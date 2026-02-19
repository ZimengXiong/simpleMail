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
    `SELECT id, incoming_connector_id as "incomingConnectorId", event_type as "eventType", payload, created_at as "createdAt"
     FROM sync_events se
     INNER JOIN incoming_connectors ic ON ic.id = se.incoming_connector_id
     WHERE se.id > $1 AND ic.user_id = $2
     ORDER BY se.id ASC
     LIMIT $3`,
    [since, userId, limit],
  );
  return result.rows;
};
