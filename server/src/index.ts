import { assertChain } from "./chain.js";
import { buildApp } from "./rest.js";
import { startKeeper, syncMarketSchedule } from "./keeper.js";
import { PORT, RPC_URL, MARKET_MODE, assertTokensConfigured, ownerToken } from "./config.js";
await assertChain();
assertTokensConfigured();
buildApp().listen(PORT, () => console.log(`StockClaw API + UI http://localhost:${PORT}  MCP http://localhost:${PORT}/mcp  RPC ${RPC_URL}  market=${MARKET_MODE}${ownerToken() ? "" : "  WARNING: no OWNER_API_TOKEN/MCP_API_TOKEN (local demo: open)"}  owner wallet: SIMULATED`));
// After deploy the market is CLOSED until a session is pushed: push one at startup (local override: [now, now+8h]).
console.log("[startup] market:", JSON.stringify(await syncMarketSchedule()));
if (process.env.KEEPER !== "off") startKeeper();
