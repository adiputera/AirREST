'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Upload, Globe, Settings2, Menu, ChevronDown, Check } from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { isCloudSessionActive } from '../workspace/cloudSession';
import { ImportModal } from './ImportModal';
import { EnvironmentModal } from './EnvironmentModal';
import { EnvironmentOccModal } from './EnvironmentOccModal';
import { ModeSelectorModal } from './ModeSelectorModal';
import { CloudAuthModal } from './CloudAuthModal';
import { ScopeSwitcher } from './ScopeSwitcher';
import { UserMenu } from './UserMenu';
import { DesktopThemeToggle } from './ThemeToggle';
import { hasScopePermission } from '../lib/jwt';
import { usePlatformAdapter, useProductPolicy } from '../context';
import { useBackHandler } from '../lib/backNavigation';

export const Header: React.FC<{ onOpenSidebar?: () => void }> = ({ onOpenSidebar }) => {
  const productPolicy = useProductPolicy();
  const isOfflineOnly = !productPolicy.workspace.cloud;
  const runtimeAdapter = usePlatformAdapter();
  const isDesktop = runtimeAdapter?.platformId === 'desktop';
  const isAndroid = runtimeAdapter?.platformId === 'android';
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isEnvModalOpen, setIsEnvModalOpen] = useState(false);
  const [isModeSelectorOpen, setIsModeSelectorOpen] = useState(false);
  const [isCloudAuthOpen, setIsCloudAuthOpen] = useState(false);
  const [isMobileEnvOpen, setIsMobileEnvOpen] = useState(false);
  const [isDesktopEnvOpen, setIsDesktopEnvOpen] = useState(false);

  const mobileEnvRef = useRef<HTMLDivElement>(null);
  const desktopEnvRef = useRef<HTMLDivElement>(null);

  useBackHandler(isMobileEnvOpen, () => setIsMobileEnvOpen(false), 20);

  const environments = useApiStore((state) => state.environments);
  const activeEnvironmentId = useApiStore((state) => state.activeEnvironmentId);
  const setActiveEnvironmentId = useApiStore((state) => state.setActiveEnvironmentId);
  const hasConfiguredMode = useApiStore((state) => state.hasConfiguredMode);
  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);
  const activeEnv = (environments || []).find((e) => e.id === activeEnvironmentId);
  const activeEnvName = activeEnv ? activeEnv.name : 'No Environment';

  useEffect(() => {
    if (!isMobileEnvOpen && !isDesktopEnvOpen) return;

    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (isMobileEnvOpen && mobileEnvRef.current && !mobileEnvRef.current.contains(target)) {
        setIsMobileEnvOpen(false);
      }
      if (isDesktopEnvOpen && desktopEnvRef.current && !desktopEnvRef.current.contains(target)) {
        setIsDesktopEnvOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMobileEnvOpen(false);
        setIsDesktopEnvOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMobileEnvOpen, isDesktopEnvOpen]);

  const isProjectReadOnly =
    workspaceMode === 'cloud' &&
    cloudConfig?.activeScope?.type === 'project' &&
    !hasScopePermission(cloudConfig?.activeScope, 'collection:write', workspaceMode, cloudConfig?.user?.role);

  // Automatically prompt on first launch if storage mode is not yet configured (Full edition only)
  useEffect(() => {
    if (!isOfflineOnly && productPolicy.workspace.offline !== false && !hasConfiguredMode) {
      setIsModeSelectorOpen(true);
    }
  }, [isOfflineOnly, productPolicy, hasConfiguredMode]);

  useEffect(() => {
    if (productPolicy.workspace.cloud && productPolicy.workspace.offline === false && !isCloudSessionActive(cloudConfig)) {
      setIsCloudAuthOpen(true);
    }
  }, [productPolicy, cloudConfig.token, cloudConfig.sessionKind, cloudConfig.user?.id]);

  return (
    <>
      <header className="relative z-30 flex h-14 w-full items-center justify-between border-b border-line bg-surface/80 px-3 backdrop-blur-md md:px-4">
        {/* Brand & Desktop Scope Switcher / Mobile Env Switcher */}
        <div className="flex flex-1 min-w-0 items-center gap-2 md:flex-initial md:gap-3">
          {onOpenSidebar && (
            <button
              type="button"
              aria-label="Open collections panel"
              onClick={onOpenSidebar}
              className="rounded-lg p-2 text-tx-secondary hover:bg-hover md:hidden shrink-0"
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
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : isDesktop
                  ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                  : 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400'
              }`}
            >
              {isOfflineOnly ? 'Offline Edition' : isDesktop ? 'Desktop App' : isAndroid ? 'Android App' : 'Extension'}
            </span>
          </div>

          {/* Desktop Scope & Workspace Switcher (Desktop only) */}
          <div className="hidden md:block border-l border-line pl-3 md:relative md:z-30">
            <ScopeSwitcher
              onOpenModeSelector={() => setIsModeSelectorOpen(true)}
              onOpenCloudAuth={() => setIsCloudAuthOpen(true)}
            />
          </div>

          {/* Mobile Environment Switcher (Directly after logo, fills remaining space on mobile only) */}
          <div
            className="flex flex-1 min-w-0 items-center gap-1.5 rounded-lg border border-line bg-card/90 px-2.5 py-1 md:hidden"
            style={{ position: 'relative' }}
            ref={mobileEnvRef}
          >
            <button
              type="button"
              onClick={() => setIsMobileEnvOpen((prev) => !prev)}
              className="flex flex-1 min-w-0 items-center gap-1.5 text-left focus:outline-none cursor-pointer"
              aria-haspopup="listbox"
              aria-expanded={isMobileEnvOpen}
              title={`Active Environment: ${activeEnvName}`}
            >
              <Globe className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400 shrink-0" />
              <span className="flex-1 truncate font-medium text-xs text-tx-primary">
                {activeEnvName}
              </span>
              <ChevronDown className={`h-3 w-3 text-tx-muted transition-transform shrink-0 ${isMobileEnvOpen ? 'rotate-180' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => {
                setIsMobileEnvOpen(false);
                setIsEnvModalOpen(true);
              }}
              className="rounded p-1 text-tx-muted hover:text-tx-primary hover:bg-hover transition shrink-0 cursor-pointer"
              title="Manage Environments"
              aria-label="Manage Environments"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </button>

            {/* Mobile Dropdown Popover */}
            {isMobileEnvOpen && (
              <div
                role="listbox"
                className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-xl border border-line bg-card p-1.5 shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-100 min-w-[220px]"
              >
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-tx-muted">
                  Active Environment
                </div>
                <div className="max-h-56 overflow-y-auto space-y-0.5 py-0.5">
                  <button
                    type="button"
                    role="option"
                    aria-selected={!activeEnvironmentId}
                    onClick={() => {
                      setActiveEnvironmentId(null);
                      setIsMobileEnvOpen(false);
                    }}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-xs transition cursor-pointer ${
                      !activeEnvironmentId
                        ? 'bg-hover text-sky-600 dark:text-sky-400 font-semibold shadow-xs'
                        : 'text-tx-secondary hover:bg-hover hover:text-tx-primary'
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <Globe className="h-3.5 w-3.5 text-tx-muted shrink-0" />
                      <span className="truncate">No Environment</span>
                    </div>
                    {!activeEnvironmentId && <Check className="h-3.5 w-3.5 text-sky-500 shrink-0" />}
                  </button>

                  {(environments || []).map((env) => {
                    const isSelected = env.id === activeEnvironmentId;
                    const varCount = env.variables?.length || 0;
                    return (
                      <button
                        key={env.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => {
                          setActiveEnvironmentId(env.id);
                          setIsMobileEnvOpen(false);
                        }}
                        className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-xs transition cursor-pointer ${
                          isSelected
                            ? 'bg-hover text-sky-600 dark:text-sky-400 font-semibold shadow-xs'
                            : 'text-tx-secondary hover:bg-hover hover:text-tx-primary'
                        }`}
                      >
                        <div className="flex items-center gap-2 truncate">
                          <Globe className={`h-3.5 w-3.5 shrink-0 ${isSelected ? 'text-sky-500' : 'text-tx-muted'}`} />
                          <span className="truncate">{env.name}</span>
                          <span className="rounded-full bg-element px-1.5 py-0.5 text-[10px] text-tx-muted shrink-0">
                            {varCount} {varCount === 1 ? 'var' : 'vars'}
                          </span>
                        </div>
                        {isSelected && <Check className="h-3.5 w-3.5 text-sky-500 shrink-0" />}
                      </button>
                    );
                  })}
                </div>

                <div className="border-t border-line mt-1 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setIsMobileEnvOpen(false);
                      setIsEnvModalOpen(true);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-tx-muted hover:text-tx-primary hover:bg-hover transition cursor-pointer"
                  >
                    <Settings2 className="h-3.5 w-3.5 shrink-0" />
                    <span>Manage Environments...</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Desktop Global Actions (Desktop only: Env Selector, Theme Toggle, Import, UserMenu) */}
        <div className="hidden md:flex items-center gap-1.5 lg:gap-2 shrink-0">
          {/* Environment Selector */}
          <div className="relative" ref={desktopEnvRef}>
            <div className="flex items-center gap-1.5 rounded-lg border border-line bg-card/90 px-2 py-1 lg:px-2.5 hover:border-line-strong transition">
              <button
                type="button"
                onClick={() => setIsDesktopEnvOpen((prev) => !prev)}
                className="flex items-center gap-1.5 text-left focus:outline-none cursor-pointer"
                aria-haspopup="listbox"
                aria-expanded={isDesktopEnvOpen}
                title={`Active Environment: ${activeEnvName}`}
              >
                <Globe className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400 shrink-0" />
                <span className="font-medium text-xs text-tx-primary max-w-[85px] sm:max-w-[105px] lg:max-w-[130px] xl:max-w-[160px] truncate">
                  {activeEnvName}
                </span>
                <ChevronDown className={`h-3 w-3 text-tx-muted transition-transform shrink-0 ${isDesktopEnvOpen ? 'rotate-180' : ''}`} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsDesktopEnvOpen(false);
                  setIsEnvModalOpen(true);
                }}
                className="rounded p-1 text-tx-muted hover:text-tx-primary hover:bg-hover transition shrink-0 cursor-pointer"
                title="Manage Environments"
                aria-label="Manage Environments"
              >
                <Settings2 className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Desktop Dropdown Popover */}
            {isDesktopEnvOpen && (
              <div
                role="listbox"
                className="absolute right-0 top-full mt-1.5 z-50 w-64 rounded-xl border border-line bg-card p-1.5 shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-100"
              >
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-tx-muted">
                  Active Environment
                </div>
                <div className="max-h-60 overflow-y-auto space-y-0.5 py-0.5">
                  <button
                    type="button"
                    role="option"
                    aria-selected={!activeEnvironmentId}
                    onClick={() => {
                      setActiveEnvironmentId(null);
                      setIsDesktopEnvOpen(false);
                    }}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition cursor-pointer ${
                      !activeEnvironmentId
                        ? 'bg-hover text-sky-600 dark:text-sky-400 font-semibold shadow-xs'
                        : 'text-tx-secondary hover:bg-hover hover:text-tx-primary'
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <Globe className="h-3.5 w-3.5 text-tx-muted shrink-0" />
                      <span className="truncate">No Environment</span>
                    </div>
                    {!activeEnvironmentId && <Check className="h-3.5 w-3.5 text-sky-500 shrink-0" />}
                  </button>

                  {(environments || []).map((env) => {
                    const isSelected = env.id === activeEnvironmentId;
                    const varCount = env.variables?.length || 0;
                    return (
                      <button
                        key={env.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => {
                          setActiveEnvironmentId(env.id);
                          setIsDesktopEnvOpen(false);
                        }}
                        className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition cursor-pointer ${
                          isSelected
                            ? 'bg-hover text-sky-600 dark:text-sky-400 font-semibold shadow-xs'
                            : 'text-tx-secondary hover:bg-hover hover:text-tx-primary'
                        }`}
                      >
                        <div className="flex items-center gap-2 truncate">
                          <Globe className={`h-3.5 w-3.5 shrink-0 ${isSelected ? 'text-sky-500' : 'text-tx-muted'}`} />
                          <span className="truncate">{env.name}</span>
                          <span className="rounded-full bg-element px-1.5 py-0.5 text-[10px] text-tx-muted shrink-0">
                            {varCount} {varCount === 1 ? 'var' : 'vars'}
                          </span>
                        </div>
                        {isSelected && <Check className="h-3.5 w-3.5 text-sky-500 shrink-0" />}
                      </button>
                    );
                  })}
                </div>

                <div className="border-t border-line mt-1 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setIsDesktopEnvOpen(false);
                      setIsEnvModalOpen(true);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-tx-muted hover:text-tx-primary hover:bg-hover transition cursor-pointer"
                  >
                    <Settings2 className="h-3.5 w-3.5 shrink-0" />
                    <span>Manage Environments...</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Desktop Theme Mode Toggle */}
          <DesktopThemeToggle />

          {!isProjectReadOnly && (
            <button
              onClick={() => setIsImportOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-1.5 lg:px-3 text-xs font-medium text-sky-600 dark:text-sky-300 hover:bg-sky-500/20 transition shadow-sm shrink-0"
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
          {productPolicy.workspace.offline !== false && (
            <ModeSelectorModal
              isOpen={isModeSelectorOpen}
              onClose={() => setIsModeSelectorOpen(false)}
              onSelectCloud={() => setIsCloudAuthOpen(true)}
            />
          )}
          <CloudAuthModal
            isOpen={isCloudAuthOpen}
            onClose={() => setIsCloudAuthOpen(false)}
          />
        </>
      )}
    </>
  );
};
