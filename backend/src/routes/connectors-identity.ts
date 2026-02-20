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


export const registerConnectorIdentityRoutes = async (app: FastifyInstance) => {
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
};
