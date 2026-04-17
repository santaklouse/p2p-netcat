#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
  NODE_BIN=(node)
else
  NODE_BIN=(npx -p node@22 node)
fi

run_node() {
  "${NODE_BIN[@]}" "$@"
}

TMP_DIR="$(mktemp -d)"
SUB_OUT="$TMP_DIR/sub.out"
SUB_ERR="$TMP_DIR/sub.err"
PUB_OUT="$TMP_DIR/pub.out"
PUB_ERR="$TMP_DIR/pub.err"
NOPEER_OUT="$TMP_DIR/nopeer.out"
NOPEER_ERR="$TMP_DIR/nopeer.err"
SUB_PID=""

cleanup() {
  if [[ -n "$SUB_PID" ]]; then
    kill "$SUB_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

run_node ./node_modules/typescript/bin/tsc -p tsconfig.json

TOPIC="smoke-topic-$$"
NOPEER_TOPIC="smoke-nopeer-$$"

run_node dist/index.js --topic "$TOPIC" >"$SUB_OUT" 2>"$SUB_ERR" &
SUB_PID="$!"

for _ in $(seq 1 200); do
  if rg -q "^listen:" "$SUB_ERR"; then
    break
  fi
  sleep 0.1
done

if ! rg -q "^listen:" "$SUB_ERR"; then
  echo "smoke-pubsub: FAILED (subscriber did not initialize)"
  cat "$SUB_ERR"
  exit 1
fi

LISTEN_ADDR="$(rg "^listen:" "$SUB_ERR" -m1 | sed 's/^listen: //')"

printf "smoke-pubsub\n" | run_node dist/index.js --topic "$TOPIC" --connect "$LISTEN_ADDR" >"$PUB_OUT" 2>"$PUB_ERR"
sleep 2
kill "$SUB_PID" >/dev/null 2>&1 || true
SUB_PID=""

if ! rg -q "^smoke-pubsub$" "$SUB_OUT"; then
  echo "smoke-pubsub: FAILED (message not delivered)"
  echo "--- subscriber stdout ---"
  cat "$SUB_OUT"
  echo "--- subscriber stderr ---"
  cat "$SUB_ERR"
  echo "--- publisher stderr ---"
  cat "$PUB_ERR"
  exit 1
fi

if ! timeout 70s "${NODE_BIN[@]}" dist/index.js --topic "$NOPEER_TOPIC" < <(printf "nopeer\n") >"$NOPEER_OUT" 2>"$NOPEER_ERR"; then
  echo "smoke-pubsub: FAILED (no-peer publish command timed out)"
  cat "$NOPEER_ERR"
  exit 1
fi

if rg -q "NotStartedError" "$NOPEER_ERR"; then
  echo "smoke-pubsub: FAILED (NotStartedError regression)"
  cat "$NOPEER_ERR"
  exit 1
fi

echo "smoke-pubsub: OK"
