// StockClaw application service: one function per api.js stub / MCP tool (ARCHITECTURE.md §7).
// Demo scope: single user. The user's wallet is simulated by DEMO_OWNER_KEY (no wallet-connect yet);
// agent session keys are held server-side (stand-in for KMS) and are AgentVault delegates.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { C, pub, read, wallet, revertReason, isRevert, loadDeployment, type Deployment } from "./chain.js";
import * as cfg from "./config.js";

let onCapBlock: (() => void) | undefined;
export const setCapBlockHook = (f: () => void) => { onCapBlock = f; };
export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

type Intent = {
  account: Address; tokenIn: Address; tokenOut: Address; adapter: Address; amountPerExec: bigint; minOutPerExec: bigint;
  limitPriceE8: bigint; interval: number; maxExecs: number; maxOracleDevBps: number; startTime: number; expiry: number; nonce: bigint;
};
type Order = {
  intentId: string; type: "DCA" | "Limit"; tokenIn: string; tokenOut: string; amount: number; interval?: string; intervalSec?: number;
  maxExecs: number; execsDone: number; limitPrice?: number; expiry?: string; nextRunAt?: string | null; status: string;
  agent: Address; intent: Record<string, string | number>; sig: Hex; hash: Hex; lastError?: string; txHashes: string[];
  activationId?: string; role?: "dca" | "rung" | "take-profit"; rung?: number; parent?: string;
};
type HistoryRow = { txHash: string | null; explorerUrl?: string; type: string; in: string; out: string; fee: string; ts: string; status: "filled" | "blocked" | "failed"; reason?: string };
type State = {
  country?: string; attestation?: { sig: string; ts: string; expiresAt: string; signer: Address; txHash: string };
  vault?: Address; nextAgentIdx: number;
  agent?: { idx: number; address: Address; id: string; perTradeCap: number; dailyCap: number; days: number; allowlist: string[]; expiresAt: string; status: "active" | "revoked" | "expired" };
  orders: Record<string, Order>; history: HistoryRow[]; usage: { day: string; calls: number }; epoch?: number;
  activations?: Record<string, any>;
};

const STATE_FILE = path.join(cfg.DATA_DIR, "state.json");
let S: State = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { nextAgentIdx: 0, orders: {}, history: [], usage: { day: "", calls: 0 } };
if (S.epoch) cfg.setUserEpoch(S.epoch);
const save = () => { fs.mkdirSync(cfg.DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(S, null, 2)); };
/** Dev reset (local chain only): fresh user = new owner key + fresh agent-key pool, all derived deterministically
 * from the anvil mnemonic at a new HD offset and funded with ETH via anvil_setBalance. Contracts stay deployed. */
export async function dev_reset() {
  if (!cfg.IS_LOCAL) throw new ApiError(403, "dev reset is only available on a local chain");
  const epoch = (S.epoch ?? 0) + 1;
  cfg.setUserEpoch(epoch);
  const addrs = [owner().address, ...cfg.keys.agentPool().map((k) => privateKeyToAccount(k).address)];
  for (const a of addrs) await pub.request({ method: "anvil_setBalance" as any, params: [a, "0x56BC75E2D63100000"] as any }); // 100 ETH
  S = { nextAgentIdx: 0, orders: {}, history: [], usage: { day: "", calls: 0 }, epoch };
  save();
  return { ok: true, epoch, owner: owner().address, agentKeys: addrs.length - 1 };
}
export function resetState() { S = { nextAgentIdx: 0, orders: {}, history: [], usage: { day: "", calls: 0 } }; save(); }

let D: Deployment | undefined;
export const dep = () => (D ??= loadDeployment());
const owner = () => wallet(cfg.keys.demoOwner());
const deployer = () => wallet(cfg.keys.deployer());
const keeper = () => wallet(cfg.keys.keeper());
const updater = () => wallet(cfg.keys.updater());
const agentWallet = () => {
  if (!S.agent) throw new ApiError(409, "No agent key. Call create_session_key first.");
  return wallet(cfg.keys.agentPool()[S.agent.idx]);
};
const txOut = (hash: string) => ({ txHash: hash, explorerUrl: cfg.IS_LOCAL ? `local-anvil/tx/${hash}` : `${cfg.EXPLORER}/tx/${hash}`, status: "confirmed" });
const chainNow = async () => Number((await pub.getBlock()).timestamp);

