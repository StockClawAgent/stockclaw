// MCP server (official TypeScript SDK) exposing ARCHITECTURE.md §7 tools. Transports: Streamable HTTP (/mcp) and stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as svc from "./service.js";
import * as strat from "./strategies.js";
import * as bk from "./baskets.js";
import "./approvals.js";
import "./breaker.js";
import { Limiter } from "./limiter.js";
import { toUserError } from "./errors.js";
import * as trades from "./trades.js";
// Gaius guardrail 3: per-agent-key limit on trading tools (on top of the per-IP/per-token REST+MCP limits).
const TRADE_TOOLS = new Set(["execute_swap", "create_dca", "create_limit_order", "cancel_order", "buy_basket"]);
const tradeLimiter = new Limiter(Number(process.env.MCP_TRADE_PER_MIN ?? 10));
export const _resetTradeLimiter = () => tradeLimiter.clear();


const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: (Array.isArray(data) ? { items: data } : data) as Record<string, unknown> });
const wrap = <A>(fn: (a: A) => Promise<unknown> | unknown) => async (a: A) => {
  svc.countCall();
  try { return ok(await fn(a)); }
  catch (e) { return err((e as Error).message, (e as any).status ?? 500, (e as any).extra); }
};
/** MCP tool errors carry the same vocabulary as REST: {code, message, retryable, hint?} + `error` (detail). */
const err = (detail: string, status = 500, extra?: Record<string, unknown>) => {
  const body = { error: detail, ...toUserError(detail, status), ...(extra ?? {}) };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: body as Record<string, unknown> };
};
/** Trade writes run as jobs (same path as REST 202); the tool waits up to MCP_WAIT_MS so agents get a plain result. */
const viaJob = (fn: trades.TradeFn) => async (args: unknown) => {
  const v = await trades.submitAndWait(fn, args);
  if (v.status === "done") return v.result;
  if (v.status === "failed") throw Object.assign(new Error(v.error!.error), { status: v.error!.status });
  return { status: v.status, jobId: v.jobId, message: `Still running after ${Math.round(Number(process.env.MCP_WAIT_MS ?? 25000) / 1000)}s. Call get_job with this jobId for the result.` };
};
const RO = { readOnlyHint: true, openWorldHint: false };
const W = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
const sym = z.string().describe("Token symbol: mUSDG, TSLA, AMZN, PLTR, NFLX, AMD");

