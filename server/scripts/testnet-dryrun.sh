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
# DRYRUN_SENDER (the deployer) has NO default off a verified local anvil: the role checks compare against it.
SENDER="${DRYRUN_SENDER:-}"
unset LOCAL_ANVIL # G2: never inherited from the caller's env; set below from the node check only
export TREASURY_SAFE="${TREASURY_SAFE:-0x1111111111111111111111111111111111111111}"
export FEED_UPDATER="${FEED_UPDATER:-0x2222222222222222222222222222222222222222}"
export KEEPER="${KEEPER:-0x3333333333333333333333333333333333333333}"
export ATTESTER="${ATTESTER:-0x4444444444444444444444444444444444444444}"
lc() { echo "$1" | tr A-F a-f; }
# L3: the attester must be a separate key from the deployer (checked before any RPC when the sender is given)
[ -z "$SENDER" ] || [ "$(lc "$ATTESTER")" != "$(lc "$SENDER")" ] || { echo "REFUSING: ATTESTER == deployer ($SENDER). Off a verified local anvil the attester must be a separate key (L3)."; exit 1; }
CHAIN=$(curl -s -m 10 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' "$RPC" | sed -E 's/.*"result":"([^"]+)".*/\1/')
[ "$CHAIN" = "0xb626" ] || { echo "REFUSING: $RPC chainId=$CHAIN, expected 0xb626 (46630)"; exit 1; }
# Verified local anvil = the same rule as the server (R7-3): RPC host is localhost (127.0.0.1 | localhost | [::1], no
# userinfo) AND the node answers web3_clientVersion ~ anvil AND anvil_nodeInfo. Never keyed on the chain id. A REMOTE
# node that claims to be anvil is refused (it could be anything).
rpc() { curl -s -m 10 -X POST -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$RPC"; }
AUTH=$(echo "$RPC" | sed -E 's#^[A-Za-z]+://([^/?#]*).*#\1#'); HOST=$(echo "$AUTH" | sed -E 's#:[0-9]+$##' | tr A-Z a-z)
LOCALHOST=0; case "$AUTH" in *@*) ;; *) case "$HOST" in 127.0.0.1|localhost|'[::1]') LOCALHOST=1;; esac;; esac
CLIENT=$(rpc web3_clientVersion '[]' || true); NODEINFO=$(rpc anvil_nodeInfo '[]' || true)
CLAIMS_ANVIL=0; if echo "$CLIENT" | grep -qi '"result":"anvil' && echo "$NODEINFO" | grep -q '"environment"'; then CLAIMS_ANVIL=1; fi
if [ "$CLAIMS_ANVIL" = 1 ] && [ "$LOCALHOST" = 0 ]; then echo "REFUSING: $RPC is not a localhost RPC but answers as anvil. Only a localhost anvil counts as local (R7-3 rule); refusing."; exit 1; fi
if [ "$CLAIMS_ANVIL" = 1 ]; then
  SENDER="${SENDER:-0x000000000000000000000000000000000000dEaD}"
  export LOCAL_ANVIL=1 # G2: Deploy.s.sol allows the EOA Safe stand-in / ATTESTER == deployer only with this
  echo "WARNING: $RPC is a verified local anvil: D-1 TREASURY_SAFE / Safe checks skipped (rehearsal only)"
