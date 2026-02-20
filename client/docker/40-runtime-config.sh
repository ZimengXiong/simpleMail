#!/bin/sh
set -eu

js_escape() {
  printf '%s' "$1" | sed "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g"
}

oidc_base_url="$(js_escape "${VITE_OIDC_BASE_URL:-}")"
oidc_realm="$(js_escape "${VITE_OIDC_REALM:-}")"
oidc_issuer_url="$(js_escape "${VITE_OIDC_ISSUER_URL:-}")"
oidc_client_id="$(js_escape "${VITE_OIDC_CLIENT_ID:-}")"
oidc_scopes="$(js_escape "${VITE_OIDC_SCOPES:-}")"

cat > /usr/share/nginx/html/runtime-config.js <<CONFIG
window.__SIMPLEMAIL_CONFIG__ = {
  VITE_OIDC_ISSUER_URL: '${oidc_issuer_url}',
  VITE_OIDC_BASE_URL: '${oidc_base_url}',
  VITE_OIDC_REALM: '${oidc_realm}',
  VITE_OIDC_CLIENT_ID: '${oidc_client_id}',
  VITE_OIDC_SCOPES: '${oidc_scopes}'
};
CONFIG
