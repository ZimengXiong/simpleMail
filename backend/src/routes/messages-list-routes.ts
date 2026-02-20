import { FastifyInstance } from 'fastify';
import {
  getUserId,
  query,
  parseBooleanParam,
  parseNonNegativeIntWithCap,
  parsePositiveIntWithCap,
  getIncomingConnectorGmailLikeCached,
  normalizeConnectorFolderFilterWithConnector,
  buildGmailFolderPredicatesWithConnector,
  logicalMessageKeySql,
  mailboxReadPreferenceRankSql,
  MAX_MESSAGES_PAGE_LIMIT,
  MAX_MESSAGES_OFFSET,
  MAX_SEND_ONLY_SEARCH_CHARS,
} from './messages-context.js';

export const registerMessageListRoutes = async (app: FastifyInstance) => {
  app.get('/api/messages', async (req) => {
    const userId = getUserId(req);
    const queryObject = req.query as any;
    const limit = parsePositiveIntWithCap(queryObject?.limit, 50, MAX_MESSAGES_PAGE_LIMIT);
    const offset = parseNonNegativeIntWithCap(queryObject?.offset, 0, MAX_MESSAGES_OFFSET);
    const connectorId = String(queryObject?.connectorId ?? '').trim();
    const resolvedConnectorIsGmailLike = connectorId
      ? await getIncomingConnectorGmailLikeCached(userId, connectorId)
      : null;
    const resolvedConnector = connectorId && resolvedConnectorIsGmailLike !== null
      ? (resolvedConnectorIsGmailLike ? { provider: 'gmail' } : { provider: 'imap' })
      : null;
    const folder = normalizeConnectorFolderFilterWithConnector(
      queryObject?.folder as string | undefined,
      resolvedConnector,
    );
    const normalizedFolder = String(folder ?? '').trim().toUpperCase();
    const folderFilter = buildGmailFolderPredicatesWithConnector(
      queryObject?.folder as string | undefined,
      resolvedConnector,
    );
    const label = queryObject?.label;
    const labelId = queryObject?.labelId;
    const hasAttachment = parseBooleanParam(queryObject?.hasAttachment);
    const isStarred = parseBooleanParam(queryObject?.isStarred);

    const predicates = ['ic.user_id = $1'];
    const values: any[] = [userId];
    if (normalizedFolder !== 'STARRED') {
      if (folderFilter.candidates && folderFilter.candidates.length > 0) {
        if (folderFilter.candidates.length === 1) {
          values.push(folderFilter.candidates[0]);
          predicates.push(`m.folder_path_norm = $${values.length}`);
        } else {
          values.push(folderFilter.candidates);
          predicates.push(`m.folder_path_norm = ANY($${values.length}::text[])`);
        }
      } else if (folder) {
        values.push(String(folder).toUpperCase());
        predicates.push(`m.folder_path_norm = $${values.length}`);
      }
    }
    if (connectorId) {
      values.push(connectorId);
      predicates.push(`m.incoming_connector_id = $${values.length}`);
    }
    if (label && typeof label === 'string') {
      const normalizedLabel = label.toLowerCase();
      values.push(normalizedLabel);
      predicates.push(`EXISTS (
         SELECT 1 FROM message_labels ml
         JOIN labels l ON l.id = ml.label_id
        WHERE ml.message_id = m.id
          AND l.user_id = $1
          AND l.key = $${values.length}
      )`);
    }
    if (labelId && typeof labelId === 'string') {
      values.push(labelId);
      predicates.push(`EXISTS (
         SELECT 1 FROM message_labels ml
        WHERE ml.message_id = m.id
          AND ml.label_id = $${values.length}
      )`);
    }
    if (typeof isStarred === 'boolean') {
      predicates.push(`m.is_starred = ${isStarred ? 'TRUE' : 'FALSE'}`);
    }
    if (typeof hasAttachment === 'boolean') {
      if (hasAttachment) {
        predicates.push(`EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)`);
      } else {
        predicates.push(`NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)`);
      }
    }
    if (normalizedFolder === 'STARRED') {
      predicates.push('m.is_starred = TRUE');
    }
    const shouldDedupeLogicalMessages = !folder || folderFilter.dedupeLogicalMessages;
    const dedupeKeyExpr = logicalMessageKeySql('m');

    const countValues = [...values];
    const rowsValues = [...values, limit, offset];

    const [countResult, result] = await Promise.all([
      shouldDedupeLogicalMessages
        ? query<{ count: string }>(
            `SELECT COUNT(*)::int as count
               FROM (
                 SELECT DISTINCT m.incoming_connector_id, ${dedupeKeyExpr}
                   FROM messages m
                   INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
                  WHERE ${predicates.join(' AND ')}
               ) dedup`,
            countValues,
          )
        : query<{ count: string }>(
            `SELECT COUNT(*)::int as count
               FROM messages m
               INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
              WHERE ${predicates.join(' AND ')}`,
            countValues,
          ),
      shouldDedupeLogicalMessages
        ? query<any>(
            `WITH dedup AS (
             SELECT DISTINCT ON (m.incoming_connector_id, ${dedupeKeyExpr})
                    m.id,
                    m.incoming_connector_id as "incomingConnectorId",
                    m.message_id as "messageId",
                    m.subject,
                    m.from_header as "fromHeader",
                    m.to_header as "toHeader",
                    m.folder_path as "folderPath",
                    m.snippet,
                    m.received_at as "receivedAt",
                    m.is_read as "isRead",
                    m.is_starred as "isStarred",
                    m.thread_id as "threadId"
               FROM messages m
               INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
              WHERE ${predicates.join(' AND ')}
              ORDER BY
                m.incoming_connector_id,
                ${dedupeKeyExpr},
                ${mailboxReadPreferenceRankSql},
                m.received_at DESC NULLS LAST,
                m.updated_at DESC,
                m.id DESC
           ),
           paged AS (
             SELECT *
               FROM dedup
              ORDER BY "receivedAt" DESC, id DESC
              LIMIT $${rowsValues.length - 1} OFFSET $${rowsValues.length}
           ),
           thread_ids AS (
             SELECT DISTINCT
                    p."incomingConnectorId" as incoming_connector_id,
                    p."threadId" as thread_id
               FROM paged p
              WHERE p."threadId" IS NOT NULL
           ),
           thread_stats AS (
             SELECT m3.incoming_connector_id,
                    m3.thread_id,
                    COUNT(DISTINCT ${logicalMessageKeySql('m3')})::int as thread_count,
                    COALESCE(
                      jsonb_agg(DISTINCT m3.from_header) FILTER (WHERE m3.from_header IS NOT NULL),
                      '[]'::jsonb
                    ) as participants
               FROM messages m3
               INNER JOIN thread_ids ti
                 ON ti.incoming_connector_id = m3.incoming_connector_id
                AND ti.thread_id = m3.thread_id
              GROUP BY m3.incoming_connector_id, m3.thread_id
           )
           SELECT p.id,
                  p."incomingConnectorId",
                  p."messageId",
                  p.subject,
                  p."fromHeader",
                  p."toHeader",
                  p."folderPath",
                  p.snippet,
                  p."receivedAt",
                  p."isRead",
                  p."isStarred",
                  p."threadId",
                  CASE
                    WHEN p."threadId" IS NULL THEN 1
                    ELSE COALESCE(ts.thread_count, 1)
                  END as "threadCount",
                  CASE
                    WHEN p."threadId" IS NULL THEN
                      CASE
                        WHEN p."fromHeader" IS NULL THEN '[]'::jsonb
                        ELSE jsonb_build_array(p."fromHeader")
                      END
                    ELSE COALESCE(ts.participants, '[]'::jsonb)
                  END as participants
             FROM paged p
             LEFT JOIN thread_stats ts
               ON ts.incoming_connector_id = p."incomingConnectorId"
              AND ts.thread_id = p."threadId"
            ORDER BY p."receivedAt" DESC, p.id DESC`,
            rowsValues,
          )
        : query<any>(
            `SELECT m.id,
                  m.incoming_connector_id as "incomingConnectorId",
                  m.message_id as "messageId",
                  m.subject,
                  m.from_header as "fromHeader",
                  m.to_header as "toHeader",
                  m.folder_path as "folderPath",
                  m.snippet,
                  m.received_at as "receivedAt",
                  m.is_read as "isRead",
                  m.is_starred as "isStarred",
                  m.thread_id as "threadId",
                  1 as "threadCount",
                  jsonb_build_array(m.from_header) as participants
            FROM messages m
            INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
           WHERE ${predicates.join(' AND ')}
            ORDER BY m.received_at DESC
            LIMIT $${rowsValues.length - 1} OFFSET $${rowsValues.length}`,
            rowsValues,
          ),
    ]);
    return {
      messages: result.rows,
      totalCount: Number(countResult.rows[0]?.count ?? 0),
    };
  });

  app.get('/api/messages/send-only', async (req, reply) => {
    const userId = getUserId(req);
    const queryObject = req.query as any;
    const emailAddress = String(queryObject?.emailAddress ?? '').trim().toLowerCase();
    if (!emailAddress) {
      return reply.code(400).send({ error: 'emailAddress required' });
    }

    const folderToken = String(queryObject?.folder ?? 'OUTBOX').trim().toUpperCase();
    const normalizedFolder = folderToken === 'SENT' ? 'SENT' : 'OUTBOX';
    const statuses = normalizedFolder === 'SENT'
      ? ['succeeded']
      : ['pending', 'processing', 'failed'];
    const searchText = String(queryObject?.q ?? '').trim();
    if (searchText.length > MAX_SEND_ONLY_SEARCH_CHARS) {
      return reply.code(400).send({ error: `q exceeds ${MAX_SEND_ONLY_SEARCH_CHARS} characters` });
    }
    const limit = parsePositiveIntWithCap(queryObject?.limit, 50, MAX_MESSAGES_PAGE_LIMIT);
    const offset = parseNonNegativeIntWithCap(queryObject?.offset, 0, MAX_MESSAGES_OFFSET);

    const values: any[] = [userId, emailAddress, statuses];
    const predicates = [
      's.user_id = $1',
      'LOWER(i.email_address) = $2',
      's.status = ANY($3::text[])',
    ];

    if (searchText) {
      values.push(`%${searchText}%`);
      predicates.push(`(
        COALESCE(s.request_meta->>'subject', '') ILIKE $${values.length}
        OR COALESCE(s.request_meta->>'to', '') ILIKE $${values.length}
      )`);
    }

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*)::int as count
         FROM send_idempotency s
         INNER JOIN identities i ON i.id = s.identity_id
        WHERE ${predicates.join(' AND ')}`,
      values,
    );

    values.push(limit, offset);
    const rowsResult = await query<any>(
      `SELECT s.idempotency_key as "idempotencyKey",
              s.status,
              s.error_message as "sendError",
              s.result,
              s.request_meta as "requestMeta",
              s.updated_at as "updatedAt",
              i.display_name as "displayName",
              i.email_address as "emailAddress"
         FROM send_idempotency s
         INNER JOIN identities i ON i.id = s.identity_id
        WHERE ${predicates.join(' AND ')}
        ORDER BY s.updated_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    const messages = rowsResult.rows.map((row: any) => {
      const requestMeta = (row.requestMeta ?? {}) as Record<string, any>;
      const toHeader = String(requestMeta.to ?? '').trim();
      const bodyText = String(requestMeta.bodyText ?? '').trim();
      const sendError = row.sendError ? String(row.sendError) : null;
      const statusLabel = String(row.status ?? '').toUpperCase();
      const fallbackSnippet = normalizedFolder === 'OUTBOX'
        ? `Outbox (${statusLabel.toLowerCase()})`
        : `Sent (${statusLabel.toLowerCase()})`;
      const snippetSource = sendError ?? bodyText ?? '';
      const snippet = (snippetSource.trim() || fallbackSnippet).slice(0, 220);

      return {
        id: `${normalizedFolder}:${row.idempotencyKey}`,
        incomingConnectorId: 'send-only',
        messageId: String(row?.result?.messageId ?? row.idempotencyKey),
        subject: String(requestMeta.subject ?? '').trim() || '(no subject)',
        fromHeader: `${row.displayName || row.emailAddress} <${row.emailAddress}>`,
        toHeader: toHeader || null,
        folderPath: normalizedFolder,
        snippet,
        bodyText: bodyText || null,
        bodyHtml: null,
        receivedAt: row.updatedAt,
        isRead: true,
        isStarred: false,
        threadId: null,
        threadCount: 1,
        participants: toHeader ? [toHeader] : [],
        sendStatus: row.status,
        sendError,
        sendOnlyNoResponses: true,
      };
    });

    return {
      messages,
      totalCount: Number(countResult.rows[0]?.count ?? 0),
    };
  });
};
