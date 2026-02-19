import { ImapFlow } from 'imapflow';
import { v4 as uuidv4 } from 'uuid';
import { query, now } from '../db/pool.js';
import { blobStore } from '../storage/seaweedS3BlobStore.js';
import { env } from '../config/env.js';
import { parseAndPersistMessage } from './messageParser.js';
import { computeThreadForMessage } from './threading.js';
import { evaluateRules } from './rules.js';
import { emitSyncEvent } from './imapEvents.js';
import { ensureValidGoogleAccessToken } from './googleOAuth.js';

const getConnectorAuth = (connector: any) => connector?.auth_config ?? {};

const toBigInt = (value: any): bigint | null => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    return BigInt(value);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return BigInt(parsed);
};

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    return Number(value);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
};

const toNumberUid = (value: unknown): number | null => {
  const numeric = toNumber(value);
  if (numeric === null) {
    return null;
  }
  return Number.isInteger(numeric) ? numeric : Math.trunc(numeric);
};

const toNumberUidList = (uids: Array<bigint | number | string>): number[] =>
  uids
    .map((uid) => toNumberUid(uid))
    .filter((uid): uid is number => uid !== null);

export const ensureIncomingConnectorState = async (connectorId: string, mailbox: string) => {
  await query(
    `INSERT INTO sync_states (incoming_connector_id, mailbox)
     VALUES ($1, $2)
     ON CONFLICT (incoming_connector_id, mailbox)
     DO UPDATE SET updated_at = NOW()`,
    [connectorId, mailbox],
  );
};

const getIncomingConnectorByIdForUser = async (userId: string, connectorId: string) => {
  const connectorResult = await query<any>(
    'SELECT * FROM incoming_connectors WHERE id = $1 AND user_id = $2',
    [connectorId, userId],
  );
  if (connectorResult.rows.length === 0) {
    return null;
  }
  return connectorResult.rows[0];
};

const getConnectorByMessageId = async (userId: string, messageId: string) => {
  const result = await query<{ incoming_connector_id: string }>(
    `SELECT m.incoming_connector_id
       FROM messages m
       INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
      WHERE m.id = $1 AND ic.user_id = $2`,
    [messageId, userId],
  );
  return result.rows[0]?.incoming_connector_id ?? null;
};

type IdleWatch = {
  stop: boolean;
  stopped: boolean;
  close: () => Promise<void>;
};

const activeIdleWatchers = new Map<string, IdleWatch>();

type GetImapClientOptions = {
  forceOAuthRefresh?: boolean;
};

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isRecoverableImapAuthError = (error: unknown): boolean => {
  const message = String(error).toLowerCase();
  return (
    message.includes('auth') ||
    message.includes('authentication') ||
    message.includes('credentials') ||
    message.includes('invalid_grant') ||
    message.includes('invalid grant') ||
    message.includes('token') ||
    message.includes('login')
  );
};

const isRecoverableImapError = (error: unknown): boolean => {
  const codeError = error as { code?: string; errno?: string; responseCode?: number };
  if (codeError.responseCode && [421, 422, 430, 431, 432, 450, 451, 452, 454].includes(codeError.responseCode)) {
    return true;
  }

  if (
    codeError.code === 'ECONNRESET' ||
    codeError.code === 'ETIMEDOUT' ||
    codeError.code === 'ECONNREFUSED' ||
    codeError.code === 'ENOTFOUND' ||
    codeError.code === 'EPIPE' ||
    codeError.code === 'EAI_AGAIN'
  ) {
    return true;
  }

  const message = String(error).toLowerCase();
  return message.includes('timed out') || message.includes('timeout') || message.includes('temporar') || message.includes('connection');
};

