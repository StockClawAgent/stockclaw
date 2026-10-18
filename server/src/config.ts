// Central config. RPC_URL is the switch: local anvil (default) or Robinhood testnet 46630.
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = path.resolve(ROOT, "..");
export const TESTNET_CHAIN_ID = 46630;
export const MAINNET_CHAIN_ID = 4663;

export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
export const IS_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?/.test(RPC_URL);
export const PORT = Number(process.env.PORT ?? 8787);
export const DATA_DIR = process.env.DATA_DIR ?? path.join(ROOT, "data");
export const DEPLOYMENTS_FILE = process.env.DEPLOYMENTS_FILE ?? path.join(DATA_DIR, IS_LOCAL ? "local-46630.json" : "testnet-46630.json");
export const EXPLORER = IS_LOCAL ? "local-anvil" : "https://explorer.testnet.chain.robinhood.com";
export const KEEPER_INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS ?? 60_000);
/** "open" forces market open (local demo only); "schedule" uses the onchain NYSE schedule (halts off-hours). */
export const MARKET_MODE = (process.env.MARKET_MODE ?? (IS_LOCAL ? "open" : "schedule")) as "open" | "schedule";
export const API_TOKEN = process.env.STOCKCLAW_API_TOKEN; // optional bearer for REST writes + /mcp

// Product decisions (ARCHITECTURE.md decisions log).
export const DEFAULT_FEE_BPS = 30;
export const MAX_FEE_BPS = 50;
export const MAX_PER_TRADE_USD = 100;
export const MAX_PER_DAY_USD = 500;
export const MAX_KEY_DAYS = 7;
export const MAX_SLIPPAGE_BPS = 300;
export const DEFAULT_SLIPPAGE_BPS = 100;
/** US, Canada, UK, Switzerland, UAE + comprehensively sanctioned (OFAC) jurisdictions. */
export const BLOCKED_REGIONS: Record<string, string> = {
  US: "United States", PR: "Puerto Rico (US)", GU: "Guam (US)", VI: "US Virgin Islands", AS: "American Samoa (US)", MP: "Northern Mariana Islands (US)", UM: "US Minor Outlying Islands",
  CA: "Canada", GB: "United Kingdom", CH: "Switzerland", AE: "United Arab Emirates",
  CU: "Cuba", IR: "Iran", KP: "North Korea", SY: "Syria", RU: "Russia", "UA-43": "Crimea", "UA-14": "Donetsk", "UA-09": "Luhansk",
};

// Anvil default accounts (public test keys derived from the default mnemonic; local chain ONLY).
import { mnemonicToAccount } from "viem/accounts";
import { bytesToHex } from "viem";
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk"; // public anvil default
const ANVIL_KEYS = Array.from({ length: 10 }, (_, i) => bytesToHex(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }).getHdKey().privateKey!));
type Hex = `0x${string}`;
function key(envName: string, anvilIdx: number): Hex {
  const v = process.env[envName];
  if (v) return v as Hex;
  if (!IS_LOCAL) throw new Error(`${envName} must be set (KMS-backed) when RPC_URL is not local; anvil keys are local-only`);
  return ANVIL_KEYS[anvilIdx] as Hex;
}
// Dev reset bumps the epoch: demo owner + agent pool move to a fresh HD range (local only).
let userEpoch = 0;
export function setUserEpoch(e: number) { userEpoch = e; }
const hd = (i: number) => bytesToHex(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }).getHdKey().privateKey!) as Hex;
export const keys = {
  deployer: () => key("DEPLOYER_KEY", 0),   // admin + attester + mock-token issuer
  keeper: () => key("KEEPER_KEY", 1),       // router keeper + oracle feed updater
  treasury: () => key("TREASURY_KEY", 2),   // fee treasury (testnet: 2/3 Safe address instead)
  demoOwner: () => (IS_LOCAL && userEpoch && !process.env.DEMO_OWNER_KEY ? hd(100 * userEpoch) : key("DEMO_OWNER_KEY", 3)),// stands in for the user's wallet (no wallet connect yet)
  agentPool: (): Hex[] => (process.env.AGENT_KEYS ? (process.env.AGENT_KEYS.split(",") as Hex[]) : IS_LOCAL ? (userEpoch ? Array.from({ length: 20 }, (_, i) => hd(100 * userEpoch + 1 + i)) : ([...ANVIL_KEYS.slice(4)] as Hex[])) : []),
};
/** Country name -> code for the prototype's country picker (it sends names). */
export const COUNTRY_NAMES: Record<string, string> = Object.fromEntries(Object.entries(BLOCKED_REGIONS).map(([k, v]) => [v.toUpperCase(), k]));
