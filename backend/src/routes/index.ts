import { FastifyInstance } from 'fastify';
import {
  createIncomingConnector,
  createOutgoingConnector,
  createIdentity,
  updateIdentity,
  deleteIdentity,
  deleteIncomingConnector,
  deleteOutgoingConnector,
  getIncomingConnector,
  getOutgoingConnector,
  getIdentity,
  listIdentities,
  listIncomingConnectors,
  listOutgoingConnectors,
  updateIncomingConnector,
  updateOutgoingConnector,
  updateIncomingConnectorAuth,
  updateOutgoingConnectorAuth,
} from '../services/connectorService.js';
import { getGoogleAuthorizeUrl, consumeOAuthState, exchangeCodeForTokens } from '../services/googleOAuth.js';
import { enqueueSync, enqueueSend, enqueueAttachmentScan } from '../services/queue.js';
import { query } from '../db/pool.js';
import {
  listConnectorMailboxes,
  syncIncomingConnector,
  startIncomingConnectorIdleWatch,
  moveMessageInMailbox,
  deleteMessageFromMailbox,
  setMessageReadState,
  setMessageStarredState,
  stopIncomingConnectorIdleWatch,
} from '../services/imap.js';
import { createRule, deleteRule, listRules } from '../services/rules.js';
import { listSyncEvents } from '../services/imapEvents.js';
import { createPushSubscription, removePushSubscription } from '../services/push.js';
import { listThreadMessages } from '../services/threading.js';
import { blobStore } from '../storage/seaweedS3BlobStore.js';
import { env } from '../config/env.js';
import { createUser } from '../services/user.js';
import { getAttachmentScanDecision } from '../services/scanPolicy.js';
import {
  getOrCreateSendIdempotency,
  makeSendRequestHash,
  normalizeSendIdempotencyKey,
} from '../services/sendIdempotency.js';

