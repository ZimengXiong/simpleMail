import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/pool.js';

const normalizeSubject = (subject = ''): string => {
  return subject
    .replace(/^\s*(re|fwd|fw):\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
};

export const computeThreadForMessage = async (message: {
  id: string;
  incomingConnectorId: string;
  userId: string;
  messageId?: string | null;
  inReplyTo?: string | null;
  referencesHeader?: string | null;
  subject?: string | null;
}) => {
  const normalizedSubject = normalizeSubject(message.subject ?? '');
  await query('UPDATE messages SET normalized_subject = $2 WHERE id = $1', [message.id, normalizedSubject]);

  if (message.inReplyTo?.trim()) {
    const inReplyMatch = await query<{ thread_id: string }>(
      `SELECT thread_id
       FROM messages m
       INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
       WHERE m.message_id = $1 AND ic.user_id = $2
       ORDER BY m.received_at ASC
       LIMIT 1`,
      [message.inReplyTo.trim(), message.userId],
    );
    if (inReplyMatch.rows[0]?.thread_id) {
      const threadId = inReplyMatch.rows[0].thread_id;
      await query('UPDATE messages SET thread_id = $2 WHERE id = $1', [message.id, threadId]);
      return threadId;
    }
  }

  if (message.referencesHeader?.trim()) {
    const refs = message.referencesHeader
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean);
    const candidate = refs[refs.length - 1];
    if (candidate) {
    const referencesMatch = await query<{ thread_id: string }>(
      `SELECT thread_id
       FROM messages m
       INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
       WHERE m.message_id = $1 AND ic.user_id = $2
       ORDER BY m.received_at ASC
       LIMIT 1`,
      [candidate, message.userId],
    );
      if (referencesMatch.rows[0]?.thread_id) {
        const threadId = referencesMatch.rows[0].thread_id;
        await query('UPDATE messages SET thread_id = $2 WHERE id = $1', [message.id, threadId]);
        return threadId;
      }
    }
  }

  const subjectMatch = await query<{ thread_id: string }>(
    `SELECT thread_id
     FROM messages
     WHERE incoming_connector_id = $1
       AND normalized_subject = $2
       AND thread_id IS NOT NULL
     ORDER BY received_at ASC
     LIMIT 1`,
    [message.incomingConnectorId, normalizedSubject],
  );

  if (subjectMatch.rows[0]?.thread_id) {
    const threadId = subjectMatch.rows[0].thread_id;
    await query('UPDATE messages SET thread_id = $2 WHERE id = $1', [message.id, threadId]);
    return threadId;
  }

  const fallbackThreadId = uuidv4();
  await query('UPDATE messages SET thread_id = $2 WHERE id = $1', [message.id, fallbackThreadId]);
  return fallbackThreadId;
};

export const listThreadMessages = async (userId: string, threadId: string) => {
  const result = await query<any>(
    `SELECT *
       FROM messages m
       INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
      WHERE m.thread_id = $1 AND ic.user_id = $2
      ORDER BY m.received_at DESC`,
    [threadId, userId],
  );
  return result.rows;
};
