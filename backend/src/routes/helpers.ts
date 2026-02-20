import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { assertSafeOutboundHost } from '../services/networkGuard.js';
import { getIncomingConnector } from '../services/connectorService.js';
import { normalizeGmailMailboxPath, ensureIncomingConnectorState, getGmailMailboxPathAliases } from '../services/imap.js';

export const required = (value: unknown, key: string): string => {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${key} is required`);
  }
  return String(value);
};

export const isGmailAuthConnector = (connector: any): boolean => {
  if (!connector) {
    return false;
  }

  if (connector.provider === 'gmail') {
    return true;
  }

  if (connector.provider !== 'imap') {
    return false;
  }

  return Boolean(
    connector.sync_settings?.gmailImap ||
    connector.syncSettings?.gmailImap ||
    connector.authConfig?.gmailImap,
  );
};

export const isActiveConnectorStatus = (value: unknown) => String(value ?? '').trim().toLowerCase() === 'active';

export const isGmailLikeConnector = (connector: any): boolean => {
  if (!connector) {
    return false;
  }

  if (connector.provider === 'gmail') {
    return true;
  }

  return connector.provider === 'imap'
    && Boolean(
      connector.sync_settings?.gmailImap ||
      connector.syncSettings?.gmailImap,
    );
};

export const getMessageAndConnectorForUser = async (userId: string, messageId: string) => {
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

export const parseBooleanParam = (value: unknown): boolean | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  return null;
};

export const parsePositiveIntWithCap = (value: unknown, fallback: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
};

export const parseNonNegativeIntWithCap = (value: unknown, fallback: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
};

export const parseTrimmedStringArrayWithCap = (
  value: unknown,
  fieldName: string,
  maxItems: number,
): string[] => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  if (value.length > maxItems) {
    throw new Error(`${fieldName} exceeds ${maxItems} items`);
  }
  const normalized: string[] = [];
  const dedupe = new Set<string>();
  for (const entry of value) {
    const token = String(entry ?? '').trim();
    if (!token) {
      throw new Error(`${fieldName} must not contain empty values`);
    }
    if (dedupe.has(token)) {
      continue;
    }
    dedupe.add(token);
    normalized.push(token);
  }
  return normalized;
};

export const assertUuidList = (values: string[], fieldName: string) => {
  for (const value of values) {
    if (!UUID_PATTERN.test(value)) {
      throw new Error(`${fieldName} must contain valid UUID values`);
    }
  }
};

export type ConnectorOwnershipCacheEntry = {
  expiresAtMs: number;
  isGmailLike: boolean;
};

export type TimedCacheEntry<T> = {
  expiresAtMs: number;
  value: T;
};

export type QuickFiltersResponse = {
  labels: Array<{ key: string; name: string; count: number }>;
  starred: number;
  withAttachments: number;
  topFrom: Array<{ fromHeader: string; count: number }>;
};

export type SearchSuggestionsResponse = {
  labels: Array<{ key: string; name: string }>;
  from: Array<{ fromHeader: string; count: number }>;
  subjects: Array<{ subject: string; count: number }>;
};

export const ACTIVE_MAILBOX_CONNECTOR_CACHE_TTL_MS = 60_000;
export const ACTIVE_MAILBOX_CONNECTOR_CACHE_MAX = 2_000;
const activeMailboxConnectorCache = new Map<string, ConnectorOwnershipCacheEntry>();
export const SEARCH_QUICK_FILTERS_CACHE_TTL_MS = 8_000;
export const SEARCH_QUICK_FILTERS_CACHE_MAX = 2_000;
export const SEARCH_SUGGESTIONS_CACHE_TTL_MS = 15_000;
export const SEARCH_SUGGESTIONS_CACHE_MAX = 8_000;
const quickFiltersCache = new Map<string, TimedCacheEntry<QuickFiltersResponse>>();
const searchSuggestionsCache = new Map<string, TimedCacheEntry<SearchSuggestionsResponse>>();
const activeEventStreamsByUser = new Map<string, number>();

export const activeMailboxConnectorCacheKey = (userId: string, connectorId: string) =>
  `${userId}:${connectorId}`;

export const getActiveMailboxConnectorCache = (userId: string, connectorId: string): ConnectorOwnershipCacheEntry | null => {
  const key = activeMailboxConnectorCacheKey(userId, connectorId);
  const cached = activeMailboxConnectorCache.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAtMs <= Date.now()) {
    activeMailboxConnectorCache.delete(key);
    return null;
  }
  return cached;
};

export const setActiveMailboxConnectorCache = (
  userId: string,
  connectorId: string,
  isGmailLike: boolean,
) => {
  const key = activeMailboxConnectorCacheKey(userId, connectorId);
  activeMailboxConnectorCache.delete(key);
  activeMailboxConnectorCache.set(key, {
    expiresAtMs: Date.now() + ACTIVE_MAILBOX_CONNECTOR_CACHE_TTL_MS,
    isGmailLike,
  });
  if (activeMailboxConnectorCache.size > ACTIVE_MAILBOX_CONNECTOR_CACHE_MAX) {
    const oldest = activeMailboxConnectorCache.keys().next().value as string | undefined;
    if (oldest) {
      activeMailboxConnectorCache.delete(oldest);
    }
  }
};

export const clearActiveMailboxConnectorCache = (userId: string, connectorId: string) => {
  activeMailboxConnectorCache.delete(activeMailboxConnectorCacheKey(userId, connectorId));
};

export const getIncomingConnectorGmailLikeCached = async (userId: string, connectorId: string): Promise<boolean | null> => {
  const cached = getActiveMailboxConnectorCache(userId, connectorId);
  if (cached) {
    return cached.isGmailLike;
  }

  const connector = await getIncomingConnector(userId, connectorId);
  if (!connector) {
    return null;
  }

  const isGmailLike = isGmailLikeConnector(connector);
  setActiveMailboxConnectorCache(userId, connectorId, isGmailLike);
  return isGmailLike;
};

export const getTimedCacheValue = <T>(
  cache: Map<string, TimedCacheEntry<T>>,
  key: string,
): T | null => {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expiresAtMs <= Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
};

export const setTimedCacheValue = <T>(
  cache: Map<string, TimedCacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
  maxEntries: number,
) => {
  cache.delete(key);
  cache.set(key, {
    expiresAtMs: Date.now() + ttlMs,
    value,
  });
  if (cache.size > maxEntries) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest) {
      cache.delete(oldest);
    }
  }
};

export const getQuickFiltersCache = (userId: string) => quickFiltersCache.get(userId) ?? null;
export const setQuickFiltersCache = (
  userId: string,
  value: QuickFiltersResponse,
  ttlMs: number,
  maxEntries: number,
) => {
  setTimedCacheValue(quickFiltersCache, userId, value, ttlMs, maxEntries);
};

export const getSearchSuggestionsCache = (key: string) => searchSuggestionsCache.get(key) ?? null;
export const setSearchSuggestionsCache = (
  key: string,
  value: SearchSuggestionsResponse,
  ttlMs: number,
  maxEntries: number,
) => {
  setTimedCacheValue(searchSuggestionsCache, key, value, ttlMs, maxEntries);
};

export const clearSearchCachesForUser = (userId: string) => {
  quickFiltersCache.delete(userId);
  const prefix = `${userId}:`;
  for (const key of searchSuggestionsCache.keys()) {
    if (key.startsWith(prefix)) {
      searchSuggestionsCache.delete(key);
    }
  }
};

export const ensureIncomingConnectorStatesBulk = async (
  connectorId: string,
  mailboxes: string[],
) => {
  const normalized = Array.from(new Set(
    (mailboxes ?? [])
      .map((mailbox) => String(mailbox ?? '').trim())
      .filter(Boolean),
  ));
  if (normalized.length === 0) {
    return;
  }

  try {
    await query(
      `INSERT INTO sync_states (incoming_connector_id, mailbox)
       SELECT $1, mailbox
         FROM UNNEST($2::text[]) AS mailboxes(mailbox)
       ON CONFLICT (incoming_connector_id, mailbox)
       DO NOTHING`,
      [connectorId, normalized],
    );
  } catch {
    for (const mailbox of normalized) {
      await ensureIncomingConnectorState(connectorId, mailbox);
    }
  }
};

export const tryAcquireEventStreamSlot = (userId: string) => {
  const current = activeEventStreamsByUser.get(userId) ?? 0;
  if (current >= MAX_ACTIVE_EVENT_STREAMS_PER_USER) {
    return false;
  }
  activeEventStreamsByUser.set(userId, current + 1);
  return true;
};

export const releaseEventStreamSlot = (userId: string) => {
  const current = activeEventStreamsByUser.get(userId) ?? 0;
  if (current <= 1) {
    activeEventStreamsByUser.delete(userId);
    return;
  }
  activeEventStreamsByUser.set(userId, current - 1);
};

export const mailboxReadPreferenceRankSql = `CASE UPPER(m.folder_path)
  WHEN 'INBOX' THEN 0
  WHEN 'SENT' THEN 1
  WHEN 'DRAFT' THEN 2
  WHEN 'STARRED' THEN 3
  WHEN 'IMPORTANT' THEN 4
  WHEN 'SPAM' THEN 5
  WHEN 'TRASH' THEN 6
  WHEN 'ALL' THEN 90
  ELSE 20
END`;

export const logicalMessageKeySql = (alias: string) =>
  `COALESCE(NULLIF(${alias}.gmail_message_id, ''), LOWER(NULLIF(${alias}.message_id, '')), ${alias}.id::text)`;

export const normalizeConnectorFolderFilterWithConnector = (
  folder: string | undefined,
  connector: any | null,
) => {
  if (!folder || !connector) {
    return folder;
  }
  if (!isGmailLikeConnector(connector)) {
    return folder;
  }
  return normalizeGmailMailboxPath(folder);
};

export const buildGmailFolderPredicatesWithConnector = (
  folder: string | undefined,
  connector: any | null,
) => {
  if (!folder || !connector) {
    return {
      candidates: null as string[] | null,
      dedupeLogicalMessages: false,
    };
  }

  const normalizedFolder = isGmailLikeConnector(connector)
    ? normalizeGmailMailboxPath(folder)
    : String(folder).trim();

  if (!isGmailLikeConnector(connector)) {
    return {
      candidates: [normalizedFolder.toUpperCase()],
      dedupeLogicalMessages: false,
    };
  }

  return {
    candidates: getGmailMailboxPathAliases(normalizedFolder),
    dedupeLogicalMessages: true,
  };
};

export const parseAddressList = (value: unknown): string[] | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const candidates = Array.isArray(value) ? value : [value];
  const parsed = candidates
    .flatMap((entry) => String(entry).split(/[,\n;]/))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) =>
      entry.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [],
    );
  if (parsed.length === 0) {
    return undefined;
  }
  const dedupe = new Set<string>();
  const normalized: string[] = [];
  for (const item of parsed) {
    const email = item.trim().toLowerCase();
    if (!email || dedupe.has(email)) {
      continue;
    }
    dedupe.add(email);
    normalized.push(email);
  }
  return normalized.length > 0 ? normalized : undefined;
};

export const parseOptionalHeaderValue = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
};

export const MAIL_TLS_MODE_VALUES = new Set(['ssl', 'starttls', 'none']);
export const BASE64_BODY_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
export const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
export const HEADER_VALUE_PATTERN = /^[^\r\n]*$/;

export const MAX_SEND_RECIPIENTS = 100;
export const MAX_SEND_ATTACHMENTS = 20;
export const MAX_SEND_SUBJECT_CHARS = 998;
export const MAX_SEND_BODY_TEXT_CHARS = 200_000;
export const MAX_SEND_BODY_HTML_CHARS = 500_000;
export const MAX_SEND_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_SEND_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_SEND_HEADER_CHARS = 2_000;
export const MAX_IDENTITY_DISPLAY_NAME_CHARS = 180;
export const MAX_IDENTITY_SIGNATURE_CHARS = 20_000;
export const MAX_IDENTITY_REPLY_TO_CHARS = 998;
export const MAX_OAUTH_CODE_CHARS = 8_192;
export const MAX_OAUTH_STATE_CHARS = 200;
export const MAX_OAUTH_CLIENT_ID_CHARS = 512;
export const MAX_OAUTH_CLIENT_SECRET_CHARS = 2_048;
export const MAX_PUSH_ENDPOINT_CHARS = 2_048;
export const MAX_PUSH_KEY_CHARS = 512;
export const MAX_PUSH_USER_AGENT_CHARS = 1_024;
export const MAX_MAILBOX_PATH_CHARS = 512;
export const MAX_WATCH_MAILBOXES = 32;
export const MAX_MESSAGES_PAGE_LIMIT = 200;
export const MAX_MESSAGES_OFFSET = 10_000;
export const MAX_MESSAGES_SEARCH_QUERY_CHARS = 2_000;
export const MAX_SEND_ONLY_SEARCH_CHARS = 512;
export const MAX_SEARCH_SUGGESTION_QUERY_CHARS = 120;
export const MAX_SAVED_SEARCH_NAME_CHARS = 120;
export const MAX_SAVED_SEARCH_QUERY_CHARS = 2_000;
export const MAX_LABEL_MUTATION_ITEMS = 100;
export const MAX_EVENTS_LIMIT = 500;
export const MAX_SYNC_EVENT_ID = Number.MAX_SAFE_INTEGER;
export const MAX_ACTIVE_EVENT_STREAMS_PER_USER = 3;
export const EVENT_STREAM_ERROR_BACKOFF_MS = 500;
export const MAX_WATCH_MAILBOX_SANITIZE_SCAN_ITEMS = MAX_WATCH_MAILBOXES * 8;
export const EMAIL_ADDRESS_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAILBOX_CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;
export const SAFE_ATTACHMENT_SCAN_STATUSES = new Set(['clean', 'disabled', 'size_skipped']);

export const insecureMailTransportAllowed =
  env.allowInsecureMailTransport || env.nodeEnv === 'development' || env.nodeEnv === 'test';

export const parseOptionalPort = (value: unknown, fieldName: string): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${fieldName} must be an integer between 1 and 65535`);
  }
  return parsed;
};

