// Rolling per-endpoint latency (last 500 samples each) for /healthz: { "POST /api/baskets/buy": { n, p50, p95, max } }
const W = 500, buf = new Map<string, number[]>();
export function record(key: string, ms: number) { let a = buf.get(key); if (!a) buf.set(key, (a = [])); a.push(ms); if (a.length > W) a.shift(); }
const pct = (s: number[], p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
export function summary() {
  const out: Record<string, { n: number; p50: number; p95: number; max: number }> = {};
  for (const [k, a] of [...buf.entries()].sort()) { const s = [...a].sort((x, y) => x - y); out[k] = { n: a.length, p50: +pct(s, 50).toFixed(1), p95: +pct(s, 95).toFixed(1), max: +s[s.length - 1].toFixed(1) }; }
  return out;
}
export const reset = () => buf.clear();
