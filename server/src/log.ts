// Structured JSON logs (BACKEND_PLAN §3): one JSON object per line with ts, level, msg plus context
// (requestId, idempotencyKey, executionId, legId, txHash, ...). Never logs keys/tokens/signatures.
import { AsyncLocalStorage } from "node:async_hooks";
export const ctx = new AsyncLocalStorage<Record<string, unknown>>();
const SECRET = /(private|secret|token|password|mnemonic|authorization|^sig$|^pk$|key$)/i;
const ALLOW = new Set(["idempotencyKey", "agentKeyId", "legId"]);
function redact(v: unknown, depth = 0): unknown {
  if (depth > 4 || v == null || typeof v !== "object") return typeof v === "bigint" ? v.toString() : v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, SECRET.test(k) && !ALLOW.has(k) ? "[redacted]" : redact(x, depth + 1)]));
}
type Level = "debug" | "info" | "warn" | "error";
const quiet = () => process.env.LOG_LEVEL === "silent";
function emit(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (quiet() && level !== "error") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(ctx.getStore() ?? {}), ...(redact(fields) as object) });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}
export const log = {
  debug: (m: string, f?: Record<string, unknown>) => process.env.LOG_LEVEL === "debug" && emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};
export const withCtx = <T>(f: Record<string, unknown>, fn: () => T) => ctx.run({ ...(ctx.getStore() ?? {}), ...f }, fn);
