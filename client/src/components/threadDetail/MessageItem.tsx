import { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, isToday, isYesterday } from 'date-fns';
import {
  Mail,
  AlertTriangle,
  ChevronDown,
  Reply,
  Star,
} from 'lucide-react';
import type { AttachmentRecord, MessageRecord } from '../../types/index';
import Avatar from '../Avatar';
import { sanitizeEmailHtmlWithReport } from '../../services/htmlSanitizer';
import { api } from '../../services/api';
import { useMediaQuery } from '../../services/layout';
import AttachmentList from './AttachmentList';

type MessageItemProps = {
  msg: MessageRecord;
  depth: number;
  defaultExpanded: boolean;
  onReply: () => void;
  onToggleStar: () => void;
  isMobile: boolean;
};

const parseFromHeader = (header: string | null) => {
  if (!header) return { name: 'Unknown', email: '' };
  const match = header.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim() || match[2], email: match[2] };
  }
  return { name: header, email: '' };
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
      img, video, audio, table, iframe {
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

const MessageItem = ({ msg, depth, defaultExpanded, onReply, onToggleStar, isMobile }: MessageItemProps) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [showDetails, setShowDetails] = useState(false);
  const [allowRichFormatting, setAllowRichFormatting] = useState(false);
  const [inlineCidUrls, setInlineCidUrls] = useState<Map<string, string>>(new Map());
  const iframeObserverRef = useRef<ResizeObserver | null>(null);
  const iframeTimerIdsRef = useRef<number[]>([]);
  const isMobileQuery = useMediaQuery('(max-width: 768px)');
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
            }
            return null;
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
          <Avatar text={from.name} fallbackIcon={Mail} size={isMobile ? 'sm' : 'md'} className="pointer-events-auto" />
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
              if (isYesterday(d)) return isMobileQuery ? 'Yest' : 'Yesterday, ' + format(d, 'h:mm a');
              return format(d, isMobileQuery ? 'MMM d' : 'MMM d, p');
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
                  style={{ height: '200px' }}
                  scrolling="no"
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

export default MessageItem;
