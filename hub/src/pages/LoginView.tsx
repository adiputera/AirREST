import React, { useState } from 'react';
import { Cloud, Lock, Mail, Server, AlertCircle, Loader2 } from 'lucide-react';
import { useHubStore } from '../store/useHubStore';
import { apiLogin, DEFAULT_API_URL } from '../lib/api';

export const LoginView: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showServerConfig, setShowServerConfig] = useState(false);

  const apiUrl = useHubStore((state) => state.apiUrl);
  const setApiUrl = useHubStore((state) => state.setApiUrl);
  const setAuth = useHubStore((state) => state.setAuth);

  const [inputUrl, setInputUrl] = useState(apiUrl);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg(null);

    try {
      const cleanUrl = inputUrl.trim().replace(/\/+$/, '') || DEFAULT_API_URL;
      setApiUrl(cleanUrl);

      const res = await apiLogin(cleanUrl, email, password);
      setAuth(res.user, res.token, res.refresh_token, res.expires_at);
    } catch (err: any) {
      setErrorMsg(err.message || 'Authentication failed. Please verify credentials.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-zinc-950 p-4">
      {/* Background Glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 h-96 w-96 rounded-full bg-sky-500/10 blur-3xl"></div>
        <div className="absolute -bottom-40 -right-40 h-96 w-96 rounded-full bg-indigo-500/10 blur-3xl"></div>
      </div>

      <div className="relative w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 shadow-2xl backdrop-blur-xl">
        {/* Brand */}
        <div className="text-center mb-6">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-tr from-sky-600 to-indigo-600 text-white shadow-lg shadow-sky-500/25">
            <Cloud className="h-6 w-6" />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-100">AirREST Hub</h1>
          <p className="text-xs text-zinc-400 mt-1">Management Portal for Teams, Projects &amp; RBAC</p>
        </div>

        {/* Error Alert */}
        {errorMsg && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Sign In Form */}
        <form onSubmit={handleSubmit} className="space-y-3.5">
          <div>
            <label className="block text-xs font-semibold text-zinc-300 mb-1">Email Address</label>
            <div className="relative">
              <Mail className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
              <input
                type="email"
                required
                placeholder="user@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 pl-9 pr-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-300 mb-1">Password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
              <input
                type="password"
                required
                minLength={8}
                placeholder="Minimum 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 pl-9 pr-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
              />
            </div>
          </div>

          {/* Server Config Toggle */}
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowServerConfig(!showServerConfig)}
              className="flex items-center gap-1.5 text-[11px] text-zinc-400 hover:text-sky-400 transition"
            >
              <Server className="h-3 w-3" />
              <span>{showServerConfig ? 'Hide Server Configuration' : `Server (${inputUrl})`}</span>
            </button>

            {showServerConfig && (
              <div className="mt-2 rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3">
                <label className="block text-[10px] uppercase font-semibold text-zinc-400 mb-1">
                  Server Endpoint
                </label>
                <input
                  type="url"
                  value={inputUrl}
                  onChange={(e) => setInputUrl(e.target.value)}
                  placeholder={DEFAULT_API_URL}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 font-mono focus:border-sky-500 focus:outline-none"
                />
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-sky-600 to-indigo-600 py-2.5 text-xs font-semibold text-white shadow-lg shadow-sky-500/25 hover:from-sky-500 hover:to-indigo-500 transition disabled:opacity-50 mt-4"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Sign In to Dashboard'}
          </button>
        </form>

        <p className="mt-5 text-center text-[11px] text-zinc-500">
          New accounts are provisioned exclusively by your system administrator.
        </p>
      </div>
    </div>
  );
};
