import { FastifyInstance } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import {
  createIncomingConnector,
  createOutgoingConnector,
  createIdentity,
  updateIdentity,
  deleteIdentity,
  deleteIncomingConnector,
  deleteOutgoingConnector,
  getIncomingConnector,
  getOutgoingConnector,
  getIdentity,
  listIdentities,
  listIncomingConnectors,
  listOutgoingConnectors,
  updateIncomingConnector,
  updateOutgoingConnector,
  updateIncomingConnectorAuth,
  updateOutgoingConnectorAuth,
} from '../services/connectorService.js';
import {
  getGoogleAuthorizeUrl,
  consumeOAuthState,
  exchangeCodeForTokens,
  ensureValidGoogleAccessToken,
} from '../services/googleOAuth.js';
import { enqueueSend, enqueueSyncWithOptions, enqueueAttachmentScan } from '../services/queue.js';
import { query } from '../db/pool.js';
import {
  listConnectorMailboxes,
  syncIncomingConnector,
  startIncomingConnectorIdleWatch,
  ensureIncomingConnectorState,
  setSyncState,
  getMailboxState,
  requestSyncCancellation,
  moveMessageInMailbox,
  deleteMessageFromMailbox,
  setMessageReadState,
  setMessageStarredState,
  stopIncomingConnectorIdleWatch,
  applyThreadMessageActions,
  normalizeGmailMailboxPath,
  getGmailMailboxPathAliases,
} from '../services/imap.js';
import { listSyncEvents, waitForSyncEventSignal } from '../services/imapEvents.js';
import { createPushSubscription, removePushSubscription } from '../services/push.js';
import { listThreadMessages } from '../services/threading.js';
import { buildMessageSearchQuery, parseMessageSearchQuery } from '../services/search.js';
import {
  createUserLabel,
  listLabels,
  getLabel,
  updateLabelName,
  archiveLabel,
  listMessageLabels,
  addLabelsToMessage,
  removeLabelsFromMessage,
  addLabelsToMessageByKey,
  removeLabelsFromMessageByKey,
} from '../services/labels.js';
import {
  listSavedSearches,
  createSavedSearch,
  getSavedSearch,
  updateSavedSearch,
  deleteSavedSearch,
} from '../services/savedSearch.js';
import { gmailApiRequest } from '../services/gmailApi.js';
import { blobStore } from '../storage/seaweedS3BlobStore.js';
import { env } from '../config/env.js';
import { createUser } from '../services/user.js';
import { getAttachmentScanDecision } from '../services/scanPolicy.js';
import {
  getOrCreateSendIdempotency,
  makeSendRequestHash,
  normalizeSendIdempotencyKey,
} from '../services/sendIdempotency.js';
import { markActiveMailbox, resolveSyncQueuePriority } from '../services/syncPriority.js';
import { verifyOutgoingConnectorCredentials } from '../services/smtp.js';
import { assertSafeOutboundHost, assertSafePushEndpoint } from '../services/networkGuard.js';

const required = (value: unknown, key: string): string => {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${key} is required`);
  }
  return String(value);
};

const isGmailAuthConnector = (connector: any): boolean => {
  if (!connector) {
    return false;
  }

  if (connector.provider === 'gmail') {
    return true;
  }

  if (connector.provider !== 'imap') {
    return false;
  }

  return Boolean(
    connector.sync_settings?.gmailImap ||
    connector.syncSettings?.gmailImap ||
    connector.authConfig?.gmailImap,
  );
};

const isGmailLikeConnector = (connector: any): boolean => {
  if (!connector) {
    return false;
  }

  if (connector.provider === 'gmail') {
    return true;
  }

  return connector.provider === 'imap'
    && Boolean(
      connector.sync_settings?.gmailImap ||
      connector.syncSettings?.gmailImap,
    );
};

const getMessageAndConnectorForUser = async (userId: string, messageId: string) => {
  const result = await query<any>(
    `SELECT m.id, m.incoming_connector_id, m.folder_path, m.uid
       FROM messages m
       INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
      WHERE m.id = $1
        AND ic.user_id = $2`,
    [messageId, userId],
  );
  return result.rows[0] ?? null;
};

const parseBooleanParam = (value: unknown): boolean | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  return null;
};

const mailboxReadPreferenceRankSql = `CASE UPPER(m.folder_path)
  WHEN 'INBOX' THEN 0
  WHEN 'SENT' THEN 1
  WHEN 'DRAFT' THEN 2
  WHEN 'STARRED' THEN 3
  WHEN 'IMPORTANT' THEN 4
  WHEN 'SPAM' THEN 5
  WHEN 'TRASH' THEN 6
  WHEN 'ALL' THEN 90
  ELSE 20
END`;

const normalizeConnectorFolderFilter = async (
  userId: string,
  folder: string | undefined,
  connectorId: string | undefined,
) => {
  if (!folder || !connectorId) {
    return folder;
  }
  const connector = await getIncomingConnector(userId, connectorId);
  if (!connector) {
    return folder;
  }
  if (!isGmailLikeConnector(connector)) {
    return folder;
  }
  return normalizeGmailMailboxPath(folder);
};

const buildGmailFolderPredicates = async (
  userId: string,
  folder: string | undefined,
  connectorId: string | undefined,
) => {
  if (!folder || !connectorId) {
    return {
      candidates: null as string[] | null,
      dedupeLogicalMessages: false,
    };
  }

  const connector = await getIncomingConnector(userId, connectorId);
  if (!connector) {
    return {
      candidates: null,
      dedupeLogicalMessages: false,
    };
  }

  const normalizedFolder = isGmailLikeConnector(connector)
    ? normalizeGmailMailboxPath(folder)
    : String(folder).trim();

  if (!isGmailLikeConnector(connector)) {
    return {
      candidates: [normalizedFolder.toUpperCase()],
      dedupeLogicalMessages: false,
    };
  }

  return {
    candidates: getGmailMailboxPathAliases(normalizedFolder),
    dedupeLogicalMessages: true,
  };
};

const parseAddressList = (value: unknown): string[] | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const candidates = Array.isArray(value) ? value : [value];
  const parsed = candidates
    .flatMap((entry) => String(entry).split(/[,\n;]/))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) =>
      entry.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [],
    );
  if (parsed.length === 0) {
    return undefined;
  }
  const dedupe = new Set<string>();
  const normalized: string[] = [];
  for (const item of parsed) {
    const email = item.trim().toLowerCase();
    if (!email || dedupe.has(email)) {
      continue;
    }
    dedupe.add(email);
    normalized.push(email);
  }
  return normalized.length > 0 ? normalized : undefined;
};

const parseOptionalHeaderValue = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
};

const MAIL_TLS_MODE_VALUES = new Set(['ssl', 'starttls', 'none']);
const BASE64_BODY_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const HEADER_VALUE_PATTERN = /^[^\r\n]*$/;

const MAX_SEND_RECIPIENTS = 100;
const MAX_SEND_ATTACHMENTS = 20;
const MAX_SEND_SUBJECT_CHARS = 998;
const MAX_SEND_BODY_TEXT_CHARS = 200_000;
const MAX_SEND_BODY_HTML_CHARS = 500_000;
const MAX_SEND_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_SEND_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_SEND_HEADER_CHARS = 2_000;

const insecureMailTransportAllowed =
  env.allowInsecureMailTransport || env.nodeEnv === 'development' || env.nodeEnv === 'test';

const parseOptionalPort = (value: unknown, fieldName: string): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${fieldName} must be an integer between 1 and 65535`);
  }
  return parsed;
};

const normalizeTlsMode = (value: unknown, fieldName: string): 'ssl' | 'starttls' | 'none' | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['ssl', 'tls', 'implicit', 'implicit_tls', 'imaps', 'smtps'].includes(normalized)) {
    return 'ssl';
  }
  if (['starttls', 'start_tls', 'explicit', 'explicit_tls'].includes(normalized)) {
    return 'starttls';
  }
  if (['none', 'plain', 'insecure', 'cleartext'].includes(normalized)) {
    return 'none';
  }
  if (MAIL_TLS_MODE_VALUES.has(normalized)) {
    return normalized as 'ssl' | 'starttls' | 'none';
  }
  throw new Error(`${fieldName} must be one of: ssl, starttls, none`);
};

const estimateBase64PayloadBytes = (value: string): number | null => {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized) {
    return 0;
  }
  if (normalized.length % 4 !== 0) {
    return null;
  }
  if (!BASE64_BODY_PATTERN.test(normalized)) {
    return null;
  }
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return ((normalized.length / 4) * 3) - padding;
};

const isPlainObject = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toPublicAuthConfig = (authConfig: unknown) => {
  const source = (authConfig && typeof authConfig === 'object')
    ? authConfig as Record<string, any>
    : {};
  const authType = String(source.authType ?? 'password').toLowerCase() === 'oauth2'
    ? 'oauth2'
    : 'password';

  if (authType === 'oauth2') {
    return {
      authType: 'oauth2',
      oauthClientId: source.oauthClientId ? String(source.oauthClientId) : undefined,
      tokenExpiresAt: source.tokenExpiresAt ? String(source.tokenExpiresAt) : undefined,
      hasAccessToken: Boolean(source.accessToken),
      hasRefreshToken: Boolean(source.refreshToken),
      hasClientSecret: Boolean(source.oauthClientSecret),
    };
  }

  return {
    authType: 'password',
    username: source.username ? String(source.username) : undefined,
    hasPassword: Boolean(source.password),
  };
};

const sanitizeConnectorForResponse = (connector: any) => {
  if (!connector || typeof connector !== 'object') {
    return connector;
  }
  const authConfig = toPublicAuthConfig(connector.authConfig ?? connector.auth_config);
  const sanitized = {
    ...connector,
    authConfig,
  } as Record<string, any>;
  delete sanitized.auth_config;
  return sanitized;
};

const isArchiveMoveTarget = (value: unknown) => {
  if (value === undefined || value === null) {
    return false;
  }
  const normalized = normalizeGmailMailboxPath(String(value));
  return normalized === 'ALL' || normalized === 'ARCHIVE';
};