export const getImapClient = async (connector: any, options: GetImapClientOptions = {}) => {
  const auth = getConnectorAuth(connector);
  const resolvedAuth =
    auth.authType === 'oauth2' && connector.provider === 'gmail'
      ? await ensureValidGoogleAccessToken('incoming', connector.id, auth, {
          forceRefresh: options.forceOAuthRefresh,
        })
      : auth;

  const host = connector.host || (connector.provider === 'gmail' ? 'imap.gmail.com' : undefined);
  if (!host) {
    throw new Error('IMAP connector host is required');
  }

  const port = Number(connector.port || (connector.provider === 'gmail' ? 993 : undefined));
  if (!port) {
    throw new Error('IMAP connector port is required');
  }

  const imapAuth: Record<string, any> = {
    user: connector.email_address,
  };

  if (connector.provider === 'gmail' && resolvedAuth.authType === 'oauth2') {
    imapAuth.accessToken = resolvedAuth.accessToken;
  } else {
    imapAuth.pass = resolvedAuth.password;
    imapAuth.loginMethod = 'AUTH=PLAIN';
  }

  return new ImapFlow({
    host,
    port,
    secure: Boolean(connector.tls),
    auth: imapAuth as any,
    logger: false,
    disableAutoIdle: !env.sync.useIdle,
    qresync: true,
    maxIdleTime: env.sync.idleIntervalMs,
  });
};

type ImapClientOperation<T> = (client: ImapFlow) => Promise<T>;

const runImapOperation = async <T>(
  connector: any,
  operation: ImapClientOperation<T>,
  options: GetImapClientOptions = {},
): Promise<T> => {
  const shouldAttemptRefresh = connector.provider === 'gmail' && getConnectorAuth(connector).authType === 'oauth2';
  const maxAttempts = 4;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let client: ImapFlow | null = null;
    const forceOAuthRefresh = options.forceOAuthRefresh || attempt > 0;
    try {
      client = await getImapClient(connector, { forceOAuthRefresh });
      await client.connect();
      const result = await operation(client);
      await client.logout().catch(() => undefined);
      return result;
    } catch (error) {
      lastError = error;
      if (client) {
        await client.logout().catch(() => undefined);
      }

      if (!isRecoverableImapError(error)) {
        throw error;
      }

      if (shouldAttemptRefresh && isRecoverableImapAuthError(error) && attempt < maxAttempts - 1) {
        try {
          const refreshedAuth = await ensureValidGoogleAccessToken(
            'incoming',
            connector.id,
            getConnectorAuth(connector),
            { forceRefresh: true },
          );
          connector.auth_config = refreshedAuth;
        } catch {
          if (attempt === maxAttempts - 1) {
            throw error;
          }
        }
        await delay(Math.min(1000 * 2 ** attempt, 8000));
        continue;
      }

      if (attempt >= maxAttempts - 1) {
        throw error;
      }

      await delay(Math.min(500 * 2 ** attempt, 5000));
    }
  }

  throw lastError;
};

const normalizeAddressList = (addresses: any[] | undefined): string =>
  (addresses ?? [])
    .map((addr) => [addr.name, addr.address].filter(Boolean).join(' '))
    .join(', ');

const getMailboxState = async (connectorId: string, mailbox: string) => {
  const result = await query<any>(
    'SELECT last_seen_uid, uidvalidity, modseq FROM sync_states WHERE incoming_connector_id = $1 AND mailbox = $2',
    [connectorId, mailbox],
  );
  return {
    lastSeenUid: Number(result.rows[0]?.last_seen_uid ?? 0),
    mailboxUidValidity: result.rows[0]?.uidvalidity ?? null,
    modseq: toBigInt(result.rows[0]?.modseq),
  };
};

