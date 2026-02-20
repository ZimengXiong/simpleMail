import { useState, useEffect, useCallback, lazy, Suspense, useTransition, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData, useQueries, type Query } from '@tanstack/react-query';
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
  Trash2,
  Mail as MailIcon,
  MailOpen,
  CheckSquare,
  Square,
  PenBox,
} from 'lucide-react';
import type { ConnectorSyncStatesResponse, MessageRecord } from '../types/index';
import EmptyState from '../components/EmptyState';
import { useLayoutMode, useMediaQuery } from '../services/layout';
import { hasActiveSyncStates } from '../services/syncState';
import { InboxColumnItem, InboxListItem } from '../components/inbox/InboxListItems';
import SendOnlyMessageDetail from './inbox/SendOnlyMessageDetail';
import {
  buildInboxSearchParams,
  persistInboxState,
  readPersistedInboxState,
  reduceInboxState,
  resolveInboxViewState,
  type InboxStateEvent,
} from '../services/inboxStateMachine';

const PAGE_SIZE = 50;
type MessagesQueryResult = { messages: MessageRecord[]; totalCount: number };
type MessagePatch = { delete?: boolean; moveToFolder?: string; isRead?: boolean; isStarred?: boolean };
type SelectionState = {
  scopeKey: string;
  messageIds: Set<string>;
};
const isStarredFolderToken = (value: unknown) => String(value ?? '').trim().toUpperCase().includes('STARRED');
const loadThreadDetail = () => import('../components/ThreadDetail');
const ThreadDetail = lazy(loadThreadDetail);
const loadComposeModal = () => import('../components/ComposeModal');
const ComposeModal = lazy(loadComposeModal);