export const normalizeTlsMode = (value: unknown, fieldName: string): 'ssl' | 'starttls' | 'none' | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['ssl', 'tls', 'implicit', 'implicit_tls', 'imaps', 'smtps'].includes(normalized)) {
    return 'ssl';
  }
  if (['starttls', 'start_tls', 'explicit', 'explicit_tls'].includes(normalized)) {
    return 'starttls';
  }
  if (['none', 'plain', 'insecure', 'cleartext'].includes(normalized)) {
    return 'none';
  }
  if (MAIL_TLS_MODE_VALUES.has(normalized)) {
    return normalized as 'ssl' | 'starttls' | 'none';
  }
  throw new Error(`${fieldName} must be one of: ssl, starttls, none`);
};

export const estimateBase64PayloadBytes = (value: string): number | null => {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized) {
    return 0;
  }
  if (normalized.length % 4 !== 0) {
    return null;
  }
  if (!BASE64_BODY_PATTERN.test(normalized)) {
    return null;
  }
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return ((normalized.length / 4) * 3) - padding;
};

export const normalizeIdentityDisplayName = (value: unknown): string => {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!normalized) {
    throw new Error('displayName is required');
  }
  if (!HEADER_VALUE_PATTERN.test(normalized) || normalized.length > MAX_IDENTITY_DISPLAY_NAME_CHARS) {
    throw new Error(`displayName is invalid (max ${MAX_IDENTITY_DISPLAY_NAME_CHARS} chars, no line breaks)`);
  }
  return normalized;
};

