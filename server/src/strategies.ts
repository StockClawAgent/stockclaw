// Strategy agents (STRATEGIES.md): registry with versioned, content-hashed, pinned definitions; Steady Stacker
// and Dip Hunter executed by the keeper as signed intents. Security (audit/strategies-review.md S-3):
// the agent/MCP can only PROPOSE; activation, switching and resume need the owner token (dashboard), which
// records the pinned strategyHash. The keeper runs only owner-confirmed activations.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { keccak256, toHex, concat } from "viem";
import * as svc from "./service.js";
import { ApiError } from "./service.js";
import * as cfg from "./config.js";
import { nextSessionStart } from "./marketCalendar.js";

export const STRATEGIES_DIR = path.join(cfg.ROOT, "strategies");
const TICKERS = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"];
const MAX_SLICE_USD = 98; // S-7

// ---------------------------------------------------------------- registry + hashing
const canon = (v: any): string => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v);
export function strategyHash(prompt: string, schema: unknown, version: string) {
  return keccak256(concat([toHex(prompt), toHex(canon(schema)), toHex(version)]));
}
type Def = { id: string; version: string; name: string; summary: string; runsIn: string; risks: string[]; defaults: any; demoAvailable: boolean; comingSoon?: boolean; changelog?: string[];
  prompt?: string; schema?: any; strategyHash: string | null; promptName: string | null; tampered?: boolean };
export function loadRegistry(dir = STRATEGIES_DIR): Def[] {
  const catalog = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json"), "utf8"));
  const lockFile = path.join(dir, "strategies.lock.json");
  const lock: Record<string, string> = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, "utf8")) : {};
  return catalog.map((c: any) => {
    if (c.comingSoon) return { ...c, strategyHash: null, promptName: null };
    const base = path.join(dir, c.id, c.version);
    const prompt = fs.readFileSync(path.join(base, "prompt.md"), "utf8"), schema = JSON.parse(fs.readFileSync(path.join(base, "schema.json"), "utf8"));
    const h = strategyHash(prompt, schema, c.version);
    return { ...c, prompt, schema, strategyHash: h, promptName: `stockclaw.${c.id}.v${c.version.split(".")[0]}`, tampered: lock[`${c.id}@${c.version}`] !== h };
  });
}
/** `npm run strategies:lock`: pin the current hashes (review + commit the lock file). */
export function writeLock(dir = STRATEGIES_DIR) {
  const lock = Object.fromEntries(loadRegistry(dir).filter((d) => d.strategyHash).map((d) => [`${d.id}@${d.version}`, d.strategyHash]));
  fs.writeFileSync(path.join(dir, "strategies.lock.json"), JSON.stringify(lock, null, 2) + "\n");
  return lock;
}
let REG: Def[] | undefined;
const reg = () => (REG ??= loadRegistry());
function def(id: string, version?: string): Def {
  const d = reg().find((x) => x.id === id && (!version || x.version === version));
  if (!d) throw new ApiError(404, `Unknown strategy ${id}${version ? "@" + version : ""}`);
  return d;
}
function usable(d: Def) {
  if (d.comingSoon || !d.demoAvailable) throw new ApiError(400, `${d.name} is coming soon`);
  if (d.tampered) throw new ApiError(500, `Strategy ${d.id}@${d.version} definition does not match its pinned hash; refusing to sign`);
}
const pub = (d: Def) => ({ id: d.id, version: d.version, strategyHash: d.strategyHash, name: d.name, summary: d.summary, runsIn: d.runsIn, paramsSchema: d.schema ?? null, defaults: d.defaults, risks: d.risks, demoAvailable: d.demoAvailable && !d.tampered, comingSoon: !!d.comingSoon });
export const list_strategies = async () => reg().map(pub);
export const get_strategy = async (id: string, version?: string) => { const d = def(id, version); return { ...pub(d), promptName: d.promptName, prompt: d.prompt ?? null, changelog: d.changelog ?? [] }; };
export const promptsForMcp = () => reg().filter((d) => d.promptName && !d.tampered).map((d) => ({ name: d.promptName!, title: d.name, text: d.prompt! }));

