import { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { getIncomingConnector, updateIncomingConnector } from '../services/connectorService.js';
import { enqueueSyncWithOptions } from '../services/queue.js';
import { query } from '../db/pool.js';
import {
  getMailboxState,
  listConnectorMailboxes,
  syncIncomingConnector,
  ensureIncomingConnectorState,
  requestSyncCancellation,
  startIncomingConnectorIdleWatch,
  stopIncomingConnectorIdleWatch,
  setSyncState,
  normalizeGmailMailboxPath,
} from '../services/imap.js';
import { markActiveMailbox, resolveSyncQueuePriority } from '../services/syncPriority.js';
import * as routeHelpers from './helpers.js';
import { getUserId } from './syncHelpers.js';

const {
  isActiveConnectorStatus,
  isGmailLikeConnector,
  normalizeMailboxInput,
  normalizePersistedWatchMailboxes,
  ACTIVE_MAILBOX_CONNECTOR_CACHE_TTL_MS,
  getActiveMailboxConnectorCache,
  setActiveMailboxConnectorCache,
  ensureIncomingConnectorStatesBulk,
  buildInitialSyncTargets,
  MAX_WATCH_MAILBOXES,
} = routeHelpers;

export const registerSyncManagementRoutes = async (app: FastifyInstance) => {
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
    const force = body.force === true;
    const requestedPriority = String(body.priority || '').toLowerCase() === 'high' ? 'high' : 'normal';
    const resolvePriorityForMailbox = (targetMailbox: string) =>
      requestedPriority === 'high'
        ? 'high'
        : resolveSyncQueuePriority(userId, connectorId, targetMailbox);

    if (syncAll) {
      const mailboxes = await listConnectorMailboxes(userId, connectorId);
      const queueTargets = mailboxes
        .map((entry: { path: string }) => isGmailLikeConnector(connector)
          ? normalizeGmailMailboxPath(entry.path)
          : entry.path)
        .filter((entry: string) => Boolean(entry && String(entry).trim()));
      const fallbackMailbox = isGmailLikeConnector(connector)
        ? normalizeGmailMailboxPath(normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX'))
        : normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX');
      const targets = buildInitialSyncTargets(connector, queueTargets, fallbackMailbox);
      await ensureIncomingConnectorStatesBulk(connectorId, targets);

      const queuedResults = await Promise.all(
        targets.map(async (targetMailbox) => {
          const enqueued = await enqueueSyncWithOptions(userId, connectorId, targetMailbox, {
            priority: resolvePriorityForMailbox(targetMailbox),
            force,
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
            }
            return enqueued;
          }
          return false;
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
          force,
        });
        if (enqueued) {
          const snapshot = force ? await getMailboxState(connectorId, mailbox).catch(() => null) : null;
          try {
            if (snapshot?.status !== 'syncing') {
              await setSyncState(connectorId, mailbox, {
                status: 'queued',
                syncCompletedAt: null,
                syncError: null,
                syncProgress: { inserted: 0, updated: 0, reconciledRemoved: 0, metadataRefreshed: 0 },
              });
            }
          } catch {
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
};