const reconcileMailboxState = async (connectorId: string, mailbox: string, seenUids: number[]) => {
  const seenSet = new Set(seenUids.map((uid) => String(uid)));
  const result = await query<{ uid: string }>(
    'SELECT uid FROM messages WHERE incoming_connector_id = $1 AND folder_path = $2 AND uid IS NOT NULL',
    [connectorId, mailbox],
  );
  if (result.rows.length === 0) {
    return 0;
  }

  const knownUids = result.rows.map((row) => row.uid.toString());
  const stale = knownUids.filter((uid) => !seenSet.has(uid));
  if (stale.length === 0) {
    return 0;
  }

  for (let index = 0; index < stale.length; index += 500) {
    const chunk = stale.slice(index, index + 500).map((uid) => BigInt(uid));
    await query(
      `DELETE FROM messages
       WHERE incoming_connector_id = $1
         AND folder_path = $2
         AND uid IS NOT NULL
         AND uid = ANY($3::bigint[])`,
      [connectorId, mailbox, chunk],
    );
  }

  return stale.length;
};

const applyMessageMetadataOnlyUpdate = async (
  connectorId: string,
  mailbox: string,
  messageUid: number,
  message: {
    messageId?: string | null;
    subject?: string | null;
    fromHeader?: string | null;
    toHeader?: string | null;
    flags: Set<string>;
    internalDate?: Date | string | null;
  },
  mailboxUidValidity: string | null,
) => {
  const isRead = !message.flags.has('\\Seen');
  const isStarred = message.flags.has('\\Flagged');

  const result = await query<{ id: string }>(
    `UPDATE messages
     SET message_id = COALESCE($4, message_id),
         subject = COALESCE($5, subject),
         from_header = COALESCE($6, from_header),
         to_header = COALESCE($7, to_header),
         is_read = $8,
         is_starred = $9,
         flags = $10,
         snippet = COALESCE($11, snippet),
         mailbox_uidvalidity = $12,
         received_at = COALESCE($13::timestamptz, received_at),
         updated_at = NOW()
     WHERE incoming_connector_id = $1 AND folder_path = $2 AND uid = $3
     RETURNING id`,
    [
      connectorId,
      mailbox,
      messageUid,
      message.messageId ?? null,
      message.subject ?? null,
      message.fromHeader ?? null,
      message.toHeader ?? null,
      isRead,
      isStarred,
      Array.from(message.flags),
      (message.subject ?? '').slice(0, 500),
      mailboxUidValidity,
      message.internalDate ? new Date(message.internalDate).toISOString() : null,
    ],
  );

  return result.rows[0]?.id ?? null;
};

