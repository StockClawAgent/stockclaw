import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, defineChain, type Abi, type Hex, type Address, BaseError, ContractFunctionRevertedError, decodeErrorResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getDb, nowIso } from "./db.js";
import { log } from "./log.js";
import { RPC_URL, ROOT, TESTNET_CHAIN_ID, MAINNET_CHAIN_ID, DEPLOYMENTS_FILE } from "./config.js";  // chain-guard: allow (guard import)

export const chain = defineChain({
  id: TESTNET_CHAIN_ID, name: "Robinhood Chain (or local anvil)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } },
});
export const pub = createPublicClient({ chain, transport: http(RPC_URL), pollingInterval: 200 });

export async function assertChain() {
  const id = await pub.getChainId();
  if (id === MAINNET_CHAIN_ID) throw new Error("REFUSING: RPC_URL points at Robinhood Chain MAINNET (4663). Mainnet needs legal review + founder approval.");  // chain-guard: allow (refuses mainnet)
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

// Per-account serialized tx queue (avoids nonce races between REST, MCP, jobs and keeper) + nonce manager.
// Nonce manager (BACKEND_PLAN §3): one counter per signer, seeded from getTransactionCount(pending) on first use in
// this process, incremented locally inside the signer's serial queue (so concurrent callers never share a nonce),
// persisted to SQLite (nonces), resynced from the chain on "nonce too low"/send failures. Every tx goes to tx_log
// (submitted -> mined | reverted | dropped) so a restart can reconcile in-flight txs by hash.
const queues = new Map<string, Promise<unknown>>();
const nonceNext = new Map<string, number>();
const NONCE_ERR = /nonce too low|nonce.*(already|has been) used|replacement transaction underpriced|already known|NonceTooLow/i;
async function takeNonce(addr: Address) {
  if (!nonceNext.has(addr)) nonceNext.set(addr, await pub.getTransactionCount({ address: addr, blockTag: "pending" }));
  const n = nonceNext.get(addr)!;
  nonceNext.set(addr, n + 1);
  getDb().prepare("INSERT INTO nonces(signer, next, updated_at) VALUES(?,?,?) ON CONFLICT(signer) DO UPDATE SET next=excluded.next, updated_at=excluded.updated_at").run(addr, n + 1, nowIso());
  return n;
}
export const resyncNonce = (addr: string) => { nonceNext.delete(addr as Address); };
export const nonceState = () => Object.fromEntries(nonceNext);
const txLog = (hash: string, f: Partial<{ signer: string; nonce: number; label: string; status: string; error: string }>) => {
  const d = getDb();
  if (f.signer) d.prepare("INSERT OR IGNORE INTO tx_log(hash, signer, nonce, label, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?)").run(hash, f.signer, f.nonce ?? null, f.label ?? null, f.status ?? "submitted", nowIso(), nowIso());
  else d.prepare("UPDATE tx_log SET status=?, error=?, updated_at=? WHERE hash=?").run(f.status, f.error ?? null, nowIso(), hash);
};
export type WriteOpts = { label?: string; onSubmitted?: (hash: Hex) => void; beforeSend?: () => void; nonce?: number };
const SETTLE_TIMEOUT_MS = () => Number(process.env.SETTLE_TIMEOUT_MS ?? 180_000);
/** Status of a tx by hash: mined | reverted | pending (known to the node, no receipt) | unknown (not found / dropped). */
export async function txState(hash: Hex): Promise<"mined" | "reverted" | "pending" | "unknown"> {
  try { const r = await pub.getTransactionReceipt({ hash }); return r.status === "success" ? "mined" : "reverted"; } catch { /* no receipt */ }
  try { await pub.getTransaction({ hash }); return "pending"; } catch { return "unknown"; }
}
export const txLogRow = (hash: string) => getDb().prepare("SELECT hash, signer, nonce, label, status FROM tx_log WHERE hash=?").get(hash) as { hash: Hex; signer: Address; nonce: number; label: string; status: string } | undefined;
/** Wait until any of the hashes has a receipt (a replaced tx and its replacement share a nonce: only one can mine). */
export async function waitAny(hashes: Hex[], timeoutMs: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const h of hashes) { try { const r = await pub.getTransactionReceipt({ hash: h }); return r; } catch { /* not yet */ } }
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${hashes.join(" / ")}`);
}
export function wallet(pk: Hex) {
  const account = privateKeyToAccount(pk);
  const client = createWalletClient({ account, chain, transport: http(RPC_URL) });
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = queues.get(account.address) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(account.address, next);
    return next;
  };
  const send = async (label: string, fn: (nonce: number) => Promise<Hex>, fixedNonce?: number): Promise<Hex> => {
    if (fixedNonce != null) { // re-send at a known nonce (dropped tx): can never mine twice
      const hash = await fn(fixedNonce);
      txLog(hash, { signer: account.address, nonce: fixedNonce, label, status: "submitted" });
      log.info("tx re-sent at the same nonce", { signer: account.address, nonce: fixedNonce, label, txHash: hash });
      return hash;
    }
    for (let attempt = 0; ; attempt++) {
      const nonce = await takeNonce(account.address);
      try {
        const hash = await fn(nonce);
        txLog(hash, { signer: account.address, nonce, label, status: "submitted" });
        log.debug("tx submitted", { signer: account.address, nonce, label, txHash: hash });
        return hash;
      } catch (e) {
        resyncNonce(account.address); // the nonce may or may not be consumed: re-read pending from the chain
        if (attempt === 0 && NONCE_ERR.test(String((e as Error)?.message))) { log.warn("nonce conflict, resynced", { signer: account.address, nonce, label }); continue; }
        throw e;
      }
    }
  };
  const settle = async (hash: Hex, label: string) => {
    const r = await pub.waitForTransactionReceipt({ hash, timeout: SETTLE_TIMEOUT_MS() });
    if (r.transactionHash.toLowerCase() !== hash.toLowerCase()) { txLog(hash, { status: "replaced" }); txLog(r.transactionHash, { status: r.status === "success" ? "mined" : "reverted" }); }
    else txLog(hash, { status: r.status === "success" ? "mined" : "reverted" });
    if (r.status !== "success") throw new Error(`tx reverted: ${label} ${hash}`);
    return r;
  };
  return {
    account, address: account.address, client,
    /** simulate (surfaces revert reason) then send with a managed nonce and wait for success */
    write: (address: Address, abi: Abi, functionName: string, args: unknown[] = [], opts: WriteOpts = {}) => (opts.nonce != null ? (f: () => Promise<any>) => f() : run)(async () => {
      const { request } = await pub.simulateContract({ account, address, abi, functionName, args } as any);
      const label = opts.label ?? functionName;
      opts.beforeSend?.();
      const hash = await send(label, (nonce) => client.writeContract({ ...(request as any), nonce }), opts.nonce);
      opts.onSubmitted?.(hash);
      const receipt = await settle(hash, label);
      return { hash, receipt };
    }),
    /** Speed-up: re-send a PENDING tx (same to/data/value) at the SAME nonce with higher fees. Bypasses the signer
     * queue on purpose: no new nonce is taken, so the original and the replacement can never both mine. */
    speedUp: async (hash: Hex, label: string) => {
      const t = await pub.getTransaction({ hash });
      if (t.from.toLowerCase() !== account.address.toLowerCase()) throw new Error("speedUp: not this signer's tx");
      const fees = await pub.estimateFeesPerGas().catch(() => ({ maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }));
      const bump = (x: bigint | undefined | null) => ((x ?? 0n) * 3n) / 2n + 1n;
      const maxPriorityFeePerGas = [bump(t.maxPriorityFeePerGas ?? t.gasPrice), fees.maxPriorityFeePerGas ?? 0n].reduce((a, b) => (a > b ? a : b));
      let maxFeePerGas = [bump(t.maxFeePerGas ?? t.gasPrice), fees.maxFeePerGas ?? 0n].reduce((a, b) => (a > b ? a : b));
      if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas;
      const h2 = await client.sendTransaction({ account, chain, to: t.to!, data: t.input, value: t.value, nonce: t.nonce, gas: t.gas, maxFeePerGas, maxPriorityFeePerGas } as any);
      txLog(h2, { signer: account.address, nonce: t.nonce, label: `${label}:speedup`, status: "submitted" });
      txLog(hash, { status: "replacing" });
      log.warn("tx sped up (same nonce)", { signer: account.address, nonce: t.nonce, old: hash, txHash: h2 });
      return h2;
    },
    deploy: (c: { abi: Abi; bytecode: Hex }, args: unknown[] = []) => run(async () => {
      const hash = await send("deploy", (nonce) => client.deployContract({ abi: c.abi, bytecode: c.bytecode, args, nonce } as any));
      const r = await settle(hash, "deploy");
      if (!r.contractAddress) throw new Error("deploy failed");
      return r.contractAddress as Address;
    }),
  };
}
/** Restart recovery: settle every tx still marked submitted (receipt by hash; unknown to the node => dropped). */
export async function reconcileTxLog() {
  const rows = getDb().prepare("SELECT hash, label FROM tx_log WHERE status='submitted'").all() as { hash: Hex; label: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) {
    let status = "submitted";
    try { const rc = await pub.getTransactionReceipt({ hash: r.hash }); status = rc.status === "success" ? "mined" : "reverted"; }
    catch { try { await pub.getTransaction({ hash: r.hash }); status = "submitted"; } catch { status = "dropped"; } }
    if (status !== "submitted") txLog(r.hash, { status });
    out[r.hash] = status;
  }
  if (rows.length) log.info("reconciled in-flight txs", { count: rows.length, result: out });
  return out;
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
