// Central error vocabulary (UX): every error response is { code, message, retryable, hint?, error }.
// `message` is one plain sentence for users; `error` keeps the detailed technical text (back-compat, logs).
// Contract revert names and server reasons both map here, so the UI never has to parse strings.
export type UserError = { code: string; message: string; retryable: boolean; hint?: string };
type Rule = { re: RegExp; code: string; message: string; retryable: boolean; hint?: string };
const RULES: Rule[] = [
  { re: /Preview expired|expired; preview again|quotes are stale/i, code: "PREVIEW_EXPIRED", message: "This preview has expired.", retryable: true, hint: "Preview again for fresh prices." },
  { re: /VaultSellCapExceeded|sell limit|pending owner approval/i, code: "SELL_CAP_EXCEEDED", message: "This sell is over your agent's daily sell limit, so it needs your approval.", retryable: false, hint: "Approve it under Approvals with your passkey." },
  { re: /anomaly breaker|key is paused|breaker/i, code: "KEY_PAUSED", message: "Your agent key is paused because of unusual activity.", retryable: false, hint: "Check the activity feed, then resume the key if it looks right." },
  { re: /VaultDailyCapExceeded|DailyCapExceeded|rolling-24h (buy )?cap|24h cap/i, code: "BUY_CAP_EXCEEDED", message: "Your agent has used up its daily buy limit.", retryable: false, hint: "Buying frees up as the 24-hour window rolls. Sells still work." },
  { re: /PerTradeCapExceeded|per-trade cap|per leg/i, code: "PER_TRADE_CAP", message: "This trade is over the per-trade limit for your agent.", retryable: false, hint: "Use a smaller amount or split it into several trades." },
  { re: /MarketClosed|market (is )?closed|BadSession/i, code: "MARKET_CLOSED", message: "The stock market is closed right now.", retryable: true, hint: "Try again when the market opens." },
  { re: /Price moved|InsufficientOutput|AdapterSwapFailed|Slippage|minOut|ZeroMinOut|SlippageOutOfBounds/i, code: "PRICE_MOVED", message: "The price moved before the trade went through, so nothing was bought or sold.", retryable: true, hint: "Get a fresh quote and try again." },
  { re: /StalePrice|stale|NoFeed|BadPrice|InvalidAnswer|oracle|OracleFloor|DeltaTooLarge/i, code: "PRICE_UNAVAILABLE", message: "Prices are briefly unavailable, so trading is paused for safety.", retryable: true, hint: "Try again in a minute." },
  { re: /InsufficientLiquidity|liquidity/i, code: "LOW_LIQUIDITY", message: "There isn't enough liquidity for a trade this size.", retryable: false, hint: "Try a smaller amount." },
  { re: /TokenNotAllowed|allowlist|AdapterNotAllowed/i, code: "TOKEN_NOT_ALLOWED", message: "Your agent isn't allowed to trade this stock.", retryable: false, hint: "Add it to the agent key's allowlist." },
  { re: /PairNotSupported|BadPair|not supported|SameToken/i, code: "PAIR_NOT_SUPPORTED", message: "This trading pair isn't supported.", retryable: false },
  { re: /NotAgent|revoked|No agent key|AgentExpired|expired agent/i, code: "KEY_INACTIVE", message: "Your agent key is revoked or expired.", retryable: false, hint: "Create a new agent key to keep trading." },
  { re: /NotEligible|OwnerNotEligible|not eligible|blocked region|Not available in/i, code: "NOT_ELIGIBLE", message: "This account isn't eligible to trade here.", retryable: false },
  { re: /TransferBlocked|ComplianceBlocked|\bFrozen\b|\bPaused\b/, code: "TRANSFER_BLOCKED", message: "The token issuer blocked this transfer.", retryable: false },
  { re: /step-up|stepUp/i, code: "STEP_UP_REQUIRED", message: "Confirm with an existing passkey first.", retryable: true },
  { re: /Passkey verification failed|passkey/i, code: "PASSKEY_FAILED", message: "The passkey check didn't go through.", retryable: true, hint: "Try again with your registered passkey." },
  { re: /FaucetCooldown|cooldown/i, code: "COOLDOWN", message: "Please wait a bit before trying that again.", retryable: true },
  { re: /Timed out|timeout/i, code: "TIMEOUT", message: "This took too long and was stopped safely.", retryable: true, hint: "Retry it. Nothing will be duplicated." },
  { re: /Transport error|fetch failed|ECONNREFUSED|HTTP request failed|RPC/i, code: "NETWORK", message: "We couldn't reach the network.", retryable: true, hint: "Try again in a moment." },
  { re: /Owner token required|bearer token|token required/i, code: "AUTH_REQUIRED", message: "Sign in as the owner to do this.", retryable: false },
];
const BY_STATUS: Record<number, UserError> = {
  400: { code: "BAD_REQUEST", message: "Something in that request isn't valid.", retryable: false },
  401: { code: "AUTH_REQUIRED", message: "Sign in as the owner to do this.", retryable: false },
  403: { code: "FORBIDDEN", message: "That action isn't allowed.", retryable: false },
  404: { code: "NOT_FOUND", message: "We couldn't find that.", retryable: false },
  409: { code: "CONFLICT", message: "That can't be done in the current state.", retryable: false },
  410: { code: "EXPIRED", message: "That has expired.", retryable: true },
  423: { code: "KEY_PAUSED", message: "Your agent key is paused because of unusual activity.", retryable: false },
  429: { code: "RATE_LIMITED", message: "Too many requests. Please slow down for a moment.", retryable: true, hint: "Wait a few seconds and retry." },
  451: { code: "NOT_ELIGIBLE", message: "This service isn't available in your region.", retryable: false },
  503: { code: "UNAVAILABLE", message: "The service is briefly unavailable.", retryable: true },
};
export function toUserError(detail: string, status = 500): UserError {
  if (status === 429) return BY_STATUS[429];
  if (status === 451) return BY_STATUS[451];
  const r = RULES.find((x) => x.re.test(detail ?? ""));
  if (r) return { code: r.code, message: r.message, retryable: r.retryable, ...(r.hint ? { hint: r.hint } : {}) };
  return BY_STATUS[status] ?? { code: "INTERNAL", message: "Something went wrong on our side.", retryable: true, hint: "Try again. If it keeps happening, check /healthz." };
}
