# StockClaw — Architecture & Tech Plan (v0.1, testnet)
Owner: Lucius (CTO), Onchain Experiments · Drafted Sun Oct 18 2026 · Target: testnet demo Fri Oct 23 2026
**TESTNET ONLY (chain 46630). Nothing touches mainnet (4663) without the founder's written approval.**

## 0. Research findings (what's real)
| Item | Status | Detail |
|---|---|---|
| Testnet chain ID | VERIFIED (RPC `eth_chainId` = 0xb626 = 46630) | Some sites list 46646. That's wrong. |
| Public RPC | VERIFIED | `https://rpc.testnet.chain.robinhood.com` (rate-limited). Prod: Alchemy `https://robinhood-testnet.g.alchemy.com/v2/{KEY}` (docs.robinhood.com/chain/connecting) |
| Explorer | VERIFIED | `https://explorer.testnet.chain.robinhood.com` (Blockscout, API at `/api/v2`) |
| Faucet | VERIFIED (documented) | `https://faucet.testnet.chain.robinhood.com`. Gives test ETH + 5 each TSLA/AMZN/PLTR/NFLX/AMD. A third-party guide reports 0.01 ETH per 24h (unverified). Extra ETH: Alchemy/QuickNode/Chainstack faucets or bridging from Sepolia. |
| Stock tokens | Addresses from a third-party guide (runitup.gg). `symbol()` confirmed onchain by us. Still need to confirm they're the official faucet tokens. | TSLA `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E` · AMZN `0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02` · PLTR `0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0` · NFLX `0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93` · AMD `0x71178BAc73cBeb415514eB542a8995b82669778d` |
| USDG on testnet | UNVERIFIED / ambiguous | Explorer search shows several community "USDG"/"Mock USDG" tokens and no official one. **Decision: deploy our own `MockUSDG` (6 dp) for the demo.** Don't hard-code any third-party USDG. |
| Permit2 | Bytecode is present at the canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3` (verified via eth_getCode). Not audited as the genuine deployment. | |
| Uniswap v3/v4/UniversalRouter | UNVERIFIED canonical | The explorer shows many community-deployed UniversalRouter/PoolManager/V3Factory contracts. No official Uniswap testnet deployment is confirmed (sources say official Uniswap is on mainnet 4663). A launchpad reports V3/V4/Sushi V3 on testnet, with stock pairs only on V4. We can't rely on liquidity. |
| Chainlink price feeds | UNVERIFIED on testnet | LINK tokens appear, but we found no stock/USD data feed proxies. **Decision: deploy our own `MockAggregatorV3` (Chainlink interface) fed by our keeper from a public price source.** Swap to real feeds when they're confirmed. |
| ClawPump model | VERIFIED (clawpump.tech) | Remote MCP at `mcp.clawpump.tech/mcp`. OAuth sign-in (Google/X), no key copying. 130+ tools (swap_execute, dca_create, limit_order_create…). Non-custodial per-agent wallets. REST with `cpk_` bearer keys. x402 pay-per-call. Fees: 1% of volume, 75% to creators. They already advertise Robinhood Chain launches, so they're a **direct competitor**. |
| MCP best practice | Per the spec | Streamable HTTP transport. OAuth 2.1 with PKCE. Server is a Resource Server with Protected Resource Metadata (RFC 9728). Dynamic client registration for Claude/ChatGPT connectors. Validate token audience, no token passthrough, scope per tool. Human confirmation for write tools. |

## 1. Product shape
Remote MCP server (`https://mcp.stockclaw.xyz/mcp`, name TBD) + REST API + web app (landing, onboarding/eligibility, dashboard). An agent connects via OAuth. Each user gets a smart-account wallet on 46630. The agent calls tools to quote, swap, DCA, and place limit orders between stock tokens and USDG.

## 2. Wallet model
| Option | Pros | Cons |
|---|---|---|
| Custodial hot wallets | Fastest to build | We hold keys = custody/regulatory and honeypot risk. Contradicts the "own wallet" pitch. |
| MPC (e.g. Turnkey/Privy/Alchemy embedded) | Good UX, no seed | Vendor dependency. Policy engine lives offchain. Still partial custody in practice. |
| **ERC-4337 / Safe smart account + session keys** | User owns account. Agent gets a scoped, revocable, expiring key with onchain spend limits and token/target allowlists. Fits DCA/limits. | More contracts, bundler/paymaster dependency |

