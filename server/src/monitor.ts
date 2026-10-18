// Basic alerting (review-3 B12): keeper failures, stale oracle, closed session, cap-block spikes.
// Alerts are logged once when they fire ("[ALERT]") and when they clear ("[ALERT-CLEARED]"), and reported by /api/health.
import { C, read } from "./chain.js";
import * as svc from "./service.js";

const st = { lastTickOk: 0, consecutiveFailures: 0, lastError: "", capBlocks: [] as number[] };
export const recordTick = (ok: boolean, err?: string) => { if (ok) { st.lastTickOk = Date.now(); st.consecutiveFailures = 0; } else { st.consecutiveFailures++; st.lastError = err ?? ""; } };
export const recordCapBlock = () => { st.capBlocks.push(Date.now()); };
const STALE_WARN_SEC = Number(process.env.ALERT_ORACLE_STALE_SEC ?? 300); // halt is at 3600
const CAP_SPIKE = Number(process.env.ALERT_CAP_BLOCKS_PER_HOUR ?? 5);
const active = new Set<string>();

export async function health() {
  const alerts: { code: string; severity: "warn" | "critical"; message: string }[] = [];
  const keeperOn = process.env.KEEPER !== "off";
  if (keeperOn && st.consecutiveFailures >= 2) alerts.push({ code: "KEEPER_FAILING", severity: "critical", message: `${st.consecutiveFailures} consecutive keeper ticks failed: ${st.lastError}` });
  if (keeperOn && st.lastTickOk && Date.now() - st.lastTickOk > 180_000) alerts.push({ code: "KEEPER_STALLED", severity: "critical", message: `no successful keeper tick for ${Math.round((Date.now() - st.lastTickOk) / 1000)}s` });
  let market: unknown = null;
  try {
    const d = svc.dep(), now = await svc.chainNow();
    for (const [sym, s] of Object.entries(d.stocks)) {
      const [, , , updatedAt] = await read<[bigint, bigint, bigint, bigint, bigint]>(s.feed, C.agg.abi, "latestRoundData");
      const age = now - Number(updatedAt);
      if (age > STALE_WARN_SEC) alerts.push({ code: "ORACLE_STALE", severity: age > 3600 ? "critical" : "warn", message: `${sym} feed ${age}s old (trading halts at 3600s)` });
    }
    const open = await read<boolean>(d.oracle, C.oracle.abi, "isMarketOpen");
    const [o, c] = await Promise.all([read<bigint>(d.oracle, C.oracle.abi, "sessionOpenAt"), read<bigint>(d.oracle, C.oracle.abi, "sessionCloseAt")]);
    market = { open, sessionOpenAt: new Date(Number(o) * 1000).toISOString(), sessionCloseAt: new Date(Number(c) * 1000).toISOString() };
    if (!open) alerts.push({ code: "SESSION_CLOSED", severity: "warn", message: "market session closed: trading halted (expected outside NYSE hours)" });
  } catch (e) { alerts.push({ code: "CHAIN_UNREACHABLE", severity: "critical", message: (e as Error).message.slice(0, 200) }); }
  st.capBlocks = st.capBlocks.filter((t) => Date.now() - t < 3600_000);
  if (st.capBlocks.length >= CAP_SPIKE) alerts.push({ code: "CAP_BLOCK_SPIKE", severity: "warn", message: `${st.capBlocks.length} cap-blocked trades in the last hour` });
  const codes = new Set(alerts.map((a) => a.code));
  for (const a of alerts) if (!active.has(a.code)) console.warn(`[ALERT] ${a.severity.toUpperCase()} ${a.code}: ${a.message}`);
  for (const c of active) if (!codes.has(c)) console.warn(`[ALERT-CLEARED] ${c}`);
  active.clear(); codes.forEach((c) => active.add(c));
  return { ok: !alerts.some((a) => a.severity === "critical"), status: alerts.length ? (alerts.some((a) => a.severity === "critical") ? "critical" : "degraded") : "ok", alerts, market, keeper: { lastTickOk: st.lastTickOk ? new Date(st.lastTickOk).toISOString() : null, consecutiveFailures: st.consecutiveFailures } };
}
