import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { 
  ChevronLeft, 
  ShieldCheck, 
  Send, 
  Server, 
  Key, 
  Settings2,
  AlertCircle,
  Loader2
} from 'lucide-react';

const ConnectorSetupView = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const type = (searchParams.get('type') as 'incoming' | 'outgoing') || 'incoming';

  const [formData, setFormData] = useState({
    name: '',
    provider: 'imap' as 'imap' | 'gmail' | 'smtp',
    emailAddress: '',
    fromAddress: '', // for outgoing
    host: '',
    port: type === 'incoming' ? 993 : 587,
    tls: true,
    tlsMode: 'starttls' as 'starttls' | 'implicit' | 'none',
    authType: 'password' as 'password' | 'oauth2',
    username: '',
    password: '',
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => 
      type === 'incoming' 
        ? api.connectors.createIncoming(data) 
        : api.connectors.createOutgoing(data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['connectors'] });
      // If Gmail, we might need to trigger OAuth right away
      if (formData.provider === 'gmail' && formData.authType === 'oauth2') {
        api.oauth.google.authorize({ 
          type, 
          connectorId: data.id 
        }).then(res => {
          window.location.href = res.authorizeUrl;
        });
      } else {
        navigate('/settings');
      }
    }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      ...formData,
      fromAddress: formData.fromAddress || formData.emailAddress,
      authConfig: formData.authType === 'password' ? {
        authType: 'password',
        username: formData.username || formData.emailAddress,
        password: formData.password
      } : { authType: 'oauth2' }
    };
    createMutation.mutate(payload);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#fbfbfa]">
      <div className="h-12 border-b border-border bg-white flex items-center px-4 shrink-0">
        <button onClick={() => navigate('/settings')} className="p-1 hover:bg-black/5 rounded mr-2">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <h1 className="text-sm font-semibold">Add {type === 'incoming' ? 'Incoming' : 'Outgoing'} Connector</h1>
      </div>

      <div className="max-w-2xl mx-auto w-full p-8 pb-32">
        <form onSubmit={handleSubmit} className="space-y-8 animate-in slide-in-from-bottom-2 duration-300">
          <section className="space-y-4">
            <div className="flex items-center gap-2 mb-4">
              {type === 'incoming' ? <ShieldCheck className="w-5 h-5 text-accent" /> : <Send className="w-5 h-5 text-accent" />}
              <h2 className="text-lg font-bold">Basic Information</h2>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-text-secondary uppercase tracking-tight">Connector Name</label>
                <input 
                  type="text" 
                  required
                  placeholder="e.g. Personal Gmail"
                  className="input text-sm"
                  value={formData.name}
                  onChange={e => setFormData({...formData, name: e.target.value})}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-text-secondary uppercase tracking-tight">Provider Type</label>
                <select 
                  className="input text-sm bg-white"
                  value={formData.provider}
                  onChange={e => setFormData({...formData, provider: e.target.value as any, authType: e.target.value === 'gmail' ? 'oauth2' : 'password'})}
                >
                  {type === 'incoming' ? (
                    <>
                      <option value="imap">Generic IMAP</option>
                      <option value="gmail">Gmail (OAuth2)</option>
                    </>
                  ) : (
                    <>
                      <option value="smtp">Generic SMTP</option>
                      <option value="gmail">Gmail SMTP (OAuth2)</option>
                    </>
                  )}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-text-secondary uppercase tracking-tight">Email Address</label>
              <input 
                type="email" 
                required
                placeholder="you@example.com"
                className="input text-sm"
                value={type === 'incoming' ? formData.emailAddress : formData.fromAddress}
                onChange={e => setFormData({...formData, [type === 'incoming' ? 'emailAddress' : 'fromAddress']: e.target.value})}
              />
            </div>
          </section>

          {formData.provider !== 'gmail' && (
            <section className="space-y-4 pt-6 border-t border-border/50">
              <div className="flex items-center gap-2 mb-4">
                <Server className="w-5 h-5 text-accent" />
                <h2 className="text-lg font-bold">Server Configuration</h2>
              </div>
              
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2 space-y-1.5">
                  <label className="text-xs font-bold text-text-secondary uppercase tracking-tight">Host</label>
                  <input 
                    type="text" 
                    required={formData.provider !== 'gmail'}
                    placeholder={type === 'incoming' ? 'imap.example.com' : 'smtp.example.com'}
                    className="input text-sm"
                    value={formData.host}
                    onChange={e => setFormData({...formData, host: e.target.value})}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-text-secondary uppercase tracking-tight">Port</label>
                  <input 
                    type="number" 
                    required={formData.provider !== 'gmail'}
                    className="input text-sm"
                    value={formData.port}
                    onChange={e => setFormData({...formData, port: parseInt(e.target.value)})}
                  />
                </div>
              </div>

              {type === 'outgoing' && (
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-text-secondary uppercase tracking-tight">Encryption Mode</label>
                  <div className="flex gap-2 p-1 bg-sidebar rounded-md border border-border">
                    {['starttls', 'implicit', 'none'].map(mode => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setFormData({...formData, tlsMode: mode as any})}
                        className={`flex-1 py-1.5 text-[11px] font-bold uppercase rounded transition-all ${formData.tlsMode === mode ? 'bg-white shadow-sm text-accent border border-border/50' : 'text-text-secondary hover:text-text-primary'}`}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          <section className="space-y-4 pt-6 border-t border-border/50">
            <div className="flex items-center gap-2 mb-4">
              <Key className="w-5 h-5 text-accent" />
              <h2 className="text-lg font-bold">Authentication</h2>
            </div>

            {formData.provider === 'gmail' || formData.authType === 'oauth2' ? (
              <div className="bg-accent/5 border border-accent/20 rounded-lg p-4 flex gap-3 items-start">
                <AlertCircle className="w-4 h-4 text-accent mt-0.5" />
                <div className="text-xs leading-relaxed">
                  <p className="font-bold text-accent mb-1">OAuth2 Authentication Required</p>
                  <p className="text-text-secondary">You will be redirected to Google after saving to authorize access. Make sure your Google Cloud Project credentials are configured in the backend.</p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-text-secondary uppercase tracking-tight">Username</label>
                  <input 
                    type="text" 
                    placeholder="Same as email if empty"
                    className="input text-sm"
                    value={formData.username}
                    onChange={e => setFormData({...formData, username: e.target.value})}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-text-secondary uppercase tracking-tight">Password / App Key</label>
                  <input 
                    type="password" 
                    required={formData.authType === 'password'}
                    className="input text-sm"
                    value={formData.password}
                    onChange={e => setFormData({...formData, password: e.target.value})}
                  />
                </div>
              </div>
            )}
          </section>

          <div className="pt-8 flex gap-3">
            <button 
              type="submit" 
              disabled={createMutation.isPending}
              className="px-6 py-2.5 bg-accent hover:bg-accent-hover text-white text-sm font-bold rounded-md transition-all shadow-md flex items-center gap-2 disabled:opacity-50"
            >
              {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Save Connector
            </button>
            <button 
              type="button" 
              onClick={() => navigate('/settings')}
              className="px-6 py-2.5 bg-white border border-border hover:bg-sidebar text-text-secondary text-sm font-bold rounded-md transition-all"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ConnectorSetupView;
