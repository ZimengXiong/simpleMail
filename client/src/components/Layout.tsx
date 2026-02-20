import { useMemo, useState } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import SyncStatus from './SyncStatus';
import { useTheme } from '../services/theme';
import { Settings, Menu, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import ProfileSwitcher from './ProfileSwitcher';

const Layout = () => {
  useTheme();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const location = useLocation();
  const routeKey = useMemo(() => `${location.pathname}|${location.search}`, [location.pathname, location.search]);
  const [sidebarOpenedAtRouteKey, setSidebarOpenedAtRouteKey] = useState(routeKey);
  const effectiveSidebarOpen = isSidebarOpen && sidebarOpenedAtRouteKey === routeKey;
  const closeSidebar = () => setIsSidebarOpen(false);
  const openSidebar = () => {
    setSidebarOpenedAtRouteKey(routeKey);
    setIsSidebarOpen(true);
  };

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
      if (!emailKey || dedupe.has(emailKey) || incomingEmails.has(emailKey)) continue;
      dedupe.add(emailKey);
      profiles.push({ id: `send-only:${emailKey}`, name: outgoing.name || outgoing.fromAddress, emailAddress: outgoing.fromAddress });
    }

    for (const identity of identities ?? []) {
      const emailKey = String(identity.emailAddress ?? '').trim().toLowerCase();
      if (!emailKey || dedupe.has(emailKey) || incomingEmails.has(emailKey)) continue;
      dedupe.add(emailKey);
      profiles.push({ id: `send-only:${emailKey}`, name: identity.displayName || identity.emailAddress, emailAddress: identity.emailAddress, visual_config: identity.visual_config });
    }
    return profiles;
  }, [identities, incomingEmails, outgoingConnectors]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-app selection:bg-accent/10 font-sans relative">
      {effectiveSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-40 md:hidden animate-in fade-in duration-200"
          onClick={closeSidebar}
        />
      )}

      <aside className={`
        fixed inset-y-0 left-0 z-50 w-72 flex flex-col overflow-hidden bg-sidebar border-r border-border shrink-0
        transition-transform duration-300 ease-in-out md:relative md:translate-x-0 md:w-64
        ${effectiveSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        <div className="flex items-center p-2 md:hidden border-b border-border/60">
          <button 
            onClick={closeSidebar}
            className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="flex-1 flex flex-col min-h-0">
          <Sidebar />
        </div>
        
        <div className="p-2 border-t border-border/60">
          <SyncStatus />
        </div>

        <div className="p-2 border-t border-border/60 flex items-center justify-between">
          <NavLink 
            to="/settings"
            title="Settings"
            className={({ isActive }) => `
              flex items-center gap-2 px-3 py-1.5 rounded-md transition-all text-sm w-full font-semibold
              ${isActive ? 'bg-accent/10 text-accent font-bold shadow-xs' : 'text-text-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-text-primary'}
            `}
          >
            <Settings className="w-4 h-4" />
            <span>Settings</span>
          </NavLink>
        </div>
      </aside>

      <main className="flex-1 flex flex-col overflow-hidden min-w-0 bg-bg-card relative">
        <header className="flex md:hidden items-center h-12 border-b border-border/60 bg-bg-app shrink-0 px-4">
          <button 
            onClick={openSidebar}
            className="p-1.5 -ml-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>
          
          <div className="flex-1 min-w-0 ml-2">
            <ProfileSwitcher 
              incomingConnectors={connectors || []} 
              sendOnlyProfiles={sendOnlyProfiles}
              variant="header"
            />
          </div>
        </header>

        <Outlet />
      </main>
    </div>
  );
};

export default Layout;
