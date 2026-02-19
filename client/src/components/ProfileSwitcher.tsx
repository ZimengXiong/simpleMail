import { useState, useRef, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ChevronDown,
  Check,
  Plus,
  UserCircle,
} from 'lucide-react';
import Avatar from './Avatar';

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
  incomingConnectors: any[];
  sendOnlyProfiles: Array<{
    id: string;
    name: string;
    emailAddress: string;
    visual_config?: { icon?: string; emoji?: string };
  }>;
}

const ProfileSwitcher = ({ incomingConnectors, sendOnlyProfiles }: ProfileSwitcherProps) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const incomingProfiles: IncomingProfile[] = incomingConnectors.map((connector) => ({
    kind: 'incoming',
    id: connector.id,
    name: connector.name || connector.emailAddress,
    emailAddress: connector.emailAddress,
    visual_config: connector.visual_config,
  }));
  const sendOnlyOptions: SendOnlyProfile[] = sendOnlyProfiles.map((profile) => ({
    kind: 'send-only',
    id: profile.id,
    name: profile.name || profile.emailAddress,
    emailAddress: profile.emailAddress,
    visual_config: profile.visual_config,
  }));
  const allProfiles: ProfileOption[] = [...incomingProfiles, ...sendOnlyOptions];

  const activeConnectorId = searchParams.get('connectorId');
  const activeProfileType = searchParams.get('profile');
  const activeSendEmail = String(searchParams.get('sendEmail') ?? '').trim().toLowerCase();

  const activeProfile = activeProfileType === 'send-only'
    ? sendOnlyOptions.find((profile) => profile.emailAddress.toLowerCase() === activeSendEmail)
    : incomingProfiles.find((profile) => profile.id === activeConnectorId);
  const fallbackProfile = allProfiles[0];
  const hasActiveProfile = Boolean(activeProfile);
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
    if (hasActiveProfile) {
      return;
    }
    if (!fallbackProfile) {
      return;
    }

    const nextParams = new URLSearchParams(searchParams);
    if (fallbackProfile.kind === 'incoming') {
      nextParams.set('connectorId', fallbackProfile.id);
      nextParams.delete('profile');
      nextParams.delete('sendEmail');
    } else {
      nextParams.set('profile', 'send-only');
      nextParams.set('sendEmail', fallbackProfile.emailAddress);
      nextParams.delete('connectorId');
    }
    nextParams.delete('folder');
    nextParams.delete('page');
    setSearchParams(nextParams, { replace: true });
  }, [fallbackProfile, hasActiveProfile, searchParams, setSearchParams]);

  const selectProfile = (profile: ProfileOption) => {
    const nextParams = new URLSearchParams(searchParams);
    if (profile.kind === 'incoming') {
      nextParams.set('connectorId', profile.id);
      nextParams.delete('profile');
      nextParams.delete('sendEmail');
    } else {
      nextParams.set('profile', 'send-only');
      nextParams.set('sendEmail', profile.emailAddress);
      nextParams.delete('connectorId');
    }
    nextParams.delete('folder');
    nextParams.delete('page');
    setSearchParams(nextParams);
    setIsOpen(false);
  };

  return (
    <div className="relative px-2 py-2" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-black/5 dark:hover:bg-white/5 transition-colors group text-left border border-transparent"
      >
        <Avatar
          visualConfig={resolvedActiveProfile?.visual_config}
          text={resolvedActiveProfile?.name || resolvedActiveProfile?.emailAddress}
          fallbackIcon={UserCircle}
          size="sm"
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-text-primary truncate leading-tight">
            {resolvedActiveProfile ? (resolvedActiveProfile.name || resolvedActiveProfile.emailAddress) : 'Select account'}
          </div>
          {resolvedActiveProfile?.kind === 'send-only' && (
            <div className="text-[10px] uppercase tracking-wide font-bold text-amber-600">Send Only</div>
          )}
        </div>
        <ChevronDown className={`w-3.5 h-3.5 text-text-secondary opacity-60 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute top-full left-2 right-2 mt-1 bg-bg-card border border-border shadow-lg rounded-md z-50 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
          <div className="p-1 space-y-0.5">
            {allProfiles.map((profile) => {
              const isActive = resolvedActiveProfile?.kind === profile.kind
                && resolvedActiveProfile?.emailAddress.toLowerCase() === profile.emailAddress.toLowerCase()
                && (profile.kind === 'send-only' || resolvedActiveProfile?.id === profile.id);
              return (
                <button
                  key={`${profile.kind}:${profile.id}`}
                  onClick={() => selectProfile(profile)}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors ${isActive ? 'bg-black/5 text-text-primary font-semibold' : 'hover:bg-black/5 dark:hover:bg-white/5 text-text-secondary font-medium'}`}
                >
                  <Avatar visualConfig={profile.visual_config} fallbackIcon={UserCircle} size="sm" />
                  <div className="flex-1 min-w-0 text-left">
                    <div className="truncate flex items-center gap-1.5">
                      <span className="truncate">{profile.name || 'Account'}</span>
                      {profile.kind === 'send-only' && (
                        <span className="text-[9px] uppercase tracking-wide font-bold text-amber-600">Send Only</span>
                      )}
                    </div>
                    <div className="truncate text-[10px] opacity-60">{profile.emailAddress}</div>
                  </div>
                  {isActive && <Check className="w-3.5 h-3.5 text-accent" />}
                </button>
              );
            })}
          </div>

          <div className="p-1 border-t border-border/60 bg-sidebar/40">
            <button
              onClick={() => { setIsOpen(false); window.location.href = '/settings/connectors/new?type=incoming'; }}
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