// ---------------------------------------------------------------- assets
const SYMS = () => ["mUSDG", ...Object.keys(dep().stocks)];
function token(sym: string): { address: Address; decimals: number; symbol: string } {
  const s = sym.toUpperCase();
  if (s === "MUSDG" || s === "USDG") return { address: dep().usdg, decimals: 6, symbol: "mUSDG" };
  const t = dep().stocks[s];
  if (!t) throw new ApiError(400, `Unknown token ${sym}. Supported: ${SYMS().join(", ")}`);
  return { address: t.token, decimals: t.decimals, symbol: s };
}
const isUsdg = (sym: string) => token(sym).symbol === "mUSDG";
/** N-4: pick the registered pool whose route the router accepts (router.isRouteSupported never reverts). */
async function poolFor(a: string, b: string): Promise<Address> {
  const ti = token(a), to = token(b);
  for (const s of Object.values(dep().stocks))
    if (await read<boolean>(dep().router, C.router.abi, "isRouteSupported", [s.pool, ti.address, to.address])) return s.pool;
  throw new ApiError(400, `Pair not supported: ${ti.symbol} -> ${to.symbol} (routes are mUSDG <-> stock)`);
}
const units = (amt: number, dec: number) => {
  if (!(amt > 0) || !Number.isFinite(amt)) throw new ApiError(400, "amount must be > 0");
  return parseUnits(amt.toFixed(Math.min(dec, 8)), dec);
};
const fmt = (v: bigint, dec: number) => Number(formatUnits(v, dec));

function humanReason(e: unknown): string {
  const { name, args } = revertReason(e);
  const usd = (x: unknown) => `$${(Number(x) / 1e6).toFixed(2)}`;
  switch (name) {
    case "PerTradeCapExceeded": return `Over ${usd(args[1])} per-trade cap (trade ${usd(args[0])})`;
    case "VaultDailyCapExceeded": return `Blocked by limit: vault's ${usd(args[1])} rolling-24h cap shared by all agent keys (would be ${usd(args[0])})`;
    case "TransferBlocked": return "Token issuer blocked the transfer (frozen / paused / registry)";
    case "ComplianceBlocked": return "Compliance check blocked the transfer";
    case "PairNotSupported": return "Pair not supported by any registered pool";
    case "ZeroMinOut": return "minOut must be > 0";
    case "InsufficientLiquidity": return "Pool liquidity too low for this size";
    case "DailyCapExceeded": return `Over ${usd(args[1])} rolling-24h cap (would be ${usd(args[0])})`;
    case "TokenNotAllowed": return "Ticker not on allowlist";
    case "NotAgent": return "Agent key revoked (paused)";
    case "AgentExpired": return "Agent key expired";
    case "NotEligible": return "Account not eligible";
    case "MarketClosed": return "Market closed: trading halted";
    case "StalePrice": return "Price feed stale (>1h): trading halted";
    case "LimitNotMet": return "Limit price not met";
    case "NotYet": return "Not due yet";
    case "NonceIsCancelled": return "Order cancelled";
    case "IntentExhausted": return "Order complete";
    case "Expired": return "Order expired";
    case "InsufficientOutput": case "AdapterSwapFailed": return "Slippage / oracle-band protection";
    default: return name;
  }
}

async function priceE8(sym: string): Promise<{ p: bigint; updatedAt: number }> {
  if (isUsdg(sym)) return { p: 100_000_000n, updatedAt: await chainNow() };
  const s = dep().stocks[token(sym).symbol];
  const [, answer, , updatedAt] = await read<[bigint, bigint, bigint, bigint, bigint]>(s.feed, C.agg.abi, "latestRoundData");
  return { p: answer, updatedAt: Number(updatedAt) };
}

export async function list_assets() {
  return Promise.all(SYMS().map(async (sym) => {
    const t = token(sym), { p } = await priceE8(sym);
    return { symbol: sym, address: t.address, decimals: t.decimals, priceUsd: Number(p) / 1e8, source: isUsdg(sym) ? "pinned 1:1" : "MockAggregatorV3" };
  }));
}
export async function get_price(symbol: string) {
  const { p, updatedAt } = await priceE8(symbol);
  let halted: string | null = null;
  if (!isUsdg(symbol)) { try { await read(dep().oracle, C.oracle.abi, "priceE8", [token(symbol).address]); } catch (e) { halted = humanReason(e); } }
  return { priceUsd: Number(p) / 1e8, source: isUsdg(symbol) ? "pinned 1:1" : "MockAggregatorV3", updatedAt: new Date(updatedAt * 1000).toISOString(), halted };
}

