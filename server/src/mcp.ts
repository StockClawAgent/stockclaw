// MCP server (official TypeScript SDK) exposing ARCHITECTURE.md §7 tools. Transports: Streamable HTTP (/mcp) and stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as svc from "./service.js";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: (Array.isArray(data) ? { items: data } : data) as Record<string, unknown> });
const wrap = <A>(fn: (a: A) => Promise<unknown> | unknown) => async (a: A) => {
  svc.countCall();
  try { return ok(await fn(a)); }
  catch (e) { return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] }; }
};
const RO = { readOnlyHint: true, openWorldHint: false };
const W = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
const sym = z.string().describe("Token symbol: mUSDG, TSLA, AMZN, PLTR, NFLX, AMD");

export function buildMcpServer() {
  const s = new McpServer({ name: "stockclaw", version: "0.1.0-testnet" }, { instructions: "StockClaw (TESTNET 46630, mock tokens). Trades run from the user's AgentVault under onchain caps ($100/trade, $500 rolling 24h, allowlist). Over-limit trades are hard-blocked. Not available to US persons or blocked regions." });
  s.registerTool("check_eligibility", { description: "Eligibility status of the connected account (blocked: US, CA, GB, CH, AE, sanctioned).", inputSchema: { country: z.string().length(2).optional().describe("ISO country code, optional") }, annotations: RO }, wrap((a: { country?: string }) => svc.check_eligibility(a.country)));
  s.registerTool("get_wallet", { description: "Smart wallet (AgentVault) address, chain and agent session-key caps / spend in the rolling 24h.", annotations: RO }, wrap(() => svc.get_wallet()));
  s.registerTool("get_balances", { description: "Token balances of the smart wallet.", inputSchema: { tokens: z.array(sym).optional() }, annotations: RO }, wrap((a: { tokens?: string[] }) => svc.get_balances(a.tokens)));
  s.registerTool("list_assets", { description: "Supported assets with oracle prices.", annotations: RO }, wrap(() => svc.list_assets()));
  s.registerTool("get_price", { description: "Oracle price of a token in USD.", inputSchema: { symbol: sym }, annotations: RO }, wrap((a: { symbol: string }) => svc.get_price(a.symbol)));
  s.registerTool("quote_swap", { description: "Quote a swap (0.30% fee on input).", inputSchema: { tokenIn: sym, tokenOut: sym, amountIn: z.number().positive(), slippageBps: z.number().int().min(0).max(300).optional() }, annotations: RO }, wrap((a: any) => svc.quote_swap(a.tokenIn, a.tokenOut, a.amountIn, a.slippageBps)));
  s.registerTool("execute_swap", { description: "Execute a swap by quoteId, or by tokenIn/tokenOut/amountIn[/minOut]. Subject to onchain agent caps.", inputSchema: { quoteId: z.string().optional(), tokenIn: sym.optional(), tokenOut: sym.optional(), amountIn: z.number().positive().optional(), minOut: z.number().nonnegative().optional() }, annotations: W },
    wrap((a: any) => a.quoteId ? svc.execute_swap(a.quoteId) : svc.execute_swap({ tokenIn: a.tokenIn, tokenOut: a.tokenOut, amountIn: a.amountIn, minOut: a.minOut })));
  s.registerTool("create_dca", { description: "Create a signed DCA intent executed by the keeper. No catch-up for missed runs.", inputSchema: { tokenIn: sym, tokenOut: sym, amountPerExec: z.number().positive(), interval: z.union([z.enum(["hourly", "daily", "weekly"]), z.number().int().min(60)]), maxExecs: z.number().int().min(1).max(365), slippageBps: z.number().int().min(0).max(300).optional() }, annotations: W }, wrap((a: any) => svc.create_dca(a)));
  s.registerTool("create_limit_order", { description: "Create a limit order. Buy (tokenIn=mUSDG) fires when price <= limitPrice; sell fires when price >= limitPrice.", inputSchema: { tokenIn: sym, tokenOut: sym, amountIn: z.number().positive(), limitPrice: z.number().positive(), expiry: z.string().optional().describe("ISO time; default 7 days") }, annotations: W }, wrap((a: any) => svc.create_limit_order(a)));
  s.registerTool("list_orders", { description: "List DCA and limit orders.", inputSchema: { status: z.string().optional() }, annotations: RO }, wrap((a: { status?: string }) => svc.list_orders(a.status)));
  s.registerTool("cancel_order", { description: "Cancel an order onchain (cancels its nonce).", inputSchema: { intentId: z.string() }, annotations: W }, wrap((a: { intentId: string }) => svc.cancel_order(a.intentId)));
  s.registerTool("get_history", { description: "Trade history incl. blocked attempts.", inputSchema: { limit: z.number().int().min(1).max(500).optional() }, annotations: RO }, wrap((a: { limit?: number }) => svc.get_history(a.limit)));
  s.registerTool("faucet_testnet", { description: "Fund the smart wallet with testnet mUSDG (1,000 / 24h) and mock stocks. Testnet only.", annotations: { ...W, destructiveHint: false } }, wrap(() => svc.faucet_testnet()));
  s.registerTool("get_usage", { description: "API usage for today (tiers are placeholders).", annotations: RO }, wrap(() => svc.get_usage()));
  return s;
}
