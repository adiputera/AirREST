'use client';

import React, { useState, useEffect } from 'react';
import { Upload, Globe, Settings2, Menu } from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { ImportModal } from './ImportModal';
import { EnvironmentModal } from './EnvironmentModal';
import { EnvironmentOccModal } from './EnvironmentOccModal';
import { ModeSelectorModal } from './ModeSelectorModal';
import { CloudAuthModal } from './CloudAuthModal';
import { ScopeSwitcher } from './ScopeSwitcher';
import { UserMenu } from './UserMenu';
import { isOfflineOnly } from '../lib/edition';
import { hasScopePermission } from '../lib/jwt';
import { useAirrestRuntime } from '../context';

export const Header: React.FC<{ onOpenSidebar?: () => void }> = ({ onOpenSidebar }) => {
  let isDesktop = false;
  let isAndroid = false;
  try {
    const runtime = useAirrestRuntime();
    isDesktop = runtime?.adapter?.platformId === 'desktop';
    isAndroid = runtime?.adapter?.platformId === 'android';
  } catch {
    // fallback if outside runtime context
  }
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isEnvModalOpen, setIsEnvModalOpen] = useState(false);
  const [isModeSelectorOpen, setIsModeSelectorOpen] = useState(false);
  const [isCloudAuthOpen, setIsCloudAuthOpen] = useState(false);

  const environments = useApiStore((state) => state.environments);
  const activeEnvironmentId = useApiStore((state) => state.activeEnvironmentId);
  const setActiveEnvironmentId = useApiStore((state) => state.setActiveEnvironmentId);
  const hasConfiguredMode = useApiStore((state) => state.hasConfiguredMode);
  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);

  const isProjectReadOnly =
    workspaceMode === 'cloud' &&
    cloudConfig?.activeScope?.type === 'project' &&
    !hasScopePermission(cloudConfig?.activeScope, 'collection:write', workspaceMode, cloudConfig?.user?.role);

  // Automatically prompt on first launch if storage mode is not yet configured (Full edition only)
  useEffect(() => {
    if (!isOfflineOnly && !hasConfiguredMode) {
      setIsModeSelectorOpen(true);
    }
  }, [isOfflineOnly, hasConfiguredMode]);

  return (
    <>
      <header className="relative z-30 flex h-14 w-full items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-3 backdrop-blur-md md:px-4">
        {/* Brand & Desktop Scope Switcher / Mobile Env Switcher */}
        <div className="flex flex-1 min-w-0 items-center gap-2 md:flex-initial md:gap-3">
          {onOpenSidebar && (
            <button
              type="button"
              aria-label="Open collections panel"
              onClick={onOpenSidebar}
              className="rounded-lg p-2 text-zinc-300 hover:bg-zinc-800 md:hidden shrink-0"
            >
              <Menu className="h-5 w-5" />
            </button>
          )}

          <div className="flex items-center gap-2 mr-1 shrink-0">
            <img
              src={isOfflineOnly && import.meta.env.DEV ? '/icons-offline/logo.png' : '/icons/logo.png'}
              alt="AirREST"
              className="h-8 w-auto rounded-lg object-contain shadow-sm"
            />
            <span
              className={`hidden xl:inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                isOfflineOnly
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                  : isDesktop
                  ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-400'
                  : 'border-sky-500/30 bg-sky-500/10 text-sky-400'
              }`}
            >
              {isOfflineOnly ? 'Offline Edition' : isDesktop ? 'Desktop App' : isAndroid ? 'Android App' : 'Extension v1.1'}
            </span>
          </div>

          {/* Desktop Scope & Workspace Switcher (Desktop only) */}
          <div className="hidden md:block border-l border-zinc-800/80 pl-3 md:relative md:z-30">
            <ScopeSwitcher
              onOpenModeSelector={() => setIsModeSelectorOpen(true)}
              onOpenCloudAuth={() => setIsCloudAuthOpen(true)}
            />
          </div>

          {/* Mobile Environment Switcher (Directly after logo, fills remaining space on mobile only) */}
          <div className="flex flex-1 min-w-0 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/90 px-2.5 py-1 md:hidden">
            <Globe className="h-3.5 w-3.5 text-sky-400 shrink-0" />
            <select
              value={activeEnvironmentId || ''}
              onChange={(e) => setActiveEnvironmentId(e.target.value ? e.target.value : null)}
              className="w-full bg-transparent font-medium text-xs text-zinc-200 focus:outline-none cursor-pointer truncate"
            >
              <option value="" className="bg-zinc-900 text-zinc-400">
                No Environment
              </option>
              {(environments || []).map((env) => (
                <option key={env.id} value={env.id} className="bg-zinc-900 text-zinc-200">
                  {env.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => setIsEnvModalOpen(true)}
              className="rounded p-1 text-zinc-400 hover:text-white hover:bg-zinc-800 transition shrink-0"
              title="Manage Environments"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Desktop Global Actions (Desktop only: Env Selector, Import, UserMenu) */}
        <div className="hidden md:flex items-center gap-1.5 lg:gap-2 shrink-0">
          {/* Environment Selector */}
          <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/90 px-2 py-1 lg:px-2.5">
            <Globe className="h-3.5 w-3.5 text-sky-400 shrink-0" />
            <select
              value={activeEnvironmentId || ''}
              onChange={(e) => setActiveEnvironmentId(e.target.value ? e.target.value : null)}
              className="bg-transparent font-medium text-xs text-zinc-200 focus:outline-none cursor-pointer max-w-[85px] sm:max-w-[105px] lg:max-w-[130px] xl:max-w-[160px] truncate"
            >
              <option value="" className="bg-zinc-900 text-zinc-400">
                No Environment
              </option>
              {(environments || []).map((env) => (
                <option key={env.id} value={env.id} className="bg-zinc-900 text-zinc-200">
                  {env.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => setIsEnvModalOpen(true)}
              className="rounded p-1 text-zinc-400 hover:text-white hover:bg-zinc-800 transition shrink-0"
              title="Manage Environments"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </button>
          </div>

          {!isProjectReadOnly && (
            <button
              onClick={() => setIsImportOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-1.5 lg:px-3 text-xs font-medium text-sky-300 hover:bg-sky-500/20 transition shadow-sm shrink-0"
              title="Import Postman Collection or Environment"
            >
              <Upload className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">Import</span>
            </button>
          )}

          {/* User Profile Menu / Sign In Button */}
          <UserMenu onOpenLogin={() => setIsCloudAuthOpen(true)} />
        </div>
      </header>

      {/* Modals */}
      <ImportModal isOpen={isImportOpen} onClose={() => setIsImportOpen(false)} />
      <EnvironmentModal isOpen={isEnvModalOpen} onClose={() => setIsEnvModalOpen(false)} />
      <EnvironmentOccModal />
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
