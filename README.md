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

OIDC setup is bring-your-own provider (external to this repository). The bundled Keycloak service is dev-only and only starts when explicitly using the `dev-oidc` profile.

If your backend container cannot reach your issuer URL directly, also set:

- `OIDC_JWKS_URI` (container-reachable JWKS endpoint for the same issuer)

Optional for non-HTTPS local/private OIDC providers:

- `OIDC_ALLOW_INSECURE_HTTP=true`

### 3. Start the stack

```bash
docker compose pull
docker compose up -d
```

### 4. Verify

- UI: `http://localhost:5173`
- API health: `http://localhost:3000/api/health`
