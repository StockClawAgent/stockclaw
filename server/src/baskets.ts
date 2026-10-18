// Themed baskets (BASKETS.md): registry (baskets.json + server/baskets/<id>/<version>.json, sha256-pinned),
// preview (split <= $98, >= $5 legs, headroom), auto-execution within the onchain limits, sequential leg execution as a
// durable job with idempotency keys, persisted per-leg state, partial status and one retry on transport errors only.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { erc20Abi, parseEventLogs, type Address, type Hex } from "viem";
import { C, read, pub, isRevert } from "./chain.js";
import * as svc from "./service.js";
import * as cfg from "./config.js";
import * as jobs from "./jobs.js";
import { getDb, tx, nowIso } from "./db.js";
import { log, withCtx } from "./log.js";

const ApiError = svc.ApiError;
const RULES = { minLegUsd: 5, maxLegUsd: 98, maxBasketUsd: cfg.MAX_PER_DAY_USD, previewTtlSec: 60, proposalTtlSec: 600 };
export const DISCLAIMER = "Themes are groupings we picked for convenience. Weights are fixed and published. Not investment advice. Buys within your vault's onchain limits run automatically. Testnet tokens have no value. Legs execute one by one (no atomicity across legs).";

// ---------------------------------------------------------------- registry
/** Python json.dumps(sort_keys=True, separators=(',',':')) compatible; weightPct is a float in the source files. */
function pyCanon(v: unknown, key = ""): string {
  if (Array.isArray(v)) return "[" + v.map((x) => pyCanon(x)).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + pyCanon((v as any)[k], k)).join(",") + "}";
  if (typeof v === "number" && key === "weightPct" && Number.isInteger(v)) return v.toFixed(1);
  if (typeof v === "string") return JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  return JSON.stringify(v);
}
const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
export const basketHash = (b: Record<string, unknown>) => { const { hash: _h, ...rest } = b; return sha(pyCanon(rest)); };
type Ticker = { ticker: string; name: string; weightPct: number; weightBps?: number; marketCapUsd: number };
type Basket = { id: string; theme: string; version: string; tickers: Ticker[]; hash: string; chainId?: number; executableLocally?: boolean; rulesNote?: string; asOf?: string; source: string };
let REG: Basket[] | undefined;
export function registry(): Basket[] {
  if (REG) return REG;
  const out: Basket[] = [], refuse: string[] = [];
  const site = JSON.parse(fs.readFileSync(path.join(cfg.REPO, "baskets.json"), "utf8"));
  for (const b of site.baskets) out.push({ ...b, source: "baskets.json", asOf: site.asOf });
  const dir = path.join(cfg.ROOT, "baskets");
  for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) for (const f of fs.readdirSync(path.join(dir, id)).filter((x) => x.endsWith(".json")))
    out.push({ ...JSON.parse(fs.readFileSync(path.join(dir, id, f), "utf8")), source: `server/baskets/${id}/${f}` });
  for (const b of out) if (verifyRaw(b) !== b.hash) refuse.push(`${b.id}@${b.version}`);
  if (refuse.length) throw new Error(`basket hash mismatch (refusing to serve): ${refuse.join(", ")}`);
  return (REG = out);
}
function verifyRaw(b: Basket) { const { source: _s, ...rest } = b as any; if (b.source === "baskets.json") delete rest.asOf; return basketHash(rest); }
const bps = (b: Basket) => b.tickers.map((t) => ({ ...t, weightBps: t.weightBps ?? Math.round(t.weightPct * 100) }));
function findBasket(id: string, version?: string) {
  const all = registry().filter((b) => b.id === id);
  if (!all.length) throw new ApiError(404, `Unknown basket ${id}. Known: ${[...new Set(registry().map((b) => b.id))].join(", ")}`);
  const b = version ? all.find((x) => x.version === version) : all.sort((a, z) => z.version.localeCompare(a.version))[0];
  if (!b) throw new ApiError(404, `Unknown version ${version} of ${id}`);
  return b;
}
function executability(b: Basket): { executable: boolean; reason: string | null } {
  if (!b.executableLocally) return { executable: false, reason: `Not executable locally: ${b.theme} uses mainnet registry tickers (${b.tickers.map((t) => t.ticker).join(", ")}) that have no StockClaw pool on the local/testnet chain. Listed for information only.` };
  const missing = b.tickers.filter((t) => !svc.dep().stocks[t.ticker]).map((t) => t.ticker);
  return missing.length ? { executable: false, reason: `No local pool for ${missing.join(", ")}` } : { executable: true, reason: null };
}

