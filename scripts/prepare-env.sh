#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-${ROOT_DIR}/.env}"
S3_TEMPLATE="${ROOT_DIR}/deploy/seaweedfs/s3.json.template"
S3_CONFIG="${ROOT_DIR}/deploy/seaweedfs/s3.json"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Env file not found: ${ENV_FILE}" >&2
  exit 1
fi

if [[ ! -f "${S3_TEMPLATE}" ]]; then
  echo "Seaweed template not found: ${S3_TEMPLATE}" >&2
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
  date +%s%N | sha256sum | cut -c1-48
}

access_key="$(read_env_var SEAWEED_ACCESS_KEY_ID)"
secret_key="$(read_env_var SEAWEED_SECRET_ACCESS_KEY)"
api_admin_token="$(read_env_var API_ADMIN_TOKEN)"

if [[ -z "${access_key}" ]]; then
  access_key="sm_$(gen_secret | cut -c1-28)"
  upsert_env_var SEAWEED_ACCESS_KEY_ID "${access_key}"
  echo "Generated SEAWEED_ACCESS_KEY_ID"
fi

if [[ -z "${secret_key}" ]]; then
  secret_key="sm_$(gen_secret)"
  upsert_env_var SEAWEED_SECRET_ACCESS_KEY "${secret_key}"
  echo "Generated SEAWEED_SECRET_ACCESS_KEY"
fi

if [[ -z "${api_admin_token}" ]]; then
  api_admin_token="smadm_$(gen_secret)"
  upsert_env_var API_ADMIN_TOKEN "${api_admin_token}"
  echo "Generated API_ADMIN_TOKEN"
fi

access_key_escaped="$(printf '%s' "${access_key}" | sed 's/[&/]/\\&/g')"
secret_key_escaped="$(printf '%s' "${secret_key}" | sed 's/[&/]/\\&/g')"

sed \
  -e "s/__SEAWEED_ACCESS_KEY_ID__/${access_key_escaped}/g" \
  -e "s/__SEAWEED_SECRET_ACCESS_KEY__/${secret_key_escaped}/g" \
  "${S3_TEMPLATE}" > "${S3_CONFIG}"
chmod 600 "${S3_CONFIG}"

echo "Prepared ${ENV_FILE} and ${S3_CONFIG}"
