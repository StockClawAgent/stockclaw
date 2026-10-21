# StockClaw — Themed Baskets (v0.1 plan)
Owner: Lucius (CTO) · 2026-10-18 · Source: Julius via Cassius · Status: DRAFT. Nothing on mainnet.
Related: STRATEGIES.md (versioning/hashing, caps analysis in S3), ARCHITECTURE.md §7 and decisions log, `src/AgentVault.sol`, `src/FeeRouter.sol`.

**UX goal:** user says "hey, get me some AI" in Claude/ChatGPT/Grok/Cursor → the agent previews a weighted basket → buys every leg in one flow, within the vault limits.

## 1. What we can actually fill
### Sources
- **Official registry (primary):** `GET https://api.robinhood.com/rhj/assets` (documented at https://docs.robinhood.com/chain/stock-token-apis/). Fetched 2026-10-18 18:56 ET: **195 assets, all `ASSET_STATUS_ACTIVE`, every deployment on chainId 4663 (mainnet); none listed for 46630.** Snapshot saved at `data/rhj_assets_2026-10-18.json` (not committed).
- https://robinhood.com/rhj/stocktokens/ ("190+ Stock Tokens"); Robinhood newsroom, 2026-07-01 mainnet launch post (also restriction list: US persons, Canada, UK, Switzerland, UAE, sanctioned).
- https://docs.robinhood.com/chain/building-with-stock-tokens/: ERC-20, 18 decimals, ERC-8056 `uiMultiplier()` for corporate actions; "tokenized stocks trade via RFQ at launch".
- Chain 46630: our fork test `test/fork/RobinhoodFork.t.sol` against the 5 addresses in ARCHITECTURE.md §0 (sourced from a third-party guide; `symbol()` checked onchain by us).

### Caveats (honest labels)
- Addresses below are copied from the official registry. **We haven't checked them onchain on 4663** (`symbol()`, code, `uid()`); do that before any use. Mainnet is out of scope anyway.
- **Theme membership is our editorial classification**, not Robinhood's. Marcus/Cassius should review it; tickers can belong to several themes.
- The registry also contains ETP tokens (SPY, QQQ, SMH, SOXX, XLK, USO, GLD, SLV, …). Baskets use single stocks only, so we never package ETFs and don't call anything a fund.
- Per-token `tradingCapabilities` (e.g. `position_closing_only`) must be checked at preview time; tokens that can't be bought are skipped.
- On mainnet, our `StockClawPool` doesn't exist. Routing would go through RFQ/Uniswap venues (ARCHITECTURE §3), which isn't built.

### Themes (mainnet 4663, registry tickers)
| Theme | # | Verdict |
|---|---|---|
| AI | 15 | Strong |
| Semiconductors | 14 | Strong (overlaps AI) |
| Power / Nuclear | 9 | Strong |
| Defense / Aerospace | 8 | OK |
| Space | 8 | OK (many small caps; volatile) |
| Quantum | 6 | OK (all small/speculative) |
| Cybersecurity | 5 | OK |
| **Robotics / Autonomy** | 4 | **Thin.** TSLA, TER, AUR, OUST; no ISRG, ABB, Fanuc or SYM in the registry |
| **Oil / Energy (fossil)** | 2 | **Too thin.** Only XOM and PR (plus the USO ETP, which we exclude). Recommend not shipping, or merging into "Energy" with Power names, clearly labelled |

**AI (compute/models/infra)** (15 names)

| Ticker | Name | 4663 address (registry) |
|---|---|---|
| NVDA | NVIDIA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` |
| AMD | AMD | `0x86923f96303D656E4aa86D9d42D1e57ad2023fdC` |
| AVGO | Broadcom | `0x156E175DD063a8cE274C50654eF40e0032b3fbcF` |
| TSM | Taiwan Semiconductor Manufacturing | `0x58FfE4a942d3885bAa22D7520691F611EF09e7AA` |
| MSFT | Microsoft | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` |
| GOOGL | Alphabet Class A | `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3` |
| META | Meta Platforms | `0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35` |
| PLTR | Palantir Technologies | `0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A` |
| MU | Micron Technology | `0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD` |
| ANET | Arista | `0x28bABD556b60E53663B8615036479a29c2CDd1Bf` |
| CRWV | CoreWeave | `0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3` |
| NBIS | Nebius Group | `0x9D9c6684F596F66a64C030B93A886D51Fd4D7931` |
| SMCI | Super Micro Computer | `0xc01aA1fECeC0605b13bc84874ff7256C0f5F562a` |
| VRT | Vertiv | `0xFA78C12E6488814A0262E4e802749a4a737d5fB7` |
| ALAB | Astera Labs, Inc. | `0x748c32c3ca24eDf31ea597Db1F3d330a7a6DA3Dc` |

**Semiconductors** (14 names)

| Ticker | Name | 4663 address (registry) |
|---|---|---|
| NVDA | NVIDIA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` |
| AMD | AMD | `0x86923f96303D656E4aa86D9d42D1e57ad2023fdC` |
| AVGO | Broadcom | `0x156E175DD063a8cE274C50654eF40e0032b3fbcF` |
| TSM | Taiwan Semiconductor Manufacturing | `0x58FfE4a942d3885bAa22D7520691F611EF09e7AA` |
| ASML | ASML Holding NV | `0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA` |
| MU | Micron Technology | `0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD` |
| INTC | Intel | `0xc72b96e0E48ecd4DC75E1e45396e26300BC39681` |
| QCOM | Qualcomm | `0x0f17206447090e464C277571124dD2688E48AEA9` |
| MRVL | Marvell Technology | `0x62fd0668e10D8B72339BE2DCF7643001688ff13B` |
| AMAT | Applied Materials | `0x36046893810a7E7fCE501229d57dc3FC8c8716d0` |
| LRCX | Lam Research Corp | `0x57b0030166DB0C31690d1A5aA167e2e26e2C29a4` |
| KLAC | KLA | `0x96b933C74eCB4A0926b9210cef7b743EF46be2E9` |
| ON | ON Semiconductor | `0xbBD09F72b025360FeE5C928053Dca6248d35be54` |
| TER | Teradyne | `0x2778C5024D5cA2CdB0f8eAD671ffc69963AdCD9C` |

**Power / Nuclear (AI power)** (9 names)

| Ticker | Name | 4663 address (registry) |
|---|---|---|
| CEG | Constellation Energy | `0xaE517A2903E68bd929Dfd15be875F8369D53e94a` |
| VST | Vistra | `0x561e2a49212b7cCF47f2744Ccb83e200722fADBc` |
| GEV | GE Vernova | `0x94B8AAE43A1cCc08Aa64B7D1F29b4D920aF4a0C9` |
| OKLO | Oklo | `0x8B2f88497f15A18E9D4FFa1a8fFB8538399aE774` |
| SMR | NuScale Power | `0x1Eebee7F74517e0279dFb09d25B0407bEEc3FDd6` |
| NNE | Nano Nuclear Energy | `0xBEF75684C43c4ea7BD18Dd532a2244674Ee8b926` |
| BE | Bloom Energy | `0x822CC93fFD030293E9842c30BBD678F530701867` |
| FLNC | Fluence Energy | `0x282e87451E10fA6679BC7D76C69BE44cD3fC777C` |
| PWR | Quanta | `0x9Ab02Ead789b6903c3c44d0ED32F9c707CDF12FD` |

**Defense / Aerospace** (8 names)

| Ticker | Name | 4663 address (registry) |
|---|---|---|
| LMT | Lockheed | `0x329fcACEb9AD6F9580DD5F643fed0646900D043c` |
| LHX | L3Harris | `0x48d60243c66437c6ac3c2495Be94747aEd5Dfe25` |
| HII | Huntington Ingalls | `0xEB61c0Ed490A367d4E3631cCf8a74B3bfc7E775D` |
| KTOS | Kratos Defense & Security Solutions | `0x7FD06a4d81cCfA3F351394E144d5191874C31313` |
| AVAV | AeroVironment | `0xF6290b5e7C26502e2dA514C31509849718EA76A5` |
| RCAT | Red Cat | `0xFDE6b5d9BB419B10C23268c74e369AbFF39C0460` |
| BA | Boeing | `0x4D21483a44Bf67a86b77E3dA301411880797D452` |
| HWM | Howmet Aerospace | `0xAEa445c5F3DB1a462998ccC422A875A361ee5d99` |

**Space** (8 names)

| Ticker | Name | 4663 address (registry) |
|---|---|---|
| RKLB | Rocket Lab Corporation | `0x3b14C39E89D60D627b42a1A4CA45b5bb45Fc12e2` |
| ASTS | AST SpaceMobile | `0x1AF6446f07eb1d97c546AFC8c9544cBDF3AD5137` |
| LUNR | Intuitive Machines | `0xa5D4968421bA94814Be3B136b15cf422101aC1a3` |
| FLY | Firefly Aerospace Inc. | `0x03BC731Ffb162cdd7B98D3C6542bFC291126075d` |
| PL | Planet Labs | `0xAA4d64474c172010aB57719cb9951E6142a100d3` |
| RDW | Redwire | `0x92Ef19E82bD8fF36661DE838D5eaE7e5CEF0EfFE` |
| SPCX | Space Exploration Technologies Corp. Class A Common Stock | `0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa` |
| SATS | EchoStar | `0x95052ddcd5DC25641657424A8Cf04834997E1730` |

**Quantum** (6 names)

| Ticker | Name | 4663 address (registry) |
|---|---|---|
| IONQ | IonQ | `0x558378E000D634A36593E338eBacdd6207640EfE` |
| RGTI | Rigetti Computing | `0x284358abc07F9359f19f4b5b4aC91901Be2597Ba` |
| QBTS | D-Wave Quantum Inc. Common Stock | `0xC583c60aeF9Dc401Da72cEC1B404743a93cea1Cc` |
| QUBT | Quantum Computing | `0x59818904ab4cE163b3cE4FfB64f2D6Ca02c434B4` |
| INFQ | Infleqtion | `0xB853bC83a753342a4f8320ea680b4B1E84118D21` |
| XNDU | Xanadu Quantum | `0xA8eB3BCcbf2017eE7CBfb652eB51CF2E1B153289` |

**Cybersecurity** (5 names)

| Ticker | Name | 4663 address (registry) |
|---|---|---|
| CRWD | CrowdStrike Holdings | `0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931` |
| PANW | Palo Alto Networks | `0xB039597eD45CBa7B6E2fb9E8BE51802969CEe5Be` |
| ZS | Zscaler | `0x7dc013eB55e436f30d7ED1AFE4E36d6e45e3c3f7` |
| FTNT | Fortinet | `0x3FB8976980d486084b2eb4a404BD12e72823958f` |
| NET | Cloudflare, Inc. Class A common stock | `0x116F00968269B7bfbaD4109cE591d6E74c0601d4` |

**Robotics / Autonomy** (4 names)

| Ticker | Name | 4663 address (registry) |
|---|---|---|
| TSLA | Tesla | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` |
| TER | Teradyne | `0x2778C5024D5cA2CdB0f8eAD671ffc69963AdCD9C` |
| AUR | Aurora Innovation | `0x373C06c4f7BDe527D7Dae4BA169E42b55E393CeD` |
| OUST | Ouster | `0x40E7a279850e443f582059ae5dC1c3b6563E6395` |

**Oil / Energy (fossil)** (2 names)

| Ticker | Name | 4663 address (registry) |
|---|---|---|
| XOM | ExxonMobil Holdings Corporation | `0xf9B46d3D1B22199D4D1025a9cEDB540A33F1a2d5` |
| PR | Permian Resources | `0x4189F0c66EBBB0bfeF1C31f763131361EF32f77C` |

### Demo chain (46630)
Only **TSLA, AMZN, PLTR, NFLX, AMD** exist (fork-tested). The only demoable basket is a **mini "AI & Tech" basket: AMD, PLTR, AMZN** (optionally + TSLA, NFLX as "Tech"), Robinhood's registry lists no 46630 deployments, so none of the other themes can be filled on the demo chain.

## 2. Basket definition (static, versioned, hashed)
```json
{"id":"ai","version":"1.0.0","chainId":46630,"name":"AI & Tech (mini)",
 "legs":[{"symbol":"AMD","weightBps":4000},{"symbol":"PLTR","weightBps":3500},{"symbol":"AMZN","weightBps":2500}],
 "minLegUsd":5,"rounding":"floor-to-cent, remainder to largest weight"}
```
`basketHash = keccak256(canonicalJSON)`, pinned in every preview/buy, like `strategyHash`. Weights are static (no LLM-chosen weights in v1). Changes = new version; old versions stay readable for history. Files: `server/baskets/<id>/<version>.json`, hashed at build; mismatch → refuse.

## 3. MCP tools
| Tool | Inputs | Output |
|---|---|---|
| `list_baskets` | — | `[{id, version, basketHash, name, legs:[{symbol, weightBps}], chainAvailable, thin:boolean}]` |
| `get_basket` | `id, version?` | full definition, prices, per-leg tradability, disclaimer |
| `preview_basket_buy` | `id, usd, version?` | `{previewId, basketHash, legs:[{symbol, usd, amountIn, quotedOut, minOut, feeUsd}], totalUsd, totalFeeUsd, skipped:[{symbol, reason}], capHeadroom:{perTrade:100, remaining24h}, scaledDown:boolean, marketOpen, oracleFresh, expiresAt}` (no tx) |
| `buy_basket` | `previewId` (or `id, usd` → implicit preview) | `{basketOrderId, status: filled\|partial\|failed, legs:[{symbol, status, txHash, out, error?}]}` |
| later: `sell_basket` | `basketOrderId \| id, fraction` | same shape, legs are sells to USDG |
| later: `rebalance_basket` | `id` | preview of trades back to target weights; same confirm flow |
| `list_basket_orders` | `status?` | history incl. partial state |
REST mirror: `GET /api/baskets`, `GET /api/baskets/:id`, `POST /api/baskets/preview`, `POST /api/baskets/buy`, `GET /api/baskets/orders`.

### Sizing rules
- **Split:** leg_usd = floor_cent(usd × weightBps / 10000); rounding remainder goes to the largest-weight leg.
- **$100 per-trade cap:** any leg > $98 is split into sub-legs of ≤ $98 (buffer for price movement between quote and execution against the onchain $100 check). Example: $300 into AMD 40/PLTR 35/AMZN 25 → AMD $120 = $98 + $22, PLTR $105 = $98 + $7, AMZN $75 → **5 swaps**.
- **$500 per vault, rolling 24h:** `_consume` counts buy legs (USD value of tokenIn); stock→USDG sells via a registered pool are exempt (Julius 2026-10-18, Quintus 5491737). Preview reads `remainingToday` and either **refuses** (default) or, with `allowScaleDown:true`, scales the whole basket proportionally to fit. A $500 basket uses the whole day's buy budget, but the owner can still sell back to USDG the same day (exits are exempt). Default max basket = $500, limited by remaining buy headroom.
- **Min leg size:** $5 (fee 30 bps = $0.015; below that, rounding and dust dominate). Legs that would fall under $5 are dropped and their weight redistributed pro rata, reported in `skipped`. With $5 minimums, a 15-name basket needs ≥ $75.
- **Rounding/decimals:** USDG 6 dp, stock tokens 18 dp; amounts computed in integer units; `minOut` from `pool.quote()` minus `oracleDevBps` (default 100, max 300).

### Execution
1. **Preflight, all or nothing:** for every leg, check market open (Mon–Fri 13:30–20:00 UTC schedule), oracle fresh (< 1h), token allowlisted and tradable, eligibility, per-leg `quote()` > 0, total ≤ headroom. Any failure → nothing executes; return reasons.
2. **Sequential legs** via `AgentVault.agentSwap` (agent key, server-side), each a normal capped swap with `minOut > 0` and the oracle floor.
3. **Partial fills:** if a leg reverts mid-way (price moved past the floor, oracle went stale, market closed), stop, record `status: partial` with per-leg results, and **don't retry automatically**. Offer the user "retry remaining legs" (new preview) or "sell filled legs". No atomicity across legs in v1; say so in the preview.
4. Preview expires in 60 s (quotes go stale).

### Execution policy (updated 2026-10-18, Julius): auto-execute within limits
~~Agent proposes, owner confirms each basket buy.~~ Superseded: **every trade inside the onchain limits auto-executes with no owner prompt** ($100/trade, $500 rolling-24h buys, agent sells up to $500 rolling-24h). A basket buy that passes preflight runs right away (`buy_basket` from MCP or REST returns the execution; there is no confirm step and no "owner confirms split" screen). The only remaining owner approval is an agent **sell over the $500/24h sell cap** (passkey-approved `SellApproval`, R4-1). Strategy activation keeps its owner confirmation (S-3).
Guardrails that replace the confirm step (Gaius): (1) an in-app owner activity feed for every auto-executed trade, each with a revoke-key action (`GET /api/activity`, SSE `GET /api/activity/stream`); (2) a per-key anomaly breaker (80% of either 24h cap within 1h, or > 5 trades in 10 min; a basket counts as one trade) that stops relaying for the key until the owner resumes or revokes it; (3) a per-key MCP limit of 10 trade-tool calls/min.

## 4. Contract changes
- Checked `src/FeeRouter.sol` and `src/AgentVault.sol`: **no multicall or batch-swap function exists** (only single `swap`/`swapWithPermit2`/`executeIntent` and `agentSwap`).
- **v1: no contract change.** Legs are sequential server-side `agentSwap` calls; every leg passes the caps, allowlist, oracle floor and market-hours checks independently. Cost: N transactions, no cross-leg atomicity.
- **Later:** `AgentVault.agentSwapBatch(Leg[])` (or a router multicall) that loops through `_consume` + swap per leg and reverts all on any failure, for atomic baskets. Needs Gaius review (per-leg caps inside the loop, gas bounds, max legs ≤ 15).

## 5. Naming & copy (Marcus)
- Call them **"baskets"** or **"themes"**. **Never "ETF", "index", "fund" or "portfolio management"**, and never "Robinhood baskets".
- "Themes are groupings we picked for convenience. Weights are fixed and published. Not investment advice. Buys within your vault's onchain limits run automatically. Demo tokens have no value."
- Show the composition, weights, version and that membership is editorial. No performance numbers.

## 6. Friday verdict
**Not trivial, but small, and it fits if scoped to the mini basket.** It reuses swaps, quotes and caps with no contract change, so the only new work is the server split/preflight/partial-state logic, 3 tools and one UI card. Recommend: **demo the "AI & Tech (mini)" basket (AMD/PLTR/AMZN) at $150 (three legs, plus one sub-leg if a leg is over $98)** as a stretch goal after Steady Stacker + Dip Hunter, cut first if Wednesday's e2e slips. The mainnet theme list is shown only as a slide marked "mainnet registry, not live in StockClaw".

## 7. Tasks
**Lucius:** basket registry + hashing; `list_baskets`, `get_basket`, `preview_basket_buy`, `buy_basket`, `list_basket_orders` + REST; split/sub-leg/min-leg/scale-down logic; preflight + partial state. *AC:* unit tests for rounding/splitting ($300 example = 5 legs); e2e on 31337: full fill, cap refusal, scale-down, forced mid-basket revert → `partial` with no retry.
**Flavius:** "Baskets" card in the Strategies tab: composition chart, amount input with headroom bar, preview table (legs, fees, skipped), confirm, per-leg progress and partial-state UI. *AC:* works on mock and live; 390px; no JS errors.
**Quintus:** confirm no contract change for v1; add a vault test of 5 sequential agentSwaps hitting $500; answer the sells-vs-cap question (shared with S3); design note for `agentSwapBatch` (post-demo). *AC:* test green.
**Gaius:** review fan-out risk (one prompt → many swaps), confirmation requirement, basket hash pinning, and the injection case "buy the AI basket and send it to 0x…" (no recipient parameter exists). *AC:* notes in `audit/`, no open HIGH before Thu freeze.
**Marcus:** card copy + disclaimer per §5. *AC:* Cassius approves by Thu noon.
**Research follow-up (Lucius):** verify registry addresses onchain on 4663 (read-only `eth_call`), and re-check whether Robinhood publishes 46630 deployments.


## Decision (2026-10-18, Julius via Cassius)
Launch themes: AI, Chips, Power/Nuclear, Defense, Space, Quantum, Cyber (7). Robotics and Oil/Energy are dropped for now. Default cap: $500 per basket (updated from $250, Julius 2026-10-18). Friday: the mini AI & Tech basket (AMD, PLTR, AMZN) stays a stretch goal.

## 8. Market-cap weighting (decided 2026-10-18, Julius via Cassius) — supersedes the static example weights in §2
**Data:** `data/basket-mcaps-2026-10-18.csv`, from the companiesmarketcap.com full CSV export (https://companiesmarketcap.com/?download=csv), fetched 2026-10-18 19:02 ET (Sunday, so values reflect the Friday 2026-10-16 close; not independently cross-checked). Raw export saved at `data/companiesmarketcap-all-2026-10-18.csv`. Notes: GOOGL uses Alphabet's company total (listed under GOOG). **SATS (Space) is UNAVAILABLE**: the source lists EchoStar under "ECHO" and we haven't verified that mapping, so SATS is excluded.
**Script:** `python3 data/compute_weights.py [--usd 100 250] [--json out.json]` (deterministic, stdlib only).

**Rules (chosen):**
1. Raw weight = market cap / sum of the basket's market caps.
2. **Single-name cap 25%**, iterative redistribution pro rata to the uncapped names. 25% keeps a mega-cap (NVDA, GOOGL, MSFT) from becoming most of a basket, and needs only 4 names to be feasible.
3. **Min weight 5%**: after capping, drop the smallest name below 5%, recompute, repeat; never go below 4 names. Effect: long-tail small caps drop out of AI/Chips/Power/Defense. With exactly 4 survivors (Defense), the cap forces equal weight (25% each). That's a property of the rules, so we disclose it.
4. **Min leg $5** (0.30% fee = $0.015, about $0.02–0.03 total per leg with the pool spread, and room for cent rounding). Because min weight is 5%, every leg is ≥ $5 at $100. For smaller buys, drop the smallest-cap name and recompute weights (same rules) until every leg is ≥ $5. So a $50 buy uses fewer names. Never pad names.
5. **Max leg $98**: legs above $98 split into sub-legs. With a 25% cap, no leg goes over $98 until the basket is above $392, so the $100 and $250 sizes need one swap per name.
6. Rounding: floor each leg to the cent, remainder to the largest leg. That leg can therefore exceed 25% by a few cents.
7. Weights are stored in basis points (sum 10000) and hashed (`sha256` of canonical JSON, see script output) into a versioned basket file `server/baskets/<id>/1.0.0.json`, pinned in every preview and buy, like strategies.

**Results (v1.0.0, market caps as of the 2026-10-16 close):**
```

== AI  (sha256:831b0ab12402…)
  NVDA 25.00%, GOOGL 21.23%, MSFT 20.24%, TSM 11.02%, META 9.31%, AVGO 8.08%, MU 5.12%
  $100: NVDA $25.03, GOOGL $21.22, MSFT $20.23, TSM $11.02, META $9.30, AVGO $8.08, MU $5.12  | names 7, swaps 7
  $250: NVDA $62.52, GOOGL $53.06, MSFT $50.59, TSM $27.55, META $23.27, AVGO $20.21, MU $12.80  | names 7, swaps 7

== Chips  (sha256:caed7cd0e335…)
  NVDA 25.00%, TSM 24.05%, AVGO 17.63%, MU 11.17%, AMD 9.70%, ASML 7.11%, INTC 5.34%
  $100: NVDA $25.04, TSM $24.04, AVGO $17.63, MU $11.17, AMD $9.69, ASML $7.10, INTC $5.33  | names 7, swaps 7
  $250: NVDA $62.53, TSM $60.11, AVGO $44.08, MU $27.93, AMD $24.24, ASML $17.77, INTC $13.34  | names 7, swaps 7

== Power/Nuclear  (sha256:cc239dbbf9d9…)
  GEV 25.00%, CEG 23.46%, PWR 23.18%, BE 15.91%, VST 12.45%
  $100: GEV $25.01, CEG $23.46, PWR $23.18, BE $15.90, VST $12.45  | names 5, swaps 5
  $250: GEV $62.52, CEG $58.65, PWR $57.95, BE $39.76, VST $31.12  | names 5, swaps 5

== Defense  (sha256:19a63d89a856…)
  LHX 25.00%, BA 25.00%, LMT 25.00%, HWM 25.00%
  $100: BA $25.00, LMT $25.00, HWM $25.00, LHX $25.00  | names 4, swaps 4
  $250: BA $62.50, LMT $62.50, HWM $62.50, LHX $62.50  | names 4, swaps 4

== Space  (sha256:0b4a75d1afb1…)
  SPCX 25.00%, RKLB 25.00%, ASTS 25.00%, PL 12.54%, FLY 7.13%, RDW 5.33%
  $100: SPCX $25.01, RKLB $25.00, ASTS $25.00, PL $12.54, FLY $7.12, RDW $5.33  | names 6, swaps 6
  $250: SPCX $62.52, RKLB $62.50, ASTS $62.50, PL $31.35, FLY $17.81, RDW $13.32  | names 6, swaps 6

== Quantum  (sha256:1956d5069260…)
  IONQ 24.99%, QBTS 25.00%, RGTI 23.93%, INFQ 11.71%, QUBT 8.75%, XNDU 5.62%
  $100: IONQ $25.02, QBTS $25.00, RGTI $23.92, INFQ $11.70, QUBT $8.74, XNDU $5.62  | names 6, swaps 6
  $250: IONQ $62.52, QBTS $62.50, RGTI $59.81, INFQ $29.26, QUBT $21.86, XNDU $14.05  | names 6, swaps 6

== Cyber  (sha256:2992a44b3416…)
  PANW 25.00%, CRWD 25.00%, FTNT 23.55%, NET 20.03%, ZS 6.42%
  $100: PANW $25.02, CRWD $25.00, FTNT $23.55, NET $20.02, ZS $6.41  | names 5, swaps 5
  $250: PANW $62.52, CRWD $62.50, FTNT $58.88, NET $50.06, ZS $16.04  | names 5, swaps 5
```
Swaps per buy = names (no sub-legs at these sizes). Weights show what's left after the 5% floor; excluded names are listed in the CSV and can return at rebalance.

**Rebalance cadence (proposal):** recompute monthly (first trading day, from a fresh market-cap snapshot), plus an off-cycle trigger if any name's target weight moves more than 5 percentage points, or a name falls below 5% or rises above the cap. Each recompute creates a new version with a new hash. Existing holders are never rebalanced automatically; `rebalance_basket` previews the trades to the new target and the owner confirms (agent proposes, owner confirms). Membership changes (adding or removing a ticker from a theme) follow the same versioning plus a Cassius/Marcus review.

**Limits (Julius, 2026-10-18: "$500 limit to start with, we still charge 0.30% per swap"):** $500 rolling-24h applies to buys; stock→USDG sells are exempt (Quintus 5491737, Gaius reviewing); **default max basket $500**; fee 0.30% per swap; $100 per-trade cap unchanged. At $500 with a 25% cap the largest leg is $125, so it splits into $98 + $27 (two swaps); a $500 basket is 8–10 swaps (script output with `--usd 500`). Replaces the earlier $250/$400 notes.
