import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, ShieldCheck } from 'lucide-react';
import { startOidcLogin } from '../services/oidc';
import { api, getAuthToken } from '../services/api';
import { resolveSafeNextPath, toAbsoluteAppUrl } from '../services/authRedirect';

const LoginView = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const initialError = useMemo(() => {
    const value = String(searchParams.get('authError') ?? '').trim();
    return value || '';
  }, [searchParams]);
  const [error, setError] = useState(initialError);
  const nextFromState = useMemo(() => {
    const state = (location.state as { from?: { pathname?: string; search?: string; hash?: string } } | null) ?? null;
    const from = state?.from;
    if (!from) {
      return null;
    }
    const pathname = String(from.pathname ?? '').trim();
    const search = String(from.search ?? '');
    const hash = String(from.hash ?? '');
    if (!pathname.startsWith('/')) {
      return null;
    }
    return `${pathname}${search}${hash}`;
  }, [location.state]);
  const nextPath = useMemo(
    () => resolveSafeNextPath(searchParams.get('next') ?? nextFromState),
    [nextFromState, searchParams],
  );

  const startLogin = useCallback(
    () => startOidcLogin(toAbsoluteAppUrl(nextPath)),
    [nextPath],
  );
  const verifyBackendSession = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    const token = getAuthToken();
    if (!token) {
      return { ok: false, message: 'Missing OIDC access token in browser runtime.' };
    }
    try {
      const response = await fetch('/api/session', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (response.ok) {
        return { ok: true };
      }
      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      const message = typeof payload?.error === 'string'
        ? payload.error
        : `Session check failed (${response.status}).`;
      return { ok: false, message };
    } catch {
      return { ok: false, message: 'Session check failed due to a network error.' };
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!api.auth.isAuthenticated()) {
      return () => {
        cancelled = true;
      };
    }
    void verifyBackendSession().then(({ ok, message }) => {
      if (cancelled) {
        return;
      }
      if (ok) {
        navigate(nextPath, { replace: true });
        return;
      }
      api.auth.clear();
      setError(`OIDC sign-in succeeded, but the API rejected the token. ${message ?? 'Check backend OIDC settings.'}`);
    });
    return () => {
      cancelled = true;
    };
  }, [navigate, nextPath, verifyBackendSession]);

  return (
    <div className="min-h-screen w-full bg-bg-app flex items-center justify-center p-4">
      <div className="w-full max-w-md card shadow-sm border-border p-8 bg-bg-card text-center">
        <div className="w-14 h-14 bg-accent rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-accent/20">
          <ShieldCheck className="w-7 h-7" style={{ color: 'var(--accent-contrast)' }} />
        </div>
        <h1 className="text-xl font-bold text-text-primary tracking-tight">Sign in with OIDC</h1>
        <p className="text-sm text-text-secondary mt-2">
          Click below to continue to your identity provider.
        </p>

        <div className="mt-5 flex items-center justify-center gap-2 text-xs text-text-secondary">
          <Loader2 className="w-4 h-4" />
          Waiting for sign-in
        </div>

        {error ? (
          <div className="mt-6 p-3 bg-red-50 border border-red-100 rounded-md text-red-600 text-xs font-medium">
            {error}
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => {
            setError('');
            void startLogin().catch(() => {
              setError('Could not start OIDC sign-in. Verify Keycloak is running and try again.');
            });
          }}
          className="w-full mt-6 btn btn-primary py-2.5 font-bold"
        >
          Sign In with OIDC
        </button>
      </div>
    </div>
  );
};

export default LoginView;