// ---------------------------------------------------------------- validation
type Err = string[];
const int = (v: any) => Number.isInteger(v);
function validateSS(p: any, e: Err) {
  if (!Array.isArray(p.basket) || p.basket.length < 1 || p.basket.length > 5) e.push("basket: 1-5 items");
  else {
    const seen = new Set<string>(); let sum = 0;
    for (const b of p.basket) {
      if (!TICKERS.includes(b?.symbol)) e.push(`basket.symbol must be one of ${TICKERS.join(", ")}`);
      if (seen.has(b?.symbol)) e.push("basket symbols must be unique"); seen.add(b?.symbol);
      if (!int(b?.weightBps) || b.weightBps < 500 || b.weightBps > 10000) e.push("weightBps: integer 500-10000");
      sum += b?.weightBps ?? 0;
      if (typeof p.usdPerPeriod === "number" && (p.usdPerPeriod * (b?.weightBps ?? 0)) / 10000 < 1) e.push(`slice for ${b?.symbol} < $1`);
    }
    if (sum !== 10000) e.push("weights must sum to 10000 bps");
  }
  if (typeof p.usdPerPeriod !== "number" || p.usdPerPeriod < 5 || p.usdPerPeriod > 100) e.push("usdPerPeriod: 5-100");
  if (!["daily", "weekly"].includes(p.period)) e.push("period: daily|weekly");
  if (p.maxPeriods != null && (!int(p.maxPeriods) || p.maxPeriods < 1 || p.maxPeriods > 52)) e.push("maxPeriods: 1-52");
  if (p.oracleDevBps != null && (!int(p.oracleDevBps) || p.oracleDevBps < 10 || p.oracleDevBps > 300)) e.push("oracleDevBps: 10-300");
  if (p.demoIntervalSec != null) { if (!cfg.isLocalChain()) e.push("demoIntervalSec is local-chain only"); else if (!int(p.demoIntervalSec) || p.demoIntervalSec < 60 || p.demoIntervalSec > 120) e.push("demoIntervalSec: 60-120"); }
}
function validateDH(p: any, e: Err) {
  if (!TICKERS.includes(p.symbol)) e.push(`symbol must be one of ${TICKERS.join(", ")}`);
  if (p.referencePrice != null && p.referencePrice !== "oracle_at_start") e.push("referencePrice: only oracle_at_start in the demo (high_7d_keeper coming soon)");
  if (!Array.isArray(p.dropsBps) || p.dropsBps.length < 1 || p.dropsBps.length > 4 || p.dropsBps.some((x: any) => !int(x) || x < 100 || x > 3000)) e.push("dropsBps: 1-4 integers 100-3000");
  if (typeof p.usdPerRung !== "number" || p.usdPerRung < 5 || p.usdPerRung > MAX_SLICE_USD) e.push(`usdPerRung: 5-${MAX_SLICE_USD}`);
  if (!int(p.takeProfitBps) || p.takeProfitBps < 100 || p.takeProfitBps > 5000) e.push("takeProfitBps: 100-5000");
  if (p.sellFractionBps != null && (!int(p.sellFractionBps) || p.sellFractionBps < 1000 || p.sellFractionBps > 10000)) e.push("sellFractionBps: 1000-10000");
  if (p.expiryDays != null && (!int(p.expiryDays) || p.expiryDays < 1 || p.expiryDays > 7)) e.push("expiryDays: 1-7");
  if (p.oracleDevBps != null && (!int(p.oracleDevBps) || p.oracleDevBps < 10 || p.oracleDevBps > 300)) e.push("oracleDevBps: 10-300");
}
const withDefaults = (d: Def, p: any) => ({ ...Object.fromEntries(Object.entries(d.schema.properties).filter(([, v]: any) => v.default !== undefined).map(([k, v]: any) => [k, v.default])), ...p });

