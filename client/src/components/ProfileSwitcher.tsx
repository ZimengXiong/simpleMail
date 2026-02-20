import { useState, useRef, useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ChevronDown,
  Check,
  Plus,
} from 'lucide-react';
import type { IncomingConnectorRecord } from '../types';
import {
  persistInboxState,
  readPersistedInboxState,
  reduceInboxState,
  resolveInboxViewState,
  toInboxPath,
  type InboxProfileState,
  type InboxViewState,
} from '../services/inboxStateMachine';

type IncomingProfile = {
  kind: 'incoming';
  id: string;
  name: string;
  emailAddress: string;
  visual_config?: { icon?: string; emoji?: string };
};

type SendOnlyProfile = {
  kind: 'send-only';
  id: string;
  name: string;
  emailAddress: string;
  visual_config?: { icon?: string; emoji?: string };
};

type ProfileOption = IncomingProfile | SendOnlyProfile;

interface ProfileSwitcherProps {
  incomingConnectors: IncomingConnectorRecord[];
  sendOnlyProfiles: Array<{
    id: string;
    name: string;
    emailAddress: string;
    visual_config?: { icon?: string; emoji?: string };
  }>;
  variant?: 'default' | 'header';
}

const ProfileSwitcher = ({ incomingConnectors, sendOnlyProfiles, variant = 'default' }: ProfileSwitcherProps) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const preferredInboxState = readPersistedInboxState();

  const incomingProfiles: IncomingProfile[] = useMemo(
    () => incomingConnectors.map((connector) => ({
      kind: 'incoming',
      id: connector.id,
      name: connector.name || connector.emailAddress,
      emailAddress: connector.emailAddress,
      visual_config: connector.visual_config,
    })),
    [incomingConnectors],
  );
  const sendOnlyOptions: SendOnlyProfile[] = useMemo(
    () => sendOnlyProfiles.map((profile) => ({
      kind: 'send-only',
      id: profile.id,
      name: profile.name || profile.emailAddress,
      emailAddress: profile.emailAddress,
      visual_config: profile.visual_config,
    })),
    [sendOnlyProfiles],
  );
  const allProfiles: ProfileOption[] = [...incomingProfiles, ...sendOnlyOptions];
  const isInboxRoute = location.pathname === '/inbox';
  const resolvedRouteState = useMemo(
    () => resolveInboxViewState(searchParams, {
      incomingConnectorIds: incomingProfiles.map((profile) => profile.id),
      sendOnlyEmails: sendOnlyOptions.map((profile) => profile.emailAddress.toLowerCase()),
      preferredState: preferredInboxState,
    }),
    [incomingProfiles, preferredInboxState, searchParams, sendOnlyOptions],
  );
  const routeState = resolvedRouteState.state;
  const activeProfile = useMemo(() => {
    if (!routeState) {
      return undefined;
    }
    const profileState = routeState.profile;
    if (profileState.kind === 'send-only') {
      const sendEmail = profileState.sendEmail;
      return sendOnlyOptions.find((profile) => profile.emailAddress.toLowerCase() === sendEmail);
    }
    const connectorId = profileState.connectorId;
    return incomingProfiles.find((profile) => profile.id === connectorId);
  }, [incomingProfiles, routeState, sendOnlyOptions]);
  const fallbackProfile = allProfiles[0];
  const resolvedActiveProfile = activeProfile ?? fallbackProfile;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!routeState) {
      return;
    }
    persistInboxState(routeState);
  }, [routeState]);

  useEffect(() => {
    if (!isInboxRoute || !routeState) {
      return;
    }
    if (!resolvedRouteState.changed) {
      return;
    }
    setSearchParams(resolvedRouteState.searchParams, { replace: true });
  }, [isInboxRoute, resolvedRouteState, routeState, setSearchParams]);

  const makeProfileState = (profile: ProfileOption): InboxProfileState =>
    profile.kind === 'incoming'
      ? { kind: 'incoming', connectorId: profile.id }
      : { kind: 'send-only', sendEmail: profile.emailAddress.toLowerCase() };

  const selectProfile = (profile: ProfileOption) => {
    const profileState = makeProfileState(profile);
    const baseState: InboxViewState = routeState ?? {
      profile: profileState,
      folder: profileState.kind === 'send-only' ? 'OUTBOX' : 'INBOX',
      query: '',
      page: 1,
      threadId: null,
    };
    const nextState = reduceInboxState(baseState, {
      type: 'select-profile',
      profile: profileState,
    });
    persistInboxState(nextState);
    navigate(toInboxPath(nextState));
    setIsOpen(false);
  };

  const isHeader = variant === 'header';

  return (
    <div className={`relative ${isHeader ? 'w-fit max-w-full' : 'px-2 py-2'}`} ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-1.5 rounded-md transition-all group text-left border border-transparent 
          ${isHeader ? 'px-2.5 py-1 bg-black/[0.07] dark:bg-white/[0.1] active:bg-black/[0.12] dark:active:bg-white/[0.15] shadow-inner' : 'w-full px-2 py-1.5 hover:bg-black/5 dark:hover:bg-white/5 hover:border-border/60 hover:shadow-sm'}
        `}
      >
        <div className="min-w-0">
          <div className={`${isHeader ? 'text-[14px]' : 'text-sm'} font-bold text-text-primary truncate leading-tight`}>
            {resolvedActiveProfile ? (resolvedActiveProfile.name || resolvedActiveProfile.emailAddress) : 'Select account'}
          </div>
        </div>
        <ChevronDown className={`shrink-0 w-3.5 h-3.5 text-text-secondary opacity-60 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className={`absolute top-full mt-1 bg-bg-card border border-border shadow-xl rounded-md z-50 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150
          ${isHeader ? 'left-0 min-w-[240px]' : 'left-2 right-2'}
        `}>
          <div className="p-1 space-y-0.5">
            {allProfiles.map((profile) => {
              const isActive = resolvedActiveProfile?.kind === profile.kind
                && resolvedActiveProfile?.emailAddress.toLowerCase() === profile.emailAddress.toLowerCase()
                && (profile.kind === 'send-only' || resolvedActiveProfile?.id === profile.id);
              return (
                <button
                  key={`${profile.kind}:${profile.id}`}
                  onClick={() => selectProfile(profile)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all group/item relative border border-transparent
                    ${isActive ? 'bg-accent/[0.12] dark:bg-accent/[0.15] border-border/40 shadow-sm' : 'hover:bg-accent/5 dark:hover:bg-accent/5 text-text-secondary font-medium'}
                  `}
                >
                  <div className="flex-1 min-w-0 text-left">
                    <div className="truncate flex items-center justify-between gap-1.5">
                      <span className={`truncate text-[13px] ${isActive ? 'font-bold text-accent dark:text-accent' : 'font-semibold text-text-primary opacity-80 group-hover/item:opacity-100'}`}>
                        {profile.name || 'Account'}
                      </span>
                      {profile.kind === 'send-only' && (
                        <span className="text-[9px] uppercase tracking-wide font-bold text-amber-600 shrink-0">Send Only</span>
                      )}
                    </div>
                    <div className="truncate text-[11px] opacity-60 group-hover/item:opacity-80 font-medium">{profile.emailAddress}</div>
                  </div>
                  {isActive && <Check className="w-3.5 h-3.5 text-accent shrink-0" />}
                </button>
              );
            })}
          </div>

          <div className="p-1 border-t border-border/60 bg-sidebar/40">
            <button
              onClick={() => { setIsOpen(false); navigate('/settings/connectors/new?type=incoming'); }}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors font-semibold"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add account</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProfileSwitcher;
