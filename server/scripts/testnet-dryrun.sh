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
# D-1: off a verified anvil (anvil_nodeInfo + web3_clientVersion, never the chain id) TREASURY_SAFE must not be the
# deployer and must have code (a deployed Safe), checked with eth_getCode on the target RPC.
rpc() { curl -s -m 10 -X POST -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$RPC"; }
CLIENT=$(rpc web3_clientVersion '[]'); NODEINFO=$(rpc anvil_nodeInfo '[]')
if echo "$CLIENT" | grep -qi '"result":"anvil' && echo "$NODEINFO" | grep -q '"environment"'; then
  echo "WARNING: $RPC is a verified local anvil: D-1 TREASURY_SAFE checks skipped (rehearsal only)"
else
  [ "$(echo "$TREASURY_SAFE" | tr A-F a-f)" != "$(echo "$SENDER" | tr A-F a-f)" ] || { echo "REFUSING: TREASURY_SAFE == deployer ($SENDER). The treasury must be the 2-of-3 Safe (D-1)."; exit 1; }
  CODE=$(rpc eth_getCode "[\"$TREASURY_SAFE\",\"latest\"]" | sed -E 's/.*"result":"([^"]*)".*/\1/')
  case "$CODE" in 0x|""|*error*|*'{'*) echo "REFUSING: TREASURY_SAFE $TREASURY_SAFE has no code on $RPC (eth_getCode empty): deploy the Safe first (D-1)."; exit 1;; esac
fi
[ "${DRYRUN_CHECK_ONLY:-0}" = "1" ] && { echo "dry-run pre-checks passed (DRYRUN_CHECK_ONLY=1: not simulating)"; exit 0; }
export MOCK_TOKENS="${MOCK_TOKENS:-0}"   # 0 = real testnet stock tokens (reverts if any is missing)
[ -f artifacts/COMMIT ] && echo "Contracts: $(cat artifacts/COMMIT)  (roles/funding: docs/TESTNET_DEPLOY.md)"
echo "Dry run on $RPC (46630), MOCK_TOKENS=$MOCK_TOKENS, sender $SENDER. NOT broadcasting."
cd artifacts/head && "$FORGE" script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --sender "$SENDER" --out ../out --cache-path ../cache "$@"
