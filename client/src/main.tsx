import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import AppErrorBoundary from './components/AppErrorBoundary'
import { initOidcAuth } from './services/oidc'

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing root element');
}

const root = createRoot(rootElement);

const renderApp = () => {
  root.render(
    <StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </StrictMode>,
  );
};

void initOidcAuth()
  .then(() => {
    renderApp();
  })
  .catch((error) => {
    console.error('Failed to initialize OIDC auth', error);
    root.render(
      <div className="min-h-screen flex items-center justify-center bg-bg-app text-text-primary p-6 text-center">
        <div className="max-w-lg">
          <h1 className="text-xl font-bold mb-2">Authentication bootstrap failed</h1>
          <p className="text-sm text-text-secondary">
            Ensure your OIDC provider is reachable at the configured issuer URL, then refresh.
          </p>
        </div>
      </div>,
    );
  });
