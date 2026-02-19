#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.dev.yml"
BACKEND_DIR="${ROOT_DIR}/backend"
CLIENT_DIR="${ROOT_DIR}/client"
SESSION_NAME="${BETTERMAIL_TMUX_SESSION:-bettermail-dev}"
DOCKER_DOWN_ON_STOP="${DOCKER_DOWN_ON_STOP:-false}"
TUNNEL_ENABLED="${BETTERMAIL_TUNNEL_ENABLED:-true}"
TUNNEL_NAME="${BETTERMAIL_TUNNEL_NAME:-bettermail-api}"
TUNNEL_CONFIG="${BETTERMAIL_TUNNEL_CONFIG:-${HOME}/.cloudflared/config.yml}"

require_cmd() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    echo "Missing required command: ${name}" >&2
    exit 1
  fi
}

session_exists() {
  tmux has-session -t "${SESSION_NAME}" 2>/dev/null
}

start_infra() {
  echo "Starting docker services via ${COMPOSE_FILE}..."
  docker compose -f "${COMPOSE_FILE}" up -d
}

wait_for_postgres() {
  local retries=30
  local sleep_seconds=1
  local count=0

  while (( count < retries )); do
    if docker exec bettermail-postgres-dev pg_isready -U bettermail -d bettermail >/dev/null 2>&1; then
      return 0
    fi
    count=$((count + 1))
    sleep "${sleep_seconds}"
  done

  echo "Postgres did not become ready in time." >&2
  return 1
}

create_tmux_session() {
  if session_exists; then
    echo "Session ${SESSION_NAME} already exists."
    return
  fi

  if [[ ! -d "${BACKEND_DIR}" ]]; then
    echo "Missing backend directory: ${BACKEND_DIR}" >&2
    exit 1
  fi

  tmux new-session -d -s "${SESSION_NAME}" -n api -c "${BACKEND_DIR}" \
    "bash -lc 'npm run dev; code=\$?; echo \"api exited with code \$code\"; exec bash'"
  tmux new-window -t "${SESSION_NAME}" -n worker -c "${BACKEND_DIR}" \
    "bash -lc 'npm run worker; code=\$?; echo \"worker exited with code \$code\"; exec bash'"

  if [[ -d "${CLIENT_DIR}" ]]; then
    tmux new-window -t "${SESSION_NAME}" -n client -c "${CLIENT_DIR}" \
      "bash -lc 'npm run dev; code=\$?; echo \"client exited with code \$code\"; exec bash'"
  else
    tmux new-window -t "${SESSION_NAME}" -n client "printf '%s\n' 'Client directory not found: ${CLIENT_DIR}'; exec bash"
  fi

  tmux new-window -t "${SESSION_NAME}" -n infra -c "${ROOT_DIR}" \
    "docker compose -f \"${COMPOSE_FILE}\" logs -f postgres seaweed-master seaweed-volume seaweed-filer"

  if [[ "${TUNNEL_ENABLED}" == "true" ]]; then
    if command -v cloudflared >/dev/null 2>&1 && [[ -f "${TUNNEL_CONFIG}" ]]; then
      tmux new-window -t "${SESSION_NAME}" -n tunnel -c "${ROOT_DIR}" \
        "bash -lc 'cloudflared --config \"${TUNNEL_CONFIG}\" tunnel run \"${TUNNEL_NAME}\"; code=\$?; echo \"tunnel exited with code \$code\"; exec bash'"
    else
      tmux new-window -t "${SESSION_NAME}" -n tunnel "printf '%s\n' 'cloudflared or config missing; skipped tunnel startup. Set BETTERMAIL_TUNNEL_ENABLED=false to hide this window.'; exec bash"
    fi
  fi

  tmux select-window -t "${SESSION_NAME}:api"
  echo "Created tmux session: ${SESSION_NAME}"
}

print_status() {
  if ! session_exists; then
    echo "Session ${SESSION_NAME} is not running."
    return
  fi

  echo "Session ${SESSION_NAME} is running."
  tmux list-windows -t "${SESSION_NAME}" -F "#I:#W active=#{window_active} panes=#{window_panes}"
}

attach_session() {
  if ! session_exists; then
    echo "Session ${SESSION_NAME} is not running."
    exit 1
  fi
  tmux attach -t "${SESSION_NAME}"
}

stop_session() {
  if session_exists; then
    tmux kill-session -t "${SESSION_NAME}"
    echo "Stopped tmux session: ${SESSION_NAME}"
  else
    echo "Session ${SESSION_NAME} is not running."
  fi

  if [[ "${DOCKER_DOWN_ON_STOP}" == "true" ]]; then
    docker compose -f "${COMPOSE_FILE}" down --remove-orphans
    echo "Docker services stopped."
  fi
}

restart_session() {
  stop_session
  start_infra
  wait_for_postgres
  create_tmux_session
}

print_usage() {
  cat <<EOF
Usage: scripts/dev.sh <command>

Commands:
  start      Start docker infra and tmux dev session
  attach     Attach to tmux session
  status     Show tmux session/window status
  stop       Stop tmux session (and docker if DOCKER_DOWN_ON_STOP=true)
  restart    Restart tmux session and docker infra
  logs       Tail docker compose logs (pass extra args to docker compose logs)

Environment:
  BETTERMAIL_TUNNEL_ENABLED=true|false  Enable Cloudflare tunnel tmux window (default: true)
  BETTERMAIL_TUNNEL_NAME=<name>         Tunnel name to run (default: bettermail-api)
  BETTERMAIL_TUNNEL_CONFIG=<path>       cloudflared config path (default: ~/.cloudflared/config.yml)
EOF
}

main() {
  require_cmd docker
  require_cmd tmux

  local command="${1:-start}"
  shift || true

  case "${command}" in
    start)
      start_infra
      wait_for_postgres
      create_tmux_session
      print_status
      echo "Attach with: tmux attach -t ${SESSION_NAME}"
      ;;
    attach)
      attach_session
      ;;
    status)
      print_status
      ;;
    stop)
      stop_session
      ;;
    restart)
      restart_session
      print_status
      echo "Attach with: tmux attach -t ${SESSION_NAME}"
      ;;
    logs)
      docker compose -f "${COMPOSE_FILE}" logs -f "$@"
      ;;
    *)
      print_usage
      exit 1
      ;;
  esac
}

main "$@"
