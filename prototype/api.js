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
  // ---- baskets (agreed shape with Flavius). Mock animates legs over ~10s; ?mockFail=1 fails leg 2 (retry fixes it).
  list_baskets: () => delay(MOCK_BASKETS.list),
  get_basket: (id) => delay(MOCK_BASKETS.list.find((b) => b.id === id) || null),
  preview_basket_buy: (id, usd) => delay(mockPreview(id, usd)),
  buy_basket: (arg) => delay(mockStartExecution(arg)),                         // runs immediately (within limits)
  get_basket_execution: (id) => delay(mockExecution(id), 80),                  // poll every 2s while pending/running
  list_basket_executions: () => delay(Object.keys(MOCK_EXEC).map(mockExecution)),
  retry_basket_leg: (id, legId) => delay(mockRetryLeg(id, legId)),
  // ---- sell approvals (only sells over the $500/24h agent sell cap need the owner). ?mockFail=1 => approve fails (price moved).
  list_approvals: (status) => delay(MOCK_APPROVALS.filter((a) => !status || a.status === status)),
  approve_sell: (id, webauthnAssertion) => delay(mockApprove(id)),
  reject_sell: (id) => delay(mockDecide(id, "rejected")),
  passkey_register_options: () => delay({ challenge: "bW9jay1yZWctY2hhbGxlbmdl", rp: { id: "localhost", name: "StockClaw" }, user: { id: "b3duZXI", name: "stockclaw-owner", displayName: "stockclaw-owner" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { residentKey: "preferred", userVerification: "required" }, attestation: "none" }),
  passkey_register_verify: (response) => delay({ verified: true, credentialId: "mock-cred", rpId: "localhost" }),
  // ---- activity feed (every auto-executed trade + breaker alerts), each with a revoke-key action
  get_activity: (since) => delay(MOCK_ACTIVITY.filter((a) => !since || a.ts > since)),
  resume_key: (keyId) => delay({ keyId, breaker: { tripped: false } }),
  // get_usage omitted from UI: tiers/subscriptions out of scope.
};
// ---------------------------------------------------------------- basket / approval / activity mocks
const MOCK_FAIL = typeof location !== "undefined" && /[?&]mockFail=1/.test(location.search || "");
const MOCK_BASKETS = { list: [{ id: "ai-tech-mini", version: "1.0.0", basketHash: "sha256:mock", name: "AI & Tech (mini, testnet)", legs: [{ symbol: "AMZN", weightBps: 3334 }, { symbol: "AMD", weightBps: 3333 }, { symbol: "PLTR", weightBps: 3333 }], chainAvailable: true, executable: true, notExecutableReason: null, thin: true },
  { id: "ai", version: "1.0.0", basketHash: "sha256:mock-ai", name: "AI", legs: [{ symbol: "NVDA", weightBps: 2500 }, { symbol: "GOOGL", weightBps: 2123 }, { symbol: "MSFT", weightBps: 2024 }, { symbol: "TSM", weightBps: 1102 }, { symbol: "META", weightBps: 931 }, { symbol: "AVGO", weightBps: 808 }, { symbol: "MU", weightBps: 512 }], chainAvailable: false, executable: false, notExecutableReason: "Not executable locally: mainnet registry tickers have no StockClaw pool on the local/testnet chain.", thin: false }] };
const splitUsd = (usd) => { const n = Math.ceil(usd / 98 - 1e-9); if (n === 1) return [usd]; const rest = +(usd - 98 * (n - 1)).toFixed(2); return rest >= 5 ? [...Array(n - 1).fill(98), rest] : Array(n).fill(+(usd / n).toFixed(2)); };
function mockLegs(id, usd) { const b = MOCK_BASKETS.list.find((x) => x.id === id) || MOCK_BASKETS.list[0]; const out = [];
  for (const l of b.legs) for (const part of splitUsd(+(usd * l.weightBps / 10000).toFixed(2))) out.push({ legId: "leg_mock" + out.length, ticker: l.symbol, weight: l.weightBps / 10000, targetUsd: part }); return { b, legs: out }; }
function mockPreview(id, usd) { const { b, legs } = mockLegs(id, usd); return { previewId: "bp_mock", basketId: b.id, basketVersion: b.version, basketHash: b.basketHash, totalUsd: usd, legs: legs.map((l) => ({ symbol: l.ticker, amountIn: l.targetUsd, quotedOut: 0, minOut: 0, feeUsd: +(l.targetUsd * FEE_BPS / 10000).toFixed(4) })), totalFeeUsd: +(usd * FEE_BPS / 10000).toFixed(4), skipped: [], capHeadroom: { perTrade: 100, remaining24h: 500 }, scaledDown: false, marketOpen: true, oracleFresh: true, preflight: { ok: true, failures: [] }, expiresAt: new Date(Date.now() + 60000).toISOString() }; }
const MOCK_EXEC = {};
function mockStartExecution(arg) { const id = "bx_mock" + Object.keys(MOCK_EXEC).length, usd = +(arg && arg.usd) || 150; const { b, legs } = mockLegs((arg && arg.id) || "ai-tech-mini", usd);
  MOCK_EXEC[id] = { id, basketId: b.id, basketVersion: b.version, basketHash: b.basketHash, totalUsd: usd, start: Date.now(), legs: legs.map((l, i) => ({ ...l, failAt: MOCK_FAIL && i === 1, retryStart: null })) }; return mockExecution(id); }
