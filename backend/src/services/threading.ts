import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/pool.js';
import {
  GENERIC_SUBJECTS,
  normalizeSubject,
  subjectGenericKey,
  extractEmails,
  normalizeMessageId,
  messageIdVariants,
} from './threadingUtils.js';

const findThreadIdForLogicalMessage = async (
  incomingConnectorId: string,
  currentMessageId: string,
  gmailMessageId?: string | null,
  messageId?: string | null,
): Promise<string | null> => {
  if (gmailMessageId?.trim()) {
    const byGmailId = await query<{ thread_id: string | null }>(
      `SELECT thread_id
         FROM messages
        WHERE incoming_connector_id = $1
          AND id <> $2
          AND gmail_message_id = $3
          AND thread_id IS NOT NULL
        ORDER BY
          CASE UPPER(folder_path)
            WHEN 'INBOX' THEN 0
            WHEN 'SENT' THEN 1
            WHEN 'DRAFT' THEN 2
            WHEN 'STARRED' THEN 3
            WHEN 'IMPORTANT' THEN 4
            WHEN 'SPAM' THEN 5
            WHEN 'TRASH' THEN 6
            WHEN 'ALL' THEN 90
            ELSE 20
          END,
          received_at DESC NULLS LAST,
          updated_at DESC,
          id DESC
        LIMIT 1`,
      [incomingConnectorId, currentMessageId, gmailMessageId.trim()],
    );
    if (byGmailId.rows[0]?.thread_id) {
      return byGmailId.rows[0].thread_id;
    }
  }

  const variants = messageIdVariants(messageId);
  if (variants.length === 0) {
    return null;
  }
  const byMessageId = await query<{ thread_id: string | null }>(
    `SELECT thread_id
       FROM messages
      WHERE incoming_connector_id = $1
        AND id <> $2
        AND LOWER(COALESCE(message_id, '')) = ANY($3::text[])
        AND thread_id IS NOT NULL
      ORDER BY
        CASE UPPER(folder_path)
          WHEN 'INBOX' THEN 0
          WHEN 'SENT' THEN 1
          WHEN 'DRAFT' THEN 2
          WHEN 'STARRED' THEN 3
          WHEN 'IMPORTANT' THEN 4
          WHEN 'SPAM' THEN 5
          WHEN 'TRASH' THEN 6
          WHEN 'ALL' THEN 90
          ELSE 20
        END,
        received_at DESC NULLS LAST,
        updated_at DESC,
        id DESC
      LIMIT 1`,
    [incomingConnectorId, currentMessageId, variants],
  );
  return byMessageId.rows[0]?.thread_id ?? null;
};

const assignThreadIdForLogicalMessage = async (
  currentMessageId: string,
  incomingConnectorId: string,
  threadId: string,
  gmailMessageId?: string | null,
  messageId?: string | null,
  normalizedSubjectHint?: string | null,
) => {
  await query('UPDATE messages SET thread_id = $2 WHERE id = $1', [currentMessageId, threadId]);

  const conditions: string[] = [];
  const values: any[] = [incomingConnectorId, threadId, currentMessageId];
  if (gmailMessageId?.trim()) {
    values.push(gmailMessageId.trim());
    conditions.push(`gmail_message_id = $${values.length}`);
  }
  const variants = messageIdVariants(messageId);
  if (variants.length > 0) {
    values.push(variants);
    conditions.push(`LOWER(COALESCE(message_id, '')) = ANY($${values.length}::text[])`);
  }

  if (conditions.length === 0) {
    return;
  }

  // Scope guard: only propagate thread_id to siblings that share the same
  // normalized subject (or have no subject yet).  This prevents Message-ID
  // collisions from two genuinely different conversations from merging.
  let subjectGuard = '';
  if (normalizedSubjectHint) {
    values.push(normalizedSubjectHint);
    subjectGuard = ` AND (normalized_subject IS NULL OR normalized_subject = $${values.length})`;
  }

  await query(
    `UPDATE messages
        SET thread_id = $2
      WHERE incoming_connector_id = $1
        AND id <> $3
        AND (${conditions.join(' OR ')})
        ${subjectGuard}`,
    values,
  );
};