**Recommendation: ERC-4337 smart account (Safe + Safe4337Module, or a Kernel/ERC-7579 account with a session-key validator) per user.** Owner = the user's EOA/passkey (from onboarding). The **agent session key** is generated and held server-side in KMS, scoped to: our `StockClawRouter` only, the allowlisted tokens, a per-tx and per-day USDG-notional cap, and an expiry (≤7 days). Revocable in one tx from the dashboard.
*Friday fallback:* if no stable 4337 EntryPoint/bundler is on 46630 (UNVERIFIED; Alchemy advertises gas-sponsored programmable wallets on Robinhood Chain, so check that), ship a minimal `AgentVault` contract per user (owner + delegate key + caps enforced in Solidity). Same policy model, no bundler.

## 3. Swap routing
1. **Primary for the demo: our own `StockClawPool`.** A constant-product (x·y=k) USDG/stock pool per ticker, seeded by us with faucet stocks + MockUSDG, with an oracle-band guard (reject if the post-trade price deviates more than X% from MockAggregator). This is deterministic and under our control.
2. **Optional: Uniswap v4/v3 adapter.** Only if Day 1 verifies a trustworthy PoolManager/V3 factory with real stock/USDG liquidity. Implemented as a router adapter behind an allowlist.
3. **RFQ (post-demo):** signed EIP-712 quotes from our market-maker signer, filled in the router with `quote.expiry` + nonce. Stub interface only this week.
The router selects the best quote across enabled adapters offchain (quote engine). Onchain it enforces `minAmountOut` + deadline.

## 4. Fee collection
**Fee-wrapping router contract `StockClawRouter`:** pulls `amountIn` (Permit2 or approve), skims `feeBps` (default 30, max 50, hard cap 100 in code) to `feeTreasury` in the input token, swaps the remainder via the adapter, sends output to the account, and emits `Swap(account, tokenIn, tokenOut, in, out, fee, source)`. Fee is charged on input, which is transparent and simple. Owner = multisig (testnet: a 2/3 Safe). `setFeeBps` is timelocked post-demo. No per-integrator split yet (hook for API-tier discounts: `feeBps` override per authorized caller, signed by the server).

## 5. DCA & limit orders (intents + keeper)
- The user/agent signs an **EIP-712 intent**: `{account, tokenIn, tokenOut, amountPerExec | amountIn, limitPrice?, interval?, maxExecs, minOut/slippageBps, expiry, nonce}`.
- Stored in Postgres. The **keeper** (Node worker, cron every 30s) checks the trigger: time for DCA, MockAggregator/pool price for limits. It calls `StockClawRouter.executeIntent(intent, sig)` via the session key or the AgentVault delegate.
- Onchain checks: signature (ERC-1271 for smart accounts), nonce/execution count, expiry, price condition against the oracle (not just the pool), minOut. Cancellation = onchain `cancel(nonce)` + DB flag.
- Keeper gas is paid by us on testnet (paymaster later). Keeper key has no custody, only an execute right.

## 6. Eligibility (no US persons)
Layers: (1) **Geo/IP block** at the edge (Cloudflare country rule US + territories, VPN/hosting-ASN heuristics) on web, MCP, and API. (2) **Self-attestation** at onboarding ("I am not a US person", with the definition, timestamped, signed by the wallet via EIP-712, stored). (3) **Onchain `EligibilityRegistry` allowlist**: our attester sets `eligible[account]=expiry`, and the router and vault **revert for non-allowlisted accounts**. (4) Post-demo: a KYC/proof-of-residency provider (attestation via EAS or zk-proof). MCP `check_eligibility` returns the status. Sanctions screening (OFAC wallet screening) is planned post-demo.
**Honest note:** IP + self-attestation is weak and easily evaded. Whether this is sufficient for tokenized-equity access, swap fees, and an AI-agent intermediary (possible broker/dealer, MSB, or investment-adviser questions in several jurisdictions) **requires legal review before any mainnet launch.** The testnet demo uses valueless tokens only.

## 7. MCP tools (v1)
All write tools require scope `trade` and an eligible account, and return `{txHash, explorerUrl, status}`. They're annotated `destructiveHint` so clients prompt for confirmation.
| Tool | Inputs | Output |
|---|---|---|
| `check_eligibility` | — | `{eligible, reason, expiresAt}` |
| `get_wallet` | — | `{address, chainId, sessionKey:{expiresAt, dailyCap, spentToday}}` |
| `get_balances` | `tokens?[]` | `[{symbol, address, amount, usdValue}]` |
| `list_assets` | — | `[{symbol, address, decimals, priceUsd, source}]` |
| `get_price` | `symbol` | `{priceUsd, source, updatedAt}` |
| `quote_swap` | `tokenIn, tokenOut, amountIn, slippageBps?` | `{amountOut, minOut, feeAmount, route, priceImpact, quoteId, expiresAt}` |
| `execute_swap` | `quoteId` or `(tokenIn, tokenOut, amountIn, minOut)` | tx result |
| `create_dca` | `tokenIn, tokenOut, amountPerExec, interval, maxExecs, slippageBps` | `{intentId, nextRunAt}` |
| `create_limit_order` | `tokenIn, tokenOut, amountIn, limitPrice, expiry` | `{intentId}` |
| `list_orders` | `status?` | `[intent…]` |
| `cancel_order` | `intentId` | tx result |
| `get_history` | `limit?` | `[{txHash, type, in, out, fee, ts}]` |
| `faucet_testnet` | — | links/instructions (testnet only) |
| `get_usage` | — | `{tier, callsToday, limit}` |

