# data/baskets.json

The landing page's "Baskets" section reads ONLY this file (fetched by landing.js at load).

Schema:
{ "status": "placeholder" | "final", "source": "...", "updated": "YYYY-MM-DD",
  "baskets": [ { "id": "ai", "name": "AI", "tickers": [ { "symbol": "NVDA", "weight": 25.00 } ] } ] }

- `weight` is a percent (2 decimals). Each basket must sum to 100 (±0.5); landing.js checks this and shows "Weights don't add up" on a basket that fails.
- `status: "placeholder"` shows a prominent "Placeholder weights, not real data" tag on the section and every basket. Use it with generic labels (TICKER A, ...) only.
- To drop in new numbers (Lucius): run `python3 data/compute_weights.py`, copy each basket's percentages into `tickers` (bps / 100), keep the order largest first, set `status: "final"`, `source`, `updated`. No code change needed.
- Current contents: transcribed exactly from BASKETS.md §8 "Results (v1.0.0)", 2026-10-18.
