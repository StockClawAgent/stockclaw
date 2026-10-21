# StockClaw X graphics (source)

HTML/CSS cards rendered to PNG with puppeteer-core + headless Chrome. Nothing here posts anything.

    cd /workspace/stockclaw/x-graphics/src
    node render.js            # rebuild data.js, render all cards + ../contact-sheet.png
    node render.js basket     # only outputs whose filename contains "basket"

Files: `card.html` / `card.css` / `card.js` (one renderer, layout picked by `type`), `content.json` (all copy:
agents, basket one-liners, steps, countdown, showcase), `data.js` (generated: content + `prototype/data/baskets.json`
+ ticker colors computed with the same greedy algorithm and palette as `prototype/landing.js` + eye positions from
`prototype/eyes.js`), `assets/` (fonts, eyeless avatars, 3D logo, wordmark, prototype screenshots).
Preview any card in a browser: `card.html?type=basket&id=chips&w=1080&h=1350`.

## Reusable templates

    node render.js --tpl quote my-quote.json [out.png]
    node render.js --tpl announcement my-ann.json [out.png]

Quote JSON (`templates/quote.example.json`):
| key | meaning |
|---|---|
| quote | the text (font size auto-steps down for longer quotes; keep it under ~170 chars) |
| name, role | attribution lines |
| avatar | `"logo"` (3D claw) or an avatar id: steady-stacker, dip-hunter, trend-flip, ai-thematic, weekend-edge, basket-ai, basket-chips, basket-power, basket-defense, basket-space, basket-quantum, basket-cyber |
| size | "1600x900" (default) or "1080x1350" |

Announcement JSON (`templates/announcement.example.json`): `kicker`, `headline` (auto-sizes), `body`, `bullets`
(rendered as lime ">" changelog lines), `avatar` (as above, optional), `size`.

Rules baked into the copy: no performance claims, no "24/7", no TSLA in examples, no ETF/fund framing. No chain badges anywhere (Julius, 10/18).
Label any example numbers as illustrative.
