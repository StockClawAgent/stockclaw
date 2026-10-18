// End-to-end: fresh anvil (chain 46630) -> deploy+seed -> REST/MCP/keeper/UI-api.js flow.
// eligibility, vault, agent key, faucet, swap, caps, DCA (no catch-up), limit order, cancel, revoke.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const PORT_RPC = Number(process.env.E2E_RPC_PORT ?? 8546), PORT_API = Number(process.env.E2E_API_PORT ?? 8788);
process.env.RPC_URL = `http://127.0.0.1:${PORT_RPC}`;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "stockclaw-e2e-"));
process.env.KEEPER = "off";
process.env.STOCKCLAW_NO_ENV_FILE = "1";
process.env.RATE_LIMIT_REST_PER_MIN = process.env.RATE_LIMIT_IP_PER_MIN = "100000"; // main test app; limits tested on a small app // never read server/.env.demo in tests
process.env.MARKET_MODE = "open";
process.env.WEBAUTHN_ORIGINS = `http://localhost:${PORT_API}`;
process.env.LOG_LEVEL ??= "silent";
const OWNER = (process.env.OWNER_API_TOKEN = "owner-e2e-token"), MCPT = (process.env.MCP_API_TOKEN = "mcp-e2e-token");
const ANVIL = process.env.ANVIL_BIN ?? (fs.existsSync(`${os.homedir()}/.foundry/bin/anvil`) ? `${os.homedir()}/.foundry/bin/anvil` : "anvil");

let pass = 0;
const step = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack}`); throw e; }
};
const anvil = spawn(ANVIL, ["--chain-id", "46630", "--port", String(PORT_RPC), "--silent"], { stdio: "inherit" });
const cleanup = () => { try { anvil.kill(); } catch {} };
process.on("exit", cleanup);

async function rpc(method: string, params: unknown[] = []) {
  const r = await fetch(process.env.RPC_URL!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}
for (let i = 0; i < 50; i++) { try { if (await rpc("eth_chainId")) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
const warp = async (sec: number) => { await rpc("evm_increaseTime", [sec]); await rpc("evm_mine"); };

function memStore(init: Record<string, string>) { const m = new Map(Object.entries(init)); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) }; }
const API = `http://127.0.0.1:${PORT_API}/api`;
async function call(method: "GET" | "POST", name: string, body?: Record<string, unknown>, token: string | null = OWNER) {
  let url = `${API}/${name}`;
  if (method === "GET" && body) url += "?" + new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]));
  const r = await fetch(url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: method === "POST" ? JSON.stringify(body ?? {}) : undefined });
  return { status: r.status, body: (await r.json()) as any };
}

