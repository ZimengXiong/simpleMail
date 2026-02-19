import React, { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../services/api';
import { 
  X, 
  Send, 
  Paperclip, 
  Trash2, 
  Maximize2, 
  Minimize2,
  ChevronDown,
  Loader2
} from 'lucide-react';

interface ComposeModalProps {
  onClose: () => void;
  initialTo?: string;
  initialSubject?: string;
}

const ComposeModal = ({ onClose, initialTo = '', initialSubject = '' }: ComposeModalProps) => {
  const [to, setTo] = useState(initialTo);
  const [subject, setSubject] = useState(initialSubject);
  const [bodyText, setBodyText] = useState('');
  const [identityId, setIdentityId] = useState<string>('');
  const [isMinimized, setIsMinimized] = useState(false);

  const { data: identities } = useQuery({
    queryKey: ['identities'],
    queryFn: () => api.identities.list(),
    onSuccess: (data) => {
      if (data.length > 0 && !identityId) {
        setIdentityId(data[0].id);
      }
    }
  });

  const sendMutation = useMutation({
    mutationFn: (data: any) => api.messages.send(data),
    onSuccess: () => {
      onClose();
    }
  });

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!identityId || !to || !subject) return;

    sendMutation.mutate({
      identityId,
      to,
      subject,
      bodyText,
    });
  };

  if (isMinimized) {
    return (
      <div className="fixed bottom-0 right-8 w-80 bg-white border border-border shadow-2xl rounded-t-lg z-50">
        <div className="bg-[#37352f] text-white px-3 py-2 rounded-t-lg flex items-center justify-between">
          <span className="text-xs font-bold truncate">New Message</span>
          <div className="flex gap-1">
            <button onClick={() => setIsMinimized(false)}><Maximize2 className="w-3.5 h-3.5" /></button>
            <button onClick={onClose}><X className="w-3.5 h-3.5" /></button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-0 right-8 w-[540px] h-[600px] bg-white border border-border shadow-2xl rounded-t-lg flex flex-col z-50 animate-in slide-in-from-bottom-4 duration-300">
      <div className="bg-[#37352f] text-white px-3 py-2 rounded-t-lg flex items-center justify-between shrink-0 cursor-pointer" onClick={() => setIsMinimized(true)}>
        <span className="text-xs font-bold">New Message</span>
        <div className="flex gap-2">
          <button onClick={(e) => { e.stopPropagation(); setIsMinimized(true); }} className="hover:bg-white/10 p-1 rounded"><Minimize2 className="w-3.5 h-3.5" /></button>
          <button onClick={(e) => { e.stopPropagation(); onClose(); }} className="hover:bg-white/10 p-1 rounded"><X className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      <form onSubmit={handleSend} className="flex-1 flex flex-col p-4 space-y-3">
        <div className="flex items-center gap-2 border-b border-border py-1">
          <span className="text-xs text-text-secondary w-12 shrink-0">From</span>
          <select 
            className="flex-1 bg-transparent text-xs focus:outline-none font-bold"
            value={identityId}
            onChange={(e) => setIdentityId(e.target.value)}
          >
            {identities?.map(id => (
              <option key={id.id} value={id.id}>{id.displayName} &lt;{id.emailAddress}&gt;</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2 border-b border-border py-1">
          <span className="text-xs text-text-secondary w-12 shrink-0">To</span>
          <input 
            type="text" 
            required
            className="flex-1 bg-transparent text-xs focus:outline-none"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-2 border-b border-border py-1">
          <span className="text-xs text-text-secondary w-12 shrink-0">Subject</span>
          <input 
            type="text" 
            required
            className="flex-1 bg-transparent text-xs focus:outline-none font-bold"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>

        <textarea 
          className="flex-1 w-full resize-none text-sm focus:outline-none font-sans py-2 leading-relaxed"
          placeholder="Write your message..."
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value)}
        />

        <div className="pt-4 border-t border-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <button 
              type="submit" 
              disabled={sendMutation.isPending}
              className="bg-accent hover:bg-accent-hover text-white px-5 py-2 rounded-md text-sm font-bold shadow-md transition-all flex items-center gap-2 disabled:opacity-50"
            >
              {sendMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Send
            </button>
            <button type="button" className="p-2 hover:bg-black/5 rounded text-text-secondary">
              <Paperclip className="w-4 h-4" />
            </button>
          </div>
          <button type="button" onClick={onClose} className="p-2 hover:bg-red-50 text-text-secondary hover:text-red-500 rounded transition-colors">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </form>
    </div>
  );
};

export default ComposeModal;
