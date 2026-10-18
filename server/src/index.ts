import { assertChain } from "./chain.js";
import { buildApp } from "./rest.js";
import { startKeeper } from "./keeper.js";
import { PORT, RPC_URL, MARKET_MODE } from "./config.js";
await assertChain();
buildApp().listen(PORT, () => console.log(`StockClaw API + UI http://localhost:${PORT}  MCP http://localhost:${PORT}/mcp  RPC ${RPC_URL}  market=${MARKET_MODE}`));
if (process.env.KEEPER !== "off") startKeeper();
