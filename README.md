# simpleMail

simpleMail is a self-hosted mail app stack with:
- React client (`client/`)
- Fastify API (`backend/`)
- Postgres storage
- SeaweedFS S3-compatible object storage
- OIDC auth (Keycloak dev defaults, bring-your-own provider supported)
- Gmail OAuth (incoming + outgoing)
- Optional Gmail Pub/Sub push sync

This guide is the complete setup reference for local development and production-style cloud setup.

## 1. Prerequisites

- Node.js 20+ and npm
- Docker + Docker Compose
- `tmux` (used by `scripts/dev.sh`)
- Google Cloud project (if using Gmail OAuth / Pub/Sub)

## 2. Local Development (Fastest Path)

From repo root:

```bash
cp .env.example .env
cp client/.env.example client/.env
cd backend && npm install
cd ../client && npm install
cd ..
scripts/dev.sh start
```

What `scripts/dev.sh start` does:
- Starts infra from `docker-compose.dev.yml`:
  - Postgres
  - SeaweedFS
  - Keycloak (dev realm import)
- Starts:
  - API on `http://localhost:3000`
  - Worker
  - Client on `http://0.0.0.0:5173` (LAN reachable)

Attach logs/processes:

```bash
scripts/dev.sh attach
```

Status:

```bash
scripts/dev.sh status
```

Stop:

```bash
scripts/dev.sh stop
```

Wipe app DB only (keeps Keycloak/OIDC data):

```bash
scripts/dev.sh wipe-db
```

## 3. Dev OIDC Credentials (Keycloak)

Dev Keycloak is auto-imported from `deploy/keycloak/simplemail-realm.json`.

- Realm: `simplemail`
- App user: `demo` / `demo123` (`demo@local.test`)
- Admin console: `http://localhost:8080/admin`
- Admin login: `admin` / `admin`
- OIDC client ID: `simplemail-web`

Default dev env values:
- Backend `.env`:
  - `OIDC_ISSUER_URL=http://localhost:8080/realms/simplemail`
  - `OIDC_CLIENT_ID=simplemail-web`
  - `OIDC_REQUIRED_EMAIL=demo@local.test`
- Frontend `client/.env`:
  - `VITE_OIDC_BASE_URL=http://localhost:8080`
  - `VITE_OIDC_REALM=simplemail`
- `VITE_OIDC_CLIENT_ID=simplemail-web`

## 4. Phone/LAN Testing

Client already binds to `0.0.0.0` via `scripts/dev.sh`. API listens on `0.0.0.0:3000`.

Use your machine LAN IP from phone, for example:
- `http://192.168.1.25:5173`
- OIDC server should then be reachable at `http://192.168.1.25:8080`

For Keycloak client (`simplemail-web`), add:
- Redirect URIs:
  - `http://localhost:5173/*`
  - `http://<LAN_IP>:5173/*`
- Web Origins:
  - `http://localhost:5173`
  - `http://<LAN_IP>:5173`
- Post logout redirect URIs:
  - `http://localhost:5173/*`
  - `http://<LAN_IP>:5173/*`

Optional host override:

```bash
SIMPLEMAIL_CLIENT_HOST=0.0.0.0 scripts/dev.sh start
```

## 5. Bring Your Own OIDC Provider

You can use Auth0, Okta, Entra ID, Cognito, another Keycloak, etc.

Backend requirements:
- Access tokens must be JWTs signed with asymmetric algs (`RS*`, `PS*`, `ES*`, `EdDSA`).
- Issuer must match `OIDC_ISSUER_URL`.
- Audience/authorized party must match `OIDC_CLIENT_ID` (comma-separated list allowed).
- Token must include:
  - Email: `email` or `preferred_username`
  - Subject: one of `sub` / `oid` / `uid` / `user_id` (falls back to `email:<email>` if missing)
- If `OIDC_REQUIRE_EMAIL_VERIFIED=true`, token must have `email_verified=true`.

