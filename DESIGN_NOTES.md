# StockClaw contracts: design notes (Quintus)
This is an implementation companion to Lucius's ARCHITECTURE.md (authoritative; not modified). Testnet 46630 only. Nothing has been deployed.

## Contracts
| File | Role |
|---|---|
| `src/FeeRouter.sol` | "StockClawRouter". Fee is 30 bps by default with a **hard cap of 50 bps** (`MAX_FEE_BPS`). It's taken from the input token before the swap and sent to `feeTreasury` (the 2-of-3 Safe, set in the constructor and changeable by the owner). Supports approve or **Permit2** SignatureTransfer pulls, **EIP-712 intents** (DCA/limit) with unordered nonces + `cancelNonce`, and SignatureChecker (EOA + ERC-1271). Every swap checks: eligibility, adapter allowlist, deadline, issuer pre-checks, minOut, optional oracle-deviation floor. Pausable, ReentrancyGuard, Ownable2Step. |
| `src/StockClawPool.sol` | **Oracle-anchored** USDG/stock pool. Fills are at the oracle price minus an owner-set spread (10–30 bps, deploy uses 20), capped by reserves. `quote()` equals `swap()` output. Pool value at the oracle price never drops (invariant). Only the router can swap. |
| `src/AgentVault.sol` | The per-user agent wallet (CTO decision: AgentVault only). Owner = user EOA. Agent caps default to **$100/trade and $500 per rolling 24h, both protocol hard maximums that owners can only lower. The $500 is shared per vault across all agent keys (S-2)**; the allowlist is **empty by default** and both tokens in a trade must be listed. Has expiry and revoke. **Every breach is a hard revert.** |
| `src/EligibilityRegistry.sol` | Attester role sets `eligibleUntil[account]`. The router reverts for any non-eligible account. |
| `src/oracle/PriceOracle.sol` | Token→USD over Chainlink-style feeds. A stale feed (>1h) halts trading. A **fail-closed market session**: the keeper pushes `setSession(openAt, closeAt)` (at most 8h, closing in the future) from the exchange calendar, and no session or an expired one means closed. The owner has emergency modes ForceClosed and ForceOpen (testnet only). USDG is pinned at $1. USD values use 6 dp. |
| `src/oracle/MockAggregatorV3.sol` | Chainlink interface. The **price updater** pushes every 60s. It is a separate key from the keeper (S-4). The move limit scales with time (N-1): `min(10%/h × elapsed, 20%)`, owner-set via `setMaxDelta`, so the price can't be compounded within one block. |
| `src/mocks/MockUSDG.sol` | 6 dp, owner mint, public faucet of 1,000 per 24h. |
| `src/mocks/MockStockToken.sol` | Pause / freeze / registry. Used to test issuer restrictions. |
| `src/mocks/MockPermit2.sol` | Unit tests only (simplified signing). Real Permit2 is used on testnet. |
| `src/libraries/TokenTransfers.sol` | Any failing token transfer (freeze/pause/registry revert, false return, no code) becomes `TransferBlocked(token, from, to, issuerRevertData)`. Adapter failures become `AdapterSwapFailed(adapter, reason)`. The whole tx reverts, so funds are never stranded. |
| `src/interfaces/ITokenComplianceAdapter.sol` | An optional pre-check per token (default: none). We'll implement it once Robinhood's real restriction function names are verified. `MockComplianceAdapter` is the example. |
| `script/Deploy.s.sol` | Reverts with `WrongChain` unless `block.chainid == 46630`. It requires an explicit `MOCK_TOKENS=0|1` and reverts if the flag is unset or the real tokens are missing (N-5). Pools use a 20 bps spread (same as the tests). It sets the keeper and updater (different keys) and transfers ownership two-step to the Safe. Never run. |

## Key decisions
1. **No escrow; allowance model for intents.** I dropped my earlier escrow `OrderExecutor` in favour of the CTO's signed-intent design. Funds stay in the user's account until the moment a slice executes, so nothing can be stranded in our contracts if a stock is frozen or paused. In that case a slice simply reverts, its exec counter is unchanged, and the keeper retries later.
2. **Fee on input** (CTO §4). The treasury may therefore receive stock tokens. If the registry blocks the Safe, swaps of that stock revert, so **the Safe must be registry-approved for each stock token** (open question 4).
3. **Daily cap = rolling 24h, using a ring of 25 hourly buckets** (2 buckets per storage word, 13 words per agent). The check sums the buckets for hours [now−24h, now], so a spend stops counting between 24h and 25h after it happened. This is conservative: **no 24h period, including one across midnight, can ever exceed $500**. The cost is that the user may wait up to 1 extra hour. A check costs about 13 SLOADs.
4. **USD valuation** is applied to `amountIn`. USDG counts 1:1. Stocks use the oracle feed (staleness 1h; a stale feed makes the cap check revert, which fails closed).
5. **Vault intents.** The agent signs the router's EIP-712 digest with `account = vault`. The keeper calls `vault.executeIntent`, which verifies the agent, charges caps **per execution**, approves the exact amount, and calls the router. The vault's ERC-1271 always returns invalid, so the router cannot pull vault funds on a signature alone (tested).
6. **Limit semantics.** For a buy (tokenIn = USDG) the order fires when oracle(stock) ≤ limit. For a sell it fires when oracle(stock) ≥ limit. The trigger checks the oracle, not the pool, and the pool output is also floored by `maxOracleDevBps` against oracle-implied output.
7. **Packing.** Router fee config sits in one slot (treasury + bps + flag). Pool reserves + band are in one slot. Vault policy uses 2 slots, with spend tracking in the same slot as the daily cap.
8. via-IR is enabled (stack depth). The build takes about 45s.