else
  export LOCAL_ANVIL=0
  [ -n "$SENDER" ] || { echo "REFUSING: DRYRUN_SENDER (the deployer address) must be set off a verified local anvil; the role checks compare against it."; exit 1; }
  # D-1 + D1-R1: TREASURY_SAFE must be a real Safe: not the deployer/keeper/attester, has code that is not an
  # EIP-7702 delegation (0xef0100...), getThreshold() >= 2, getOwners() >= 3 and none of them a role key. RPC errors refuse.
  for pair in "deployer:$SENDER" "keeper:$KEEPER" "attester:$ATTESTER"; do
    [ "$(lc "$TREASURY_SAFE")" != "$(lc "${pair#*:}")" ] || { echo "REFUSING: TREASURY_SAFE == ${pair%%:*} (${pair#*:}). The treasury must be the 2-of-3 Safe (D-1)."; exit 1; }
  done
  CODE=$(rpc eth_getCode "[\"$TREASURY_SAFE\",\"latest\"]" | sed -E 's/.*"result":"([^"]*)".*/\1/' || true)
  case "$CODE" in 0x|""|*error*|*'{'*) echo "REFUSING: TREASURY_SAFE $TREASURY_SAFE has no code on $RPC (eth_getCode empty): deploy the Safe first (D-1)."; exit 1;; esac
  case "$(lc "$CODE")" in 0xef0100*) echo "REFUSING: TREASURY_SAFE $TREASURY_SAFE is an EIP-7702 delegated EOA (code 0xef0100...), not a Safe contract (D1-R1)."; exit 1;; esac
  CAST=$(command -v cast || echo "$HOME/.foundry/bin/cast")
  THRESH=$("$CAST" call --rpc-url "$RPC" "$TREASURY_SAFE" "getThreshold()(uint256)" 2>/dev/null) || { echo "REFUSING: TREASURY_SAFE $TREASURY_SAFE does not answer getThreshold() (not a Safe, or RPC error) (D1-R1)."; exit 1; }
  OWNERS=$("$CAST" call --rpc-url "$RPC" "$TREASURY_SAFE" "getOwners()(address[])" 2>/dev/null) || { echo "REFUSING: TREASURY_SAFE $TREASURY_SAFE does not answer getOwners() (not a Safe, or RPC error) (D1-R1)."; exit 1; }
  THRESH=${THRESH%% *}; case "$THRESH" in ''|*[!0-9]*) echo "REFUSING: unreadable getThreshold() '$THRESH' (D1-R1)."; exit 1;; esac
  [ "$THRESH" -ge 2 ] || { echo "REFUSING: TREASURY_SAFE threshold is $THRESH; need >= 2 (D1-R1)."; exit 1; }
  OLIST=$(echo "$OWNERS" | tr -d '[] ' | tr ',' '\n' | grep -E '^0x[0-9a-fA-F]{40}$' || true); NOWN=$(echo "$OLIST" | grep -c . || true)
  [ "$NOWN" -ge 3 ] || { echo "REFUSING: TREASURY_SAFE has $NOWN owners; need >= 3 (D1-R1)."; exit 1; }
  for pair in "deployer:$SENDER" "keeper:$KEEPER" "attester:$ATTESTER"; do
    ! echo "$OLIST" | tr A-F a-f | grep -qx "$(lc "${pair#*:}")" || { echo "REFUSING: the ${pair%%:*} ${pair#*:} is an owner of TREASURY_SAFE; Safe signers must be separate keys (D1-R1)."; exit 1; }
  done
  echo "TREASURY_SAFE $TREASURY_SAFE: Safe threshold $THRESH of $NOWN owners, no role key among them"
fi
export SENDER
echo "LOCAL_ANVIL=$LOCAL_ANVIL (from the node check; never inherited)"
[ "${DRYRUN_CHECK_ONLY:-0}" = "1" ] && { echo "dry-run pre-checks passed (DRYRUN_CHECK_ONLY=1: not simulating)"; exit 0; }
export MOCK_TOKENS="${MOCK_TOKENS:-0}"   # 0 = real testnet stock tokens (reverts if any is missing)
[ -f artifacts/COMMIT ] && echo "Contracts: $(cat artifacts/COMMIT)  (roles/funding: docs/TESTNET_DEPLOY.md)"
echo "Dry run on $RPC (46630), MOCK_TOKENS=$MOCK_TOKENS, sender $SENDER. NOT broadcasting."
cd artifacts/head && "$FORGE" script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --sender "$SENDER" --out ../out --cache-path ../cache "$@"
