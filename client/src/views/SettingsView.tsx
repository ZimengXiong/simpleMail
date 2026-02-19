import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { 
  Plus, 
  Trash2, 
  Settings2, 
  Mail, 
  ExternalLink,
  ChevronRight,
  ShieldCheck,
  Zap,
  Cpu,
  UserCircle,
  Filter,
  Loader2,
  Send
} from 'lucide-react';
import { Link } from 'react-router-dom';
import EmptyState from '../components/EmptyState';

const SettingsView = () => {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'accounts' | 'identities' | 'rules'>('accounts');

  const { data: incomingConnectors, isLoading: loadingIncoming } = useQuery({
    queryKey: ['connectors', 'incoming'],
    queryFn: () => api.connectors.listIncoming(),
  });

  const { data: outgoingConnectors, isLoading: loadingOutgoing } = useQuery({
    queryKey: ['connectors', 'outgoing'],
    queryFn: () => api.connectors.listOutgoing(),
  });

  const { data: identities, isLoading: loadingIdentities } = useQuery({
    queryKey: ['identities'],
    queryFn: () => api.identities.list(),
  });

  const triggerGoogleAuth = useMutation({
    mutationFn: (data: { type: 'incoming' | 'outgoing', connectorId: string }) => 
      api.oauth.google.authorize(data),
    onSuccess: (data) => {
      window.location.href = data.authorizeUrl;
    }
  });

  const isLoading = loadingIncoming || loadingOutgoing || loadingIdentities;

  return (
    <div className="flex-1 flex flex-col h-full bg-[#fbfbfa] overflow-y-auto overflow-x-hidden">
      <div className="h-12 border-b border-border bg-white flex items-center px-4 shrink-0 sticky top-0 z-10">
        <h1 className="text-sm font-semibold">Settings</h1>
      </div>

      <div className="max-w-4xl mx-auto w-full p-8 pb-32">
        <div className="flex gap-1 mb-8">
          <button 
            onClick={() => setActiveTab('accounts')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${activeTab === 'accounts' ? 'bg-black/5 text-text-primary' : 'text-text-secondary hover:bg-black/5'}`}
          >
            Accounts & Connectors
          </button>
          <button 
            onClick={() => setActiveTab('identities')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${activeTab === 'identities' ? 'bg-black/5 text-text-primary' : 'text-text-secondary hover:bg-black/5'}`}
          >
            Identities
          </button>
          <button 
            onClick={() => setActiveTab('rules')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${activeTab === 'rules' ? 'bg-black/5 text-text-primary' : 'text-text-secondary hover:bg-black/5'}`}
          >
            Rules & Filters
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-text-secondary" />
          </div>
        ) : (
          <>
            {activeTab === 'accounts' && (
              <div className="space-y-12 animate-in fade-in duration-300">
                <section>
                  <div className="flex items-center justify-between mb-4 border-b border-border pb-2">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-accent" />
                      <h2 className="text-base font-bold text-text-primary">Incoming (IMAP/Gmail)</h2>
                    </div>
                    <Link to="/settings/connectors/new?type=incoming" className="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-[12px] font-bold rounded-md transition-all shadow-sm">
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Incoming</span>
                    </Link>
                  </div>
                  
                  {!incomingConnectors?.length ? (
                    <div className="p-8 border border-dashed border-border rounded-lg text-center bg-white">
                      <Mail className="w-8 h-8 text-text-secondary opacity-20 mx-auto mb-3" />
                      <p className="text-xs text-text-secondary font-medium">No incoming accounts connected yet.</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {incomingConnectors.map(connector => (
                        <div key={connector.id} className="card group hover:border-accent/40 hover:shadow-sm transition-all flex flex-col justify-between">
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className={`w-2 h-2 rounded-full ${connector.status === 'active' ? 'bg-green-500' : 'bg-yellow-500'}`} title={connector.status} />
                                <span className="text-[10px] font-bold uppercase tracking-wider text-text-secondary opacity-60">
                                  {connector.provider}
                                </span>
                              </div>
                              <button className="p-1.5 hover:bg-black/5 rounded text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity">
                                <Settings2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                            <h3 className="text-sm font-bold text-text-primary truncate">{connector.name}</h3>
                            <p className="text-xs text-text-secondary truncate mt-0.5">{connector.emailAddress}</p>
                          </div>
                          <div className="mt-4 pt-4 border-t border-border/40 flex items-center justify-between">
                            <div className="text-[10px] text-text-secondary flex items-center gap-1">
                              <Zap className="w-3 h-3 text-accent" />
                              Synced {connector.updatedAt ? new Date(connector.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Never'}
                            </div>
                            {connector.provider === 'gmail' && !connector.authConfig?.refreshToken && (
                              <button 
                                onClick={() => triggerGoogleAuth.mutate({ type: 'incoming', connectorId: connector.id })}
                                className="text-[11px] font-bold text-accent hover:underline flex items-center gap-1"
                              >
                                Reconnect <ExternalLink className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section>
                  <div className="flex items-center justify-between mb-4 border-b border-border pb-2">
                    <div className="flex items-center gap-2">
                      <Send className="w-4 h-4 text-accent" />
                      <h2 className="text-base font-bold text-text-primary">Outgoing (SMTP/SES/Brevo)</h2>
                    </div>
                    <Link to="/settings/connectors/new?type=outgoing" className="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-[12px] font-bold rounded-md transition-all shadow-sm">
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Outgoing</span>
                    </Link>
                  </div>
                  
                  {!outgoingConnectors?.length ? (
                    <div className="p-8 border border-dashed border-border rounded-lg text-center bg-white">
                      <Send className="w-8 h-8 text-text-secondary opacity-20 mx-auto mb-3" />
                      <p className="text-xs text-text-secondary font-medium">No outgoing servers configured yet.</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {outgoingConnectors.map(connector => (
                        <div key={connector.id} className="card group hover:border-accent/40 transition-all">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-text-secondary opacity-60">
                              {connector.provider}
                            </span>
                            <button className="p-1.5 hover:bg-black/5 rounded text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity">
                              <Settings2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          <h3 className="text-sm font-bold text-text-primary">{connector.name}</h3>
                          <p className="text-xs text-text-secondary truncate mt-0.5">{connector.fromAddress}</p>
                          <div className="mt-3 text-[11px] text-text-secondary bg-sidebar/50 rounded-sm px-2 py-1 flex items-center justify-between">
                            <span className="truncate">{connector.host || 'Gmail SMTP'}</span>
                            <span className="font-mono text-[9px] px-1 bg-white border border-border rounded">{connector.port || '443'}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}

            {activeTab === 'identities' && (
              <div className="space-y-6 animate-in fade-in duration-300">
                <div className="flex items-center justify-between mb-4 border-b border-border pb-2">
                  <h2 className="text-base font-bold text-text-primary">Sender Identities</h2>
                  <button className="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-[12px] font-bold rounded-md transition-all shadow-sm">
                    <Plus className="w-3.5 h-3.5" />
                    <span>New Identity</span>
                  </button>
                </div>
                
                {!identities?.length ? (
                  <EmptyState 
                    icon={UserCircle}
                    title="No identities configured"
                    description="Identities allow you to customize your 'From' name, email, and signature. Each identity is linked to an outgoing connector."
                    actionText="Create your first identity"
                    actionPath="#"
                  />
                ) : (
                  <div className="space-y-3">
                    {identities.map(identity => (
                      <div key={identity.id} className="card flex items-center justify-between gap-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-accent/10 text-accent flex items-center justify-center font-bold text-xs">
                            {identity.displayName.charAt(0)}
                          </div>
                          <div>
                            <div className="text-sm font-bold">{identity.displayName}</div>
                            <div className="text-xs text-text-secondary">{identity.emailAddress}</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-6">
                          <div className="text-[11px]">
                            <span className="text-text-secondary mr-2">Using:</span>
                            <span className="font-medium text-text-primary px-2 py-0.5 bg-sidebar rounded border border-border/50">
                              {outgoingConnectors?.find(c => c.id === identity.outgoingConnectorId)?.name || 'Default SMTP'}
                            </span>
                          </div>
                          <button className="p-1.5 hover:bg-black/5 rounded-sm text-text-secondary">
                            <ChevronRight className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'rules' && (
              <div className="space-y-6 animate-in fade-in duration-300">
                <div className="flex items-center justify-between mb-4 border-b border-border pb-2">
                  <h2 className="text-base font-bold text-text-primary">Rules & Filters</h2>
                  <button className="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-[12px] font-bold rounded-md transition-all shadow-sm">
                    <Plus className="w-3.5 h-3.5" />
                    <span>New Rule</span>
                  </button>
                </div>
                
                <EmptyState 
                  icon={Filter}
                  title="No active rules"
                  description="Automation rules help you sort, move, and flag incoming messages automatically. Keep your inbox organized without lifting a finger."
                  actionText="Create your first rule"
                  actionPath="#"
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default SettingsView;
