import { ensureValidGoogleAccessToken, isGoogleTokenExpiringSoon } from './googleOAuth.js';

type ConnectorType = 'incoming' | 'outgoing';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

const isRecoverableNetworkError = (error: unknown) => {
  const asError = error as { code?: string; errno?: string };
  const message = String(error).toLowerCase();
  return (
    asError.code === 'ECONNRESET'
    || asError.code === 'ETIMEDOUT'
    || asError.code === 'EAI_AGAIN'
    || asError.errno === 'ECONNRESET'
    || asError.errno === 'ETIMEDOUT'
    || message.includes('timed out')
    || message.includes('timeout')
    || message.includes('connection')
    || message.includes('network')
  );
};

const isRetryableStatus = (status: number) => status === 429 || status === 408 || (status >= 500 && status <= 599);

const isTokenInvalidStatus = (status: number) => status === 401 || status === 403;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const nextBackoffMs = (attempt: number) => Math.min(500 * 2 ** attempt, 8000);

const getValidAuth = async (
  connectorType: ConnectorType,
  connector: { id: string; auth_config?: Record<string, any> },
  forceRefresh = false,
) => {
  const next = await ensureValidGoogleAccessToken(
    connectorType,
    connector.id,
    connector.auth_config ?? {},
    { forceRefresh },
  );
  connector.auth_config = next;
  return next;
};

export const gmailApiRequest = async <T = any>(
  connectorType: ConnectorType,
  connector: { id: string; auth_config?: Record<string, any> },
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const maxAttempts = 4;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      let auth = connector.auth_config ?? {};
      if (attempt > 0 || !auth.accessToken || isGoogleTokenExpiringSoon(auth)) {
        auth = await getValidAuth(connectorType, connector, attempt > 0);
      }

      const response = await fetch(`${GMAIL_API_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const error = new Error(`Gmail API ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
        if (isTokenInvalidStatus(response.status) && attempt < maxAttempts - 1) {
          await getValidAuth(connectorType, connector, true);
          await sleep(nextBackoffMs(attempt));
          continue;
        }
        if (isRetryableStatus(response.status) && attempt < maxAttempts - 1) {
          await sleep(nextBackoffMs(attempt));
          continue;
        }
        throw error;
      }

      if (response.status === 204) {
        return undefined as T;
      }
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts - 1 || !isRecoverableNetworkError(error)) {
        throw error;
      }
      await sleep(nextBackoffMs(attempt));
    }
  }

  throw lastError;
};

export const listAllGmailPages = async <T = any>(
  connectorType: ConnectorType,
  connector: { id: string; auth_config?: Record<string, any> },
  pathBuilder: (pageToken?: string) => string,
  pageExtractor: (payload: any) => T[],
) => {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const path = pathBuilder(pageToken);
    const payload = await gmailApiRequest<any>(connectorType, connector, path);
    items.push(...pageExtractor(payload));
    pageToken = payload?.nextPageToken || undefined;
  } while (pageToken);
  return items;
};
