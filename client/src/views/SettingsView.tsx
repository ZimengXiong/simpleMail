import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import {
  Plus,
  Trash2,
  Mail,
  ChevronRight,
  Zap,
  UserCircle,
  Loader2,
  Send,
  RefreshCw,
  Layout,
  Check,
  Moon,
  Sun,
  Palette,
  ShieldCheck
} from 'lucide-react';
import { Link } from 'react-router-dom';
import EmptyState from '../components/EmptyState';
import IdentityModal from '../components/IdentityModal';
import { useTheme } from '../services/theme';
import Avatar from '../components/Avatar';

const SettingsView = () => {
  const queryClient = useQueryClient();
  const { theme, setTheme, accentColor, setAccentColor } = useTheme();
  const [activeTab, setActiveTab] = useState<'accounts' | 'identities' | 'appearance'>('accounts');
  const [isIdentityModalOpen, setIsIdentityModalOpen] = useState(false);
  const [editingIdentity, setEditingIdentity] = useState<any | null>(null);
  const [gmailPushErrors, setGmailPushErrors] = useState<Record<string, string>>({});
  const [smtpTestResults, setSmtpTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  // Layout Preference
  const [layoutMode, setLayoutMode] = useState<'columns' | 'list'>(() =>
    (localStorage.getItem('layoutMode') as 'columns' | 'list') || 'columns'
  );

  const toggleLayout = (mode: 'columns' | 'list') => {
    setLayoutMode(mode);
    localStorage.setItem('layoutMode', mode);
    window.dispatchEvent(new Event('storage'));
  };

  const { data: incomingConnectors, isLoading: loadingIncoming } = useQuery({
    queryKey: ['connectors', 'incoming'],
    queryFn: () => api.connectors.listIncoming(),
    staleTime: 60_000,
  });

  const { data: outgoingConnectors, isLoading: loadingOutgoing } = useQuery({
    queryKey: ['connectors', 'outgoing'],
    queryFn: () => api.connectors.listOutgoing(),
    staleTime: 60_000,
  });

  const { data: identities, isLoading: loadingIdentities } = useQuery({
    queryKey: ['identities'],
    queryFn: () => api.identities.list(),
    staleTime: 60_000,
  });

  const deleteIncoming = useMutation({
    mutationFn: (id: string) => api.connectors.deleteIncoming(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connectors', 'incoming'] });
      queryClient.invalidateQueries({ queryKey: ['identities'] });
    },
  });

  const deleteOutgoing = useMutation({
    mutationFn: (id: string) => api.connectors.deleteOutgoing(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connectors', 'outgoing'] });
      queryClient.invalidateQueries({ queryKey: ['identities'] });
    },
  });

  const testOutgoing = useMutation({
    mutationFn: (id: string) => api.connectors.testOutgoing(id),
    onSuccess: (_, connectorId) => {
      setSmtpTestResults((prev) => ({
        ...prev,
        [connectorId]: { ok: true, message: 'SMTP verified' },
      }));
    },
    onError: (error, connectorId) => {
      setSmtpTestResults((prev) => ({
        ...prev,
        [connectorId]: {
          ok: false,
          message: error instanceof Error ? error.message : 'SMTP test failed',
        },
      }));
    },
  });

  const deleteIdentity = useMutation({
    mutationFn: (id: string) => api.identities.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['identities'] })
  });

  const manualSync = useMutation({
    mutationFn: (id: string) => api.sync.trigger(id, 'INBOX', false, false),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['events'] })
  });

  const toggleGmailPush = useMutation({
    mutationFn: ({ id, enabled }: { id: string, enabled: boolean }) =>
      api.sync.setGmailPush(id, enabled),
    onMutate: ({ id }) => {
      setGmailPushErrors((prev) => ({ ...prev, [id]: '' }));
    },
    onSuccess: (_, variables) => {
      setGmailPushErrors((prev) => ({ ...prev, [variables.id]: '' }));
      queryClient.invalidateQueries({ queryKey: ['connectors', 'incoming'] });
      queryClient.invalidateQueries({ queryKey: ['syncStates'] });
    },
    onError: (error, variables) => {
      const message = error instanceof Error ? error.message : 'Failed to update Gmail Pub/Sub';
      setGmailPushErrors((prev) => ({ ...prev, [variables.id]: message }));
    },
  });

  const isLoading = loadingIncoming || loadingOutgoing || loadingIdentities;

  const accentColors = [
    { name: 'Graphite', value: '#37352f' },
    { name: 'Crema', value: '#efecd3' },
    { name: 'Classic Blue', value: '#2383e2' },
    { name: 'Deep Purple', value: '#2B1D3A' },
    { name: 'Emerald', value: '#10b981' },
    { name: 'Rose', value: '#e11d48' },
    { name: 'Amber', value: '#f59e0b' },
  ];

  return (
    <div className="flex-1 flex flex-col h-full bg-bg-app overflow-y-auto">
      <div className="h-12 border-b border-border bg-bg-card flex items-center px-4 shrink-0 sticky top-0 z-10">
        <h1 className="text-sm font-semibold">Settings</h1>
      </div>

      <div className="max-w-4xl mx-auto w-full p-8 pb-32">
        <div className="flex gap-1 mb-8">
          {['accounts', 'identities', 'appearance'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab as any)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors capitalize ${activeTab === tab ? 'bg-black/5 dark:bg-white/10 text-text-primary' : 'text-text-secondary hover:bg-black/5 dark:hover:bg-white/5'}`}
            >
              {tab === 'accounts' ? 'Accounts & Connectors' : tab}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-text-secondary" />
          </div>
        ) : (
          <>
            {activeTab === 'appearance' && (
              <div className="space-y-12 animate-in fade-in duration-300">
                {/* Theme Toggle */}
                <section>
                  <h2 className="text-base font-semibold text-text-primary mb-4 border-b border-border pb-2 flex items-center gap-2">
                    <Palette className="w-4 h-4 text-accent" />
                    Visual Theme
                  </h2>
                  <div className="grid grid-cols-2 gap-4">
                    <button
                      onClick={() => setTheme('light')}
                      className={`flex items-center justify-center gap-3 p-4 rounded-md border transition-all ${theme === 'light' ? 'border-accent bg-accent/5' : 'border-border bg-bg-card hover:border-text-secondary/30'}`}
                    >
                      <Sun className={`w-4 h-4 ${theme === 'light' ? 'text-accent' : 'text-text-secondary'}`} />
                      <span className={`text-sm font-semibold ${theme === 'light' ? 'text-accent' : 'text-text-primary'}`}>Light Mode</span>
                    </button>
                    <button
                      onClick={() => setTheme('dark')}
                      className={`flex items-center justify-center gap-3 p-4 rounded-md border transition-all ${theme === 'dark' ? 'border-accent bg-accent/5' : 'border-border bg-bg-card hover:border-text-secondary/30'}`}
                    >
                      <Moon className={`w-4 h-4 ${theme === 'dark' ? 'text-accent' : 'text-text-secondary'}`} />
                      <span className={`text-sm font-semibold ${theme === 'dark' ? 'text-accent' : 'text-text-primary'}`}>Dark Mode</span>
                    </button>
                  </div>
                </section>

                {/* Accent Color Picker */}
                <section>
                  <h2 className="text-base font-semibold text-text-primary mb-4 border-b border-border pb-2">Accent Color</h2>
                  <div className="flex flex-wrap gap-3">
                    {accentColors.map(color => (
                      <button
                        key={color.value}
                        onClick={() => setAccentColor(color.value)}
                        className={`group relative w-8 h-8 rounded-md border transition-all ${accentColor === color.value ? 'border-accent ring-1 ring-accent/20' : 'border-transparent'}`}
                        style={{ backgroundColor: color.value }}
                        title={color.name}
                      >
                        {accentColor === color.value && <Check className="w-3 h-3 text-white drop-shadow-md absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />}
                      </button>
                    ))}
                  </div>
                </section>

                {/* Dashboard Layout */}
                <section>
                  <h2 className="text-base font-semibold text-text-primary mb-4 border-b border-border pb-2 flex items-center gap-2">
                    <Layout className="w-4 h-4 text-accent" />
                    Dashboard Layout
                  </h2>
                  <div className="grid grid-cols-2 gap-6">
                    <button
                      onClick={() => toggleLayout('columns')}
                      className={`flex flex-col gap-3 p-4 rounded-md border transition-all text-left group ${layoutMode === 'columns' ? 'border-accent bg-accent/5' : 'border-border hover:border-text-secondary/30 bg-bg-card'}`}
                    >
                      <div className="flex gap-1.5 h-24 w-full opacity-40">
                        <div className="w-1/4 h-full bg-text-secondary/20 rounded-sm" />
                        <div className="w-1/3 h-full bg-text-secondary/20 rounded-sm" />
                        <div className="flex-1 h-full bg-accent/20 rounded-sm border border-accent/20" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold flex items-center gap-2">
                          Column View (3-Pane)
                          {layoutMode === 'columns' && <Check className="w-3.5 h-3.5 text-accent" />}
                        </div>
                        <p className="text-xs text-text-secondary mt-1">Side-by-side message list and reading pane.</p>
                      </div>
                    </button>

                    <button
                      onClick={() => toggleLayout('list')}
                      className={`flex flex-col gap-3 p-4 rounded-md border transition-all text-left group ${layoutMode === 'list' ? 'border-accent bg-accent/5' : 'border-border hover:border-text-secondary/30 bg-bg-card'}`}
                    >
                      <div className="flex flex-col gap-1.5 h-24 w-full opacity-40">
                        <div className="h-4 bg-text-secondary/20 rounded-sm w-full" />
                        <div className="h-4 bg-text-secondary/20 rounded-sm w-full" />
                        <div className="h-12 bg-accent/20 rounded-sm w-full border border-accent/20 flex items-center px-3 text-[8px] font-bold text-accent uppercase">Reading Pane</div>
                      </div>
                      <div>
                        <div className="text-sm font-semibold flex items-center gap-2">
                          List View (Gmail-style)
                          {layoutMode === 'list' && <Check className="w-3.5 h-3.5 text-accent" />}
                        </div>
                        <p className="text-xs text-text-secondary mt-1">Full-width message list. Opens replace the list view.</p>
                      </div>
                    </button>
                  </div>
                </section>
              </div>
            )}

            {activeTab === 'accounts' && (
              <div className="space-y-12 animate-in fade-in duration-300">
                <section>
                  <div className="flex items-center justify-between mb-4 border-b border-border pb-2">
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-semibold text-text-primary">Incoming Accounts</h2>
                    </div>
                    <Link to="/settings/connectors/new?type=incoming" className="flex items-center gap-1.5 px-3 py-1 bg-accent hover:bg-accent-hover text-sm font-semibold rounded-md transition-all" style={{ color: 'var(--accent-contrast)' }}>
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add account</span>
                    </Link>
                  </div>

                  {!incomingConnectors?.length ? (
                    <div className="p-8 border border-dashed border-border rounded-md text-center bg-bg-card">
                      <Mail className="w-8 h-8 text-text-secondary opacity-10 mx-auto mb-3" />
                      <p className="text-size-sm text-text-secondary font-medium">No incoming accounts connected yet.</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-2">
                      {incomingConnectors.map(connector => {
                        const isGmailApiConnector = connector.provider === 'gmail';
                        const isGmailPushEnabled = isGmailApiConnector
                          ? connector.syncSettings?.gmailPush?.enabled !== false
                          : false;
                        const isGmailPushPending = toggleGmailPush.isPending
                          && toggleGmailPush.variables?.id === connector.id;
                        const gmailPushError = gmailPushErrors[connector.id] ?? '';

                        return (
                          <div key={connector.id} className="flex items-center justify-between p-3 hover:bg-black/5 dark:hover:bg-white/5 rounded-md transition-colors group">
                            <div className="flex items-center gap-3 min-w-0">
                              <Avatar visualConfig={connector.visual_config} text={connector.name} fallbackIcon={Mail} size="lg" />
                              <div className="min-w-0">
                                <h3 className="text-size-sm font-semibold text-text-primary truncate">{connector.name}</h3>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-size-tiny font-bold uppercase tracking-wider text-text-secondary opacity-50 bg-black/5 dark:bg-white/10 px-1 rounded-sm">
                                    {connector.provider}
                                  </span>
                                  <span className="text-size-tiny text-text-secondary truncate">{connector.emailAddress}</span>
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-1 opacity-40 group-hover:opacity-100 transition-opacity">
                              <button onClick={() => manualSync.mutate(connector.id)} className="p-1.5 hover:bg-black/5 rounded text-text-secondary" title="Sync Now"><RefreshCw className={`w-3.5 h-3.5 ${manualSync.isPending && manualSync.variables === connector.id ? 'animate-spin' : ''}`} /></button>
                              {isGmailApiConnector && (
                                <button
                                  onClick={() => toggleGmailPush.mutate({ id: connector.id, enabled: !isGmailPushEnabled })}
                                  disabled={isGmailPushPending}
                                  className={`p-1.5 rounded ${isGmailPushEnabled ? 'text-accent bg-accent/10' : 'text-text-secondary hover:bg-black/5'}`}
                                  title={gmailPushError ? `Gmail Push Error: ${gmailPushError}` : 'Gmail Push'}
                                >
                                  {isGmailPushPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                                </button>
                              )}
                              <button
                                onClick={() => { if (window.confirm('Delete account?')) deleteIncoming.mutate(connector.id); }}
                                className="p-1.5 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 rounded transition-colors"
                                title="Delete"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>

                <section>
                  <div className="flex items-center justify-between mb-4 border-b border-border pb-2">
                    <h2 className="text-base font-semibold text-text-primary">Outgoing Servers</h2>
                    <Link to="/settings/connectors/new?type=outgoing" className="flex items-center gap-1.5 px-3 py-1 bg-accent hover:bg-accent-hover text-sm font-semibold rounded-md transition-all" style={{ color: 'var(--accent-contrast)' }}>
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add server</span>
                    </Link>
                  </div>

                  {!outgoingConnectors?.length ? (
                    <div className="p-8 border border-dashed border-border rounded-md text-center bg-bg-card">
                      <Send className="w-8 h-8 text-text-secondary opacity-10 mx-auto mb-3" />
                      <p className="text-size-sm text-text-secondary font-medium">No outgoing servers configured yet.</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-2">
                      {outgoingConnectors.map(connector => {
                        const smtpTest = smtpTestResults[connector.id];
                        const smtpTestPending = testOutgoing.isPending && testOutgoing.variables === connector.id;
                        return (
                          <div key={connector.id} className="flex items-center justify-between p-3 hover:bg-black/5 dark:hover:bg-white/5 rounded-md transition-colors group">
                            <div className="flex items-center gap-3 min-w-0">
                              <Avatar fallbackIcon={Send} size="lg" />
                              <div className="min-w-0">
                                <h3 className="text-size-sm font-semibold text-text-primary truncate">{connector.name}</h3>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-size-tiny font-bold uppercase tracking-wider text-text-secondary opacity-50 bg-black/5 dark:bg-white/10 px-1 rounded-sm">
                                    {connector.provider}
                                  </span>
                                  <span className="text-size-tiny text-text-secondary truncate">{connector.fromAddress}</span>
                                  {smtpTest && (
                                    <span className={`text-size-tiny truncate ${smtpTest.ok ? 'text-green-600' : 'text-red-500'}`}>
                                      {smtpTest.message}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 opacity-40 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => testOutgoing.mutate(connector.id)}
                                disabled={smtpTestPending}
                                className="p-1.5 hover:bg-black/5 rounded text-text-secondary disabled:opacity-50"
                                title="Test SMTP authentication"
                              >
                                {smtpTestPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                              </button>
                              <button onClick={() => { if (window.confirm('Delete?')) deleteOutgoing.mutate(connector.id); }} className="p-1.5 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 rounded transition-colors" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>
              </div>
            )}

            {activeTab === 'identities' && (
              <div className="space-y-6 animate-in fade-in duration-300">
                <div className="flex items-center justify-between mb-4 border-b border-border pb-2">
                  <h2 className="text-base font-semibold text-text-primary">Sender Identities</h2>
                  <button onClick={() => setIsIdentityModalOpen(true)} className="flex items-center gap-1.5 px-3 py-1 bg-accent hover:bg-accent-hover text-sm font-semibold rounded-md transition-all" style={{ color: 'var(--accent-contrast)' }}>
                    <Plus className="w-3.5 h-3.5" />
                    <span>New Identity</span>
                  </button>
                </div>

                {!identities?.length ? (
                  <EmptyState icon={UserCircle} title="No identities" description="Identities allow you to customize your 'From' name and signature." actionText="Create identity" onAction={() => setIsIdentityModalOpen(true)} />
                ) : (
                  <div className="space-y-1">
                    {identities.map(identity => (
                      <div key={identity.id} className="flex items-center justify-between p-3 hover:bg-black/5 dark:hover:bg-white/5 rounded-md transition-colors group">
                        <div className="flex items-center gap-3 min-w-0">
                          <Avatar visualConfig={identity.visual_config} text={identity.displayName} fallbackIcon={UserCircle} size="lg" />
                          <div className="min-w-0">
                            <div className="text-size-sm font-semibold text-text-primary truncate">{identity.displayName}</div>
                            <div className="text-size-xs text-text-secondary truncate">{identity.emailAddress}</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 opacity-40 group-hover:opacity-100 transition-opacity">
                          <button onClick={() => { if (window.confirm('Delete?')) deleteIdentity.mutate(identity.id); }} className="p-1.5 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 rounded"><Trash2 className="w-3.5 h-3.5" /></button>
                          <button onClick={() => setEditingIdentity(identity)} className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-secondary"><ChevronRight className="w-4 h-4" /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

          </>
        )}
      </div>

      {(isIdentityModalOpen || editingIdentity) && <IdentityModal onClose={() => { setIsIdentityModalOpen(false); setEditingIdentity(null); }} incomingConnectors={incomingConnectors || []} outgoingConnectors={outgoingConnectors || []} identity={editingIdentity} />}
    </div>
  );
};

export default SettingsView;
