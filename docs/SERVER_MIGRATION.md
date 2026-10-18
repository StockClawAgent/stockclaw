# Server migration: contract interface changes since 7656854
For `server/` (I haven't edited it). It covers every change from 7656854 through 5491737 (see §10 for the latest batch). Rebuild ABIs from `out/` after `forge build`.

## 1. Contracts removed / renamed
| Before (7656854) | Now |
|---|---|
| `OrderExecutor` (escrow DCA/limit, `createDCA`, `createLimitOrder`, `claim`) | **Removed.** Use the signed EIP-712 intents in `FeeRouter.executeIntent` (no escrow; funds pulled by allowance). |
| `MockDexAdapter`, `MockERC20` | Removed. Use `StockClawPool` (oracle-anchored) and `MockUSDG`. |
| `TokenChecks` / `IRestrictedToken` probes (`paused`/`isFrozen`/`canTransfer`) | Removed. Optional `ITokenComplianceAdapter` per token (default none) via `router.setComplianceAdapter(token, adapter)`. |

## 2. FeeRouter
- **Constructor:** `(owner, feeTreasury /*2-of-3 Safe*/, permit2, oracle, eligibility)`. Fee defaults to 30 bps, range 0–50, taken from the **input** token.
- **Keeper:** `setKeeper(address)` (single keeper, emits `KeeperSet`). The old `setKeeper(address,bool)`, `isKeeper()` and `setPermissionlessExecution()` are **gone**. `executeIntent` can be called only by the keeper, or by the account itself (vault path).
- **`swap` / `swapWithPermit2`:**
  - `minAmountOut == 0` reverts with `ZeroMinOut`.
  - There's a **mandatory oracle floor**: output must be ≥ oracle-implied × (1 − `maxSlippageBps`). The default is 300; the owner can set 1–300 with `setMaxSlippageBps`. Quote with `router.quote()` and send `minOut = quote × (1 − your slippage)`, which must be > 0.
  - **The recipient must be the account itself or eligible** (`NotEligible(recipient)`).
  - The market must be open (`MarketClosed`).
- **Intent struct** (unchanged field order): `minOutPerExec` must be > 0, `0 < maxOracleDevBps ≤ 300`, otherwise `InvalidIntent` / `ZeroMinOut`.
- **DCA has no catch-up.** State is `intentState(hash) → (execs, nextExecAt)` (`execCount(hash)` still exists). After a run, `nextExecAt` moves to the next future interval boundary. The keeper should read `nextExecAt` and treat `NotYet` as benign.
- `quote(adapter, tokenIn, tokenOut, amountIn)` returns **`(netOut, fee)`**. That's 2 values; the 3rd value (`feeToken`) was removed.
- `precheck(account, tokenIn, tokenOut, amountIn, recipient)` checks eligibility (account and recipient), pause, market open, and the compliance-adapter legs including fee→Safe. Without an adapter, issuer blocks are only seen at execution.
- **New errors to decode:**
  - `TransferBlocked(token, from, to, issuerRevertData)`: frozen/paused/registry.
  - `AdapterSwapFailed(adapter, reason)`: wraps pool errors.
  - `ComplianceBlocked(token, from, to, reason)`, `MarketClosed`, `ZeroMinOut`, `SlippageOutOfBounds`, `NotEligible(addr)`, `NotKeeper`, `NotYet(nextAt)`, `IntentExhausted`, `LimitNotMet`, `InvalidIntent`, `InsufficientOutput`.

## 3. StockClawPool: oracle-anchored (CTO decision)
- **Constructor:** `(owner, stock, usdg, oracle, spreadBps)`. **`spreadBps` must be 10–30** (the deploy and tests use 20). The old 5th param `bandBps` is gone, along with `setBand`, `bandBps()`, `poolPriceE8()` and the curve.
- **Pricing:** fills at oracle price × (1 − spread), capped by reserves (`InsufficientLiquidity(out, reserve)`). `quote()` equals exactly what `swap()` delivers in the same block. There's no price impact.
- `setSpread(bps)` emits `SpreadSet`. `valueUsd()` returns reserves at the oracle price.
- **Only the router can swap.** Quotes revert when the market is closed or the feed is stale.

## 4. PriceOracle: market sessions (fail-closed)
- **Removed:** `setSchedule`, `openMinute`/`closeMinute`, and the `MarketMode.Schedule/Open/Closed` modes.
- **`MarketMode` is now `{Session, ForceClosed, ForceOpen}`.** `setMarketMode` is **owner-only** (the Safe). `ForceOpen` is **testnet/demo only**.
- **The keeper must push each session** with `setSession(uint64 openAt, uint64 closeAt)`, using unix seconds in UTC from the exchange calendar. That calendar handles daylight saving (e.g. Nov 2 2026 is 14:30–21:00 UTC), holidays (don't push anything for Thanksgiving) and half-days.
  - Rules: `closeAt > openAt`, `closeAt − openAt ≤ 8h`, and `closeAt > now`. Otherwise it reverts with `BadSession`.
  - Trading is open only when `openAt ≤ now < closeAt`. **No session, or an expired one, means CLOSED.** Push the next session before it opens (e.g. pre-market).
  - Emits `SessionSet`.
- **After deploy, the market is CLOSED** until a session is pushed, or the Safe sets `ForceOpen` for a demo.
- `setKeeper` (emits `KeeperSet`). `priceE8` reverts with `MarketClosed` / `StalePrice` (>1h) / `BadPrice` (≤0). USDG is always $1.

## 5. MockAggregatorV3: price updater (separate key, S-4)
- **The updater is a different key from the keeper** (Deploy requires `FEED_UPDATER != KEEPER`). Only the updater can call `updateAnswer`, and it should push every 60s.
- **N-1 time-scaled move limit.** An update may move the price by at most `min(maxDeltaBpsPerHour × elapsed / 1h, maxDeltaCapBps)` relative to the last accepted answer. Defaults: 10%/h, capped at 20%. At a 60s cadence that's about 0.16% per push.
  - A push in the same block as the last accepted one can't change the price at all.
  - A rejected push (`DeltaTooLarge`) leaves the old answer in place. The allowance grows with time, so retry with the new price at the next tick. If no update is accepted for >1h, trading halts.
- `setMaxDeltaBps` was **replaced** by `setMaxDelta(perHourBps, capBps)` (owner, emits `MaxDeltaSet`). The aggregator is now Ownable2Step.

## 6. EligibilityRegistry
- Eligibility is **keyed to the owner EOA** (`setEligible(owner, expiry)` by the attester).
- **Vaults inherit it:** the eligible owner must call `registry.linkAccount(vault)` once after creating the vault. The link breaks if vault ownership changes or the owner's eligibility expires.
- Don't call `setEligible(vault, ...)` anymore. It still works, but it bypasses the owner binding.

## 7. AgentVault
- **Hard protocol maximums:** `MAX_PER_TRADE_USD = 100e6`, `MAX_PER_DAY_USD = 500e6`. `setCaps` can only **lower** them (`CapAboveProtocolMax`); `perTradeUsd == 0` and `perTrade > perDay` both revert with `InvalidParams`.
- **Rolling 24h window** (25 hourly buckets) replaces the UTC day. A spend stops counting between 24h and 25h after it happened.
  - `remainingToday(agent)` returns `min(agent left, vault left)`.
  - `spentLast24h(agent)` and **`vaultSpentLast24h()`** are new.
- **S-2: the $500/24h cap is per VAULT.** All agent keys share it (`VaultDailyCapExceeded(wouldSpend, 500e6)`). Re-issuing keys no longer resets anything. Per-agent caps (≤ the vault's) still apply.
- **Per-trade cap** is $100 per trade, measured on the USD value of **tokenIn**, which applies to sells too.
- **`agentSwap` oracle floor:** the vault replaces a lower `minOut` with the oracle floor (net of fee, minus `maxSlippageBps`).
- **`executeIntent(intent, agentSig)`** can be called only by the **router keeper or the vault owner** (`NotKeeper`). The intent needs `account = vault` and is signed by the agent over `router.hashIntent(intent)`.
- **Errors:** `PerTradeCapExceeded(usd, cap)`, `DailyCapExceeded(wouldSpend, cap)`, `VaultDailyCapExceeded`, `TokenNotAllowed(token)`, `NotAgent`, `AgentExpired`, `CapAboveProtocolMax`.

## 8. Strategy rules the server must enforce
- **S-7: split sells into slices of ≤ $98** of oracle USD value (CTO decision). A take-profit on a $100 rung is worth more than $100 and would revert with `PerTradeCapExceeded` **by design**. The caps aren't changing. Sells also count against the vault's $500/24h, so show "TP blocked by limit" when that happens.
- Back off on `DailyCapExceeded` / `VaultDailyCapExceeded` until `vaultSpentLast24h()` frees up (S-8). Don't retry every tick.
- Treat `NotYet`, `LimitNotMet` and `MarketClosed` as benign keeper outcomes.

## 9. Deploy (script/Deploy.s.sol; never run by me)
- **Env vars:** `TREASURY_SAFE`, `FEED_UPDATER`, `KEEPER` (different from `FEED_UPDATER`), `ATTESTER`, and an **explicit `MOCK_TOKENS=0|1`**. Unset or any other value reverts (`MockTokensFlagRequired`). With `MOCK_TOKENS=0` and real tokens missing, it reverts with `RealTokenMissing(token)`.
- **Chain:** 46630 only (local anvil must use `--chain-id 46630`).
- **Pools:** spread 20 bps, the same as the tests (`test_R2_band20bps_liveness` uses the exact deploy params). Feeds use 1h staleness.
- **Ownership** of the router, oracle, pools and feeds is transferred to the Safe **two-step**. The Safe must execute `acceptOwnership()` on each one; until then the deployer stays owner (needed for seeding). The Safe also gets registry admin. After acceptance, the deployer should renounce registry admin.

## 10. Batch after 43f82c8 (8c0bc7b, 5491737, c14819c)
- **N-4: the router checks the route.** Every swap and intent reverts with `PairNotSupported(adapter, tokenIn, tokenOut)` unless the adapter is registered **and** `adapter.supportsPair(tokenIn, tokenOut)`. Use `router.isRouteSupported(adapter, tokenIn, tokenOut)` (a view that never reverts) to pick the pool for a ticker before quoting. `IDexAdapter` gains `supportsPair`, and `StockClawPool` implements it.
- **Exit exemption (CTO decision):**
  - **What's exempt:** a sell of an allowlisted stock **into USDG** (`tokenOut == oracle.usdg()`, `tokenIn != USDG`) through a registered pool for exactly that pair. It does **not** count toward the rolling 24h caps, neither the agent's nor the vault's $500. Use `vault.isExemptExit(adapter, tokenIn, tokenOut)`. Output always lands in the vault.
  - **What still applies:** $100 per trade (keep slicing sells at ≤ $98), allowlist (**both** the stock and USDG must be allowlisted), oracle floor and market hours.
  - **What still counts:** USDG→stock buys, stock→stock and any sell into a non-USDG token. Cycling buy/sell can't buy more than $500 per 24h.
  - **UI:** "Exits don't use your daily limit". `remainingToday` and `vaultSpentLast24h()` only reflect buys and token→token trades now.
- **S-4 test:** `oracle.setMarketMode` from the keeper reverts with `OwnableUnauthorizedAccount(keeper)`.

## R4-1: per-vault agent SELL cap + owner sell approvals (final)
- Agent sells (stock -> USDG, registered pool, recipient = vault) do not count toward the $500 buy window. They use their own per-vault rolling 24h **sell** cap: protocol max $500 (`MAX_SELL_PER_DAY_USD`). The owner can lower it with `setSellCap` but can never raise it. Same 25-bucket ring as buys.
- If a sell goes over the cap it reverts with `VaultSellCapExceeded(vault, needUsd, remainingUsd)`. Owner trades (`ownerSwap`) are never capped.
- Views: `vaultSoldLast24h()`, `exitRemaining() -> (capLeftUsd, allowanceUsd, allowanceExpiry, totalUsd)`, `sellApprovalDigest(amountUsd, expiry, nonce)`.
- Events: `SellCapSet`, `SellApproved`, `SellAllowanceUsed`, `SellApprovalCancelled`.
- **Keeper queue flow (CTO final):** before each sell slice, check `exitRemaining().totalUsd`. If it doesn't cover the slice, hold the sell and ask the owner for **one approval per held sell**: amount = slice USD x 1.02, expiry = now + 1h (the contract allows up to 7d), and a fresh nonce. The owner signs the EIP-712 `SellApproval(vault, amountUsd, expiry, nonce)` (domain `StockClawVault`/`1`/chainId/vault). The keeper relays it with `approveSellWithSig`, then executes the held sell. Any leftover expires at `expiry` and can't be reused. A new approval replaces the active one. If the owner cancels a nonce with `cancelSellApproval`, relaying that nonce fails with `SellNonceUsed`. An expired approval blocks nothing, so just request a new one.
- **UX (approve-sell screen):** show the token, slice size, USD value incl. 2% buffer, a 1h countdown and the reason ("daily agent sell limit of $X reached"). Offer Approve (sign) and Cancel. After expiry, say the sell was not executed and offer to re-request.
