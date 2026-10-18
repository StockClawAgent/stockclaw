# StockClaw server: REST API, MCP server, keeper, local deploy

**Testnet only (chain id 46630).** Locally this runs on anvil with chain id 46630. Nothing here broadcasts to Robinhood testnet or mainnet. The server refuses chain 4663 and any chain id other than 46630.

## Prerequisites
Node 20+ and Foundry (`forge`, `anvil`).

## Run locally
```bash
cd server && npm install
npm run build                       # forge build into server/artifacts (separate from ../out)
npm run chain                       # terminal 1: anvil --chain-id 46630 on :8545
npm run deploy                      # terminal 2: deploy + seed -> data/local-46630.json
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
| `STOCKCLAW_API_TOKEN` | unset | if set, REST writes and /mcp require `Authorization: Bearer` |
| `PORT`, `DATA_DIR` | 8787, `server/data` | |

## Enforced decisions
- Fee is 0.30% by default and the contract caps it at 0.50% (`FeeRouter.MAX_FEE_BPS`; deploy asserts 30).
- Agent caps are $100 per trade and $500 per rolling 24h (AgentVault). The server refuses higher caps, and every over-limit trade is a hard onchain revert. Trading is allowlist-only, and keys expire after at most 7 days.
- Blocked regions: US and its territories, CA, GB, CH, AE, CU, IR, KP, SY, RU, Crimea, Donetsk and Luhansk. The server checks both the self-declared country and the `CF-IPCountry` header (geo-IP), and returns 451 for blocked regions. The onchain registry is keyed to the owner EOA, and the vault is linked to its owner.
- Pause = `revoke_session_key` (1 tx). It stops the agent's swaps and all intents it has signed. Editing limits revokes the key and issues a new one.
- DCA has no catch-up: the router skips missed slots and the keeper never replays them.

## Demo shortcuts (disclose on stage)
Single demo user. The server holds the owner's key (`DEMO_OWNER_KEY`) as a stand-in for wallet-connect and signs the EIP-712 attestation itself. Agent keys sit in server memory and env (a stand-in for KMS). Prices are a bounded random walk (±3% around base, kept inside the 5% pool band), not a market-data feed. State is a JSON file, not Postgres. There's no OAuth on MCP yet.
