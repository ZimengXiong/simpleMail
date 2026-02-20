import { api } from './api';

type RuntimeConfig = Partial<Record<
  'VITE_OIDC_ISSUER_URL' | 'VITE_OIDC_CLIENT_ID' | 'VITE_OIDC_SCOPES',
  string
>>;

declare global {
  interface Window {
    __SIMPLEMAIL_CONFIG__?: RuntimeConfig;
  }
}

const OIDC_STORAGE_KEY = 'simplemail:oidc:token';
const OIDC_STATE_KEY = 'simplemail:oidc:state';
const AUTO_LOGIN_DISABLED_KEY = 'simplemail:oidc:auto-login-disabled';

type OidcDiscoveryDocument = {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
};

type OidcAuthState = {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  nextPath: string;
};

type StoredOidcToken = {
  token: string;
  exp: number | null;
  refreshToken?: string;
};

let discoveryPromise: Promise<OidcDiscoveryDocument> | null = null;
let refreshPromise: Promise<boolean> | null = null;
let refreshTimer: number | null = null;

const readEnv = (key: keyof RuntimeConfig, fallback = ''): string => {
  const runtimeValue = window.__SIMPLEMAIL_CONFIG__?.[key];
  const value = (runtimeValue ?? (import.meta.env[key] as string | undefined))?.trim();
  return value && value.length > 0 ? value : fallback;
};

const resolveIssuerUrl = (): string => {
  const issuer = readEnv('VITE_OIDC_ISSUER_URL');
  if (issuer) {
    return issuer.replace(/\/+$/, '');
  }
  throw new Error('Missing VITE_OIDC_ISSUER_URL');
};

const oidcConfig = {
  issuerUrl: resolveIssuerUrl(),
  clientId: readEnv('VITE_OIDC_CLIENT_ID', 'simplemail-web'),
  scopes: readEnv('VITE_OIDC_SCOPES', 'openid profile email'),
};

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

const randomString = (size = 32): string => {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
};

const sha256Base64Url = async (value: string): Promise<string> => {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return toBase64Url(new Uint8Array(digest));
};

const parseJwtExp = (token: string): number | null => {
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
};

const clearRefreshTimer = () => {
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
};

const scheduleTokenRefresh = () => {
  clearRefreshTimer();
  const raw = window.sessionStorage.getItem(OIDC_STORAGE_KEY);
  if (!raw) {
    return;
  }
  try {
    const stored = JSON.parse(raw) as StoredOidcToken;
    if (!stored.refreshToken || !stored.exp) {
      return;
    }
    const refreshAtMs = (stored.exp * 1000) - 60_000;
    const delayMs = Math.max(5_000, refreshAtMs - Date.now());
    refreshTimer = window.setTimeout(() => {
      void refreshTokenIfNeeded(true);
    }, delayMs);
  } catch {
    clearRefreshTimer();
  }
};

const saveToken = (token: string, refreshToken?: string) => {
  const raw = window.sessionStorage.getItem(OIDC_STORAGE_KEY);
  const previous = raw ? (JSON.parse(raw) as StoredOidcToken) : null;
  const stored: StoredOidcToken = {
    token,
    exp: parseJwtExp(token),
    refreshToken: refreshToken ?? previous?.refreshToken,
  };
  window.sessionStorage.setItem(OIDC_STORAGE_KEY, JSON.stringify(stored));
  api.auth.login(token);
  scheduleTokenRefresh();
};

const clearStoredToken = () => {
  clearRefreshTimer();
  window.sessionStorage.removeItem(OIDC_STORAGE_KEY);
  api.auth.clear();
};

const restoreToken = () => {
  const raw = window.sessionStorage.getItem(OIDC_STORAGE_KEY);
  if (!raw) {
    return;
  }
  try {
    const stored = JSON.parse(raw) as StoredOidcToken;
    if (!stored.token) {
      clearStoredToken();
      return;
    }
    if (stored.exp && stored.exp * 1000 <= Date.now() && !stored.refreshToken) {
      clearStoredToken();
      return;
    }
    scheduleTokenRefresh();
    api.auth.login(stored.token);
  } catch {
    clearStoredToken();
  }
};

const refreshTokenIfNeeded = async (force = false): Promise<boolean> => {
  if (refreshPromise) {
    return refreshPromise;
  }

  const raw = window.sessionStorage.getItem(OIDC_STORAGE_KEY);
  if (!raw) {
    return false;
  }

  let stored: StoredOidcToken;
  try {
    stored = JSON.parse(raw) as StoredOidcToken;
  } catch {
    clearStoredToken();
    return false;
  }

  if (!stored.refreshToken) {
    return false;
  }

  const expiresSoon = stored.exp ? ((stored.exp * 1000) - Date.now()) <= 60_000 : false;
  if (!force && !expiresSoon) {
    return true;
  }

  refreshPromise = (async () => {
    try {
      const discovery = await loadDiscoveryDocument();
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken as string,
        client_id: oidcConfig.clientId,
      });

      const response = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: unknown } | null;
        const errorCode = String(body?.error ?? '').trim().toLowerCase();
        if (response.status === 400 || response.status === 401 || errorCode === 'invalid_grant') {
          clearStoredToken();
          return false;
        }
        scheduleTokenRefresh();
        return false;
      }

      const payload = await response.json() as { id_token?: string; access_token?: string; refresh_token?: string };
      const nextToken = String(payload.id_token ?? payload.access_token ?? '').trim();
      if (!nextToken) {
        scheduleTokenRefresh();
        return false;
      }
      saveToken(nextToken, payload.refresh_token);
      return true;
    } catch {
      scheduleTokenRefresh();
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
};

