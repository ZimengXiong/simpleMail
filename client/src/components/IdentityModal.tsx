import React, { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { X, Loader2, Send } from 'lucide-react';
import type { IdentityRecord } from '../types';
import Avatar from './Avatar';
import Select from './Select';

interface IdentityModalProps {
  onClose: () => void;
  outgoingConnectors: any[];
  incomingConnectors: any[];
  identity?: IdentityRecord | null;
}

const IdentityModal = ({ onClose, outgoingConnectors, incomingConnectors, identity }: IdentityModalProps) => {
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState({
    displayName: '',
    emailAddress: '',
    outgoingConnectorId: outgoingConnectors[0]?.id || '',
    signature: '',
    sentToIncomingConnectorId: incomingConnectors[0]?.id || '',
    replyTo: '',
  });

  useEffect(() => {
    if (identity) {
      setFormData({
        displayName: identity.displayName || '',
        emailAddress: identity.emailAddress || '',
        outgoingConnectorId: identity.outgoingConnectorId || outgoingConnectors[0]?.id || '',
        signature: identity.signature || '',
        sentToIncomingConnectorId: identity.sentToIncomingConnectorId || incomingConnectors[0]?.id || '',
        replyTo: identity.replyTo || '',
      });
    }
  }, [identity, outgoingConnectors, incomingConnectors]);

  const mutation = useMutation({
    mutationFn: (data: any) => 
      identity 
        ? api.identities.update(identity.id, data) 
        : api.identities.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['identities'] });
      onClose();
    }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate(formData);
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 font-sans">
      <div className="bg-bg-card w-full max-w-lg rounded-md shadow-xl overflow-hidden animate-in zoom-in-95 duration-200 border border-border">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between bg-black/[0.02] dark:bg-white/[0.02]">
          <h2 className="text-sm font-semibold flex items-center gap-2 text-text-primary">
            <Avatar size="sm" />
            {identity ? 'Edit Identity' : 'New Sender Identity'}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-secondary transition-colors"><X className="w-4.5 h-4.5" /></button>
        </div>
        
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-semibold text-text-secondary">Display name</label>
              <input 
                type="text" 
                required
                className="w-full h-9 px-3 bg-black/[0.02] dark:bg-white/[0.02] border border-border rounded-md text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent transition-all"
                placeholder="John Doe"
                value={formData.displayName}
                onChange={e => setFormData({...formData, displayName: e.target.value})}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-semibold text-text-secondary">Email address</label>
              <input 
                type="email" 
                required
                className="w-full h-9 px-3 bg-black/[0.02] dark:bg-white/[0.02] border border-border rounded-md text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent transition-all"
                placeholder="john@example.com"
                value={formData.emailAddress}
                onChange={e => setFormData({...formData, emailAddress: e.target.value})}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-semibold text-text-secondary">Outgoing server (SMTP)</label>
            <Select 
              value={formData.outgoingConnectorId}
              onChange={(val) => setFormData({ ...formData, outgoingConnectorId: val })}
              options={outgoingConnectors.map(c => ({
                value: c.id,
                label: c.name,
                description: c.fromAddress,
                icon: <Send className="w-3.5 h-3.5 opacity-60" />
              }))}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-semibold text-text-secondary">Signature</label>
            <textarea 
              className="w-full min-h-[100px] p-3 bg-black/[0.02] dark:bg-white/[0.02] border border-border rounded-md text-sm text-text-primary font-sans leading-relaxed resize-none focus:outline-none focus:ring-1 focus:ring-accent transition-all"
              placeholder="Best regards,..."
              value={formData.signature}
              onChange={e => setFormData({...formData, signature: e.target.value})}
            />
          </div>

          <div className="pt-4 flex gap-4">
            <button 
              type="submit" 
              disabled={mutation.isPending}
              className="flex-1 px-8 py-2.5 bg-accent hover:bg-accent-hover text-sm font-semibold rounded-md transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              style={{ color: 'var(--accent-contrast)' }}
            >
              {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : identity ? 'Save Changes' : 'Create Identity'}
            </button>
            <button 
              type="button" 
              onClick={onClose}
              className="flex-1 border border-border bg-bg-card text-text-secondary py-2.5 rounded-md text-sm font-semibold hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default IdentityModal;
