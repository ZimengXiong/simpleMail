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

const getUserId = (request: any) => {
  if (!request.user?.id) {
    const error = new Error('missing user context') as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }
  return request.user.id;
};


export const registerConnectorCoreRoutes = async (app: FastifyInstance) => {
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

};
