# simpleMail (Self-hosted MVP Backend)

Backend implementation for Gmail + generic SMTP clients with:
- Connector-first model for incoming IMAP and outgoing SMTP
- OAuth2 for Gmail API (incoming sync/actions + send) and IMAP/SMTP for generic providers
- Postgres metadata + FTS search + threading
- SeaweedFS S3-compatible storage for raw messages and attachments
- Rules engine and sync event stream API
- Optional ClamAV attachment scanning and Web Push notifications
- Graphile Worker for sync/send jobs
- IDLE-capable IMAP watcher for near-realtime updates (per mailbox)

## Run locally (dev)

```bash
cd <repo-root>
cp .env.example .env
scripts/prepare-env.sh .env
npm install
npm run migrate
npm run worker:migrate
npm run dev
```

API is available at `http://localhost:3000`.

### Development OIDC (Keycloak)

`scripts/dev.sh start` now starts a local Keycloak service from `docker-compose.dev.yml` and imports
`deploy/keycloak/simplemail-realm.json`.

Default dev credentials:

- realm: `simplemail`
- app user: `demo` / `demo123` (`demo@local.test`)
- admin console: `http://localhost:8080/admin` with `admin` / `admin`

OIDC defaults are preconfigured in `.env.example`:

- `OIDC_ISSUER_URL=http://localhost:8080/realms/simplemail`
- `OIDC_CLIENT_ID=simplemail-web`
- `OIDC_ALLOWED_EMAILS=demo@local.test`
- `OIDC_ALLOWED_ALGS=RS256`
- `OIDC_REQUIRE_EMAIL_VERIFIED=false` (development default)

`OIDC_ALLOWED_EMAILS` is single-user in current backend scope and must contain exactly one email.

## Docker compose

```bash
docker compose up --build
```

Run migrations once db is online:

```bash
docker compose run --rm migrate
docker compose run --rm worker-migrate
```

Then start:

```bash
docker compose up -d api worker
```

### Production guardrails

- Set `API_ADMIN_TOKEN` in production (minimum 24 chars). Admin routes (for bootstrap/management) require it as `x-api-key`.
- Keep `ALLOW_ADMIN_USER_BOOTSTRAP=false` unless you intentionally need the legacy admin-user bootstrap endpoint.
- All user routes require a valid OIDC access token in `Authorization: Bearer <token>`.
- Set `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_ALLOWED_EMAILS`, and `OIDC_ALLOWED_ALGS` explicitly in production.
- `POST /api/health` and OAuth callback are intentionally public.
- Run both migration tasks before first deployment (`migrate`, `worker-migrate`).
- Keep API, worker, Postgres, and SeaweedFS in the same compose stack for single-host operation.

For production you can skip `npm install` locally and use the Docker build only. The compose stack includes:

- `postgres`
- SeaweedFS master/volume/filer with S3 API on port 8333
- API
- worker
- app schema migration one-shot task (`migrate`)
- graphile worker migration one-shot task (`worker-migrate`)

## Gmail OAuth credentials

`/api/oauth/google/authorize` supports optional `oauthClientId`/`oauthClientSecret` in the request body.
These values are persisted to the connector and reused during callback and token refresh.
- request body: `{ type, connectorId, oauthClientId?, oauthClientSecret? }`
- callback: `/api/oauth/google/callback?code=...&state=...`

## Gmail OAuth flow

1. Create connector (`provider: gmail`).
2. Call `POST /api/oauth/google/authorize`.
3. Open returned `authorizeUrl` in browser.
4. Gmail redirects to `/api/oauth/google/callback`.

## New API endpoints in full MVP

- `POST /api/connectors/incoming`
- `POST /api/connectors/outgoing`
- `POST /api/identities`
- `POST /api/sync/:connectorId` (sync once or queue with `useQueue=true`)
- `POST /api/sync/:connectorId/watch` start IMAP idle watcher
- `GET /api/connectors/:connectorId/mailboxes`
- `POST /api/sync/:connectorId/watch/stop` stop IMAP idle watcher
- `GET /api/messages` / query params `folder`, `limit`
- `POST /api/messages/send` accepts optional `attachments`:
  - `[{ filename, contentType, contentBase64, inline?, contentId? }]`
- `GET /api/messages/thread/:threadId`
- `GET /api/messages/:id/attachments`
- `GET /api/attachments/:id/download`
- `POST /api/rules` / `DELETE /api/rules/:id` / `GET /api/rules`
- `GET /api/events` (simple polling stream)
- `POST /api/push/subscribe`, `DELETE /api/push/subscribe`
- `POST /api/attachments/scan`

## Kubernetes manifests

- `deploy/k8s/api.yaml`
- `deploy/k8s/worker.yaml`
- `deploy/k8s/worker-migrate.yaml` (Graphile Worker schema migration job)

Note: include your PostgreSQL and SeaweedFS deployments separately for your cluster (or replace with managed alternatives).

## Backend scope

This repository is backend-only for MVP. There is no frontend app in this branch.
