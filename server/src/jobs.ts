// Durable job queue (BACKEND_PLAN §3): SQLite `jobs` table (status, run_at, attempts, locked_until) polled by a worker.
// Claiming is a single synchronous UPDATE (better-sqlite3), so one job never runs twice concurrently in-process;
// leases (locked_until) let a restarted process take over jobs a dead process left "running".
import { getDb } from "./db.js";
import { reconcileTxLog } from "./chain.js";
import { log, withCtx } from "./log.js";

export type Job = { id: number; kind: string; payload: any; attempts: number; max_attempts: number };
type Handler = (payload: any, job: Job) => Promise<unknown>;
const handlers = new Map<string, Handler>();
type Opts = { timeoutMs?: number; onTimeout?: (payload: any) => void };
const opts = new Map<string, Opts>();
/** Every job has a timeout (default JOB_TIMEOUT_MS or 120s): on expiry it is failed (final) with a reason and onTimeout settles its state. */
export const register = (kind: string, h: Handler, o: Opts = {}) => { handlers.set(kind, h); opts.set(kind, o); };
export class JobTimeout extends Error {}
/** Thrown by fault injection (e2e) to emulate the process dying mid-job: the job is left "running" with its lease. */
export class SimulatedCrash extends Error { constructor() { super("simulated crash (process died)"); } }
const LEASE_MS = 120_000;