// ---------------------------------------------------------------- eligibility
export function regionCheck(country?: string) {
  let c = (country ?? "").toUpperCase().trim();
  c = cfg.COUNTRY_NAMES[c] ?? c;
  if (!c) return { eligible: false, reason: "Country not provided" };
  if (cfg.BLOCKED_REGIONS[c]) return { eligible: false, reason: `Not available in ${cfg.BLOCKED_REGIONS[c]} (blocked region)` };
  return { eligible: true, reason: null };
}
/** country = self-declared country; geoCountry = edge geo-IP header (CF-IPCountry). Either blocked => blocked. */
export async function check_eligibility(country?: string, geoCountry?: string) {
  if (geoCountry) { const g = regionCheck(geoCountry); if (!g.eligible) return { ...g, expiresAt: null }; }
  if (country) S.country = country.toUpperCase();
  save();
  const r = regionCheck(S.country);
  if (!r.eligible) return { ...r, expiresAt: null };
  const until = Number(await read<bigint>(dep().registry, C.registry.abi, "eligibleUntil", [owner().address]));
  if (until > (await chainNow())) return { eligible: true, reason: null, expiresAt: new Date(until * 1000).toISOString() };
  return { eligible: true, reason: "Region OK; sign the non-US-person attestation to activate", expiresAt: null };
}
const ATTEST_TYPES = { Attestation: [{ name: "owner", type: "address" }, { name: "statement", type: "string" }, { name: "country", type: "string" }, { name: "issuedAt", type: "uint256" }] } as const;
export async function submit_attestation(_sig?: string, geoCountry?: string) {
  const r = regionCheck(S.country);
  if (!r.eligible) throw new ApiError(451, r.reason ?? "Not eligible");
  if (geoCountry && !regionCheck(geoCountry).eligible) throw new ApiError(451, "Blocked region (geo-IP)");
  const o = owner(); const issuedAt = BigInt(await chainNow());
  const message = { owner: o.address, statement: "I am not a US person and not resident in a blocked region (US, CA, GB, CH, AE, sanctioned).", country: S.country!, issuedAt };
  // Demo: the simulated wallet signs (real app: user's wallet signs in the browser and we verify).
  const sig = await o.client.signTypedData({ domain: { name: "StockClaw Eligibility", version: "1", chainId: cfg.TESTNET_CHAIN_ID }, types: ATTEST_TYPES, primaryType: "Attestation", message });
  const expiry = Number(issuedAt) + 30 * 86400;
  const { hash } = await deployer().write(dep().registry, C.registry.abi, "setEligible", [o.address, BigInt(expiry)]);
  S.attestation = { sig, ts: new Date().toISOString(), expiresAt: new Date(expiry * 1000).toISOString(), signer: o.address, txHash: hash };
  if (S.vault) await owner().write(dep().registry, C.registry.abi, "linkAccount", [S.vault]);
  save();
  return { ok: true, signature: sig, ...txOut(hash) };
}
async function requireEligible() {
  const e = await check_eligibility();
  if (!e.eligible || !e.expiresAt) throw new ApiError(451, e.reason ?? "Not eligible");
}

