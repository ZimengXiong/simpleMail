import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { startOidcLogin } from '../services/oidc';
import { api, getAuthToken } from '../services/api';
import { resolveSafeNextPath, toAbsoluteAppUrl } from '../services/authRedirect';
import AppBrand from '../components/AppBrand';

const LoginView = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const initialError = useMemo(() => {
    const value = String(searchParams.get('authError') ?? '').trim();
    return value || '';
  }, [searchParams]);
  const [error, setError] = useState(initialError);
  const [isVerifying, setIsVerifying] = useState(() => api.auth.isAuthenticated());

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
      setIsVerifying(false);
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
      <div className="w-full max-w-[360px] p-10 border border-border bg-bg-card text-center shadow-xs">
        <div className="mb-6">
          <AppBrand className="justify-center" />
        </div>
        <h1 className="text-lg font-bold text-text-primary mb-8">Sign in to SimpleMail with OIDC</h1>

        {isVerifying ? (
          <div className="text-xs text-text-secondary py-4">
            Verifying session...
          </div>
        ) : (
          <>
            {error ? (
              <div className="mb-6 p-3 bg-red-50 border border-red-100 text-red-600 text-xs text-left">
                {error}
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => {
                setError('');
                void startLogin().catch(() => {
                  setError('Could not start OIDC sign-in. Verify your OIDC provider settings and try again.');
                });
              }}
              className="w-full btn btn-primary py-2 font-bold"
            >
              Sign In
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default LoginView;
