import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, getAuthToken } from '../services/api';

type AuthGuardProps = {
  children: ReactNode;
};

const AuthGuard = ({ children }: AuthGuardProps) => {
  const location = useLocation();
  const [status, setStatus] = useState<'checking' | 'valid' | 'invalid'>(() =>
    api.auth.isAuthenticated() ? 'checking' : 'invalid',
  );
  const [failureMessage, setFailureMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    const token = getAuthToken();
    if (!token) {
      return () => {
        cancelled = true;
      };
    }

    void fetch('/api/session', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }).then((response) => {
      if (cancelled) {
        return;
      }
      if (response.ok) {
        setFailureMessage('');
        setStatus('valid');
        return;
      }
      void response.json().catch(() => null).then((payload: unknown) => {
        if (cancelled) {
          return;
        }
        const message = typeof payload === 'object' && payload !== null && 'error' in payload
          ? String((payload as { error?: unknown }).error ?? '').trim()
          : '';
        setFailureMessage(message);
        api.auth.clear();
        setStatus('invalid');
      });
    }).catch(() => {
      if (cancelled) {
        return;
      }
      setFailureMessage('Session check failed due to a network error.');
      api.auth.clear();
      setStatus('invalid');
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (status === 'checking') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin opacity-40" />
      </div>
    );
  }

  if (status !== 'valid') {
    const next = `${location.pathname}${location.search}${location.hash}`;
    const params = new URLSearchParams({ next });
    if (failureMessage) {
      params.set('authError', failureMessage.slice(0, 300));
    }
    return <Navigate to={`/login?${params.toString()}`} state={{ from: location }} replace />;
  }

  return <>{children}</>;
};

export const RouteChunkPreloader = () => {
  const location = useLocation();

  useEffect(() => {
    if (!api.auth.isAuthenticated()) {
      return;
    }

    const preload = () => {
      void import('../views/ThreadView');
      void import('../views/SettingsView');
      void import('../views/ConnectorSetupView');
      void import('../views/LoginView');
      void import('../views/OAuthCallbackView');
    };

    const browserWindow = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    if (typeof browserWindow.requestIdleCallback === 'function') {
      const idleHandle = browserWindow.requestIdleCallback(() => {
        preload();
      }, { timeout: 1_500 });
      return () => {
        if (typeof browserWindow.cancelIdleCallback === 'function') {
          browserWindow.cancelIdleCallback(idleHandle);
        }
      };
    }

    const timeoutId = window.setTimeout(preload, 450);
    return () => window.clearTimeout(timeoutId);
  }, [location.pathname]);

  return null;
};

export default AuthGuard;