type Planned = { type: "DCA" | "Limit"; role: "dca" | "rung"; tokenIn: string; tokenOut: string; amountUsd: number; trigger: string; startTime: number; interval?: number; intervalLabel?: string; maxExecs: number; limitPrice?: number; expiry: number; devBps: number; rung?: number };
async function plan(d: Def, params: any): Promise<{ errors: Err; params: any; planned: Planned[]; worst: number }> {
  const e: Err = []; const p = withDefaults(d, params ?? {});
  (d.id === "steady-stacker" ? validateSS : validateDH)(p, e);
  if (e.length) return { errors: e, params: p, planned: [], worst: 0 };
  const now = await svc.chainNow();
  const planned: Planned[] = [];
  let worst = 0;
  if (d.id === "steady-stacker") {
    const interval = p.demoIntervalSec ?? (p.period === "daily" ? 86400 : 604800);
    const start = cfg.isLocalChain() ? now : Math.floor(nextSessionStart(new Date(now * 1000), 90).getTime() / 1000);
    for (const b of p.basket) {
      const amt = +((p.usdPerPeriod * b.weightBps) / 10000).toFixed(6);
      planned.push({ type: "DCA", role: "dca", tokenIn: "mUSDG", tokenOut: b.symbol, amountUsd: amt, trigger: `every ${p.demoIntervalSec ? interval + "s (demo)" : p.period}`, startTime: start, interval, intervalLabel: p.demoIntervalSec ? `${interval}s` : p.period, maxExecs: p.maxPeriods, expiry: start + interval * p.maxPeriods + 3600, devBps: p.oracleDevBps });
    }
    worst = p.usdPerPeriod * Math.min(p.maxPeriods, Math.ceil(86400 / interval));
  } else {
    const ref = (await svc.get_price(p.symbol)).priceUsd;
    p.referencePriceUsd = ref;
    const expiry = now + p.expiryDays * 86400;
    p.dropsBps.forEach((drop: number, k: number) => {
      const lp = +(ref * (1 - drop / 10000)).toFixed(4);
      planned.push({ type: "Limit", role: "rung", tokenIn: "mUSDG", tokenOut: p.symbol, amountUsd: p.usdPerRung, trigger: `${p.symbol} <= $${lp} (-${drop / 100}%)`, startTime: now, maxExecs: 1, limitPrice: lp, expiry, devBps: p.oracleDevBps, rung: k + 1 });
    });
    worst = p.dropsBps.length * p.usdPerRung; // take-profit sells (stock -> USDG) are exempt from the 24h cap (5491737)
  }
  return { errors: e, params: p, planned, worst: +worst.toFixed(2) };
}
async function headroom() {
  const w = await svc.get_wallet();
  const spent = w.sessionKey?.spentToday ?? 0, cap = w.sessionKey?.dailyCap ?? cfg.MAX_PER_DAY_USD;
  return { spent24h: spent, remaining24h: Math.max(0, cap - spent) };
}

export async function preview_strategy(id: string, version: string | undefined, params: any) {
  const d = def(id, version); usable(d);
  const r = await plan(d, params);
  const h = await headroom();
  return { valid: r.errors.length === 0, errors: r.errors, strategyHash: d.strategyHash, params: r.params,
    plannedIntents: r.planned.map((x) => ({ type: x.type, tokenIn: x.tokenIn, tokenOut: x.tokenOut, amountUsd: x.amountUsd, trigger: x.trigger, startTime: new Date(x.startTime * 1000).toISOString() })),
    worstCaseUsdPer24h: r.worst, capHeadroom: +(h.remaining24h - r.worst).toFixed(2) };
}

// ---------------------------------------------------------------- proposals & activations (state in service S.activations)
type Activation = { activationId: string; strategyId: string; version: string; strategyHash: string; params: any; status: "pending" | "active" | "paused" | "stopped" | "completed" | "error" | "rejected";
  proposedBy: "agent" | "owner"; proposedAt: string; confirmedBy?: "owner"; confirmedAt?: string; intentIds: string[]; fills: { intentId: string; txHash: string; role: string; ts: string }[]; note?: string };
const A = (): Record<string, Activation> => { const S = svc._state(); return (S.activations ??= {}); };
const vaultActive = () => Object.values(A()).find((a) => ["active", "paused"].includes(a.status));

/** Agent (MCP) or owner: creates a PENDING proposal only. Nothing is signed. */
export async function choose_strategy(id: string, version: string | undefined, params: any, confirmHash: string, proposedBy: "agent" | "owner") {
  const d = def(id, version); usable(d);
  if (!confirmHash || confirmHash !== d.strategyHash) throw new ApiError(409, "confirmHash must equal the strategyHash from preview_strategy");
  const r = await plan(d, params);
  if (r.errors.length) throw new ApiError(400, `Invalid params: ${r.errors.join("; ")}`);
  const activationId = "act_" + randomBytes(5).toString("hex");
  A()[activationId] = { activationId, strategyId: d.id, version: d.version, strategyHash: d.strategyHash!, params: r.params, status: "pending", proposedBy, proposedAt: new Date().toISOString(), intentIds: [], fills: [] };
  svc._save();
  return { activationId, strategyHash: d.strategyHash, intents: [], status: "pending", requiresOwnerConfirmation: true, confirmVia: `POST /api/strategies/proposals/${activationId}/confirm (owner token)` };
}

