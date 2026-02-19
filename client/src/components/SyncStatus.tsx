import { useMemo } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { api } from '../services/api';
import { RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react';
import type { MailboxSyncState } from '../types/index';
import { countActiveSyncStates, hasActiveSyncStates } from '../services/syncState';

const SyncStatus = () => {
  const isTabFocused = document.visibilityState === 'visible';
  const { data: connectors } = useQuery({
    queryKey: ['connectors', 'incoming'],
    queryFn: () => api.connectors.listIncoming(),
    staleTime: 30_000,
    refetchInterval: isTabFocused ? 30_000 : 120_000,
  });

  const syncStateQueries = useQueries({
    queries: (connectors ?? []).map((connector) => ({
      queryKey: ['syncStates', connector.id],
      queryFn: () => api.sync.getStates(connector.id),
      enabled: Boolean(connector.id),
      refetchInterval: (query: any) =>
        hasActiveSyncStates(query.state.data?.states ?? [])
          ? 2000
          : (isTabFocused ? 5000 : 20000),
    })),
  });

  const connectorStates = useMemo(
    () =>
      (connectors ?? []).map((connector) => ({ connector })),
    [connectors],
  );

  const summarizeStates = (states: Array<MailboxSyncState & { mailbox?: string }> = []) => {
    const total = states.length;
    const active = countActiveSyncStates(states);
    const errors = states.filter((state) => state.status === 'error');
    const firstError = errors
      .map((state) => (typeof state.syncError === 'string' ? state.syncError.trim() : ''))
      .find((value) => value.length > 0) ?? null;
    const totals = states.reduce((acc, state) => {
      const progress = state.syncProgress ?? {};
      return {
        inserted: acc.inserted + (progress.inserted ?? 0),
        updated: acc.updated + (progress.updated ?? 0) + (progress.metadataRefreshed ?? 0),
        reconciled: acc.reconciled + (progress.reconciledRemoved ?? 0),
      };
    }, { inserted: 0, updated: 0, reconciled: 0 });
    return { total, active, errors, firstError, ...totals };
  };

  return (
    <div className="flex flex-col gap-1.5 px-1 py-1">
      {connectorStates.map(({ connector }, index) => {
        const payload = syncStateQueries[index]?.data as { states?: Array<MailboxSyncState & { mailbox: string }> } | undefined;
        const states = payload?.states ?? [];
        const summary = summarizeStates(states);
        const status = summary.errors.length > 0
          ? 'error'
          : (summary.active > 0 ? 'syncing' : 'completed');
        
        const downloaded = summary.inserted;
        const total = summary.total || 0;
        const activeCount = summary.active;

        return (
          <div
            key={connector.id}
            className="flex items-center gap-2 px-1.5 py-0.5 rounded-md transition-colors"
          >
            <div className="shrink-0">
              {status === 'syncing' ? (
                <RefreshCw className="w-3 h-3 text-accent animate-spin" />
              ) : status === 'error' ? (
                <AlertCircle className="w-3 h-3 text-red-500" />
              ) : (
                <CheckCircle2 className="w-3 h-3 text-green-600 opacity-60" />
              )}
            </div>

            <div className="min-w-0 flex-1 flex flex-col leading-tight">
              <span className="text-[11px] font-semibold text-text-secondary truncate">
                {connector.name || connector.emailAddress}
              </span>
              {status === 'syncing' && (
                <span className="text-[9px] text-accent font-medium opacity-80">
                  {activeCount}/{total} active · {downloaded} new
                </span>
              )}
              {status === 'error' && (
                <span className="text-[9px] text-red-500 font-medium truncate max-w-[180px]" title={summary.firstError ?? 'Sync failed'}>
                  {summary.firstError ?? 'Sync failed (no details)'}
                </span>
              )}
            </div>
          </div>
        );
      })}

      {!connectorStates.length && (
        <div className="text-[10px] text-text-secondary px-2 py-1 italic font-medium opacity-50">
          No connectors.
        </div>
      )}
    </div>
  );
};

export default SyncStatus;
