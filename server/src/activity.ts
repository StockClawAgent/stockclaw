// Owner activity feed (Gaius guardrail 1): every auto-executed trade (agent swaps, basket legs, keeper DCA/limit fills,
// owner-approved sells) and every anomaly-breaker event becomes an in-app entry with a revoke-key action.
// GET /api/activity (polling, ?since=<id>) and GET /api/activity/stream (SSE). No external channel yet.
import { getDb, nowIso } from "./db.js";
import { log } from "./log.js";
import { explorerTx } from "./config.js";

export type Action = { type: "revoke_key" | "resume_key"; label: string; method: "POST"; href: string; keyId?: string };
export type Entry = { id: number; ts: string; kind: "trade" | "breaker" | "breaker_resumed" | "alert"; ref?: string; code?: string; keyId: string | null; title: string; side?: "buy" | "sell"; usd?: number; txHash?: string | null; swapId?: string; executionId?: string; source?: string; actions: Action[] };
const subs = new Set<(e: Entry) => void>();
export const revokeAction = (keyId?: string | null): Action => ({ type: "revoke_key", label: "Revoke agent key", method: "POST", href: "/api/revoke_session_key", ...(keyId ? { keyId } : {}) });
export const resumeAction = (keyId: string): Action => ({ type: "resume_key", label: "Resume agent key", method: "POST", href: `/api/keys/${keyId}/resume`, keyId });
export function add(e: Omit<Entry, "id" | "ts">) {
  const ts = nowIso();
  if (e.txHash && !("explorerUrl" in e)) (e as any).explorerUrl = explorerTx(e.txHash);
  const r = getDb().prepare("INSERT INTO activity(ts, kind, key_id, json) VALUES(?,?,?,?)").run(ts, e.kind, e.keyId, JSON.stringify(e));
  const entry = { ...e, id: Number(r.lastInsertRowid), ts } as Entry;
  for (const f of subs) { try { f(entry); } catch {} }
  log.info("activity", { kind: e.kind, keyId: e.keyId, title: e.title });
  return entry;
}
export function list(since?: number, limit = 50): Entry[] {
  return (getDb().prepare("SELECT id, ts, json FROM activity WHERE id > ? ORDER BY id DESC LIMIT ?").all(since ?? 0, Math.min(limit, 200)) as { id: number; ts: string; json: string }[]).map((r) => ({ ...JSON.parse(r.json), id: r.id, ts: r.ts }));
}
export const subscribe = (f: (e: Entry) => void) => { subs.add(f); return () => subs.delete(f); };
// ephemeral job status events (not stored in the feed): SSE `event: job` on /api/activity/stream
const jobSubs = new Set<(j: unknown) => void>();
export const publishJob = (j: unknown) => { for (const f of jobSubs) { try { f(j); } catch {} } };
export const subscribeJobs = (f: (j: unknown) => void) => { jobSubs.add(f); return () => jobSubs.delete(f); };
export const reset = () => { getDb().prepare("DELETE FROM activity").run(); };
