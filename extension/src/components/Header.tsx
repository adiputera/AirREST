'use client';

import React, { useState, useEffect } from 'react';
import { Plus, Upload, Download, Terminal, Globe, Settings2 } from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import { ImportModal } from './ImportModal';
import { EnvironmentModal } from './EnvironmentModal';
import { ModeSelectorModal } from './ModeSelectorModal';
import { CloudAuthModal } from './CloudAuthModal';
import { ScopeSwitcher } from './ScopeSwitcher';
import { exportPostmanCollection } from '@/lib/postman';
import { isOfflineOnly } from '@/lib/edition';

export const Header: React.FC = () => {
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isEnvModalOpen, setIsEnvModalOpen] = useState(false);
  const [isModeSelectorOpen, setIsModeSelectorOpen] = useState(false);
  const [isCloudAuthOpen, setIsCloudAuthOpen] = useState(false);

  const createTab = useApiStore((state) => state.createTab);
  const collections = useApiStore((state) => state.collections);
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

  const handleExportAll = () => {
    if (collections.length === 0) {
      alert('No collections to export! Create or import a collection first.');
      return;
    }

    const firstCollection = collections[0];
    const postmanJson = exportPostmanCollection(firstCollection);
    const blob = new Blob([postmanJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${firstCollection.name.toLowerCase().replace(/\s+/g, '-')}-postman-v2.1.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <header className="relative z-30 flex h-14 w-full items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-4 backdrop-blur-md">
        {/* Brand & Team/Project Scope Switcher */}
        <div className="flex items-center gap-3">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-lg shadow-md shrink-0 text-white ${
              isOfflineOnly
                ? 'bg-gradient-to-tr from-emerald-600 to-teal-500 shadow-emerald-500/20'
                : 'bg-gradient-to-tr from-sky-600 to-indigo-600 shadow-sky-500/20'
            }`}
          >
            <Terminal className="h-4 w-4" />
          </div>
          <div className="flex items-center gap-2 mr-1">
            <h1 className="text-sm font-bold tracking-tight text-zinc-100">
              AirREST
            </h1>
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

          {/* Scope & Team Switcher (Full edition only) */}
          {!isOfflineOnly && (
            <div className="relative z-30 border-l border-zinc-800/80 pl-3">
              <ScopeSwitcher
                onOpenModeSelector={() => setIsModeSelectorOpen(true)}
                onOpenCloudAuth={() => setIsCloudAuthOpen(true)}
              />
            </div>
          )}
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
            onClick={() => createTab()}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white transition"
          >
            <Plus className="h-3.5 w-3.5 text-sky-400" />
            <span className="hidden sm:inline">New Request</span>
          </button>

          <button
            onClick={() => setIsImportOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 hover:bg-sky-500/20 transition shadow-sm"
          >
            <Upload className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Import</span>
          </button>

          {collections.length > 0 && (
            <button
              onClick={handleExportAll}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition"
              title="Export primary collection to Postman v2.1 JSON"
            >
              <Download className="h-3.5 w-3.5 text-zinc-400" />
              <span className="hidden md:inline">Export</span>
            </button>
          )}
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

