#!/bin/sh
set -e

bgutil-pot server --host "${POT_SERVER_HOST:-127.0.0.1}" --port "${POT_SERVER_PORT:-4416}" &
POT_PID=$!

cleanup() {
  kill "$POT_PID" 2>/dev/null || true
}
trap cleanup TERM INT

# Wait for POT server to be ready before starting Worker, so the first
# extraction request doesn't race a still-booting POT provider.
for i in $(seq 1 30); do
  if node -e "fetch('http://${POT_SERVER_HOST:-127.0.0.1}:${POT_SERVER_PORT:-4416}/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "[start.sh] POT provider ready"
    break
  fi
  sleep 0.5
done

# exec replaces the shell process so Node receives SIGTERM directly from Render
exec node src/index.js
