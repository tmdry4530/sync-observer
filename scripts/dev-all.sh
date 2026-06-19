#!/usr/bin/env bash
# Local monitor dev stack: the collector (127.0.0.1:8787) + the Vite UI (5173).
# Open http://127.0.0.1:5173/monitor once both are up.
set -euo pipefail

FRONTEND_PID=""
COLLECTOR_PID=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if [[ -n "${FRONTEND_PID}" ]]; then
    kill "${FRONTEND_PID}" 2>/dev/null || true
  fi
  if [[ -n "${COLLECTOR_PID}" ]]; then
    kill "${COLLECTOR_PID}" 2>/dev/null || true
  fi

  wait "${FRONTEND_PID}" 2>/dev/null || true
  wait "${COLLECTOR_PID}" 2>/dev/null || true
  exit "${status}"
}

trap cleanup EXIT INT TERM

pnpm --filter server dev:collector &
COLLECTOR_PID=$!

pnpm run dev:frontend &
FRONTEND_PID=$!

wait -n "${FRONTEND_PID}" "${COLLECTOR_PID}"
