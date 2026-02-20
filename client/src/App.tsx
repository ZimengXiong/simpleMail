import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Layout from './components/Layout';
import LegacyFolderRedirect from './components/LegacyFolderRedirect';
import InboxView from './views/InboxView';
import SyncEventBridge from './components/SyncEventBridge';
import AuthGuard, { RouteChunkPreloader } from './components/AppRoutes';

const loadThreadView = () => import('./views/ThreadView');
const loadSettingsView = () => import('./views/SettingsView');
const loadConnectorSetupView = () => import('./views/ConnectorSetupView');
const loadLoginView = () => import('./views/LoginView');
const loadOAuthCallbackView = () => import('./views/OAuthCallbackView');

const ThreadView = React.lazy(loadThreadView);
const SettingsView = React.lazy(loadSettingsView);
const ConnectorSetupView = React.lazy(loadConnectorSetupView);
const LoginView = React.lazy(loadLoginView);
const OAuthCallbackView = React.lazy(loadOAuthCallbackView);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 15 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      retry: 1,
    },
    mutations: {
      retry: 1,
    },
  },
});


function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <RouteChunkPreloader />
        <React.Suspense fallback={<div className="flex-1 flex items-center justify-center"><div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin opacity-40" /></div>}>
          <Routes>
            <Route path="/login" element={<LoginView />} />
            <Route path="/oauth/callback" element={<OAuthCallbackView />} />
            <Route
              path="/"
              element={
                <AuthGuard>
                  <SyncEventBridge />
                  <Layout />
                </AuthGuard>
              }
            >
              <Route index element={<Navigate to="/inbox" replace />} />
              <Route path="inbox" element={<InboxView />} />
              <Route path="folder/*" element={<LegacyFolderRedirect />} />
              <Route path="thread/:threadId" element={<ThreadView />} />
              <Route path="settings" element={<SettingsView />} />
              <Route path="settings/connectors/new" element={<ConnectorSetupView />} />
            </Route>
          </Routes>
        </React.Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
