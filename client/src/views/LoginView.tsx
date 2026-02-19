import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { Mail, Key, Loader2, ShieldCheck } from 'lucide-react';

const LoginView = () => {
  const [token, setToken] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;

    setIsLoading(true);
    setError('');

    try {
      // For bootstrapping, we store the token and try a health check or list connectors
      api.auth.login(token);
      await api.connectors.listIncoming();
      navigate('/inbox');
    } catch (err: any) {
      setError('Invalid user token or server connection failed.');
      api.auth.logout();
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-bg-app flex items-center justify-center p-4">
      <div className="w-full max-w-md animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-accent rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-accent/20">
            <Mail className="w-8 h-8" style={{ color: 'var(--accent-contrast)' }} />
          </div>
          <h1 className="text-2xl font-bold text-text-primary tracking-tight">betterMail</h1>
          <p className="text-sm text-text-secondary mt-1">Connector-first email client</p>
        </div>

        <div className="card shadow-sm border-border p-8 bg-bg-card">
          <form onSubmit={handleLogin} className="space-y-6">
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-text-secondary uppercase tracking-wider flex items-center gap-1.5">
                <Key className="w-3.5 h-3.5" />
                User Access Token
              </label>
              <input
                type="password"
                required
                className="input text-sm"
                placeholder="Paste your Bearer token here..."
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <p className="text-[10px] text-text-secondary leading-relaxed pt-1 flex items-center gap-1">
                <ShieldCheck className="w-3 h-3 text-green-500" />
                Token is kept in this browser session and sent over HTTPS.
              </p>
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-100 rounded-md text-red-600 text-xs font-medium animate-in fade-in duration-300">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full btn btn-primary flex items-center justify-center gap-2 py-2.5 font-bold shadow-md active:scale-[0.98] transition-all"
            >
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Enter Dashboard'}
            </button>
          </form>
        </div>

        <div className="mt-8 text-center">
          <p className="text-[11px] text-text-secondary italic">
            "Compact, robust, and information-dense."
          </p>
        </div>
      </div>
    </div>
  );
};

export default LoginView;
