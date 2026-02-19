import { ImapFlow } from 'imapflow';
import { v4 as uuidv4 } from 'uuid';
import { query, now } from '../db/pool.js';
import { blobStore } from '../storage/seaweedS3BlobStore.js';
import { env } from '../config/env.js';
import { parseAndPersistMessage } from './messageParser.js';
import { computeThreadForMessage } from './threading.js';
import { emitSyncEvent } from './imapEvents.js';
import { enqueueGmailHydration } from './queue.js';
import { ensureValidGoogleAccessToken, isGoogleTokenExpiringSoon } from './googleOAuth.js';
import { gmailApiRequest, listAllGmailPages } from './gmailApi.js';
import {
  addLabelsToMessageByKey,
  ensureSystemLabelsForUser,
  removeLabelsFromMessageByKey,
  syncSystemLabelsForMessage,
} from './labels.js';

const getConnectorAuth = (connector: any) => connector?.auth_config ?? {};

const isGmailImapConnector = (connector: any): boolean => {
  if (!connector) {
    return false;
  }
  if (connector.provider === 'gmail') {
    return true;
  }
  return (
    connector.provider === 'imap' &&
    Boolean(
      connector.sync_settings?.gmailImap ||
      connector.syncSettings?.gmailImap,
    )
  );
};

type SyncMailboxStatus = 'idle' | 'queued' | 'syncing' | 'cancel_requested' | 'cancelled' | 'completed' | 'error';

type SyncProgressSnapshot = {
  inserted: number;
  updated: number;
  reconciledRemoved: number;
  metadataRefreshed: number;
};

type SyncStatePatch = {
  status?: SyncMailboxStatus | null;
  syncStartedAt?: string | Date | null;
  syncCompletedAt?: string | Date | null;
  syncError?: string | null;
  syncProgress?: SyncProgressSnapshot | Record<string, any> | null;
  lastSeenUid?: number | null;
  highestUid?: number | null;
  lastFullReconcileAt?: string | Date | null;
  mailboxUidValidity?: string | null;
  modseq?: string | null;
};

const normalizeSyncProgress = (progress: SyncProgressSnapshot | Record<string, any> | null | undefined) =>
  progress && typeof progress === 'object' ? progress : {};

let syncStateColumnCache: Set<string> | null = null;

const getSyncStateColumns = async () => {
  if (syncStateColumnCache) {
    return syncStateColumnCache;
  }

  const result = await query<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sync_states'
  `);

  syncStateColumnCache = new Set(
    result.rows.map((row) => row.column_name.toLowerCase()),
  );
  return syncStateColumnCache;
};

export const setSyncState = async (
  connectorId: string,
  mailbox: string,
  patch: SyncStatePatch,
) => {
  const safeQuery = async <T>(fn: () => Promise<T>, fallback: T) => {
    try {
      return await fn();
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError?.code === '42703' || pgError?.code === '42P01') {
        return fallback;
      }
      throw error;
    }
  };

  const columns = await safeQuery(() => getSyncStateColumns(), new Set<string>([
    'incoming_connector_id',
    'mailbox',
    'updated_at',
    'uidvalidity',
    'last_seen_uid',
    'modseq',
  ]));
  const assignments: string[] = [];
  const values: any[] = [connectorId, mailbox];

  if (patch.status !== undefined && columns.has('status')) {
    assignments.push(`status = $${values.push(patch.status)}`);
  }
  if (patch.syncStartedAt !== undefined && columns.has('sync_started_at')) {
    assignments.push(`sync_started_at = $${values.push(patch.syncStartedAt)}`);
  }
  if (patch.syncCompletedAt !== undefined && columns.has('sync_completed_at')) {
    assignments.push(`sync_completed_at = $${values.push(patch.syncCompletedAt)}`);
  }
  if (patch.syncError !== undefined && columns.has('sync_error')) {
    assignments.push(`sync_error = $${values.push(patch.syncError)}`);
  }
  if (patch.syncProgress !== undefined && columns.has('sync_progress')) {
    assignments.push(`sync_progress = $${values.push(JSON.stringify(normalizeSyncProgress(patch.syncProgress)))}::jsonb`);
  }
  if (patch.lastSeenUid !== undefined && columns.has('last_seen_uid')) {
    assignments.push(`last_seen_uid = $${values.push(patch.lastSeenUid)}`);
  }
  if (patch.highestUid !== undefined && columns.has('highest_uid')) {
    assignments.push(`highest_uid = $${values.push(patch.highestUid)}`);
  }
  if (patch.lastFullReconcileAt !== undefined && columns.has('last_full_reconcile_at')) {
    assignments.push(`last_full_reconcile_at = $${values.push(patch.lastFullReconcileAt)}`);
  }
  if (patch.mailboxUidValidity !== undefined && columns.has('uidvalidity')) {
    assignments.push(`uidvalidity = $${values.push(patch.mailboxUidValidity)}`);
  }
  if (patch.modseq !== undefined && columns.has('modseq')) {
    assignments.push(`modseq = $${values.push(patch.modseq)}`);
  }

  if (assignments.length === 0) {
    await safeQuery(
      () => query(
        `UPDATE sync_states
            SET updated_at = NOW()
          WHERE incoming_connector_id = $1
            AND mailbox = $2`,
        [connectorId, mailbox],
      ),
      null,
    );
    return;
  }

  assignments.push('updated_at = NOW()');

  await query(
    `UPDATE sync_states
       SET ${assignments.join(', ')}
     WHERE incoming_connector_id = $1
       AND mailbox = $2`,
    values,
  );
};

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

const chunkArray = <T>(values: T[], chunkSize: number): T[][] => {
  if (values.length === 0) {
    return [];
  }
  const size = Number.isFinite(chunkSize) && chunkSize > 0 ? Math.floor(chunkSize) : values.length;
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

export const ensureIncomingConnectorState = async (connectorId: string, mailbox: string) => {
  await query(
    `INSERT INTO sync_states (incoming_connector_id, mailbox)
     VALUES ($1, $2)
     ON CONFLICT (incoming_connector_id, mailbox)
     DO NOTHING`,
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

const getGmailMessageForUser = async (userId: string, messageId: string) => {
  const result = await query<{
    gmail_message_id: string | null;
    folder_path: string;
    is_read: boolean;
    is_starred: boolean;
    flags: string[];
  }>(
    `SELECT m.gmail_message_id,
            m.folder_path,
            m.is_read,
            m.is_starred,
            COALESCE(m.flags, ARRAY[]::text[]) as flags
       FROM messages m
       INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
      WHERE m.id = $1
        AND ic.user_id = $2`,
    [messageId, userId],
  );
  return result.rows[0] ?? null;
};

const setFlagInList = (flags: string[], flag: string, enabled: boolean) => {
  const next = new Set<string>((flags ?? []).map((value) => String(value)));
  if (enabled) {
    next.add(flag);
  } else {
    next.delete(flag);
  }
  return Array.from(next).sort();
};

const getThreadMessageRowsForUser = async (userId: string, threadId: string) => {
  const result = await query<{
    id: string;
    incoming_connector_id: string;
    folder_path: string;
    uid: number | null;
  }>(`
    SELECT m.id, m.incoming_connector_id, m.folder_path, m.uid
      FROM messages m
      INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
     WHERE m.thread_id = $1
       AND ic.user_id = $2
     ORDER BY m.received_at DESC
  `, [threadId, userId]);
  return result.rows;
};

const getThreadIdForMessage = async (userId: string, messageId: string) => {
  const result = await query<{ thread_id: string }>(
    `SELECT m.thread_id
       FROM messages m
       INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
      WHERE m.id = $1 AND ic.user_id = $2`,
    [messageId, userId],
  );
  return result.rows[0]?.thread_id ?? null;
};

type IdleWatch = {
  userId: string;
  connectorId: string;
  mailbox: string;
  provider: string;
  startedAtMs: number;
  lastActivityAtMs: number;
  reconnectCount: number;
  errorCount: number;
  lastError: string | null;
  stop: boolean;
  stopped: boolean;
  close: () => Promise<void>;
};

const activeIdleWatchers = new Map<string, IdleWatch>();
const IMAP_TIMEOUT_SENTINEL = 'IMAP_OPERATION_TIMEOUT';
const SYNC_CANCELLED_SENTINEL = 'SYNC_CANCELLED';
const SYNC_ALREADY_RUNNING_SENTINEL = 'SYNC_ALREADY_RUNNING';
const GMAIL_HISTORY_STALE_SENTINEL = 'GMAIL_HISTORY_TOO_OLD';

const GMAIL_SPECIAL_USE_MAP: Record<string, string> = {
  INBOX: '\\Inbox',
  STARRED: '\\Flagged',
  SENT: '\\Sent',
  DRAFT: '\\Drafts',
  SPAM: '\\Junk',
  TRASH: '\\Trash',
  IMPORTANT: '\\Important',
};

const GMAIL_SYSTEM_LABEL_ORDER: Record<string, number> = {
  INBOX: 10,
  STARRED: 20,
  SENT: 30,
  DRAFT: 40,
  IMPORTANT: 50,
  SPAM: 60,
  TRASH: 70,
};

const GMAIL_IMAP_FOLDER_BY_SPECIAL_USE: Record<string, string> = {
  '\\INBOX': 'INBOX',
  '\\SENT': 'SENT',
  '\\DRAFTS': 'DRAFT',
  '\\TRASH': 'TRASH',
  '\\JUNK': 'SPAM',
  '\\FLAGGED': 'STARRED',
  '\\IMPORTANT': 'IMPORTANT',
  '\\ALL': 'ALL',
};

const GMAIL_IMAP_MAILBOX_ALIASES: Record<string, string[]> = {
  INBOX: ['INBOX'],
  SENT: ['[GMAIL]/SENT MAIL', '[GOOGLE MAIL]/SENT MAIL', '[GMAIL]/SENT', '[GOOGLE MAIL]/SENT'],
  TRASH: ['[GMAIL]/TRASH', '[GOOGLE MAIL]/TRASH', '[GMAIL]/TRASH'],
  SPAM: ['[GMAIL]/SPAM', '[GMAIL]/JUNK', '[GOOGLE MAIL]/SPAM', '[GOOGLE MAIL]/JUNK', '[GOOGLE MAIL]/SPAM FOLDER', '[GMAIL]/SPAM', '[GMAIL]/JUNK', '[GMAIL]/BULK', '[GOOGLE MAIL]/BULK'],
  STARRED: ['[GMAIL]/STARRED', '[GOOGLE MAIL]/STARRED', '[GMAIL]/STARRED MAIL'],
  IMPORTANT: ['[GMAIL]/IMPORTANT', '[GOOGLE MAIL]/IMPORTANT'],
  DRAFT: ['[GMAIL]/DRAFTS', '[GOOGLE MAIL]/DRAFTS', '[GMAIL]/DRAFT', '[GOOGLE MAIL]/DRAFT'],
  ALL: ['[GMAIL]/ALL MAIL', '[GOOGLE MAIL]/ALL MAIL', 'ALL MAIL'],
};

const GMAIL_IMAP_BRACKET_CANONICAL: Record<string, string> = {
  'INBOX': 'INBOX',
  'SENT MAIL': 'SENT',
  'SENT': 'SENT',
  'DRAFTS': 'DRAFT',
  'DRAFT': 'DRAFT',
  'TRASH': 'TRASH',
  'SPAM': 'SPAM',
  'STARRED': 'STARRED',
  'IMPORTANT': 'IMPORTANT',
  'ALL MAIL': 'ALL',
};

type GmailImapMailboxDirectoryEntry = {
  serverPath: string;
  canonicalPath: string | null;
  displayPath: string;
  specialUse: string | null;
  name: string;
  delimiter: string;
  subscribed: boolean;
};

type GmailImapMailboxDirectory = {
  canonicalToServer: Map<string, string>;
  serverToCanonical: Map<string, string>;
  displayRows: GmailImapMailboxDirectoryEntry[];
};

const gmailImapMailboxDirectoryCache = new Map<string, { expiresAt: number; directory: GmailImapMailboxDirectory }>();
const GMAIL_IMAP_MAILBOX_DIRECTORY_TTL_MS = 60_000;

const toUpperStringSet = (value: unknown): Set<string> => {
  if (value === undefined || value === null) {
    return new Set();
  }
  if (typeof value === 'string') {
    return new Set(value.split(',').map((entry) => String(entry).trim().toUpperCase()));
  }
  if (Array.isArray(value)) {
    return new Set(value.map((entry) => String(entry).trim().toUpperCase()));
  }
  if (value instanceof Set) {
    return new Set(Array.from(value).map((entry) => String(entry).trim().toUpperCase()));
  }
  return new Set();
};

const inferGmailImapCanonicalPath = (path: string, mailbox: any): string | null => {
  const marker = toUpperStringSet(mailbox?.specialUse ?? mailbox?.flags ?? mailbox?.specialUseFlags);
  if (marker.has('\\ALL')) {
    return 'ALL';
  }
  if (marker.has('\\INBOX')) {
    return 'INBOX';
  }
  if (marker.has('\\STARRED') || marker.has('\\FLAGGED')) {
    return 'STARRED';
  }
  if (marker.has('\\IMPORTANT')) {
    return 'IMPORTANT';
  }
  for (const [specialUse, canonical] of Object.entries(GMAIL_IMAP_FOLDER_BY_SPECIAL_USE)) {
    if (marker.has(specialUse)) {
      return canonical;
    }
  }

  const normalized = String(path ?? '').trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  if (normalized === 'INBOX') {
    return 'INBOX';
  }
  if (normalized.startsWith('[GMAIL]/') || normalized.startsWith('[GOOGLE MAIL]/')) {
    const suffix = normalized.slice(normalized.indexOf('/') + 1).trim();
    return GMAIL_IMAP_BRACKET_CANONICAL[suffix] ?? null;
  }

  return null;
};

const buildGmailImapMailboxDirectory = async (connectorId: string, client: ImapFlow): Promise<GmailImapMailboxDirectory> => {
  const now = Date.now();
  const cached = gmailImapMailboxDirectoryCache.get(connectorId);
  if (cached && cached.expiresAt > now) {
    return cached.directory;
  }

  const mailboxes = await client.list();

  const canonicalToServer = new Map<string, string>();
  const serverToCanonical = new Map<string, string>();
  const displayRows: GmailImapMailboxDirectoryEntry[] = [];
  const seenDisplay = new Set<string>();

  const registerRow = (entry: GmailImapMailboxDirectoryEntry) => {
    const displayKey = entry.displayPath.toUpperCase();
    if (seenDisplay.has(displayKey)) {
      return;
    }
    seenDisplay.add(displayKey);
    displayRows.push(entry);
  };

  for (const mailbox of mailboxes) {
    const serverPath = String(mailbox.path ?? '').trim();
    if (!serverPath) {
      continue;
    }
    const canonicalPath = inferGmailImapCanonicalPath(serverPath, mailbox);
    const displayPath = canonicalPath ?? serverPath;
    registerRow({
      serverPath,
      canonicalPath,
      displayPath,
      specialUse: mailbox.specialUse ? String(mailbox.specialUse) : null,
      name: mailbox.name ?? serverPath,
      delimiter: mailbox.delimiter ?? '/',
      subscribed: Boolean(mailbox.subscribed),
    });
    serverToCanonical.set(serverPath, canonicalPath || serverPath);
    if (canonicalPath && !canonicalToServer.has(canonicalPath)) {
      canonicalToServer.set(canonicalPath, serverPath);
    }
  }

  const directory = { canonicalToServer, serverToCanonical, displayRows };
  gmailImapMailboxDirectoryCache.set(connectorId, { expiresAt: now + GMAIL_IMAP_MAILBOX_DIRECTORY_TTL_MS, directory });
  return directory;
};

const resolveGmailImapMailboxPath = async (connector: any, client: ImapFlow, mailbox: string): Promise<string> => {
  if (!isGmailImapConnector(connector)) {
    return mailbox;
  }

  const directory = await buildGmailImapMailboxDirectory(connector.id, client);
  const requestedPath = String(mailbox ?? '').trim();
  if (!requestedPath) {
    return requestedPath;
  }

  const requestedCanonical = normalizeGmailMailboxPath(requestedPath);
  if (directory.canonicalToServer.has(requestedCanonical)) {
    return directory.canonicalToServer.get(requestedCanonical)!;
  }

  if (directory.serverToCanonical.has(requestedPath)) {
    return requestedPath;
  }

  const requestedUpper = requestedPath.toUpperCase();
  const knownByPath = directory.displayRows.find((entry) => entry.serverPath.toUpperCase() === requestedUpper);
  if (knownByPath) {
    return knownByPath.serverPath;
  }

  for (const entry of directory.displayRows) {
    if (normalizeGmailMailboxPath(entry.serverPath) === requestedCanonical) {
      return entry.serverPath;
    }
  }

  return requestedPath;
};

const clearGmailImapMailboxDirectoryCache = (connectorId?: string) => {
  if (!connectorId) {
    gmailImapMailboxDirectoryCache.clear();
    return;
  }
  gmailImapMailboxDirectoryCache.delete(connectorId);
};

export const normalizeGmailMailboxPath = (mailbox: string) => {
  const value = String(mailbox || '').trim();
  if (!value) return 'INBOX';
  const upper = value.toUpperCase();
  const legacyMap: Record<string, string> = {
    '[GMAIL]/SENT MAIL': 'SENT',
    '[GMAIL]/SPAM': 'SPAM',
    '[GMAIL]/TRASH': 'TRASH',
    '[GMAIL]/STARRED': 'STARRED',
    '[GMAIL]/DRAFTS': 'DRAFT',
    '[GMAIL]/IMPORTANT': 'IMPORTANT',
    '[GMAIL]/ALL MAIL': 'ALL',
  };
  return legacyMap[upper] ?? upper;
};

export const getGmailMailboxPathAliases = (mailbox: string): string[] => {
  const canonical = normalizeGmailMailboxPath(mailbox);
  const aliases = new Set<string>([canonical]);
  const extra = GMAIL_IMAP_MAILBOX_ALIASES[canonical];
  if (extra) {
    for (const entry of extra) {
      if (entry) {
        aliases.add(entry.toUpperCase());
      }
    }
  }
  aliases.add(canonical.toUpperCase());
  return Array.from(aliases).map((value) => String(value).trim()).filter(Boolean);
};

const mailboxToGmailLabelFilter = (mailbox: string) => {
  const normalized = normalizeGmailMailboxPath(mailbox);
  if (normalized === 'ALL') {
    return { mailbox: 'ALL', labelId: null };
  }
  return { mailbox: normalized, labelId: normalized };
};

const mapFolderToGmailLabelId = (folderPath: string) => {
  const { labelId } = mailboxToGmailLabelFilter(folderPath);
  return labelId;
};

const gmailModifyMessageLabels = async (
  connector: any,
  gmailMessageId: string,
  addLabelIds: string[] = [],
  removeLabelIds: string[] = [],
) => {
  const payload = await gmailApiRequest<{
    labelIds?: string[];
  }>(
    'incoming',
    connector,
    `/messages/${encodeURIComponent(gmailMessageId)}/modify`,
    {
      method: 'POST',
      body: JSON.stringify({
        addLabelIds,
        removeLabelIds,
      }),
    },
  );
  return payload.labelIds ?? [];
};

type GetImapClientOptions = {
  forceOAuthRefresh?: boolean;
  operationTimeoutMs?: number;
  gmailHistoryIdHint?: string | null;
};

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const clampConcurrency = (value: number, fallback: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
};

const mapWithConcurrency = async <T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) => {
  if (items.length === 0) {
    return;
  }

  const size = clampConcurrency(concurrency, 1);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
};

const retryWithJitter = (milliseconds: number) => {
  const capped = Math.max(250, milliseconds);
  const jitter = Math.floor(capped * 0.2 * Math.random());
  return delay(capped + jitter);
};

const runWithTimeout = async <T>(
  label: string,
  timeoutMs: number,
  fn: () => Promise<T>,
  onTimeout?: () => Promise<void> | void,
): Promise<T> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fn();
  }

  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    return await Promise.race<T>([
      fn(),
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          void Promise.resolve(onTimeout?.()).catch(() => undefined);
          reject(new Error(`${IMAP_TIMEOUT_SENTINEL}: ${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

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
  const message = String(error);
  if (message.includes(IMAP_TIMEOUT_SENTINEL)) {
    return false;
  }

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

  const lowered = message.toLowerCase();
  return lowered.includes('timed out') || lowered.includes('timeout') || lowered.includes('temporar') || lowered.includes('connection');
};

const shouldProactivelyRefreshGoogleToken = (connector: any): boolean => isGoogleTokenExpiringSoon(
  getConnectorAuth(connector),
);

export const getImapClient = async (connector: any, options: GetImapClientOptions = {}) => {
  const auth = getConnectorAuth(connector);
  const resolvedAuth =
    auth.authType === 'oauth2' && isGmailImapConnector(connector)
      ? await ensureValidGoogleAccessToken('incoming', connector.id, auth, {
          forceRefresh: options.forceOAuthRefresh,
        })
      : auth;

  const host = connector.host || (isGmailImapConnector(connector) ? 'imap.gmail.com' : undefined);
  if (!host) {
    throw new Error('IMAP connector host is required');
  }

  const port = Number(connector.port || (isGmailImapConnector(connector) ? 993 : undefined));
  if (!port) {
    throw new Error('IMAP connector port is required');
  }

  const imapAuth: Record<string, any> = {
    user: connector.email_address,
  };

  if (isGmailImapConnector(connector) && resolvedAuth.authType === 'oauth2') {
    if (!resolvedAuth.accessToken) {
      throw new Error('Incoming gmail connector has no OAuth access token. Reconnect account.');
    }
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
  const operationTimeoutMs = Number.isFinite(options.operationTimeoutMs) && Number(options.operationTimeoutMs) > 0
    ? Math.floor(Number(options.operationTimeoutMs))
    : env.sync.operationTimeoutMs;
  const shouldAttemptRefresh = isGmailImapConnector(connector) && getConnectorAuth(connector).authType === 'oauth2';
  const maxAttempts = 4;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let client: ImapFlow | null = null;
    const forceOAuthRefresh = options.forceOAuthRefresh || attempt > 0;
    try {
      if (shouldProactivelyRefreshGoogleToken(connector)) {
        const refreshedAuth = await ensureValidGoogleAccessToken(
          'incoming',
          connector.id,
          getConnectorAuth(connector),
          { forceRefresh: true },
        );
        connector.auth_config = refreshedAuth;
      }

      client = await getImapClient(connector, { forceOAuthRefresh });
      await runWithTimeout(
        'imap connect',
        operationTimeoutMs,
        () => client!.connect(),
        () => client?.logout().catch(() => undefined),
      );
      const result = await runWithTimeout(
        'imap sync operation',
        operationTimeoutMs,
        () => operation(client!),
        () => client?.logout().catch(() => undefined),
      );
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
        const currentAuth = getConnectorAuth(connector);
        if (!currentAuth.refreshToken) {
          throw new Error('OAuth refresh token missing; user must reconnect account');
        }
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
        await retryWithJitter(Math.min(1000 * 2 ** attempt, 8000));
        continue;
      }

      if (attempt >= maxAttempts - 1) {
        throw error;
      }

      await retryWithJitter(Math.min(500 * 2 ** attempt, 5000));
    }
  }

  throw lastError;
};

