# StockClaw server: REST API, MCP server, keeper, local deploy

**Testnet only (chain id 46630).** Locally this runs on anvil with chain id 46630. Nothing here broadcasts to Robinhood testnet or mainnet. The server refuses chain 4663 and any chain id other than 46630.

## Prerequisites
Node 20+ and Foundry (`forge`, `anvil`).

## Run locally
```bash
cd server && npm install
npm run build                       # forge build of the COMMITTED contracts (git HEAD) into server/artifacts
npm run chain                       # terminal 1: anvil --chain-id 46630 on :8545
npm run deploy                      # terminal 2: script/Deploy.s.sol with MOCK_TOKENS=1, then seed -> data/local-46630.json
npm start                           # API + prototype UI + MCP (HTTP) + keeper on :8787
```
- UI: http://localhost:8787/ (prototype; add `?mock=1` for the original mocks. The UI also falls back to the mocks when the server can't be reached)
- REST: `GET|POST /api/<stub name>` (one endpoint per function in prototype/api.js, plus `get_usage` and `health`)
- MCP Streamable HTTP: `POST http://localhost:8787/mcp` (stateless). MCP stdio: `npm run mcp` (keep `npm start` running so the keeper executes orders)
- Cursor/Claude Desktop stdio config: `{"command":"npx","args":["tsx","src/mcpStdio.ts"],"cwd":"<repo>/server"}`

## End-to-end test
`npm run build && npm run e2e`: starts its own anvil on :8546 and the API on :8788, then runs 14 checks. The checks cover deploy, the fee cap, eligibility and blocked regions, the vault, the agent key, the faucet, a swap with the fee landing in the treasury, per-trade and allowlist blocks, MCP, DCA with no catch-up, limit orders and cancel, the rolling 24h cap, revoke, and prototype/api.js.

## Config (env)
| var | default | |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8545` | Set it to `https://rpc.testnet.chain.robinhood.com` (or Alchemy) to point at testnet. Needs `DEPLOYER_KEY`, `KEEPER_KEY`, `TREASURY_KEY`, `DEMO_OWNER_KEY` and `AGENT_KEYS` (KMS-backed). Anvil keys are local-only. `npm run deploy` refuses non-local RPCs; testnet contracts come from `script/Deploy.s.sol` after approval, written to `data/testnet-46630.json`. |
| `MARKET_MODE` | `open` locally, `schedule` on testnet | `schedule` halts trading outside NYSE hours (onchain) |
| `KEEPER_INTERVAL_MS` | 60000 | oracle push + intent execution cadence; `KEEPER=off` disables |
| `OWNER_API_TOKEN` / `MCP_API_TOKEN` | unset (local only) | Separate tokens (review S-1). The owner token covers dashboard/owner endpoints; the MCP token covers `/mcp`. Either token works for reads and agent actions. The server **refuses to start on a non-local chain** unless both are set and they differ. |
| `PORT`, `DATA_DIR` | 8787, `server/data` | |

## Enforced decisions
- Fee is 0.30% by default and the contract caps it at 0.50% (`FeeRouter.MAX_FEE_BPS`; deploy asserts 30).
- Agent caps are $100 per trade and $500 per rolling 24h (AgentVault). The server refuses higher caps, and every over-limit trade is a hard onchain revert. Trading is allowlist-only, and keys expire after at most 7 days.
- Blocked regions: US and its territories, CA, GB, CH, AE, CU, IR, KP, SY, RU, Crimea, Donetsk and Luhansk. The server checks both the self-declared country and the `CF-IPCountry` header (geo-IP), and returns 451 for blocked regions. The onchain registry is keyed to the owner EOA, and the vault is linked to its owner.
- Pause = `revoke_session_key` (1 tx). It stops the agent's swaps and all intents it has signed. Editing limits revokes the key and issues a new one.
- DCA has no catch-up: the router skips missed slots and the keeper never replays them.

## Demo shortcuts (disclose on stage)
Single demo user. The server holds the owner's key (`DEMO_OWNER_KEY`) as a stand-in for wallet-connect and signs the EIP-712 attestation itself. Agent keys sit in server memory and env (a stand-in for KMS). Prices are a bounded random walk (±3% around base, kept inside the 5% pool band), not a market-data feed. State is a JSON file, not Postgres. There's no OAuth on MCP yet.

## API notes
- `create_session_key` returns the new key's fields at the top level (for app.js) plus `{revoked: {key, agent, txHash} | null, created: {...}}`.
- `list_orders` status is one of `open | paused | filled | cancelled | expired`, plus `lastError`.
- `POST /api/dev/reset` (local chain only, otherwise 403) wipes server state and switches to a fresh demo owner and a fresh 20-key agent pool, funded with anvil_setBalance. Contracts stay deployed, so demo runs repeat without restarting anvil.
- The quote engine still uses `FeeRouter.quote()` (pool x·y=k). TODO: switch to the oracle-anchored `StockClawPool.quote()` when Quintus ships docs/SERVER_MIGRATION.md.