const required = (value: unknown, key: string): string => {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${key} is required`);
  }
  return String(value);
};

const getMessageAndConnectorForUser = async (userId: string, messageId: string) => {
  const result = await query<any>(
    `SELECT m.id, m.incoming_connector_id, m.folder_path, m.uid
       FROM messages m
       INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
      WHERE m.id = $1
        AND ic.user_id = $2`,
    [messageId, userId],
  );
  return result.rows[0] ?? null;
};

export const registerRoutes = async (app: FastifyInstance) => {
  const getUserId = (request: any) => {
    if (!request.user?.id) {
      throw new Error('missing user context');
    }
    return request.user.id;
  };

  app.get('/api/health', async () => ({ status: 'ok', seaweed: { bucket: env.seaweed.bucket } }));

  app.post('/api/admin/users', async (req, reply) => {
    const body = req.body as any;
    if (!body?.email || !body?.name) {
      return reply.code(400).send({ error: 'email and name required' });
    }

    const created = await createUser({
      email: String(body.email),
      name: String(body.name),
      token: body.token,
    });

    return created;
  });

  app.get('/api/connectors/incoming', async (req) => {
    const userId = getUserId(req);
    return listIncomingConnectors(userId);
  });
  app.get('/api/connectors/outgoing', async (req) => {
    const userId = getUserId(req);
    return listOutgoingConnectors(userId);
  });
  app.get('/api/connectors/incoming/:connectorId', async (req, reply) => {
    const connectorId = String((req.params as any).connectorId);
    const userId = getUserId(req);
    const result = await getIncomingConnector(userId, connectorId);
    if (!result) {
      return reply.code(404).send({ error: 'connector not found' });
    }
    return result;
  });
  app.get('/api/connectors/outgoing/:connectorId', async (req, reply) => {
    const connectorId = String((req.params as any).connectorId);
    const userId = getUserId(req);
    const result = await getOutgoingConnector(userId, connectorId);
    if (!result) {
      return reply.code(404).send({ error: 'connector not found' });
    }
    return result;
  });
  app.get('/api/connectors/:connectorId/mailboxes', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    try {
      return await listConnectorMailboxes(userId, connectorId);
    } catch {
      return reply.code(404).send({ error: 'connector not found' });
    }
  });

  app.post('/api/connectors/incoming', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.name || !body?.provider || !body?.emailAddress) {
      return reply.code(400).send({ error: 'name, provider, emailAddress required' });
    }

    const result = await createIncomingConnector(userId, {
      name: String(body.name),
      provider: String(body.provider),
      emailAddress: String(body.emailAddress),
      host: body.host,
      port: body.port,
      tls: body.tls ?? true,
      authType: body.authType ?? 'password',
      authConfig: body.authConfig ?? {},
      syncSettings: body.syncSettings ?? {},
    });
    return result;
  });

  app.post('/api/connectors/outgoing', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.name || !body?.provider || !body?.fromAddress) {
      return reply.code(400).send({ error: 'name, provider, fromAddress required' });
    }

    const result = await createOutgoingConnector(userId, {
      name: String(body.name),
      provider: String(body.provider),
      fromAddress: String(body.fromAddress),
      host: body.host,
      port: body.port,
      tlsMode: body.tlsMode ?? 'starttls',
      authType: body.authType ?? (body.provider === 'gmail' ? 'oauth2' : 'password'),
      authConfig: body.authConfig ?? {},
      fromEnvelopeDefaults: body.fromEnvelopeDefaults ?? {},
      sentCopyBehavior: body.sentCopyBehavior ?? {},
    });
    return result;
  });

  app.patch('/api/connectors/incoming/:connectorId', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    const body = req.body as any;

    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'request body required' });
    }

    await updateIncomingConnector(userId, connectorId, {
      name: body.name,
      emailAddress: body.emailAddress,
      host: body.host,
      port: body.port,
      tls: body.tls,
      authConfig: body.authConfig,
      syncSettings: body.syncSettings,
      status: body.status,
    });
    const updated = await getIncomingConnector(userId, connectorId);
    if (!updated) {
      return reply.code(404).send({ error: 'connector not found' });
    }
    return updated;
  });

  app.patch('/api/connectors/outgoing/:connectorId', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    const body = req.body as any;

    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'request body required' });
    }

    await updateOutgoingConnector(userId, connectorId, {
      name: body.name,
      fromAddress: body.fromAddress,
      host: body.host,
      port: body.port,
      tlsMode: body.tlsMode,
      authConfig: body.authConfig,
      fromEnvelopeDefaults: body.fromEnvelopeDefaults,
      sentCopyBehavior: body.sentCopyBehavior,
    });
    const updated = await getOutgoingConnector(userId, connectorId);
    if (!updated) {
      return reply.code(404).send({ error: 'connector not found' });
    }
    return updated;
  });

  app.delete('/api/connectors/incoming/:connectorId', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    await deleteIncomingConnector(userId, connectorId);
    return { status: 'deleted', id: connectorId };
  });

  app.delete('/api/connectors/outgoing/:connectorId', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    await deleteOutgoingConnector(userId, connectorId);
    return { status: 'deleted', id: connectorId };
  });

  app.post('/api/identities', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.displayName || !body?.emailAddress || !body?.outgoingConnectorId) {
      return reply.code(400).send({ error: 'displayName, emailAddress, outgoingConnectorId required' });
    }

    const created = await createIdentity(
      userId,
      String(body.displayName),
      String(body.emailAddress),
      String(body.outgoingConnectorId),
      body.signature ?? null,
      body.sentToIncomingConnectorId ?? null,
      body.replyTo ?? null,
    );
    return created;
  });

  app.get('/api/identities', async (req) => {
    const userId = getUserId(req);
    return listIdentities(userId);
  });

  app.get('/api/identities/:id', async (req, reply) => {
    const userId = getUserId(req);
    const identityId = String((req.params as any).id);
    const identity = await getIdentity(userId, identityId);
    if (!identity) {
      return reply.code(404).send({ error: 'identity not found' });
    }
    return identity;
  });

  app.patch('/api/identities/:id', async (req, reply) => {
    const userId = getUserId(req);
    const identityId = String((req.params as any).id);
    const body = req.body as any;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'request body required' });
    }

    await updateIdentity(userId, identityId, {
      displayName: body.displayName,
      emailAddress: body.emailAddress,
      signature: body.signature,
      outgoingConnectorId: body.outgoingConnectorId ?? undefined,
      sentToIncomingConnectorId: body.sentToIncomingConnectorId ?? undefined,
      replyTo: body.replyTo,
    });
    const refreshed = await getIdentity(userId, identityId);
    if (!refreshed) {
      return reply.code(404).send({ error: 'identity not found' });
    }
    return refreshed;
  });

  app.delete('/api/identities/:id', async (req) => {
    const userId = getUserId(req);
    const identityId = String((req.params as any).id);
    await deleteIdentity(userId, identityId);
    return { status: 'deleted', id: identityId };
  });

  app.get('/api/rules', async (req) => {
    const userId = getUserId(req);
    return listRules(userId);
  });

  app.post('/api/rules', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.name || !body?.actions) {
      return reply.code(400).send({ error: 'name and actions required' });
    }

    const rule = await createRule(userId, {
      name: String(body.name),
      matchingScope: body.matchingScope ?? 'incoming',
      matchConditions: body.matchConditions ?? {},
      actions: body.actions ?? {},
      executionOrder: body.executionOrder ?? 0,
    });

    return rule;
  });

  app.delete('/api/rules/:id', async (req, reply) => {
    const userId = getUserId(req);
    const id = String((req.params as any).id);
    await deleteRule(userId, id);
    return { status: 'deleted', id };
  });

  app.post('/api/oauth/google/authorize', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    const type = body?.type;
    const connectorId = body?.connectorId;
    const clientId = body?.oauthClientId;
    const clientSecret = body?.oauthClientSecret;

    if (!type || !connectorId) {
      return reply.code(400).send({ error: 'type (incoming|outgoing) and connectorId required' });
    }

    const connectorType = type === 'incoming' ? 'incoming' : 'outgoing';
    const connector = connectorType === 'incoming'
      ? await getIncomingConnector(userId, connectorId)
      : await getOutgoingConnector(userId, connectorId);

    if (!connector) {
      return reply.code(404).send({ error: `${connectorType} connector not found` });
    }

    if (connector.provider !== 'gmail') {
      return reply.code(400).send({ error: 'OAuth flow is only valid for provider=gmail connectors' });
    }

    if (clientId || clientSecret) {
      const existingAuth = connector.authConfig ?? {};
      const nextAuth = {
        ...existingAuth,
        ...(clientId ? { oauthClientId: clientId } : {}),
        ...(clientSecret ? { oauthClientSecret: clientSecret } : {}),
      };

      if (connectorType === 'incoming') {
        await updateIncomingConnectorAuth(connectorId, nextAuth, userId);
      } else {
        await updateOutgoingConnectorAuth(connectorId, nextAuth, userId);
      }

      connector.authConfig = nextAuth;
    }

    const url = await getGoogleAuthorizeUrl(
      connectorType,
      connectorId,
      connector.authConfig?.oauthClientId ?? clientId,
      connector.authConfig?.oauthClientSecret ?? clientSecret,
      userId,
    );
    return { authorizeUrl: url };
  });

  app.get('/api/oauth/google/callback', async (req, reply) => {
    const queryParams = req.query as any;
    const code = required(queryParams.code, 'code');
    const state = required(queryParams.state, 'state');

    const payload = await consumeOAuthState(state);
    if (!payload) {
      return reply.code(400).send({ error: 'invalid or expired oauth state' });
    }

    const targetUserId = payload.userId;
    if (!targetUserId) {
      return reply.code(400).send({ error: 'oauth state missing user context' });
    }

    const { type, connectorId } = payload;

    const connectorTable = type === 'incoming' ? 'incoming_connectors' : 'outgoing_connectors';
    const whereClause = 'WHERE id = $1 AND user_id = $2';
    const params = [connectorId, targetUserId];

    const row = await query<any>(`SELECT auth_config, user_id FROM ${connectorTable} ${whereClause}`, params);
    if (row.rows.length === 0) {
      return reply.code(404).send({ error: `${type} connector not found` });
    }

    const existingAuth = row.rows[0]?.auth_config || {};
    const tokens = await exchangeCodeForTokens(code, existingAuth.oauthClientId, existingAuth.oauthClientSecret);
    const nextAuth = {
      ...(existingAuth || {}),
      authType: 'oauth2',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? existingAuth.refreshToken,
      tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : existingAuth.tokenExpiresAt,
      scope: tokens.scope,
    };

    if (type === 'incoming') {
      await updateIncomingConnectorAuth(connectorId, nextAuth, targetUserId);
    } else {
      await updateOutgoingConnectorAuth(connectorId, nextAuth, targetUserId);
    }

    return { status: 'ok', connectorType: type, connectorId };
  });

  app.post('/api/sync/:connectorId', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    const body = (req.body as any) || {};
    const mailbox = body.mailbox || 'INBOX';
    const useQueue = body.useQueue === true;

    if (useQueue) {
      await enqueueSync(userId, connectorId, mailbox);
      return { status: 'queued' };
    }

    await syncIncomingConnector(userId, connectorId, mailbox);
    return { status: 'ok' };
  });

  app.post('/api/sync/:connectorId/watch', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    const body = req.body as any;
    const mailbox = body?.mailbox || env.sync.defaultMailbox;
    await startIncomingConnectorIdleWatch(userId, connectorId, mailbox);
    return { status: 'watching', connectorId, mailbox };
  });

  app.post('/api/sync/:connectorId/watch/stop', async (req, reply) => {
    const userId = getUserId(req);
    const connectorId = String((req.params as any).connectorId);
    const body = req.body as any;
    const mailbox = body?.mailbox || env.sync.defaultMailbox;
    await stopIncomingConnectorIdleWatch(userId, connectorId, mailbox);
    return { status: 'stopped', connectorId, mailbox };
  });

  app.get('/api/events', async (req) => {
    const userId = getUserId(req);
    const queryObject = req.query as any;
    const since = Number(queryObject?.since ?? 0);
    const limit = Number(queryObject?.limit ?? 100);
    return listSyncEvents(userId, since, limit);
  });

  app.get('/api/messages', async (req) => {
    const userId = getUserId(req);
    const queryObject = req.query as any;
    const limit = Number(queryObject?.limit ?? 50);
    const folder = queryObject?.folder;
    const connectorId = queryObject?.connectorId;

    const predicates = ['ic.user_id = $1'];
    const values: any[] = [userId];
    if (folder) {
      values.push(folder);
      predicates.push(`m.folder_path = $${values.length}`);
    }
    if (connectorId) {
      values.push(connectorId);
      predicates.push(`m.incoming_connector_id = $${values.length}`);
    }
    values.push(limit);

    const result = await query<any>(
      `SELECT m.*
         FROM messages m
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE ${predicates.join(' AND ')}
        ORDER BY m.received_at DESC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows;
  });

  app.post('/api/messages/search', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    const q = required(body?.q, 'q');
    const limit = Number(body?.limit ?? 50);
    const folder = body?.folder;
    const connectorId = body?.connectorId;

    const predicates = [
      'ic.user_id = $1',
      `m.search_vector @@ websearch_to_tsquery('english', $2)`,
    ];
    const values: any[] = [userId, q];

    if (folder) {
      values.push(folder);
      predicates.push(`m.folder_path = $${values.length}`);
    }
    if (connectorId) {
      values.push(connectorId);
      predicates.push(`m.incoming_connector_id = $${values.length}`);
    }
    values.push(limit);

    const result = await query<any>(
      `SELECT m.id, m.subject, m.from_header as "fromHeader", m.to_header as "toHeader", m.folder_path as "folderPath", m.snippet, m.received_at as "receivedAt", m.thread_id as "threadId", m.raw_blob_key as "rawBlobKey"
         FROM messages m
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE ${predicates.join(' AND ')}
        ORDER BY m.received_at DESC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows;
  });

  app.get('/api/messages/thread/:threadId', async (req) => {
    const userId = getUserId(req);
    const threadId = String((req.params as any).threadId);
    return listThreadMessages(userId, threadId);
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

    const attachments = await query<any>(
      `SELECT id, filename, content_type as "contentType", size_bytes as "sizeBytes", is_inline as "isInline", scan_status as "scanStatus", scan_result as "scanResult"
         FROM attachments
        WHERE message_id = $1
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

    const data = await blobStore.getObject(row.rawBlobKey);
    if (!data) {
      return reply.code(404).send({ error: 'message source not found' });
    }

    reply.header('Content-Type', 'message/rfc822');
    reply.header('Content-Disposition', `attachment; filename="${messageId}.eml"`);
    return reply.send(data);
  });

  app.patch('/api/messages/:messageId', async (req, reply) => {
    const userId = getUserId(req);
    const messageId = String((req.params as any).messageId);
    const body = req.body as any;

    const message = await getMessageAndConnectorForUser(userId, messageId);
    if (!message) {
      return reply.code(404).send({ error: 'message not found' });
    }

    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'request body required' });
    }

    if (message.uid === null || message.uid === undefined) {
      return reply.code(409).send({ error: 'message uid unavailable for action' });
    }

    if (body?.isRead !== undefined) {
      await setMessageReadState(
        userId,
        message.id,
        message.incoming_connector_id,
        message.folder_path,
        Number(message.uid),
        Boolean(body.isRead),
      );
    }

    if (body?.isStarred !== undefined) {
      await setMessageStarredState(
        userId,
        message.id,
        message.incoming_connector_id,
        message.folder_path,
        Number(message.uid),
        Boolean(body.isStarred),
      );
    }

    if (body?.moveToFolder) {
      await moveMessageInMailbox(
        userId,
        message.id,
        message.incoming_connector_id,
        message.folder_path,
        String(body.moveToFolder),
        Number(message.uid),
      );
    }

    if (body?.delete === true) {
      await deleteMessageFromMailbox(
        userId,
        message.id,
        message.incoming_connector_id,
        message.folder_path,
        Number(message.uid),
      );
      return { status: 'deleted', id: messageId };
    }

    const after = await query<any>(
      `SELECT * FROM messages m
       INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
       WHERE m.id = $1 AND ic.user_id = $2`,
      [messageId, userId],
    );
    return after.rows[0];
  });

  app.get('/api/messages/:messageId/attachments', async (req) => {
    const userId = getUserId(req);
    const messageId = String((req.params as any).messageId);
    const result = await query<any>(
      `SELECT a.id, a.filename, a.content_type as "contentType", a.size_bytes as "sizeBytes", a.is_inline as "isInline", a.scan_status as "scanStatus", a.scan_result as "scanResult"
         FROM attachments a
         INNER JOIN messages m ON m.id = a.message_id
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE m.id = $1 AND ic.user_id = $2
        ORDER BY a.created_at DESC`,
      [messageId, userId],
    );
    return result.rows;
  });

  app.get('/api/attachments/:attachmentId/download', async (req, reply) => {
    const userId = getUserId(req);
    const attachmentId = String((req.params as any).attachmentId);
    const attachmentResult = await query<any>(
      `SELECT a.filename, a.blob_key, a.content_type as "contentType"
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

    const data = await blobStore.getObject(attachment.blob_key);
    if (!data) {
      return reply.code(404).send({ error: 'attachment blob not found' });
    }

    reply.header('Content-Type', attachment.contentType || 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${attachment.filename}"`);
    return reply.send(data);
  });

  app.post('/api/messages/send', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.identityId || !body?.to || !body?.subject) {
      return reply.code(400).send({ error: 'identityId, to, subject required' });
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

    const idempotencyKey = normalizeSendIdempotencyKey(body.idempotencyKey ?? idempotencyHeader);
    const requestHash = makeSendRequestHash({
      identityId,
      to: String(body.to),
      cc: body.cc,
      bcc: body.bcc,
      subject: String(body.subject),
      bodyText: body.bodyText,
      bodyHtml: body.bodyHtml,
      attachments: body.attachments ?? [],
    });

    const idempotency = await getOrCreateSendIdempotency({
      userId,
      identityId,
      idempotencyKey,
      requestHash,
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
      to: String(body.to),
      cc: body.cc,
      bcc: body.bcc,
      subject: String(body.subject),
      bodyText: body.bodyText,
      bodyHtml: body.bodyHtml,
      attachments: body.attachments ?? [],
    });

    return { status: 'queued' };
  });

  app.post('/api/attachments/scan', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.messageId || !body?.attachmentId) {
      return reply.code(400).send({ error: 'messageId and attachmentId required' });
    }
    const attachmentId = String(body.attachmentId);
    const messageId = String(body.messageId);

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
        [body.attachmentId, decision.status, decision.verdictHint],
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
        [body.attachmentId],
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

    const subscription = await createPushSubscription({
      userId,
      endpoint: String(body.endpoint),
      p256dh: String(body.p256dh),
      auth: String(body.auth),
      userAgent: body.userAgent,
    });
    return subscription;
  });

  app.delete('/api/push/subscribe', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.endpoint) {
      return reply.code(400).send({ error: 'endpoint required' });
    }
    await removePushSubscription(userId, String(body.endpoint));
    return { status: 'deleted' };
  });
};
