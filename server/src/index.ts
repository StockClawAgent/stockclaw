import { assertChain } from "./chain.js";
import { buildApp } from "./rest.js";
import { startKeeper, syncMarketSchedule } from "./keeper.js";
import * as jobs from "./jobs.js";
import "./baskets.js";
import "./approvals.js";
import { log } from "./log.js";
import { PORT, RPC_URL, getMarketMode, assertTokensConfigured, ownerToken } from "./config.js";
await assertChain();
assertTokensConfigured();
import "./breaker.js";
import { assertGuardrails } from "./service.js";
assertGuardrails(); // fail closed (Gaius R6)
// Restart recovery: settle in-flight txs by hash, requeue jobs a dead process left running (baskets resume leg by leg).
await jobs.recover();
buildApp().listen(PORT, () => log.info(`StockClaw API + UI http://localhost:${PORT}  MCP http://localhost:${PORT}/mcp  RPC ${RPC_URL}  market=${getMarketMode()}${ownerToken() ? "" : "  WARNING: no OWNER_API_TOKEN/MCP_API_TOKEN (local demo: open)"}  owner wallet: SIMULATED`, { port: PORT }));
// After deploy the market is CLOSED until a session is pushed: push one at startup (local override: [now, now+8h]).
log.info("startup market", { market: await syncMarketSchedule() });
if (process.env.KEEPER !== "off") startKeeper(); else jobs.startWorker();
