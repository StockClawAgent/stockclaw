#!/usr/bin/env bash
# demo-up.sh: bring the LOCAL demo back after a box reboot. Idempotent, never kills anything:
#   anvil :8545 (from data/anvil-46630.state.json) -> npm ci if node_modules is missing -> contract artifacts if missing
#   -> :8787 (npm start, detached) -> poll /healthz for up to 60s. Logs: /workspace/logs. Local anvil only; no broadcast.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
LOGS=/workspace/logs; mkdir -p "$LOGS"
STATE=data/anvil-46630.state.json
API=http://127.0.0.1:8787
ts() { date '+%F %T %Z'; }
rpc_up() { curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' http://127.0.0.1:8545 | grep -q '"result":"0xb626"'; }
api_up() { [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$API/healthz" || true)" != "000" ]; }

# 1) anvil on :8545 with the persistent state file (dumped every 5s, reloaded on start)
if rpc_up; then echo "$(ts) anvil: already answering on :8545 (chain 46630), left as is"
elif curl -s -m 2 -o /dev/null http://127.0.0.1:8545; then echo "$(ts) REFUSING: something is on :8545 but it is not chain 46630; not touching it"; exit 1
else
  [ -f "$STATE" ] || echo "$(ts) WARNING: $STATE is missing: anvil starts EMPTY; run 'npm run deploy' and re-seed the demo before using it"
  echo "$(ts) anvil: starting on :8545 with --state $STATE (log $LOGS/chain.log)"
  setsid nohup npm run chain -- --state "$STATE" --state-interval 5 >> "$LOGS/chain.log" 2>&1 < /dev/null &
  for _ in $(seq 1 30); do rpc_up && break; sleep 1; done
  rpc_up || { echo "$(ts) anvil did not come up in 30s; see $LOGS/chain.log"; exit 1; }
fi

# 2) dependencies (node_modules is not kept across a reboot)
if [ -x node_modules/.bin/tsx ]; then echo "$(ts) node_modules: present"
else echo "$(ts) node_modules: missing, running npm ci (log $LOGS/npm-ci.log)"; npm ci >> "$LOGS/npm-ci.log" 2>&1; fi

# 3) contract artifacts (built from the committed tree, git HEAD)
if [ -f artifacts/out/MockUSDG.sol/MockUSDG.json ] && [ -f artifacts/out/AgentVault.sol/AgentVault.json ]; then echo "$(ts) artifacts: present ($(cat artifacts/COMMIT 2>/dev/null || echo 'no COMMIT file'))"
else echo "$(ts) artifacts: missing, building (log $LOGS/build.log)"; bash scripts/build.sh >> "$LOGS/build.log" 2>&1; fi

# 4) API/UI/MCP/keeper on :8787 (127.0.0.1 and ::1; .env.demo is loaded by the server)
if api_up; then echo "$(ts) server: already answering on :8787, left as is"
else echo "$(ts) server: starting npm start (log $LOGS/server.log)"; setsid nohup npm start >> "$LOGS/server.log" 2>&1 < /dev/null & fi

# 5) health: wait for 200 for up to 60s
code=000; body=""
for _ in $(seq 1 60); do
  body=$(curl -s -m 3 -w '\n%{http_code}' "$API/healthz" || true); code=${body##*$'\n'}; body=${body%$'\n'*}
  [ "$code" = "200" ] && break; sleep 1
done
echo "$(ts) /healthz HTTP $code: $body"
[ "$code" = "200" ] || { echo "$(ts) not healthy after 60s; see $LOGS/server.log and $LOGS/chain.log"; exit 1; }
