#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.dev.yml"
BACKEND_DIR="${ROOT_DIR}/backend"
CLIENT_DIR="${ROOT_DIR}/client"
ENV_FILE="${SIMPLEMAIL_ENV_FILE:-${ROOT_DIR}/.env.dev}"
CLIENT_HOST="${SIMPLEMAIL_CLIENT_HOST:-0.0.0.0}"
SESSION_NAME="${SIMPLEMAIL_TMUX_SESSION:-simplemail-dev}"
DOCKER_DOWN_ON_STOP="${DOCKER_DOWN_ON_STOP:-false}"
TUNNEL_ENABLED="${SIMPLEMAIL_TUNNEL_ENABLED:-true}"
TUNNEL_NAME="${SIMPLEMAIL_TUNNEL_NAME:-simplemail-api}"
TUNNEL_CONFIG="${SIMPLEMAIL_TUNNEL_CONFIG:-${HOME}/.cloudflared/config.yml}"
KEYCLOAK_WELL_KNOWN_URL="${SIMPLEMAIL_KEYCLOAK_WELL_KNOWN_URL:-http://localhost:8080/realms/simplemail/.well-known/openid-configuration}"
ENV_PREPARE_SCRIPT="${ROOT_DIR}/scripts/prepare-env.sh"

ensure_env_file() {
  if [[ -f "${ENV_FILE}" ]]; then
    return
  fi
  if [[ -f "${ROOT_DIR}/.env.example" ]]; then
    cp "${ROOT_DIR}/.env.example" "${ENV_FILE}"
    chmod 600 "${ENV_FILE}" || true
    echo "Created ${ENV_FILE} from .env.example"
    return
  fi
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
}

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
  ensure_env_file
  if [[ -x "${ENV_PREPARE_SCRIPT}" ]]; then
    "${ENV_PREPARE_SCRIPT}" "${ENV_FILE}"
  fi
  echo "Starting docker services via ${COMPOSE_FILE}..."
  docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" --profile dev-oidc up -d postgres seaweed-master seaweed-volume seaweed-filer keycloak
}

wait_for_postgres() {
  local retries=30
  local sleep_seconds=1
  local count=0

  while (( count < retries )); do
    if docker exec simplemail-postgres pg_isready -U simplemail -d simplemail >/dev/null 2>&1; then
      return 0
    fi
    count=$((count + 1))
    sleep "${sleep_seconds}"
  done

  echo "Postgres did not become ready in time." >&2
  return 1
}

wait_for_keycloak() {
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl not found; skipping Keycloak readiness check."
    return 0
  fi

  local retries=90
  local sleep_seconds=1
  local count=0

  while (( count < retries )); do
    if curl -fsS "${KEYCLOAK_WELL_KNOWN_URL}" >/dev/null 2>&1; then
      return 0
    fi
    count=$((count + 1))
    sleep "${sleep_seconds}"
  done

  echo "Keycloak did not become ready in time." >&2
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
    "bash -lc 'set -a; source \"${ENV_FILE}\"; set +a; npm run dev; code=\$?; echo \"api exited with code \$code\"; exec bash'"
  tmux new-window -t "${SESSION_NAME}" -n worker -c "${BACKEND_DIR}" \
    "bash -lc 'set -a; source \"${ENV_FILE}\"; set +a; npm run worker; code=\$?; echo \"worker exited with code \$code\"; exec bash'"

  if [[ -d "${CLIENT_DIR}" ]]; then
    tmux new-window -t "${SESSION_NAME}" -n client -c "${CLIENT_DIR}" \
      "bash -lc 'set -a; source \"${ENV_FILE}\"; set +a; npm run dev -- --host ${CLIENT_HOST}; code=\$?; echo \"client exited with code \$code\"; exec bash'"
  else
    tmux new-window -t "${SESSION_NAME}" -n client "printf '%s\n' 'Client directory not found: ${CLIENT_DIR}'; exec bash"
  fi

  tmux new-window -t "${SESSION_NAME}" -n infra -c "${ROOT_DIR}" \
    "docker compose --env-file \"${ENV_FILE}\" -f \"${COMPOSE_FILE}\" logs -f postgres seaweed-master seaweed-volume seaweed-filer keycloak"

  if [[ "${TUNNEL_ENABLED}" == "true" ]]; then
    if command -v cloudflared >/dev/null 2>&1 && [[ -f "${TUNNEL_CONFIG}" ]]; then
      tmux new-window -t "${SESSION_NAME}" -n tunnel -c "${ROOT_DIR}" \
        "bash -lc 'cloudflared --config \"${TUNNEL_CONFIG}\" tunnel run \"${TUNNEL_NAME}\"; code=\$?; echo \"tunnel exited with code \$code\"; exec bash'"
    else
      tmux new-window -t "${SESSION_NAME}" -n tunnel "printf '%s\n' 'cloudflared or config missing; skipped tunnel startup. Set SIMPLEMAIL_TUNNEL_ENABLED=false to hide this window.'; exec bash"
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
    docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" down --remove-orphans
    echo "Docker services stopped."
  fi
}

