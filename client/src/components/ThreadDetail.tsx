import { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { format, isToday, isYesterday } from 'date-fns';
import ComposeModal from './ComposeModal';
import {
  Loader2,
  Paperclip,
  Download,
  RefreshCw,
  Reply,
  Forward,
  Star,
  ChevronDown,
  Trash2,
  MailOpen,
  Mail as MailIcon,
  CornerUpLeft,
  AlertCircle,
  ExternalLink,
  UserCircle
} from 'lucide-react';
import type { AttachmentRecord, MessageRecord } from '../types/index';
import Avatar from './Avatar';
import { sanitizeEmailHtml } from '../services/htmlSanitizer';
import { buildReplyReferencesHeader, normalizeMessageIdHeader, orderThreadMessages } from '../services/threading';

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

const parseFromHeader = (header: string | null) => {
  if (!header) return { name: 'Unknown', email: '' };
  const match = header.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim() || match[2], email: match[2] };
  }
  return { name: header, email: '' };
};

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

  const { data: messages, isLoading, isError } = useQuery({
    queryKey: threadQueryKey,
    queryFn: () => api.messages.getThread(threadId),
    enabled: !!threadId,
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
        queryClient.cancelQueries({ queryKey: ['messages'] }),
      ]);
      const previousThread = queryClient.getQueryData<MessageRecord[]>(threadQueryKey);
      const previousMessages = queryClient.getQueriesData<MessagesQueryResult>({ queryKey: ['messages'] });
      queryClient.setQueryData<MessageRecord[]>(
        threadQueryKey,
        (current) => applyThreadPatch(current, payload.messageId, payload.data),
      );
      for (const [key, data] of previousMessages) {
        const queryKey = Array.isArray(key) ? key : [];
        const removeFromStarredOnUnstar = isStarredFolderToken(queryKey[1]);
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
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      queryClient.invalidateQueries({ queryKey: threadQueryKey });
      onActionComplete?.();
    }
  });

  const { data: identities } = useQuery({
    queryKey: ['identities'],
    queryFn: () => api.identities.list(),
  });

  const openComposer = (mode: ComposeMode, message: MessageRecord) => {
    const from = parseEmails(message.fromHeader)[0] ?? '';
    const toRecipients = parseEmails(message.toHeader);
    const ccRecipients = parseEmails(message.ccHeader ?? null);
    const inReplyTo = normalizeMessageIdHeader(message.messageId) ?? undefined;
    const references = buildReplyReferencesHeader(message.referencesHeader, message.messageId);

    // Try to find the best identity to reply FROM
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
    <div className="flex flex-col h-full bg-bg-card overflow-hidden font-sans">
      <div className="h-11 border-b border-border/60 flex items-center px-4 gap-2 shrink-0 bg-bg-card">
        <div className="flex items-center gap-1 border-r border-border/40 pr-2 mr-1">
          <button onClick={() => updateMutation.mutate({ messageId: newestMessage.id, data: { delete: true } })} className="p-1.5 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 rounded-md text-text-secondary transition-colors" title="Delete"><Trash2 className="w-4 h-4" /></button>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => updateMutation.mutate({ messageId: newestMessage.id, data: { isRead: !newestMessage.isRead } })} className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary transition-colors" title={newestMessage.isRead ? "Mark as Unread" : "Mark as Read"}>{newestMessage.isRead ? <MailIcon className="w-4 h-4" /> : <MailOpen className="w-4 h-4" />}</button>
        </div>
        <div className="flex-1 min-w-0" />
        <div className="flex items-center gap-1 text-text-secondary">
          <button className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-md" onClick={() => { void api.messages.viewRaw(newestMessage.id); }}><ExternalLink className="w-4 h-4" /></button>
        </div>
      </div>

      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto bg-sidebar/30 p-4 pt-6 custom-scrollbar">
        <div className="w-full max-w-4xl mx-auto space-y-4 pb-32">
          <div className="px-1 mb-8 pb-6 border-b border-border/40">
            <h1 className="text-2xl md:text-3xl font-extrabold text-text-primary tracking-tight leading-tight">
              {newestMessage.subject || '(no subject)'}
            </h1>
          </div>
          <div className="space-y-4">
            {orderedThreadNodes.map((node) => {
              const msg = node.message;
              const isNewest = msg.id === newestMessageId;
              const depthOffsetPx = Math.min(node.depth, 6) * 20;
              return (
                <div key={msg.id} ref={isNewest ? newestMessageRef : null} style={depthOffsetPx > 0 ? { marginLeft: `${depthOffsetPx}px` } : undefined}>
                  <MessageItem
                    msg={msg}
                    depth={node.depth}
                    defaultExpanded={isNewest}
                    onReply={() => openComposer('reply', msg)}
                    onToggleStar={() => updateMutation.mutate({ messageId: msg.id, data: { isStarred: !msg.isStarred } })}
                  />
                </div>
              );
            })}
          </div>
          <div className="pt-8 flex justify-center gap-3">
            <button onClick={() => openComposer('replyAll', newestMessage)} className="flex items-center gap-2 px-5 py-1.5 bg-bg-card border border-border rounded-md text-size-sm font-semibold text-text-secondary hover:text-text-primary hover:border-accent/40 transition-all active:scale-[0.98] shadow-xs"><CornerUpLeft className="w-3.5 h-3.5 text-accent" />Reply all</button>
            <button onClick={() => openComposer('forward', newestMessage)} className="flex items-center gap-2 px-5 py-1.5 bg-bg-card border border-border rounded-md text-size-sm font-semibold text-text-secondary hover:text-text-primary hover:border-accent/40 transition-all active:scale-[0.98] shadow-xs"><Forward className="w-3.5 h-3.5 text-text-secondary" />Forward</button>
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