// ---------------------------------------------------------------- wallet / session key
export async function create_smart_account(_owner?: string) {
  await requireEligible();
  if (S.vault) return { address: S.vault };
  const o = owner();
  const vault = await o.deploy(C.vault, [o.address, dep().router]);
  await o.write(dep().registry, C.registry.abi, "linkAccount", [vault]); // vault inherits owner eligibility
  S.vault = vault; save();
  return { address: vault };
}
async function spentLast24h(): Promise<number> {
  if (!S.vault || !S.agent) return 0;
  // $500/24h is per VAULT (all keys share it; SERVER_MIGRATION §7). Headroom = vaultSpentLast24h.
  return Number(await read<bigint>(S.vault, C.vault.abi, "vaultSpentLast24h")) / 1e6;
}
export async function get_wallet() {
  let status = S.agent?.status;
  if (S.agent && status === "active" && Date.parse(S.agent.expiresAt) < (await chainNow()) * 1000) status = S.agent.status = "expired";
  return {
    address: S.vault ?? null, chainId: cfg.TESTNET_CHAIN_ID, owner: owner().address,
    ownerSimulated: true, ownerNote: "DEMO: the owner wallet is SIMULATED by the server (no wallet-connect yet). Owner actions require the owner token.",
    sessionKey: S.agent ? { status, id: S.agent.id, agent: S.agent.address, expiresAt: S.agent.expiresAt, perTradeCap: S.agent.perTradeCap, dailyCap: S.agent.dailyCap, spentToday: await spentLast24h(), window: "rolling 24h, per vault (shared by all keys); buys only: exits to mUSDG don't use the daily limit", allowlist: S.agent.allowlist } : null,
  };
}
export type Caps = { perTradeCap?: number; dailyCap?: number; days?: number; allowlist?: string[] };
export async function create_session_key(caps: Caps = {}) {
  if (!S.vault) throw new ApiError(409, "Create the smart account first");
  const perTradeCap = caps.perTradeCap ?? cfg.MAX_PER_TRADE_USD, dailyCap = caps.dailyCap ?? cfg.MAX_PER_DAY_USD, days = caps.days ?? cfg.MAX_KEY_DAYS;
  if (!(perTradeCap > 0 && dailyCap > 0) || perTradeCap > dailyCap) throw new ApiError(400, "Limits must be positive and per-trade <= daily");
  if (perTradeCap > cfg.MAX_PER_TRADE_USD || dailyCap > cfg.MAX_PER_DAY_USD) throw new ApiError(400, `Demo limits are capped at $${cfg.MAX_PER_TRADE_USD}/trade and $${cfg.MAX_PER_DAY_USD}/rolling 24h`);
  if (!(days > 0 && days <= cfg.MAX_KEY_DAYS)) throw new ApiError(400, "Key expiry must be 1-7 days");
  const allowlist = (caps.allowlist ?? Object.keys(dep().stocks)).map((s) => s.toUpperCase()).filter((s) => s !== "MUSDG" && s !== "USDG");
  if (!allowlist.length) throw new ApiError(400, "Allowlist must contain at least one ticker");
  allowlist.forEach((s) => token(s));
  const pool = cfg.keys.agentPool();
  if (S.nextAgentIdx >= pool.length) throw new ApiError(503, "Agent key pool exhausted (restart local chain)");
  const o = owner(), v = S.vault;
  let revoked: { key: string; agent: Address; txHash: string } | null = null;
  if (S.agent?.status === "active") { const old = S.agent; const r = await revoke_session_key(); revoked = { key: old.id, agent: old.address, txHash: r.txHash }; } // editing limits = revoke + re-issue
  // allowlist: mUSDG + chosen tickers on, everything else off
  const wanted = new Set([dep().usdg.toLowerCase(), ...allowlist.map((s) => token(s).address.toLowerCase())]);
  for (const sym of SYMS()) {
    const a = token(sym).address, on = wanted.has(a.toLowerCase());
    if ((await read<boolean>(v, C.vault.abi, "allowedToken", [a])) !== on) await o.write(v, C.vault.abi, "setAllowedToken", [a, on]);
  }
  const idx = S.nextAgentIdx++;
  const agent = privateKeyToAccount(pool[idx]).address;
  const expiry = (await chainNow()) + Math.round(days * 86400);
  await o.write(v, C.vault.abi, "setCaps", [agent, BigInt(perTradeCap * 1e6), BigInt(dailyCap * 1e6)]);
  const { hash } = await o.write(v, C.vault.abi, "grantAgent", [agent, expiry]);
  S.agent = { idx, address: agent, id: "sk_" + agent.slice(2, 8).toLowerCase(), perTradeCap, dailyCap, days, allowlist, expiresAt: new Date(expiry * 1000).toISOString(), status: "active" };
  save();
  const created = { ...txOut(hash), status: "active", id: S.agent.id, agent, expiresAt: S.agent.expiresAt, perTradeCap, dailyCap, days, spentToday: 0, allowlist };
  return { ...created, revoked, created }; // top-level fields kept for app.js
}
/** The user-facing pause: one tx, revokes the agent key; the agent's swaps and all its signed intents stop. */
export async function revoke_session_key() {
  if (!S.vault || !S.agent) throw new ApiError(409, "No agent key to revoke");
  const { hash } = await owner().write(S.vault, C.vault.abi, "revokeAgent", [S.agent.address]);
  S.agent.status = "revoked";
  for (const o of Object.values(S.orders)) if (o.agent === S.agent.address && o.status === "open") o.status = "paused";
  for (const a of Object.values(S.activations ?? {})) if (a.status === "active") a.status = "paused"; // kill switch pauses strategies
  save();
  return txOut(hash);
}

// ---------------------------------------------------------------- balances
export async function get_balances(tokens?: string[]) {
  const who = S.vault;
  if (!who) return [];
  const syms = tokens?.length ? tokens.map((t) => token(t).symbol) : SYMS();
  return Promise.all(syms.map(async (sym) => {
    const t = token(sym);
    const amount = fmt(await read<bigint>(t.address, C.usdg.abi, "balanceOf", [who]), t.decimals);
    const { p } = await priceE8(sym);
    return { symbol: sym, address: t.address, amount, usdValue: +(amount * Number(p) / 1e8).toFixed(2) };
  }));
}

