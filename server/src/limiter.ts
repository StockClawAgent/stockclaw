// B8 / SC-2: fixed-window limiter with TTL + max-size eviction (shared by REST and MCP).
export class Limiter {
  private hits = new Map<string, { win: number; n: number; seen: number }>();
  constructor(public perMin: number, private maxKeys = 50_000, private ttlMs = 120_000) {}
  /** returns seconds to wait (>0) if over the limit, else 0 */
  hit(key: string): number {
    const now = Date.now(), win = Math.floor(now / 60_000);
    if (this.hits.size >= this.maxKeys) this.evict(now);
    const h = this.hits.get(key);
    if (!h || h.win !== win) { this.hits.delete(key); this.hits.set(key, { win, n: 1, seen: now }); return 0; }
    h.seen = now;
    return ++h.n > this.perMin ? 60 - Math.floor((now / 1000) % 60) : 0;
  }
  private evict(now: number) {
    for (const [k, v] of this.hits) if (now - v.seen > this.ttlMs) this.hits.delete(k);
    while (this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value as string);
  }
  clear() { this.hits.clear(); }
  get size() { return this.hits.size; }
}
