// Keeper: every KEEPER_INTERVAL_MS (60s) push the mock oracle, then execute due DCA / limit intents.
// No catch-up: the router skips missed DCA slots (next slot = first boundary in the future); the keeper
// never replays missed runs. Keeper pays testnet gas; it has execute rights only (no custody).
import { parseUnits } from "viem";
import { C, read, revertReason } from "./chain.js";
import * as svc from "./service.js";
import { KEEPER_INTERVAL_MS, MARKET_MODE } from "./config.js";
import { BASE_PRICES } from "./deploy.js";

const MAX_DRIFT = 0.03; // stay inside the pools' 5% oracle band

/** Price source for the demo: bounded random walk around base prices. TODO: real market-data vendor. */
export async function pushOracle(overrides: Record<string, number> = {}) {
  const d = svc.dep(), k = svc.keeperWallet();
  const mode = Number(await read(d.oracle, C.oracle.abi, "marketMode"));
  const want = MARKET_MODE === "open" ? 1 : 0;
  if (mode !== want) await k.write(d.oracle, C.oracle.abi, "setMarketMode", [want]);
  const pushed: Record<string, number> = {};
  for (const [sym, s] of Object.entries(d.stocks)) {
    const cur = Number((await svc.priceE8(sym)).p) / 1e8;
    const base = BASE_PRICES[sym] ?? cur;
    let next = overrides[sym] ?? cur * (1 + (Math.random() - 0.5) * 0.004);
    if (overrides[sym] == null) next = Math.min(base * (1 + MAX_DRIFT), Math.max(base * (1 - MAX_DRIFT), next));
    await k.write(s.feed, C.agg.abi, "updateAnswer", [parseUnits(next.toFixed(8), 8)]);
    pushed[sym] = +next.toFixed(4);
  }
  return pushed;
}

const BENIGN = new Set(["NotYet", "LimitNotMet"]);
export async function executeDue() {
  const S = svc._state(), d = svc.dep(), k = svc.keeperWallet(), now = await svc.chainNow();
  const results: { intentId: string; result: string }[] = [];
  for (const o of Object.values(S.orders)) {
    if (!["active", "open"].includes(o.status)) continue;
    const i = svc.fromWire(o.intent);
    if (now > i.expiry) { o.status = "expired"; results.push({ intentId: o.intentId, result: "expired" }); continue; }
    const [execs, nextAt] = await read<[number, number]>(d.router, C.router.abi, "intentState", [o.hash]);
    if (Number(execs) >= i.maxExecs) { o.status = "filled"; continue; }
    const due = Number(nextAt) === 0 ? i.startTime : Number(nextAt);
    if (now < due) continue;
    try {
      const { hash } = await k.write(i.account, C.vault.abi, "executeIntent", [i, o.sig]);
      const [n2, next2] = await read<[number, number]>(d.router, C.router.abi, "intentState", [o.hash]);
      o.execsDone = Number(n2); o.txHashes.push(hash); o.lastError = undefined;
      o.nextRunAt = o.type === "DCA" && o.execsDone < o.maxExecs ? new Date(Number(next2) * 1000).toISOString() : null;
      if (o.execsDone >= o.maxExecs) o.status = "filled";
      S.history.unshift({ txHash: hash, type: o.type === "DCA" ? "dca" : "limit", in: `${o.amount.toFixed(2)} ${o.tokenIn}`, out: `→ ${o.tokenOut}`, fee: `${(o.amount * 0.003).toFixed(4)} ${o.tokenIn}`, ts: new Date().toISOString(), status: "filled" });
      results.push({ intentId: o.intentId, result: `executed ${o.execsDone}/${o.maxExecs}` });
    } catch (e) {
      const name = revertReason(e).name, reason = svc.humanReason(e);
      o.lastError = reason;
      if (name === "NotAgent" || name === "AgentExpired") o.status = "paused (key revoked)";
      if (name === "NonceIsCancelled") o.status = "cancelled";
      if (!BENIGN.has(name)) S.history.unshift({ txHash: null, type: o.type === "DCA" ? "dca" : "limit", in: `${o.amount.toFixed(2)} ${o.tokenIn}`, out: "—", fee: "—", ts: new Date().toISOString(), status: "blocked", reason });
      results.push({ intentId: o.intentId, result: `skipped: ${reason}` });
    }
  }
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
