import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';

const CURSOR_STORAGE_KEY = 'BETTERMAIL_SYNC_EVENT_CURSOR';

const resolveToken = () => {
  const envToken = (import.meta.env.VITE_BETTERMAIL_USER_TOKEN as string | undefined)?.trim();
  return localStorage.getItem('BETTERMAIL_USER_TOKEN') ?? envToken ?? null;
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
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) {
    return { id, payload: null as any };
  }
  const data = dataLines.join('\n');
  try {
    return { id, payload: JSON.parse(data) as any };
  } catch {
    return { id, payload: null as any };
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

    const scheduleInvalidation = () => {
      if (invalidateTimer !== null) {
        return;
      }
      invalidateTimer = window.setTimeout(() => {
        invalidateTimer = null;
        queryClient.invalidateQueries({ queryKey: ['syncStates'] });
        queryClient.invalidateQueries({ queryKey: ['messages'] });
        queryClient.invalidateQueries({ queryKey: ['thread'] });
        queryClient.invalidateQueries({ queryKey: ['events'] });
      }, 250);
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

              const { id, payload } = parseSseFrame(frame);
              if (id !== null && id > since) {
                since = id;
                saveCursor(since);
              }
              if (payload) {
                scheduleInvalidation();
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