export const computeThreadForMessage = async (message: {
  id: string;
  incomingConnectorId: string;
  userId: string;
  gmailMessageId?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  referencesHeader?: string | null;
  subject?: string | null;
  fromHeader?: string | null;
  toHeader?: string | null;
  receivedAt?: string | Date | null;
}) => {
  const normalizedSubject = normalizeSubject(message.subject ?? '');
  const normalizedSubjectGenericKey = subjectGenericKey(normalizedSubject);
  const hasReplyPrefix = /^\s*(re|fwd|fw):/i.test(message.subject ?? '');
  const hasExplicitThreadHeaders = Boolean(message.inReplyTo?.trim() || message.referencesHeader?.trim());
  await query('UPDATE messages SET normalized_subject = $2 WHERE id = $1', [message.id, normalizedSubject]);

  const canonicalThreadId = await findThreadIdForLogicalMessage(
    message.incomingConnectorId,
    message.id,
    message.gmailMessageId,
    message.messageId,
  );
  if (canonicalThreadId) {
    await assignThreadIdForLogicalMessage(
      message.id,
      message.incomingConnectorId,
      canonicalThreadId,
      message.gmailMessageId,
      message.messageId,
      normalizedSubject,
    );
    return canonicalThreadId;
  }

  const inReplyVariants = messageIdVariants(message.inReplyTo);
  if (inReplyVariants.length > 0) {
    const inReplyMatch = await query<{ thread_id: string }>(
      `SELECT thread_id
       FROM messages m
       INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
       WHERE LOWER(COALESCE(m.message_id, '')) = ANY($1::text[]) AND ic.user_id = $2
       ORDER BY m.received_at ASC
       LIMIT 1`,
      [inReplyVariants, message.userId],
    );
    if (inReplyMatch.rows[0]?.thread_id) {
      const threadId = inReplyMatch.rows[0].thread_id;
      await assignThreadIdForLogicalMessage(
        message.id,
        message.incomingConnectorId,
        threadId,
        message.gmailMessageId,
        message.messageId,
        normalizedSubject,
      );
      return threadId;
    }
  }

  if (message.referencesHeader?.trim()) {
    const refs = message.referencesHeader
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean);

    // Collect all variants for all references in one go, then do a single
    // batched ANY() query instead of N sequential per-reference queries.
    const allRefVariants = refs.flatMap((ref) => messageIdVariants(ref));
    if (allRefVariants.length > 0) {
      const referencesMatch = await query<{ thread_id: string; message_id: string; received_at: string }>(
        `SELECT LOWER(COALESCE(m.message_id, '')) as message_id, m.thread_id, m.received_at
           FROM messages m
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
          WHERE LOWER(COALESCE(m.message_id, '')) = ANY($1::text[])
            AND ic.user_id = $2
            AND m.thread_id IS NOT NULL
          ORDER BY m.received_at ASC`,
        [allRefVariants, message.userId],
      );

      if (referencesMatch.rows.length > 0) {
        // Prefer the most direct parent: iterate refs from last to first and
        // pick the first ref that has a matching row.
        let threadId: string | null = null;
        for (let refIdx = refs.length - 1; refIdx >= 0 && !threadId; refIdx--) {
          const variants = new Set(messageIdVariants(refs[refIdx]));
          const match = referencesMatch.rows.find((row) => variants.has(row.message_id));
          if (match) {
            threadId = match.thread_id;
          }
        }
        if (threadId) {
          await assignThreadIdForLogicalMessage(
            message.id,
            message.incomingConnectorId,
            threadId,
            message.gmailMessageId,
            message.messageId,
            normalizedSubject,
          );
          return threadId;
        }
      }
    }
  }

  const subjectTooGeneric = !normalizedSubject
    || normalizedSubjectGenericKey.length < 4
    || GENERIC_SUBJECTS.has(normalizedSubjectGenericKey)
    || (!hasExplicitThreadHeaders && !hasReplyPrefix);

  if (subjectTooGeneric) {
    const fallbackThreadId = uuidv4();
    await assignThreadIdForLogicalMessage(
      message.id,
      message.incomingConnectorId,
      fallbackThreadId,
      message.gmailMessageId,
      message.messageId,
      normalizedSubject,
    );
    return fallbackThreadId;
  }

  // Subject-based fallback: tighter 7-day window, require participant
  // overlap (current sender in candidate's to/cc, or vice versa) rather
  // than just same-sender.  This prevents unrelated emails with the same
  // subject from merging into a single thread.
  const candidateThreads = await query<{
    thread_id: string;
    from_header: string | null;
    to_header: string | null;
  }>(
    `SELECT thread_id
            , from_header
            , to_header
     FROM messages
     WHERE incoming_connector_id = $1
       AND normalized_subject = $2
       AND id <> $4
       AND thread_id IS NOT NULL
       AND ($3::timestamptz IS NULL OR received_at BETWEEN $3::timestamptz - INTERVAL '7 days' AND $3::timestamptz + INTERVAL '7 days')
     ORDER BY received_at DESC
     LIMIT 50`,
    [
      message.incomingConnectorId,
      normalizedSubject,
      message.receivedAt ? new Date(message.receivedAt).toISOString() : null,
      message.id,
    ],
  );

  const currentFrom = extractEmails(message.fromHeader);
  const currentTo = extractEmails(message.toHeader);
  const currentAllParticipants = new Set([...currentFrom, ...currentTo]);

  for (const candidate of candidateThreads.rows) {
    const candidateFrom = extractEmails(candidate.from_header);
    const candidateTo = extractEmails(candidate.to_header);
    const candidateAllParticipants = new Set([...candidateFrom, ...candidateTo]);

    // Require at least one participant overlap between the two messages.
    // This catches both reply directions: A→B then B→A.
    let hasOverlap = false;
    for (const participant of currentAllParticipants) {
      if (candidateAllParticipants.has(participant)) {
        hasOverlap = true;
        break;
      }
    }
    if (!hasOverlap && currentAllParticipants.size > 0 && candidateAllParticipants.size > 0) {
      continue;
    }

    const threadId = candidate.thread_id;
    await assignThreadIdForLogicalMessage(
      message.id,
      message.incomingConnectorId,
      threadId,
      message.gmailMessageId,
      message.messageId,
      normalizedSubject,
    );
    return threadId;
  }

  const fallbackThreadId = uuidv4();
  await assignThreadIdForLogicalMessage(
    message.id,
    message.incomingConnectorId,
    fallbackThreadId,
    message.gmailMessageId,
    message.messageId,
    normalizedSubject,
  );
  return fallbackThreadId;
};

