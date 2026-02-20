import { FastifyInstance } from 'fastify';
import {
  getUserId,
  getMessageAndConnectorForUser,
  parseTrimmedStringArrayWithCap,
  getAttachmentScanBlock,
  UUID_PATTERN,
  query,
  blobStore,
  isArchiveMoveTarget,
  normalizeMailboxInput,
  clearSearchCachesForUser,
  parseAddressList,
  parseOptionalHeaderValue,
  HEADER_VALUE_PATTERN,
  MIME_TYPE_PATTERN,
  MAX_SEND_RECIPIENTS,
  MAX_SEND_ATTACHMENTS,
  MAX_SEND_SUBJECT_CHARS,
  MAX_SEND_BODY_TEXT_CHARS,
  MAX_SEND_BODY_HTML_CHARS,
  MAX_SEND_ATTACHMENT_BYTES,
  MAX_SEND_TOTAL_ATTACHMENT_BYTES,
  MAX_SEND_HEADER_CHARS,
  MAX_LABEL_MUTATION_ITEMS,
  normalizeSendIdempotencyKey,
  getIdentity,
  estimateBase64PayloadBytes,
  makeSendRequestHash,
  getOrCreateSendIdempotency,
  enqueueSend,
  setMessageReadState,
  setMessageStarredState,
  addLabelsToMessageByKey,
  removeLabelsFromMessageByKey,
  moveMessageInMailbox,
  deleteMessageFromMailbox,
  applyThreadMessageActions,
  sanitizeDispositionFilename,
} from './messages-context.js';

