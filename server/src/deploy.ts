// Deploy + seed StockClaw on a LOCAL anvil chain (chain id 46630).
// Deploys with Quintus's script/Deploy.s.sol (MOCK_TOKENS=1, built from git HEAD in server/artifacts/head),
// reads addresses from the forge broadcast file, then seeds feeds + pools. Refuses any non-local RPC:
// testnet deploys need approval and are run by hand with the same script.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { parseUnits, parseAbi, zeroAddress, type Address } from "viem";
import { C, wallet, assertChain, read, pub, type Deployment } from "./chain.js";
import { IS_LOCAL, RPC_URL, DEPLOYMENTS_FILE, keys, TESTNET_CHAIN_ID, DEFAULT_FEE_BPS, ROOT, attesterSeparation } from "./config.js";

export const BASE_PRICES: Record<string, number> = { TSLA: 250, AMZN: 190, PLTR: 40, NFLX: 700, AMD: 150 };
const POOL_USD = 250_000; // per side

export async function deployAndSeed(): Promise<Deployment> {
  if (!IS_LOCAL) throw new Error(`REFUSING to deploy to ${RPC_URL}: this flow is local-anvil only. Robinhood Chain deploys need approval.`);
  await assertChain();
  const dep = wallet(keys.deployer()), kp = wallet(keys.keeper()), tr = wallet(keys.treasury()), up = wallet(keys.updater());
  // L3: off a verified anvil ATTESTER must not be the deployer (throws); on anvil both are key 0 (warning, kept)
  const sep = attesterSeparation({ ...process.env, DEPLOYER_KEY: keys.deployer(), ATTESTER_KEY: keys.attester() }, dep.address);
  if (sep.warning) console.warn(`  WARNING: ${sep.warning}`);
  const head = path.join(ROOT, "artifacts", "head");
  if (!fs.existsSync(path.join(head, "script", "Deploy.s.sol"))) throw new Error("Run `npm run build` first");
  const forge = fs.existsSync(`${os.homedir()}/.foundry/bin/forge`) ? `${os.homedir()}/.foundry/bin/forge` : "forge";
  execFileSync(forge, ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", RPC_URL, "--broadcast", "--private-key", keys.deployer(), "--slow", "--out", "../out", "--cache-path", "../cache"], {
    cwd: head, stdio: process.env.DEPLOY_VERBOSE ? "inherit" : "pipe",
    env: { ...process.env, MOCK_TOKENS: "1", TREASURY_SAFE: tr.address, FEED_UPDATER: up.address, ATTESTER: sep.attester!, KEEPER: kp.address },
  });
  const bc = JSON.parse(fs.readFileSync(path.join(head, "broadcast", "Deploy.s.sol", String(TESTNET_CHAIN_ID), "run-latest.json"), "utf8"));
  const created = (bc.transactions as any[]).filter((t) => t.transactionType === "CREATE").map((t) => ({ name: t.contractName as string, addr: t.contractAddress as Address }));
  const byName = (n: string) => created.filter((c) => c.name === n).map((c) => c.addr);
  const [usdg] = byName("MockUSDG"), [oracle] = byName("PriceOracle"), [registry] = byName("EligibilityRegistry"), [router] = byName("FeeRouter");
  const tokens = byName("MockStockToken"), feeds = byName("MockAggregatorV3"), pools = byName("StockClawPool");
  if (!router || tokens.length !== 5 || feeds.length !== 5 || pools.length !== 5) throw new Error("unexpected broadcast contents");
  const fee = await read<number>(router, C.router.abi, "feeBps");
  if (fee !== DEFAULT_FEE_BPS) throw new Error(`router feeBps ${fee} != ${DEFAULT_FEE_BPS}`);
  // Deployer is still owner until the Safe accepts (2-step): it seeds feeds + pools first (MockUSDG mint included).
  const stocks: Deployment["stocks"] = {};
  const syms = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"];
  for (let i = 0; i < 5; i++) {
    const sym = syms[i], px = BASE_PRICES[sym], token = tokens[i], feed = feeds[i], pool = pools[i];
    if ((await read<string>(token, C.stock.abi, "symbol")) !== sym) throw new Error(`token order mismatch at ${i}`);
    await dep.write(feed, C.agg.abi, "setMaxDelta", [5000, 5000]); // LOCAL DEMO ONLY: allow scripted price moves (testnet keeps 10%/h, 20% cap)
    await up.write(feed, C.agg.abi, "updateAnswer", [parseUnits(String(px), 8)]);
    const stockAmt = parseUnits(String(POOL_USD / px), 18), usdAmt = parseUnits(String(POOL_USD), 6);
    await dep.write(token, C.stock.abi, "mint", [dep.address, stockAmt]);
    await dep.write(usdg, C.usdg.abi, "mint", [dep.address, usdAmt]);
    await dep.write(token, C.stock.abi, "approve", [pool, stockAmt]);
    await dep.write(usdg, C.usdg.abi, "approve", [pool, usdAmt]);
    await dep.write(pool, C.pool.abi, "addLiquidity", [stockAmt, usdAmt]);
    stocks[sym] = { token, feed, pool, decimals: 18 };
    console.log(`  ${sym}: token ${token} feed ${feed} pool ${pool}`);
  }
  // Simulated Safe step (LOCAL ONLY): the treasury key stands in for the 2-of-3 Safe and accepts the 2-step ownership
  // of router, oracle, pools, feeds and (65cd2f6) MockUSDG, right after seeding. The script already moved registry admin.
  for (const a of [router, oracle, ...pools, ...feeds, usdg]) await tr.write(a, OWNABLE2, "acceptOwnership");
  const h = await deployerHandoff({ router, oracle, registry, usdg, pools, feeds, tokens }, dep.address, tr.address);
  if (h.problems.length) throw new Error(`L3 handoff incomplete: ${h.problems.join("; ")}`);
  if (h.attesterRole) console.warn(`  WARNING: deployer ${dep.address} keeps ATTESTER_ROLE (ATTESTER == deployer, local anvil only)`);
  const d: Deployment = { chainId: TESTNET_CHAIN_ID, rpc: RPC_URL, deployedAt: new Date().toISOString(), deployer: dep.address, keeper: kp.address, treasury: tr.address, usdg, oracle, registry, router, stocks };
  fs.mkdirSync(path.dirname(DEPLOYMENTS_FILE), { recursive: true });
  fs.writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(d, null, 2));
  fs.rmSync(path.join(path.dirname(DEPLOYMENTS_FILE), "state.json"), { force: true });
  console.log(`Deployed via script/Deploy.s.sol (MOCK_TOKENS=1): router ${router} (fee ${fee} bps) -> ${DEPLOYMENTS_FILE}`);
  void pub;
  return d;
}