export function list_baskets() {
  return registry().map((b) => { const e = executability(b); return { id: b.id, version: b.version, basketHash: b.hash, name: b.theme, legs: bps(b).map((t) => ({ symbol: t.ticker, weightBps: t.weightBps })), chainAvailable: e.executable, executable: e.executable, notExecutableReason: e.reason, thin: b.tickers.length < 4 }; });
}
export async function get_basket(id: string, version?: string) {
  const b = findBasket(id, version), e = executability(b);
  const legs = await Promise.all(bps(b).map(async (t) => {
    let priceUsd: number | null = null, tradable = false, reason: string | null = e.reason;
    if (e.executable) { try { priceUsd = (await svc.get_price(t.ticker)).priceUsd; await svc._poolFor("mUSDG", t.ticker); tradable = true; reason = null; } catch (x) { reason = (x as Error).message; } }
    return { symbol: t.ticker, name: t.name, weightBps: t.weightBps, marketCapUsd: t.marketCapUsd, priceUsd, tradable, reason };
  }));
  return { id: b.id, version: b.version, basketHash: b.hash, name: b.theme, source: b.source, asOf: b.asOf ?? null, rulesNote: b.rulesNote ?? null, executable: e.executable, notExecutableReason: e.reason, legs, rules: RULES, disclaimer: DISCLAIMER, editorial: "Theme membership is our editorial classification, not Robinhood's." };
}

// ---------------------------------------------------------------- sizing
/** Per-ticker dollars: weights, drop names whose leg < $5 (smallest market cap first, re-normalise), floor to cents, remainder to largest. */
export function sizeTickers(tickers: { ticker: string; weightBps: number; marketCapUsd: number }[], usd: number) {
  let names = [...tickers]; const skipped: { symbol: string; reason: string }[] = [];
  for (;;) {
    const tot = names.reduce((s, t) => s + t.weightBps, 0);
    const legs = names.map((t) => ({ ...t, usd: Math.floor((usd * t.weightBps) / tot * 100) / 100 }));
    const small = legs.filter((l) => l.usd < RULES.minLegUsd);
    if (!small.length || names.length === 1) {
      const rem = Math.round((usd - legs.reduce((s, l) => s + l.usd, 0)) * 100) / 100;
      const top = legs.reduce((a, l) => (l.usd > a.usd ? l : a)); top.usd = Math.round((top.usd + rem) * 100) / 100;
      return { legs, skipped };
    }
    const drop = small.reduce((a, l) => (l.marketCapUsd < a.marketCapUsd ? l : a));
    skipped.push({ symbol: drop.ticker, reason: `leg under $${RULES.minLegUsd} minimum; weight redistributed` });
    names = names.filter((n) => n.ticker !== drop.ticker);
  }
}
/** Split a ticker's dollars into swaps of <= $98: $98 chunks + remainder (BASKETS.md: $125 = $98 + $27); if the
 * remainder would be under the $5 minimum, split into equal sub-legs instead (e.g. $100.02 = $50.01 + $50.01). */
export function splitLeg(usd: number) {
  const M = RULES.maxLegUsd, n = Math.ceil(usd / M - 1e-9);
  if (n === 1) return [usd];
  const rest = Math.round((usd - M * (n - 1)) * 100) / 100;
  if (rest >= RULES.minLegUsd) return [...Array(n - 1).fill(M), rest] as number[];
  const base = Math.floor((usd / n) * 100) / 100, parts = Array(n).fill(base);
  parts[0] = Math.round((usd - base * (n - 1)) * 100) / 100;
  return parts as number[];
}

