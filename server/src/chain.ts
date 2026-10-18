import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, defineChain, type Abi, type Hex, type Address, BaseError, ContractFunctionRevertedError, decodeErrorResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RPC_URL, ROOT, TESTNET_CHAIN_ID, MAINNET_CHAIN_ID, DEPLOYMENTS_FILE } from "./config.js";

export const chain = defineChain({
  id: TESTNET_CHAIN_ID, name: "Robinhood Chain Testnet (or local anvil)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } },
});
export const pub = createPublicClient({ chain, transport: http(RPC_URL), pollingInterval: 200 });

export async function assertChain() {
  const id = await pub.getChainId();
  if (id === MAINNET_CHAIN_ID) throw new Error("REFUSING: RPC_URL points at Robinhood Chain MAINNET (4663). Mainnet needs legal review + founder approval.");
  if (id !== TESTNET_CHAIN_ID) throw new Error(`REFUSING: chainId ${id} != 46630`);
}

const artifact = (file: string, name: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts", "out", file, `${name}.json`), "utf8"));
export function load(name: string, file = `${name}.sol`) {
  const a = artifact(file, name);
  return { abi: a.abi as Abi, bytecode: a.bytecode.object as Hex };
}
export const C = {
  usdg: load("MockUSDG"), stock: load("MockStockToken"), agg: load("MockAggregatorV3"), oracle: load("PriceOracle"),
  registry: load("EligibilityRegistry"), router: load("FeeRouter"), pool: load("StockClawPool"), vault: load("AgentVault"),
};
export const ALL_ABIS: Abi[] = Object.values(C).map((c) => c.abi);

// Per-account serialized tx queue (avoids nonce races between REST, MCP and keeper).
const queues = new Map<string, Promise<unknown>>();
export function wallet(pk: Hex) {
  const account = privateKeyToAccount(pk);
  const client = createWalletClient({ account, chain, transport: http(RPC_URL) });
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = queues.get(account.address) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(account.address, next);
    return next;
  };
  return {
    account, address: account.address, client,
    /** simulate (surfaces revert reason) then send and wait for success */
    write: (address: Address, abi: Abi, functionName: string, args: unknown[] = []) => run(async () => {
      const { request } = await pub.simulateContract({ account, address, abi, functionName, args } as any);
      const hash = await client.writeContract(request as any);
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`tx reverted: ${functionName} ${hash}`);
      return { hash, receipt: r };
    }),
    deploy: (c: { abi: Abi; bytecode: Hex }, args: unknown[] = []) => run(async () => {
      const hash = await client.deployContract({ abi: c.abi, bytecode: c.bytecode, args } as any);
      const r = await pub.waitForTransactionReceipt({ hash });
      if (!r.contractAddress || r.status !== "success") throw new Error("deploy failed");
      return r.contractAddress as Address;
    }),
  };
}
export type Wallet = ReturnType<typeof wallet>;

export const read = <T = any>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args } as any) as Promise<T>;

/** Decode a revert into the custom error name + args, trying every StockClaw ABI. */
export function revertReason(e: unknown): { name: string; args: readonly unknown[] } {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r?.data?.errorName) return { name: r.data.errorName, args: r.data.args ?? [] };
    const raw = (r as any)?.raw as Hex | undefined;
    if (raw) for (const abi of ALL_ABIS) { try { const d = decodeErrorResult({ abi, data: raw }); return { name: d.errorName, args: d.args ?? [] }; } catch {} }
    // nested AdapterSwapFailed(bytes) etc.
    return { name: e.shortMessage, args: [] };
  }
  return { name: String((e as Error)?.message ?? e), args: [] };
}

export type Deployment = {
  chainId: number; rpc: string; deployedAt: string; deployer: Address; keeper: Address; treasury: Address;
  usdg: Address; oracle: Address; registry: Address; router: Address;
  stocks: Record<string, { token: Address; feed: Address; pool: Address; decimals: number }>;
};
export function loadDeployment(): Deployment {
  if (!fs.existsSync(DEPLOYMENTS_FILE)) throw new Error(`No deployment at ${DEPLOYMENTS_FILE}. Run: npm run deploy`);
  return JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, "utf8"));
}
export const isRevert = (e: unknown) => e instanceof BaseError && !!e.walk((x) => x instanceof ContractFunctionRevertedError);
