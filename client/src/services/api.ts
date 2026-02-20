import type {
  IncomingConnectorRecord,
  OutgoingConnectorRecord,
  IdentityRecord,
  MessageRecord,
  MailboxInfo,
  AttachmentRecord,
  MailboxSyncState,
  ConnectorSyncStatesResponse,
} from '../types/index';
import { redirectToLogin } from './authRedirect';

const API_BASE = '/api';
let runtimeToken: string | null = null;
type JsonObject = Record<string, unknown>;

export const getAuthToken = () => runtimeToken;
const clearRuntimeAuth = () => {
  runtimeToken = null;
};

const parseDownloadFilename = (value: string | null) => {
  if (!value) return null;
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const plainMatch = value.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] ?? null;
};

const triggerBrowserDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

const openBlobInNewTab = (blob: Blob, fallbackFilename: string) => {
  const url = URL.createObjectURL(blob);
  const popup = window.open(url, '_blank', 'noopener,noreferrer');
  if (!popup) {
    triggerBrowserDownload(blob, fallbackFilename);
  }
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
};

const navigateToPath = (path: string) => {
  if (typeof window.location.assign === 'function') {
    window.location.assign(path);
    return;
  }
  (window.location as unknown as { href: string }).href = path;
};

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

const tryParseJson = (value: string): unknown | null => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const parseErrorMessage = async (response: Response): Promise<string> => {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const payload = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
    const errorMessage = typeof payload?.error === 'string'
      ? payload.error
      : (typeof payload?.message === 'string' ? payload.message : '');
    if (errorMessage) {
      return errorMessage;
    }
  }

  const text = (await response.text().catch(() => '')).trim();
  if (text) {
    return text;
  }
  return response.statusText || 'Request failed';
};

