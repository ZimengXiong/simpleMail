import type {
  IncomingConnectorRecord,
  OutgoingConnectorRecord,
  IdentityRecord,
  MessageRecord,
  MailboxInfo,
} from '../types/index';

const API_BASE = '/api';

const getAuthHeaders = () => {
  const headerToken = import.meta.env.VITE_BETTERMAIL_USER_TOKEN as string | undefined;
  const adminToken = import.meta.env.VITE_BETTERMAIL_ADMIN_TOKEN as string | undefined;
  const queryToken =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('bettermail_token')
      : null;
  const storedToken =
    typeof window !== 'undefined' ? localStorage.getItem('BETTERMAIL_USER_TOKEN') : null;

  const authToken = (queryToken || headerToken || storedToken || '').trim();
  const apiToken = (adminToken || '').trim();

  if (queryToken && typeof window !== 'undefined') {
    localStorage.setItem('BETTERMAIL_USER_TOKEN', queryToken);
  }

  if (!authToken) {
    return apiToken ? { 'x-api-key': apiToken } : {};
  }

  return {
    Authorization: `Bearer ${authToken}`,
    'x-user-token': authToken,
    ...(apiToken ? { 'x-api-key': apiToken } : {}),
  };
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || response.statusText);
  }

  return response.json();
}

export const api = {
  health: () => request<{ status: string }>('/health'),

  connectors: {
    listIncoming: () => request<IncomingConnectorRecord[]>('/connectors/incoming'),
    listOutgoing: () => request<OutgoingConnectorRecord[]>('/connectors/outgoing'),
    createIncoming: (data: any) => request<IncomingConnectorRecord>('/connectors/incoming', { method: 'POST', body: JSON.stringify(data) }),
    createOutgoing: (data: any) => request<OutgoingConnectorRecord>('/connectors/outgoing', { method: 'POST', body: JSON.stringify(data) }),
    getMailboxes: (connectorId: string) => request<MailboxInfo[]>(`/connectors/${connectorId}/mailboxes`),
  },

  identities: {
    list: () => request<IdentityRecord[]>('/identities'),
    create: (data: any) => request<IdentityRecord>('/identities', { method: 'POST', body: JSON.stringify(data) }),
  },

  messages: {
    list: (params?: { folder?: string; limit?: number }) => {
      const query = new URLSearchParams();
      if (params?.folder) query.append('folder', params.folder);
      if (params?.limit) query.append('limit', String(params.limit));
      return request<MessageRecord[]>(`/messages?${query.toString()}`);
    },
    getThread: (threadId: string) => request<MessageRecord[]>(`/messages/thread/${threadId}`),
    search: (q: string, limit = 50) => request<MessageRecord[]>('/messages/search', { method: 'POST', body: JSON.stringify({ q, limit }) }),
    send: (data: any) => request<{ status: string }>('/messages/send', { method: 'POST', body: JSON.stringify(data) }),
  },

  oauth: {
    google: {
      authorize: (data: { type: 'incoming' | 'outgoing'; connectorId: string; oauthClientId?: string; oauthClientSecret?: string }) =>
        request<{ authorizeUrl: string }>('/oauth/google/authorize', { method: 'POST', body: JSON.stringify(data) }),
    },
  },

  sync: {
    trigger: (connectorId: string, mailbox = 'INBOX') => request<{ status: string }>(`/sync/${connectorId}`, { method: 'POST', body: JSON.stringify({ mailbox }) }),
  },
};
