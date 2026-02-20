import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, getAuthToken } from '../services/api';
import { readStorageNumber, writeStorageString } from '../services/storage';

const CURSOR_STORAGE_KEY = 'SIMPLEMAIL_SYNC_EVENT_CURSOR';

const parseCursor = () => {
  const parsed = readStorageNumber(CURSOR_STORAGE_KEY);
  return parsed === null ? 0 : Math.max(0, Math.floor(parsed));
};

const saveCursor = (cursor: number) => {
  writeStorageString(CURSOR_STORAGE_KEY, String(cursor));
};

type SyncEventPayload = {
  incomingConnectorId?: string;
  eventType?: string;
};

const parseSseFrame = (frame: string) => {
  const lines = frame.split(/\r?\n/);
  let id: number | null = null;
  let eventName: string | null = null;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('id:')) {
      const maybe = Number(line.slice(3).trim());
      if (Number.isFinite(maybe) && maybe >= 0) {
        id = Math.floor(maybe);
      }
      continue;
    }
    if (line.startsWith('event:')) {
      const rawEvent = line.slice(6).trim();
      eventName = rawEvent.length > 0 ? rawEvent : null;
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) {
    return { id, eventName, payload: null as unknown };
  }
  const data = dataLines.join('\n');
  try {
    return { id, eventName, payload: JSON.parse(data) as unknown };
  } catch {
    return { id, eventName, payload: null as unknown };
  }
};

const SyncEventBridge = () => {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!api.auth.isAuthenticated()) {
      return;
    }

    let disposed = false;
    let reconnectDelayMs = 1000;
    let since = parseCursor();
    let abortController: AbortController | null = null;
    let invalidateTimer: number | null = null;
    const pendingConnectorIds = new Set<string>();
    let shouldInvalidateMessages = false;
    let shouldInvalidateThreads = false;
    let shouldInvalidateSyncStates = false;
    let shouldInvalidateEvents = false;

    const scheduleInvalidation = () => {
      if (invalidateTimer !== null) {
        return;
      }
      invalidateTimer = window.setTimeout(() => {
        const connectorIds = Array.from(pendingConnectorIds);
        pendingConnectorIds.clear();
        const connectorSet = new Set(connectorIds);
        const hasConnectorScope = connectorSet.size > 0;
        const shouldRefreshMessages = shouldInvalidateMessages;
        const shouldRefreshThreads = shouldInvalidateThreads;
        const shouldRefreshSyncStates = shouldInvalidateSyncStates;
        const shouldRefreshEvents = shouldInvalidateEvents;

        shouldInvalidateMessages = false;
        shouldInvalidateThreads = false;
        shouldInvalidateSyncStates = false;
        shouldInvalidateEvents = false;
        invalidateTimer = null;

        if (shouldRefreshSyncStates) {
          if (hasConnectorScope) {
            for (const connectorId of connectorIds) {
              queryClient.invalidateQueries({ queryKey: ['syncStates', connectorId], refetchType: 'active' });
            }
          } else {
            queryClient.invalidateQueries({ queryKey: ['syncStates'], refetchType: 'active' });
          }
        }

        if (shouldRefreshMessages) {
          if (hasConnectorScope) {
            queryClient.invalidateQueries({
              predicate: (query) => {
                if (!Array.isArray(query.queryKey) || query.queryKey[0] !== 'messages') {
                  return false;
                }
                const scope = query.queryKey[1];
                if (typeof scope !== 'string') {
                  return true;
                }
                if (scope.startsWith('send-only:')) {
                  return false;
                }
                return connectorSet.has(scope);
              },
              refetchType: 'active',
            });
          } else {
            queryClient.invalidateQueries({ queryKey: ['messages'], refetchType: 'active' });
          }
        }

        if (shouldRefreshThreads) {
          if (hasConnectorScope) {
            queryClient.invalidateQueries({
              predicate: (query) => {
                if (!Array.isArray(query.queryKey) || query.queryKey[0] !== 'thread') {
                  return false;
                }
                const scope = query.queryKey[2];
                if (typeof scope !== 'string') {
                  return true;
                }
                if (scope === 'all') {
                  return true;
                }
                return connectorSet.has(scope);
              },
              refetchType: 'active',
            });
          } else {
            queryClient.invalidateQueries({ queryKey: ['thread'], refetchType: 'active' });
          }
        }

        if (shouldRefreshEvents) {
          queryClient.invalidateQueries({ queryKey: ['events'], refetchType: 'active' });
        }
      }, 250);
    };

    const markDirtyFromSyncEvent = (payload: unknown) => {
      const eventPayload = payload as SyncEventPayload | null;
      const connectorId = typeof eventPayload?.incomingConnectorId === 'string'
        ? eventPayload.incomingConnectorId.trim()
        : '';
      const eventType = typeof eventPayload?.eventType === 'string'
        ? eventPayload.eventType.trim().toLowerCase()
        : '';

      if (connectorId) {
        pendingConnectorIds.add(connectorId);
      }

      shouldInvalidateSyncStates = true;
      shouldInvalidateEvents = true;

      if (
        eventType.startsWith('message_')
        || eventType === 'rule_triggered'
        || eventType === 'sync_completed'
        || eventType === 'sync_cancelled'
      ) {
        shouldInvalidateMessages = true;
      }

      if (eventType.startsWith('message_') || eventType === 'rule_triggered') {
        shouldInvalidateThreads = true;
      }

      scheduleInvalidation();
    };

    const consumeStream = async () => {
      while (!disposed) {
        const token = getAuthToken();
        if (!token) {
          await new Promise((resolve) => window.setTimeout(resolve, reconnectDelayMs));
          reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10_000);
          continue;
        }

        abortController = new AbortController();
        try {
          const response = await fetch(`/api/events/stream?since=${since}`, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
            },
            signal: abortController.signal,
          });

          if (!response.ok || !response.body) {
            throw new Error(`events stream failed (${response.status})`);
          }

          reconnectDelayMs = 1000;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (!disposed) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            buffer = buffer.replace(/\r\n/g, '\n');

            let splitIndex = buffer.indexOf('\n\n');
            while (splitIndex >= 0) {
              const frame = buffer.slice(0, splitIndex);
              buffer = buffer.slice(splitIndex + 2);
              splitIndex = buffer.indexOf('\n\n');

              const { id, eventName, payload } = parseSseFrame(frame);
              if (id !== null && id > since) {
                since = id;
                saveCursor(since);
              }
              if (eventName !== 'sync') {
                continue;
              }
              if (payload && typeof payload === 'object') {
                markDirtyFromSyncEvent(payload);
              }
            }
          }
        } catch {
          return;
        }

        if (!disposed) {
          await new Promise((resolve) => window.setTimeout(resolve, reconnectDelayMs));
          reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10_000);
        }
      }
    };

    void consumeStream();

    return () => {
      disposed = true;
      if (invalidateTimer !== null) {
        window.clearTimeout(invalidateTimer);
      }
      abortController?.abort();
    };
  }, [queryClient]);

  return null;
};

export default SyncEventBridge;
