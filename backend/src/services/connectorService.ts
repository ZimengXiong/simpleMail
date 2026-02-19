import { randomUUID } from 'node:crypto';
import { pool, query } from '../db/pool.js';
import type { IncomingConnectorRecord, OutgoingConnectorRecord, IdentityRecord } from '../shared/types.js';

const toJson = (value: any) => JSON.stringify(value ?? {});

const ensureIdentityOwner = async (userId: string, outgoingConnectorId: string) => {
  const result = await query(
    'SELECT id FROM outgoing_connectors WHERE id = $1 AND user_id = $2',
    [outgoingConnectorId, userId],
  );
  if (result.rows.length === 0) {
    throw new Error('outgoing connector not found');
  }
};

const ensureIncomingConnectorOwner = async (userId: string, incomingConnectorId: string) => {
  const result = await query(
    'SELECT id FROM incoming_connectors WHERE id = $1 AND user_id = $2',
    [incomingConnectorId, userId],
  );
  if (result.rows.length === 0) {
    throw new Error('incoming connector not found');
  }
};

export const listIncomingConnectors = async (userId: string): Promise<IncomingConnectorRecord[]> => {
  const result = await query<any>(
    `SELECT id, user_id, name, email_address as "emailAddress", provider, host, port, tls,
            auth_config as "authConfig", sync_settings as "syncSettings", status,
            visual_config as "visual_config",
            created_at as "createdAt", updated_at as "updatedAt"
       FROM incoming_connectors
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows as IncomingConnectorRecord[];
};

export const getIncomingConnector = async (userId: string, id: string): Promise<any | null> => {
  const result = await query<any>(
    'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return result.rows[0] ?? null;
};

export const getIncomingConnectorById = async (id: string): Promise<any | null> => {
  const result = await query<any>(
    'SELECT * FROM incoming_connectors WHERE id = $1',
    [id],
  );
  return result.rows[0] ?? null;
};

export const deleteIncomingConnector = async (userId: string, id: string): Promise<void> => {
  await query('DELETE FROM incoming_connectors WHERE id = $1 AND user_id = $2', [id, userId]);
};

export const updateIncomingConnector = async (
  userId: string,
  connectorId: string,
  payload: {
    name?: string;
    emailAddress?: string;
    host?: string | null;
    port?: number | null;
    tls?: boolean;
    authConfig?: Record<string, any> | null;
    syncSettings?: Record<string, any> | null;
    visual_config?: Record<string, any> | null;
    status?: string;
  },
) => {
  const values: any[] = [connectorId, userId];
  const setClauses: string[] = [];

  if (payload.name !== undefined) {
    values.push(payload.name);
    setClauses.push(`name = $${values.length}`);
  }
  if (payload.emailAddress !== undefined) {
    values.push(payload.emailAddress);
    setClauses.push(`email_address = $${values.length}`);
  }
  if (payload.host !== undefined) {
    values.push(payload.host);
    setClauses.push(`host = $${values.length}`);
  }
  if (payload.port !== undefined) {
    values.push(payload.port);
    setClauses.push(`port = $${values.length}`);
  }
  if (payload.tls !== undefined) {
    values.push(payload.tls);
    setClauses.push(`tls = $${values.length}`);
  }
  if (payload.authConfig !== undefined) {
    values.push(toJson(payload.authConfig));
    setClauses.push(`auth_config = $${values.length}::jsonb`);
  }
  if (payload.syncSettings !== undefined) {
    values.push(toJson(payload.syncSettings));
    setClauses.push(`sync_settings = $${values.length}::jsonb`);
  }
  if (payload.visual_config !== undefined) {
    values.push(toJson(payload.visual_config));
    setClauses.push(`visual_config = $${values.length}::jsonb`);
  }
  if (payload.status !== undefined) {
    values.push(payload.status);
    setClauses.push(`status = $${values.length}`);
  }

  setClauses.push('updated_at = NOW()');

  if (setClauses.length === 1) {
    return;
  }

  await query(
    `UPDATE incoming_connectors SET ${setClauses.join(', ')} WHERE id = $1 AND user_id = $2`,
    values,
  );
};

export const createIncomingConnector = async (
  userId: string,
  payload: {
    name: string;
    emailAddress: string;
    provider: string;
    host?: string;
    port?: number;
    tls?: boolean;
    authType: string;
    authConfig?: any;
    syncSettings?: any;
    visual_config?: any;
  },
) => {
  const id = randomUUID();
  const result = await query<{ id: string }>(
    `INSERT INTO incoming_connectors
      (id, user_id, name, email_address, provider, host, port, tls, auth_config, sync_settings, visual_config)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb)
     RETURNING id`,
    [
      id,
      userId,
      payload.name,
      payload.emailAddress,
      payload.provider,
      payload.host ?? null,
      payload.port ?? null,
      payload.tls ?? true,
      toJson({ authType: payload.authType, ...(payload.authConfig ?? {}) }),
      toJson(payload.syncSettings ?? {}),
      toJson(payload.visual_config ?? {}),
    ],
  );

  return { id: result.rows[0].id };
};

export const updateIncomingConnectorAuth = async (connectorId: string, authConfig: Record<string, any>, userId?: string) => {
  const values: any[] = [connectorId, JSON.stringify(authConfig)];
  let queryText = 'UPDATE incoming_connectors SET auth_config = $2::jsonb, updated_at = NOW() WHERE id = $1';
  if (userId) {
    queryText += ' AND user_id = $3';
    values.push(userId);
  }
  await query(queryText, values);
};

export const listOutgoingConnectors = async (userId: string): Promise<OutgoingConnectorRecord[]> => {
  const result = await query<any>(
    `SELECT id, user_id, name, provider, from_address as "fromAddress", host, port, tls_mode as "tlsMode", auth_config as "authConfig", from_envelope_defaults as "fromEnvelopeDefaults", sent_copy_behavior as "sentCopyBehavior", created_at as "createdAt", updated_at as "updatedAt"
     FROM outgoing_connectors
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows as OutgoingConnectorRecord[];
};