## Infra facts verified today (eth_getCode on https://rpc.testnet.chain.robinhood.com, chainId 0xb626)
| Contract | Address | Present? |
|---|---|---|
| Permit2 | 0x000000000022D473030F116dDEE9F6B43aC78BA3 | yes (bytecode; genuineness not hash-verified) |
| Safe L2 singleton v1.4.1 | 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762 | yes |
| Safe v1.4.1 singleton | 0x41675C099F32341bf84BFc5382aF534df5C7461a | yes |
| SafeProxyFactory v1.4.1 | 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67 | yes |
| Safe L2 v1.3.0 / factory v1.3.0 | 0x3E5c…D36E / 0xa6B7…6AB2 | yes |
| ERC-4337 EntryPoint v0.7 / v0.6 | 0x0000000071727De22E5E9d8BAf0edAc6f37da032 / 0x5FF1…2789 | yes |
| Multicall3 | 0xcA11bde05977b3631167028862bE2a173976CA11 | yes |
So **no Safe or Permit2 mocks are needed on testnet**. Create the 2-of-3 treasury with the canonical factory. Bundler availability is a separate question (EntryPoint presence ≠ bundler).

## Changes after CTO decisions + review #1 (commits 5026818, fb76009)
- **Single keeper** (`router.keeper`, `oracle.keeper`). The key lives in cloud KMS (AWS/GCP); it can only execute and has no custody. Rotate it with `setKeeper`. Vault intents may be triggered by the keeper or the vault owner.
- **DCA has no catch-up.** After each slice, `nextExecAt` moves to the first interval boundary that is strictly in the future. Missed slices are skipped and don't consume `maxExecs`.
- **Eligibility is keyed to the owner EOA** that signed the attestation. A vault inherits it through `linkAccount` (called by the eligible owner). The link breaks if vault ownership changes or the owner's eligibility expires. Recipients must be the account itself or eligible (M-4).
- **Slippage (H-1):** `minOut > 0` is required. There is a mandatory oracle floor, `maxSlippageBps` (default 300, owner-settable from 1 to 300), which intents and callers can only tighten. Intents need `0 < maxOracleDevBps ≤ 300` and `minOutPerExec > 0`. The vault replaces an agent's minOut with the oracle floor when the floor is higher.
- **Fee:** 0–50 bps, default 30, taken from the input token.
- **Own pool only.** No Uniswap adapter.

## Fork test (M-5c)
`test/fork/RobinhoodFork.t.sol` is read-only: it forks 46630, deploys into the local fork EVM only, and broadcasts nothing. It's skipped unless `RH_TESTNET_RPC` is set. **It ran and passed on Oct 18** against the public RPC. All 5 real tokens (TSLA 0xC9f9…Bd4E, AMZN 0x5884…9E02, PLTR 0x1FBE…98d0, NFLX 0x3b82…8C93, AMD 0x7117…778d, all 18 dp) bought and sold through router→pool, with the fee in the input token reaching the Safe address. Caveat: balances were seeded with `deal()` (a storage write) and the Safe address was a placeholder. The real registry may treat the actual Safe or our deployed addresses differently, so re-run it once the Safe exists.

## Pre-mainnet items
- **Registry approval:** the Safe treasury, router, every pool and every AgentVault must be approved by the issuer's transfer registry (and must not be frozen) for each real stock token. If not, every swap of that stock reverts with `TransferBlocked`. This is a no-op for mock tokens. Before using real tokens, run a fork test on 46630 that swaps each stock through router→pool→Safe (review-1 M-5c).
- Implement `ITokenComplianceAdapter` for the real issuer ABI.
- Real oracle (Chainlink + sequencer uptime + `answeredInRound`), a consumer-side max-move check, and a timelock on `setFeeBps`. Transfer ownership to the Safe (2-step).
- M-5a: the fee stays in the input token (CTO decision). A frozen or unregistered Safe will block sells of that stock until it's registered.

## Open questions for the CTO (original list; items 1, 3, 5, 6, 7 now decided)
1. **DEX:** do we stick with our own pool for Friday (current code)? A Uniswap v4 adapter only makes sense if Day-1 finds a trustworthy PoolManager with stock liquidity.
2. **Oracle:** what price source does the updater use (exchange API? which vendor?), what's the push cadence, and what do we do outside market hours/weekends? A 1h staleness setting will halt trading when the keeper stops. Is the 5% band right?
3. **Keeper:** is a single keeper EOA enough for the demo, or should we use permissionless execution plus a tip? Who pays gas for vault intents? Should DCA slices allow catch-up after missed windows? (Currently missed slices accumulate and can run back-to-back.)
4. **Registry:** which real stock-token ABI do we have (freeze/pause/registry function names)? Must the router, pools, vaults and the Safe be registered with the issuer to hold or transfer stock tokens?
5. **Session keys:** do we build the 4337 module (Safe4337Module + a custom guard reusing AgentVault's policy logic) or ship AgentVault only for Friday?
6. **Eligibility:** should vaults be allowlisted (currently the vault address is gated, not the EOA)? Should the attester also bind vault→owner?
7. **Fee tiers:** do we want a per-caller `feeBps` override for API tiers (20-25 bps in §8 sits below the 30 bps floor in the brief)? Currently the floor is 0 and the cap is 50.
