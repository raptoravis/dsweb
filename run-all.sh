#!/usr/bin/env bash
# Run backend and frontend together on non-default ports.
set -euo pipefail

BACKEND_PORT="${RUN_ALL_BACKEND_PORT:-4120}"
FRONTEND_PORT="${RUN_ALL_FRONTEND_PORT:-5180}"

export PORT="$BACKEND_PORT"
export VITE_DEV_PORT="$FRONTEND_PORT"
export VITE_BACKEND_PORT="$BACKEND_PORT"

# Install dependencies once if missing or out of date.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  echo "[run-all] installing dependencies..."
  npm install
fi

echo "[run-all] backend  -> http://localhost:${BACKEND_PORT}"
echo "[run-all] frontend -> http://localhost:${FRONTEND_PORT}"

cleanup() {
  trap - INT TERM EXIT
  [ -n "${PIDS:-}" ] && kill ${PIDS} 2>/dev/null || true
}
trap cleanup INT TERM EXIT

npm run dev --workspace backend &
PIDS="$!"
npm run dev --workspace frontend &
PIDS="$PIDS $!"

# Exit as soon as either process ends; the EXIT trap reaps the other.
wait -n
