import { query } from '../db/pool.js';

export type LabelSource = 'system' | 'user';

export interface LabelRecord {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
}

export interface MessageLabelRecord {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
}

type LabelInput = {
  userId: string;
  name: string;
  key?: string;
  isSystem?: boolean;
  color?: string | null;
};

const SYSTEM_LABELS = [
  { key: 'all', name: 'All Mail' },
  { key: 'trash', name: 'Trash' },
  { key: 'spam', name: 'Spam' },
  { key: 'snoozed', name: 'Snoozed' },
  { key: 'starred', name: 'Starred' },
] as const;

const labelSelect = `
  SELECT id, key, name, is_system as "isSystem"
    FROM labels
   WHERE user_id = $1`;

const sanitizeKey = (value: string) => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/[_-]{2,}/g, '_')
    .replace(/^[_\-.]+|[_\-.]+$/g, '');

  return normalized.slice(0, 96);
};

export const ensureSystemLabelsForUser = async (userId: string) => {
  for (const label of SYSTEM_LABELS) {
    await query(
      `INSERT INTO labels (user_id, key, name, is_system)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (user_id, key) DO UPDATE
       SET is_system = TRUE,
           name = EXCLUDED.name`,
      [userId, label.key, label.name],
    );
  }
};

export const listLabels = async (userId: string): Promise<LabelRecord[]> => {
  await ensureSystemLabelsForUser(userId);
  const result = await query<LabelRecord>(`
    ${labelSelect}
      AND is_archived = FALSE
    ORDER BY is_system DESC, name ASC
  `, [userId]);
  return result.rows;
};

export const createUserLabel = async (payload: LabelInput) => {
  const userId = payload.userId;
  await ensureSystemLabelsForUser(userId);
  const requestedKey = sanitizeKey(payload.key ?? payload.name);
  if (!requestedKey) {
    throw new Error('invalid label key');
  }
  const result = await query<{ id: string }>(`
    INSERT INTO labels (user_id, key, name, is_system)
    VALUES ($1, $2, $3, FALSE)
    ON CONFLICT (user_id, key) DO UPDATE
    SET name = EXCLUDED.name
    RETURNING id
  `, [userId, requestedKey, payload.name]);
  return { id: result.rows[0].id };
};

export const getLabel = async (userId: string, labelId: string): Promise<LabelRecord | null> => {
  await ensureSystemLabelsForUser(userId);
  const result = await query<LabelRecord>(`
    ${labelSelect}
      AND id = $2
      AND is_archived = FALSE
  `, [userId, labelId]);
  return result.rows[0] ?? null;
};

export const getLabelByKey = async (userId: string, key: string): Promise<LabelRecord | null> => {
  await ensureSystemLabelsForUser(userId);
  const result = await query<LabelRecord>(`
    ${labelSelect}
      AND key = $2
      AND is_archived = FALSE
  `, [userId, key]);
  return result.rows[0] ?? null;
};

export const updateLabelName = async (userId: string, labelId: string, name: string) => {
  await query(
    `UPDATE labels
       SET name = $3, updated_at = NOW()
     WHERE id = $1
       AND user_id = $2
       AND is_system = FALSE`,
    [labelId, userId, name],
  );
};

export const archiveLabel = async (userId: string, labelId: string) => {
  await query(
    `UPDATE labels
       SET is_archived = TRUE, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND is_system = FALSE`,
    [labelId, userId],
  );
};

export const listMessageLabels = async (userId: string, messageId: string): Promise<MessageLabelRecord[]> => {
  const result = await query<MessageLabelRecord>(`
    SELECT l.id, l.key, l.name, l.is_system as "isSystem"
      FROM message_labels ml
      INNER JOIN labels l ON l.id = ml.label_id
      INNER JOIN messages m ON m.id = ml.message_id
      INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
     WHERE m.id = $1
       AND ic.user_id = $2
       AND l.is_archived = FALSE
     ORDER BY l.name
  `, [messageId, userId]);
  return result.rows;
};

