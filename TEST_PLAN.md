# StockClaw contracts: test plan (Robinhood Chain 46630 only)

Run: `forge build && forge test` (Foundry 1.8.5, solc 0.8.24, via-IR). Coverage: `forge coverage --ir-minimum`.
Current status (43f82c8): **138 passing + 1 fork test skipped without RPC (it passed when run against 46630)**; Slither --fail-high clean. Earlier: 100/100 passing (unit, fuzz at 512 runs, 9 invariants at 64x32, plus the flipped review-1 PoCs in `test/audit/`). Line coverage: FeeRouter 93%, AgentVault 91%, PriceOracle 100%, total 85%.
New suites: `Oracle.t.sol` (market hours, weekend, keeper/owner mode, 1h staleness, max per-update move), `VaultInvariant.t.sol` (rolling cap never exceeded in ANY 24h window, per-trade ≤ cap, no DCA catch-up, no dangling allowance, router holds nothing), rolling-window boundary tests (across midnight, release at the 25h bucket edge, partial release, ring reuse), eligibility inheritance, single keeper, DCA skip, and H-1 slippage tests.
Slither (config `slither.config.json`): **0 high**. Remaining: medium strict-equality (pool `amountIn == 0`, oracle mode checks; intended), medium unused-return (tuple destructuring; intended), low missing zero-checks, low timestamp comparisons.

## 1. Unit tests (implemented)
| Area | File | Cases |
|---|---|---|
| Router fees | FeeRouter.t.sol | default 30 bps; fee is taken from the input token and sent to the Safe treasury; cap 50 (51 reverts); treasury change; onlyOwner admin |
| Router safety | FeeRouter.t.sol | deadline, minOut, non-allowlisted adapter, pause, ineligible account, expired eligibility, router balance always 0 |
| Issuer restrictions | FeeRouter.t.sol, Intents.t.sol | stock paused -> `TokenPaused`; sender frozen / recipient frozen -> `AccountFrozen`; registry -> `TransferRestricted`; `precheck()` returns false without reverting; no funds move on failure; frozen account during DCA: exec count untouched, retry after unfreeze works |
| Permit2 | FeeRouter.t.sol | swap via SignatureTransfer, replay rejected, token mismatch (uses MockPermit2) |
| Intents | Intents.t.sol | limit buy/sell trigger on oracle; DCA schedule (NotYet, 3 execs, exhaustion); cancelNonce; bad/tampered signature; keeper-only vs permissionless; expiry; oracle-deviation floor; EIP-712 domain changes with chainId |
| Pool | Pool.t.sol | onlyRouter, oracle band rejects large trade, stale oracle blocks swaps, bad pair |
| AgentVault limits | AgentVault.t.sol | defaults $100/$500; empty allowlist blocks everything; both sides must be allowlisted; **per-trade boundary** ($100 ok, $100 + 1 wei reverts; stock input valued by oracle at the boundary); **daily boundary** (5 x $100 ok, +1 wei reverts; no partial fill; exact top-up to $500 ok); UTC-midnight reset (t-1 reverts, t ok); expiry boundary (at expiry ok, +1s reverts); revoke; unknown agent; owner cap changes; onlyOwner controls; output always goes to the vault |
| Vault intents | AgentVault.t.sol | caps charged per DCA execution; direct router path rejected (ERC-1271 disabled); non-agent signature rejected; owner cancel; allowance reset to 0 |
| Deploy guard | DeployGuard.t.sol | reverts on 31337, on 4663 (mainnet), and on any fuzzed chainId other than 46630; wiring on simulated 46630 |

## 2. Fuzz (implemented)
`testFuzz_feeAccounting` (amount x fee bps 0-50), `testFuzz_setFee`, `testFuzz_slippage`, `testFuzz_kNonDecreasing`, `testFuzz_perTradeBoundary`, `testFuzz_dailyNeverExceeded` (8 trades of random size), `testFuzz_revertsOnAnyOtherChain`.

## 3. Invariants (implemented: Invariant.t.sol, handler with buy/sell)
- The router never holds token balances.
- Pool k never decreases.
- Pool reserves equal its balances.
- Fees received by the treasury equal the sum of `amountIn * feeBps / 1e4`.
Vault + intent invariants are now implemented (`VaultInvariant.t.sol`). **TODO:** multiple agents per vault, fee-bps changes mid-sequence.

## 4. Integration on Robinhood Chain (46630). Run only after deploy approval.
1. Fork tests: `forge test --fork-url $RH_TESTNET_RPC` against the real faucet stock tokens (confirm `paused`/`isFrozen`/`canTransfer` ABI; TokenChecks degrades gracefully if they're absent) and the **real Permit2** at `0x0000…8BA3` (replace MockPermit2 encoding with real EIP-712 PermitTransferFrom signing).
2. Deploy (guarded script), push feeds, seed 5 pools, allowlist test accounts via the attester.
3. E2E: MCP `quote_swap` -> `execute_swap`; DCA intent signed by the agent through the vault -> keeper executes 3 slices; limit order triggers on a feed update; revoke the agent mid-DCA -> next slice reverts.
4. Negative: ineligible wallet, over-cap trade, off-allowlist token, stale feed (stop the updater > 1h), pause router.
5. Gas report (`forge test --gas-report`), Blockscout verification, `deployments/46630.json`.

## 5. Security checklist (for Gaius)
- [ ] Slither + Aderyn clean or triaged
- [x] ReentrancyGuard on all state-changing externals; CEI in executeIntent (execCount before transfers)
- [x] SafeERC20, exact pulls, balance-delta accounting, allowances reset to 0 in the vault, no infinite approvals held by the router
- [x] Fee hard cap 50 bps enforced in code; treasury non-zero
- [x] EIP-712 domain (name, version, chainId, verifyingContract), unordered nonces, cancel, exec counter keyed by intent hash
- [x] Cap bypass: vault returns 0xffffffff for ERC-1271, so its intents must go through `vault.executeIntent`
- [x] Oracle: staleness check, positive answer, deviation floor on intents, band on pool
- [x] Chain guard on deploy scripts (31337/4663/fuzz tested)
- [ ] Ownership -> 2-of-3 Safe via Ownable2Step after deploy; timelock on setFeeBps (post-demo)
- [ ] Keeper key in KMS, execute-only rights (has no custody by design)
- [ ] Review: price manipulation of the pool within the 5% band; sandwiching of keeper txs (Arbitrum FCFS sequencer reduces this)
- [ ] Review: signature malleability (OZ ECDSA rejects high-s); ERC-1271 accounts other than the vault
- [ ] Token decimals assumptions (USDG 6 dp, stocks read from `decimals()`)