const createNewMessage = async (
  connector: any,
  mailbox: string,
  message: {
    uid: number;
    messageId?: string | null;
    subject?: string | null;
    fromHeader?: string | null;
    toHeader?: string | null;
    source: Buffer;
    internalDate?: Date | string | null;
    flags: Set<string>;
    mailboxUidValidity: string | null;
  },
) => {
  const dbMessageId = uuidv4();
  const rawKey = `raw/${connector.id}/${mailbox}/${message.uid}-${uuidv4()}.eml`;
  const receivedAt = message.internalDate ? new Date(message.internalDate).toISOString() : now();

  await blobStore.putObject(rawKey, message.source, 'message/rfc822');

  const insertResult = await query<{ id: string }>(
    `INSERT INTO messages
       (id, incoming_connector_id, message_id, subject, from_header, to_header, folder_path, raw_blob_key, snippet, received_at, is_read, is_starred, flags, uid, mailbox_uidvalidity, body_text, body_html)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (incoming_connector_id, uid, folder_path) DO UPDATE SET
       message_id = COALESCE(EXCLUDED.message_id, messages.message_id),
       subject = COALESCE(EXCLUDED.subject, messages.subject),
       from_header = COALESCE(EXCLUDED.from_header, messages.from_header),
       to_header = COALESCE(EXCLUDED.to_header, messages.to_header),
       snippet = COALESCE(EXCLUDED.snippet, messages.snippet),
       received_at = COALESCE(EXCLUDED.received_at, messages.received_at),
       is_read = EXCLUDED.is_read,
       is_starred = EXCLUDED.is_starred,
       flags = EXCLUDED.flags,
       uid = EXCLUDED.uid,
       mailbox_uidvalidity = EXCLUDED.mailbox_uidvalidity,
       raw_blob_key = COALESCE(messages.raw_blob_key, EXCLUDED.raw_blob_key),
       updated_at = NOW(),
       search_vector = NULL
     RETURNING id`,
    [
      dbMessageId,
      connector.id,
      message.messageId ?? null,
      message.subject ?? null,
      message.fromHeader ?? null,
      message.toHeader ?? null,
      mailbox,
      rawKey,
      (message.subject ?? '').slice(0, 500),
      receivedAt,
      !message.flags.has('\\Seen'),
      message.flags.has('\\Flagged'),
      Array.from(message.flags),
      message.uid,
      message.mailboxUidValidity,
      null,
      null,
    ],
  );

  const storedId = insertResult.rows[0]?.id;
  if (!storedId) {
    return null;
  }

  const parsedResult = await parseAndPersistMessage(storedId, message.source);
  const messageLookup = await query<any>(
    'SELECT incoming_connector_id, subject, message_id, in_reply_to, references_header, from_header, to_header, raw_headers FROM messages WHERE id = $1',
    [storedId],
  );

  const stored = messageLookup.rows[0];
  const threadId = await computeThreadForMessage({
    id: storedId,
    incomingConnectorId: stored.incoming_connector_id,
    userId: connector.user_id,
    messageId: stored.message_id,
    inReplyTo: stored.in_reply_to,
    referencesHeader: stored.references_header,
    subject: stored.subject,
  });

  await evaluateRules(connector.user_id, stored.incoming_connector_id, {
    id: storedId,
    incomingConnectorId: stored.incoming_connector_id,
    folderPath: mailbox,
    uid: message.uid,
    fromHeader: stored.from_header,
    toHeader: stored.to_header,
    subject: stored.subject,
    rawHeaders: stored.raw_headers,
  }, parsedResult.attachmentCount);

  await emitSyncEvent(connector.id, 'message_synced', {
    messageId: storedId,
    threadId,
    folder: mailbox,
    hasAttachments: parsedResult.attachmentCount > 0,
    isNew: true,
  });

  return { id: storedId, hasAttachment: parsedResult.attachmentCount > 0 };
};

const fetchAllUids = async (incomingConnectorId: string, client: ImapFlow): Promise<number[] | null> => {
  const attempts: Array<() => Promise<number[] | false>> = [
    () => client.search({ all: true }, { uid: true }),
    () => client.search({ uid: '1:*' }, { uid: true }),
  ];

  for (const attempt of attempts) {
    try {
      const fullUids = await attempt();
      if (fullUids !== false) {
        return Array.from(new Set(toNumberUidList(fullUids)));
      }
    } catch (error) {
      await emitSyncEvent(incomingConnectorId, 'sync_error', {
        phase: 'full-uid-scan',
        error: String(error),
      });
    }
  }

  return null;
};