// ---------------------------------------------------------------- preview / preflight
async function headroom() {
  const a = svc._agent(), spent = await svc._spentLast24h();
  const daily = Math.min(a?.dailyCap ?? cfg.MAX_PER_DAY_USD, cfg.MAX_PER_DAY_USD);
  return { perTrade: Math.min(a?.perTradeCap ?? cfg.MAX_PER_TRADE_USD, cfg.MAX_PER_TRADE_USD), remaining24h: Math.max(0, +(daily - spent).toFixed(2)) };
}
type PlanLeg = { idx: number; ticker: string; weight: number; targetUsd: number; amountIn: number; quotedOut: number; minOut: number; feeUsd: number };
async function plan(b: Basket, usd: number, slippageBps: number) {
  const { legs: per, skipped } = sizeTickers(bps(b).map((t) => ({ ticker: t.ticker, weightBps: t.weightBps, marketCapUsd: t.marketCapUsd })), usd);
  const tot = per.reduce((s, t) => s + t.weightBps, 0), out: PlanLeg[] = [], failures: string[] = [];
  for (const t of per) for (const part of splitLeg(t.usd)) {
    let quotedOut = 0, minOut = 0, feeUsd = 0;
    try { const q = await svc.quote_swap("mUSDG", t.ticker, part, slippageBps); quotedOut = q.amountOut; minOut = q.minOut; feeUsd = q.feeAmount; if (!(quotedOut > 0)) failures.push(`${t.ticker}: quote() returned 0`); }
    catch (e) { failures.push(`${t.ticker}: ${(e as Error).message}`); }
    out.push({ idx: out.length, ticker: t.ticker, weight: +(t.weightBps / tot).toFixed(4), targetUsd: part, amountIn: part, quotedOut, minOut, feeUsd: +feeUsd.toFixed(4) });
  }
  return { legs: out, skipped, failures };
}
async function preflight(b: Basket, legs: PlanLeg[], total: number) {
  const f: string[] = [], d = svc.dep();
  const e = await svc.check_eligibility(); if (!e.eligible || !e.expiresAt) f.push(`Not eligible: ${e.reason ?? "attestation required"}`);
  const a = svc._agent(); if (!svc._vault()) f.push("No smart account"); if (!a || a.status !== "active") f.push("Agent key not active (revoked or missing)");
  const marketOpen = await read<boolean>(d.oracle, C.oracle.abi, "isMarketOpen"); if (!marketOpen) f.push("Market closed");
  let oracleFresh = true;
  for (const t of new Set(legs.map((l) => l.ticker))) {
    if (a && !a.allowlist.includes(t)) f.push(`${t} not on the agent allowlist`);
    try { await svc._poolFor("mUSDG", t); } catch (x) { f.push((x as Error).message); }
    try { await read(d.oracle, C.oracle.abi, "priceE8", [d.stocks[t].token]); } catch { oracleFresh = false; f.push(`${t} price feed stale or halted`); }
  }
  const h = await headroom(); if (total > h.remaining24h + 1e-9) f.push(`Total $${total.toFixed(2)} exceeds the $${h.remaining24h.toFixed(2)} left in the vault's rolling-24h buy cap`);
  return { failures: f, marketOpen, oracleFresh, headroom: h };
}
const putProposal = (p: any) => getDb().prepare("INSERT INTO basket_proposals(id, status, created_at, json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, json=excluded.json").run(p.previewId, p.status, p.createdAt, JSON.stringify(p));
const getProposal = (id: string) => { const r = getDb().prepare("SELECT json FROM basket_proposals WHERE id=?").get(id) as { json: string } | undefined; return r ? JSON.parse(r.json) : null; };

