// Async trade writes (UX): REST execute_swap / create_dca / create_limit_order answer 202 + a job right away; the job
// runs in-process at once (jobs.runNow) and its outcome goes out as an SSE `job` event on /api/activity/stream and via
// GET /api/jobs/:id (?wait=ms long-poll). MCP tools enqueue the same job and wait for the result (MCP_WAIT_MS).
import * as jobs from "./jobs.js";
import * as svc from "./service.js";
import * as act from "./activity.js";
import { toUserError } from "./errors.js";
import { log } from "./log.js";

export const TRADE_FNS = { execute_swap: (a: any) => svc.execute_swap(a?.quoteId ?? a), create_dca: (a: any) => svc.create_dca(a), create_limit_order: (a: any) => svc.create_limit_order(a) } as const;
export type TradeFn = keyof typeof TRADE_FNS;

for (const [fn, run] of Object.entries(TRADE_FNS)) {
  jobs.register(`trade.${fn}`, async (args: any, job) => {
    // never auto-replay a trade: a job that was interrupted (restart) fails instead of sending again
    if (job.attempts > 1) throw new svc.ApiError(409, "Interrupted by a server restart before it finished; check history before retrying");
    return run(args);
  }, { timeoutMs: Number(process.env.TRADE_JOB_TIMEOUT_MS ?? 60_000) });
}

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
export const waitView = async (id: number, ms: number) => { await jobs.wait(id, Math.min(Math.max(ms, 0), 30_000)); return view(id); };