const runMailboxSync = async (connector: any, mailbox: string, options: GetImapClientOptions = {}) => {
  const connectorState = await getMailboxState(connector.id, mailbox);
  const incomingConnectorId: string = connector.id;

  let updated = 0;
  let inserted = 0;
  let reconciledRemoved = 0;
  let metadataRefreshed = 0;
  let lastSeenUid = connectorState.lastSeenUid;
  let nextModseq = connectorState.modseq;
  let lastRemoteUids: number[] = [];

  const flagSyncWindow = Number.isFinite(env.sync.flagSyncWindow) && env.sync.flagSyncWindow > 0
    ? Math.floor(env.sync.flagSyncWindow)
    : 256;

  const normalizeFetchedMessage = (message: any, mailboxUidValidity: string | null) => {
    const numericUid = toNumberUid(message.uid);
    if (numericUid === null) {
      return null;
    }

    return {
      uid: numericUid,
      messageId: message.envelope?.messageId,
      subject: message.envelope?.subject ?? null,
      fromHeader: normalizeAddressList(message.envelope?.from),
      toHeader: normalizeAddressList(message.envelope?.to),
      internalDate: message.internalDate,
      flags: new Set<string>(message.flags ?? []),
      mailboxUidValidity,
      hasSource: !!message.source,
    };
  };

  const processMetadataOnlyMessage = async (message: any, mailboxUidValidity: string | null): Promise<void> => {
    const normalized = normalizeFetchedMessage(message, mailboxUidValidity);
    if (!normalized) {
      return;
    }

    const existing = await query<{ id: string }>(
      'SELECT id FROM messages WHERE incoming_connector_id = $1 AND folder_path = $2 AND uid = $3',
      [incomingConnectorId, mailbox, normalized.uid],
    );

    if (!existing.rows[0]) {
      return;
    }

    await applyMessageMetadataOnlyUpdate(
      incomingConnectorId,
      mailbox,
      normalized.uid,
      {
        messageId: normalized.messageId,
        subject: normalized.subject,
        fromHeader: normalized.fromHeader,
        toHeader: normalized.toHeader,
        flags: normalized.flags,
        internalDate: normalized.internalDate,
      },
      mailboxUidValidity,
    );

    metadataRefreshed += 1;
    updated += 1;
    await emitSyncEvent(incomingConnectorId, 'message_updated', {
      messageId: existing.rows[0].id,
      folder: mailbox,
      uid: normalized.uid,
      syncMode: 'metadata',
    });
  };

  const processSourceMessage = async (message: any, mailboxUidValidity: string | null): Promise<void> => {
    const normalized = normalizeFetchedMessage(message, mailboxUidValidity);
    if (!normalized) {
      return;
    }

    if (!message.source) {
      await processMetadataOnlyMessage(message, mailboxUidValidity);
      return;
    }

    const sourceBuffer = Buffer.isBuffer(message.source)
      ? message.source
      : Buffer.from(message.source as string);

    const existing = await query<{ id: string }>(
      'SELECT id FROM messages WHERE incoming_connector_id = $1 AND folder_path = $2 AND uid = $3',
      [incomingConnectorId, mailbox, normalized.uid],
    );

    if (existing.rows[0]) {
      await applyMessageMetadataOnlyUpdate(
        incomingConnectorId,
        mailbox,
        normalized.uid,
        {
          messageId: normalized.messageId,
          subject: normalized.subject,
          fromHeader: normalized.fromHeader,
          toHeader: normalized.toHeader,
          flags: normalized.flags,
          internalDate: normalized.internalDate,
        },
        mailboxUidValidity,
      );
      updated += 1;

      await emitSyncEvent(incomingConnectorId, 'message_updated', {
        messageId: existing.rows[0].id,
        folder: mailbox,
        uid: normalized.uid,
        syncMode: 'source',
      });
      return;
    }

    const created = await createNewMessage(connector, mailbox, {
      uid: normalized.uid,
      messageId: normalized.messageId,
      subject: normalized.subject,
      fromHeader: normalized.fromHeader,
      toHeader: normalized.toHeader,
      source: sourceBuffer,
      internalDate: normalized.internalDate,
      flags: normalized.flags,
      mailboxUidValidity,
    });

    if (created) {
      inserted += 1;
    }
  };

  const refreshMetadataTail = async (client: ImapFlow, mailboxUidValidity: string | null) => {
    const candidates =
      lastRemoteUids.length > 0
        ? lastRemoteUids.slice(Math.max(0, lastRemoteUids.length - flagSyncWindow))
        : [];

    if (candidates.length === 0) {
      return;
    }

    for await (const message of client.fetch(candidates, {
      uid: true,
      envelope: true,
      internalDate: true,
      flags: true,
    }, {
      uid: true,
    })) {
      await processMetadataOnlyMessage(message, mailboxUidValidity);
    }
  };

  return runImapOperation(connector, async (client) => {
    const mailboxLock = await client.mailboxOpen(mailbox);
    const currentUidValidity = mailboxLock.uidValidity ? String(mailboxLock.uidValidity) : null;
    const currentModseq = toBigInt(mailboxLock.highestModseq) ?? undefined;

    if (
      connectorState.mailboxUidValidity &&
      currentUidValidity &&
      connectorState.mailboxUidValidity !== currentUidValidity
    ) {
      await query('DELETE FROM messages WHERE incoming_connector_id = $1 AND folder_path = $2', [incomingConnectorId, mailbox]);
      lastSeenUid = 0;
      nextModseq = null;
    }

    let usedIncremental = false;
    if (nextModseq !== null && lastSeenUid > 0) {
      try {
        for await (const message of client.fetch('1:*', {
          uid: true,
          envelope: true,
          internalDate: true,
          flags: true,
          source: true,
        }, {
          uid: true,
          changedSince: currentModseq,
        })) {
          usedIncremental = true;
          await processSourceMessage(message, currentUidValidity);
        }
      } catch (error) {
        await emitSyncEvent(incomingConnectorId, 'sync_error', {
          mailbox,
          phase: 'changedSince',
          error: String(error),
        });
        usedIncremental = false;
      }
    }

    if (!usedIncremental) {
      const rangeStart = Math.max(1, lastSeenUid + 1);
      const searchRange = `${rangeStart}:*`;
      const uids = await client.search({ uid: searchRange }, { uid: true });
      if (uids !== false && uids.length > 0) {
        for await (const message of client.fetch(uids, {
          uid: true,
          envelope: true,
          internalDate: true,
          flags: true,
          source: true,
        }, { uid: true })) {
          await processSourceMessage(message, currentUidValidity);
        }
      }
    }

    const fullUids = await fetchAllUids(incomingConnectorId, client);
    if (fullUids !== null) {
      const uniqueUids = Array.from(new Set(fullUids)).sort((left, right) => left - right);
      lastRemoteUids = uniqueUids;
      reconciledRemoved = await reconcileMailboxState(incomingConnectorId, mailbox, uniqueUids);
      await refreshMetadataTail(client, currentUidValidity);
    }

    if (currentModseq) {
      nextModseq = currentModseq;
    }

    const maxRemoteUid = lastRemoteUids.length > 0 ? lastRemoteUids[lastRemoteUids.length - 1] : lastSeenUid;
    const normalizedModseq = nextModseq ? String(nextModseq) : null;

    await query(
      `UPDATE sync_states
         SET last_seen_uid = $3,
             uidvalidity = $4,
             modseq = $5,
             updated_at = NOW()
         WHERE incoming_connector_id = $1 AND mailbox = $2`,
      [incomingConnectorId, mailbox, maxRemoteUid, currentUidValidity, normalizedModseq],
    );

    await emitSyncEvent(incomingConnectorId, 'sync_completed', {
      mailbox,
      inserted,
      updated,
      reconciledRemoved,
      metadataRefreshed,
    });
    return;
  }, options);
};