function mockExecution(id) { const e = MOCK_EXEC[id]; if (!e) throw Object.assign(new Error("Unknown basket execution"), { status: 404 });
  const per = 10000 / e.legs.length, t = Date.now() - e.start; let stopped = false;
  const legs = e.legs.map((l, i) => { let status = "pending";
    if (l.failAt && l.retryStart && t > per * (i + 1)) { stopped = true; } // legs after a failure stay pending (retry reruns only that leg)
    if (l.retryStart) status = Date.now() - l.retryStart > 2000 ? "filled" : "filling";
    else if (!stopped && t > per * (i + 1)) { status = l.failAt ? "failed" : "filled"; if (l.failAt) stopped = true; }
    else if (!stopped && t > per * i) status = "filling";
    return { legId: l.legId, ticker: l.ticker, weight: l.weight, targetUsd: l.targetUsd, filledUsd: status === "filled" ? l.targetUsd : 0, status, ...(status === "filled" || status === "filling" ? { txHash: "0xMOCKLEG" + i } : {}), ...(status === "failed" ? { error: "Slippage / oracle-band protection" } : {}) }; });
  const done = legs.filter((l) => l.status === "filled").length, busy = legs.some((l) => l.status === "filling") || (!stopped && legs.some((l) => l.status === "pending") && !legs.some((l) => l.status === "failed"));
  const status = busy ? (t < 300 ? "pending" : "running") : done === legs.length ? "filled" : done ? "partial" : "failed";
  return { id, basketId: e.basketId, basketVersion: e.basketVersion, basketHash: e.basketHash, totalUsd: e.totalUsd, status, createdAt: new Date(e.start).toISOString(), updatedAt: new Date().toISOString(), legs }; }
function mockRetryLeg(id, legId) { const e = MOCK_EXEC[id], l = e && e.legs.find((x) => x.legId === legId); if (!l) throw Object.assign(new Error("Unknown legId"), { status: 404 });
  const cur = mockExecution(id).legs.find((x) => x.legId === legId); if (cur.status === "filled" || cur.status === "filling") return mockExecution(id);
  if (cur.status !== "failed") throw Object.assign(new Error(`Only failed legs can be retried (leg is ${cur.status})`), { status: 409 });
  l.retryStart = Date.now(); return mockExecution(id); }
const inH = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const MOCK_APPROVALS = [{ id: "apr_mock1", agentKeyId: "sk_mock", agentName: "Agent key sk_mock", ticker: "AMD", amountIn: 0.6, estUsdgOut: 89.73, estUsdgOutMin: 88.83, reason: "Daily agent sell limit reached: $450.00 sold in the last 24h, $50.00 left, this sell is ~$90.00", status: "pending", createdAt: inH(-0.1), expiresAt: inH(0.9), challenge: "YXByX21vY2sxOjB4bW9jaw", ownerSignatureSimulated: true }];
function mockApprove(id) { const a = MOCK_APPROVALS.find((x) => x.id === id); if (!a) throw Object.assign(new Error("Unknown approval"), { status: 404 });
  if (a.status !== "pending") throw Object.assign(new Error(`Approval is ${a.status} (one approval per sell)`), { status: 409 });
  if (MOCK_FAIL) { a.status = "failed"; a.error = "Price moved 3.40% since the request (> 3%); not executed. Ask the agent to sell again."; throw Object.assign(new Error(a.error), { status: 409 }); }
  a.status = "executed"; a.txHash = "0xMOCKSELL"; a.exitApproval = { type: "SellApproval", amountUsd: +(a.estUsdgOut * 1.02).toFixed(2), expiry: inH(1), relayedBy: "keeper" }; return { ...a }; }
function mockDecide(id, status) { const a = MOCK_APPROVALS.find((x) => x.id === id); if (!a) throw Object.assign(new Error("Unknown approval"), { status: 404 }); if (a.status !== "pending") throw Object.assign(new Error(`Approval is ${a.status}`), { status: 409 }); a.status = status; return { ...a }; }
const MOCK_ACTIVITY = [{ id: 2, ts: inH(-0.2), kind: "trade", keyId: "sk_mock", title: "Agent bought $50.00 of AMD", side: "buy", usd: 50, txHash: "0xMOCKTX", actions: [{ type: "revoke_key", label: "Revoke agent key", method: "POST", href: "/api/revoke_session_key" }] },
  { id: 1, ts: inH(-0.5), kind: "trade", keyId: "sk_mock", title: "Agent sold 0.05 TSLA", side: "sell", usd: 12.5, txHash: "0xMOCKTX2", actions: [{ type: "revoke_key", label: "Revoke agent key", method: "POST", href: "/api/revoke_session_key" }] }];