const sanitizeDispositionFilename = (value: unknown, fallback: string): string => {
  const normalized = String(value ?? '')
    .replace(/[\r\n";\\]/g, '_')
    .replace(/[^\x20-\x7E]/g, '_')
    .trim();
  const filename = normalized.length > 0 ? normalized : fallback;
  return filename.slice(0, 180);
};

const GOOGLE_IDENTITY_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const pubSubTokenVerifier = new OAuth2Client();

const getGmailPushAudience = () =>
  env.gmailPush.webhookAudience || `${env.appBaseUrl}${env.gmailPush.webhookPath}`;

const extractBearerToken = (authorizationHeader: string | string[] | undefined): string | null => {
  const raw = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  if (!raw) {
    return null;
  }
  const normalized = String(raw).trim();
  if (!normalized.toLowerCase().startsWith('bearer ')) {
    return null;
  }
  const token = normalized.slice(7).trim();
  return token.length > 0 ? token : null;
};

const verifyPubSubPushToken = async (
  authorizationHeader: string | string[] | undefined,
  additionalAudiences: string[] = [],
) => {
  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    throw new Error('missing pubsub bearer token');
  }

  const audience = Array.from(new Set([getGmailPushAudience(), ...additionalAudiences].filter(Boolean)));
  const ticket = await pubSubTokenVerifier.verifyIdToken({
    idToken: token,
    audience,
  });
  const payload = ticket.getPayload();
  if (!payload) {
    throw new Error('invalid pubsub oidc payload');
  }
  if (!payload.iss || !GOOGLE_IDENTITY_ISSUERS.has(payload.iss)) {
    throw new Error('invalid pubsub oidc issuer');
  }
  if (payload.email_verified === false) {
    throw new Error('pubsub oidc email is not verified');
  }
  if (payload.aud && !audience.includes(String(payload.aud))) {
    throw new Error('invalid pubsub oidc audience');
  }
  if (
    env.gmailPush.pushServiceAccountEmail
    && payload.email !== env.gmailPush.pushServiceAccountEmail
  ) {
    throw new Error('unexpected pubsub service account');
  }
  return payload;
};

const decodePubSubPushBody = (body: any): { emailAddress: string; historyId?: string | null } | null => {
  const encoded = body?.message?.data;
  if (!encoded || typeof encoded !== 'string') {
    return null;
  }
  if (encoded.length > 32_768) {
    return null;
  }
  const normalized = encoded.replace(/\s+/g, '');
  if (normalized.length % 4 !== 0 || !BASE64_BODY_PATTERN.test(normalized)) {
    return null;
  }

  const decoded = Buffer.from(normalized, 'base64').toString('utf8');
  if (!decoded || decoded.length > 32_768) {
    return null;
  }

  const payload = JSON.parse(decoded) as { emailAddress?: string; historyId?: string | number };
  const emailAddress = String(payload.emailAddress ?? '').trim();
  if (!emailAddress) {
    return null;
  }

  return {
    emailAddress,
    historyId: payload.historyId !== undefined && payload.historyId !== null
      ? String(payload.historyId)
      : null,
  };
};

const buildGmailWatchLabelIds = (watchMailboxes: string[]) => {
  const ids = Array.from(new Set(
    watchMailboxes
      .map((mailbox) => normalizeGmailMailboxPath(mailbox))
      .filter((labelId) => labelId !== 'ALL'),
  ));
  return ids.length > 0 ? ids : ['INBOX'];
};

export const registerRoutes = async (app: FastifyInstance) => {
  const getUserId = (request: any) => {
    if (!request.user?.id) {
      const error = new Error('missing user context') as Error & { statusCode?: number };
      error.statusCode = 401;
      throw error;
    }
    return request.user.id;
  };

  app.get('/api/health', async () => ({ status: 'ok', seaweed: { bucket: env.seaweed.bucket } }));

  app.post('/api/admin/users', async (req, reply) => {
    const body = req.body as any;
    if (!body?.email || !body?.name) {
      return reply.code(400).send({ error: 'email and name required' });
    }

    const created = await createUser({
      email: String(body.email),
      name: String(body.name),
      token: body.token,
    });

    return created;
  });

  app.get('/api/connectors/incoming', async (req) => {
    const userId = getUserId(req);
    const connectors = await listIncomingConnectors(userId);
    return connectors.map((connector) => sanitizeConnectorForResponse(connector));
  });
  app.get('/api/connectors/outgoing', async (req) => {
    const userId = getUserId(req);
    const connectors = await listOutgoingConnectors(userId);
    return connectors.map((connector) => sanitizeConnectorForResponse(connector));
  });
  app.get('/api/connectors/incoming/:connectorId', async (req, reply) => {
    const connectorId = String((req.params as any).connectorId);
    const userId = getUserId(req);
    const result = await getIncomingConnector(userId, connectorId);
    if (!result) {
      return reply.code(404).send({ error: 'connector not found' });
    }
    return sanitizeConnectorForResponse(result);
  });
  app.get('/api/connectors/outgoing/:connectorId', async (req, reply) => {
    const connectorId = String((req.params as any).connectorId);
    const userId = getUserId(req);
    const result = await getOutgoingConnector(userId, connectorId);
    if (!result) {
      return reply.code(404).send({ error: 'connector not found' });
    }
    return sanitizeConnectorForResponse(result);
  });
  app.get('/api/connectors/:connectorId/mailboxes', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    try {
      return await listConnectorMailboxes(userId, connectorId);
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return reply.code(404).send({ error: 'connector not found' });
      }
      return reply.code(502).send({ error: 'Unable to fetch mailboxes for this connector' });
    }
  });

  app.post('/api/connectors/incoming', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.name || !body?.provider || !body?.emailAddress) {
      return reply.code(400).send({ error: 'name, provider, emailAddress required' });
    }

    const normalizedAuthType = String(body?.authType ?? 'password').toLowerCase();
    const provider = String(body.provider ?? '').trim().toLowerCase();
    if (body.syncSettings !== undefined && !isPlainObject(body.syncSettings)) {
      return reply.code(400).send({ error: 'syncSettings must be an object' });
    }
    if (body.authConfig !== undefined && !isPlainObject(body.authConfig)) {
      return reply.code(400).send({ error: 'authConfig must be an object' });
    }
    let parsedPort: number | undefined;
    let normalizedImapTlsMode: 'ssl' | 'starttls' | 'none' | undefined;
    try {
      parsedPort = parseOptionalPort(body.port, 'incoming connector port');
      normalizedImapTlsMode = normalizeTlsMode(
        body?.syncSettings?.imapTlsMode ?? body?.syncSettings?.tlsMode,
        'syncSettings.imapTlsMode',
      );
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid incoming connector config' });
    }
    if ((body.tls === false || normalizedImapTlsMode === 'none') && !insecureMailTransportAllowed) {
      return reply.code(400).send({ error: 'unencrypted IMAP is disabled on this server' });
    }
    if (body.host !== undefined && body.host !== null && String(body.host).trim()) {
      await assertSafeOutboundHost(String(body.host), { context: 'incoming connector host' });
    }
    const requestedSyncSettings = {
      ...(body?.syncSettings ?? {}),
      ...(normalizedImapTlsMode ? { imapTlsMode: normalizedImapTlsMode } : {}),
    };
    const defaultWatchMailbox = isGmailLikeConnector({
      provider: String(body.provider),
      sync_settings: requestedSyncSettings,
      syncSettings: requestedSyncSettings,
    })
      ? normalizeGmailMailboxPath(env.sync.defaultMailbox)
      : env.sync.defaultMailbox;
    const watchMailboxes = Array.isArray(requestedSyncSettings?.watchMailboxes)
      ? requestedSyncSettings.watchMailboxes
        .map((value: unknown) => String(value).trim())
        .filter(Boolean)
      : [defaultWatchMailbox];
    const syncSettings = {
      ...requestedSyncSettings,
      watchMailboxes: Array.from(new Set(
        watchMailboxes.map((mailbox: string) => isGmailLikeConnector({
          provider: provider,
          sync_settings: requestedSyncSettings,
          syncSettings: requestedSyncSettings,
        })
          ? normalizeGmailMailboxPath(mailbox)
          : mailbox),
      )),
    };
    const supportsOauthIncoming = isGmailAuthConnector({
      provider,
      sync_settings: syncSettings,
      syncSettings: syncSettings,
    });
    if (normalizedAuthType === 'oauth2' && !supportsOauthIncoming) {
      return reply.code(400).send({
        error: 'oauth2 incoming auth is only supported for provider=gmail or provider=imap with syncSettings.gmailImap=true',
      });
    }

    if (normalizedAuthType === 'oauth2') {
      const expectedGmailMode = String(Boolean(syncSettings?.gmailImap));
      const existing = await query<{ id: string }>(
        `SELECT id
           FROM incoming_connectors
          WHERE user_id = $1
            AND provider = $2
            AND email_address = $3
            AND COALESCE(auth_config->>'authType', 'password') = $4
            AND COALESCE(sync_settings->>'gmailImap', 'false') = $5`,
        [userId, provider, String(body.emailAddress), normalizedAuthType, expectedGmailMode],
      );

      if (existing.rows.length > 0) {
        return { id: existing.rows[0].id };
      }
    }

    const result = await createIncomingConnector(userId, {
      name: String(body.name),
      provider,
      emailAddress: String(body.emailAddress),
      host: body.host,
      port: parsedPort,
      tls: body.tls ?? true,
      authType: normalizedAuthType,
      authConfig: body.authConfig ?? {},
      syncSettings,
    });

    if (normalizedAuthType !== 'oauth2') {
      const firstMailbox = syncSettings.watchMailboxes?.[0] ?? defaultWatchMailbox;
      try {
        await startIncomingConnectorIdleWatch(userId, result.id, firstMailbox);
      } catch {
        // best effort: connector creation should not fail if watcher cannot start immediately
      }
    }

    return result;
  });

  app.post('/api/connectors/outgoing', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.name || !body?.provider || !body?.fromAddress) {
      return reply.code(400).send({ error: 'name, provider, fromAddress required' });
    }

    const normalizedProvider = String(body.provider ?? '').trim().toLowerCase();
    const authType = String(body.authType ?? (normalizedProvider === 'gmail' ? 'oauth2' : 'password')).toLowerCase();
    if (body.authConfig !== undefined && !isPlainObject(body.authConfig)) {
      return reply.code(400).send({ error: 'authConfig must be an object' });
    }
    let parsedPort: number | undefined;
    let normalizedTlsMode: 'ssl' | 'starttls' | 'none';
    try {
      parsedPort = parseOptionalPort(body.port, 'outgoing connector port');
      normalizedTlsMode = normalizeTlsMode(body.tlsMode, 'tlsMode') ?? 'starttls';
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid outgoing connector config' });
    }
    if (authType === 'oauth2' && normalizedProvider !== 'gmail') {
      return reply.code(400).send({ error: 'oauth2 is only supported for provider=gmail for outgoing connectors' });
    }
    if (normalizedTlsMode === 'none' && !insecureMailTransportAllowed) {
      return reply.code(400).send({ error: 'unencrypted SMTP is disabled on this server' });
    }
    if (body.host !== undefined && body.host !== null && String(body.host).trim()) {
      await assertSafeOutboundHost(String(body.host), { context: 'outgoing connector host' });
    }
    if (authType === 'oauth2') {
      const existing = await query<{ id: string }>(
        `SELECT id
           FROM outgoing_connectors
          WHERE user_id = $1
            AND provider = $2
            AND from_address = $3
            AND COALESCE(auth_config->>'authType', 'password') = $4`,
        [userId, normalizedProvider, String(body.fromAddress), authType],
      );

      if (existing.rows.length > 0) {
        return { id: existing.rows[0].id };
      }
    }

    if (authType !== 'oauth2') {
      try {
        await verifyOutgoingConnectorCredentials({
          provider: normalizedProvider,
          fromAddress: String(body.fromAddress),
          host: body.host ?? null,
          port: parsedPort ?? null,
          tlsMode: normalizedTlsMode,
          authType,
          authConfig: body.authConfig ?? {},
        });
      } catch (error) {
        req.log.warn({ error }, 'smtp auth verification failed while creating outgoing connector');
        return reply.code(400).send({ error: 'smtp auth failed' });
      }
    }

    const result = await createOutgoingConnector(userId, {
      name: String(body.name),
      provider: normalizedProvider,
      fromAddress: String(body.fromAddress),
      host: body.host,
      port: parsedPort,
      tlsMode: normalizedTlsMode,
      authType,
      authConfig: body.authConfig ?? {},
      fromEnvelopeDefaults: body.fromEnvelopeDefaults ?? {},
      sentCopyBehavior: body.sentCopyBehavior ?? {},
    });
    return result;
  });

  app.patch('/api/connectors/incoming/:connectorId', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    const body = req.body as any;

    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'request body required' });
    }
    if (body.syncSettings !== undefined && body.syncSettings !== null && !isPlainObject(body.syncSettings)) {
      return reply.code(400).send({ error: 'syncSettings must be an object' });
    }
    if (body.authConfig !== undefined && body.authConfig !== null && !isPlainObject(body.authConfig)) {
      return reply.code(400).send({ error: 'authConfig must be an object' });
    }

    const existing = await getIncomingConnector(userId, connectorId);
    if (!existing) {
      return reply.code(404).send({ error: 'connector not found' });
    }

    let parsedPort: number | null | undefined;
    let normalizedImapTlsMode: 'ssl' | 'starttls' | 'none' | undefined;
    try {
      parsedPort = body.port === undefined
        ? undefined
        : (body.port === null || body.port === '' ? null : parseOptionalPort(body.port, 'incoming connector port') ?? null);
      normalizedImapTlsMode = normalizeTlsMode(
        body?.syncSettings?.imapTlsMode ?? body?.syncSettings?.tlsMode,
        'syncSettings.imapTlsMode',
      );
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid incoming connector config' });
    }
    if ((body.tls === false || normalizedImapTlsMode === 'none') && !insecureMailTransportAllowed) {
      return reply.code(400).send({ error: 'unencrypted IMAP is disabled on this server' });
    }

    const mergedHost = body.host !== undefined ? body.host : existing.host;
    if (mergedHost !== undefined && mergedHost !== null && String(mergedHost).trim()) {
      await assertSafeOutboundHost(String(mergedHost), { context: 'incoming connector host' });
    }
    const mergedSyncSettings = {
      ...(body.syncSettings ?? existing.sync_settings ?? existing.syncSettings ?? {}),
      ...(normalizedImapTlsMode ? { imapTlsMode: normalizedImapTlsMode } : {}),
    };
    const mergedAuthConfig = body.authConfig ?? existing.auth_config ?? existing.authConfig ?? {};
    const mergedAuthType = String(mergedAuthConfig?.authType ?? 'password').toLowerCase();
    const supportsOauthIncoming = isGmailAuthConnector({
      provider: String(existing.provider ?? '').trim().toLowerCase(),
      sync_settings: mergedSyncSettings,
      syncSettings: mergedSyncSettings,
    });
    if (mergedAuthType === 'oauth2' && !supportsOauthIncoming) {
      return reply.code(400).send({
        error: 'oauth2 incoming auth is only supported for provider=gmail or provider=imap with syncSettings.gmailImap=true',
      });
    }

    await updateIncomingConnector(userId, connectorId, {
      name: body.name,
      emailAddress: body.emailAddress,
      host: body.host,
      port: parsedPort,
      tls: body.tls,
      authConfig: body.authConfig,
      syncSettings: body.syncSettings === undefined
        ? undefined
        : {
            ...(body.syncSettings ?? {}),
            ...(normalizedImapTlsMode ? { imapTlsMode: normalizedImapTlsMode } : {}),
          },
      status: body.status,
    });
    const updated = await getIncomingConnector(userId, connectorId);
    if (!updated) {
      return reply.code(404).send({ error: 'connector not found' });
    }
    return sanitizeConnectorForResponse(updated);
  });

  app.patch('/api/connectors/outgoing/:connectorId', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    const body = req.body as any;

    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'request body required' });
    }
    if (body.authConfig !== undefined && body.authConfig !== null && !isPlainObject(body.authConfig)) {
      return reply.code(400).send({ error: 'authConfig must be an object' });
    }

    const existing = await getOutgoingConnector(userId, connectorId);
    if (!existing) {
      return reply.code(404).send({ error: 'connector not found' });
    }

    let parsedPort: number | null | undefined;
    let normalizedTlsMode: 'ssl' | 'starttls' | 'none' | undefined;
    try {
      parsedPort = body.port === undefined
        ? undefined
        : (body.port === null || body.port === '' ? null : parseOptionalPort(body.port, 'outgoing connector port') ?? null);
      normalizedTlsMode = normalizeTlsMode(body.tlsMode, 'tlsMode');
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid outgoing connector config' });
    }
    if (normalizedTlsMode === 'none' && !insecureMailTransportAllowed) {
      return reply.code(400).send({ error: 'unencrypted SMTP is disabled on this server' });
    }

    const hasSmtpConnectivityChange =
      body.fromAddress !== undefined
      || body.host !== undefined
      || body.port !== undefined
      || body.tlsMode !== undefined
      || body.authConfig !== undefined;

    const mergedAuthConfig = body.authConfig !== undefined
      ? body.authConfig
      : (existing.authConfig ?? existing.auth_config ?? {});
    const mergedAuthType = mergedAuthConfig?.authType ?? 'password';
    if (String(mergedAuthType).toLowerCase() === 'oauth2' && String(existing.provider ?? '').toLowerCase() !== 'gmail') {
      return reply.code(400).send({ error: 'oauth2 is only supported for provider=gmail for outgoing connectors' });
    }
    const mergedHost = body.host !== undefined ? body.host : (existing.host ?? null);
    if (mergedHost !== undefined && mergedHost !== null && String(mergedHost).trim()) {
      await assertSafeOutboundHost(String(mergedHost), { context: 'outgoing connector host' });
    }
    if (hasSmtpConnectivityChange && mergedAuthType !== 'oauth2') {
      try {
        await verifyOutgoingConnectorCredentials({
          provider: String(existing.provider ?? ''),
          fromAddress: String(body.fromAddress ?? existing.fromAddress ?? existing.from_address ?? ''),
          host: body.host !== undefined ? body.host : (existing.host ?? null),
          port: parsedPort !== undefined ? parsedPort : (existing.port ?? null),
          tlsMode: normalizedTlsMode ?? existing.tlsMode ?? existing.tls_mode ?? 'starttls',
          authType: mergedAuthType,
          authConfig: mergedAuthConfig ?? {},
        });
      } catch (error) {
        req.log.warn({ error }, 'smtp auth verification failed while updating outgoing connector');
        return reply.code(400).send({ error: 'smtp auth failed' });
      }
    }

    await updateOutgoingConnector(userId, connectorId, {
      name: body.name,
      fromAddress: body.fromAddress,
      host: body.host,
      port: parsedPort,
      tlsMode: normalizedTlsMode,
      authConfig: body.authConfig,
      fromEnvelopeDefaults: body.fromEnvelopeDefaults,
      sentCopyBehavior: body.sentCopyBehavior,
    });
    const updated = await getOutgoingConnector(userId, connectorId);
    if (!updated) {
      return reply.code(404).send({ error: 'connector not found' });
    }
    return sanitizeConnectorForResponse(updated);
  });

  app.post('/api/connectors/outgoing/:connectorId/test', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);

    const connector = await getOutgoingConnector(userId, connectorId);
    if (!connector) {
      return reply.code(404).send({ error: 'connector not found' });
    }

    const authConfig = connector.authConfig ?? connector.auth_config ?? {};
    const authType = authConfig.authType ?? 'password';
    const provider = String(connector.provider ?? '').toLowerCase();
    if (String(authType).toLowerCase() === 'oauth2' && provider !== 'gmail') {
      return reply.code(400).send({ error: 'oauth2 is only supported for provider=gmail for outgoing connectors' });
    }

    try {
      const resolvedAuthConfig = authType === 'oauth2' && provider === 'gmail'
        ? await ensureValidGoogleAccessToken('outgoing', connectorId, authConfig, { forceRefresh: true })
        : authConfig;
      if (provider === 'gmail' && String(authType).toLowerCase() === 'oauth2') {
        await gmailApiRequest(
          'outgoing',
          { id: connectorId, auth_config: resolvedAuthConfig },
          '/profile',
        );
      } else {
        if (connector.host !== undefined && connector.host !== null && String(connector.host).trim()) {
          await assertSafeOutboundHost(String(connector.host), { context: 'outgoing connector host' });
        }
        await verifyOutgoingConnectorCredentials({
          provider,
          fromAddress: String(connector.fromAddress ?? connector.from_address ?? ''),
          host: connector.host ?? null,
          port: connector.port ?? null,
          tlsMode: connector.tlsMode ?? connector.tls_mode ?? 'starttls',
          authType,
          authConfig: resolvedAuthConfig,
        });
      }
    } catch (error) {
      req.log.warn({ error }, 'smtp test failed');
      return reply.code(400).send({ error: 'smtp test failed' });
    }

    return { status: 'ok', id: connectorId };
  });

  app.delete('/api/connectors/incoming/:connectorId', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    const connector = await getIncomingConnector(userId, connectorId);
    if (connector) {
      const configuredWatchMailboxes = Array.isArray(connector.sync_settings?.watchMailboxes)
        ? connector.sync_settings.watchMailboxes.map((value: unknown) => String(value || '').trim()).filter(Boolean)
        : [];
      const fallbackMailbox = isGmailLikeConnector(connector)
        ? normalizeGmailMailboxPath(env.sync.defaultMailbox)
        : env.sync.defaultMailbox;
      const watchMailboxes = configuredWatchMailboxes.length > 0
        ? configuredWatchMailboxes
        : [fallbackMailbox];
      for (const mailbox of watchMailboxes) {
        await stopIncomingConnectorIdleWatch(userId, connectorId, mailbox).catch(() => undefined);
      }
    }
    await deleteIncomingConnector(userId, connectorId);
    return { status: 'deleted', id: connectorId };
  });

  app.delete('/api/connectors/outgoing/:connectorId', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    await deleteOutgoingConnector(userId, connectorId);
    return { status: 'deleted', id: connectorId };
  });

  app.post('/api/identities', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.displayName || !body?.emailAddress || !body?.outgoingConnectorId) {
      return reply.code(400).send({ error: 'displayName, emailAddress, outgoingConnectorId required' });
    }

    const created = await createIdentity(
      userId,
      String(body.displayName),
      String(body.emailAddress),
      String(body.outgoingConnectorId),
      body.signature ?? null,
      body.sentToIncomingConnectorId ?? null,
      body.replyTo ?? null,
    );
    return created;
  });

  app.get('/api/identities', async (req) => {
    const userId = getUserId(req);
    return listIdentities(userId);
  });

  app.get('/api/identities/:id', async (req, reply) => {
    const userId = getUserId(req);
    const identityId = String((req.params as any).id);
    const identity = await getIdentity(userId, identityId);
    if (!identity) {
      return reply.code(404).send({ error: 'identity not found' });
    }
    return identity;
  });

  app.patch('/api/identities/:id', async (req, reply) => {
    const userId = getUserId(req);
    const identityId = String((req.params as any).id);
    const body = req.body as any;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'request body required' });
    }

    await updateIdentity(userId, identityId, {
      displayName: body.displayName,
      emailAddress: body.emailAddress,
      signature: body.signature,
      outgoingConnectorId: body.outgoingConnectorId ?? undefined,
      sentToIncomingConnectorId: body.sentToIncomingConnectorId ?? undefined,
      replyTo: body.replyTo,
    });
    const refreshed = await getIdentity(userId, identityId);
    if (!refreshed) {
      return reply.code(404).send({ error: 'identity not found' });
    }
    return refreshed;
  });

  app.delete('/api/identities/:id', async (req) => {
    const userId = getUserId(req);
    const identityId = String((req.params as any).id);
    await deleteIdentity(userId, identityId);
    return { status: 'deleted', id: identityId };
  });

  app.get('/api/labels', async (req) => {
    const userId = getUserId(req);
    return listLabels(userId);
  });

  app.post('/api/labels', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.name) {
      return reply.code(400).send({ error: 'name required' });
    }
    return createUserLabel({
      userId,
      name: String(body.name),
      key: body.key,
    });
  });

  app.get('/api/labels/:labelId', async (req, reply) => {
    const userId = getUserId(req);
    const labelId = String((req.params as any).labelId);
    const label = await getLabel(userId, labelId);
    if (!label) {
      return reply.code(404).send({ error: 'label not found' });
    }
    return label;
  });

  app.patch('/api/labels/:labelId', async (req, reply) => {
    const userId = getUserId(req);
    const labelId = String((req.params as any).labelId);
    const body = req.body as any;
    if (!body || typeof body !== 'object' || typeof body.name !== 'string') {
      return reply.code(400).send({ error: 'label name required' });
    }
    await updateLabelName(userId, labelId, String(body.name));
    const updated = await getLabel(userId, labelId);
    if (!updated) {
      return reply.code(404).send({ error: 'label not found' });
    }
    return updated;
  });

  app.delete('/api/labels/:labelId', async (req, reply) => {
    const userId = getUserId(req);
    const labelId = String((req.params as any).labelId);
    await archiveLabel(userId, labelId);
    return { status: 'deleted', id: labelId };
  });

  app.get('/api/messages/:messageId/labels', async (req, reply) => {
    const userId = getUserId(req);
    const messageId = String((req.params as any).messageId);
    const message = await getMessageAndConnectorForUser(userId, messageId);
    if (!message) {
      return reply.code(404).send({ error: 'message not found' });
    }
    return listMessageLabels(userId, messageId);
  });

  app.post('/api/messages/:messageId/labels', async (req, reply) => {
    const userId = getUserId(req);
    const messageId = String((req.params as any).messageId);
    const message = await getMessageAndConnectorForUser(userId, messageId);
    if (!message) {
      return reply.code(404).send({ error: 'message not found' });
    }
    const body = req.body as any;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'request body required' });
    }

    const addLabelIds = Array.isArray(body.addLabelIds) ? body.addLabelIds : [];
    const removeLabelIds = Array.isArray(body.removeLabelIds) ? body.removeLabelIds : [];
    const addLabelKeys = Array.isArray(body.addLabelKeys) ? body.addLabelKeys : [];
    const removeLabelKeys = Array.isArray(body.removeLabelKeys) ? body.removeLabelKeys : [];

    if (addLabelIds.length === 0 && removeLabelIds.length === 0 && addLabelKeys.length === 0 && removeLabelKeys.length === 0) {
      return reply.code(400).send({ error: 'labels required' });
    }

    if (addLabelIds.length > 0) {
      await addLabelsToMessage(userId, messageId, addLabelIds);
    }
    if (removeLabelIds.length > 0) {
      await removeLabelsFromMessage(userId, messageId, removeLabelIds);
    }
    if (addLabelKeys.length > 0) {
      await addLabelsToMessageByKey(userId, messageId, addLabelKeys);
    }
    if (removeLabelKeys.length > 0) {
      await removeLabelsFromMessageByKey(userId, messageId, removeLabelKeys);
    }
    return listMessageLabels(userId, messageId);
  });

  app.delete('/api/messages/:messageId/labels/:labelId', async (req, reply) => {
    const userId = getUserId(req);
    const messageId = String((req.params as any).messageId);
    const labelId = String((req.params as any).labelId);
    const message = await getMessageAndConnectorForUser(userId, messageId);
    if (!message) {
      return reply.code(404).send({ error: 'message not found' });
    }
    await removeLabelsFromMessage(userId, messageId, [labelId]);
    return { status: 'deleted', messageId, labelId };
  });

  app.post('/api/oauth/google/authorize', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    const type = body?.type;
    const connectorId = body?.connectorId;
    const clientId = body?.oauthClientId;
    const clientSecret = body?.oauthClientSecret;

    if (!type || !connectorId) {
      return reply.code(400).send({ error: 'type (incoming|outgoing) and connectorId required' });
    }

    const connectorType = type === 'incoming' ? 'incoming' : 'outgoing';
    const connector = connectorType === 'incoming'
      ? await getIncomingConnector(userId, connectorId)
      : await getOutgoingConnector(userId, connectorId);

    if (!connector) {
      return reply.code(404).send({ error: `${connectorType} connector not found` });
    }

    if (!isGmailAuthConnector(connector)) {
      return reply.code(400).send({ error: 'OAuth flow is only valid for Gmail connectors' });
    }

    if (clientId || clientSecret) {
      const existingAuth = connector.authConfig ?? {};
      const nextAuth = {
        ...existingAuth,
        ...(clientId ? { oauthClientId: clientId } : {}),
        ...(clientSecret ? { oauthClientSecret: clientSecret } : {}),
      };

      if (connectorType === 'incoming') {
        await updateIncomingConnectorAuth(connectorId, nextAuth, userId);
      } else {
        await updateOutgoingConnectorAuth(connectorId, nextAuth, userId);
      }

      connector.authConfig = nextAuth;
    }

    const url = await getGoogleAuthorizeUrl(
      connectorType,
      connectorId,
      connector.authConfig?.oauthClientId ?? clientId,
      connector.authConfig?.oauthClientSecret ?? clientSecret,
      userId,
    );
    return { authorizeUrl: url };
  });

  app.get('/api/oauth/google/callback', async (req, reply) => {
    const redirectToFrontend = (status: 'ok' | 'error', extras: Record<string, string> = {}) => {
      const redirectUrl = new URL(env.oauthCallbackPath, env.frontendBaseUrl);
      redirectUrl.searchParams.set('status', status);
      for (const [key, value] of Object.entries(extras)) {
        if (value !== undefined) {
          redirectUrl.searchParams.set(key, value);
        }
      }

      return reply.code(302).redirect(redirectUrl.toString());
    };

    const queryParams = req.query as any;
    const code = queryParams?.code as string | undefined;
    const state = queryParams?.state as string | undefined;

    if (!code || !state) {
      return redirectToFrontend('error', { error: 'missing code or state' });
    }

    const payload = await consumeOAuthState(state);
    if (!payload) {
      return redirectToFrontend('error', { error: 'invalid or expired oauth state' });
    }

    const targetUserId = payload.userId;
    if (!targetUserId) {
      return redirectToFrontend('error', { error: 'oauth state missing user context' });
    }

    const { type, connectorId } = payload;

    const connectorTable = type === 'incoming' ? 'incoming_connectors' : 'outgoing_connectors';
    const connectorSelectColumns = type === 'incoming'
      ? 'auth_config, user_id, provider, sync_settings'
      : 'auth_config, user_id, provider, NULL::jsonb AS sync_settings';
    const whereClause = 'WHERE id = $1 AND user_id = $2';
    const params = [connectorId, targetUserId];

    const row = await query<any>(`SELECT ${connectorSelectColumns} FROM ${connectorTable} ${whereClause}`, params);
    if (row.rows.length === 0) {
      return redirectToFrontend('error', { error: `${type} connector not found` });
    }

    const existingAuth = row.rows[0]?.auth_config || {};
    const tokens = await exchangeCodeForTokens(code, existingAuth.oauthClientId, existingAuth.oauthClientSecret);
    const nextAuth = {
      ...(existingAuth || {}),
      authType: 'oauth2',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? existingAuth.refreshToken,
      tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : existingAuth.tokenExpiresAt,
      scope: tokens.scope,
    };

    if (type === 'incoming') {
      await updateIncomingConnectorAuth(connectorId, nextAuth, targetUserId);
      try {
        const provider = row.rows[0]?.provider;
        let connectorSyncSettings = row.rows[0]?.sync_settings ?? {};
        const fallbackMailbox = isGmailLikeConnector({ provider, sync_settings: connectorSyncSettings, syncSettings: connectorSyncSettings })
          ? normalizeGmailMailboxPath(env.sync.defaultMailbox)
          : env.sync.defaultMailbox;
        const existingWatchMailboxes: string[] = Array.isArray(connectorSyncSettings?.watchMailboxes)
          ? connectorSyncSettings.watchMailboxes.map((value: unknown) => String(value))
          : [];
        if (!existingWatchMailboxes.includes(fallbackMailbox)) {
          connectorSyncSettings = {
            ...connectorSyncSettings,
            watchMailboxes: [...existingWatchMailboxes, fallbackMailbox],
          };
          await updateIncomingConnector(targetUserId, connectorId, {
            syncSettings: connectorSyncSettings,
          });
        }

        const connectorPushEnabled = connectorSyncSettings?.gmailPush?.enabled !== false;
        if (provider === 'gmail' && env.gmailPush.enabled && env.gmailPush.topicName && connectorPushEnabled) {
          try {
            const watchLabelIds = buildGmailWatchLabelIds(
              Array.isArray(connectorSyncSettings.watchMailboxes)
                ? connectorSyncSettings.watchMailboxes
                  .map((value: unknown) => String(value))
                  .filter(Boolean)
                : [fallbackMailbox],
            );
            const watchResponse = await gmailApiRequest<{ historyId?: string | number; expiration?: string | number }>(
              'incoming',
              { id: connectorId, auth_config: nextAuth },
              '/watch',
              {
                method: 'POST',
                body: JSON.stringify({
                  topicName: env.gmailPush.topicName,
                  labelIds: watchLabelIds,
                  labelFilterAction: 'include',
                }),
              },
            );
            connectorSyncSettings = {
              ...connectorSyncSettings,
              gmailPush: {
                ...(connectorSyncSettings.gmailPush ?? {}),
                topicName: env.gmailPush.topicName,
                webhookAudience: getGmailPushAudience(),
                historyId: watchResponse.historyId ? String(watchResponse.historyId) : null,
                expiration: watchResponse.expiration
                  ? new Date(Number(watchResponse.expiration)).toISOString()
                  : null,
                status: 'watching',
                updatedAt: new Date().toISOString(),
              },
            };
            await updateIncomingConnector(targetUserId, connectorId, {
              syncSettings: connectorSyncSettings,
            });
          } catch (error) {
            app.log.warn({ error, connectorId }, 'failed to register gmail push watch');
          }
        }

        const shouldStartIdleWatch = !(provider === 'gmail' && env.gmailPush.enabled);
        if (shouldStartIdleWatch) {
          try {
            await startIncomingConnectorIdleWatch(targetUserId, connectorId, fallbackMailbox);
          } catch {
            // best effort: initial sync queueing should still continue even if watcher startup fails
          }
        }

        const mailboxes = await listConnectorMailboxes(targetUserId, connectorId);
        const queueTargets = mailboxes
          .map((mailbox) => isGmailLikeConnector({ provider, sync_settings: connectorSyncSettings, syncSettings: connectorSyncSettings })
            ? normalizeGmailMailboxPath(mailbox.path)
            : mailbox.path)
          .filter((mailbox) => Boolean(mailbox && String(mailbox).trim()));
        const uniqueTargets = Array.from(new Set(queueTargets));
        const targets = uniqueTargets.length > 0 ? uniqueTargets : [fallbackMailbox];
        for (const mailbox of targets) {
          await ensureIncomingConnectorState(connectorId, mailbox);
          const enqueued = await enqueueSyncWithOptions(targetUserId, connectorId, mailbox, {
            priority: resolveSyncQueuePriority(targetUserId, connectorId, mailbox),
          });
          if (enqueued) {
            await setSyncState(connectorId, mailbox, {
              status: 'queued',
              syncCompletedAt: null,
              syncError: null,
              syncProgress: { inserted: 0, updated: 0, reconciledRemoved: 0, metadataRefreshed: 0 },
            });
          }
        }
      } catch {
        // no-op: callback should still succeed even if background queue is temporarily unavailable
      }
    } else {
      await updateOutgoingConnectorAuth(connectorId, nextAuth, targetUserId);
    }

    return redirectToFrontend('ok', {
      connectorType: type,
      connectorId,
    });
  });

  app.post('/api/sync/:connectorId', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    const body = (req.body as any) || {};
    const connector = await getIncomingConnector(userId, connectorId);
    if (!connector) {
      return reply.code(404).send({ error: 'connector not found' });
    }
    const mailboxInput = body.mailbox || 'INBOX';
    const mailbox = isGmailLikeConnector(connector)
      ? normalizeGmailMailboxPath(mailboxInput)
      : mailboxInput;
    const useQueue = body.useQueue === true;
    const syncAll = body.syncAll === true;
    const requestedPriority = String(body.priority || '').toLowerCase() === 'high' ? 'high' : 'normal';
    const resolvePriorityForMailbox = (targetMailbox: string) =>
      requestedPriority === 'high'
        ? 'high'
        : resolveSyncQueuePriority(userId, connectorId, targetMailbox);

    if (syncAll) {
      const mailboxes = await listConnectorMailboxes(userId, connectorId);
      const queueTargets = mailboxes
        .map((entry) => isGmailLikeConnector(connector)
          ? normalizeGmailMailboxPath(entry.path)
          : entry.path)
        .filter((entry) => Boolean(entry && String(entry).trim()));
      const uniqueTargets = Array.from(new Set(queueTargets));
      const fallbackMailbox = isGmailLikeConnector(connector)
        ? normalizeGmailMailboxPath(env.sync.defaultMailbox)
        : env.sync.defaultMailbox;
      const targets = uniqueTargets.length > 0 ? uniqueTargets : [fallbackMailbox];

      let queued = 0;
      for (const targetMailbox of targets) {
        await ensureIncomingConnectorState(connectorId, targetMailbox);
        const enqueued = await enqueueSyncWithOptions(userId, connectorId, targetMailbox, {
          priority: resolvePriorityForMailbox(targetMailbox),
        });
        if (enqueued) {
          queued += 1;
          try {
            await setSyncState(connectorId, targetMailbox, {
              status: 'queued',
              syncCompletedAt: null,
              syncError: null,
              syncProgress: { inserted: 0, updated: 0, reconciledRemoved: 0, metadataRefreshed: 0 },
            });
          } catch {
            // Ignore sync state persistence failures to keep sync trigger responsive.
          }
        }
      }
      return { status: 'queued', queued, total: targets.length, mailboxes: targets };
    }

    if (useQueue) {
      await ensureIncomingConnectorState(connectorId, mailbox);
      try {
        const enqueued = await enqueueSyncWithOptions(userId, connectorId, mailbox, {
          priority: resolvePriorityForMailbox(mailbox),
        });
        if (enqueued) {
          try {
            await setSyncState(connectorId, mailbox, {
              status: 'queued',
              syncCompletedAt: null,
              syncError: null,
              syncProgress: { inserted: 0, updated: 0, reconciledRemoved: 0, metadataRefreshed: 0 },
            });
          } catch {
            // Ignore sync state persistence failures to keep sync trigger responsive
            // (older schemas or transient DB state issues should not block sync start).
          }
          return { status: 'queued' };
        }
        const snapshot = await getMailboxState(connectorId, mailbox).catch(() => null);
        if (snapshot?.status === 'syncing' || snapshot?.status === 'queued' || snapshot?.status === 'cancel_requested') {
          return { status: 'syncing' };
        }
        await syncIncomingConnector(userId, connectorId, mailbox);
        return { status: 'ok' };
      } catch {
        await syncIncomingConnector(userId, connectorId, mailbox);
        return { status: 'ok' };
      }
    }

    await syncIncomingConnector(userId, connectorId, mailbox);
    return { status: 'ok' };
  });

  app.post('/api/sync/active-mailbox', async (req, reply) => {
    const userId = getUserId(req);
    const body = (req.body as any) || {};
    const connectorId = String(body.connectorId || '').trim();
    const mailboxInput = String(body.mailbox || '').trim();
    if (!connectorId || !mailboxInput) {
      return reply.code(400).send({ error: 'connectorId and mailbox are required' });
    }

    const connector = await getIncomingConnector(userId, connectorId);
    if (!connector) {
      return reply.code(404).send({ error: 'connector not found' });
    }

    const mailbox = isGmailLikeConnector(connector)
      ? normalizeGmailMailboxPath(mailboxInput)
      : mailboxInput;
    markActiveMailbox(userId, connectorId, mailbox);
    return { status: 'ok' };
  });

  app.post('/api/sync/:connectorId/cancel', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    const body = (req.body as any) || {};
    const connector = await getIncomingConnector(userId, connectorId);
    if (!connector) {
      return reply.code(404).send({ error: 'connector not found' });
    }
    const mailbox = isGmailLikeConnector(connector)
      ? normalizeGmailMailboxPath(body.mailbox || env.sync.defaultMailbox)
      : (body.mailbox || env.sync.defaultMailbox);
    return requestSyncCancellation(userId, connectorId, mailbox);
  });

  app.get('/api/connectors/:connectorId/sync-state', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    const queryParams = req.query as any;
    const mailboxInput = String(queryParams?.mailbox || env.sync.defaultMailbox);

    const connector = await getIncomingConnector(userId, connectorId);
    if (!connector) {
      return reply.code(404).send({ error: 'connector not found' });
    }
    const mailbox = isGmailLikeConnector(connector)
      ? normalizeGmailMailboxPath(mailboxInput)
      : mailboxInput;

    await ensureIncomingConnectorState(connectorId, mailbox);
    try {
      return await getMailboxState(connectorId, mailbox);
    } catch {
      return {
        lastSeenUid: 0,
        highestUid: 0,
        lastFullReconcileAt: null,
        mailboxUidValidity: null,
        modseq: null,
        status: 'idle',
        syncStartedAt: null,
        syncCompletedAt: null,
        syncError: null,
        syncProgress: {},
      };
    }
  });

  app.get('/api/connectors/:connectorId/sync-states', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    const connector = await getIncomingConnector(userId, connectorId);
    if (!connector) {
      return reply.code(404).send({ error: 'connector not found' });
    }

    // Keep sync-state polling fully DB-backed. Listing remote mailboxes here
    // opens extra IMAP/Gmail API sessions and can starve active sync watchers.
    const configuredWatchMailboxes = Array.isArray(connector.sync_settings?.watchMailboxes)
      ? connector.sync_settings.watchMailboxes
        .map((value: unknown) => String(value || '').trim())
        .filter(Boolean)
      : [];
    const fallbackMailbox = isGmailLikeConnector(connector)
      ? normalizeGmailMailboxPath(env.sync.defaultMailbox)
      : env.sync.defaultMailbox;
    const seedMailboxes = configuredWatchMailboxes.length > 0
      ? configuredWatchMailboxes
      : [fallbackMailbox];

    const ignoredContainerMailboxes = new Set<string>(['[GMAIL]', '[GOOGLE MAIL]']);
    const uniqueMailboxes = Array.from(new Set<string>(
      seedMailboxes
        .map((entry: string) => (isGmailLikeConnector(connector) ? normalizeGmailMailboxPath(entry) : entry))
        .map((entry: string) => String(entry || '').trim())
        .filter((entry: string): entry is string => Boolean(entry)),
    )).filter((mailbox: string) => !ignoredContainerMailboxes.has(mailbox.toUpperCase()));

    for (const mailbox of uniqueMailboxes) {
      await ensureIncomingConnectorState(connectorId, mailbox);
    }

    const states = await query<any>(
      `SELECT mailbox,
              last_seen_uid as "lastSeenUid",
              highest_uid as "highestUid",
              last_full_reconcile_at as "lastFullReconcileAt",
              uidvalidity as "mailboxUidValidity",
              modseq,
              status,
              sync_started_at as "syncStartedAt",
              sync_completed_at as "syncCompletedAt",
              sync_error as "syncError",
              sync_progress as "syncProgress"
         FROM sync_states
        WHERE incoming_connector_id = $1
          AND UPPER(mailbox) <> ALL($2::text[])
        ORDER BY mailbox`,
      [connectorId, Array.from(ignoredContainerMailboxes)],
    );

    return {
      connectorId,
      states: states.rows.map((row: any) => ({
        ...row,
        syncProgress: row.syncProgress ?? {},
      })),
    };
  });

  app.post('/api/sync/:connectorId/watch', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    const body = req.body as any;
    const mailboxInput = body?.mailbox || env.sync.defaultMailbox;
    const connector = await getIncomingConnector(userId, connectorId);
    if (!connector) {
      return reply.code(404).send({ error: 'connector not found' });
    }
    const mailbox = isGmailLikeConnector(connector)
      ? normalizeGmailMailboxPath(mailboxInput)
      : mailboxInput;
    await startIncomingConnectorIdleWatch(userId, connectorId, mailbox);
    const existingMailboxes = Array.isArray(connector.sync_settings?.watchMailboxes)
      ? connector.sync_settings.watchMailboxes.map((value: unknown) => String(value))
      : [];
    if (!existingMailboxes.includes(mailbox)) {
      await updateIncomingConnector(userId, connectorId, {
        syncSettings: {
          ...(connector.sync_settings ?? {}),
          watchMailboxes: [...existingMailboxes, mailbox],
        },
      });
    }
    return { status: 'watching', connectorId, mailbox };
  });

  app.post('/api/sync/:connectorId/watch/stop', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    const body = req.body as any;
    const mailboxInput = body?.mailbox || env.sync.defaultMailbox;
    const connector = await getIncomingConnector(userId, connectorId);
    if (!connector) {
      return reply.code(404).send({ error: 'connector not found' });
    }
    const mailbox = isGmailLikeConnector(connector)
      ? normalizeGmailMailboxPath(mailboxInput)
      : mailboxInput;
    await stopIncomingConnectorIdleWatch(userId, connectorId, mailbox);
    const existingMailboxes = Array.isArray(connector.sync_settings?.watchMailboxes)
      ? connector.sync_settings.watchMailboxes.map((value: unknown) => String(value))
      : [];
    const nextMailboxes = existingMailboxes.filter((value: string) => value !== mailbox);
    if (nextMailboxes.length !== existingMailboxes.length) {
      await updateIncomingConnector(userId, connectorId, {
        syncSettings: {
          ...(connector.sync_settings ?? {}),
          watchMailboxes: nextMailboxes,
        },
      });
    }
    return { status: 'stopped', connectorId, mailbox };
  });

  app.post('/api/sync/:connectorId/gmail-push', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    const body = (req.body as any) || {};
    const enabled = body?.enabled !== false;
    const connector = await getIncomingConnector(userId, connectorId);
    if (!connector) {
      return reply.code(404).send({ error: 'connector not found' });
    }
    if (connector.provider !== 'gmail') {
      return reply.code(400).send({ error: 'gmail push is only supported for provider=gmail connectors' });
    }

    const existingSyncSettings = connector.sync_settings ?? {};
    const fallbackMailbox = normalizeGmailMailboxPath(env.sync.defaultMailbox);
    const existingWatchMailboxes: string[] = Array.isArray(existingSyncSettings.watchMailboxes)
      ? existingSyncSettings.watchMailboxes.map((value: unknown) => String(value)).filter(Boolean)
      : [];
    const watchMailboxes: string[] = Array.from(new Set<string>(
      (existingWatchMailboxes.length > 0 ? existingWatchMailboxes : [fallbackMailbox])
        .map((mailbox: string) => normalizeGmailMailboxPath(mailbox)),
    ));

    if (enabled) {
      if (!env.gmailPush.enabled || !env.gmailPush.topicName) {
        return reply.code(503).send({ error: 'gmail push is not configured on server' });
      }

      const watchResponse = await gmailApiRequest<{ historyId?: string | number; expiration?: string | number }>(
        'incoming',
        { id: connectorId, auth_config: connector.auth_config ?? {} },
        '/watch',
        {
          method: 'POST',
          body: JSON.stringify({
            topicName: env.gmailPush.topicName,
            labelIds: buildGmailWatchLabelIds(watchMailboxes),
            labelFilterAction: 'include',
          }),
        },
      );

      const nextSyncSettings = {
        ...existingSyncSettings,
        watchMailboxes,
        gmailPush: {
          ...(existingSyncSettings.gmailPush ?? {}),
          enabled: true,
          status: 'watching',
          topicName: env.gmailPush.topicName,
          webhookAudience: getGmailPushAudience(),
          historyId: watchResponse.historyId ? String(watchResponse.historyId) : null,
          expiration: watchResponse.expiration
            ? new Date(Number(watchResponse.expiration)).toISOString()
            : null,
          updatedAt: new Date().toISOString(),
        },
      };
      await updateIncomingConnector(userId, connectorId, { syncSettings: nextSyncSettings });
      return { status: 'watching', connectorId, gmailPush: nextSyncSettings.gmailPush };
    }

    try {
      await gmailApiRequest(
        'incoming',
        { id: connectorId, auth_config: connector.auth_config ?? {} },
        '/stop',
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
      );
    } catch (error) {
      req.log.warn({ error, connectorId }, 'gmail push stop failed');
    }

    const nextSyncSettings = {
      ...existingSyncSettings,
      watchMailboxes,
      gmailPush: {
        ...(existingSyncSettings.gmailPush ?? {}),
        enabled: false,
        status: 'stopped',
        updatedAt: new Date().toISOString(),
      },
    };
    await updateIncomingConnector(userId, connectorId, { syncSettings: nextSyncSettings });
    return { status: 'stopped', connectorId, gmailPush: nextSyncSettings.gmailPush };
  });

  app.post('/api/gmail/push', async (req, reply) => {
    if (!env.gmailPush.enabled) {
      return reply.code(404).send({ error: 'gmail push disabled' });
    }

    try {
      await verifyPubSubPushToken(req.headers.authorization);
    } catch (error) {
      req.log.warn({ error }, 'gmail push token verification failed');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    let decoded: { emailAddress: string; historyId?: string | null } | null = null;
    try {
      decoded = decodePubSubPushBody(req.body);
    } catch (error) {
      req.log.warn({ error }, 'invalid pubsub push payload');
      return reply.code(204).send();
    }
    if (!decoded) {
      return reply.code(204).send();
    }

    const connectors = await query<{
      id: string;
      user_id: string;
      sync_settings: Record<string, any> | null;
    }>(
      `SELECT id, user_id, sync_settings
         FROM incoming_connectors
        WHERE provider = 'gmail'
          AND status = 'active'
          AND LOWER(email_address) = LOWER($1)`,
      [decoded.emailAddress],
    );

    for (const connector of connectors.rows) {
      const existingSyncSettings = connector.sync_settings ?? {};
      if (existingSyncSettings.gmailPush?.enabled === false) {
        continue;
      }
      const configuredWatchMailboxes = Array.isArray(existingSyncSettings.watchMailboxes)
        ? existingSyncSettings.watchMailboxes.map((value: unknown) => String(value)).filter(Boolean)
        : [];
      const fallbackMailbox = normalizeGmailMailboxPath(env.sync.defaultMailbox);
      const targetMailboxes = Array.from(new Set(
        (configuredWatchMailboxes.length > 0 ? configuredWatchMailboxes : [fallbackMailbox])
          .map((mailbox) => normalizeGmailMailboxPath(mailbox)),
      ));

      for (const mailbox of targetMailboxes) {
        await ensureIncomingConnectorState(connector.id, mailbox);
        const enqueued = await enqueueSyncWithOptions(connector.user_id, connector.id, mailbox, {
          priority: resolveSyncQueuePriority(connector.user_id, connector.id, mailbox),
          gmailHistoryIdHint: decoded.historyId ?? null,
        });
        if (enqueued) {
          await setSyncState(connector.id, mailbox, {
            status: 'queued',
            syncCompletedAt: null,
            syncError: null,
            syncProgress: { inserted: 0, updated: 0, reconciledRemoved: 0, metadataRefreshed: 0 },
          });
        } else {
          void syncIncomingConnector(connector.user_id, connector.id, mailbox, {
            gmailHistoryIdHint: decoded.historyId ?? null,
          }).catch((error) => {
            req.log.warn({ error, connectorId: connector.id, mailbox }, 'gmail push fallback sync failed');
          });
        }
      }

      const nextSyncSettings = {
        ...existingSyncSettings,
        gmailPush: {
          ...(existingSyncSettings.gmailPush ?? {}),
          topicName: env.gmailPush.topicName || (existingSyncSettings.gmailPush?.topicName ?? null),
          webhookAudience: getGmailPushAudience(),
          lastNotificationHistoryId: decoded.historyId ?? null,
          lastNotificationAt: new Date().toISOString(),
        },
      };
      await updateIncomingConnector(connector.user_id, connector.id, {
        syncSettings: nextSyncSettings,
      });
    }

    return reply.code(204).send();
  });

  app.get('/api/events', async (req) => {
    const userId = getUserId(req);
    const queryObject = req.query as any;
    const parsedSince = Number(queryObject?.since);
    const parsedLimit = Number(queryObject?.limit);
    const since = Number.isFinite(parsedSince) && parsedSince >= 0 ? Math.floor(parsedSince) : 0;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 100;
    return listSyncEvents(userId, since, limit);
  });

  app.get('/api/events/stream', async (req, reply) => {
    const userId = getUserId(req);
    const queryObject = req.query as any;
    const parsedSince = Number(queryObject?.since);
    let since = Number.isFinite(parsedSince) && parsedSince >= 0 ? Math.floor(parsedSince) : 0;

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    const onClose = () => {
      closed = true;
    };
    req.raw.on('close', onClose);
    req.raw.on('aborted', onClose);

    reply.raw.write(`event: ready\ndata: {"since":${since}}\n\n`);

    while (!closed) {
      try {
        const events = await listSyncEvents(userId, since, 250);
        if (events.length > 0) {
          for (const event of events) {
            const eventId = Number((event as any).id ?? 0);
            if (Number.isFinite(eventId) && eventId > since) {
              since = eventId;
            }
            reply.raw.write(`id: ${eventId || since}\n`);
            reply.raw.write(`event: sync\n`);
            reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          continue;
        }

        const signal = await waitForSyncEventSignal(userId, since, 25_000);
        if (closed) {
          break;
        }
        if (!signal) {
          reply.raw.write(`event: ping\ndata: {"since":${since}}\n\n`);
        }
      } catch (error) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: String(error) })}\n\n`);
      }
    }

    req.raw.off('close', onClose);
    req.raw.off('aborted', onClose);
    if (!reply.raw.writableEnded) {
      reply.raw.end();
    }
    return reply;
  });

  app.get('/api/messages', async (req) => {
    const userId = getUserId(req);
    const queryObject = req.query as any;
    const limitInput = Number(queryObject?.limit ?? 50);
    const offsetInput = Number(queryObject?.offset ?? 0);
    const folder = await normalizeConnectorFolderFilter(userId, queryObject?.folder as string | undefined, queryObject?.connectorId as string | undefined);
    const normalizedFolder = String(folder ?? '').trim().toUpperCase();
    const folderFilter = await buildGmailFolderPredicates(
      userId,
      queryObject?.folder as string | undefined,
      queryObject?.connectorId as string | undefined,
    );
    const connectorId = queryObject?.connectorId;
    const label = queryObject?.label;
    const labelId = queryObject?.labelId;
    const hasAttachment = parseBooleanParam(queryObject?.hasAttachment);
    const isStarred = parseBooleanParam(queryObject?.isStarred);

    const predicates = ['ic.user_id = $1'];
    const values: any[] = [userId];
    if (normalizedFolder !== 'STARRED') {
      if (folderFilter.candidates && folderFilter.candidates.length > 0) {
        if (folderFilter.candidates.length === 1) {
          values.push(folderFilter.candidates[0]);
          predicates.push(`m.folder_path_norm = $${values.length}`);
        } else {
          values.push(folderFilter.candidates);
          predicates.push(`m.folder_path_norm = ANY($${values.length}::text[])`);
        }
      } else if (folder) {
        values.push(String(folder).toUpperCase());
        predicates.push(`m.folder_path_norm = $${values.length}`);
      }
    }
    if (connectorId) {
      values.push(connectorId);
      predicates.push(`m.incoming_connector_id = $${values.length}`);
    }
    if (label && typeof label === 'string') {
      const normalizedLabel = label.toLowerCase();
      values.push(normalizedLabel);
      predicates.push(`EXISTS (
         SELECT 1 FROM message_labels ml
         JOIN labels l ON l.id = ml.label_id
        WHERE ml.message_id = m.id
          AND l.user_id = $1
          AND l.key = $${values.length}
      )`);
    }
    if (labelId && typeof labelId === 'string') {
      values.push(labelId);
      predicates.push(`EXISTS (
         SELECT 1 FROM message_labels ml
        WHERE ml.message_id = m.id
          AND ml.label_id = $${values.length}
      )`);
    }
    if (typeof isStarred === 'boolean') {
      predicates.push(`m.is_starred = ${isStarred ? 'TRUE' : 'FALSE'}`);
    }
    if (typeof hasAttachment === 'boolean') {
      if (hasAttachment) {
        predicates.push(`EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)`);
      } else {
        predicates.push(`NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)`);
      }
    }
    if (normalizedFolder === 'STARRED') {
      predicates.push('m.is_starred = TRUE');
    }
    const limit = Number.isFinite(limitInput) && limitInput > 0
      ? Math.floor(limitInput)
      : 50;
    const offset = Number.isFinite(offsetInput) && offsetInput >= 0
      ? Math.floor(offsetInput)
      : 0;
    
    const shouldDedupeLogicalMessages = !folder || folderFilter.dedupeLogicalMessages;

    const countResult = shouldDedupeLogicalMessages
      ? await query<{ count: string }>(
          `SELECT COUNT(*)::int as count
             FROM (
               SELECT DISTINCT m.incoming_connector_id, COALESCE(NULLIF(m.gmail_message_id, ''), LOWER(NULLIF(m.message_id, '')), m.id::text)
                 FROM messages m
                 INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
                WHERE ${predicates.join(' AND ')}
             ) dedup`,
          values,
        )
      : await query<{ count: string }>(
          `SELECT COUNT(*)::int as count
             FROM messages m
             INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
            WHERE ${predicates.join(' AND ')}`,
          values,
        );

    values.push(limit, offset);

    const result = shouldDedupeLogicalMessages
      ? await query<any>(
          `SELECT dedup.id,
                  dedup."incomingConnectorId",
                  dedup."messageId",
                  dedup.subject,
                  dedup."fromHeader",
                  dedup."toHeader",
                  dedup."folderPath",
                  dedup.snippet,
                  dedup."receivedAt",
                  dedup."isRead",
                  dedup."isStarred",
                  dedup."threadId",
                  dedup.thread_count as "threadCount",
                  dedup.participants
             FROM (
               SELECT DISTINCT ON (m.incoming_connector_id, COALESCE(NULLIF(m.gmail_message_id, ''), LOWER(NULLIF(m.message_id, '')), m.id::text))
                      m.id,
                      m.incoming_connector_id as "incomingConnectorId",
                      m.message_id as "messageId",
                      m.subject,
                      m.from_header as "fromHeader",
                      m.to_header as "toHeader",
                      m.folder_path as "folderPath",
                      m.snippet,
                      m.received_at as "receivedAt",
                      m.is_read as "isRead",
                      m.is_starred as "isStarred",
                      m.thread_id as "threadId",
                      CASE
                        WHEN m.thread_id IS NULL THEN 1
                        ELSE (
                          SELECT COUNT(DISTINCT COALESCE(NULLIF(m3.gmail_message_id, ''), LOWER(NULLIF(m3.message_id, '')), m3.id::text))
                            FROM messages m3
                           WHERE m3.incoming_connector_id = m.incoming_connector_id
                             AND m3.thread_id = m.thread_id
                        )
                      END as thread_count,
                      CASE
                        WHEN m.thread_id IS NULL THEN
                          CASE
                            WHEN m.from_header IS NULL THEN '[]'::jsonb
                            ELSE jsonb_build_array(m.from_header)
                          END
                        ELSE COALESCE((
                          SELECT jsonb_agg(thread_participant.participant)
                            FROM (
                              SELECT DISTINCT m2.from_header AS participant
                                FROM messages m2
                               WHERE m2.incoming_connector_id = m.incoming_connector_id
                                 AND m2.thread_id = m.thread_id
                                 AND m2.from_header IS NOT NULL
                            ) thread_participant
                        ), '[]'::jsonb)
                      END as participants
                 FROM messages m
                 INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
                WHERE ${predicates.join(' AND ')}
                ORDER BY
                  m.incoming_connector_id,
                  COALESCE(NULLIF(m.gmail_message_id, ''), LOWER(NULLIF(m.message_id, '')), m.id::text),
                  ${mailboxReadPreferenceRankSql},
                  m.received_at DESC NULLS LAST,
                  m.updated_at DESC,
                  m.id DESC
             ) dedup
            ORDER BY dedup."receivedAt" DESC, dedup.id DESC
            LIMIT $${values.length - 1} OFFSET $${values.length}`,
          values,
        )
      : await query<any>(
          `SELECT m.id,
                  m.incoming_connector_id as "incomingConnectorId",
                  m.message_id as "messageId",
                  m.subject,
                  m.from_header as "fromHeader",
                  m.to_header as "toHeader",
                  m.folder_path as "folderPath",
                  m.snippet,
                  m.received_at as "receivedAt",
                  m.is_read as "isRead",
                  m.is_starred as "isStarred",
                  m.thread_id as "threadId",
                  1 as "threadCount",
                  jsonb_build_array(m.from_header) as participants
            FROM messages m
            INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
           WHERE ${predicates.join(' AND ')}
            ORDER BY m.received_at DESC
            LIMIT $${values.length - 1} OFFSET $${values.length}`,
          values,
        );
    return {
      messages: result.rows,
      totalCount: Number(countResult.rows[0]?.count ?? 0),
    };
  });

  app.get('/api/messages/send-only', async (req, reply) => {
    const userId = getUserId(req);
    const queryObject = req.query as any;
    const emailAddress = String(queryObject?.emailAddress ?? '').trim().toLowerCase();
    if (!emailAddress) {
      return reply.code(400).send({ error: 'emailAddress required' });
    }

    const folderToken = String(queryObject?.folder ?? 'OUTBOX').trim().toUpperCase();
    const normalizedFolder = folderToken === 'SENT' ? 'SENT' : 'OUTBOX';
    const statuses = normalizedFolder === 'SENT'
      ? ['succeeded']
      : ['pending', 'processing', 'failed'];
    const searchText = String(queryObject?.q ?? '').trim();
    const limitInput = Number(queryObject?.limit ?? 50);
    const offsetInput = Number(queryObject?.offset ?? 0);
    const limit = Number.isFinite(limitInput) && limitInput > 0 ? Math.floor(limitInput) : 50;
    const offset = Number.isFinite(offsetInput) && offsetInput >= 0 ? Math.floor(offsetInput) : 0;

    const values: any[] = [userId, emailAddress, statuses];
    const predicates = [
      's.user_id = $1',
      'LOWER(i.email_address) = $2',
      's.status = ANY($3::text[])',
    ];

    if (searchText) {
      values.push(`%${searchText}%`);
      predicates.push(`(
        COALESCE(s.request_meta->>'subject', '') ILIKE $${values.length}
        OR COALESCE(s.request_meta->>'to', '') ILIKE $${values.length}
      )`);
    }

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*)::int as count
         FROM send_idempotency s
         INNER JOIN identities i ON i.id = s.identity_id
        WHERE ${predicates.join(' AND ')}`,
      values,
    );

    values.push(limit, offset);
    const rowsResult = await query<any>(
      `SELECT s.idempotency_key as "idempotencyKey",
              s.status,
              s.error_message as "sendError",
              s.result,
              s.request_meta as "requestMeta",
              s.updated_at as "updatedAt",
              i.display_name as "displayName",
              i.email_address as "emailAddress"
         FROM send_idempotency s
         INNER JOIN identities i ON i.id = s.identity_id
        WHERE ${predicates.join(' AND ')}
        ORDER BY s.updated_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    const messages = rowsResult.rows.map((row: any) => {
      const requestMeta = (row.requestMeta ?? {}) as Record<string, any>;
      const toHeader = String(requestMeta.to ?? '').trim();
      const bodyText = String(requestMeta.bodyText ?? '').trim();
      const sendError = row.sendError ? String(row.sendError) : null;
      const statusLabel = String(row.status ?? '').toUpperCase();
      const fallbackSnippet = normalizedFolder === 'OUTBOX'
        ? `Outbox (${statusLabel.toLowerCase()})`
        : `Sent (${statusLabel.toLowerCase()})`;
      const snippetSource = sendError ?? bodyText ?? '';
      const snippet = (snippetSource.trim() || fallbackSnippet).slice(0, 220);

      return {
        id: `${normalizedFolder}:${row.idempotencyKey}`,
        incomingConnectorId: 'send-only',
        messageId: String(row?.result?.messageId ?? row.idempotencyKey),
        subject: String(requestMeta.subject ?? '').trim() || '(no subject)',
        fromHeader: `${row.displayName || row.emailAddress} <${row.emailAddress}>`,
        toHeader: toHeader || null,
        folderPath: normalizedFolder,
        snippet,
        bodyText: bodyText || null,
        bodyHtml: null,
        receivedAt: row.updatedAt,
        isRead: true,
        isStarred: false,
        threadId: null,
        threadCount: 1,
        participants: toHeader ? [toHeader] : [],
        sendStatus: row.status,
        sendError,
        sendOnlyNoResponses: true,
      };
    });

    return {
      messages,
      totalCount: Number(countResult.rows[0]?.count ?? 0),
    };
  });

  app.post('/api/messages/search', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    let q = body?.q ?? body?.query;
    if (!q && body?.savedSearchId) {
      const saved = await getSavedSearch(userId, String(body.savedSearchId));
      if (!saved) {
        return reply.code(404).send({ error: 'saved search not found' });
      }
      q = saved.queryText;
    }
    const parsedQuery = required(q, 'q');
    const limit = Number(body?.limit ?? 50);
    const folder = await normalizeConnectorFolderFilter(userId, body?.folder as string | undefined, body?.connectorId as string | undefined);
    const normalizedFolder = String(folder ?? '').trim().toUpperCase();
    const connectorId = body?.connectorId;

    const parsed = parseMessageSearchQuery(String(parsedQuery));
    const parsedResult = buildMessageSearchQuery(userId, parsed);
    const values = parsedResult.values;
    const predicates = parsedResult.predicates;
    const folderFilter = await buildGmailFolderPredicates(
      userId,
      body?.folder as string | undefined,
      body?.connectorId as string | undefined,
    );
    if (normalizedFolder !== 'STARRED' && folder) {
      if (folderFilter.candidates && folderFilter.candidates.length > 0) {
        if (folderFilter.candidates.length === 1) {
          values.push(folderFilter.candidates[0]);
          predicates.push(`m.folder_path_norm = $${values.length}`);
        } else {
          values.push(folderFilter.candidates);
          predicates.push(`m.folder_path_norm = ANY($${values.length}::text[])`);
        }
      } else {
        values.push(String(folder).toUpperCase());
        predicates.push(`m.folder_path_norm = $${values.length}`);
      }
    }
    if (connectorId) {
      values.push(connectorId);
      predicates.push(`m.incoming_connector_id = $${values.length}`);
    }
    if (normalizedFolder === 'STARRED') {
      predicates.push('m.is_starred = TRUE');
    }

    const shouldDedupeLogicalMessages = !folder || folderFilter.dedupeLogicalMessages;

    const countResult = shouldDedupeLogicalMessages
      ? await query<{ count: string }>(
          `SELECT COUNT(*)::int as count
             FROM (
               SELECT DISTINCT m.incoming_connector_id, COALESCE(NULLIF(m.gmail_message_id, ''), LOWER(NULLIF(m.message_id, '')), m.id::text)
                 FROM messages m
                 INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
                WHERE ${predicates.join(' AND ')}
             ) dedup`,
          values,
        )
      : await query<{ count: string }>(
          `SELECT COUNT(*)::int as count
             FROM messages m
             INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
            WHERE ${predicates.join(' AND ')}`,
          values,
        );

    const offsetInput = Number((req.body as any)?.offset ?? 0);
    const offset = Number.isFinite(offsetInput) && offsetInput >= 0 ? Math.floor(offsetInput) : 0;
    
    values.push(Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50, offset);

    const result = shouldDedupeLogicalMessages
      ? await query<any>(
          `SELECT dedup.id,
                  dedup."incomingConnectorId",
                  dedup."messageId",
                  dedup.subject,
                  dedup."fromHeader",
                  dedup."toHeader",
                  dedup."folderPath",
                  dedup.snippet,
                  dedup."receivedAt",
                  dedup."threadId",
                  dedup."isRead",
                  dedup."isStarred",
                  dedup.thread_count as "threadCount",
                  dedup.participants
             FROM (
               SELECT DISTINCT ON (m.incoming_connector_id, COALESCE(NULLIF(m.gmail_message_id, ''), LOWER(NULLIF(m.message_id, '')), m.id::text))
                      m.id,
                      m.incoming_connector_id as "incomingConnectorId",
                      m.message_id as "messageId",
                      m.subject,
                      m.from_header as "fromHeader",
                      m.to_header as "toHeader",
                      m.folder_path as "folderPath",
                      m.snippet,
                      m.received_at as "receivedAt",
                      m.thread_id as "threadId",
                      m.is_read as "isRead",
                      m.is_starred as "isStarred",
                      CASE
                        WHEN m.thread_id IS NULL THEN 1
                        ELSE (
                          SELECT COUNT(DISTINCT COALESCE(NULLIF(m3.gmail_message_id, ''), LOWER(NULLIF(m3.message_id, '')), m3.id::text))
                            FROM messages m3
                           WHERE m3.incoming_connector_id = m.incoming_connector_id
                             AND m3.thread_id = m.thread_id
                        )
                      END as thread_count,
                      CASE
                        WHEN m.thread_id IS NULL THEN
                          CASE
                            WHEN m.from_header IS NULL THEN '[]'::jsonb
                            ELSE jsonb_build_array(m.from_header)
                          END
                        ELSE COALESCE((
                          SELECT jsonb_agg(thread_participant.participant)
                            FROM (
                              SELECT DISTINCT m2.from_header AS participant
                                FROM messages m2
                               WHERE m2.incoming_connector_id = m.incoming_connector_id
                                 AND m2.thread_id = m.thread_id
                                 AND m2.from_header IS NOT NULL
                            ) thread_participant
                        ), '[]'::jsonb)
                      END as participants
                 FROM messages m
                 INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
                WHERE ${predicates.join(' AND ')}
                ORDER BY
                  m.incoming_connector_id,
                  COALESCE(NULLIF(m.gmail_message_id, ''), LOWER(NULLIF(m.message_id, '')), m.id::text),
                  ${mailboxReadPreferenceRankSql},
                  m.received_at DESC NULLS LAST,
                  m.updated_at DESC,
                  m.id DESC
             ) dedup
            ORDER BY dedup."receivedAt" DESC, dedup.id DESC
            LIMIT $${values.length - 1} OFFSET $${values.length}`,
          values,
        )
      : await query<any>(
          `SELECT m.id,
                  m.incoming_connector_id as "incomingConnectorId",
                  m.message_id as "messageId",
                  m.subject,
                  m.from_header as "fromHeader",
                  m.to_header as "toHeader",
                  m.folder_path as "folderPath",
                  m.snippet,
                  m.received_at as "receivedAt",
                  m.thread_id as "threadId",
                  m.is_read as "isRead",
                  m.is_starred as "isStarred",
                  1 as "threadCount",
                  jsonb_build_array(m.from_header) as participants
             FROM messages m
             INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
            WHERE ${predicates.join(' AND ')}
            ORDER BY m.received_at DESC
            LIMIT $${values.length - 1} OFFSET $${values.length}`,
          values,
        );
    return {
      messages: result.rows,
      totalCount: Number(countResult.rows[0]?.count ?? 0),
    };
  });

  app.get('/api/search/quick-filters', async (req) => {
    const userId = getUserId(req);
    const labelRows = await query<{ key: string; name: string; count: number }>(
      `SELECT l.key, l.name, COUNT(ml.message_id)::int as count
         FROM labels l
         LEFT JOIN message_labels ml ON ml.label_id = l.id
         LEFT JOIN messages m ON m.id = ml.message_id
         LEFT JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
         WHERE l.user_id = $1
           AND l.is_archived = FALSE
           AND (ic.user_id = $1 OR m.id IS NULL)
         GROUP BY l.key, l.name
         ORDER BY COUNT(ml.message_id) DESC, l.name ASC`,
      [userId],
    );

    const starredRow = await query<{ count: number }>(
      `SELECT COUNT(*)::int as count
         FROM messages m
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE ic.user_id = $1 AND m.is_starred = TRUE`,
      [userId],
    );

    const attachmentRow = await query<{ count: number }>(
      `SELECT COUNT(DISTINCT m.id)::int as count
         FROM messages m
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
         INNER JOIN attachments a ON a.message_id = m.id
        WHERE ic.user_id = $1`,
      [userId],
    );

    const fromResult = await query<{ fromHeader: string }>(
      `SELECT m.from_header as "fromHeader", COUNT(*)::int as count
         FROM messages m
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE ic.user_id = $1
          AND m.from_header IS NOT NULL
          AND m.from_header <> ''
        GROUP BY m.from_header
        ORDER BY COUNT(*) DESC, m.from_header
        LIMIT 10`,
      [userId],
    );

    return {
      labels: labelRows.rows,
      starred: Number(starredRow.rows[0]?.count ?? 0),
      withAttachments: Number(attachmentRow.rows[0]?.count ?? 0),
      topFrom: fromResult.rows,
    };
  });

  app.get('/api/search/suggestions', async (req) => {
    const userId = getUserId(req);
    const queryText = required((req.query as any)?.q, 'q');
    const prefix = `%${String(queryText)}%`;
    const labelResult = await query<{ key: string; name: string }>(
      `SELECT key, name
         FROM labels
        WHERE user_id = $1
          AND is_archived = FALSE
          AND (key ILIKE $2 OR name ILIKE $2)
        LIMIT 10`,
      [userId, prefix],
    );
    const fromResult = await query<{ fromHeader: string }>(
      `SELECT from_header as "fromHeader", COUNT(*)::int as count
         FROM messages m
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE ic.user_id = $1
          AND from_header ILIKE $2
        GROUP BY from_header
        ORDER BY COUNT(*) DESC, from_header
        LIMIT 10`,
      [userId, prefix],
    );
    const subjectResult = await query<{ subject: string }>(
      `SELECT subject, COUNT(*)::int as count
         FROM messages m
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE ic.user_id = $1
          AND subject ILIKE $2
        GROUP BY subject
        ORDER BY COUNT(*) DESC, subject
        LIMIT 10`,
      [userId, prefix],
    );
    return {
      labels: labelResult.rows,
      from: fromResult.rows,
      subjects: subjectResult.rows,
    };
  });

  app.get('/api/saved-searches', async (req) => {
    const userId = getUserId(req);
    return listSavedSearches(userId);
  });

  app.post('/api/saved-searches', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.name || !body?.queryText) {
      return reply.code(400).send({ error: 'name and queryText required' });
    }
    return createSavedSearch(userId, {
      name: String(body.name),
      queryText: String(body.queryText),
      isStarred: body.isStarred === true,
      queryAst: body.queryAst,
    });
  });

  app.get('/api/saved-searches/:id', async (req, reply) => {
    const userId = getUserId(req);
    const id = String((req.params as any).id);
    const saved = await getSavedSearch(userId, id);
    if (!saved) {
      return reply.code(404).send({ error: 'saved search not found' });
    }
    return saved;
  });

  app.patch('/api/saved-searches/:id', async (req, reply) => {
    const userId = getUserId(req);
    const id = String((req.params as any).id);
    const body = req.body as any;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'request body required' });
    }
    await updateSavedSearch(userId, id, {
      name: body.name,
      queryText: body.queryText,
      queryAst: body.queryAst,
      isStarred: body.isStarred,
    });
    const updated = await getSavedSearch(userId, id);
    if (!updated) {
      return reply.code(404).send({ error: 'saved search not found' });
    }
    return updated;
  });

  app.delete('/api/saved-searches/:id', async (req, reply) => {
    const userId = getUserId(req);
    const id = String((req.params as any).id);
    await deleteSavedSearch(userId, id);
    return { status: 'deleted', id };
  });

  app.get('/api/messages/thread/:threadId', async (req) => {
    const userId = getUserId(req);
    const threadId = String((req.params as any).threadId);
    const connectorId = (req.query as any)?.connectorId ? String((req.query as any).connectorId) : undefined;
    return listThreadMessages(userId, threadId, connectorId);
  });

  app.get('/api/messages/:messageId', async (req, reply) => {
    const userId = getUserId(req);
    const messageId = String((req.params as any).messageId);
    const result = await query<any>(
      `SELECT m.*
         FROM messages m
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE m.id = $1 AND ic.user_id = $2`,
      [messageId, userId],
    );
    const message = result.rows[0];
    if (!message) {
      return reply.code(404).send({ error: 'message not found' });
    }

    const attachments = await query<any>(
      `WITH ranked AS (
         SELECT a.id,
                a.message_id,
                a.filename,
                a.content_type,
                a.size_bytes,
                a.blob_key,
                a.is_inline,
                a.scan_status,
                a.scan_result,
                a.created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY a.message_id, a.filename, COALESCE(a.content_type, ''), COALESCE(a.size_bytes, -1), a.is_inline
                  ORDER BY a.created_at DESC, a.id DESC
                ) AS dedupe_rank
           FROM attachments a
          WHERE a.message_id = $1
       )
       SELECT id,
              message_id as "messageId",
              filename,
              content_type as "contentType",
              size_bytes as "size",
              blob_key as "blobKey",
              is_inline as "isInline",
              scan_status as "scanStatus",
              scan_result as "scanResult",
              NULL::timestamptz as "scannedAt"
         FROM ranked
        WHERE dedupe_rank = 1
        ORDER BY created_at DESC`,
      [messageId],
    );
    return {
      ...message,
      attachments: attachments.rows,
    };
  });

  app.get('/api/messages/:messageId/raw', async (req, reply) => {
    const userId = getUserId(req);
    const messageId = String((req.params as any).messageId);
    const result = await query<any>(
      `SELECT m.raw_blob_key as "rawBlobKey"
         FROM messages m
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE m.id = $1 AND ic.user_id = $2`,
      [messageId, userId],
    );
    const row = result.rows[0];
    if (!row || !row.rawBlobKey) {
      return reply.code(404).send({ error: 'message not found' });
    }

    const data = await blobStore.getObject(row.rawBlobKey);
    if (!data) {
      return reply.code(404).send({ error: 'message source not found' });
    }

    const filename = sanitizeDispositionFilename(`${messageId}.eml`, 'message.eml');
    reply.header('Content-Type', 'message/rfc822');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(data);
  });

  // Bulk-update multiple messages in a single request.
  app.post('/api/messages/bulk', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    const rawIds = body?.messageIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return reply.code(400).send({ error: 'messageIds array required' });
    }

    const messageIds = rawIds.map(String).slice(0, 500); // safety cap
    const scope = body?.scope === 'thread' ? 'thread' : 'single';
    if (isArchiveMoveTarget(body?.moveToFolder)) {
      return reply.code(400).send({ error: 'archive is no longer supported' });
    }

    const results: { id: string; status: string }[] = [];
    const chunks: string[][] = [];
    for (let i = 0; i < messageIds.length; i += 20) {
      chunks.push(messageIds.slice(i, i + 20));
    }

    for (const chunk of chunks) {
      await Promise.all(chunk.map(async (messageId) => {
        try {
          const message = await getMessageAndConnectorForUser(userId, messageId);
          if (!message) {
            results.push({ id: messageId, status: 'not_found' });
            return;
          }

          if (scope === 'thread') {
            await applyThreadMessageActions(userId, message.id, {
              isRead: body?.isRead,
              isStarred: body?.isStarred,
              moveToFolder: body?.moveToFolder,
              delete: body?.delete,
            });
          } else {
            if (body?.isRead !== undefined) {
              await setMessageReadState(userId, message.id, message.incoming_connector_id, message.folder_path, message.uid === null || message.uid === undefined ? null : Number(message.uid), Boolean(body.isRead));
            }
            if (body?.isStarred !== undefined) {
              await setMessageStarredState(userId, message.id, message.incoming_connector_id, message.folder_path, message.uid === null || message.uid === undefined ? null : Number(message.uid), Boolean(body.isStarred));
            }
            if (body?.moveToFolder) {
              await moveMessageInMailbox(userId, message.id, message.incoming_connector_id, message.folder_path, String(body.moveToFolder), message.uid === null || message.uid === undefined ? null : Number(message.uid));
            }
            if (body?.delete === true) {
              await deleteMessageFromMailbox(userId, message.id, message.incoming_connector_id, message.folder_path, message.uid === null || message.uid === undefined ? null : Number(message.uid));
            }
          }
          results.push({ id: messageId, status: body?.delete === true ? 'deleted' : 'updated' });
        } catch {
          results.push({ id: messageId, status: 'error' });
        }
      }));
    }

    return { results };
  });

  app.patch('/api/messages/:messageId', async (req, reply) => {
    const userId = getUserId(req);
    const messageId = String((req.params as any).messageId);
    const body = req.body as any;
    const scope = body?.scope === 'thread' ? 'thread' : 'single';

    const message = await getMessageAndConnectorForUser(userId, messageId);
    if (!message) {
      return reply.code(404).send({ error: 'message not found' });
    }

    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'request body required' });
    }
    if (isArchiveMoveTarget(body?.moveToFolder)) {
      return reply.code(400).send({ error: 'archive is no longer supported' });
    }

    if (scope === 'thread') {
      await applyThreadMessageActions(userId, message.id, {
        isRead: body?.isRead,
        isStarred: body?.isStarred,
        moveToFolder: body?.moveToFolder,
        delete: body?.delete,
        addLabelKeys: Array.isArray(body?.addLabelKeys) ? body.addLabelKeys : undefined,
        removeLabelKeys: Array.isArray(body?.removeLabelKeys) ? body.removeLabelKeys : undefined,
      });
      return { status: 'thread_updated', id: messageId };
    }

    if (body?.isRead !== undefined) {
      await setMessageReadState(
        userId,
        message.id,
        message.incoming_connector_id,
        message.folder_path,
        message.uid === null || message.uid === undefined ? null : Number(message.uid),
        Boolean(body.isRead),
      );
    }

    if (body?.isStarred !== undefined) {
      await setMessageStarredState(
        userId,
        message.id,
        message.incoming_connector_id,
        message.folder_path,
        message.uid === null || message.uid === undefined ? null : Number(message.uid),
        Boolean(body.isStarred),
      );
    }

    if (Array.isArray(body?.addLabelKeys)) {
      await addLabelsToMessageByKey(userId, message.id, body.addLabelKeys);
    }
    if (Array.isArray(body?.removeLabelKeys)) {
      await removeLabelsFromMessageByKey(userId, message.id, body.removeLabelKeys);
    }

    if (body?.moveToFolder) {
      await moveMessageInMailbox(
        userId,
        message.id,
        message.incoming_connector_id,
        message.folder_path,
        String(body.moveToFolder),
        message.uid === null || message.uid === undefined ? null : Number(message.uid),
      );
    }

    if (body?.delete === true) {
      await deleteMessageFromMailbox(
        userId,
        message.id,
        message.incoming_connector_id,
        message.folder_path,
        message.uid === null || message.uid === undefined ? null : Number(message.uid),
      );
      return { status: 'deleted', id: messageId };
    }

    const after = await query<any>(
      `SELECT * FROM messages m
       INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
       WHERE m.id = $1 AND ic.user_id = $2`,
      [messageId, userId],
    );
    return after.rows[0];
  });

  app.get('/api/messages/:messageId/attachments', async (req) => {
    const userId = getUserId(req);
    const messageId = String((req.params as any).messageId);
    const result = await query<any>(
      `WITH ranked AS (
         SELECT a.id,
                a.message_id,
                a.filename,
                a.content_type,
                a.size_bytes,
                a.blob_key,
                a.is_inline,
                a.scan_status,
                a.scan_result,
                a.created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY a.message_id, a.filename, COALESCE(a.content_type, ''), COALESCE(a.size_bytes, -1), a.is_inline
                  ORDER BY a.created_at DESC, a.id DESC
                ) AS dedupe_rank
           FROM attachments a
           INNER JOIN messages m ON m.id = a.message_id
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
          WHERE m.id = $1 AND ic.user_id = $2
       )
       SELECT id,
              message_id as "messageId",
              filename,
              content_type as "contentType",
              size_bytes as "size",
              blob_key as "blobKey",
              is_inline as "isInline",
              scan_status as "scanStatus",
              scan_result as "scanResult",
              NULL::timestamptz as "scannedAt"
         FROM ranked
        WHERE dedupe_rank = 1
        ORDER BY created_at DESC`,
      [messageId, userId],
    );
    return result.rows;
  });

  app.get('/api/attachments/:attachmentId/download', async (req, reply) => {
    const userId = getUserId(req);
    const attachmentId = String((req.params as any).attachmentId);
    const attachmentResult = await query<any>(
      `SELECT a.filename,
              a.blob_key,
              a.content_type as "contentType",
              a.scan_status as "scanStatus"
         FROM attachments a
         INNER JOIN messages m ON m.id = a.message_id
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE a.id = $1 AND ic.user_id = $2`,
      [attachmentId, userId],
    );
    const attachment = attachmentResult.rows[0];
    if (!attachment) {
      return reply.code(404).send({ error: 'attachment not found' });
    }
    if (attachment.scanStatus === 'infected') {
      return reply.code(403).send({ error: 'attachment blocked: malware detected' });
    }

    const data = await blobStore.getObject(attachment.blob_key);
    if (!data) {
      return reply.code(404).send({ error: 'attachment blob not found' });
    }

    const filename = sanitizeDispositionFilename(attachment.filename, 'attachment');
    reply.header('Content-Type', attachment.contentType || 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(data);
  });

  app.get('/api/attachments/:attachmentId/view', async (req, reply) => {
    const userId = getUserId(req);
    const attachmentId = String((req.params as any).attachmentId);
    const attachmentResult = await query<any>(
      `SELECT a.filename,
              a.blob_key,
              a.content_type as "contentType",
              a.scan_status as "scanStatus"
         FROM attachments a
         INNER JOIN messages m ON m.id = a.message_id
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE a.id = $1 AND ic.user_id = $2`,
      [attachmentId, userId],
    );
    const attachment = attachmentResult.rows[0];
    if (!attachment) {
      return reply.code(404).send({ error: 'attachment not found' });
    }
    if (attachment.scanStatus === 'infected') {
      return reply.code(403).send({ error: 'attachment blocked: malware detected' });
    }

    const data = await blobStore.getObject(attachment.blob_key);
    if (!data) {
      return reply.code(404).send({ error: 'attachment blob not found' });
    }

    const filename = sanitizeDispositionFilename(attachment.filename, 'attachment');
    reply.header('Content-Type', attachment.contentType || 'application/octet-stream');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src data: blob: https:; media-src data: blob: https:; style-src 'unsafe-inline'");
    reply.header('Content-Disposition', `inline; filename="${filename}"`);
    return reply.send(data);
  });

  app.post('/api/messages/send', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body || typeof body !== 'object' || !body?.identityId || !body?.subject) {
      return reply.code(400).send({ error: 'identityId and subject required' });
    }
    const subject = String(body.subject);
    if (!subject.trim()) {
      return reply.code(400).send({ error: 'subject is required' });
    }
    if (subject.length > MAX_SEND_SUBJECT_CHARS) {
      return reply.code(400).send({ error: `subject exceeds ${MAX_SEND_SUBJECT_CHARS} characters` });
    }
    const headerIdempotency = req.headers['idempotency-key'] ?? req.headers['x-idempotency-key'];
    const idempotencyHeader = Array.isArray(headerIdempotency) ? headerIdempotency[0] : headerIdempotency;

    if (!body.idempotencyKey && !idempotencyHeader) {
      return reply.code(400).send({ error: 'idempotency key is required (body.idempotencyKey or Idempotency-Key header)' });
    }
    const identityId = String(body.identityId);
    const identity = await getIdentity(userId, identityId);
    if (!identity) {
      return reply.code(404).send({ error: 'identity not found' });
    }

    const idempotencyKey = normalizeSendIdempotencyKey(body.idempotencyKey ?? idempotencyHeader);
    const toList = parseAddressList(body.to);
    if (!toList || toList.length === 0) {
      return reply.code(400).send({ error: 'to must include at least one valid email address' });
    }
    const normalizedTo = toList.join(', ');
    const ccList = parseAddressList(body.cc);
    const bccList = parseAddressList(body.bcc);
    const totalRecipients = toList.length + (ccList?.length ?? 0) + (bccList?.length ?? 0);
    if (totalRecipients > MAX_SEND_RECIPIENTS) {
      return reply.code(400).send({ error: `recipient limit exceeded (max ${MAX_SEND_RECIPIENTS})` });
    }

    if (body.bodyText !== undefined && body.bodyText !== null && typeof body.bodyText !== 'string') {
      return reply.code(400).send({ error: 'bodyText must be a string' });
    }
    if (body.bodyHtml !== undefined && body.bodyHtml !== null && typeof body.bodyHtml !== 'string') {
      return reply.code(400).send({ error: 'bodyHtml must be a string' });
    }
    const bodyText = typeof body.bodyText === 'string' ? body.bodyText : undefined;
    const bodyHtml = typeof body.bodyHtml === 'string' ? body.bodyHtml : undefined;
    if (bodyText && bodyText.length > MAX_SEND_BODY_TEXT_CHARS) {
      return reply.code(400).send({ error: `bodyText exceeds ${MAX_SEND_BODY_TEXT_CHARS} characters` });
    }
    if (bodyHtml && bodyHtml.length > MAX_SEND_BODY_HTML_CHARS) {
      return reply.code(400).send({ error: `bodyHtml exceeds ${MAX_SEND_BODY_HTML_CHARS} characters` });
    }

    const inReplyTo = parseOptionalHeaderValue(body.inReplyTo);
    const references = parseOptionalHeaderValue(body.references);
    if (inReplyTo && (!HEADER_VALUE_PATTERN.test(inReplyTo) || inReplyTo.length > MAX_SEND_HEADER_CHARS)) {
      return reply.code(400).send({ error: 'inReplyTo header is invalid' });
    }
    if (references && (!HEADER_VALUE_PATTERN.test(references) || references.length > MAX_SEND_HEADER_CHARS)) {
      return reply.code(400).send({ error: 'references header is invalid' });
    }

    let threadId: string | undefined;
    if (body.threadId !== undefined && body.threadId !== null) {
      threadId = String(body.threadId).trim();
      if (!threadId) {
        return reply.code(400).send({ error: 'threadId must be non-empty when provided' });
      }
      if (!HEADER_VALUE_PATTERN.test(threadId) || threadId.length > 255) {
        return reply.code(400).send({ error: 'threadId is invalid' });
      }
    }

    if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
      return reply.code(400).send({ error: 'attachments must be an array' });
    }
    const attachmentsInput = Array.isArray(body.attachments) ? body.attachments : [];
    if (attachmentsInput.length > MAX_SEND_ATTACHMENTS) {
      return reply.code(400).send({ error: `attachment limit exceeded (max ${MAX_SEND_ATTACHMENTS})` });
    }
    let totalAttachmentBytes = 0;
    let attachments: Array<{
      filename: string;
      contentType: string;
      contentBase64: string;
      inline: boolean;
      contentId?: string;
    }>;
    try {
      attachments = attachmentsInput.map((attachment: any, index: number) => {
        if (!attachment || typeof attachment !== 'object') {
          throw new Error(`attachment[${index}] must be an object`);
        }
        const filename = String(attachment.filename ?? '').trim();
        const contentType = String(attachment.contentType ?? '').trim().toLowerCase();
        const contentBase64 = String(attachment.contentBase64 ?? '').trim();
        const inline = attachment.inline === true;
        const contentId = attachment.contentId === undefined || attachment.contentId === null
          ? undefined
          : String(attachment.contentId).trim();

        if (!filename || filename.length > 180 || !HEADER_VALUE_PATTERN.test(filename)) {
          throw new Error(`attachment[${index}] filename is invalid`);
        }
        if (!contentType || !MIME_TYPE_PATTERN.test(contentType)) {
          throw new Error(`attachment[${index}] contentType is invalid`);
        }
        if (!contentBase64) {
          throw new Error(`attachment[${index}] contentBase64 is required`);
        }
        const estimatedBytes = estimateBase64PayloadBytes(contentBase64);
        if (estimatedBytes === null) {
          throw new Error(`attachment[${index}] contentBase64 is invalid`);
        }
        if (estimatedBytes > MAX_SEND_ATTACHMENT_BYTES) {
          throw new Error(`attachment[${index}] exceeds ${MAX_SEND_ATTACHMENT_BYTES} bytes`);
        }
        totalAttachmentBytes += estimatedBytes;
        if (totalAttachmentBytes > MAX_SEND_TOTAL_ATTACHMENT_BYTES) {
          throw new Error(`total attachment payload exceeds ${MAX_SEND_TOTAL_ATTACHMENT_BYTES} bytes`);
        }
        if (contentId && (!HEADER_VALUE_PATTERN.test(contentId) || contentId.length > 255)) {
          throw new Error(`attachment[${index}] contentId is invalid`);
        }
        if (inline && !contentId) {
          throw new Error(`attachment[${index}] inline attachments require contentId`);
        }

        return {
          filename,
          contentType,
          contentBase64,
          inline,
          contentId,
        };
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'attachment validation failed' });
    }

    const requestHash = makeSendRequestHash({
      identityId,
      to: normalizedTo,
      cc: ccList,
      bcc: bccList,
      subject,
      bodyText,
      bodyHtml,
      threadId,
      inReplyTo,
      references,
      attachments,
    });

    const idempotency = await getOrCreateSendIdempotency({
      userId,
      identityId,
      idempotencyKey,
      requestHash,
      requestMeta: {
        to: normalizedTo,
        cc: ccList ?? [],
        bcc: bccList ?? [],
        subject,
        bodyText: bodyText ? bodyText.slice(0, 1000) : '',
      },
    });

    if (idempotency.status === 'succeeded') {
      return { status: 'succeeded', idempotencyKey, result: idempotency.result };
    }

    if (idempotency.status === 'processing') {
      return { status: 'in_flight', idempotencyKey };
    }
    if (idempotency.status === 'failed') {
      return {
        status: 'failed',
        idempotencyKey,
        error: idempotency.errorMessage ?? null,
      };
    }

    await enqueueSend({
      userId,
      identityId,
      idempotencyKey,
      to: normalizedTo,
      cc: ccList,
      bcc: bccList,
      subject,
      bodyText,
      bodyHtml,
      threadId,
      inReplyTo,
      references,
      attachments,
    });

    return { status: 'queued' };
  });

  app.post('/api/attachments/scan', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.messageId || !body?.attachmentId) {
      return reply.code(400).send({ error: 'messageId and attachmentId required' });
    }
    const attachmentId = String(body.attachmentId);
    const messageId = String(body.messageId);

    const attachmentBelongs = await query<{ id: string; size_bytes: number | null; scan_status: string }>(
      `SELECT a.id, a.size_bytes, a.scan_status
         FROM attachments a
         INNER JOIN messages m ON m.id = a.message_id
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE a.id = $1 AND m.id = $2 AND ic.user_id = $3`,
      [attachmentId, messageId, userId],
    );
    if (attachmentBelongs.rows.length === 0) {
      return reply.code(404).send({ error: 'attachment not found' });
    }

    const decision = getAttachmentScanDecision(Number(attachmentBelongs.rows[0].size_bytes ?? 0));
    const currentStatus = attachmentBelongs.rows[0].scan_status;

    if (decision.disposition !== 'queued') {
      if (currentStatus === decision.status) {
        return {
          status: decision.disposition === 'skip' ? decision.status : 'not_queued',
          scanStatus: currentStatus,
        };
      }
      await query(
        `UPDATE attachments
            SET scan_status = $2, scan_result = $3
          WHERE id = $1`,
        [body.attachmentId, decision.status, decision.verdictHint],
      );
      return {
        status: decision.disposition === 'skip' ? decision.status : 'not_queued',
        scanStatus: decision.status,
      };
    }

    if (currentStatus === 'clean' || currentStatus === 'infected') {
      return {
        status: 'not_queued',
        scanStatus: currentStatus,
      };
    }

    if (currentStatus !== 'pending') {
      await query(
        `UPDATE attachments
         SET scan_status = 'pending', scan_result = NULL
         WHERE id = $1`,
        [body.attachmentId],
      );
    }

    await enqueueAttachmentScan(messageId, attachmentId);
    return { status: 'queued', attachmentId };
  });

  app.post('/api/push/subscribe', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.endpoint || !body?.p256dh || !body?.auth) {
      return reply.code(400).send({ error: 'endpoint, p256dh, auth required' });
    }
    await assertSafePushEndpoint(String(body.endpoint));

    const subscription = await createPushSubscription({
      userId,
      endpoint: String(body.endpoint),
      p256dh: String(body.p256dh),
      auth: String(body.auth),
      userAgent: body.userAgent,
    });
    return subscription;
  });

  app.delete('/api/push/subscribe', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.endpoint) {
      return reply.code(400).send({ error: 'endpoint required' });
    }
    await removePushSubscription(userId, String(body.endpoint));
    return { status: 'deleted' };
  });
};
