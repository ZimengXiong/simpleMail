import Keycloak from 'keycloak-js';
import { api } from './api';

const readEnv = (key: string, fallback: string): string => {
  const value = (import.meta.env[key] as string | undefined)?.trim();
  return value && value.length > 0 ? value : fallback;
};

const resolveDefaultOidcBaseUrl = () => {
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  return `${protocol}//${window.location.hostname}:8080`;
};

const keycloak = new Keycloak({
  url: readEnv('VITE_OIDC_BASE_URL', resolveDefaultOidcBaseUrl()),
  realm: readEnv('VITE_OIDC_REALM', 'simplemail'),
  clientId: readEnv('VITE_OIDC_CLIENT_ID', 'simplemail-web'),
});

let initialized = false;
let initializePromise: Promise<void> | null = null;
let refreshTimerId: number | null = null;

const syncRuntimeToken = () => {
  if (keycloak.token) {
    api.auth.login(keycloak.token);
  }
};

const refreshTokenIfNeeded = async (minValiditySeconds = 30) => {
  if (!initialized) {
    return;
  }
  const refreshed = await keycloak.updateToken(minValiditySeconds);
  if (refreshed || keycloak.token) {
    syncRuntimeToken();
  }
};

const ensureRefreshLoop = () => {
  if (refreshTimerId !== null) {
    return;
  }
  refreshTimerId = window.setInterval(() => {
    void refreshTokenIfNeeded(30).catch(() => {
      api.auth.logout();
    });
  }, 15_000);
};

export const initOidcAuth = async () => {
  if (initialized) {
    return;
  }
  if (initializePromise) {
    return initializePromise;
  }

  initializePromise = (async () => {
    const authenticated = await keycloak.init({
      onLoad: 'check-sso',
      pkceMethod: 'S256',
      checkLoginIframe: false,
    });

    initialized = true;
    if (authenticated && keycloak.token) {
      syncRuntimeToken();
      ensureRefreshLoop();
      return;
    }
    api.auth.clear();
  })();

  return initializePromise;
};

export const startOidcLogin = async (redirectUri?: string) => {
  const target = String(redirectUri || '').trim();
  await keycloak.login({ redirectUri: target || window.location.href });
};
