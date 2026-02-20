import { makeWorkerUtils, WorkerUtils } from 'graphile-worker';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';

let queue: WorkerUtils | null = null;
let activeWorkersCache: { expiresAtMs: number; value: boolean } | null = null;
const ACTIVE_WORKERS_CACHE_TTL_MS = 5_000;

export const createQueue = async () => {
  if (queue) return queue;
  queue = await makeWorkerUtils({
    connectionString: env.databaseUrl,
  });
  return queue;
};

const hasActiveWorkers = async () => {
  if (activeWorkersCache && activeWorkersCache.expiresAtMs > Date.now()) {
    return activeWorkersCache.value;
  }

  const heartbeatGraceSeconds = 30;
  const safeWorkerCount = async (tableName: 'workers' | '_private_workers') => {
    const result = await query<{ count: number }>(
      `SELECT COUNT(*)::int as count
         FROM graphile_worker.${tableName}
        WHERE last_heartbeat IS NOT NULL
          AND last_heartbeat > NOW() - ($1::double precision * INTERVAL '1 second')`,
      [heartbeatGraceSeconds],
    );
    return Number(result.rows[0]?.count ?? 0);
  };

  const countRecentlyLockedJobs = async () => {
    const result = await query<{ count: number }>(
      `SELECT COUNT(*)::int as count
         FROM graphile_worker.jobs
        WHERE locked_at IS NOT NULL
          AND locked_at > NOW() - ($1::double precision * INTERVAL '1 second')`,
      [heartbeatGraceSeconds],
    );
    return Number(result.rows[0]?.count ?? 0);
  };

  const countFrom = async (tableName: 'workers' | '_private_workers') => {
    try {
      return await safeWorkerCount(tableName);
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError?.code === '42P01') {
        return null;
      }
      return null;
    }
  };

  let active = false;
  const workersCount = await countFrom('workers');
  if (typeof workersCount === 'number') {
    active = workersCount > 0;
  } else {
    const privateWorkersCount = await countFrom('_private_workers');
    if (typeof privateWorkersCount === 'number') {
      active = privateWorkersCount > 0;
    } else {
      // Some graphile-worker schemas do not expose worker heartbeat tables.
      // In that case, fall back to recent lock activity; if unavailable, assume
      // no active workers so sync can run immediately in-process.
      try {
        active = (await countRecentlyLockedJobs()) > 0;
      } catch {
        active = false;
      }
    }
  }

  activeWorkersCache = {
    value: active,
    expiresAtMs: Date.now() + ACTIVE_WORKERS_CACHE_TTL_MS,
  };
  return active;
};

const hasActiveSyncClaim = async (connectorId: string, mailbox: string) => {
  try {
    const staleMs = Number.isFinite(env.sync.syncClaimStaleMs) && env.sync.syncClaimStaleMs > 0
      ? Math.floor(env.sync.syncClaimStaleMs)
      : 900000;
    const heartbeatStaleMs = Number.isFinite(env.sync.syncClaimHeartbeatStaleMs) && env.sync.syncClaimHeartbeatStaleMs > 0
      ? Math.floor(env.sync.syncClaimHeartbeatStaleMs)
      : 45000;
    const result = await query<{ status: string; sync_started_at: string | null; updated_at: string | null }>(
      `SELECT status, sync_started_at, updated_at
         FROM sync_states
        WHERE incoming_connector_id = $1
          AND mailbox = $2`,
      [connectorId, mailbox],
    );
    const row = result.rows[0];
    if (!row || row.status !== 'syncing' || !row.sync_started_at) {
      return false;
    }
    const updatedAtMs = row.updated_at ? Date.parse(row.updated_at) : NaN;
    if (Number.isFinite(updatedAtMs) && (Date.now() - updatedAtMs) > heartbeatStaleMs) {
      return false;
    }
    const startedAtMs = Date.parse(row.sync_started_at);
    if (!Number.isFinite(startedAtMs)) {
      return false;
    }
    return (Date.now() - startedAtMs) < staleMs;
  } catch {
    return false;
  }
};

export type SyncQueuePriority = 'normal' | 'high';

type EnqueueSyncOptions = {
  priority?: SyncQueuePriority;
  gmailHistoryIdHint?: string | null;
};

const toJobPriority = (priority: SyncQueuePriority | undefined) =>
  priority === 'high' ? -50 : 0;

