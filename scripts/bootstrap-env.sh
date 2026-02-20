#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-${ROOT_DIR}/.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Env file not found: ${ENV_FILE}" >&2
  exit 1
fi

read_env_var() {
  local key="$1"
  local value
  value="$(awk -F= -v key="${key}" '$1 == key { print substr($0, index($0, "=") + 1) }' "${ENV_FILE}" | tail -n1)"
  printf '%s' "${value}"
}

upsert_env_var() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"

  awk -v k="${key}" -v v="${value}" '
    BEGIN { replaced = 0 }
    $0 ~ ("^" k "=") { print k "=" v; replaced = 1; next }
    { print }
    END { if (!replaced) print k "=" v }
  ' "${ENV_FILE}" > "${tmp}"

  mv "${tmp}" "${ENV_FILE}"
}

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
    return
  fi
  if command -v uuidgen >/dev/null 2>&1; then
    printf '%s%s' "$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-')" "$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-')" | cut -c1-48
    return
  fi
  date +%s%N | shasum -a 256 | cut -c1-48
}

postgres_db="$(read_env_var POSTGRES_DB)"
postgres_user="$(read_env_var POSTGRES_USER)"
postgres_password="$(read_env_var POSTGRES_PASSWORD)"
database_url="$(read_env_var DATABASE_URL)"
api_admin_token="$(read_env_var API_ADMIN_TOKEN)"

postgres_db="${postgres_db:-simplemail}"
postgres_user="${postgres_user:-simplemail}"

if [[ -z "${postgres_password}" || "${postgres_password}" == "change-me" ]]; then
  postgres_password="smdb_$(gen_secret)"
  upsert_env_var POSTGRES_PASSWORD "${postgres_password}"
  echo "Generated POSTGRES_PASSWORD"
fi

expected_database_url="postgres://${postgres_user}:${postgres_password}@postgres:5432/${postgres_db}"
if [[ -z "${database_url}" || "${database_url}" == *":change-me@"* ]]; then
  upsert_env_var DATABASE_URL "${expected_database_url}"
  echo "Generated DATABASE_URL"
fi

if [[ -z "${api_admin_token}" || "${api_admin_token}" == "change-me-api-admin-token" ]]; then
  upsert_env_var API_ADMIN_TOKEN "smadm_$(gen_secret)"
  echo "Generated API_ADMIN_TOKEN"
fi

echo "Prepared ${ENV_FILE}"