const normalizeAddressList = (addresses: any[] | undefined): string =>
  (addresses ?? [])
    .map((addr) => [addr.name, addr.address].filter(Boolean).join(' '))
    .join(', ');

export const getMailboxState = async (connectorId: string, mailbox: string) => {
  const safeQuery = async <T>(fn: () => Promise<T>, fallback: T) => {
    try {
      return await fn();
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError?.code === '42703' || pgError?.code === '42P01') {
        return fallback;
      }
      throw error;
    }
  };

  const columns = await safeQuery(() => getSyncStateColumns(), new Set<string>([
    'incoming_connector_id',
    'mailbox',
    'updated_at',
    'uidvalidity',
    'last_seen_uid',
    'highest_uid',
    'last_full_reconcile_at',
    'modseq',
  ]));
  const selectColumns: string[] = [
    'COALESCE(last_seen_uid, 0) AS "lastSeenUid"',
    'uidvalidity',
    'modseq',
  ];
  if (columns.has('highest_uid')) {
    selectColumns.push('COALESCE(highest_uid, 0) AS "highestUid"');
  } else {
    selectColumns.push('0 AS "highestUid"');
  }
  if (columns.has('last_full_reconcile_at')) {
    selectColumns.push('last_full_reconcile_at AS "lastFullReconcileAt"');
  } else {
    selectColumns.push('NULL::timestamptz AS "lastFullReconcileAt"');
  }
  const includesStatus = columns.has('status');
  const includesSyncStartedAt = columns.has('sync_started_at');
  const includesSyncCompletedAt = columns.has('sync_completed_at');
  const includesSyncError = columns.has('sync_error');
  const includesSyncProgress = columns.has('sync_progress');

  if (includesStatus) {
    selectColumns.push('status');
  }
  if (includesSyncStartedAt) {
    selectColumns.push('sync_started_at AS "syncStartedAt"');
  }
  if (includesSyncCompletedAt) {
    selectColumns.push('sync_completed_at AS "syncCompletedAt"');
  }
  if (includesSyncError) {
    selectColumns.push('sync_error AS "syncError"');
  }
  if (includesSyncProgress) {
    selectColumns.push('COALESCE(sync_progress, \'{}\'::jsonb) AS "syncProgress"');
  }

  const result = await query<any>(
    `SELECT ${selectColumns.join(', ')}
       FROM sync_states
      WHERE incoming_connector_id = $1
        AND mailbox = $2`,
    [connectorId, mailbox],
  );
  return {
    lastSeenUid: Number(result.rows[0]?.lastSeenUid ?? 0),
    highestUid: Number(result.rows[0]?.highestUid ?? 0),
    lastFullReconcileAt: result.rows[0]?.lastFullReconcileAt ?? null,
    mailboxUidValidity: result.rows[0]?.uidvalidity ?? null,
    modseq: result.rows[0]?.modseq ? String(result.rows[0].modseq) : null,
    status: includesStatus ? ((result.rows[0]?.status as SyncMailboxStatus) ?? 'idle') : 'idle',
    syncStartedAt: includesSyncStartedAt ? (result.rows[0]?.syncStartedAt ?? null) : null,
    syncCompletedAt: includesSyncCompletedAt ? (result.rows[0]?.syncCompletedAt ?? null) : null,
    syncError: includesSyncError ? (result.rows[0]?.syncError ?? null) : null,
    syncProgress: includesSyncProgress ? (result.rows[0]?.syncProgress ?? {}) : {},
  };
};

const isSyncCancellationRequested = async (connectorId: string, mailbox: string) => {
  try {
    const result = await query<{ status: string }>(
      `SELECT status
         FROM sync_states
        WHERE incoming_connector_id = $1
          AND mailbox = $2`,
      [connectorId, mailbox],
    );
    return result.rows[0]?.status === 'cancel_requested';
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError?.code === '42703' || pgError?.code === '42P01') {
      return false;
    }
    throw error;
  }
};

const tryClaimMailboxSync = async (
  connectorId: string,
  mailbox: string,
  syncProgress: SyncProgressSnapshot,
  lastSeenUid: number,
  highestUid: number,
) => {
  const staleMs = Number.isFinite(env.sync.syncClaimStaleMs) && env.sync.syncClaimStaleMs > 0
    ? Math.floor(env.sync.syncClaimStaleMs)
    : 900000;
  const heartbeatStaleMs = Number.isFinite(env.sync.syncClaimHeartbeatStaleMs) && env.sync.syncClaimHeartbeatStaleMs > 0
    ? Math.floor(env.sync.syncClaimHeartbeatStaleMs)
    : 45000;
  const payload = JSON.stringify(normalizeSyncProgress(syncProgress));

  try {
    const result = await query<{ incoming_connector_id: string }>(
      `UPDATE sync_states
          SET status = 'syncing',
              sync_started_at = NOW(),
              sync_completed_at = NULL,
              sync_error = NULL,
              sync_progress = $3::jsonb,
              last_seen_uid = $4,
              highest_uid = GREATEST(COALESCE(highest_uid, 0), $5),
              updated_at = NOW()
        WHERE incoming_connector_id = $1
          AND mailbox = $2
          AND (
            status IS DISTINCT FROM 'syncing'
            OR sync_started_at IS NULL
            OR (
              updated_at IS NOT NULL
              AND updated_at < NOW() - ($7::double precision * INTERVAL '1 millisecond')
            )
            OR sync_started_at < NOW() - ($6::double precision * INTERVAL '1 millisecond')
          )
      RETURNING incoming_connector_id`,
      [connectorId, mailbox, payload, lastSeenUid, highestUid, staleMs, heartbeatStaleMs],
    );
    return result.rows.length > 0;
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError?.code === '42703' || pgError?.code === '42P01') {
      return true;
    }
    throw error;
  }
};

