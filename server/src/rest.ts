import express from "express";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as svc from "./service.js";
import * as strat from "./strategies.js";
import { buildMcpServer } from "./mcp.js";
import * as mon from "./monitor.js";
import * as bk from "./baskets.js";
import * as apr from "./approvals.js";
import * as act from "./activity.js";
import * as brk from "./breaker.js";
import * as trades from "./trades.js";
import { randomUUID } from "node:crypto";
import { log, withCtx } from "./log.js";
import { REPO, ownerToken, mcpToken } from "./config.js";

// Auth (review S-1). Roles: "owner" (OWNER_API_TOKEN, dashboard) and "agent" (MCP_API_TOKEN).
// If a token is unset (local demo only; non-local refuses to start), that role is open.
// Owner token may arrive as Authorization: Bearer or X-Owner-Token (dashboard owner calls send both).
const bearer = (req: express.Request) => (req.headers["x-owner-token"] as string | undefined) || (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
const isOwner = (req: express.Request) => !ownerToken() || bearer(req) === ownerToken();
const isAgent = (req: express.Request) => !mcpToken() || bearer(req) === mcpToken();
const ownerOnly: express.RequestHandler = (req, res, next) => (ownerToken() && bearer(req) !== ownerToken() ? (bearer(req) && mcpToken() && bearer(req) === mcpToken() ? res.status(403).json({ error: "Owner token required (dashboard action): the agent token cannot do this" }) : res.status(401).json({ error: "Owner token required (dashboard action): missing or bad token" })) : next());
const anyRole: express.RequestHandler = (req, res, next) => (isOwner(req) || isAgent(req) ? next() : res.status(401).json({ error: "Missing or bad bearer token" }));
const mcpOnly: express.RequestHandler = (req, res, next) => (mcpToken() && bearer(req) !== mcpToken() ? res.status(401).json({ error: "MCP token required" }) : next());

import { Limiter } from "./limiter.js";
import { toUserError } from "./errors.js";
import * as lat from "./latency.js";
import * as cfg from "./config.js";
import { requireLocalAnvil } from "./chain.js";
export { Limiter };
const deny = (res: express.Response, wait: number) => { res.setHeader("Retry-After", String(wait)); res.status(429).json({ error: "Rate limit exceeded" }); };
const ipOf = (req: express.Request) => req.ip ?? req.socket.remoteAddress ?? "?";

export function buildApp(opts: { restPerMin?: number; mcpPerMin?: number; ipPerMin?: number; healthPerMin?: number } = {}) {
  const app = express();
  // R7-6: geo + client IP come from proxy headers only behind a configured trusted proxy
  const proxyTrust = cfg.trustedProxy();
  if (proxyTrust != null) app.set("trust proxy", proxyTrust);
  app.use(express.json({ limit: "100kb" }));
  // UX: every error body gets {code, message, retryable, hint?} (central mapping in errors.ts); `error` keeps the detail
  app.use((_req, res, next) => { const j = res.json.bind(res); res.json = (b: any) => j(res.statusCode >= 400 && b && typeof b === "object" && b.error && !b.code ? { ...b, ...toUserError(String(b.error), res.statusCode) } : b); next(); });
  // per-endpoint latency (p50/p95 in /healthz); SSE streams excluded
  app.use((req, res, next) => { const t0 = process.hrtime.bigint(); res.on("finish", () => { if (!/\/stream$/.test(req.path)) lat.record(`${req.method} ${req.baseUrl}${req.route?.path ?? (req.baseUrl ? "" : req.path)}`, Number(process.hrtime.bigint() - t0) / 1e6); }); next(); });
  // structured request logs with a request id (X-Request-Id echoed) and idempotency key; tokens never logged
  app.use((req, res, next) => {
    const requestId = (req.headers["x-request-id"] as string | undefined)?.slice(0, 64) || randomUUID(), t0 = Date.now();
    res.setHeader("X-Request-Id", requestId);
    const idempotencyKey = (req.headers["idempotency-key"] as string | undefined)?.slice(0, 128);
    res.on("finish", () => { if (req.path !== "/api/health" && req.path !== "/healthz") log.info("http", { requestId, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0, ...(idempotencyKey ? { idempotencyKey } : {}) }); });
    withCtx({ requestId, ...(idempotencyKey ? { idempotencyKey } : {}) }, () => next());
  });
  mon && svc.setCapBlockHook(mon.recordCapBlock);
  const restPerMin = opts.restPerMin ?? Number(process.env.RATE_LIMIT_REST_PER_MIN ?? 300);
  const mcpPerMin = opts.mcpPerMin ?? Number(process.env.RATE_LIMIT_MCP_PER_MIN ?? 120);
  // Stage 1 (before auth): per-IP per scope + a global per-IP limit. Fake tokens can't create new buckets.
  const ipGlobal = new Limiter(opts.ipPerMin ?? Number(process.env.RATE_LIMIT_IP_PER_MIN ?? 600));
  const ipRest = new Limiter(restPerMin), ipMcp = new Limiter(mcpPerMin);
  // /api/health: its own generous per-IP bucket (dashboard polling), still limited.
  const ipHealth = new Limiter(opts.healthPerMin ?? Number(process.env.RATE_LIMIT_HEALTH_PER_MIN ?? 60));
  app.use("/api/health", (req, res, next) => { const w = ipHealth.hit(ipOf(req)); return w ? deny(res, w) : next(); });
  app.use(["/api", "/mcp"], (req, res, next) => {
    if (req.baseUrl === "/api" && req.path === "/health") return next();
    const ip = ipOf(req), w = ipGlobal.hit(ip) || (req.baseUrl === "/mcp" ? ipMcp : ipRest).hit(ip);
    return w ? deny(res, w) : next();
  });
  // Stage 2 (after token validation): per-role buckets, keyed only for VALID tokens.
  const tokRest = new Limiter(restPerMin), tokMcp = new Limiter(mcpPerMin);
  app.use(["/api", "/mcp"], (req, res, next) => {
    const t = bearer(req), role = t && t === ownerToken() ? "owner" : t && t === mcpToken() ? "agent" : null;
    if (!role || (req.baseUrl === "/api" && req.path === "/health")) return next(); // invalid/absent token: auth middleware rejects; already IP-limited
    const w = (req.baseUrl === "/mcp" ? tokMcp : tokRest).hit(role);
    return w ? deny(res, w) : next();
  });
  // R7-6: CF-IPCountry is a client-settable header; it's only meaningful when a trusted edge (TRUSTED_PROXY) sets it.
  // Without one it's ignored (the self-declared country + the onchain attestation still apply).
  const geoHeader = (process.env.GEO_HEADER ?? "cf-ipcountry").toLowerCase();
  const geo = (req: express.Request) => (proxyTrust != null ? ((req.headers[geoHeader] as string | undefined) ?? undefined) : undefined);
  const h = (fn: (req: express.Request) => unknown) => async (req: express.Request, res: express.Response) => {
    svc.countCall();
    try { res.json(await fn(req)); }
    catch (e) { res.status((e as svc.ApiError).status ?? 500).json({ error: (e as Error).message, ...((e as any).extra ?? {}) }); }
  };
  // 202 Accepted: the work is queued (basket legs run in the job worker); body = the execution
  const h202 = (fn: (req: express.Request) => unknown) => async (req: express.Request, res: express.Response) => {
    svc.countCall();
    try { const out = await fn(req); res.status(202).json(out); }
    catch (e) { res.status((e as svc.ApiError).status ?? 500).json({ error: (e as Error).message, ...((e as any).extra ?? {}) }); }
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
  // 202 + job (never blocks on chain); outcome via SSE `job` events or GET /api/jobs/:id?wait=ms
  for (const fn of ["execute_swap", "create_dca", "create_limit_order"] as const) r.post(`/${fn}`, anyRole, h202((q) => trades.submit(fn, q.body ?? {}, idem(q))));
  r.get("/jobs/:id", anyRole, h(async (q) => { const v = await trades.waitView(Number(q.params.id), Number(q.query.wait ?? 0)); if (!v) throw new svc.ApiError(404, "Unknown job"); return v; }));
  r.get("/list_orders", anyRole, h((q) => svc.list_orders(q.query.status as string | undefined)));
  r.get("/get_history", anyRole, h((q) => svc.get_history(q.query.limit ? Number(q.query.limit) : undefined)));
  r.post("/faucet", anyRole, h(() => svc.faucet()));
  r.post("/faucet_testnet", anyRole, h(() => svc.faucet())); // alias of /faucet
  r.get("/get_usage", anyRole, h(() => svc.get_usage()));
  r.get("/config", h(() => cfg.publicNetworkConfig())); // public: NETWORK_LABEL / explorer / faucet URLs for the UI
  r.get("/health", h(async () => ({ ...(await mon.health()), chainId: 46630, router: svc.dep().router, ownerSimulated: true, ...cfg.publicNetworkConfig() })));
  // owner-only (dashboard)
  r.post("/submit_attestation", ownerOnly, h((q) => svc.submit_attestation(q.body?.sig, geo(q))));
  r.post("/create_smart_account", ownerOnly, h((q) => svc.create_smart_account(q.body?.owner)));
  r.post("/create_session_key", ownerOnly, h((q) => svc.create_session_key(q.body ?? {})));
  r.post("/revoke_session_key", ownerOnly, h(() => svc.revoke_session_key()));
  r.post("/cancel_order", ownerOnly, h((q) => svc.cancel_order(q.body.intentId, "owner")));
  r.post("/dev/reset", ownerOnly, h(() => svc.dev_reset()));
  r.post("/dev/seed-approval", ownerOnly, h(async (q) => {
    await requireLocalAnvil("dev/seed-approval"); // R7-3: same check as dev/reset, faults and BREAKER=off
    return apr.seedApproval(q.body ?? {});
  }));
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
  // themed baskets (BASKETS.md §3). Within the onchain limits a basket buy runs right away (policy 2026-10-18).
  const idem = (q: express.Request) => (q.headers["idempotency-key"] as string | undefined)?.slice(0, 128) || q.body?.idempotencyKey;
  r.get("/baskets", anyRole, h(() => bk.list_baskets()));
  r.get("/baskets/executions", anyRole, h((q) => bk.list_executions(q.query.limit ? Number(q.query.limit) : undefined)));
  r.get("/baskets/executions/:id", anyRole, h((q) => bk.get_execution(String(q.params.id))));
  r.post("/baskets/executions/:id/legs/:legId/retry", ownerOnly, h202((q) => bk.retry_leg(String(q.params.id), String(q.params.legId))));
  r.post("/baskets/preview", anyRole, h((q) => bk.preview_basket_buy(q.body.id, Number(q.body.usd), { version: q.body.version, allowScaleDown: !!q.body.allowScaleDown, slippageBps: q.body.slippageBps })));
  r.post("/baskets/buy", anyRole, h202((q) => bk.buy_basket(q.body, role(q), idem(q))));
  // per-leg fill events (SSE): snapshot, then leg_pending/leg_filling/leg_filled/leg_failed + execution_status; closes when done
  r.get("/baskets/executions/:id/stream", anyRole, (req, res) => {
    let ex: any; try { ex = bk.get_execution(String(req.params.id)); } catch (e) { return res.status((e as any).status ?? 404).json({ error: (e as Error).message }); }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.flushHeaders(); res.write(": ok\n\n");
    const send = (e: any) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    send({ type: "snapshot", executionId: ex.id, execution: ex });
    const done = (st: string) => ["filled", "partial", "failed"].includes(st);
    if (done(ex.status)) return res.end();
    const off = bk.onExecEvent(ex.id, (e) => { send(e); if (e.type === "execution_status" && done(String(e.status))) { off(); clearInterval(hb); res.end(); } });
    const hb = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => { off(); clearInterval(hb); });
  });
  r.get("/baskets/:id", anyRole, h((q) => bk.get_basket(String(q.params.id), q.query.version as string | undefined)));
  // sell approvals + passkeys (owner only)
  r.get("/approvals", ownerOnly, h((q) => apr.list_approvals(q.query.status as string | undefined)));
  r.get("/approvals/:id/options", ownerOnly, h((q) => apr.approval_options(String(q.params.id))));
  r.post("/approvals/:id/approve", ownerOnly, h((q) => apr.approve(String(q.params.id), q.body?.webauthnAssertion, idem(q))));
  r.post("/approvals/:id/reject", ownerOnly, h((q) => apr.reject(String(q.params.id))));
  // activity feed (owner): polling + SSE; anomaly breaker
  r.get("/swaps", ownerOnly, h((q) => svc.list_swaps(q.query.status ? String(q.query.status) : "pending")));
  r.get("/activity", ownerOnly, h((q) => act.list(q.query.since ? Number(q.query.since) : undefined, q.query.limit ? Number(q.query.limit) : undefined)));
  r.get("/activity/stream", ownerOnly, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.flushHeaders(); res.write(": ok\n\n"); // let the client know the stream is open before any event
    const since = Number(req.query.since ?? req.headers["last-event-id"] ?? 0);
    for (const e of act.list(since, 50).reverse()) res.write(`id: ${e.id}\nevent: activity\ndata: ${JSON.stringify(e)}\n\n`);
    const off = act.subscribe((e) => res.write(`id: ${e.id}\nevent: activity\ndata: ${JSON.stringify(e)}\n\n`));
    const offJobs = act.subscribeJobs((j) => res.write(`event: job\ndata: ${JSON.stringify({ ...(j as any), jobKind: (j as any).kind, kind: "job" })}\n\n`));
    const hb = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => { off(); offJobs(); clearInterval(hb); });
  });
  r.get("/keys/breaker", ownerOnly, h(() => ({ tripped: brk.tripped().map((t) => ({ keyId: t.key_id, reason: t.reason, trippedAt: new Date(t.tripped_at).toISOString() })) })));
  r.post("/keys/:keyId/resume", ownerOnly, h((q) => brk.resume(String(q.params.keyId))));
  r.post("/passkey/register/options", ownerOnly, h((q) => apr.passkey_register_options(q.body?.webauthnAssertion)));
  r.post("/passkey/register/verify", ownerOnly, h((q) => apr.passkey_register_verify(q.body?.response ?? q.body)));
  app.use("/api", r);
  // liveness/readiness for ops: 503 when any critical alert (e.g. anvil down)
  app.get("/healthz", async (_req, res) => { const hh = await mon.health(); res.status(hh.ok ? 200 : 503).json({ ok: hh.ok, status: hh.status, alerts: hh.alerts.map((a) => a.code), rpc: hh.rpc, queue: hh.queue, latencyMs: lat.summary() }); });

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
