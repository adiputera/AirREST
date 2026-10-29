'use client';

import React from 'react';
import { Database, Cloud, Shield, Zap, Users, Check, ArrowRight, X } from 'lucide-react';
import { useApiStore } from '../store/useApiStore';

interface ModeSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectCloud: () => void;
}

export const ModeSelectorModal: React.FC<ModeSelectorModalProps> = ({
  isOpen,
  onClose,
  onSelectCloud,
}) => {
  const setWorkspaceMode = useApiStore((state) => state.setWorkspaceMode);
  const workspaceMode = useApiStore((state) => state.workspaceMode);

  if (!isOpen) return null;

  const handleSelectOffline = () => {
    setWorkspaceMode('offline');
    onClose();
  };

  const handleSelectCloud = () => {
    onClose();
    onSelectCloud();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4 animate-in fade-in duration-150">
      <div className="relative w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl shadow-black/80">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition"
          title="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Header */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs font-semibold text-sky-400 mb-2">
            AirREST Workspace Configuration
          </div>
          <h2 className="text-xl font-bold text-zinc-100 tracking-tight">
            How would you like to use AirREST?
          </h2>
          <p className="text-xs text-zinc-400 mt-1 max-w-md mx-auto">
            Choose your storage mode. You can switch between offline and cloud sync at any time from the top header.
          </p>
        </div>

        {/* Options Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Card 1: Offline Mode */}
          <div
            onClick={handleSelectOffline}
            className={`group relative flex flex-col justify-between rounded-xl border p-5 cursor-pointer transition-all duration-200 ${
              workspaceMode === 'offline'
                ? 'border-sky-500 bg-sky-950/20 shadow-md shadow-sky-500/10'
                : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900/80'
            }`}
          >
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-800 text-sky-400 group-hover:scale-105 transition">
                  <Database className="h-5 w-5" />
                </div>
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/20">
                  Instant • Private
                </span>
              </div>

              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-1.5">
                Offline Mode (Local-First)
                {workspaceMode === 'offline' && <Check className="h-4 w-4 text-sky-400" />}
              </h3>
              <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed">
                100% private. All collections, environments, and requests are stored strictly in your browser&apos;s local storage.
              </p>

              <div className="mt-4 space-y-1.5 border-t border-zinc-800/80 pt-3 text-[11px] text-zinc-300">
                <div className="flex items-center gap-2">
                  <Zap className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                  <span>Instant 0ms launch, zero network lag</span>
                </div>
                <div className="flex items-center gap-2">
                  <Shield className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  <span>No login, no external servers, no tracking</span>
                </div>
                <div className="flex items-center gap-2">
                  <Database className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                  <span>Postman v2.1 import &amp; export ready</span>
                </div>
              </div>
            </div>

            <button
              onClick={(e) => {
                e.stopPropagation();
                handleSelectOffline();
              }}
              className="mt-5 w-full flex items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/90 py-2 text-xs font-semibold text-zinc-200 group-hover:bg-zinc-700 group-hover:text-white transition"
            >
              <span>Use Offline Storage</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Card 2: Cloud Sync Mode */}
          <div
            onClick={handleSelectCloud}
            className={`group relative flex flex-col justify-between rounded-xl border p-5 cursor-pointer transition-all duration-200 ${
              workspaceMode === 'cloud'
                ? 'border-indigo-500 bg-indigo-950/20 shadow-md shadow-indigo-500/10'
                : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900/80'
            }`}
          >
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-sky-600 to-indigo-600 text-white shadow-md shadow-sky-500/20 group-hover:scale-105 transition">
                  <Cloud className="h-5 w-5" />
                </div>
                <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold text-indigo-400 border border-indigo-500/20">
                  Team Collaboration
                </span>
              </div>

              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-1.5">
                Cloud Sync Mode
                {workspaceMode === 'cloud' && <Check className="h-4 w-4 text-indigo-400" />}
              </h3>
              <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed">
                Connect to AirREST Cloud or self-hosted backend. Sync collections, share environments, and collaborate with your team.
              </p>

              <div className="mt-4 space-y-1.5 border-t border-zinc-800/80 pt-3 text-[11px] text-zinc-300">
                <div className="flex items-center gap-2">
                  <Users className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                  <span>Team &amp; project switcher with fine RBAC</span>
                </div>
                <div className="flex items-center gap-2">
                  <Cloud className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                  <span>Automatic delta sync &amp; multi-device backup</span>
                </div>
                <div className="flex items-center gap-2">
                  <Zap className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                  <span>30-day rolling refresh: never logged out</span>
                </div>
              </div>
            </div>

            <button
              onClick={(e) => {
                e.stopPropagation();
                handleSelectCloud();
              }}
              className="mt-5 w-full flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-sky-600 to-indigo-600 py-2 text-xs font-semibold text-white shadow-md shadow-sky-500/20 hover:from-sky-500 hover:to-indigo-500 transition"
            >
              <span>Connect Cloud Sync</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Footer Note */}
        <p className="text-center text-[11px] text-zinc-500 mt-5">
          You can toggle between Offline and Cloud mode at any time using the header badge.
        </p>
      </div>
    </div>
  );
};
