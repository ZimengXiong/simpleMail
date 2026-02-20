<img src="./client/public/logo-128.svg" width="64" height="64" alt="simpleMail logo" style="display:block; margin:0; border:0;" />

# simpleMail

simpleMail is a self-hosted mail app stack (UI + API + worker). It is intentionally a simple email system focused on core workflows. Built with Fastify, Graphile Worker for background jobs, and PostgreS and SeaweedFS for storage.

![](readme-assets/screenshot.png)

## Features

What it supports now:

- Gmail connector support w/ pub sub
- Generic IMAP/SMTP connector support
- Basic mailbox sync, threading, reading, composing, sending, starring, and replying

What it does not include (yet):

- Drafts
- Role-based filtering/routing
- Advanced rule engines/automations
- Email forwarding workflows
- Moving mail between folders

## Quick Start

### 1. Create env file

```bash
cp .env.example .env
scripts/bootstrap-env.sh .env
```

### 2. Set required env vars in `.env`

Set these values:

- `APP_BASE_URL`
- `FRONTEND_BASE_URL`
- `OIDC_ISSUER_URL`
- `OIDC_CLIENT_ID`
- `OIDC_ALLOWED_EMAILS` (exactly one email)
- `VITE_OIDC_ISSUER_URL`
- `VITE_OIDC_CLIENT_ID`

OIDC setup is bring-your-own provider (external to this repository). The bundled Keycloak service is dev-only and only starts when explicitly using the `dev-oidc` profile.

If your backend container cannot reach your issuer URL directly, also set:

- `OIDC_JWKS_URI` (container-reachable JWKS endpoint for the same issuer)

Optional for non-HTTPS local/private OIDC providers:

- `OIDC_ALLOW_INSECURE_HTTP=true`

To reduce frequent sign-in prompts, include refresh scope in frontend OIDC scopes:

- `VITE_OIDC_SCOPES=openid profile email offline_access`

### 3. Start the stack

```bash
docker compose pull
docker compose up -d
```

### 4. Verify

- UI: `http://localhost:7676`
- API health: `http://localhost:3000/api/health`

### 5. Extra configuration options

<details>
  <summary>Google / Gmail API (OAuth connector)</summary>

Before adding a Gmail connector, create OAuth credentials in Google Cloud:

1. Open Credentials: `https://console.cloud.google.com/apis/credentials`
2. Create/select project: `https://console.cloud.google.com/projectcreate`
3. Enable Gmail API: `https://console.cloud.google.com/apis/api/gmail.googleapis.com`
4. Configure OAuth consent screen: `https://console.cloud.google.com/auth/branding`
5. If app is in Testing, add test users: `https://console.cloud.google.com/auth/audience`
6. Create OAuth client at `https://console.cloud.google.com/auth/clients`
7. Use application type `Web application` and add authorized redirect URI matching `GOOGLE_REDIRECT_URI` (default `http://localhost:3000/api/oauth/google/callback`)

NOTE: Gmail via IMAP is more reliable in my experience than Gmail over API.

Set these env vars:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` (must match callback configured in Google Cloud Console)

</details>

<details>
  <summary>Google Gmail Pub/Sub webhooks</summary>

Gmail Pub/Sub push delivery requires a public HTTPS endpoint that Google can reach. For local/self-hosted setups, use a tunnel/domain (for example Cloudflare Tunnel) and point your webhook audience/base URL to that HTTPS endpoint.

Google Cloud setup:

1. Enable Gmail API: `https://console.cloud.google.com/apis/api/gmail.googleapis.com`
2. Enable Cloud Pub/Sub API: `https://console.cloud.google.com/apis/api/pubsub.googleapis.com`
3. Create a Pub/Sub topic and subscription for Gmail push
4. Grant publish permission on your topic to `gmail-api-push@system.gserviceaccount.com`
5. Set webhook audience to your public HTTPS webhook URL

Set these when enabling push sync:

- `GMAIL_PUSH_ENABLED=true`
- `GMAIL_PUSH_TOPIC_NAME`
- `GMAIL_PUSH_WEBHOOK_PATH`
- `GMAIL_PUSH_WEBHOOK_AUDIENCE`
- `GMAIL_PUSH_SERVICE_ACCOUNT_EMAIL`

Notes:

- Webhook endpoint must be publicly reachable over HTTPS.
- Pub/Sub OIDC audience should match your webhook URL/audience expectation.

</details>

## Developer

<details>
  <summary>Developer setup and repo workflow</summary>

Environment files:

- User/deploy template: `.env.example`
- Local runtime env (manual): `.env`
- Dev-script env (optional): `.env.dev`
- Docker deploy bootstrap: `scripts/bootstrap-env.sh .env`

Development scripts:

- Start dev workflow: `./scripts/dev.sh start`
- Attach tmux session: `./scripts/dev.sh attach`
- Stop: `./scripts/dev.sh stop`
- Restart: `./scripts/dev.sh restart`
- Logs: `./scripts/dev.sh logs`

Dev stack notes:

- `docker-compose.dev.yml` is aligned with production requirements, but app services build from local source.
- `docker-compose.yml` is for image-based deploy flow (pulls configured repositories/tags).

Bundled Keycloak:

- A bundled Keycloak service exists for development/testing and is started via `dev-oidc` profile.
- End-user/production OIDC is expected to be external (BYO provider).

Where to find key config docs:

- Full env variable descriptions: `.env.example`
- Release flow/local vs GitHub publish toggle: `scripts/release.sh`
- CI/release pipeline: `.github/workflows/release.yml`

</details>

## Screenshots

![](readme-assets/threading.png)
![](readme-assets/settings.png)
![](readme-assets/appearance.png)
