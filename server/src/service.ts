// StockClaw application service: one function per api.js stub / MCP tool (ARCHITECTURE.md §7).
// Demo scope: single user. The user's wallet is simulated by DEMO_OWNER_KEY (no wallet-connect yet);
// agent session keys are held server-side (stand-in for KMS) and are AgentVault delegates.
import { randomBytes } from "node:crypto";
import { formatUnits, parseUnits, parseEventLogs, erc20Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { C, pub, read, wallet, revertReason, isRevert, loadDeployment, requireLocalAnvil, txState, txLogRow, assertTreasurySafe, deployerHandoff, ownedList, OWNED_CONTRACTS, type Deployment } from "./chain.js";
import { log } from "./log.js";
import * as cfg from "./config.js";
import { getDb, migrateFromJson, tx, nowIso } from "./db.js";

type SellGuard = (p: { tokenIn: string; tokenOut: string; amountIn: number }) => Promise<{ hold: boolean; estUsd: number; result?: unknown }>;
let sellGuard: SellGuard | undefined, sellRecorder: ((p: { vault: Address; ts: number; usd: number; txHash: string }) => void) | undefined;
export const setSellGuard = (f: SellGuard) => { sellGuard = f; };
export const setSellRecorder = (f: typeof sellRecorder) => { sellRecorder = f; };
type TradeHooks = { guard: (keyId: string, ref: string) => void; record: (keyId: string, side: "buy" | "sell", usd: number, ref: string) => void };
let tradeHooks: TradeHooks | undefined;
export const setTradeHooks = (h: TradeHooks) => { tradeHooks = h; };
type ActivityHook = (h: HistoryRow) => void;
let activityHook: ActivityHook | undefined;
export const setActivityHook = (f: ActivityHook) => { activityHook = f; };
export const keyIdOf = (addr: string) => "sk_" + addr.slice(2, 8).toLowerCase();
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
type HistoryRow = { txHash: string | null; explorerUrl?: string | null; swapId?: string; type: string; in: string; out: string; fee: string; ts: string; status: "filled" | "blocked" | "failed"; reason?: string; side?: "buy" | "sell"; executionId?: string; keyId?: string; usd?: number };
type State = {
  country?: string; attestation?: { sig: string; ts: string; expiresAt: string; signer: Address; txHash: string };
  vault?: Address; nextAgentIdx: number;
  agent?: { idx: number; address: Address; id: string; perTradeCap: number; dailyCap: number; days: number; allowlist: string[]; expiresAt: string; status: "active" | "revoked" | "expired"; label?: string; name?: string };
  orders: Record<string, Order>; history: HistoryRow[]; usage: { day: string; calls: number }; epoch?: number;
  activations?: Record<string, any>;
};

// State lives in SQLite (db.ts). S is the in-memory view; save() writes it back in one transaction.
const empty = (): State => ({ nextAgentIdx: 0, orders: {}, history: [], usage: { day: "", calls: 0 } });
function loadState(): State {
  const d = getDb(), legacy = migrateFromJson();
  if (legacy) { S = { ...empty(), ...legacy }; save(); return S; }
  const acc = d.prepare("SELECT json FROM accounts WHERE id='default'").get() as { json: string } | undefined;
  const st: State = { ...empty(), ...(acc ? JSON.parse(acc.json) : {}) };
  st.orders = Object.fromEntries((d.prepare("SELECT id, json FROM intents").all() as { id: string; json: string }[]).map((r) => [r.id, JSON.parse(r.json)]));
  st.activations = Object.fromEntries((d.prepare("SELECT id, json FROM activations").all() as { id: string; json: string }[]).map((r) => [r.id, JSON.parse(r.json)]));
  st.history = (d.prepare("SELECT json FROM history ORDER BY seq DESC LIMIT 500").all() as { json: string }[]).map((r) => JSON.parse(r.json));
  return st;
}
let S: State = empty();
const save = () => tx(() => {
  const d = getDb(), { orders, history, activations, ...acc } = S;
  d.prepare("INSERT INTO accounts(id, json, updated_at) VALUES('default', ?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at").run(JSON.stringify(acc), nowIso());
  const ui = d.prepare("INSERT INTO intents(id, status, activation_id, json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, activation_id=excluded.activation_id, json=excluded.json");
  const ids = Object.keys(orders);
  for (const o of Object.values(orders)) ui.run(o.intentId, o.status, o.activationId ?? null, JSON.stringify(o));
  if (!ids.length) d.prepare("DELETE FROM intents").run();
  const ua = d.prepare("INSERT INTO activations(id, status, json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, json=excluded.json");
  for (const a of Object.values(activations ?? {})) ua.run(a.activationId, a.status, JSON.stringify(a));
  if (!Object.keys(activations ?? {}).length) d.prepare("DELETE FROM activations").run();
  d.prepare("DELETE FROM history").run();
  const ih = d.prepare("INSERT INTO history(ts, json) VALUES(?, ?)");
  for (const h of [...history].reverse()) ih.run(h.ts, JSON.stringify(h));
});
S = loadState();
if (S.epoch) cfg.setUserEpoch(S.epoch);
/** Restart simulation (e2e) / recovery: rebuild the in-memory view from SQLite. */
export function _reloadFromDb() { S = loadState(); if (S.epoch) cfg.setUserEpoch(S.epoch); return S; }
const resetHooks: (() => void)[] = [];
export const onReset = (f: () => void) => { resetHooks.push(f); };
/** Dev reset (local chain only): fresh user = new owner key + fresh agent-key pool, all derived deterministically
 * from the anvil mnemonic at a new HD offset and funded with ETH via anvil_setBalance. Contracts stay deployed. */
export async function dev_reset() {
  if (!cfg.IS_LOCAL) throw new ApiError(403, "dev reset is only available on a local chain");
  await requireLocalAnvil("dev reset"); // R7-3: the hostname alone isn't enough
  const epoch = (S.epoch ?? 0) + 1;
  cfg.setUserEpoch(epoch);
  const addrs = [owner().address, ...cfg.keys.agentPool().map((k) => privateKeyToAccount(k).address)];
  for (const a of addrs) await pub.request({ method: "anvil_setBalance" as any, params: [a, "0x56BC75E2D63100000"] as any }); // 100 ETH
  S = { ...empty(), epoch };
  save(); resetHooks.forEach((f) => f());
  return { ok: true, epoch, owner: owner().address, agentKeys: addrs.length - 1 };
}
export function resetState() { S = empty(); save(); resetHooks.forEach((f) => f()); }
onReset(() => { getDb().prepare("DELETE FROM swaps").run(); });

let D: Deployment | undefined;
export const dep = () => (D ??= loadDeployment());
const owner = () => wallet(cfg.keys.demoOwner());
const deployer = () => wallet(cfg.keys.deployer());
const attester = () => wallet(cfg.keys.attester()); // L3: ATTESTER_ROLE holder (== deployer only on a verified local anvil)
const keeper = () => wallet(cfg.keys.keeper());
const updater = () => wallet(cfg.keys.updater());
const agentWallet = () => {
  if (!S.agent) throw new ApiError(409, "No agent key. Call create_session_key first.");
  return wallet(cfg.keys.agentPool()[S.agent.idx]);
};
const txOut = (hash: string) => ({ txHash: hash, explorerUrl: cfg.explorerTx(hash), status: "confirmed" });
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
  throw new ApiError(400, `Pair not supported: ${ti.symbol} -> ${to.symbol} (routes are USDG <-> stock)`);
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
    case "VaultSellCapExceeded": return `Daily agent sell limit reached (needs ${usd(args[1])}, ${usd(args[2])} left): owner approval required`;
    case "BadSellApproval": return "Sell approval signature invalid";
    case "SellNonceUsed": return "Sell approval already used or cancelled";
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
  const { hash } = await attester().write(dep().registry, C.registry.abi, "setEligible", [o.address, BigInt(expiry)]);
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
    sessionKey: S.agent ? { status, id: S.agent.id, agent: S.agent.address, expiresAt: S.agent.expiresAt, perTradeCap: S.agent.perTradeCap, dailyCap: S.agent.dailyCap, spentToday: await spentLast24h(), window: "rolling 24h, per vault (shared by all keys); buys only: exits to USDG don't use the daily limit", allowlist: S.agent.allowlist } : null,
  };
}
export type Caps = { perTradeCap?: number; dailyCap?: number; days?: number; allowlist?: string[]; label?: string; name?: string };
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
  S.agent = { idx, address: agent, id: "sk_" + agent.slice(2, 8).toLowerCase(), perTradeCap, dailyCap, days, allowlist, expiresAt: new Date(expiry * 1000).toISOString(), status: "active", label: String(caps.label ?? "").trim().slice(0, 64) || `Agent key ${"sk_" + agent.slice(2, 8).toLowerCase()}`, ...(caps.name ? { name: String(caps.name).trim().slice(0, 64) } : {}) };
  save();
  const created = { ...txOut(hash), status: "active", id: S.agent.id, agent, expiresAt: S.agent.expiresAt, perTradeCap, dailyCap, days, spentToday: 0, allowlist, label: S.agent.label, name: S.agent.name ?? null };
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
function pushHistory(h: HistoryRow) { S.history.unshift(h); S.history = S.history.slice(0, 500); save(); if (h.status === "filled") activityHook?.(h); }