## Owner wallet: SIMULATED
The demo has no wallet-connect, so the server holds the owner key and signs owner transactions itself (`DEMO_OWNER_KEY`, or an anvil key locally). `get_wallet` and `/api/health` return `ownerSimulated: true`. Owner endpoints accept only `OWNER_API_TOKEN`: `submit_attestation`, `create_smart_account`, `create_session_key`, `revoke_session_key`, `cancel_order`, `dev/reset`, `strategies/activate`, `strategies/proposals/:id/confirm|reject` and `strategies/activations/:id/resume`.

## Keys (local)
anvil #0 is the deployer/attester, #1 the keeper (executes intents and pushes market sessions), #2 the treasury, #3 the simulated owner, #4 the **feed updater (separate from the keeper)** and #5-9 agent keys. Dev reset moves the owner and agents to a fresh HD range. Prices are pushed every 60s (`KEEPER_INTERVAL_MS`) and kept within the feed's per-update move cap. The local deploy raises that cap (`setMaxDelta(5000,5000)`) so scripted demo moves work; testnet keeps 10% per hour with a 20% cap.

## Market sessions
`src/marketCalendar.ts` hardcodes the NYSE 2026-2027 calendar: DST (13:30-20:00 UTC in EDT, 14:30-21:00 UTC from Nov 1 2026), holidays, and early closes at 13:00 ET. The keeper uses an adapter that detects the oracle generation from its ABI:
- With session-based oracles (Quintus's `setSession`, the current HEAD), it pushes each session `[open, close]` before the open. Weekends and holidays push nothing, so the market stays closed (fail-closed).
- `MARKET_MODE=open` (local default) pushes `[now, now+8h]` and re-pushes it 1h before expiry.
- With legacy `setSchedule` oracles, it sets mode and minutes.

## Strategies (STRATEGIES.md)
Definitions live in `strategies/<id>/<version>/{prompt.md,schema.json}` plus `catalog.json`. `strategyHash = keccak256(prompt || canonicalJSON(schema) || version)` and is pinned in `strategies.lock.json`. Run `npm run strategies:lock` after a reviewed change. If a file doesn't match its pinned hash, the server refuses to sign. The demo runs Steady Stacker and Dip Hunter; Momentum Rider, AI Thematic and Monday Open Planner are listed as coming soon. There is one active strategy per vault.

**The agent can't activate (review S-3).** MCP `choose_strategy` creates a *pending* proposal. Only the owner token can confirm it, which records the strategyHash, and the keeper runs only owner-confirmed active activations. MCP has no resume, confirm or activate tools. Revoking the agent key pauses every strategy. Dip Hunter take-profits are split into slices of $98 or less, and `usdPerRung` must be $98 or less (S-7).

| REST | MCP | Returns |
|---|---|---|
| `GET /api/strategies` | `list_strategies` | `[{id, version, strategyHash, name, summary, runsIn, paramsSchema, defaults, risks[], demoAvailable, comingSoon}]` |
| `GET /api/strategies/:id/:version` | `get_strategy` | above + `{promptName, prompt, changelog}` |
| `POST /api/strategies/preview` `{id, version?, params}` | `preview_strategy` | `{valid, errors[], strategyHash, params, plannedIntents[{type,tokenIn,tokenOut,amountUsd,trigger,startTime}], worstCaseUsdPer24h, capHeadroom}` |
| `POST /api/strategies/propose` `{id, version?, params, confirmHash}` | `choose_strategy` | `{activationId, strategyHash, intents:[], status:"pending", requiresOwnerConfirmation:true}` |
| `POST /api/strategies/proposals/:id/confirm` `{confirmHash, replace?}` (owner) | — | status object (below) |
| `POST /api/strategies/activate` `{id, version?, params, confirmHash, replace?}` (owner: propose + confirm) | — | status object |
| `GET /api/strategies/status`, `GET /api/strategies/activations[/:id]` | `get_strategy_status` | `{activationId, strategyId, version, status: pending\|active\|paused\|stopped\|completed\|rejected, strategyHash, params, proposedBy, confirmedBy, confirmedAt, intents[{intentId, role: dca\|rung\|take-profit, rung, status, nextRunAt, execs, limitPrice, lastError}], fills[], spent24h, remaining24h}` |
| `POST /api/strategies/activations/:id/pause` / `stop` | `pause_strategy` / `stop_strategy` | `{activationId, status, cancelled:[nonce]}` |
| `POST /api/strategies/activations/:id/resume` (owner) | — | `{activationId, status:"active", intents}` |

## Contracts at 6be1c43 (docs/SERVER_MIGRATION.md)
- Quotes come from the oracle-anchored `StockClawPool.quote()` on the post-fee amount, which equals the `swap()` fill. The e2e checks quote == fill.
- The $500/24h cap is per vault (`vaultSpentLast24h`, shared by all agent keys). `spentToday` and the headroom use it. `VaultDailyCapExceeded` shows as "Blocked by limit: vault's $500 rolling-24h cap shared by all agent keys". The legacy per-key re-issue block has been removed.
- The keeper backs off for 1h after a cap block (S-8). `NotYet`, `LimitNotMet`, `MarketClosed` and `StalePrice` are treated as benign.
- After deploy the market is closed: `npm start` pushes a session at startup, and the keeper re-pushes before expiry.
- **Simulated Safe (local only):** after seeding, the treasury key (anvil #2, standing in for the 2-of-3 Safe) calls `acceptOwnership()` on the router, oracle, pools and feeds, and the deployer renounces registry admin. On testnet the real Safe does this through the Safe tx builder. Owner actions such as `setFeeBps` and `setMarketMode` then need the Safe.

## Demo auth and ops (review-3)
- **R3-1:** the server refuses to start unless `OWNER_API_TOKEN` and `MCP_API_TOKEN` are both set, on every chain. The only escape is `ALLOW_OPEN_LOCAL=1`, which works on a local chain only and logs a loud warning. `npm run demo:env` writes strong random tokens to `server/.env.demo` (gitignored, chmod 600), and the server loads that file at startup.
- **Presenter:** the owner token is in `server/.env.demo` (`OWNER_API_TOKEN=`) and is never served. api.js reads `sessionStorage["stockclaw-owner-token"]` (the same key as app.js). If the token is missing it awaits `window.__requestOwnerToken()` (the app's masked prompt), and otherwise fails with "owner token required". It sends `Authorization: Bearer` + `X-Owner-Token`, and clears the stored token after a 401/403 on an owner call. `/api/health` has its own per-IP bucket of 60/min (`RATE_LIMIT_HEALTH_PER_MIN`).
- **B8/SC-2 rate limits:** applied before auth, per client IP: a global limit of 600/min across REST+MCP (`RATE_LIMIT_IP_PER_MIN`), plus REST 300/min and MCP 120/min. After token validation, valid tokens also get per-role buckets, so fake tokens never create new buckets. Entries are evicted by TTL (2 min) with a max-size cap. Over the limit returns 429 with Retry-After. SC-1: an RPC counts as local only if `new URL()` gives hostname 127.0.0.1, localhost or ::1 with no userinfo.
- **B12 alerts:** `GET /api/health` returns `{ok, status: ok|degraded|critical, alerts[{code, severity, message}], market, keeper}`. The codes are KEEPER_FAILING, KEEPER_STALLED, ORACLE_STALE (warn after 300s, critical after 3600s), SESSION_CLOSED, CAP_BLOCK_SPIKE (5 or more per hour) and CHAIN_UNREACHABLE. Alerts are logged as `[ALERT]` when they fire and `[ALERT-CLEARED]` when they clear.
- **Testnet dry run:** `npm run testnet:dryrun` simulates `script/Deploy.s.sol` (HEAD) against a fork of live 46630 (`MOCK_TOKENS=0`, placeholder role addresses). It never broadcasts and refuses `--broadcast` and key flags. Last run: SIMULATION COMPLETE, about 18.0M gas (~0.00036 ETH). A real deploy needs a funded KMS deployer, the real Safe/keeper/updater/attester addresses, and Julius's sign-off.
- **Accepted demo risks:** B5 keys are env vars (anvil keys locally; no KMS). B6 MCP auth is a static bearer token, not OAuth 2.1. Both are disclosed on stage and must be fixed before any non-demo use.

## Reliability, baskets, approvals, guardrails (Friday backend)
- **State:** SQLite (`data/stockclaw.db`, WAL, better-sqlite3). An existing `data/state.json` is imported once and renamed `state.json.migrated`. Tables: accounts, intents, activations, history, basket_proposals (previews), basket_executions, legs, idempotency, jobs, tx_log, nonces, approvals, passkeys, activity, key_trades, key_breaker.
- **Jobs:** durable `jobs` table polled by a worker (keeper ticks, basket executions, leg retries). **Nonces:** one counter per signer, seeded from `pending`, incremented inside the signer's serial queue, persisted, resynced on "nonce too low". Every tx is in `tx_log`. **Restart:** `jobs.recover()` at boot reconciles `submitted` txs by receipt and requeues jobs a dead process left running; a basket leg with a tx hash is settled from its receipt, never resent.
- **Logs:** one JSON object per line (`ts, level, msg, requestId, idempotencyKey, executionId, legId, txHash, ...`); keys/tokens/signatures are redacted. `LOG_LEVEL=silent|debug`. **Health:** `/api/health` (rpc, db, queue, signers + balances + nonces, tx stats, alerts) and `/healthz` (503 on any critical alert, e.g. anvil down).
- **Baskets:** `GET /api/baskets`, `GET /api/baskets/:id`, `POST /api/baskets/preview {id, usd, allowScaleDown?}`, `POST /api/baskets/buy {previewId | id, usd}` (+ `Idempotency-Key`), `GET /api/baskets/executions[/:id]`, `POST /api/baskets/executions/:id/legs/:legId/retry` (owner, failed legs only, idempotent). Within limits a buy runs right away. Only `ai-tech-mini` (AMZN/AMD/PLTR, equal weight: with 3 names the 25% cap binds at 1/3) is executable locally.
- **Sell approvals (R4-1):** an agent sell that `exitRemaining().totalUsd` doesn't cover is held (no tx) as a pending approval (1h). `GET /api/approvals?status=`, `POST /api/approvals/:id/approve {webauthnAssertion}`, `POST /api/approvals/:id/reject`, `POST /api/passkey/register/options|verify` (UV required; a second passkey needs a step-up assertion). On approve the server re-quotes (> 3% move fails), signs a per-sell `SellApproval` (est. USD x 1.02, expiry 1h) and the keeper relays it with `approveSellWithSig` before the sell.
- **PRODUCTION signing:** responses carry `ownerSignatureSimulated: true` because the demo owner key is held by the server. In production the `SellApproval` must be signed by the user's own wallet (or an EIP-1271 smart-account signature) on their device; there must be **no operator signing path**.
- **Guardrails:** `GET /api/activity?since=&limit=` and SSE `GET /api/activity/stream` (owner token), each trade entry has a `revoke_key` action; anomaly breaker per key (80%-of-cap-within-1h pauses only when the usage comes from >= 2 executions; one execution reaching 80% raises a KEY_SINGLE_EXECUTION_80PCT alert in the feed and /healthz without pausing; each basket = one trade toward > 5 trades/10 min; `GET /api/keys/breaker`, `POST /api/keys/:keyId/resume`; `BREAKER=off` disables); MCP trade tools limited to 10 calls/min per agent key (`MCP_TRADE_PER_MIN`).


### Dashboard integration notes (Flavius)
- Writes accept an `Idempotency-Key` header (fallback: `body.idempotencyKey`).
- `api.js`: `getActivity(since)`, `getBreaker()`, `resumeKey(id)`, `openActivityStream(onEvent, since?) -> {close()}`. `since` is an activity id cursor. The stream sends `: ok` right away.
- Only a 401 clears the stored owner token. A 403 keeps it, and step-up 403s expose `err.stepUpChallenge`.
- Approvals include `reasonCode` (`SELL_CAP_EXCEEDED`), `reasonText` and `agentName` (the key's `label`, set through `create_session_key({label})`).
- On the local chain, `explorerUrl` is `null`, so the UI shows the hash as plain text.
- Dev fixture: `npm run seed:approval [TICKER] [USD]` calls `POST /api/dev/seed-approval` (owner only, refused unless the chain is anvil).

### Async trade writes, retries, MCP errors
- `POST /api/execute_swap`, `/create_dca` and `/create_limit_order` return **202** `{jobId, kind:"trade.<fn>", status:"queued"|"running", statusUrl, createdAt, updatedAt}`. They never wait on the chain. `Idempotency-Key` dedupes to the same job.
- Outcome: `GET /api/jobs/:id?wait=<ms≤30000>` returns `{status:"done", result}` or `{status:"failed", error:{code,message,retryable,hint?,error,status}}`, and the activity stream sends an SSE `event: job` (`kind:"job"`, `jobKind`). In `api.js`, the existing functions wait for the job, so their return shapes don't change. `openActivityStream(onEvent, {onJob})` receives the job events.
- MCP trade tools run the same job and wait up to `MCP_WAIT_MS` (25s). If it is still running, they return `{status, jobId}` and the agent calls `get_job`. MCP errors are `{error, code, message, retryable, hint?}` (as JSON text and as `structuredContent`).
- Basket leg retry never sends twice: the leg's tx hash and nonce are tracked. If the old tx is still pending, it is sped up at the **same nonce**. If it was dropped, it is re-sent at the same nonce unless that nonce was already used. A timed-out run can't send any more.