Required backend OIDC env:
- `OIDC_ISSUER_URL`
- `OIDC_CLIENT_ID`
- `OIDC_REQUIRED_EMAIL` (single-user gate; required by server)
- Optional: `OIDC_JWKS_URI` (if not default issuer certs path)
- Optional: `OIDC_ALLOWED_ALGS` (default `RS256`)
- Optional: `OIDC_REQUIRE_EMAIL_VERIFIED`

Frontend OIDC env:
- `VITE_OIDC_BASE_URL`
- `VITE_OIDC_REALM` (for Keycloak-style config)
- `VITE_OIDC_CLIENT_ID`

## 6. Gmail OAuth Setup (Google Cloud)

### 6.1 Enable APIs

In Google Cloud Console, enable:
- Gmail API
- Pub/Sub API (if using Gmail push)

### 6.2 OAuth Consent Screen

Configure OAuth consent screen in your Google Cloud project.
- External or internal app type is fine for dev.
- Add test users if app is not published.
- Scopes used by simpleMail include Gmail read/send and user email.

### 6.3 OAuth Client

Create OAuth 2.0 Client ID (`Web application`).

Add authorized redirect URI:
- `http://localhost:3000/api/oauth/google/callback` (dev)
- `https://<your-api-domain>/api/oauth/google/callback` (prod)

Then set in `.env`:
- `GOOGLE_CLIENT_ID=<client-id>`
- `GOOGLE_CLIENT_SECRET=<client-secret>`
- `GOOGLE_REDIRECT_URI=<same redirect URI configured above>`

### 6.4 In-App OAuth Flow

When you add a Gmail connector in UI:
1. simpleMail creates connector(s).
2. Backend calls `/api/oauth/google/authorize`.
3. You sign in/consent at Google.
4. Google redirects to `/api/oauth/google/callback`.
5. Backend stores tokens and starts initial sync.

## 7. Gmail Pub/Sub Push Setup (Google Cloud)

This section is required only if you want push notifications instead of polling-only sync.

### 7.1 One-Time Project Setup

Create a Pub/Sub topic, e.g.:
- `projects/<PROJECT_ID>/topics/simplemail-gmail-push`

Grant publisher role on that topic to Gmail push service identity:
- `gmail-api-push@system.gserviceaccount.com`
- Role: `Pub/Sub Publisher` on the topic

This project/topic setup is one-time per project/environment.

### 7.2 Push Subscription to simpleMail Webhook

Create push subscription for that topic:
- Push endpoint: `https://<your-api-domain>/api/gmail/push`
- Use authenticated push (OIDC token)
- Audience should match simpleMail expectation:
  - default: `${APP_BASE_URL}${GMAIL_PUSH_WEBHOOK_PATH}`
  - example: `https://api.example.com/api/gmail/push`
- Use a dedicated service account for push auth, for example:
  - `pubsub-push@<PROJECT_ID>.iam.gserviceaccount.com`

Then set backend env:
- `GMAIL_PUSH_ENABLED=true`
- `GMAIL_PUSH_TOPIC_NAME=projects/<PROJECT_ID>/topics/<TOPIC_NAME>`
- `GMAIL_PUSH_WEBHOOK_PATH=/api/gmail/push`
- `GMAIL_PUSH_WEBHOOK_AUDIENCE=<audience-used-by-subscription>` (or leave empty for default)
- `GMAIL_PUSH_SERVICE_ACCOUNT_EMAIL=<push service account email>`

Important:
- simpleMail verifies bearer token issuer, audience, and service account email.
- If these do not match, webhook returns 401.

### 7.3 Per-Account Behavior

- Cloud Console Pub/Sub setup is one-time.
- Each Gmail account still needs OAuth authorization.
- Gmail watch registration is per connector/account and is renewed automatically.

## 8. Production Minimum Checklist