export const normalizeSingleEmailAddress = (value: unknown, fieldName: string): string => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  if (!EMAIL_ADDRESS_PATTERN.test(normalized)) {
    throw new Error(`${fieldName} must be a valid email address`);
  }
  return normalized;
};

export const normalizeOptionalReplyTo = (value: unknown): string | null => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  const normalized = String(value).trim();
  if (!HEADER_VALUE_PATTERN.test(normalized) || normalized.length > MAX_IDENTITY_REPLY_TO_CHARS) {
    throw new Error('replyTo is invalid');
  }
  const parsed = parseAddressList(normalized);
  if (!parsed || parsed.length === 0) {
    throw new Error('replyTo must include at least one valid email address');
  }
  return parsed.join(', ');
};

export const normalizeOptionalSignature = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value);
  if (normalized.length > MAX_IDENTITY_SIGNATURE_CHARS) {
    throw new Error(`signature exceeds ${MAX_IDENTITY_SIGNATURE_CHARS} characters`);
  }
  return normalized;
};

export const normalizeMailboxInput = (value: unknown, fieldName = 'mailbox'): string => {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  if (normalized.length > MAX_MAILBOX_PATH_CHARS) {
    throw new Error(`${fieldName} exceeds ${MAX_MAILBOX_PATH_CHARS} characters`);
  }
  if (MAILBOX_CONTROL_CHAR_PATTERN.test(normalized)) {
    throw new Error(`${fieldName} contains invalid control characters`);
  }
  return normalized;
};

