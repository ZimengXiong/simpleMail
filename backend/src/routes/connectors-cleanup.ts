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


export const registerConnectorCleanupRoutes = async (app: FastifyInstance) => {
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
};
