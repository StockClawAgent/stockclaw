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