export const enqueueSyncWithOptions = async (
  userId: string,
  connectorId: string,
  mailbox = 'INBOX',
  options: EnqueueSyncOptions = {},
) => {
  const jobKey = `sync:${connectorId}:${mailbox}`;
  // Best-effort cleanup only; some graphile-worker versions expose `jobs` via a view.
  // Enqueue must still proceed if this maintenance query is unsupported.
  try {
    await query(
      `DELETE FROM graphile_worker.jobs
        WHERE task_identifier = 'syncIncomingConnector'
          AND key = $1
          AND locked_at IS NULL
          AND attempts >= max_attempts`,
      [jobKey],
    );
  } catch {}
  if (await hasActiveSyncClaim(connectorId, mailbox)) {
    return false;
  }
  if (!(await hasActiveWorkers())) {
    return false;
  }
  const q = await createQueue();
  await q.addJob(
    'syncIncomingConnector',
    {
      userId,
      connectorId,
      mailbox,
      ...(options.gmailHistoryIdHint ? { gmailHistoryIdHint: options.gmailHistoryIdHint } : {}),
    },
    {
      maxAttempts: 5,
      jobKey,
      // preserve_run_at: if a running job has this key, schedule a new run
      // after it completes rather than silently dropping the request.  This
      // prevents push notifications / IDLE triggers from going missing while
      // a long sync is in progress.
      jobKeyMode: 'preserve_run_at',
      priority: toJobPriority(options.priority),
    },
  );
  return true;
};

export const enqueueSync = async (userId: string, connectorId: string, mailbox = 'INBOX') =>
  enqueueSyncWithOptions(userId, connectorId, mailbox);

export const enqueueSend = async (payload: {
  userId: string;
  identityId: string;
  idempotencyKey: string;
  to: string;
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Array<{ filename: string; contentType: string; contentBase64: string; inline?: boolean; contentId?: string }>;
}) => {
  const q = await createQueue();
  await q.addJob(
    'sendEmail',
    payload,
    {
      maxAttempts: 3,
      jobKey: `send:${payload.userId}:${payload.idempotencyKey}`,
      jobKeyMode: 'unsafe_dedupe',
      priority: -100,
    },
  );
};

export const enqueueAttachmentScan = async (messageId: string, attachmentId: string) => {
  const q = await createQueue();
  await q.addJob(
    'scanAttachment',
    { messageId, attachmentId },
    {
      maxAttempts: 2,
      jobKey: `scan:${messageId}:${attachmentId}`,
      jobKeyMode: 'unsafe_dedupe',
    },
  );
};

export const enqueueRulesReplay = async (payload: {
  userId: string;
  ruleId?: string;
  incomingConnectorId?: string;
  limit?: number;
  offset?: number;
}) => {
  const q = await createQueue();
  const keyParts = ['rules', payload.userId, payload.incomingConnectorId ?? 'all'];
  if (payload.ruleId) {
    keyParts.push(payload.ruleId);
  }
  await q.addJob(
    'runRules',
    payload,
    {
      maxAttempts: 1,
      jobKey: keyParts.join(':'),
      jobKeyMode: 'preserve_run_at',
    },
  );
};

export const enqueueGmailHydration = async (
  userId: string,
  connectorId: string,
  mailbox: string,
) => {
  const q = await createQueue();
  await q.addJob(
    'hydrateGmailMailboxContent',
    { userId, connectorId, mailbox },
    {
      maxAttempts: 5,
      jobKey: `gmail-hydrate:${connectorId}:${mailbox}`,
      jobKeyMode: 'preserve_run_at',
    },
  );
};

export const purgeIncomingConnectorSyncJobs = async (connectorId: string) => {
  const normalizedConnectorId = String(connectorId || '').trim();
  if (!normalizedConnectorId) {
    return { removed: 0 };
  }

  const syncKeyPrefix = `sync:${normalizedConnectorId}:`;
  const hydrateKeyPrefix = `gmail-hydrate:${normalizedConnectorId}:`;
  const removed = await query<{ count: number }>(
    `WITH deleted AS (
       DELETE FROM graphile_worker.jobs
        WHERE locked_at IS NULL
          AND (
            (task_identifier = 'syncIncomingConnector' AND key LIKE ($1 || '%'))
            OR
            (task_identifier = 'hydrateGmailMailboxContent' AND key LIKE ($2 || '%'))
          )
       RETURNING 1
     )
     SELECT COUNT(*)::int AS count FROM deleted`,
    [syncKeyPrefix, hydrateKeyPrefix],
  );

  return { removed: Number(removed.rows[0]?.count ?? 0) };
};
