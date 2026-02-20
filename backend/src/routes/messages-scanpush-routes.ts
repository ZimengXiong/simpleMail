import { FastifyInstance } from 'fastify';
import {
  getUserId,
  query,
  UUID_PATTERN,
  getAttachmentScanDecision,
  getAttachmentScanBlock,
  enqueueAttachmentScan,
  assertSafePushEndpoint,
  createPushSubscription,
  removePushSubscription,
  MAX_PUSH_ENDPOINT_CHARS,
  MAX_PUSH_KEY_CHARS,
  MAX_PUSH_USER_AGENT_CHARS,
} from './messages-context.js';

export const registerMessageScanPushRoutes = async (app: FastifyInstance) => {
  app.post('/api/attachments/scan', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.messageId || !body?.attachmentId) {
      return reply.code(400).send({ error: 'messageId and attachmentId required' });
    }
    const attachmentId = String(body.attachmentId);
    const messageId = String(body.messageId);
    if (!UUID_PATTERN.test(messageId) || !UUID_PATTERN.test(attachmentId)) {
      return reply.code(400).send({ error: 'messageId and attachmentId must be valid UUID values' });
    }

    const attachmentBelongs = await query<{ id: string; size_bytes: number | null; scan_status: string }>(
      `SELECT a.id, a.size_bytes, a.scan_status
         FROM attachments a
         INNER JOIN messages m ON m.id = a.message_id
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE a.id = $1 AND m.id = $2 AND ic.user_id = $3`,
      [attachmentId, messageId, userId],
    );
    if (attachmentBelongs.rows.length === 0) {
      return reply.code(404).send({ error: 'attachment not found' });
    }

    const decision = getAttachmentScanDecision(Number(attachmentBelongs.rows[0].size_bytes ?? 0));
    const currentStatus = attachmentBelongs.rows[0].scan_status;

    if (decision.disposition !== 'queued') {
      if (currentStatus === decision.status) {
        return {
          status: decision.disposition === 'skip' ? decision.status : 'not_queued',
          scanStatus: currentStatus,
        };
      }
      await query(
        `UPDATE attachments
            SET scan_status = $2, scan_result = $3
          WHERE id = $1`,
        [attachmentId, decision.status, decision.verdictHint],
      );
      return {
        status: decision.disposition === 'skip' ? decision.status : 'not_queued',
        scanStatus: decision.status,
      };
    }

    if (currentStatus === 'clean' || currentStatus === 'infected') {
      return {
        status: 'not_queued',
        scanStatus: currentStatus,
      };
    }

    if (currentStatus !== 'pending') {
      await query(
        `UPDATE attachments
         SET scan_status = 'pending', scan_result = NULL
         WHERE id = $1`,
        [attachmentId],
      );
    }

    await enqueueAttachmentScan(messageId, attachmentId);
    return { status: 'queued', attachmentId };
  });

  app.post('/api/push/subscribe', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.endpoint || !body?.p256dh || !body?.auth) {
      return reply.code(400).send({ error: 'endpoint, p256dh, auth required' });
    }
    const endpoint = String(body.endpoint).trim();
    const p256dh = String(body.p256dh).trim();
    const auth = String(body.auth).trim();
    const userAgent = body.userAgent === undefined || body.userAgent === null
      ? undefined
      : String(body.userAgent).trim();

    if (!endpoint || !p256dh || !auth) {
      return reply.code(400).send({ error: 'endpoint, p256dh, auth required' });
    }
    if (endpoint.length > MAX_PUSH_ENDPOINT_CHARS) {
      return reply.code(400).send({ error: `endpoint exceeds ${MAX_PUSH_ENDPOINT_CHARS} characters` });
    }
    if (p256dh.length > MAX_PUSH_KEY_CHARS || auth.length > MAX_PUSH_KEY_CHARS) {
      return reply.code(400).send({ error: `p256dh/auth exceeds ${MAX_PUSH_KEY_CHARS} characters` });
    }
    if (userAgent && userAgent.length > MAX_PUSH_USER_AGENT_CHARS) {
      return reply.code(400).send({ error: `userAgent exceeds ${MAX_PUSH_USER_AGENT_CHARS} characters` });
    }

    await assertSafePushEndpoint(endpoint);

    const subscription = await createPushSubscription({
      userId,
      endpoint,
      p256dh,
      auth,
      userAgent,
    });
    return subscription;
  });

  app.delete('/api/push/subscribe', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.endpoint) {
      return reply.code(400).send({ error: 'endpoint required' });
    }
    const endpoint = String(body.endpoint).trim();
    if (!endpoint) {
      return reply.code(400).send({ error: 'endpoint required' });
    }
    await removePushSubscription(userId, endpoint);
    return { status: 'deleted' };
  });
};
