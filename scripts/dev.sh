#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="docker-compose.dev.yml"
BACKEND_DIR="backend"
CLIENT_DIR="client"

BACKEND_PID=""
CLIENT_PID=""

cleanup() {
  echo ""
  echo "Shutting down dev environment..."

  if [[ -n "${BACKEND_PID}" ]] && kill -0 "${BACKEND_PID}" 2>/dev/null; then
    kill "${BACKEND_PID}" 2>/dev/null || true
    wait "${BACKEND_PID}" 2>/dev/null || true
  fi

  if [[ -n "${CLIENT_PID}" ]] && kill -0 "${CLIENT_PID}" 2>/dev/null; then
    kill "${CLIENT_PID}" 2>/dev/null || true
    wait "${CLIENT_PID}" 2>/dev/null || true
  fi

  if [[ -f "${COMPOSE_FILE}" ]]; then
    docker compose -f "${COMPOSE_FILE}" down --remove-orphans
  fi

  echo "Dev environment stopped."
}

trap cleanup SIGINT SIGTERM EXIT

echo "Starting dev services via ${COMPOSE_FILE}..."
if ! docker compose -f "${COMPOSE_FILE}" up -d; then
  echo "Failed to start docker services"
  exit 1
fi

if [[ ! -d "${BACKEND_DIR}" ]]; then
  echo "Missing backend directory: ${BACKEND_DIR}"
  exit 1
fi

(
  cd "${BACKEND_DIR}"
  npm run dev
) &
BACKEND_PID=$!

if [[ -d "${CLIENT_DIR}" ]]; then
  (
    cd "${CLIENT_DIR}"
    npm run dev
  ) &
  CLIENT_PID=$!
else
  echo "Client directory not found, skipping frontend dev process: ${CLIENT_DIR}"
  CLIENT_PID=""
fi

echo "Backend PID: ${BACKEND_PID}"
echo "Client PID: ${CLIENT_PID:-<not-started>}"
echo "Press Ctrl+C to stop all services."

while true; do
  has_exit=""
  if [[ -n "${BACKEND_PID}" ]] && ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
    has_exit="backend:${BACKEND_PID}"
  elif [[ -n "${CLIENT_PID}" ]] && ! kill -0 "${CLIENT_PID}" 2>/dev/null; then
    has_exit="client:${CLIENT_PID}"
  fi

  if [[ -n "${has_exit}" ]]; then
    IFS=':' read -r label pid <<< "${has_exit}"
    if wait "${pid}"; then
      echo "${label} exited cleanly (pid ${pid})."
      exit_code=0
    else
      exit_code=$?
      echo "${label} exited with code ${exit_code} (pid ${pid})."
    fi
    exit "${exit_code}"
  fi

  sleep 1
done