// ---------------------------------------------------------------- quotes & swaps
const quotes = new Map<string, { tokenIn: string; tokenOut: string; amountIn: number; minOutRaw: bigint; expiresAt: number }>();
export async function quote_swap(tokenIn: string, tokenOut: string, amountIn: number, slippageBps = cfg.DEFAULT_SLIPPAGE_BPS) {
  if (slippageBps < 0 || slippageBps > cfg.MAX_SLIPPAGE_BPS) throw new ApiError(400, `slippageBps must be 0-${cfg.MAX_SLIPPAGE_BPS}`);
  const ti = token(tokenIn), to = token(tokenOut), pool = await poolFor(tokenIn, tokenOut);
  const raw = units(amountIn, ti.decimals);
  // TODO(Quintus): switch to oracle-anchored StockClawPool.quote() once docs/SERVER_MIGRATION.md lands (quote engine + keeper limit fills).
  // Oracle-anchored StockClawPool.quote() (== swap() in the same block) on the post-fee amount.
  const feeBpsNow = BigInt(await read<number>(dep().router, C.router.abi, "feeBps"));
  const fee = raw * feeBpsNow / 10_000n;
  const netOut = await read<bigint>(pool, C.pool.abi, "quote", [ti.address, to.address, raw - fee]);
  const minOutRaw = netOut * BigInt(10_000 - slippageBps) / 10_000n;
  const pi = (await priceE8(tokenIn)).p, po = (await priceE8(tokenOut)).p;
  const fair = (amountIn - fmt(fee, ti.decimals)) * Number(pi) / Number(po);
  const amountOut = fmt(netOut, to.decimals);
  const quoteId = "q_" + randomBytes(6).toString("hex"), expiresAt = Date.now() + 60_000;
  quotes.set(quoteId, { tokenIn: ti.symbol, tokenOut: to.symbol, amountIn, minOutRaw, expiresAt });
  const feeAmount = fmt(fee, ti.decimals);
  return { amountIn, feeAmount, feeBps: Number(await read(dep().router, C.router.abi, "feeBps")), netIn: amountIn - feeAmount, amountOut, minOut: fmt(minOutRaw, to.decimals), route: "StockClawPool", priceImpact: fair ? +Math.max(0, (1 - amountOut / fair) * 100).toFixed(4) : 0, quoteId, expiresAt: new Date(expiresAt).toISOString() };
}
function pushHistory(h: HistoryRow) { S.history.unshift(h); S.history = S.history.slice(0, 500); save(); }

export async function execute_swap(arg: string | { tokenIn: string; tokenOut: string; amountIn: number; minOut?: number }) {
  await requireEligible();
  if (!S.vault) throw new ApiError(409, "No smart account");
  let p: { tokenIn: string; tokenOut: string; amountIn: number; minOutRaw: bigint };
  if (typeof arg === "string") {
    const q = quotes.get(arg);
    if (!q) throw new ApiError(404, "Unknown quoteId"); if (q.expiresAt < Date.now()) throw new ApiError(410, "Quote expired");
    quotes.delete(arg); p = q;
  } else {
    const q = await quote_swap(arg.tokenIn, arg.tokenOut, arg.amountIn);
    const floor = units(q.minOut, token(arg.tokenOut).decimals);
    p = { ...arg, minOutRaw: arg.minOut != null && units(arg.minOut, token(arg.tokenOut).decimals) > floor ? units(arg.minOut, token(arg.tokenOut).decimals) : floor };
  }
  const ti = token(p.tokenIn), to = token(p.tokenOut);
  const inStr = `${p.amountIn.toFixed(2)} ${ti.symbol}`, ts = new Date().toISOString();
  if (!S.agent || S.agent.status !== "active") {
    pushHistory({ txHash: null, type: "swap", in: inStr, out: "—", fee: "—", ts, status: "blocked", reason: "Agent key revoked (paused)" });
    throw new ApiError(403, "Agent key revoked (paused)");
  }
  const a = agentWallet(), raw = units(p.amountIn, ti.decimals), deadline = BigInt((await chainNow()) + 300);
  const before = await read<bigint>(to.address, C.usdg.abi, "balanceOf", [S.vault]);
  try {
    // The vault enforces caps/allowlist/expiry onchain; any breach reverts => hard block.
    const { hash } = await a.write(S.vault, C.vault.abi, "agentSwap", [await poolFor(p.tokenIn, p.tokenOut), ti.address, to.address, raw, p.minOutRaw, deadline]);
    const out = fmt((await read<bigint>(to.address, C.usdg.abi, "balanceOf", [S.vault])) - before, to.decimals);
    const fee = p.amountIn * Number(await read(dep().router, C.router.abi, "feeBps")) / 10_000;
    pushHistory({ txHash: hash, explorerUrl: txOut(hash).explorerUrl, type: "swap", in: inStr, out: `${out.toFixed(6)} ${to.symbol}`, fee: `${fee.toFixed(4)} ${ti.symbol}`, ts, status: "filled" });
    return { ...txOut(hash), amountOut: out };
  } catch (e) {
    if (e instanceof ApiError || !isRevert(e)) throw e;
    const reason = humanReason(e);
    pushHistory({ txHash: null, type: "swap", in: inStr, out: "—", fee: "—", ts, status: "blocked", reason });
    if (/rolling-24h cap/.test(reason)) onCapBlock?.();
    throw new ApiError(403, `Blocked: ${reason}`);
  }
}

