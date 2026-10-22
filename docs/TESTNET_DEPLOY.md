# Robinhood Chain (46630) deploy runbook

Status: **PREPARED, NOT BROADCAST.** Nothing in this repo has sent a transaction to 46630. Julius has to sign off before the deploy, and it needs a funded deployer key that we don't have yet.

| | |
|---|---|
| Chain ID | 46630 (`0xb626`) |
| Public RPC (rate-limited) | `https://rpc.testnet.chain.robinhood.com` (Alchemy is recommended for production use: `https://robinhood-testnet.g.alchemy.com/v2/<KEY>`) |
| Explorer (Blockscout) | `https://explorer.testnet.chain.robinhood.com` (`/tx/<hash>`, `/address/<addr>`; verifier API `/api/`) |
| Faucets | `https://faucet.testnet.chain.robinhood.com` (ETH + stock tokens), Alchemy `https://www.alchemy.com/faucets/robinhood-testnet` (0.1 ETH/24h, mainnet-activity check) |
| Contracts | git HEAD `baa80e9` (Quintus's latest: R4-1 sell cap + approvals, 5491737 sell exemption, 8c0bc7b isRouteSupported) |

## 1. Dry run (safe, any time)

```bash
cd server && npm run testnet:dryrun        # forks live 46630, simulates script/Deploy.s.sol, NO broadcast
```

The script refuses `--broadcast`, `--private-key`, `--ledger`, `--trezor` and `--account`, and checks that the chain id is `0xb626`. It builds artifacts from git HEAD only. Last result (2026-10-18, HEAD baa80e9, `MOCK_TOKENS=0`, real 46630 stock tokens):

- 44 transactions: 13 CREATEs (MockUSDG, PriceOracle, EligibilityRegistry, FeeRouter, 5× MockAggregatorV3, 5× StockClawPool) + 31 config calls
- estimated gas 18.44M; at 0.02 gwei max fee that is **~0.00037 ETH**
- all 5 real 46630 stock tokens resolved (TSLA, AMZN, PLTR, NFLX, AMD; `symbol()` checked onchain)

To rehearse with the real role addresses, set `TREASURY_SAFE`, `FEED_UPDATER`, `KEEPER`, `ATTESTER` and `DRYRUN_SENDER` before running.

## 2. Addresses needed (all distinct)

| Role | Env | Holds key? | What it does | ETH to fund (46630) |
|---|---|---|---|---|
| Deployer | sender of `forge script` | KMS / hardware, one-off | Deploys everything. Owns contracts until the Safe accepts. Seeds pools. | 0.01 (deploy ≈0.0004 + seeding + margin) |
| Treasury Safe (2-of-3) | `TREASURY_SAFE` | Safe signers | Fee treasury. `pendingOwner` of router, oracle, pools, feeds and MockUSDG (Ownable2Step since 65cd2f6). Must call `acceptOwnership()` on each (batch in Safe tx builder). Gets registry admin (`DEFAULT_ADMIN_ROLE`) from the script; the deployer renounces it. | 0.005 (accept batch) |
| Keeper | `KEEPER` | server (KMS for prod) | Executes DCA/limit intents, pushes NYSE `setSession`, relays `approveSellWithSig` | 0.05 (≈1 session tx/day + intents + relays) |
| Feed updater | `FEED_UPDATER` (≠ KEEPER, S-4) | server | Pushes 5 mock feed prices every 60s | 0.05/week (≈7k tx/day × ~45k gas × 0.02 gwei ≈ 0.0065 ETH/day; cut it by pushing only on change) |
| Attester | `ATTESTER` (server: `ATTESTER_KEY`) | server | Writes eligibility attestations (`ATTESTER_ROLE`). **Must not be the deployer** (L3): the server and `npm run testnet:dryrun` refuse to start when ATTESTER == deployer off a verified local anvil, and the server also refuses if the deployer holds `ATTESTER_ROLE` or registry admin onchain. | 0.005 |
| Owner (demo) | server `DEMO_OWNER_KEY` | server (SIMULATED owner) | Creates per-user AgentVaults, sets caps/allowlist, grants agent keys. Production: the user's own wallet / EIP-1271, no operator path. | 0.02 per ~10 demo users |
| Agent session keys | derived per user | server | Agent swaps from the vault | 0.002 each |

Total to start: **about 0.15 ETH on 46630**, spread across the roles above. Alchemy gives 0.1 ETH/day, so plan on 2 days or use the official faucet.

## 3. Tokens needed

- **USDG**: our `MockUSDG` (deployed by the script; onchain symbol `mUSDG`). `faucet()` gives 1,000 / 24h per address. The deployer can mint for seeding only until the Safe accepts ownership (Ownable2Step); after that only the Safe can mint. No external dependency.
- **Stock tokens** (TSLA, AMZN, PLTR, NFLX, AMD) from `faucet.testnet.chain.robinhood.com`, about 5 of each per claim. To seed each pool at ~$1,000 per side you need roughly 4 (TSLA) / 6 (AMZN) / 6 (PLTR) / 1 (NFLX) / 6 (AMD) tokens, matched with ~$1,000 USDG per pool. Claim to the deployer before seeding. Demo users also claim for themselves.

## 4. Deploy steps (only after Julius's sign-off)

1. Create and fund the role addresses above. Put the server keys in the secret store, never in git or `.env.demo`.
2. `npm run testnet:dryrun` with the real addresses → review `server/artifacts/head/broadcast/Deploy.s.sol/46630/dry-run/run-latest.json`.
3. Broadcast (a human runs this from the KMS-backed signer; it is **not scripted here**): `forge script script/Deploy.s.sol:Deploy --rpc-url $RPC --broadcast --verify --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api/` using the KMS signer.
4. Push the first feed prices (feed updater), then seed the pools from the deployer (mint MockUSDG for seeding now: the deployer loses mint rights in step 5), before the Safe accepts ownership.
5. Safe: one batch of `acceptOwnership()` on router, oracle, 5 pools, 5 feeds **and MockUSDG** (13 calls; MockUSDG is Ownable2Step since 65cd2f6, the script only set its `pendingOwner`). Check in Blockscout:
   - `owner()` == Safe and `pendingOwner()` == `0x0` on all 13.
   - EligibilityRegistry: `hasRole(DEFAULT_ADMIN_ROLE, Safe)` true; `hasRole(DEFAULT_ADMIN_ROLE, deployer)` and `hasRole(ATTESTER_ROLE, deployer)` both false (the deployer ends with no roles or ownership).
   - `MockUSDG.mint` from the deployer now reverts `OwnableUnauthorizedAccount`.
   (Local anvil does this automatically right after seeding in `server/src/deploy.ts`, with the treasury key standing in for the Safe, and checks the same list. The only allowed leftover there is `ATTESTER_ROLE` when ATTESTER == deployer, which is logged as a warning.)
6. Keeper pushes today's NYSE session (`setSession`). The market stays CLOSED until it does (fail-closed).
7. Server: `RPC_URL=<alchemy 46630>`, `DEPLOYMENTS_FILE` (default `server/data/testnet-46630.json`), `DEMO_OWNER_KEY`, `AGENT_KEYS`, `EXPLORER_URL` (default is the Blockscout above), tokens set, `KEEPER=1`. The server refuses to start unless both API tokens are set (the local `ALLOW_OPEN_LOCAL` escape doesn't work on 46630). Check `/healthz` (rpc ok, oracle fresh, session open).
8. Smoke test: eligibility → vault → agent key → faucet claim → $5 swap. Check the tx link opens on Blockscout.

Rollback: revoke agent keys (one tx per key = pause). The Safe can force-close the market on the oracle. Tokens have no value.

## Demo rules

- **Never re-grant a revoked agent key.** `AgentVault.revokeAgent` only clears the key's `active` flag. It does not cancel anything that key signed, so `grantAgent` on the same address would revive every signed intent (DCA / limit) that was not cancelled. To bring an agent back, use a **fresh key**, or first call `cancelIntent(nonce)` on the vault (it calls `FeeRouter.cancelNonce`) for every outstanding intent nonce of that key, then grant.

## Testnet conditions satisfied

- **F1 / R3-3 (pool donations)**, 80c1f21: `StockClawPool` reserves are accounted, never re-synced from raw balances. `swap` fills exactly the router's `amountIn` (reverts `InputNotReceived` if less arrived), so direct transfers can't DoS buys or give the next buyer a windfall. The owner (Safe) can `skim(to)` the excess. Tests: `test/PoolDonation.t.sol`, the donate action in the pool invariant, `test/audit/Review3.t.sol` R3-3 flipped to assert the fix.
- **L3 (deployer handoff)**, 65cd2f6 + server side: registry admin goes to the Safe and the deployer renounces it; MockUSDG ownership is offered to the Safe (Ownable2Step) and accepted after seeding (step 5); ATTESTER is a separate key, enforced by the server, the local deploy and the dry run (refuse when ATTESTER == deployer off a verified anvil). Tests: `test/DeployGuard.t.sol` (`DeployHandoffTest`), server e2e "L3 handoff" and "L3 attester separation".

## 5. ERC-8004 Identity registry on 46630 (read-only check, 2026-10-18)

`0x8004A818BFB912233c491871b3d84c89A494BD9e` **is the official deployment**:

- It is listed for **Robinhood Chain 46630** in the official `erc-8004/erc-8004-contracts` README (IdentityRegistry `0x8004A818…BD9e`, ReputationRegistry `0x8004B663…8713`). Mainnet 4663 is listed as `0x8004A169…a432` / `0x8004BAa1…9b63`, the same addresses as Ethereum mainnet.
- Bytecode: the 46630 proxy runtime code (131 bytes, sha256 prefix `48f9cfbbdbd87d29`) is identical to Ethereum mainnet `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, Ethereum Sepolia and Arbitrum Sepolia. The ERC-1967 implementation slot points to the same implementation, `0x7274e874ca62410a93bd8bf61c69d8045e399c02`, on all four chains, and its runtime code (14,474 bytes, sha256 prefix `3b110d5b58880799`) is identical everywhere.
- This was done with `eth_getCode` / `eth_getStorageAt` calls only. No transactions.
