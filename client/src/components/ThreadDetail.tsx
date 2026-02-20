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
  ReplyAll,
  Forward,
  Star,
  ChevronDown,
  Trash2,
  MailOpen,
  Mail as MailIcon,
  AlertCircle,
  AlertTriangle,
  ExternalLink,
  UserCircle
} from 'lucide-react';
import type { AttachmentRecord, MessageRecord } from '../types/index';
import Avatar from './Avatar';
import { sanitizeEmailHtmlWithReport } from '../services/htmlSanitizer';
import { buildReplyReferencesHeader, normalizeMessageIdHeader, orderThreadMessages } from '../services/threading';
import { useMediaQuery } from '../services/layout';

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

const normalizeContentId = (value: unknown) =>
  String(value ?? '').replace(/[<>]/g, '').trim().toLowerCase();

const extractInlineCidReferences = (html: string | null | undefined) => {
  const references = new Set<string>();
  if (!html) {
    return references;
  }

  const cidRegex = /cid:\s*<?([^>"'\s)]+)>?/gi;
  let match: RegExpExecArray | null;
  while ((match = cidRegex.exec(html)) !== null) {
    const normalized = normalizeContentId(match[1]);
    if (normalized) {
      references.add(normalized);
    }
  }
  return references;
};

const isAbortDomException = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

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

const buildSandboxedEmailDoc = (safeBodyHtml: string) => `<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data: blob: cid:; media-src data: blob: cid:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'"
    />
    <style>
      :root { color-scheme: only light; }
      html, body {
        overflow: hidden;
      }
      body {
        margin: 0;
        padding: 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        font-size: 14px;
        color: #222;
        line-height: 1.55;
        background: #fff;
        overflow-wrap: anywhere;
        word-break: break-word;
        overflow-x: hidden;
        box-sizing: border-box;
      }
      * {
        box-sizing: border-box;
      }
      img, video, audio, iframe, table {
        max-width: 100%;
      }
      pre, code {
        white-space: pre-wrap;
        word-break: break-word;
      }
      a {
        color: #0b67d0;
      }
    </style>
  </head>
  <body>
    <div id="mail-root">${safeBodyHtml}</div>
  </body>
</html>`;

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

const MessageItem = ({ msg, depth, defaultExpanded, onReply, onToggleStar, isMobile }: { msg: MessageRecord; depth: number, defaultExpanded: boolean, onReply: () => void, onToggleStar: () => void, isMobile: boolean }) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [showDetails, setShowDetails] = useState(false);
  const [allowRichFormatting, setAllowRichFormatting] = useState(false);
  const [inlineCidUrls, setInlineCidUrls] = useState<Map<string, string>>(new Map());
  const iframeObserverRef = useRef<ResizeObserver | null>(null);
  const iframeTimerIdsRef = useRef<number[]>([]);
  const referencedInlineCids = useMemo(
    () => extractInlineCidReferences(msg.bodyHtml),
    [msg.bodyHtml],
  );

  useEffect(() => {
    return () => {
      iframeObserverRef.current?.disconnect();
      iframeObserverRef.current = null;
      for (const timerId of iframeTimerIdsRef.current) {
        window.clearTimeout(timerId);
      }
      iframeTimerIdsRef.current = [];
    };
  }, []);

  const { data: attachments } = useQuery({
    queryKey: ['attachments', msg.id],
    queryFn: () => api.messages.getAttachments(msg.id),
    staleTime: 30_000,
    enabled: isExpanded && referencedInlineCids.size > 0,
  });

  useEffect(() => {
    let cancelled = false;
    let abortController: AbortController | null = null;
    const createdObjectUrls: string[] = [];

    const loadInlineCidUrls = async () => {
      if (!isExpanded || referencedInlineCids.size === 0 || !attachments?.length) {
        if (!cancelled) {
          setInlineCidUrls(new Map());
        }
        return;
      }

      const cidAttachmentMap = new Map<string, AttachmentRecord>();
      for (const attachment of attachments) {
        const normalizedCid = normalizeContentId(attachment.contentId);
        if (
          !normalizedCid
          || attachment.scanStatus === 'infected'
          || !referencedInlineCids.has(normalizedCid)
          || cidAttachmentMap.has(normalizedCid)
        ) {
          continue;
        }
        cidAttachmentMap.set(normalizedCid, attachment);
      }

      if (cidAttachmentMap.size === 0) {
        if (!cancelled) {
          setInlineCidUrls(new Map());
        }
        return;
      }

      abortController = new AbortController();
      const entries = await Promise.all(
        Array.from(cidAttachmentMap.entries()).map(async ([cid, attachment]) => {
          try {
            const blob = await api.attachments.getPreviewBlob(attachment.id, abortController?.signal);
            if (cancelled) {
              return null;
            }
            const objectUrl = URL.createObjectURL(blob);
            createdObjectUrls.push(objectUrl);
            return [cid, objectUrl] as const;
          } catch (error) {
            if (isAbortDomException(error)) {
              return null;
            }return null;
          }
        }),
      );

      if (!cancelled) {
        const resolvedEntries = entries.filter((entry): entry is readonly [string, string] => Boolean(entry));
        setInlineCidUrls(new Map(resolvedEntries));
      }
    };

    void loadInlineCidUrls();
    return () => {
      cancelled = true;
      abortController?.abort();
      for (const url of createdObjectUrls) {
        URL.revokeObjectURL(url);
      }
    };
  }, [attachments, isExpanded, referencedInlineCids]);

  const sanitizedBody = useMemo(() => {
    if (!msg.bodyHtml) return null;
    const result = sanitizeEmailHtmlWithReport(msg.bodyHtml, { allowStyles: allowRichFormatting });

    if (inlineCidUrls.size > 0) {
      let html = result.html;
      for (const [cid, url] of inlineCidUrls.entries()) {
        const escapedCid = cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`cid:<?${escapedCid}>?`, 'gi');
        html = html.replace(regex, url);
      }
      return { ...result, html };
    }

    return result;
  }, [msg.bodyHtml, allowRichFormatting, inlineCidUrls]);

  const safeBodyHtml = sanitizedBody?.html ?? null;
  const blockedContentSummary = useMemo(() => {
    if (!sanitizedBody?.hasBlockedContent || allowRichFormatting) {
      return null;
    }
    const details: string[] = [];
    if (sanitizedBody.blockedTagNames.length > 0) {
      details.push(`tags: ${sanitizedBody.blockedTagNames.slice(0, 3).join(', ')}`);
    }
    if (sanitizedBody.blockedAttributeNames.length > 0) {
      details.push(`attributes: ${sanitizedBody.blockedAttributeNames.slice(0, 3).join(', ')}`);
    }
    return details.length > 0 ? details.join(' · ') : null;
  }, [allowRichFormatting, sanitizedBody]);
  const from = parseFromHeader(msg.fromHeader);
  const cc = msg.ccHeader || null;
  const bcc = msg.bccHeader || null;

  return (
    <div className={`bg-bg-card border border-border rounded-md shadow-xs overflow-hidden transition-all ${depth > 0 && !isMobile ? 'border-l-4 border-l-accent/20' : ''} ${depth > 0 && isMobile ? 'border-l-2 border-l-accent/20' : ''} ${!isExpanded ? 'hover:border-accent/30 cursor-pointer' : ''}`}>
      <div className={`px-2 md:px-4 py-2.5 md:py-3 flex items-center justify-between transition-colors relative ${isExpanded ? 'border-b border-border/40 bg-black/[0.01] dark:bg-white/[0.01]' : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.02]'}`}>
        <div className="absolute inset-0 cursor-pointer z-0" onClick={() => setIsExpanded(!isExpanded)} />
        <div className="flex items-center gap-2 md:gap-3 flex-1 min-w-0 z-10 pointer-events-none">
          <Avatar text={from.name} fallbackIcon={UserCircle} size={isMobile ? 'sm' : 'md'} className="pointer-events-auto" />
            <div className="min-w-0 flex-1 pointer-events-auto">
            <div className="flex items-baseline gap-2 overflow-hidden flex-1">
              <span className="text-sm font-semibold text-text-primary shrink-0 max-w-[150px] md:max-w-[300px] truncate cursor-text">{from.name}</span>
              {isExpanded && from.email && !isMobile && <span className="text-[11px] text-text-secondary opacity-60 truncate font-normal cursor-text">{from.email}</span>}
              {!isExpanded && <span className="text-[11px] text-text-secondary truncate font-normal opacity-50 ml-1 md:ml-2 italic flex-1 min-w-0 cursor-text">— {msg.snippet}</span>}
            </div>
            {isExpanded && (
              <div className="flex flex-col min-w-0">
                <div className="text-[10px] md:text-[11px] text-text-secondary mt-0.5 flex items-center gap-1 opacity-80 cursor-pointer hover:underline w-fit max-w-full" onClick={(e) => { e.stopPropagation(); setShowDetails(!showDetails); }}>
                  <span className="shrink-0">to</span>
                  <span className="truncate">{msg.toHeader}</span>
                  <ChevronDown className={`w-2.5 h-2.5 md:w-3 md:h-3 shrink-0 transition-transform ${showDetails ? 'rotate-180' : ''}`} />
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 md:gap-3 shrink-0 ml-2 md:ml-4 z-10">
          <div className="text-[9px] md:text-[10px] text-text-secondary font-medium whitespace-nowrap opacity-60 uppercase tracking-tight cursor-text">
            {msg.receivedAt && (() => {
              const d = new Date(msg.receivedAt);
              if (isToday(d)) return format(d, 'h:mm a');
              if (isYesterday(d)) return isMobile ? 'Yest' : 'Yesterday, ' + format(d, 'h:mm a');
              return format(d, isMobile ? 'MMM d' : 'MMM d, p');
            })()}
          </div>
          <div className="flex items-center gap-0.5 text-text-secondary">
            <button className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-md transition-colors" onClick={(e) => { e.stopPropagation(); onToggleStar(); }}><Star className={`w-4 h-4 ${msg.isStarred ? 'fill-yellow-400 text-yellow-400' : ''}`} /></button>
            <button className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-md transition-colors" onClick={(e) => { e.stopPropagation(); onReply(); }} title="Reply"><Reply className="w-4 h-4" /></button>
          </div>
        </div>
      </div>

      {isExpanded && showDetails && (
        <div className="px-3 md:px-4 py-2.5 md:py-3 bg-black/[0.02] dark:bg-white/[0.02] border-b border-border/40 animate-in slide-in-from-top-1 duration-200">
          <div className="grid grid-cols-[max-content_1fr] gap-x-2 md:gap-x-3 gap-y-1 text-[10px] md:text-[11px] ml-8 md:ml-11">
            <span className="text-text-secondary font-semibold text-right opacity-60">from:</span>
            <span className="text-text-primary font-medium flex flex-wrap items-center gap-1 md:gap-2"><span className="font-bold">{from.name}</span><span className="opacity-60 break-all">{from.email}</span></span>
            <span className="text-text-secondary font-semibold text-right opacity-60">to:</span><span className="text-text-primary font-medium break-all">{msg.toHeader}</span>
            {cc && <><span className="text-text-secondary font-semibold text-right opacity-60">cc:</span><span className="text-text-primary font-medium break-all">{cc}</span></>}
            {bcc && <><span className="text-text-secondary font-semibold text-right opacity-60">bcc:</span><span className="text-text-primary font-medium break-all">{bcc}</span></>}
            <span className="text-text-secondary font-semibold text-right opacity-60">date:</span><span className="text-text-primary font-medium">{msg.receivedAt && format(new Date(msg.receivedAt), 'MMMM d, yyyy, h:mm a')}</span>
            <span className="text-text-secondary font-semibold text-right opacity-60">subject:</span><span className="text-text-primary font-medium">{msg.subject || '(no subject)'}</span>
          </div>
        </div>
      )}

      {isExpanded && (
        <>
          <div className="bg-white p-4 md:p-6 text-sm md:text-base leading-relaxed selection:bg-accent/10 text-[#222] break-words overflow-wrap-anywhere">
            {sanitizedBody?.hasBlockedContent && !allowRichFormatting && (
              <div className="mb-3 rounded-md border border-amber-300/80 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div>Some content was blocked for safety.</div>
                  {blockedContentSummary && (
                    <div className="opacity-80 truncate">{blockedContentSummary}</div>
                  )}
                </div>
                <button
                  className="shrink-0 rounded border border-amber-400 bg-white px-2 py-0.5 text-[11px] font-semibold hover:bg-amber-100"
                  onClick={() => setAllowRichFormatting(true)}
                >
                  Allow richer formatting
                </button>
              </div>
            )}
            {sanitizedBody?.hasBlockedContent && allowRichFormatting && (
              <div className="mb-3 rounded-md border border-blue-300/80 bg-blue-50 px-3 py-2 text-[12px] text-blue-900 flex items-center justify-between gap-2">
                <span>Richer formatting enabled for this message. Active content is still blocked.</span>
                <button
                  className="shrink-0 rounded border border-blue-400 bg-white px-2 py-0.5 text-[11px] font-semibold hover:bg-blue-100"
                  onClick={() => setAllowRichFormatting(false)}
                >
                  Use safer view
                </button>
              </div>
            )}
            {safeBodyHtml ? (
              <div className="w-full min-w-0">
                <iframe
                  title={`msg-${msg.id}`}
                  srcDoc={buildSandboxedEmailDoc(safeBodyHtml)}
                  className="w-full border-none bg-white transition-all duration-200"
                  style={{ height: '200px' }}                   scrolling="no"
                  sandbox="allow-popups allow-same-origin"
                  onLoad={(e) => {
                    const iframe = e.currentTarget;
                    const doc = iframe.contentWindow?.document;
                    if (doc?.body) {
                      iframeObserverRef.current?.disconnect();
                      iframeObserverRef.current = null;
                      for (const timerId of iframeTimerIdsRef.current) {
                        window.clearTimeout(timerId);
                      }
                      iframeTimerIdsRef.current = [];

                      const updateHeight = () => {
                        const height = doc.body.scrollHeight;
                        if (height > 0) {
                          iframe.style.height = `${height}px`;
                        }
                      };
                      updateHeight();
                      const observer = new ResizeObserver(updateHeight);
                      observer.observe(doc.body);
                      iframeObserverRef.current = observer;
                      iframeTimerIdsRef.current.push(window.setTimeout(updateHeight, 500));
                      iframeTimerIdsRef.current.push(window.setTimeout(updateHeight, 2000));
                    }
                  }}
                  referrerPolicy="no-referrer"
                  loading="lazy"
                />
              </div>
            ) : <div className="whitespace-pre-wrap break-words overflow-wrap-anywhere">{msg.bodyText}</div>}
          </div>
          <AttachmentList messageId={msg.id} isMobile={isMobile} />
        </>
      )}
    </div>
  );
};

const AttachmentList = ({ messageId, isMobile }: { messageId: string; isMobile: boolean }) => {
  const { data: attachments, isLoading } = useQuery({ queryKey: ['attachments', messageId], queryFn: () => api.messages.getAttachments(messageId), staleTime: 30_000 });
  if (isLoading || !attachments?.length) return null;
  return (
    <div className="px-4 pb-4 pt-2 border-t border-border/40 bg-bg-card">
      <div className="flex items-center gap-2 mb-2 text-text-secondary opacity-60 ml-1">
        <Paperclip className="w-3 h-3" />
        <span className="text-[10px] font-bold uppercase tracking-wider">{attachments.length} {attachments.length === 1 ? 'Attachment' : 'Attachments'}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {attachments.map(att => <AttachmentItem key={att.id} messageId={messageId} attachment={att} isMobile={isMobile} />)}
      </div>
    </div>
  );
};

const AttachmentItem = ({ messageId, attachment, isMobile }: { messageId: string; attachment: AttachmentRecord; isMobile: boolean }) => {
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
    <div className="flex items-center gap-2.5 p-1.5 bg-accent/[0.02] dark:bg-white/[0.02] border border-border/60 rounded-lg group hover:bg-accent/[0.05] hover:border-accent/30 transition-all duration-200 shadow-xs hover:shadow-sm">
      <div className="w-8 h-8 rounded-md bg-bg-card flex items-center justify-center shrink-0 border border-border/40 shadow-xs group-hover:scale-105 transition-transform">
        <Paperclip className="w-3.5 h-3.5 text-text-secondary opacity-70" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-bold text-text-primary truncate" title={attachment.filename}>
          {attachment.filename}
        </div>
        <div className="text-[9px] text-text-secondary opacity-60 font-medium lowercase">
          {(attachment.size / 1024).toFixed(0)}kb
        </div>
      </div>
      <div className={`flex items-center gap-0.5 transition-opacity ${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
        {['error', 'missing'].includes(attachment.scanStatus) && (
          <button onClick={() => scanMutation.mutate()} className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded-md" title="Retry scan">
            <RefreshCw className="w-3.5 h-3.5 text-text-secondary" />
          </button>
        )}
        {canPreviewInline && (
          <button onClick={handleOpenInNewTab} disabled={attachment.scanStatus === 'infected'} className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary disabled:opacity-30" title="Open in new tab">
            <ExternalLink className="w-4 h-4 md:w-3.5 md:h-3.5" />
          </button>
        )}
        <button
          onClick={handleDownload}
          disabled={attachment.scanStatus === 'infected' || downloadMutation.isPending}
          className="p-1.5 hover:bg-accent/10 rounded-md text-accent disabled:opacity-30 transition-colors"
          title="Download"
        >
          {downloadMutation.isPending ? <Loader2 className="w-4 h-4 md:w-3.5 md:h-3.5 animate-spin" /> : <Download className="w-4 h-4 md:w-3.5 md:h-3.5" />}
        </button>
      </div>
    </div>
  );
};

export default ThreadDetail;
