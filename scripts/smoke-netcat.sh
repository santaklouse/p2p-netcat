#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
  NODE_BIN=(node)
else
  NODE_BIN=(npx -p node@22 node)
fi

TMP_DIR="$(mktemp -d)"
SERVER_OUT="$TMP_DIR/server.out"
SERVER_ERR="$TMP_DIR/server.err"
CLIENT_OUT="$TMP_DIR/client.out"
CLIENT_ERR="$TMP_DIR/client.err"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

"${NODE_BIN[@]}" ./node_modules/typescript/bin/tsc -p tsconfig.json

"${NODE_BIN[@]}" dist/index.js --mode server >"$SERVER_OUT" 2>"$SERVER_ERR" &
SERVER_PID="$!"

for _ in $(seq 1 200); do
  if rg -q "^peerId:" "$SERVER_ERR" && rg -q "^listen:" "$SERVER_ERR"; then
    break
  fi
  sleep 0.1
done

if ! rg -q "^peerId:" "$SERVER_ERR" || ! rg -q "^listen:" "$SERVER_ERR"; then
  echo "smoke-netcat: FAILED (server did not initialize)"
  cat "$SERVER_ERR"
  exit 1
fi

PEER_ID="$(rg "^peerId:" "$SERVER_ERR" -m1 | sed 's/^peerId: //')"
LISTEN_ADDR="$(rg "^listen:" "$SERVER_ERR" -m1 | sed 's/^listen: //')"

printf "smoke-netcat\n" | "${NODE_BIN[@]}" dist/index.js --mode client --remote-peer-id "$PEER_ID" --connect "$LISTEN_ADDR" >"$CLIENT_OUT" 2>"$CLIENT_ERR"
sleep 1
kill "$SERVER_PID" >/dev/null 2>&1 || true
SERVER_PID=""

if ! rg -q "^smoke-netcat$" "$SERVER_OUT"; then
  echo "smoke-netcat: FAILED (message not delivered)"
  echo "--- server stdout ---"
  cat "$SERVER_OUT"
  echo "--- server stderr ---"
  cat "$SERVER_ERR"
  echo "--- client stderr ---"
  cat "$CLIENT_ERR"
  exit 1
fi

echo "smoke-netcat: OK"
