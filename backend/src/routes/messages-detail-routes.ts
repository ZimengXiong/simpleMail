import { FastifyInstance } from 'fastify';
import {
  getUserId,
  query,
  blobStore,
  sanitizeDispositionFilename,
  parseTrimmedStringArrayWithCap,
  assertUuidList,
  listThreadMessages,
  normalizeMailboxInput,
  isArchiveMoveTarget,
  applyThreadMessageActions,
  setMessageReadState,
  setMessageStarredState,
  moveMessageInMailbox,
  deleteMessageFromMailbox,
  clearSearchCachesForUser,
} from './messages-context.js';

export const registerMessageDetailRoutes = async (app: FastifyInstance) => {
  app.get('/api/messages/thread/:threadId', async (req) => {
    const userId = getUserId(req);
    const threadId = String((req.params as any).threadId);
    const connectorId = (req.query as any)?.connectorId ? String((req.query as any).connectorId) : undefined;
    return listThreadMessages(userId, threadId, connectorId);
  });

  app.get('/api/messages/:messageId', async (req, reply) => {
    const userId = getUserId(req);
    const messageId = String((req.params as any).messageId);
    const result = await query<any>(
      `SELECT m.*
         FROM messages m
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE m.id = $1 AND ic.user_id = $2`,
      [messageId, userId],
    );
    const message = result.rows[0];
    if (!message) {
      return reply.code(404).send({ error: 'message not found' });
    }
    delete message.raw_blob_key;

    const attachments = await query<any>(
      `WITH ranked AS (
         SELECT a.id,
                a.message_id,
                a.filename,
                a.content_type,
                a.size_bytes,
                a.is_inline,
                a.scan_status,
                a.scan_result,
                a.created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY a.message_id, a.filename, COALESCE(a.content_type, ''), COALESCE(a.size_bytes, -1), a.is_inline
                  ORDER BY a.created_at DESC, a.id DESC
                ) AS dedupe_rank
           FROM attachments a
          WHERE a.message_id = $1
       )
       SELECT id,
              message_id as "messageId",
              filename,
              content_type as "contentType",
              size_bytes as "size",
              NULL::text as "blobKey",
              is_inline as "isInline",
              scan_status as "scanStatus",
              scan_result as "scanResult",
              NULL::timestamptz as "scannedAt"
         FROM ranked
        WHERE dedupe_rank = 1
        ORDER BY created_at DESC`,
      [messageId],
    );
    return {
      ...message,
      attachments: attachments.rows,
    };
  });

  app.get('/api/messages/:messageId/raw', async (req, reply) => {
    const userId = getUserId(req);
    const messageId = String((req.params as any).messageId);
    const result = await query<any>(
      `SELECT m.raw_blob_key as "rawBlobKey"
         FROM messages m
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE m.id = $1 AND ic.user_id = $2`,
      [messageId, userId],
    );
    const row = result.rows[0];
    if (!row || !row.rawBlobKey) {
      return reply.code(404).send({ error: 'message not found' });
    }

    const blob = await blobStore.getObjectStream(row.rawBlobKey);
    if (!blob) {
      return reply.code(404).send({ error: 'message source not found' });
    }

    const filename = sanitizeDispositionFilename(`${messageId}.eml`, 'message.eml');
    reply.header('Content-Type', 'message/rfc822');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Pragma', 'no-cache');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    if (blob.size !== null) {
      reply.header('Content-Length', String(blob.size));
    }
    return reply.send(blob.stream);
  });

  app.post('/api/messages/bulk', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    const rawIds = body?.messageIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return reply.code(400).send({ error: 'messageIds array required' });
    }
    if (rawIds.length > 500) {
      return reply.code(400).send({ error: 'messageIds exceeds 500 items' });
    }
    let messageIds: string[];
    try {
      messageIds = parseTrimmedStringArrayWithCap(rawIds, 'messageIds', 500);
      assertUuidList(messageIds, 'messageIds');
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid messageIds' });
    }
    const scope = body?.scope === 'thread' ? 'thread' : 'single';
    let normalizedMoveToFolder: string | undefined;
    try {
      if (body?.moveToFolder !== undefined && body?.moveToFolder !== null && String(body.moveToFolder).trim()) {
        normalizedMoveToFolder = normalizeMailboxInput(body.moveToFolder, 'moveToFolder');
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid moveToFolder' });
    }
    if (isArchiveMoveTarget(normalizedMoveToFolder)) {
      return reply.code(400).send({ error: 'archive is no longer supported' });
    }

    const results: { id: string; status: string }[] = [];
    const chunks: string[][] = [];
    for (let i = 0; i < messageIds.length; i += 20) {
      chunks.push(messageIds.slice(i, i + 20));
    }

    for (const chunk of chunks) {
      const chunkMessagesResult = await query<any>(
        `SELECT m.id,
                m.incoming_connector_id,
                m.folder_path,
                m.uid
           FROM messages m
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
          WHERE ic.user_id = $1
            AND m.id::text = ANY($2::text[])`,
        [userId, chunk],
      );
      const messageById = new Map<string, any>(
        chunkMessagesResult.rows.map((row) => [String(row.id), row]),
      );

      await Promise.all(chunk.map(async (messageId) => {
        try {
          const message = messageById.get(messageId) ?? null;
          if (!message) {
            results.push({ id: messageId, status: 'not_found' });
            return;
          }

          if (scope === 'thread') {
            await applyThreadMessageActions(userId, message.id, {
              isRead: body?.isRead,
              isStarred: body?.isStarred,
              moveToFolder: normalizedMoveToFolder,
              delete: body?.delete,
            });
          } else {
            if (body?.isRead !== undefined) {
              await setMessageReadState(userId, message.id, message.incoming_connector_id, message.folder_path, message.uid === null || message.uid === undefined ? null : Number(message.uid), Boolean(body.isRead));
            }
            if (body?.isStarred !== undefined) {
              await setMessageStarredState(userId, message.id, message.incoming_connector_id, message.folder_path, message.uid === null || message.uid === undefined ? null : Number(message.uid), Boolean(body.isStarred));
            }
            if (normalizedMoveToFolder) {
              await moveMessageInMailbox(
                userId,
                message.id,
                message.incoming_connector_id,
                message.folder_path,
                normalizedMoveToFolder,
                message.uid === null || message.uid === undefined ? null : Number(message.uid),
              );
            }
            if (body?.delete === true) {
              await deleteMessageFromMailbox(userId, message.id, message.incoming_connector_id, message.folder_path, message.uid === null || message.uid === undefined ? null : Number(message.uid));
            }
          }
          results.push({ id: messageId, status: body?.delete === true ? 'deleted' : 'updated' });
        } catch {
          results.push({ id: messageId, status: 'error' });
        }
      }));
    }

    clearSearchCachesForUser(userId);
    return { results };
  });
};