async function signPlan(a: Activation) {
  const d = def(a.strategyId, a.version); usable(d);
  if (d.strategyHash !== a.strategyHash) throw new ApiError(409, "Pinned strategyHash no longer matches the registry; re-select the strategy");
  const r = await plan(d, a.params);
  if (r.errors.length) throw new ApiError(400, r.errors.join("; "));
  if (d.id === "dip-hunter") a.params.referencePriceUsd = r.params.referencePriceUsd;
  const ids: string[] = [];
  for (const x of r.planned) {
    const o = await svc._createIntent({ type: x.type, tokenIn: x.tokenIn, tokenOut: x.tokenOut, amount: x.amountUsd, interval: x.interval, intervalLabel: x.intervalLabel, maxExecs: x.maxExecs, limitPrice: x.limitPrice, startTime: x.startTime, expiry: x.expiry, devBps: x.devBps, activationId: a.activationId, role: x.role, rung: x.rung });
    ids.push(o.intentId);
  }
  a.intentIds.push(...ids);
  return ids;
}
/** OWNER ONLY (dashboard). Confirms a pending proposal, pins its hash, signs intents. replace=true stops the current one (switch). */
export async function confirm_proposal(activationId: string, confirmHash: string, replace = false) {
  const a = A()[activationId];
  if (!a || a.status !== "pending") throw new ApiError(404, "No pending proposal with that id");
  if (confirmHash !== a.strategyHash) throw new ApiError(409, "confirmHash does not match the proposal's strategyHash");
  const cur = vaultActive();
  if (cur) { if (!replace) throw new ApiError(409, `Strategy ${cur.activationId} is ${cur.status}; one per vault. Stop it or confirm with replace=true`); await stop_strategy(cur.activationId); }
  const k = svc._agent(); if (!k || k.status !== "active") throw new ApiError(409, "Issue an agent key first");
  a.status = "active"; a.confirmedBy = "owner"; a.confirmedAt = new Date().toISOString();
  await signPlan(a);
  svc._save();
  return status(a);
}
export async function reject_proposal(activationId: string) {
  const a = A()[activationId]; if (!a || a.status !== "pending") throw new ApiError(404, "No pending proposal with that id");
  a.status = "rejected"; svc._save(); return { activationId, status: "rejected" };
}
async function cancelOpen(a: Activation) {
  const cancelled: string[] = [];
  for (const id of a.intentIds) {
    const o = svc._state().orders[id];
    if (o && o.status === "open") { await svc.cancel_order(id, "auto"); cancelled.push(String(o.intent.nonce)); }
  }
  return cancelled;
}
/** Agent or owner (safe direction). */
export async function pause_strategy(activationId: string) {
  const a = A()[activationId]; if (!a || a.status !== "active") throw new ApiError(409, "Strategy is not active");
  const cancelled = await cancelOpen(a); a.status = "paused"; svc._save();
  return { activationId, status: "paused", cancelled };
}
/** OWNER ONLY. Re-signs fresh intents from stored params under the same pinned hash. */
export async function resume_strategy(activationId: string) {
  const a = A()[activationId]; if (!a || a.status !== "paused") throw new ApiError(409, "Strategy is not paused");
  const k = svc._agent(); if (!k || k.status !== "active") throw new ApiError(409, "Agent key is revoked; issue a new key first");
  a.status = "active"; const ids = await signPlan(a); svc._save();
  return { activationId, status: "active", intents: ids };
}
/** Agent or owner (safe direction). */
export async function stop_strategy(activationId: string) {
  const a = A()[activationId]; if (!a || !["active", "paused", "pending"].includes(a.status)) throw new ApiError(409, "Strategy is not running");
  const cancelled = a.status === "active" ? await cancelOpen(a) : [];
  a.status = "stopped"; svc._save(); return { activationId, status: "stopped", cancelled };
}
function status(a: Activation) {
  const orders = svc._state().orders;
  const intents = a.intentIds.map((id) => orders[id]).filter(Boolean).map((o) => ({ intentId: o.intentId, role: o.role, rung: o.rung, type: o.type, tokenIn: o.tokenIn, tokenOut: o.tokenOut, amount: o.amount, limitPrice: o.limitPrice, status: o.status, nextRunAt: o.nextRunAt ?? null, execs: `${o.execsDone}/${o.maxExecs}`, lastError: o.lastError ?? null }));
  return { activationId: a.activationId, strategyId: a.strategyId, version: a.version, status: a.status, strategyHash: a.strategyHash, params: a.params, proposedBy: a.proposedBy, confirmedBy: a.confirmedBy ?? null, confirmedAt: a.confirmedAt ?? null, intents, fills: a.fills };
}
export async function get_strategy_status(activationId?: string) {
  const all = Object.values(A());
  const a = activationId ? A()[activationId] : (vaultActive() ?? all.filter((x) => x.status === "pending").pop() ?? all[all.length - 1]);
  if (!a) return { status: "none", activations: [] };
  return { ...status(a), ...(await headroom()) };
}
export const list_activations = async () => Object.values(A()).map((a) => ({ activationId: a.activationId, strategyId: a.strategyId, version: a.version, status: a.status, strategyHash: a.strategyHash, proposedBy: a.proposedBy, confirmedBy: a.confirmedBy ?? null }));

