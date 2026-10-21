// Async trade writes (UX): REST execute_swap / create_dca / create_limit_order answer 202 + a job right away; the job
// runs in-process at once (jobs.runNow) and its outcome goes out as an SSE `job` event on /api/activity/stream and via
// GET /api/jobs/:id (?wait=ms long-poll). MCP tools enqueue the same job and wait for the result (MCP_WAIT_MS).
import * as jobs from "./jobs.js";
import * as svc from "./service.js";
import * as act from "./activity.js";
import { toUserError } from "./errors.js";
import { log } from "./log.js";
import { settleTimeoutMs } from "./chain.js";

export const TRADE_FNS = { execute_swap: (a: any, job?: jobs.Job) => svc.execute_swap(a?.quoteId ?? a, { jobId: job?.id }), create_dca: (a: any) => svc.create_dca(a), create_limit_order: (a: any) => svc.create_limit_order(a) } as const;
export type TradeFn = keyof typeof TRADE_FNS;

/** R7-1: a trade job must outlive the tx confirm wait (SETTLE_TIMEOUT_MS) so a slow confirm comes back as "pending" +
 * txHash, never as a retryable TIMEOUT. TRADE_JOB_TIMEOUT_MS can raise it, never lower it below confirm + 30s. */
let warned = false;
export function tradeJobTimeoutMs() {
  const floor = settleTimeoutMs() + 30_000, set = process.env.TRADE_JOB_TIMEOUT_MS ? Number(process.env.TRADE_JOB_TIMEOUT_MS) : 0;
  if (set && set < floor && !warned) { warned = true; log.warn("TRADE_JOB_TIMEOUT_MS is below the confirm timeout + 30s; using the floor (R7-1)", { set, floor }); }
  return Math.max(set, floor);
}
for (const [fn, run] of Object.entries(TRADE_FNS)) {
  jobs.register(`trade.${fn}`, async (args: any, job) => {
    // never auto-replay a trade: a job that was interrupted (restart) fails instead of sending again
    if (job.attempts > 1) throw new svc.ApiError(409, "Interrupted by a server restart before it finished; check history before retrying");
    return run(args, job);
  }, { timeoutMs: tradeJobTimeoutMs, ...(fn === "execute_swap" ? { onTimeoutResult: (_p: unknown, job: jobs.Job) => svc.onSwapJobTimeout(job.id) } : {}) });
}
// A swap that came back "pending" settles its job(s) again when it confirms or fails (SSE `job` event + /api/jobs/:id).
svc.setSwapSettledHook((ids, o) => { for (const id of ids) jobs.settle(id, o); });

/** status "done" + result.status "pending" (execute_swap only, R7-1): sent, not confirmed yet; the same job is settled
 * again (SSE `job` event) with result.status "confirmed", or flips to "failed" if it reverts / can't mine. */
export type JobView = { jobId: number; kind: string; status: "queued" | "running" | "done" | "failed"; result?: unknown; error?: { code: string; message: string; retryable: boolean; hint?: string; error: string; status: number }; createdAt: string; updatedAt: string; statusUrl: string };
export function view(id: number): JobView | null {
  const j = jobs.get(id); if (!j) return null;
  const base = { jobId: j.id, kind: j.kind, status: j.status as JobView["status"], createdAt: new Date(j.created_at).toISOString(), updatedAt: new Date(j.updated_at).toISOString(), statusUrl: `/api/jobs/${j.id}` };
  if (j.status === "done") return { ...base, result: j.result ? JSON.parse(j.result) : null };
  if (j.status === "failed") { const meta = j.result ? JSON.parse(j.result) : {}; const status = meta.status ?? 500, detail = j.last_error ?? "failed";
    return { ...base, error: { error: detail, status, ...toUserError(detail, status), ...(meta.extra ?? {}) } }; }
  return base;
}
jobs.onJobSettled((id) => { const v = view(id); if (v && v.kind.startsWith("trade.")) act.publishJob(v); });

/** Enqueue (deduped by Idempotency-Key) and start right away. Returns the queued job view in < 1 ms of DB work. */
export function submit(fn: TradeFn, args: unknown, idemKey?: string): JobView {
  const id = jobs.enqueue(`trade.${fn}`, args ?? {}, { maxAttempts: 1, ...(idemKey ? { dedupe: `trade:${fn}:${idemKey}` } : {}) });
  const v = view(id)!;
  if (v.status === "queued") { act.publishJob(v); setImmediate(() => void jobs.runNow(id).catch((e) => log.error("trade job crashed", { jobId: id, error: String(e) }))); }
  return v;
}
/** For MCP: submit, then wait up to waitMs for the outcome. */
export async function submitAndWait(fn: TradeFn, args: unknown, waitMs = Number(process.env.MCP_WAIT_MS ?? 25_000), idemKey?: string) {
  const v = submit(fn, args, idemKey);
  await jobs.wait(v.jobId, waitMs);
  return view(v.jobId)!;
}
const isPending = (v: JobView | null) => !!v && v.status === "done" && (v.result as any)?.status === "pending";
/** Wait for a terminal job; a "pending" swap result (R7-1) keeps waiting for its confirmation within the same budget. */
export async function waitView(id: number, ms: number) {
  const until = Date.now() + Math.min(Math.max(ms, 0), 30_000);
  await jobs.wait(id, until - Date.now());
  let v = view(id);
  while (isPending(v) && Date.now() < until) {
    await new Promise<void>((res) => { const off = jobs.onJobSettled((x) => { if (x === id) { clearTimeout(t); off(); res(); } }); const t = setTimeout(() => { off(); res(); }, until - Date.now()); });
    v = view(id);
  }
  return v;
}
