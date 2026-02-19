import { useMemo, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import ComposeModal from '../components/ComposeModal';
import { format } from 'date-fns';
import { sanitizeEmailHtml } from '../services/htmlSanitizer';
import {
  ChevronLeft,
  Loader2,
  Star,
  Mail,
  MailOpen,
  Download,
  Reply,
  ReplyAll,
  Forward,
  CornerUpLeft,
} from 'lucide-react';

import type { MessageRecord } from '../types/index';
import { buildReplyReferencesHeader, normalizeMessageIdHeader, orderThreadMessages } from '../services/threading';
type MessagesQueryResult = { messages: MessageRecord[]; totalCount: number };

const isStarredFolderToken = (value: unknown) => String(value ?? '').trim().toUpperCase().includes('STARRED');

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

const parseEmailFromHeader = (header: string | null): string => {
  if (!header) return '';
  const angleMatch = header.match(/<([^>]+)>/);
  return angleMatch?.[1]?.trim() || header.trim();
};

const makeReplySubject = (subject: string | null, mode: 'reply' | 'replyAll' | 'forward') => {
  const base = subject || '(no subject)';
  if (mode === 'forward') {
    return base.match(/^fwd?:?/i) ? base : `Fwd: ${base}`;
  }
  return base.match(/^re:/i) ? base : `Re: ${base}`;
};

const splitAddressHeader = (header: string | null | undefined): string[] => {
  if (!header) return [];
  return header
    .split(',')
    .map((entry) => parseEmailFromHeader(entry))
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const sortableTimestamp = (value: string | null | undefined) => {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

const quoteForReply = (text: string): string => {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
};

const makeInitialBodyText = (message: MessageRecord, mode: 'reply' | 'replyAll' | 'forward'): string => {
  const sentAt = message.receivedAt ? format(new Date(message.receivedAt), 'PPP p') : 'an earlier date';
  const sourceText = (message.bodyText || message.snippet || '').trim();

  if (mode === 'forward') {
    const ccHeader = message.ccHeader ? `\nCc: ${message.ccHeader}` : '';
    const bccHeader = message.bccHeader ? `\nBcc: ${message.bccHeader}` : '';
    return `\n\n---------- Forwarded message ----------\nFrom: ${message.fromHeader || ''}\nDate: ${sentAt}\nSubject: ${message.subject || '(no subject)'}\nTo: ${message.toHeader || ''}${ccHeader}${bccHeader}\n\n${sourceText}`;
  }

  const quoted = quoteForReply(sourceText);
  return `\n\nOn ${sentAt}, ${message.fromHeader || 'Unknown sender'} wrote:\n${quoted}`;
};

const ThreadView = () => {
  const { threadId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const connectorId = searchParams.get('connectorId') || undefined;

  const [replyContext, setReplyContext] = useState<{
    open: boolean;
    to: string;
    cc: string;
    bcc: string;
    subject: string;
    bodyText: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
  } | null>(null);

  const { data: messages, isLoading } = useQuery({
    queryKey: ['thread', threadId, connectorId ?? 'all'],
    queryFn: () => api.messages.getThread(threadId!),
    enabled: !!threadId,
    staleTime: 30_000,
  });

  const updateMutation = useMutation({
    mutationFn: (vars: { messageId: string; data: { delete?: boolean; isRead?: boolean; isStarred?: boolean } }) =>
      api.messages.update(vars.messageId, { ...vars.data, scope: 'single' }),
    onMutate: async (vars) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ['thread', threadId, connectorId ?? 'all'] }),
        queryClient.cancelQueries({ queryKey: ['messages'] }),
      ]);
      const previousThread = queryClient.getQueryData<MessageRecord[]>(['thread', threadId, connectorId ?? 'all']);
      const previousMessages = queryClient.getQueriesData<MessagesQueryResult>({ queryKey: ['messages'] });
      queryClient.setQueryData<MessageRecord[]>(
        ['thread', threadId, connectorId ?? 'all'],
        (current) => applyThreadPatch(current, vars.messageId, vars.data),
      );
      for (const [key, data] of previousMessages) {
        const queryKey = Array.isArray(key) ? key : [];
        const removeFromStarredOnUnstar = isStarredFolderToken(queryKey[1]);
        queryClient.setQueryData<MessagesQueryResult>(
          key,
          applyMessageListPatch(data, vars.messageId, vars.data, { removeFromStarredOnUnstar }),
        );
      }
      return { previousThread, previousMessages };
    },
    onError: (_error, _vars, context) => {
      if (context?.previousThread) {
        queryClient.setQueryData(['thread', threadId, connectorId ?? 'all'], context.previousThread);
      }
      for (const [key, data] of context?.previousMessages ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      queryClient.invalidateQueries({ queryKey: ['thread', threadId, connectorId ?? 'all'] });
    },
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
  const threadSubject = newestMessage?.subject || '(no subject)';
  const threadConversationId = threadId || '';

  const openReplyComposer = (mode: 'reply' | 'replyAll' | 'forward', message: MessageRecord | null) => {
    if (!message) return;

    const senderEmail = parseEmailFromHeader(message.fromHeader);
    const cc = mode === 'replyAll'
      ? Array.from(
          new Set(
            [...splitAddressHeader(message.toHeader), ...splitAddressHeader(message.ccHeader)]
              .filter((entry) => entry.toLowerCase() !== senderEmail.toLowerCase()),
          ),
        ).join(', ')
      : '';

    setReplyContext({
      open: true,
      to: mode === 'forward' ? '' : senderEmail,
      cc: mode === 'replyAll' ? cc : '',
      bcc: '',
      subject: makeReplySubject(message.subject, mode),
      bodyText: makeInitialBodyText(message, mode),
      threadId: mode === 'forward' ? undefined : threadConversationId,
      inReplyTo: mode === 'forward' ? undefined : (normalizeMessageIdHeader(message.messageId) ?? undefined),
      references: mode === 'forward' ? undefined : buildReplyReferencesHeader(message.referencesHeader, message.messageId),
    });
  };

  if (isLoading) return (
    <div className="flex-1 flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-text-secondary" />
    </div>
  );

  return (
    <div className="flex-1 flex flex-col h-full bg-white overflow-hidden">
      <div className="h-14 border-b border-border flex items-center px-4 gap-4 shrink-0 bg-bg-card">
        <button onClick={() => navigate(-1)} className="p-1.5 hover:bg-black/5 rounded-md text-text-secondary">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-bold text-text-primary truncate flex-1">
          {threadSubject}
        </h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => newestMessage && updateMutation.mutate({ messageId: newestMessage.id, data: { isStarred: !newestMessage.isStarred } })}
            className="p-1.5 hover:bg-black/5 rounded-md text-text-secondary"
          >
            <Star className={`w-4 h-4 ${newestMessage?.isStarred ? 'fill-yellow-400 text-yellow-400' : ''}`} />
          </button>
          <button
            onClick={() => newestMessage && updateMutation.mutate({ messageId: newestMessage.id, data: { isRead: !newestMessage.isRead } })}
            className="p-1.5 hover:bg-black/5 rounded-md text-text-secondary"
            title={newestMessage?.isRead ? 'Mark as Unread' : 'Mark as Read'}
          >
            {newestMessage?.isRead ? <Mail className="w-4 h-4" /> : <MailOpen className="w-4 h-4" />}
          </button>
          <button
            onClick={() => newestMessage && api.messages.downloadRaw(newestMessage.id)}
            className="p-1.5 hover:bg-black/5 rounded-md text-text-secondary"
            title="Download raw message"
          >
            <Download className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-[#fbfbfa] p-8 pt-12">
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="pb-6 mb-8">
            <h1 className="text-3xl md:text-4xl font-extrabold text-text-primary tracking-tight leading-tight">
              {threadSubject}
            </h1>
          </div>

          {orderedThreadNodes.map((node) => {
            const msg = node.message;
            const depthOffsetPx = Math.min(node.depth, 6) * 20;
            const safeBodyHtml = msg.bodyHtml ? sanitizeEmailHtml(msg.bodyHtml) : null;
            return (
            <div key={msg.id} className={`bg-white border border-border rounded-lg shadow-sm overflow-hidden ${msg.id === newestMessageId ? 'ring-1 ring-accent/15' : ''}`} style={depthOffsetPx > 0 ? { marginLeft: `${depthOffsetPx}px` } : undefined}>
              <div className="px-4 py-3 border-b border-border bg-sidebar/30 flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-accent/10 text-accent flex items-center justify-center font-bold text-xs">
                    {msg.fromHeader?.charAt(0) || '?'}
                  </div>
                  <div>
                    <div className="text-sm font-bold">{msg.fromHeader}</div>
                    <div className="text-[11px] text-text-secondary">to {msg.toHeader}</div>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-[11px] text-text-secondary">
                    {msg.receivedAt && format(new Date(msg.receivedAt), 'MMM d, yyyy h:mm a')}
                  </div>
                  <button
                    onClick={() => openReplyComposer('reply', msg)}
                    className="p-1 hover:bg-black/5 rounded text-text-secondary"
                    title="Reply"
                  >
                    <Reply className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => openReplyComposer('replyAll', msg)}
                    className="p-1 hover:bg-black/5 rounded text-text-secondary"
                    title="Reply all"
                  >
                    <ReplyAll className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => openReplyComposer('forward', msg)}
                    className="p-1 hover:bg-black/5 rounded text-text-secondary"
                    title="Forward"
                  >
                    <Forward className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="p-6 text-sm leading-relaxed whitespace-pre-wrap font-sans">
                {safeBodyHtml ? (
                  <div dangerouslySetInnerHTML={{ __html: safeBodyHtml }} className="mail-content" />
                ) : (
                  msg.bodyText
                )}
              </div>
            </div>
            );
          })}

          <div className="pt-8 flex justify-center">
            <button
              onClick={() => openReplyComposer('reply', newestMessage)}
              className="flex items-center gap-2 px-6 py-2 border border-border rounded-full text-sm font-bold text-text-secondary hover:bg-sidebar hover:text-text-primary transition-all"
            >
              <CornerUpLeft className="w-4 h-4" />
              Reply to conversation
            </button>
          </div>
        </div>
      </div>

      {replyContext?.open && (
        <ComposeModal
          onClose={() => setReplyContext(null)}
          initialTo={replyContext.to}
          initialCc={replyContext.cc}
          initialBcc={replyContext.bcc}
          initialSubject={replyContext.subject}
          initialBodyText={replyContext.bodyText}
          initialThreadId={replyContext.threadId}
          initialInReplyTo={replyContext.inReplyTo}
          initialReferences={replyContext.references}
        />
      )}
    </div>
  );
};

export default ThreadView;