export const registerMessageMutationRoutes = async (app: FastifyInstance) => {
  app.patch('/api/messages/:messageId', async (req, reply) => {
    const userId = getUserId(req);
    const messageId = String((req.params as any).messageId);
    const body = req.body as any;
    const scope = body?.scope === 'thread' ? 'thread' : 'single';

    const message = await getMessageAndConnectorForUser(userId, messageId);
    if (!message) {
      return reply.code(404).send({ error: 'message not found' });
    }

    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'request body required' });
    }
    let normalizedMoveToFolder: string | undefined;
    let addLabelKeys: string[] | undefined;
    let removeLabelKeys: string[] | undefined;
    try {
      if (body?.moveToFolder !== undefined && body?.moveToFolder !== null && String(body.moveToFolder).trim()) {
        normalizedMoveToFolder = normalizeMailboxInput(body.moveToFolder, 'moveToFolder');
      }
      if (body?.addLabelKeys !== undefined) {
        addLabelKeys = parseTrimmedStringArrayWithCap(body.addLabelKeys, 'addLabelKeys', MAX_LABEL_MUTATION_ITEMS);
      }
      if (body?.removeLabelKeys !== undefined) {
        removeLabelKeys = parseTrimmedStringArrayWithCap(body.removeLabelKeys, 'removeLabelKeys', MAX_LABEL_MUTATION_ITEMS);
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid message action payload' });
    }
    if (isArchiveMoveTarget(normalizedMoveToFolder)) {
      return reply.code(400).send({ error: 'archive is no longer supported' });
    }

    if (scope === 'thread') {
      await applyThreadMessageActions(userId, message.id, {
        isRead: body?.isRead,
        isStarred: body?.isStarred,
        moveToFolder: normalizedMoveToFolder,
        delete: body?.delete,
        addLabelKeys,
        removeLabelKeys,
      });
      clearSearchCachesForUser(userId);
      return { status: 'thread_updated', id: messageId };
    }

    if (body?.isRead !== undefined) {
      await setMessageReadState(
        userId,
        message.id,
        message.incoming_connector_id,
        message.folder_path,
        message.uid === null || message.uid === undefined ? null : Number(message.uid),
        Boolean(body.isRead),
      );
    }

    if (body?.isStarred !== undefined) {
      await setMessageStarredState(
        userId,
        message.id,
        message.incoming_connector_id,
        message.folder_path,
        message.uid === null || message.uid === undefined ? null : Number(message.uid),
        Boolean(body.isStarred),
      );
    }

    if (addLabelKeys?.length) {
      await addLabelsToMessageByKey(userId, message.id, addLabelKeys);
    }
    if (removeLabelKeys?.length) {
      await removeLabelsFromMessageByKey(userId, message.id, removeLabelKeys);
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
      await deleteMessageFromMailbox(
        userId,
        message.id,
        message.incoming_connector_id,
        message.folder_path,
        message.uid === null || message.uid === undefined ? null : Number(message.uid),
      );
      clearSearchCachesForUser(userId);
      return { status: 'deleted', id: messageId };
    }

    const after = await query<any>(
      `SELECT m.*
       FROM messages m
       INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
       WHERE m.id = $1 AND ic.user_id = $2`,
      [messageId, userId],
    );
    const refreshed = after.rows[0];
    if (refreshed) {
      delete refreshed.raw_blob_key;
    }
    clearSearchCachesForUser(userId);
    return refreshed;
  });

  app.get('/api/messages/:messageId/attachments', async (req) => {
    const userId = getUserId(req);
    const messageId = String((req.params as any).messageId);
    const result = await query<any>(
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
           INNER JOIN messages m ON m.id = a.message_id
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
          WHERE m.id = $1 AND ic.user_id = $2
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
      [messageId, userId],
    );
    return result.rows;
  });

  app.get('/api/attachments/:attachmentId/download', async (req, reply) => {
    const userId = getUserId(req);
    const attachmentId = String((req.params as any).attachmentId);
    if (!UUID_PATTERN.test(attachmentId)) {
      return reply.code(400).send({ error: 'invalid attachmentId' });
    }
    const attachmentResult = await query<any>(
      `SELECT a.filename,
              a.blob_key,
              a.content_type as "contentType",
              a.scan_status as "scanStatus"
         FROM attachments a
         INNER JOIN messages m ON m.id = a.message_id
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE a.id = $1 AND ic.user_id = $2`,
      [attachmentId, userId],
    );
    const attachment = attachmentResult.rows[0];
    if (!attachment) {
      return reply.code(404).send({ error: 'attachment not found' });
    }
    const scanBlock = getAttachmentScanBlock(attachment.scanStatus);
    if (scanBlock) {
      return reply.code(scanBlock.statusCode).send({ error: scanBlock.error });
    }

    const blob = await blobStore.getObjectStream(attachment.blob_key);
    if (!blob) {
      return reply.code(404).send({ error: 'attachment blob not found' });
    }

    const filename = sanitizeDispositionFilename(attachment.filename, 'attachment');
    reply.header('Content-Type', attachment.contentType || 'application/octet-stream');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Pragma', 'no-cache');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    if (blob.size !== null) {
      reply.header('Content-Length', String(blob.size));
    }
    return reply.send(blob.stream);
  });

  app.get('/api/attachments/:attachmentId/view', async (req, reply) => {
    const userId = getUserId(req);
    const attachmentId = String((req.params as any).attachmentId);
    if (!UUID_PATTERN.test(attachmentId)) {
      return reply.code(400).send({ error: 'invalid attachmentId' });
    }
    const attachmentResult = await query<any>(
      `SELECT a.filename,
              a.blob_key,
              a.content_type as "contentType",
              a.scan_status as "scanStatus"
         FROM attachments a
         INNER JOIN messages m ON m.id = a.message_id
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE a.id = $1 AND ic.user_id = $2`,
      [attachmentId, userId],
    );
    const attachment = attachmentResult.rows[0];
    if (!attachment) {
      return reply.code(404).send({ error: 'attachment not found' });
    }
    const scanBlock = getAttachmentScanBlock(attachment.scanStatus);
    if (scanBlock) {
      return reply.code(scanBlock.statusCode).send({ error: scanBlock.error });
    }

    const blob = await blobStore.getObjectStream(attachment.blob_key);
    if (!blob) {
      return reply.code(404).send({ error: 'attachment blob not found' });
    }

    const filename = sanitizeDispositionFilename(attachment.filename, 'attachment');
    reply.header('Content-Type', attachment.contentType || 'application/octet-stream');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header(
      'Content-Security-Policy',
      "sandbox; default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'",
    );
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Pragma', 'no-cache');
    reply.header('Content-Disposition', `inline; filename="${filename}"`);
    if (blob.size !== null) {
      reply.header('Content-Length', String(blob.size));
    }
    return reply.send(blob.stream);
  });

  app.post('/api/messages/send', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body || typeof body !== 'object' || !body?.identityId || !body?.subject) {
      return reply.code(400).send({ error: 'identityId and subject required' });
    }
    const subject = String(body.subject);
    if (!subject.trim()) {
      return reply.code(400).send({ error: 'subject is required' });
    }
    if (subject.length > MAX_SEND_SUBJECT_CHARS) {
      return reply.code(400).send({ error: `subject exceeds ${MAX_SEND_SUBJECT_CHARS} characters` });
    }
    const headerIdempotency = req.headers['idempotency-key'] ?? req.headers['x-idempotency-key'];
    const idempotencyHeader = Array.isArray(headerIdempotency) ? headerIdempotency[0] : headerIdempotency;

    if (!body.idempotencyKey && !idempotencyHeader) {
      return reply.code(400).send({ error: 'idempotency key is required (body.idempotencyKey or Idempotency-Key header)' });
    }
    const identityId = String(body.identityId);
    const identity = await getIdentity(userId, identityId);
    if (!identity) {
      return reply.code(404).send({ error: 'identity not found' });
    }

    let idempotencyKey: string;
    try {
      idempotencyKey = normalizeSendIdempotencyKey(body.idempotencyKey ?? idempotencyHeader);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid idempotency key' });
    }
    const toList = parseAddressList(body.to);
    if (!toList || toList.length === 0) {
      return reply.code(400).send({ error: 'to must include at least one valid email address' });
    }
    const normalizedTo = toList.join(', ');
    const ccList = parseAddressList(body.cc);
    const bccList = parseAddressList(body.bcc);
    const totalRecipients = toList.length + (ccList?.length ?? 0) + (bccList?.length ?? 0);
    if (totalRecipients > MAX_SEND_RECIPIENTS) {
      return reply.code(400).send({ error: `recipient limit exceeded (max ${MAX_SEND_RECIPIENTS})` });
    }

    if (body.bodyText !== undefined && body.bodyText !== null && typeof body.bodyText !== 'string') {
      return reply.code(400).send({ error: 'bodyText must be a string' });
    }
    if (body.bodyHtml !== undefined && body.bodyHtml !== null && typeof body.bodyHtml !== 'string') {
      return reply.code(400).send({ error: 'bodyHtml must be a string' });
    }
    const bodyText = typeof body.bodyText === 'string' ? body.bodyText : undefined;
    const bodyHtml = typeof body.bodyHtml === 'string' ? body.bodyHtml : undefined;
    if (bodyText && bodyText.length > MAX_SEND_BODY_TEXT_CHARS) {
      return reply.code(400).send({ error: `bodyText exceeds ${MAX_SEND_BODY_TEXT_CHARS} characters` });
    }
    if (bodyHtml && bodyHtml.length > MAX_SEND_BODY_HTML_CHARS) {
      return reply.code(400).send({ error: `bodyHtml exceeds ${MAX_SEND_BODY_HTML_CHARS} characters` });
    }

    const inReplyTo = parseOptionalHeaderValue(body.inReplyTo);
    const references = parseOptionalHeaderValue(body.references);
    if (inReplyTo && (!HEADER_VALUE_PATTERN.test(inReplyTo) || inReplyTo.length > MAX_SEND_HEADER_CHARS)) {
      return reply.code(400).send({ error: 'inReplyTo header is invalid' });
    }
    if (references && (!HEADER_VALUE_PATTERN.test(references) || references.length > MAX_SEND_HEADER_CHARS)) {
      return reply.code(400).send({ error: 'references header is invalid' });
    }

    let threadId: string | undefined;
    if (body.threadId !== undefined && body.threadId !== null) {
      threadId = String(body.threadId).trim();
      if (!threadId) {
        return reply.code(400).send({ error: 'threadId must be non-empty when provided' });
      }
      if (!HEADER_VALUE_PATTERN.test(threadId) || threadId.length > 255) {
        return reply.code(400).send({ error: 'threadId is invalid' });
      }
    }

    if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
      return reply.code(400).send({ error: 'attachments must be an array' });
    }
    const attachmentsInput = Array.isArray(body.attachments) ? body.attachments : [];
    if (attachmentsInput.length > MAX_SEND_ATTACHMENTS) {
      return reply.code(400).send({ error: `attachment limit exceeded (max ${MAX_SEND_ATTACHMENTS})` });
    }
    let totalAttachmentBytes = 0;
    let attachments: Array<{
      filename: string;
      contentType: string;
      contentBase64: string;
      inline: boolean;
      contentId?: string;
    }>;
    try {
      attachments = attachmentsInput.map((attachment: any, index: number) => {
        if (!attachment || typeof attachment !== 'object') {
          throw new Error(`attachment[${index}] must be an object`);
        }
        const filename = String(attachment.filename ?? '').trim();
        const contentType = String(attachment.contentType ?? '').trim().toLowerCase();
        const contentBase64 = String(attachment.contentBase64 ?? '').trim();
        const inline = attachment.inline === true;
        const contentId = attachment.contentId === undefined || attachment.contentId === null
          ? undefined
          : String(attachment.contentId).trim();

        if (!filename || filename.length > 180 || !HEADER_VALUE_PATTERN.test(filename)) {
          throw new Error(`attachment[${index}] filename is invalid`);
        }
        if (!contentType || !MIME_TYPE_PATTERN.test(contentType)) {
          throw new Error(`attachment[${index}] contentType is invalid`);
        }
        if (!contentBase64) {
          throw new Error(`attachment[${index}] contentBase64 is required`);
        }
        const estimatedBytes = estimateBase64PayloadBytes(contentBase64);
        if (estimatedBytes === null) {
          throw new Error(`attachment[${index}] contentBase64 is invalid`);
        }
        if (estimatedBytes > MAX_SEND_ATTACHMENT_BYTES) {
          throw new Error(`attachment[${index}] exceeds ${MAX_SEND_ATTACHMENT_BYTES} bytes`);
        }
        totalAttachmentBytes += estimatedBytes;
        if (totalAttachmentBytes > MAX_SEND_TOTAL_ATTACHMENT_BYTES) {
          throw new Error(`total attachment payload exceeds ${MAX_SEND_TOTAL_ATTACHMENT_BYTES} bytes`);
        }
        if (contentId && (!HEADER_VALUE_PATTERN.test(contentId) || contentId.length > 255)) {
          throw new Error(`attachment[${index}] contentId is invalid`);
        }
        if (inline && !contentId) {
          throw new Error(`attachment[${index}] inline attachments require contentId`);
        }

        return {
          filename,
          contentType,
          contentBase64,
          inline,
          contentId,
        };
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'attachment validation failed' });
    }

    const requestHash = makeSendRequestHash({
      identityId,
      to: normalizedTo,
      cc: ccList,
      bcc: bccList,
      subject,
      bodyText,
      bodyHtml,
      threadId,
      inReplyTo,
      references,
      attachments,
    });

    const idempotency = await getOrCreateSendIdempotency({
      userId,
      identityId,
      idempotencyKey,
      requestHash,
      requestMeta: {
        to: normalizedTo,
        cc: ccList ?? [],
        bcc: bccList ?? [],
        subject,
        bodyText: bodyText ? bodyText.slice(0, 1000) : '',
      },
    });

    if (idempotency.status === 'succeeded') {
      return { status: 'succeeded', idempotencyKey, result: idempotency.result };
    }

    if (idempotency.status === 'processing') {
      return { status: 'in_flight', idempotencyKey };
    }
    if (idempotency.status === 'failed') {
      return {
        status: 'failed',
        idempotencyKey,
        error: idempotency.errorMessage ?? null,
      };
    }

    await enqueueSend({
      userId,
      identityId,
      idempotencyKey,
      to: normalizedTo,
      cc: ccList,
      bcc: bccList,
      subject,
      bodyText,
      bodyHtml,
      threadId,
      inReplyTo,
      references,
      attachments,
    });

    return { status: 'queued' };
  });
};
