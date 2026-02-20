import { FastifyInstance } from 'fastify';
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
import {
  enqueueSend,
  enqueueSyncWithOptions,
  enqueueAttachmentScan,
  purgeIncomingConnectorSyncJobs,
} from '../services/queue.js';
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
import * as routeHelpers from './helpers.js';

type ConnectorOwnershipCacheEntry = routeHelpers.ConnectorOwnershipCacheEntry;
type TimedCacheEntry<T> = routeHelpers.TimedCacheEntry<T>;
type QuickFiltersResponse = routeHelpers.QuickFiltersResponse;
type SearchSuggestionsResponse = routeHelpers.SearchSuggestionsResponse;
type IncomingOAuthConnectorDraft = routeHelpers.IncomingOAuthConnectorDraft;
type OutgoingOAuthConnectorDraft = routeHelpers.OutgoingOAuthConnectorDraft;

const {
  required,
  isGmailAuthConnector,
  isActiveConnectorStatus,
  isGmailLikeConnector,
  getMessageAndConnectorForUser,
  parseBooleanParam,
  parsePositiveIntWithCap,
  parseNonNegativeIntWithCap,
  parseTrimmedStringArrayWithCap,
  assertUuidList,
  ACTIVE_MAILBOX_CONNECTOR_CACHE_TTL_MS,
  ACTIVE_MAILBOX_CONNECTOR_CACHE_MAX,
  SEARCH_QUICK_FILTERS_CACHE_TTL_MS,
  SEARCH_QUICK_FILTERS_CACHE_MAX,
  SEARCH_SUGGESTIONS_CACHE_TTL_MS,
  SEARCH_SUGGESTIONS_CACHE_MAX,
  getActiveMailboxConnectorCache,
  setActiveMailboxConnectorCache,
  clearActiveMailboxConnectorCache,
  getIncomingConnectorGmailLikeCached,
  clearSearchCachesForUser,
  ensureIncomingConnectorStatesBulk,
  tryAcquireEventStreamSlot,
  releaseEventStreamSlot,
  mailboxReadPreferenceRankSql,
  logicalMessageKeySql,
  normalizeConnectorFolderFilterWithConnector,
  buildGmailFolderPredicatesWithConnector,
  parseAddressList,
  parseOptionalHeaderValue,
  MAIL_TLS_MODE_VALUES,
  BASE64_BODY_PATTERN,
  MIME_TYPE_PATTERN,
  HEADER_VALUE_PATTERN,
  MAX_SEND_RECIPIENTS,
  MAX_SEND_ATTACHMENTS,
  MAX_SEND_SUBJECT_CHARS,
  MAX_SEND_BODY_TEXT_CHARS,
  MAX_SEND_BODY_HTML_CHARS,
  MAX_SEND_ATTACHMENT_BYTES,
  MAX_SEND_TOTAL_ATTACHMENT_BYTES,
  MAX_SEND_HEADER_CHARS,
  MAX_IDENTITY_DISPLAY_NAME_CHARS,
  MAX_IDENTITY_SIGNATURE_CHARS,
  MAX_IDENTITY_REPLY_TO_CHARS,
  MAX_OAUTH_CODE_CHARS,
  MAX_OAUTH_STATE_CHARS,
  MAX_OAUTH_CLIENT_ID_CHARS,
  MAX_OAUTH_CLIENT_SECRET_CHARS,
  MAX_PUSH_ENDPOINT_CHARS,
  MAX_PUSH_KEY_CHARS,
  MAX_PUSH_USER_AGENT_CHARS,
  MAX_MAILBOX_PATH_CHARS,
  MAX_WATCH_MAILBOXES,
  MAX_MESSAGES_PAGE_LIMIT,
  MAX_MESSAGES_OFFSET,
  MAX_MESSAGES_SEARCH_QUERY_CHARS,
  MAX_SEND_ONLY_SEARCH_CHARS,
  MAX_SEARCH_SUGGESTION_QUERY_CHARS,
  MAX_SAVED_SEARCH_NAME_CHARS,
  MAX_SAVED_SEARCH_QUERY_CHARS,
  MAX_LABEL_MUTATION_ITEMS,
  MAX_EVENTS_LIMIT,
  MAX_SYNC_EVENT_ID,
  MAX_ACTIVE_EVENT_STREAMS_PER_USER,
  EVENT_STREAM_ERROR_BACKOFF_MS,
  MAX_WATCH_MAILBOX_SANITIZE_SCAN_ITEMS,
  EMAIL_ADDRESS_PATTERN,
  UUID_PATTERN,
  MAILBOX_CONTROL_CHAR_PATTERN,
  SAFE_ATTACHMENT_SCAN_STATUSES,
  insecureMailTransportAllowed,
  parseOptionalPort,
  normalizeTlsMode,
  estimateBase64PayloadBytes,
  normalizeIdentityDisplayName,
  normalizeSingleEmailAddress,
  normalizeOptionalReplyTo,
  normalizeOptionalSignature,
  normalizeMailboxInput,
  normalizePersistedWatchMailboxes,
  getAttachmentScanBlock,
  getQuickFiltersCache,
  setQuickFiltersCache,
  getSearchSuggestionsCache,
  setSearchSuggestionsCache,
  isPlainObject,
  buildIncomingOAuthConnectorDraft,
  buildOutgoingOAuthConnectorDraft,
  toPublicAuthConfig,
  sanitizeConnectorForResponse,
  isArchiveMoveTarget,
  sanitizeDispositionFilename,
  GOOGLE_IDENTITY_ISSUERS,
  getGmailPushAudience,
  extractBearerToken,
  verifyPubSubPushToken,
  decodePubSubPushBody,
  buildGmailWatchLabelIds,
  GMAIL_DEFAULT_SYNC_TARGETS,
  buildInitialSyncTargets,
} = routeHelpers;

