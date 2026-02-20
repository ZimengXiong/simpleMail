import { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { format } from 'date-fns';
import ComposeModal from './ComposeModal';
import {
  Loader2,
  Reply,
  ReplyAll,
  Forward,
  Trash2,
  MailOpen,
  Mail as MailIcon,
  AlertCircle,
  ExternalLink,
} from 'lucide-react';
import type { MessageRecord } from '../types/index';
import { buildReplyReferencesHeader, normalizeMessageIdHeader, orderThreadMessages } from '../services/threading';
import { useMediaQuery } from '../services/layout';
import MessageItem from './threadDetail/MessageItem';

interface ThreadDetailProps {
  threadId: string;
  connectorId?: string;
  onActionComplete?: () => void;
}

type ComposeMode = 'reply' | 'replyAll' | 'forward';

interface ReplyContext {
  to: string;
  cc: string;
  subject: string;
  bodyText: string;
  identityId?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  initialFocus: 'to' | 'body';
}
type MessagesQueryResult = { messages: MessageRecord[]; totalCount: number };
const isStarredFolderToken = (value: unknown) => String(value ?? '').trim().toUpperCase().includes('STARRED');

const parseEmails = (header: string | null | undefined): string[] => {
  if (!header) return [];
  const matches = header.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
  return Array.from(new Set(matches.map(e => e.toLowerCase())));
};

const sortableTimestamp = (value: string | null | undefined) => {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

const makeReplySubject = (subject: string | null, mode: ComposeMode) => {
  const base = subject || '(no subject)';
  if (mode === 'forward') return /^fwd?:/i.test(base) ? base : `Fwd: ${base}`;
  return /^re:/i.test(base) ? base : `Re: ${base}`;
};

const buildQuotedBody = (message: MessageRecord, mode: ComposeMode) => {
  const dateLine = message.receivedAt ? format(new Date(message.receivedAt), 'PPP p') : 'unknown date';
  const body = (message.bodyText || message.snippet || '').trim();

  if (mode === 'forward') {
    const header = [
      '',
      '---------- Forwarded message ---------',
      `From: ${message.fromHeader || ''}`,
      `Date: ${dateLine}`,
      `Subject: ${message.subject || '(no subject)'}`,
      `To: ${message.toHeader || ''}`,
      '',
      ''
    ].join('\n');
    return header + body;
  }

  const header = `\n\nOn ${dateLine}, ${message.fromHeader || 'Unknown'} wrote:\n`;
  const quotedLines = body ? body.split('\n').map(line => `> ${line}`) : ['> '];
  return header + quotedLines.join('\n');
};

const applyThreadPatch = (
  current: MessageRecord[] | undefined,
  messageId: string,
  patch: { delete?: boolean; isRead?: boolean; isStarred?: boolean },
) => {
  if (!current) {
    return current;
  }
  if (patch.delete) {
    return current.filter((message) => message.id !== messageId);
  }
  return current.map((message) => {
    if (message.id !== messageId) {
      return message;
    }
    return {
      ...message,
      isRead: patch.isRead ?? message.isRead,
      isStarred: patch.isStarred ?? message.isStarred,
    };
  });
};

const applyMessageListPatch = (
  current: MessagesQueryResult | undefined,
  messageId: string,
  patch: { delete?: boolean; isRead?: boolean; isStarred?: boolean },
  options?: { removeFromStarredOnUnstar?: boolean },
) => {
  if (!current?.messages) {
    return current;
  }
  let removed = false;
  const nextMessages = current.messages
    .map((message) => {
      if (message.id !== messageId) {
        return message;
      }
      if (patch.delete || (options?.removeFromStarredOnUnstar === true && patch.isStarred === false)) {
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

const ThreadDetail = ({ threadId, connectorId, onActionComplete }: ThreadDetailProps) => {
  const queryClient = useQueryClient();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const newestMessageRef = useRef<HTMLDivElement>(null);
  const [replyContext, setReplyContext] = useState<ReplyContext | null>(null);
  const threadQueryKey = ['thread', threadId, connectorId ?? 'all'];
  const isMobile = useMediaQuery('(max-width: 768px)');
  const isScopedMessageQuery = (queryKey: readonly unknown[]) => {
    if (!Array.isArray(queryKey) || queryKey[0] !== 'messages') {
      return false;
    }
    const scope = queryKey[1];
    if (connectorId) {
      return scope === connectorId;
    }
    return !(typeof scope === 'string' && scope.startsWith('send-only:'));
  };

  const { data: messages, isLoading, isError } = useQuery({
    queryKey: threadQueryKey,
    queryFn: ({ signal }) => api.messages.getThread(threadId, connectorId, signal),
    enabled: !!threadId,
    staleTime: 30_000,
  });

  const orderedThreadNodes = useMemo(
    () => orderThreadMessages(messages ?? []),
    [messages],
  );

  const newestNode = useMemo(() => {
    if (orderedThreadNodes.length === 0) {
      return null;
    }
    return orderedThreadNodes.reduce((latest, node) => {
      const latestTs = sortableTimestamp(latest.message.receivedAt);
      const nodeTs = sortableTimestamp(node.message.receivedAt);
      return nodeTs > latestTs ? node : latest;
    });
  }, [orderedThreadNodes]);
  const newestMessage = newestNode?.message ?? null;
  const newestMessageId = newestMessage?.id ?? null;

  useEffect(() => {
    if (!isLoading && orderedThreadNodes.length > 0 && newestMessageRef.current && scrollContainerRef.current) {
      const timer = setTimeout(() => {
        if (newestMessageRef.current && scrollContainerRef.current) {
          scrollContainerRef.current.scrollTo({
            top: newestMessageRef.current.offsetTop - 20,
            behavior: 'smooth'
          });
        }
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [isLoading, orderedThreadNodes, threadId]);

  const updateMutation = useMutation({
    mutationFn: (payload: { messageId: string; data: { delete?: boolean; isRead?: boolean; isStarred?: boolean } }) =>
      api.messages.update(payload.messageId, { ...payload.data, scope: 'single' }),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: threadQueryKey }),
        queryClient.cancelQueries({
          predicate: (query) => isScopedMessageQuery(query.queryKey),
        }),
      ]);
      const previousThread = queryClient.getQueryData<MessageRecord[]>(threadQueryKey);
      const previousMessages = queryClient.getQueriesData<MessagesQueryResult>({
        predicate: (query) => isScopedMessageQuery(query.queryKey),
      });
      queryClient.setQueryData<MessageRecord[]>(
        threadQueryKey,
        (current) => applyThreadPatch(current, payload.messageId, payload.data),
      );
      for (const [key, data] of previousMessages) {
        const queryKey = Array.isArray(key) ? key : [];
        const removeFromStarredOnUnstar = isStarredFolderToken(queryKey[2]);
        queryClient.setQueryData<MessagesQueryResult>(
          key,
          applyMessageListPatch(data, payload.messageId, payload.data, { removeFromStarredOnUnstar }),
        );
      }
      return { previousThread, previousMessages };
    },
    onError: (_error, _payload, context) => {
      if (context?.previousThread) {
        queryClient.setQueryData(threadQueryKey, context.previousThread);
      }
      for (const [key, data] of context?.previousMessages ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        predicate: (query) => isScopedMessageQuery(query.queryKey),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({ queryKey: threadQueryKey, refetchType: 'active' });
      onActionComplete?.();
    }
  });

  const { data: identities } = useQuery({
    queryKey: ['identities'],
    queryFn: () => api.identities.list(),
    staleTime: 60_000,
  });

  const openComposer = (mode: ComposeMode, message: MessageRecord) => {
    const from = parseEmails(message.fromHeader)[0] ?? '';
    const toRecipients = parseEmails(message.toHeader);
    const ccRecipients = parseEmails(message.ccHeader ?? null);
    const inReplyTo = normalizeMessageIdHeader(message.messageId) ?? undefined;
    const references = buildReplyReferencesHeader(message.referencesHeader, message.messageId);

    const allRecipients = new Set([...toRecipients, ...ccRecipients].map(e => e.toLowerCase()));
    let bestIdentity = identities?.find(id => allRecipients.has(id.emailAddress.toLowerCase()));
    if (!bestIdentity && message.incomingConnectorId) {
      bestIdentity = identities?.find(id => id.sentToIncomingConnectorId === message.incomingConnectorId);
    }
    const identityId = bestIdentity?.id;

    if (mode === 'forward') {
      setReplyContext({
        to: '',
        cc: '',
        subject: makeReplySubject(message.subject, mode),
        bodyText: buildQuotedBody(message, mode),
        identityId,
        threadId: undefined,
        initialFocus: 'to'
      });
      return;
    }

    if (mode === 'reply') {
      setReplyContext({
        to: from,
        cc: '',
        subject: makeReplySubject(message.subject, mode),
        bodyText: buildQuotedBody(message, mode),
        identityId,
        threadId,
        inReplyTo,
        references,
        initialFocus: 'body'
      });
      return;
    }

    const excluded = new Set([from, bestIdentity?.emailAddress ?? ''].map((value) => value.toLowerCase()).filter(Boolean));
    const others = Array.from(new Set([...toRecipients, ...ccRecipients].filter((email) => !excluded.has(email.toLowerCase()))));
    setReplyContext({
      to: from,
      cc: others.join(', '),
      subject: makeReplySubject(message.subject, mode),
      bodyText: buildQuotedBody(message, mode),
      identityId,
      threadId,
      inReplyTo,
      references,
      initialFocus: 'body'
    });
  };

  if (isLoading) return <div className="flex-1 flex items-center justify-center bg-bg-card"><Loader2 className="w-6 h-6 animate-spin text-text-secondary" /></div>;
  if (isError || !messages || orderedThreadNodes.length === 0 || !newestMessage) return <div className="flex-1 flex flex-col items-center justify-center text-text-secondary p-8 text-center bg-bg-card"><AlertCircle className="w-12 h-12 mb-4 text-red-400 opacity-50" /><h3 className="text-base font-bold text-text-primary mb-1">Thread not found</h3></div>;

  return (
    <div className="flex flex-col min-h-full bg-bg-card font-sans">
      <div className="h-11 border-b border-border/60 flex items-center px-4 gap-2 shrink-0 bg-bg-card sticky top-0 z-30">
        <div className="flex items-center gap-1 border-r border-border/40 pr-2 -ml-2">
          <button
            onClick={() => updateMutation.mutate({ messageId: newestMessage.id, data: { delete: true } })}
            className="p-2 hover:bg-red-50 dark:hover:bg-red-900/20 text-text-secondary hover:text-red-500 rounded-md transition-colors"
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => updateMutation.mutate({ messageId: newestMessage.id, data: { isRead: !newestMessage.isRead } })}
            className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary transition-colors"
            title={newestMessage.isRead ? "Mark as Unread" : "Mark as Read"}
          >
            {newestMessage.isRead ? <MailIcon className="w-4 h-4" /> : <MailOpen className="w-4 h-4" />}
          </button>
        </div>
        <div className="flex-1 min-w-0" />
        <div className="flex items-center gap-1 text-text-secondary -mr-2">
          <button className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-md transition-colors" onClick={() => { void api.messages.viewRaw(newestMessage.id); }}><ExternalLink className="w-4 h-4" /></button>
        </div>
      </div>

      <div className="flex-1 bg-sidebar/30 p-2 md:p-4 pt-4 md:pt-6">
        <div className="w-full max-w-4xl mx-auto space-y-3 md:space-y-4 pb-32">
          <div className="px-2 mb-2 md:mb-4 pb-3 border-b border-border/40">
            <h1 className="text-xl md:text-3xl font-extrabold text-text-primary tracking-tight leading-tight">
              {newestMessage.subject || '(no subject)'}
            </h1>
          </div>
          <div className="space-y-3 md:space-y-4">
            {orderedThreadNodes.map((node) => {
              const msg = node.message;
              const isNewest = msg.id === newestMessageId;
              const depthOffsetPx = isMobile ? Math.min(node.depth, 2) * 8 : Math.min(node.depth, 6) * 20;
              return (
                <div key={msg.id} ref={isNewest ? newestMessageRef : null} style={depthOffsetPx > 0 ? { marginLeft: `${depthOffsetPx}px` } : undefined}>
                  <MessageItem
                    msg={msg}
                    depth={node.depth}
                    defaultExpanded={isNewest}
                    onReply={() => openComposer('reply', msg)}
                    onToggleStar={() => updateMutation.mutate({ messageId: msg.id, data: { isStarred: !msg.isStarred } })}
                    isMobile={isMobile}
                  />
                </div>
              );
            })}
          </div>
          <div className="pt-8 flex flex-col sm:flex-row justify-start gap-3 px-2 md:px-0">
            <button onClick={() => openComposer('reply', newestMessage)} className="btn-secondary px-6 py-2 font-bold">
              <Reply className="w-4 h-4 text-accent" />
              Reply
            </button>
            <button onClick={() => openComposer('replyAll', newestMessage)} className="btn-secondary px-6 py-2 font-bold">
              <ReplyAll className="w-4 h-4 text-accent" />
              Reply all
            </button>
            <button onClick={() => openComposer('forward', newestMessage)} className="btn-secondary px-6 py-2 font-bold">
              <Forward className="w-4 h-4 text-text-secondary" />
              Forward
            </button>
          </div>
        </div>
      </div>

      {replyContext && (
        <ComposeModal
          onClose={() => setReplyContext(null)}
          initialTo={replyContext.to}
          initialCc={replyContext.cc}
          initialSubject={replyContext.subject}
          initialBodyText={replyContext.bodyText}
          initialIdentityId={replyContext.identityId}
          initialThreadId={replyContext.threadId}
          initialInReplyTo={replyContext.inReplyTo}
          initialReferences={replyContext.references}
          initialFocus={replyContext.initialFocus}
        />
      )}
    </div>
  );
};

export default ThreadDetail;
