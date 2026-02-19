import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Layout from './components/Layout';
import InboxView from './views/InboxView';
import { api } from './services/api';
import SyncEventBridge from './components/SyncEventBridge';

// Secondary views are lazy-loaded to reduce the initial JS bundle.
const ThreadView = React.lazy(() => import('./views/ThreadView'));
const SettingsView = React.lazy(() => import('./views/SettingsView'));
const ConnectorSetupView = React.lazy(() => import('./views/ConnectorSetupView'));
const LoginView = React.lazy(() => import('./views/LoginView'));
const OAuthCallbackView = React.lazy(() => import('./views/OAuthCallbackView'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15000,
      gcTime: 15 * 60 * 1000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: 1,
    },
    mutations: {
      retry: 1,
    },
  },
});


const AuthGuard = ({ children }: { children: React.ReactNode }) => {
  const location = useLocation();
  if (!api.auth.isAuthenticated()) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
};

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
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
              <Route path="folder/:path" element={<InboxView />} />
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