const parseSuccessResponse = async <T>(response: Response): Promise<T> => {
  if (response.status === 204 || response.status === 205 || response.status === 304) {
    return undefined as T;
  }

  const bodyText = await response.text();
  if (!bodyText) {
    return undefined as T;
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return JSON.parse(bodyText) as T;
  }

  const maybeJson = tryParseJson(bodyText);
  if (maybeJson !== null) {
    return maybeJson as T;
  }
  return bodyText as T;
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getAuthToken();
  
  const headers = new Headers(options?.headers);
  if (options?.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new Error('Network request failed');
  }

  if (response.status === 401) {
    clearRuntimeAuth();
    redirectToLogin();
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  return parseSuccessResponse<T>(response);
}

async function requestBlob(path: string, options?: RequestInit): Promise<{ blob: Blob; filename: string | null }> {
  const token = getAuthToken();
  const headers = new Headers(options?.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new Error('Network request failed');
  }

  if (response.status === 401) {
    clearRuntimeAuth();
    redirectToLogin();
    throw new Error('Unauthorized');
  }
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  return {
    blob: await response.blob(),
    filename: parseDownloadFilename(response.headers.get('Content-Disposition')),
  };
}

export const api = {
  auth: {
    login: (token: string) => {
      runtimeToken = String(token || '').trim() || null;
    },
    clear: () => {
      clearRuntimeAuth();
    },
    logout: () => {
      clearRuntimeAuth();
      navigateToPath('/login');
    },
    isAuthenticated: () => Boolean(getAuthToken()),
    session: () => request<{ id: string; email: string; name: string }>('/session'),
  },

  connectors: {
    getIncoming: (id: string) => request<IncomingConnectorRecord>(`/connectors/incoming/${id}`),
    listIncoming: () => request<IncomingConnectorRecord[]>('/connectors/incoming'),
    updateIncoming: (id: string, data: JsonObject) => request<IncomingConnectorRecord>(`/connectors/incoming/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    listOutgoing: () => request<OutgoingConnectorRecord[]>('/connectors/outgoing'),
    getOutgoing: (id: string) => request<OutgoingConnectorRecord>(`/connectors/outgoing/${id}`),
    createIncoming: (data: JsonObject) => request<IncomingConnectorRecord>('/connectors/incoming', { method: 'POST', body: JSON.stringify(data) }),
    createOutgoing: (data: JsonObject) => request<OutgoingConnectorRecord>('/connectors/outgoing', { method: 'POST', body: JSON.stringify(data) }),
    updateOutgoing: (id: string, data: JsonObject) => request<OutgoingConnectorRecord>(`/connectors/outgoing/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    deleteIncoming: (id: string) => request(`/connectors/incoming/${id}`, { method: 'DELETE' }),
    deleteOutgoing: (id: string) => request(`/connectors/outgoing/${id}`, { method: 'DELETE' }),
    testOutgoing: (id: string) => request<{ status: string; id: string }>(`/connectors/outgoing/${id}/test`, { method: 'POST' }),
    getMailboxes: (connectorId: string) => request<MailboxInfo[]>(`/connectors/${connectorId}/mailboxes`),
  },

  identities: {
    get: (id: string) => request<IdentityRecord>(`/identities/${id}`),
    list: () => request<IdentityRecord[]>('/identities'),
    create: (data: JsonObject) => request<IdentityRecord>('/identities', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: JsonObject) => request<IdentityRecord>(`/identities/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) => request(`/identities/${id}`, { method: 'DELETE' }),
  },

  rules: {
    list: () => request<JsonObject[]>('/rules'),
    create: (data: JsonObject) => request<JsonObject>('/rules', { method: 'POST', body: JSON.stringify(data) }),
    delete: (id: string) => request(`/rules/${id}`, { method: 'DELETE' }),
    runAll: () => request<{ status: string }>('/rules/run', { method: 'POST' }),
  },

  labels: {
    list: () => request<JsonObject[]>('/labels'),
    create: (name: string, key?: string) => request<JsonObject>('/labels', { method: 'POST', body: JSON.stringify({ name, key }) }),
    delete: (id: string) => request(`/labels/${id}`, { method: 'DELETE' }),
    addToMessage: (messageId: string, labelKeys: string[]) => 
      request(`/messages/${messageId}/labels`, { method: 'POST', body: JSON.stringify({ addLabelKeys: labelKeys }) }),
    removeFromMessage: (messageId: string, labelKeys: string[]) => 
      request(`/messages/${messageId}/labels`, { method: 'POST', body: JSON.stringify({ removeLabelKeys: labelKeys }) }),
  },

  savedSearches: {
    list: () => request<JsonObject[]>('/saved-searches'),
    create: (data: { name: string, queryText: string }) => request<JsonObject>('/saved-searches', { method: 'POST', body: JSON.stringify(data) }),
    delete: (id: string) => request(`/saved-searches/${id}`, { method: 'DELETE' }),
  },

  search: {
    quickFilters: () => request<JsonObject>('/search/quick-filters'),
    suggestions: (q: string) => request<JsonObject>(`/search/suggestions?q=${encodeURIComponent(q)}`),
  },

  messages: {
    list: (params?: { folder?: string; connectorId?: string; limit?: number; offset?: number; signal?: AbortSignal }) => {
      const query = new URLSearchParams();
      if (params?.folder) query.append('folder', params.folder);
      if (params?.connectorId) query.append('connectorId', params.connectorId);
      if (params?.limit) query.append('limit', String(params.limit));
      if (typeof params?.offset === 'number') query.append('offset', String(params.offset));
      return request<{ messages: MessageRecord[]; totalCount: number }>(`/messages?${query.toString()}`, {
        signal: params?.signal,
      });
    },
    listSendOnly: (params: { emailAddress: string; folder?: string; q?: string; limit?: number; offset?: number; signal?: AbortSignal }) => {
      const query = new URLSearchParams();
      query.append('emailAddress', params.emailAddress);
      if (params.folder) query.append('folder', params.folder);
      if (params.q) query.append('q', params.q);
      if (params.limit) query.append('limit', String(params.limit));
      if (typeof params.offset === 'number') query.append('offset', String(params.offset));
      return request<{ messages: MessageRecord[]; totalCount: number }>(`/messages/send-only?${query.toString()}`, {
        signal: params.signal,
      });
    },
    getThread: (threadId: string, connectorId?: string, signal?: AbortSignal) => {
      const query = connectorId
        ? `?connectorId=${encodeURIComponent(connectorId)}`
        : '';
      return request<MessageRecord[]>(`/messages/thread/${threadId}${query}`, { signal });
    },
    getLabels: (messageId: string) => request<JsonObject[]>(`/messages/${messageId}/labels`),
    update: (messageId: string, data: { isRead?: boolean, isStarred?: boolean, moveToFolder?: string, delete?: boolean, scope?: 'single' | 'thread' }) =>
      request<JsonObject>(`/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify(data) }),
    bulkUpdate: (messageIds: string[], data: { isRead?: boolean, isStarred?: boolean, moveToFolder?: string, delete?: boolean, scope?: 'single' | 'thread' }) =>
      request<{ results: { id: string; status: string }[] }>('/messages/bulk', {
        method: 'POST',
        body: JSON.stringify({ messageIds, ...data }),
      }),
    getRawUrl: (messageId: string) => `/api/messages/${messageId}/raw`,
    downloadRaw: async (messageId: string) => {
      const { blob, filename } = await requestBlob(`/messages/${messageId}/raw`);
      triggerBrowserDownload(blob, filename ?? `${messageId}.eml`);
    },
    viewRaw: async (messageId: string) => {
      const { blob, filename } = await requestBlob(`/messages/${messageId}/raw`);
      openBlobInNewTab(blob, filename ?? `${messageId}.eml`);
    },
    search: (params: { q: string; folder?: string; connectorId?: string; limit?: number; offset?: number; signal?: AbortSignal }) => {
      const { signal, ...payload } = params;
      return request<{ messages: MessageRecord[]; totalCount: number }>('/messages/search', { 
        method: 'POST', 
        signal,
        body: JSON.stringify(payload) 
      });
    },
    send: (data: JsonObject, idempotencyKey: string) => {
      return request<{ status: string; sendId: string }>('/messages/send', { 
        method: 'POST', 
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(data) 
      });
    },
    getAttachments: (messageId: string) => request<AttachmentRecord[]>(`/messages/${messageId}/attachments`),
    triggerScan: (messageId: string, attachmentId: string) => 
      request(`/attachments/scan`, { 
        method: 'POST', 
        body: JSON.stringify({ messageId, attachmentId }) 
      }),
  },

  oauth: {
    google: {
      authorize: (data: {
        type: 'incoming' | 'outgoing';
        connectorId?: string;
        connector?: JsonObject;
        oauthClientId?: string;
        oauthClientSecret?: string;
      }) =>
        request<{ authorizeUrl: string }>('/oauth/google/authorize', { method: 'POST', body: JSON.stringify(data) }),
    },
  },

  sync: {
    trigger: (connectorId: string, mailbox = 'INBOX', useQueue = false, syncAll = false) => 
      request(`/sync/${connectorId}`, { 
        method: 'POST', 
        body: JSON.stringify({ mailbox, useQueue, syncAll }) 
      }),
    cancel: (connectorId: string, mailbox = 'INBOX') =>
      request(`/sync/${connectorId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ mailbox }),
      }),
    watch: (connectorId: string, mailbox = 'INBOX') => 
      request(`/sync/${connectorId}/watch`, { method: 'POST', body: JSON.stringify({ mailbox }) }),
    stopWatch: (connectorId: string, mailbox = 'INBOX') => 
      request(`/sync/${connectorId}/watch/stop`, { method: 'POST', body: JSON.stringify({ mailbox }) }),
    setGmailPush: (connectorId: string, enabled: boolean) =>
      request(`/sync/${connectorId}/gmail-push`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }),
    setActiveMailbox: (connectorId: string, mailbox: string) =>
      request('/sync/active-mailbox', {
        method: 'POST',
        body: JSON.stringify({ connectorId, mailbox }),
      }),
    getState: (connectorId: string, mailbox = 'INBOX') => {
      const query = new URLSearchParams({ mailbox });
      return request<MailboxSyncState>(`/connectors/${connectorId}/sync-state?${query.toString()}`);
    },
    getStates: (connectorId: string, signal?: AbortSignal) =>
      request<ConnectorSyncStatesResponse>(`/connectors/${connectorId}/sync-states`, { signal }),
  },

  events: {
    list: (since = 0, limit = 50) => request<JsonObject[]>(`/events?since=${since}&limit=${limit}`),
  },

  attachments: {
    getPreviewBlob: async (attachmentId: string, signal?: AbortSignal) => {
      const { blob } = await requestBlob(`/attachments/${attachmentId}/view`, { signal });
      return blob;
    },
    download: async (attachmentId: string, fallbackFilename = 'attachment') => {
      const { blob, filename } = await requestBlob(`/attachments/${attachmentId}/download`);
      triggerBrowserDownload(blob, filename ?? fallbackFilename);
    },
    preview: async (attachmentId: string, fallbackFilename = 'attachment') => {
      const { blob, filename } = await requestBlob(`/attachments/${attachmentId}/view`);
      openBlobInNewTab(blob, filename ?? fallbackFilename);
    },
  }
};