export const normalizePersistedWatchMailboxes = (
  value: unknown,
  options: {
    isGmailLike: boolean;
    fallbackMailbox: string;
    includeFallbackWhenEmpty?: boolean;
  },
): string[] => {
  const entries = Array.isArray(value) ? value : [];
  const normalized: string[] = [];
  const dedupe = new Set<string>();
  const scanLimit = Math.min(entries.length, MAX_WATCH_MAILBOX_SANITIZE_SCAN_ITEMS);
  for (let index = 0; index < scanLimit && normalized.length < MAX_WATCH_MAILBOXES; index += 1) {
    const entry = String(entries[index] ?? '').trim();
    if (!entry) {
      continue;
    }
    let mailbox: string;
    try {
      mailbox = normalizeMailboxInput(entry, 'syncSettings.watchMailboxes[]');
    } catch {
      continue;
    }
    const canonicalMailbox = options.isGmailLike
      ? normalizeGmailMailboxPath(mailbox)
      : mailbox;
    if (dedupe.has(canonicalMailbox)) {
      continue;
    }
    dedupe.add(canonicalMailbox);
    normalized.push(canonicalMailbox);
  }

  if (normalized.length > 0) {
    return normalized;
  }
  if (options.includeFallbackWhenEmpty === false) {
    return [];
  }
  return [options.fallbackMailbox];
};