export async function preview_basket_buy(id: string, usd: number, o: { version?: string; allowScaleDown?: boolean; slippageBps?: number } = {}) {
  const b = findBasket(id, o.version), e = executability(b);
  if (!e.executable) throw new ApiError(409, e.reason!);
  if (!(usd >= RULES.minLegUsd && usd <= RULES.maxBasketUsd)) throw new ApiError(400, `usd must be $${RULES.minLegUsd}-$${RULES.maxBasketUsd} (default max basket)`);
  const slip = o.slippageBps ?? cfg.DEFAULT_SLIPPAGE_BPS; if (!(slip > 0 && slip <= cfg.MAX_SLIPPAGE_BPS)) throw new ApiError(400, "slippageBps must be in (0, 300]");
  const h = await headroom(); let total = Math.round(usd * 100) / 100, scaledDown = false;
  if (total > h.remaining24h) {
    if (!o.allowScaleDown) throw new ApiError(403, `Blocked: $${total.toFixed(2)} is over the $${h.remaining24h.toFixed(2)} left in the vault's $${cfg.MAX_PER_DAY_USD} rolling-24h buy cap (sells are exempt). Pass allowScaleDown:true to fit it.`);
    total = Math.floor(h.remaining24h * 100) / 100; scaledDown = true;
    if (total < RULES.minLegUsd) throw new ApiError(403, "Blocked: not enough buy headroom left today");
  }
  const p = await plan(b, total, slip), pf = await preflight(b, p.legs, total);
  const failures = [...p.failures, ...pf.failures];
  const previewId = "bp_" + randomBytes(6).toString("hex"), now = Date.now();
  const preview = { previewId, basketId: b.id, basketVersion: b.version, basketHash: b.hash, name: b.theme, usdRequested: usd, totalUsd: total, slippageBps: slip,
    legs: p.legs.map(({ idx: _i, ...l }) => ({ symbol: l.ticker, ...l })), totalFeeUsd: +p.legs.reduce((s, l) => s + l.feeUsd, 0).toFixed(4), skipped: p.skipped, swaps: p.legs.length,
    capHeadroom: pf.headroom, scaledDown, marketOpen: pf.marketOpen, oracleFresh: pf.oracleFresh, preflight: { ok: !failures.length, failures },
    status: "preview", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + RULES.previewTtlSec * 1000).toISOString(),
    requiresOwnerConfirmation: false, autoExecutesWithinLimits: true, atomic: false, disclaimer: DISCLAIMER };
  putProposal(preview);
  return preview;
}

// ---------------------------------------------------------------- propose / confirm
/** Policy (Julius 2026-10-18): trades inside the onchain limits auto-execute. A basket buy (agent or owner) that passes
 * preflight runs right away; the owner sees every leg in the activity feed and can revoke the key. */
export async function buy_basket(a: { previewId?: string; id?: string; usd?: number; version?: string; allowScaleDown?: boolean }, _by: "agent" | "owner", idemKey?: string) {
  if (idemKey) { const prev = idemGet(`buy:${idemKey}`); if (prev) return get_execution(prev.ref); }
  let p = a.previewId ? getProposal(a.previewId) : null;
  if (a.previewId && !p) throw new ApiError(404, "Unknown previewId");
  if (!p) { if (!a.id || !a.usd) throw new ApiError(400, "previewId or (id, usd) required"); p = await preview_basket_buy(a.id, a.usd, { version: a.version, allowScaleDown: a.allowScaleDown }); }
  if (p.status === "confirmed") { idemKey && idemPut(`buy:${idemKey}`, "execution", p.executionId); return get_execution(p.executionId); }
  if (Date.parse(p.expiresAt) < Date.now()) throw new ApiError(410, "Preview expired (quotes are stale after 60s); preview again");
  if (!p.preflight.ok) throw new ApiError(409, `Preflight failed: ${p.preflight.failures.join("; ")}`);
  const s = svc._agent(); if (s) svc._trade()?.guard(s.id, "basket-preflight:" + p.previewId); // tripped key => refuse before creating the execution
  return start_execution(p.previewId, idemKey);
}
/** Pins the basket hash, creates the execution + legs (pending) and enqueues the job. Idempotent per key / preview. */
export function start_execution(proposalId: string, idemKey?: string) {
  const key = `buy:${idemKey ?? "preview:" + proposalId}`;
  const r = tx(() => {
    const prev = idemGet(key); if (prev) return { id: prev.ref, fresh: false };
    const p = getProposal(proposalId); if (!p) throw new ApiError(404, "Unknown proposal");
    if (p.status === "confirmed") { idemPut(key, "execution", p.executionId); return { id: p.executionId as string, fresh: false }; }
    if (Date.parse(p.expiresAt) < Date.now()) throw new ApiError(410, "Preview expired; preview again");
    if (findBasket(p.basketId, p.basketVersion).hash !== p.basketHash) throw new ApiError(409, "Basket definition changed since preview (hash mismatch); preview again");
    const id = "bx_" + randomBytes(6).toString("hex"), now = nowIso();
    const ex = { id, basketId: p.basketId, basketVersion: p.basketVersion, basketHash: p.basketHash, totalUsd: p.totalUsd, slippageBps: p.slippageBps, proposalId, idempotencyKey: key, createdAt: now, updatedAt: now };
    getDb().prepare("INSERT INTO basket_executions(id, status, idem_key, created_at, updated_at, json) VALUES(?,?,?,?,?,?)").run(id, "pending", key, now, now, JSON.stringify(ex));
    const il = getDb().prepare("INSERT INTO legs(leg_id, execution_id, idx, status, json) VALUES(?,?,?,?,?)");
    p.legs.forEach((l: any, i: number) => { const legId = "leg_" + createHash("sha256").update(`${id}:${i}`).digest("hex").slice(0, 16); il.run(legId, id, i, "pending", JSON.stringify({ legId, ticker: l.symbol, weight: l.weight, targetUsd: l.targetUsd, filledUsd: 0 })); });
    p.status = "confirmed"; p.executionId = id; putProposal(p); idemPut(key, "execution", id);
    return { id, fresh: true };
  });
  if (r.fresh) { jobs.enqueue("basket.execute", { executionId: r.id }, { dedupe: `basket:${r.id}`, maxAttempts: 3 }); log.info("basket started", { executionId: r.id, idempotencyKey: key }); }
  return get_execution(r.id);
}