export const getOutgoingConnector = async (userId: string, id: string): Promise<any | null> => {
  const result = await query<any>(
    'SELECT * FROM outgoing_connectors WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return result.rows[0] ?? null;
};

export const getOutgoingConnectorById = async (id: string): Promise<any | null> => {
  const result = await query<any>('SELECT * FROM outgoing_connectors WHERE id = $1', [id]);
  return result.rows[0] ?? null;
};

export const deleteOutgoingConnector = async (userId: string, id: string): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM send_idempotency si
        USING identities i
       WHERE si.identity_id = i.id
         AND i.user_id = $1
         AND i.outgoing_connector_id = $2`,
      [userId, id],
    );
    await client.query(
      `DELETE FROM identities
        WHERE user_id = $1
          AND outgoing_connector_id = $2`,
      [userId, id],
    );
    await client.query(
      `DELETE FROM outgoing_connectors
        WHERE id = $1
          AND user_id = $2`,
      [id, userId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

export const updateOutgoingConnector = async (
  userId: string,
  connectorId: string,
  payload: {
    name?: string;
    fromAddress?: string;
    host?: string | null;
    port?: number | null;
    tlsMode?: string;
    authConfig?: Record<string, any> | null;
    fromEnvelopeDefaults?: Record<string, any> | null;
    sentCopyBehavior?: Record<string, any> | null;
  },
) => {
  const values: any[] = [connectorId, userId];
  const setClauses: string[] = [];

  if (payload.name !== undefined) {
    values.push(payload.name);
    setClauses.push(`name = $${values.length}`);
  }
  if (payload.fromAddress !== undefined) {
    values.push(payload.fromAddress);
    setClauses.push(`from_address = $${values.length}`);
  }
  if (payload.host !== undefined) {
    values.push(payload.host);
    setClauses.push(`host = $${values.length}`);
  }
  if (payload.port !== undefined) {
    values.push(payload.port);
    setClauses.push(`port = $${values.length}`);
  }
  if (payload.tlsMode !== undefined) {
    values.push(payload.tlsMode);
    setClauses.push(`tls_mode = $${values.length}`);
  }
  if (payload.authConfig !== undefined) {
    values.push(toJson(payload.authConfig));
    setClauses.push(`auth_config = $${values.length}::jsonb`);
  }
  if (payload.fromEnvelopeDefaults !== undefined) {
    values.push(toJson(payload.fromEnvelopeDefaults));
    setClauses.push(`from_envelope_defaults = $${values.length}::jsonb`);
  }
  if (payload.sentCopyBehavior !== undefined) {
    values.push(toJson(payload.sentCopyBehavior));
    setClauses.push(`sent_copy_behavior = $${values.length}::jsonb`);
  }

  setClauses.push('updated_at = NOW()');

  if (setClauses.length === 1) {
    return;
  }

  await query(
    `UPDATE outgoing_connectors SET ${setClauses.join(', ')} WHERE id = $1 AND user_id = $2`,
    values,
  );
};

export const createOutgoingConnector = async (
  userId: string,
  payload: {
    name: string;
    provider: string;
    fromAddress: string;
    host?: string;
    port?: number;
    tlsMode?: string;
    authType?: string;
    authConfig?: any;
    fromEnvelopeDefaults?: any;
    sentCopyBehavior?: any;
  },
) => {
  const id = randomUUID();
  const result = await query<{ id: string }>(
    `INSERT INTO outgoing_connectors
      (id, user_id, name, provider, from_address, host, port, tls_mode, auth_config, from_envelope_defaults, sent_copy_behavior)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb)
     RETURNING id`,
    [
      id,
      userId,
      payload.name,
      payload.provider,
      payload.fromAddress,
      payload.host ?? null,
      payload.port ?? null,
      payload.tlsMode ?? 'starttls',
      JSON.stringify({ authType: payload.authType ?? 'password', ...(payload.authConfig ?? {}) }),
      JSON.stringify(payload.fromEnvelopeDefaults ?? {}),
      JSON.stringify(payload.sentCopyBehavior ?? {}),
    ],
  );

  return { id: result.rows[0].id };
};

export const updateOutgoingConnectorAuth = async (connectorId: string, authConfig: Record<string, any>, userId?: string) => {
  const values: any[] = [connectorId, JSON.stringify(authConfig)];
  let queryText = 'UPDATE outgoing_connectors SET auth_config = $2::jsonb, updated_at = NOW() WHERE id = $1';
  if (userId) {
    queryText += ' AND user_id = $3';
    values.push(userId);
  }
  await query(queryText, values);
};

export const createIdentity = async (
  userId: string,
  displayName: string,
  emailAddress: string,
  outgoingConnectorId: string,
  signature?: string | null,
  sentToIncomingConnectorId?: string | null,
  replyTo?: string | null,
  visual_config?: any,
) => {
  await ensureIdentityOwner(userId, outgoingConnectorId);
  if (sentToIncomingConnectorId) {
    await ensureIncomingConnectorOwner(userId, sentToIncomingConnectorId);
  }

  const id = randomUUID();
  const result = await query<{ id: string }>(
    `INSERT INTO identities
      (id, user_id, display_name, email_address, signature, outgoing_connector_id, sent_to_incoming_connector_id, reply_to, visual_config)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      RETURNING id`,
    [
      id,
      userId,
      displayName,
      emailAddress,
      signature ?? null,
      outgoingConnectorId,
      sentToIncomingConnectorId ?? null,
      replyTo ?? null,
      toJson(visual_config ?? {}),
    ],
  );

  return result.rows[0];
};

export const listIdentities = async (userId: string): Promise<IdentityRecord[]> => {
  const result = await query<any>(
    `SELECT id, user_id as "userId", display_name as "displayName", email_address as "emailAddress", signature,
            outgoing_connector_id as "outgoingConnectorId", sent_to_incoming_connector_id as "sentToIncomingConnectorId",
            reply_to as "replyTo", visual_config as "visual_config"
       FROM identities
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows as IdentityRecord[];
};

