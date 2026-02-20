<img src="./client/public/logo-128.svg" width="64" height="64" alt="simpleMail logo" style="display:block; margin:0; border:0;" />

# simpleMail

simpleMail is a self-hosted mail app stack (UI + API + worker) with OIDC login.

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

No internal infrastructure variables are required for first boot. Seaweed and other internal defaults are prewired.

Image settings are already defaulted to Docker Hub:

- `SIMPLEMAIL_BACKEND_REPOSITORY=docker.io/zimengxiong/simplemail-backend`
- `SIMPLEMAIL_CLIENT_REPOSITORY=docker.io/zimengxiong/simplemail-client`
- `SIMPLEMAIL_VERSION=latest` (or pin to a release like `v1.2.3`)

### 3. Start the stack

```bash
docker compose pull
docker compose up -d
```

That is the full deployment flow.

### 4. Verify

- UI: `http://localhost:5173`
- API health: `http://localhost:3000/api/health`