// ---------------------------------------------------------------- intents (DCA / limit)
const INTENT_TYPES = { Intent: [
  { name: "account", type: "address" }, { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "adapter", type: "address" },
  { name: "amountPerExec", type: "uint128" }, { name: "minOutPerExec", type: "uint128" }, { name: "limitPriceE8", type: "uint64" }, { name: "interval", type: "uint32" },
  { name: "maxExecs", type: "uint16" }, { name: "maxOracleDevBps", type: "uint16" }, { name: "startTime", type: "uint40" }, { name: "expiry", type: "uint40" }, { name: "nonce", type: "uint256" },
] } as const;
const INTERVALS: Record<string, number> = { hourly: 3600, daily: 86400, weekly: 604800 };
const toWire = (i: Intent) => Object.fromEntries(Object.entries(i).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])) as Record<string, string | number>;
export const fromWire = (w: Record<string, string | number>): Intent => ({
  account: w.account as Address, tokenIn: w.tokenIn as Address, tokenOut: w.tokenOut as Address, adapter: w.adapter as Address,
  amountPerExec: BigInt(w.amountPerExec), minOutPerExec: BigInt(w.minOutPerExec), limitPriceE8: BigInt(w.limitPriceE8), interval: Number(w.interval),
  maxExecs: Number(w.maxExecs), maxOracleDevBps: Number(w.maxOracleDevBps), startTime: Number(w.startTime), expiry: Number(w.expiry), nonce: BigInt(w.nonce),
});
async function signIntent(i: Intent) {
  const a = agentWallet();
  const sig = await a.client.signTypedData({ domain: { name: "StockClawRouter", version: "1", chainId: cfg.TESTNET_CHAIN_ID, verifyingContract: dep().router }, types: INTENT_TYPES, primaryType: "Intent", message: i });
  const hash = await read<Hex>(dep().router, C.router.abi, "hashIntent", [i]);
  return { sig, hash };
}
function precheckAgentCaps(tokenIn: string, tokenOut: string, usd: number) {
  if (!S.agent || S.agent.status !== "active") throw new ApiError(403, "Agent key revoked (paused)");
  for (const t of [tokenIn, tokenOut]) if (!isUsdg(t) && !S.agent.allowlist.includes(token(t).symbol)) throw new ApiError(403, "Blocked: Ticker not on allowlist");
  if (usd > S.agent.perTradeCap) throw new ApiError(403, `Blocked: Over $${S.agent.perTradeCap} per-trade cap`);
}
async function usdOf(sym: string, amt: number) { return amt * Number((await priceE8(sym)).p) / 1e8; }