export const getAttachmentScanBlock = (
  scanStatus: unknown,
): { statusCode: number; error: string } | null => {
  const normalizedStatus = String(scanStatus ?? '').trim().toLowerCase();
  if (SAFE_ATTACHMENT_SCAN_STATUSES.has(normalizedStatus)) {
    return null;
  }
  if (normalizedStatus === 'infected') {
    return { statusCode: 403, error: 'attachment blocked: malware detected' };
  }
  if (normalizedStatus === 'pending' || normalizedStatus === 'processing') {
    return { statusCode: 409, error: 'attachment blocked: malware scan in progress' };
  }
  if (normalizedStatus === 'failed' || normalizedStatus === 'missing' || normalizedStatus === 'error') {
    return { statusCode: 409, error: 'attachment blocked: malware scan failed' };
  }
  return { statusCode: 409, error: 'attachment blocked: unknown scan status' };
};

export const isPlainObject = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type IncomingOAuthConnectorDraft = {
  name: string;
  provider: string;
  emailAddress: string;
  host?: string;
  port?: number;
  tls?: boolean;
  authType: 'oauth2';
  authConfig: Record<string, any>;
  syncSettings?: Record<string, any>;
};

export type OutgoingOAuthConnectorDraft = {
  name: string;
  provider: 'gmail';
  fromAddress: string;
  host?: string;
  port?: number;
  tlsMode: 'ssl' | 'starttls' | 'none';
  authType: 'oauth2';
  authConfig: Record<string, any>;
  fromEnvelopeDefaults?: Record<string, any>;
  sentCopyBehavior?: Record<string, any>;
};

