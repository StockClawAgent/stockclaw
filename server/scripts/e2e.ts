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

const API = `http://127.0.0.1:${PORT_API}/api`;
async function call(method: "GET" | "POST", name: string, body?: Record<string, unknown>) {
  let url = `${API}/${name}`;
  if (method === "GET" && body) url += "?" + new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]));
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(body ?? {}) : undefined });
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
  await keeper.pushOracle();
  const usdgBal = async (a: string) => Number(await read<bigint>(d.usdg, C.usdg.abi, "balanceOf", [a])) / 1e6;

  await step("fee: router default 30 bps, setFeeBps(51) reverts FeeAboveCap, 50 allowed", async () => {
    assert.equal(Number(await read(d.router, C.router.abi, "feeBps")), 30);
    assert.equal(Number(await read(d.router, C.router.abi, "MAX_FEE_BPS")), 50);
    const dep = wallet(cfg.keys.deployer());
    await assert.rejects(dep.write(d.router, C.router.abi, "setFeeBps", [51]), (e) => revertReason(e).name === "FeeAboveCap");
  });

  await step("eligibility: US/CA/GB/CH/AE/IR blocked, geo-IP 451, DE ok after attestation", async () => {
    for (const c of ["US", "CA", "GB", "CH", "AE", "IR", "United Kingdom"]) {
      const r = await call("GET", "check_eligibility", { country: c }); assert.equal(r.body.eligible, false, c);
    }
    assert.equal((await call("POST", "submit_attestation", { sig: "0x" })).status, 451);
    const geo = await fetch(`${API}/check_eligibility?country=DE`, { headers: { "cf-ipcountry": "US" } }); assert.equal(geo.status, 451);
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
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT_API}/mcp`)));
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
    await keeper.pushOracle({ AMD: 153 });
    const id = (await call("POST", "create_limit_order", { tokenIn: "mUSDG", tokenOut: "AMD", amountIn: 25, limitPrice: 151 })).body.intentId;
    const id2 = (await call("POST", "create_limit_order", { tokenIn: "TSLA", tokenOut: "mUSDG", amountIn: 0.1, limitPrice: 500 })).body.intentId;
    await keeper.executeDue();
    let os_ = (await call("GET", "list_orders")).body; assert.equal(os_.find((x: any) => x.intentId === id).status, "open");
    const amd0 = (await call("GET", "get_balances", { tokens: "AMD" })).body[0].amount;
    await keeper.pushOracle({ AMD: 150 }); await keeper.executeDue();
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
    const ctx: any = { fetch, URLSearchParams, console, localStorage: { getItem: () => JSON.stringify({ country: "Germany" }) }, window: { STOCKCLAW_API: `http://127.0.0.1:${PORT_API}` } };
    vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(cfg.REPO, "prototype/api.js"), "utf8"), ctx);
    const api = ctx.window.api;
    const e = await api.check_eligibility(); assert.equal(e.eligible, true);
    const w = await api.get_wallet(); assert.equal(w.chainId, 46630); assert.equal(w.address, vault);
    const q = await api.quote_swap("mUSDG", "TSLA", 10); assert.equal(q.feeAmount, 0.03); for (const k of ["amountIn", "feeAmount", "netIn", "amountOut", "minOut", "route", "priceImpact", "quoteId", "expiresAt"]) assert.ok(k in q, k);
    assert.ok((await api.list_assets()).length === 6); assert.ok(Array.isArray(await api.get_history())); assert.ok(Array.isArray(await api.list_orders()));
    const k = await api.create_session_key({ perTradeCap: 50, dailyCap: 200, days: 3, allowlist: ["TSLA"] }); assert.equal(k.status, "active"); assert.equal(k.spentToday, 0); assert.equal(k.created.id, k.id); assert.equal(k.revoked, null, "old key was already revoked");
    const k2 = await api.create_session_key({ perTradeCap: 60, dailyCap: 200, days: 3, allowlist: ["TSLA"] }); assert.equal(k2.revoked.key, k.id); assert.match(k2.revoked.txHash, /^0x/); assert.equal(k2.perTradeCap, 60);
    const x = await api.execute_swap({ tokenIn: "mUSDG", tokenOut: "TSLA", amountIn: 40 }); assert.match(x.txHash, /^0x/);
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

  server.close();
  console.log(`\nE2E PASS: ${pass} steps`);
  cleanup(); process.exit(0);
} catch (e) {
  console.error(`\nE2E FAIL after ${pass} passing steps`, (e as Error)?.message ?? e);
  cleanup(); process.exit(1);
}