const syncMailbox = async (connector: any, mailbox: string) => {
  return runMailboxSync(connector, mailbox);
};

export const syncIncomingConnector = async (userId: string, connectorId: string, mailbox = env.sync.defaultMailbox) => {
  const connector = await getIncomingConnectorByIdForUser(userId, connectorId);
  if (!connector) {
    throw new Error(`Incoming connector ${connectorId} not found`);
  }
  await ensureIncomingConnectorState(connectorId, mailbox);
  await syncMailbox(connector, mailbox);
};

const createWatcherKey = (connectorId: string, mailbox: string) => `${connectorId}:${mailbox}`;

const getConnectorAuthToken = (connectorAuth: any) => connectorAuth?.accessToken ?? connectorAuth?.password;

export const startIncomingConnectorIdleWatch = async (userId: string, connectorId: string, mailbox = env.sync.defaultMailbox) => {
  const key = createWatcherKey(connectorId, mailbox);
  if (activeIdleWatchers.has(key)) {
    return;
  }

  const connector = await getIncomingConnectorByIdForUser(userId, connectorId);
  if (!connector) {
    throw new Error(`Incoming connector ${connectorId} not found`);
  }
  if (!getConnectorAuthToken(connector.auth_config)) {
    throw new Error(`Incoming connector ${connectorId} has no auth credentials`);
  }

  const state: IdleWatch = {
    stop: false,
    stopped: false,
    close: async () => Promise.resolve(),
  };

  const openWatchClient = async (forceOAuthRefresh = false) => {
    const watchClient = await getImapClient(connector, { forceOAuthRefresh });
    await watchClient.connect();
    await watchClient.mailboxOpen(mailbox);
    return watchClient;
  };

  let client = await openWatchClient();
  activeIdleWatchers.set(key, state);

  state.close = async () => {
    state.stop = true;
    await client.logout().catch(() => undefined);
  };

  const ensureSync = async () => {
    try {
      await syncIncomingConnector(userId, connectorId, mailbox);
    } catch (error) {
      await emitSyncEvent(connector.id, 'sync_error', {
        mailbox,
        error: String(error),
      });
    }
  };

  (async () => {
    try {
      await ensureSync();

      while (!state.stop) {
        let hasChanges = false;
        try {
          hasChanges = await client.idle();
        } catch (error) {
          if (state.stop) {
            break;
          }

          await emitSyncEvent(connector.id, 'sync_error', {
            mailbox,
            error: String(error),
          });

          const shouldRefreshAuth = connector.provider === 'gmail'
            && getConnectorAuth(connector).authType === 'oauth2'
            && isRecoverableImapAuthError(error);

          if (shouldRefreshAuth) {
            try {
              const refreshedAuth = await ensureValidGoogleAccessToken('incoming', connector.id, getConnectorAuth(connector), {
                forceRefresh: true,
              });
              connector.auth_config = refreshedAuth;
            } catch (refreshError) {
              await emitSyncEvent(connector.id, 'sync_error', {
                mailbox,
                error: String(refreshError),
              });
            }
          }

          await client.logout().catch(() => undefined);

          await delay(1000);
          try {
            client = await openWatchClient(shouldRefreshAuth);
            continue;
          } catch (reconnectError) {
            await emitSyncEvent(connector.id, 'sync_error', {
              mailbox,
              error: String(reconnectError),
            });
            await delay(2000);
            continue;
          }
        }

        if (hasChanges) {
          await ensureSync();
        }
      }
    } finally {
      state.stopped = true;
      await client.logout().catch(() => undefined);
      if (activeIdleWatchers.get(key) === state) {
        activeIdleWatchers.delete(key);
      }
    }
  })();
};