export const buildIncomingOAuthConnectorDraft = async (
  userId: string,
  rawDraft: unknown,
  oauthClientId?: string,
  oauthClientSecret?: string,
): Promise<{ existingConnectorId?: string; draft?: IncomingOAuthConnectorDraft }> => {
  if (!isPlainObject(rawDraft)) {
    throw new Error('connector draft is required');
  }
  if (!rawDraft.name || !rawDraft.provider || !rawDraft.emailAddress) {
    throw new Error('name, provider, emailAddress required');
  }

  const provider = String(rawDraft.provider ?? '').trim().toLowerCase();
  const authType = String(rawDraft.authType ?? 'oauth2').trim().toLowerCase();
  if (authType !== 'oauth2') {
    throw new Error('oauth2 authType is required for Gmail OAuth flow');
  }
  const emailAddress = normalizeSingleEmailAddress(rawDraft.emailAddress, 'emailAddress');

  if (rawDraft.syncSettings !== undefined && !isPlainObject(rawDraft.syncSettings)) {
    throw new Error('syncSettings must be an object');
  }
  if (rawDraft.authConfig !== undefined && !isPlainObject(rawDraft.authConfig)) {
    throw new Error('authConfig must be an object');
  }

  const parsedPort = parseOptionalPort(rawDraft.port, 'incoming connector port');
  const normalizedImapTlsMode = normalizeTlsMode(
    rawDraft?.syncSettings?.imapTlsMode ?? rawDraft?.syncSettings?.tlsMode,
    'syncSettings.imapTlsMode',
  );
  if ((rawDraft.tls === false || normalizedImapTlsMode === 'none') && !insecureMailTransportAllowed) {
    throw new Error('unencrypted IMAP is disabled on this server');
  }
  if (rawDraft.host !== undefined && rawDraft.host !== null && String(rawDraft.host).trim()) {
    await assertSafeOutboundHost(String(rawDraft.host), { context: 'incoming connector host' });
  }

  const requestedSyncSettings = {
    ...(rawDraft?.syncSettings ?? {}),
    ...(normalizedImapTlsMode ? { imapTlsMode: normalizedImapTlsMode } : {}),
  };
  const defaultWatchMailbox = isGmailLikeConnector({
    provider,
    sync_settings: requestedSyncSettings,
    syncSettings: requestedSyncSettings,
  })
    ? normalizeGmailMailboxPath(normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX'))
    : normalizeMailboxInput(env.sync.defaultMailbox, 'DEFAULT_MAILBOX');
  let watchMailboxes = parseTrimmedStringArrayWithCap(
    requestedSyncSettings?.watchMailboxes,
    'syncSettings.watchMailboxes',
    MAX_WATCH_MAILBOXES,
  );
  if (watchMailboxes.length === 0) {
    watchMailboxes = [defaultWatchMailbox];
  } else {
    watchMailboxes = watchMailboxes.map((mailbox) => normalizeMailboxInput(mailbox, 'syncSettings.watchMailboxes[]'));
  }

  const syncSettings = {
    ...requestedSyncSettings,
    watchMailboxes: Array.from(new Set(
      watchMailboxes.map((mailbox: string) => isGmailLikeConnector({
        provider,
        sync_settings: requestedSyncSettings,
        syncSettings: requestedSyncSettings,
      })
        ? normalizeGmailMailboxPath(mailbox)
        : mailbox),
    )),
  };
  const supportsOauthIncoming = isGmailAuthConnector({
    provider,
    sync_settings: syncSettings,
    syncSettings: syncSettings,
  });
  if (!supportsOauthIncoming) {
    throw new Error('oauth2 incoming auth is only supported for Gmail connectors');
  }

  const expectedGmailMode = String(Boolean(syncSettings?.gmailImap));
  const existing = await query<{ id: string }>(
    `SELECT id
       FROM incoming_connectors
      WHERE user_id = $1
        AND provider = $2
        AND email_address = $3
        AND COALESCE(auth_config->>'authType', 'password') = 'oauth2'
        AND COALESCE(sync_settings->>'gmailImap', 'false') = $4
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, provider, emailAddress, expectedGmailMode],
  );
  if (existing.rows.length > 0) {
    return { existingConnectorId: existing.rows[0].id };
  }

  return {
    draft: {
      name: String(rawDraft.name),
      provider,
      emailAddress,
      host: rawDraft.host !== undefined ? String(rawDraft.host) : undefined,
      port: parsedPort,
      tls: rawDraft.tls ?? true,
      authType: 'oauth2',
      authConfig: {
        authType: 'oauth2',
        ...(oauthClientId ? { oauthClientId } : {}),
        ...(oauthClientSecret ? { oauthClientSecret } : {}),
      },
      syncSettings,
    },
  };
};

export const buildOutgoingOAuthConnectorDraft = async (
  userId: string,
  rawDraft: unknown,
  oauthClientId?: string,
  oauthClientSecret?: string,
): Promise<{ existingConnectorId?: string; draft?: OutgoingOAuthConnectorDraft }> => {
  if (!isPlainObject(rawDraft)) {
    throw new Error('connector draft is required');
  }
  if (!rawDraft.name || !rawDraft.provider || !rawDraft.fromAddress) {
    throw new Error('name, provider, fromAddress required');
  }

  const provider = String(rawDraft.provider ?? '').trim().toLowerCase();
  if (provider !== 'gmail') {
    throw new Error('oauth2 outgoing auth is only supported for provider=gmail');
  }
  const authType = String(rawDraft.authType ?? 'oauth2').trim().toLowerCase();
  if (authType !== 'oauth2') {
    throw new Error('oauth2 authType is required for Gmail OAuth flow');
  }
  const fromAddress = normalizeSingleEmailAddress(rawDraft.fromAddress, 'fromAddress');
  if (rawDraft.authConfig !== undefined && !isPlainObject(rawDraft.authConfig)) {
    throw new Error('authConfig must be an object');
  }

  const parsedPort = parseOptionalPort(rawDraft.port, 'outgoing connector port');
  const tlsMode = normalizeTlsMode(rawDraft.tlsMode, 'tlsMode') ?? 'starttls';
  if (tlsMode === 'none' && !insecureMailTransportAllowed) {
    throw new Error('unencrypted SMTP is disabled on this server');
  }
  if (rawDraft.host !== undefined && rawDraft.host !== null && String(rawDraft.host).trim()) {
    await assertSafeOutboundHost(String(rawDraft.host), { context: 'outgoing connector host' });
  }

  const existing = await query<{ id: string }>(
    `SELECT id
       FROM outgoing_connectors
      WHERE user_id = $1
        AND provider = 'gmail'
        AND from_address = $2
        AND COALESCE(auth_config->>'authType', 'password') = 'oauth2'
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, fromAddress],
  );
  if (existing.rows.length > 0) {
    return { existingConnectorId: existing.rows[0].id };
  }

  return {
    draft: {
      name: String(rawDraft.name),
      provider: 'gmail',
      fromAddress,
      host: rawDraft.host !== undefined ? String(rawDraft.host) : undefined,
      port: parsedPort,
      tlsMode,
      authType: 'oauth2',
      authConfig: {
        authType: 'oauth2',
        ...(oauthClientId ? { oauthClientId } : {}),
        ...(oauthClientSecret ? { oauthClientSecret } : {}),
      },
      fromEnvelopeDefaults: isPlainObject(rawDraft.fromEnvelopeDefaults) ? rawDraft.fromEnvelopeDefaults : {},
      sentCopyBehavior: isPlainObject(rawDraft.sentCopyBehavior) ? rawDraft.sentCopyBehavior : {},
    },
  };
};

