// Sell approvals (R4-1, Quintus baa80e9). Agent sells (stock -> mUSDG) are exempt from the $500 BUY window but use
// the vault's own rolling-24h SELL cap (max $500; over it the vault reverts VaultSellCapExceeded). The server never
// submits a reverting sell: it preflights exitRemaining().totalUsd and, if the sell isn't covered, holds it as a
// pending approval (SQLite, 1h). The owner approves with a WebAuthn passkey assertion (challenge = approvalId +
// sell-params hash). Only then the server signs ONE per-sell EIP-712 SellApproval(vault, amountUsd = est. USD x 1.02,
// expiry = now+1h, fresh nonce) with the SIMULATED owner key; the keeper relays it with approveSellWithSig; the server
// re-quotes (fails on a > 3% move), enforces the oracle floor + minOut and executes the held sell with the agent key.
// The contract keeps one active allowance (a new one replaces it), so approvals execute one at a time per vault.
// A relayed approval whose sell then fails is voided with cancelSellApproval(nonce).
// PRODUCTION: SellApproval must be signed by the user's own wallet (or an EIP-1271 smart-account signature);
// there must be no operator signing path. ownerSignatureSimulated: true marks every response until then.
import { createHash, randomBytes } from "node:crypto";
import { type Address, type Hex } from "viem";
import { generateRegistrationOptions, verifyRegistrationResponse, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { C, read } from "./chain.js";
import * as svc from "./service.js";
import * as cfg from "./config.js";
import { getDb, tx, nowIso } from "./db.js";
import { log } from "./log.js";

const ApiError = svc.ApiError;
export const SELL_CAP_USD = Number(process.env.SELL_CAP_USD ?? 500);
const TTL_SEC = 3600, MAX_MOVE = 0.03, FLOOR_BPS = 300;
const RP_ID = () => process.env.WEBAUTHN_RP_ID ?? "localhost";
const ORIGINS = () => (process.env.WEBAUTHN_ORIGINS ?? `http://localhost:${cfg.PORT}`).split(",").map((s) => s.trim());
const BUFFER = 1.02;
const has = (name: string) => (C.vault.abi as any[]).some((x) => x.type === "function" && x.name === name);
if (!has("exitRemaining") || !has("approveSellWithSig")) throw new Error("AgentVault ABI lacks R4-1 (exitRemaining/approveSellWithSig): rebuild artifacts from baa80e9 or later");
export const approvalMode = () => "contract" as const;
export async function soldLast24h(vault: Address) { return Number(await read<bigint>(vault, C.vault.abi, "vaultSoldLast24h")) / 1e6; }
export async function exitRemaining(vault: Address) {
  const [capLeft, allowance, expiry, total] = await read<[bigint, bigint, bigint, bigint]>(vault, C.vault.abi, "exitRemaining");
  return { capLeftUsd: Number(capLeft) / 1e6, allowanceUsd: Number(allowance) / 1e6, allowanceExpiry: Number(expiry) ? new Date(Number(expiry) * 1000).toISOString() : null, totalUsd: Number(total) / 1e6 };
}
const locks = new Map<string, Promise<unknown>>();
const perVault = <T>(vault: string, fn: () => Promise<T>) => { const prev = locks.get(vault) ?? Promise.resolve(); const next = prev.catch(() => {}).then(fn); locks.set(vault, next); return next; };
async function usd(sym: string, amt: number) { return (amt * Number((await svc.priceE8(sym)).p)) / 1e8; }

type Approval = { id: string; vault: Address; agentKeyId: string; agentName: string; ticker: string; amountIn: number; estUsd: number; estUsdgOut: number; estUsdgOutMin: number;
  reason: string; reasonCode: string; reasonText: string; status: "pending" | "executing" | "executed" | "rejected" | "expired" | "failed"; createdAt: string; expiresAt: string; paramsHash: string; challenge: string;
  txHash?: string; error?: string; exitApproval?: Record<string, unknown>; decidedAt?: string };
const put = (a: Approval) => getDb().prepare("INSERT INTO approvals(id, vault, status, created_at, expires_at, json) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, json=excluded.json").run(a.id, a.vault, a.status, a.createdAt, a.expiresAt, JSON.stringify(a));
const get = (id: string): Approval | null => { const r = getDb().prepare("SELECT json FROM approvals WHERE id=?").get(id) as { json: string } | undefined; return r ? JSON.parse(r.json) : null; };
const pub = (a: Approval) => ({ id: a.id, agentKeyId: a.agentKeyId, agentName: a.agentName, ticker: a.ticker, amountIn: a.amountIn, estUsdgOut: a.estUsdgOut, estUsdgOutMin: a.estUsdgOutMin, reason: a.reason, reasonCode: a.reasonCode ?? "SELL_CAP_EXCEEDED", reasonText: a.reasonText ?? a.reason, status: a.status, createdAt: a.createdAt, expiresAt: a.expiresAt,
  challenge: a.challenge, paramsHash: a.paramsHash, ...(a.txHash ? { txHash: a.txHash } : {}), ...(a.error ? { error: a.error } : {}), ...(a.exitApproval ? { exitApproval: a.exitApproval } : {}), ownerSignatureSimulated: true as const, mode: approvalMode() });
function expire(a: Approval) { if (a.status === "pending" && Date.parse(a.expiresAt) < Date.now()) { a.status = "expired"; put(a); } return a; }
export const paramsHash = (p: { vault: string; ticker: string; amountIn: number; tokenOut: string }) => "0x" + createHash("sha256").update(JSON.stringify([p.vault.toLowerCase(), p.ticker, p.amountIn.toFixed(8), p.tokenOut])).digest("hex");
export const challengeFor = (id: string, ph: string) => isoBase64URL.fromUTF8String(`${id}:${ph}`);

const agentName = (agent: { id: string; label?: string }) => agent.label || `Agent key ${agent.id}`;
async function makeApproval(vault: Address, agent: { id: string; label?: string }, tokenIn: string, tokenOut: string, amountIn: number, est: number, remUsd: number) {
  const sold = await soldLast24h(vault);
  const q = await svc.quote_swap(tokenIn, tokenOut, amountIn);
  const id = "apr_" + randomBytes(6).toString("hex"), ph = paramsHash({ vault, ticker: tokenIn, amountIn, tokenOut });
  const reasonText = `Daily agent sell limit reached: $${sold.toFixed(2)} sold in the last 24h, $${remUsd.toFixed(2)} left, this sell is ~$${est.toFixed(2)}`;
  const a: Approval = { id, vault, agentKeyId: agent.id, agentName: agentName(agent), ticker: tokenIn, amountIn, estUsd: +est.toFixed(2), estUsdgOut: q.amountOut, estUsdgOutMin: q.minOut,
    reason: reasonText, reasonCode: "SELL_CAP_EXCEEDED", reasonText, status: "pending", createdAt: nowIso(), expiresAt: new Date(Date.now() + TTL_SEC * 1000).toISOString(), paramsHash: ph, challenge: challengeFor(id, ph) };
  put(a);
  return a;
}
/** Dev fixture (local anvil only, owner): a pending over-cap agent sell approval for the dashboard demo. Nothing is submitted. */
export async function seedApproval(p: { ticker?: string; usd?: number } = {}) {
  const vault = svc._vault(), agent = svc._agent();
  if (!vault || !agent) throw new svc.ApiError(409, "Needs a vault and an agent key first (create_smart_account, create_session_key)");
  const ticker = String(p.ticker ?? "AMD").toUpperCase(), rem = await exitRemaining(vault);
  const px = await usd(ticker, 1), est = Math.max(rem.totalUsd + 1, Number(p.usd) || rem.totalUsd + 50);
  const a = await makeApproval(vault, agent, ticker, "mUSDG", +(est / px).toFixed(6), est, rem.totalUsd);
  log.info("dev: seeded pending sell approval", { approvalId: a.id, ticker, estUsd: a.estUsd });
  return { seeded: true, approval: pub(a) };
}

/** execute_swap guard: returns a pending approval instead of submitting a sell that would exceed the sell cap. */
svc.setSellGuard(async ({ tokenIn, tokenOut, amountIn }) => {
  const vault = svc._vault()!, agent = svc._agent()!;
  const est = await usd(tokenIn, amountIn), rem = await exitRemaining(vault);
  if (est <= rem.totalUsd - 0.01) return { hold: false, estUsd: est }; // 1 cent margin for oracle rounding
  const a = await makeApproval(vault, agent, tokenIn, tokenOut, amountIn, est, rem.totalUsd);
  log.info("sell held for owner approval", { approvalId: a.id, ticker: tokenIn, estUsd: a.estUsd });
  return { hold: true, estUsd: est, result: { status: "pending_owner_approval", approvalId: a.id, message: `Sell is pending owner approval: agent sells over $${SELL_CAP_USD} per rolling 24h need the owner's passkey approval in the StockClaw dashboard. Nothing was submitted.`, approval: pub(a) } };
});

export function list_approvals(status?: string) {
  return (getDb().prepare("SELECT json FROM approvals ORDER BY created_at DESC").all() as { json: string }[]).map((r) => expire(JSON.parse(r.json))).filter((a) => !status || a.status === status).map(pub);
}
export function approval_options(id: string) {
  const a = get(id); if (!a) throw new ApiError(404, "Unknown approval");
  return { challenge: a.challenge, rpId: RP_ID(), allowCredentials: (getDb().prepare("SELECT id FROM passkeys").all() as { id: string }[]).map((r) => ({ id: r.id, type: "public-key" })), userVerification: "required", timeout: 60000 };
}

// ---------------------------------------------------------------- passkeys (WebAuthn)
/** Gaius R5: once a passkey exists, adding another needs a UV assertion from an existing passkey (owner token alone is not enough). */
export async function passkey_register_options(stepUp?: any) {
  const existing = (getDb().prepare("SELECT COUNT(*) n FROM passkeys").get() as { n: number }).n;
  if (existing) {
    const su = getDb().prepare("SELECT challenge, created_at FROM webauthn_challenges WHERE k='stepup'").get() as { challenge: string; created_at: number } | undefined;
    if (!stepUp || !su || Date.now() - su.created_at > 300_000) {
      const challenge = isoBase64URL.fromBuffer(new Uint8Array(randomBytes(32)));
      getDb().prepare("INSERT INTO webauthn_challenges(k, challenge, created_at) VALUES('stepup', ?, ?) ON CONFLICT(k) DO UPDATE SET challenge=excluded.challenge, created_at=excluded.created_at").run(challenge, Date.now());
      throw Object.assign(new ApiError(403, "A passkey is already registered: sign stepUpChallenge with an existing passkey and resend as webauthnAssertion"), { extra: { stepUpChallenge: challenge, rpId: RP_ID() } });
    }
    await verifyAssertion({ challenge: su.challenge } as Approval, stepUp);
    getDb().prepare("DELETE FROM webauthn_challenges WHERE k='stepup'").run();
  }
  const o = await generateRegistrationOptions({ rpName: "StockClaw", rpID: RP_ID(), userName: "stockclaw-owner", userID: new TextEncoder().encode(svc._owner().address), attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" }, excludeCredentials: (getDb().prepare("SELECT id FROM passkeys").all() as { id: string }[]).map((r) => ({ id: r.id })) });
  const slot = existing ? "register-stepup" : "register-bootstrap"; // R6-3: verify re-checks which path issued the challenge
  getDb().prepare("DELETE FROM webauthn_challenges WHERE k LIKE 'register%'").run();
  getDb().prepare("INSERT INTO webauthn_challenges(k, challenge, created_at) VALUES(?, ?, ?)").run(slot, o.challenge, Date.now());
  return o;
}
export async function passkey_register_verify(response: any) {
  const c = getDb().prepare("SELECT k, challenge, created_at FROM webauthn_challenges WHERE k LIKE 'register-%'").get() as { k: string; challenge: string; created_at: number } | undefined;
  if (!c || Date.now() - c.created_at > 300_000) throw new ApiError(400, "No registration in progress (call /api/passkey/register/options)");
  let v;
  try { v = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: ORIGINS(), expectedRPID: RP_ID(), requireUserVerification: true }); }
  catch (e) { throw new ApiError(400, `Passkey registration failed: ${(e as Error).message}`); }
  if (!v.verified || !v.registrationInfo) throw new ApiError(400, "Passkey registration not verified");
  const cr = v.registrationInfo.credential;
  // R6-3: re-check the bootstrap rule at verify time, atomically with the insert: a bootstrap challenge can't add a passkey once one exists
  tx(() => {
    const n = (getDb().prepare("SELECT COUNT(*) n FROM passkeys").get() as { n: number }).n;
    if (n > 0 && c.k !== "register-stepup") throw new ApiError(403, "A passkey is already registered: adding another needs a step-up assertion (request new options)");
    getDb().prepare("INSERT OR REPLACE INTO passkeys(id, owner, public_key, counter, created_at) VALUES(?,?,?,?,?)").run(cr.id, svc._owner().address, isoBase64URL.fromBuffer(cr.publicKey), cr.counter, nowIso());
    getDb().prepare("DELETE FROM webauthn_challenges WHERE k LIKE 'register%'").run();
  });
  return { verified: true, credentialId: cr.id, rpId: RP_ID() };
}
async function verifyAssertion(a: Approval, assertion: any) {
  if (!assertion?.id) throw new ApiError(401, "Passkey assertion required (webauthnAssertion)");
  const pk = getDb().prepare("SELECT id, public_key, counter FROM passkeys WHERE id=?").get(assertion.id) as { id: string; public_key: string; counter: number } | undefined;
  if (!pk) throw new ApiError(401, "Unknown passkey (register one at /api/passkey/register/options)");
  let v;
  try { v = await verifyAuthenticationResponse({ response: assertion, expectedChallenge: a.challenge, expectedOrigin: ORIGINS(), expectedRPID: RP_ID(), credential: { id: pk.id, publicKey: isoBase64URL.toBuffer(pk.public_key), counter: pk.counter }, requireUserVerification: true }); }
  catch (e) { throw new ApiError(401, `Passkey verification failed: ${(e as Error).message}`); }
  if (!v.verified) throw new ApiError(401, "Passkey verification failed");
  getDb().prepare("UPDATE passkeys SET counter=? WHERE id=?").run(v.authenticationInfo.newCounter, pk.id);
}

// ---------------------------------------------------------------- approve / reject
export async function approve(id: string, assertion: any) {
  const a0 = get(id); if (!a0) throw new ApiError(404, "Unknown approval");
  expire(a0);
  if (a0.status === "expired") throw new ApiError(410, "Approval expired (1h): the sell was not executed; ask the agent to sell again");
  if (a0.status !== "pending") throw new ApiError(409, `Approval is ${a0.status} (one approval per sell)`);
  await verifyAssertion(a0, assertion);
  const a = tx(() => { const x = get(id)!; if (x.status !== "pending") throw new ApiError(409, `Approval is ${x.status}`); x.status = "executing"; x.decidedAt = nowIso(); put(x); return x; });
  return perVault(a.vault, () => execApproved(a));
}
async function execApproved(a: Approval) {
  const id = a.id; let relayedNonce: bigint | null = null;
  try {
    const d = svc.dep(), vault = a.vault, ti = svc._token(a.ticker), usdg = svc._token("mUSDG");
    if (!svc._agent() || svc._agent()!.status !== "active") throw new ApiError(409, "Agent key is not active; the held sell can't run");
    // re-quote; refuse if the price moved > 3% since the agent asked
    const q = await svc.quote_swap(a.ticker, "mUSDG", a.amountIn);
    const move = Math.abs(q.amountOut - a.estUsdgOut) / a.estUsdgOut;
    if (move > MAX_MOVE) throw new ApiError(409, `Price moved ${(move * 100).toFixed(2)}% since the request (> 3%); not executed. Ask the agent to sell again.`);
    const raw = svc._units(a.amountIn, ti.decimals), net = raw - (raw * BigInt(await read<number>(d.router, C.router.abi, "feeBps"))) / 10_000n;
    const floor = ((await read<bigint>(d.oracle, C.oracle.abi, "convert", [ti.address, usdg.address, net])) * BigInt(10_000 - FLOOR_BPS)) / 10_000n;
    let minOut = svc._units(q.minOut, 6); if (floor > minOut) minOut = floor;
    // per-sell SellApproval: est. USD (at re-quote) x 1.02, expiry now+1h, fresh nonce; signed by the SIMULATED owner key
    const now = await svc.chainNow(), estNow = await usd(a.ticker, a.amountIn);
    const amountUsd = BigInt(Math.ceil(estNow * BUFFER * 1e6)), expiry = now + TTL_SEC, nonce = BigInt("0x" + randomBytes(7).toString("hex"));
    const digest = await read<Hex>(vault, C.vault.abi, "sellApprovalDigest", [amountUsd, expiry, nonce]);
    const signature = await svc._owner().account.sign!({ hash: digest });
    const relay = await svc.keeperWallet().write(vault, C.vault.abi, "approveSellWithSig", [amountUsd, expiry, nonce, signature], { label: `sell-approval:${id}` });
    relayedNonce = nonce;
    const pool = await svc._poolFor(a.ticker, "mUSDG"), deadline = BigInt(now + 300);
    const before = await read<bigint>(usdg.address, C.usdg.abi, "balanceOf", [vault]);
    const { hash: txHash } = await svc._agentWallet().write(vault, C.vault.abi, "agentSwap", [pool, ti.address, usdg.address, raw, minOut, deadline], { label: `approved-sell:${id}` });
    const out = Number((await read<bigint>(usdg.address, C.usdg.abi, "balanceOf", [vault])) - before) / 1e6;
    a.status = "executed"; a.txHash = txHash;
    a.exitApproval = { type: "SellApproval", vault, amountUsd: Number(amountUsd) / 1e6, expiry: new Date(expiry * 1000).toISOString(), nonce: nonce.toString(), signature, relayedBy: "keeper", relayTxHash: relay.hash, minOut: Number(minOut) / 1e6, amountOut: out };
    put(a);
    svc._pushHistory({ txHash, explorerUrl: svc._txOut(txHash).explorerUrl, type: "swap", in: `${a.amountIn.toFixed(2)} ${a.ticker}`, out: `${out.toFixed(6)} mUSDG`, fee: `${(a.amountIn * 0.003).toFixed(6)} ${a.ticker}`, ts: nowIso(), status: "filled", side: "sell", reason: "owner-approved sell", keyId: a.agentKeyId, usd: a.estUsd });
    svc._trade()?.record(a.agentKeyId, "sell", a.estUsd, `approval:${id}`);
    log.info("approved sell executed", { approvalId: id, txHash, relayTxHash: relay.hash });
    return pub(a);
  } catch (e) {
    a.status = "failed"; a.error = (e instanceof ApiError ? e.message : svc.humanReason(e)).slice(0, 300); put(a);
    if (relayedNonce != null) { try { await svc._owner().write(a.vault, C.vault.abi, "cancelSellApproval", [relayedNonce], { label: `sell-approval-cancel:${id}` }); } catch (x) { log.error("could not void sell approval", { approvalId: id, error: (x as Error).message.slice(0, 200) }); } }
    log.warn("approved sell failed", { approvalId: id, error: a.error });
    if (e instanceof ApiError) throw e;
    throw new ApiError(409, `Approved sell failed: ${a.error}`);
  }
}
export function reject(id: string) {
  const a = get(id); if (!a) throw new ApiError(404, "Unknown approval");
  expire(a); if (a.status !== "pending") throw new ApiError(409, `Approval is ${a.status}`);
  a.status = "rejected"; a.decidedAt = nowIso(); put(a); // nothing was signed or relayed, so there is nothing onchain to cancel
  return pub(a);
}
svc.onReset(() => { const d = getDb(); for (const t of ["approvals", "passkeys", "sells", "webauthn_challenges"]) d.prepare(`DELETE FROM ${t}`).run(); });