const loadDiscoveryDocument = async (): Promise<OidcDiscoveryDocument> => {
  if (!discoveryPromise) {
    const url = `${oidcConfig.issuerUrl}/.well-known/openid-configuration`;
    discoveryPromise = fetch(url).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed OIDC discovery (${response.status})`);
      }
      const json = await response.json() as Partial<OidcDiscoveryDocument>;
      if (!json.authorization_endpoint || !json.token_endpoint) {
        throw new Error('OIDC discovery missing required endpoints');
      }
      return {
        authorization_endpoint: json.authorization_endpoint,
        token_endpoint: json.token_endpoint,
        end_session_endpoint: json.end_session_endpoint,
      };
    });
  }
  return discoveryPromise;
};

const saveAuthState = (state: OidcAuthState) => {
  window.sessionStorage.setItem(OIDC_STATE_KEY, JSON.stringify(state));
};

const readAuthState = (): OidcAuthState | null => {
  const raw = window.sessionStorage.getItem(OIDC_STATE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as OidcAuthState;
    if (!parsed.state || !parsed.codeVerifier || !parsed.redirectUri) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const clearAuthState = () => {
  window.sessionStorage.removeItem(OIDC_STATE_KEY);
};

const shouldHandleLoginCallback = () => {
  if (window.location.pathname !== '/login') {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  return params.has('code') && params.has('state');
};

const exchangeCodeForToken = async () => {
  const params = new URLSearchParams(window.location.search);
  const code = String(params.get('code') ?? '').trim();
  const state = String(params.get('state') ?? '').trim();
  const error = String(params.get('error') ?? '').trim();
  const errorDescription = String(params.get('error_description') ?? '').trim();

  if (error) {
    throw new Error(errorDescription || error);
  }

  const savedState = readAuthState();
  if (!savedState || savedState.state !== state || !code) {
    throw new Error('Invalid OIDC callback state');
  }

  const discovery = await loadDiscoveryDocument();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: oidcConfig.clientId,
    redirect_uri: savedState.redirectUri,
    code_verifier: savedState.codeVerifier,
  });

  const response = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`OIDC token exchange failed (${response.status})`);
  }

  const payload = await response.json() as { id_token?: string; access_token?: string; refresh_token?: string };
  const token = String(payload.id_token ?? payload.access_token ?? '').trim();
  if (!token) {
    throw new Error('OIDC token response missing id_token/access_token');
  }

  saveToken(token, payload.refresh_token);
  clearAuthState();

  const redirectPath = savedState.nextPath || '/inbox';
  window.location.replace(redirectPath);
};

export const initOidcAuth = async () => {
  restoreToken();
  await refreshTokenIfNeeded(false);
  if (shouldHandleLoginCallback()) {
    await exchangeCodeForToken();
  }
};

export const startOidcLogin = async (redirectUri?: string) => {
  window.sessionStorage.removeItem(AUTO_LOGIN_DISABLED_KEY);
  const discovery = await loadDiscoveryDocument();
  const callbackUrl = `${window.location.origin}/login`;
  const target = String(redirectUri || '').trim();
  const nextPath = (() => {
    if (!target) return '/inbox';
    try {
      const parsed = new URL(target);
      if (parsed.origin === window.location.origin) {
        return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/inbox';
      }
    } catch {
      if (target.startsWith('/')) {
        return target;
      }
    }
    return '/inbox';
  })();

  const state = randomString(24);
  const nonce = randomString(24);
  const codeVerifier = randomString(48);
  const codeChallenge = await sha256Base64Url(codeVerifier);

  saveAuthState({
    state,
    nonce,
    codeVerifier,
    redirectUri: callbackUrl,
    nextPath,
  });

  const authorizeUrl = new URL(discovery.authorization_endpoint);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', oidcConfig.clientId);
  authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
  authorizeUrl.searchParams.set('scope', oidcConfig.scopes);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('nonce', nonce);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  window.location.assign(authorizeUrl.toString());
};

export const logoutOidc = async () => {
  window.sessionStorage.setItem(AUTO_LOGIN_DISABLED_KEY, '1');
  clearStoredToken();
  clearAuthState();

  try {
    const discovery = await loadDiscoveryDocument();
    if (!discovery.end_session_endpoint) {
      return;
    }
    const logoutUrl = new URL(discovery.end_session_endpoint);
    logoutUrl.searchParams.set('post_logout_redirect_uri', `${window.location.origin}/login`);
    window.location.assign(logoutUrl.toString());
  } catch {
    window.location.assign('/login');
  }
};
