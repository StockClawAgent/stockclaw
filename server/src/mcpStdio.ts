import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { assertChain } from "./chain.js";
import { buildMcpServer } from "./mcp.js";
await assertChain();
await buildMcpServer().connect(new StdioServerTransport());
console.error("StockClaw MCP (stdio) ready. Note: run `npm start` alongside so the keeper executes DCA/limit orders.");