export const getIdentity = async (userId: string, id: string): Promise<any | null> => {
  const result = await query<any>(
    'SELECT * FROM identities WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return result.rows[0] ?? null;
};

export const getIdentityById = async (id: string): Promise<any | null> => {
  const result = await query<any>('SELECT * FROM identities WHERE id = $1', [id]);
  return result.rows[0] ?? null;
};

export const deleteIdentity = async (userId: string, id: string): Promise<void> => {
  await query('DELETE FROM identities WHERE id = $1 AND user_id = $2', [id, userId]);
};

export const ensureIdentityOwnership = async (userId: string, identityId: string): Promise<void> => {
  const result = await query<any>('SELECT id FROM identities WHERE id = $1 AND user_id = $2', [identityId, userId]);
  if (result.rows.length === 0) {
    throw new Error('identity not found');
  }
};

export const updateIdentity = async (
  userId: string,
  identityId: string,
  payload: {
    displayName?: string;
    emailAddress?: string;
    signature?: string | null;
    outgoingConnectorId?: string | null;
    sentToIncomingConnectorId?: string | null;
    replyTo?: string | null;
    visual_config?: Record<string, any> | null;
  },
) => {
  await ensureIdentityOwnership(userId, identityId);

  if (payload.outgoingConnectorId !== undefined && payload.outgoingConnectorId !== null) {
    await ensureIdentityOwner(userId, payload.outgoingConnectorId);
  }

  if (payload.sentToIncomingConnectorId !== undefined && payload.sentToIncomingConnectorId !== null) {
    await ensureIncomingConnectorOwner(userId, payload.sentToIncomingConnectorId);
  }

  const values: any[] = [identityId, userId];
  const updates: string[] = [];

  if (payload.displayName !== undefined) {
    values.push(payload.displayName);
    updates.push(`display_name = $${values.length}`);
  }
  if (payload.emailAddress !== undefined) {
    values.push(payload.emailAddress);
    updates.push(`email_address = $${values.length}`);
  }
  if (payload.signature !== undefined) {
    values.push(payload.signature);
    updates.push(`signature = $${values.length}`);
  }
  if (payload.outgoingConnectorId !== undefined) {
    values.push(payload.outgoingConnectorId);
    updates.push(`outgoing_connector_id = $${values.length}`);
  }
  if (payload.sentToIncomingConnectorId !== undefined) {
    values.push(payload.sentToIncomingConnectorId);
    updates.push(`sent_to_incoming_connector_id = $${values.length}`);
  }
  if (payload.replyTo !== undefined) {
    values.push(payload.replyTo);
    updates.push(`reply_to = $${values.length}`);
  }
  if (payload.visual_config !== undefined) {
    values.push(toJson(payload.visual_config));
    updates.push(`visual_config = $${values.length}::jsonb`);
  }

  updates.push('updated_at = NOW()');
  if (updates.length > 1) {
    await query(
      `UPDATE identities SET ${updates.join(', ')} WHERE id = $1 AND user_id = $2`,
      values,
    );
  }
};
