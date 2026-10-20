'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronDown,
  User,
  Users,
  FolderGit2,
  RefreshCw,
  Laptop,
  LogOut,
  Search,
  Check,
  AlertTriangle,
  Loader2,
  Cloud,
} from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import { ActiveScope } from '@/types/api';
import { getRoleFromJwt } from '@/lib/jwt';

function formatTimeAgo(timestamp: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

interface ScopeSwitcherProps {
  onOpenModeSelector: () => void;
  onOpenCloudAuth: () => void;
}

export const ScopeSwitcher: React.FC<ScopeSwitcherProps> = ({
  onOpenModeSelector,
  onOpenCloudAuth,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [isLoadingScopes, setIsLoadingScopes] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);

  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);
  const activeScope = cloudConfig.activeScope;
  const syncStatus = useApiStore((state) => state.syncStatus);
  const syncError = useApiStore((state) => state.syncError);
  const lastSyncedAt = useApiStore((state) => state.lastSyncedAt);
  const scopesCache = useApiStore((state) => state.scopesCache);

  const setActiveScope = useApiStore((state) => state.setActiveScope);
  const pullCloudDelta = useApiStore((state) => state.pullCloudDelta);
  const fetchScopes = useApiStore((state) => state.fetchScopes);
  const setWorkspaceMode = useApiStore((state) => state.setWorkspaceMode);
  const logoutCloud = useApiStore((state) => state.logoutCloud);

  const workspaces = scopesCache?.workspaces || [];
  const teamsWithProjects = scopesCache?.teamsWithProjects || [];

  const isOffline = workspaceMode === 'offline';

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Load accessible workspaces and teams (uses 1-hour cache unless forced)
  const loadScopes = async (force = false) => {
    if (!cloudConfig.token) return;
    setIsLoadingScopes(true);
    try {
      await fetchScopes(force);
    } finally {
      setIsLoadingScopes(false);
    }
  };

  useEffect(() => {
    if (cloudConfig.token) {
      loadScopes(false);
    }
  }, [cloudConfig.token]);

  const handleSelectScope = async (scope: ActiveScope) => {
    setIsOpen(false);
    await setActiveScope(scope);
  };

  const handleSelectOffline = () => {
    setIsOpen(false);
    setWorkspaceMode('offline');
  };

  const handleManualSync = async () => {
    await pullCloudDelta();
  };

  const jwtRole = getRoleFromJwt(cloudConfig.token);
  const scopeRole = (jwtRole === 'superadmin' || jwtRole === 'admin') ? 'admin' : activeScope?.role;

  const scopeLabel = isOffline
    ? 'Offline Workspace'
    : activeScope
    ? activeScope.type === 'project'
      ? `${activeScope.teamName || 'Team'} / ${activeScope.name}`
      : activeScope.name
    : 'Select Workspace';

  const searchLower = search.toLowerCase();
  const showOfflineOption =
    !search || 'offline workspace'.includes(searchLower) || 'local storage'.includes(searchLower);

  // Filter scopes based on search query
  const filteredWorkspaces = workspaces.filter((w) =>
    w.name.toLowerCase().includes(searchLower)
  );

  const filteredTeams = teamsWithProjects
    .map((tp) => ({
      team: tp.team,
      projects: tp.projects.filter(
        (p) =>
          p.name.toLowerCase().includes(searchLower) ||
          tp.team.name.toLowerCase().includes(searchLower)
      ),
    }))
    .filter((tp) => tp.projects.length > 0 || tp.team.name.toLowerCase().includes(searchLower));

  return (
    <div className="relative z-30" ref={dropdownRef}>
      {/* Switcher Header Button */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => {
            const next = !isOpen;
            setIsOpen(next);
            if (next && cloudConfig.token) loadScopes(false);
          }}
          className="group flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/90 px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-700 hover:bg-zinc-800 hover:text-white transition shadow-sm max-w-[280px]"
          title="Switch Workspace (Offline / Online)"
        >
          {isOffline ? (
            <Laptop className="h-3.5 w-3.5 text-amber-400 shrink-0" />
          ) : activeScope?.type === 'project' ? (
            <Users className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
          ) : (
            <User className="h-3.5 w-3.5 text-sky-400 shrink-0" />
          )}

          <span className="font-semibold truncate max-w-[170px]">{scopeLabel}</span>

          {isOffline ? (
            <span className="rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1 py-0.2 text-[9px] font-bold uppercase tracking-wider">
              Offline
            </span>
          ) : scopeRole ? (
            <span
              className={`rounded px-1 py-0.2 text-[9px] font-bold uppercase tracking-wider ${
                scopeRole === 'admin' || scopeRole === 'owner'
                  ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                  : scopeRole === 'reader'
                  ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                  : 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
              }`}
            >
              {scopeRole}
            </span>
          ) : null}

          <ChevronDown
            className={`h-3.5 w-3.5 text-zinc-400 transition-transform ${
              isOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        {/* Sync Status Button or Connect Cloud Shortcut */}
        {!isOffline ? (
          <button
            onClick={handleManualSync}
            disabled={syncStatus === 'syncing'}
            className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
              syncStatus === 'syncing'
                ? 'border-sky-500/30 bg-sky-500/10 text-sky-400'
                : syncStatus === 'error'
                ? 'border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20'
                : 'border-zinc-800 bg-zinc-900/80 text-zinc-300 hover:border-sky-500/30 hover:bg-zinc-850 hover:text-white'
            }`}
            title={
              syncError
                ? `Sync Error: ${syncError}. Click to retry.`
                : syncStatus === 'syncing'
                ? 'Synchronizing workspace with cloud...'
                : `Synced online (${lastSyncedAt ? formatTimeAgo(lastSyncedAt) : 'cached'}). Click to sync online now.`
            }
          >
            {syncStatus === 'syncing' ? (
              <>
                <RefreshCw className="h-3 w-3 animate-spin text-sky-400" />
                <span className="hidden sm:inline">Syncing</span>
              </>
            ) : syncStatus === 'error' ? (
              <>
                <AlertTriangle className="h-3 w-3 text-rose-400" />
                <span className="hidden sm:inline">Retry</span>
              </>
            ) : (
              <>
                <RefreshCw className="h-3 w-3 text-emerald-400" />
                <span className="hidden sm:inline text-emerald-400">Sync Online</span>
              </>
            )}
          </button>
        ) : (
          <div
            className="flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-400 select-none"
            title="Currently in Offline Workspace"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400"></span>
            <span className="hidden sm:inline">Offline</span>
          </div>
        )}
      </div>

      {/* Floating Scope Switcher Dropdown */}
      {isOpen && (
        <div className="absolute left-0 top-full mt-2 w-84 rounded-xl border border-zinc-800 bg-zinc-950 p-2 shadow-2xl shadow-black/90 z-50 animate-in fade-in zoom-in-95 duration-100">
          {/* Search Scope */}
          <div className="relative mb-2">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-500" />
            <input
              type="text"
              placeholder="Search workspaces & projects..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900/90 pl-8 pr-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
            />
          </div>

          <div className="max-h-72 overflow-y-auto space-y-3 pr-1">
            {/* Section 1: Offline Workspace */}
            {showOfflineOption && (
              <div>
                <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-400 flex items-center justify-between">
                  <span>Offline Workspace</span>
                  <span className="text-[9px] font-medium text-zinc-500 lowercase">local only</span>
                </div>
                <button
                  onClick={handleSelectOffline}
                  className={`w-full flex items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition ${
                    isOffline
                      ? 'bg-amber-500/10 text-amber-300 font-semibold border border-amber-500/30'
                      : 'text-zinc-300 hover:bg-zinc-900 hover:text-white border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2.5 truncate">
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400 shrink-0 border border-amber-500/20">
                      <Laptop className="h-4 w-4" />
                    </div>
                    <div className="truncate">
                      <div className="truncate font-semibold flex items-center gap-1.5">
                        <span>Offline Workspace</span>
                        <span className="rounded bg-amber-500/20 text-amber-300 px-1 py-0.2 text-[9px] font-bold uppercase">
                          Offline
                        </span>
                      </div>
                      <div className="text-[10px] text-zinc-500 font-normal truncate">
                        Local device only • Zero cloud sync
                      </div>
                    </div>
                  </div>
                  {isOffline && <Check className="h-4 w-4 text-amber-400 shrink-0" />}
                </button>
              </div>
            )}

            {/* Section 2: Online Workspaces (Cloud Sync) */}
            <div>
              <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-sky-400 flex items-center justify-between border-t border-zinc-850 pt-2">
                <span>Online Workspaces</span>
                {cloudConfig.token && (
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        loadScopes(true);
                      }}
                      disabled={isLoadingScopes}
                      title="Sync online workspaces & projects list (force refresh)"
                      className="p-0.5 rounded text-sky-400/80 hover:text-sky-300 hover:bg-sky-500/10 transition"
                    >
                      <RefreshCw className={`h-3 w-3 ${isLoadingScopes ? 'animate-spin' : ''}`} />
                    </button>
                    <span className="text-[9px] font-medium text-sky-400/80 uppercase">Cloud Sync</span>
                  </div>
                )}
              </div>

              {cloudConfig.token ? (
                isLoadingScopes ? (
                  <div className="flex items-center justify-center py-6 text-xs text-zinc-500 gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
                    <span>Loading online workspaces...</span>
                  </div>
                ) : (
                  <div className="space-y-3 mt-1">
                    {/* Personal Cloud Workspaces */}
                    {filteredWorkspaces.length > 0 && (
                      <div className="space-y-0.5">
                        <div className="px-2 py-0.5 text-[10px] font-semibold text-zinc-400">
                          Personal
                        </div>
                        {filteredWorkspaces.map((ws) => {
                          const isSelected =
                            !isOffline &&
                            activeScope?.type === 'workspace' &&
                            activeScope.id === ws.id;
                          return (
                            <button
                              key={ws.id}
                              onClick={() =>
                                handleSelectScope({
                                  type: 'workspace',
                                  id: ws.id,
                                  name: ws.name,
                                  role: 'owner',
                                })
                              }
                              className={`w-full flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition ${
                                isSelected
                                  ? 'bg-sky-500/10 text-sky-300 font-semibold border border-sky-500/20'
                                  : 'text-zinc-300 hover:bg-zinc-900 hover:text-white border border-transparent'
                              }`}
                            >
                              <div className="flex items-center gap-2 truncate">
                                <User className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                                <span className="truncate">{ws.name}</span>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <span className="rounded bg-sky-500/10 text-sky-400 border border-sky-500/20 px-1 py-0.2 text-[9px] uppercase font-bold">
                                  Online
                                </span>
                                {isSelected && <Check className="h-3.5 w-3.5 text-sky-400 shrink-0" />}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* Team Projects */}
                    {filteredTeams.length > 0 && (
                      <div className="space-y-2">
                        <div className="px-2 py-0.5 text-[10px] font-semibold text-zinc-400">
                          Team Projects
                        </div>
                        {filteredTeams.map(({ team, projects }) => (
                          <div key={team.id} className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-1.5">
                            <div className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] font-semibold text-zinc-300">
                              <Users className="h-3 w-3 text-indigo-400 shrink-0" />
                              <span className="truncate">{team.name}</span>
                            </div>

                            <div className="mt-1 space-y-0.5">
                              {projects.map((proj) => {
                                const isSelected =
                                  !isOffline &&
                                  activeScope?.type === 'project' &&
                                  activeScope.id === proj.id;
                                return (
                                  <button
                                    key={proj.id}
                                    onClick={() =>
                                      handleSelectScope({
                                        type: 'project',
                                        id: proj.id,
                                        name: proj.name,
                                        teamId: team.id,
                                        teamName: team.name,
                                        role: (jwtRole === 'superadmin' || jwtRole === 'admin')
                                          ? 'admin'
                                          : (proj.user_role || 'contributor'),
                                      })
                                    }
                                    className={`w-full flex items-center justify-between rounded px-2 py-1 text-left text-xs transition ${
                                      isSelected
                                        ? 'bg-indigo-500/20 text-indigo-300 font-semibold border border-indigo-500/30'
                                        : 'text-zinc-300 hover:bg-zinc-800 hover:text-white border border-transparent'
                                    }`}
                                  >
                                    <div className="flex items-center gap-2 truncate">
                                      <FolderGit2 className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                                      <span className="truncate">{proj.name}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                      <span className="rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-1 py-0.2 text-[9px] uppercase font-bold">
                                        Online
                                      </span>
                                      {proj.user_role && (
                                        <span className="rounded bg-zinc-800 px-1 py-0.2 text-[9px] text-zinc-400 uppercase font-medium">
                                          {proj.user_role}
                                        </span>
                                      )}
                                      {isSelected && <Check className="h-3.5 w-3.5 text-indigo-400" />}
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {filteredWorkspaces.length === 0 && filteredTeams.length === 0 && (
                      <div className="py-3 text-center text-xs text-zinc-500">
                        No online workspaces or team projects found.
                      </div>
                    )}
                  </div>
                )
              ) : (
                <div className="mt-2 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 p-3 text-center">
                  <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400 mb-2 border border-sky-500/20">
                    <Cloud className="h-4 w-4" />
                  </div>
                  <div className="text-xs font-semibold text-zinc-200">
                    Online Cloud Workspaces
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-400 leading-relaxed">
                    Connect your account to access synced workspaces &amp; team projects.
                  </p>
                  <button
                    onClick={() => {
                      setIsOpen(false);
                      onOpenCloudAuth();
                    }}
                    className="mt-2.5 w-full rounded-lg bg-gradient-to-r from-sky-500 to-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:from-sky-400 hover:to-blue-500 transition"
                  >
                    Connect Cloud Account
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Footer Controls */}
          {cloudConfig.token && (
            <div className="mt-2 border-t border-zinc-800 pt-2 space-y-1">
              <button
                onClick={async () => {
                  setIsOpen(false);
                  await Promise.all([loadScopes(true), pullCloudDelta()]);
                }}
                disabled={syncStatus === 'syncing'}
                className="w-full flex items-center justify-between rounded-lg bg-sky-500/10 border border-sky-500/20 px-2.5 py-2 text-xs font-medium text-sky-300 hover:bg-sky-500/20 hover:text-white transition group"
                title="Bypass 1-hour cache and synchronize active workspace with cloud"
              >
                <div className="flex items-center gap-2">
                  <RefreshCw
                    className={`h-3.5 w-3.5 text-sky-400 group-hover:rotate-180 transition-transform duration-500 ${
                      syncStatus === 'syncing' ? 'animate-spin' : ''
                    }`}
                  />
                  <span>Sync Workspace Online</span>
                </div>
                <span className="text-[10px] text-sky-400/70 font-mono">
                  {lastSyncedAt ? formatTimeAgo(lastSyncedAt) : '1h cache'}
                </span>
              </button>

              <button
                onClick={() => {
                  setIsOpen(false);
                  logoutCloud();
                }}
                className="w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-rose-400 hover:bg-rose-500/10 transition"
              >
                <LogOut className="h-3.5 w-3.5 text-rose-400" />
                <span>Sign Out &amp; Disconnect</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