// ---------------------------------------------------------------- single swaps: one intent = one tx (R7-1)
// Every execute_swap is a row in `swaps` (preparing -> submitted -> filled | failed, or -> pending while unconfirmed).
// * The tx hash + nonce are recorded on submit. If the receipt doesn't come within SETTLE_TIMEOUT_MS the call returns
//   status "pending" + txHash (never "failed"/"retry"), and a watcher keeps reconciling it by hash and nonce: receipt
//   first, then a speed-up at the SAME nonce, a dropped tx is re-sent at the same nonce; never a new nonce.
// * Retries of the same intent are idempotent: the same quoteId, or an identical swap (key, tokens, amount) while the
//   first is still in flight, returns that swap's state instead of sending again.
// * History, the activity feed and the anomaly breaker are written exactly once, when (and only if) the tx mines.
type SwapStatus = "preparing" | "submitted" | "pending" | "filled" | "failed" | "abandoned" | "held";
type SwapData = { tokenIn: string; tokenOut: string; amountIn: number; side: "buy" | "sell"; estUsd: number; inStr: string; ts: string; vault: Address; agent: Address; agentIdx: number;
  call?: { pool: Address; tokenIn: Address; tokenOut: Address; amountIn: string; minOut: string; deadline: string }; hashes: string[]; nonce?: number; lastSendAt?: number; speedUps?: number;
  jobIds: number[]; error?: string; amountOut?: number; outDec: number; outSym: string };
