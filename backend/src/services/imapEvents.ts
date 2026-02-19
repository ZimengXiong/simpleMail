import { query } from '../db/pool.js';
import { notifySubscribers } from './push.js';

export const emitSyncEvent = async (
  incomingConnectorId: string,
  eventType: string,
  payload: Record<string, any>,
) => {
  await query(
    `INSERT INTO sync_events (incoming_connector_id, event_type, payload)
     VALUES ($1, $2, $3::jsonb)`,
    [incomingConnectorId, eventType, JSON.stringify(payload)],
  );

  const userResult = await query<{ user_id: string }>(
    'SELECT user_id FROM incoming_connectors WHERE id = $1',
    [incomingConnectorId],
  );
  const userId = userResult.rows[0]?.user_id;
  if (!userId) {
    return;
  }

  await notifySubscribers(userId, {
    eventType,
    incomingConnectorId,
    payload,
  }).catch(() => {
    // best effort: keep sync path non-blocking on notification failures
  });
};

export const listSyncEvents = async (userId: string, since = 0, limit = 100) => {
  const result = await query<any>(
    `SELECT se.id, se.incoming_connector_id as "incomingConnectorId", se.event_type as "eventType", se.payload, se.created_at as "createdAt"
     FROM sync_events se
     INNER JOIN incoming_connectors ic ON ic.id = se.incoming_connector_id
     WHERE se.id > $1 AND ic.user_id = $2
     ORDER BY se.id ASC
     LIMIT $3`,
    [since, userId, limit],
  );
  return result.rows;
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