- Set strong `API_ADMIN_TOKEN` (24+ chars)
- `ALLOW_ADMIN_USER_BOOTSTRAP=false`
- `APP_BASE_URL` and `FRONTEND_BASE_URL` use HTTPS
- OIDC values set explicitly for production provider
- `GOOGLE_REDIRECT_URI` uses your production API domain
- If using Gmail push: all `GMAIL_PUSH_*` values configured and webhook reachable from Google
- Run migrations before start:
  - `docker compose run --rm migrate`
  - `docker compose run --rm worker-migrate`

## 9. Environment Variables (Root `.env`)

Most values are already documented in `.env.example`. Key groups:

- Core:
  - `DATABASE_URL`, `PORT`, `NODE_ENV`, `APP_BASE_URL`, `FRONTEND_BASE_URL`, `OAUTH_CALLBACK_PATH`
- Admin/Auth:
  - `API_ADMIN_TOKEN`, `ALLOW_ADMIN_USER_BOOTSTRAP`
- OIDC:
  - `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_JWKS_URI`, `OIDC_REQUIRED_EMAIL`, `OIDC_REQUIRED_SUBJECT`, `OIDC_ALLOWED_ALGS`, `OIDC_REQUIRE_EMAIL_VERIFIED`
- Google OAuth:
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
- Gmail Push:
  - `GMAIL_PUSH_ENABLED`, `GMAIL_PUSH_TOPIC_NAME`, `GMAIL_PUSH_WEBHOOK_PATH`, `GMAIL_PUSH_WEBHOOK_AUDIENCE`, `GMAIL_PUSH_SERVICE_ACCOUNT_EMAIL`
- SeaweedFS/S3:
  - `SEAWEED_S3_ENDPOINT`, `SEAWEED_REGION`, `SEAWEED_BUCKET`, `SEAWEED_ACCESS_KEY_ID`, `SEAWEED_SECRET_ACCESS_KEY`, `SEAWEED_FORCE_PATH_STYLE`
- Sync:
  - `SYNC_USE_IDLE`, `DEFAULT_MAILBOX`, `GMAIL_BOOTSTRAP_METADATA_ONLY`, `GMAIL_BOOTSTRAP_CONCURRENCY`, `GMAIL_BACKGROUND_HYDRATE_*`, and other `SYNC_*` knobs
- Optional security/notifications:
  - `CLAMAV_*`, `WEB_PUSH_*`, `ALLOW_INSECURE_MAIL_TRANSPORT`, `ALLOW_PRIVATE_NETWORK_TARGETS`

Frontend env (`client/.env`):
- `VITE_OIDC_BASE_URL`
- `VITE_OIDC_REALM`
- `VITE_OIDC_CLIENT_ID`

## 10. Sync Semantics (Gmail)

- Initial connector bootstrap discovers Gmail folders/labels and seeds sync targets (not just Inbox).
- `GMAIL_BOOTSTRAP_METADATA_ONLY=true`:
  - Fast startup: metadata first, message bodies hydrated in background.
- `GMAIL_BOOTSTRAP_METADATA_ONLY=false`:
  - Heavier initial sync: fetches full content earlier.

## 11. Troubleshooting

- `GET /api/session 401` before login:
  - Expected when not authenticated yet.
- Repeated duplicate log lines in dev:
  - React Strict Mode double-invokes effects in development.
- OIDC login loops or callback errors:
  - Verify issuer URL, client ID, redirect URIs, and frontend origin in IdP settings.
- Gmail OAuth callback fails:
  - Redirect URI mismatch between Google Console and `GOOGLE_REDIRECT_URI`.
- Gmail push 401:
  - Check `GMAIL_PUSH_WEBHOOK_AUDIENCE` and `GMAIL_PUSH_SERVICE_ACCOUNT_EMAIL`.
- Gmail push not delivering:
  - Ensure topic IAM includes `gmail-api-push@system.gserviceaccount.com` as publisher.