export const stopIncomingConnectorIdleWatch = async (userId: string, connectorId: string, mailbox = env.sync.defaultMailbox) => {
  const connector = await getIncomingConnectorByIdForUser(userId, connectorId);
  if (!connector) {
    throw new Error(`Incoming connector ${connectorId} not found`);
  }

  const key = createWatcherKey(connectorId, mailbox);
  const existing = activeIdleWatchers.get(key);
  if (!existing) {
    return { stopped: true };
  }

  await existing.close();
  while (!existing.stopped) {
    await delay(25);
  }
  activeIdleWatchers.delete(key);
  return { stopped: true };
};

export const appendMessageToMailbox = async (
  userId: string,
  incomingConnectorId: string,
  mailbox: string,
  rawMessage: Buffer,
) => {
  const incomingConnector = await getIncomingConnectorByIdForUser(userId, incomingConnectorId);
  if (!incomingConnector) {
    throw new Error('Incoming connector not found');
  }

  await runImapOperation(incomingConnector, async (client) => {
    await client.mailboxOpen(mailbox);
    await client.append(mailbox, rawMessage, ['Seen']);
    return;
  });
};

export const moveMessageInMailbox = async (
  userId: string,
  messageId: string,
  incomingConnectorId: string,
  sourceFolder: string,
  destinationFolder: string,
  uid: number,
) => {
  const incomingConnector = await getIncomingConnectorByIdForUser(userId, incomingConnectorId);
  if (!incomingConnector) {
    throw new Error('Incoming connector not found');
  }

  const messageConnectorId = await getConnectorByMessageId(userId, messageId);
  if (!messageConnectorId || messageConnectorId !== incomingConnectorId) {
    throw new Error('Message not found');
  }

  await runImapOperation(incomingConnector, async (client) => {
    await client.mailboxOpen(sourceFolder);
    await client.messageMove(String(uid), destinationFolder, { uid: true });
    await query(
      'UPDATE messages SET folder_path = $2, updated_at = NOW() WHERE id = $1',
      [messageId, destinationFolder],
    );
  });
};

