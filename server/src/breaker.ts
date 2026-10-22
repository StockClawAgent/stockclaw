// Per-key anomaly breaker (Gaius guardrail 2). A key trips when, within 1h, its buys reach 80% of its 24h buy cap or
// its sells reach 80% of the vault's $500 sell cap, counting only when the usage comes from >= 2 separate executions, or when it starts a 6th trade within 10 minutes (a basket counts
// as ONE trade: its legs share a ref). A tripped key is not relayed for (agent swaps, basket legs, keeper intents)
// until the owner resumes or revokes it; trips are logged as alerts and shown in the activity feed and /api/health.
// Counting restarts at resume. BREAKER=off disables it (used by legacy e2e steps that test the onchain caps directly).
import * as svc from "./service.js";
import * as act from "./activity.js";
import * as cfg from "./config.js";
import { getDb } from "./db.js";
import { log } from "./log.js";

// R7-3: BREAKER=off only takes effect on a verified local anvil (re-checked at run time, not just at startup)
const enabled = () => !(process.env.BREAKER === "off" && cfg.isLocalChain());
const MAX_TRADES_10M = 5, PCT = 0.8, SELL_CAP = 500;
type State = { tripped: boolean; trippedAt: number | null; resumedAt: number | null; reason: string | null };
export function state(keyId: string): State {
  const r = getDb().prepare("SELECT tripped, tripped_at, resumed_at, reason FROM key_breaker WHERE key_id=?").get(keyId) as any;
  return r ? { tripped: !!r.tripped, trippedAt: r.tripped_at, resumedAt: r.resumed_at, reason: r.reason } : { tripped: false, trippedAt: null, resumedAt: null, reason: null };
}
export const recentAlerts = () => getDb().prepare("SELECT key_id, json FROM activity WHERE kind='alert' AND ts > ?").all(new Date(Date.now() - 3600_000).toISOString()) as { key_id: string; json: string }[];
export const tripped = () => (getDb().prepare("SELECT key_id, reason, tripped_at FROM key_breaker WHERE tripped=1").all() as { key_id: string; reason: string; tripped_at: number }[]);
function trip(keyId: string, reason: string) {
  getDb().prepare("INSERT INTO key_breaker(key_id, tripped, tripped_at, reason) VALUES(?,1,?,?) ON CONFLICT(key_id) DO UPDATE SET tripped=1, tripped_at=excluded.tripped_at, reason=excluded.reason").run(keyId, Date.now(), reason);
  log.error("ALERT", { code: "KEY_BREAKER_TRIPPED", severity: "critical", keyId, message: reason });
  act.add({ kind: "breaker", keyId, title: `Agent key ${keyId} paused by the anomaly breaker: ${reason}`, actions: [act.resumeAction(keyId), act.revokeAction(keyId)] });
}
const since = (keyId: string, windowMs: number) => Math.max(Date.now() - windowMs, state(keyId).resumedAt ?? 0);
const blockedMsg = (s: State) => `Agent key paused by the anomaly breaker (${s.reason}). The owner can resume or revoke it in the dashboard.`;
/** Before relaying a trade for `keyId`. `ref` groups legs of one basket into one trade. */
export function guard(keyId: string, ref: string) {
  if (!enabled()) return;
  const s = state(keyId);
  if (s.tripped) throw new svc.ApiError(423, blockedMsg(s));
  const d = getDb(), t0 = since(keyId, 10 * 60_000);
  const seen = d.prepare("SELECT 1 FROM key_trades WHERE key_id=? AND ref=? AND ts>?").get(keyId, ref, t0);
  const n = (d.prepare("SELECT COUNT(DISTINCT ref) n FROM key_trades WHERE key_id=? AND ts>?").get(keyId, t0) as { n: number }).n;
  if (!seen && n >= MAX_TRADES_10M) { trip(keyId, `more than ${MAX_TRADES_10M} trades in 10 minutes`); throw new svc.ApiError(423, blockedMsg(state(keyId))); }
}
/** After a fill: record it, then trip if 80% of a 24h cap was used within the last hour (blocks the NEXT trade). */
export function record(keyId: string, side: "buy" | "sell", usd: number, ref: string) {
  const d = getDb();
  d.prepare("INSERT INTO key_trades(key_id, ts, side, usd, ref) VALUES(?,?,?,?,?)").run(keyId, Date.now(), side, usd, ref);
  if (!enabled() || state(keyId).tripped) return;
  // 80% rule needs usage from >= 2 separate executions (a basket = one execution; one basket alone never trips: the onchain caps bound it)
  const t0 = since(keyId, 3600_000), q = (sd: string) => d.prepare("SELECT COALESCE(SUM(usd),0) s, COUNT(DISTINCT ref) n FROM key_trades WHERE key_id=? AND side=? AND ts>?").get(keyId, sd, t0) as { s: number; n: number };
  const buyCap = Math.min(svc._agent()?.dailyCap ?? cfg.MAX_PER_DAY_USD, cfg.MAX_PER_DAY_USD), B = q("buy"), S = q("sell"), b = B.n >= 2 ? B.s : 0, s = S.n >= 2 ? S.s : 0;
  // Gaius: a single execution reaching 80% alerts (feed + health) but doesn't pause
  for (const [side, X, cap] of [["buy", B, buyCap], ["sell", S, SELL_CAP]] as const)
    if (X.n < 2 && X.s >= PCT * cap && !d.prepare("SELECT 1 FROM activity WHERE kind='alert' AND key_id=? AND json LIKE ?").get(keyId, `%"ref":"${ref}"%`)) {
      log.error("ALERT", { code: "KEY_SINGLE_EXECUTION_80PCT", severity: "warn", keyId, ref, message: `${side}s $${X.s.toFixed(2)} from one execution (>= 80% of the $${cap} cap); not paused` });
      act.add({ kind: "alert", keyId, ref, code: "KEY_SINGLE_EXECUTION_80PCT", title: `Agent key ${keyId}: one execution used $${X.s.toFixed(2)} of the $${cap} 24h ${side} cap (>= 80%). Not paused; the onchain cap still applies.`, actions: [act.revokeAction(keyId)] } as any);
    }
  if (b >= PCT * buyCap) trip(keyId, `buys reached $${b.toFixed(2)} (>= 80% of the $${buyCap} 24h buy cap) within 1h`);
  else if (s >= PCT * SELL_CAP) trip(keyId, `sells reached $${s.toFixed(2)} (>= 80% of the $${SELL_CAP} 24h sell cap) within 1h`);
}
export function resume(keyId: string) {
  const s = state(keyId);
  if (!s.tripped) return { keyId, breaker: s };
  getDb().prepare("UPDATE key_breaker SET tripped=0, resumed_at=? WHERE key_id=?").run(Date.now(), keyId);
  act.add({ kind: "breaker_resumed", keyId, title: `Owner resumed agent key ${keyId}`, actions: [act.revokeAction(keyId)] });
  log.info("ALERT-CLEARED", { code: "KEY_BREAKER_TRIPPED", keyId });
  return { keyId, breaker: state(keyId) };
}
export const reset = () => { const d = getDb(); d.prepare("DELETE FROM key_trades").run(); d.prepare("DELETE FROM key_breaker").run(); };
svc.setTradeHooks({ guard, record });
svc.setActivityHook((h) => {
  const keyId = h.keyId ?? svc._agent()?.id ?? null, side = h.side ?? (h.in.endsWith("mUSDG") ? "buy" : "sell");
  act.add({ kind: "trade", keyId, title: `${side === "sell" ? "Agent sold" : "Agent bought"}: ${h.in} -> ${h.out}${h.reason ? ` (${h.reason})` : ""}`, side, usd: h.usd, txHash: h.txHash, ...(h.swapId ? { swapId: h.swapId } : {}), executionId: h.executionId, source: h.type, actions: [act.revokeAction(keyId)] });
});
svc.onReset(() => { reset(); act.reset(); });
