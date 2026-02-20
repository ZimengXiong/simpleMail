import { useState, useMemo, lazy, Suspense, useCallback, useEffect } from 'react';
import { NavLink, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { 
  Inbox, 
  PenBox,
  Hash,
  Star,
  Loader2,
  Send,
  FileText,
  Trash2,
  AlertOctagon,
  Clock
} from 'lucide-react';
import { Github } from 'lucide-react';
import ProfileSwitcher from './ProfileSwitcher';
import AppBrand from './AppBrand';
import type { MailboxInfo } from '../types';
import {
  reduceInboxState,
  resolveInboxViewState,
  toInboxPath,
  readPersistedInboxState,
  type InboxStateEvent,
} from '../services/inboxStateMachine';

const loadComposeModal = () => import('./ComposeModal');
const ComposeModal = lazy(loadComposeModal);
const PAGE_SIZE = 50;

const Sidebar = () => {
  const [searchParams] = useSearchParams();
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const queryClient = useQueryClient();
  const preferredInboxState = readPersistedInboxState();

  const { data: connectors } = useQuery({
    queryKey: ['connectors', 'incoming'],
    queryFn: () => api.connectors.listIncoming(),
    staleTime: 60_000,
  });
  const { data: outgoingConnectors } = useQuery({
    queryKey: ['connectors', 'outgoing'],
    queryFn: () => api.connectors.listOutgoing(),
    staleTime: 60_000,
  });
  const { data: identities } = useQuery({
    queryKey: ['identities'],
    queryFn: () => api.identities.list(),
    staleTime: 60_000,
  });
  const incomingEmails = useMemo(
    () => new Set((connectors ?? []).map((connector) => String(connector.emailAddress ?? '').trim().toLowerCase()).filter(Boolean)),
    [connectors],
  );

  const sendOnlyProfiles = useMemo(() => {
    const dedupe = new Set<string>();
    const profiles: Array<{ id: string; name: string; emailAddress: string; visual_config?: { icon?: string; emoji?: string } }> = [];

    for (const outgoing of outgoingConnectors ?? []) {
      const emailKey = String(outgoing.fromAddress ?? '').trim().toLowerCase();
      if (!emailKey || dedupe.has(emailKey)) {
        continue;
      }
      if (incomingEmails.has(emailKey)) {
        continue;
      }
      dedupe.add(emailKey);
      profiles.push({
        id: `send-only:${emailKey}`,
        name: outgoing.name || outgoing.fromAddress,
        emailAddress: outgoing.fromAddress,
      });
    }

    for (const identity of identities ?? []) {
      const emailKey = String(identity.emailAddress ?? '').trim().toLowerCase();
      if (!emailKey || dedupe.has(emailKey)) {
        continue;
      }
      if (incomingEmails.has(emailKey)) {
        continue;
      }
      dedupe.add(emailKey);
      profiles.push({
        id: `send-only:${emailKey}`,
        name: identity.displayName || identity.emailAddress,
        emailAddress: identity.emailAddress,
        visual_config: identity.visual_config,
      });
    }
    return profiles;
  }, [identities, incomingEmails, outgoingConnectors]);

  const resolvedRouteState = useMemo(
    () => resolveInboxViewState(searchParams, {
      incomingConnectorIds: (connectors ?? []).map((connector) => connector.id),
      sendOnlyEmails: sendOnlyProfiles.map((profile) => String(profile.emailAddress ?? '').trim().toLowerCase()).filter(Boolean),
      preferredState: preferredInboxState,
    }),
    [connectors, preferredInboxState, searchParams, sendOnlyProfiles],
  );
  const routeState = resolvedRouteState.state;
  const isSendOnlyProfile = routeState?.profile.kind === 'send-only';
  const activeSendEmail = routeState?.profile.kind === 'send-only'
    ? routeState.profile.sendEmail
    : '';
  const effectiveConnectorId = routeState?.profile.kind === 'incoming'
    ? routeState.profile.connectorId
    : null;
  const firstConnectorId = connectors?.[0]?.id ?? null;
  const firstSendOnlyEmail = sendOnlyProfiles[0]?.emailAddress ?? null;
  const brandInboxPath = useMemo(() => {
    if (firstConnectorId) {
      return toInboxPath({
        profile: {
          kind: 'incoming',
          connectorId: firstConnectorId,
        },
        folder: 'INBOX',
        query: '',
        page: 1,
        threadId: null,
      });
    }
    if (firstSendOnlyEmail) {
      const params = new URLSearchParams();
      params.set('profile', 'send-only');
      params.set('sendEmail', firstSendOnlyEmail);
      params.set('folder', 'OUTBOX');
      return `/inbox?${params.toString()}`;
    }
    return '/inbox';
  }, [firstConnectorId, firstSendOnlyEmail]);
  const activeFolder = routeState?.folder ?? (isSendOnlyProfile ? 'OUTBOX' : 'INBOX');
  const dispatchToInbox = useCallback((event: InboxStateEvent) => {
    if (!routeState) {
      return '/inbox';
    }
    const nextState = reduceInboxState(routeState, event);
    return toInboxPath(nextState);
  }, [routeState]);

  const { data: mailboxes, isLoading: loadingMailboxes } = useQuery({
    queryKey: ['mailboxes', effectiveConnectorId],
    queryFn: () => api.connectors.getMailboxes(effectiveConnectorId!),
    enabled: !!effectiveConnectorId && !isSendOnlyProfile,
    staleTime: 60_000,
  });

  const getFolderIcon = (name: string) => {
    const lower = name.toLowerCase();
    if (lower.includes('inbox')) return Inbox;
    if (lower.includes('sent')) return Send;
    if (lower.includes('draft')) return FileText;
    if (lower.includes('trash') || lower.includes('bin')) return Trash2;
    if (lower.includes('spam') || lower.includes('junk')) return AlertOctagon;
    if (lower.includes('starred')) return Star;
    if (lower.includes('snoozed')) return Clock;
    return Hash;
  };

  const linkClass = (isActive: boolean) => `
    flex items-center gap-2 px-3 py-1.5 rounded-md transition-all text-sm group
    ${isActive 
      ? 'bg-accent/10 text-accent font-bold shadow-xs' 
      : 'text-text-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-text-primary font-semibold'}
  `;const dynamicFolders = useMemo(() => {
    if (!mailboxes) return [];
    return mailboxes
      .filter((mb) => {
        const name = String(mb?.name ?? '').trim().toLowerCase();
        const path = String(mb?.path ?? '').trim();
        const pathLower = path.toLowerCase();
        const pathUpper = path.toUpperCase();
        if (!name || !path) return false;
        if (pathLower === '[gmail]') return false;
        if (name.includes('archive')) return false;
        if (pathUpper === 'ALL' || pathUpper === 'ARCHIVE' || pathUpper === '[GMAIL]/ALL MAIL') return false;
        return true;
      })
      .filter((mb, index, all) =>
        all.findIndex((candidate) => String(candidate.path).toLowerCase() === String(mb.path).toLowerCase()) === index);
  }, [mailboxes]) as MailboxInfo[];

  const prefetchFolderMessages = useCallback((folderPath: string) => {
    const normalizedFolder = String(folderPath || '').trim();
    if (!normalizedFolder) {
      return;
    }

    if (isSendOnlyProfile) {
      if (!activeSendEmail) {
        return;
      }
      void queryClient.prefetchQuery({
        queryKey: ['messages', `send-only:${activeSendEmail}`, normalizedFolder, '', 1],
        queryFn: () => api.messages.listSendOnly({
          emailAddress: activeSendEmail,
          folder: normalizedFolder,
          limit: PAGE_SIZE,
          offset: 0,
        }),
        staleTime: 20_000,
      });
      return;
    }

    if (!effectiveConnectorId) {
      return;
    }

    void queryClient.prefetchQuery({
      queryKey: ['messages', effectiveConnectorId, normalizedFolder, '', 1],
      queryFn: () => api.messages.list({
        folder: normalizedFolder,
        connectorId: effectiveConnectorId,
        limit: PAGE_SIZE,
        offset: 0,
      }),
      staleTime: 20_000,
    });
  }, [activeSendEmail, effectiveConnectorId, isSendOnlyProfile, queryClient]);

  useEffect(() => {
    const browserWindow = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    if (isSendOnlyProfile) {
      const warmSendOnlyFolders = () => {
        prefetchFolderMessages('OUTBOX');
        prefetchFolderMessages('SENT');
      };
      if (typeof browserWindow.requestIdleCallback === 'function') {
        const idleHandle = browserWindow.requestIdleCallback(() => {
          warmSendOnlyFolders();
        }, { timeout: 1_500 });
        return () => {
          if (typeof browserWindow.cancelIdleCallback === 'function') {
            browserWindow.cancelIdleCallback(idleHandle);
          }
        };
      }
      const timeoutId = window.setTimeout(warmSendOnlyFolders, 400);
      return () => window.clearTimeout(timeoutId);
    }

    if (!dynamicFolders.length) {
      return;
    }

    const foldersToWarm = dynamicFolders
      .slice(0, 4)
      .map((mailbox) => String(mailbox.path || '').trim())
      .filter(Boolean);
    const warmFolders = () => {
      foldersToWarm.forEach((folderPath) => prefetchFolderMessages(folderPath));
    };

    if (typeof browserWindow.requestIdleCallback === 'function') {
      const idleHandle = browserWindow.requestIdleCallback(() => {
        warmFolders();
      }, { timeout: 1_500 });
      return () => {
        if (typeof browserWindow.cancelIdleCallback === 'function') {
          browserWindow.cancelIdleCallback(idleHandle);
        }
      };
    }

    const timeoutId = window.setTimeout(warmFolders, 450);
    return () => window.clearTimeout(timeoutId);
  }, [dynamicFolders, isSendOnlyProfile, prefetchFolderMessages]);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-sidebar border-r border-border font-sans select-none">
      <div className="px-3 py-2 border-b border-border/60 flex items-center justify-between gap-2">
        <Link to={brandInboxPath} title="Open first mail inbox" className="inline-flex">
          <AppBrand variant="compact" />
        </Link>
        <a
          href="https://github.com/ZimengXiong/simpleMail"
          target="_blank"
          rel="noopener noreferrer"
          title="GitHub"
          className="p-1.5 rounded-md text-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
        >
          <Github className="w-4 h-4" />
        </a>
      </div>
      <ProfileSwitcher incomingConnectors={connectors || []} sendOnlyProfiles={sendOnlyProfiles} />

      <div className="p-3 pt-0 hidden md:block">
        <button 
          onClick={() => setIsComposeOpen(true)}
          onMouseEnter={() => { void loadComposeModal(); }}
          onFocus={() => { void loadComposeModal(); }}
          disabled={!(identities?.length)}
          className="w-full btn-secondary py-2 font-bold"
        >
          <PenBox className="w-4 h-4 text-accent" />
          Compose
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 space-y-0.5 custom-scrollbar pt-2">
        {isSendOnlyProfile ? (
          <div className="animate-in fade-in duration-300">
            {[{ name: 'Outbox', path: 'OUTBOX', icon: Clock }, { name: 'Sent', path: 'SENT', icon: Send }].map((mb) => {
              const Icon = mb.icon;
              const currentFolder = String(activeFolder ?? '').toUpperCase();
              const isActive = currentFolder
                ? currentFolder === mb.path
                : mb.path === 'OUTBOX';
              const to = dispatchToInbox({ type: 'select-folder', folder: mb.path });
              return (
                <NavLink
                  key={mb.path}
                  to={to}
                  onMouseEnter={() => prefetchFolderMessages(mb.path)}
                  onFocus={() => prefetchFolderMessages(mb.path)}
                  className={linkClass(isActive)}
                >
                  <Icon className="w-4 h-4 opacity-60" />
                  <span className="truncate text-sm">{mb.name}</span>
                </NavLink>
              );
            })}
          </div>
        ) : effectiveConnectorId ? (
          <div className="animate-in fade-in duration-300">
            {loadingMailboxes ? (
              <div className="px-6 py-2 text-xs text-text-secondary italic flex items-center gap-2">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading folders...
              </div>
            ) : dynamicFolders.length === 0 ? (
              <div className="px-6 py-2 text-xs text-text-secondary italic">No folders</div>
            ) : dynamicFolders.map((mb) => {
                const Icon = getFolderIcon(mb.name);
                const isActive = activeFolder === mb.path
                  || (!activeFolder && String(mb.path).toUpperCase() === 'INBOX');
                const to = dispatchToInbox({ type: 'select-folder', folder: mb.path });
                return (
                  <NavLink
                    key={mb.path}
                    to={to}
                    onMouseEnter={() => prefetchFolderMessages(mb.path)}
                    onFocus={() => prefetchFolderMessages(mb.path)}
                    className={linkClass(isActive)}
                  >
                    <Icon className="w-4 h-4 opacity-60" />
                    <span className="truncate text-sm">{mb.name}</span>
                  </NavLink>
                );
              })}
          </div>
        ) : null}
      </nav>

      {isComposeOpen && (
        <Suspense fallback={null}>
          <ComposeModal onClose={() => setIsComposeOpen(false)} />
        </Suspense>
      )}
    </div>
  );
};

export default Sidebar;
