import { useState, useMemo } from 'react';
import { NavLink, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
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
import ComposeModal from './ComposeModal';
import ProfileSwitcher from './ProfileSwitcher';

const Sidebar = () => {
  const [searchParams] = useSearchParams();
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  
  const activeConnectorId = searchParams.get('connectorId');
  const activeProfileType = searchParams.get('profile');
  const activeSendEmail = String(searchParams.get('sendEmail') ?? '').trim().toLowerCase();
  const isSendOnlyProfile = activeProfileType === 'send-only' && !!activeSendEmail;

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

  const effectiveConnectorId = isSendOnlyProfile
    ? null
    : (activeConnectorId || connectors?.[0]?.id);

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
    flex items-center gap-2 px-2.5 py-1 rounded-md transition-colors text-sm group
    ${isActive 
      ? 'bg-black/5 dark:bg-white/5 text-text-primary font-semibold' 
      : 'text-text-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-text-primary font-medium'}
  `;

  // Sort and filter mailboxes to put Inbox first and avoid duplicates
  const dynamicFolders = useMemo(() => {
    if (!mailboxes) return [];
    return mailboxes
      .filter((mb: any) => {
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
      .filter((mb: any, index: number, all: any[]) =>
        all.findIndex((candidate: any) => String(candidate.path).toLowerCase() === String(mb.path).toLowerCase()) === index);
  }, [mailboxes]);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-sidebar border-r border-border font-sans select-none">
      <ProfileSwitcher incomingConnectors={connectors || []} sendOnlyProfiles={sendOnlyProfiles} />

      <div className="p-3 pt-0">
        <button 
          onClick={() => setIsComposeOpen(true)}
          disabled={!(identities?.length)}
          className="w-full flex items-center justify-center gap-2 bg-bg-card border border-border py-1.5 rounded-md text-sm font-semibold text-text-primary hover:bg-black/5 dark:hover:bg-white/5 transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
        >
          <PenBox className="w-3.5 h-3.5 text-accent" />
          Compose
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 space-y-0.5 custom-scrollbar pt-2">
        {isSendOnlyProfile ? (
          <div className="animate-in fade-in duration-300">
            {[{ name: 'Outbox', path: 'OUTBOX', icon: Clock }, { name: 'Sent', path: 'SENT', icon: Send }].map((mb) => {
              const Icon = mb.icon;
              const currentFolder = String(searchParams.get('folder') ?? '').toUpperCase();
              const isActive = currentFolder
                ? currentFolder === mb.path
                : mb.path === 'OUTBOX';
              return (
                <NavLink
                  key={mb.path}
                  to={`/inbox?profile=send-only&sendEmail=${encodeURIComponent(activeSendEmail)}&folder=${mb.path}`}
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
            ) : dynamicFolders.map((mb: any) => {
                const Icon = getFolderIcon(mb.name);
                const isActive = searchParams.get('folder') === mb.path
                  || (!searchParams.get('folder') && String(mb.path).toUpperCase() === 'INBOX');
                return (
                  <NavLink
                    key={mb.path}
                    to={`/inbox?connectorId=${effectiveConnectorId}&folder=${encodeURIComponent(mb.path)}`}
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
        <ComposeModal onClose={() => setIsComposeOpen(false)} />
      )}
    </div>
  );
};

export default Sidebar;
