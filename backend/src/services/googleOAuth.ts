import { randomUUID } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { updateIncomingConnectorAuth, updateOutgoingConnectorAuth } from './connectorService.js';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
];
const INVALID_GRANT_REGEX = /invalid[_\s-]grant|unauthorized|disabled|permission.?denied|rejected/i;
const MAX_OAUTH_STATE_CHARS = 200;

export interface OAuthState {
  type: 'incoming' | 'outgoing';
  connectorId?: string;
  connectorPayload?: Record<string, any>;
  userId?: string;
}

const getGoogleClient = (clientId?: string, clientSecret?: string): OAuth2Client => {
  return new OAuth2Client({
    clientId: clientId ?? env.googleClientId,
    clientSecret: clientSecret ?? env.googleClientSecret,
    redirectUri: env.googleRedirectUri,
  });
};

export const createOAuthState = async (
  type: 'incoming' | 'outgoing',
  connectorId?: string,
  userId?: string,
  connectorPayload?: Record<string, any>,
) => {
  if (!userId) {
    throw new Error('userId is required for OAuth state');
  }

  const state = randomUUID();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  await query(
    `INSERT INTO oauth_states (state, connector_id, connector_type, user_id, connector_payload, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, to_timestamp($6 / 1000.0))`,
    [state, connectorId ?? null, type, userId ?? null, JSON.stringify(connectorPayload ?? null), expiresAt],
  );
  return state;
};

export const consumeOAuthState = async (state: string): Promise<OAuthState | null> => {
  const normalizedState = String(state ?? '').trim();
  if (!normalizedState || normalizedState.length > MAX_OAUTH_STATE_CHARS) {
    return null;
  }

  try {
    const consumed = await query<{
      connector_id: string | null;
      connector_type: 'incoming' | 'outgoing';
      user_id: string | null;
      connector_payload: Record<string, any> | null;
    }>(
      `DELETE FROM oauth_states
        WHERE state = $1
          AND expires_at > NOW()
      RETURNING connector_id, connector_type, user_id, connector_payload`,
      [normalizedState],
    );
    if (consumed.rows.length > 0) {
      const row = consumed.rows[0];
      return {
        type: row.connector_type,
        connectorId: row.connector_id ?? undefined,
        connectorPayload: row.connector_payload ?? undefined,
        userId: row.user_id ?? undefined,
      };
    }
  } catch {
    // Fail closed if state cannot be atomically consumed from persistent storage.
    // This avoids replay if DB deletes temporarily fail.
    return null;
  }
  return null;
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

export const isGoogleTokenExpiringSoon = (authConfig: Record<string, any>, windowMs = 5 * 60 * 1000): boolean => {
  if (authConfig.authType !== 'oauth2' || !authConfig.tokenExpiresAt) {
    return false;
  }

  const expiry = toTimestamp(authConfig.tokenExpiresAt);
  if (!expiry) {
    return false;
  }

  return expiry - Date.now() <= windowMs;
};

const isExpired = (value?: string | null): boolean => {
  if (!value) {
    return false;
  }
  const expiry = toTimestamp(value);
  if (!expiry) {
    return true;
  }

  return expiry <= Date.now();
};

export const getGoogleAuthorizeUrl = async (
  type: 'incoming' | 'outgoing',
  connectorId?: string,
  clientId?: string,
  clientSecret?: string,
  userId?: string,
  connectorPayload?: Record<string, any>,
) => {
  const state = await createOAuthState(type, connectorId, userId, connectorPayload);
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
    if (!options.forceRefresh && authConfig.accessToken && !isExpired(authConfig.tokenExpiresAt)) {
      return authConfig;
    }
    throw new Error('OAuth refresh token is missing; user must reconnect account');
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