export const addLabelsToMessage = async (userId: string, messageId: string, labelIds: string[]) => {
  if (labelIds.length === 0) {
    return;
  }

  const placeholders = labelIds.map((_, index) => `$${index + 3}`).join(', ');
  await query(`
    INSERT INTO message_labels (message_id, label_id)
    SELECT $1, l.id
      FROM labels l
      INNER JOIN messages m ON m.id = $1
      INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
     WHERE l.user_id = ic.user_id
       AND l.id IN (${placeholders})
    ON CONFLICT DO NOTHING
  `, [messageId, userId, ...labelIds]);
};

const addLabelsByKey = async (userId: string, messageId: string, keys: string[]) => {
  if (keys.length === 0) {
    return;
  }

  const placeholders = keys.map((_, index) => `$${index + 3}`).join(', ');
  await query(`
    INSERT INTO message_labels (message_id, label_id)
    SELECT $1, l.id
      FROM labels l
      INNER JOIN messages m ON m.id = $1
      INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
     WHERE l.user_id = ic.user_id
       AND l.key = ANY(ARRAY[${placeholders}]::text[])
    ON CONFLICT DO NOTHING
  `, [messageId, userId, ...keys]);
};

export const addLabelsToMessageByKey = async (userId: string, messageId: string, keys: string[]) => {
  return addLabelsByKey(userId, messageId, keys);
};

export const removeLabelsFromMessage = async (userId: string, messageId: string, labelIds: string[]) => {
  if (labelIds.length === 0) {
    return;
  }

  await query(`
    DELETE FROM message_labels ml
    USING labels l, messages m, incoming_connectors ic
    WHERE ml.message_id = $1
      AND ml.label_id = l.id
      AND l.id IN (SELECT UNNEST($2::uuid[]))
      AND l.user_id = ic.user_id
      AND m.id = ml.message_id
      AND ic.id = m.incoming_connector_id
      AND ic.user_id = $3
  `, [messageId, labelIds, userId]);
};

export const removeLabelsFromMessageByKey = async (userId: string, messageId: string, keys: string[]) => {
  if (keys.length === 0) {
    return;
  }

  await query(`
    DELETE FROM message_labels ml
    USING labels l, messages m, incoming_connectors ic
    WHERE ml.message_id = $1
      AND ml.label_id = l.id
      AND l.key = ANY($2::text[])
      AND l.user_id = ic.user_id
      AND m.id = ml.message_id
      AND ic.id = m.incoming_connector_id
      AND ic.user_id = $3
  `, [messageId, keys, userId]);
};

export const syncSystemLabelsForMessage = async (
  userId: string,
  messageId: string,
  folderPath: string,
  isStarred: boolean,
) => {
  await ensureSystemLabelsForUser(userId);

  const normalizedFolder = String(folderPath ?? '').toLowerCase();
  const desiredKeys = new Set<string>(['all']);
  if (normalizedFolder.includes('trash')) {
    desiredKeys.add('trash');
  }
  if (normalizedFolder.includes('spam')) {
    desiredKeys.add('spam');
  }
  if (normalizedFolder.includes('snoozed')) {
    desiredKeys.add('snoozed');
  }
  if (isStarred) {
    desiredKeys.add('starred');
  }
  const existing = await query<{ key: string }>(
    `SELECT l.key
       FROM message_labels ml
       INNER JOIN labels l ON l.id = ml.label_id
      WHERE ml.message_id = $1
        AND l.user_id = $2
        AND l.is_system = TRUE`,
    [messageId, userId],
  );
  const existingKeys = new Set(existing.rows.map((row) => row.key));
  const toRemove = [...existingKeys].filter((key) => !desiredKeys.has(key));
  if (toRemove.length > 0) {
    await query(
      `DELETE FROM message_labels ml
        USING labels l
       WHERE ml.message_id = $1
         AND ml.label_id = l.id
         AND l.user_id = $2
         AND l.is_system = TRUE
         AND l.key = ANY($3::text[])`,
      [messageId, userId, toRemove],
    );
  }
  const toAdd = [...desiredKeys].filter((key) => !existingKeys.has(key));
  for (const key of toAdd) {
    await query(
      `INSERT INTO message_labels (message_id, label_id)
       SELECT $1, l.id
         FROM labels l
        WHERE l.user_id = $2
          AND l.key = $3
       ON CONFLICT DO NOTHING`,
      [messageId, userId, key],
    );
  }
};
