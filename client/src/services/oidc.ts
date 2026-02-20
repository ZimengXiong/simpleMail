import Keycloak from 'keycloak-js';
import { api } from './api';

type RuntimeConfig = Partial<Record<'VITE_OIDC_BASE_URL' | 'VITE_OIDC_REALM' | 'VITE_OIDC_CLIENT_ID', string>>;

declare global {
  interface Window {
    __SIMPLEMAIL_CONFIG__?: RuntimeConfig;
  }
}

const readEnv = (key: string, fallback: string): string => {
  const runtimeValue = window.__SIMPLEMAIL_CONFIG__?.[key as keyof RuntimeConfig];
  const value = (runtimeValue ?? (import.meta.env[key] as string | undefined))?.trim();
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
const AUTO_LOGIN_DISABLED_KEY = 'simplemail:oidc:auto-login-disabled';

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
    const autoLoginDisabled = window.sessionStorage.getItem(AUTO_LOGIN_DISABLED_KEY) === '1';
    const authenticated = await keycloak.init({
      onLoad: autoLoginDisabled ? undefined : 'check-sso',
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
  window.sessionStorage.removeItem(AUTO_LOGIN_DISABLED_KEY);
  const target = String(redirectUri || '').trim();
  await keycloak.login({ redirectUri: target || window.location.href });
};

export const logoutOidc = async () => {
  window.sessionStorage.setItem(AUTO_LOGIN_DISABLED_KEY, '1');
  try {
    keycloak.clearToken();
  } catch {
  }
  api.auth.logout();
};
