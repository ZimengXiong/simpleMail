<img src="./client/public/logo-128.svg" width="64" height="64" alt="simpleMail logo" style="display:block; margin:0; border:0;" />

# simpleMail

simpleMail is a self-hosted mail app stack (UI + API + worker) with OIDC login.

<details>
<summary><strong>End Users: Deploy simpleMail</strong></summary>

### Prerequisites

- Docker Engine + Docker Compose plugin
- OIDC provider/client for app login
- Google Cloud project (for Gmail connectors and Pub/Sub)

### 1. Initialize env and internal secrets

```bash
cp .env.docker.example .env
scripts/prepare-env.sh .env
```

This generates:

- `API_ADMIN_TOKEN`
- `SEAWEED_ACCESS_KEY_ID`
- `SEAWEED_SECRET_ACCESS_KEY`
- `deploy/seaweedfs/s3.json`

### 2. Set required `.env` values

Set these values:

- `APP_BASE_URL`
- `FRONTEND_BASE_URL`
- `OIDC_ISSUER_URL`
- `OIDC_CLIENT_ID`
- `OIDC_ALLOWED_EMAILS` (exactly one email)
- `VITE_OIDC_BASE_URL`
- `VITE_OIDC_REALM`
- `VITE_OIDC_CLIENT_ID`
- `SIMPLEMAIL_BACKEND_REPOSITORY` (default `docker.io/zimengxiong/simplemail-backend`)
- `SIMPLEMAIL_CLIENT_REPOSITORY` (default `docker.io/zimengxiong/simplemail-client`)

Default single-host Docker values can stay as-is:

- `POSTGRES_PASSWORD`
- `DATABASE_URL`
- `SIMPLEMAIL_VERSION` (`latest` or a pinned release like `1.2.3`)

### 3. Start stack

```bash
docker compose pull
docker compose up -d
```

### 4. OIDC provider setup

Configure your IdP client to match your app values:

- Issuer must match `OIDC_ISSUER_URL`
- Audience/client must match `OIDC_CLIENT_ID`
- Redirect/web origins must include your frontend/app URLs
- The login email must match `OIDC_ALLOWED_EMAILS`

### 5. Gmail connector setup (Google OAuth)

In Google Cloud Console:

1. Create/select project:
- https://console.cloud.google.com/projectcreate
2. Enable Gmail API:
- https://console.cloud.google.com/apis/api/gmail.googleapis.com
3. Configure OAuth consent screen:
- https://console.cloud.google.com/auth/branding
- Add test users if app is in Testing mode:
  - https://console.cloud.google.com/auth/audience
4. Create OAuth client (`Web application`):
- https://console.cloud.google.com/auth/clients
- Add redirect URI:
  - `https://<your-api-domain>/api/oauth/google/callback`

Then set in `.env`:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI=https://<your-api-domain>/api/oauth/google/callback`

### 6. Gmail Pub/Sub setup

In Google Cloud Console:

1. Enable Pub/Sub API:
- https://console.cloud.google.com/apis/api/pubsub.googleapis.com
2. Create topic (example `simplemail-gmail-push`):
- https://console.cloud.google.com/cloudpubsub/topic/list
3. Grant topic publisher:
- principal: `gmail-api-push@system.gserviceaccount.com`
- role: `Pub/Sub Publisher`
4. Create push subscription:
- endpoint: `https://<your-api-domain>/api/gmail/push`
- auth: OIDC token with your push service account
- audience: same value as `GMAIL_PUSH_WEBHOOK_AUDIENCE`

Set in `.env`:

- `GMAIL_PUSH_ENABLED=true`
- `GMAIL_PUSH_TOPIC_NAME=projects/<PROJECT_ID>/topics/<TOPIC_NAME>`
- `GMAIL_PUSH_WEBHOOK_PATH=/api/gmail/push`
- `GMAIL_PUSH_WEBHOOK_AUDIENCE=https://<your-api-domain>/api/gmail/push`
- `GMAIL_PUSH_SERVICE_ACCOUNT_EMAIL=<push-service-account>@<project>.iam.gserviceaccount.com`

### 7. Cloudflare Tunnel option for webhook reachability

Use this if your API is local/private and needs a public HTTPS URL for Google callbacks/webhooks.

Option A: quick tunnel

```bash
cloudflared tunnel --url http://localhost:3000
```

Option B: named tunnel (recommended for stable domain)

