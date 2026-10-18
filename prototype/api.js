// StockClaw data layer. TESTNET (chain 46630): tokens and prices are mocks.
// Each function is named after an MCP tool / REST endpoint in ARCHITECTURE.md §7.
// Live mode calls the StockClaw server (server/, `npm start`, same origin). Return shapes match the original stubs.
// Mock mode: ?mock=1 or localStorage "stockclaw-use-mock"="1" restores the original mock bodies. If the server is
// unreachable (network error) each call falls back to its mock automatically. HTTP errors (403 blocked, 451) are not masked.
const API_BASE = (typeof window !== "undefined" && window.STOCKCLAW_API) || (typeof location !== "undefined" && location.origin.startsWith("http") ? location.origin : "http://localhost:8787");
const CHAIN_ID = 46630;
const EXPLORER = "https://explorer.testnet.chain.robinhood.com";
const FEE_BPS = 30; // 0.30%, taken from the input token (router default; cap 0.50%)
const USE_MOCK = (() => { try { return (typeof location !== "undefined" && new URLSearchParams(location.search).get("mock") === "1") || (typeof localStorage !== "undefined" && localStorage.getItem("stockclaw-use-mock") === "1"); } catch { return false; } })();
class Unreachable extends Error {}
// ---------------------------------------------------------------- original mocks (unchanged)
const delay = (v) => new Promise((r) => setTimeout(() => r(v), 50));
const MOCK = {
  eligibility: { eligible: true, reason: null, expiresAt: "2026-11-18T00:00:00Z" },
  wallet: { address: "0xABCD000000000000000000000000000000001234", chainId: CHAIN_ID, owner: "0x9F00000000000000000000000000000000000000",
    sessionKey: { status: "active", expiresAt: "2026-10-25T00:00:00Z", perTradeCap: 100, dailyCap: 500, spentToday: 42, allowlist: ["TSLA","AMZN","PLTR","NFLX","AMD"] } },
  balances: [
    { symbol: "mUSDG", address: "0xMOCK…USDG", amount: 1000.0, usdValue: 1000.0 },
    { symbol: "TSLA", address: "0xC9f9…Bd4E", amount: 5, usdValue: 0 },
    { symbol: "AMZN", address: "0x5884…9E02", amount: 5, usdValue: 0 },
  ],
  assets: ["TSLA","AMZN","PLTR","NFLX","AMD"].map((s) => ({ symbol: s, decimals: 18, priceUsd: 0, source: "MockAggregatorV3" })),
  orders: [
    { intentId: "int_mock_1", type: "DCA", tokenIn: "mUSDG", tokenOut: "TSLA", amount: 10, interval: "daily", execs: "1/5", nextRunAt: "2026-10-19T09:00:00Z", status: "active" },
    { intentId: "int_mock_2", type: "Limit", tokenIn: "mUSDG", tokenOut: "AMD", amount: 25, limitPrice: 0, expiry: "2026-10-22T00:00:00Z", status: "open" },
  ],
  history: [
    { txHash: "0xMOCKTX1", type: "swap", in: "10.00 mUSDG", out: "0.0X TSLA", fee: "0.03 mUSDG", ts: "2026-10-18T10:00:00Z", status: "filled" },
    { txHash: null, type: "swap", in: "150.00 mUSDG", out: "—", fee: "—", ts: "2026-10-18T11:00:00Z", status: "blocked", reason: "Over $100 per-trade cap" },
    { txHash: null, type: "swap", in: "20.00 mUSDG", out: "—", fee: "—", ts: "2026-10-18T12:00:00Z", status: "blocked", reason: "Ticker not on allowlist" },
  ],
};
const mockApi = {
  check_eligibility: () => delay(MOCK.eligibility),          // GET /eligibility
  submit_attestation: (sig) => delay({ ok: true }),          // POST /eligibility/attestation (EIP-712 signed)
  get_wallet: () => delay(MOCK.wallet),                       // GET /wallet
  create_smart_account: (owner) => delay({ address: MOCK.wallet.address }),
  create_session_key: (caps) => delay({ ...MOCK.wallet.sessionKey, ...caps }), // issue agent key
  revoke_session_key: () => delay({ txHash: "0xMOCKREVOKE", explorerUrl: EXPLORER + "/tx/0xMOCKREVOKE", status: "confirmed" }),
  get_balances: (tokens) => delay(MOCK.balances),
  list_assets: () => delay(MOCK.assets),
  get_price: (symbol) => delay({ priceUsd: 0, source: "MockAggregatorV3", updatedAt: new Date().toISOString() }),
  quote_swap: (tokenIn, tokenOut, amountIn) => { const feeAmount = amountIn * FEE_BPS / 10000; return delay({ amountIn, feeAmount, netIn: amountIn - feeAmount, amountOut: 0, minOut: 0, route: "StockClawPool", priceImpact: 0, quoteId: "q_mock", expiresAt: null }); },
  execute_swap: (quoteId) => delay({ txHash: "0xMOCKTX", explorerUrl: EXPLORER + "/tx/0xMOCKTX", status: "pending" }),
  create_dca: (p) => delay({ intentId: "int_mock_new", nextRunAt: null }),
  create_limit_order: (p) => delay({ intentId: "int_mock_new" }),
  list_orders: (status) => delay(MOCK.orders),
  cancel_order: (intentId) => delay({ txHash: "0xMOCKCANCEL", status: "pending" }),
  get_history: (limit) => delay(MOCK.history),
  faucet_testnet: () => delay({ ethFaucet: "https://faucet.testnet.chain.robinhood.com", musdgFaucet: "MockUSDG.faucet() [placeholder]" }),
  // get_usage omitted from UI: tiers/subscriptions out of scope.
};
// ---------------------------------------------------------------- live (StockClaw server)
// ---- presenter auth (review-3 R3-1). The owner token is NEVER served by the server: the presenter pastes it
// once per tab; it lives in sessionStorage only. Owner calls also send X-Owner-Token.
const OWNER_KEY = "stockclaw-owner-token";
const OWNER_CALLS = new Set(["submit_attestation", "create_smart_account", "create_session_key", "revoke_session_key", "cancel_order"]);
const ss = () => { try { return typeof sessionStorage !== "undefined" ? sessionStorage : null; } catch { return null; } };
function getOwnerToken(forcePrompt) {
  let t = forcePrompt ? null : (ss()?.getItem(OWNER_KEY) || (typeof window !== "undefined" && window.STOCKCLAW_TOKEN) || null);
  if (!t && typeof window !== "undefined" && typeof window.prompt === "function") {
    t = (window.prompt("Presenter: paste the StockClaw OWNER token (stored in this tab only)") || "").trim() || null;
    if (t) ss()?.setItem(OWNER_KEY, t);
  }
  return t;
}
const StockClawAuth = { set: (t) => ss()?.setItem(OWNER_KEY, t), clear: () => ss()?.removeItem(OWNER_KEY), has: () => !!ss()?.getItem(OWNER_KEY) };
async function call(method, name, body, retried) {
  let url = `${API_BASE}/api/${name}`;
  const opt = { method, headers: { "content-type": "application/json" } };
  const tok = getOwnerToken(retried);
  if (tok) { opt.headers.authorization = `Bearer ${tok}`; if (OWNER_CALLS.has(name)) opt.headers["x-owner-token"] = tok; }
  if (method === "GET" && body) { const q = new URLSearchParams(Object.entries(body).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)])); if ([...q].length) url += "?" + q; }
  else if (body) opt.body = JSON.stringify(body);
  let r; try { r = await fetch(url, opt); } catch (e) { throw new Unreachable(String(e)); }
  const data = await r.json().catch(() => ({}));
  if ((r.status === 401 || r.status === 403) && /token/i.test(data.error || "") && !retried) { StockClawAuth.clear(); return call(method, name, body, true); }
  if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return data;
}
const savedCountry = () => { try { return JSON.parse(localStorage.getItem("stockclaw-proto-v1") || "{}").country; } catch { return undefined; } };
const liveApi = {
  check_eligibility: (country) => call("GET", "check_eligibility", { country: country ?? savedCountry() }), // {eligible, reason, expiresAt}
  submit_attestation: (sig) => call("POST", "submit_attestation", { sig }),                                  // {ok, ...}
  get_wallet: () => call("GET", "get_wallet"),                                                               // {address, chainId, owner, sessionKey}
  create_smart_account: (owner) => call("POST", "create_smart_account", { owner }),                          // {address}
  create_session_key: async (caps) => ({ ...caps, ...(await call("POST", "create_session_key", caps)) }),    // sessionKey + caps
  revoke_session_key: () => call("POST", "revoke_session_key"),                                              // {txHash, explorerUrl, status}
  get_balances: (tokens) => call("GET", "get_balances", { tokens }),
  list_assets: () => call("GET", "list_assets"),
  get_price: (symbol) => call("GET", "get_price", { symbol }),
  quote_swap: (tokenIn, tokenOut, amountIn, slippageBps) => {
    if (!(amountIn > 0)) return Promise.resolve({ amountIn: 0, feeAmount: 0, netIn: 0, amountOut: 0, minOut: 0, route: "StockClawPool", priceImpact: 0, quoteId: null, expiresAt: null });
    return call("GET", "quote_swap", { tokenIn, tokenOut, amountIn, slippageBps });
  },
  execute_swap: (quoteId) => call("POST", "execute_swap", typeof quoteId === "string" ? { quoteId } : quoteId),
  create_dca: (p) => call("POST", "create_dca", p),
  create_limit_order: (p) => call("POST", "create_limit_order", p),
  list_orders: (status) => call("GET", "list_orders", { status }),
  cancel_order: (intentId) => call("POST", "cancel_order", { intentId }),
  get_history: (limit) => call("GET", "get_history", { limit }),
  faucet_testnet: () => call("POST", "faucet_testnet"),
};
const api = Object.fromEntries(Object.keys(mockApi).map((name) => [name, async (...args) => {
  if (USE_MOCK || !liveApi[name]) return mockApi[name](...args);
  try { return await liveApi[name](...args); }
  catch (e) { if (e instanceof Unreachable) { console.warn(`[api] server unreachable, using mock for ${name}`); return mockApi[name](...args); } throw e; }
}]));
if (typeof window !== "undefined") Object.assign(window, { api, FEE_BPS, EXPLORER, CHAIN_ID, USE_MOCK, StockClawAuth });
