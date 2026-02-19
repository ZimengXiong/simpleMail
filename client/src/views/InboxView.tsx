import { useState, useEffect, memo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData, useQueries } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { format, isToday, isThisYear } from 'date-fns';
import {
  RefreshCw,
  Search,
  Loader2,
  Mail,
  LayoutPanelLeft,
  X,
  ChevronLeft,
  ChevronRight,
  Star,
  Trash2,
  Mail as MailIcon,
  MailOpen,
  CheckSquare,
  Square,
  Archive,
} from 'lucide-react';
import type { MessageRecord } from '../types/index';
import EmptyState from '../components/EmptyState';
import ThreadDetail from '../components/ThreadDetail';
import { useLayoutMode } from '../services/layout';
import { hasActiveSyncStates } from '../services/syncState';

const PAGE_SIZE = 50;
type MessagesQueryResult = { messages: MessageRecord[]; totalCount: number };
const isStarredFolderToken = (value: unknown) => String(value ?? '').trim().toUpperCase().includes('STARRED');

const InboxView = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const layoutMode = useLayoutMode();

  const folder = searchParams.get('folder');
  const connectorIdFromParams = searchParams.get('connectorId');
  const profileType = searchParams.get('profile');
  const sendOnlyEmail = profileType === 'send-only'
    ? String(searchParams.get('sendEmail') ?? '').trim().toLowerCase()
    : '';
  const isSendOnlyMode = Boolean(sendOnlyEmail);
  const query = searchParams.get('q') || '';
  const page = parseInt(searchParams.get('page') || '1', 10);
  const offset = (page - 1) * PAGE_SIZE;

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState(query);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [isTabVisible, setIsTabVisible] = useState(() => document.visibilityState === 'visible');

  useEffect(() => {
    const onVisibilityChange = () => setIsTabVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    setSelectedThreadId(null);
    setSelectedMessageIds(new Set());
  }, [folder, connectorIdFromParams, sendOnlyEmail, query, page]);

  const { data: connectors, isLoading: loadingConnectors } = useQuery({
    queryKey: ['connectors', 'incoming'],
    queryFn: () => api.connectors.listIncoming(),
  });

  const firstConnectorId = connectors?.[0]?.id;
  const effectiveConnectorId = isSendOnlyMode
    ? undefined
    : (connectorIdFromParams || firstConnectorId);

  useEffect(() => {
    if (!isSendOnlyMode || folder) {
      return;
    }
    const params = new URLSearchParams(searchParams);
    params.set('folder', 'OUTBOX');
    setSearchParams(params, { replace: true });
  }, [folder, isSendOnlyMode, searchParams, setSearchParams]);

  useEffect(() => {
    if (isSendOnlyMode || connectorIdFromParams || !firstConnectorId) {
      return;
    }
    const params = new URLSearchParams(searchParams);
    params.set('connectorId', firstConnectorId);
    params.delete('folder');
    setSearchParams(params, { replace: true });
  }, [connectorIdFromParams, firstConnectorId, isSendOnlyMode, searchParams, setSearchParams]);

  const { data: result, isLoading: loadingMessages } = useQuery({
    queryKey: ['messages', isSendOnlyMode ? `send-only:${sendOnlyEmail}` : effectiveConnectorId, folder, query, page],
    queryFn: () => {
      if (isSendOnlyMode) {
        return api.messages.listSendOnly({
          emailAddress: sendOnlyEmail,
          folder: folder || 'OUTBOX',
          q: query || undefined,
          limit: PAGE_SIZE,
          offset,
        });
      }
      return query
        ? api.messages.search({ q: query, folder: folder || undefined, connectorId: effectiveConnectorId, limit: PAGE_SIZE, offset })
        : api.messages.list({
          folder: folder || undefined,
          connectorId: effectiveConnectorId,
          limit: PAGE_SIZE,
          offset,
        });
    },
    enabled: isSendOnlyMode ? Boolean(sendOnlyEmail) : !!effectiveConnectorId,
    placeholderData: keepPreviousData,
    // Reduced from 2s to 8s — saves ~4x the DB queries at rest.
    refetchInterval: isTabVisible ? 8_000 : 30_000,
    refetchIntervalInBackground: false,
  });

  const syncStateQueries = useQueries({
    queries: (connectors ?? [])
      .filter((connector) => !isSendOnlyMode && connector.id === effectiveConnectorId)
      .map((connector) => ({
        queryKey: ['syncStates', connector.id],
        queryFn: () => api.sync.getStates(connector.id),
        enabled: Boolean(connector.id),
        refetchInterval: (syncQuery: any) =>
          hasActiveSyncStates(syncQuery.state.data?.states ?? [])
            ? 2_000
            : (isTabVisible ? 5_000 : 20_000),
      })),
  });

  const isAnySyncActive = !isSendOnlyMode && syncStateQueries.some((syncQuery) =>
    hasActiveSyncStates(syncQuery.data?.states ?? []),
  );

  // When sync becomes active, do a single targeted invalidation instead of a
  // recurring interval (the syncStateQuery's own 2s poll drives the re-check).
  useEffect(() => {
    if (isAnySyncActive && isTabVisible) {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
    }
  }, [isAnySyncActive, isTabVisible, queryClient]);

  const applyOptimisticPatch = (
    current: MessagesQueryResult | undefined,
    messageId: string,
    patch: { delete?: boolean; moveToFolder?: string; isRead?: boolean; isStarred?: boolean },
    options?: { removeFromStarredOnUnstar?: boolean },
  ) => {
    if (!current?.messages) {
      return current;
    }

    const shouldRemove = patch.delete === true
      || Boolean(patch.moveToFolder)
      || (options?.removeFromStarredOnUnstar === true && patch.isStarred === false);

    let removed = false;
    const nextMessages = current.messages
      .map((message) => {
        if (message.id !== messageId) {
          return message;
        }
        if (shouldRemove) {
          removed = true;
          return null;
        }
        return {
          ...message,
          isRead: patch.isRead ?? message.isRead,
          isStarred: patch.isStarred ?? message.isStarred,
        };
      })
      .filter((message): message is MessageRecord => Boolean(message));

    return {
      ...current,
      messages: nextMessages,
      totalCount: removed ? Math.max(0, current.totalCount - 1) : current.totalCount,
    };
  };

  const updateMessageMutation = useMutation({
    mutationFn: (payload: { messageId: string; data: { delete?: boolean; moveToFolder?: string; isRead?: boolean; isStarred?: boolean } }) =>
      api.messages.update(payload.messageId, payload.data),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: ['messages'] });
      const snapshots = queryClient.getQueriesData<MessagesQueryResult>({ queryKey: ['messages'] });
      for (const [key, data] of snapshots) {
        const queryKey = Array.isArray(key) ? key : [];
        const removeFromStarredOnUnstar = isStarredFolderToken(queryKey[1]);
        queryClient.setQueryData<MessagesQueryResult>(
          key,
          applyOptimisticPatch(data, payload.messageId, payload.data, { removeFromStarredOnUnstar }),
        );
      }
      return { snapshots };
    },
    onError: (_error, _payload, context) => {
      for (const [key, data] of context?.snapshots ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
    },
  });

  const messages = result?.messages || [];
  const totalCount = result?.totalCount || 0;
  const selectedSendOnlyMessage = isSendOnlyMode && selectedThreadId
    ? messages.find((message) => (message.threadId || message.id) === selectedThreadId) ?? null
    : null;

  const triggerSyncMutation = useMutation({
    mutationFn: async () => {
      if (!effectiveConnectorId || isSendOnlyMode) {
        return;
      }
      const mailbox = folder || 'INBOX';
      await api.sync.trigger(effectiveConnectorId, mailbox, false, false);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['syncStates'] });
      queryClient.invalidateQueries({ queryKey: ['messages'] });
    },
  });

  const bulkActionMutation = useMutation({
    mutationFn: (data: any) => api.messages.bulkUpdate(Array.from(selectedMessageIds), { ...data, scope: 'single' }),
    onMutate: async (data: { delete?: boolean; moveToFolder?: string; isRead?: boolean; isStarred?: boolean }) => {
      await queryClient.cancelQueries({ queryKey: ['messages'] });
      const snapshots = queryClient.getQueriesData<MessagesQueryResult>({ queryKey: ['messages'] });
      const ids = Array.from(selectedMessageIds);
      for (const [key, snapshot] of snapshots) {
        const queryKey = Array.isArray(key) ? key : [];
        const removeFromStarredOnUnstar = isStarredFolderToken(queryKey[1]);
        let next = snapshot;
        for (const id of ids) {
          next = applyOptimisticPatch(next, id, data, { removeFromStarredOnUnstar });
        }
        queryClient.setQueryData<MessagesQueryResult>(key, next);
      }
      return { snapshots };
    },
    onError: (_error, _vars, context) => {
      for (const [key, data] of context?.snapshots ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      setSelectedMessageIds(new Set());
    }
  });

  const markAsReadMutation = useMutation({
    mutationFn: (messageId: string) => api.messages.update(messageId, { isRead: true, scope: 'single' }),
    onMutate: async (messageId: string) => {
      await queryClient.cancelQueries({ queryKey: ['messages'] });
      const snapshots = queryClient.getQueriesData<MessagesQueryResult>({ queryKey: ['messages'] });
      for (const [key, data] of snapshots) {
        const queryKey = Array.isArray(key) ? key : [];
        const removeFromStarredOnUnstar = isStarredFolderToken(queryKey[1]);
        queryClient.setQueryData<MessagesQueryResult>(
          key,
          applyOptimisticPatch(data, messageId, { isRead: true }, { removeFromStarredOnUnstar }),
        );
      }
      return { snapshots };
    },
    onError: (_error, _messageId, context) => {
      for (const [key, data] of context?.snapshots ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
    }
  });

  // Auto mark as read on selection
  useEffect(() => {
    if (isSendOnlyMode) {
      return;
    }
    if (selectedThreadId) {
      const msg = messages.find(m => (m.threadId || m.id) === selectedThreadId);
      if (msg && !msg.isRead) {
        markAsReadMutation.mutate(msg.id);
      }
    }
  }, [isSendOnlyMode, selectedThreadId, messages]);

  const toggleSelectAll = () => {
    if (isSendOnlyMode) {
      return;
    }
    if (selectedMessageIds.size === messages.length) {
      setSelectedMessageIds(new Set());
    } else {
      setSelectedMessageIds(new Set(messages.map(m => m.id)));
    }
  };

  const toggleSelectMessage = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isSendOnlyMode) {
      return;
    }
    setSelectedMessageIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [isSendOnlyMode]);

  const handleSearchSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const params = new URLSearchParams(searchParams);
    if (searchInput) params.set('q', searchInput);
    else params.delete('q');
    params.set('page', '1');
    setSearchParams(params);
  };

  const setPage = (p: number) => {
    const params = new URLSearchParams(searchParams);
    params.set('page', String(p));
    setSearchParams(params);
  };

  const formatDate = useCallback((dateStr: string | null) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (isToday(date)) return format(date, 'h:mm a');
    if (isThisYear(date)) return format(date, 'MMM d');
    return format(date, 'MM/dd/yy');
  }, []);

  const stripEmailFromName = (value: string) =>
    value
      .replace(/<[^>]*>/g, ' ')
      .replace(/\([^)]*@[^)]*\)/g, ' ')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ')
      .replace(/['"]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const parseFromHeader = (header: string | null) => {
    if (!header) return { name: 'Unknown', email: '' };
    const match = header.match(/^(.*?)\s*<([^>]+)>$/);
    if (match) {
      const email = String(match[2] ?? '').trim();
      const cleanName = stripEmailFromName(String(match[1] ?? ''));
      const fallback = email ? email.split('@')[0] : '';
      return { name: cleanName || fallback || 'Unknown', email };
    }
    const emailMatch = header.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    const email = emailMatch?.[0] ?? '';
    const cleanName = stripEmailFromName(header);
    const fallback = email ? email.split('@')[0] : '';
    return { name: cleanName || fallback || 'Unknown', email };
  };

  const renderParticipants = (msg: MessageRecord) => {
    const userEmails = new Set((connectors ?? []).map(c => c.emailAddress.toLowerCase()));

    const getDisplayName = (header: string) => {
      const parsed = parseFromHeader(header);
      if (userEmails.has(parsed.email.toLowerCase())) return 'me';
      return parsed.name;
    };

    if (!msg.participants || msg.participants.length === 0) {
      return <span className={`truncate ${!msg.isRead ? 'font-semibold text-text-primary' : 'text-text-secondary font-medium'}`}>{getDisplayName(msg.fromHeader || '')}</span>;
    }

    const names = msg.participants.map(p => getDisplayName(p));
    const uniqueNames: string[] = [];
    const seen = new Set<string>();
    for (const n of names) {
      if (!seen.has(n)) {
        uniqueNames.push(n);
        seen.add(n);
      }
    }

    const sortedNames = uniqueNames.sort((a, b) => {
      if (a === 'me') return -1;
      if (b === 'me') return 1;
      return a.localeCompare(b);
    });

    const joined = sortedNames.join(', ');

    return (
      <div className="flex items-center gap-1 min-w-0">
        <span className={`truncate ${!msg.isRead ? 'font-semibold text-text-primary' : 'text-text-secondary font-medium'}`}>{joined}</span>
        {msg.threadCount && msg.threadCount > 1 && (
          <span className="text-[11px] text-text-secondary/60 font-normal">({msg.threadCount})</span>
        )}
      </div>
    );
  };

  // Stable callbacks for memo'd list items — created once per mutation identity
  const handleUpdateMessage = useCallback((messageId: string, data: { isRead?: boolean; isStarred?: boolean; delete?: boolean; moveToFolder?: string }) => {
    if (isSendOnlyMode) {
      return;
    }
    updateMessageMutation.mutate({ messageId, data });
  }, [isSendOnlyMode, updateMessageMutation]);

  const handleSelectThread = useCallback((threadId: string) => {
    setSelectedThreadId(threadId);
  }, []);

  if (loadingConnectors) {
    return <div className="flex-1 flex items-center justify-center bg-bg-card"><Loader2 className="w-6 h-6 animate-spin text-text-secondary" /></div>;
  }

  if (!isSendOnlyMode && !connectors?.length) {
    return <EmptyState icon={LayoutPanelLeft} title="Welcome to betterMail" description="Connect an account to get started." actionText="Add account" actionPath="/settings/connectors/new?type=incoming" />;
  }

  // --- BULK TOOLBAR ---
  const bulkToolbar = (
    <div className="h-12 border-b border-border/60 flex items-center px-3 gap-2 bg-accent shrink-0 animate-in slide-in-from-top-1 duration-200" style={{ color: 'var(--accent-contrast)' }}>
      <button onClick={toggleSelectAll} className="p-1.5 hover:bg-black/10 rounded">
        {selectedMessageIds.size === messages.length ? <CheckSquare className="w-4.5 h-4.5" /> : <Square className="w-4.5 h-4.5" />}
      </button>
      <div className="text-xs font-bold mr-2">{selectedMessageIds.size} selected</div>
      <div className="h-4 w-px bg-current opacity-20 mx-1" />
      <button onClick={() => bulkActionMutation.mutate({ moveToFolder: 'ARCHIVE' })} className="p-2 hover:bg-black/10 transition-colors rounded-md" title="Archive"><Archive className="w-4 h-4" /></button>
      <button onClick={() => bulkActionMutation.mutate({ delete: true })} className="p-2 hover:bg-red-500/20 rounded-md" title="Delete"><Trash2 className="w-4 h-4" /></button>
      <button onClick={() => bulkActionMutation.mutate({ isRead: true })} className="p-2 hover:bg-black/10 rounded-md" title="Mark as Read"><MailOpen className="w-4 h-4" /></button>
      <button onClick={() => bulkActionMutation.mutate({ isRead: false })} className="p-2 hover:bg-black/10 rounded-md" title="Mark as Unread"><MailIcon className="w-4 h-4" /></button>
      <div className="flex-1" />
      <button onClick={() => setSelectedMessageIds(new Set())} className="p-1.5 hover:bg-black/10 rounded"><X className="w-4 h-4" /></button>
    </div>
  );

  // --- PAGINATION UI ---
  const startRange = offset + 1;
  const endRange = Math.min(offset + messages.length, totalCount);
  const paginationUI = (
    <div className="flex items-center gap-4 px-2 shrink-0">
      <div className="text-xs text-text-secondary font-semibold whitespace-nowrap opacity-70">{totalCount > 0 ? `${startRange}-${endRange} of ${totalCount}` : '0-0 of 0'}</div>
      <div className="flex items-center gap-0.5">
        <button onClick={() => setPage(page - 1)} disabled={page <= 1} className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded disabled:opacity-30 transition-colors"><ChevronLeft className="w-4 h-4" /></button>
        <button onClick={() => setPage(page + 1)} disabled={endRange >= totalCount} className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded disabled:opacity-30 transition-colors"><ChevronRight className="w-4 h-4" /></button>
      </div>
    </div>
  );

  if (layoutMode === 'list' && selectedThreadId) {
    return (
      <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-bg-card animate-in fade-in slide-in-from-right-2 duration-200">
        <div className="h-10 border-b border-border/60 flex items-center px-2 bg-bg-card shrink-0">
          <button onClick={() => setSelectedThreadId(null)} className="flex items-center gap-1.5 px-2 py-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-secondary transition-colors"><ChevronLeft className="w-4 h-4" /><span className="text-sm font-semibold text-text-primary">Back to inbox</span></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          {isSendOnlyMode
            ? (selectedSendOnlyMessage
              ? <SendOnlyMessageDetail message={selectedSendOnlyMessage} />
              : <div className="flex-1 flex items-center justify-center text-sm text-text-secondary">Message not found.</div>)
            : <ThreadDetail threadId={selectedThreadId} connectorId={effectiveConnectorId} onActionComplete={() => { }} />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg-card">
      {selectedMessageIds.size > 0 && !isSendOnlyMode ? bulkToolbar : (
        <div className="h-11 border-b border-border/60 flex items-center px-3 gap-2 shrink-0 bg-bg-card relative">
          {!isSendOnlyMode && (
            <div className="shrink-0 mr-1"><button onClick={toggleSelectAll} className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-secondary"><Square className="w-4 h-4 opacity-60" /></button></div>
          )}
          <div className="relative flex-1 max-w-2xl mx-auto">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary opacity-60" />
            <form onSubmit={handleSearchSubmit}><input type="text" placeholder="Search mail" className="w-full bg-sidebar border-none rounded-md pl-9 pr-8 py-1.5 text-sm text-text-primary focus:outline-none transition-all placeholder:text-text-secondary/50" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} /></form>
            {searchInput && <button onClick={() => { setSearchInput(''); handleSearchSubmit(); }} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-secondary"><X className="w-3 h-3" /></button>}
          </div>
          <div className="flex-1" />
          {layoutMode === 'list' && paginationUI}
          {!isSendOnlyMode && (
            <button
              onClick={() => triggerSyncMutation.mutate()}
              className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-secondary disabled:opacity-50"
              disabled={triggerSyncMutation.isPending}
              title="Run full sync"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${triggerSyncMutation.isPending ? 'animate-spin' : ''}`} />
            </button>
          )}
        </div>
      )}

      <div className="flex-1 flex overflow-hidden bg-bg-card">
        <div className={`flex flex-col bg-bg-card shrink-0 min-w-0 ${layoutMode === 'columns' ? 'w-full md:w-[350px] lg:w-[400px] xl:w-[450px] border-r border-border/60' : 'flex-1'}`}>
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {loadingMessages ? (
              <div className="flex items-center justify-center h-32"><Loader2 className="w-6 h-6 animate-spin text-text-secondary" /></div>
            ) : messages.length === 0 ? (
              <div className="p-12 text-center text-text-secondary opacity-50 italic text-sm">No messages found.</div>
            ) : (
              <div className={layoutMode === 'columns' ? 'divide-y divide-border/20' : ''}>
                {messages.map((msg) =>
                  layoutMode === 'columns' ? (
                    <MemoColumnItem
                      key={msg.id}
                      msg={msg}
                      selectedThreadId={selectedThreadId}
                      isSelected={selectedMessageIds.has(msg.id)}
                      onSelect={handleSelectThread}
                      onToggleSelect={toggleSelectMessage}
                      onUpdateMessage={handleUpdateMessage}
                      participants={renderParticipants(msg)}
                      formattedDate={formatDate(msg.receivedAt)}
                      disableActions={isSendOnlyMode}
                    />
                  ) : (
                    <MemoListItem
                      key={msg.id}
                      msg={msg}
                      selectedThreadId={selectedThreadId}
                      isSelected={selectedMessageIds.has(msg.id)}
                      onSelect={handleSelectThread}
                      onToggleSelect={toggleSelectMessage}
                      onUpdateMessage={handleUpdateMessage}
                      participants={renderParticipants(msg)}
                      formattedDate={formatDate(msg.receivedAt)}
                      disableActions={isSendOnlyMode}
                    />
                  )
                )}
              </div>
            )}
            {layoutMode === 'columns' && totalCount > PAGE_SIZE && <div className="p-4 border-t border-border/20 flex justify-center bg-bg-card">{paginationUI}</div>}
          </div>
        </div>

        {layoutMode === 'columns' && (
          <div className="flex-1 flex flex-col min-w-0 bg-black/[0.02] dark:bg-white/[0.02]">
            {isSendOnlyMode
              ? (selectedSendOnlyMessage
                ? <SendOnlyMessageDetail message={selectedSendOnlyMessage} />
                : <div className="flex-1 flex flex-col items-center justify-center text-text-secondary opacity-60"><Mail className="w-12 h-12 mb-2 stroke-1" /><p className="text-sm font-medium">Select a sent/outbox message</p><p className="text-xs mt-1">Responses will not appear without an IMAP inbox.</p></div>)
              : (selectedThreadId
                ? <ThreadDetail threadId={selectedThreadId} connectorId={effectiveConnectorId} onActionComplete={() => { }} />
                : <div className="flex-1 flex flex-col items-center justify-center text-text-secondary opacity-50"><Mail className="w-12 h-12 mb-2 stroke-1" /><p className="text-sm font-medium">Select a message to read</p></div>)
            }
          </div>
        )}
      </div>
    </div>
  );
};

const SendOnlyMessageDetail = ({ message }: { message: MessageRecord }) => {
  const statusLabel = String(message.sendStatus ?? 'queued').toUpperCase();
  const warning = 'Responses will not be shown because this is a SEND ONLY profile and no IMAP inbox is configured.';
  const showNoResponseWarning = message.sendOnlyNoResponses !== false;
  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar p-5 md:p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        {showNoResponseWarning && (
          <div className="rounded-md border border-amber-300/60 bg-amber-50/70 text-amber-900 px-3 py-2 text-xs font-medium">
            {warning}
          </div>
        )}

        <div className="rounded-md border border-border bg-bg-card p-4 md:p-5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-text-primary">{message.subject || '(no subject)'}</h2>
            <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded bg-black/5 dark:bg-white/10 text-text-secondary">
              {statusLabel}
            </span>
          </div>
          <div className="text-xs text-text-secondary space-y-1">
            <div><span className="font-semibold">From:</span> {message.fromHeader || 'Unknown'}</div>
            <div><span className="font-semibold">To:</span> {message.toHeader || 'Unknown recipient'}</div>
            <div><span className="font-semibold">Folder:</span> {message.folderPath}</div>
            <div><span className="font-semibold">Time:</span> {message.receivedAt ? format(new Date(message.receivedAt), 'PPP p') : 'Unknown'}</div>
          </div>
          {message.sendError && (
            <div className="rounded border border-red-300/60 bg-red-50/60 text-red-700 px-3 py-2 text-xs">
              <span className="font-semibold">Send error:</span> {message.sendError}
            </div>
          )}
          <div className="border-t border-border pt-3">
            <div className="text-sm text-text-primary whitespace-pre-wrap">{message.bodyText || message.snippet || '(no body)'}</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InboxView;

// ---------------------------------------------------------------------------
// Stable memo'd list item components — at module level so React can diff
// them correctly across polling-triggered re-renders.
// ---------------------------------------------------------------------------

type ListItemProps = {
  msg: MessageRecord;
  selectedThreadId: string | null;
  isSelected: boolean;
  onSelect: (threadId: string) => void;
  onToggleSelect: (id: string, e: React.MouseEvent) => void;
  onUpdateMessage: (id: string, data: { isRead?: boolean; isStarred?: boolean; delete?: boolean; moveToFolder?: string }) => void;
  participants: React.ReactNode;
  formattedDate: string;
  disableActions?: boolean;
};

const MemoColumnItem = memo(({ msg, selectedThreadId, isSelected, onSelect, onToggleSelect, participants, formattedDate, disableActions }: ListItemProps) => {
  const threadId = msg.threadId || msg.id;
  return (
    <div
      onClick={() => onSelect(threadId)}
      className={`
        px-3 py-1.5 cursor-pointer transition-colors group relative border-l-2 flex gap-2
        ${selectedThreadId === threadId ? 'bg-accent/5 border-l-accent' : 'hover:bg-sidebar/40 border-l-transparent'}
        ${!msg.isRead ? 'bg-bg-card' : 'bg-black/[0.02] dark:bg-white/[0.02]'}
        ${isSelected ? 'bg-accent/[0.08]' : ''}
      `}
    >
      {!disableActions && (
        <div className="pt-0.5 shrink-0 z-10" onClick={(e) => onToggleSelect(msg.id, e)}>
          <button className={`p-0.5 rounded transition-colors ${isSelected ? 'text-accent' : 'text-text-secondary opacity-40 group-hover:opacity-100'}`}>
            {isSelected ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
          </button>
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex justify-between items-baseline mb-0">
          <div className="flex items-center gap-1.5 truncate max-w-[200px] flex-1">
            {!msg.isRead && <div className="w-1.5 h-1.5 shrink-0 rounded-full bg-blue-500 shadow-sm" />}
            <div className="truncate">{participants}</div>
          </div>
          <span className="text-[10px] text-text-secondary whitespace-nowrap opacity-70 font-medium">{formattedDate}</span>
        </div>
        <div className={`text-sm leading-tight truncate mb-0 pr-4 ${!msg.isRead ? 'font-semibold text-text-primary' : 'text-text-primary/90 font-medium'}`}>{msg.subject || '(no subject)'}</div>
        <div className="text-xs text-text-secondary line-clamp-1 font-normal opacity-60">{msg.snippet}</div>
      </div>
    </div>
  );
});
MemoColumnItem.displayName = 'MemoColumnItem';

// selectedThreadId not needed in list mode but kept in type for uniformity
const MemoListItem = memo(({ msg, isSelected, onSelect, onToggleSelect, onUpdateMessage, participants, formattedDate, disableActions }: ListItemProps) => {
  const threadId = msg.threadId || msg.id;
  const subjectText = (msg.subject || '(no subject)').trim();
  const snippetText = String(msg.snippet || '').trim();
  const normalizedSubject = subjectText.replace(/\s+/g, ' ').toLowerCase();
  let previewText = snippetText;
  if (previewText) {
    const normalizedPreview = previewText.replace(/\s+/g, ' ').toLowerCase();
    if (normalizedPreview === normalizedSubject) {
      previewText = '';
    } else if (normalizedSubject && normalizedPreview.startsWith(`${normalizedSubject} `)) {
      previewText = previewText.slice(subjectText.length).trim();
    }
  }

  return (
    <div
      onClick={() => onSelect(threadId)}
      className={`
        flex items-center px-4 h-9 cursor-pointer border-b border-border/40 transition-colors group
        ${!msg.isRead ? 'bg-bg-card text-text-primary' : 'bg-black/[0.01] dark:bg-white/[0.01] text-text-secondary/80 hover:bg-black/[0.03] dark:hover:bg-white/[0.03]'}
        ${isSelected ? 'bg-accent/[0.08]' : ''}
      `}
    >
      {!disableActions && (
        <div className="shrink-0 mr-3 z-10" onClick={(e) => onToggleSelect(msg.id, e)}>
          <button className={`p-1 rounded transition-colors ${isSelected ? 'text-accent' : 'text-text-secondary opacity-50 group-hover:opacity-100'}`}>
            {isSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
          </button>
        </div>
      )}
      <div className="flex items-center gap-3 shrink-0 mr-4 w-48">
        {!msg.isRead && <div className="w-2 h-2 shrink-0 rounded-full bg-blue-500 shadow-sm -ml-2" />}
        {!disableActions && (
          <button
            className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10"
            onClick={(e) => { e.stopPropagation(); onUpdateMessage(msg.id, { isStarred: !msg.isStarred }); }}
            title={msg.isStarred ? 'Unstar' : 'Star'}
          >
            <Star className={`w-3.5 h-3.5 ${msg.isStarred ? 'fill-yellow-400 text-yellow-400' : 'text-text-secondary opacity-40 group-hover:opacity-100'}`} />
          </button>
        )}
        <div className="flex-1 min-w-0">{participants}</div>
      </div>
      <div className="min-w-0 flex-1 flex items-baseline gap-2 pr-4">
        <span className={`text-sm truncate max-w-[48%] ${!msg.isRead ? 'font-semibold text-text-primary' : 'text-text-primary/90 font-medium'}`}>{subjectText}</span>
        {previewText && (
          <span className="text-sm text-text-secondary font-normal opacity-50 truncate min-w-0 flex-1">— {previewText}</span>
        )}
      </div>
      <div className="text-xs text-text-secondary/70 font-medium whitespace-nowrap shrink-0 group-hover:hidden ml-3 min-w-[3.25rem] text-right">{formattedDate}</div>
      {!disableActions && (
        <div className="hidden group-hover:flex items-center gap-1 shrink-0">
          <button
            className="p-1.5 hover:bg-black/10 dark:hover:bg-white/10 rounded text-text-secondary transition-colors"
            onClick={(e) => { e.stopPropagation(); onUpdateMessage(msg.id, { moveToFolder: 'ARCHIVE' }); }}
            title="Archive"
          >
            <Archive className="w-4 h-4" />
          </button>
          <button
            className="p-1.5 hover:bg-black/10 dark:hover:bg-white/10 rounded text-text-secondary transition-colors"
            onClick={(e) => { e.stopPropagation(); onUpdateMessage(msg.id, { delete: true }); }}
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
});
MemoListItem.displayName = 'MemoListItem';