export function buildMcpServer() {
  const s = new McpServer({ name: "stockclaw", version: "0.1.0-testnet" }, { instructions: "StockClaw (TESTNET 46630, mock tokens). Trades run from the user's AgentVault under onchain caps ($100/trade, $500 rolling 24h, allowlist). Over-limit trades are hard-blocked. Not available to US persons or blocked regions." });
  const reg = s.registerTool.bind(s) as any;
  (s as any).registerTool = (name: string, cfg: any, handler: any) => reg(name, cfg, TRADE_TOOLS.has(name) ? async (a: any) => { const key = svc._agent()?.id ?? "no-key", w = tradeLimiter.hit(key); if (w) return err(`Rate limit: ${tradeLimiter.perMin} trade calls/min per agent key (${key}); retry in ${w}s`, 429, { retryAfterSec: w }); return handler(a); } : handler);
  // S-5: read-only; the agent cannot declare the user's country.
  s.registerTool("check_eligibility", { description: "Eligibility status of the connected account (blocked: US, CA, GB, CH, AE, sanctioned).", annotations: RO }, wrap(() => svc.check_eligibility()));
  s.registerTool("get_wallet", { description: "Smart wallet (AgentVault) address, chain and agent session-key caps / spend in the rolling 24h.", annotations: RO }, wrap(() => svc.get_wallet()));
  s.registerTool("get_balances", { description: "Token balances of the smart wallet.", inputSchema: { tokens: z.array(sym).optional() }, annotations: RO }, wrap((a: { tokens?: string[] }) => svc.get_balances(a.tokens)));
  s.registerTool("list_assets", { description: "Supported assets with oracle prices.", annotations: RO }, wrap(() => svc.list_assets()));
  s.registerTool("get_price", { description: "Oracle price of a token in USD.", inputSchema: { symbol: sym }, annotations: RO }, wrap((a: { symbol: string }) => svc.get_price(a.symbol)));
  s.registerTool("quote_swap", { description: "Quote a swap (0.30% fee on input).", inputSchema: { tokenIn: sym, tokenOut: sym, amountIn: z.number().positive(), slippageBps: z.number().int().min(0).max(300).optional() }, annotations: RO }, wrap((a: any) => svc.quote_swap(a.tokenIn, a.tokenOut, a.amountIn, a.slippageBps)));
  s.registerTool("execute_swap", { description: "Execute a swap by quoteId, or by tokenIn/tokenOut/amountIn[/minOut]. Subject to onchain agent caps.", inputSchema: { quoteId: z.string().optional(), tokenIn: sym.optional(), tokenOut: sym.optional(), amountIn: z.number().positive().optional(), minOut: z.number().nonnegative().optional() }, annotations: W },
    wrap((a: any) => viaJob("execute_swap")(a.quoteId ? { quoteId: a.quoteId } : { tokenIn: a.tokenIn, tokenOut: a.tokenOut, amountIn: a.amountIn, minOut: a.minOut })));
  s.registerTool("get_job", { description: "Status/result of a queued trade job (from a trade tool that was still running). Optionally waits up to waitSec (max 30).", inputSchema: { jobId: z.number().int().positive(), waitSec: z.number().min(0).max(30).optional() }, annotations: RO },
    wrap(async (a: { jobId: number; waitSec?: number }) => { const v = await trades.waitView(a.jobId, (a.waitSec ?? 0) * 1000); if (!v) throw new svc.ApiError(404, "Unknown job"); return v; }));
  s.registerTool("create_dca", { description: "Create a signed DCA intent executed by the keeper. No catch-up for missed runs.", inputSchema: { tokenIn: sym, tokenOut: sym, amountPerExec: z.number().positive(), interval: z.union([z.enum(["hourly", "daily", "weekly"]), z.number().int().min(60)]), maxExecs: z.number().int().min(1).max(365), slippageBps: z.number().int().min(0).max(300).optional() }, annotations: W }, wrap(viaJob("create_dca")));
  s.registerTool("create_limit_order", { description: "Create a limit order. Buy (tokenIn=mUSDG) fires when price <= limitPrice; sell fires when price >= limitPrice.", inputSchema: { tokenIn: sym, tokenOut: sym, amountIn: z.number().positive(), limitPrice: z.number().positive(), expiry: z.string().optional().describe("ISO time; default 7 days") }, annotations: W }, wrap(viaJob("create_limit_order")));
  s.registerTool("list_orders", { description: "List DCA and limit orders.", inputSchema: { status: z.string().optional() }, annotations: RO }, wrap((a: { status?: string }) => svc.list_orders(a.status)));
  s.registerTool("cancel_order", { description: "Cancel an order onchain (cancels its nonce).", inputSchema: { intentId: z.string() }, annotations: W }, wrap((a: { intentId: string }) => svc.cancel_order(a.intentId, "agent")));
  s.registerTool("get_history", { description: "Trade history incl. blocked attempts.", inputSchema: { limit: z.number().int().min(1).max(500).optional() }, annotations: RO }, wrap((a: { limit?: number }) => svc.get_history(a.limit)));
  s.registerTool("faucet_testnet", { description: "Fund the smart wallet with testnet mUSDG (1,000 / 24h) and mock stocks. Testnet only.", annotations: { ...W, destructiveHint: false } }, wrap(() => svc.faucet_testnet()));
  s.registerTool("get_usage", { description: "API usage for today (tiers are placeholders).", annotations: RO }, wrap(() => svc.get_usage()));
  // ---- strategies (STRATEGIES.md §4). The agent can propose, pause and stop; it can NOT activate, switch or resume (S-3).
  const sid = z.enum(["steady-stacker", "dip-hunter", "momentum-rider", "ai-thematic", "monday-planner"]);
  s.registerTool("list_strategies", { description: "Strategy templates (versioned, hashed). Not investment advice.", annotations: RO }, wrap(() => strat.list_strategies()));
  s.registerTool("get_strategy", { description: "Full definition of a strategy: schema, prompt name, changelog.", inputSchema: { id: sid, version: z.string().optional() }, annotations: RO }, wrap((a: any) => strat.get_strategy(a.id, a.version)));
  s.registerTool("preview_strategy", { description: "Validate params and show planned orders and worst-case $/24h vs the cap. No transaction.", inputSchema: { id: sid, version: z.string().optional(), params: z.record(z.string(), z.any()) }, annotations: RO }, wrap((a: any) => strat.preview_strategy(a.id, a.version, a.params)));
  s.registerTool("choose_strategy", { description: "Propose a strategy for the user's vault. Creates a PENDING proposal only; the user must confirm it in the StockClaw dashboard before anything runs. confirmHash = strategyHash from preview_strategy.", inputSchema: { id: sid, version: z.string().optional(), params: z.record(z.string(), z.any()), confirmHash: z.string() }, annotations: { ...W, destructiveHint: false } }, wrap((a: any) => strat.choose_strategy(a.id, a.version, a.params, a.confirmHash, "agent")));
  s.registerTool("get_strategy_status", { description: "Status of the vault's strategy (or a given activation): intents, fills, 24h headroom.", inputSchema: { activationId: z.string().optional() }, annotations: RO }, wrap((a: any) => strat.get_strategy_status(a.activationId)));
  s.registerTool("pause_strategy", { description: "Pause the strategy: cancels its open orders onchain. Resuming needs the user (dashboard).", inputSchema: { activationId: z.string() }, annotations: W }, wrap((a: any) => strat.pause_strategy(a.activationId)));
  s.registerTool("stop_strategy", { description: "Stop the strategy and cancel all its open orders.", inputSchema: { activationId: z.string() }, annotations: W }, wrap((a: any) => strat.stop_strategy(a.activationId)));
  // ---- baskets (BASKETS.md §3): the agent previews and proposes; the owner confirms in the dashboard.
  s.registerTool("list_baskets", { description: "Themed baskets (fixed, published, market-cap weights; editorial groupings, not funds). Only executable ones can be bought on this chain.", annotations: RO }, wrap(() => bk.list_baskets()));
  s.registerTool("get_basket", { description: "Full basket definition: legs, weights, prices, tradability, disclaimer.", inputSchema: { id: z.string(), version: z.string().optional() }, annotations: RO }, wrap((a: any) => bk.get_basket(a.id, a.version)));
  s.registerTool("preview_basket_buy", { description: "Preview a basket buy: legs (<= $98 each), quotes, fees, skipped names, cap headroom, preflight. No transaction. Expires in 60s.", inputSchema: { id: z.string(), usd: z.number().positive(), version: z.string().optional(), allowScaleDown: z.boolean().optional() }, annotations: RO }, wrap((a: any) => bk.preview_basket_buy(a.id, a.usd, { version: a.version, allowScaleDown: a.allowScaleDown })));
  s.registerTool("buy_basket", { description: "Buy a previewed basket. Within the vault's onchain limits it executes right away (legs one by one, no atomicity); the owner sees every leg in the activity feed. Poll get_basket_execution for progress.", inputSchema: { previewId: z.string().optional(), id: z.string().optional(), usd: z.number().positive().optional(), idempotencyKey: z.string().max(128).optional() }, annotations: W }, wrap((a: any) => bk.buy_basket(a, "agent", a.idempotencyKey)));
  s.registerTool("get_basket_execution", { description: "Status of a basket execution (per-leg status, tx hashes, errors).", inputSchema: { executionId: z.string() }, annotations: RO }, wrap((a: any) => bk.get_execution(a.executionId)));
  for (const p of strat.promptsForMcp()) s.registerPrompt(p.name, { title: p.title, description: `${p.title} explainer (StockClaw strategy template)` }, () => ({ messages: [{ role: "user", content: { type: "text", text: p.text } }] }));
  return s;
}
