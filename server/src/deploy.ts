// Deploy + seed StockClaw on a LOCAL anvil chain with chain id 46630.
// Mirrors script/Deploy.s.sol (deployCore + per-ticker feed/pool wiring, same constructor args) but
// deploys MockStockTokens instead of the real testnet stock-token addresses (they don't exist on anvil)
// and seeds pools. Refuses any non-local RPC: testnet deploys go through Quintus's forge script after approval.
import fs from "node:fs";
import path from "node:path";
import { parseUnits, type Address } from "viem";
import { C, wallet, assertChain, read, type Deployment } from "./chain.js";
import { IS_LOCAL, RPC_URL, DEPLOYMENTS_FILE, keys, TESTNET_CHAIN_ID, DEFAULT_FEE_BPS } from "./config.js";

export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const BASE_PRICES: Record<string, number> = { TSLA: 250, AMZN: 190, PLTR: 40, NFLX: 700, AMD: 150 };
const POOL_USD = 250_000; // per side
const BAND_BPS = 500;

export async function deployAndSeed(): Promise<Deployment> {
  if (!IS_LOCAL) throw new Error(`REFUSING to deploy to ${RPC_URL}: this flow is local-anvil only. Testnet deploys need approval and use script/Deploy.s.sol.`);
  await assertChain();
  const dep = wallet(keys.deployer()), kp = wallet(keys.keeper()), tr = wallet(keys.treasury());
  const usdg = await dep.deploy(C.usdg, [dep.address]);
  const oracle = await dep.deploy(C.oracle, [dep.address, usdg]);
  const registry = await dep.deploy(C.registry, [dep.address, dep.address]); // admin, attester
  const router = await dep.deploy(C.router, [dep.address, tr.address, PERMIT2, oracle, registry]);
  const fee = await read<number>(router, C.router.abi, "feeBps");
  if (fee !== DEFAULT_FEE_BPS) throw new Error(`router feeBps ${fee} != ${DEFAULT_FEE_BPS}`);
  await dep.write(router, C.router.abi, "setKeeper", [kp.address]);
  await dep.write(oracle, C.oracle.abi, "setKeeper", [kp.address]);
  await dep.write(oracle, C.oracle.abi, "setMarketMode", [1]); // Open (local demo; testnet uses Schedule)

  const stocks: Deployment["stocks"] = {};
  for (const [sym, px] of Object.entries(BASE_PRICES)) {
    const token = await dep.deploy(C.stock, [`${sym} (StockClaw mock)`, sym]);
    const feed = await dep.deploy(C.agg, [dep.address, kp.address, 8, `${sym} / USD`]);
    await dep.write(oracle, C.oracle.abi, "setFeed", [token, feed, 3600]);
    await kp.write(feed, C.agg.abi, "updateAnswer", [parseUnits(String(px), 8)]);
    const pool = await dep.deploy(C.pool, [dep.address, token, usdg, oracle, BAND_BPS]);
    await dep.write(pool, C.pool.abi, "setRouter", [router]);
    await dep.write(router, C.router.abi, "setAdapter", [pool, true]);
    const stockAmt = parseUnits(String(POOL_USD / px), 18), usdAmt = parseUnits(String(POOL_USD), 6);
    await dep.write(token, C.stock.abi, "mint", [dep.address, stockAmt]);
    await dep.write(usdg, C.usdg.abi, "mint", [dep.address, usdAmt]);
    await dep.write(token, C.stock.abi, "approve", [pool, stockAmt]);
    await dep.write(usdg, C.usdg.abi, "approve", [pool, usdAmt]);
    await dep.write(pool, C.pool.abi, "addLiquidity", [stockAmt, usdAmt]);
    stocks[sym] = { token, feed, pool, decimals: 18 };
    console.log(`  ${sym}: token ${token} feed ${feed} pool ${pool}`);
  }
  const d: Deployment = { chainId: TESTNET_CHAIN_ID, rpc: RPC_URL, deployedAt: new Date().toISOString(), deployer: dep.address, keeper: kp.address, treasury: tr.address, usdg, oracle, registry, router, stocks };
  fs.mkdirSync(path.dirname(DEPLOYMENTS_FILE), { recursive: true });
  fs.writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(d, null, 2));
  for (const f of ["state.json"]) fs.rmSync(path.join(path.dirname(DEPLOYMENTS_FILE), f), { force: true }); // fresh chain => fresh app state
  console.log(`Deployed router ${router} (fee ${fee} bps) -> ${DEPLOYMENTS_FILE}`);
  return d;
}

if (import.meta.url === `file://${process.argv[1]}`) deployAndSeed().catch((e) => { console.error(e.message ?? e); process.exit(1); });