## 8. API tiers & rate limiting
Free: 60 req/min, 500 write/day, 30 bps fee. Pro ($29/mo, placeholder): 300 req/min, DCA/limits ≤50 active, 25 bps. Builder ($199/mo): 1,000 req/min, webhooks, 20 bps, REST keys. Enterprise: custom. Fee floor ≥20 bps; the brief's range is 30–50 bps, so pricing needs Cassius/founder sign-off. Token bucket per account + per IP in Redis, enforced at the gateway. 429 with `Retry-After`. Write tools also respect the onchain session caps (defense in depth).

## 9. Stack
Contracts: Solidity 0.8.2x, Foundry, OpenZeppelin, Safe/4337 modules. Backend: TypeScript, `@modelcontextprotocol/sdk` (Streamable HTTP), Hono/Fastify, viem, Postgres (Neon/Supabase), Redis (Upstash), BullMQ keeper. Auth: OAuth 2.1 AS (WorkOS/Auth0/Stytch or `oidc-provider`) with DCR + PKCE. Keys: AWS KMS/GCP KMS for session + keeper keys. Frontend: Next.js, wagmi/viem, RainbowKit or passkeys. Infra: Vercel (web), Fly/Railway (MCP + keeper), Cloudflare (WAF/geo). Obs: Sentry, OpenTelemetry, Blockscout links.

## 10. Security threats & mitigations
- **Prompt injection → malicious trades:** onchain caps, token/target allowlist, server-side slippage ceiling (≤3%), confirmations on write tools, and no tool takes an arbitrary `to`/calldata.
- **Session/keeper key theft:** KMS, short expiry, per-day cap, one-click revoke, alerting on anomalous spend.
- **OAuth flaws (token passthrough, confused deputy, redirect abuse):** audience-bound tokens, exact redirect URIs, PKCE, short-lived access + rotating refresh tokens.
- **Oracle/pool manipulation:** oracle band on the pool, limit triggers on the oracle, TWAP later.
- **Router bugs (reentrancy, approval drain, fee bypass):** ReentrancyGuard, pull exact amounts, no infinite approvals held by the router, pausable, fuzz + invariant tests, Slither.
- **Intent replay/cross-chain replay:** EIP-712 domain with chainId 46630 + verifyingContract, nonces.
- **Eligibility bypass:** onchain gate + legal caveat. Log attestations.
- **Supply chain/secrets:** pinned deps, Dependabot, gitleaks, no keys in repo, least-privilege CI deploy keys (testnet only).
- **Mainnet accident:** deploy scripts hard-fail if `chainId != 46630`. Separate env with no mainnet RPC configured.

## 11. Day-by-day plan
- **Sun 18 / Mon 19:** Finalize the plan. Repo + CI. Verify 4337/bundler availability, stock tokens, and Uniswap. Quintus starts MockUSDG/MockAggregator/Registry. Flavius wireframes. Gaius threat model + CI security.
- **Tue 20:** Router + Pool + Vault/session module on testnet with tests. MCP server skeleton with OAuth + read tools. Landing page live.
- **Wed 21:** execute_swap end to end from Claude/Cursor. Keeper + DCA/limit intents. Onboarding/eligibility flow wired. Slither/fuzz pass.
- **Thu 22:** Dashboard (balances, orders, history, revoke). ChatGPT/Grok connector testing. Security review fixes. Feature freeze 6pm ET.
- **Fri 23:** Bug bash AM, demo script + recorded backup, demo PM. Report to Cassius.

