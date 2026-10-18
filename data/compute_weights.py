#!/usr/bin/env python3
"""Reproducible market-cap basket weights for StockClaw (testnet planning only).
Input : data/basket-mcaps-2026-10-18.csv (ticker,basket,market_cap_usd,source,as_of,note)
Rules : cap=25% single name, min weight=5% (names below are dropped, keeping >= MIN_NAMES),
        iterative cap redistribution, min leg $5, max leg $98 (sub-legs), cents rounding.
Usage : python3 data/compute_weights.py [--usd 100 250] [--json out.json]
"""
import csv, json, math, sys, hashlib, os
HERE = os.path.dirname(os.path.abspath(__file__))
CAP, MIN_W, MIN_NAMES, MIN_LEG, MAX_LEG = 0.25, 0.05, 4, 5.00, 98.00

def cap_redistribute(w, cap):
    w = dict(w)
    for _ in range(100):
        over = {k for k, v in w.items() if v > cap + 1e-12}
        if not over: break
        excess = sum(w[k] - cap for k in over)
        for k in over: w[k] = cap
        free = {k: v for k, v in w.items() if v < cap - 1e-12}
        tot = sum(free.values())
        if tot == 0: break
        for k, v in free.items(): w[k] = v + excess * v / tot
    return w

def weights(mcaps, cap=CAP, min_w=MIN_W):
    names = sorted(mcaps, key=lambda k: -mcaps[k])
    while True:
        tot = sum(mcaps[k] for k in names)
        w = cap_redistribute({k: mcaps[k] / tot for k in names}, max(cap, 1 / len(names)))
        small = [k for k in names if w[k] < min_w - 1e-12]
        if not small or len(names) <= MIN_NAMES: return w
        drop = min(small, key=lambda k: mcaps[k])          # drop smallest one, recompute
        if len(names) - 1 < MIN_NAMES: return w
        names.remove(drop)

def split(w, usd, mcaps):
    """Drop smallest names until every leg >= MIN_LEG, re-weight with same rules, round to cents."""
    names = dict(w)
    while True:
        legs = {k: math.floor(usd * v * 100) / 100 for k, v in names.items()}
        if min(legs.values()) >= MIN_LEG or len(names) == 1: break
        drop = min(names, key=lambda k: mcaps[k]); names.pop(drop)
        names = weights({k: mcaps[k] for k in names})
    rem = round(usd - sum(legs.values()), 2)
    top = max(legs, key=legs.get); legs[top] = round(legs[top] + rem, 2)
    return {k: {"usd": v, "swaps": math.ceil(v / MAX_LEG)} for k, v in legs.items()}

def main():
    args = sys.argv[1:]; sizes = [100, 250]; out = None
    if "--usd" in args:
        i = args.index("--usd"); sizes = []
        for a in args[i + 1:]:
            if a.startswith("--"): break
            sizes.append(float(a))
    if "--json" in args: out = args[args.index("--json") + 1]
    rows = list(csv.DictReader(open(os.path.join(HERE, "basket-mcaps-2026-10-18.csv"))))
    baskets = {}
    for r in rows:
        if r["market_cap_usd"]: baskets.setdefault(r["basket"], {})[r["ticker"]] = float(r["market_cap_usd"])
    result = {}
    for b, m in baskets.items():
        w = weights(m)
        wr = {k: round(v * 10000) for k, v in sorted(w.items(), key=lambda x: -x[1])}
        diff = 10000 - sum(wr.values()); wr[next(iter(wr))] += diff
        canon = json.dumps({"id": b, "version": "1.0.0", "weightsBps": wr}, sort_keys=True, separators=(",", ":"))
        result[b] = {"weightsBps": wr, "basketHash": "sha256:" + hashlib.sha256(canon.encode()).hexdigest(),
                     "splits": {str(int(s)): split(w, s, m) for s in sizes}}
        print(f"\n== {b}  ({result[b]['basketHash'][:19]}…)")
        print("  " + ", ".join(f"{k} {v/100:.2f}%" for k, v in wr.items()))
        for s in sizes:
            sp = result[b]["splits"][str(int(s))]
            print(f"  ${s:.0f}: " + ", ".join(f"{k} ${v['usd']:.2f}" + (f" ({v['swaps']} swaps)" if v['swaps'] > 1 else "") for k, v in sp.items())
                  + f"  | names {len(sp)}, swaps {sum(v['swaps'] for v in sp.values())}")
    if out: json.dump(result, open(out, "w"), indent=1)

if __name__ == "__main__": main()
