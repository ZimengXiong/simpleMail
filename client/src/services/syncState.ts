import type { MailboxSyncState } from '../types/index';

const ACTIVE_STATE_STALE_MS = 2 * 60 * 1000;

const toTimestamp = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
};

export const isSyncStateActive = (
  state: Pick<MailboxSyncState, 'status' | 'syncStartedAt'> | null | undefined,
  now = Date.now(),
): boolean => {
  if (!state) {
    return false;
  }

  if (state.status === 'syncing') {
    return true;
  }

  if (state.status !== 'queued' && state.status !== 'cancel_requested') {
    return false;
  }

  const startedAt = toTimestamp(state.syncStartedAt);
  if (!startedAt) {
    return false;
  }

  const ageMs = now - startedAt;
  return ageMs >= 0 && ageMs <= ACTIVE_STATE_STALE_MS;
};

export const countActiveSyncStates = (
  states: Array<Pick<MailboxSyncState, 'status' | 'syncStartedAt'>> = [],
): number => {
  const now = Date.now();
  return states.reduce((total, state) => total + (isSyncStateActive(state, now) ? 1 : 0), 0);
};

export const hasActiveSyncStates = (
  states: Array<Pick<MailboxSyncState, 'status' | 'syncStartedAt'>> = [],
): boolean => countActiveSyncStates(states) > 0;

