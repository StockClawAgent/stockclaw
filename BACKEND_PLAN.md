# StockClaw — Backend Plan (routing, wallets, reliability)
Owner: Lucius (CTO) · 2026-10-18 · **Local sim and testnet (46630) only. Nothing on mainnet.** Friday stage demo: public testnet 46630, pending Julius's go-ahead to deploy (local anvil fallback).
Owners: **Lucius** = server/keeper/routing · **Quintus** = contracts · **Gaius** = security · **Flavius** = wallet UX.
Current state (checked in repo): Node/TS server with viem; state lives in `server/data/state.json` (`service.ts` `save()` rewrites it); per-account in-memory tx queue in `chain.ts`; keeper is a `setInterval` loop; AgentVault (not 4337) is the wallet; `FeeRouter.isRouteSupported(adapter, tokenIn, tokenOut)` exists; exit exemption landed in 5491737.

## Friday stage demo target (updated 2026-10-19)
- **Target: public Robinhood Chain testnet 46630, not the local sim.** This is pending Julius's final go-ahead for the deploy. No deploy or faucet claim happens before that.
- **Fallback: local anvil (chain id 46630, MOCK_TOKENS=1)** stays fully working and rehearsed. It's the same build, switched with `RPC_URL`. If the testnet deploy isn't approved, funded and smoke-tested by **Thu 22, 6 pm ET**, or if testnet RPC/faucet/sequencer problems appear on Friday, the demo runs locally.
- Prep done (no txs): dry run of Quintus's HEAD contracts against a 46630 fork (44 txs, ~0.0004 ETH). Fresh testnet-only role keys are kept outside the repo. Blockscout tx links are in place. Runbook and funding table: `docs/TESTNET_DEPLOY.md`.
- Testnet adds: real testnet stock tokens (faucet), Blockscout links in the activity feed and history, keeper-pushed NYSE sessions (fail-closed: market closed until pushed), and a separate KEEPER and FEED_UPDATER (S-4).

## Friday scope
| Area | Friday (demo) | After |
|---|---|---|
| Routing | Pool selection via `isRouteSupported`; per-leg `quote()`; oracle floor + minOut on every swap | Multiple adapters/best-price, RFQ, Uniswap adapter |
| Basket execution | All-legs preflight, sequential legs, partial state, idempotency keys | Atomic `agentSwapBatch` (Quintus), auto-retry policy tuning |
| Reliability | SQLite instead of JSON, durable job table, nonce manager, restart recovery, `/healthz`, structured JSON logs | Postgres, BullMQ/Redis, multi-instance, alerting to Slack/PagerDuty, OpenTelemetry |
| Wallet | AgentVault + session key (as today) | ERC-4337 smart wallet, passkey/email/wallet owner, paymaster, bundler |
| 4337 | **Spike only, at most:** local bundler against a 31337 fork, one sponsored UserOp | Everything else |

## 1. Swap routing (Lucius; contracts Quintus; review Gaius)
- **Pool selection:** for (tokenIn, tokenOut), take candidate adapters from deployments, keep those where `router.isRouteSupported(adapter, tokenIn, tokenOut)` is true, quote each, pick the best `quote()` output. Friday: one pool per pair, so this is a check, not a choice. Stock→USDG through a supported route also qualifies for the cap exemption, and the server must use the same check so its preview matches what the contract does.
- **Basket execution:** (1) preview computes legs (≤ $98, ≥ $5, weights from `baskets.json` pinned by hash); (2) **preflight all legs**: market open, oracle fresh, allowlist, eligibility, `remainingToday` ≥ total buys, `quote()` > 0 for every leg → refuse on any failure; (3) execute legs sequentially through `agentSwap`, each with `minOut = quote × (1 − slippageBps)` and the contract's oracle floor (max 3%; default 100 bps).
- **Retry/partial policy:** a revert on price/floor/staleness → stop the basket, mark `partial`, report filled and unfilled legs. One automatic retry is allowed only for transport errors (RPC timeout, nonce conflict) where the tx was not mined; never for contract reverts. The user chooses "retry remaining" (new preview) or "sell filled legs".
- **Idempotency:** every write (REST/MCP) takes an `Idempotency-Key` (client-supplied or derived from previewId). Stored with the result; a repeat returns the stored result. Each leg has `legId = hash(basketOrderId, index)`, recorded before submit with its tx hash, so a restart never double-buys.
- *AC:* e2e: full fill; forced revert in leg 3 → `partial`, legs 1–2 kept, no retry; replaying the same key → no new txs.