export const toPublicAuthConfig = (authConfig: unknown) => {
  const source = (authConfig && typeof authConfig === 'object')
    ? authConfig as Record<string, any>
    : {};
  const authType = String(source.authType ?? 'password').toLowerCase() === 'oauth2'
    ? 'oauth2'
    : 'password';

  if (authType === 'oauth2') {
    return {
      authType: 'oauth2',
      oauthClientId: source.oauthClientId ? String(source.oauthClientId) : undefined,
      tokenExpiresAt: source.tokenExpiresAt ? String(source.tokenExpiresAt) : undefined,
      hasAccessToken: Boolean(source.accessToken),
      hasRefreshToken: Boolean(source.refreshToken),
      hasClientSecret: Boolean(source.oauthClientSecret),
    };
  }

  return {
    authType: 'password',
    username: source.username ? String(source.username) : undefined,
    hasPassword: Boolean(source.password),
  };
};

export const sanitizeConnectorForResponse = (connector: any) => {
  if (!connector || typeof connector !== 'object') {
    return connector;
  }
  const authConfig = toPublicAuthConfig(connector.authConfig ?? connector.auth_config);
  const sanitized = {
    ...connector,
    authConfig,
  } as Record<string, any>;
  delete sanitized.auth_config;
  return sanitized;
};

export const isArchiveMoveTarget = (value: unknown) => {
  if (value === undefined || value === null) {
    return false;
  }
  const normalized = normalizeGmailMailboxPath(String(value));
  return normalized === 'ALL' || normalized === 'ARCHIVE';
};