export const registerRoutes = async (app: FastifyInstance) => {
  const getUserId = (request: any) => {
    if (!request.user?.id) {
      const error = new Error('missing user context') as Error & { statusCode?: number };
      error.statusCode = 401;
      throw error;
    }
    return request.user.id;
  };

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.get('/api/session', async (req, reply) => {
    const user = (req as any).user;
    if (!user?.id) {
      return reply.code(401).send({ error: 'missing user context' });
    }
    return {
      id: String(user.id),
      email: String(user.email ?? ''),
      name: String(user.name ?? ''),
    };
  });

  app.post('/api/admin/users', async (req, reply) => {
    if (!env.allowAdminUserBootstrap) {
      return reply.code(404).send({ error: 'not found' });
    }
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
    let normalizedEmailAddress: string;
    try {
      normalizedEmailAddress = normalizeSingleEmailAddress(body.emailAddress, 'emailAddress');
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid emailAddress' });
    }
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
      ? normalizeGmailMailboxPath(normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX'))
      : normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX');
    let watchMailboxes: string[];
    try {
      watchMailboxes = parseTrimmedStringArrayWithCap(
        requestedSyncSettings?.watchMailboxes,
        'syncSettings.watchMailboxes',
        MAX_WATCH_MAILBOXES,
      );
      if (watchMailboxes.length === 0) {
        watchMailboxes = [defaultWatchMailbox];
      } else {
        watchMailboxes = watchMailboxes.map((mailbox) => normalizeMailboxInput(mailbox, 'syncSettings.watchMailboxes[]'));
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid syncSettings.watchMailboxes' });
    }
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
        [userId, provider, normalizedEmailAddress, normalizedAuthType, expectedGmailMode],
      );

      if (existing.rows.length > 0) {
        return { id: existing.rows[0].id };
      }
    }

    const result = await createIncomingConnector(userId, {
      name: String(body.name),
      provider,
      emailAddress: normalizedEmailAddress,
      host: body.host,
      port: parsedPort,
      tls: body.tls ?? true,
      authType: normalizedAuthType,
      authConfig: body.authConfig ?? {},
      syncSettings,
    });
    setActiveMailboxConnectorCache(
      userId,
      result.id,
      isGmailLikeConnector({ provider, sync_settings: syncSettings, syncSettings }),
    );

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
    let normalizedFromAddress: string;
    try {
      normalizedFromAddress = normalizeSingleEmailAddress(body.fromAddress, 'fromAddress');
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid fromAddress' });
    }
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
        [userId, normalizedProvider, normalizedFromAddress, authType],
      );

      if (existing.rows.length > 0) {
        return { id: existing.rows[0].id };
      }
    }

    if (authType !== 'oauth2') {
      try {
        await verifyOutgoingConnectorCredentials({
          provider: normalizedProvider,
          fromAddress: normalizedFromAddress,
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
      fromAddress: normalizedFromAddress,
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
    let normalizedEmailAddress: string | undefined;
    let normalizedWatchMailboxes: string[] | undefined;
    try {
      if (body.emailAddress !== undefined) {
        normalizedEmailAddress = normalizeSingleEmailAddress(body.emailAddress, 'emailAddress');
      }
      if (
        body.syncSettings !== undefined
        && body.syncSettings !== null
        && Object.prototype.hasOwnProperty.call(body.syncSettings, 'watchMailboxes')
      ) {
        const parsedWatchMailboxes = parseTrimmedStringArrayWithCap(
          body.syncSettings.watchMailboxes,
          'syncSettings.watchMailboxes',
          MAX_WATCH_MAILBOXES,
        );
        normalizedWatchMailboxes = parsedWatchMailboxes.map((mailbox) => normalizeMailboxInput(mailbox, 'syncSettings.watchMailboxes[]'));
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid incoming connector payload' });
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
    const provider = String(existing.provider ?? '').trim().toLowerCase();
    const mergedSyncSettingsBase = {
      ...(body.syncSettings ?? existing.sync_settings ?? existing.syncSettings ?? {}),
      ...(normalizedImapTlsMode ? { imapTlsMode: normalizedImapTlsMode } : {}),
    };
    const canonicalWatchMailboxes = normalizedWatchMailboxes
      ? Array.from(new Set(
          normalizedWatchMailboxes.map((mailbox) => isGmailLikeConnector({
            provider,
            sync_settings: mergedSyncSettingsBase,
            syncSettings: mergedSyncSettingsBase,
          })
            ? normalizeGmailMailboxPath(mailbox)
            : mailbox),
        ))
      : undefined;
    const mergedSyncSettings = {
      ...mergedSyncSettingsBase,
      ...(canonicalWatchMailboxes ? { watchMailboxes: canonicalWatchMailboxes } : {}),
    };
    const mergedAuthConfig = body.authConfig ?? existing.auth_config ?? existing.authConfig ?? {};
    const mergedAuthType = String(mergedAuthConfig?.authType ?? 'password').toLowerCase();
    const supportsOauthIncoming = isGmailAuthConnector({
      provider,
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
      emailAddress: normalizedEmailAddress ?? body.emailAddress,
      host: body.host,
      port: parsedPort,
      tls: body.tls,
      authConfig: body.authConfig,
      syncSettings: body.syncSettings === undefined
        ? undefined
        : {
            ...(body.syncSettings ?? {}),
            ...(normalizedImapTlsMode ? { imapTlsMode: normalizedImapTlsMode } : {}),
            ...(canonicalWatchMailboxes ? { watchMailboxes: canonicalWatchMailboxes } : {}),
          },
      status: body.status,
    });
    const updated = await getIncomingConnector(userId, connectorId);
    if (!updated) {
      clearActiveMailboxConnectorCache(userId, connectorId);
      return reply.code(404).send({ error: 'connector not found' });
    }
    setActiveMailboxConnectorCache(userId, connectorId, isGmailLikeConnector(updated));
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
    let normalizedFromAddress: string | undefined;
    try {
      if (body.fromAddress !== undefined) {
        normalizedFromAddress = normalizeSingleEmailAddress(body.fromAddress, 'fromAddress');
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid fromAddress' });
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
          fromAddress: normalizedFromAddress ?? String(existing.fromAddress ?? existing.from_address ?? ''),
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
      fromAddress: normalizedFromAddress ?? body.fromAddress,
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
      await updateIncomingConnector(userId, connectorId, { status: 'deleting' });
      const connectorIsGmailLike = isGmailLikeConnector(connector);
      const fallbackMailbox = connectorIsGmailLike
        ? normalizeGmailMailboxPath(normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX'))
        : normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX');
      const watchMailboxes = normalizePersistedWatchMailboxes(
        connector.sync_settings?.watchMailboxes,
        {
          isGmailLike: connectorIsGmailLike,
          fallbackMailbox,
        },
      );
      const syncStateMailboxes = await query<{ mailbox: string }>(
        `SELECT mailbox
           FROM sync_states
          WHERE incoming_connector_id = $1`,
        [connectorId],
      ).then((result) => result.rows.map((row) => String(row.mailbox || '').trim()).filter(Boolean))
        .catch(() => []);
      const cancellationTargets = Array.from(new Set([...watchMailboxes, ...syncStateMailboxes]));
      await Promise.allSettled(
        cancellationTargets.map((mailbox: string) =>
          requestSyncCancellation(userId, connectorId, mailbox),
        ),
      );
      await Promise.allSettled(
        watchMailboxes.map((mailbox: string) =>
          stopIncomingConnectorIdleWatch(userId, connectorId, mailbox),
        ),
      );
      await purgeIncomingConnectorSyncJobs(connectorId).catch(() => ({ removed: 0 }));
    }
    await deleteIncomingConnector(userId, connectorId);
    clearActiveMailboxConnectorCache(userId, connectorId);
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

    let displayName: string;
    let emailAddress: string;
    let signature: string | null;
    let replyTo: string | null;
    try {
      displayName = normalizeIdentityDisplayName(body.displayName);
      emailAddress = normalizeSingleEmailAddress(body.emailAddress, 'emailAddress');
      signature = normalizeOptionalSignature(body.signature);
      replyTo = normalizeOptionalReplyTo(body.replyTo);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid identity payload' });
    }

    const created = await createIdentity(
      userId,
      displayName,
      emailAddress,
      String(body.outgoingConnectorId),
      signature,
      body.sentToIncomingConnectorId ?? null,
      replyTo,
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

    let displayName: string | undefined;
    let emailAddress: string | undefined;
    let signature: string | null | undefined;
    let replyTo: string | null | undefined;
    try {
      if (body.displayName !== undefined) {
        displayName = normalizeIdentityDisplayName(body.displayName);
      }
      if (body.emailAddress !== undefined) {
        emailAddress = normalizeSingleEmailAddress(body.emailAddress, 'emailAddress');
      }
      if (body.signature !== undefined) {
        signature = normalizeOptionalSignature(body.signature);
      }
      if (body.replyTo !== undefined) {
        replyTo = normalizeOptionalReplyTo(body.replyTo);
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid identity payload' });
    }

    await updateIdentity(userId, identityId, {
      displayName,
      emailAddress,
      signature,
      outgoingConnectorId: body.outgoingConnectorId ?? undefined,
      sentToIncomingConnectorId: body.sentToIncomingConnectorId ?? undefined,
      replyTo,
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
    const created = await createUserLabel({
      userId,
      name: String(body.name),
      key: body.key,
    });
    clearSearchCachesForUser(userId);
    return created;
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
    clearSearchCachesForUser(userId);
    return updated;
  });

  app.delete('/api/labels/:labelId', async (req, reply) => {
    const userId = getUserId(req);
    const labelId = String((req.params as any).labelId);
    await archiveLabel(userId, labelId);
    clearSearchCachesForUser(userId);
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

    let addLabelIds: string[];
    let removeLabelIds: string[];
    let addLabelKeys: string[];
    let removeLabelKeys: string[];
    try {
      addLabelIds = parseTrimmedStringArrayWithCap(body.addLabelIds, 'addLabelIds', MAX_LABEL_MUTATION_ITEMS);
      removeLabelIds = parseTrimmedStringArrayWithCap(body.removeLabelIds, 'removeLabelIds', MAX_LABEL_MUTATION_ITEMS);
      addLabelKeys = parseTrimmedStringArrayWithCap(body.addLabelKeys, 'addLabelKeys', MAX_LABEL_MUTATION_ITEMS);
      removeLabelKeys = parseTrimmedStringArrayWithCap(body.removeLabelKeys, 'removeLabelKeys', MAX_LABEL_MUTATION_ITEMS);
      assertUuidList(addLabelIds, 'addLabelIds');
      assertUuidList(removeLabelIds, 'removeLabelIds');
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid label mutation payload' });
    }

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
    clearSearchCachesForUser(userId);
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
    clearSearchCachesForUser(userId);
    return { status: 'deleted', messageId, labelId };
  });

  app.post('/api/oauth/google/authorize', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    const type = body?.type;
    const connectorId = body?.connectorId;
    const connectorDraft = body?.connector;
    const clientId = body?.oauthClientId;
    const clientSecret = body?.oauthClientSecret;

    if (!type) {
      return reply.code(400).send({ error: 'type (incoming|outgoing) required' });
    }
    if (type !== 'incoming' && type !== 'outgoing') {
      return reply.code(400).send({ error: 'type must be incoming or outgoing' });
    }
    const normalizedClientId = clientId === undefined || clientId === null
      ? undefined
      : String(clientId).trim();
    const normalizedClientSecret = clientSecret === undefined || clientSecret === null
      ? undefined
      : String(clientSecret).trim();
    if (normalizedClientId && normalizedClientId.length > MAX_OAUTH_CLIENT_ID_CHARS) {
      return reply.code(400).send({ error: `oauthClientId exceeds ${MAX_OAUTH_CLIENT_ID_CHARS} characters` });
    }
    if (normalizedClientSecret && normalizedClientSecret.length > MAX_OAUTH_CLIENT_SECRET_CHARS) {
      return reply.code(400).send({ error: `oauthClientSecret exceeds ${MAX_OAUTH_CLIENT_SECRET_CHARS} characters` });
    }

    if (!connectorId && !connectorDraft) {
      return reply.code(400).send({ error: 'connectorId or connector draft is required' });
    }

    if (!connectorId && connectorDraft) {
      try {
        if (type === 'incoming') {
          const built = await buildIncomingOAuthConnectorDraft(
            userId,
            connectorDraft,
            normalizedClientId,
            normalizedClientSecret,
          );
          if (built.existingConnectorId) {
            const url = await getGoogleAuthorizeUrl(
              type,
              built.existingConnectorId,
              normalizedClientId,
              normalizedClientSecret,
              userId,
            );
            return { authorizeUrl: url };
          }
          const url = await getGoogleAuthorizeUrl(
            type,
            undefined,
            normalizedClientId,
            normalizedClientSecret,
            userId,
            built.draft,
          );
          return { authorizeUrl: url };
        }

        const built = await buildOutgoingOAuthConnectorDraft(
          userId,
          connectorDraft,
          normalizedClientId,
          normalizedClientSecret,
        );
        if (built.existingConnectorId) {
          const url = await getGoogleAuthorizeUrl(
            type,
            built.existingConnectorId,
            normalizedClientId,
            normalizedClientSecret,
            userId,
          );
          return { authorizeUrl: url };
        }
        const url = await getGoogleAuthorizeUrl(
          type,
          undefined,
          normalizedClientId,
          normalizedClientSecret,
          userId,
          built.draft,
        );
        return { authorizeUrl: url };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid connector draft' });
      }
    }

    const connectorType = type;
    const connector = connectorType === 'incoming'
      ? await getIncomingConnector(userId, connectorId)
      : await getOutgoingConnector(userId, connectorId);

    if (!connector) {
      return reply.code(404).send({ error: `${connectorType} connector not found` });
    }

    if (!isGmailAuthConnector(connector)) {
      return reply.code(400).send({ error: 'OAuth flow is only valid for Gmail connectors' });
    }

    if (normalizedClientId || normalizedClientSecret) {
      const existingAuth = connector.authConfig ?? {};
      const nextAuth = {
        ...existingAuth,
        ...(normalizedClientId ? { oauthClientId: normalizedClientId } : {}),
        ...(normalizedClientSecret ? { oauthClientSecret: normalizedClientSecret } : {}),
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
      connector.authConfig?.oauthClientId ?? normalizedClientId,
      connector.authConfig?.oauthClientSecret ?? normalizedClientSecret,
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
    const normalizedCode = String(code).trim();
    const normalizedState = String(state).trim();
    if (
      !normalizedCode
      || !normalizedState
      || normalizedCode.length > MAX_OAUTH_CODE_CHARS
      || normalizedState.length > MAX_OAUTH_STATE_CHARS
      || !HEADER_VALUE_PATTERN.test(normalizedCode)
      || !HEADER_VALUE_PATTERN.test(normalizedState)
    ) {
      return redirectToFrontend('error', { error: 'invalid code or state' });
    }

    const payload = await consumeOAuthState(normalizedState);
    if (!payload) {
      return redirectToFrontend('error', { error: 'invalid or expired oauth state' });
    }

    const targetUserId = payload.userId;
    if (!targetUserId) {
      return redirectToFrontend('error', { error: 'oauth state missing user context' });
    }

    const { type } = payload;
    let connectorId = payload.connectorId;
    if (type !== 'incoming' && type !== 'outgoing') {
      return redirectToFrontend('error', { error: 'invalid oauth state payload' });
    }
    const connectorDraft = payload.connectorPayload;
    let connectorRow: any = null;

    if (connectorId) {
      const row = type === 'incoming'
        ? await query<any>(
          `SELECT auth_config, user_id, provider, sync_settings, email_address, name
             FROM incoming_connectors
            WHERE id = $1 AND user_id = $2`,
          [connectorId, targetUserId],
        )
        : await query<any>(
          `SELECT auth_config, user_id, provider, NULL::jsonb AS sync_settings
             FROM outgoing_connectors
            WHERE id = $1 AND user_id = $2`,
          [connectorId, targetUserId],
        );
      if (row.rows.length === 0) {
        return redirectToFrontend('error', { error: `${type} connector not found` });
      }
      connectorRow = row.rows[0];
    } else {
      if (!isPlainObject(connectorDraft)) {
        return redirectToFrontend('error', { error: 'oauth state missing connector draft' });
      }
      connectorRow = {
        auth_config: isPlainObject(connectorDraft.authConfig) ? connectorDraft.authConfig : {},
        provider: connectorDraft.provider,
        sync_settings: isPlainObject(connectorDraft.syncSettings) ? connectorDraft.syncSettings : {},
        email_address: connectorDraft.emailAddress,
        name: connectorDraft.name,
      };
    }

    const existingAuth = connectorRow?.auth_config || {};
    const tokens = await exchangeCodeForTokens(normalizedCode, existingAuth.oauthClientId, existingAuth.oauthClientSecret);
    const nextAuth = {
      ...(existingAuth || {}),
      authType: 'oauth2',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? existingAuth.refreshToken,
      tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : existingAuth.tokenExpiresAt,
      scope: tokens.scope,
    };

    if (!connectorId) {
      if (!isPlainObject(connectorDraft)) {
        return redirectToFrontend('error', { error: 'oauth state missing connector draft' });
      }
      if (type === 'incoming') {
        const created = await createIncomingConnector(targetUserId, {
          name: String(connectorDraft.name ?? ''),
          provider: String(connectorDraft.provider ?? '').trim().toLowerCase(),
          emailAddress: normalizeSingleEmailAddress(connectorDraft.emailAddress, 'emailAddress'),
          host: connectorDraft.host !== undefined ? String(connectorDraft.host) : undefined,
          port: parseOptionalPort(connectorDraft.port, 'incoming connector port'),
          tls: connectorDraft.tls ?? true,
          authType: 'oauth2',
          authConfig: nextAuth,
          syncSettings: isPlainObject(connectorDraft.syncSettings) ? connectorDraft.syncSettings : {},
        });
        connectorId = created.id;
        connectorRow = {
          ...connectorRow,
          auth_config: nextAuth,
          sync_settings: isPlainObject(connectorDraft.syncSettings) ? connectorDraft.syncSettings : {},
        };
      } else {
        const created = await createOutgoingConnector(targetUserId, {
          name: String(connectorDraft.name ?? ''),
          provider: 'gmail',
          fromAddress: normalizeSingleEmailAddress(connectorDraft.fromAddress, 'fromAddress'),
          host: connectorDraft.host !== undefined ? String(connectorDraft.host) : undefined,
          port: parseOptionalPort(connectorDraft.port, 'outgoing connector port'),
          tlsMode: normalizeTlsMode(connectorDraft.tlsMode, 'tlsMode') ?? 'starttls',
          authType: 'oauth2',
          authConfig: nextAuth,
          fromEnvelopeDefaults: isPlainObject(connectorDraft.fromEnvelopeDefaults) ? connectorDraft.fromEnvelopeDefaults : {},
          sentCopyBehavior: isPlainObject(connectorDraft.sentCopyBehavior) ? connectorDraft.sentCopyBehavior : {},
        });
        connectorId = created.id;
        connectorRow = {
          ...connectorRow,
          auth_config: nextAuth,
        };
      }
    }

    if (!connectorId) {
      return redirectToFrontend('error', { error: 'failed to resolve connector for oauth callback' });
    }

    if (type === 'incoming') {
      await updateIncomingConnectorAuth(connectorId, nextAuth, targetUserId);
      try {
        const provider = connectorRow?.provider;
        let connectorSyncSettings = connectorRow?.sync_settings ?? {};
        const connectorIsGmailLike = isGmailLikeConnector({ provider, sync_settings: connectorSyncSettings, syncSettings: connectorSyncSettings });
        const fallbackMailbox = connectorIsGmailLike
          ? normalizeGmailMailboxPath(normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX'))
          : normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX');
        connectorSyncSettings = {
          ...connectorSyncSettings,
          watchMailboxes: normalizePersistedWatchMailboxes(
            connectorSyncSettings?.watchMailboxes,
            {
              isGmailLike: connectorIsGmailLike,
              fallbackMailbox,
            },
          ),
        };
        await updateIncomingConnector(targetUserId, connectorId, {
          syncSettings: connectorSyncSettings,
        });

        const shouldCreateOutgoingGmail = connectorSyncSettings?.createOutgoingGmail === true;
        if (shouldCreateOutgoingGmail) {
          const incomingEmailAddress = (() => {
            try {
              return normalizeSingleEmailAddress(connectorRow?.email_address, 'emailAddress');
            } catch {
              return String(connectorRow?.email_address ?? '').trim().toLowerCase();
            }
          })();
          if (incomingEmailAddress) {
            const existingOutgoing = await query<{ id: string }>(
              `SELECT id
                 FROM outgoing_connectors
                WHERE user_id = $1
                  AND provider = 'gmail'
                  AND LOWER(from_address) = LOWER($2)
                ORDER BY created_at DESC
                LIMIT 1`,
              [targetUserId, incomingEmailAddress],
            );
            const outgoingConnectorId = existingOutgoing.rows[0]?.id
              ?? (await createOutgoingConnector(targetUserId, {
                name: `${String(connectorRow?.name ?? '').trim() || incomingEmailAddress} (Outgoing)`,
                provider: 'gmail',
                fromAddress: incomingEmailAddress,
                authType: 'oauth2',
                authConfig: nextAuth,
              })).id;
            await updateOutgoingConnectorAuth(outgoingConnectorId, nextAuth, targetUserId);
          }
        }

        const connectorPushEnabled = connectorSyncSettings?.gmailPush?.enabled !== false;
        if (provider === 'gmail' && env.gmailPush.enabled && env.gmailPush.topicName && connectorPushEnabled) {
          try {
            const watchLabelIds = buildGmailWatchLabelIds(connectorSyncSettings.watchMailboxes ?? [fallbackMailbox]);
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
        const targets = buildInitialSyncTargets(
          { provider, sync_settings: connectorSyncSettings, syncSettings: connectorSyncSettings },
          queueTargets,
          fallbackMailbox,
        );
        await ensureIncomingConnectorStatesBulk(connectorId, targets);
        await Promise.all(
          targets.map(async (mailbox) => {
            const enqueued = await enqueueSyncWithOptions(targetUserId, connectorId, mailbox, {
              priority: resolveSyncQueuePriority(targetUserId, connectorId, mailbox),
            });
            if (!enqueued) {
              try {
                await setSyncState(connectorId, mailbox, {
                  status: 'syncing',
                  syncStartedAt: new Date(),
                  syncCompletedAt: null,
                  syncError: null,
                  syncProgress: { inserted: 0, updated: 0, reconciledRemoved: 0, metadataRefreshed: 0 },
                });
              } catch {
                // Ignore sync-state persistence failures so fallback sync still starts.
              }
              void syncIncomingConnector(targetUserId, connectorId, mailbox).catch((error) => {
                app.log.warn({ error, connectorId, mailbox }, 'oauth callback fallback sync failed');
              });
              return;
            }
            try {
              await setSyncState(connectorId, mailbox, {
                status: 'queued',
                syncCompletedAt: null,
                syncError: null,
                syncProgress: { inserted: 0, updated: 0, reconciledRemoved: 0, metadataRefreshed: 0 },
              });
            } catch {
              // Keep queueing responsive even when sync-state persistence is unavailable.
            }
          }),
        );
      } catch {
        // no-op: callback should still succeed even if background queue is temporarily unavailable
      }
    } else {
      await updateOutgoingConnectorAuth(connectorId, nextAuth, targetUserId);
    }

    return redirectToFrontend('ok', {
      connectorType: type,
      type,
      connectorId,
      id: connectorId,
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
    if (!isActiveConnectorStatus(connector.status)) {
      return reply.code(409).send({ error: 'connector is not active' });
    }
    let mailboxInput: string;
    try {
      mailboxInput = normalizeMailboxInput(body.mailbox ?? 'INBOX');
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid mailbox' });
    }
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
      const fallbackMailbox = isGmailLikeConnector(connector)
        ? normalizeGmailMailboxPath(normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX'))
        : normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX');
      const targets = buildInitialSyncTargets(connector, queueTargets, fallbackMailbox);
      await ensureIncomingConnectorStatesBulk(connectorId, targets);

      const queuedResults = await Promise.all(
        targets.map(async (targetMailbox) => {
          const enqueued = await enqueueSyncWithOptions(userId, connectorId, targetMailbox, {
            priority: resolvePriorityForMailbox(targetMailbox),
          });
          if (enqueued) {
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
          return enqueued;
        }),
      );
      const queued = queuedResults.filter(Boolean).length;
      if (queued === 0) {
        for (const targetMailbox of targets) {
          void syncIncomingConnector(userId, connectorId, targetMailbox).catch((error) => {
            req.log.warn({ error, connectorId, mailbox: targetMailbox }, 'fallback full-sync start failed');
          });
        }
        return { status: 'started', queued: 0, total: targets.length, mailboxes: targets };
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
    if (!connectorId) {
      return reply.code(400).send({ error: 'connectorId and mailbox are required' });
    }
    let mailboxInput: string;
    try {
      mailboxInput = normalizeMailboxInput(body.mailbox);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid mailbox' });
    }

    let cached = getActiveMailboxConnectorCache(userId, connectorId);
    if (!cached) {
      const connector = await getIncomingConnector(userId, connectorId);
      if (!connector) {
        return reply.code(404).send({ error: 'connector not found' });
      }
      cached = {
        expiresAtMs: Date.now() + ACTIVE_MAILBOX_CONNECTOR_CACHE_TTL_MS,
        isGmailLike: isGmailLikeConnector(connector),
      };
      setActiveMailboxConnectorCache(userId, connectorId, cached.isGmailLike);
    }

    const mailbox = cached.isGmailLike
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
    let mailboxInput: string;
    try {
      mailboxInput = normalizeMailboxInput(body.mailbox ?? env.sync.defaultMailbox);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid mailbox' });
    }
    const mailbox = isGmailLikeConnector(connector)
      ? normalizeGmailMailboxPath(mailboxInput)
      : mailboxInput;
    return requestSyncCancellation(userId, connectorId, mailbox);
  });

  app.get('/api/connectors/:connectorId/sync-state', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    const queryParams = req.query as any;
    let mailboxInput: string;
    try {
      mailboxInput = normalizeMailboxInput(queryParams?.mailbox ?? env.sync.defaultMailbox);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid mailbox' });
    }

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
    const connectorIsGmailLike = isGmailLikeConnector(connector);
    const fallbackMailbox = connectorIsGmailLike
      ? normalizeGmailMailboxPath(normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX'))
      : normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX');
    const seedMailboxes = normalizePersistedWatchMailboxes(
      connector.sync_settings?.watchMailboxes,
      {
        isGmailLike: connectorIsGmailLike,
        fallbackMailbox,
      },
    );

    const ignoredContainerMailboxes = new Set<string>(['[GMAIL]', '[GOOGLE MAIL]']);
    const uniqueMailboxes = seedMailboxes
      .filter((mailbox: string) => !ignoredContainerMailboxes.has(mailbox.toUpperCase()));

    await ensureIncomingConnectorStatesBulk(connectorId, uniqueMailboxes);

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
    let mailboxInput: string;
    try {
      mailboxInput = normalizeMailboxInput(body?.mailbox ?? env.sync.defaultMailbox);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid mailbox' });
    }
    const connector = await getIncomingConnector(userId, connectorId);
    if (!connector) {
      return reply.code(404).send({ error: 'connector not found' });
    }
    if (!isActiveConnectorStatus(connector.status)) {
      return reply.code(409).send({ error: 'connector is not active' });
    }
    const connectorIsGmailLike = isGmailLikeConnector(connector);
    const mailbox = connectorIsGmailLike
      ? normalizeGmailMailboxPath(mailboxInput)
      : mailboxInput;
    const fallbackMailbox = connectorIsGmailLike
      ? normalizeGmailMailboxPath(normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX'))
      : normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX');
    const existingMailboxes = normalizePersistedWatchMailboxes(
      connector.sync_settings?.watchMailboxes,
      {
        isGmailLike: connectorIsGmailLike,
        fallbackMailbox,
        includeFallbackWhenEmpty: false,
      },
    );
    const mailboxAlreadyWatched = existingMailboxes.includes(mailbox);
    if (!mailboxAlreadyWatched && existingMailboxes.length >= MAX_WATCH_MAILBOXES) {
      return reply.code(400).send({ error: `watch mailbox limit exceeded (max ${MAX_WATCH_MAILBOXES})` });
    }
    const nextMailboxes = mailboxAlreadyWatched
      ? existingMailboxes
      : [...existingMailboxes, mailbox];
    await updateIncomingConnector(userId, connectorId, {
      syncSettings: {
        ...(connector.sync_settings ?? {}),
        watchMailboxes: nextMailboxes,
      },
    });
    await startIncomingConnectorIdleWatch(userId, connectorId, mailbox);
    return { status: 'watching', connectorId, mailbox };
  });

  app.post('/api/sync/:connectorId/watch/stop', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    const body = req.body as any;
    let mailboxInput: string;
    try {
      mailboxInput = normalizeMailboxInput(body?.mailbox ?? env.sync.defaultMailbox);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid mailbox' });
    }
    const connector = await getIncomingConnector(userId, connectorId);
    if (!connector) {
      return reply.code(404).send({ error: 'connector not found' });
    }
    const connectorIsGmailLike = isGmailLikeConnector(connector);
    const mailbox = connectorIsGmailLike
      ? normalizeGmailMailboxPath(mailboxInput)
      : mailboxInput;
    const fallbackMailbox = connectorIsGmailLike
      ? normalizeGmailMailboxPath(normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX'))
      : normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX');
    const existingMailboxes = normalizePersistedWatchMailboxes(
      connector.sync_settings?.watchMailboxes,
      {
        isGmailLike: connectorIsGmailLike,
        fallbackMailbox,
        includeFallbackWhenEmpty: false,
      },
    );
    await stopIncomingConnectorIdleWatch(userId, connectorId, mailbox);
    const nextMailboxes = existingMailboxes.filter((value: string) => value !== mailbox);
    await updateIncomingConnector(userId, connectorId, {
      syncSettings: {
        ...(connector.sync_settings ?? {}),
        watchMailboxes: nextMailboxes,
      },
    });
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
    if (!isActiveConnectorStatus(connector.status)) {
      return reply.code(409).send({ error: 'connector is not active' });
    }
    if (connector.provider !== 'gmail') {
      return reply.code(400).send({ error: 'gmail push is only supported for provider=gmail connectors' });
    }

    const existingSyncSettings = connector.sync_settings ?? {};
    const fallbackMailbox = normalizeGmailMailboxPath(normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX'));
    const watchMailboxes = normalizePersistedWatchMailboxes(
      existingSyncSettings.watchMailboxes,
      {
        isGmailLike: true,
        fallbackMailbox,
      },
    );

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
      const fallbackMailbox = normalizeGmailMailboxPath(normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX'));
      const targetMailboxes = normalizePersistedWatchMailboxes(
        existingSyncSettings.watchMailboxes,
        {
          isGmailLike: true,
          fallbackMailbox,
        },
      );
      await ensureIncomingConnectorStatesBulk(connector.id, targetMailboxes);

      await Promise.all(
        targetMailboxes.map(async (mailbox) => {
          const enqueued = await enqueueSyncWithOptions(connector.user_id, connector.id, mailbox, {
            priority: resolveSyncQueuePriority(connector.user_id, connector.id, mailbox),
            gmailHistoryIdHint: decoded.historyId ?? null,
          });
          if (enqueued) {
            try {
              await setSyncState(connector.id, mailbox, {
                status: 'queued',
                syncCompletedAt: null,
                syncError: null,
                syncProgress: { inserted: 0, updated: 0, reconciledRemoved: 0, metadataRefreshed: 0 },
              });
            } catch {
              // Keep webhook handling fast even if sync-state writes are transiently unavailable.
            }
            return;
          }
          void syncIncomingConnector(connector.user_id, connector.id, mailbox, {
            gmailHistoryIdHint: decoded.historyId ?? null,
          }).catch((error) => {
            req.log.warn({ error, connectorId: connector.id, mailbox }, 'gmail push fallback sync failed');
          });
        }),
      );

      const nextSyncSettings = {
        ...existingSyncSettings,
        watchMailboxes: targetMailboxes,
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
    const since = parseNonNegativeIntWithCap(queryObject?.since, 0, MAX_SYNC_EVENT_ID);
    const limit = parsePositiveIntWithCap(queryObject?.limit, 100, MAX_EVENTS_LIMIT);
    return listSyncEvents(userId, since, limit);
  });

  app.get('/api/events/stream', async (req, reply) => {
    const userId = getUserId(req);
    if (!tryAcquireEventStreamSlot(userId)) {
      return reply.code(429).send({ error: `too many open event streams (max ${MAX_ACTIVE_EVENT_STREAMS_PER_USER})` });
    }
    const queryObject = req.query as any;
    let since = parseNonNegativeIntWithCap(queryObject?.since, 0, MAX_SYNC_EVENT_ID);
    let closed = false;
    const onClose = () => {
      closed = true;
    };
    try {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

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
          req.log.warn({ error }, 'sync event stream polling failed');
          reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: 'event stream failed' })}\n\n`);
          await new Promise<void>((resolve) => {
            setTimeout(resolve, EVENT_STREAM_ERROR_BACKOFF_MS);
          });
        }
      }

      return reply;
    } finally {
      req.raw.off('close', onClose);
      req.raw.off('aborted', onClose);
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
      releaseEventStreamSlot(userId);
    }
  });

  app.get('/api/messages', async (req) => {
    const userId = getUserId(req);
    const queryObject = req.query as any;
    const limit = parsePositiveIntWithCap(queryObject?.limit, 50, MAX_MESSAGES_PAGE_LIMIT);
    const offset = parseNonNegativeIntWithCap(queryObject?.offset, 0, MAX_MESSAGES_OFFSET);
    const connectorId = String(queryObject?.connectorId ?? '').trim();
    const resolvedConnectorIsGmailLike = connectorId
      ? await getIncomingConnectorGmailLikeCached(userId, connectorId)
      : null;
    const resolvedConnector = connectorId && resolvedConnectorIsGmailLike !== null
      ? (resolvedConnectorIsGmailLike ? { provider: 'gmail' } : { provider: 'imap' })
      : null;
    const folder = normalizeConnectorFolderFilterWithConnector(
      queryObject?.folder as string | undefined,
      resolvedConnector,
    );
    const normalizedFolder = String(folder ?? '').trim().toUpperCase();
    const folderFilter = buildGmailFolderPredicatesWithConnector(
      queryObject?.folder as string | undefined,
      resolvedConnector,
    );
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
    const shouldDedupeLogicalMessages = !folder || folderFilter.dedupeLogicalMessages;
    const dedupeKeyExpr = logicalMessageKeySql('m');

    const countValues = [...values];
    const rowsValues = [...values, limit, offset];

    const [countResult, result] = await Promise.all([
      shouldDedupeLogicalMessages
        ? query<{ count: string }>(
            `SELECT COUNT(*)::int as count
               FROM (
                 SELECT DISTINCT m.incoming_connector_id, ${dedupeKeyExpr}
                   FROM messages m
                   INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
                  WHERE ${predicates.join(' AND ')}
               ) dedup`,
            countValues,
          )
        : query<{ count: string }>(
            `SELECT COUNT(*)::int as count
               FROM messages m
               INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
              WHERE ${predicates.join(' AND ')}`,
            countValues,
          ),
      shouldDedupeLogicalMessages
        ? query<any>(
            `WITH dedup AS (
             SELECT DISTINCT ON (m.incoming_connector_id, ${dedupeKeyExpr})
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
                    m.thread_id as "threadId"
               FROM messages m
               INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
              WHERE ${predicates.join(' AND ')}
              ORDER BY
                m.incoming_connector_id,
                ${dedupeKeyExpr},
                ${mailboxReadPreferenceRankSql},
                m.received_at DESC NULLS LAST,
                m.updated_at DESC,
                m.id DESC
           ),
           paged AS (
             SELECT *
               FROM dedup
              ORDER BY "receivedAt" DESC, id DESC
              LIMIT $${rowsValues.length - 1} OFFSET $${rowsValues.length}
           ),
           thread_ids AS (
             SELECT DISTINCT
                    p."incomingConnectorId" as incoming_connector_id,
                    p."threadId" as thread_id
               FROM paged p
              WHERE p."threadId" IS NOT NULL
           ),
           thread_stats AS (
             SELECT m3.incoming_connector_id,
                    m3.thread_id,
                    COUNT(DISTINCT ${logicalMessageKeySql('m3')})::int as thread_count,
                    COALESCE(
                      jsonb_agg(DISTINCT m3.from_header) FILTER (WHERE m3.from_header IS NOT NULL),
                      '[]'::jsonb
                    ) as participants
               FROM messages m3
               INNER JOIN thread_ids ti
                 ON ti.incoming_connector_id = m3.incoming_connector_id
                AND ti.thread_id = m3.thread_id
              GROUP BY m3.incoming_connector_id, m3.thread_id
           )
           SELECT p.id,
                  p."incomingConnectorId",
                  p."messageId",
                  p.subject,
                  p."fromHeader",
                  p."toHeader",
                  p."folderPath",
                  p.snippet,
                  p."receivedAt",
                  p."isRead",
                  p."isStarred",
                  p."threadId",
                  CASE
                    WHEN p."threadId" IS NULL THEN 1
                    ELSE COALESCE(ts.thread_count, 1)
                  END as "threadCount",
                  CASE
                    WHEN p."threadId" IS NULL THEN
                      CASE
                        WHEN p."fromHeader" IS NULL THEN '[]'::jsonb
                        ELSE jsonb_build_array(p."fromHeader")
                      END
                    ELSE COALESCE(ts.participants, '[]'::jsonb)
                  END as participants
             FROM paged p
             LEFT JOIN thread_stats ts
               ON ts.incoming_connector_id = p."incomingConnectorId"
              AND ts.thread_id = p."threadId"
            ORDER BY p."receivedAt" DESC, p.id DESC`,
            rowsValues,
          )
        : query<any>(
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
            LIMIT $${rowsValues.length - 1} OFFSET $${rowsValues.length}`,
            rowsValues,
          ),
    ]);
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
    if (searchText.length > MAX_SEND_ONLY_SEARCH_CHARS) {
      return reply.code(400).send({ error: `q exceeds ${MAX_SEND_ONLY_SEARCH_CHARS} characters` });
    }
    const limit = parsePositiveIntWithCap(queryObject?.limit, 50, MAX_MESSAGES_PAGE_LIMIT);
    const offset = parseNonNegativeIntWithCap(queryObject?.offset, 0, MAX_MESSAGES_OFFSET);

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
    const normalizedQuery = String(q ?? '').trim();
    if (!normalizedQuery) {
      return reply.code(400).send({ error: 'q is required' });
    }
    if (normalizedQuery.length > MAX_MESSAGES_SEARCH_QUERY_CHARS) {
      return reply.code(400).send({ error: `q exceeds ${MAX_MESSAGES_SEARCH_QUERY_CHARS} characters` });
    }
    const limit = parsePositiveIntWithCap(body?.limit, 50, MAX_MESSAGES_PAGE_LIMIT);
    const connectorId = String(body?.connectorId ?? '').trim();
    const resolvedConnectorIsGmailLike = connectorId
      ? await getIncomingConnectorGmailLikeCached(userId, connectorId)
      : null;
    const resolvedConnector = connectorId && resolvedConnectorIsGmailLike !== null
      ? (resolvedConnectorIsGmailLike ? { provider: 'gmail' } : { provider: 'imap' })
      : null;
    const folder = normalizeConnectorFolderFilterWithConnector(
      body?.folder as string | undefined,
      resolvedConnector,
    );
    const normalizedFolder = String(folder ?? '').trim().toUpperCase();

    const parsed = parseMessageSearchQuery(normalizedQuery);
    const parsedResult = buildMessageSearchQuery(userId, parsed);
    const values = parsedResult.values;
    const predicates = parsedResult.predicates;
    const folderFilter = buildGmailFolderPredicatesWithConnector(
      body?.folder as string | undefined,
      resolvedConnector,
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
    const dedupeKeyExpr = logicalMessageKeySql('m');

    const offset = parseNonNegativeIntWithCap((req.body as any)?.offset, 0, MAX_MESSAGES_OFFSET);
    const countValues = [...values];
    const rowsValues = [...values, limit, offset];

    const [countResult, result] = await Promise.all([
      shouldDedupeLogicalMessages
        ? query<{ count: string }>(
            `SELECT COUNT(*)::int as count
               FROM (
                 SELECT DISTINCT m.incoming_connector_id, ${dedupeKeyExpr}
                   FROM messages m
                   INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
                  WHERE ${predicates.join(' AND ')}
               ) dedup`,
            countValues,
          )
        : query<{ count: string }>(
            `SELECT COUNT(*)::int as count
               FROM messages m
               INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
              WHERE ${predicates.join(' AND ')}`,
            countValues,
          ),
      shouldDedupeLogicalMessages
        ? query<any>(
            `WITH dedup AS (
             SELECT DISTINCT ON (m.incoming_connector_id, ${dedupeKeyExpr})
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
                    m.is_starred as "isStarred"
               FROM messages m
               INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
              WHERE ${predicates.join(' AND ')}
              ORDER BY
                m.incoming_connector_id,
                ${dedupeKeyExpr},
                ${mailboxReadPreferenceRankSql},
                m.received_at DESC NULLS LAST,
                m.updated_at DESC,
                m.id DESC
           ),
           paged AS (
             SELECT *
               FROM dedup
              ORDER BY "receivedAt" DESC, id DESC
              LIMIT $${rowsValues.length - 1} OFFSET $${rowsValues.length}
           ),
           thread_ids AS (
             SELECT DISTINCT
                    p."incomingConnectorId" as incoming_connector_id,
                    p."threadId" as thread_id
               FROM paged p
              WHERE p."threadId" IS NOT NULL
           ),
           thread_stats AS (
             SELECT m3.incoming_connector_id,
                    m3.thread_id,
                    COUNT(DISTINCT ${logicalMessageKeySql('m3')})::int as thread_count,
                    COALESCE(
                      jsonb_agg(DISTINCT m3.from_header) FILTER (WHERE m3.from_header IS NOT NULL),
                      '[]'::jsonb
                    ) as participants
               FROM messages m3
               INNER JOIN thread_ids ti
                 ON ti.incoming_connector_id = m3.incoming_connector_id
                AND ti.thread_id = m3.thread_id
              GROUP BY m3.incoming_connector_id, m3.thread_id
           )
           SELECT p.id,
                  p."incomingConnectorId",
                  p."messageId",
                  p.subject,
                  p."fromHeader",
                  p."toHeader",
                  p."folderPath",
                  p.snippet,
                  p."receivedAt",
                  p."threadId",
                  p."isRead",
                  p."isStarred",
                  CASE
                    WHEN p."threadId" IS NULL THEN 1
                    ELSE COALESCE(ts.thread_count, 1)
                  END as "threadCount",
                  CASE
                    WHEN p."threadId" IS NULL THEN
                      CASE
                        WHEN p."fromHeader" IS NULL THEN '[]'::jsonb
                        ELSE jsonb_build_array(p."fromHeader")
                      END
                    ELSE COALESCE(ts.participants, '[]'::jsonb)
                  END as participants
             FROM paged p
             LEFT JOIN thread_stats ts
               ON ts.incoming_connector_id = p."incomingConnectorId"
              AND ts.thread_id = p."threadId"
            ORDER BY p."receivedAt" DESC, p.id DESC`,
            rowsValues,
          )
        : query<any>(
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
            LIMIT $${rowsValues.length - 1} OFFSET $${rowsValues.length}`,
            rowsValues,
          ),
    ]);
    return {
      messages: result.rows,
      totalCount: Number(countResult.rows[0]?.count ?? 0),
    };
  });

  app.get('/api/search/quick-filters', async (req) => {
    const userId = getUserId(req);
    const cached = getQuickFiltersCache(userId);
    if (cached) {
      return cached.value;
    }

    const [labelRows, starredRow, attachmentRow, fromResult] = await Promise.all([
      query<{ key: string; name: string; count: number }>(
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
      ),
      query<{ count: number }>(
        `SELECT COUNT(*)::int as count
           FROM messages m
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
          WHERE ic.user_id = $1 AND m.is_starred = TRUE`,
        [userId],
      ),
      query<{ count: number }>(
        `SELECT COUNT(DISTINCT m.id)::int as count
           FROM messages m
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
           INNER JOIN attachments a ON a.message_id = m.id
          WHERE ic.user_id = $1`,
        [userId],
      ),
      query<{ fromHeader: string; count: number }>(
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
      ),
    ]);

    const payload: QuickFiltersResponse = {
      labels: labelRows.rows,
      starred: Number(starredRow.rows[0]?.count ?? 0),
      withAttachments: Number(attachmentRow.rows[0]?.count ?? 0),
      topFrom: fromResult.rows,
    };
    setQuickFiltersCache(userId, payload, SEARCH_QUICK_FILTERS_CACHE_TTL_MS, SEARCH_QUICK_FILTERS_CACHE_MAX);
    return payload;
  });

  app.get('/api/search/suggestions', async (req, reply) => {
    const userId = getUserId(req);
    const queryText = String((req.query as any)?.q ?? '').trim();
    if (!queryText) {
      return reply.code(400).send({ error: 'q is required' });
    }
    if (queryText.length > MAX_SEARCH_SUGGESTION_QUERY_CHARS) {
      return reply.code(400).send({ error: `q exceeds ${MAX_SEARCH_SUGGESTION_QUERY_CHARS} characters` });
    }
    const cacheKey = `${userId}:${queryText.toLowerCase()}`;
    const cached = getSearchSuggestionsCache(cacheKey);
    if (cached) {
      return cached.value;
    }

    const prefix = `%${queryText}%`;
    const [labelResult, fromResult, subjectResult] = await Promise.all([
      query<{ key: string; name: string }>(
        `SELECT key, name
           FROM labels
          WHERE user_id = $1
            AND is_archived = FALSE
            AND (key ILIKE $2 OR name ILIKE $2)
          LIMIT 10`,
        [userId, prefix],
      ),
      query<{ fromHeader: string; count: number }>(
        `SELECT from_header as "fromHeader", COUNT(*)::int as count
           FROM messages m
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
          WHERE ic.user_id = $1
            AND from_header ILIKE $2
          GROUP BY from_header
          ORDER BY COUNT(*) DESC, from_header
          LIMIT 10`,
        [userId, prefix],
      ),
      query<{ subject: string; count: number }>(
        `SELECT subject, COUNT(*)::int as count
           FROM messages m
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
          WHERE ic.user_id = $1
            AND subject ILIKE $2
          GROUP BY subject
          ORDER BY COUNT(*) DESC, subject
          LIMIT 10`,
        [userId, prefix],
      ),
    ]);

    const payload: SearchSuggestionsResponse = {
      labels: labelResult.rows,
      from: fromResult.rows,
      subjects: subjectResult.rows,
    };
    setSearchSuggestionsCache(
      cacheKey,
      payload,
      SEARCH_SUGGESTIONS_CACHE_TTL_MS,
      SEARCH_SUGGESTIONS_CACHE_MAX,
    );
    return payload;
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
    const name = String(body.name).trim();
    const queryText = String(body.queryText).trim();
    if (!name || !queryText) {
      return reply.code(400).send({ error: 'name and queryText required' });
    }
    if (name.length > MAX_SAVED_SEARCH_NAME_CHARS) {
      return reply.code(400).send({ error: `name exceeds ${MAX_SAVED_SEARCH_NAME_CHARS} characters` });
    }
    if (queryText.length > MAX_SAVED_SEARCH_QUERY_CHARS) {
      return reply.code(400).send({ error: `queryText exceeds ${MAX_SAVED_SEARCH_QUERY_CHARS} characters` });
    }
    return createSavedSearch(userId, {
      name,
      queryText,
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
    const nextName = body.name === undefined ? undefined : String(body.name).trim();
    const nextQueryText = body.queryText === undefined ? undefined : String(body.queryText).trim();
    if (nextName !== undefined && !nextName) {
      return reply.code(400).send({ error: 'name cannot be empty' });
    }
    if (nextQueryText !== undefined && !nextQueryText) {
      return reply.code(400).send({ error: 'queryText cannot be empty' });
    }
    if (nextName && nextName.length > MAX_SAVED_SEARCH_NAME_CHARS) {
      return reply.code(400).send({ error: `name exceeds ${MAX_SAVED_SEARCH_NAME_CHARS} characters` });
    }
    if (nextQueryText && nextQueryText.length > MAX_SAVED_SEARCH_QUERY_CHARS) {
      return reply.code(400).send({ error: `queryText exceeds ${MAX_SAVED_SEARCH_QUERY_CHARS} characters` });
    }
    await updateSavedSearch(userId, id, {
      name: nextName,
      queryText: nextQueryText,
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
    delete message.raw_blob_key;

    const attachments = await query<any>(
      `WITH ranked AS (
         SELECT a.id,
                a.message_id,
                a.filename,
                a.content_type,
                a.size_bytes,
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
              NULL::text as "blobKey",
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

    const blob = await blobStore.getObjectStream(row.rawBlobKey);
    if (!blob) {
      return reply.code(404).send({ error: 'message source not found' });
    }

    const filename = sanitizeDispositionFilename(`${messageId}.eml`, 'message.eml');
    reply.header('Content-Type', 'message/rfc822');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Pragma', 'no-cache');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    if (blob.size !== null) {
      reply.header('Content-Length', String(blob.size));
    }
    return reply.send(blob.stream);
  });

  // Bulk-update multiple messages in a single request.
  app.post('/api/messages/bulk', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    const rawIds = body?.messageIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return reply.code(400).send({ error: 'messageIds array required' });
    }
    if (rawIds.length > 500) {
      return reply.code(400).send({ error: 'messageIds exceeds 500 items' });
    }
    let messageIds: string[];
    try {
      messageIds = parseTrimmedStringArrayWithCap(rawIds, 'messageIds', 500);
      assertUuidList(messageIds, 'messageIds');
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid messageIds' });
    }
    const scope = body?.scope === 'thread' ? 'thread' : 'single';
    let normalizedMoveToFolder: string | undefined;
    try {
      if (body?.moveToFolder !== undefined && body?.moveToFolder !== null && String(body.moveToFolder).trim()) {
        normalizedMoveToFolder = normalizeMailboxInput(body.moveToFolder, 'moveToFolder');
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid moveToFolder' });
    }
    if (isArchiveMoveTarget(normalizedMoveToFolder)) {
      return reply.code(400).send({ error: 'archive is no longer supported' });
    }

    const results: { id: string; status: string }[] = [];
    const chunks: string[][] = [];
    for (let i = 0; i < messageIds.length; i += 20) {
      chunks.push(messageIds.slice(i, i + 20));
    }

    for (const chunk of chunks) {
      const chunkMessagesResult = await query<any>(
        `SELECT m.id,
                m.incoming_connector_id,
                m.folder_path,
                m.uid
           FROM messages m
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
          WHERE ic.user_id = $1
            AND m.id::text = ANY($2::text[])`,
        [userId, chunk],
      );
      const messageById = new Map<string, any>(
        chunkMessagesResult.rows.map((row) => [String(row.id), row]),
      );

      await Promise.all(chunk.map(async (messageId) => {
        try {
          const message = messageById.get(messageId) ?? null;
          if (!message) {
            results.push({ id: messageId, status: 'not_found' });
            return;
          }

          if (scope === 'thread') {
            await applyThreadMessageActions(userId, message.id, {
              isRead: body?.isRead,
              isStarred: body?.isStarred,
              moveToFolder: normalizedMoveToFolder,
              delete: body?.delete,
            });
          } else {
            if (body?.isRead !== undefined) {
              await setMessageReadState(userId, message.id, message.incoming_connector_id, message.folder_path, message.uid === null || message.uid === undefined ? null : Number(message.uid), Boolean(body.isRead));
            }
            if (body?.isStarred !== undefined) {
              await setMessageStarredState(userId, message.id, message.incoming_connector_id, message.folder_path, message.uid === null || message.uid === undefined ? null : Number(message.uid), Boolean(body.isStarred));
            }
            if (normalizedMoveToFolder) {
              await moveMessageInMailbox(
                userId,
                message.id,
                message.incoming_connector_id,
                message.folder_path,
                normalizedMoveToFolder,
                message.uid === null || message.uid === undefined ? null : Number(message.uid),
              );
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

    clearSearchCachesForUser(userId);
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
    let normalizedMoveToFolder: string | undefined;
    let addLabelKeys: string[] | undefined;
    let removeLabelKeys: string[] | undefined;
    try {
      if (body?.moveToFolder !== undefined && body?.moveToFolder !== null && String(body.moveToFolder).trim()) {
        normalizedMoveToFolder = normalizeMailboxInput(body.moveToFolder, 'moveToFolder');
      }
      if (body?.addLabelKeys !== undefined) {
        addLabelKeys = parseTrimmedStringArrayWithCap(body.addLabelKeys, 'addLabelKeys', MAX_LABEL_MUTATION_ITEMS);
      }
      if (body?.removeLabelKeys !== undefined) {
        removeLabelKeys = parseTrimmedStringArrayWithCap(body.removeLabelKeys, 'removeLabelKeys', MAX_LABEL_MUTATION_ITEMS);
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid message action payload' });
    }
    if (isArchiveMoveTarget(normalizedMoveToFolder)) {
      return reply.code(400).send({ error: 'archive is no longer supported' });
    }

    if (scope === 'thread') {
      await applyThreadMessageActions(userId, message.id, {
        isRead: body?.isRead,
        isStarred: body?.isStarred,
        moveToFolder: normalizedMoveToFolder,
        delete: body?.delete,
        addLabelKeys,
        removeLabelKeys,
      });
      clearSearchCachesForUser(userId);
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

    if (addLabelKeys?.length) {
      await addLabelsToMessageByKey(userId, message.id, addLabelKeys);
    }
    if (removeLabelKeys?.length) {
      await removeLabelsFromMessageByKey(userId, message.id, removeLabelKeys);
    }

    if (normalizedMoveToFolder) {
      await moveMessageInMailbox(
        userId,
        message.id,
        message.incoming_connector_id,
        message.folder_path,
        normalizedMoveToFolder,
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
      clearSearchCachesForUser(userId);
      return { status: 'deleted', id: messageId };
    }

    const after = await query<any>(
      `SELECT m.*
       FROM messages m
       INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
       WHERE m.id = $1 AND ic.user_id = $2`,
      [messageId, userId],
    );
    const refreshed = after.rows[0];
    if (refreshed) {
      delete refreshed.raw_blob_key;
    }
    clearSearchCachesForUser(userId);
    return refreshed;
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
              NULL::text as "blobKey",
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
    if (!UUID_PATTERN.test(attachmentId)) {
      return reply.code(400).send({ error: 'invalid attachmentId' });
    }
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
    const scanBlock = getAttachmentScanBlock(attachment.scanStatus);
    if (scanBlock) {
      return reply.code(scanBlock.statusCode).send({ error: scanBlock.error });
    }

    const blob = await blobStore.getObjectStream(attachment.blob_key);
    if (!blob) {
      return reply.code(404).send({ error: 'attachment blob not found' });
    }

    const filename = sanitizeDispositionFilename(attachment.filename, 'attachment');
    reply.header('Content-Type', attachment.contentType || 'application/octet-stream');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Pragma', 'no-cache');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    if (blob.size !== null) {
      reply.header('Content-Length', String(blob.size));
    }
    return reply.send(blob.stream);
  });

  app.get('/api/attachments/:attachmentId/view', async (req, reply) => {
    const userId = getUserId(req);
    const attachmentId = String((req.params as any).attachmentId);
    if (!UUID_PATTERN.test(attachmentId)) {
      return reply.code(400).send({ error: 'invalid attachmentId' });
    }
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
    const scanBlock = getAttachmentScanBlock(attachment.scanStatus);
    if (scanBlock) {
      return reply.code(scanBlock.statusCode).send({ error: scanBlock.error });
    }

    const blob = await blobStore.getObjectStream(attachment.blob_key);
    if (!blob) {
      return reply.code(404).send({ error: 'attachment blob not found' });
    }

    const filename = sanitizeDispositionFilename(attachment.filename, 'attachment');
    reply.header('Content-Type', attachment.contentType || 'application/octet-stream');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header(
      'Content-Security-Policy',
      "sandbox; default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'",
    );
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Pragma', 'no-cache');
    reply.header('Content-Disposition', `inline; filename="${filename}"`);
    if (blob.size !== null) {
      reply.header('Content-Length', String(blob.size));
    }
    return reply.send(blob.stream);
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

    let idempotencyKey: string;
    try {
      idempotencyKey = normalizeSendIdempotencyKey(body.idempotencyKey ?? idempotencyHeader);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid idempotency key' });
    }
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
    if (!UUID_PATTERN.test(messageId) || !UUID_PATTERN.test(attachmentId)) {
      return reply.code(400).send({ error: 'messageId and attachmentId must be valid UUID values' });
    }

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
        [attachmentId, decision.status, decision.verdictHint],
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
        [attachmentId],
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
    const endpoint = String(body.endpoint).trim();
    const p256dh = String(body.p256dh).trim();
    const auth = String(body.auth).trim();
    const userAgent = body.userAgent === undefined || body.userAgent === null
      ? undefined
      : String(body.userAgent).trim();

    if (!endpoint || !p256dh || !auth) {
      return reply.code(400).send({ error: 'endpoint, p256dh, auth required' });
    }
    if (endpoint.length > MAX_PUSH_ENDPOINT_CHARS) {
      return reply.code(400).send({ error: `endpoint exceeds ${MAX_PUSH_ENDPOINT_CHARS} characters` });
    }
    if (p256dh.length > MAX_PUSH_KEY_CHARS || auth.length > MAX_PUSH_KEY_CHARS) {
      return reply.code(400).send({ error: `p256dh/auth exceeds ${MAX_PUSH_KEY_CHARS} characters` });
    }
    if (userAgent && userAgent.length > MAX_PUSH_USER_AGENT_CHARS) {
      return reply.code(400).send({ error: `userAgent exceeds ${MAX_PUSH_USER_AGENT_CHARS} characters` });
    }

    await assertSafePushEndpoint(endpoint);

    const subscription = await createPushSubscription({
      userId,
      endpoint,
      p256dh,
      auth,
      userAgent,
    });
    return subscription;
  });

  app.delete('/api/push/subscribe', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.endpoint) {
      return reply.code(400).send({ error: 'endpoint required' });
    }
    const endpoint = String(body.endpoint).trim();
    if (!endpoint) {
      return reply.code(400).send({ error: 'endpoint required' });
    }
    await removePushSubscription(userId, endpoint);
    return { status: 'deleted' };
  });
};