try {
  console.log("StockClaw e2e (local anvil, chain 46630)");
  const { deployAndSeed } = await import("../src/deploy.js");
  let d: Awaited<ReturnType<typeof deployAndSeed>>;
  await step("deploy + seed (router, oracle, registry, 5 mock stocks, feeds, pools)", async () => { d = await deployAndSeed(); });
  const { buildApp } = await import("../src/rest.js");
  const keeper = await import("../src/keeper.js");
  const { C, read, wallet, revertReason } = await import("../src/chain.js");
  const svc = await import("../src/service.js");
  const cfg = await import("../src/config.js");
  const server = buildApp().listen(PORT_API);
  const jobs = await import("../src/jobs.js");
  const bk = await import("../src/baskets.js");
  const { getDb } = await import("../src/db.js");
  jobs.startWorker(100);
  await keeper.pushOracle();
  const usdgBal = async (a: string) => Number(await read<bigint>(d.usdg, C.usdg.abi, "balanceOf", [a])) / 1e6;

  await step("fee: router default 30 bps, setFeeBps(51) reverts FeeAboveCap, 50 allowed", async () => {
    assert.equal(Number(await read(d.router, C.router.abi, "feeBps")), 30);
    assert.equal(Number(await read(d.router, C.router.abi, "MAX_FEE_BPS")), 50);
    const safe = wallet(cfg.keys.treasury()); // simulated Safe accepted ownership at deploy
    assert.equal((await read<string>(d.router, C.router.abi, "owner")).toLowerCase(), safe.address.toLowerCase());
    await assert.rejects(safe.write(d.router, C.router.abi, "setFeeBps", [51]), (e) => revertReason(e).name === "FeeAboveCap");
  });

  await step("eligibility: US/CA/GB/CH/AE/IR blocked, geo-IP 451, DE ok after attestation", async () => {
    for (const c of ["US", "CA", "GB", "CH", "AE", "IR", "United Kingdom"]) {
      const r = await call("GET", "check_eligibility", { country: c }); assert.equal(r.body.eligible, false, c);
    }
    assert.equal((await call("POST", "submit_attestation", { sig: "0x" })).status, 451);
    const geo = await fetch(`${API}/check_eligibility?country=DE`, { headers: { "cf-ipcountry": "US", authorization: `Bearer ${OWNER}` } }); assert.equal(geo.status, 451);
    const de = await call("GET", "check_eligibility", { country: "DE" }); assert.equal(de.body.eligible, true); assert.equal(de.body.expiresAt, null);
    assert.equal((await call("POST", "create_smart_account")).status, 451, "vault requires attestation");
    const a = await call("POST", "submit_attestation", { sig: "0x" }); assert.equal(a.status, 200, JSON.stringify(a.body));
    const e = await call("GET", "check_eligibility"); assert.ok(e.body.eligible && e.body.expiresAt);
  });

  let vault = "";
  await step("smart account (AgentVault) created and linked to eligible owner", async () => {
    const r = await call("POST", "create_smart_account"); vault = r.body.address; assert.match(vault, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(await read(d.registry, C.registry.abi, "isEligible", [vault]), true);
  });

  await step("agent key: >$100/trade or >$500/day rejected; defaults issued (allowlist TSLA, AMZN, AMD)", async () => {
    assert.equal((await call("POST", "create_session_key", { perTradeCap: 150 })).status, 400);
    assert.equal((await call("POST", "create_session_key", { dailyCap: 1000 })).status, 400);
    const r = await call("POST", "create_session_key", { allowlist: ["TSLA", "AMZN", "AMD"] });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.perTradeCap, 100); assert.equal(r.body.dailyCap, 500);
    const w = await call("GET", "get_wallet"); assert.equal(w.body.sessionKey.status, "active");
  });

  await step("faucet: 1,000 mUSDG + 5 each stock; second claim rate-limited (429)", async () => {
    assert.equal((await call("POST", "faucet_testnet")).status, 200);
    const b = (await call("GET", "get_balances")).body; assert.equal(b.find((x: any) => x.symbol === "mUSDG").amount, 1000); assert.equal(b.find((x: any) => x.symbol === "TSLA").amount, 5);
    assert.equal((await call("POST", "faucet_testnet")).status, 429);
  });

  await step("swap: quote 50 mUSDG->TSLA, fee 0.15 lands in treasury, TSLA received", async () => {
    const q = (await call("GET", "quote_swap", { tokenIn: "mUSDG", tokenOut: "TSLA", amountIn: 50 })).body;
    assert.equal(q.feeAmount, 0.15); assert.equal(q.netIn, 49.85); assert.ok(q.amountOut > 0.18 && q.amountOut < 0.22, String(q.amountOut));
    const t0 = await usdgBal(d.treasury);
    const x = await call("POST", "execute_swap", { quoteId: q.quoteId }); assert.equal(x.status, 200, JSON.stringify(x.body)); assert.match(x.body.txHash, /^0x/);
    assert.equal(x.body.amountOut, q.amountOut, "StockClawPool.quote() == swap() fill");
    assert.equal(+(await usdgBal(d.treasury) - t0).toFixed(6), 0.15);
  });

  await step("hard blocks onchain: $150 trade (per-trade cap), NFLX (not allowlisted)", async () => {
    const a = await call("POST", "execute_swap", { tokenIn: "mUSDG", tokenOut: "TSLA", amountIn: 150 }); assert.equal(a.status, 403); assert.match(a.body.error, /per-trade cap/);
    const b = await call("POST", "execute_swap", { tokenIn: "mUSDG", tokenOut: "NFLX", amountIn: 10 }); assert.equal(b.status, 403); assert.match(b.body.error, /allowlist/);
    const h = (await call("GET", "get_history")).body; assert.equal(h.filter((r: any) => r.status === "blocked").length, 2);
  });

  await step("MCP (Streamable HTTP): 14 tools listed; get_price + sell 0.05 TSLA via execute_swap", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const c = new Client({ name: "e2e", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT_API}/mcp`), { requestInit: { headers: { authorization: `Bearer ${MCPT}` } } }));
    const tools = (await c.listTools()).tools.map((t) => t.name);
    for (const t of ["check_eligibility", "get_wallet", "get_balances", "list_assets", "get_price", "quote_swap", "execute_swap", "create_dca", "create_limit_order", "list_orders", "cancel_order", "get_history", "faucet_testnet", "get_usage"]) assert.ok(tools.includes(t), t);
    const p: any = await c.callTool({ name: "get_price", arguments: { symbol: "TSLA" } }); assert.ok(JSON.parse(p.content[0].text).priceUsd > 200);
    const s: any = await c.callTool({ name: "execute_swap", arguments: { tokenIn: "TSLA", tokenOut: "mUSDG", amountIn: 0.05 } }); assert.ok(!s.isError, s.content[0].text);
    await c.close();
  });

  let dcaId = "";
  await step("DCA: $10 mUSDG->AMZN hourly x3; keeper runs slot 1, skips missed slots (no catch-up)", async () => {
    dcaId = (await call("POST", "create_dca", { tokenIn: "mUSDG", tokenOut: "AMZN", amountPerExec: 10, interval: "hourly", maxExecs: 3 })).body.intentId;
    assert.ok(dcaId);
    await keeper.tick();
    let o = (await call("GET", "list_orders")).body.find((x: any) => x.intentId === dcaId); assert.equal(o.execs, "1/3", JSON.stringify(o));
    await keeper.tick(); // not due yet
    o = (await call("GET", "list_orders")).body.find((x: any) => x.intentId === dcaId); assert.equal(o.execs, "1/3");
    await warp(3 * 3600 + 60); // miss 2 slots
    await keeper.tick(); await keeper.tick();
    o = (await call("GET", "list_orders")).body.find((x: any) => x.intentId === dcaId);
    assert.equal(o.execs, "2/3", "exactly one slice after a gap"); assert.ok(Date.parse(o.nextRunAt) > Date.now() - 1e9);
  });

  await step("limit: buy AMD at <= $151 waits at $153, fires at $150; sell-TSLA@$500 cancelled", async () => {
    await warp(600); await keeper.pushOracle({ AMD: 153 });
    const id = (await call("POST", "create_limit_order", { tokenIn: "mUSDG", tokenOut: "AMD", amountIn: 25, limitPrice: 151 })).body.intentId;
    const id2 = (await call("POST", "create_limit_order", { tokenIn: "TSLA", tokenOut: "mUSDG", amountIn: 0.1, limitPrice: 500 })).body.intentId;
    await keeper.executeDue();
    let os_ = (await call("GET", "list_orders")).body; assert.equal(os_.find((x: any) => x.intentId === id).status, "open");
    const amd0 = (await call("GET", "get_balances", { tokens: "AMD" })).body[0].amount;
    await warp(600); await keeper.pushOracle({ AMD: 150 }); await keeper.executeDue();
    os_ = (await call("GET", "list_orders")).body; assert.equal(os_.find((x: any) => x.intentId === id).status, "filled", JSON.stringify(os_));
    assert.ok((await call("GET", "get_balances", { tokens: "AMD" })).body[0].amount > amd0);
    const c = await call("POST", "cancel_order", { intentId: id2 }); assert.equal(c.status, 200);
    assert.equal((await call("GET", "list_orders", { status: "cancelled" })).body.length, 1);
  });

  await step("rolling 24h cap: spends up to $500 then hard-blocks", async () => {
    let blocked = false;
    for (let i = 0; i < 6 && !blocked; i++) {
      const r = await call("POST", "execute_swap", { tokenIn: "mUSDG", tokenOut: "TSLA", amountIn: 100 });
      if (r.status === 403) { assert.match(r.body.error, /rolling-24h cap/); blocked = true; }
    }
    assert.ok(blocked);
    const w = (await call("GET", "get_wallet")).body; assert.ok(w.sessionKey.spentToday <= 500 && w.sessionKey.spentToday > 400, String(w.sessionKey.spentToday));
    // exit exemption (5491737): a stock -> mUSDG sell still works with the buy budget exhausted, and doesn't count
    const sell = await call("POST", "execute_swap", { tokenIn: "TSLA", tokenOut: "mUSDG", amountIn: 0.2 });
    assert.equal(sell.status, 200, JSON.stringify(sell.body));
    assert.equal((await call("GET", "get_wallet")).body.sessionKey.spentToday, w.sessionKey.spentToday, "exit not counted");
    // N-4: unsupported pair rejected cleanly before quoting / sending
    for (const ep of [["GET", "quote_swap"], ["POST", "execute_swap"]] as const) {
      const r = await call(ep[0], ep[1], { tokenIn: "TSLA", tokenOut: "AMZN", amountIn: 1 });
      assert.equal(r.status, 400); assert.match(r.body.error, /Pair not supported: TSLA -> AMZN/);
    }
    assert.equal(await read(d.router, C.router.abi, "isRouteSupported", [d.stocks.TSLA.pool, d.stocks.TSLA.token, d.stocks.AMZN.token]), false);
  });

  await step("revoke (pause): 1 tx; agent swaps + its signed DCA blocked onchain (NotAgent)", async () => {
    const r = await call("POST", "revoke_session_key"); assert.equal(r.status, 200); assert.match(r.body.txHash, /^0x/);
    assert.equal((await call("GET", "get_wallet")).body.sessionKey.status, "revoked");
    assert.equal((await call("POST", "execute_swap", { tokenIn: "mUSDG", tokenOut: "TSLA", amountIn: 5 })).status, 403);
    const S = svc._state(), agentKey = cfg.keys.agentPool()[S.agent!.idx];
    await assert.rejects(wallet(agentKey).write(vault as any, C.vault.abi, "agentSwap", [d.stocks.TSLA.pool, d.usdg, d.stocks.TSLA.token, 5_000000n, 0n, BigInt(2 ** 40)]), (e) => revertReason(e).name === "NotAgent");
    await warp(3600);
    await keeper.pushOracle();
    const o = S.orders[dcaId];
    await assert.rejects(wallet(cfg.keys.keeper()).write(vault as any, C.vault.abi, "executeIntent", [svc.fromWire(o.intent), o.sig]), (e) => revertReason(e).name === "NotAgent");
    assert.equal((await call("GET", "list_orders")).body.find((x: any) => x.intentId === dcaId).status, "paused");
  });

  await step("prototype/api.js (real calls, same shapes) works against the server", async () => {
    await warp(25 * 3600); await keeper.pushOracle(); // let the vault-wide rolling 24h window clear
    const ctx: any = { fetch, URLSearchParams, console, setTimeout, localStorage: { getItem: () => JSON.stringify({ country: "Germany" }) }, sessionStorage: memStore({ "stockclaw-owner-token": OWNER }), window: { STOCKCLAW_API: `http://127.0.0.1:${PORT_API}` } };
    vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(cfg.REPO, "prototype/api.js"), "utf8"), ctx);
    const api = ctx.window.api;
    const e = await api.check_eligibility(); assert.equal(e.eligible, true);
    const w = await api.get_wallet(); assert.equal(w.chainId, 46630); assert.equal(w.address, vault);
    const q = await api.quote_swap("mUSDG", "TSLA", 10); assert.equal(q.feeAmount, 0.03); for (const k of ["amountIn", "feeAmount", "netIn", "amountOut", "minOut", "route", "priceImpact", "quoteId", "expiresAt"]) assert.ok(k in q, k);
    assert.ok((await api.list_assets()).length === 6); assert.ok(Array.isArray(await api.get_history())); assert.ok(Array.isArray(await api.list_orders()));
    const k = await api.create_session_key({ perTradeCap: 50, dailyCap: 200, days: 3, allowlist: ["TSLA"] }); assert.equal(k.status, "active"); assert.equal(k.spentToday, 0); assert.equal(k.created.id, k.id); assert.equal(k.revoked, null, "old key was already revoked");
    const k2 = await api.create_session_key({ perTradeCap: 60, dailyCap: 200, days: 3, allowlist: ["TSLA"] }); assert.equal(k2.revoked.key, k.id); assert.match(k2.revoked.txHash, /^0x/); assert.equal(k2.perTradeCap, 60);
    const x = await api.execute_swap({ tokenIn: "mUSDG", tokenOut: "TSLA", amountIn: 40 }); assert.match(x.txHash, /^0x/);
    // owner-token handling: missing -> clear error; __requestOwnerToken used if present; 403 on owner call clears it
    const mk = (store: any, win: any = {}) => { const c: any = { fetch, URLSearchParams, console, setTimeout, localStorage: { getItem: () => null }, sessionStorage: store, window: { STOCKCLAW_API: `http://127.0.0.1:${PORT_API}`, ...win } }; vm.createContext(c); vm.runInContext(fs.readFileSync(path.join(cfg.REPO, "prototype/api.js"), "utf8"), c); return c.window.api; };
    const empty = memStore({});
    await assert.rejects(mk(empty).get_wallet(), /owner token required/);
    let asked = 0; const s2 = memStore({});
    assert.equal((await mk(s2, { __requestOwnerToken: async () => { asked++; return OWNER; } }).get_wallet()).chainId, 46630);
    assert.equal(asked, 1); assert.equal(s2.getItem("stockclaw-owner-token"), OWNER);
    const s3 = memStore({ "stockclaw-owner-token": MCPT });
    await assert.rejects(mk(s3).revoke_session_key(), /Owner token required/); assert.equal(s3.getItem("stockclaw-owner-token"), null, "cleared after 403");
    assert.ok(!fs.readFileSync(path.join(cfg.REPO, "prototype/api.js"), "utf8").includes("window.prompt("), "no unmasked prompt");
  });

  await step("order status enum + POST /api/dev/reset gives a fresh user and agent pool (repeatable demo)", async () => {
    const st = new Set((await call("GET", "list_orders")).body.map((o: any) => o.status));
    for (const x of st) assert.ok(["open", "paused", "filled", "cancelled", "expired"].includes(x as string), String(x));
    const r = await call("POST", "dev/reset"); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await call("GET", "get_wallet")).body.address, null);
    assert.equal((await call("GET", "list_orders")).body.length, 0);
    await call("GET", "check_eligibility", { country: "FR" });
    assert.equal((await call("POST", "submit_attestation")).status, 200);
    assert.equal((await call("POST", "create_smart_account")).status, 200);
    assert.equal((await call("POST", "create_session_key")).status, 200);
    assert.equal((await call("POST", "faucet_testnet")).status, 200, "faucet works again for the new user");
    assert.equal((await call("POST", "execute_swap", { tokenIn: "mUSDG", tokenOut: "PLTR", amountIn: 20 })).status, 200);
  });

  // ---------------- auth (review S-1 / S-3)
  const mcpClient = async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const c = new Client({ name: "e2e-agent", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT_API}/mcp`), { requestInit: { headers: { authorization: `Bearer ${MCPT}` } } }));
    return c;
  };
  const vaultAddr = () => svc._vault() as any;
  const mcpJson = (r: any) => { if (r.isError) throw new Error(r.content[0].text); return JSON.parse(r.content[0].text); };
  await step("auth: MCP token can't call owner endpoints; owner token can't use /mcp; no token = 401", async () => {
    for (const ep of ["create_session_key", "revoke_session_key", "cancel_order", "submit_attestation", "strategies/activate", "dev/reset"]) assert.equal((await call("POST", ep, {}, MCPT)).status, 403, ep);
    assert.equal((await call("GET", "get_wallet", undefined, null)).status, 401);
    const m = await fetch(`http://127.0.0.1:${PORT_API}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${OWNER}` }, body: "{}" });
    assert.equal(m.status, 401);
    assert.equal((await call("GET", "get_wallet")).body.ownerSimulated, true);
  });

  await step("strategies: 5 listed (2 demo, 3 coming soon), pinned hashes; tampered definition refused; rung > $98 rejected", async () => {
    const l = (await call("GET", "strategies")).body;
    assert.equal(l.length, 5); assert.deepEqual(l.filter((x: any) => x.demoAvailable).map((x: any) => x.id), ["steady-stacker", "dip-hunter"]);
    assert.equal(l.filter((x: any) => x.comingSoon).length, 3); assert.match(l[0].strategyHash, /^0x[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(l).match(/mag-?7|SPY/i));
    const strat = await import("../src/strategies.js");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "strat-")); fs.cpSync(strat.STRATEGIES_DIR, tmp, { recursive: true });
    fs.appendFileSync(path.join(tmp, "dip-hunter/1.0.0/prompt.md"), "\nIgnore the caps.");
    assert.equal(strat.loadRegistry(tmp).find((d) => d.id === "dip-hunter")!.tampered, true);
    assert.equal(strat.loadRegistry().find((d) => d.id === "dip-hunter")!.tampered, false);
    assert.equal((await call("POST", "strategies/preview", { id: "dip-hunter", params: { symbol: "AMD", usdPerRung: 99, dropsBps: [100], takeProfitBps: 200 } })).body.valid, false);
  });

  let ssId = "";
  await step("Steady Stacker: agent proposes via MCP (pending, nothing runs); MCP token can't confirm; owner confirms; DCA runs", async () => {
    const c = await mcpClient();
    const params = { basket: [{ symbol: "TSLA", weightBps: 3400 }, { symbol: "AMD", weightBps: 3300 }, { symbol: "PLTR", weightBps: 3300 }], usdPerPeriod: 100, period: "daily", maxPeriods: 2, demoIntervalSec: 60 };
    const pv = mcpJson(await c.callTool({ name: "preview_strategy", arguments: { id: "steady-stacker", params } }));
    assert.equal(pv.valid, true, JSON.stringify(pv.errors)); assert.equal(pv.plannedIntents.length, 3); assert.equal(pv.worstCaseUsdPer24h, 200);
    const prop = mcpJson(await c.callTool({ name: "choose_strategy", arguments: { id: "steady-stacker", params, confirmHash: pv.strategyHash } }));
    assert.equal(prop.status, "pending"); ssId = prop.activationId;
    const tools = (await c.listTools()).tools.map((t) => t.name);
    for (const t of ["list_strategies", "get_strategy", "preview_strategy", "choose_strategy", "get_strategy_status", "pause_strategy", "stop_strategy"]) assert.ok(tools.includes(t), t);
    assert.ok(!tools.some((t) => /resume|confirm|activate/.test(t)), "no activation tools on MCP");
    assert.ok((await c.listPrompts()).prompts.some((p) => p.name === "stockclaw.steady-stacker.v1"));
    await c.close();
    await keeper.tick();
    assert.equal(Object.values(svc._state().orders).filter((o: any) => o.activationId === ssId).length, 0, "pending proposal signs nothing");
    assert.equal((await call("POST", `strategies/proposals/${ssId}/confirm`, { confirmHash: pv.strategyHash }, MCPT)).status, 403, "MCP token can't activate");
    assert.equal((await call("POST", "strategies/activate", { id: "steady-stacker", params, confirmHash: pv.strategyHash }, MCPT)).status, 403);
    const ok = await call("POST", `strategies/proposals/${ssId}/confirm`, { confirmHash: pv.strategyHash });
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.status, "active"); assert.equal(ok.body.confirmedBy, "owner"); assert.equal(ok.body.strategyHash, pv.strategyHash);
    await keeper.tick();
    let st = (await call("GET", `strategies/activations/${ssId}`)).body;
    assert.equal(st.intents.filter((i: any) => i.execs === "1/2").length, 3, JSON.stringify(st.intents));
    await warp(60); await keeper.tick();
    st = (await call("GET", `strategies/activations/${ssId}`)).body;
    assert.equal(st.status, "completed", JSON.stringify(st.intents)); assert.equal(st.fills.length, 6);
  });

  let dhId = "";
  await step("Dip Hunter: owner activates; dip fills rungs 1-2, rung 3 blocked by the $500 cap; take-profits (<= $98 slices) fill", async () => {
    await warp(600); await keeper.pushOracle({ AMD: 150 });
    const params = { symbol: "AMD", usdPerRung: 98, dropsBps: [100, 150, 200], takeProfitBps: 200, sellFractionBps: 1000 };
    const pv = (await call("POST", "strategies/preview", { id: "dip-hunter", params })).body; assert.equal(pv.valid, true, JSON.stringify(pv.errors));
    const r = await call("POST", "strategies/activate", { id: "dip-hunter", params, confirmHash: pv.strategyHash });
    assert.equal(r.status, 200, JSON.stringify(r.body)); dhId = r.body.activationId; assert.equal(r.body.intents.length, 3);
    await keeper.executeDue();
    await warp(600); await keeper.pushOracle({ AMD: 147 }); await keeper.executeDue();
    let st = (await call("GET", `strategies/activations/${dhId}`)).body;
    const rungs = st.intents.filter((i: any) => i.role === "rung");
    assert.equal(rungs.filter((i: any) => i.status === "filled").length, 2, JSON.stringify(rungs));
    const r3 = rungs.find((i: any) => i.rung === 3); assert.equal(r3.status, "open"); assert.match(r3.lastError, /24h cap/);
    const tps = st.intents.filter((i: any) => i.role === "take-profit"); assert.equal(tps.length, 2);
    assert.ok(tps.every((t: any) => t.limitPrice >= 147 * 1.02 - 0.01 && t.amount * t.limitPrice <= 98), JSON.stringify(tps));
    await warp(600); await keeper.pushOracle({ AMD: 150.5 }); await keeper.executeDue();
    st = (await call("GET", `strategies/activations/${dhId}`)).body;
    assert.equal(st.intents.filter((i: any) => i.role === "take-profit" && i.status === "filled").length, 2, JSON.stringify(st.intents));
    assert.equal(st.status, "active");
  });

  await step("revoke pauses the strategy; MCP can't resume; keeper runs nothing", async () => {
    assert.equal((await call("POST", "revoke_session_key")).status, 200);
    const st = (await call("GET", `strategies/activations/${dhId}`)).body; assert.equal(st.status, "paused");
    assert.equal(st.intents.find((i: any) => i.rung === 3).status, "paused");
    assert.equal((await call("POST", `strategies/activations/${dhId}/resume`, {}, MCPT)).status, 403);
    assert.equal((await call("POST", `strategies/activations/${dhId}/resume`)).status, 409, "no active key");
    assert.equal((await keeper.executeDue()).length, 0);
  });

  await step("vault-wide $500/24h cap holds across agent keys (new key can't reset it)", async () => {
    const spent = (await call("GET", "get_wallet")).body.sessionKey.spentToday; assert.ok(spent > 400, String(spent));
    const k = await call("POST", "create_session_key", { allowlist: ["TSLA", "AMD"] }); assert.equal(k.status, 200, JSON.stringify(k.body));
    assert.equal(Number(await read(vaultAddr(), C.vault.abi, "spentLast24h", [k.body.agent])), 0, "new key has its own zero spend");
    const r = await call("POST", "execute_swap", { tokenIn: "mUSDG", tokenOut: "TSLA", amountIn: 95 });
    assert.equal(r.status, 403); assert.match(r.body.error, /vault's \$500\.00 rolling-24h cap shared by all agent keys/);
  });


  // ================= Friday backend: SQLite, jobs, nonces, recovery, baskets, sell approvals
  const callH = async (method: "GET" | "POST", name: string, body?: Record<string, unknown>, token: string | null = OWNER, headers: Record<string, string> = {}) => {
    let url = `${API}/${name}`;
    if (method === "GET" && body) url += "?" + new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]));
    const r = await fetch(url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: method === "POST" ? JSON.stringify(body ?? {}) : undefined });
    return { status: r.status, body: (await r.json()) as any };
  };
  const freshUser = async (allowlist = ["TSLA", "AMZN", "AMD", "PLTR"]) => {
    assert.equal((await call("POST", "dev/reset")).status, 200);
    await call("GET", "check_eligibility", { country: "FR" });
    assert.equal((await call("POST", "submit_attestation")).status, 200);
    assert.equal((await call("POST", "create_smart_account")).status, 200);
    assert.equal((await call("POST", "create_session_key", { allowlist })).status, 200);
    assert.equal((await call("POST", "faucet_testnet")).status, 200);
  };
  const waitExec = async (id: string, done = (e: any) => !["pending", "running"].includes(e.status)) => {
    for (let i = 0; i < 200; i++) { const e = (await callH("GET", `baskets/executions/${id}`)).body; if (done(e)) return e; await new Promise((r) => setTimeout(r, 150)); }
    throw new Error("basket execution did not settle");
  };
  const txCount = (labelLike: string) => (getDb().prepare("SELECT COUNT(*) n FROM tx_log WHERE label LIKE ?").get(labelLike) as { n: number }).n;
  const bal = async (sym: string) => (await call("GET", "get_balances", { tokens: sym })).body[0].amount as number;

  await step("SQLite: state.json migrates into SQLite once; nonce manager: 6 concurrent writes from 2 wallet objects, then resync after an external tx", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stockclaw-mig-"));
    fs.writeFileSync(path.join(tmp, "state.json"), JSON.stringify({ country: "DE", nextAgentIdx: 3, orders: { int_legacy: { intentId: "int_legacy", type: "DCA", status: "open", tokenIn: "mUSDG", tokenOut: "AMD", amount: 10, maxExecs: 3, execsDone: 1, txHashes: [] } }, history: [{ txHash: null, type: "swap", in: "1 mUSDG", out: "—", fee: "—", ts: "2026-10-18T10:00:00Z", status: "blocked", reason: "x" }], usage: { day: "", calls: 0 }, activations: { act_old: { activationId: "act_old", status: "stopped" } } }));
    const script = path.join(tmp, "check.mts");
    fs.writeFileSync(script, `const s = await import(${JSON.stringify(path.resolve("src/service.ts"))}); const S = s._state(); console.log("RESULT" + JSON.stringify({ orders: Object.keys(S.orders), history: S.history.length, country: S.country, idx: S.nextAgentIdx, acts: Object.keys(S.activations ?? {}) }));`);
    const { spawnSync } = await import("node:child_process");
    const run = () => { const r = spawnSync("npx", ["tsx", script], { env: { ...process.env, DATA_DIR: tmp }, encoding: "utf8" }); const m = /RESULT(.*)/.exec(r.stdout); assert.ok(m, r.stderr); return JSON.parse(m![1]); };
    const r1 = run();
    assert.deepEqual(r1, { orders: ["int_legacy"], history: 1, country: "DE", idx: 3, acts: ["act_old"] });
    assert.ok(fs.existsSync(path.join(tmp, "state.json.migrated")) && !fs.existsSync(path.join(tmp, "state.json")) && fs.existsSync(path.join(tmp, "stockclaw.db")));
    assert.deepEqual(run(), r1, "second boot reads SQLite (no re-import)");
    // state survives a reload of the in-memory view
    const v = svc._vault(); svc._reloadFromDb(); assert.equal(svc._vault(), v);
    // nonce manager: concurrent writes, two wallet objects for the same key share one queue + counter
    const w1 = wallet(cfg.keys.demoOwner()), w2 = wallet(cfg.keys.demoOwner());
    const res = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => (i % 2 ? w1 : w2).write(v as any, C.vault.abi, "setAllowedToken", [d.stocks.PLTR.token, true], { label: `e2e-nonce-${i}` })));
    assert.equal(res.length, 6);
    const ns = (getDb().prepare("SELECT nonce FROM tx_log WHERE label LIKE 'e2e-nonce-%' ORDER BY nonce").all() as { nonce: number }[]).map((r) => r.nonce);
    assert.equal(new Set(ns).size, 6); assert.equal(ns[5] - ns[0], 5, JSON.stringify(ns));
    // an external tx from the same key (outside the manager) => "nonce too low" => resync => success
    await w1.client.sendTransaction({ to: w1.address, value: 0n, nonce: ns[5] + 1 } as any);
    await rpc("evm_mine");
    const r = await w1.write(v as any, C.vault.abi, "setAllowedToken", [d.stocks.PLTR.token, true], { label: "e2e-nonce-resync" });
    assert.equal(r.receipt.status, "success");
    assert.equal((getDb().prepare("SELECT status FROM tx_log WHERE label='e2e-nonce-resync'").get() as any).status, "mined");
  });

  await step("baskets: 8 listed (only ai-tech-mini executable, others give a reason); hashes pinned; $300 preview = 6 legs <= $98; non-executable 409", async () => {
    await freshUser();
    const ls = (await callH("GET", "baskets", undefined, MCPT)).body;
    assert.equal(ls.length, 8);
    const mini = ls.find((b: any) => b.id === "ai-tech-mini");
    assert.equal(mini.executable, true); assert.deepEqual(mini.legs.map((l: any) => l.symbol).sort(), ["AMD", "AMZN", "PLTR"]); assert.equal(mini.legs.reduce((s: number, l: any) => s + l.weightBps, 0), 10000);
    for (const b of ls.filter((x: any) => x.id !== "ai-tech-mini")) { assert.equal(b.executable, false); assert.match(b.notExecutableReason, /Not executable locally/); assert.match(b.basketHash, /^sha256:/); }
    const g = (await callH("GET", "baskets/ai-tech-mini")).body; assert.ok(g.legs.every((l: any) => l.tradable && l.priceUsd > 0)); assert.match(g.disclaimer, /Not investment advice/);
    const p = (await callH("POST", "baskets/preview", { id: "ai-tech-mini", usd: 300 }, MCPT)).body;
    assert.equal(p.preflight.ok, true, JSON.stringify(p.preflight)); assert.equal(p.legs.length, 6);
    assert.ok(p.legs.every((l: any) => l.amountIn <= 98 && l.amountIn >= 5 && l.quotedOut > 0 && l.minOut > 0));
    assert.equal(+p.legs.reduce((s: number, l: any) => s + l.amountIn, 0).toFixed(2), 300);
    assert.equal(p.capHeadroom.perTrade, 100); assert.equal(p.capHeadroom.remaining24h, 500);
    const ai = await callH("POST", "baskets/preview", { id: "ai", usd: 100 }); assert.equal(ai.status, 409); assert.match(ai.body.error, /Not executable locally/);
    assert.equal((await callH("POST", "baskets/preview", { id: "ai-tech-mini", usd: 600 })).status, 400, "basket max $500");
    assert.deepEqual(bk.splitLeg(125), [98, 27]);
  });

  let ex1: any;
  await step("basket: agent proposes via MCP (pending, nothing bought); MCP token can't confirm; owner confirms; 3 legs fill; same Idempotency-Key replays with no new txs", async () => {
    const c = await mcpClient();
    const pv = mcpJson(await c.callTool({ name: "preview_basket_buy", arguments: { id: "ai-tech-mini", usd: 150 } }));
    const usdg0 = await bal("mUSDG");
    const pr = mcpJson(await c.callTool({ name: "buy_basket", arguments: { previewId: pv.previewId } }));
    assert.equal(pr.status, "pending_confirmation"); assert.equal(pr.requiresOwnerConfirmation, true); assert.match(pr.message, /pending owner confirmation/);
    await c.close();
    assert.equal(await bal("mUSDG"), usdg0, "nothing bought before owner confirms");
    assert.equal((await callH("POST", `baskets/proposals/${pr.proposalId}/confirm`, {}, MCPT)).status, 403);
    const cf = await callH("POST", `baskets/proposals/${pr.proposalId}/confirm`, {}, OWNER, { "idempotency-key": "e2e-k1" });
    assert.equal(cf.status, 200, JSON.stringify(cf.body)); assert.ok(["pending", "running", "filled"].includes(cf.body.status));
    ex1 = await waitExec(cf.body.id);
    assert.equal(ex1.status, "filled", JSON.stringify(ex1));
    assert.deepEqual(Object.keys(ex1).sort(), ["basketHash", "basketId", "basketVersion", "createdAt", "id", "legs", "status", "totalUsd", "updatedAt"].sort());
    assert.equal(ex1.legs.length, 3);
    for (const l of ex1.legs) { assert.deepEqual(Object.keys(l).sort(), ["filledUsd", "legId", "status", "targetUsd", "ticker", "txHash", "weight"].sort()); assert.equal(l.status, "filled"); assert.equal(l.filledUsd, l.targetUsd); }
    const n = txCount("basket:%");
    const again = await callH("POST", `baskets/proposals/${pr.proposalId}/confirm`, {}, OWNER, { "idempotency-key": "e2e-k1" });
    assert.equal(again.body.id, ex1.id); assert.equal(txCount("basket:%"), n, "replay: no new txs");
    assert.ok(Math.abs((await bal("mUSDG")) - (usdg0 - 150)) < 0.01);
  });

  await step("basket partial: forced revert in leg 2 => partial (leg 1 kept, no auto-retry); replay = no new txs; only failed legs retry (owner, idempotent); transport error retried once", async () => {
    bk._setFaults({ revertLeg: 1 });
    const b = await callH("POST", "baskets/buy", { id: "ai-tech-mini", usd: 60 }, OWNER, { "idempotency-key": "e2e-k2" });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const e = await waitExec(b.body.id);
    assert.equal(e.status, "partial", JSON.stringify(e));
    assert.deepEqual(e.legs.map((l: any) => l.status), ["filled", "failed", "pending"]);
    assert.match(e.legs[1].error, /Slippage|oracle|Insufficient/i); assert.equal(e.legs[1].txHash, undefined);
    const n = txCount("basket:%");
    const rep = await callH("POST", "baskets/buy", { id: "ai-tech-mini", usd: 60 }, OWNER, { "idempotency-key": "e2e-k2" });
    assert.equal(rep.body.id, e.id); assert.equal(rep.body.status, "partial"); assert.equal(txCount("basket:%"), n, "no duplicates on replay");
    const [l1, l2, l3] = e.legs;
    assert.equal((await callH("POST", `baskets/executions/${e.id}/legs/${l3.legId}/retry`)).status, 409, "pending legs can't be retried");
    assert.equal((await callH("POST", `baskets/executions/${e.id}/legs/${l1.legId}/retry`)).body.legs[0].status, "filled", "filled leg: no-op");
    assert.equal((await callH("POST", `baskets/executions/${e.id}/legs/${l2.legId}/retry`, {}, MCPT)).status, 403, "owner token only");
    const rt = await callH("POST", `baskets/executions/${e.id}/legs/${l2.legId}/retry`); assert.equal(rt.status, 200, JSON.stringify(rt.body));
    const e2 = await waitExec(e.id, (x) => x.legs[1].status === "filled" || x.legs[1].status === "failed");
    assert.equal(e2.legs[1].status, "filled"); assert.equal(e2.status, "partial", "leg 3 untouched");
    const n2 = txCount("basket:%"); assert.equal(n2, n + 1);
    await callH("POST", `baskets/executions/${e.id}/legs/${l2.legId}/retry`); await new Promise((r) => setTimeout(r, 300));
    assert.equal(txCount("basket:%"), n2, "repeat retry: no new tx");
    bk._setFaults({ transientOnceLeg: 0 });
    const t = await callH("POST", "baskets/buy", { id: "ai-tech-mini", usd: 30 });
    const et = await waitExec(t.body.id);
    assert.equal(et.status, "filled"); assert.equal(txCount(`basket:${et.legs[0].legId}`), 1);
  });

  await step("restart mid-queue: crash after leg 2's tx is sent; restart reconciles it by receipt and finishes leg 3, no duplicate txs", async () => {
    bk._setFaults({ crashAfterSubmitLeg: 1 });
    const b = await callH("POST", "baskets/buy", { id: "ai-tech-mini", usd: 60 }, OWNER, { "idempotency-key": "e2e-k3" });
    for (let i = 0; i < 100 && !jobs.isCrashed(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(jobs.isCrashed(), "process 'died' mid-basket");
    const mid = (await callH("GET", `baskets/executions/${b.body.id}`)).body;
    assert.equal(mid.status, "running"); assert.deepEqual(mid.legs.map((l: any) => l.status), ["filled", "filling", "pending"]); assert.ok(mid.legs[1].txHash);
    assert.equal(jobs.stats().running, 1);
    // "restart": drop in-memory state, rebuild from SQLite, recover (reconcile tx_log + requeue jobs), resume worker
    jobs.stopWorker(); svc._reloadFromDb(); const { resyncNonce } = await import("../src/chain.js"); resyncNonce(svc._agent()!.address);
    const rec = await jobs.recover(); assert.equal(rec.requeuedJobs, 1);
    jobs.startWorker(100);
    const e = await waitExec(b.body.id);
    assert.equal(e.status, "filled", JSON.stringify(e));
    assert.equal(e.legs[1].txHash, mid.legs[1].txHash, "leg 2 settled from its original tx");
    for (const l of e.legs) assert.equal(txCount(`basket:${l.legId}`), 1, `exactly one tx for ${l.legId}`);
    assert.equal(jobs.stats().running, 0);
    // remaining headroom now $220 (150 + 40 + 30 + 60 bought) => $250 refused by default, scaled down on request
    const big = await callH("POST", "baskets/preview", { id: "ai-tech-mini", usd: 250 }); assert.equal(big.status, 403); assert.match(big.body.error, /rolling-24h buy cap/);
    const sd = (await callH("POST", "baskets/preview", { id: "ai-tech-mini", usd: 250, allowScaleDown: true })).body; assert.equal(sd.scaledDown, true); assert.ok(Math.abs(sd.totalUsd - 220) < 0.05 && sd.totalUsd <= sd.capHeadroom.remaining24h, String(sd.totalUsd));
  });

  await step("sell approvals (R4-1): sells use the $500 sell cap; over it the sell is held (no tx), MCP says pending owner approval; passkey approve => keeper relays SellApproval, sell executes; reject; >3% move fails", async () => {
    const { virtualAuthenticator } = await import("./virtualAuthenticator.js");
    for (let i = 0; i < 5; i++) { const r = await call("POST", "execute_swap", { tokenIn: "AMD", tokenOut: "mUSDG", amountIn: 0.6 }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.txHash, JSON.stringify(r.body)); }
    const sold = Number(await read<bigint>(vaultAddr(), C.vault.abi, "vaultSoldLast24h")) / 1e6; assert.ok(sold > 440 && sold < 460, String(sold));
    const amd0 = await bal("AMD");
    const c = await mcpClient();
    const held = mcpJson(await c.callTool({ name: "execute_swap", arguments: { tokenIn: "AMD", tokenOut: "mUSDG", amountIn: 0.6 } }));
    await c.close();
    assert.equal(held.status, "pending_owner_approval"); assert.match(held.message, /pending owner approval/); assert.equal(await bal("AMD"), amd0, "nothing submitted");
    assert.equal((await callH("GET", "approvals", { status: "pending" }, MCPT)).status, 403);
    const list = (await callH("GET", "approvals", { status: "pending" })).body; assert.equal(list.length, 1);
    const ap = list[0];
    for (const k of ["id", "agentKeyId", "agentName", "ticker", "amountIn", "estUsdgOut", "estUsdgOutMin", "reason", "status", "createdAt", "expiresAt"]) assert.ok(k in ap, k);
    assert.equal(ap.ownerSignatureSimulated, true); assert.ok(Math.abs(Date.parse(ap.expiresAt) - Date.parse(ap.createdAt) - 3600_000) < 2000);
    // passkey (virtual authenticator, real WebAuthn verification)
    const va = virtualAuthenticator("localhost", `http://localhost:${PORT_API}`);
    const ro = (await callH("POST", "passkey/register/options")).body; assert.equal(ro.rp.id, "localhost");
    const rv = await callH("POST", "passkey/register/verify", { response: va.register(ro) }); assert.equal(rv.status, 200, JSON.stringify(rv.body));
    assert.equal((await callH("POST", `approvals/${ap.id}/approve`, { webauthnAssertion: va.assert(ap.challenge, { tamper: true }) })).status, 401);
    assert.equal((await callH("POST", `approvals/${ap.id}/approve`, { webauthnAssertion: va.assert(ap.challenge, { noUV: true }) })).status, 401, "userVerification required");
    // a second passkey can't be added with the owner token alone (Gaius R5); a step-up assertion from the first one is needed
    const su = await callH("POST", "passkey/register/options"); assert.equal(su.status, 403); assert.ok(su.body.stepUpChallenge);
    assert.equal((await callH("POST", "passkey/register/options", { webauthnAssertion: va.assert(su.body.stepUpChallenge, { tamper: true }) })).status, 401);
    const ro2 = await callH("POST", "passkey/register/options", { webauthnAssertion: va.assert(su.body.stepUpChallenge) }); assert.equal(ro2.status, 200, JSON.stringify(ro2.body));
    assert.equal(ro2.body.authenticatorSelection.userVerification, "required");
    assert.equal((await callH("POST", `approvals/${ap.id}/approve`, { webauthnAssertion: va.assert("d3Jvbmc") })).status, 401, "wrong challenge");
    assert.equal((await callH("POST", `approvals/${ap.id}/approve`, {})).status, 401, "assertion required");
    const ok = await callH("POST", `approvals/${ap.id}/approve`, { webauthnAssertion: va.assert(ap.challenge) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, "executed"); assert.equal(ok.body.ownerSignatureSimulated, true); assert.equal(ok.body.exitApproval.relayedBy, "keeper");
    assert.ok(Math.abs(ok.body.exitApproval.amountUsd / (0.6 * Number((await svc.priceE8("AMD")).p) / 1e8) - 1.02) < 0.01, "amount = est x 1.02");
    assert.ok(Math.abs((await bal("AMD")) - (amd0 - 0.6)) < 1e-9);
    assert.equal((await callH("POST", `approvals/${ap.id}/approve`, { webauthnAssertion: va.assert(ap.challenge) })).status, 409, "one approval per sell");
    // reject
    const h2 = (await call("POST", "execute_swap", { tokenIn: "AMD", tokenOut: "mUSDG", amountIn: 0.6 })).body; assert.equal(h2.status, "pending_owner_approval");
    assert.equal((await callH("POST", `approvals/${h2.approvalId}/reject`)).body.status, "rejected");
    assert.equal((await callH("POST", `approvals/${h2.approvalId}/approve`, { webauthnAssertion: va.assert(h2.approval.challenge) })).status, 409);
    // price moved > 3% => not executed
    const h3 = (await call("POST", "execute_swap", { tokenIn: "AMD", tokenOut: "mUSDG", amountIn: 0.6 })).body; assert.equal(h3.status, "pending_owner_approval");
    const px = Number((await svc.priceE8("AMD")).p) / 1e8;
    await warp(600); await keeper.pushOracle({ AMD: +(px * 0.95).toFixed(2) });
    const mv = await callH("POST", `approvals/${h3.approvalId}/approve`, { webauthnAssertion: va.assert(h3.approval.challenge) });
    assert.equal(mv.status, 409); assert.match(mv.body.error, /Price moved .*> 3%/);
    assert.equal((await callH("GET", "approvals", { status: "failed" })).body.length, 1);
    await warp(600); await keeper.pushOracle({ AMD: 150 });
  });

  await step("blocked sell display fixture: a non-cap blocked sell is recorded as side=sell with its real reason (fixtures/blocked-sell.json)", async () => {
    const r = await call("POST", "execute_swap", { tokenIn: "NFLX", tokenOut: "mUSDG", amountIn: 0.01 });
    assert.equal(r.status, 403); assert.match(r.body.error, /allowlist/);
    const h = (await call("GET", "get_history", { limit: 1 })).body[0];
    assert.equal(h.side, "sell"); assert.equal(h.status, "blocked"); assert.doesNotMatch(h.reason, /rolling|24h|cap/i);
    const pending = (await callH("GET", "approvals")).body.find((a: any) => a.status === "failed");
    const fixture = { note: "Generated by scripts/e2e.ts. Sells are never cap-blocked: a blocked sell shows its own reason; an over-limit sell is held for owner approval instead.",
      blockedSellHistoryRow: { ...h, ts: "2026-10-18T12:00:00.000Z" }, expectedUi: `Blocked: ${h.reason}`,
      heldSellApiResponse: { status: "pending_owner_approval", approvalId: "apr_example", message: "Sell is pending owner approval: agent sells over $500 per rolling 24h need the owner's passkey approval in the StockClaw dashboard. Nothing was submitted." },
      approvalShapeKeys: Object.keys(pending).sort() };
    fs.mkdirSync(path.resolve("fixtures"), { recursive: true });
    fs.writeFileSync(path.resolve("fixtures/blocked-sell.json"), JSON.stringify(fixture, null, 2) + "\n");
  });

  await step("health: /api/health reports rpc, sqlite, job queue, signers (keeper/updater/owner) with nonces, tx stats; /healthz 200", async () => {
    const hh = (await callH("GET", "health", undefined, null)).body;
    assert.equal(hh.rpc.ok, true); assert.equal(hh.db.ok, true); assert.ok("queued" in hh.queue && "running" in hh.queue);
    assert.deepEqual(hh.signers.map((x: any) => x.role), ["keeper", "updater", "owner"]); assert.ok(hh.signers.every((x: any) => x.balanceEth > 0));
    assert.ok(hh.txs && "inFlight" in hh.txs);
    const z = await fetch(`http://127.0.0.1:${PORT_API}/healthz`); assert.equal(z.status, 200);
  });
  await step("R3-1/B8/B12: tokens required (ALLOW_OPEN_LOCAL escape), X-Owner-Token, rate limit 429, health alerts", async () => {
    const save = { o: process.env.OWNER_API_TOKEN, m: process.env.MCP_API_TOKEN };
    delete process.env.OWNER_API_TOKEN;
    assert.throws(() => cfg.assertTokensConfigured(), /REFUSING to start/);
    process.env.ALLOW_OPEN_LOCAL = "1"; assert.doesNotThrow(() => cfg.assertTokensConfigured()); delete process.env.ALLOW_OPEN_LOCAL;
    process.env.OWNER_API_TOKEN = save.o; process.env.MCP_API_TOKEN = save.m;
    // owner endpoint via X-Owner-Token header (dashboard shape); MCP token in the same header is still refused
    const viaHdr = await fetch(`${API}/strategies/activations/x/resume`, { method: "POST", headers: { "content-type": "application/json", "x-owner-token": OWNER } }); assert.equal(viaHdr.status, 409);
    const mcpHdr = await fetch(`${API}/revoke_session_key`, { method: "POST", headers: { "content-type": "application/json", "x-owner-token": MCPT } }); assert.equal(mcpHdr.status, 403);
    // rate limit on a separate app instance with a tiny budget
    const small = buildApp({ restPerMin: 5, mcpPerMin: 2 }).listen(PORT_API + 1);
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await fetch(`http://127.0.0.1:${PORT_API + 1}/api/list_assets`, { headers: { authorization: `Bearer ${MCPT}` } })).status);
    assert.deepEqual(codes.slice(5), [429, 429]); assert.ok(codes.slice(0, 5).every((c) => c === 200));
    const m: number[] = [];
    for (let i = 0; i < 3; i++) m.push((await fetch(`http://127.0.0.1:${PORT_API + 1}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${MCPT}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status);
    assert.equal(m[2], 429);
    // SC-2: random fake tokens share the IP bucket (no bypass)
    const small2 = buildApp({ restPerMin: 5, mcpPerMin: 2, ipPerMin: 50 }).listen(PORT_API + 12);
    const fake: number[] = [];
    for (let i = 0; i < 8; i++) fake.push((await fetch(`http://127.0.0.1:${PORT_API + 12}/api/list_assets`, { headers: { authorization: `Bearer fake_${Math.random()}` } })).status);
    assert.deepEqual(fake.slice(0, 5), [401, 401, 401, 401, 401]); assert.deepEqual(fake.slice(5), [429, 429, 429]);
    small2.close();
    const small3 = buildApp({ restPerMin: 1000, mcpPerMin: 1000, ipPerMin: 4 }).listen(PORT_API + 13);
    const g: number[] = [];
    for (const u of ["api/list_assets", "mcp", "api/get_wallet", "mcp", "api/list_assets"]) g.push((await fetch(`http://127.0.0.1:${PORT_API + 13}/${u}`, { method: u === "mcp" ? "POST" : "GET", headers: { "content-type": "application/json", authorization: `Bearer x${Math.random()}` }, body: u === "mcp" ? "{}" : undefined })).status);
    assert.equal(g[4], 429, "global per-IP limit spans REST + MCP: " + g);
    small3.close();
    const { Limiter } = await import("../src/rest.js");
    const L = new Limiter(10, 100); for (let i = 0; i < 1000; i++) L.hit("k" + i); assert.ok(L.size <= 100, "bounded size");
    // /api/health has its own generous bucket: survives after the REST bucket is exhausted, but is still limited
    const hz: number[] = [];
    for (let i = 0; i < 4; i++) hz.push((await fetch(`http://127.0.0.1:${PORT_API + 1}/api/health`)).status);
    assert.ok(hz.every((c) => c === 200), "health not blocked by the exhausted REST bucket: " + hz);
    const small4 = buildApp({ healthPerMin: 3 }).listen(PORT_API + 14);
    const hl: number[] = []; for (let i = 0; i < 4; i++) hl.push((await fetch(`http://127.0.0.1:${PORT_API + 14}/api/health`)).status);
    assert.deepEqual(hl, [200, 200, 200, 429]); small4.close();
    small.close();
    // health: fresh pushes = no oracle alert; after 20 min without pushes ORACLE_STALE fires; cap-block spike counted
    await keeper.pushOracle();
    let hh = (await call("GET", "health")).body; assert.ok(!hh.alerts.some((a: any) => a.code === "ORACLE_STALE"), JSON.stringify(hh.alerts));
    await warp(1200);
    hh = (await call("GET", "health")).body; assert.ok(hh.alerts.some((a: any) => a.code === "ORACLE_STALE")); assert.equal(hh.status, "degraded");
    const mon = await import("../src/monitor.js"); for (let i = 0; i < 5; i++) mon.recordCapBlock();
    hh = (await call("GET", "health")).body; assert.ok(hh.alerts.some((a: any) => a.code === "CAP_BLOCK_SPIKE"));
    process.env.MARKET_MODE = "schedule"; keeper._resetPushedSession();
    await warp(9 * 3600); // past the override session's close, no new session pushed
    hh = (await call("GET", "health")).body; assert.ok(hh.alerts.some((a: any) => a.code === "SESSION_CLOSED"), JSON.stringify(hh.alerts));
    process.env.MARKET_MODE = "open";
  });

  await step("SC-1: local RPC detection parses the URL (no userinfo / suffix tricks)", async () => {
    for (const u of ["http://127.0.0.1:8545", "http://localhost:8545", "http://[::1]:8545", "https://LOCALHOST"]) assert.equal(cfg.isLocalRpc(u), true, u);
    for (const u of ["http://127.0.0.1@remote.example:8545", "http://user:pw@localhost:8545", "http://localhost.evil.com", "http://127.0.0.1.nip.io", "http://0.0.0.0:8545", "https://rpc.testnet.chain.robinhood.com", "file:///127.0.0.1", "not a url", "http://127.0.0.2"]) assert.equal(cfg.isLocalRpc(u), false, u);
  });

  await step("market calendar: DST (14:30-21:00 UTC from Nov 1), holidays, early close; keeper pushes the NYSE session", async () => {
    const cal = await import("../src/marketCalendar.js");
    const s1 = cal.sessionFor(new Date("2026-10-30T15:00:00Z")); assert.deepEqual([s1.openMinute, s1.closeMinute], [810, 1200]);
    const s2 = cal.sessionFor(new Date("2026-11-02T15:00:00Z")); assert.deepEqual([s2.openMinute, s2.closeMinute], [870, 1260]);
    assert.equal(cal.sessionFor(new Date("2026-11-26T15:00:00Z")).open, false);
    const s3 = cal.sessionFor(new Date("2026-11-27T15:00:00Z")); assert.equal(s3.earlyClose, true); assert.equal(s3.closeMinute, 1080);
    assert.equal(cal.sessionFor(new Date("2026-12-25T15:00:00Z")).open, false);
    assert.equal(cal.sessionFor(new Date("2027-03-15T14:00:00Z")).openMinute, 810);
    assert.equal(cal.sessionFor(new Date("2026-10-31T15:00:00Z")).reason, "Weekend");
    process.env.MARKET_MODE = "schedule";
    const { pub } = await import("../src/chain.js");
    const target = Math.floor(Date.parse("2026-11-02T15:00:00Z") / 1000), now = Number((await pub.getBlock()).timestamp);
    if (target > now) await warp(target - now);
    keeper._resetPushedSession();
    const r: any = await keeper.syncMarketSchedule(); assert.equal(r.adapter, "session"); assert.equal(r.mode, "session");
    assert.equal(Number(await read(d.oracle, C.oracle.abi, "sessionCloseAt")), Math.floor(Date.parse("2026-11-02T21:00:00Z") / 1000));
    assert.equal(await read(d.oracle, C.oracle.abi, "isMarketOpen"), true);
    process.env.MARKET_MODE = "open";
  });

  await step("healthz is red (503, CHAIN_UNREACHABLE) when anvil is down", async () => {
    anvil.kill(); await new Promise((r) => setTimeout(r, 500));
    const z = await fetch(`http://127.0.0.1:${PORT_API}/healthz`); assert.equal(z.status, 503);
    assert.ok((await z.json()).alerts.includes("CHAIN_UNREACHABLE"));
  });
  jobs.stopWorker();
  server.close();
  console.log(`\nE2E PASS: ${pass} steps`);
  cleanup(); process.exit(0);
} catch (e) {
  console.error(`\nE2E FAIL after ${pass} passing steps`, (e as Error)?.message ?? e);
  cleanup(); process.exit(1);
}
