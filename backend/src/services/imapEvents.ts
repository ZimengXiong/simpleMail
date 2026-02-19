import type { Notification, PoolClient } from 'pg';
import { pool, query } from '../db/pool.js';
import { notifySubscribers } from './push.js';

const SYNC_EVENTS_NOTIFY_CHANNEL = 'bettermail_sync_events';
const MIN_WAIT_TIMEOUT_MS = 250;
const MAX_WAIT_TIMEOUT_MS = 60_000;

type SyncEventSignal = {
  userId: string;
  eventId: number;
};

const waitersByUser = new Map<string, Set<(signal: SyncEventSignal) => void>>();
const latestSignalByUser = new Map<string, SyncEventSignal>();

let listenerClient: PoolClient | null = null;
let listenerBootstrapPromise: Promise<void> | null = null;
let listenerReconnectTimer: NodeJS.Timeout | null = null;

const toSafeEventId = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
};

const dispatchSyncEventSignal = (signal: SyncEventSignal) => {
  latestSignalByUser.set(signal.userId, signal);
  const waiters = waitersByUser.get(signal.userId);
  if (!waiters || waiters.size === 0) {
    return;
  }
  waitersByUser.delete(signal.userId);
  for (const waiter of waiters) {
    waiter(signal);
  }
};

const parseSyncEventSignal = (notification: Notification): SyncEventSignal | null => {
  if (notification.channel !== SYNC_EVENTS_NOTIFY_CHANNEL) {
    return null;
  }
  if (!notification.payload) {
    return null;
  }
  try {
    const parsed = JSON.parse(notification.payload) as { userId?: string; eventId?: number | string };
    const userId = typeof parsed.userId === 'string' ? parsed.userId : '';
    const eventId = toSafeEventId(parsed.eventId);
    if (!userId || eventId === null) {
      return null;
    }
    return { userId, eventId };
  } catch {
    return null;
  }
};

const resetListenerClient = () => {
  if (!listenerClient) {
    return;
  }
  const client = listenerClient;
  listenerClient = null;
  client.removeAllListeners('notification');
  client.removeAllListeners('error');
  client.removeAllListeners('end');
  try {
    client.release(true);
  } catch {
    // ignore client release failures
  }
};

const scheduleListenerReconnect = () => {
  if (listenerReconnectTimer) {
    return;
  }
  listenerReconnectTimer = setTimeout(() => {
    listenerReconnectTimer = null;
    void ensureSyncEventListener().catch(() => {
      scheduleListenerReconnect();
    });
  }, 1_000);
};

const attachSyncEventListener = async () => {
  const client = await pool.connect();
  const onDropped = () => {
    if (listenerClient !== client) {
      return;
    }
    resetListenerClient();
    scheduleListenerReconnect();
  };
  client.on('notification', (notification) => {
    const signal = parseSyncEventSignal(notification);
    if (!signal) {
      return;
    }
    dispatchSyncEventSignal(signal);
  });
  client.on('error', onDropped);
  client.on('end', onDropped);

  try {
    await client.query(`LISTEN ${SYNC_EVENTS_NOTIFY_CHANNEL}`);
    listenerClient = client;
  } catch (error) {
    client.removeAllListeners('notification');
    client.removeAllListeners('error');
    client.removeAllListeners('end');
    client.release(true);
    throw error;
  }
};

const ensureSyncEventListener = async () => {
  if (listenerClient) {
    return;
  }
  if (listenerBootstrapPromise) {
    return listenerBootstrapPromise;
  }
  listenerBootstrapPromise = (async () => {
    await attachSyncEventListener();
  })();
  try {
    await listenerBootstrapPromise;
  } finally {
    listenerBootstrapPromise = null;
  }
};

