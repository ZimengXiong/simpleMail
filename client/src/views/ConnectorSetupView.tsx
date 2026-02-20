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
import Select from '../components/Select';

type ConnectorCreatePayload = {
  name: string;
  provider: string;
  emailAddress?: string;
  fromAddress?: string;
  authType: 'password' | 'oauth2';
  authConfig: {
    authType: 'password';
    username: string;
    password: string;
  } | {
    authType: 'oauth2';
  };
  syncSettings?: {
    gmailImap?: boolean;
    createOutgoingGmail?: boolean;
  };
  host?: string;
  port?: number;
  tls?: boolean;
  tlsMode?: 'starttls' | 'implicit' | 'none';
};

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
    createOutgoingGmail: type === 'incoming',
  });
  const [oauthPending, setOauthPending] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const createMutation = useMutation<IncomingConnectorRecord | OutgoingConnectorRecord, unknown, ConnectorCreatePayload>({
    mutationFn: (data: ConnectorCreatePayload) => 
      type === 'incoming' 
        ? api.connectors.createIncoming(data) 
        : api.connectors.createOutgoing(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connectors'] });
      navigate('/settings');
    },
    onError: (error) => {
      setSubmitError(error instanceof Error ? error.message : 'Unable to save connector');
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError('');
    const derivedProvider = (() => {
      if (formData.providerMode === 'gmail-api' || formData.providerMode === 'gmail-smtp') {
        return 'gmail';
      }
      if (formData.providerMode === 'gmail-imap' || formData.providerMode === 'generic-imap') {
        return 'imap';
      }
      return 'smtp';
    })();

    const payload: ConnectorCreatePayload = {
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
      syncSettings: (() => {
        if (type !== 'incoming') {
          return undefined;
        }
        const isGmailImap = formData.providerMode === 'gmail-imap';
        const shouldLinkOutgoing = isGmailAuthMode ? formData.createOutgoingGmail : false;
        if (!isGmailImap && !shouldLinkOutgoing) {
          return undefined;
        }
        return {
          ...(isGmailImap ? { gmailImap: true } : {}),
          ...(shouldLinkOutgoing ? { createOutgoingGmail: true } : {}),
        };
      })(),
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

    if (formData.authType === 'oauth2' && isGmailAuthMode) {
      setOauthPending(true);
      void api.oauth.google.authorize({ type, connector: payload as unknown as Record<string, unknown> })
        .then((res) => {
          window.location.href = res.authorizeUrl;
        })
        .catch((error) => {
          setSubmitError(error instanceof Error ? error.message : 'OAuth authorization failed');
        })
        .finally(() => {
          setOauthPending(false);
        });
      return;
    }

    createMutation.mutate(payload);
  };

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

      <div className="max-w-2xl mx-auto w-full p-4 md:p-8 pb-32">
        <form onSubmit={handleSubmit} className="space-y-4 md:space-y-6 animate-in slide-in-from-bottom-2 duration-300">
          
          <div className="bg-bg-card border border-border/60 rounded-md">
            <div className="px-4 md:px-5 py-2.5 md:py-3 border-b border-border/40 bg-black/[0.01] dark:bg-white/[0.01] flex items-center gap-3">
              <h2 className="text-sm font-semibold text-text-primary">Basic information</h2>
            </div>
            <div className="p-4 md:p-5 space-y-4 md:space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5">
                <div className="space-y-1.5">
                  <label className="label">Connector name</label>
                  <input type="text" required placeholder="e.g. Personal Gmail" className="input" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
                </div>
                <div className="space-y-1.5">
                  <label className="label">Provider type</label>
                  <Select 
                    value={formData.providerMode}
                    onChange={(val) => {
                      const mode = val as typeof formData.providerMode;
                      const updates: Partial<typeof formData> = { providerMode: mode };
                      if (type === 'incoming') {
                        if (mode === 'gmail-api') {
                          updates.provider = 'gmail';
                          updates.authType = 'oauth2';
                          updates.createOutgoingGmail = true;
                          updates.host = '';
                          updates.port = 587;
                          updates.username = '';
                          updates.password = '';
                        } else if (mode === 'gmail-imap') {
                          updates.provider = 'imap';
                          updates.authType = 'oauth2';
                          updates.createOutgoingGmail = true;
                          updates.port = 993;
                          updates.tls = true;
                          updates.host = 'imap.gmail.com';
                          updates.username = '';
                          updates.password = '';
                        } else {
                          updates.provider = 'imap';
                          updates.authType = 'password';
                          updates.createOutgoingGmail = false;
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
                <label className="label">Email address</label>
                <input type="email" required placeholder="you@example.com" className="input" value={type === 'incoming' ? formData.emailAddress : formData.fromAddress} onChange={e => setFormData({...formData, [type === 'incoming' ? 'emailAddress' : 'fromAddress']: e.target.value})} />
              </div>
            </div>
          </div>

          {showServerConfig && (
            <div className="bg-bg-card border border-border/60 rounded-md">
              <div className="px-4 md:px-5 py-2.5 md:py-3 border-b border-border/40 bg-black/[0.01] dark:bg-white/[0.01] flex items-center gap-3">
                <Server className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-semibold text-text-primary">Server configuration</h2>
              </div>
              <div className="p-4 md:p-5 space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-5">
                  <div className="md:col-span-2 space-y-1.5">
                    <label className="label">Host</label>
                    <input type="text" required={showServerConfig} placeholder={type === 'incoming' ? 'imap.example.com' : 'smtp.example.com'} className="input" value={formData.host} onChange={e => setFormData({...formData, host: e.target.value})} />
                  </div>
                  <div className="space-y-1.5">
                    <label className="label">Port</label>
                    <input type="number" required={showServerConfig} className="input" value={formData.port} onChange={e => setFormData({...formData, port: parseInt(e.target.value)})} />
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="bg-bg-card border border-border/60 rounded-md">
            <div className="px-4 md:px-5 py-2.5 md:py-3 border-b border-border/40 bg-black/[0.01] dark:bg-white/[0.01] flex items-center gap-3">
              <Key className="w-4 h-4 text-accent" />
              <h2 className="text-sm font-semibold text-text-primary">Authentication</h2>
            </div>
            <div className="p-4 md:p-5 space-y-4">
              {isGmailAuthMode ? (
                <div className="bg-accent/5 border border-accent/20 rounded-md p-4 flex gap-4 items-start">
                  <AlertCircle className="w-4 h-4 text-accent mt-0.5 shrink-0" />
                  <div className="text-xs leading-relaxed">
                    <p className="font-semibold text-accent mb-1">OAuth2 authorization required</p>
                    <p className="text-text-secondary font-medium">Redirecting to Google after saving. Ensure credentials are configured in backend.</p>
                    {type === 'incoming' ? (
                      <>
                        <label className="mt-2 inline-flex items-center gap-2 text-text-secondary font-medium">
                          <input
                            type="checkbox"
                            className="accent-[var(--accent)]"
                            checked={formData.createOutgoingGmail}
                            onChange={(event) => setFormData((current) => ({
                              ...current,
                              createOutgoingGmail: event.target.checked,
                            }))}
                          />
                          Also create matching Gmail outgoing connector (same OAuth account)
                        </label>
                        <p className="text-text-secondary mt-2">
                          Initial sync is metadata-first (folders, sender, subject, snippet) and then hydrates full message bodies/attachments in background.
                        </p>
                      </>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5">
                  <div className="space-y-1.5">
                    <label className="label">Username</label>
                    <input type="text" placeholder="Same as email" className="input" value={formData.username} onChange={e => setFormData({...formData, username: e.target.value})} />
                  </div>
                  <div className="space-y-1.5">
                    <label className="label">Password / Key</label>
                    <input type="password" required={formData.authType === 'password'} className="input" value={formData.password} onChange={e => setFormData({...formData, password: e.target.value})} />
                  </div>
                </div>
              )}
            </div>
          </div>

          {submitError ? (
            <div className="bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 rounded-md px-3 py-2 text-xs">
              {submitError}
            </div>
          ) : null}
          <div className="pt-4 flex flex-col sm:flex-row gap-3 md:gap-4">
            <button type="submit" disabled={createMutation.isPending || oauthPending} className="btn-primary flex-1 py-2.5 font-semibold order-1 sm:order-none">
              {(createMutation.isPending || oauthPending) ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Save Connector
            </button>
            <button type="button" onClick={() => navigate('/settings')} className="btn-secondary flex-1 py-2.5 font-semibold">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ConnectorSetupView;
