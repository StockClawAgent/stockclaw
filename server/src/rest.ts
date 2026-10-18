import express from "express";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as svc from "./service.js";
import * as strat from "./strategies.js";
import { buildMcpServer } from "./mcp.js";
import { REPO, ownerToken, mcpToken } from "./config.js";

// Auth (review S-1). Roles: "owner" (OWNER_API_TOKEN, dashboard) and "agent" (MCP_API_TOKEN).
// If a token is unset (local demo only; non-local refuses to start), that role is open.
const bearer = (req: express.Request) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
const isOwner = (req: express.Request) => !ownerToken() || bearer(req) === ownerToken();
const isAgent = (req: express.Request) => !mcpToken() || bearer(req) === mcpToken();
const ownerOnly: express.RequestHandler = (req, res, next) => (ownerToken() && bearer(req) !== ownerToken() ? res.status(bearer(req) ? 403 : 401).json({ error: "Owner token required (dashboard action)" }) : next());
const anyRole: express.RequestHandler = (req, res, next) => (isOwner(req) || isAgent(req) ? next() : res.status(401).json({ error: "Missing or bad bearer token" }));
const mcpOnly: express.RequestHandler = (req, res, next) => (mcpToken() && bearer(req) !== mcpToken() ? res.status(401).json({ error: "MCP token required" }) : next());

export function buildApp() {
  const app = express();
  app.use(express.json());
  const geo = (req: express.Request) => (req.headers["cf-ipcountry"] as string | undefined) ?? undefined;
  const h = (fn: (req: express.Request) => unknown) => async (req: express.Request, res: express.Response) => {
    svc.countCall();
    try { res.json(await fn(req)); }
    catch (e) { res.status((e as svc.ApiError).status ?? 500).json({ error: (e as Error).message }); }
  };
  app.use(["/api", "/mcp"], (req, res, next) => { const g = geo(req); if (g && !svc.regionCheck(g).eligible) return res.status(451).json({ error: svc.regionCheck(g).reason }); next(); });
  // who is calling (for proposals): owner token wins
  const role = (req: express.Request) => (ownerToken() ? (bearer(req) === ownerToken() ? "owner" : "agent") : "owner") as "owner" | "agent";

  const r = express.Router();
  // reads + agent-level actions (either token)
  r.get("/check_eligibility", anyRole, h((q) => svc.check_eligibility(isOwner(q) ? (q.query.country as string | undefined) : undefined, geo(q))));
  r.get("/get_wallet", anyRole, h(() => svc.get_wallet()));
  r.get("/get_balances", anyRole, h((q) => svc.get_balances(q.query.tokens ? String(q.query.tokens).split(",") : undefined)));
  r.get("/list_assets", anyRole, h(() => svc.list_assets()));
  r.get("/get_price", anyRole, h((q) => svc.get_price(String(q.query.symbol))));
  r.get("/quote_swap", anyRole, h((q) => svc.quote_swap(String(q.query.tokenIn), String(q.query.tokenOut), Number(q.query.amountIn), q.query.slippageBps ? Number(q.query.slippageBps) : undefined)));
  r.post("/execute_swap", anyRole, h((q) => svc.execute_swap(q.body.quoteId ?? q.body)));
  r.post("/create_dca", anyRole, h((q) => svc.create_dca(q.body)));
  r.post("/create_limit_order", anyRole, h((q) => svc.create_limit_order(q.body)));
  r.get("/list_orders", anyRole, h((q) => svc.list_orders(q.query.status as string | undefined)));
  r.get("/get_history", anyRole, h((q) => svc.get_history(q.query.limit ? Number(q.query.limit) : undefined)));
  r.post("/faucet_testnet", anyRole, h(() => svc.faucet_testnet()));
  r.get("/get_usage", anyRole, h(() => svc.get_usage()));
  r.get("/health", h(async () => ({ ok: true, chainId: 46630, router: svc.dep().router, ownerSimulated: true })));
  // owner-only (dashboard)
  r.post("/submit_attestation", ownerOnly, h((q) => svc.submit_attestation(q.body?.sig, geo(q))));
  r.post("/create_smart_account", ownerOnly, h((q) => svc.create_smart_account(q.body?.owner)));
  r.post("/create_session_key", ownerOnly, h((q) => svc.create_session_key(q.body ?? {})));
  r.post("/revoke_session_key", ownerOnly, h(() => svc.revoke_session_key()));
  r.post("/cancel_order", ownerOnly, h((q) => svc.cancel_order(q.body.intentId, "owner")));
  r.post("/dev/reset", ownerOnly, h(() => svc.dev_reset()));
  r.post("/demo/reset", ownerOnly, h(() => svc.dev_reset()));

  // strategies (STRATEGIES.md §5)
  r.get("/strategies", anyRole, h(() => strat.list_strategies()));
  r.get("/strategies/activations", anyRole, h(() => strat.list_activations()));
  r.get("/strategies/activations/:id", anyRole, h((q) => strat.get_strategy_status(String(q.params.id))));
  r.get("/strategies/status", anyRole, h(() => strat.get_strategy_status()));
  r.get("/strategies/:id/:version", anyRole, h((q) => strat.get_strategy(String(q.params.id), String(q.params.version))));
  r.post("/strategies/preview", anyRole, h((q) => strat.preview_strategy(q.body.id, q.body.version, q.body.params)));
  r.post("/strategies/propose", anyRole, h((q) => strat.choose_strategy(q.body.id, q.body.version, q.body.params, q.body.confirmHash, role(q))));
  // activate = propose + owner confirm in one step (owner only)
  r.post("/strategies/activate", ownerOnly, h(async (q) => { const p = await strat.choose_strategy(q.body.id, q.body.version, q.body.params, q.body.confirmHash, "owner"); return strat.confirm_proposal(p.activationId, q.body.confirmHash, !!q.body.replace); }));
  r.post("/strategies/proposals/:id/confirm", ownerOnly, h((q) => strat.confirm_proposal(String(q.params.id), q.body.confirmHash, !!q.body.replace)));
  r.post("/strategies/proposals/:id/reject", ownerOnly, h((q) => strat.reject_proposal(String(q.params.id))));
  r.post("/strategies/activations/:id/pause", anyRole, h((q) => strat.pause_strategy(String(q.params.id))));
  r.post("/strategies/activations/:id/stop", anyRole, h((q) => strat.stop_strategy(String(q.params.id))));
  r.post("/strategies/activations/:id/resume", ownerOnly, h((q) => strat.resume_strategy(String(q.params.id))));
  app.use("/api", r);

  // MCP Streamable HTTP, stateless; MCP token only. TODO: OAuth 2.1 resource server (PRM, audience check).
  app.post("/mcp", mcpOnly, async (req, res) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all("/mcp", (_req, res) => res.status(405).json({ error: "Method not allowed (stateless Streamable HTTP: POST only)" }));

  app.use("/", express.static(path.join(REPO, "prototype")));
  return app;
}