// ---------------------------------------------------------------- idempotency
function idemGet(key: string) { const r = getDb().prepare("SELECT scope, ref FROM idempotency WHERE key=?").get(key) as { scope: string; ref: string } | undefined; return r ? { kind: r.scope, ref: r.ref } : null; }
function idemPut(key: string, scope: string, ref: string) { getDb().prepare("INSERT OR IGNORE INTO idempotency(key, scope, ref, created_at) VALUES(?,?,?,?)").run(key, scope, ref, nowIso()); }

// ---------------------------------------------------------------- execution state
type LegRow = { legId: string; ticker: string; weight: number; targetUsd: number; filledUsd: number; status: "pending" | "filling" | "filled" | "failed"; txHash?: string; error?: string; amountOut?: number; attempts?: number };
const legsOf = (id: string): (LegRow & { idx: number })[] => (getDb().prepare("SELECT idx, status, tx_hash, json FROM legs WHERE execution_id=? ORDER BY idx").all(id) as any[]).map((r) => ({ ...JSON.parse(r.json), idx: r.idx, status: r.status, ...(r.tx_hash ? { txHash: r.tx_hash } : {}) }));
function setLeg(id: string, l: LegRow) { const { status, txHash, ...rest } = l as any; delete rest.idx; getDb().prepare("UPDATE legs SET status=?, tx_hash=?, json=? WHERE leg_id=?").run(status, txHash ?? null, JSON.stringify(rest), l.legId); touch(id); }
function setStatus(id: string, status: string) { getDb().prepare("UPDATE basket_executions SET status=?, updated_at=? WHERE id=?").run(status, nowIso(), id); }
function touch(id: string) { getDb().prepare("UPDATE basket_executions SET updated_at=? WHERE id=?").run(nowIso(), id); }
export function get_execution(id: string) {
  const r = getDb().prepare("SELECT status, created_at, updated_at, json FROM basket_executions WHERE id=?").get(id) as any;
  if (!r) throw new ApiError(404, "Unknown basket execution");
  const ex = JSON.parse(r.json);
  return { id, basketId: ex.basketId, basketVersion: ex.basketVersion, basketHash: ex.basketHash, totalUsd: ex.totalUsd, status: r.status as "pending" | "running" | "partial" | "filled" | "failed", createdAt: r.created_at, updatedAt: r.updated_at,
    legs: legsOf(id).map((l) => ({ legId: l.legId, ticker: l.ticker, weight: l.weight, targetUsd: l.targetUsd, filledUsd: l.filledUsd, status: l.status, ...(l.txHash ? { txHash: l.txHash } : {}), ...(l.error ? { error: l.error } : {}) })) };
}
export function list_executions(limit = 20) { return (getDb().prepare("SELECT id FROM basket_executions ORDER BY created_at DESC LIMIT ?").all(limit) as { id: string }[]).map((r) => get_execution(r.id)); }
function finalStatus(id: string) {
  const ls = legsOf(id), filled = ls.filter((l) => l.status === "filled").length;
  const s = filled === ls.length ? "filled" : filled > 0 ? "partial" : "failed";
  setStatus(id, s); return s;
}