// ---------------------------------------------------------------- keeper hooks
/** The keeper only executes strategy intents whose activation is owner-confirmed and active. */
export function intentRunnable(o: { activationId?: string }) {
  if (!o.activationId) return true;
  const a = A()[o.activationId];
  return !!a && a.status === "active" && a.confirmedBy === "owner";
}
/** After a Dip Hunter rung fills: take-profit sell limit(s), each slice <= $98 (S-7). S-10 bounds:
 * tokenIn = filled token, total amount <= received * sellFraction, limit >= fill * (1 + TP). */
export async function onFill(o: any, received: number, fillPrice: number, txHash: string) {
  const a = o.activationId && A()[o.activationId]; if (!a) return;
  a.fills.push({ intentId: o.intentId, txHash, role: o.role, ts: new Date().toISOString() });
  if (a.strategyId === "dip-hunter" && o.role === "rung" && a.status === "active") {
    const p = a.params, sellAmt = received * p.sellFractionBps / 10000, limit = +(fillPrice * (1 + p.takeProfitBps / 10000)).toFixed(4);
    const usd = sellAmt * limit, n = Math.max(1, Math.ceil(usd / MAX_SLICE_USD));
    const per = Math.floor((sellAmt / n) * 1e8) / 1e8; // round down: never sell more than received
    const now = await svc.chainNow();
    for (let i = 0; i < n; i++) {
      try {
        const tp = await svc._createIntent({ type: "Limit", tokenIn: o.tokenOut, tokenOut: "mUSDG", amount: per, maxExecs: 1, limitPrice: limit, startTime: now, expiry: Number(o.intent.expiry), devBps: p.oracleDevBps, activationId: a.activationId, role: "take-profit", rung: o.rung, parent: o.intentId });
        a.intentIds.push(tp.intentId);
      } catch (e) { a.note = `take-profit not placed: ${(e as Error).message}`; }
    }
  }
  refresh(a); svc._save();
}
function refresh(a: Activation) {
  if (a.status !== "active") return;
  const os = a.intentIds.map((id) => svc._state().orders[id]).filter(Boolean);
  if (os.length && os.every((o) => ["filled", "cancelled", "expired"].includes(o.status))) a.status = "completed";
}
export function refreshAll() { Object.values(A()).forEach(refresh); }
/** Revoking the agent key (kill switch) pauses every running activation. */
export function onRevoke() { for (const a of Object.values(A())) if (a.status === "active") a.status = "paused"; }

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === "lock") console.log(writeLock());
/** Display name of the vault's active (or paused) strategy, e.g. "Dip Hunter"; null if none. */
export function activeStrategyName(): string | null { const a = vaultActive(); return a ? (reg().find((d) => d.id === a.strategyId)?.name ?? null) : null; }
