# data/baskets.json

Single source of truth: `/workspace/stockclaw/baskets.json` (Lucius, canonical). The landing page's Baskets section reads only `prototype/data/baskets.json`, a verbatim copy made by:

    prototype/data/sync-baskets.sh

Run it after every change to the root `baskets.json`, then commit both files. Do not edit `prototype/data/baskets.json` by hand.

Fields used by landing.js: `version`, `asOf`, `source`, `sourceUrl`, `rules` (singleNameCapPct, minWeightPct), `disclaimer`, `baskets[].{id, theme, version, hash, tickers[].{ticker, name, weightPct}}`.
Checks: each basket's weightPct must sum to 100 (±0.5) or the basket shows "Weights don't add up".
Placeholder mode: if the file is missing/unreadable, or has `"status": "placeholder"`, the section and every basket show "Placeholder weights, not real data".

"Not cross-checked yet" note: shown next to the source/as-of line unless the JSON has `"verified": true` at the top level. Add that field (to the root baskets.json, then re-sync) once the market-cap data has been cross-checked.
Basket avatars: prototype/avatars/eyeless-basket-<id>-transparent.png (eyes drawn by eyes.js; ids ai, chips, power, defense, space, quantum, cyber; "power-nuclear" maps to "power").