type SwapRow = { id: string; fp: string; status: SwapStatus; quote_id: string | null; key_id: string; tx_hash: string | null; created_at: number; updated_at: number; json: string };
const INFLIGHT: SwapStatus[] = ["preparing", "submitted", "pending"];
const swapGet = (id: string) => getDb().prepare("SELECT * FROM swaps WHERE id=?").get(id) as SwapRow | undefined;
const swapData = (r: SwapRow) => JSON.parse(r.json) as SwapData;
function swapPut(id: string, f: { status?: SwapStatus; tx_hash?: string | null; data?: Partial<SwapData> }) {
  const r = swapGet(id); if (!r) return;
  const data = { ...swapData(r), ...(f.data ?? {}) };
  getDb().prepare("UPDATE swaps SET status=?, tx_hash=?, json=?, updated_at=? WHERE id=?").run(f.status ?? r.status, f.tx_hash !== undefined ? f.tx_hash : r.tx_hash, JSON.stringify(data), Date.now(), id);
}
/** Atomic: an identical swap still in flight (same agent key, tokens, amount) is the same intent; else claim a new row. */
function claimSwap(id: string, fp: string, quoteId: string | null, keyId: string, data: SwapData): SwapRow | null {
  return tx(() => {
    const dup = getDb().prepare(`SELECT * FROM swaps WHERE fp=? AND status IN (${INFLIGHT.map(() => "?").join(",")}) ORDER BY created_at LIMIT 1`).get(fp, ...INFLIGHT) as SwapRow | undefined;
    if (dup) { const jid = data.jobIds[0]; if (jid != null) swapPut(dup.id, { data: { jobIds: [...new Set([...swapData(dup).jobIds, jid])] } }); return swapGet(dup.id)!; }
    const now = Date.now();
    getDb().prepare("INSERT INTO swaps(id, fp, status, quote_id, key_id, tx_hash, created_at, updated_at, json) VALUES(?,?,?,?,?,?,?,?,?)").run(id, fp, "preparing", quoteId, keyId, null, now, now, JSON.stringify(data));
    return null;
  });
}
const PENDING_COPY = { code: "TX_PENDING", message: "Your trade was sent and is still waiting for network confirmation.", retryable: false, hint: "Don't retry it: it is still pending and will update here when it confirms. Repeating the same trade won't send it twice." };
/** What the UI shows for a swap (pending card, settle event, GET /api/swaps): the stock, buy/sell and the USD size. */
const swapMeta = (r: SwapRow) => { const d = swapData(r); return { swapId: r.id, symbol: d.side === "buy" ? d.tokenOut : d.tokenIn, side: d.side, amountUsd: +d.estUsd.toFixed(2) }; };
function swapResult(r: SwapRow, duplicate = false) {
  const d = swapData(r);
  if (r.status === "filled") return { ...txOut(r.tx_hash!), amountOut: d.amountOut ?? null, ...swapMeta(r), ...(duplicate ? { duplicate: true, note: "Same trade as an earlier request: already confirmed, not sent again." } : {}) };
  if (INFLIGHT.includes(r.status)) return { status: "pending" as const, txHash: r.tx_hash, explorerUrl: r.tx_hash ? cfg.explorerTx(r.tx_hash) : null, ...swapMeta(r), ...PENDING_COPY, ...(duplicate ? { duplicate: true } : {}) };
  throw new ApiError(409, `This trade already finished (${r.status}${d.error ? `: ${d.error}` : ""}); nothing was sent again. Get a fresh quote to trade again.`);
}
type SwapSettled = (jobIds: number[], o: { result: unknown } | { error: string; status: number; extra?: unknown }) => void;
let swapSettledHook: SwapSettled | undefined;
export const setSwapSettledHook = (f: SwapSettled) => { swapSettledHook = f; };
function onSwapSubmitted(id: string, h: string, how: "send" | "speedup" | "resend" = "send") {
  const r = swapGet(id); if (!r) return;
  const d = swapData(r), row = txLogRow(h);
  const status: SwapStatus = r.status === "preparing" ? "submitted" : r.status === "abandoned" ? "pending" : r.status;
  swapPut(id, { status, tx_hash: h, data: { hashes: [...new Set([...d.hashes, h])], nonce: d.nonce ?? row?.nonce, lastSendAt: Date.now(), ...(how === "speedup" ? { speedUps: (d.speedUps ?? 0) + 1 } : {}) } });
  if (r.status === "abandoned") { log.warn("swap was sent after its job timed out: reconciling it", { swapId: id, txHash: h }); void watchSwap(id); }
}
async function outFromReceipt(rc: { logs: any[] }, tokenOut: Address, vault: Address, dec: number) {
  const logs = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: rc.logs as any }).filter((l: any) => l.address.toLowerCase() === tokenOut.toLowerCase() && l.args.to.toLowerCase() === vault.toLowerCase());
  return fmt(logs.reduce((a: bigint, l: any) => a + (l.args.value as bigint), 0n), dec);
}
/** The swap mined: record it exactly once (status transition in one SQLite transaction). */
async function finalizeSwap(id: string, hash: string) {
  const rc = await pub.getTransactionReceipt({ hash: hash as Hex });
  if (rc.status !== "success") return failSwap(id, hash, "Transaction reverted onchain");
  const r0 = swapGet(id)!, d = swapData(r0), out = await outFromReceipt(rc, token(d.outSym).address, d.vault, d.outDec);
  const prior = tx(() => { const r = swapGet(id)!; if (r.status === "filled" || r.status === "failed") return null; swapPut(id, { status: "filled", tx_hash: hash, data: { amountOut: out } }); return r.status; });
  const r = swapGet(id)!;
  if (prior) {
    const feeBps = Number(await read(dep().router, C.router.abi, "feeBps").catch(() => 30));
    pushHistory({ txHash: hash, explorerUrl: txOut(hash).explorerUrl, swapId: id, type: "swap", in: d.inStr, out: `${out.toFixed(6)} ${d.outSym}`, fee: `${(d.amountIn * feeBps / 10_000).toFixed(4)} ${d.tokenIn}`, ts: d.ts, status: "filled", side: d.side, keyId: r.key_id, usd: +d.estUsd.toFixed(2) });
    tradeHooks?.record(r.key_id, d.side, d.estUsd, id); // breaker: onchain reality, once per intent
    if (prior === "pending" || prior === "abandoned") { swapSettledHook?.(d.jobIds, { result: swapResult(r) }); log.info("pending swap confirmed", { swapId: id, txHash: hash }); }
  }
  return swapResult(r);
}
function failSwap(id: string, hash: string | null, reason: string): never {
  const prior = tx(() => { const r = swapGet(id)!; if (r.status === "filled" || r.status === "failed") return null; swapPut(id, { status: "failed", ...(hash ? { tx_hash: hash } : {}), data: { error: reason } }); return r.status; });
  const r = swapGet(id)!, d = swapData(r);
  if (prior && prior !== "preparing") {
    pushHistory({ txHash: hash, swapId: id, type: "swap", in: d.inStr, out: "—", fee: "—", ts: d.ts, status: "blocked", reason, side: d.side });
    if (prior === "pending" || prior === "abandoned") swapSettledHook?.(d.jobIds, { error: `Blocked: ${reason}`, status: 403, extra: { ...swapMeta(r), txHash: hash ?? r.tx_hash, explorerUrl: (hash ?? r.tx_hash) ? cfg.explorerTx((hash ?? r.tx_hash)!) : null } });
  }
  throw new ApiError(403, `Blocked: ${reason}`);
}
const watching = new Set<string>();
const swapPendingWaitMs = () => Number(process.env.PENDING_WAIT_MS ?? 20_000);
/** Reconcile a pending swap by hash and nonce until it mines or provably can't (watcher; survives restarts via resumeSwaps). */
export async function watchSwap(id: string) {
  if (watching.has(id)) return; watching.add(id);
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  try {
    const t0 = Date.now(), maxMs = Number(process.env.SWAP_WATCH_MS ?? 3_600_000);
    while (Date.now() - t0 < maxMs) {
      const r = swapGet(id); if (!r || !INFLIGHT.includes(r.status) && r.status !== "abandoned") return;
      const d = swapData(r);
      let anyPending = false;
      for (const h of d.hashes) {
        const st = await txState(h as Hex);
        if (st === "mined") { await finalizeSwap(id, h).catch(() => {}); return; }
        if (st === "reverted") { try { failSwap(id, h, "Transaction reverted onchain"); } catch { /* recorded */ } return; }
        if (st === "pending") anyPending = true;
      }
      const w = wallet(cfg.keys.agentPool()[d.agentIdx]);
      const quiet = Date.now() - (d.lastSendAt ?? r.updated_at) > swapPendingWaitMs();
      if (d.hashes.length && !anyPending && d.nonce != null && quiet) {
        // dropped: none of our txs is known to the node. Same nonce only: if it was used by another tx, ours can never mine.
        const used = await pub.getTransactionCount({ address: d.agent, blockTag: "latest" });
        if (used > d.nonce) { try { failSwap(id, null, "Not executed: the transaction was dropped and its nonce was used by another transaction"); } catch { /* recorded */ } return; }
        if (d.call) {
          log.warn("swap tx dropped: re-sending the same call at the same nonce", { swapId: id, nonce: d.nonce });
          try {
            const c = d.call; swapPut(id, { data: { lastSendAt: Date.now() } });
            const { hash } = await w.write(d.vault, C.vault.abi, "agentSwap", [c.pool, c.tokenIn, c.tokenOut, BigInt(c.amountIn), BigInt(c.minOut), BigInt(c.deadline)], { label: `swap:${id}:resend`, nonce: d.nonce, onSubmitted: (h) => onSwapSubmitted(id, h, "resend") });
            await finalizeSwap(id, hash).catch(() => {}); return;
          } catch (e) { if (isRevert(e)) { try { failSwap(id, null, `Not executed: ${humanReason(e)}`); } catch { /* recorded */ } return; } log.warn("swap re-send failed; will retry", { swapId: id, error: String((e as Error).message).slice(0, 200) }); }
        }
      } else if (anyPending && quiet && (d.speedUps ?? 0) < 3) {
        try { const h1 = await w.speedUp(r.tx_hash as Hex, `swap:${id}`); onSwapSubmitted(id, h1, "speedup"); }
        catch (e) { log.warn("swap speed-up failed; still watching", { swapId: id, error: String((e as Error).message).slice(0, 200) }); swapPut(id, { data: { lastSendAt: Date.now() } }); }
      }
      await sleep(Number(process.env.SWAP_POLL_MS ?? 1000));
    }
    log.warn("swap still pending after the watch window; resumes on restart", { swapId: id });
  } catch (e) { log.error("swap watcher crashed", { swapId: id, error: String((e as Error).message).slice(0, 200) }); }
  finally { watching.delete(id); }
}
/** Boot: resume every unresolved swap (hash from the row or, if the process died right after sending, from tx_log). */
export function resumeSwaps() {
  const rows = getDb().prepare(`SELECT * FROM swaps WHERE status IN ('preparing','submitted','pending','abandoned')`).all() as SwapRow[];
  let resumed = 0;
  for (const r of rows) {
    const logged = getDb().prepare("SELECT hash, nonce FROM tx_log WHERE label LIKE ? ORDER BY created_at").all(`swap:${r.id}%`) as { hash: string; nonce: number }[];
    const d = swapData(r), hashes = [...new Set([...d.hashes, ...logged.map((x) => x.hash)])];
    if (!hashes.length) { swapPut(r.id, { status: "failed", data: { error: "Interrupted before it was sent (nothing sent)" } }); continue; }
    swapPut(r.id, { status: "pending", tx_hash: r.tx_hash ?? hashes[hashes.length - 1], data: { hashes, nonce: d.nonce ?? logged[0]?.nonce } });
    void watchSwap(r.id); resumed++;
  }
  if (rows.length) log.info("resumed in-flight swaps", { resumed, total: rows.length });
  return { resumed, total: rows.length };
}
/** Trade job timed out (R7-1): if the swap was already sent, the job completes as "pending" + hash; else it can never send. */
export function onSwapJobTimeout(jobId: number) {
  const r = (getDb().prepare("SELECT * FROM swaps WHERE status IN ('preparing','submitted','pending') ORDER BY created_at DESC").all() as SwapRow[]).find((x) => swapData(x).jobIds.includes(jobId));
  if (!r) return undefined;
  if (r.status === "preparing" && !r.tx_hash) { swapPut(r.id, { status: "abandoned" }); return undefined; } // beforeSend refuses from now on
  swapPut(r.id, { status: "pending" }); void watchSwap(r.id);
  return swapResult(swapGet(r.id)!);
}
/** GET /api/swaps?status=pending: swaps sent but not confirmed yet, so a page load can show them (newest first). */
export function list_swaps(status = "pending") {
  if (status !== "pending") throw new ApiError(400, 'status must be "pending"');
  const rows = getDb().prepare("SELECT * FROM swaps WHERE tx_hash IS NOT NULL AND status IN ('preparing','submitted','pending','abandoned') ORDER BY created_at DESC LIMIT 100").all() as SwapRow[];
  return { swaps: rows.map((r) => { const d = swapData(r); return { ...swapMeta(r), jobId: d.jobIds[0] ?? null, jobIds: d.jobIds, txHash: r.tx_hash, explorerUrl: cfg.explorerTx(r.tx_hash!), createdAt: new Date(r.created_at).toISOString(), status: "pending" as const }; }) };
}
export const _swap = (id: string) => { const r = swapGet(id); return r ? { ...r, data: swapData(r) } : undefined; };

