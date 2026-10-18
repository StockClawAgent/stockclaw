import express from "express";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as svc from "./service.js";
import { buildMcpServer } from "./mcp.js";
import { API_TOKEN, REPO } from "./config.js";

export function buildApp() {
  const app = express();
  app.use(express.json());
  const auth: express.RequestHandler = (req, res, next) => {
    if (!API_TOKEN || req.headers.authorization === `Bearer ${API_TOKEN}`) return next();
    res.status(401).json({ error: "Missing or bad bearer token" });
  };
  const geo = (req: express.Request) => (req.headers["cf-ipcountry"] as string | undefined) ?? undefined;
  const h = (fn: (req: express.Request) => unknown) => async (req: express.Request, res: express.Response) => {
    svc.countCall();
    try { res.json(await fn(req)); }
    catch (e) { res.status((e as svc.ApiError).status ?? 500).json({ error: (e as Error).message }); }
  };
  // Edge geo block (Cloudflare sets CF-IPCountry in prod): 451 for blocked regions on everything except static UI.
  app.use(["/api", "/mcp"], (req, res, next) => { const g = geo(req); if (g && !svc.regionCheck(g).eligible) return res.status(451).json({ error: svc.regionCheck(g).reason }); next(); });

  const r = express.Router();
  r.get("/check_eligibility", h((q) => svc.check_eligibility(q.query.country as string | undefined, geo(q))));
  r.post("/submit_attestation", auth, h((q) => svc.submit_attestation(q.body?.sig, geo(q))));
  r.get("/get_wallet", h(() => svc.get_wallet()));
  r.post("/create_smart_account", auth, h((q) => svc.create_smart_account(q.body?.owner)));
  r.post("/create_session_key", auth, h((q) => svc.create_session_key(q.body ?? {})));
  r.post("/revoke_session_key", auth, h(() => svc.revoke_session_key()));
  r.get("/get_balances", h((q) => svc.get_balances(q.query.tokens ? String(q.query.tokens).split(",") : undefined)));
  r.get("/list_assets", h(() => svc.list_assets()));
  r.get("/get_price", h((q) => svc.get_price(String(q.query.symbol))));
  r.get("/quote_swap", h((q) => svc.quote_swap(String(q.query.tokenIn), String(q.query.tokenOut), Number(q.query.amountIn), q.query.slippageBps ? Number(q.query.slippageBps) : undefined)));
  r.post("/execute_swap", auth, h((q) => svc.execute_swap(q.body.quoteId ?? q.body)));
  r.post("/create_dca", auth, h((q) => svc.create_dca(q.body)));
  r.post("/create_limit_order", auth, h((q) => svc.create_limit_order(q.body)));
  r.get("/list_orders", h((q) => svc.list_orders(q.query.status as string | undefined)));
  r.post("/cancel_order", auth, h((q) => svc.cancel_order(q.body.intentId)));
  r.get("/get_history", h((q) => svc.get_history(q.query.limit ? Number(q.query.limit) : undefined)));
  r.post("/faucet_testnet", auth, h(() => svc.faucet_testnet()));
  r.get("/get_usage", h(() => svc.get_usage()));
  r.get("/health", h(async () => ({ ok: true, chainId: 46630, router: svc.dep().router })));
  app.use("/api", r);

  // MCP Streamable HTTP, stateless (new server+transport per request). TODO: OAuth 2.1 resource server (PRM, audience check).
  app.post("/mcp", auth, async (req, res) => {
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
