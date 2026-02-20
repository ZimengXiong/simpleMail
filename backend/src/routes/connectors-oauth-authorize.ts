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


export const registerOAuthAuthorizeRoutes = async (app: FastifyInstance) => {
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
};
