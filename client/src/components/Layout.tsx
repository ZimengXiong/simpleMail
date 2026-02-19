import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import SyncStatus from './SyncStatus';

const Layout = () => {
  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-white selection:bg-accent/20">
      <div className="flex-1 flex overflow-hidden min-w-0">
        <Sidebar />
        <main className="flex-1 flex overflow-hidden min-w-0">
          <Outlet />
        </main>
      </div>
      <SyncStatus />
    </div>
  );
};

export default Layout;