const fetchUidsInRange = async (client: ImapFlow, range: string) => {
  const uids = await client.search({ uid: range }, { uid: true });
  if (uids === false || uids.length === 0) {
    return [];
  }
  return Array.from(new Set(toNumberUidList(uids))).sort((left, right) => left - right);
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

const reconcileMailboxByKnownUids = async (connectorId: string, mailbox: string, seenUids: number[]) => {
  const seenSet = new Set(seenUids.map((uid) => String(uid)));
  const messageRows = await query<{ id: string; uid: string; raw_blob_key: string | null }>(
    `SELECT id, uid, raw_blob_key
       FROM messages
      WHERE incoming_connector_id = $1
        AND folder_path = $2
        AND uid IS NOT NULL`,
    [connectorId, mailbox],
  );

  const staleMessageIds: string[] = [];
  const staleUids: string[] = [];
  const staleBlobKeys: string[] = [];
  for (const message of messageRows.rows) {
    const uid = String(message.uid);
    if (!seenSet.has(uid)) {
      staleMessageIds.push(message.id);
      staleUids.push(uid);
      if (message.raw_blob_key) {
        staleBlobKeys.push(message.raw_blob_key);
      }
    }
  }

  // Collect attachment blob keys before cascade-deleting rows
  let attachmentBlobKeys: string[] = [];
  if (staleMessageIds.length > 0) {
    const attRows = await query<{ blob_key: string }>(
      `SELECT blob_key FROM attachments WHERE message_id = ANY($1::uuid[]) AND blob_key IS NOT NULL`,
      [staleMessageIds],
    ).catch(() => ({ rows: [] as { blob_key: string }[] }));
    attachmentBlobKeys = attRows.rows.map((r) => r.blob_key);
  }

  for (let index = 0; index < staleUids.length; index += 500) {
    const chunk = staleUids.slice(index, index + 500).map((uid) => BigInt(uid));
    await query(
      `DELETE FROM messages
         WHERE incoming_connector_id = $1
           AND folder_path = $2
           AND uid = ANY($3::bigint[])`,
      [connectorId, mailbox, chunk],
    );
  }

  // Best-effort blob cleanup — do not let storage errors block sync
  await Promise.allSettled([
    ...staleBlobKeys.map((key) => blobStore.deleteObject(key)),
    ...attachmentBlobKeys.map((key) => blobStore.deleteObject(key)),
  ]);

  return staleMessageIds;
};

const reconcileMailboxTailByKnownUids = async (
  connectorId: string,
  mailbox: string,
  seenUids: number[],
  minUid: number,
) => {
  const seenSet = new Set(seenUids.map((uid) => String(uid)));
  const messageRows = await query<{ id: string; uid: string; raw_blob_key: string | null }>(
    `SELECT id, uid, raw_blob_key
       FROM messages
      WHERE incoming_connector_id = $1
        AND folder_path = $2
        AND uid IS NOT NULL
        AND uid >= $3`,
    [connectorId, mailbox, minUid],
  );

  const staleMessageIds: string[] = [];
  const staleUids: string[] = [];
  const staleBlobKeys: string[] = [];
  for (const message of messageRows.rows) {
    const uid = String(message.uid);
    if (!seenSet.has(uid)) {
      staleMessageIds.push(message.id);
      staleUids.push(uid);
      if (message.raw_blob_key) {
        staleBlobKeys.push(message.raw_blob_key);
      }
    }
  }

  // Collect attachment blob keys before cascade-deleting rows
  let attachmentBlobKeys: string[] = [];
  if (staleMessageIds.length > 0) {
    const attRows = await query<{ blob_key: string }>(
      `SELECT blob_key FROM attachments WHERE message_id = ANY($1::uuid[]) AND blob_key IS NOT NULL`,
      [staleMessageIds],
    ).catch(() => ({ rows: [] as { blob_key: string }[] }));
    attachmentBlobKeys = attRows.rows.map((r) => r.blob_key);
  }

  for (let index = 0; index < staleUids.length; index += 500) {
    const chunk = staleUids.slice(index, index + 500).map((uid) => BigInt(uid));
    await query(
      `DELETE FROM messages
         WHERE incoming_connector_id = $1
           AND folder_path = $2
           AND uid = ANY($3::bigint[])`,
      [connectorId, mailbox, chunk],
    );
  }

  // Best-effort blob cleanup — do not let storage errors block sync
  await Promise.allSettled([
    ...staleBlobKeys.map((key) => blobStore.deleteObject(key)),
    ...attachmentBlobKeys.map((key) => blobStore.deleteObject(key)),
  ]);

  return staleMessageIds;
};

const applyMessageMetadataOnlyUpdate = async (
  userId: string,
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
  const isRead = message.flags.has('\\Seen');
  const isStarred = message.flags.has('\\Flagged');
  const snippet = message.subject ? message.subject.slice(0, 500) : null;
  const receivedAtIso = message.internalDate ? new Date(message.internalDate).toISOString() : null;

  const result = await query<{ id: string }>(
    `UPDATE messages
     SET message_id = COALESCE($4::text, message_id),
         subject = COALESCE($5::text, subject),
         from_header = COALESCE($6::text, from_header),
         to_header = COALESCE($7::text, to_header),
         is_read = $8,
         is_starred = $9,
         flags = $10,
         snippet = COALESCE($11::text, snippet),
         mailbox_uidvalidity = $12::bigint,
         received_at = COALESCE($13::timestamptz, received_at),
         updated_at = NOW()
     WHERE incoming_connector_id = $1
       AND folder_path = $2
       AND uid = $3
       AND (
         ($4::text IS NOT NULL AND message_id IS DISTINCT FROM $4::text)
         OR ($5::text IS NOT NULL AND subject IS DISTINCT FROM $5::text)
         OR ($6::text IS NOT NULL AND from_header IS DISTINCT FROM $6::text)
         OR ($7::text IS NOT NULL AND to_header IS DISTINCT FROM $7::text)
         OR is_read IS DISTINCT FROM $8
         OR is_starred IS DISTINCT FROM $9
         OR flags IS DISTINCT FROM $10
         OR ($11::text IS NOT NULL AND snippet IS DISTINCT FROM $11::text)
         OR mailbox_uidvalidity IS DISTINCT FROM $12::bigint
         OR ($13::timestamptz IS NOT NULL AND received_at IS DISTINCT FROM $13::timestamptz)
       )
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
      snippet,
      mailboxUidValidity,
      receivedAtIso,
    ],
  );

  const messageId = result.rows[0]?.id ?? null;
  if (!messageId) {
    return null;
  }

  await syncSystemLabelsForMessage(userId, messageId, mailbox, isStarred);
  return messageId;
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

  // Insert the DB row first so we have a valid ID before writing the blob.
  // On conflict (same connector+uid+folder) we do an upsert; the raw_blob_key
  // will be backfilled in the UPDATE below if it was previously NULL.
  const insertResult = await query<{ id: string }>(
    `INSERT INTO messages
       (id, incoming_connector_id, message_id, subject, from_header, to_header, folder_path, raw_blob_key, snippet, received_at, is_read, is_starred, flags, uid, mailbox_uidvalidity, body_text, body_html)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9::timestamptz, $10, $11, $12, $13, $14, $15, $16)
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
      (message.subject ?? '').slice(0, 500),
      receivedAt,
      message.flags.has('\\Seen'),
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

  // Upload the blob now that we have a committed DB row.
  // If this fails we leave the row with raw_blob_key = NULL so the next
  // sync pass will retry via rehydrateExistingMessage.
  try {
    await blobStore.putObject(rawKey, message.source, 'message/rfc822');
    await query(
      `UPDATE messages SET raw_blob_key = $2, updated_at = NOW() WHERE id = $1`,
      [storedId, rawKey],
    );
  } catch (blobError) {
    await emitSyncEvent(connector.id, 'sync_error', {
      mailbox,
      phase: 'message-blob-upload',
      uid: message.uid,
      messageId: storedId,
      error: String(blobError),
    });
    // Return the ID anyway — the message row exists and will be rehydrated
  }

  let parsedResult = { attachmentCount: 0 };
  let parseFailed = false;
  try {
    parsedResult = await parseAndPersistMessage(storedId, message.source);
  } catch (error) {
    parseFailed = true;
    await emitSyncEvent(connector.id, 'sync_error', {
      mailbox,
      phase: 'message-parse',
      uid: message.uid,
      messageId: storedId,
      error: String(error),
    });
  }
  await syncSystemLabelsForMessage(
    connector.user_id,
    storedId,
    mailbox,
    message.flags.has('\\Flagged'),
  );

  // Only run threading when parsing succeeded — if it failed, the message
  // has no in_reply_to / references_header yet and would be threaded on
  // incomplete data.  Leave thread_id NULL; next re-sync will re-parse and
  // thread correctly.
  let threadId: string | null = null;
  if (!parseFailed) {
    const messageLookup = await query<any>(
      `SELECT incoming_connector_id, subject, is_read, is_starred, message_id, gmail_message_id, in_reply_to,
              references_header, from_header, to_header, raw_headers
         FROM messages WHERE id = $1`,
      [storedId],
    );

    const stored = messageLookup.rows[0];
    threadId = await computeThreadForMessage({
      id: storedId,
      incomingConnectorId: stored.incoming_connector_id,
      userId: connector.user_id,
      gmailMessageId: stored.gmail_message_id,
      messageId: stored.message_id,
      inReplyTo: stored.in_reply_to,
      referencesHeader: stored.references_header,
      subject: stored.subject,
      fromHeader: stored.from_header,
      toHeader: stored.to_header,
      receivedAt,
    });
  }

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

type GmailLabel = {
  id: string;
  name: string;
  type?: 'system' | 'user';
};

type GmailMessageMetadata = {
  id: string;
  threadId: string;
  labelIds?: string[];
  historyId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
  };
};

const decodeBase64UrlToBuffer = (value: string) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
};

const mapHeadersByName = (headers: Array<{ name: string; value: string }> = []) => {
  const mapped = new Map<string, string>();
  for (const header of headers) {
    mapped.set(header.name.toLowerCase(), header.value);
  }
  return mapped;
};

const getGmailLabels = async (connector: any) => {
  const payload = await gmailApiRequest<{ labels?: GmailLabel[] }>(
    'incoming',
    connector,
    '/labels',
  );
  return payload.labels ?? [];
};

const getGmailMailboxes = async (connector: any) => {
  const labels = await getGmailLabels(connector);
  const rows = labels
    .filter((label) => label.id !== 'UNREAD' && label.id !== 'CHAT' && label.id !== 'CATEGORY_FORUMS' && label.id !== 'CATEGORY_UPDATES' && label.id !== 'CATEGORY_PROMOTIONS' && label.id !== 'CATEGORY_SOCIAL')
    .map((label) => {
      const normalizedPath = label.id.toUpperCase();
      const systemDisplayName = label.name
        .toLowerCase()
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
      return {
        name: label.type === 'system'
          ? systemDisplayName
          : label.name,
        path: normalizedPath,
        delimiter: '/',
        parent: null,
        flags: [],
        specialUse: GMAIL_SPECIAL_USE_MAP[normalizedPath],
      };
    })
    .sort((left, right) => {
      const leftRank = GMAIL_SYSTEM_LABEL_ORDER[left.path] ?? 1000;
      const rightRank = GMAIL_SYSTEM_LABEL_ORDER[right.path] ?? 1000;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.name.localeCompare(right.name);
    });

  if (!rows.some((row) => row.path === 'ALL')) {
    rows.push({
      name: 'All Mail',
      path: 'ALL',
      delimiter: '/',
      parent: null,
      flags: [],
      specialUse: '\\All',
    });
  }

  return rows;
};

const listMailboxGmailMessageIds = async (connector: any, mailbox: string): Promise<string[]> => {
  const { labelId } = mailboxToGmailLabelFilter(mailbox);
  const ids = await listAllGmailPages<string>(
    'incoming',
    connector,
    (pageToken) => {
      const query = new URLSearchParams();
      query.set('maxResults', '500');
      if (pageToken) query.set('pageToken', pageToken);
      if (labelId) query.append('labelIds', labelId);
      if (!labelId || labelId === 'SPAM' || labelId === 'TRASH') {
        query.set('includeSpamTrash', 'true');
      }
      return `/messages?${query.toString()}`;
    },
    (payload) => ((payload?.messages ?? []) as Array<{ id: string }>).map((message) => message.id),
  );
  return Array.from(new Set(ids));
};

const listChangedGmailMessageIds = async (
  connector: any,
  mailbox: string,
  startHistoryId: string,
): Promise<{ changed: string[]; deleted: string[]; latestHistoryId: string | null }> => {
  const changed = new Set<string>();
  const deleted = new Set<string>();
  let latestHistoryId: string | null = null;
  let pageToken: string | undefined;

  do {
    const query = new URLSearchParams();
    query.set('startHistoryId', startHistoryId);
    query.set('maxResults', '500');
    if (pageToken) query.set('pageToken', pageToken);
    // NOTE: intentionally omit `labelId` filter — using it suppresses
    // label-removal events, so messages moved out of a folder would not
    // be detected until the next full reconcile.  upsertGmailMessage
    // already checks label membership and cleans up stale messages.
    const payload = await gmailApiRequest<any>(
      'incoming',
      connector,
      `/history?${query.toString()}`,
    );
    latestHistoryId = payload?.historyId ? String(payload.historyId) : latestHistoryId;

    const records = (payload?.history ?? []) as Array<any>;
    for (const record of records) {
      const messages = (record.messages ?? []) as Array<{ id: string }>;
      const added = (record.messagesAdded ?? []) as Array<{ message?: { id?: string } }>;
      const labelsAdded = (record.labelsAdded ?? []) as Array<{ message?: { id?: string } }>;
      const labelsRemoved = (record.labelsRemoved ?? []) as Array<{ message?: { id?: string } }>;
      const messagesDeleted = (record.messagesDeleted ?? []) as Array<{ message?: { id?: string } }>;

      for (const message of messages) {
        if (message.id) changed.add(message.id);
      }
      for (const item of added) {
        if (item.message?.id) changed.add(item.message.id);
      }
      for (const item of labelsAdded) {
        if (item.message?.id) changed.add(item.message.id);
      }
      for (const item of labelsRemoved) {
        if (item.message?.id) changed.add(item.message.id);
      }
      for (const item of messagesDeleted) {
        if (item.message?.id) deleted.add(item.message.id);
      }
    }

    pageToken = payload?.nextPageToken || undefined;
  } while (pageToken);

  return {
    changed: Array.from(changed),
    deleted: Array.from(deleted),
    latestHistoryId,
  };
};

const fetchGmailMessageMetadata = async (connector: any, gmailMessageId: string) => {
  const query = new URLSearchParams();
  query.set('format', 'metadata');
  query.append('metadataHeaders', 'Message-ID');
  query.append('metadataHeaders', 'Subject');
  query.append('metadataHeaders', 'From');
  query.append('metadataHeaders', 'To');
  query.append('metadataHeaders', 'In-Reply-To');
  query.append('metadataHeaders', 'References');
  return gmailApiRequest<GmailMessageMetadata>(
    'incoming',
    connector,
    `/messages/${encodeURIComponent(gmailMessageId)}?${query.toString()}`,
  );
};