// ---------------------------------------------------------------- fault injection (e2e only; local chain only)
type Faults = { revertLeg?: number; transientOnceLeg?: number; crashAfterSubmitLeg?: number };
let faults: Faults = {};
export const _setFaults = (f: Faults) => { if (!cfg.IS_LOCAL) throw new Error("faults are local-only"); faults = { ...f }; };

// ---------------------------------------------------------------- leg execution
async function outFromReceipt(hash: Hex, tokenOut: Address, vault: Address, dec: number) {
  const rc = await pub.getTransactionReceipt({ hash });
  if (rc.status !== "success") return { ok: false as const, out: 0 };
  const logs = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: rc.logs }).filter((l) => l.address.toLowerCase() === tokenOut.toLowerCase() && l.args.to.toLowerCase() === vault.toLowerCase());
  return { ok: true as const, out: Number(logs.reduce((s, l) => s + l.args.value, 0n)) / 10 ** dec };
}
/** Run one leg. Returns false to stop the basket. Never resubmits a leg that has a tx hash (reconciles by receipt instead). */
async function runLeg(exId: string, l: LegRow & { idx: number }, slippageBps: number): Promise<boolean> {
  return withCtx({ executionId: exId, legId: l.legId }, async () => {
    const vault = svc._vault()!, t = svc._token(l.ticker);
    if (l.status === "filling" && l.txHash) { // in flight when the process died: settle by receipt
      try { const r = await outFromReceipt(l.txHash as Hex, t.address, vault, t.decimals);
        if (r.ok) { setLeg(exId, { ...l, status: "filled", filledUsd: l.targetUsd, amountOut: r.out }); log.info("leg reconciled from receipt", { txHash: l.txHash }); return true; }
        setLeg(exId, { ...l, status: "failed", error: "Transaction reverted" }); return false;
      } catch { /* no receipt: dropped => safe to re-send below (nonce resynced) */ l.txHash = undefined; log.warn("in-flight leg tx not found; resending"); }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      setLeg(exId, { ...l, status: "filling", txHash: undefined, error: undefined, attempts: (l.attempts ?? 0) + 1 });
      try {
        if (faults.transientOnceLeg === l.idx) { faults.transientOnceLeg = undefined; throw Object.assign(new Error("HTTP request failed: fetch failed (simulated RPC timeout)"), { transient: true }); }
        svc._trade()?.guard(svc._agent()!.id, exId); // anomaly breaker: a basket counts as one trade
        const q = await svc.quote_swap("mUSDG", l.ticker, l.targetUsd, slippageBps);
        let minOutRaw = svc._units(q.minOut, t.decimals);
        if (faults.revertLeg === l.idx) { faults.revertLeg = undefined; minOutRaw = minOutRaw * 1000n; } // forces InsufficientOutput onchain
        const pool = await svc._poolFor("mUSDG", l.ticker), usdg = svc._token("mUSDG");
        const deadline = BigInt((await svc.chainNow()) + 300);
        const { hash } = await svc._agentWallet().write(vault, C.vault.abi, "agentSwap", [pool, usdg.address, t.address, svc._units(l.targetUsd, 6), minOutRaw, deadline], {
          label: `basket:${l.legId}`,
          onSubmitted: (h) => { setLeg(exId, { ...l, status: "filling", txHash: h }); if (faults.crashAfterSubmitLeg === l.idx) { faults.crashAfterSubmitLeg = undefined; throw new jobs.SimulatedCrash(); } },
        });
        const r = await outFromReceipt(hash, t.address, vault, t.decimals);
        setLeg(exId, { ...l, status: "filled", filledUsd: l.targetUsd, amountOut: r.out, txHash: hash });
        svc._pushHistory({ txHash: hash, explorerUrl: svc._txOut(hash).explorerUrl, type: "basket", in: `${l.targetUsd.toFixed(2)} mUSDG`, out: `${r.out.toFixed(6)} ${l.ticker}`, fee: `${(l.targetUsd * 0.003).toFixed(4)} mUSDG`, ts: nowIso(), status: "filled", side: "buy", executionId: exId, keyId: svc._agent()!.id, usd: l.targetUsd });
        svc._trade()?.record(svc._agent()!.id, "buy", l.targetUsd, exId);
        log.info("leg filled", { txHash: hash, usd: l.targetUsd, out: r.out });
        return true;
      } catch (e) {
        if (e instanceof jobs.SimulatedCrash) throw e;
        if (e instanceof ApiError) { const cur0 = legsOf(exId).find((x) => x.legId === l.legId)!; setLeg(exId, { ...cur0, status: "failed", error: e.message }); log.warn("leg refused", { reason: e.message }); return false; }
        const reverted = isRevert(e) || /tx reverted/.test((e as Error).message);
        const cur = legsOf(exId).find((x) => x.legId === l.legId)!;
        if (!reverted && !cur.txHash && attempt === 0) { log.warn("leg transport error; one retry", { error: (e as Error).message.slice(0, 200) }); continue; } // tx never sent => safe to retry once
        const reason = reverted ? svc.humanReason(e) : `Transport error: ${(e as Error).message.slice(0, 160)}`;
        setLeg(exId, { ...cur, status: "failed", error: reason });
        svc._pushHistory({ txHash: null, type: "basket", in: `${l.targetUsd.toFixed(2)} mUSDG`, out: "—", fee: "—", ts: nowIso(), status: "blocked", reason, side: "buy", executionId: exId });
        log.warn("leg failed; basket stops (no auto-retry of reverts)", { reason });
        return false;
      }
    }
    return false;
  });
}
jobs.register("basket.execute", async ({ executionId }: { executionId: string }) => {
  const r = getDb().prepare("SELECT status, json FROM basket_executions WHERE id=?").get(executionId) as any;
  if (!r || ["filled", "partial", "failed"].includes(r.status)) return;
  const ex = JSON.parse(r.json);
  setStatus(executionId, "running");
  for (const l of legsOf(executionId)) {
    if (l.status === "filled") continue;
    if (l.status === "failed") break;
    if (!(await runLeg(executionId, l, ex.slippageBps))) break;
  }
  log.info("basket finished", { executionId, status: finalStatus(executionId) });
});
jobs.register("basket.retryLeg", async ({ executionId, legId }: { executionId: string; legId: string }) => {
  const ex = JSON.parse((getDb().prepare("SELECT json FROM basket_executions WHERE id=?").get(executionId) as any).json);
  const l = legsOf(executionId).find((x) => x.legId === legId);
  if (l && l.status !== "filled") await runLeg(executionId, l, ex.slippageBps);
  finalStatus(executionId);
});