export async function execute_swap(arg: string | { tokenIn: string; tokenOut: string; amountIn: number; minOut?: number }, ctx: { jobId?: number } = {}) {
  await requireEligible();
  if (!S.vault) throw new ApiError(409, "No smart account");
  let p: { tokenIn: string; tokenOut: string; amountIn: number; minOutRaw: bigint }, quoteId: string | null = null;
  if (typeof arg === "string") {
    quoteId = arg;
    const prior = getDb().prepare("SELECT * FROM swaps WHERE quote_id=? ORDER BY created_at DESC LIMIT 1").get(arg) as SwapRow | undefined;
    if (prior) { if (ctx.jobId != null && INFLIGHT.includes(prior.status)) swapPut(prior.id, { data: { jobIds: [...new Set([...swapData(prior).jobIds, ctx.jobId])] } }); return swapResult(prior, true); } // retry of the same quote
    const q = quotes.get(arg);
    if (!q) throw new ApiError(404, "Unknown quoteId"); if (q.expiresAt < Date.now()) throw new ApiError(410, "Quote expired");
    quotes.delete(arg); p = q;
  } else {
    const q = await quote_swap(arg.tokenIn, arg.tokenOut, arg.amountIn);
    const floor = units(q.minOut, token(arg.tokenOut).decimals);
    p = { ...arg, minOutRaw: arg.minOut != null && units(arg.minOut, token(arg.tokenOut).decimals) > floor ? units(arg.minOut, token(arg.tokenOut).decimals) : floor };
  }
  const ti = token(p.tokenIn), to = token(p.tokenOut);
  const inStr = `${p.amountIn.toFixed(2)} ${ti.symbol}`, ts = new Date().toISOString(), side: "buy" | "sell" = ti.symbol === "mUSDG" ? "buy" : "sell";
  if (!S.agent || S.agent.status !== "active") {
    pushHistory({ txHash: null, type: "swap", in: inStr, out: "—", fee: "—", ts, status: "blocked", reason: "Agent key revoked (paused)", side });
    throw new ApiError(403, "Agent key revoked (paused)");
  }
  const ref = "swap_" + randomBytes(6).toString("hex"), estUsd = await usdOf(ti.symbol, p.amountIn), keyId = S.agent.id;
  const base: SwapData = { tokenIn: ti.symbol, tokenOut: to.symbol, amountIn: p.amountIn, side, estUsd, inStr, ts, vault: S.vault, agent: S.agent.address, agentIdx: S.agent.idx, hashes: [], jobIds: ctx.jobId != null ? [ctx.jobId] : [], outDec: to.decimals, outSym: to.symbol };
  // R7-1: the same intent still in flight => its state, never a second tx
  const dup = claimSwap(ref, `${keyId}|${ti.symbol}|${to.symbol}|${p.amountIn}`, quoteId, keyId, base);
  if (dup) {
    for (let i = 0; i < 300 && swapGet(dup.id)!.status === "preparing"; i++) await new Promise((res) => setTimeout(res, 100)); // let the first one get its hash
    return swapResult(swapGet(dup.id)!, true);
  }
  try {
    tradeHooks?.guard(keyId, ref);
    if (side === "sell" && to.symbol === "mUSDG" && sellGuard) { const g = await sellGuard({ tokenIn: ti.symbol, tokenOut: to.symbol, amountIn: p.amountIn }); if (g.hold) { swapPut(ref, { status: "held" }); return g.result as any; } }
  } catch (e) { swapPut(ref, { status: "failed", data: { error: (e as Error).message } }); throw e; }
  const a = agentWallet(), raw = units(p.amountIn, ti.decimals), deadline = BigInt((await chainNow()) + 300);
  try {
    const pool = await poolFor(p.tokenIn, p.tokenOut);
    swapPut(ref, { data: { call: { pool, tokenIn: ti.address, tokenOut: to.address, amountIn: raw.toString(), minOut: p.minOutRaw.toString(), deadline: deadline.toString() } } });
    // The vault enforces caps/allowlist/expiry onchain; any breach reverts => hard block.
    const { hash } = await a.write(S.vault, C.vault.abi, "agentSwap", [pool, ti.address, to.address, raw, p.minOutRaw, deadline], {
      label: `swap:${ref}`,
      beforeSend: () => { if (swapGet(ref)?.status !== "preparing") throw new ApiError(409, "This trade timed out before it was sent; nothing was sent. Check history, then try again."); },
      onSubmitted: (h) => onSwapSubmitted(ref, h),
    });
    return await finalizeSwap(ref, hash);
  } catch (e) {
    const row = swapGet(ref)!;
    if (e instanceof ApiError) { if (row.status === "preparing") swapPut(ref, { status: "failed", data: { error: e.message } }); throw e; }
    if (!row.tx_hash) { // never sent (simulation revert or transport error before the send)
      if (!isRevert(e)) { swapPut(ref, { status: "failed", data: { error: String((e as Error).message).slice(0, 200) } }); throw e; }
      const reason = humanReason(e);
      swapPut(ref, { status: "failed", data: { error: reason } });
      pushHistory({ txHash: null, type: "swap", in: inStr, out: "—", fee: "—", ts, status: "blocked", reason, side });
      if (/rolling-24h cap/.test(reason)) onCapBlock?.();
      throw new ApiError(403, `Blocked: ${reason}`);
    }
    // Sent. Mined-but-reverted => blocked; otherwise the receipt didn't come in time: PENDING (keep reconciling; never resend at a new nonce)
    const st = await txState(row.tx_hash as Hex).catch(() => "unknown" as const);
    if (st === "mined") return finalizeSwap(ref, row.tx_hash);
    if (st === "reverted") failSwap(ref, row.tx_hash, "Transaction reverted onchain");
    log.warn("swap sent but not confirmed in time: pending, reconciling by hash/nonce", { swapId: ref, txHash: row.tx_hash, error: String((e as Error).message).slice(0, 160) });
    swapPut(ref, { status: "pending" }); void watchSwap(ref);
    return swapResult(swapGet(ref)!);
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
export async function faucet() {
  if (!S.vault) throw new ApiError(409, "Create the smart account first");
  const o = owner(), txs: string[] = [];
  try { txs.push((await o.write(dep().usdg, C.usdg.abi, "faucet")).hash); }
  catch (e) { const r = revertReason(e); if (r.name === "FaucetCooldown") throw new ApiError(429, "Faucet rate limit: 1,000 USDG per 24h"); throw e; }
  txs.push((await o.write(dep().usdg, C.usdg.abi, "transfer", [S.vault, 1000_000000n])).hash);
  if (cfg.isLocalChain()) for (const s of Object.values(dep().stocks)) txs.push((await deployer().write(s.token, C.stock.abi, "mint", [S.vault, parseUnits("5", 18)])).hash); // mirrors the official faucet's 5 each
  return { ethFaucet: cfg.FAUCET_URL, faucetUrl: cfg.FAUCET_URL, musdgFaucet: `MockUSDG.faucet() at ${dep().usdg}: 1,000 USDG / 24h, sent to your smart wallet`, stocks: cfg.isLocalChain() ? "5 each TSLA/AMZN/PLTR/NFLX/AMD added to your smart wallet" : "Use the official faucet", txHashes: txs, status: "confirmed" };
}
/** @deprecated alias of faucet (kept for MCP/REST consumers) */
export const faucet_testnet = faucet;

export function get_usage() {
  const day = new Date().toISOString().slice(0, 10);
  if (S.usage.day !== day) S.usage = { day, calls: 0 };
  return { tier: "free (demo; tiers are placeholders)", callsToday: S.usage.calls, limit: 500 };
}
export function countCall() { get_usage(); S.usage.calls++; save(); }

// ---------------------------------------------------------------- keeper hooks
export const _state = () => S;
export const _trade = () => tradeHooks;
/** Startup (Gaius R6): fail closed if the anomaly breaker isn't registered. BREAKER=off only on a local chain with ALLOW_OPEN_LOCAL=1. */
/** Startup (L3): off a verified anvil, refuse if ATTESTER is the deployer, by config (keys/addresses) and onchain (the
 * deployer must hold no ATTESTER_ROLE / registry admin). On a verified anvil: today's behavior + a logged warning. */
/** Startup role checks (fail closed, before listening). Off a verified anvil (R7-3 verdict):
 *  G1   the deployer must be known (DEPLOYER_KEY | DEPLOYER | deployments file `deployer`) and differ from the attester;
 *  D-1/D1-R1 TREASURY_SAFE (else the deployments file `treasury`) is a real Safe (code, not 7702, threshold >= 2,
 *       >= 3 owners, none of them the deployer/keeper/attester);
 *  L3   the deployer holds neither ATTESTER_ROLE nor registry admin; G1 the attester DOES hold ATTESTER_ROLE;
 *       the Safe owns all 13 Ownable2Step contracts with no pending owner and holds registry admin.
 * On a verified anvil: today's behavior + the ATTESTER_IS_DEPLOYER warning. Any RPC error throws (refuses to start). */
export async function assertDeployRoles(env = process.env) {
  const d = (() => { try { return dep(); } catch { return undefined; } })();
  const sep = cfg.attesterSeparation(env, d?.deployer); // throws off-anvil: attester == deployer, attester unset, deployer unknown (G1)
  if (cfg.isLocalChain()) { if (sep.warning) log.warn("ATTESTER", { code: "ATTESTER_IS_DEPLOYER", message: sep.warning }); return { local: true, ...sep }; }
  if (!d) throw new Error("REFUSING TO START: no deployments file off a verified local anvil (the role checks need it)");
  const deployer = sep.deployer as Address, attester = sep.attester as Address;
  const keeper = env.KEEPER_KEY ? privateKeyToAccount(env.KEEPER_KEY as Hex).address : d.keeper; // (env KEEPER is the on/off switch, not an address)
  if (!keeper) throw new Error("REFUSING TO START: the keeper address is unknown (set KEEPER_KEY, or `keeper` in the deployments file) off a verified local anvil");
  const safe = (env.TREASURY_SAFE ?? d.treasury) as Address;
  const s = await assertTreasurySafe(safe, { deployer, keeper, attester }, false);
  const reg = d.registry;
  const [att, admin] = await Promise.all([read<Hex>(reg, C.registry.abi, "ATTESTER_ROLE"), read<Hex>(reg, C.registry.abi, "DEFAULT_ADMIN_ROLE")]);
  if (await read<boolean>(reg, C.registry.abi, "hasRole", [att, deployer])) throw new Error(`REFUSING TO START: the deployer ${deployer} holds ATTESTER_ROLE on the registry ${reg}. Off a verified local anvil the attester must be a separate key (L3): redeploy with ATTESTER set to it.`);
  if (await read<boolean>(reg, C.registry.abi, "hasRole", [admin, deployer])) throw new Error(`REFUSING TO START: the deployer ${deployer} still holds DEFAULT_ADMIN_ROLE on the registry ${reg} (L3 handoff not done)`);
  if (!(await read<boolean>(reg, C.registry.abi, "hasRole", [att, attester]))) throw new Error(`REFUSING TO START: ATTESTER ${attester} does not hold ATTESTER_ROLE on the registry ${reg} (G1: wrong ATTESTER_KEY, or the role was never granted)`);
  // exactly 13 Ownable2Step contracts, derived from the deployments file: router, oracle, MockUSDG, 5 pools, 5 feeds
  ownedList(d);
  const ss = Object.values(d.stocks);
  const h = await deployerHandoff({ router: d.router, oracle: d.oracle, registry: reg, usdg: d.usdg, pools: ss.map((x) => x.pool), feeds: ss.map((x) => x.feed) }, deployer, safe);
  if (h.checked !== OWNED_CONTRACTS) throw new Error(`REFUSING TO START: the ownership check covered ${h.checked} contracts, expected exactly ${OWNED_CONTRACTS}`);
  if (h.problems.length) throw new Error(`REFUSING TO START: the Safe ${safe} does not own the deployment yet (L3 step 5): ${h.problems.slice(0, 6).join("; ")}${h.problems.length > 6 ? ` (+${h.problems.length - 6} more)` : ""}`);
  log.info("deploy roles ok", { safe, singleton: s.singleton, threshold: s.threshold, owners: s.owners, ownedBySafe: h.ownedBySafe, attester, deployer });
  return { local: false, ...sep };
}
export function assertGuardrails(env = process.env) {
  if (env.BREAKER === "off") {
    if (!(cfg.isLocalChain() && env.ALLOW_OPEN_LOCAL === "1")) throw new Error(`REFUSING TO START: BREAKER=off is only allowed on a local chain with ALLOW_OPEN_LOCAL=1 (test mode); the node must be a verified anvil (R7-3: ${JSON.stringify(cfg.localNodeInfo())})`);
    return { breaker: "off (local test mode)" };
  }
  if (!tradeHooks || !activityHook) throw new Error("REFUSING TO START: anomaly breaker / activity hooks are not registered (breaker.ts not loaded)");
  return { breaker: "on" };
}
export { usdOf as _usdOf, save as _save, pushHistory as _pushHistory, poolFor as _poolFor, token as _token, units as _units, fmt as _fmt, agentWallet as _agentWallet, requireEligible as _requireEligible, txOut as _txOut, humanReason, priceE8, chainNow, keeper as keeperWallet, updater as updaterWallet };
