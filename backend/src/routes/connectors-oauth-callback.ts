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


export const registerOAuthCallbackRoutes = async (app: FastifyInstance) => {
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
          }
        }

        const mailboxes = await listConnectorMailboxes(targetUserId, connectorId);
        const queueTargets = mailboxes
          .map((mailbox: any) => isGmailLikeConnector({ provider, sync_settings: connectorSyncSettings, syncSettings: connectorSyncSettings })
            ? normalizeGmailMailboxPath(mailbox.path)
            : mailbox.path)
          .filter((mailbox: any) => Boolean(mailbox && String(mailbox).trim()));
        const targets = buildInitialSyncTargets(
          { provider, sync_settings: connectorSyncSettings, syncSettings: connectorSyncSettings },
          queueTargets,
          fallbackMailbox,
        );
        await ensureIncomingConnectorStatesBulk(connectorId, targets);
        await Promise.all(
          targets.map(async (mailbox: string) => {
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
              }
              void syncIncomingConnector(targetUserId, connectorId, mailbox).catch((error: unknown) => {
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
            }
          }),
        );
      } catch {
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

};