export const emitSyncEvent = async (
  incomingConnectorId: string,
  eventType: string,
  payload: Record<string, any>,
) => {
  const result = await query<{ id: string; user_id: string }>(
    `WITH inserted AS (
       INSERT INTO sync_events (incoming_connector_id, event_type, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, incoming_connector_id
     ),
     event_meta AS (
       SELECT inserted.id::text AS id, ic.user_id
         FROM inserted
         INNER JOIN incoming_connectors ic ON ic.id = inserted.incoming_connector_id
     ),
     notifier AS (
       SELECT pg_notify($4, json_build_object('userId', event_meta.user_id, 'eventId', event_meta.id)::text)
         FROM event_meta
     )
     SELECT id, user_id
       FROM event_meta`,
    [incomingConnectorId, eventType, JSON.stringify(payload), SYNC_EVENTS_NOTIFY_CHANNEL],
  );

  const userId = result.rows[0]?.user_id;
  const eventId = toSafeEventId(result.rows[0]?.id);

  if (userId && eventId !== null) {
    dispatchSyncEventSignal({ userId, eventId });
  }

  if (!userId) {
    return;
  }

  void notifySubscribers(userId, {
    eventType,
    incomingConnectorId,
    payload,
  }).catch(() => {
    // best effort: keep sync path non-blocking on notification failures
  });
};

export const listSyncEvents = async (userId: string, since = 0, limit = 100) => {
  const safeSince = Number.isFinite(Number(since)) && Number(since) >= 0 ? Math.floor(Number(since)) : 0;
  const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(500, Math.floor(Number(limit)))
    : 100;

  const result = await query<any>(
    `SELECT se.id, se.incoming_connector_id as "incomingConnectorId", se.event_type as "eventType", se.payload, se.created_at as "createdAt"
     FROM sync_events se
     INNER JOIN incoming_connectors ic ON ic.id = se.incoming_connector_id
     WHERE se.id > $1 AND ic.user_id = $2
     ORDER BY se.id ASC
     LIMIT $3`,
    [safeSince, userId, safeLimit],
  );
  return result.rows;
};

export const waitForSyncEventSignal = async (
  userId: string,
  since = 0,
  timeoutMs = 25_000,
): Promise<SyncEventSignal | null> => {
  const safeSince = Number.isFinite(Number(since)) && Number(since) >= 0 ? Math.floor(Number(since)) : 0;
  const safeTimeout = Number.isFinite(Number(timeoutMs))
    ? Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(MIN_WAIT_TIMEOUT_MS, Math.floor(Number(timeoutMs))))
    : 25_000;

  try {
    await ensureSyncEventListener();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, Math.min(safeTimeout, 1_000)));
    return null;
  }

  const latestSignal = latestSignalByUser.get(userId);
  if (latestSignal && latestSignal.eventId > safeSince) {
    return latestSignal;
  }

  return new Promise((resolve) => {
    let settled = false;
    const waiters = waitersByUser.get(userId) ?? new Set<(signal: SyncEventSignal) => void>();
    waitersByUser.set(userId, waiters);

    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      waiters.delete(onSignal);
      if (waiters.size === 0) {
        waitersByUser.delete(userId);
      }
    };

    const onSignal = (signal: SyncEventSignal) => {
      if (signal.eventId <= safeSince) {
        return;
      }
      cleanup();
      resolve(signal);
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, safeTimeout);

    waiters.add(onSignal);

    const signalAfterSubscribe = latestSignalByUser.get(userId);
    if (signalAfterSubscribe && signalAfterSubscribe.eventId > safeSince) {
      onSignal(signalAfterSubscribe);
    }
  });
};

export const pruneSyncEvents = async (options?: {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
}) => {
  const toPositiveInt = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return Math.floor(parsed);
  };

  const retentionDays = toPositiveInt(options?.retentionDays, 14);
  const batchSize = toPositiveInt(options?.batchSize, 2000);
  const maxBatches = toPositiveInt(options?.maxBatches, 3);

  let pruned = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const deleteResult = await query<{ id: string }>(
      `WITH stale AS (
         SELECT id
           FROM sync_events
          WHERE created_at < (NOW() - make_interval(days => $1::int))
          ORDER BY id ASC
          LIMIT $2
       )
       DELETE FROM sync_events se
        USING stale
        WHERE se.id = stale.id
      RETURNING se.id`,
      [retentionDays, batchSize],
    );
    const deletedRows = deleteResult.rows.length;
    pruned += deletedRows;
    if (deletedRows < batchSize) {
      break;
    }
  }

  return { pruned };
};