// ---------------------------------------------------------------- live (StockClaw server)
// ---- presenter auth (review-3 R3-1). The owner token is NEVER served by the server. It lives in sessionStorage
// ("stockclaw-owner-token", same key as app.js). If missing we ask the app's masked prompt (window.__requestOwnerToken);
// otherwise the call fails with "owner token required". Sent as Bearer + X-Owner-Token (matches app.js c1715b9).
const OWNER_KEY = "stockclaw-owner-token";
const OWNER_CALLS = new Set(["submit_attestation", "create_smart_account", "create_session_key", "revoke_session_key", "cancel_order", "approvals", "passkey/register/options", "passkey/register/verify", "activity"]);
const ss = () => { try { return typeof sessionStorage !== "undefined" ? sessionStorage : null; } catch { return null; } };
const StockClawAuth = { set: (t) => ss()?.setItem(OWNER_KEY, t), clear: () => ss()?.removeItem(OWNER_KEY), has: () => !!ss()?.getItem(OWNER_KEY) };
async function ownerToken() {
  let t = ss()?.getItem(OWNER_KEY) || "";
  if (!t && typeof window !== "undefined" && typeof window.__requestOwnerToken === "function") {
    t = String((await window.__requestOwnerToken()) || "").trim();
    if (t) StockClawAuth.set(t);
  }
  if (!t) { const e = new Error("owner token required"); e.status = 401; e.code = "OWNER_TOKEN_REQUIRED"; throw e; }
  return t;
}
async function call(method, name, body) {
  let url = `${API_BASE}/api/${name}`;
  const tok = await ownerToken();
  const opt = { method, headers: { "content-type": "application/json", authorization: `Bearer ${tok}`, "x-owner-token": tok } };
  if (method === "GET" && body) { const q = new URLSearchParams(Object.entries(body).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)])); if ([...q].length) url += "?" + q; }
  else if (body) opt.body = JSON.stringify(body);
  let r; try { r = await fetch(url, opt); } catch (e) { throw new Unreachable(String(e)); }
  const data = await r.json().catch(() => ({}));
  if ((r.status === 401 || r.status === 403) && OWNER_CALLS.has(name)) StockClawAuth.clear(); // bad/expired owner token
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
  // baskets / approvals / passkeys / activity (owner token; same call() auth)
  list_baskets: () => call("GET", "baskets"),
  get_basket: (id) => call("GET", `baskets/${encodeURIComponent(id)}`),
  preview_basket_buy: (id, usd, opts = {}) => call("POST", "baskets/preview", { id, usd, ...opts }),
  buy_basket: (arg) => call("POST", "baskets/buy", arg),                      // {previewId} or {id, usd}; returns the execution
  get_basket_execution: (id) => call("GET", `baskets/executions/${encodeURIComponent(id)}`),
  list_basket_executions: () => call("GET", "baskets/executions"),
  retry_basket_leg: (id, legId) => call("POST", `baskets/executions/${encodeURIComponent(id)}/legs/${encodeURIComponent(legId)}/retry`),
  list_approvals: (status) => call("GET", "approvals", { status }),
  approve_sell: (id, webauthnAssertion) => call("POST", `approvals/${encodeURIComponent(id)}/approve`, { webauthnAssertion }),
  reject_sell: (id) => call("POST", `approvals/${encodeURIComponent(id)}/reject`),
  passkey_register_options: (webauthnAssertion) => call("POST", "passkey/register/options", webauthnAssertion ? { webauthnAssertion } : {}),
  passkey_register_verify: (response) => call("POST", "passkey/register/verify", { response }),
  get_activity: (since) => call("GET", "activity", { since }),
  resume_key: (keyId) => call("POST", `keys/${encodeURIComponent(keyId)}/resume`),
  faucet_testnet: () => call("POST", "faucet_testnet"),
};
const api = Object.fromEntries(Object.keys(mockApi).map((name) => [name, async (...args) => {
  if (USE_MOCK || !liveApi[name]) return mockApi[name](...args);
  try { return await liveApi[name](...args); }
  catch (e) { if (e instanceof Unreachable) { console.warn(`[api] server unreachable, using mock for ${name}`); return mockApi[name](...args); } throw e; }
}]));
if (typeof window !== "undefined") Object.assign(window, { api, FEE_BPS, EXPLORER, CHAIN_ID, USE_MOCK, StockClawAuth });