export const sanitizeDispositionFilename = (value: unknown, fallback: string): string => {
  const normalized = String(value ?? '')
    .replace(/[\r\n";\\]/g, '_')
    .replace(/[^\x20-\x7E]/g, '_')
    .trim();
  const filename = normalized.length > 0 ? normalized : fallback;
  return filename.slice(0, 180);
};

export const GOOGLE_IDENTITY_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const pubSubTokenVerifier = new OAuth2Client();

export const getGmailPushAudience = () =>
  env.gmailPush.webhookAudience || `${env.appBaseUrl}${env.gmailPush.webhookPath}`;

export const extractBearerToken = (authorizationHeader: string | string[] | undefined): string | null => {
  const raw = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  if (!raw) {
    return null;
  }
  const normalized = String(raw).trim();
  if (!normalized.toLowerCase().startsWith('bearer ')) {
    return null;
  }
  const token = normalized.slice(7).trim();
  return token.length > 0 ? token : null;
};

export const verifyPubSubPushToken = async (
  authorizationHeader: string | string[] | undefined,
  additionalAudiences: string[] = [],
) => {
  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    throw new Error('missing pubsub bearer token');
  }

  const audience = Array.from(new Set([getGmailPushAudience(), ...additionalAudiences].filter(Boolean)));
  const ticket = await pubSubTokenVerifier.verifyIdToken({
    idToken: token,
    audience,
  });
  const payload = ticket.getPayload();
  if (!payload) {
    throw new Error('invalid pubsub oidc payload');
  }
  if (!payload.iss || !GOOGLE_IDENTITY_ISSUERS.has(payload.iss)) {
    throw new Error('invalid pubsub oidc issuer');
  }
  if (payload.email_verified !== true) {
    throw new Error('pubsub oidc email is not verified');
  }
  if (payload.aud && !audience.includes(String(payload.aud))) {
    throw new Error('invalid pubsub oidc audience');
  }
  if (
    env.gmailPush.pushServiceAccountEmail
    && payload.email !== env.gmailPush.pushServiceAccountEmail
  ) {
    throw new Error('unexpected pubsub service account');
  }
  return payload;
};

export const decodePubSubPushBody = (body: any): { emailAddress: string; historyId?: string | null } | null => {
  const encoded = body?.message?.data;
  if (!encoded || typeof encoded !== 'string') {
    return null;
  }
  if (encoded.length > 32_768) {
    return null;
  }
  const normalized = encoded.replace(/\s+/g, '');
  if (normalized.length % 4 !== 0 || !BASE64_BODY_PATTERN.test(normalized)) {
    return null;
  }

  const decoded = Buffer.from(normalized, 'base64').toString('utf8');
  if (!decoded || decoded.length > 32_768) {
    return null;
  }

  const payload = JSON.parse(decoded) as { emailAddress?: string; historyId?: string | number };
  const emailAddress = String(payload.emailAddress ?? '').trim().toLowerCase();
  if (!emailAddress || !EMAIL_ADDRESS_PATTERN.test(emailAddress)) {
    return null;
  }

  return {
    emailAddress,
    historyId: payload.historyId !== undefined && payload.historyId !== null
      ? String(payload.historyId)
      : null,
  };
};

export const buildGmailWatchLabelIds = (watchMailboxes: string[]) => {
  const ids = Array.from(new Set(
    watchMailboxes
      .map((mailbox) => normalizeGmailMailboxPath(mailbox))
      .filter((labelId) => labelId !== 'ALL'),
  ));
  return ids.length > 0 ? ids : ['INBOX'];
};

export const GMAIL_DEFAULT_SYNC_TARGETS = ['INBOX', 'SENT', 'DRAFT', 'STARRED', 'TRASH', 'SPAM'] as const;

export const buildInitialSyncTargets = (
  connector: { provider?: unknown; sync_settings?: Record<string, any> | null; syncSettings?: Record<string, any> | null } | null,
  discoveredMailboxes: string[],
  fallbackMailbox: string,
) => {
  const normalizedDiscovered = Array.from(new Set(
    (discoveredMailboxes ?? [])
      .map((mailbox) => String(mailbox ?? '').trim())
      .filter(Boolean),
  ));

  if (!isGmailLikeConnector(connector ?? {})) {
    return normalizedDiscovered.length > 0 ? normalizedDiscovered : [fallbackMailbox];
  }

  const merged = new Set<string>();
  for (const mailbox of normalizedDiscovered) {
    merged.add(normalizeGmailMailboxPath(mailbox));
  }
  for (const mailbox of GMAIL_DEFAULT_SYNC_TARGETS) {
    merged.add(normalizeGmailMailboxPath(mailbox));
  }
  if (merged.size === 0) {
    merged.add(normalizeGmailMailboxPath(fallbackMailbox));
  }

  return Array.from(merged);
};