const fetchGmailRawMessage = async (connector: any, gmailMessageId: string) => {
  const query = new URLSearchParams();
  query.set('format', 'raw');
  const payload = await gmailApiRequest<{ raw?: string }>(
    'incoming',
    connector,
    `/messages/${encodeURIComponent(gmailMessageId)}?${query.toString()}`,
  );
  if (!payload.raw) {
    throw new Error(`gmail message ${gmailMessageId} has no raw payload`);
  }
  return decodeBase64UrlToBuffer(payload.raw);
};

const reconcileMailboxByGmailMessageIds = async (connectorId: string, mailbox: string, seenIds: string[]) => {
  if (seenIds.length === 0) {
    const result = await query<{ id: string }>(
      `DELETE FROM messages
        WHERE incoming_connector_id = $1
          AND folder_path = $2
          AND gmail_message_id IS NOT NULL
      RETURNING id`,
      [connectorId, mailbox],
    );
    return result.rows.length;
  }

  const result = await query<{ id: string }>(
    `DELETE FROM messages
      WHERE incoming_connector_id = $1
        AND folder_path = $2
        AND gmail_message_id IS NOT NULL
        AND gmail_message_id <> ALL($3::text[])
    RETURNING id`,
    [connectorId, mailbox, seenIds],
  );
  return result.rows.length;
};