const MessageItem = ({ msg, depth, defaultExpanded, onReply, onToggleStar }: { msg: MessageRecord; depth: number, defaultExpanded: boolean, onReply: () => void, onToggleStar: () => void }) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [showDetails, setShowDetails] = useState(false);
  const safeBodyHtml = useMemo(
    () => (msg.bodyHtml ? sanitizeEmailHtml(msg.bodyHtml) : null),
    [msg.bodyHtml],
  );
  const from = parseFromHeader(msg.fromHeader);
  const cc = msg.ccHeader || null;
  const bcc = msg.bccHeader || null;

  return (
    <div className={`bg-bg-card border border-border rounded-md shadow-xs overflow-hidden transition-all ${depth > 0 ? 'border-l-4 border-l-accent/20' : ''} ${!isExpanded ? 'hover:border-accent/30 cursor-pointer' : ''}`}>
      <div className={`px-4 py-3 flex items-center justify-between transition-colors relative ${isExpanded ? 'border-b border-border/40 bg-black/[0.01] dark:bg-white/[0.01]' : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.02]'}`}>
        <div className="absolute inset-0 cursor-pointer z-0" onClick={() => setIsExpanded(!isExpanded)} />
        <div className="flex items-center gap-3 flex-1 min-w-0 z-10 pointer-events-none">
          <Avatar text={from.name} fallbackIcon={UserCircle} size="md" className="pointer-events-auto" />
          <div className="min-w-0 flex-1 pointer-events-auto">
            <div className="flex items-baseline gap-2 overflow-hidden flex-1">
              <span className="text-sm font-semibold text-text-primary shrink-0 max-w-[300px] truncate cursor-text">{from.name}</span>
              {isExpanded && from.email && <span className="text-[11px] text-text-secondary opacity-60 truncate font-normal cursor-text">{from.email}</span>}
              {!isExpanded && <span className="text-[11px] text-text-secondary truncate font-normal opacity-50 ml-2 italic flex-1 min-w-0 cursor-text">— {msg.snippet}</span>}
            </div>
            {isExpanded && (
              <div className="flex flex-col">
                <div className="text-[11px] text-text-secondary mt-0.5 flex items-center gap-1 opacity-80 cursor-pointer hover:underline w-fit" onClick={(e) => { e.stopPropagation(); setShowDetails(!showDetails); }}>to {msg.toHeader}<ChevronDown className={`w-3 h-3 transition-transform ${showDetails ? 'rotate-180' : ''}`} /></div>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0 ml-4 z-10">
          <div className="text-[10px] text-text-secondary font-medium whitespace-nowrap opacity-60 uppercase tracking-tight cursor-text">
            {msg.receivedAt && (() => {
              const d = new Date(msg.receivedAt);
              if (isToday(d)) return format(d, 'h:mm a');
              if (isYesterday(d)) return 'Yesterday, ' + format(d, 'h:mm a');
              return format(d, 'MMM d, p');
            })()}
          </div>
          <div className="flex items-center gap-0.5 text-text-secondary">
            <button className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-md" onClick={(e) => { e.stopPropagation(); onToggleStar(); }}><Star className={`w-3.5 h-3.5 ${msg.isStarred ? 'fill-yellow-400 text-yellow-400' : ''}`} /></button>
            <button className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-md" onClick={(e) => { e.stopPropagation(); onReply(); }} title="Reply"><Reply className="w-3.5 h-3.5" /></button>
          </div>
        </div>
      </div>

      {isExpanded && showDetails && (
        <div className="px-4 py-3 bg-black/[0.02] dark:bg-white/[0.02] border-b border-border/40 animate-in slide-in-from-top-1 duration-200">
          <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[11px] ml-11">
            <span className="text-text-secondary font-semibold text-right opacity-60">from:</span>
            <span className="text-text-primary font-medium flex items-center gap-2"><span className="font-bold">{from.name}</span><span className="opacity-60">{from.email}</span></span>
            <span className="text-text-secondary font-semibold text-right opacity-60">to:</span><span className="text-text-primary font-medium">{msg.toHeader}</span>
            {cc && <><span className="text-text-secondary font-semibold text-right opacity-60">cc:</span><span className="text-text-primary font-medium">{cc}</span></>}
            {bcc && <><span className="text-text-secondary font-semibold text-right opacity-60">bcc:</span><span className="text-text-primary font-medium">{bcc}</span></>}
            <span className="text-text-secondary font-semibold text-right opacity-60">date:</span><span className="text-text-primary font-medium">{msg.receivedAt && format(new Date(msg.receivedAt), 'MMMM d, yyyy, h:mm a')}</span>
            <span className="text-text-secondary font-semibold text-right opacity-60">subject:</span><span className="text-text-primary font-medium">{msg.subject || '(no subject)'}</span>
          </div>
        </div>
      )}

      {isExpanded && (
        <>
          <div className="bg-white p-6 text-base leading-relaxed selection:bg-accent/10 text-[#222]">
            {safeBodyHtml ? (
              <div className="w-full min-w-0 overflow-hidden">
                <iframe
                  title={`msg-${msg.id}`}
                  scrolling="no"
                  srcDoc={`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; color: #222 !important; line-height: 1.5; margin: 0; padding: 0; padding-bottom: 24px; width: 100% !important; overflow: hidden !important; background-color: #ffffff !important; } img { max-width: 100%; height: auto; display: block; } table { max-width: 100% !important; height: auto !important; border-collapse: collapse; } a { color: #2383e2 !important; text-decoration: none; } a:hover { text-decoration: underline; }</style></head><body><div id="content-wrapper">${safeBodyHtml}</div></body></html>`}
                  className="w-full border-none transition-all duration-200"
                  sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
                  referrerPolicy="no-referrer"
                  onLoad={(e) => {
                    const iframe = e.currentTarget;
                    const updateHeight = () => {
                      if (iframe.contentWindow?.document.documentElement) {
                        const height = iframe.contentWindow.document.documentElement.scrollHeight;
                        iframe.style.height = height + 'px';
                      }
                    };
                    updateHeight();

                    // Real-time height updates as content (like images) loads
                    if (iframe.contentWindow && typeof window.ResizeObserver !== 'undefined') {
                      const win = iframe.contentWindow;
                      const observer = new window.ResizeObserver(updateHeight);
                      observer.observe(win.document.body);
                    }

                    setTimeout(updateHeight, 500);
                    setTimeout(updateHeight, 2000);
                  }}
                />
              </div>
            ) : <div className="whitespace-pre-wrap">{msg.bodyText}</div>}
          </div>
          <AttachmentList messageId={msg.id} />
        </>
      )}
    </div>
  );
};

const AttachmentList = ({ messageId }: { messageId: string }) => {
  const { data: attachments, isLoading } = useQuery({ queryKey: ['attachments', messageId], queryFn: () => api.messages.getAttachments(messageId), staleTime: 30_000 });
  if (isLoading || !attachments?.length) return null;
  return <div className="px-5 pb-5 pt-2 border-t border-border/40 bg-white"><div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">{attachments.map(att => <AttachmentItem key={att.id} messageId={messageId} attachment={att} />)}</div></div>;
};

const AttachmentItem = ({ messageId, attachment }: { messageId: string; attachment: AttachmentRecord }) => {
  const queryClient = useQueryClient();
  const scanMutation = useMutation({ mutationFn: () => api.messages.triggerScan(messageId, attachment.id), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['attachments', messageId] }) });
  const downloadMutation = useMutation({ mutationFn: () => api.attachments.download(attachment.id, attachment.filename || 'attachment') });
  const contentType = String(attachment.contentType || '').toLowerCase();
  const canPreviewInline = (contentType.startsWith('image/') && contentType !== 'image/svg+xml')
    || contentType === 'text/plain'
    || contentType === 'text/markdown'
    || contentType === 'text/csv'
    || contentType === 'application/pdf'
    || contentType.startsWith('audio/')
    || contentType.startsWith('video/');
  const handleOpenInNewTab = async () => {
    if (attachment.scanStatus === 'infected') {
      alert('Flagged as infected.');
      return;
    }
    if (!canPreviewInline) {
      alert('Preview is not supported for this file type.');
      return;
    }
    try {
      await api.attachments.preview(attachment.id, attachment.filename || 'attachment');
    } catch (error) {
      alert(`Preview failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };
  const handleDownload = async () => {
    if (attachment.scanStatus === 'infected') {
      alert('Flagged as infected.');
      return;
    }
    try {
      await downloadMutation.mutateAsync();
    } catch (error) {
      alert(`Download failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };
  return (
    <div className="flex items-center gap-2 p-1.5 bg-[#f8f9fa] border border-[#dadce0] rounded-lg group hover:border-accent/40 transition-all shadow-xs">
      <div className="w-7 h-7 rounded bg-white flex items-center justify-center shrink-0 border border-[#dadce0]"><Paperclip className="w-3.5 h-3.5 text-[#5f6368]" /></div>
      <div className="min-w-0 flex-1"><div className="text-[11px] font-bold text-[#1f1f1f] truncate" title={attachment.filename}>{attachment.filename}</div><div className="text-[9px] text-[#5f6368] flex items-center gap-1 uppercase tracking-tighter"><span>{(attachment.size / 1024).toFixed(0)}K</span></div></div>
      <div className="flex items-center gap-0.5">{['error', 'missing'].includes(attachment.scanStatus) && <button onClick={() => scanMutation.mutate()} className="p-1 hover:bg-black/5 rounded" title="Retry scan"><RefreshCw className="w-3 h-3" /></button>}{canPreviewInline && <button onClick={handleOpenInNewTab} disabled={attachment.scanStatus === 'infected'} className="p-1 hover:bg-black/5 rounded text-text-secondary disabled:opacity-30" title="Open in new tab"><ExternalLink className="w-3 h-3" /></button>}<button onClick={handleDownload} disabled={attachment.scanStatus === 'infected' || downloadMutation.isPending} className="p-1 hover:bg-accent/10 rounded text-accent disabled:opacity-30" title="Download">{downloadMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}</button></div>
    </div>
  );
};

export default ThreadDetail;
