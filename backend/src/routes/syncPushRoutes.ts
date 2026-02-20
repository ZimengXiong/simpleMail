import { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { getIncomingConnector, updateIncomingConnector } from '../services/connectorService.js';
import { enqueueSyncWithOptions } from '../services/queue.js';
import {
  normalizeGmailMailboxPath,
  syncIncomingConnector,
  setSyncState,
} from '../services/imap.js';
import { gmailApiRequest } from '../services/gmailApi.js';
import { query } from '../db/pool.js';
import { getUserId } from './syncHelpers.js';
import * as routeHelpers from './helpers.js';
import { resolveSyncQueuePriority } from '../services/syncPriority.js';

const {
  isActiveConnectorStatus,
  normalizeMailboxInput,
  normalizePersistedWatchMailboxes,
  getGmailPushAudience,
  decodePubSubPushBody,
  verifyPubSubPushToken,
  buildGmailWatchLabelIds,
  ensureIncomingConnectorStatesBulk,
} = routeHelpers;

export const registerSyncPushRoutes = async (app: FastifyInstance) => {
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
};
