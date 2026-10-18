// Keeper: every KEEPER_INTERVAL_MS (60s) push the mock oracle, then execute due DCA / limit intents.
// No catch-up: the router skips missed DCA slots (next slot = first boundary in the future); the keeper
// never replays missed runs. Keeper pays testnet gas; it has execute rights only (no custody).
import { parseUnits } from "viem";
import { C, read, revertReason } from "./chain.js";
import * as svc from "./service.js";
import { KEEPER_INTERVAL_MS, getMarketMode } from "./config.js";
import { BASE_PRICES } from "./deploy.js";
import { sessionFor } from "./marketCalendar.js";
import * as strat from "./strategies.js";

const MAX_DRIFT = 0.03; // stay inside the pools' 5% oracle band

/** Price source for the demo: bounded random walk around base prices. TODO: real market-data vendor. */
export async function pushOracle(overrides: Record<string, number> = {}) {
  const d = svc.dep(), u = svc.updaterWallet();
  await syncMarketSchedule();
  const pushed: Record<string, number> = {};
  for (const [sym, s] of Object.entries(d.stocks)) {
    const cur = Number((await svc.priceE8(sym)).p) / 1e8;
    const base = BASE_PRICES[sym] ?? cur;
    let next = overrides[sym] ?? cur * (1 + (Math.random() - 0.5) * 0.004);
    if (overrides[sym] == null) {
      next = Math.min(base * (1 + MAX_DRIFT), Math.max(base * (1 - MAX_DRIFT), next));
      const allowed = Number(await read(s.feed, C.agg.abi, "allowedDeltaBps")) / 10_000 * 0.9; // respect the feed's per-update move cap
      next = Math.min(cur * (1 + allowed), Math.max(cur * (1 - allowed), next));
    }
    await u.write(s.feed, C.agg.abi, "updateAnswer", [parseUnits(next.toFixed(8), 8)]);
    pushed[sym] = +next.toFixed(4);
  }
  return pushed;
}

/**
 * Market-schedule adapter. Two contract generations:
 *  - "legacy" (current HEAD): PriceOracle.setMarketMode(Schedule|Open|Closed) + setSchedule(openMinute, closeMinute).
 *  - "session" (Quintus's next commit): fail-closed keeper-pushed setSession(openAt, closeAt), closeAt > openAt,
 *    window <= 8h, not in the past; no/expired session = closed. Detected from the ABI, so the switch is automatic.
 * Calendar: hardcoded NYSE 2026-2027 (DST, holidays, early closes) in marketCalendar.ts.
 * Local demo override (MARKET_MODE=open): legacy => force Open; session => push [now, now+8h], re-push 1h before expiry.
 */
const hasFn = (name: string) => (C.oracle.abi as any[]).some((x) => x.type === "function" && x.name === name);
export const scheduleAdapterKind = () => (hasFn("setSession") ? "session" : "legacy");
let pushedSession: { openAt: number; closeAt: number } | null = null;
const MAX_WINDOW = 8 * 3600;

export async function syncMarketSchedule() {
  const d = svc.dep(), k = svc.keeperWallet(), now = await svc.chainNow();
  const override = getMarketMode() === "open";
  if (scheduleAdapterKind() === "session") {
    let win: { openAt: number; closeAt: number } | null = null;
    if (override) {
      if (!pushedSession || pushedSession.closeAt - now < 3600) win = { openAt: now, closeAt: now + MAX_WINDOW };
    } else {
      const s = sessionFor(new Date(now * 1000));
      if (!s.open) return { adapter: "session", mode: "closed", reason: s.reason };
      const day = Math.floor(now / 86400) * 86400, openAt = day + s.openMinute! * 60, closeAt = day + s.closeMinute! * 60;
      if (now < closeAt && pushedSession?.closeAt !== closeAt) win = { openAt: Math.max(openAt, now), closeAt }; // push before open (or on restart mid-session)
    }
    if (win) { await k.write(d.oracle, C.oracle.abi, "setSession", [BigInt(win.openAt), BigInt(win.closeAt)]); pushedSession = win; }
    return { adapter: "session", mode: override ? "open (override)" : "session", session: pushedSession };
  }
  const mode = Number(await read(d.oracle, C.oracle.abi, "marketMode")); // 0 Schedule, 1 Open, 2 Closed
  if (override) { if (mode !== 1) await k.write(d.oracle, C.oracle.abi, "setMarketMode", [1]); return { adapter: "legacy", mode: "open (override)" }; }
  const s = sessionFor(new Date(now * 1000));
  if (!s.open) { if (mode !== 2) await k.write(d.oracle, C.oracle.abi, "setMarketMode", [2]); return { adapter: "legacy", mode: "closed", reason: s.reason }; }
  const [o, c] = [Number(await read(d.oracle, C.oracle.abi, "openMinute")), Number(await read(d.oracle, C.oracle.abi, "closeMinute"))];
  if (o !== s.openMinute || c !== s.closeMinute) await k.write(d.oracle, C.oracle.abi, "setSchedule", [s.openMinute, s.closeMinute]);
  if (mode !== 0) await k.write(d.oracle, C.oracle.abi, "setMarketMode", [0]);
  return { adapter: "legacy", mode: "schedule", openMinute: s.openMinute, closeMinute: s.closeMinute, reason: s.reason };
}
export const _resetPushedSession = () => { pushedSession = null; };

