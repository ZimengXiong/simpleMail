import React, { useState } from 'react';
import type { IncomingConnectorRecord, OutgoingConnectorRecord } from '../types/index';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { 
  ChevronLeft, 
  Server, 
  Key, 
  AlertCircle,
  Loader2,
  CheckCircle2,
  Mail,
  ShieldCheck,
  Send
} from 'lucide-react';
import Avatar from '../components/Avatar';
import Select from '../components/Select';

const ConnectorSetupView = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const type = (searchParams.get('type') as 'incoming' | 'outgoing') || 'incoming';

  const [formData, setFormData] = useState({
    name: '',
    providerMode: type === 'incoming' ? 'generic-imap' : 'generic-smtp' as 'generic-imap' | 'gmail-imap' | 'gmail-api' | 'generic-smtp' | 'gmail-smtp',
    provider: type === 'incoming' ? 'imap' : 'smtp',
    emailAddress: '',
    fromAddress: '',
    host: '',
    port: type === 'incoming' ? 993 : 587,
    tls: true,
    tlsMode: 'starttls' as 'starttls' | 'implicit' | 'none',
    authType: 'password' as 'password' | 'oauth2',
    username: '',
    password: '',
  });

  const createMutation = useMutation<IncomingConnectorRecord | OutgoingConnectorRecord, unknown, any>({
    mutationFn: (data: any) => 
      type === 'incoming' 
        ? api.connectors.createIncoming(data) 
        : api.connectors.createOutgoing(data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['connectors'] });
      if (formData.authType === 'oauth2' && isGmailAuthMode) {
        api.oauth.google.authorize({ type, connectorId: data.id }).then(res => {
          window.location.href = res.authorizeUrl;
        });
      } else {
        navigate('/settings');
      }
    }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const derivedProvider = (() => {
      if (formData.providerMode === 'gmail-api' || formData.providerMode === 'gmail-smtp') {
        return 'gmail';
      }
      if (formData.providerMode === 'gmail-imap' || formData.providerMode === 'generic-imap') {
        return 'imap';
      }
      return 'smtp';
    })();

    const payload: any = {
      name: formData.name,
      provider: derivedProvider,
      emailAddress: type === 'incoming' ? formData.emailAddress : undefined,
      fromAddress: formData.fromAddress || formData.emailAddress,
      authType: formData.authType,
      authConfig: formData.authType === 'password' ? {
        authType: 'password',
        username: formData.username || formData.emailAddress,
        password: formData.password
      } : { authType: 'oauth2' },
      syncSettings: type === 'incoming' && formData.providerMode === 'gmail-imap'
        ? { gmailImap: true }
        : undefined,
    };

    if (showServerConfig) {
      payload.host = formData.host;
      payload.port = formData.port;
      if (type === 'incoming') {
        payload.tls = formData.tls;
      } else {
        payload.tlsMode = formData.tlsMode;
      }
    }

    createMutation.mutate(payload);
  };

  const labelClass = "text-sm font-semibold text-text-secondary";
  const isGmailAuthMode = formData.providerMode.startsWith('gmail');
  const showServerConfig = formData.providerMode === 'generic-imap' || formData.providerMode === 'gmail-imap' || formData.providerMode === 'generic-smtp';

  return (
    <div className="flex-1 flex flex-col h-full bg-bg-app overflow-y-auto font-sans">
      <div className="h-11 border-b border-border/60 bg-bg-card flex items-center px-4 shrink-0 sticky top-0 z-10">
        <button onClick={() => navigate('/settings')} className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-md mr-2 text-text-secondary transition-colors">
          <ChevronLeft className="w-4.5 h-4.5" />
        </button>
        <h1 className="text-sm font-semibold text-text-primary">Setup {type} connector</h1>
      </div>

      <div className="max-w-2xl mx-auto w-full p-8 pb-32">
        <form onSubmit={handleSubmit} className="space-y-6 animate-in slide-in-from-bottom-2 duration-300">
          
          <div className="bg-bg-card border border-border/60 rounded-md overflow-hidden">
            <div className="px-5 py-3 border-b border-border/40 bg-black/[0.01] dark:bg-white/[0.01] flex items-center gap-3">
              <h2 className="text-sm font-semibold text-text-primary">Basic information</h2>
            </div>
            <div className="p-5 space-y-5">
              <div className="grid grid-cols-2 gap-5">
                <div className="space-y-1.5">
                  <label className={labelClass}>Connector name</label>
                  <input type="text" required placeholder="e.g. Personal Gmail" className="w-full h-9 px-3 bg-black/[0.02] dark:bg-white/[0.02] border border-border/60 rounded-md text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent transition-all" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
                </div>
                <div className="space-y-1.5">
                  <label className={labelClass}>Provider type</label>
                  <Select 
                    value={formData.providerMode}
                    onChange={(val) => {
                      const mode = val as typeof formData.providerMode;
                      const updates: Partial<typeof formData> = { providerMode: mode };
                      if (type === 'incoming') {
                        if (mode === 'gmail-api') {
                          updates.provider = 'gmail';
                          updates.authType = 'oauth2';
                          updates.host = '';
                          updates.port = 587;
                          updates.username = '';
                          updates.password = '';
                        } else if (mode === 'gmail-imap') {
                          updates.provider = 'imap';
                          updates.authType = 'oauth2';
                          updates.port = 993;
                          updates.tls = true;
                          updates.host = 'imap.gmail.com';
                          updates.username = '';
                          updates.password = '';
                        } else {
                          updates.provider = 'imap';
                          updates.authType = 'password';
                          updates.port = 993;
                          updates.tls = true;
                          updates.host = '';
                        }
                      } else {
                        updates.provider = mode === 'gmail-smtp' ? 'gmail' : 'smtp';
                        updates.authType = mode === 'gmail-smtp' ? 'oauth2' : 'password';
                        updates.host = '';
                        updates.port = mode === 'gmail-smtp' ? 465 : 587;
                        updates.username = '';
                        updates.password = '';
                      }
                      setFormData((prev) => ({ ...prev, ...updates }));
                    }}
                    options={type === 'incoming' ? [
                      { value: 'generic-imap', label: 'Generic IMAP', icon: <Mail className="w-3.5 h-3.5 opacity-60" /> },
                      { value: 'gmail-imap', label: 'Gmail via IMAP', icon: <ShieldCheck className="w-3.5 h-3.5 opacity-60" /> },
                      { value: 'gmail-api', label: 'Gmail (API)', icon: <ShieldCheck className="w-3.5 h-3.5 opacity-60" /> },
                    ] : [
                      { value: 'generic-smtp', label: 'Generic SMTP', icon: <Send className="w-3.5 h-3.5 opacity-60" /> },
                      { value: 'gmail-smtp', label: 'Gmail SMTP (OAuth2)', icon: <Send className="w-3.5 h-3.5 opacity-60" /> },
                    ]}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className={labelClass}>Email address</label>
                <input type="email" required placeholder="you@example.com" className="w-full h-9 px-3 bg-black/[0.02] dark:bg-white/[0.02] border border-border/60 rounded-md text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent transition-all" value={type === 'incoming' ? formData.emailAddress : formData.fromAddress} onChange={e => setFormData({...formData, [type === 'incoming' ? 'emailAddress' : 'fromAddress']: e.target.value})} />
              </div>
            </div>
          </div>

          {showServerConfig && (
            <div className="bg-bg-card border border-border/60 rounded-md overflow-hidden">
              <div className="px-5 py-3 border-b border-border/40 bg-black/[0.01] dark:bg-white/[0.01] flex items-center gap-3">
                <Server className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-semibold text-text-primary">Server configuration</h2>
              </div>
              <div className="p-5 space-y-4">
                <div className="grid grid-cols-3 gap-5">
                  <div className="col-span-2 space-y-1.5">
                    <label className={labelClass}>Host</label>
                    <input type="text" required={showServerConfig} placeholder={type === 'incoming' ? 'imap.example.com' : 'smtp.example.com'} className="w-full h-9 px-3 bg-black/[0.02] dark:bg-white/[0.02] border border-border/60 rounded-md text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent transition-all" value={formData.host} onChange={e => setFormData({...formData, host: e.target.value})} />
                  </div>
                  <div className="space-y-1.5">
                    <label className={labelClass}>Port</label>
                    <input type="number" required={showServerConfig} className="w-full h-9 px-3 bg-black/[0.02] dark:bg-white/[0.02] border border-border/60 rounded-md text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent transition-all" value={formData.port} onChange={e => setFormData({...formData, port: parseInt(e.target.value)})} />
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="bg-bg-card border border-border/60 rounded-md overflow-hidden">
            <div className="px-5 py-3 border-b border-border/40 bg-black/[0.01] dark:bg-white/[0.01] flex items-center gap-3">
              <Key className="w-4 h-4 text-accent" />
              <h2 className="text-sm font-semibold text-text-primary">Authentication</h2>
            </div>
            <div className="p-5 space-y-4">
              {isGmailAuthMode ? (
                <div className="bg-accent/5 border border-accent/20 rounded-md p-4 flex gap-4 items-start">
                  <AlertCircle className="w-4 h-4 text-accent mt-0.5 shrink-0" />
                  <div className="text-xs leading-relaxed">
                    <p className="font-semibold text-accent mb-1">OAuth2 authorization required</p>
                    <p className="text-text-secondary font-medium">Redirecting to Google after saving. Ensure credentials are configured in backend.</p>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-5">
                  <div className="space-y-1.5">
                    <label className={labelClass}>Username</label>
                    <input type="text" placeholder="Same as email" className="w-full h-9 px-3 bg-black/[0.02] dark:bg-white/[0.02] border border-border/60 rounded-md text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent transition-all" value={formData.username} onChange={e => setFormData({...formData, username: e.target.value})} />
                  </div>
                  <div className="space-y-1.5">
                    <label className={labelClass}>Password / Key</label>
                    <input type="password" required={formData.authType === 'password'} className="w-full h-9 px-3 bg-black/[0.02] dark:bg-white/[0.02] border border-border/60 rounded-md text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent transition-all" value={formData.password} onChange={e => setFormData({...formData, password: e.target.value})} />
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="pt-4 flex gap-4">
            <button type="submit" disabled={createMutation.isPending} className="flex-1 px-8 py-2.5 bg-accent hover:bg-accent-hover text-sm font-semibold rounded-md transition-all flex items-center justify-center gap-2 disabled:opacity-50" style={{ color: 'var(--accent-contrast)' }}>
              {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Save Connector
            </button>
            <button type="button" onClick={() => navigate('/settings')} className="flex-1 px-8 py-2.5 bg-bg-card border border-border/60 hover:bg-black/5 dark:hover:bg-white/5 text-text-secondary text-sm font-semibold rounded-md transition-all">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ConnectorSetupView;
