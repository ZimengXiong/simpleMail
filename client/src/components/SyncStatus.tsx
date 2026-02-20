import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueries, type Query } from '@tanstack/react-query';
import { api } from '../services/api';
import { RefreshCw, CheckCircle2, AlertCircle, ChevronDown } from 'lucide-react';
import type { MailboxSyncState } from '../types/index';
import { countActiveSyncStates, hasActiveSyncStates } from '../services/syncState';

const SyncStatus = () => {
  const [isTabFocused, setIsTabFocused] = useState(() => document.visibilityState === 'visible');
  const [hoveredConnectorId, setHoveredConnectorId] = useState<string | null>(null);
  const [pinnedConnectorId, setPinnedConnectorId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const onVisibilityChange = () => {
      setIsTabFocused(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);
  const { data: connectors } = useQuery({
    queryKey: ['connectors', 'incoming'],
    queryFn: () => api.connectors.listIncoming(),
    staleTime: 30_000,
    refetchInterval: isTabFocused ? 60_000 : 180_000,
  });

  const syncStateQueries = useQueries({
    queries: (connectors ?? []).map((connector) => ({
      queryKey: ['syncStates', connector.id],
      queryFn: ({ signal }: { signal?: AbortSignal }) => api.sync.getStates(connector.id, signal),
      enabled: Boolean(connector.id),
      refetchInterval: (query: Query) =>
        hasActiveSyncStates(
          ((query.state.data as { states?: Array<MailboxSyncState & { mailbox: string }> } | undefined)?.states) ?? [],
        )
          ? 4_000
          : (isTabFocused ? 20_000 : 60_000),
    })),
  });

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const connectorStates = useMemo(
    () =>
      (connectors ?? []).map((connector) => ({ connector })),
    [connectors],
  );

  const formatRelativeTime = (isoLike: string | null | undefined, timestamp = now) => {
    if (!isoLike) {
      return 'never';
    }
    const parsed = Date.parse(String(isoLike));
    if (!Number.isFinite(parsed)) {
      return 'unknown';
    }
    const seconds = Math.max(0, Math.floor((timestamp - parsed) / 1000));
    if (seconds < 60) {
      return `${seconds}s ago`;
    }
    if (seconds < 3600) {
      return `${Math.floor(seconds / 60)}m ago`;
    }
    if (seconds < 86400) {
      return `${Math.floor(seconds / 3600)}h ago`;
    }
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  const isAutoRecoveryErrorMessage = (value: string | null | undefined) => {
    const message = String(value ?? '').trim().toLowerCase();
    if (!message) {
      return false;
    }
    return message.includes('stale sync state reaped by maintenance')
      || message.includes('previous sync stalled and was auto-restarted');
  };

  const formatSyncErrorMessage = (value: string | null | undefined) => {
    if (isAutoRecoveryErrorMessage(value)) {
      return 'Previous sync stalled. Auto-recovery is in progress.';
    }
    const message = String(value ?? '').trim();
    return message.length > 0 ? message : null;
  };

  const statusLabel = (value: MailboxSyncState['status'], syncError?: string | null) => {
    switch (value) {
      case 'syncing':
        return 'Syncing';
      case 'queued':
        return 'Queued';
      case 'cancel_requested':
        return 'Cancel Requested';
      case 'cancelled':
        return 'Cancelled';
      case 'completed':
        return 'Completed';
      case 'error':
        if (isAutoRecoveryErrorMessage(syncError)) {
          return 'Recovering';
        }
        return 'Error';
      case 'idle':
      default:
        return 'Idle';
    }
  };

  const statusBadgeClass = (value: MailboxSyncState['status'], syncError?: string | null) => {
    if (value === 'syncing' || value === 'queued' || value === 'cancel_requested') {
      return 'bg-accent/10 text-accent border-accent/25';
    }
    if (value === 'error') {
      if (isAutoRecoveryErrorMessage(syncError)) {
        return 'bg-amber-50 text-amber-700 border-amber-200';
      }
      return 'bg-red-50 text-red-600 border-red-200';
    }
    if (value === 'completed') {
      return 'bg-green-50 text-green-700 border-green-200';
    }
    if (value === 'cancelled') {
      return 'bg-amber-50 text-amber-700 border-amber-200';
    }
    return 'bg-black/5 text-text-secondary border-border/60 dark:bg-white/5';
  };

  const summarizeStates = (states: Array<MailboxSyncState & { mailbox?: string }> = []) => {
    const total = states.length;
    const active = countActiveSyncStates(states);
    const transientRecovering = states.filter((state) =>
      state.status === 'error' && isAutoRecoveryErrorMessage(state.syncError),
    );
    const errors = states.filter((state) =>
      state.status === 'error' && !isAutoRecoveryErrorMessage(state.syncError),
    );
    const queued = states.filter((state) => state.status === 'queued' || state.status === 'cancel_requested').length;
    const firstError = [...errors, ...transientRecovering]
      .map((state) => formatSyncErrorMessage(state.syncError))
      .find((value): value is string => Boolean(value)) ?? null;
    const lastCompletedAt = states
      .map((state) => state.syncCompletedAt ?? null)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
    const totals = states.reduce((acc, state) => {
      const progress = state.syncProgress ?? {};
      return {
        inserted: acc.inserted + (progress.inserted ?? 0),
        updated: acc.updated + (progress.updated ?? 0) + (progress.metadataRefreshed ?? 0),
        reconciled: acc.reconciled + (progress.reconciledRemoved ?? 0),
      };
    }, { inserted: 0, updated: 0, reconciled: 0 });
    return {
      total,
      active,
      queued,
      errors,
      recovering: transientRecovering.length,
      firstError,
      lastCompletedAt,
      ...totals,
    };
  };

  return (
    <div className="flex flex-col gap-1.5 px-1 py-1">
      {connectorStates.map(({ connector }, index) => {
        const payload = syncStateQueries[index]?.data as { states?: Array<MailboxSyncState & { mailbox: string }> } | undefined;
        const states = payload?.states ?? [];
        const summary = summarizeStates(states);
        const status = summary.errors.length > 0
          ? 'error'
          : (summary.active > 0 ? 'syncing' : (summary.recovering > 0 ? 'recovering' : 'completed'));
        const isExpanded = (pinnedConnectorId ?? hoveredConnectorId) === connector.id;

        const downloaded = summary.inserted;
        const total = summary.total || 0;
        const activeCount = summary.active;

        return (
          <div
            key={connector.id}
            className="rounded-md border border-border/50 bg-bg-card/60 transition-colors"
            onMouseEnter={() => setHoveredConnectorId(connector.id)}
            onMouseLeave={() => setHoveredConnectorId(null)}
          >
            <button
              type="button"
              onClick={() => {
                setPinnedConnectorId((current) => (current === connector.id ? null : connector.id));
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-black/5 dark:hover:bg-white/5 rounded-md transition-colors"
            >
              <div className="shrink-0">
                {status === 'syncing' ? (
                  <RefreshCw className="w-3 h-3 text-accent animate-spin" />
                ) : status === 'error' ? (
                  <AlertCircle className="w-3 h-3 text-red-500" />
                ) : status === 'recovering' ? (
                  <RefreshCw className="w-3 h-3 text-amber-600 animate-spin" />
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
                    {activeCount}/{total} active
                    {summary.queued > 0 ? ` · ${summary.queued} queued` : ''}
                    {downloaded > 0 ? ` · ${downloaded} downloaded` : ''}
                  </span>
                )}
                {status === 'error' && (
                  <span className="text-[9px] text-red-500 font-medium truncate max-w-[180px]" title={summary.firstError ?? 'Sync failed'}>
                    {summary.firstError ?? 'Sync failed (no details)'}
                  </span>
                )}
                {status === 'recovering' && (
                  <span className="text-[9px] text-amber-700 font-medium truncate max-w-[180px]" title={summary.firstError ?? 'Recovery in progress'}>
                    {summary.firstError ?? 'Recovery in progress'}
                  </span>
                )}
                {status === 'completed' && (
                  <span className="text-[9px] text-text-secondary font-medium opacity-80">
                    Last completed {formatRelativeTime(summary.lastCompletedAt, now)}
                  </span>
                )}
              </div>

              <ChevronDown className={`w-3 h-3 text-text-secondary transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
            </button>

            {isExpanded && (
              <div className="px-2 pb-2">
                <div className="rounded-md border border-border/60 bg-bg-app/80 max-h-44 overflow-y-auto">
                  {states.length === 0 ? (
                    <div className="px-2.5 py-2 text-[10px] text-text-secondary">
                      No mailbox sync states yet.
                    </div>
                  ) : (
                    states.map((state) => {
                      const progress = state.syncProgress ?? {};
                      const progressLabel = [
                        Number(progress.inserted ?? 0) > 0 ? `+${progress.inserted} new` : '',
                        Number(progress.updated ?? 0) > 0 ? `~${progress.updated} updated` : '',
                        Number(progress.metadataRefreshed ?? 0) > 0 ? `${progress.metadataRefreshed} metadata` : '',
                        Number(progress.reconciledRemoved ?? 0) > 0 ? `-${progress.reconciledRemoved} removed` : '',
                      ].filter(Boolean).join(' · ');
                      const whenText = state.status === 'syncing'
                        ? `started ${formatRelativeTime(state.syncStartedAt, now)}`
                        : `updated ${formatRelativeTime(state.syncCompletedAt ?? state.syncStartedAt, now)}`;
                      return (
                        <div key={`${connector.id}:${state.mailbox}`} className="px-2.5 py-2 border-b border-border/40 last:border-b-0">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-[10px] font-bold text-text-primary truncate">{state.mailbox}</div>
                              <div className="text-[9px] text-text-secondary">{whenText}</div>
                            </div>
                            <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border ${statusBadgeClass(state.status, state.syncError)}`}>
                              {statusLabel(state.status, state.syncError)}
                            </span>
                          </div>
                          {progressLabel ? (
                            <div className="mt-1 text-[9px] text-text-secondary">{progressLabel}</div>
                          ) : null}
                          {state.status === 'error' && formatSyncErrorMessage(state.syncError) ? (
                            <div className={`mt-1 text-[9px] break-words ${isAutoRecoveryErrorMessage(state.syncError) ? 'text-amber-700' : 'text-red-500'}`}>
                              {formatSyncErrorMessage(state.syncError)}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
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