wipe_db() {
  start_infra
  wait_for_postgres

  if session_exists; then
    echo "Stopping tmux session ${SESSION_NAME} before database wipe..."
    tmux kill-session -t "${SESSION_NAME}"
  fi

  echo "Wiping Postgres database 'simplemail' (OIDC/Keycloak data is not touched)..."
  docker exec simplemail-postgres psql -v ON_ERROR_STOP=1 -U simplemail -d postgres <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'simplemail'
  AND pid <> pg_backend_pid();

DROP DATABASE IF EXISTS simplemail;
CREATE DATABASE simplemail OWNER simplemail;
SQL

  echo "Re-running migrations..."
  (cd "${BACKEND_DIR}" && npm run migrate && npm run worker:migrate)
  echo "Database wipe complete."
}

restart_session() {
  stop_session
  start_infra
  wait_for_postgres
  wait_for_keycloak
  create_tmux_session
}

print_usage() {
  cat <<EOF
Usage: scripts/dev.sh <command>

Commands:
  start      Start docker infra and tmux dev session
  attach     Attach to tmux session
  status     Show tmux session/window status
  wipe-db    Drop/recreate dev Postgres database and run migrations (OIDC/Keycloak untouched)
  stop       Stop tmux session (and docker if DOCKER_DOWN_ON_STOP=true)
  restart    Restart tmux session and docker infra
  logs       Tail docker compose logs (pass extra args to docker compose logs)

Environment:
  SIMPLEMAIL_TUNNEL_ENABLED=true|false  Enable Cloudflare tunnel tmux window (default: true)
  SIMPLEMAIL_TUNNEL_NAME=<name>         Tunnel name to run (default: simplemail-api)
  SIMPLEMAIL_TUNNEL_CONFIG=<path>       cloudflared config path (default: ~/.cloudflared/config.yml)
  SIMPLEMAIL_CLIENT_HOST=<host>         Vite dev host bind address (default: 0.0.0.0)
  SIMPLEMAIL_ENV_FILE=<path>            Dev env file path (default: ${ROOT_DIR}/.env.dev)
  SIMPLEMAIL_KEYCLOAK_WELL_KNOWN_URL    OIDC readiness URL (default: http://localhost:8080/realms/simplemail/.well-known/openid-configuration)
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
      wait_for_keycloak
      create_tmux_session
      print_status
      echo "Keycloak dev realm: simplemail"
      echo "Keycloak dev user: demo / demo123"
      echo "Keycloak admin: http://localhost:8080/admin (admin / admin)"
      echo "Attach with: tmux attach -t ${SESSION_NAME}"
      ;;
    attach)
      attach_session
      ;;
    status)
      print_status
      ;;
    wipe-db)
      wipe_db
      ;;
    stop)
      stop_session
      ;;
    restart)
      restart_session
      print_status
      echo "Keycloak dev user: demo / demo123"
      echo "Attach with: tmux attach -t ${SESSION_NAME}"
      ;;
    logs)
      docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" logs -f "$@"
      ;;
    *)
      print_usage
      exit 1
      ;;
  esac
}

main "$@"