export const listThreadMessages = async (userId: string, threadId: string, connectorId?: string) => {
  const values: any[] = [threadId, userId];
  let connectorPredicate = '';
  if (connectorId) {
    values.push(connectorId);
    connectorPredicate = ` AND m.incoming_connector_id = $${values.length}`;
  }
  const result = await query<any>(
    `SELECT dedup.id,
            dedup."incomingConnectorId",
            dedup."messageId",
            dedup.subject,
            dedup."fromHeader",
            dedup."toHeader",
            dedup."ccHeader",
            dedup."bccHeader",
            dedup."folderPath",
            dedup."rawBlobKey",
            dedup."bodyText",
            dedup."bodyHtml",
            dedup.snippet,
            dedup."receivedAt",
            dedup."isRead",
            dedup."isStarred",
            dedup."threadId",
            dedup."inReplyTo",
            dedup."referencesHeader",
            dedup.uid,
            dedup."createdAt",
            dedup."updatedAt"
       FROM (
         SELECT m.id,
                m.incoming_connector_id as "incomingConnectorId",
                m.message_id as "messageId",
                m.subject,
                m.from_header as "fromHeader",
                m.to_header as "toHeader",
                (m.raw_headers ->> 'cc') as "ccHeader",
                (m.raw_headers ->> 'bcc') as "bccHeader",
                m.folder_path as "folderPath",
                m.raw_blob_key as "rawBlobKey",
                m.body_text as "bodyText",
                m.body_html as "bodyHtml",
                m.snippet,
                m.received_at as "receivedAt",
                m.is_read as "isRead",
                m.is_starred as "isStarred",
                m.thread_id as "threadId",
                m.in_reply_to as "inReplyTo",
                m.references_header as "referencesHeader",
                m.uid,
                m.created_at as "createdAt",
                m.updated_at as "updatedAt",
                ROW_NUMBER() OVER (
                  PARTITION BY m.incoming_connector_id, LOWER(COALESCE(NULLIF(m.gmail_message_id, ''), NULLIF(m.message_id, ''), m.id::text))
                  ORDER BY
                    CASE UPPER(m.folder_path)
                      WHEN 'INBOX' THEN 0
                      WHEN 'SENT' THEN 1
                      WHEN 'DRAFT' THEN 2
                      WHEN 'STARRED' THEN 3
                      WHEN 'IMPORTANT' THEN 4
                      WHEN 'SPAM' THEN 5
                      WHEN 'TRASH' THEN 6
                      WHEN 'ALL' THEN 90
                      ELSE 20
                    END,
                    m.received_at DESC NULLS LAST,
                    m.updated_at DESC
                ) AS dedupe_rank
           FROM messages m
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
          WHERE m.thread_id = $1
            AND ic.user_id = $2
            ${connectorPredicate}
       ) dedup
      WHERE dedup.dedupe_rank = 1
      ORDER BY dedup."receivedAt" DESC`,
    values,
  );
  return result.rows;
};
