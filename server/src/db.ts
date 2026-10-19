// SQLite persistence (BACKEND_PLAN §3): WAL, better-sqlite3 (synchronous => no interleaving inside a transaction).
// Tables: accounts, intents, activations, history, basket_proposals, basket_executions, legs, idempotency, jobs, tx_log, nonces.
// Migration: on first open, an existing data/state.json is imported and renamed to state.json.migrated.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { log } from "./log.js";

export const DB_FILE = path.join(DATA_DIR, "stockclaw.db");
let db: Database.Database | undefined;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT);
CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY, status TEXT, activation_id TEXT, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activations(id TEXT PRIMARY KEY, status TEXT, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS basket_proposals(id TEXT PRIMARY KEY, status TEXT, created_at TEXT, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS basket_executions(id TEXT PRIMARY KEY, status TEXT, idem_key TEXT UNIQUE, created_at TEXT, updated_at TEXT, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS legs(leg_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, idx INTEGER NOT NULL, status TEXT NOT NULL, tx_hash TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS legs_exec ON legs(execution_id, idx);
CREATE TABLE IF NOT EXISTS idempotency(key TEXT PRIMARY KEY, scope TEXT NOT NULL, ref TEXT, result TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, dedupe TEXT UNIQUE, payload TEXT, status TEXT NOT NULL DEFAULT 'queued',
  run_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, locked_until INTEGER, last_error TEXT, created_at INTEGER, updated_at INTEGER);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, run_at);
CREATE TABLE IF NOT EXISTS tx_log(hash TEXT PRIMARY KEY, signer TEXT, nonce INTEGER, label TEXT, status TEXT, created_at TEXT, updated_at TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS tx_status ON tx_log(status);
CREATE TABLE IF NOT EXISTS sells(id INTEGER PRIMARY KEY AUTOINCREMENT, vault TEXT, ts INTEGER, usd REAL, tx_hash TEXT, via TEXT);
CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, vault TEXT, status TEXT, created_at TEXT, expires_at TEXT, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS passkeys(id TEXT PRIMARY KEY, owner TEXT, public_key TEXT, counter INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS webauthn_challenges(k TEXT PRIMARY KEY, challenge TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, kind TEXT, key_id TEXT, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS key_trades(id INTEGER PRIMARY KEY AUTOINCREMENT, key_id TEXT, ts INTEGER, side TEXT, usd REAL, ref TEXT);
CREATE INDEX IF NOT EXISTS key_trades_k ON key_trades(key_id, ts);
CREATE TABLE IF NOT EXISTS key_breaker(key_id TEXT PRIMARY KEY, tripped INTEGER, tripped_at INTEGER, resumed_at INTEGER, reason TEXT);
CREATE TABLE IF NOT EXISTS nonces(signer TEXT PRIMARY KEY, next INTEGER NOT NULL, updated_at TEXT);
`;
export function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL"); db.pragma("synchronous = NORMAL"); db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  try { db.exec("ALTER TABLE jobs ADD COLUMN result TEXT"); } catch { /* already there */ }
  return db;
}
export const tx = <T>(fn: () => T): T => getDb().transaction(fn)();
export const nowIso = () => new Date().toISOString();

// ---- legacy state.json migration
export function migrateFromJson(): Record<string, any> | null {
  const d = getDb(), file = path.join(DATA_DIR, "state.json");
  if (d.prepare("SELECT 1 FROM accounts WHERE id='default'").get() || !fs.existsSync(file)) return null;
  const S = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.renameSync(file, file + ".migrated");
  log.info("migrated state.json into SQLite", { orders: Object.keys(S.orders ?? {}).length, history: (S.history ?? []).length, activations: Object.keys(S.activations ?? {}).length, db: DB_FILE });
  return S;
}