const InboxView = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const preferredInboxState = readPersistedInboxState();
  const layoutPreference = useLayoutMode();
  const isMobile = useMediaQuery('(max-width: 768px)');
  const layoutMode = isMobile ? 'list' : layoutPreference;
  const [searchInput, setSearchInput] = useState('');
  const [isTabVisible, setIsTabVisible] = useState(() => document.visibilityState === 'visible');
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [, startTransition] = useTransition();

  useEffect(() => {
    const onVisibilityChange = () => setIsTabVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const { data: connectors, isLoading: loadingConnectors } = useQuery({
    queryKey: ['connectors', 'incoming'],
    queryFn: () => api.connectors.listIncoming(),
  });

  const connectorIds = useMemo(
    () => (connectors ?? []).map((connector) => connector.id),
    [connectors],
  );
  const sendOnlyEmailFromParams = String(searchParams.get('sendEmail') ?? '').trim().toLowerCase();
  const resolvedRouteState = useMemo(
    () => resolveInboxViewState(searchParams, {
      incomingConnectorIds: connectorIds,
      sendOnlyEmails: sendOnlyEmailFromParams ? [sendOnlyEmailFromParams] : [],
      preferredState: preferredInboxState,
    }),
    [connectorIds, preferredInboxState, searchParams, sendOnlyEmailFromParams],
  );
  const routeState = resolvedRouteState.state;

  useEffect(() => {
    if (!routeState) {
      return;
    }
    if (!resolvedRouteState.changed) {
      return;
    }
    setSearchParams(resolvedRouteState.searchParams, { replace: true });
  }, [resolvedRouteState, routeState, setSearchParams]);

  useEffect(() => {
    if (!routeState) {
      return;
    }
    persistInboxState(routeState);
  }, [routeState]);

  const folder = routeState?.folder ?? 'INBOX';
  const query = routeState?.query ?? '';
  const page = routeState?.page ?? 1;
  const selectedThreadId = routeState?.threadId ?? null;
  const isSendOnlyMode = routeState?.profile.kind === 'send-only';
  const sendOnlyEmail = routeState?.profile.kind === 'send-only'
    ? routeState.profile.sendEmail
    : '';
  const effectiveConnectorId = routeState?.profile.kind === 'incoming'
    ? routeState.profile.connectorId
    : undefined;
  const offset = (page - 1) * PAGE_SIZE;
  const selectionScopeKey = `${folder}|${effectiveConnectorId ?? ''}|${sendOnlyEmail}|${query}|${page}`;
  const [selectionState, setSelectionState] = useState<SelectionState>({
    scopeKey: selectionScopeKey,
    messageIds: new Set(),
  });
  const selectedMessageIds = selectionState.scopeKey === selectionScopeKey
    ? selectionState.messageIds
    : new Set<string>();
  const markReadInFlightRef = useRef<Set<string>>(new Set());
  const setSelectedMessageIds = useCallback((next: Set<string> | ((current: Set<string>) => Set<string>)) => {
    setSelectionState((current) => {
      const currentIds = current.scopeKey === selectionScopeKey ? current.messageIds : new Set<string>();
      const resolvedNext = typeof next === 'function'
        ? next(currentIds)
        : next;
      return {
        scopeKey: selectionScopeKey,
        messageIds: new Set(resolvedNext),
      };
    });
  }, [selectionScopeKey]);
  const dispatchRouteEvent = useCallback((event: InboxStateEvent, options?: { replace?: boolean }) => {
    if (!routeState) {
      return;
    }
    const nextState = reduceInboxState(routeState, event);
    const nextParams = buildInboxSearchParams(searchParams, nextState);
    startTransition(() => {
      setSearchParams(nextParams, { replace: options?.replace === true });
    });
  }, [routeState, searchParams, setSearchParams, startTransition]);
  const activeMailboxForPriority = folder;

  useEffect(() => {
    setSearchInput(query);
  }, [query]);

  useEffect(() => {
    if (isSendOnlyMode || !effectiveConnectorId || !isTabVisible) {
      return;
    }

    const reportActiveMailbox = () => {
      void api.sync.setActiveMailbox(effectiveConnectorId, activeMailboxForPriority).catch(() => {});
    };

    reportActiveMailbox();
    const timer = window.setInterval(reportActiveMailbox, 30_000);
    return () => window.clearInterval(timer);
  }, [isSendOnlyMode, effectiveConnectorId, activeMailboxForPriority, isTabVisible]);

  const { data: result, isLoading: loadingMessages } = useQuery<MessagesQueryResult>({
    queryKey: ['messages', isSendOnlyMode ? `send-only:${sendOnlyEmail}` : effectiveConnectorId, folder, query, page],
    queryFn: ({ signal }) => {
      if (isSendOnlyMode) {
        return api.messages.listSendOnly({
          emailAddress: sendOnlyEmail,
          folder: folder || 'OUTBOX',
          q: query || undefined,
          limit: PAGE_SIZE,
          offset,
          signal,
        });
      }
      return query
        ? api.messages.search({ q: query, folder: folder || undefined, connectorId: effectiveConnectorId, limit: PAGE_SIZE, offset, signal })
        : api.messages.list({
          folder: folder || undefined,
          connectorId: effectiveConnectorId,
          limit: PAGE_SIZE,
          offset,
          signal,
        });
    },
    enabled: isSendOnlyMode ? Boolean(sendOnlyEmail) : !!effectiveConnectorId,
    placeholderData: keepPreviousData,
    refetchInterval: isTabVisible
      ? (isSendOnlyMode ? 30_000 : 90_000)
      : 240_000,
    refetchIntervalInBackground: false,
  });

  const activeMessagesQueryKey = useMemo(
    () => ['messages', isSendOnlyMode ? `send-only:${sendOnlyEmail}` : effectiveConnectorId, folder, query, page],
    [effectiveConnectorId, folder, isSendOnlyMode, page, query, sendOnlyEmail],
  );
  const activeMessageScope = isSendOnlyMode ? `send-only:${sendOnlyEmail}` : (effectiveConnectorId ?? null);
  const isScopedMessageQuery = useCallback((queryKey: readonly unknown[]) => {
    if (!Array.isArray(queryKey) || queryKey[0] !== 'messages') {
      return false;
    }
    const scope = queryKey[1];
    if (activeMessageScope) {
      return scope === activeMessageScope;
    }
    return !(typeof scope === 'string' && scope.startsWith('send-only:'));
  }, [activeMessageScope]);

  const syncStateQueries = useQueries({
    queries: (connectors ?? [])
      .filter((connector) => !isSendOnlyMode && connector.id === effectiveConnectorId)
      .map((connector) => ({
        queryKey: ['syncStates', connector.id],
        queryFn: ({ signal }) => api.sync.getStates(connector.id, signal),
        enabled: Boolean(connector.id),
        refetchInterval: (syncQuery: Query) =>
          hasActiveSyncStates(
            ((syncQuery.state.data as ConnectorSyncStatesResponse | undefined)?.states) ?? [],
          )
            ? 4_000
            : (isTabVisible ? 15_000 : 45_000),
      })),
  });

  const isAnySyncActive = !isSendOnlyMode && syncStateQueries.some((syncQuery) =>
    hasActiveSyncStates(syncQuery.data?.states ?? []),
  );

  useEffect(() => {
    if (isAnySyncActive && isTabVisible) {
      queryClient.invalidateQueries({ queryKey: activeMessagesQueryKey, refetchType: 'active' });
    }
  }, [activeMessagesQueryKey, isAnySyncActive, isTabVisible, queryClient]);

  const applyOptimisticPatch = (
    current: MessagesQueryResult | undefined,
    messageId: string,
    patch: MessagePatch,
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
    mutationFn: (payload: { messageId: string; data: MessagePatch }) =>
      api.messages.update(payload.messageId, payload.data),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({
        predicate: (query) => isScopedMessageQuery(query.queryKey),
      });
      const snapshots = queryClient.getQueriesData<MessagesQueryResult>({
        predicate: (query) => isScopedMessageQuery(query.queryKey),
      });
      for (const [key, data] of snapshots) {
        const queryKey = Array.isArray(key) ? key : [];
        const removeFromStarredOnUnstar = isStarredFolderToken(queryKey[2]);
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
      queryClient.invalidateQueries({ queryKey: activeMessagesQueryKey, refetchType: 'active' });
    },
  });

  const messages = useMemo<MessageRecord[]>(
    () => result?.messages ?? [],
    [result?.messages],
  );
  const totalCount = result?.totalCount || 0;
  const selectedSendOnlyMessage = isSendOnlyMode && selectedThreadId
    ? messages.find((message) => (message.threadId || message.id) === selectedThreadId) ?? null
    : null;

  useEffect(() => {
    const canFetchSendOnly = isSendOnlyMode && Boolean(sendOnlyEmail);
    const canFetchIncoming = !isSendOnlyMode && Boolean(effectiveConnectorId);
    if (!canFetchSendOnly && !canFetchIncoming) {
      return;
    }

    const prefetchPage = (targetPage: number) => {
      if (targetPage < 1) {
        return;
      }
      const targetOffset = (targetPage - 1) * PAGE_SIZE;
      const queryKey = ['messages', isSendOnlyMode ? `send-only:${sendOnlyEmail}` : effectiveConnectorId, folder, query, targetPage];
      void queryClient.prefetchQuery({
        queryKey,
        queryFn: ({ signal }) => {
          if (isSendOnlyMode) {
            return api.messages.listSendOnly({
              emailAddress: sendOnlyEmail,
              folder: folder || 'OUTBOX',
              q: query || undefined,
              limit: PAGE_SIZE,
              offset: targetOffset,
              signal,
            });
          }
          return query
            ? api.messages.search({ q: query, folder: folder || undefined, connectorId: effectiveConnectorId, limit: PAGE_SIZE, offset: targetOffset, signal })
            : api.messages.list({
              folder: folder || undefined,
              connectorId: effectiveConnectorId,
              limit: PAGE_SIZE,
              offset: targetOffset,
              signal,
            });
        },
        staleTime: 20_000,
      });
    };

    if (page > 1) {
      prefetchPage(page - 1);
    }

    const hasNextPage = offset + messages.length < totalCount;
    if (hasNextPage) {
      prefetchPage(page + 1);
    }
  }, [
    effectiveConnectorId,
    folder,
    isSendOnlyMode,
    messages.length,
    offset,
    page,
    query,
    queryClient,
    sendOnlyEmail,
    totalCount,
  ]);

  useEffect(() => {
    if (isSendOnlyMode || messages.length === 0) {
      return;
    }

    const browserWindow = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    if (typeof browserWindow.requestIdleCallback === 'function') {
      const idleHandle = browserWindow.requestIdleCallback(() => {
        void loadThreadDetail();
      }, { timeout: 1_200 });
      return () => {
        if (typeof browserWindow.cancelIdleCallback === 'function') {
          browserWindow.cancelIdleCallback(idleHandle);
        }
      };
    }

    const timeoutId = window.setTimeout(() => {
      void loadThreadDetail();
    }, 350);
    return () => window.clearTimeout(timeoutId);
  }, [isSendOnlyMode, messages.length]);

  const triggerSyncMutation = useMutation({
    mutationFn: async () => {
      if (!effectiveConnectorId || isSendOnlyMode) {
        return;
      }
      const mailbox = folder || 'INBOX';
      await api.sync.trigger(effectiveConnectorId, mailbox, false, false);
    },
    onSuccess: () => {
      if (effectiveConnectorId) {
        queryClient.invalidateQueries({ queryKey: ['syncStates', effectiveConnectorId], refetchType: 'active' });
      }
      queryClient.invalidateQueries({ queryKey: activeMessagesQueryKey, refetchType: 'active' });
    },
  });

  const bulkActionMutation = useMutation({
    mutationFn: (data: MessagePatch) => api.messages.bulkUpdate(Array.from(selectedMessageIds), { ...data, scope: 'single' }),
    onMutate: async (data: MessagePatch) => {
      await queryClient.cancelQueries({
        predicate: (query) => isScopedMessageQuery(query.queryKey),
      });
      const snapshots = queryClient.getQueriesData<MessagesQueryResult>({
        predicate: (query) => isScopedMessageQuery(query.queryKey),
      });
      const ids = Array.from(selectedMessageIds);
      for (const [key, snapshot] of snapshots) {
        const queryKey = Array.isArray(key) ? key : [];
        const removeFromStarredOnUnstar = isStarredFolderToken(queryKey[2]);
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
      queryClient.invalidateQueries({ queryKey: activeMessagesQueryKey, refetchType: 'active' });
      setSelectedMessageIds(new Set());
    }
  });

  const markAsReadMutation = useMutation({
    mutationFn: (messageId: string) => api.messages.update(messageId, { isRead: true, scope: 'single' }),
    onMutate: async (messageId: string) => {
      await queryClient.cancelQueries({
        predicate: (query) => isScopedMessageQuery(query.queryKey),
      });
      const snapshots = queryClient.getQueriesData<MessagesQueryResult>({
        predicate: (query) => isScopedMessageQuery(query.queryKey),
      });
      for (const [key, data] of snapshots) {
        const queryKey = Array.isArray(key) ? key : [];
        const removeFromStarredOnUnstar = isStarredFolderToken(queryKey[2]);
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
      queryClient.invalidateQueries({ queryKey: activeMessagesQueryKey, refetchType: 'active' });
    }
  });

  useEffect(() => {
    if (isSendOnlyMode) {
      return;
    }
    if (selectedThreadId) {
      const msg = messages.find(m => (m.threadId || m.id) === selectedThreadId);
      if (msg && !msg.isRead && !markReadInFlightRef.current.has(msg.id)) {
        markReadInFlightRef.current.add(msg.id);
        markAsReadMutation.mutate(msg.id, {
          onSettled: () => {
            markReadInFlightRef.current.delete(msg.id);
          },
        });
      }
    }
  }, [isSendOnlyMode, selectedThreadId, messages, markAsReadMutation]);

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
  }, [isSendOnlyMode, setSelectedMessageIds]);

  const commitSearch = useCallback((nextQuery: string) => {
    dispatchRouteEvent({ type: 'set-query', query: nextQuery });
  }, [dispatchRouteEvent]);

  const handleSearchSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    commitSearch(searchInput);
  };

  const setPage = (p: number) => {
    dispatchRouteEvent({ type: 'set-page', page: p });
  };

  const formatDate = useCallback((dateStr: string | null) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (isToday(date)) return format(date, 'h:mm a');
    if (isThisYear(date)) return format(date, 'MMM d');
    return format(date, 'MM/dd/yy');
  }, []);

  const stripEmailFromName = useCallback((value: string) =>
    value
      .replace(/<[^>]*>/g, ' ')
      .replace(/\([^)]*@[^)]*\)/g, ' ')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ')
      .replace(/['"]/g, '')
      .replace(/\s+/g, ' ')
      .trim(), []);

  const parseFromHeader = useCallback((header: string | null) => {
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
  }, [stripEmailFromName]);

  const userEmails = useMemo(
    () => new Set((connectors ?? []).map((connector) => String(connector.emailAddress ?? '').toLowerCase()).filter(Boolean)),
    [connectors],
  );

  const participantDisplayById = useMemo(() => {
    const byId = new Map<string, string>();
    const getDisplayName = (header: string) => {
      const parsed = parseFromHeader(header);
      if (userEmails.has(parsed.email.toLowerCase())) return 'me';
      return parsed.name;
    };

    for (const msg of messages) {
      if (!msg.participants || msg.participants.length === 0) {
        byId.set(msg.id, getDisplayName(msg.fromHeader || ''));
        continue;
      }

      const names = msg.participants.map((participant) => getDisplayName(participant));
      const uniqueNames: string[] = [];
      const seen = new Set<string>();
      for (const name of names) {
        if (!seen.has(name)) {
          uniqueNames.push(name);
          seen.add(name);
        }
      }
      uniqueNames.sort((left, right) => {
        if (left === 'me') return -1;
        if (right === 'me') return 1;
        return left.localeCompare(right);
      });
      byId.set(msg.id, uniqueNames.join(', '));
    }
    return byId;
  }, [messages, parseFromHeader, userEmails]);

  const formattedDateById = useMemo(() => {
    const byId = new Map<string, string>();
    for (const msg of messages) {
      byId.set(msg.id, formatDate(msg.receivedAt));
    }
    return byId;
  }, [formatDate, messages]);

  const handleUpdateMessage = useCallback((messageId: string, data: MessagePatch) => {
    if (isSendOnlyMode) {
      return;
    }
    updateMessageMutation.mutate({ messageId, data });
  }, [isSendOnlyMode, updateMessageMutation]);

  const handleSelectThread = useCallback((threadId: string) => {
    void loadThreadDetail();
    dispatchRouteEvent({ type: 'open-thread', threadId });
  }, [dispatchRouteEvent]);

  const handlePrefetchThread = useCallback((threadId: string) => {
    if (isSendOnlyMode) {
      return;
    }
    void loadThreadDetail();
    void queryClient.prefetchQuery({
      queryKey: ['thread', threadId, effectiveConnectorId ?? 'all'],
      queryFn: ({ signal }) => api.messages.getThread(threadId, effectiveConnectorId, signal),
      staleTime: 15_000,
    });
  }, [effectiveConnectorId, isSendOnlyMode, queryClient]);

  if (loadingConnectors) {
    return <div className="flex-1 flex items-center justify-center bg-bg-card"><Loader2 className="w-6 h-6 animate-spin text-text-secondary" /></div>;
  }

  if (!isSendOnlyMode && !connectors?.length) {
    return <EmptyState icon={LayoutPanelLeft} title="Welcome to simpleMail" description="Connect an account to get started." actionText="Add account" actionPath="/settings/connectors/new?type=incoming" />;
  }

  const bulkToolbar = (
    <div className="h-12 border-b border-border/60 flex items-center px-3 gap-2 bg-accent shrink-0 animate-in slide-in-from-top-1 duration-200" style={{ color: 'var(--accent-contrast)' }}>
      <button onClick={toggleSelectAll} className="p-1.5 hover:bg-black/10 rounded">
        {selectedMessageIds.size === messages.length ? <CheckSquare className="w-4.5 h-4.5" /> : <Square className="w-4.5 h-4.5" />}
      </button>
      {!isMobile && <div className="text-xs font-bold mr-2">{selectedMessageIds.size} selected</div>}
      <div className="h-4 w-px bg-current opacity-20 mx-1" />
      <button onClick={() => bulkActionMutation.mutate({ delete: true })} className="p-2 hover:bg-red-500/20 rounded-md" title="Delete"><Trash2 className="w-4 h-4" /></button>
      <button onClick={() => bulkActionMutation.mutate({ isRead: true })} className="p-2 hover:bg-black/10 rounded-md" title="Mark as Read"><MailOpen className="w-4 h-4" /></button>
      <button onClick={() => bulkActionMutation.mutate({ isRead: false })} className="p-2 hover:bg-black/10 rounded-md" title="Mark as Unread"><MailIcon className="w-4 h-4" /></button>
      <div className="flex-1" />
      <button onClick={() => setSelectedMessageIds(new Set())} className="p-1.5 hover:bg-black/10 rounded"><X className="w-4 h-4" /></button>
    </div>
  );
  const startRange = offset + 1;
  const endRange = Math.min(offset + messages.length, totalCount);
  const paginationUI = (
    <div className="flex items-center gap-4 px-2 shrink-0">
      {!isMobile && <div className="text-xs text-text-secondary font-semibold whitespace-nowrap opacity-70">{totalCount > 0 ? `${startRange}-${endRange} of ${totalCount}` : '0-0 of 0'}</div>}
      <div className="flex items-center gap-2 md:gap-0.5">
        <button
          onClick={() => setPage(page - 1)}
          disabled={page <= 1}
          className={`${isMobile ? 'p-3' : 'p-1.5'} hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary disabled:opacity-30 transition-colors`}
        >
          <ChevronLeft className={`${isMobile ? 'w-6 h-6' : 'w-4 h-4'}`} />
        </button>
        <button
          onClick={() => setPage(page + 1)}
          disabled={endRange >= totalCount}
          className={`${isMobile ? 'p-3' : 'p-1.5'} hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary disabled:opacity-30 transition-colors`}
        >
          <ChevronRight className={`${isMobile ? 'w-6 h-6' : 'w-4 h-4'}`} />
        </button>
      </div>
    </div>
  );
  const threadDetailFallback = <div className="flex items-center justify-center h-32"><Loader2 className="w-6 h-6 animate-spin text-text-secondary" /></div>;

  if (layoutMode === 'list' && selectedThreadId) {
    return (
      <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-bg-card animate-in fade-in slide-in-from-right-2 duration-200 overflow-y-auto custom-scrollbar">
        <div className="h-14 md:h-11 border-b border-border/60 flex items-center bg-bg-card shrink-0 sticky top-0 z-40 px-4">
          <button
            onClick={() => dispatchRouteEvent({ type: 'close-thread' })}
            className="flex items-center gap-1.5 -ml-1 p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary transition-colors"
          >
            <ChevronLeft className="w-6 h-6 md:w-4 md:h-4" />
            <span className="text-sm font-bold text-text-primary">Back</span>
          </button>
        </div>
        <div className="flex-1 flex flex-col">
          {isSendOnlyMode
            ? (selectedSendOnlyMessage
              ? <SendOnlyMessageDetail message={selectedSendOnlyMessage} />
              : <div className="flex-1 flex items-center justify-center text-sm text-text-secondary">Message not found.</div>)
            : (
              <Suspense fallback={threadDetailFallback}>
                <ThreadDetail threadId={selectedThreadId} connectorId={effectiveConnectorId} onActionComplete={() => { }} />
              </Suspense>
            )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg-card">
      {selectedMessageIds.size > 0 && !isSendOnlyMode ? bulkToolbar : (
        <div className="h-12 md:h-11 border-b border-border/60 flex items-center px-3 gap-2 shrink-0 bg-bg-card relative">
          {!isSendOnlyMode && (
            <div className="shrink-0">
              <button
                onClick={toggleSelectAll}
                className={`${isMobile ? 'p-2.5' : 'p-2'} hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary transition-colors`}
              >
                <Square className={`${isMobile ? 'w-5 h-5' : 'w-4.5 h-4.5'} opacity-70`} />
              </button>
            </div>
          )}
          <div className="relative flex-1 max-w-2xl mx-auto">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary opacity-70" />
            <form onSubmit={handleSearchSubmit}>
              <input
                type="text"
                placeholder="Search mail"
                className="w-full bg-black/[0.03] dark:bg-white/[0.05] border-none rounded-lg pl-10 pr-10 py-2 text-sm text-text-primary focus:bg-transparent focus:ring-1 focus:ring-accent transition-all placeholder:text-text-secondary/60"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </form>
            {searchInput && (
              <button
                onClick={() => { setSearchInput(''); handleSearchSubmit(); }}
                className={`absolute right-2 top-1/2 -translate-y-1/2 ${isMobile ? 'p-2' : 'p-1.5'} hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary transition-colors`}
              >
                <X className={`${isMobile ? 'w-5 h-5' : 'w-4 h-4'}`} />
              </button>
            )}
          </div>
          <div className="hidden md:flex flex-1" />
          {layoutMode === 'list' && paginationUI}
          {!isSendOnlyMode && !isMobile && (
            <button
              onClick={() => triggerSyncMutation.mutate()}
              className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary disabled:opacity-30 transition-colors"
              disabled={triggerSyncMutation.isPending}
              title="Run full sync"
            >
              <RefreshCw className={`w-4 h-4 ${triggerSyncMutation.isPending ? 'animate-spin' : ''}`} />
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
              <div className="p-12 text-center text-text-secondary opacity-70 italic text-sm">No messages found.</div>
            ) : (
              <div className={layoutMode === 'columns' ? 'divide-y divide-border/20' : ''}>
                {messages.map((msg) =>
                  layoutMode === 'columns' ? (
                    <InboxColumnItem
                      key={msg.id}
                      msg={msg}
                      selectedThreadId={selectedThreadId}
                      isSelected={selectedMessageIds.has(msg.id)}
                      onSelect={handleSelectThread}
                      onPrefetchThread={handlePrefetchThread}
                      onToggleSelect={toggleSelectMessage}
                      onUpdateMessage={handleUpdateMessage}
                      participants={participantDisplayById.get(msg.id) ?? 'Unknown'}
                      formattedDate={formattedDateById.get(msg.id) ?? ''}
                      disableActions={isSendOnlyMode}
                    />
                  ) : (
                    <InboxListItem
                      key={msg.id}
                      msg={msg}
                      selectedThreadId={selectedThreadId}
                      isSelected={selectedMessageIds.has(msg.id)}
                      onSelect={handleSelectThread}
                      onPrefetchThread={handlePrefetchThread}
                      onToggleSelect={toggleSelectMessage}
                      onUpdateMessage={handleUpdateMessage}
                      participants={participantDisplayById.get(msg.id) ?? 'Unknown'}
                      formattedDate={formattedDateById.get(msg.id) ?? ''}
                      disableActions={isSendOnlyMode}
                      isMobile={isMobile}
                    />
                  )
                )}
              </div>
            )}
            {(layoutMode === 'columns' || isMobile) && totalCount > PAGE_SIZE && <div className="p-4 border-t border-border/20 flex justify-center bg-bg-card">{paginationUI}</div>}
          </div>
        </div>

        {layoutMode === 'columns' && !isMobile && (
          <div className="flex-1 flex flex-col min-w-0 bg-black/[0.02] dark:bg-white/[0.02] overflow-y-auto custom-scrollbar">
            {isSendOnlyMode
              ? (selectedSendOnlyMessage
                ? <SendOnlyMessageDetail message={selectedSendOnlyMessage} />
                : <div className="flex-1 flex flex-col items-center justify-center text-text-secondary opacity-60"><Mail className="w-12 h-12 mb-2 stroke-1" /><p className="text-sm font-medium">Select a sent/outbox message</p><p className="text-xs mt-1">Responses will not appear without an IMAP inbox.</p></div>)
              : (selectedThreadId
                ? (
                  <Suspense fallback={threadDetailFallback}>
                    <ThreadDetail threadId={selectedThreadId} connectorId={effectiveConnectorId} onActionComplete={() => { }} />
                  </Suspense>
                )
                : <div className="flex-1 flex flex-col items-center justify-center text-text-secondary opacity-70"><Mail className="w-12 h-12 mb-2 stroke-1" /><p className="text-sm font-medium">Select a message to read</p></div>)
            }
          </div>
        )}
      </div>

      {isMobile && !selectedThreadId && (
        <button
          onClick={() => setIsComposeOpen(true)}
          className="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-accent shadow-xl flex items-center justify-center text-white active:scale-90 transition-transform z-40"
          style={{ color: 'var(--accent-contrast)' }}
          title="Compose"
        >
          <PenBox className="w-6 h-6" />
        </button>
      )}

      {isComposeOpen && (
        <Suspense fallback={null}>
          <ComposeModal onClose={() => setIsComposeOpen(false)} />
        </Suspense>
      )}
    </div>
  );
};

export default InboxView;