const OWNABLE2 = parseAbi(["function owner() view returns (address)", "function pendingOwner() view returns (address)", "function acceptOwnership()"]);
const ISSUER = parseAbi(["function issuer() view returns (address)"]);
/** L3 check: after the Safe accepted, the deployer holds no ownership and no registry role. The only allowed leftover is
 * ATTESTER_ROLE when ATTESTER == deployer (local anvil, logged). Mock stock tokens' `issuer` (immutable, MOCK_TOKENS=1
 * stand-in for the external stock issuer, used by the local faucet) is reported separately, not a StockClaw role. */
export async function deployerHandoff(a: { router: Address; oracle: Address; registry: Address; usdg: Address; pools: Address[]; feeds: Address[]; tokens?: Address[] }, deployer: Address, safe: Address) {
  const problems: string[] = [], eq = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  const owned = [["router", a.router], ["oracle", a.oracle], ["usdg", a.usdg], ...a.pools.map((p, i) => [`pool${i}`, p]), ...a.feeds.map((f, i) => [`feed${i}`, f])] as [string, Address][];
  for (const [n, c] of owned) {
    const [o, p] = await Promise.all([read<string>(c, OWNABLE2, "owner"), read<string>(c, OWNABLE2, "pendingOwner")]);
    if (!eq(o, safe)) problems.push(`${n} owner ${o} != Safe`);
    if (!eq(p, zeroAddress)) problems.push(`${n} pendingOwner ${p} not accepted`);
  }
  const [admin, att] = await Promise.all([read<`0x${string}`>(a.registry, C.registry.abi, "DEFAULT_ADMIN_ROLE"), read<`0x${string}`>(a.registry, C.registry.abi, "ATTESTER_ROLE")]);
  if (await read<boolean>(a.registry, C.registry.abi, "hasRole", [admin, deployer])) problems.push("deployer still has registry DEFAULT_ADMIN_ROLE");
  if (!(await read<boolean>(a.registry, C.registry.abi, "hasRole", [admin, safe]))) problems.push("Safe lacks registry DEFAULT_ADMIN_ROLE");
  const attesterRole = await read<boolean>(a.registry, C.registry.abi, "hasRole", [att, deployer]);
  const mockIssuer = (await Promise.all((a.tokens ?? []).map((t) => read<string>(t, ISSUER, "issuer").catch(() => "")))).filter((x) => eq(x, deployer)).length;
  return { problems, ownedBySafe: owned.length, attesterRole, mockIssuerOf: mockIssuer };
}

if (import.meta.url === `file://${process.argv[1]}`) deployAndSeed().catch((e) => { console.error(e.message ?? e); process.exit(1); });
