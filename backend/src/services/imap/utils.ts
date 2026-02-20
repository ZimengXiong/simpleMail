import { query } from '../../db/pool.js';

export const MAX_MAILBOX_PATH_CHARS = 512;
export const MAX_WATCH_MAILBOXES = 32;
export const MAX_WATCH_MAILBOX_SANITIZE_SCAN_ITEMS = MAX_WATCH_MAILBOXES * 8;
const MAILBOX_CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;

export const getConnectorAuth = (connector: any) => connector?.auth_config ?? {};

export const isGmailImapConnector = (connector: any): boolean => {
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

export const normalizeWatchMailboxInput = (value: unknown): string => {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error('mailbox is required');
  }
  if (normalized.length > MAX_MAILBOX_PATH_CHARS) {
    throw new Error(`mailbox exceeds ${MAX_MAILBOX_PATH_CHARS} characters`);
  }
  if (MAILBOX_CONTROL_CHAR_PATTERN.test(normalized)) {
    throw new Error('mailbox contains invalid control characters');
  }
  return normalized;
};

export type SyncMailboxStatus = 'idle' | 'queued' | 'syncing' | 'cancel_requested' | 'cancelled' | 'completed' | 'error';

export type SyncProgressSnapshot = {
  inserted: number;
  updated: number;
  reconciledRemoved: number;
  metadataRefreshed: number;
};

export type SyncStatePatch = {
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

export const normalizeSyncProgress = (progress: SyncProgressSnapshot | Record<string, any> | null | undefined) =>
  progress && typeof progress === 'object' ? progress : {};

let syncStateColumnCache: Set<string> | null = null;

export const getSyncStateColumns = async () => {
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
    result.rows.map((row: { column_name: string }) => row.column_name.toLowerCase()),
  );
  return syncStateColumnCache;
};

export const toBigInt = (value: any): bigint | null => {
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

export const toNumber = (value: unknown): number | null => {
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

export const toNumberUid = (value: unknown): number | null => {
  const numeric = toNumber(value);
  if (numeric === null) {
    return null;
  }
  return Number.isInteger(numeric) ? numeric : Math.trunc(numeric);
};

export const toNumberUidList = (uids: Array<bigint | number | string>): number[] =>
  uids
    .map((uid) => toNumberUid(uid))
    .filter((uid): uid is number => uid !== null);

export const chunkArray = <T>(values: T[], chunkSize: number): T[][] => {
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

export const normalizeWatchMailboxList = (
  raw: unknown,
  { isGmailLike, mailboxNormalizer }: { isGmailLike: boolean; mailboxNormalizer: (mailbox: string) => string },
): string[] => {
  const entries = Array.isArray(raw) ? raw : [];
  const normalized: string[] = [];
  const dedupe = new Set<string>();
  const scanLimit = Math.min(entries.length, MAX_WATCH_MAILBOX_SANITIZE_SCAN_ITEMS);
  for (let index = 0; index < scanLimit && normalized.length < MAX_WATCH_MAILBOXES; index += 1) {
    let mailbox: string;
    try {
      mailbox = normalizeWatchMailboxInput(entries[index]);
    } catch {
      continue;
    }
    const canonicalMailbox = isGmailLike ? mailboxNormalizer(mailbox) : mailbox;
    if (dedupe.has(canonicalMailbox)) {
      continue;
    }
    dedupe.add(canonicalMailbox);
    normalized.push(canonicalMailbox);
  }
  return normalized;
};