export const setMessageReadState = async (
  userId: string,
  messageId: string,
  incomingConnectorId: string,
  folderPath: string,
  uid: number,
  isRead: boolean,
) => {
  const incomingConnector = await getIncomingConnectorByIdForUser(userId, incomingConnectorId);
  if (!incomingConnector) {
    throw new Error('Incoming connector not found');
  }

  const messageConnectorId = await getConnectorByMessageId(userId, messageId);
  if (!messageConnectorId || messageConnectorId !== incomingConnectorId) {
    throw new Error('Message not found');
  }

  await runImapOperation(incomingConnector, async (client) => {
    await client.mailboxOpen(folderPath);
    if (isRead) {
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    } else {
      await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
    }
    await query(
      'UPDATE messages SET is_read = $2, updated_at = NOW() WHERE id = $1',
      [messageId, isRead],
    );
  });
};

export const setMessageStarredState = async (
  userId: string,
  messageId: string,
  incomingConnectorId: string,
  folderPath: string,
  uid: number,
  isStarred: boolean,
) => {
  const incomingConnector = await getIncomingConnectorByIdForUser(userId, incomingConnectorId);
  if (!incomingConnector) {
    throw new Error('Incoming connector not found');
  }

  const messageConnectorId = await getConnectorByMessageId(userId, messageId);
  if (!messageConnectorId || messageConnectorId !== incomingConnectorId) {
    throw new Error('Message not found');
  }

  await runImapOperation(incomingConnector, async (client) => {
    await client.mailboxOpen(folderPath);
    if (isStarred) {
      await client.messageFlagsAdd(String(uid), ['\\Flagged'], { uid: true });
    } else {
      await client.messageFlagsRemove(String(uid), ['\\Flagged'], { uid: true });
    }
    await query(
      'UPDATE messages SET is_starred = $2, updated_at = NOW() WHERE id = $1',
      [messageId, isStarred],
    );
  });
};

export const deleteMessageFromMailbox = async (
  userId: string,
  messageId: string,
  incomingConnectorId: string,
  folderPath: string,
  uid: number,
) => {
  const incomingConnector = await getIncomingConnectorByIdForUser(userId, incomingConnectorId);
  if (!incomingConnector) {
    throw new Error('Incoming connector not found');
  }

  const messageConnectorId = await getConnectorByMessageId(userId, messageId);
  if (!messageConnectorId || messageConnectorId !== incomingConnectorId) {
    throw new Error('Message not found');
  }

  await runImapOperation(incomingConnector, async (client) => {
    await client.mailboxOpen(folderPath);
    await client.messageDelete(String(uid), { uid: true });
    await query('DELETE FROM messages WHERE id = $1', [messageId]);
  });
};

export const listConnectorMailboxes = async (userId: string, connectorId: string) => {
  const connector = await getIncomingConnectorByIdForUser(userId, connectorId);
  if (!connector) {
    throw new Error(`Incoming connector ${connectorId} not found`);
  }

  return runImapOperation(connector, async (client) => {
    const mailboxes = await client.list();
    return mailboxes.map((mailbox) => ({
      path: mailbox.path,
      name: mailbox.name,
      delimiter: mailbox.delimiter,
      flags: Array.from(mailbox.flags ?? []),
      subscribed: mailbox.subscribed ?? false,
      specialUse: mailbox.specialUse ?? null,
    }));
  });
};