```bash
cloudflared tunnel login
cloudflared tunnel create simplemail-api
cloudflared tunnel route dns simplemail-api api.yourdomain.com
cloudflared tunnel run simplemail-api
```

Then use tunnel URL/domain for:

- Pub/Sub push endpoint
- `GMAIL_PUSH_WEBHOOK_AUDIENCE`
- `APP_BASE_URL` (if external callbacks/webhooks should hit tunnel)

### 8. Verify

- UI loads: `http://localhost:5173`
- API health: `http://localhost:3000/api/health`
- OIDC login succeeds
- Gmail OAuth callback succeeds after connector auth
- Pub/Sub push deliveries arrive (if enabled)

</details>

<details>
<summary><strong>Developers: Local Development (Detailed)</strong></summary>

### 1. Start local dev stack

```bash
cp .env.example .env
cp client/.env.example client/.env
scripts/prepare-env.sh .env
cd backend && npm install
cd ../client && npm install
cd ..
scripts/dev.sh start
```

This runs:

- Docker infra: Postgres, SeaweedFS, Keycloak (`docker-compose.dev.yml`)
- Host processes: backend dev server, worker, Vite client (tmux)

### 2. Core dev env vars you will edit most

- `OIDC_ALLOWED_EMAILS` (single allowed local user email)
- `APP_BASE_URL` / `FRONTEND_BASE_URL`
- `OIDC_REQUIRED_SUBJECT` (strict claim tests)
- `GOOGLE_*` (if testing Gmail OAuth)
- `GMAIL_PUSH_*` (if testing push)

### 3. Local OIDC defaults

- Keycloak realm: `simplemail`
- User: `demo` / `demo123`
- Admin: `http://localhost:8080/admin` (`admin` / `admin`)
- Single-user auth model: `OIDC_ALLOWED_EMAILS` must contain exactly one email

### 4. Developer Gmail OAuth setup

Google Console flow is same as production, but use local redirect URI:

- `http://localhost:3000/api/oauth/google/callback`

Set in `.env`:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI=http://localhost:3000/api/oauth/google/callback`

### 5. Developer Gmail Pub/Sub setup

Set in `.env`:

- `GMAIL_PUSH_ENABLED=true`
- `GMAIL_PUSH_TOPIC_NAME=projects/<PROJECT_ID>/topics/<TOPIC_NAME>`
- `GMAIL_PUSH_WEBHOOK_PATH=/api/gmail/push`
- `GMAIL_PUSH_WEBHOOK_AUDIENCE=<audience>`
- `GMAIL_PUSH_SERVICE_ACCOUNT_EMAIL=<service-account-email>`

Google setup is same as production:

- Enable Pub/Sub API
- Topic + push subscription
- Grant topic publisher role to `gmail-api-push@system.gserviceaccount.com`
- Configure subscription push auth (OIDC service account + matching audience)

### 6. Developer Cloudflare Tunnel workflow

For local webhook testing from Google:

```bash
cloudflared tunnel --url http://localhost:3000
```

Then update:

- `APP_BASE_URL=<tunnel-url>`
- `GOOGLE_REDIRECT_URI=<tunnel-url>/api/oauth/google/callback`
- `GMAIL_PUSH_WEBHOOK_AUDIENCE=<tunnel-url>/api/gmail/push`

### 7. Useful commands

```bash
scripts/dev.sh status
scripts/dev.sh attach
scripts/dev.sh restart
scripts/dev.sh stop
```

### 8. Maintainer release flow

This repository ships images from GitHub Actions on version tags.

Prerequisites:

- Repo secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`
- Optional repo vars:
  - `DOCKERHUB_NAMESPACE` (defaults to repository owner)
  - `DOCKERHUB_BACKEND_IMAGE` (defaults to `simplemail-backend`)
  - `DOCKERHUB_CLIENT_IMAGE` (defaults to `simplemail-client`)

Create a release:

```bash
scripts/release.sh
```

The script asks for `patch/minor/major`, bumps backend/client versions, commits, tags (`vX.Y.Z`), and pushes.

On tag push, GitHub Actions:

- runs backend/client verification
- builds multi-arch Docker images with Buildx (`linux/amd64`, `linux/arm64`)
- pushes image tags (`X.Y.Z`, `X.Y`, `X`, `sha-*`, and `latest` for stable tags)
- creates the GitHub Release with generated notes

</details>
