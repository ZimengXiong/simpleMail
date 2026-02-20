import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { gmailApiRequest } from './gmailApi.js';
import {
  normalizeGmailMailboxPath,
  startIncomingConnectorIdleWatch,
  stopIncomingConnectorIdleWatch,
} from './imap.js';
import { emitSyncEvent } from './imapEvents.js';

const RENEW_LEAD_MS = 24 * 60 * 60 * 1000;
const MAX_WATCH_MAILBOXES = 32;
const MAX_MAILBOX_PATH_CHARS = 512;
const MAX_WATCH_MAILBOX_SANITIZE_SCAN_ITEMS = MAX_WATCH_MAILBOXES * 8;
const MAILBOX_CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;

const getGmailPushAudience = () =>
  env.gmailPush.webhookAudience || `${env.appBaseUrl}${env.gmailPush.webhookPath}`;

const parseExpirationMs = (value: unknown) => {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeMailboxCandidate = (value: unknown): string | null => {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > MAX_MAILBOX_PATH_CHARS) {
    return null;
  }
  if (MAILBOX_CONTROL_CHAR_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
};

const getConfiguredWatchMailboxes = (syncSettings: Record<string, any>) => {
  const fallbackMailbox = normalizeGmailMailboxPath(
    normalizeMailboxCandidate(env.sync.defaultMailbox) ?? 'INBOX',
  );
  const entries = Array.isArray(syncSettings.watchMailboxes)
    ? syncSettings.watchMailboxes
    : [];
  const configured: string[] = [];
  const dedupe = new Set<string>();
  const scanLimit = Math.min(entries.length, MAX_WATCH_MAILBOX_SANITIZE_SCAN_ITEMS);
  for (let index = 0; index < scanLimit && configured.length < MAX_WATCH_MAILBOXES; index += 1) {
    const mailbox = normalizeMailboxCandidate(entries[index]);
    if (!mailbox) {
      continue;
    }
    const normalized = normalizeGmailMailboxPath(mailbox);
    if (dedupe.has(normalized)) {
      continue;
    }
    dedupe.add(normalized);
    configured.push(normalized);
  }
  return configured.length > 0 ? configured : [fallbackMailbox];
};

const shouldRenewConnector = (syncSettings: Record<string, any>) => {
  const gmailPush = syncSettings.gmailPush ?? {};
  if (gmailPush.enabled === false) {
    return false;
  }
  const expirationMs = parseExpirationMs(gmailPush.expiration);
  if (!expirationMs) {
    return true;
  }
  return (expirationMs - Date.now()) <= RENEW_LEAD_MS;
};

export const renewExpiringGmailPushWatches = async () => {
  if (!env.gmailPush.enabled || !env.gmailPush.topicName) {
    return { renewed: 0, failed: 0, skipped: 0 };
  }

  const connectors = await query<{
    id: string;
    user_id: string;
    auth_config: Record<string, any> | null;
    sync_settings: Record<string, any> | null;
  }>(
    `SELECT id, user_id, auth_config, sync_settings
       FROM incoming_connectors
      WHERE provider = 'gmail'
        AND status = 'active'`,
  );

  let renewed = 0;
  let failed = 0;
  let skipped = 0;

  for (const connector of connectors.rows) {
    const syncSettings = connector.sync_settings ?? {};
    if (!shouldRenewConnector(syncSettings)) {
      skipped += 1;
      continue;
    }

    const watchMailboxes = getConfiguredWatchMailboxes(syncSettings);
    try {
      const watchLabelIds = watchMailboxes
        .map((mb) => normalizeGmailMailboxPath(mb))
        .filter((id) => id !== 'ALL');
      const watchResponse = await gmailApiRequest<{ historyId?: string | number; expiration?: string | number }>(
        'incoming',
        { id: connector.id, auth_config: connector.auth_config ?? {} },
        '/watch',
        {
          method: 'POST',
          body: JSON.stringify({
            topicName: env.gmailPush.topicName,
            labelIds: watchLabelIds.length > 0 ? watchLabelIds : ['INBOX'],
            labelFilterAction: 'include',
          }),
        },
      );

      const nextSyncSettings = {
        ...syncSettings,
        watchMailboxes,
        gmailPush: {
          ...(syncSettings.gmailPush ?? {}),
          enabled: true,
          status: 'watching',
          topicName: env.gmailPush.topicName,
          webhookAudience: getGmailPushAudience(),
          historyId: watchResponse.historyId ? String(watchResponse.historyId) : null,
          expiration: watchResponse.expiration
            ? new Date(Number(watchResponse.expiration)).toISOString()
            : null,
          lastError: null,
          updatedAt: new Date().toISOString(),
        },
      };

      await query(
        `UPDATE incoming_connectors
            SET sync_settings = $3::jsonb,
                updated_at = NOW()
          WHERE id = $1
            AND user_id = $2`,
        [connector.id, connector.user_id, JSON.stringify(nextSyncSettings)],
      );

      for (const mailbox of watchMailboxes) {
        await stopIncomingConnectorIdleWatch(connector.user_id, connector.id, mailbox).catch(() => undefined);
      }

      renewed += 1;
      await emitSyncEvent(connector.id, 'sync_info', {
        mailbox: 'INBOX',
        phase: 'gmail-push-watch-renewed',
        expiration: nextSyncSettings.gmailPush.expiration,
      }).catch(() => undefined);
    } catch (error) {
      failed += 1;

      const nextSyncSettings = {
        ...syncSettings,
        watchMailboxes,
        gmailPush: {
          ...(syncSettings.gmailPush ?? {}),
          enabled: true,
          status: 'error',
          lastError: String(error),
          updatedAt: new Date().toISOString(),
        },
      };

      await query(
        `UPDATE incoming_connectors
            SET sync_settings = $3::jsonb,
                updated_at = NOW()
          WHERE id = $1
            AND user_id = $2`,
        [connector.id, connector.user_id, JSON.stringify(nextSyncSettings)],
      ).catch(() => undefined);

      await emitSyncEvent(connector.id, 'sync_error', {
        mailbox: 'INBOX',
        phase: 'gmail-push-watch-renew-failed',
        error: String(error),
      }).catch(() => undefined);

      const fallbackMailbox = watchMailboxes[0]
        ?? normalizeGmailMailboxPath(normalizeMailboxCandidate(env.sync.defaultMailbox) ?? 'INBOX');
      try {
        await startIncomingConnectorIdleWatch(connector.user_id, connector.id, fallbackMailbox);
        await emitSyncEvent(connector.id, 'sync_info', {
          mailbox: fallbackMailbox,
          phase: 'gmail-push-fallback-watch-started',
        }).catch(() => undefined);
      } catch (fallbackError) {
        await emitSyncEvent(connector.id, 'sync_error', {
          mailbox: fallbackMailbox,
          phase: 'gmail-push-fallback-watch-failed',
          error: String(fallbackError),
        }).catch(() => undefined);
      }
    }
  }

  return { renewed, failed, skipped };
};
