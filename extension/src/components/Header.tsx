'use client';

import React, { useState, useEffect } from 'react';
import { Upload, Globe, Settings2 } from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import { ImportModal } from './ImportModal';
import { EnvironmentModal } from './EnvironmentModal';
import { ModeSelectorModal } from './ModeSelectorModal';
import { CloudAuthModal } from './CloudAuthModal';
import { ScopeSwitcher } from './ScopeSwitcher';
import { isOfflineOnly } from '@/lib/edition';

export const Header: React.FC = () => {
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isEnvModalOpen, setIsEnvModalOpen] = useState(false);
  const [isModeSelectorOpen, setIsModeSelectorOpen] = useState(false);
  const [isCloudAuthOpen, setIsCloudAuthOpen] = useState(false);

  const environments = useApiStore((state) => state.environments);
  const activeEnvironmentId = useApiStore((state) => state.activeEnvironmentId);
  const setActiveEnvironmentId = useApiStore((state) => state.setActiveEnvironmentId);
  const hasConfiguredMode = useApiStore((state) => state.hasConfiguredMode);

  // Automatically prompt on first launch if storage mode is not yet configured (Full edition only)
  useEffect(() => {
    if (!isOfflineOnly && !hasConfiguredMode) {
      setIsModeSelectorOpen(true);
    }
  }, [isOfflineOnly, hasConfiguredMode]);

  return (
    <>
      <header className="relative z-30 flex h-14 w-full items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-4 backdrop-blur-md">
        {/* Brand & Team/Project Scope Switcher */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 mr-1">
            <img
              src={isOfflineOnly && import.meta.env.DEV ? '/icons-offline/logo.png' : '/icons/logo.png'}
              alt="AirREST"
              className="h-8 w-auto rounded-lg object-contain shadow-sm"
            />
            <span
              className={`hidden sm:inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                isOfflineOnly
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                  : 'border-sky-500/30 bg-sky-500/10 text-sky-400'
              }`}
            >
              {isOfflineOnly ? 'Offline Edition' : 'Extension v1.1'}
            </span>
          </div>

          {/* Scope & Workspace Switcher */}
          <div className="relative z-30 border-l border-zinc-800/80 pl-3">
            <ScopeSwitcher
              onOpenModeSelector={() => setIsModeSelectorOpen(true)}
              onOpenCloudAuth={() => setIsCloudAuthOpen(true)}
            />
          </div>
        </div>

        {/* Global Actions */}
        <div className="flex items-center gap-2">
          {/* Environment Selector */}
          <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/90 px-2.5 py-1">
            <Globe className="h-3.5 w-3.5 text-sky-400 shrink-0" />
            <select
              value={activeEnvironmentId || ''}
              onChange={(e) => setActiveEnvironmentId(e.target.value ? e.target.value : null)}
              className="bg-transparent font-medium text-xs text-zinc-200 focus:outline-none cursor-pointer max-w-[130px] truncate"
            >
              <option value="" className="bg-zinc-900 text-zinc-400">
                No Environment
              </option>
              {environments.map((env) => (
                <option key={env.id} value={env.id} className="bg-zinc-900 text-zinc-200">
                  {env.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => setIsEnvModalOpen(true)}
              className="rounded p-1 text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
              title="Manage Environments"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </button>
          </div>

          <button
            onClick={() => setIsImportOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 hover:bg-sky-500/20 transition shadow-sm"
          >
            <Upload className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Import</span>
          </button>
        </div>
      </header>

      {/* Modals */}
      <ImportModal isOpen={isImportOpen} onClose={() => setIsImportOpen(false)} />
      <EnvironmentModal isOpen={isEnvModalOpen} onClose={() => setIsEnvModalOpen(false)} />
      {!isOfflineOnly && (
        <>
          <ModeSelectorModal
            isOpen={isModeSelectorOpen}
            onClose={() => setIsModeSelectorOpen(false)}
            onSelectCloud={() => setIsCloudAuthOpen(true)}
          />
          <CloudAuthModal
            isOpen={isCloudAuthOpen}
            onClose={() => setIsCloudAuthOpen(false)}
          />
        </>
      )}
    </>
  );
};

