import { randomUUID } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { updateIncomingConnectorAuth, updateOutgoingConnectorAuth } from './connectorService.js';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
];
const INVALID_GRANT_REGEX = /invalid[_\s-]grant|unauthorized|disabled|permission.?denied|rejected/i;

export interface OAuthState {
  type: 'incoming' | 'outgoing';
  connectorId: string;
  userId?: string;
}

const stateStore = new Map<string, { expiresAt: number; payload: OAuthState }>();

const getGoogleClient = (clientId?: string, clientSecret?: string): OAuth2Client => {
  return new OAuth2Client({
    clientId: clientId ?? env.googleClientId,
    clientSecret: clientSecret ?? env.googleClientSecret,
    redirectUri: env.googleRedirectUri,
  });
};

export const createOAuthState = async (
  type: 'incoming' | 'outgoing',
  connectorId: string,
  userId?: string,
) => {
  if (!userId) {
    throw new Error('userId is required for OAuth state');
  }

  const state = randomUUID();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  stateStore.set(state, {
    expiresAt,
    payload: { type, connectorId, userId },
  });
  await query(
    'INSERT INTO oauth_states (state, connector_id, connector_type, user_id, expires_at) VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0))',
    [state, connectorId, type, userId ?? null, expiresAt],
  );
  return state;
};

export const consumeOAuthState = async (state: string): Promise<OAuthState | null> => {
  const cached = stateStore.get(state);
  if (cached) {
    if (cached.expiresAt < Date.now()) {
      stateStore.delete(state);
      return null;
    }
    stateStore.delete(state);
    return cached.payload;
  }

  const result = await query<{ connector_id: string; connector_type: 'incoming' | 'outgoing'; user_id: string | null }>(
    'SELECT connector_id, connector_type, user_id FROM oauth_states WHERE state = $1 AND expires_at > NOW()',
    [state],
  );

  if (result.rows.length === 0) {
    return null;
  }

  await query('DELETE FROM oauth_states WHERE state = $1', [state]);
  const row = result.rows[0];
  return {
    type: row.connector_type,
    connectorId: row.connector_id,
    userId: row.user_id ?? undefined,
  };
};

const toTimestamp = (value?: string | null): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
};

const isExpired = (value?: string | null): boolean => {
  const expiry = toTimestamp(value);
  if (!expiry) {
    return false;
  }

  return expiry <= Date.now();
};

export const getGoogleAuthorizeUrl = async (
  type: 'incoming' | 'outgoing',
  connectorId: string,
  clientId?: string,
  clientSecret?: string,
  userId?: string,
) => {
  const state = await createOAuthState(type, connectorId, userId);
  const client = getGoogleClient(clientId, clientSecret);
  const authorizeUrl = client.generateAuthUrl({
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  return authorizeUrl;
};

export const exchangeCodeForTokens = async (code: string, clientId?: string, clientSecret?: string) => {
  const client = getGoogleClient(clientId, clientSecret);
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) {
    throw new Error('Google OAuth returned no access token');
  }
  return tokens;
};

export const ensureValidGoogleAccessToken = async (
  connectorType: 'incoming' | 'outgoing',
  connectorId: string,
  authConfig: Record<string, any>,
  options: { forceRefresh?: boolean } = {},
) => {
  if (authConfig.authType !== 'oauth2') {
    return authConfig;
  }

  const isTokenValid = !isExpired(authConfig.tokenExpiresAt) && !!authConfig.accessToken;
  if (!options.forceRefresh && isTokenValid) {
    return authConfig;
  }

  if (!authConfig.refreshToken) {
    if (!options.forceRefresh && authConfig.accessToken) {
      return authConfig;
    }
    throw new Error('OAuth refresh token is missing; user must reconnect account');
  }

  if (!authConfig.accessToken && !options.forceRefresh) {
    return authConfig;
  }

  const client = getGoogleClient(authConfig.oauthClientId, authConfig.oauthClientSecret);
  client.setCredentials({
    refresh_token: authConfig.refreshToken,
    access_token: authConfig.accessToken,
    expiry_date: toTimestamp(authConfig.tokenExpiresAt),
  });

  let refreshed;
  try {
    const refresh = await client.refreshAccessToken();
    refreshed = refresh.credentials;
  } catch (error) {
    if (INVALID_GRANT_REGEX.test(String(error))) {
      const revokedAuth = {
        ...authConfig,
        accessToken: null,
        tokenExpiresAt: null,
      };
      if (connectorType === 'incoming') {
        await updateIncomingConnectorAuth(connectorId, revokedAuth);
      } else {
        await updateOutgoingConnectorAuth(connectorId, revokedAuth);
      }
      throw new Error('OAuth refresh token is invalid; user must reconnect account');
    }
    throw error;
  }

  const nextAuth = {
    ...authConfig,
    authType: 'oauth2',
    accessToken: refreshed.access_token ?? authConfig.accessToken,
    refreshToken: refreshed.refresh_token ?? authConfig.refreshToken,
    tokenExpiresAt: refreshed.expiry_date ? new Date(refreshed.expiry_date).toISOString() : authConfig.tokenExpiresAt,
  };

  if (nextAuth.accessToken && (nextAuth.accessToken !== authConfig.accessToken || nextAuth.tokenExpiresAt !== authConfig.tokenExpiresAt)) {
    if (connectorType === 'incoming') {
      await updateIncomingConnectorAuth(connectorId, nextAuth);
    } else {
      await updateOutgoingConnectorAuth(connectorId, nextAuth);
    }
  }

  return nextAuth;
};
