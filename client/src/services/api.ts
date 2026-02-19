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

const API_BASE = '/api';
const TOKEN_STORAGE_KEY = 'BETTERMAIL_USER_TOKEN';
let runtimeToken: string | null = null;

const resolveToken = () => {
  const envToken = ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_BETTERMAIL_USER_TOKEN ?? '').trim();
  if (runtimeToken) {
    return runtimeToken;
  }

  try {
    const sessionToken = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (sessionToken) {
      runtimeToken = sessionToken;
      return sessionToken;
    }

    // One-time migration path for older clients that used localStorage.
    const legacyLocalToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (legacyLocalToken) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, legacyLocalToken);
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      runtimeToken = legacyLocalToken;
      return legacyLocalToken;
    }
  } catch {
    // ignore browser storage availability issues and fall through to env token.
  }

  return envToken || null;
};

const getAuthToken = () => resolveToken();

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
  const plainMatch = value.match(/filename=\"?([^\";]+)\"?/i);
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

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getAuthToken();
  
  const headers = new Headers(options?.headers);
  if (options?.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    runtimeToken = null;
    try {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // ignore storage failures
    }
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || response.statusText);
  }

  return response.json();
}

async function requestBlob(path: string, options?: RequestInit): Promise<{ blob: Blob; filename: string | null }> {
  const token = getAuthToken();
  const headers = new Headers(options?.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    runtimeToken = null;
    try {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // ignore storage failures
    }
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || response.statusText);
  }

  return {
    blob: await response.blob(),
    filename: parseDownloadFilename(response.headers.get('Content-Disposition')),
  };
}

export const api = {
  auth: {
    login: (token: string) => {
      runtimeToken = token;
      try {
        sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
        localStorage.removeItem(TOKEN_STORAGE_KEY);
      } catch {
        // ignore storage failures
      }
    },
    logout: () => {
      runtimeToken = null;
      try {
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        localStorage.removeItem(TOKEN_STORAGE_KEY);
      } catch {
        // ignore storage failures
      }
      window.location.href = '/login';
    },
    isAuthenticated: () => !!getAuthToken(),
  },

  connectors: {
    getIncoming: (id: string) => request<IncomingConnectorRecord>(`/connectors/incoming/${id}`),
    listIncoming: () => request<IncomingConnectorRecord[]>('/connectors/incoming'),
    updateIncoming: (id: string, data: any) => request<IncomingConnectorRecord>(`/connectors/incoming/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    listOutgoing: () => request<OutgoingConnectorRecord[]>('/connectors/outgoing'),
    getOutgoing: (id: string) => request<OutgoingConnectorRecord>(`/connectors/outgoing/${id}`),
    createIncoming: (data: any) => request<IncomingConnectorRecord>('/connectors/incoming', { method: 'POST', body: JSON.stringify(data) }),
    createOutgoing: (data: any) => request<OutgoingConnectorRecord>('/connectors/outgoing', { method: 'POST', body: JSON.stringify(data) }),
    updateOutgoing: (id: string, data: any) => request<OutgoingConnectorRecord>(`/connectors/outgoing/${id}`, {
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
    create: (data: any) => request<IdentityRecord>('/identities', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: any) => request<IdentityRecord>(`/identities/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) => request(`/identities/${id}`, { method: 'DELETE' }),
  },

  rules: {
    list: () => request<any[]>('/rules'),
    create: (data: any) => request<any>('/rules', { method: 'POST', body: JSON.stringify(data) }),
    delete: (id: string) => request(`/rules/${id}`, { method: 'DELETE' }),
    runAll: () => request<{ status: string }>('/rules/run', { method: 'POST' }),
  },

  labels: {
    list: () => request<any[]>('/labels'),
    create: (name: string, key?: string) => request<any>('/labels', { method: 'POST', body: JSON.stringify({ name, key }) }),
    delete: (id: string) => request(`/labels/${id}`, { method: 'DELETE' }),
    addToMessage: (messageId: string, labelKeys: string[]) => 
      request(`/messages/${messageId}/labels`, { method: 'POST', body: JSON.stringify({ addLabelKeys: labelKeys }) }),
    removeFromMessage: (messageId: string, labelKeys: string[]) => 
      request(`/messages/${messageId}/labels`, { method: 'POST', body: JSON.stringify({ removeLabelKeys: labelKeys }) }),
  },

  savedSearches: {
    list: () => request<any[]>('/saved-searches'),
    create: (data: { name: string, queryText: string }) => request<any>('/saved-searches', { method: 'POST', body: JSON.stringify(data) }),
    delete: (id: string) => request(`/saved-searches/${id}`, { method: 'DELETE' }),
  },

  search: {
    quickFilters: () => request<any>('/search/quick-filters'),
    suggestions: (q: string) => request<any>(`/search/suggestions?q=${encodeURIComponent(q)}`),
  },

  messages: {
    list: (params?: { folder?: string; connectorId?: string; limit?: number; offset?: number }) => {
      const query = new URLSearchParams();
      if (params?.folder) query.append('folder', params.folder);
      if (params?.connectorId) query.append('connectorId', params.connectorId);
      if (params?.limit) query.append('limit', String(params.limit));
      if (typeof params?.offset === 'number') query.append('offset', String(params.offset));
      return request<{ messages: MessageRecord[]; totalCount: number }>(`/messages?${query.toString()}`);
    },
    listSendOnly: (params: { emailAddress: string; folder?: string; q?: string; limit?: number; offset?: number }) => {
      const query = new URLSearchParams();
      query.append('emailAddress', params.emailAddress);
      if (params.folder) query.append('folder', params.folder);
      if (params.q) query.append('q', params.q);
      if (params.limit) query.append('limit', String(params.limit));
      if (typeof params.offset === 'number') query.append('offset', String(params.offset));
      return request<{ messages: MessageRecord[]; totalCount: number }>(`/messages/send-only?${query.toString()}`);
    },
    getThread: (threadId: string, connectorId?: string) => {
      const query = connectorId
        ? `?connectorId=${encodeURIComponent(connectorId)}`
        : '';
      return request<MessageRecord[]>(`/messages/thread/${threadId}${query}`);
    },
    getLabels: (messageId: string) => request<any[]>(`/messages/${messageId}/labels`),
    update: (messageId: string, data: { isRead?: boolean, isStarred?: boolean, moveToFolder?: string, delete?: boolean, scope?: 'single' | 'thread' }) =>
      request<any>(`/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify(data) }),
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
    search: (params: { q: string; folder?: string; connectorId?: string; limit?: number; offset?: number }) => {
      return request<{ messages: MessageRecord[]; totalCount: number }>('/messages/search', { 
        method: 'POST', 
        body: JSON.stringify(params) 
      });
    },
    send: (data: any, idempotencyKey: string) => {
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
      authorize: (data: { type: 'incoming' | 'outgoing'; connectorId: string; oauthClientId?: string; oauthClientSecret?: string }) =>
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
    getStates: (connectorId: string) =>
      request<ConnectorSyncStatesResponse>(`/connectors/${connectorId}/sync-states`),
  },

  events: {
    list: (since = 0, limit = 50) => request<any[]>(`/events?since=${since}&limit=${limit}`),
  },

  attachments: {
    getDownloadUrl: (attachmentId: string) => `/api/attachments/${attachmentId}/download`,
    getPreviewUrl: (attachmentId: string) => `/api/attachments/${attachmentId}/view`,
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