const BENIGN = new Set(["NotYet", "LimitNotMet"]);
export async function executeDue() {
  const S = svc._state(), d = svc.dep(), k = svc.keeperWallet(), now = await svc.chainNow();
  const results: { intentId: string; result: string }[] = [];
  for (const o of Object.values(S.orders)) {
    if (o.status !== "open") continue;
    if (!strat.intentRunnable(o)) continue; // strategy intents run only for owner-confirmed, active activations
    const i = svc.fromWire(o.intent);
    if (now > i.expiry) { o.status = "expired"; results.push({ intentId: o.intentId, result: "expired" }); continue; }
    const [execs, nextAt] = await read<[number, number]>(d.router, C.router.abi, "intentState", [o.hash]);
    if (Number(execs) >= i.maxExecs) { o.status = "filled"; continue; }
    const due = Number(nextAt) === 0 ? i.startTime : Number(nextAt);
    if (now < due) continue;
    try {
      const outTok = (o.tokenOut === "mUSDG" ? d.usdg : d.stocks[o.tokenOut].token);
      const before = await read<bigint>(outTok, C.usdg.abi, "balanceOf", [i.account]);
      const { hash } = await k.write(i.account, C.vault.abi, "executeIntent", [i, o.sig]);
      const received = Number(((await read<bigint>(outTok, C.usdg.abi, "balanceOf", [i.account])) - before)) / 10 ** (o.tokenOut === "mUSDG" ? 6 : 18);
      const [n2, next2] = await read<[number, number]>(d.router, C.router.abi, "intentState", [o.hash]);
      o.execsDone = Number(n2); o.txHashes.push(hash); o.lastError = undefined;
      o.nextRunAt = o.type === "DCA" && o.execsDone < o.maxExecs ? new Date(Number(next2) * 1000).toISOString() : null;
      if (o.execsDone >= o.maxExecs) o.status = "filled";
      S.history.unshift({ txHash: hash, type: o.type === "DCA" ? "dca" : "limit", in: `${o.amount.toFixed(2)} ${o.tokenIn}`, out: `→ ${o.tokenOut}`, fee: `${(o.amount * 0.003).toFixed(4)} ${o.tokenIn}`, ts: new Date().toISOString(), status: "filled" });
      results.push({ intentId: o.intentId, result: `executed ${o.execsDone}/${o.maxExecs}` });
      if (o.activationId) { const stock = o.tokenOut === "mUSDG" ? o.tokenIn : o.tokenOut; await strat.onFill(o, received, Number((await svc.priceE8(stock)).p) / 1e8, hash); }
    } catch (e) {
      const name = revertReason(e).name, reason = svc.humanReason(e);
      const prev = o.lastError; o.lastError = reason;
      if (name === "NotAgent" || name === "AgentExpired") o.status = "paused";
      if (name === "NonceIsCancelled") o.status = "cancelled";
      if (!BENIGN.has(name) && prev !== reason) S.history.unshift({ txHash: null, type: o.type === "DCA" ? "dca" : "limit", in: `${o.amount.toFixed(2)} ${o.tokenIn}`, out: "—", fee: "—", ts: new Date().toISOString(), status: "blocked", reason });
      results.push({ intentId: o.intentId, result: `skipped: ${reason}` });
    }
  }
  strat.refreshAll();
  svc._save();
  return results;
}

export async function tick() {
  const prices = await pushOracle();
  const executed = await executeDue();
  return { prices, executed };
}

export function startKeeper(log = console.log) {
  let busy = false;
  const run = async () => {
    if (busy) return; busy = true;
    try { const r = await tick(); log(`[keeper] ${new Date().toISOString()} prices ${JSON.stringify(r.prices)} ${r.executed.length ? JSON.stringify(r.executed) : ""}`); }
    catch (e) { log(`[keeper] error: ${(e as Error).message}`); }
    finally { busy = false; }
  };
  run();
  return setInterval(run, KEEPER_INTERVAL_MS);
}