export function enqueue(kind: string, payload: unknown, o: { runAt?: number; dedupe?: string; maxAttempts?: number } = {}) {
  const now = Date.now();
  const r = getDb().prepare("INSERT OR IGNORE INTO jobs(kind, dedupe, payload, status, run_at, max_attempts, created_at, updated_at) VALUES(?,?,?, 'queued', ?,?,?,?)")
    .run(kind, o.dedupe ?? null, JSON.stringify(payload ?? null), o.runAt ?? now, o.maxAttempts ?? 3, now, now);
  if (!r.changes) return (getDb().prepare("SELECT id FROM jobs WHERE dedupe=?").get(o.dedupe) as { id: number }).id;
  setImmediate(() => void kick());
  return Number(r.lastInsertRowid);
}
function claim(kinds?: string[]): Job | null {
  const d = getDb(), now = Date.now();
  const row = d.prepare(`SELECT id FROM jobs WHERE ((status='queued' AND run_at<=?) OR (status='running' AND locked_until<?)) ${kinds ? `AND kind IN (${kinds.map(() => "?").join(",")})` : ""} ORDER BY run_at, id LIMIT 1`).get(now, now, ...(kinds ?? [])) as { id: number } | undefined;
  if (!row) return null;
  const u = d.prepare("UPDATE jobs SET status='running', attempts=attempts+1, locked_until=?, updated_at=? WHERE id=? AND (status='queued' OR (status='running' AND locked_until<?))").run(now + LEASE_MS, now, row.id, now);
  if (!u.changes) return null;
  const j = d.prepare("SELECT id, kind, payload, attempts, max_attempts FROM jobs WHERE id=?").get(row.id) as any;
  return { ...j, payload: JSON.parse(j.payload) };
}
async function runJob(j: Job) {
  const d = getDb(), h = handlers.get(j.kind);
  return withCtx({ jobId: j.id, jobKind: j.kind }, async () => {
    try {
      if (!h) throw new Error(`no handler for ${j.kind}`);
      let out: unknown;
      const o = opts.get(j.kind) ?? {}, ms = o.timeoutMs ?? Number(process.env.JOB_TIMEOUT_MS ?? 120_000);
      let t: NodeJS.Timeout | undefined;
      try { out = await Promise.race([h(j.payload, j), new Promise((_, rej) => { t = setTimeout(() => rej(new JobTimeout(`Timed out after ${Math.round(ms / 1000)}s`)), ms); })]); }
      catch (e) { if (e instanceof JobTimeout) { try { o.onTimeout?.(j.payload); } catch { /* best effort */ } j.attempts = j.max_attempts; } throw e; }
      finally { clearTimeout(t); }
      d.prepare("UPDATE jobs SET status='done', locked_until=NULL, last_error=NULL, result=?, updated_at=? WHERE id=?").run(out === undefined ? null : JSON.stringify(out), Date.now(), j.id);
      notify(j.id);
    } catch (e) {
      if (e instanceof SimulatedCrash) { log.warn("job interrupted (simulated crash); lease left in place", { jobId: j.id }); crashed = true; return; }
      const msg = (e as Error).message?.slice(0, 300);
      const final = j.attempts >= j.max_attempts;
      d.prepare("UPDATE jobs SET status=?, run_at=?, locked_until=NULL, last_error=?, result=?, updated_at=? WHERE id=?").run(final ? "failed" : "queued", Date.now() + 2000 * j.attempts, msg, final ? JSON.stringify({ status: (e as any).status ?? 500, extra: (e as any).extra ?? null }) : null, Date.now(), j.id);
      if (final) notify(j.id);
      log[final ? "error" : "warn"]("job failed", { jobId: j.id, kind: j.kind, attempt: j.attempts, final, error: msg });
    }
  });
}
let crashed = false, running: Promise<void> | null = null, timer: NodeJS.Timeout | undefined;
/** Run due jobs until none are left (optionally only some kinds). */
export async function drain(kinds?: string[]) {
  for (let j = claim(kinds); j && !crashed; j = claim(kinds)) await runJob(j);
}
export function kick() {
  if (running || crashed || !timer) return running ?? Promise.resolve();
  running = drain().finally(() => { running = null; });
  return running;
}
export function startWorker(pollMs = 500) { crashed = false; timer ??= setInterval(() => void kick(), pollMs); void kick(); }
export function stopWorker() { if (timer) clearInterval(timer); timer = undefined; }
export const isCrashed = () => crashed;
export const idle = async () => { while (running) await running; };
/** Boot-time recovery: settle in-flight txs by hash, then make jobs a dead process left "running" claimable now. */
export async function recover() {
  crashed = false;
  const txs = await reconcileTxLog();
  const r = getDb().prepare("UPDATE jobs SET status='queued', locked_until=NULL, run_at=?, updated_at=? WHERE status='running'").run(Date.now(), Date.now());
  log.info("recovery", { requeuedJobs: r.changes, reconciledTxs: Object.keys(txs).length });
  return { requeuedJobs: r.changes, txs };
}
export function stats() {
  const rows = getDb().prepare("SELECT status, COUNT(*) n FROM jobs GROUP BY status").all() as { status: string; n: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const oldest = getDb().prepare("SELECT MIN(run_at) t FROM jobs WHERE status='queued'").get() as { t: number | null };
  return { queued: by.queued ?? 0, running: by.running ?? 0, failed: by.failed ?? 0, done: by.done ?? 0, oldestQueuedAgeSec: oldest.t ? Math.max(0, Math.round((Date.now() - oldest.t) / 1000)) : 0 };
}
// ---- job watchers (REST long-poll, MCP wait, SSE job events)
const watchers = new Set<(id: number) => void>();
function notify(id: number) { for (const w of watchers) { try { w(id); } catch {} } }
export const onJobSettled = (f: (id: number) => void) => { watchers.add(f); return () => watchers.delete(f); };
export function get(id: number) {
  return getDb().prepare("SELECT id, kind, status, attempts, last_error, result, created_at, updated_at FROM jobs WHERE id=?").get(id) as { id: number; kind: string; status: string; attempts: number; last_error: string | null; result: string | null; created_at: number; updated_at: number } | undefined;
}
/** Wait until the job is done/failed (or timeoutMs passes). */
export async function wait(id: number, timeoutMs: number) {
  const fin = () => { const j = get(id); return !j || j.status === "done" || j.status === "failed"; };
  if (fin()) return get(id);
  await new Promise<void>((res) => { const off = onJobSettled((x) => { if (x === id) { clearTimeout(t); off(); res(); } }); const t = setTimeout(() => { off(); res(); }, timeoutMs); });
  return get(id);
}
/** Run one specific queued job now, in this process (atomic claim; the worker can't run it twice). */
export async function runNow(id: number) {
  const d = getDb(), now = Date.now();
  const u = d.prepare("UPDATE jobs SET status='running', attempts=attempts+1, locked_until=?, updated_at=? WHERE id=? AND status='queued'").run(now + LEASE_MS, now, id);
  if (!u.changes) return;
  const j = d.prepare("SELECT id, kind, payload, attempts, max_attempts FROM jobs WHERE id=?").get(id) as any;
  await runJob({ ...j, payload: JSON.parse(j.payload) });
}
export const _purge = (kindPrefix: string) => getDb().prepare("DELETE FROM jobs WHERE kind LIKE ?").run(kindPrefix + "%");
