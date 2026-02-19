#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 /path/to/client_secret.json"
  echo "Example: $0 ~/Downloads/client_secret.json"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SECRET_PATH="$1"
ENV_FILE="${ROOT_DIR}/.env"

if [[ ! -f "${SECRET_PATH}" ]]; then
  echo "OAuth secret file not found: ${SECRET_PATH}"
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo ".env not found at ${ENV_FILE}. Run: cp .env.example .env"
  exit 1
fi

node - "$SECRET_PATH" "$ENV_FILE" <<'NODE'
const fs = require('fs');

const [,, secretPath, envPath] = process.argv;

const raw = fs.readFileSync(secretPath, 'utf8');
const parsed = JSON.parse(raw);
const cfg = parsed.web || parsed.installed;

if (!cfg || typeof cfg !== 'object') {
  throw new Error('Invalid client secret format: expected an object with `web` or `installed` section.');
}

if (!cfg.client_id || !cfg.client_secret) {
  throw new Error('Could not find client_id/client_secret in the JSON file.');
}

let redirectUri = process.env.GOOGLE_REDIRECT_URI;
if (!redirectUri || !redirectUri.trim()) {
  if (Array.isArray(cfg.redirect_uris) && cfg.redirect_uris.length > 0) {
    const preferred = 'http://localhost:3000/api/oauth/google/callback';
    redirectUri = cfg.redirect_uris.includes(preferred) ? preferred : cfg.redirect_uris[0];
  } else {
    redirectUri = 'http://localhost:3000/api/oauth/google/callback';
  }
}

const setVar = (text, key, value) => {
  const escaped = String(value).replace(/\\/g, '\\\\');
  const pattern = new RegExp(`^${key}=.*$`, 'm');

  if (pattern.test(text)) {
    return text.replace(pattern, `${key}=${escaped}`);
  }

  const needsNewline = text.length > 0 && !text.endsWith('\n');
  return text + (needsNewline ? '\n' : '') + `${key}=${escaped}\n`;
};

let envText = fs.readFileSync(envPath, 'utf8');
envText = setVar(envText, 'GOOGLE_CLIENT_ID', cfg.client_id);
envText = setVar(envText, 'GOOGLE_CLIENT_SECRET', cfg.client_secret);
envText = setVar(envText, 'GOOGLE_REDIRECT_URI', redirectUri);

fs.writeFileSync(envPath, envText);
console.log(`Updated ${envPath}`);
NODE