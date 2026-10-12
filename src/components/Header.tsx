'use client';

import React, { useState } from 'react';
import { Plus, Upload, Download, Terminal, ShieldCheck, Globe, Settings2 } from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import { ImportModal } from './ImportModal';
import { EnvironmentModal } from './EnvironmentModal';
import { exportPostmanCollection } from '@/lib/postman';

export const Header: React.FC = () => {
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isEnvModalOpen, setIsEnvModalOpen] = useState(false);

  const createTab = useApiStore((state) => state.createTab);
  const collections = useApiStore((state) => state.collections);
  const environments = useApiStore((state) => state.environments);
  const activeEnvironmentId = useApiStore((state) => state.activeEnvironmentId);
  const setActiveEnvironmentId = useApiStore((state) => state.setActiveEnvironmentId);

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
      <header className="flex h-14 w-full items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-4 backdrop-blur-md">
        {/* Brand & Status */}
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-tr from-sky-600 to-indigo-600 shadow-md shadow-sky-500/20 text-white">
            <Terminal className="h-4 w-4" />
          </div>
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-bold tracking-tight text-zinc-100">
              AirREST
            </h1>
            <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-400">
              Extension v1.1
            </span>
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

          <div className="hidden 2xl:flex items-center gap-1 border-l border-zinc-800 pl-3 ml-1 text-[11px] text-zinc-500">
            <ShieldCheck className="h-3.5 w-3.5 text-zinc-400" />
            <span>Saved</span>
          </div>
        </div>
      </header>

      <ImportModal isOpen={isImportOpen} onClose={() => setIsImportOpen(false)} />
      <EnvironmentModal isOpen={isEnvModalOpen} onClose={() => setIsEnvModalOpen(false)} />
    </>
  );
};
