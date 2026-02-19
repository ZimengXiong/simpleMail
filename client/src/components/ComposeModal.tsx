import { useState, useEffect, useRef, type FormEvent } from 'react';
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

  useEffect(() => {
    if (identities && identities.length > 0 && !identityId && !initialIdentityId) {
      setIdentityId(identities[0].id);
    }
  }, [identities, identityId, initialIdentityId]);

  useEffect(() => {
    if (isMinimized) return;
    const timer = window.setTimeout(() => {
      if (initialFocus === 'to' && toInputRef.current) {
        toInputRef.current.focus();
      } else if (bodyTextRef.current) {
        const textarea = bodyTextRef.current;
        textarea.focus();
        // If it's a reply or forward, start at the very top (before the leading newlines)
        const shouldStartAtTop = bodyText.startsWith('\n\nOn ') || bodyText.startsWith('\n\n---------- Forwarded message');
        const cursorPosition = shouldStartAtTop ? 0 : bodyText.length;
        textarea.setSelectionRange(cursorPosition, cursorPosition);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isMinimized, initialBodyText, initialFocus]);

  // High-performance Dragging using refs
  const dragData = useRef({ isDragging: false, startX: 0, startY: 0, initialX: 0, initialY: 0 });

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!modalRef.current) return;
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
      if (!dragData.current.isDragging || !modalRef.current) return;
      const dx = e.clientX - dragData.current.startX;
      const dy = e.clientY - dragData.current.startY;
      const x = dragData.current.initialX + dx;
      const y = dragData.current.initialY + dy;
      modalRef.current.style.transform = `translate(${x}px, ${y}px)`;
    };

    const handleUp = (e: PointerEvent) => {
      if (!dragData.current.isDragging || !modalRef.current) return;
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
  }, []);

  const sendMutation = useMutation({
    mutationFn: (data: any) => api.messages.send(data, idempotencyKey),
    onSuccess: async (res) => {
      const selectedIdentity = identities?.find((identity) => identity.id === identityId);
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
    onError: (err: any) => {
      setSendStatus('failed');
      setSendErrorMessage(err?.message || 'Failed to send message.');
      console.error(err?.message || 'Failed to send message.');
    }
  });

  const handleSend = (e: FormEvent) => {
    e.preventDefault();
    const normalizedTo = to.trim();
    const normalizedSubject = subject.trim();
    const recipients = normalizedTo.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
    if (!identityId || !normalizedSubject) return;
    if (recipients.length === 0) {
      setSendStatus('failed');
      setSendErrorMessage('Please enter at least one valid recipient email.');
      return;
    }
    setSendErrorMessage(null);
    setSendStatus('sending');
    sendMutation.mutate({
      identityId,
      to: normalizedTo,
      cc: cc.split(',').map(e => e.trim()).filter(Boolean),
      bcc: bcc.split(',').map(e => e.trim()).filter(Boolean),
      subject: normalizedSubject,
      bodyText,
      threadId: initialThreadId,
      inReplyTo: initialInReplyTo,
      references: initialReferences,
      attachments: attachments.map(({ filename, contentType, contentBase64 }) => ({ filename, contentType, contentBase64 })),
    });
  };

  const headerClasses = "h-11 border-b border-border/60 flex items-center justify-between px-3 bg-black/[0.02] dark:bg-white/[0.02] shrink-0 cursor-grab active:cursor-grabbing select-none";

  if (isMinimized) {
    return (
      <div
        ref={modalRef}
        className="fixed bottom-18 right-8 w-72 bg-bg-card border border-border/60 rounded-md z-50 overflow-hidden animate-in slide-in-from-bottom-2 transition-[background-color,border-color]"
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
  }

  return (
    <div
      ref={modalRef}
      className="fixed bottom-18 right-8 w-[500px] h-[540px] bg-bg-card border border-border/60 rounded-md flex flex-col z-50 animate-in slide-in-from-bottom-4 duration-300 transition-[background-color,border-color]"
    >
      <div className={headerClasses} onPointerDown={handlePointerDown}>
        <div className="flex items-center gap-2">
          <GripHorizontal className="w-3.5 h-3.5 text-text-secondary opacity-60" />
          <span className="text-sm font-semibold text-text-primary uppercase tracking-wider opacity-60">Compose</span>
        </div>
        <div className="flex gap-1">
          <button onPointerDown={e => e.stopPropagation()} onClick={() => setIsMinimized(true)} className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary transition-colors"><Minimize2 className="w-3.5 h-3.5" /></button>
          <button onPointerDown={e => e.stopPropagation()} onClick={onClose} className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary transition-colors"><X className="w-3.5 h-3.5" /></button>
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
                value={identityId}
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
                <Paperclip className="w-3 h-3 text-text-secondary opacity-50" /><span className="flex-1 truncate text-text-primary">{attachment.filename}</span><span className="text-text-secondary opacity-50">{(attachment.size / 1024).toFixed(0)}K</span>
                <button type="button" onClick={() => setAttachments(current => current.filter((_, i) => i !== index))} className="p-0.5 rounded hover:bg-red-50 text-text-secondary hover:text-red-500"><Minus className="w-3 h-3" /></button>
              </div>
            ))}
          </div>
        )}

        <div className="pt-4 border-t border-border/60 flex items-center justify-between shrink-0">
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => {
            const files = Array.from(e.target.files || []);
            files.forEach(async f => {
              const reader = new FileReader();
              reader.onload = () => setAttachments(curr => [...curr, { filename: f.name, contentType: f.type, size: f.size, contentBase64: (reader.result as string).split(',')[1] }]);
              reader.readAsDataURL(f);
            });
          }} />
          <div className="flex items-center gap-3">
            <button type="submit" disabled={['sending', 'queued', 'success'].includes(sendStatus)} className={`px-5 py-1.5 rounded-md text-sm font-bold shadow-xs transition-all flex items-center gap-2 disabled:opacity-70 active:scale-[0.98] ${sendStatus === 'success' ? 'bg-green-600 text-white' : 'bg-accent hover:bg-accent-hover'}`} style={sendStatus !== 'success' ? { color: 'var(--accent-contrast)' } : {}}>
              {sendStatus === 'sending' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : sendStatus === 'success' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
              {sendStatus === 'sending' ? 'Sending...' : sendStatus === 'success' ? 'Sent' : 'Send'}
            </button>
            <button type="button" onClick={() => fileInputRef.current?.click()} className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary transition-colors" title="Attach file"><Paperclip className="w-4 h-4" /></button>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 hover:bg-red-50 dark:hover:bg-red-900/20 text-text-secondary hover:text-red-500 rounded-md transition-colors"><Trash2 className="w-4 h-4" /></button>
        </div>
        {sendStatus === 'failed' && sendErrorMessage && (
          <div className="text-xs text-red-500">{sendErrorMessage}</div>
        )}
      </form>
    </div>
  );
};

export default ComposeModal;
