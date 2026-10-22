#!/usr/bin/env bash
# Robinhood Chain TESTNET (46630) deploy DRY RUN: simulates script/Deploy.s.sol (from git HEAD) against a fork of
# the live testnet. NEVER broadcasts: no --broadcast, no private key. A real deploy needs a funded deployer
# key (KMS), the real Safe/keeper/updater/attester addresses, and Julius's sign-off.
set -euo pipefail
cd "$(dirname "$0")/.."
RPC="${TESTNET_RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
for a in "$@"; do case "$a" in --broadcast|--private-key*|--ledger|--trezor|--account*) echo "REFUSING: $a not allowed in dry run"; exit 1;; esac; done
[ -d artifacts/head ] || bash scripts/build.sh
FORGE=$(command -v forge || echo "$HOME/.foundry/bin/forge")
# Placeholder role addresses (override with real ones for the rehearsal). Must be distinct; KEEPER != FEED_UPDATER.
export SENDER="${DRYRUN_SENDER:-0x000000000000000000000000000000000000dEaD}"
export TREASURY_SAFE="${TREASURY_SAFE:-0x1111111111111111111111111111111111111111}"
export FEED_UPDATER="${FEED_UPDATER:-0x2222222222222222222222222222222222222222}"
export KEEPER="${KEEPER:-0x3333333333333333333333333333333333333333}"
export ATTESTER="${ATTESTER:-0x4444444444444444444444444444444444444444}"
# L3: on 46630 (never a verified local anvil) the attester must be a separate key from the deployer
[ "$(echo "$ATTESTER" | tr A-F a-f)" != "$(echo "$SENDER" | tr A-F a-f)" ] || { echo "REFUSING: ATTESTER == deployer ($SENDER). Off a verified local anvil the attester must be a separate key (L3)."; exit 1; }
CHAIN=$(curl -s -m 10 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' "$RPC" | sed -E 's/.*"result":"([^"]+)".*/\1/')
[ "$CHAIN" = "0xb626" ] || { echo "REFUSING: $RPC chainId=$CHAIN, expected 0xb626 (46630)"; exit 1; }
export MOCK_TOKENS="${MOCK_TOKENS:-0}"   # 0 = real testnet stock tokens (reverts if any is missing)
[ -f artifacts/COMMIT ] && echo "Contracts: $(cat artifacts/COMMIT)  (roles/funding: docs/TESTNET_DEPLOY.md)"
echo "Dry run on $RPC (46630), MOCK_TOKENS=$MOCK_TOKENS, sender $SENDER. NOT broadcasting."
cd artifacts/head && "$FORGE" script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --sender "$SENDER" --out ../out --cache-path ../cache "$@"
