import { useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, AlertCircle, Inbox, Settings, RefreshCw } from 'lucide-react';
import { api } from '../services/api';

const OAuthCallbackView = () => {
  const [searchParams] = useSearchParams();

  const status = searchParams.get('status');
  const connectorType = searchParams.get('connectorType') || searchParams.get('type');
  const connectorId = searchParams.get('connectorId') || searchParams.get('id');
  const errorMessage = searchParams.get('error') || searchParams.get('message') || 'An unexpected error occurred during authorization.';
  const shouldTrackSync = Boolean(
    status === 'ok'
    && connectorType === 'incoming'
    && connectorId
    && api.auth.isAuthenticated(),
  );

  const initialSyncMutation = useMutation({
    mutationFn: async () => {
      if (!connectorId) return;
      await api.sync.trigger(connectorId, 'INBOX', true, true);
    },
  });

  const syncStatesQuery = useQuery({
    queryKey: ['syncStates', connectorId],
    queryFn: () => api.sync.getStates(connectorId!),
    enabled: shouldTrackSync,
    refetchInterval: (query) => {
      const states = query.state.data?.states ?? [];
      const isActive = states.some(
        (state) => state.status === 'syncing' || state.status === 'queued' || state.status === 'cancel_requested',
      );
      return isActive ? 1000 : 5000;
    },
  });

  useEffect(() => {
    if (!shouldTrackSync || initialSyncMutation.isPending || initialSyncMutation.isSuccess) {
      return;
    }
    initialSyncMutation.mutate();
  }, [shouldTrackSync, initialSyncMutation]);

  const states = syncStatesQuery.data?.states ?? [];
  const activeFolders = states.filter((state) =>
    state.status === 'syncing' || state.status === 'queued' || state.status === 'cancel_requested').length;
  const failedFolders = states.filter((state) => state.status === 'error').length;
  const progress = states.reduce((acc, state) => {
    const snapshot = state.syncProgress ?? {};
    return {
      inserted: acc.inserted + (snapshot.inserted ?? 0),
      updated: acc.updated + (snapshot.updated ?? 0) + (snapshot.metadataRefreshed ?? 0),
      reconciled: acc.reconciled + (snapshot.reconciledRemoved ?? 0),
    };
  }, { inserted: 0, updated: 0, reconciled: 0 });

  return (
    <div className="min-h-screen w-full bg-bg-app flex items-center justify-center p-4 font-sans">
      <div className="w-full max-w-2xl animate-in fade-in zoom-in-95 duration-500">
        {status === 'ok' ? (
          <div className="card bg-bg-card p-8 shadow-xl border-border">
            <div className="flex items-start gap-4 mb-6">
              <div className="w-12 h-12 bg-green-50 dark:bg-green-900/20 rounded-full flex items-center justify-center border border-green-100 dark:border-green-900/30 shrink-0">
                <CheckCircle2 className="w-6 h-6 text-green-500" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-text-primary">Gmail Connected</h1>
                <p className="text-sm text-text-secondary">
                  Connector authorized. Initial full sync is running across all folders.
                </p>
                <p className="text-xs text-text-secondary mt-1">
                  Sync starts with metadata (folder + headers/snippets), then downloads full message bodies and attachments in follow-up hydration.
                </p>
              </div>
            </div>

            {shouldTrackSync ? (
              <div className="mb-6 border border-border/60 rounded-xl p-4 bg-black/[0.02] dark:bg-white/[0.02]">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[11px] font-bold text-text-primary uppercase tracking-widest opacity-70">
                    Onboarding Sync
                  </p>
                  <button
                    onClick={() => initialSyncMutation.mutate()}
                    className="px-2.5 py-1 text-[11px] font-bold rounded-lg border border-border/60 hover:bg-black/5 dark:hover:bg-white/5 text-text-secondary"
                    disabled={initialSyncMutation.isPending}
                  >
                    {initialSyncMutation.isPending ? 'Queueing…' : 'Run full sync again'}
                  </button>
                </div>

                <div className="text-xs text-text-secondary mb-3">
                  {activeFolders > 0
                    ? `Syncing ${activeFolders}/${states.length || 1} folders`
                    : `Synced ${states.length || 1} folders`}
                  {failedFolders > 0 ? `, ${failedFolders} failed` : ''}
                  {` · ${progress.inserted} downloaded · ${progress.updated} updated · ${progress.reconciled} reconciled`}
                </div>

                <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
                  {states.map((state) => (
                    <div key={state.mailbox} className="flex items-center justify-between text-[11px] border border-border/40 rounded-lg px-2.5 py-1.5 bg-bg-card">
                      <span className="font-bold text-text-primary">{state.mailbox}</span>
                      <span className="text-text-secondary">
                        {state.status}
                        {state.syncProgress?.inserted ? ` · +${state.syncProgress.inserted}` : ''}
                        {state.syncProgress?.updated ? ` · ~${state.syncProgress.updated}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="w-full space-y-3">
              <Link
                to="/inbox"
                className="w-full btn bg-accent hover:bg-accent-hover py-2.5 font-bold flex items-center justify-center gap-2 shadow-md shadow-accent/10"
                style={{ color: 'var(--accent-contrast)' }}
              >
                <Inbox className="w-4 h-4" />
                Continue to Inbox
              </Link>
              <Link
                to="/settings/connectors/new?type=incoming"
                className="w-full btn bg-bg-card border border-border hover:bg-sidebar text-text-secondary py-2.5 font-bold flex items-center justify-center gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                Connect another account
              </Link>
            </div>
          </div>
        ) : (
          <div className="card bg-bg-card p-10 shadow-xl border-border flex flex-col items-center">
            <div className="w-20 h-20 bg-red-50 dark:bg-red-900/20 rounded-full flex items-center justify-center mb-6 border border-red-100 dark:border-red-900/30">
              <AlertCircle className="w-10 h-10 text-red-500" />
            </div>

            <h1 className="text-2xl font-bold text-text-primary mb-2">OAuth Failed</h1>
            <div className="bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/20 rounded-lg p-3 w-full mb-8">
              <p className="text-xs text-red-600 dark:text-red-400 font-medium leading-relaxed">
                {errorMessage}
              </p>
            </div>

            <div className="w-full space-y-3">
              <Link
                to="/settings/connectors/new?type=incoming"
                className="w-full btn bg-accent hover:bg-accent-hover py-2.5 font-bold flex items-center justify-center gap-2 shadow-md shadow-accent/10"
                style={{ color: 'var(--accent-contrast)' }}
              >
                <RefreshCw className="w-4 h-4" />
                Try again
              </Link>
              <Link
                to="/settings"
                className="w-full btn bg-bg-card border border-border hover:bg-sidebar text-text-secondary py-2.5 font-bold flex items-center justify-center gap-2"
              >
                <Settings className="w-4 h-4" />
                Back to Connectors
              </Link>
            </div>
          </div>
        )}

        <div className="mt-6">
          <p className="text-[11px] text-text-secondary font-mono opacity-60 text-center">
            CID: {connectorId || 'unknown'}
          </p>
        </div>
      </div>
    </div>
  );
};

export default OAuthCallbackView;
