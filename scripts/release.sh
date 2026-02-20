#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

read_env_value() {
  local key="$1"
  local file="$2"
  if [[ ! -f "${file}" ]]; then
    return
  fi
  awk -F= -v key="${key}" '$1 == key { print substr($0, index($0, "=") + 1) }' "${file}" | tail -n1
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree must be clean before releasing." >&2
  exit 1
fi

current_backend="$(node -p "JSON.parse(require('fs').readFileSync('backend/package.json','utf8')).version")"
current_client="$(node -p "JSON.parse(require('fs').readFileSync('client/package.json','utf8')).version")"

if [[ "${current_backend}" != "${current_client}" ]]; then
  echo "Version mismatch detected:" >&2
  echo "  backend: ${current_backend}" >&2
  echo "  client : ${current_client}" >&2
  echo "Releases use backend version as source of truth and will sync both packages." >&2
fi

bump_type="${1:-}"
if [[ -z "${bump_type}" ]]; then
  echo "Select version bump type:"
  select option in patch minor major; do
    if [[ -n "${option:-}" ]]; then
      bump_type="${option}"
      break
    fi
  done
fi

case "${bump_type}" in
  patch|minor|major) ;;
  *)
    echo "Invalid bump type: ${bump_type}. Use patch, minor, or major." >&2
    exit 1
    ;;
esac

next_version="$(
  node - "${current_backend}" "${bump_type}" <<'NODE'
const [current, bump] = process.argv.slice(2);
const match = String(current).trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!match) {
  throw new Error(`Current version is not semver: ${current}`);
}
let [major, minor, patch] = match.slice(1).map(Number);
if (bump === 'major') {
  major += 1;
  minor = 0;
  patch = 0;
} else if (bump === 'minor') {
  minor += 1;
  patch = 0;
} else {
  patch += 1;
}
console.log(`${major}.${minor}.${patch}`);
NODE
)"
tag="v${next_version}"

if git rev-parse --quiet --verify "refs/tags/${tag}" >/dev/null; then
  echo "Tag ${tag} already exists." >&2
  exit 1
fi

echo "Current backend version: ${current_backend}"
echo "Next version: ${next_version} (${bump_type})"
read -r -p "Proceed with release ${tag}? [y/N] " confirm
if [[ ! "${confirm}" =~ ^[Yy]$ ]]; then
  echo "Release cancelled."
  exit 0
fi

node - "${next_version}" <<'NODE'
const fs = require('fs');

const nextVersion = process.argv[2];
const files = ['backend/package.json', 'client/package.json'];

for (const file of files) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.version = nextVersion;
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}
NODE

npm --prefix backend install --package-lock-only --ignore-scripts >/dev/null
npm --prefix client install --package-lock-only --ignore-scripts >/dev/null

git add backend/package.json backend/package-lock.json client/package.json client/package-lock.json
git commit -m "chore(release): ${tag}"
git tag -a "${tag}" -m "${tag}"

echo "Pushing release commit and tag..."
git push origin HEAD
git push origin "${tag}"

echo "Release ${tag} created and pushed."
echo "GitHub Actions can publish Docker images and create the GitHub Release."

read -r -p "Build and push Docker images locally now? [y/N] " local_publish_confirm
if [[ "${local_publish_confirm}" =~ ^[Yy]$ ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required for local publish." >&2
    exit 1
  fi

  if ! docker buildx version >/dev/null 2>&1; then
    echo "docker buildx is required for local publish." >&2
    exit 1
  fi

  env_file="${RELEASE_ENV_FILE:-.env}"
  backend_repo="$(read_env_value SIMPLEMAIL_BACKEND_REPOSITORY "${env_file}")"
  client_repo="$(read_env_value SIMPLEMAIL_CLIENT_REPOSITORY "${env_file}")"
  backend_repo="${backend_repo:-docker.io/zimengxiong/simplemail-backend}"
  client_repo="${client_repo:-docker.io/zimengxiong/simplemail-client}"
  docker_platforms="${RELEASE_DOCKER_PLATFORMS:-linux/amd64,linux/arm64}"

  echo "Local Docker publish configuration:"
  echo "  Backend repo: ${backend_repo}"
  echo "  Client repo : ${client_repo}"
  echo "  Platforms   : ${docker_platforms}"
  echo "Building and pushing backend image..."
  docker buildx build \
    --platform "${docker_platforms}" \
    -f backend/Dockerfile \
    -t "${backend_repo}:${next_version}" \
    -t "${backend_repo}:latest" \
    --push \
    backend

  echo "Building and pushing client image..."
  docker buildx build \
    --platform "${docker_platforms}" \
    -f client/Dockerfile \
    -t "${client_repo}:${next_version}" \
    -t "${client_repo}:latest" \
    --push \
    client

  echo "Local Docker publish complete."
fi