/** Owner-only: retry ONE failed leg. Idempotent: a leg that is already being retried / filled just returns state. */
export function retry_leg(executionId: string, legId: string) {
  const res = tx(() => {
    const st = (getDb().prepare("SELECT status FROM basket_executions WHERE id=?").get(executionId) as any)?.status;
    if (!st) throw new ApiError(404, "Unknown basket execution");
    const l = legsOf(executionId).find((x) => x.legId === legId);
    if (!l) throw new ApiError(404, "Unknown legId");
    if (l.status === "filled" || l.status === "filling") return false; // repeat call: no new tx
    if (l.status !== "failed") throw new ApiError(409, `Only failed legs can be retried (leg is ${l.status})`);
    if (st === "running" || st === "pending") throw new ApiError(409, "Execution still running");
    const { idx: _i, ...row } = l; setLeg(executionId, { ...row, status: "pending", error: undefined } as LegRow); setStatus(executionId, "running");
    return true;
  });
  if (res) jobs.enqueue("basket.retryLeg", { executionId, legId }, { maxAttempts: 1 });
  return get_execution(executionId);
}
export function resetBaskets() { const d = getDb(); for (const t of ["basket_proposals", "basket_executions", "legs", "idempotency"]) d.prepare(`DELETE FROM ${t}`).run(); jobs._purge("basket."); }
svc.onReset(resetBaskets);
