# StockClaw contracts: design notes (Quintus)
This is an implementation companion to Lucius's ARCHITECTURE.md (authoritative; not modified). Testnet 46630 only. Nothing has been deployed.

## Contracts
| File | Role |
|---|---|
| `src/FeeRouter.sol` | "StockClawRouter". Fee is 30 bps by default with a **hard cap of 50 bps** (`MAX_FEE_BPS`). It's taken from the input token before the swap and sent to `feeTreasury` (the 2-of-3 Safe, set in the constructor and changeable by the owner). Supports approve or **Permit2** SignatureTransfer pulls, **EIP-712 intents** (DCA/limit) with unordered nonces + `cancelNonce`, and SignatureChecker (EOA + ERC-1271). Every swap checks: eligibility, adapter allowlist, deadline, issuer pre-checks, minOut, optional oracle-deviation floor. Pausable, ReentrancyGuard, Ownable2Step. |
| `src/StockClawPool.sol` | x·y=k USDG/stock pool with owner-only liquidity and no LP fee. The oracle band (default 5%) rejects any trade whose post-trade price drifts from the feed. Implements `IDexAdapter`. Only the router can swap, so the fee can't be bypassed. |
| `src/AgentVault.sol` | Friday fallback for the 4337 session-key module. Owner = user EOA. Agent caps default to **$100/trade and $500/day**; the allowlist is **empty by default** and both tokens in a trade must be listed. Has expiry and revoke. **Every breach is a hard revert.** |
| `src/EligibilityRegistry.sol` | Attester role sets `eligibleUntil[account]`. The router reverts for any non-eligible account. |
| `src/oracle/PriceOracle.sol` | Token→USD over Chainlink-style feeds, with per-feed staleness. USDG is pinned at $1. USD values use 6 dp. |
| `src/oracle/MockAggregatorV3.sol` | Chainlink interface. Only the updater can push. |
| `src/mocks/MockUSDG.sol` | 6 dp, owner mint, public faucet of 1,000 per 24h. |
| `src/mocks/MockStockToken.sol` | Pause / freeze / registry. Used to test issuer restrictions. |
| `src/mocks/MockPermit2.sol` | Unit tests only (simplified signing). Real Permit2 is used on testnet. |
| `src/libraries/TokenChecks.sol` | try/catch probes of `paused()`, `isFrozen()`, `canTransfer()` that give clean errors. They degrade to "unknown = allowed" if a token lacks the function, and the transfer itself stays authoritative. |
| `script/Deploy.s.sol` | Reverts with `WrongChain` unless `block.chainid == 46630`. Never run. |

## Key decisions
1. **No escrow; allowance model for intents.** I dropped my earlier escrow `OrderExecutor` in favour of the CTO's signed-intent design. Funds stay in the user's account until the moment a slice executes, so nothing can be stranded in our contracts if a stock is frozen or paused. In that case a slice simply reverts, its exec counter is unchanged, and the keeper retries later.
2. **Fee on input** (CTO §4). The treasury may therefore receive stock tokens. If the registry blocks the Safe, swaps of that stock revert, so **the Safe must be registry-approved for each stock token** (open question 4).
3. **Daily window = fixed UTC calendar day** (`block.timestamp / 1 days`), not a rolling 24h. It's cheaper (one slot, no ring buffer), easy to show in the UI ("resets 00:00 UTC"), and it matches "spent today". The tradeoff: up to $1,000 can be spent across a midnight boundary. A rolling window would need a bucketed design; it's an easy upgrade if product wants it.
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

## Open questions for the CTO
1. **DEX:** do we stick with our own pool for Friday (current code)? A Uniswap v4 adapter only makes sense if Day-1 finds a trustworthy PoolManager with stock liquidity.
2. **Oracle:** what price source does the updater use (exchange API? which vendor?), what's the push cadence, and what do we do outside market hours/weekends? A 1h staleness setting will halt trading when the keeper stops. Is the 5% band right?
3. **Keeper:** is a single keeper EOA enough for the demo, or should we use permissionless execution plus a tip? Who pays gas for vault intents? Should DCA slices allow catch-up after missed windows? (Currently missed slices accumulate and can run back-to-back.)
4. **Registry:** which real stock-token ABI do we have (freeze/pause/registry function names)? Must the router, pools, vaults and the Safe be registered with the issuer to hold or transfer stock tokens?
5. **Session keys:** do we build the 4337 module (Safe4337Module + a custom guard reusing AgentVault's policy logic) or ship AgentVault only for Friday?
6. **Eligibility:** should vaults be allowlisted (currently the vault address is gated, not the EOA)? Should the attester also bind vault→owner?
7. **Fee tiers:** do we want a per-caller `feeBps` override for API tiers (20-25 bps in §8 sits below the 30 bps floor in the brief)? Currently the floor is 0 and the cap is 50.
