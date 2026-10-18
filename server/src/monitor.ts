// Basic alerting (review-3 B12): keeper failures, stale oracle, closed session, cap-block spikes.
// Alerts are logged once when they fire ("[ALERT]") and when they clear ("[ALERT-CLEARED]"), and reported by /api/health.
import { C, read } from "./chain.js";
import { formatEther } from "viem";
import * as svc from "./service.js";
import { pub, nonceState } from "./chain.js";
import * as jobs from "./jobs.js";
import * as brk from "./breaker.js";
import { getDb } from "./db.js";
import { log } from "./log.js";
import { KEEPER_INTERVAL_MS } from "./config.js";

const st = { lastTickOk: 0, consecutiveFailures: 0, lastError: "", capBlocks: [] as number[] };
export const recordTick = (ok: boolean, err?: string) => { if (ok) { st.lastTickOk = Date.now(); st.consecutiveFailures = 0; } else { st.consecutiveFailures++; st.lastError = err ?? ""; } };
export const recordCapBlock = () => { st.capBlocks.push(Date.now()); };
const STALE_WARN_SEC = Number(process.env.ALERT_ORACLE_STALE_SEC ?? 300); // halt is at 3600
const CAP_SPIKE = Number(process.env.ALERT_CAP_BLOCKS_PER_HOUR ?? 5);
const active = new Set<string>();
const MIN_SIGNER_ETH = Number(process.env.ALERT_MIN_SIGNER_ETH ?? 0.01);
const codesHas = (a: { code: string }[], c: string) => a.some((x) => x.code === c);

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
  // BACKEND_PLAN §3 extensions: RPC, DB, queue depth, signer balances + nonces, in-flight / failed txs
  let rpc: unknown = null, signers: unknown = null;
  try { const t0 = Date.now(), bn = await pub.getBlockNumber(); rpc = { ok: true, blockNumber: Number(bn), latencyMs: Date.now() - t0 }; }
  catch (e) { rpc = { ok: false, error: (e as Error).message.slice(0, 120) }; if (!codesHas(alerts, "CHAIN_UNREACHABLE")) alerts.push({ code: "CHAIN_UNREACHABLE", severity: "critical", message: "RPC unreachable" }); }
  try {
    const ns = nonceState() as Record<string, number>;
    const roles: [string, () => { address: string }][] = [["keeper", svc.keeperWallet], ["updater", svc.updaterWallet], ["owner", svc._owner]];
    signers = await Promise.all(roles.map(async ([role, w]) => { const a = w().address as `0x${string}`, bal = Number(formatEther(await pub.getBalance({ address: a })));
      if (bal < MIN_SIGNER_ETH) alerts.push({ code: "SIGNER_LOW_BALANCE", severity: "warn", message: `${role} ${a} has ${bal.toFixed(4)} ETH` });
      return { role, address: a, balanceEth: +bal.toFixed(6), nextNonce: ns[a] ?? null }; }));
  } catch { /* chain alert already raised */ }
  let db: unknown, queue: unknown, txs: unknown;
  try {
    getDb().prepare("SELECT 1").get(); db = { ok: true, engine: "sqlite (WAL)" };
    queue = jobs.stats();
    const q = queue as ReturnType<typeof jobs.stats>;
    if (q.failed > 0) alerts.push({ code: "JOBS_FAILED", severity: "warn", message: `${q.failed} job(s) failed permanently` });
    if (q.oldestQueuedAgeSec > 300) alerts.push({ code: "QUEUE_BACKLOG", severity: "warn", message: `oldest queued job waiting ${q.oldestQueuedAgeSec}s` });
    const since = new Date(Date.now() - 3600_000).toISOString();
    const r = getDb().prepare("SELECT status, COUNT(*) n FROM tx_log WHERE created_at > ? GROUP BY status").all(since) as { status: string; n: number }[];
    const by = Object.fromEntries(r.map((x) => [x.status, x.n])), total = r.reduce((s, x) => s + x.n, 0), bad = (by.reverted ?? 0) + (by.dropped ?? 0);
    txs = { lastHour: by, inFlight: (getDb().prepare("SELECT COUNT(*) n FROM tx_log WHERE status='submitted'").get() as { n: number }).n, failedRate: total ? +(bad / total).toFixed(3) : 0 };
    if (total >= 5 && bad / total > 0.2) alerts.push({ code: "TX_FAILURE_RATE", severity: "warn", message: `${bad}/${total} txs failed in the last hour` });
  } catch (e) { db = { ok: false, error: (e as Error).message }; alerts.push({ code: "DB_ERROR", severity: "critical", message: (e as Error).message.slice(0, 120) }); }
  if (keeperOn && st.lastTickOk && Date.now() - st.lastTickOk > KEEPER_INTERVAL_MS + 120_000 && !codesHas(alerts, "KEEPER_STALLED")) alerts.push({ code: "KEEPER_LATE", severity: "warn", message: "keeper tick more than 2 min late" });
  for (const a of brk.recentAlerts()) alerts.push({ code: "KEY_SINGLE_EXECUTION_80PCT", severity: "warn", message: JSON.parse(a.json).title });
  for (const t of brk.tripped()) alerts.push({ code: "KEY_BREAKER_TRIPPED", severity: "warn", message: `agent key ${t.key_id} paused: ${t.reason}` });
  st.capBlocks = st.capBlocks.filter((t) => Date.now() - t < 3600_000);
  if (st.capBlocks.length >= CAP_SPIKE) alerts.push({ code: "CAP_BLOCK_SPIKE", severity: "warn", message: `${st.capBlocks.length} cap-blocked trades in the last hour` });
  const codes = new Set(alerts.map((a) => a.code));
  for (const a of alerts) if (!active.has(a.code)) log.error("ALERT", { code: a.code, severity: a.severity, message: a.message });
  for (const c of active) if (!codes.has(c)) log.info("ALERT-CLEARED", { code: c });
  active.clear(); codes.forEach((c) => active.add(c));
  return { ok: !alerts.some((a) => a.severity === "critical"), status: alerts.length ? (alerts.some((a) => a.severity === "critical") ? "critical" : "degraded") : "ok", alerts, market, rpc, db, queue, signers, txs, keeper: { lastTickOk: st.lastTickOk ? new Date(st.lastTickOk).toISOString() : null, consecutiveFailures: st.consecutiveFailures } };
}
