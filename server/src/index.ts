import { assertChain } from "./chain.js";
import { buildApp } from "./rest.js";
import { startKeeper, syncMarketSchedule } from "./keeper.js";
import * as jobs from "./jobs.js";
import "./baskets.js";
import "./approvals.js";
import { log } from "./log.js";
import { PORT, RPC_URL, getMarketMode, assertTokensConfigured, ownerToken, listenHost, trustedProxy } from "./config.js";
await assertChain();
assertTokensConfigured();
import "./breaker.js";
import { assertGuardrails } from "./service.js";
assertGuardrails(); // fail closed (Gaius R6)
// Restart recovery: settle in-flight txs by hash, requeue jobs a dead process left running (baskets resume leg by leg).
await jobs.recover();
// R7-1: keep reconciling single swaps that were sent but not confirmed (by hash, same nonce only)
(await import("./service.js")).resumeSwaps();
const { host: HOST, warning: hostWarning } = listenHost(); // R7-6: 127.0.0.1 unless HOST is set
if (hostWarning) console.warn("\n" + "!".repeat(78) + "\n!! WARNING: " + hostWarning + "\n" + "!".repeat(78) + "\n");
log.info("network", { host: HOST, trustedProxy: trustedProxy() ?? "off (geo header ignored)" });
const app = buildApp();
// default: loopback on IPv4 and (if available) IPv6, so http://localhost:PORT works whichever family "localhost" resolves to
if (!process.env.HOST) app.listen(PORT, "::1").on("error", () => { /* no IPv6 loopback: fine */ });
app.listen(PORT, HOST, () => log.info(`StockClaw API + UI http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}  MCP /mcp  RPC ${RPC_URL}  market=${getMarketMode()}${ownerToken() ? "" : "  WARNING: no OWNER_API_TOKEN/MCP_API_TOKEN (local demo: open)"}  owner wallet: SIMULATED`, { port: PORT }));
// After deploy the market is CLOSED until a session is pushed: push one at startup (local override: [now, now+8h]).
log.info("startup market", { market: await syncMarketSchedule() });
if (process.env.KEEPER !== "off") startKeeper(); else jobs.startWorker();