const runGmailMailboxSync = async (connector: any, mailboxInput: string, options: GetImapClientOptions = {}) => {
  const mailbox = normalizeGmailMailboxPath(mailboxInput);
  const connectorState = await getMailboxState(connector.id, mailbox);
  const incomingConnectorId: string = connector.id;
  const { labelId } = mailboxToGmailLabelFilter(mailbox);

  let lastSeenUid = connectorState.lastSeenUid;
  let highestUid = Math.max(connectorState.lastSeenUid, connectorState.highestUid ?? 0);
  let nextModseq = connectorState.modseq;
  let lastFullReconcileAt = connectorState.lastFullReconcileAt ? new Date(connectorState.lastFullReconcileAt as string) : null;
  let lastProgressWrite = 0;

  const syncProgress = {
    inserted: 0,
    updated: 0,
    reconciledRemoved: 0,
    metadataRefreshed: 0,
  };

  let processedSinceCancelCheck = 0;
  let lastCancelCheckAt = 0;

  const ensureNotCancelled = async (force = false) => {
    if (!force && (processedSinceCancelCheck - lastCancelCheckAt) < 25) {
      return;
    }
    lastCancelCheckAt = processedSinceCancelCheck;
    if (await isSyncCancellationRequested(incomingConnectorId, mailbox)) {
      throw new Error(`${SYNC_CANCELLED_SENTINEL}: ${incomingConnectorId}:${mailbox}`);
    }
  };

  const writeProgress = async (force = false) => {
    if (!force && Date.now() - lastProgressWrite < 1000) {
      return;
    }
    lastProgressWrite = Date.now();
    await setSyncState(incomingConnectorId, mailbox, {
      syncProgress,
      lastSeenUid,
      highestUid,
    });
  };

  await ensureNotCancelled(true);
  const claimed = await tryClaimMailboxSync(
    incomingConnectorId,
    mailbox,
    syncProgress,
    lastSeenUid,
    highestUid,
  );
  if (!claimed) {
    throw new Error(`${SYNC_ALREADY_RUNNING_SENTINEL}: ${incomingConnectorId}:${mailbox}`);
  }

  // Independent heartbeat: keeps sync_states.updated_at fresh so the
  // hasActiveSyncClaim / stale-reaper logic doesn't race against long ops.
  const HEARTBEAT_INTERVAL_MS = Math.min(
    Math.max(Math.floor(env.sync.syncClaimHeartbeatStaleMs / 3), 5000),
    15000,
  );
  const heartbeatTimer = setInterval(() => {
    setSyncState(incomingConnectorId, mailbox, {}).catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  try {
  const fullReconcileIntervalMs = Number.isFinite(env.sync.fullReconcileIntervalMs) && env.sync.fullReconcileIntervalMs > 0
    ? Math.floor(env.sync.fullReconcileIntervalMs)
    : 86400000;
  const fullReconcileDue = !lastFullReconcileAt
    || Number.isNaN(lastFullReconcileAt.getTime())
    || (Date.now() - lastFullReconcileAt.getTime()) >= fullReconcileIntervalMs;

  const existingMailboxRows = await query<{ count: number }>(
    `SELECT COUNT(*)::int as count
       FROM messages
      WHERE incoming_connector_id = $1
        AND folder_path = $2`,
    [incomingConnectorId, mailbox],
  );
  const isInitialBootstrap = !nextModseq && Number(existingMailboxRows.rows[0]?.count ?? 0) === 0;
  const useMetadataOnlyBootstrap = isInitialBootstrap && env.sync.gmailBootstrapMetadataOnly;
  const syncConcurrency = useMetadataOnlyBootstrap
    ? clampConcurrency(env.sync.gmailBootstrapConcurrency, 10)
    : clampConcurrency(env.sync.gmailSyncConcurrency, 4);

  const upsertGmailMessage = async (gmailMessageId: string, hydrateRaw: boolean) => {
    processedSinceCancelCheck += 1;
    await ensureNotCancelled();

    let metadata: GmailMessageMetadata;
    try {
      metadata = await fetchGmailMessageMetadata(connector, gmailMessageId);
    } catch (error) {
      if (String(error).includes(' 404 ')) {
        await query(
          `DELETE FROM messages
            WHERE incoming_connector_id = $1
              AND folder_path = $2
              AND gmail_message_id = $3`,
          [incomingConnectorId, mailbox, gmailMessageId],
        );
        return;
      }
      throw error;
    }

    const labels = new Set(metadata.labelIds ?? []);
    const isInMailbox = labelId ? labels.has(labelId) : true;
    if (!isInMailbox) {
      const removed = await query<{ id: string }>(
        `DELETE FROM messages
          WHERE incoming_connector_id = $1
            AND folder_path = $2
            AND gmail_message_id = $3
        RETURNING id`,
        [incomingConnectorId, mailbox, gmailMessageId],
      );
      if (removed.rows.length > 0) {
        syncProgress.reconciledRemoved += removed.rows.length;
      }
      return;
    }

    const headerMap = mapHeadersByName(metadata.payload?.headers ?? []);
    const rfcMessageId = headerMap.get('message-id') ?? null;
    const inReplyToHeader = headerMap.get('in-reply-to') ?? null;
    const referencesHeader = headerMap.get('references') ?? null;
    const subject = headerMap.get('subject') ?? null;
    const fromHeader = headerMap.get('from') ?? null;
    const toHeader = headerMap.get('to') ?? null;
    const receivedAt = metadata.internalDate
      ? new Date(Number(metadata.internalDate)).toISOString()
      : now();
    const isRead = !labels.has('UNREAD');
    const isStarred = labels.has('STARRED');
    const flags = Array.from(labels).sort();
    const providerMeta = {
      gmailHistoryId: metadata.historyId ? String(metadata.historyId) : null,
      gmailLabelIds: Array.from(labels),
    };
    const threadSeed = metadata.threadId ?? null;
    let resolvedThreadId: string | null = null;
    let resolvedFromExistingGmailThread = false;
    if (threadSeed) {
      const threadLookup = await query<{ thread_id: string | null }>(
        `SELECT thread_id
           FROM messages
          WHERE incoming_connector_id = $1
            AND gmail_thread_id = $2
            AND thread_id IS NOT NULL
          ORDER BY received_at DESC
          LIMIT 1`,
        [incomingConnectorId, threadSeed],
      );
      resolvedFromExistingGmailThread = Boolean(threadLookup.rows[0]?.thread_id);
      resolvedThreadId = threadLookup.rows[0]?.thread_id ?? uuidv4();
    }

    let existing = await query<{ id: string; has_body: boolean; has_raw: boolean }>(
      `SELECT id,
              (body_text IS NOT NULL OR body_html IS NOT NULL) AS has_body,
              (raw_blob_key IS NOT NULL) AS has_raw
         FROM messages
        WHERE incoming_connector_id = $1
          AND folder_path = $2
          AND gmail_message_id = $3`,
      [incomingConnectorId, mailbox, gmailMessageId],
    );

    if (!existing.rows[0] && rfcMessageId) {
      existing = await query<{ id: string; has_body: boolean; has_raw: boolean }>(
        `SELECT id,
                (body_text IS NOT NULL OR body_html IS NOT NULL) AS has_body,
                (raw_blob_key IS NOT NULL) AS has_raw
           FROM messages
          WHERE incoming_connector_id = $1
            AND folder_path = $2
            AND message_id = $3
            AND (gmail_message_id IS NULL OR gmail_message_id = '')
          ORDER BY received_at DESC
          LIMIT 1`,
        [incomingConnectorId, mailbox, rfcMessageId],
      );
      if (existing.rows[0]) {
        await query(
          `UPDATE messages
              SET gmail_message_id = $2,
                  gmail_thread_id = COALESCE($3, gmail_thread_id),
                  provider_message_meta = $4::jsonb,
                  updated_at = NOW()
            WHERE id = $1`,
          [
            existing.rows[0].id,
            gmailMessageId,
            metadata.threadId ?? null,
            JSON.stringify(providerMeta),
          ],
        );
      }
    }

    let messageRowId: string;
    let hasBody = false;
    let hasRaw = false;
    if (!existing.rows[0]) {
      let rawKey: string | null = null;
      let sourceBuffer: Buffer | null = null;
      if (hydrateRaw) {
        sourceBuffer = await fetchGmailRawMessage(connector, gmailMessageId);
        rawKey = `raw/${connector.id}/${mailbox}/${gmailMessageId}-${uuidv4()}.eml`;
        await blobStore.putObject(rawKey, sourceBuffer, 'message/rfc822');
      }
      const insertedMessage = await query<{ id: string }>(
        `INSERT INTO messages
           (id, incoming_connector_id, message_id, subject, from_header, to_header, folder_path, raw_blob_key, snippet, received_at, is_read, is_starred, flags, uid, mailbox_uidvalidity, gmail_message_id, gmail_thread_id, thread_id, provider_message_meta, body_text, body_html)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11, $12, $13, NULL, NULL, $14, $15, $16, $17::jsonb, NULL, NULL)
         ON CONFLICT (incoming_connector_id, folder_path, gmail_message_id)
         DO UPDATE SET
           message_id = COALESCE(EXCLUDED.message_id, messages.message_id),
           subject = COALESCE(EXCLUDED.subject, messages.subject),
           from_header = COALESCE(EXCLUDED.from_header, messages.from_header),
           to_header = COALESCE(EXCLUDED.to_header, messages.to_header),
           snippet = COALESCE(EXCLUDED.snippet, messages.snippet),
           received_at = COALESCE(EXCLUDED.received_at, messages.received_at),
           is_read = EXCLUDED.is_read,
           is_starred = EXCLUDED.is_starred,
           flags = EXCLUDED.flags,
           raw_blob_key = COALESCE(messages.raw_blob_key, EXCLUDED.raw_blob_key),
           gmail_thread_id = COALESCE(EXCLUDED.gmail_thread_id, messages.gmail_thread_id),
           thread_id = COALESCE(EXCLUDED.thread_id, messages.thread_id),
            provider_message_meta = EXCLUDED.provider_message_meta,
            updated_at = NOW()
         RETURNING id`,
        [
          uuidv4(),
          incomingConnectorId,
          rfcMessageId,
          subject,
          fromHeader,
          toHeader,
          mailbox,
          rawKey,
          metadata.snippet ?? (subject ?? '').slice(0, 500),
          receivedAt,
          isRead,
          isStarred,
          flags,
          gmailMessageId,
          metadata.threadId ?? null,
          resolvedThreadId,
          JSON.stringify(providerMeta),
        ],
      );
      messageRowId = insertedMessage.rows[0].id;
      hasRaw = Boolean(rawKey);

      if (sourceBuffer) {
        try {
          await parseAndPersistMessage(messageRowId, sourceBuffer);
          hasBody = true;
        } catch (error) {
          await emitSyncEvent(incomingConnectorId, 'sync_error', {
            mailbox,
            phase: 'gmail-message-parse',
            gmailMessageId,
            messageId: messageRowId,
            error: String(error),
          });
        }
      }

      syncProgress.inserted += 1;
      await emitSyncEvent(incomingConnectorId, 'message_synced', {
        messageId: messageRowId,
        folder: mailbox,
        isNew: true,
      });
    } else {
      messageRowId = existing.rows[0].id;
      hasBody = !!existing.rows[0].has_body;
      hasRaw = !!existing.rows[0].has_raw;
      await query(
        `UPDATE messages
            SET message_id = COALESCE($4, message_id),
                subject = COALESCE($5, subject),
                from_header = COALESCE($6, from_header),
                to_header = COALESCE($7, to_header),
                snippet = COALESCE($8, snippet),
                received_at = COALESCE($9::timestamptz, received_at),
                is_read = $10,
                is_starred = $11,
                flags = $12,
                gmail_thread_id = COALESCE($13, gmail_thread_id),
                thread_id = COALESCE($14, thread_id),
                provider_message_meta = $15::jsonb,
                updated_at = NOW()
          WHERE id = $1
            AND incoming_connector_id = $2
            AND folder_path = $3`,
        [
          messageRowId,
          incomingConnectorId,
          mailbox,
          rfcMessageId,
          subject,
          fromHeader,
          toHeader,
          metadata.snippet ?? (subject ?? '').slice(0, 500),
          receivedAt,
          isRead,
          isStarred,
          flags,
          metadata.threadId ?? null,
          resolvedThreadId,
          JSON.stringify(providerMeta),
        ],
      );
      syncProgress.metadataRefreshed += 1;
      syncProgress.updated += 1;
      await emitSyncEvent(incomingConnectorId, 'message_updated', {
        messageId: messageRowId,
        folder: mailbox,
        gmailMessageId,
        syncMode: 'gmail-metadata',
      });
    }

    if (hydrateRaw && (!hasBody || !hasRaw)) {
      const sourceBuffer = await fetchGmailRawMessage(connector, gmailMessageId);
      const rawKey = `raw/${connector.id}/${mailbox}/${gmailMessageId}-${uuidv4()}.eml`;
      await blobStore.putObject(rawKey, sourceBuffer, 'message/rfc822');
      await query(
        `UPDATE messages
            SET raw_blob_key = COALESCE(raw_blob_key, $2),
                updated_at = NOW()
          WHERE id = $1`,
        [messageRowId, rawKey],
      );
      try {
        await parseAndPersistMessage(messageRowId, sourceBuffer);
      } catch (error) {
        await emitSyncEvent(incomingConnectorId, 'sync_error', {
          mailbox,
          phase: 'gmail-message-rehydrate',
          gmailMessageId,
          messageId: messageRowId,
          error: String(error),
        });
      }
    }

    await query(
      `UPDATE messages
          SET in_reply_to = COALESCE($2, in_reply_to),
              references_header = COALESCE($3, references_header),
              updated_at = NOW()
        WHERE id = $1`,
      [messageRowId, inReplyToHeader, referencesHeader],
    );

    // Always re-validate threading using our own logic after headers are
    // available.  Gmail's threadId is aggressive (groups by subject) and
    // may be wrong.  After hydration, in_reply_to / references_header will
    // be populated, allowing computeThreadForMessage to make a correct call.
    {
      const threadSource = await query<{
        incoming_connector_id: string;
        gmail_message_id: string | null;
        message_id: string | null;
        in_reply_to: string | null;
        references_header: string | null;
        subject: string | null;
        from_header: string | null;
        to_header: string | null;
        received_at: string | null;
      }>(
        `SELECT incoming_connector_id, gmail_message_id, message_id, in_reply_to, references_header, subject, from_header, to_header, received_at
           FROM messages
          WHERE id = $1`,
        [messageRowId],
      );
      const threaded = threadSource.rows[0];
      if (threaded) {
        resolvedThreadId = await computeThreadForMessage({
          id: messageRowId,
          incomingConnectorId: threaded.incoming_connector_id,
          userId: connector.user_id,
          gmailMessageId: threaded.gmail_message_id,
          messageId: threaded.message_id,
          inReplyTo: threaded.in_reply_to,
          referencesHeader: threaded.references_header,
          subject: threaded.subject,
          fromHeader: threaded.from_header,
          toHeader: threaded.to_header,
          receivedAt: threaded.received_at ?? receivedAt,
        });
      }
    }

    await syncSystemLabelsForMessage(
      connector.user_id,
      messageRowId,
      mailbox,
      isStarred,
    );
    await writeProgress();
  };

  let latestHistoryId = nextModseq;
  let changedIds: string[] = [];
  let deletedIds: string[] = [];
  let fullSeenIds: string[] | null = null;
  let historyFallback = false;
  const hintedHistoryId = options.gmailHistoryIdHint ? String(options.gmailHistoryIdHint) : null;
  if (hintedHistoryId) {
    latestHistoryId = hintedHistoryId;
  } else {
    const profile = await gmailApiRequest<{ historyId?: string }>('incoming', connector, '/profile');
    if (profile.historyId) {
      latestHistoryId = String(profile.historyId);
    }
  }

  if (nextModseq) {
    try {
      const history = await listChangedGmailMessageIds(connector, mailbox, nextModseq);
      changedIds = history.changed;
      deletedIds = history.deleted;
      if (history.latestHistoryId) {
        latestHistoryId = history.latestHistoryId;
      }
    } catch (error) {
      const text = String(error);
      if (text.includes(' 404 ') || text.toLowerCase().includes('starthistoryid')) {
        historyFallback = true;
        await emitSyncEvent(incomingConnectorId, 'sync_error', {
          mailbox,
          phase: 'gmail-history-fallback',
          error: `${GMAIL_HISTORY_STALE_SENTINEL}: ${text}`,
        });
      } else {
        throw error;
      }
    }
  } else {
    historyFallback = true;
  }

  if (historyFallback || fullReconcileDue) {
    fullSeenIds = await listMailboxGmailMessageIds(connector, mailbox);
    changedIds = fullSeenIds;
    deletedIds = [];
  }

  for (const gmailMessageId of deletedIds) {
    processedSinceCancelCheck += 1;
    await ensureNotCancelled();
    const removed = await query<{ id: string }>(
      `DELETE FROM messages
        WHERE incoming_connector_id = $1
          AND folder_path = $2
          AND gmail_message_id = $3
      RETURNING id`,
      [incomingConnectorId, mailbox, gmailMessageId],
    );
    if (removed.rows.length > 0) {
      syncProgress.reconciledRemoved += removed.rows.length;
    }
  }

  await mapWithConcurrency(changedIds, syncConcurrency, async (gmailMessageId) => {
    await upsertGmailMessage(gmailMessageId, !useMetadataOnlyBootstrap);
  });

  if (fullSeenIds) {
    const removed = await reconcileMailboxByGmailMessageIds(incomingConnectorId, mailbox, fullSeenIds);
    syncProgress.reconciledRemoved += removed;
    lastFullReconcileAt = new Date();
  }

  await setSyncState(incomingConnectorId, mailbox, {
    lastSeenUid,
    highestUid,
    mailboxUidValidity: null,
    modseq: latestHistoryId ?? null,
    lastFullReconcileAt,
  });

  await emitSyncEvent(incomingConnectorId, 'sync_completed', {
    mailbox,
    inserted: syncProgress.inserted,
    updated: syncProgress.updated,
    reconciledRemoved: syncProgress.reconciledRemoved,
    metadataRefreshed: syncProgress.metadataRefreshed,
    source: 'gmail-api',
  });

  if (useMetadataOnlyBootstrap) {
    try {
      await enqueueGmailHydration(connector.user_id, incomingConnectorId, mailbox);
      await emitSyncEvent(incomingConnectorId, 'sync_info', {
        mailbox,
        phase: 'gmail-bootstrap-hydration-enqueued',
      });
    } catch (error) {
      await emitSyncEvent(incomingConnectorId, 'sync_error', {
        mailbox,
        phase: 'gmail-bootstrap-hydration-enqueue',
        error: String(error),
      });
    }
  }

  await writeProgress(true);
  return syncProgress;
  } finally {
    clearInterval(heartbeatTimer);
  }
};

export const hydrateGmailMailboxContentBatch = async (
  userId: string,
  connectorId: string,
  mailboxInput: string,
  batchSize = env.sync.gmailBackgroundHydrateBatchSize,
) => {
  const connector = await getIncomingConnectorByIdForUser(userId, connectorId);
  if (!connector || connector.provider !== 'gmail') {
    return { processed: 0, failed: 0, remaining: 0 };
  }

  const mailbox = normalizeGmailMailboxPath(mailboxInput);
  const limit = Number.isFinite(batchSize) && batchSize > 0
    ? Math.floor(batchSize)
    : 200;
  const hydrateConcurrency = clampConcurrency(env.sync.gmailBackgroundHydrateConcurrency, 4);

  const missingRows = await query<{
    id: string;
    gmail_message_id: string;
    raw_blob_key: string | null;
  }>(
    `SELECT id, gmail_message_id, raw_blob_key
       FROM messages
      WHERE incoming_connector_id = $1
        AND folder_path = $2
        AND gmail_message_id IS NOT NULL
        AND (raw_blob_key IS NULL OR (body_text IS NULL AND body_html IS NULL))
      ORDER BY received_at DESC NULLS LAST
      LIMIT $3`,
    [connectorId, mailbox, limit],
  );

  let processed = 0;
  let failed = 0;

  await mapWithConcurrency(missingRows.rows, hydrateConcurrency, async (row) => {
    try {
      let rawBuffer: Buffer | null = null;
      let rawKey = row.raw_blob_key;

      if (rawKey) {
        rawBuffer = await blobStore.getObject(rawKey);
      }
      if (!rawBuffer) {
        rawBuffer = await fetchGmailRawMessage(connector, row.gmail_message_id);
        rawKey = rawKey ?? `raw/${connector.id}/${mailbox}/${row.gmail_message_id}-${uuidv4()}.eml`;
        await blobStore.putObject(rawKey, rawBuffer, 'message/rfc822');
        await query(
          `UPDATE messages
              SET raw_blob_key = $2,
                  updated_at = NOW()
            WHERE id = $1`,
          [row.id, rawKey],
        );
      }

      await parseAndPersistMessage(row.id, rawBuffer);

      // Re-thread after hydration: now that in_reply_to / references_header
      // are populated from the raw RFC822, correct any stale thread_id that
      // was assigned during metadata-only bootstrap.
      try {
        const threadSource = await query<{
          incoming_connector_id: string;
          gmail_message_id: string | null;
          message_id: string | null;
          in_reply_to: string | null;
          references_header: string | null;
          subject: string | null;
          from_header: string | null;
          to_header: string | null;
          received_at: string | null;
        }>(
          `SELECT incoming_connector_id, gmail_message_id, message_id, in_reply_to, references_header, subject, from_header, to_header, received_at
             FROM messages
            WHERE id = $1`,
          [row.id],
        );
        const threaded = threadSource.rows[0];
        if (threaded) {
          await computeThreadForMessage({
            id: row.id,
            incomingConnectorId: threaded.incoming_connector_id,
            userId,
            gmailMessageId: threaded.gmail_message_id,
            messageId: threaded.message_id,
            inReplyTo: threaded.in_reply_to,
            referencesHeader: threaded.references_header,
            subject: threaded.subject,
            fromHeader: threaded.from_header,
            toHeader: threaded.to_header,
            receivedAt: threaded.received_at,
          });
        }
      } catch (threadError) {
        await emitSyncEvent(connectorId, 'sync_error', {
          mailbox,
          phase: 'gmail-background-hydrate-rethread',
          messageId: row.id,
          error: String(threadError),
        });
      }

      processed += 1;
    } catch (error) {
      failed += 1;
      await emitSyncEvent(connectorId, 'sync_error', {
        mailbox,
        phase: 'gmail-background-hydrate',
        messageId: row.id,
        gmailMessageId: row.gmail_message_id,
        error: String(error),
      });
    }
  });

  const remainingRows = await query<{ count: number }>(
    `SELECT COUNT(*)::int as count
       FROM messages
      WHERE incoming_connector_id = $1
        AND folder_path = $2
        AND gmail_message_id IS NOT NULL
        AND (raw_blob_key IS NULL OR (body_text IS NULL AND body_html IS NULL))`,
    [connectorId, mailbox],
  );
  const remaining = Number(remainingRows.rows[0]?.count ?? 0);

  if (processed > 0 || failed > 0) {
    await emitSyncEvent(connectorId, 'sync_info', {
      mailbox,
      phase: 'gmail-background-hydrate-progress',
      processed,
      failed,
      remaining,
    });
  }

  return { processed, failed, remaining };
};

const runMailboxSync = async (connector: any, mailbox: string, options: GetImapClientOptions = {}) => {
  if (connector.provider === 'gmail') {
    return runGmailMailboxSync(connector, mailbox, options);
  }

  const connectorState = await getMailboxState(connector.id, mailbox);
  const incomingConnectorId: string = connector.id;

  let lastSeenUid = connectorState.lastSeenUid;
  let highestUid = Math.max(connectorState.lastSeenUid, connectorState.highestUid ?? 0);
  let nextModseq = toBigInt(connectorState.modseq);
  let lastRemoteUids: number[] = [];
  let lastProgressWrite = 0;
  let lastFullReconcileAt = connectorState.lastFullReconcileAt ? new Date(connectorState.lastFullReconcileAt as string) : null;

  const syncProgress = {
    inserted: 0,
    updated: 0,
    reconciledRemoved: 0,
    metadataRefreshed: 0,
  };

  let processedSinceCancelCheck = 0;
  let lastCancelCheckAt = 0;

  const ensureNotCancelled = async (force = false) => {
    if (!force && (processedSinceCancelCheck - lastCancelCheckAt) < 25) {
      return;
    }
    lastCancelCheckAt = processedSinceCancelCheck;
    if (await isSyncCancellationRequested(incomingConnectorId, mailbox)) {
      throw new Error(`${SYNC_CANCELLED_SENTINEL}: ${incomingConnectorId}:${mailbox}`);
    }
  };

  const advanceUidWatermark = (uid: number) => {
    if (uid > lastSeenUid) {
      lastSeenUid = uid;
    }
    if (uid > highestUid) {
      highestUid = uid;
    }
  };

  const writeProgress = async (force = false) => {
    if (!force && Date.now() - lastProgressWrite < 1000) {
      return;
    }
    lastProgressWrite = Date.now();
    await setSyncState(incomingConnectorId, mailbox, {
      syncProgress,
      lastSeenUid,
      highestUid,
    });
  };

  await ensureNotCancelled(true);

  const claimed = await tryClaimMailboxSync(
    incomingConnectorId,
    mailbox,
    syncProgress,
    lastSeenUid,
    highestUid,
  );
  if (!claimed) {
    throw new Error(`${SYNC_ALREADY_RUNNING_SENTINEL}: ${incomingConnectorId}:${mailbox}`);
  }

  // Independent heartbeat: keeps sync_states.updated_at fresh so the
  // hasActiveSyncClaim / stale-reaper logic doesn't race against long ops.
  const HEARTBEAT_INTERVAL_MS = Math.min(
    Math.max(Math.floor(env.sync.syncClaimHeartbeatStaleMs / 3), 5000),
    15000,
  );
  const heartbeatTimer = setInterval(() => {
    setSyncState(incomingConnectorId, mailbox, {}).catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  const flagSyncWindow = Number.isFinite(env.sync.flagSyncWindow) && env.sync.flagSyncWindow > 0
    ? Math.floor(env.sync.flagSyncWindow)
    : 256;
  const sourceFetchBatchSize = Number.isFinite(env.sync.sourceFetchBatchSize) && env.sync.sourceFetchBatchSize > 0
    ? Math.floor(env.sync.sourceFetchBatchSize)
    : 200;
  const recentReconcileUidWindow = Number.isFinite(env.sync.recentReconcileUidWindow) && env.sync.recentReconcileUidWindow > 0
    ? Math.floor(env.sync.recentReconcileUidWindow)
    : 2000;
  const fullReconcileIntervalMs = Number.isFinite(env.sync.fullReconcileIntervalMs) && env.sync.fullReconcileIntervalMs > 0
    ? Math.floor(env.sync.fullReconcileIntervalMs)
    : 86400000;

  type LocalMessageState = {
    id: string;
    hasBody: boolean;
    hasRaw: boolean;
  };

  const localMessageStateCache = new Map<number, LocalMessageState | null>();
  const getLocalMessageState = async (uid: number): Promise<LocalMessageState | null> => {
    if (localMessageStateCache.has(uid)) {
      return localMessageStateCache.get(uid) ?? null;
    }
    const result = await query<{
      id: string;
      has_body: boolean;
      has_raw: boolean;
    }>(
      `SELECT id,
              (body_text IS NOT NULL OR body_html IS NOT NULL) AS has_body,
              (raw_blob_key IS NOT NULL) AS has_raw
         FROM messages
        WHERE incoming_connector_id = $1
          AND folder_path = $2
          AND uid = $3`,
      [incomingConnectorId, mailbox, uid],
    );
    const row = result.rows[0];
    const state = row
      ? {
          id: row.id,
          hasBody: !!row.has_body,
          hasRaw: !!row.has_raw,
        }
      : null;
    localMessageStateCache.set(uid, state);
    return state;
  };

  const setLocalMessageState = (uid: number, state: LocalMessageState | null) => {
    localMessageStateCache.set(uid, state);
  };

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
    };
  };

  const processMetadataOnlyMessage = async (message: any, mailboxUidValidity: string | null): Promise<number | null> => {
    const normalized = normalizeFetchedMessage(message, mailboxUidValidity);
    if (!normalized) {
      return null;
    }
    advanceUidWatermark(normalized.uid);
    processedSinceCancelCheck += 1;
    await ensureNotCancelled();

    const existing = await getLocalMessageState(normalized.uid);
    if (!existing) {
      return normalized.uid;
    }

    const changedMessageId = await applyMessageMetadataOnlyUpdate(
      connector.user_id,
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

    if (changedMessageId) {
      syncProgress.metadataRefreshed += 1;
      syncProgress.updated += 1;
      await writeProgress();
      await emitSyncEvent(incomingConnectorId, 'message_updated', {
        messageId: changedMessageId,
        folder: mailbox,
        uid: normalized.uid,
        syncMode: 'metadata',
      });
    }

    if (!existing.hasBody || !existing.hasRaw) {
      return normalized.uid;
    }
    return null;
  };

  const rehydrateExistingMessage = async (
    local: LocalMessageState,
    uid: number,
    mailboxUidValidity: string | null,
    sourceBuffer: Buffer,
  ) => {
    const rawKey = `raw/${incomingConnectorId}/${mailbox}/${uid}-${uuidv4()}.eml`;
    await blobStore.putObject(rawKey, sourceBuffer, 'message/rfc822');
    await query(
      `UPDATE messages
          SET raw_blob_key = COALESCE(raw_blob_key, $2),
              mailbox_uidvalidity = $3,
              updated_at = NOW()
        WHERE id = $1`,
      [local.id, rawKey, mailboxUidValidity],
    );
    try {
      await parseAndPersistMessage(local.id, sourceBuffer);
    } catch (error) {
      await emitSyncEvent(incomingConnectorId, 'sync_error', {
        mailbox,
        phase: 'message-rehydrate',
        uid,
        messageId: local.id,
        error: String(error),
      });
    }
    setLocalMessageState(uid, {
      id: local.id,
      hasBody: true,
      hasRaw: true,
    });
  };

  const processSourceMessage = async (
    message: any,
    mailboxUidValidity: string | null,
    options: { forceRehydrateExisting?: boolean } = {},
  ): Promise<void> => {
    const normalized = normalizeFetchedMessage(message, mailboxUidValidity);
    if (!normalized) {
      return;
    }
    advanceUidWatermark(normalized.uid);
    processedSinceCancelCheck += 1;
    await ensureNotCancelled();

    if (!message.source) {
      await processMetadataOnlyMessage(message, mailboxUidValidity);
      return;
    }

    const sourceBuffer = Buffer.isBuffer(message.source)
      ? message.source
      : Buffer.from(message.source as string);

    const existing = await getLocalMessageState(normalized.uid);
    if (existing) {
      const changedMessageId = await applyMessageMetadataOnlyUpdate(
        connector.user_id,
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

      let didRehydrate = false;
      if (options.forceRehydrateExisting || !existing.hasBody || !existing.hasRaw) {
        await rehydrateExistingMessage(existing, normalized.uid, mailboxUidValidity, sourceBuffer);
        didRehydrate = true;
      }

      if (changedMessageId || didRehydrate) {
        syncProgress.updated += 1;
        await writeProgress();
        await emitSyncEvent(incomingConnectorId, 'message_updated', {
          messageId: changedMessageId ?? existing.id,
          folder: mailbox,
          uid: normalized.uid,
          syncMode: didRehydrate ? 'rehydrate' : 'source',
        });
      }
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
      syncProgress.inserted += 1;
      setLocalMessageState(normalized.uid, {
        id: created.id,
        hasBody: true,
        hasRaw: true,
      });
      await writeProgress();
    }
  };

  const fetchSourceForUids = async (
    client: ImapFlow,
    uids: number[],
    mailboxUidValidity: string | null,
    forceRehydrateExisting = false,
  ) => {
    if (uids.length === 0) {
      return;
    }
    const normalized = Array.from(new Set(uids)).sort((left, right) => left - right);
    for (const chunk of chunkArray(normalized, sourceFetchBatchSize)) {
      for await (const message of client.fetch(chunk, {
        uid: true,
        envelope: true,
        internalDate: true,
        flags: true,
        source: true,
      }, { uid: true })) {
        await processSourceMessage(message, mailboxUidValidity, {
          forceRehydrateExisting,
        });
      }
      // Persist watermark between chunks so a mid-stream disconnect does
      // not leave lastSeenUid ahead of un-processed UIDs.
      await writeProgress(true);
    }
  };

  const refreshMetadataTail = async (
    client: ImapFlow,
    mailboxUidValidity: string | null,
  ) => {
    const candidates =
      lastRemoteUids.length > 0
        ? lastRemoteUids.slice(Math.max(0, lastRemoteUids.length - flagSyncWindow))
        : [];

    if (candidates.length === 0) {
      return;
    }

    const sourceCandidates: number[] = [];
    for await (const message of client.fetch(candidates, {
      uid: true,
      envelope: true,
      internalDate: true,
      flags: true,
    }, {
      uid: true,
    })) {
      const maybeSourceUid = await processMetadataOnlyMessage(message, mailboxUidValidity);
      if (maybeSourceUid !== null) {
        sourceCandidates.push(maybeSourceUid);
      }
    }
    await fetchSourceForUids(client, sourceCandidates, mailboxUidValidity, true);
  };

  const syncOperationTimeoutMs = Math.max(env.sync.operationTimeoutMs, 300000);
  try {
    return await runImapOperation(connector, async (client) => {
    const resolvedMailbox = await resolveGmailImapMailboxPath(connector, client, mailbox);
    if (resolvedMailbox !== mailbox) {
      clearGmailImapMailboxDirectoryCache(connector.id);
    }
    const mailboxLock = await client.mailboxOpen(resolvedMailbox);
    await ensureNotCancelled(true);
    const currentUidValidity = mailboxLock.uidValidity ? String(mailboxLock.uidValidity) : null;
    const currentModseq = toBigInt(mailboxLock.highestModseq) ?? undefined;
    const uidNext = toNumberUid((mailboxLock as any).uidNext);
    if (uidNext && uidNext > 1) {
      highestUid = Math.max(highestUid, uidNext - 1);
    }

    if (
      connectorState.mailboxUidValidity &&
      currentUidValidity &&
      connectorState.mailboxUidValidity !== currentUidValidity
    ) {
      await query('DELETE FROM messages WHERE incoming_connector_id = $1 AND folder_path = $2', [incomingConnectorId, mailbox]);
      localMessageStateCache.clear();
      lastSeenUid = 0;
      highestUid = 0;
      nextModseq = null;
      lastFullReconcileAt = null;
    }

    let usedIncremental = false;
    let hadChangedSinceFailure = false;
    const changedSinceModseq = toBigInt(nextModseq);
    if (changedSinceModseq !== null) {
      try {
        usedIncremental = true;
        const sourceCandidates: number[] = [];
        for await (const message of client.fetch('1:*', {
          uid: true,
          envelope: true,
          internalDate: true,
          flags: true,
        }, {
          uid: true,
          changedSince: changedSinceModseq,
        })) {
          const maybeSourceUid = await processMetadataOnlyMessage(message, currentUidValidity);
          if (maybeSourceUid !== null) {
            sourceCandidates.push(maybeSourceUid);
          }
        }
        await fetchSourceForUids(client, sourceCandidates, currentUidValidity, true);
      } catch (error) {
        await emitSyncEvent(incomingConnectorId, 'sync_error', {
          mailbox,
          phase: 'changedSince',
          error: String(error),
        });
        usedIncremental = false;
        hadChangedSinceFailure = true;
      }
    }

    if (!usedIncremental) {
      await ensureNotCancelled(true);
      const rangeStart = Math.max(1, lastSeenUid + 1);
      const newUids = await fetchUidsInRange(client, `${rangeStart}:*`);
      if (newUids.length > 0) {
        lastRemoteUids = newUids;
        await fetchSourceForUids(client, newUids, currentUidValidity);
      }

      const tailStart = Math.max(1, Math.max(highestUid, lastSeenUid) - Math.max(flagSyncWindow, 1) + 1);
      const tailCandidates = await fetchUidsInRange(client, `${tailStart}:*`);
      if (tailCandidates.length > 0) {
        lastRemoteUids = tailCandidates;
        const sourceCandidates: number[] = [];
        for await (const message of client.fetch(tailCandidates, {
          uid: true,
          envelope: true,
          internalDate: true,
          flags: true,
        }, { uid: true })) {
          const maybeSourceUid = await processMetadataOnlyMessage(message, currentUidValidity);
          if (maybeSourceUid !== null) {
            sourceCandidates.push(maybeSourceUid);
          }
        }
        await fetchSourceForUids(client, sourceCandidates, currentUidValidity, true);
      }
    }

    await ensureNotCancelled(true);
    const fullReconcileDue = !lastFullReconcileAt
      || Number.isNaN(lastFullReconcileAt.getTime())
      || (Date.now() - lastFullReconcileAt.getTime()) >= fullReconcileIntervalMs;

    if (fullReconcileDue) {
      const fullUids = await fetchAllUids(incomingConnectorId, client);
      if (fullUids !== null) {
        const uniqueUids = Array.from(new Set(fullUids)).sort((left, right) => left - right);
        lastRemoteUids = uniqueUids;
        const removedMessageIds = await reconcileMailboxByKnownUids(incomingConnectorId, mailbox, uniqueUids);
        syncProgress.reconciledRemoved += removedMessageIds.length;
        await refreshMetadataTail(client, currentUidValidity);
        lastFullReconcileAt = new Date();
      }
    } else {
      const tailStart = Math.max(1, Math.max(highestUid, lastSeenUid) - Math.max(recentReconcileUidWindow, 1) + 1);
      const tailUids = await fetchUidsInRange(client, `${tailStart}:*`);
      if (tailUids.length > 0) {
        lastRemoteUids = tailUids;
        const removedMessageIds = await reconcileMailboxTailByKnownUids(
          incomingConnectorId,
          mailbox,
          tailUids,
          tailStart,
        );
        syncProgress.reconciledRemoved += removedMessageIds.length;
        await refreshMetadataTail(client, currentUidValidity);
      }
    }

    if (currentModseq) {
      nextModseq = currentModseq;
    } else if (hadChangedSinceFailure) {
      nextModseq = null;
    }

    const maxRemoteUid = lastRemoteUids.length > 0 ? lastRemoteUids[lastRemoteUids.length - 1] : Math.max(highestUid, lastSeenUid);
    advanceUidWatermark(maxRemoteUid);
    const normalizedModseq = nextModseq ? String(nextModseq) : null;

    await setSyncState(incomingConnectorId, mailbox, {
      lastSeenUid,
      highestUid,
      mailboxUidValidity: currentUidValidity,
      modseq: normalizedModseq,
      lastFullReconcileAt,
    });

    await emitSyncEvent(incomingConnectorId, 'sync_completed', {
      mailbox,
      inserted: syncProgress.inserted,
      updated: syncProgress.updated,
      reconciledRemoved: syncProgress.reconciledRemoved,
      metadataRefreshed: syncProgress.metadataRefreshed,
    });
    await writeProgress(true);
    return syncProgress;
    }, {
      ...options,
      operationTimeoutMs: syncOperationTimeoutMs,
    });
  } finally {
    clearInterval(heartbeatTimer);
  }
};

const syncMailbox = async (connector: any, mailbox: string, options: GetImapClientOptions = {}) => {
  try {
    const progress = await runMailboxSync(connector, mailbox, options);
    await setSyncState(connector.id, mailbox, {
      status: 'completed',
      syncCompletedAt: new Date(),
      syncError: null,
      syncProgress: progress ?? { inserted: 0, updated: 0, reconciledRemoved: 0, metadataRefreshed: 0 },
    });
    return progress;
  } catch (error) {
    if (String(error).includes(SYNC_ALREADY_RUNNING_SENTINEL)) {
      const snapshot = await getMailboxState(connector.id, mailbox).catch(() => null);
      return snapshot?.syncProgress ?? {
        inserted: 0,
        updated: 0,
        reconciledRemoved: 0,
        metadataRefreshed: 0,
      };
    }

    if (String(error).includes(SYNC_CANCELLED_SENTINEL)) {
      const snapshot = await getMailboxState(connector.id, mailbox).catch(() => null);
      const snapshotProgress = snapshot?.syncProgress ?? {
        inserted: 0,
        updated: 0,
        reconciledRemoved: 0,
        metadataRefreshed: 0,
      };
      await setSyncState(connector.id, mailbox, {
        status: 'cancelled',
        syncCompletedAt: new Date(),
        syncError: 'cancelled by user',
        syncProgress: snapshotProgress,
      });
      await emitSyncEvent(connector.id, 'sync_cancelled', { mailbox, progress: snapshotProgress });
      return snapshotProgress;
    }

    await setSyncState(connector.id, mailbox, {
      status: 'error',
      syncCompletedAt: new Date(),
      syncError: String(error),
      syncProgress: null,
    });
    throw error;
  }
};

export const syncIncomingConnector = async (
  userId: string,
  connectorId: string,
  mailbox = env.sync.defaultMailbox,
  options: GetImapClientOptions = {},
) => {
  const connector = await getIncomingConnectorByIdForUser(userId, connectorId);
  if (!connector) {
    throw new Error(`Incoming connector ${connectorId} not found`);
  }
  if (connector.provider === 'gmail' && connector.sync_settings?.gmailApiBootstrapped !== true) {
    // Only wipe existing data if the account is genuinely empty.
    // A missing flag on an account that already has messages (e.g. after a
    // migration or config issue) must NOT trigger a destructive full reset.
    const existingCount = await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM messages WHERE incoming_connector_id = $1 LIMIT 1`,
      [connectorId],
    );
    const hasExistingMessages = Number(existingCount.rows[0]?.count ?? 0) > 0;
    if (!hasExistingMessages) {
      await query('DELETE FROM messages WHERE incoming_connector_id = $1', [connectorId]);
      await query('DELETE FROM sync_states WHERE incoming_connector_id = $1', [connectorId]);
    }
    await query(
      `UPDATE incoming_connectors
          SET sync_settings = jsonb_set(COALESCE(sync_settings, '{}'::jsonb), '{gmailApiBootstrapped}', 'true'::jsonb, true),
              updated_at = NOW()
        WHERE id = $1
          AND user_id = $2`,
      [connectorId, userId],
    );
    connector.sync_settings = {
      ...(connector.sync_settings ?? {}),
      gmailApiBootstrapped: true,
    };
  }
  const normalizedMailbox = isGmailImapConnector(connector)
    ? normalizeGmailMailboxPath(mailbox)
    : mailbox;
  await ensureSystemLabelsForUser(userId);
  await ensureIncomingConnectorState(connectorId, normalizedMailbox);
  await syncMailbox(connector, normalizedMailbox, options);
};

export const reapStaleSyncStates = async () => {
  const staleMs = Number.isFinite(env.sync.syncClaimStaleMs) && env.sync.syncClaimStaleMs > 0
    ? Math.floor(env.sync.syncClaimStaleMs)
    : 900000;

  try {
    const result = await query<{
      incoming_connector_id: string;
      mailbox: string;
      status: string;
      sync_started_at: string | null;
      updated_at: string | null;
    }>(
      `UPDATE sync_states
          SET status = 'error',
              sync_completed_at = NOW(),
              sync_error = COALESCE(NULLIF(sync_error, ''), 'stale sync state reaped by maintenance'),
              updated_at = NOW()
        WHERE status IN ('syncing', 'queued', 'cancel_requested')
          AND COALESCE(updated_at, sync_started_at) IS NOT NULL
          AND COALESCE(updated_at, sync_started_at) < NOW() - ($1::double precision * INTERVAL '1 millisecond')
      RETURNING incoming_connector_id, mailbox, status, sync_started_at, updated_at`,
      [staleMs],
    );

    for (const row of result.rows) {
      await emitSyncEvent(row.incoming_connector_id, 'sync_error', {
        mailbox: row.mailbox,
        phase: 'stale-sync-reaper',
        previousStatus: row.status,
        syncStartedAt: row.sync_started_at,
        updatedAt: row.updated_at,
      }).catch(() => undefined);
    }

    return { reaped: result.rows.length };
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError?.code === '42703' || pgError?.code === '42P01') {
      return { reaped: 0 };
    }
    throw error;
  }
};

export const requestSyncCancellation = async (
  userId: string,
  connectorId: string,
  mailbox = env.sync.defaultMailbox,
) => {
  const connector = await getIncomingConnectorByIdForUser(userId, connectorId);
  if (!connector) {
    throw new Error(`Incoming connector ${connectorId} not found`);
  }
  const normalizedMailbox = isGmailImapConnector(connector)
    ? normalizeGmailMailboxPath(mailbox)
    : mailbox;

  await ensureIncomingConnectorState(connectorId, normalizedMailbox);
  await setSyncState(connectorId, normalizedMailbox, {
    status: 'cancel_requested',
    syncError: 'cancel requested by user',
  });
  await emitSyncEvent(connectorId, 'sync_cancel_requested', { mailbox: normalizedMailbox });
  return { status: 'cancel_requested', connectorId, mailbox: normalizedMailbox };
};

const createWatcherKey = (connectorId: string, mailbox: string) => `${connectorId}:${mailbox}`;

const getConnectorAuthToken = (connectorAuth: any) => connectorAuth?.accessToken ?? connectorAuth?.password;

export const startIncomingConnectorIdleWatch = async (userId: string, connectorId: string, mailbox = env.sync.defaultMailbox) => {
  const connector = await getIncomingConnectorByIdForUser(userId, connectorId);
  if (!connector) {
    throw new Error(`Incoming connector ${connectorId} not found`);
  }
  const normalizedMailbox = isGmailImapConnector(connector)
    ? normalizeGmailMailboxPath(mailbox)
    : mailbox;
  const key = createWatcherKey(connectorId, normalizedMailbox);
  if (activeIdleWatchers.has(key)) {
    return;
  }

  if (!getConnectorAuthToken(connector.auth_config)) {
    throw new Error(`Incoming connector ${connectorId} has no auth credentials`);
  }

  const nowMs = Date.now();
  const updateWatchActivity = (state: IdleWatch) => {
    state.lastActivityAtMs = Date.now();
  };
  const noteWatchError = (state: IdleWatch, error: unknown) => {
    state.errorCount += 1;
    state.lastError = String(error);
    state.lastActivityAtMs = Date.now();
  };

  if (connector.provider === 'gmail') {
    // Fix #6: If Gmail Pub/Sub push is healthy, suppress the fallback polling
    // loop — push notifications will trigger syncs directly.  Only start a
    // poll loop when push is absent, disabled, or in an error state.
    const pushSettings = connector.sync_settings?.gmailPush ?? {};
    if (pushSettings.enabled === true && pushSettings.status === 'watching') {
      await emitSyncEvent(connector.id, 'sync_info', {
        mailbox: normalizedMailbox,
        phase: 'watch_skipped_push_active',
        provider: connector.provider,
      });
      return;
    }

    const MAX_CONSECUTIVE_ERRORS = 20;
    const state: IdleWatch = {
      userId,
      connectorId,
      mailbox: normalizedMailbox,
      provider: connector.provider,
      startedAtMs: nowMs,
      lastActivityAtMs: nowMs,
      reconnectCount: 0,
      errorCount: 0,
      lastError: null,
      stop: false,
      stopped: false,
      close: async () => Promise.resolve(),
    };
    activeIdleWatchers.set(key, state);
    await emitSyncEvent(connector.id, 'sync_info', {
      mailbox: normalizedMailbox,
      phase: 'watch_started',
      provider: connector.provider,
    });

    state.close = async () => {
      state.stop = true;
      updateWatchActivity(state);
    };

    (async () => {
      try {
        while (!state.stop) {
          // Fix #5: circuit breaker — stop retrying after too many consecutive errors
          if (state.errorCount >= MAX_CONSECUTIVE_ERRORS) {
            await emitSyncEvent(connector.id, 'sync_error', {
              mailbox: normalizedMailbox,
              phase: 'watch_circuit_breaker_tripped',
              provider: connector.provider,
              errorCount: state.errorCount,
              lastError: state.lastError,
            });
            break;
          }
          try {
            updateWatchActivity(state);
            await syncIncomingConnector(userId, connectorId, normalizedMailbox);
            // Reset error count on success
            state.errorCount = 0;
            updateWatchActivity(state);
          } catch (error) {
            noteWatchError(state, error);
            await emitSyncEvent(connector.id, 'sync_error', {
              mailbox: normalizedMailbox,
              error: String(error),
            });
          }
          if (state.stop) {
            break;
          }
          updateWatchActivity(state);
          await delay(Math.max(env.sync.idleIntervalMs, 2000));
        }
      } finally {
        state.stopped = true;
        if (activeIdleWatchers.get(key) === state) {
          activeIdleWatchers.delete(key);
        }
      }
    })();

    return;
  }

  const state: IdleWatch = {
    userId,
    connectorId,
    mailbox: normalizedMailbox,
    provider: connector.provider,
    startedAtMs: nowMs,
    lastActivityAtMs: nowMs,
    reconnectCount: 0,
    errorCount: 0,
    lastError: null,
    stop: false,
    stopped: false,
    close: async () => Promise.resolve(),
  };

  const openWatchClient = async (forceOAuthRefresh = false) => {
    const watchClient = await getImapClient(connector, { forceOAuthRefresh });
    await watchClient.connect();
    const resolvedMailbox = await resolveGmailImapMailboxPath(connector, watchClient, normalizedMailbox);
    await watchClient.mailboxOpen(resolvedMailbox);
    return watchClient;
  };

  let client = await openWatchClient();
  activeIdleWatchers.set(key, state);
  await emitSyncEvent(connector.id, 'sync_info', {
    mailbox: normalizedMailbox,
    phase: 'watch_started',
    provider: connector.provider,
  });

  state.close = async () => {
    state.stop = true;
    updateWatchActivity(state);
    await client.logout().catch(() => undefined);
  };

  // Safety net for missed IDLE notifications: run a periodic sync regardless
  // of IDLE return behavior so silent server-side drops cannot stall delivery.
  const idleFallbackSyncIntervalMs = Math.max(env.sync.idleIntervalMs * 3, 6_000);
  let fallbackTimer: NodeJS.Timeout | null = null;
  let syncInFlight = false;

  const ensureSync = async () => {
    if (syncInFlight || state.stop) {
      return;
    }
    syncInFlight = true;
    try {
      updateWatchActivity(state);
      await syncIncomingConnector(userId, connectorId, normalizedMailbox);
      state.errorCount = 0;
      updateWatchActivity(state);
    } catch (error) {
      noteWatchError(state, error);
      await emitSyncEvent(connector.id, 'sync_error', {
        mailbox: normalizedMailbox,
        error: String(error),
      });
    } finally {
      syncInFlight = false;
    }
  };

  (async () => {
    const MAX_CONSECUTIVE_ERRORS = 20;
    try {
      await ensureSync();
      fallbackTimer = setInterval(() => {
        void ensureSync();
      }, idleFallbackSyncIntervalMs);
      fallbackTimer.unref?.();

      while (!state.stop) {
        // Fix #5: circuit breaker — stop retrying after too many consecutive errors
        if (state.errorCount >= MAX_CONSECUTIVE_ERRORS) {
          await emitSyncEvent(connector.id, 'sync_error', {
            mailbox: normalizedMailbox,
            phase: 'watch_circuit_breaker_tripped',
            provider: connector.provider,
            errorCount: state.errorCount,
            lastError: state.lastError,
          }).catch(() => undefined);
          break;
        }

        let hasChanges = false;
        try {
          updateWatchActivity(state);
          hasChanges = await client.idle();
          // Reset error count on a successful idle round
          state.errorCount = 0;
          updateWatchActivity(state);
        } catch (error) {
          if (state.stop) {
            break;
          }

          noteWatchError(state, error);
          await emitSyncEvent(connector.id, 'sync_error', {
            mailbox: normalizedMailbox,
            error: String(error),
          });

          const shouldRefreshAuth = isGmailImapConnector(connector)
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
                mailbox: normalizedMailbox,
                error: String(refreshError),
              });
            }
          }

          await client.logout().catch(() => undefined);

          const backoffMs = Math.min(1000 * 2 ** Math.min(state.errorCount - 1, 6), 120000);
          await delay(backoffMs);
          try {
            client = await openWatchClient(shouldRefreshAuth);
            state.reconnectCount += 1;
            // Reset error count on successful reconnect
            state.errorCount = 0;
            updateWatchActivity(state);
            await emitSyncEvent(connector.id, 'sync_info', {
              mailbox: normalizedMailbox,
              phase: 'watch_reconnected',
              reconnectCount: state.reconnectCount,
              backoffMs,
            });
            continue;
          } catch (reconnectError) {
            noteWatchError(state, reconnectError);
            await emitSyncEvent(connector.id, 'sync_error', {
              mailbox: normalizedMailbox,
              error: String(reconnectError),
            });
            const reconnectBackoffMs = Math.min(2000 * 2 ** Math.min(state.errorCount - 1, 6), 120000);
            await delay(reconnectBackoffMs);
            continue;
          }
        }

        if (hasChanges) {
          await ensureSync();
        }
      }
    } finally {
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
      }
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
  const normalizedMailbox = isGmailImapConnector(connector)
    ? normalizeGmailMailboxPath(mailbox)
    : mailbox;

  const key = createWatcherKey(connectorId, normalizedMailbox);
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

export const runIdleWatchdog = async () => {
  // Keep watchdog threshold comfortably above normal sync durations so
  // aggressive UI polling / short idle intervals don't trigger false restarts.
  const staleMs = Math.max(
    env.sync.idleIntervalMs * 6,
    env.sync.syncClaimStaleMs + env.sync.syncClaimHeartbeatStaleMs,
    120000,
  );
  const snapshot = Array.from(activeIdleWatchers.values()).filter((watch) => !watch.stop && !watch.stopped);
  let restarted = 0;

  for (const watch of snapshot) {
    const idleForMs = Date.now() - watch.lastActivityAtMs;
    if (idleForMs <= staleMs) {
      continue;
    }

    await emitSyncEvent(watch.connectorId, 'sync_error', {
      mailbox: watch.mailbox,
      phase: 'idle-watchdog-stale',
      provider: watch.provider,
      idleForMs,
      reconnectCount: watch.reconnectCount,
      errorCount: watch.errorCount,
      lastError: watch.lastError,
    }).catch(() => undefined);

    try {
      await stopIncomingConnectorIdleWatch(watch.userId, watch.connectorId, watch.mailbox);
      await startIncomingConnectorIdleWatch(watch.userId, watch.connectorId, watch.mailbox);
      restarted += 1;
      await emitSyncEvent(watch.connectorId, 'sync_info', {
        mailbox: watch.mailbox,
        phase: 'idle-watchdog-restarted',
        provider: watch.provider,
        idleForMs,
      }).catch(() => undefined);
    } catch (error) {
      await emitSyncEvent(watch.connectorId, 'sync_error', {
        mailbox: watch.mailbox,
        phase: 'idle-watchdog-restart-failed',
        provider: watch.provider,
        error: String(error),
      }).catch(() => undefined);
    }
  }

  return { watched: snapshot.length, restarted, staleMs };
};

export const resumeConfiguredIdleWatches = async () => {
  if (!env.sync.useIdle) {
    return { resumed: 0 };
  }

  const connectors = await query<{
    id: string;
    user_id: string;
    sync_settings: Record<string, any> | null;
  }>(
    `SELECT id, user_id, sync_settings
       FROM incoming_connectors
      WHERE status = 'active'`,
  );

  let resumed = 0;
  for (const connector of connectors.rows) {
    const configured = connector.sync_settings?.watchMailboxes;
    const watchMailboxes = Array.isArray(configured)
      ? configured.map((value) => String(value)).filter(Boolean)
      : [];
    for (const mailbox of watchMailboxes) {
      try {
        await startIncomingConnectorIdleWatch(connector.user_id, connector.id, mailbox);
        resumed += 1;
      } catch (error) {
        console.warn(`Failed to resume watcher for ${connector.id}:${mailbox}`, error);
      }
    }
  }

  return { resumed };
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
    const resolvedMailbox = await resolveGmailImapMailboxPath(incomingConnector, client, mailbox);
    await client.mailboxOpen(resolvedMailbox);
    await client.append(resolvedMailbox, rawMessage, ['Seen']);
    return;
  });
};

export const moveMessageInMailbox = async (
  userId: string,
  messageId: string,
  incomingConnectorId: string,
  sourceFolder: string,
  destinationFolder: string,
  uid: number | null,
) => {
  const incomingConnector = await getIncomingConnectorByIdForUser(userId, incomingConnectorId);
  if (!incomingConnector) {
    throw new Error('Incoming connector not found');
  }

  const messageConnectorId = await getConnectorByMessageId(userId, messageId);
  if (!messageConnectorId || messageConnectorId !== incomingConnectorId) {
    throw new Error('Message not found');
  }

  if (incomingConnector.provider === 'gmail') {
    const message = await getGmailMessageForUser(userId, messageId);
    if (!message?.gmail_message_id) {
      throw new Error('gmail message id unavailable for action');
    }
    const normalizedDestination = normalizeGmailMailboxPath(destinationFolder);
    const sourceLabel = mapFolderToGmailLabelId(sourceFolder);
    const destinationLabel = mapFolderToGmailLabelId(normalizedDestination);
    const archiveRequested = normalizedDestination === 'ALL' || normalizedDestination === 'ARCHIVE';

    let addLabelIds: string[] = [];
    let removeLabelIds: string[] = [];
    let targetFolderPath = normalizedDestination;

    if (archiveRequested) {
      removeLabelIds = sourceLabel ? [sourceLabel] : ['INBOX'];
      targetFolderPath = 'ALL';
    } else {
      if (!destinationLabel) {
        throw new Error('destination label not supported');
      }
      addLabelIds = [destinationLabel];
      removeLabelIds = sourceLabel ? [sourceLabel] : [];
      targetFolderPath = normalizedDestination;
    }

    const labels = await gmailModifyMessageLabels(
      incomingConnector,
      message.gmail_message_id,
      addLabelIds,
      removeLabelIds,
    );
    await query(
      'UPDATE messages SET folder_path = $2, flags = $3, is_read = $4, is_starred = $5, updated_at = NOW() WHERE id = $1',
      [messageId, targetFolderPath, labels, !labels.includes('UNREAD'), labels.includes('STARRED')],
    );
    await syncSystemLabelsForMessage(
      userId,
      messageId,
      targetFolderPath,
      labels.includes('STARRED'),
    );
    return;
  }

  if (uid === null || uid === undefined) {
    throw new Error('message uid unavailable for action');
  }

  const effectiveDestinationFolder = isGmailImapConnector(incomingConnector)
    ? normalizeGmailMailboxPath(destinationFolder)
    : destinationFolder;

  await runImapOperation(incomingConnector, async (client) => {
    const resolvedSource = await resolveGmailImapMailboxPath(incomingConnector, client, sourceFolder);
    const resolvedDestination = await resolveGmailImapMailboxPath(incomingConnector, client, destinationFolder);
    await client.mailboxOpen(resolvedSource);
    await client.messageMove(String(uid), resolvedDestination, { uid: true });
    await query(
      'UPDATE messages SET folder_path = $2, updated_at = NOW() WHERE id = $1',
      [messageId, effectiveDestinationFolder],
    );
    const state = await query<{ is_starred: boolean }>(
      'SELECT is_starred FROM messages WHERE id = $1',
      [messageId],
    );
    if (state.rows[0]) {
      await syncSystemLabelsForMessage(
        userId,
        messageId,
        effectiveDestinationFolder,
        !!state.rows[0].is_starred,
      );
    }
  });
};

export const setMessageReadState = async (
  userId: string,
  messageId: string,
  incomingConnectorId: string,
  folderPath: string,
  uid: number | null,
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

  const message = await getGmailMessageForUser(userId, messageId);
  if (!message) {
    throw new Error('Message not found');
  }
  const previousState = {
    isRead: message.is_read,
    isStarred: message.is_starred,
    flags: Array.isArray(message.flags) ? message.flags : [],
  };

  if (incomingConnector.provider === 'gmail') {
    if (!message?.gmail_message_id) {
      throw new Error('gmail message id unavailable for action');
    }
    await query(
      'UPDATE messages SET is_read = $2, flags = $3, updated_at = NOW() WHERE id = $1',
      [messageId, isRead, setFlagInList(previousState.flags, 'UNREAD', !isRead)],
    );
    try {
      const labels = await gmailModifyMessageLabels(
        incomingConnector,
        message.gmail_message_id,
        isRead ? [] : ['UNREAD'],
        isRead ? ['UNREAD'] : [],
      );
      await query(
        'UPDATE messages SET is_read = $2, is_starred = $3, flags = $4, updated_at = NOW() WHERE id = $1',
        [messageId, !labels.includes('UNREAD'), labels.includes('STARRED'), labels],
      );
    } catch (error) {
      await query(
        'UPDATE messages SET is_read = $2, is_starred = $3, flags = $4, updated_at = NOW() WHERE id = $1',
        [messageId, previousState.isRead, previousState.isStarred, previousState.flags],
      ).catch(() => undefined);
      throw error;
    }
    return;
  }

  if (uid === null || uid === undefined) {
    throw new Error('message uid unavailable for action');
  }

  const effectiveFolderPath = isGmailImapConnector(incomingConnector)
    ? normalizeGmailMailboxPath(folderPath)
    : folderPath;

  await query(
    'UPDATE messages SET is_read = $2, flags = $3, updated_at = NOW() WHERE id = $1',
    [messageId, isRead, setFlagInList(previousState.flags, '\\Seen', isRead)],
  );

  try {
    await runImapOperation(incomingConnector, async (client) => {
      const resolvedMailbox = await resolveGmailImapMailboxPath(incomingConnector, client, effectiveFolderPath);
      await client.mailboxOpen(resolvedMailbox);
      if (isRead) {
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      } else {
        await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
      }
    });
  } catch (error) {
    await query(
      'UPDATE messages SET is_read = $2, is_starred = $3, flags = $4, updated_at = NOW() WHERE id = $1',
      [messageId, previousState.isRead, previousState.isStarred, previousState.flags],
    ).catch(() => undefined);
    throw error;
  }
};

export const setMessageStarredState = async (
  userId: string,
  messageId: string,
  incomingConnectorId: string,
  folderPath: string,
  uid: number | null,
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

  const message = await getGmailMessageForUser(userId, messageId);
  if (!message) {
    throw new Error('Message not found');
  }
  const previousState = {
    isRead: message.is_read,
    isStarred: message.is_starred,
    flags: Array.isArray(message.flags) ? message.flags : [],
  };

  if (incomingConnector.provider === 'gmail') {
    if (!message?.gmail_message_id) {
      throw new Error('gmail message id unavailable for action');
    }
    const normalizedFolder = normalizeGmailMailboxPath(folderPath);
    await query(
      'UPDATE messages SET is_starred = $2, flags = $3, updated_at = NOW() WHERE id = $1',
      [messageId, isStarred, setFlagInList(previousState.flags, 'STARRED', isStarred)],
    );
    await syncSystemLabelsForMessage(userId, messageId, normalizedFolder, isStarred);
    try {
      const labels = await gmailModifyMessageLabels(
        incomingConnector,
        message.gmail_message_id,
        isStarred ? ['STARRED'] : [],
        isStarred ? [] : ['STARRED'],
      );
      const resolvedStarred = labels.includes('STARRED');
      await query(
        'UPDATE messages SET is_starred = $2, is_read = $3, flags = $4, updated_at = NOW() WHERE id = $1',
        [messageId, resolvedStarred, !labels.includes('UNREAD'), labels],
      );
      await syncSystemLabelsForMessage(userId, messageId, normalizedFolder, resolvedStarred);
    } catch (error) {
      await query(
        'UPDATE messages SET is_starred = $2, is_read = $3, flags = $4, updated_at = NOW() WHERE id = $1',
        [messageId, previousState.isStarred, previousState.isRead, previousState.flags],
      ).catch(() => undefined);
      await syncSystemLabelsForMessage(userId, messageId, normalizedFolder, previousState.isStarred).catch(() => undefined);
      throw error;
    }
    return;
  }

  if (uid === null || uid === undefined) {
    throw new Error('message uid unavailable for action');
  }

  const effectiveFolderPath = isGmailImapConnector(incomingConnector)
    ? normalizeGmailMailboxPath(folderPath)
    : folderPath;

  await query(
    'UPDATE messages SET is_starred = $2, flags = $3, updated_at = NOW() WHERE id = $1',
    [messageId, isStarred, setFlagInList(previousState.flags, '\\Flagged', isStarred)],
  );
  await syncSystemLabelsForMessage(userId, messageId, effectiveFolderPath, isStarred);

  try {
    await runImapOperation(incomingConnector, async (client) => {
      const resolvedMailbox = await resolveGmailImapMailboxPath(incomingConnector, client, effectiveFolderPath);
      await client.mailboxOpen(resolvedMailbox);
      if (isStarred) {
        await client.messageFlagsAdd(String(uid), ['\\Flagged'], { uid: true });
      } else {
        await client.messageFlagsRemove(String(uid), ['\\Flagged'], { uid: true });
      }
    });
  } catch (error) {
    await query(
      'UPDATE messages SET is_starred = $2, is_read = $3, flags = $4, updated_at = NOW() WHERE id = $1',
      [messageId, previousState.isStarred, previousState.isRead, previousState.flags],
    ).catch(() => undefined);
    await syncSystemLabelsForMessage(userId, messageId, effectiveFolderPath, previousState.isStarred).catch(() => undefined);
    throw error;
  }
};

export const deleteMessageFromMailbox = async (
  userId: string,
  messageId: string,
  incomingConnectorId: string,
  folderPath: string,
  uid: number | null,
) => {
  const incomingConnector = await getIncomingConnectorByIdForUser(userId, incomingConnectorId);
  if (!incomingConnector) {
    throw new Error('Incoming connector not found');
  }

  const messageConnectorId = await getConnectorByMessageId(userId, messageId);
  if (!messageConnectorId || messageConnectorId !== incomingConnectorId) {
    throw new Error('Message not found');
  }

  if (incomingConnector.provider === 'gmail') {
    const message = await getGmailMessageForUser(userId, messageId);
    if (!message?.gmail_message_id) {
      throw new Error('gmail message id unavailable for action');
    }
    await gmailApiRequest(
      'incoming',
      incomingConnector,
      `/messages/${encodeURIComponent(message.gmail_message_id)}/trash`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    await query('DELETE FROM messages WHERE id = $1', [messageId]);
    return;
  }

  if (uid === null || uid === undefined) {
    throw new Error('message uid unavailable for action');
  }

  const effectiveFolderPath = isGmailImapConnector(incomingConnector)
    ? normalizeGmailMailboxPath(folderPath)
    : folderPath;

  await runImapOperation(incomingConnector, async (client) => {
    const resolvedMailbox = await resolveGmailImapMailboxPath(incomingConnector, client, effectiveFolderPath);
    await client.mailboxOpen(resolvedMailbox);
    await client.messageDelete(String(uid), { uid: true });
    await query('DELETE FROM messages WHERE id = $1', [messageId]);
  });
};

export const applyThreadMessageActions = async (
  userId: string,
  messageId: string,
  payload: {
    isRead?: boolean;
    isStarred?: boolean;
    moveToFolder?: string;
    delete?: boolean;
    addLabelKeys?: string[];
    removeLabelKeys?: string[];
  },
) => {
  const threadId = await getThreadIdForMessage(userId, messageId);
  if (!threadId) {
    throw new Error('Message not found');
  }

  const threadMessages = await getThreadMessageRowsForUser(userId, threadId);
  if (threadMessages.length === 0) {
    throw new Error('Thread not found');
  }

  if (payload.addLabelKeys?.length) {
    for (const message of threadMessages) {
      await addLabelsToMessageByKey(userId, message.id, payload.addLabelKeys);
    }
  }
  if (payload.removeLabelKeys?.length) {
    for (const message of threadMessages) {
      await removeLabelsFromMessageByKey(userId, message.id, payload.removeLabelKeys);
    }
  }

  if (payload.isRead !== undefined) {
    for (const message of threadMessages) {
      await setMessageReadState(
        userId,
        message.id,
        message.incoming_connector_id,
        message.folder_path,
        message.uid === null || message.uid === undefined ? null : Number(message.uid),
        payload.isRead,
      );
    }
  }

  if (payload.isStarred !== undefined) {
    for (const message of threadMessages) {
      await setMessageStarredState(
        userId,
        message.id,
        message.incoming_connector_id,
        message.folder_path,
        message.uid === null || message.uid === undefined ? null : Number(message.uid),
        payload.isStarred,
      );
    }
  }

  if (payload.moveToFolder) {
    for (const message of threadMessages) {
      await moveMessageInMailbox(
        userId,
        message.id,
        message.incoming_connector_id,
        message.folder_path,
        payload.moveToFolder,
        message.uid === null || message.uid === undefined ? null : Number(message.uid),
      );
    }
  }

  if (payload.delete) {
    for (const message of threadMessages) {
      await deleteMessageFromMailbox(
        userId,
        message.id,
        message.incoming_connector_id,
        message.folder_path,
        message.uid === null || message.uid === undefined ? null : Number(message.uid),
      );
    }
  }
};

export const listConnectorMailboxes = async (userId: string, connectorId: string) => {
  const connector = await getIncomingConnectorByIdForUser(userId, connectorId);
  if (!connector) {
    throw new Error(`Incoming connector ${connectorId} not found`);
  }

  if (connector.provider === 'gmail') {
    return getGmailMailboxes(connector);
  }

  if (isGmailImapConnector(connector)) {
    return runImapOperation(connector, async (client) => {
      const directory = await buildGmailImapMailboxDirectory(connector.id, client);
      const seen = new Set<string>();
      const nonSelectableContainers = new Set(['[GMAIL]', '[GOOGLE MAIL]']);
      return directory.displayRows
        .map((mailbox) => {
          const canonicalPath = mailbox.canonicalPath ?? normalizeGmailMailboxPath(mailbox.serverPath);
          const path = canonicalPath || mailbox.serverPath;
          const normalizedPathKey = String(path).trim().toUpperCase();
          return {
            path,
            canonicalPath,
            normalizedPathKey,
            mailbox,
          };
        })
        .filter((entry) => {
          if (!entry.normalizedPathKey) {
            return false;
          }
          if (nonSelectableContainers.has(entry.normalizedPathKey)) {
            return false;
          }
          if (seen.has(entry.normalizedPathKey)) {
            return false;
          }
          seen.add(entry.normalizedPathKey);
          return true;
        })
        .map(({ mailbox, path }) => ({
          path,
          name: mailbox.displayPath || mailbox.serverPath,
          delimiter: mailbox.delimiter,
          flags: mailbox.specialUse ? [mailbox.specialUse] : [],
          subscribed: mailbox.subscribed,
          specialUse: mailbox.specialUse,
        }));
    });
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
