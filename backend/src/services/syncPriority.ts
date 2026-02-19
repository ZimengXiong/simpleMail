import type { SyncQueuePriority } from './queue.js';

type ActiveMailboxState = {
  userId: string;
  connectorId: string;
  mailbox: string;
  updatedAtMs: number;
};

const ACTIVE_MAILBOX_TTL_MS = 90_000;
const activeMailboxByUser = new Map<string, ActiveMailboxState>();

const normalizeMailbox = (mailbox: string) => String(mailbox || '').trim().toUpperCase();

const pruneStaleActiveMailboxes = (nowMs: number) => {
  for (const [userId, state] of activeMailboxByUser) {
    if ((nowMs - state.updatedAtMs) > ACTIVE_MAILBOX_TTL_MS) {
      activeMailboxByUser.delete(userId);
    }
  }
};

export const markActiveMailbox = (userId: string, connectorId: string, mailbox: string) => {
  const nowMs = Date.now();
  pruneStaleActiveMailboxes(nowMs);
  activeMailboxByUser.set(userId, {
    userId,
    connectorId,
    mailbox: normalizeMailbox(mailbox),
    updatedAtMs: nowMs,
  });
};

export const resolveSyncQueuePriority = (
  userId: string,
  connectorId: string,
  mailbox: string,
): SyncQueuePriority => {
  const nowMs = Date.now();
  pruneStaleActiveMailboxes(nowMs);
  const active = activeMailboxByUser.get(userId);
  if (!active) {
    return 'normal';
  }
  const normalizedMailbox = normalizeMailbox(mailbox);
  if (active.connectorId === connectorId && active.mailbox === normalizedMailbox) {
    return 'high';
  }
  return 'normal';
};

