import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import { 
  Inbox, 
  Send, 
  Archive, 
  Settings, 
  Plus, 
  ChevronRight, 
  Mail, 
  PenBox,
  AlertCircle
} from 'lucide-react';
import ComposeModal from './ComposeModal';

const Sidebar = () => {
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const { data: connectors, isLoading } = useQuery({
    queryKey: ['connectors', 'incoming'],
    queryFn: () => api.connectors.listIncoming(),
  });

  const mainLinks = [
    { label: 'Inbox', icon: Inbox, path: '/inbox' },
    { label: 'Sent', icon: Send, path: '/folder/Sent' },
    { label: 'Archive', icon: Archive, path: '/folder/Archive' },
  ];

  return (
    <div className="w-60 bg-sidebar border-r border-border h-full flex flex-col shrink-0">
      <div className="p-3">
        <button 
          onClick={() => setIsComposeOpen(true)}
          disabled={!connectors?.length}
          className="w-full flex items-center justify-center gap-2 bg-white border border-border py-2 rounded-lg text-sm font-bold shadow-sm hover:bg-sidebar transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <PenBox className="w-4 h-4 text-accent" />
          Compose
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2">
        <div className="space-y-0.5 mb-6">
          {mainLinks.map((link) => (
            <NavLink
              key={link.path}
              to={link.path}
              className={({ isActive }) => `
                flex items-center gap-2 px-2 py-1.5 rounded-sm group transition-colors
                ${isActive ? 'bg-black/5 text-text-primary' : 'text-text-secondary hover:bg-black/5 hover:text-text-primary'}
              `}
            >
              <link.icon className="w-4 h-4" />
              <span className="flex-1 truncate">{link.label}</span>
            </NavLink>
          ))}
        </div>

        <div className="mb-4">
          <div className="px-3 py-1 text-[11px] font-semibold text-text-secondary uppercase tracking-wider flex items-center justify-between group">
            <span>Accounts</span>
            <NavLink to="/settings/connectors/new?type=incoming" className="hidden group-hover:block opacity-60 hover:opacity-100">
              <Plus className="w-3.5 h-3.5" />
            </NavLink>
          </div>
          <div className="space-y-0.5 mt-1">
            {!isLoading && !connectors?.length && (
              <div className="px-3 py-4 text-center">
                <p className="text-[10px] text-text-secondary italic leading-relaxed">No accounts connected yet. Add one in settings.</p>
              </div>
            )}
            {connectors?.map((c) => (
              <div key={c.id} className="group">
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-sm text-text-secondary hover:bg-black/5 hover:text-text-primary cursor-pointer transition-colors">
                  <ChevronRight className="w-3 h-3 transition-transform opacity-40 group-hover:opacity-100" />
                  <span className="flex-1 truncate text-xs font-medium">{c.emailAddress}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </nav>

      <div className="p-2 border-t border-border mt-auto">
        <NavLink
          to="/settings"
          className={({ isActive }) => `
            flex items-center gap-2 px-2 py-1.5 rounded-sm transition-colors
            ${isActive ? 'bg-black/5 text-text-primary' : 'text-text-secondary hover:bg-black/5 hover:text-text-primary'}
          `}
        >
          <Settings className="w-4 h-4" />
          <span>Settings</span>
        </NavLink>
      </div>

      {isComposeOpen && (
        <ComposeModal onClose={() => setIsComposeOpen(false)} />
      )}
    </div>
  );
};

export default Sidebar;