## 2. Wallet infra (Flavius UX; Quintus contracts; Lucius infra; Gaius review)
- **Target:** ERC-4337 smart account per user (Safe + Safe4337Module, or an ERC-7579 account with a session-key validator), owner = passkey (WebAuthn), email (embedded-wallet vendor, TBD) or an existing wallet; agent gets a session key scoped to router + allowlist + caps + ≤ 7-day expiry; one-click revoke; paymaster sponsors testnet gas.
- **What exists on 46630** (DESIGN_NOTES, code checked by Quintus): EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` and v0.6, Safe v1.4.1 singletons and factory. **No public bundler or paymaster is known** for 46630 (unverified; Alchemy markets smart wallets for Robinhood Chain, not confirmed for testnet).
- **Sim plan (spike):** anvil fork of 46630 + a local bundler container (Pimlico **Alto** or Alchemy **Rundler**; image names/versions to be pinned when spiked), a test `VerifyingPaymaster` we deploy locally, one session-key UserOp swap through the router. Not wired into the demo.
- Caps stay enforced onchain (by AgentVault today, by the session-key module later); a wallet migration must not weaken them (Gaius gate).
- *AC (spike, if time):* a UserOp from a passkey-owned account executes one capped swap on the local fork; a write-up of gaps.

## 3. Keeper & server reliability (Lucius; review Gaius)
- **DB:** move `state.json` to **SQLite** (WAL; better-sqlite3) for Friday with tables: accounts, intents, activations, basket_orders, legs, idempotency, jobs, tx_log. Postgres after Friday (ARCHITECTURE §9).
- **Job queue:** durable `jobs` table (status, runAt, attempts, lockedUntil) polled by the keeper; replaces the bare `setInterval`. BullMQ/Redis later.
- **Nonce manager:** one signer per role (keeper, agent, updater); local nonce counter seeded from `getTransactionCount(pending)`, persisted; resync on "nonce too low"; keeps the existing per-account serial queue.
- **Restart recovery:** on boot, reload jobs and every leg/tx in `submitted` state, check receipts by hash, mark mined/failed, resume only unsent work.
- **Health & alerts:** `/healthz` (RPC reachable, oracle age, keeper last tick, queue depth, signer balance); Friday alerts = log lines at `level=error`, later Slack. Alert on oracle stale > 5 min, keeper tick > 2 min late, failed tx rate.
- **Logs:** structured JSON (pino) with requestId, idempotency key, basketOrderId, legId, txHash; never log keys.
- *AC:* kill the server mid-basket → restart → completes or marks partial with no duplicate tx; `/healthz` red when anvil is down.

## 4. Schedule
- **Mon 19:** SQLite + jobs + nonce manager (Lucius); Gaius reviews 5491737.
- **Tue 20:** routing via `isRouteSupported`, basket preflight/legs/idempotency (Lucius); Flavius basket progress UI.
- **Wed 21:** restart-recovery and partial-state e2e; `/healthz`; Gaius review of execution paths.
- **Thu 22:** after Julius's go-ahead, fund roles → deploy to 46630 → Safe accepts ownership → seed pools → smoke test with Blockscout links; 4337 local spike only if everything is green; freeze 6 pm ET (go/no-go: testnet or local).
- **Fri 23:** stage demo on **public testnet 46630**; local anvil is the fallback.