export async function create_dca(p: { tokenIn: string; tokenOut: string; amountPerExec: number; interval: string | number; maxExecs: number; slippageBps?: number }) {
  await requireEligible();
  if (!S.vault) throw new ApiError(409, "No smart account");
  const ti = token(p.tokenIn), to = token(p.tokenOut);
  const interval = typeof p.interval === "number" ? p.interval : INTERVALS[p.interval] ?? Number(p.interval);
  if (!(interval >= 60)) throw new ApiError(400, "interval must be hourly|daily|weekly or >= 60 seconds");
  if (!(p.maxExecs >= 1 && p.maxExecs <= 365)) throw new ApiError(400, "maxExecs must be 1-365");
  const slip = p.slippageBps ?? cfg.DEFAULT_SLIPPAGE_BPS; if (!(slip > 0) || slip > cfg.MAX_SLIPPAGE_BPS) throw new ApiError(400, "slippageBps must be in (0, 300]");
  precheckAgentCaps(p.tokenIn, p.tokenOut, await usdOf(p.tokenIn, p.amountPerExec));
  const now = await chainNow();
  const i: Intent = { account: S.vault, tokenIn: ti.address, tokenOut: to.address, adapter: await poolFor(p.tokenIn, p.tokenOut), amountPerExec: units(p.amountPerExec, ti.decimals), minOutPerExec: 1n /* router requires >0; real floor = maxOracleDevBps vs oracle at exec time */, limitPriceE8: 0n, interval, maxExecs: p.maxExecs, maxOracleDevBps: slip, startTime: now, expiry: now + interval * p.maxExecs + 3600, nonce: BigInt("0x" + randomBytes(16).toString("hex")) };
  const { sig, hash } = await signIntent(i);
  const intentId = "int_" + hash.slice(2, 14);
  S.orders[intentId] = { intentId, type: "DCA", tokenIn: ti.symbol, tokenOut: to.symbol, amount: p.amountPerExec, interval: typeof p.interval === "string" ? p.interval : `${interval}s`, intervalSec: interval, maxExecs: p.maxExecs, execsDone: 0, nextRunAt: new Date(now * 1000).toISOString(), status: "open", agent: S.agent!.address, intent: toWire(i), sig, hash, txHashes: [] };
  save();
  return { intentId, nextRunAt: S.orders[intentId].nextRunAt };
}
export async function create_limit_order(p: { tokenIn: string; tokenOut: string; amountIn: number; limitPrice: number; expiry?: string | number; slippageBps?: number }) {
  await requireEligible();
  if (!S.vault) throw new ApiError(409, "No smart account");
  const ti = token(p.tokenIn), to = token(p.tokenOut);
  if (!(p.limitPrice > 0)) throw new ApiError(400, "limitPrice must be > 0 (USD per share)");
  precheckAgentCaps(p.tokenIn, p.tokenOut, await usdOf(p.tokenIn, p.amountIn));
  const now = await chainNow();
  const expiry = p.expiry == null ? now + 7 * 86400 : typeof p.expiry === "number" ? p.expiry : Math.floor(Date.parse(p.expiry) / 1000);
  if (!(expiry > now)) throw new ApiError(400, "expiry must be in the future");
  // minOut implied by the limit price, after fee and slippage.
  const slipL = p.slippageBps ?? cfg.DEFAULT_SLIPPAGE_BPS; if (!(slipL > 0) || slipL > cfg.MAX_SLIPPAGE_BPS) throw new ApiError(400, "slippageBps must be in (0, 300]");
  const i: Intent = { account: S.vault, tokenIn: ti.address, tokenOut: to.address, adapter: await poolFor(p.tokenIn, p.tokenOut), amountPerExec: units(p.amountIn, ti.decimals), minOutPerExec: 1n /* trigger = limitPrice; protection = mandatory oracle floor (maxOracleDevBps) */, limitPriceE8: BigInt(Math.round(p.limitPrice * 1e8)), interval: 0, maxExecs: 1, maxOracleDevBps: slipL, startTime: now, expiry, nonce: BigInt("0x" + randomBytes(16).toString("hex")) };
  const { sig, hash } = await signIntent(i);
  const intentId = "int_" + hash.slice(2, 14);
  S.orders[intentId] = { intentId, type: "Limit", tokenIn: ti.symbol, tokenOut: to.symbol, amount: p.amountIn, maxExecs: 1, execsDone: 0, limitPrice: p.limitPrice, expiry: new Date(expiry * 1000).toISOString(), status: "open", agent: S.agent!.address, intent: toWire(i), sig, hash, txHashes: [] };
  save();
  return { intentId };
}
/** Internal: sign + store an intent for a strategy (caller validated params). */
export async function _createIntent(o: { type: "DCA" | "Limit"; tokenIn: string; tokenOut: string; amount: number; interval?: number; intervalLabel?: string; maxExecs: number;
  limitPrice?: number; startTime: number; expiry: number; devBps: number; activationId: string; role: Order["role"]; rung?: number; parent?: string }) {
  if (!S.vault) throw new ApiError(409, "No smart account");
  if (!(o.devBps > 0 && o.devBps <= cfg.MAX_SLIPPAGE_BPS)) throw new ApiError(400, "oracleDevBps must be in (0, 300]");
  const ti = token(o.tokenIn), to = token(o.tokenOut);
  precheckAgentCaps(o.tokenIn, o.tokenOut, await usdOf(o.tokenIn, o.amount));
  const i: Intent = { account: S.vault, tokenIn: ti.address, tokenOut: to.address, adapter: await poolFor(o.tokenIn, o.tokenOut), amountPerExec: units(o.amount, ti.decimals), minOutPerExec: 1n,
    limitPriceE8: o.limitPrice ? BigInt(Math.round(o.limitPrice * 1e8)) : 0n, interval: o.interval ?? 0, maxExecs: o.maxExecs, maxOracleDevBps: o.devBps, startTime: o.startTime, expiry: o.expiry, nonce: BigInt("0x" + randomBytes(16).toString("hex")) };
  const { sig, hash } = await signIntent(i);
  const intentId = "int_" + hash.slice(2, 14);
  S.orders[intentId] = { intentId, type: o.type, tokenIn: ti.symbol, tokenOut: to.symbol, amount: o.amount, maxExecs: o.maxExecs, execsDone: 0, status: "open", agent: S.agent!.address, intent: toWire(i), sig, hash, txHashes: [],
    ...(o.type === "DCA" ? { interval: o.intervalLabel ?? `${o.interval}s`, intervalSec: o.interval, nextRunAt: new Date(o.startTime * 1000).toISOString() } : { limitPrice: o.limitPrice, expiry: new Date(o.expiry * 1000).toISOString() }),
    activationId: o.activationId, role: o.role, rung: o.rung, parent: o.parent };
  save();
  return S.orders[intentId];
}
export const _vault = () => S.vault;
export const _agent = () => S.agent;
export { spentLast24h as _spentLast24h, owner as _owner };

