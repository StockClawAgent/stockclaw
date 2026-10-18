// npm run passkey:status — lists registered owner passkeys (no secrets). Register the presenter's passkey BEFORE the demo:
// while none exists, any owner-token holder can register the first one (R6-3 bootstrap).
import { getDb, DB_FILE } from "../src/db.js";
const rows = getDb().prepare("SELECT id, owner, counter, created_at FROM passkeys ORDER BY created_at").all() as { id: string; owner: string; counter: number; created_at: string }[];
console.log(JSON.stringify({ db: DB_FILE, count: rows.length, passkeys: rows.map((r) => ({ credentialId: r.id.slice(0, 10) + "…", owner: r.owner, createdAt: r.created_at, signCount: r.counter })),
  note: rows.length ? "Bootstrap closed: adding a passkey needs a step-up assertion from an existing one." : "NO PASSKEY YET: register the presenter's passkey now (dashboard > Approvals > Register passkey) before going on stage." }, null, 2));
