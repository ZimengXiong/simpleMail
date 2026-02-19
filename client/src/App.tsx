import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Layout from './components/Layout';
import InboxView from './views/InboxView';
import ThreadView from './views/ThreadView';
import SettingsView from './views/SettingsView';
import ConnectorSetupView from './views/ConnectorSetupView';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Navigate to="/inbox" replace />} />
            <Route path="inbox" element={<InboxView />} />
            <Route path="folder/:path" element={<InboxView />} />
            <Route path="thread/:threadId" element={<ThreadView />} />
            <Route path="settings" element={<SettingsView />} />
            <Route path="settings/connectors/new" element={<ConnectorSetupView />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
