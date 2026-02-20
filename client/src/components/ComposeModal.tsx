import { useState, useEffect, useRef, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import {
  X,
  Send,
  Paperclip,
  Trash2,
  Maximize2,
  Minimize2,
  Loader2,
  CheckCircle2,
  Minus,
  GripHorizontal,
  UserCircle
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import Select from './Select';
import Avatar from './Avatar';
import { useMediaQuery } from '../services/layout';

interface ComposeModalProps {
  onClose: () => void;
  initialTo?: string;
  initialCc?: string;
  initialBcc?: string;
  initialSubject?: string;
  initialBodyText?: string;
  initialIdentityId?: string;
  initialThreadId?: string;
  initialInReplyTo?: string;
  initialReferences?: string;
  initialFocus?: 'to' | 'body';
}

interface PendingAttachment {
  filename: string;
  contentType: string;
  contentBase64: string;
  size: number;
}

const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DEFAULT_ATTACHMENT_CONTENT_TYPE = 'application/octet-stream';

const ComposeModal = ({
  onClose,
  initialTo = '',
  initialCc = '',
  initialBcc = '',
  initialSubject = '',
  initialBodyText = '',
  initialIdentityId,
  initialThreadId,
  initialInReplyTo,
  initialReferences,
  initialFocus = 'body',
}: ComposeModalProps) => {
  const queryClient = useQueryClient();
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [to, setTo] = useState(initialTo);
  const [cc, setCc] = useState(initialCc);
  const [bcc, setBcc] = useState(initialBcc);
  const [subject, setSubject] = useState(initialSubject);
  const [bodyText, setBodyText] = useState(initialBodyText);
  const [identityId, setIdentityId] = useState<string>(initialIdentityId || '');
  const [isMinimized, setIsMinimized] = useState(false);
  const [showCcBcc, setShowCcBcc] = useState(Boolean(initialCc || initialBcc));
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [idempotencyKey] = useState(uuidv4());
  const [sendErrorMessage, setSendErrorMessage] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toInputRef = useRef<HTMLInputElement>(null);
  const bodyTextRef = useRef<HTMLTextAreaElement>(null);

  const [sendStatus, setSendStatus] = useState<'idle' | 'sending' | 'queued' | 'success' | 'failed'>('idle');

  const { data: identities, isLoading: loadingIdentities } = useQuery({
    queryKey: ['identities'],
    queryFn: () => api.identities.list(),
  });
  const resolvedIdentityId = identityId || initialIdentityId || identities?.[0]?.id || '';

  useEffect(() => {
    if (isMinimized) return;
    const timer = window.setTimeout(() => {
      if (initialFocus === 'to' && toInputRef.current) {
        toInputRef.current.focus();
      } else if (bodyTextRef.current) {
        const textarea = bodyTextRef.current;
        textarea.focus();
        const shouldStartAtTop = bodyText.startsWith('\n\nOn ') || bodyText.startsWith('\n\n---------- Forwarded message');
        const cursorPosition = shouldStartAtTop ? 0 : bodyText.length;
        textarea.setSelectionRange(cursorPosition, cursorPosition);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isMinimized, initialBodyText, initialFocus, bodyText]);

  const dragData = useRef({ isDragging: false, startX: 0, startY: 0, initialX: 0, initialY: 0 });

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!modalRef.current || isMobile) return;
    dragData.current = {
      isDragging: true,
      startX: e.clientX,
      startY: e.clientY,
      initialX: dragData.current.initialX,
      initialY: dragData.current.initialY
    };
    modalRef.current.setPointerCapture(e.pointerId);
  };

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      if (!dragData.current.isDragging || !modalRef.current || isMobile) return;
      const dx = e.clientX - dragData.current.startX;
      const dy = e.clientY - dragData.current.startY;
      const x = dragData.current.initialX + dx;
      const y = dragData.current.initialY + dy;
      modalRef.current.style.transform = `translate(${x}px, ${y}px)`;
    };

    const handleUp = (e: PointerEvent) => {
      if (!dragData.current.isDragging || !modalRef.current || isMobile) return;
      const dx = e.clientX - dragData.current.startX;
      const dy = e.clientY - dragData.current.startY;
      dragData.current.initialX += dx;
      dragData.current.initialY += dy;
      dragData.current.isDragging = false;
      modalRef.current.releasePointerCapture(e.pointerId);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [isMobile]);

  const sendMutation = useMutation({
    mutationFn: (data: Parameters<typeof api.messages.send>[0]) => api.messages.send(data, idempotencyKey),
    onSuccess: async (res) => {
      const selectedIdentity = identities?.find((identity) => identity.id === resolvedIdentityId);
      const connectorId = selectedIdentity?.sentToIncomingConnectorId ?? null;
      const refreshMailboxState = () => {
        queryClient.invalidateQueries({ queryKey: ['messages'] });
        queryClient.invalidateQueries({ queryKey: ['syncState'] });
        if (initialThreadId) {
          queryClient.invalidateQueries({ queryKey: ['thread', initialThreadId] });
        }
      };
      const triggerSentSync = async () => {
        if (!connectorId) {
          refreshMailboxState();
          return;
        }
        await Promise.allSettled([
          api.sync.trigger(connectorId, 'SENT', true, false),
          api.sync.trigger(connectorId, 'INBOX', true, false),
        ]);
        refreshMailboxState();
      };

      if (res.status === 'queued') {
        setSendStatus('queued');
        void triggerSentSync();
        window.setTimeout(() => { void triggerSentSync(); }, 2000);
        setTimeout(() => onClose(), 2000);
      } else {
        setSendStatus('success');
        void triggerSentSync();
        setTimeout(() => onClose(), 1500);
      }
    },
    onError: (err: unknown) => {
      setSendStatus('failed');
      const errorMessage = err instanceof Error ? err.message : 'Failed to send message.';
      setSendErrorMessage(errorMessage);
      console.error(errorMessage);
    }
  });

  const handleSend = (e: FormEvent) => {
    e.preventDefault();
    const normalizedTo = to.trim();
    const normalizedSubject = subject.trim();
    const recipients = normalizedTo.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
    if (!resolvedIdentityId || !normalizedSubject) return;
    if (recipients.length === 0) {
      setSendStatus('failed');
      setSendErrorMessage('Please enter at least one valid recipient email.');
      return;
    }

    if (isMobile && !window.confirm('Send this message?')) {
      return;
    }

    setSendErrorMessage(null);
    setSendStatus('sending');
    const shouldAttachToThread = Boolean(initialThreadId && (initialInReplyTo || initialReferences));
    sendMutation.mutate({
      identityId: resolvedIdentityId,
      to: normalizedTo,
      cc: cc.split(',').map(e => e.trim()).filter(Boolean),
      bcc: bcc.split(',').map(e => e.trim()).filter(Boolean),
      subject: normalizedSubject,
      bodyText,
      threadId: shouldAttachToThread ? initialThreadId : undefined,
      inReplyTo: initialInReplyTo,
      references: initialReferences,
      attachments: attachments.map(({ filename, contentType, contentBase64 }) => ({ filename, contentType, contentBase64 })),
    });
  };

  const headerClasses = `h-11 border-b border-border/60 flex items-center justify-between px-3 bg-black/[0.02] dark:bg-white/[0.02] shrink-0 ${!isMobile ? 'cursor-grab active:cursor-grabbing' : ''} select-none`;

  const modalContent = (
    <div
      ref={modalRef}
      className={`
        fixed bg-bg-card border border-border/60 flex flex-col z-[1000] animate-in duration-300 transition-[background-color,border-color]
        ${isMobile 
          ? 'inset-0 h-full w-full rounded-none slide-in-from-bottom-full' 
          : 'bottom-18 right-8 w-[500px] h-[540px] rounded-md slide-in-from-bottom-4 shadow-xl'}
      `}
    >
      <div className={headerClasses} onPointerDown={handlePointerDown}>
        <div className="flex items-center gap-2">
          {!isMobile && <GripHorizontal className="w-3.5 h-3.5 text-text-secondary opacity-60" />}
          <span className="text-sm font-semibold text-text-primary uppercase tracking-wider opacity-60">{isMobile ? (subject || 'New Message') : 'Compose'}</span>
        </div>
        <div className="flex gap-1">
          {!isMobile && <button onPointerDown={e => e.stopPropagation()} onClick={() => setIsMinimized(true)} className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary transition-colors"><Minimize2 className="w-3.5 h-3.5" /></button>}
          <button onPointerDown={e => e.stopPropagation()} onClick={onClose} className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary transition-colors"><X className="w-4 h-4 md:w-3.5 md:h-3.5" /></button>
        </div>
      </div>

      <form onSubmit={handleSend} className="flex-1 flex flex-col p-4 space-y-3 overflow-hidden">
        <div className="space-y-0.5">
          <div className="flex items-center gap-3 border-b border-border/40 py-0.5 min-h-[36px]">
            <span className="text-xs text-text-secondary w-14 shrink-0 font-medium opacity-60">From</span>
            {loadingIdentities ? <div className="flex-1 text-sm text-text-secondary italic">Loading...</div> : (
              <Select
                className="flex-1"
                variant="minimal"
                value={resolvedIdentityId}
                onChange={(val) => setIdentityId(val)}
                options={identities?.map(id => ({
                  value: id.id,
                  label: id.displayName,
                  description: id.emailAddress,
                  icon: <Avatar visualConfig={id.visual_config} text={id.displayName} fallbackIcon={UserCircle} size="sm" />
                })) || []}
              />
            )}
          </div>
          <div className="flex items-center gap-3 border-b border-border/40 py-0.5 min-h-[36px]">
            <span className="text-xs text-text-secondary w-14 shrink-0 font-medium opacity-60">To</span>
            <input ref={toInputRef} type="text" required className="flex-1 bg-transparent text-sm focus:outline-none text-text-primary placeholder:text-text-secondary/30" placeholder="Recipients" value={to} onChange={(e) => setTo(e.target.value)} />
            <button type="button" onClick={() => setShowCcBcc(!showCcBcc)} className="text-[10px] text-text-secondary hover:text-accent font-bold uppercase tracking-widest opacity-80 hover:opacity-100 transition-opacity px-1.5 py-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5">Cc/Bcc</button>
          </div>
          {showCcBcc && (
            <div className="space-y-0.5 animate-in slide-in-from-top-1">
              <div className="flex items-center gap-3 border-b border-border/40 py-0.5 min-h-[36px]">
                <span className="text-xs text-text-secondary w-14 shrink-0 font-medium opacity-60">Cc</span>
                <input type="text" className="flex-1 bg-transparent text-sm focus:outline-none text-text-primary placeholder:text-text-secondary/30" placeholder="CC recipients" value={cc} onChange={(e) => setCc(e.target.value)} />
              </div>
              <div className="flex items-center gap-3 border-b border-border/40 py-0.5 min-h-[36px]">
                <span className="text-xs text-text-secondary w-14 shrink-0 font-medium opacity-60">Bcc</span>
                <input type="text" className="flex-1 bg-transparent text-sm focus:outline-none text-text-primary placeholder:text-text-secondary/30" placeholder="BCC recipients" value={bcc} onChange={(e) => setBcc(e.target.value)} />
              </div>
            </div>
          )}
          <div className="flex items-center gap-3 border-b border-border/40 py-0.5 min-h-[36px]">
            <span className="text-xs text-text-secondary w-14 shrink-0 font-medium opacity-60">Subject</span>
            <input type="text" required className="flex-1 bg-transparent text-sm focus:outline-none font-medium text-text-primary placeholder:text-text-secondary/30" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
        </div>

        <textarea ref={bodyTextRef} className="flex-1 w-full resize-none text-sm focus:outline-none font-sans py-2 leading-relaxed text-text-primary bg-transparent" placeholder="Write your message..." value={bodyText} onChange={(e) => setBodyText(e.target.value)} />

        {attachments.length > 0 && (
          <div className="border border-border/40 rounded-md p-2 space-y-1 max-h-24 overflow-y-auto bg-black/[0.01] dark:bg-white/[0.01]">
            {attachments.map((attachment, index) => (
              <div key={`${attachment.filename}-${index}`} className="flex items-center gap-2 text-xs">
                <Paperclip className="w-3 h-3 text-text-secondary opacity-70" /><span className="flex-1 truncate text-text-primary">{attachment.filename}</span><span className="text-text-secondary opacity-70">{(attachment.size / 1024).toFixed(0)}K</span>
                <button type="button" onClick={() => setAttachments(current => current.filter((_, i) => i !== index))} className="p-0.5 rounded hover:bg-red-50 text-text-secondary hover:text-red-500"><Minus className="w-3 h-3" /></button>
              </div>
            ))}
          </div>
        )}

        <div className="pt-4 border-t border-border/60 flex items-center justify-between shrink-0 mb-safe">
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => {
            const files = Array.from(e.target.files || []);
            if (files.length === 0) {
              return;
            }
            const currentTotalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
            const availableSlots = Math.max(0, MAX_ATTACHMENTS - attachments.length);
            const filesToRead = files.slice(0, availableSlots);

            if (files.length > availableSlots) {
              setSendErrorMessage(`Only ${MAX_ATTACHMENTS} attachments are allowed per message.`);
            }

            let runningBytes = currentTotalBytes;
            const acceptedFiles = filesToRead.filter((file) => {
              if (file.size > MAX_ATTACHMENT_BYTES) {
                setSendErrorMessage(`"${file.name}" exceeds the 10 MB per-file limit.`);
                return false;
              }
              if (runningBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
                setSendErrorMessage('Total attachment size exceeds 25 MB.');
                return false;
              }
              runningBytes += file.size;
              return true;
            });

            acceptedFiles.forEach((file) => {
              const reader = new FileReader();
              reader.onload = () => {
                const dataUrl = typeof reader.result === 'string' ? reader.result : '';
                const [, base64 = ''] = dataUrl.split(',', 2);
                if (!base64) {
                  setSendErrorMessage(`Failed to attach "${file.name}".`);
                  return;
                }
                setAttachments((current) => [
                  ...current,
                  {
                    filename: file.name,
                    contentType: file.type || DEFAULT_ATTACHMENT_CONTENT_TYPE,
                    size: file.size,
                    contentBase64: base64,
                  },
                ]);
              };
              reader.onerror = () => {
                setSendErrorMessage(`Failed to read "${file.name}".`);
              };
              reader.readAsDataURL(file);
            });

            if (e.target) {
              e.target.value = '';
            }
          }} />
          <div className="flex items-center gap-3">
            <button type="submit" disabled={['sending', 'queued', 'success'].includes(sendStatus)} className={`btn-primary px-6 md:px-5 py-2 md:py-1.5 ${sendStatus === 'success' ? 'bg-green-600 text-white' : ''}`}>
              {sendStatus === 'sending' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : sendStatus === 'success' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
              {sendStatus === 'sending' ? 'Sending...' : sendStatus === 'success' ? 'Sent' : 'Send'}
            </button>
            <button type="button" onClick={() => fileInputRef.current?.click()} className="p-2 md:p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary transition-colors" title="Attach file"><Paperclip className="w-5 h-5 md:w-4 md:h-4" /></button>
          </div>
          <button type="button" onClick={onClose} className="btn-danger p-2 md:p-1.5"><Trash2 className="w-5 h-5 md:w-4 md:h-4" /></button>
        </div>
        {sendStatus === 'failed' && sendErrorMessage && (
          <div className="text-xs text-red-500">{sendErrorMessage}</div>
        )}
      </form>
    </div>
  );

  const minimizedContent = (
    <div
      ref={modalRef}
      className="fixed bottom-18 right-8 w-72 bg-bg-card border border-border/60 rounded-md z-[1000] overflow-hidden animate-in slide-in-from-bottom-2 transition-[background-color,border-color] shadow-xl"
    >
      <div className={headerClasses} onPointerDown={handlePointerDown}>
        <div className="flex items-center gap-2 min-w-0">
          <GripHorizontal className="w-3.5 h-3.5 text-text-secondary opacity-60 shrink-0" />
          <span className="text-sm font-semibold text-text-primary truncate">{subject || 'New Message'}</span>
        </div>
        <div className="flex gap-0.5">
          <button className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary" onPointerDown={e => e.stopPropagation()} onClick={() => setIsMinimized(false)}><Maximize2 className="w-3.5 h-3.5" /></button>
          <button className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary" onPointerDown={e => e.stopPropagation()} onClick={onClose}><X className="w-3.5 h-3.5" /></button>
        </div>
      </div>
    </div>
  );

  return createPortal(
    isMinimized && !isMobile ? minimizedContent : modalContent,
    document.body
  );
};

export default ComposeModal;
