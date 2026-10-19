// npm run seed:approval — local anvil only. Creates a pending over-cap agent sell approval on the running server
// (POST /api/dev/seed-approval, owner token from OWNER_API_TOKEN or server/.env.demo). Nothing is submitted onchain.
import fs from "node:fs";
const env = fs.existsSync(".env.demo") ? Object.fromEntries(fs.readFileSync(".env.demo", "utf8").split("\n").filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])) : {};
const tok = process.env.OWNER_API_TOKEN || env.OWNER_API_TOKEN;
const base = process.env.API_URL || `http://127.0.0.1:${process.env.PORT || env.PORT || 8787}`;
if (!tok) { console.error("OWNER_API_TOKEN not set (and no server/.env.demo)"); process.exit(1); }
const [ticker, usd] = process.argv.slice(2);
const r = await fetch(`${base}/api/dev/seed-approval`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}`, "x-owner-token": tok }, body: JSON.stringify({ ticker, usd: usd ? Number(usd) : undefined }) });
console.log(r.status, JSON.stringify(await r.json(), null, 2));
process.exit(r.ok ? 0 : 1);
