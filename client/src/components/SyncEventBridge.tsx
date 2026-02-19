import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';

const CURSOR_STORAGE_KEY = 'BETTERMAIL_SYNC_EVENT_CURSOR';
const TOKEN_STORAGE_KEY = 'BETTERMAIL_USER_TOKEN';

const resolveToken = () => {
  const envToken = (import.meta.env.VITE_BETTERMAIL_USER_TOKEN as string | undefined)?.trim();
  try {
    const sessionToken = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (sessionToken) {
      return sessionToken;
    }
    const legacyToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (legacyToken) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, legacyToken);
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      return legacyToken;
    }
  } catch {
    // ignore storage failures and fall through to env token
  }
  return envToken ?? null;
};

const parseCursor = () => {
  const raw = localStorage.getItem(CURSOR_STORAGE_KEY);
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
};

const saveCursor = (cursor: number) => {
  localStorage.setItem(CURSOR_STORAGE_KEY, String(cursor));
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
    return { id, eventName, payload: null as any };
  }
  const data = dataLines.join('\n');
  try {
    return { id, eventName, payload: JSON.parse(data) as any };
  } catch {
    return { id, eventName, payload: null as any };
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
          queryClient.invalidateQueries({ queryKey: ['thread'], refetchType: 'active' });
        }

        if (shouldRefreshEvents) {
          queryClient.invalidateQueries({ queryKey: ['events'], refetchType: 'active' });
        }
      }, 250);
    };

    const markDirtyFromSyncEvent = (payload: any) => {
      const connectorId = typeof payload?.incomingConnectorId === 'string'
        ? payload.incomingConnectorId.trim()
        : '';
      const eventType = typeof payload?.eventType === 'string'
        ? payload.eventType.trim().toLowerCase()
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
        const token = resolveToken();
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
          // ignore and retry
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