## 12. Task breakdown
### Quintus — Solidity
1. `MockUSDG` (6 dp, owner mint + public capped faucet). *AC:* deployed + verified on Blockscout.
2. `MockAggregatorV3` per ticker (Chainlink interface, keeper-updatable, staleness). *AC:* `latestRoundData` works. Updater-only.
3. `EligibilityRegistry` (attester role, expiry). *AC:* router reverts for non-eligible accounts in tests.
4. `StockClawPool` (xy=k, oracle band, LP owner-only for the demo). *AC:* 5 pools seeded. Invariant test k non-decreasing.
5. `StockClawRouter` (fee skim ≤50 bps, cap 100, adapters, Permit2, `executeIntent` EIP-712/1271, cancel, pause). *AC:* ≥90% line coverage, fuzz on fees/slippage, fee lands in treasury.
6. `AgentVault` fallback **or** session-key module config for Safe/Kernel. *AC:* over-cap or off-allowlist call reverts. Revoke works.
7. Deploy scripts with the chainId-46630 guard + `deployments/46630.json`.
### Gaius — Security & DevSecOps
1. Threat model doc (based on §10). *AC:* reviewed by Lucius by Tue.
2. CI: Foundry tests, Slither, gitleaks, npm audit, Dependabot. *AC:* PRs blocked on high findings.
3. KMS setup for session + keeper keys. No plaintext keys anywhere. *AC:* key-rotation runbook.
4. OAuth/MCP review (audience, PKCE, redirect, scopes). *AC:* checklist signed off Thu.
5. Cloudflare WAF, US geo block, rate limits. *AC:* US IP gets a 451 page. 429 under load test.
6. Contract review of router/vault + mainnet-guard verification. *AC:* findings fixed or accepted by Thu EOD.
7. Monitoring/alerts (spend anomalies, keeper failures).
### Flavius — UI/UX
1. Landing page (pitch, supported clients, "testnet" banner, waitlist). *AC:* live on Vercel Tue.
2. Onboarding: connect/create wallet → eligibility attestation (signed) → create smart account → issue agent session (caps/expiry UI) → faucet → "Add to Claude/ChatGPT/Grok/Cursor" instructions. *AC:* a new user gets from zero to first swap in under 5 min.
3. Dashboard: balances, prices, active DCA/limits, history with Blockscout links, session-key caps + revoke, API key/tier. *AC:* reflects onchain state within 30s.
4. Blocked/ineligible and error states, legal disclaimer copy (placeholder pending legal).
5. Demo script visuals.
### Lucius — Integration
1. Day 1 verification spikes (4337/bundler, Uniswap, feeds, stock-token provenance). Update this doc.
2. MCP server (Streamable HTTP, OAuth 2.1 + DCR, PRM) with all §7 tools. *AC:* works in Claude + Cursor; ChatGPT/Grok tested.
3. Quote engine + tx builder (viem). Keeper service. Postgres schema. REST API + tier limiter.
4. Wire contracts ↔ backend ↔ UI. End-to-end demo script. Weekly report to Cassius.

## 13. Open risks / decisions needed
- No verified official USDG, Chainlink stock feeds, or Uniswap on testnet, so the demo runs on our mocks + own pool (call this out in the demo).
- 4337 bundler availability on 46630 is unverified (AgentVault fallback ready).
- Stock-token addresses come from a third party. Confirm via the faucet before seeding.
- ClawPump already supports Robinhood Chain: we need a differentiation story (stock-native DCA/limits, safety caps).
- Legal review of eligibility and the fee model is required before mainnet. Founder approval gates mainnet.
- Fee level/tier pricing needs business sign-off.


## Decisions log (2026-10-18)
- Fee: 0.30% default, 0.50% hard cap in the contract (replaces the 0.50% cap).
- Agent defaults: $100 per trade, $500 per day, allowlist-only, hard block when over a limit.
- Blocked regions: US, Canada, UK, Switzerland, UAE, and sanctioned countries.
- Tier prices and fee discounts are placeholders, not in the demo; Julius decides before launch.
- UI: real tickers shown with a testnet badge; USDG shown as mUSDG; editing limits re-issues the session key.
- Pause control: a one-click revoke of the agent session key (the user-facing pause); the router pause stays admin-only.
- Friday scope: own pool, AgentVault (ERC-4337 module later), keeper pushes mock oracle every 60s and pays testnet gas, 1h staleness or off-hours halts trading, no DCA catch-up, rolling 24h daily cap, eligibility keyed to owner EOA, fee range 0-50 bps with 30 default.
- Strategy S3 (2026-10-18, Julius via Cassius): Momentum Rider replaced by a 9 EMA / VWAP flip (1-min candles, session VWAP, 2-candle confirm, cooldown, max entries/day, optional flat-before-close), keeper-run, long-or-flat, no contract change. Fee drag ~0.8–1.2% per round trip. Sells currently count toward the $500/24h cap, so max 2 round trips/24h and the keeper reserves exit budget; whether sells should count is open for Quintus. Testnet VWAP uses proxy volume and is labeled simulated. Details in STRATEGIES.md §2 S3.
