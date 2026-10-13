import React, { useState } from 'react';
import { Laptop, Copy, Check, Shield, Server, Key, ArrowRight } from 'lucide-react';
import { useHubStore } from '../store/useHubStore';

export const ConnectView: React.FC = () => {
  const apiUrl = useHubStore((state) => state.apiUrl);
  const token = useHubStore((state) => state.token);
  const user = useHubStore((state) => state.user);

  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);

  const copyToClipboard = (text: string, setCopied: (v: boolean) => void) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex-1 overflow-y-auto p-8 bg-zinc-950">
      <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in duration-150">
        {/* Banner */}
        <div className="rounded-2xl border border-sky-500/30 bg-gradient-to-r from-sky-950/20 to-indigo-950/20 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Laptop className="h-5 w-5 text-sky-400" />
              <h1 className="text-xl font-bold text-zinc-100">Pair with AirREST Chrome Extension</h1>
            </div>
            <p className="text-xs text-zinc-400 max-w-xl">
              Connect your testing client studio directly to this Hub instance to access team collections,
              environments, and synchronizations with zero CORS restrictions.
            </p>
          </div>
        </div>

        {/* Pairing Credentials Card */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 space-y-5">
          <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
            <Key className="h-4 w-4 text-amber-400" />
            <span>Connection Credentials</span>
          </h2>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1">Backend API Endpoint</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={apiUrl}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none"
                />
                <button
                  onClick={() => copyToClipboard(apiUrl, setCopiedUrl)}
                  className="flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-800/80 px-3 py-2 text-xs font-semibold text-zinc-300 hover:text-white hover:bg-zinc-700 transition shrink-0"
                >
                  {copiedUrl ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copiedUrl ? 'Copied' : 'Copy URL'}</span>
                </button>
              </div>
            </div>

            {token && (
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Active JWT Access Token</label>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    readOnly
                    value={token}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none"
                  />
                  <button
                    onClick={() => copyToClipboard(token, setCopiedToken)}
                    className="flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-800/80 px-3 py-2 text-xs font-semibold text-zinc-300 hover:text-white hover:bg-zinc-700 transition shrink-0"
                  >
                    {copiedToken ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                    <span>{copiedToken ? 'Copied' : 'Copy Token'}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Step-by-Step Pairing Guide */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 space-y-4">
          <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
            <Server className="h-4 w-4 text-sky-400" />
            <span>How to Connect in 3 Steps</span>
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-950 p-4 space-y-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/10 font-bold text-sky-400 text-xs border border-sky-500/20">
                1
              </div>
              <h3 className="font-semibold text-zinc-200">Open Extension</h3>
              <p className="text-zinc-400 text-[11px] leading-relaxed">
                Click the AirREST icon in your Google Chrome extensions toolbar to launch the studio.
              </p>
            </div>

            <div className="rounded-xl border border-zinc-800/80 bg-zinc-950 p-4 space-y-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/10 font-bold text-indigo-400 text-xs border border-indigo-500/20">
                2
              </div>
              <h3 className="font-semibold text-zinc-200">Click &ldquo;Connect Cloud&rdquo;</h3>
              <p className="text-zinc-400 text-[11px] leading-relaxed">
                Select the storage pill in the top header and sign in with <strong className="text-zinc-200">{user?.email}</strong>.
              </p>
            </div>

            <div className="rounded-xl border border-zinc-800/80 bg-zinc-950 p-4 space-y-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 font-bold text-emerald-400 text-xs border border-emerald-500/20">
                3
              </div>
              <h3 className="font-semibold text-zinc-200">Never Logged Out</h3>
              <p className="text-zinc-400 text-[11px] leading-relaxed">
                With 30-day rolling refresh tokens, your session updates seamlessly in the background as you work.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