const publicOrder = (o: Order) => ({ intentId: o.intentId, type: o.type, ...(o.activationId ? { activationId: o.activationId, role: o.role } : {}), tokenIn: o.tokenIn, tokenOut: o.tokenOut, amount: o.amount, ...(o.type === "DCA" ? { interval: o.interval, execs: `${o.execsDone}/${o.maxExecs}`, nextRunAt: o.nextRunAt } : { limitPrice: o.limitPrice, expiry: o.expiry }), status: o.status, lastError: o.lastError ?? null, txHashes: o.txHashes });
export async function list_orders(status?: string) {
  // status enum: open | paused | filled | cancelled | expired
  return Object.values(S.orders).filter((o) => !status || o.status === status).map(publicOrder);
}
/** by: "owner" (owner token / dashboard), "agent" (MCP: signs with the agent key, review S-1), "auto" (agent if active, else owner). */
export async function cancel_order(intentId: string, by: "owner" | "agent" | "auto" = "owner") {
  const o = S.orders[intentId];
  if (!o || !S.vault) throw new ApiError(404, "Unknown intentId");
  const agentOk = S.agent?.status === "active";
  if (by === "agent" && !agentOk) throw new ApiError(403, "Agent key revoked; the owner can cancel from the dashboard");
  const signer = by === "owner" || (by === "auto" && !agentOk) ? owner() : agentWallet();
  const { hash } = await signer.write(S.vault, C.vault.abi, "cancelIntent", [BigInt(o.intent.nonce)]);
  o.status = "cancelled"; save();
  return { ...txOut(hash), status: "confirmed" };
}
export async function get_history(limit = 50) { return S.history.slice(0, limit); }

// ---------------------------------------------------------------- faucet
export async function faucet_testnet() {
  if (!S.vault) throw new ApiError(409, "Create the smart account first");
  const o = owner(), txs: string[] = [];
  try { txs.push((await o.write(dep().usdg, C.usdg.abi, "faucet")).hash); }
  catch (e) { const r = revertReason(e); if (r.name === "FaucetCooldown") throw new ApiError(429, "Faucet rate limit: 1,000 mUSDG per 24h"); throw e; }
  txs.push((await o.write(dep().usdg, C.usdg.abi, "transfer", [S.vault, 1000_000000n])).hash);
  if (cfg.IS_LOCAL) for (const s of Object.values(dep().stocks)) txs.push((await deployer().write(s.token, C.stock.abi, "mint", [S.vault, parseUnits("5", 18)])).hash); // mirrors the official faucet's 5 each
  return { ethFaucet: "https://faucet.testnet.chain.robinhood.com", musdgFaucet: `MockUSDG.faucet() at ${dep().usdg}: 1,000 mUSDG / 24h, sent to your smart wallet`, stocks: cfg.IS_LOCAL ? "5 each mock TSLA/AMZN/PLTR/NFLX/AMD minted to your smart wallet" : "Use the official faucet", txHashes: txs, status: "confirmed" };
}

export function get_usage() {
  const day = new Date().toISOString().slice(0, 10);
  if (S.usage.day !== day) S.usage = { day, calls: 0 };
  return { tier: "free (demo; tiers are placeholders)", callsToday: S.usage.calls, limit: 500 };
}
export function countCall() { get_usage(); S.usage.calls++; save(); }

// ---------------------------------------------------------------- keeper hooks
export const _state = () => S;
export { save as _save, humanReason, priceE8, chainNow, keeper as keeperWallet, updater as updaterWallet };
