import { Outlet, NavLink } from 'react-router-dom';
import Sidebar from './Sidebar';
import SyncStatus from './SyncStatus';
import { useTheme } from '../services/theme';
import { Settings } from 'lucide-react';

const Layout = () => {
  useTheme(); // Initialize theme logic

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-app selection:bg-accent/10 font-sans">
      {/* Sidebar Container */}
      <aside className="w-64 flex flex-col overflow-hidden bg-sidebar border-r border-border shrink-0">
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
              flex items-center gap-2 px-2.5 py-1.5 rounded-md transition-all text-sm w-full
              ${isActive ? 'bg-black/5 text-text-primary font-semibold' : 'text-text-secondary hover:bg-black/5 dark:hover:bg-white/5'}
            `}
          >
            <Settings className="w-4 h-4" />
            <span>Settings</span>
          </NavLink>
        </div>
      </aside>

      {/* Main Content Container */}
      <main className="flex-1 flex flex-col overflow-hidden min-w-0 bg-bg-card">
        <Outlet />
      </main>
    </div>
  );
};

export default Layout;
