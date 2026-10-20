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
  Plus,
  Pencil,
  Copy,
  Trash2,
  X,
} from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import { ActiveScope, OfflineWorkspace } from '@/types/api';
import { getRoleFromJwt } from '@/lib/jwt';
import { isOfflineOnly } from '@/lib/edition';
import { ConfirmModal } from './ConfirmModal';

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

  // Offline Workspace Management State
  const [isCreatingWs, setIsCreatingWs] = useState(false);
  const [newWsName, setNewWsName] = useState('');
  const [editingWsId, setEditingWsId] = useState<string | null>(null);
  const [editingWsName, setEditingWsName] = useState('');
  const [deletingWs, setDeletingWs] = useState<OfflineWorkspace | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);

  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);
  const activeScope = cloudConfig.activeScope;
  const syncStatus = useApiStore((state) => state.syncStatus);
  const syncError = useApiStore((state) => state.syncError);
  const lastSyncedAt = useApiStore((state) => state.lastSyncedAt);
  const scopesCache = useApiStore((state) => state.scopesCache);

  const offlineWorkspaces = useApiStore((state) => state.offlineWorkspaces) || [];
  const activeOfflineWorkspaceId = useApiStore((state) => state.activeOfflineWorkspaceId);
  const switchOfflineWorkspace = useApiStore((state) => state.switchOfflineWorkspace);
  const createOfflineWorkspace = useApiStore((state) => state.createOfflineWorkspace);
  const renameOfflineWorkspace = useApiStore((state) => state.renameOfflineWorkspace);
  const deleteOfflineWorkspace = useApiStore((state) => state.deleteOfflineWorkspace);
  const duplicateOfflineWorkspace = useApiStore((state) => state.duplicateOfflineWorkspace);

  const setActiveScope = useApiStore((state) => state.setActiveScope);
  const pullCloudDelta = useApiStore((state) => state.pullCloudDelta);
  const fetchScopes = useApiStore((state) => state.fetchScopes);
  const logoutCloud = useApiStore((state) => state.logoutCloud);

  const workspaces = scopesCache?.workspaces || [];
  const teamsWithProjects = scopesCache?.teamsWithProjects || [];

  const isOffline = workspaceMode === 'offline';
  const activeOfflineWs = offlineWorkspaces.find((w) => w.id === activeOfflineWorkspaceId);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setIsCreatingWs(false);
        setEditingWsId(null);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Load accessible workspaces and teams (uses 1-hour cache unless forced)
  const loadScopes = async (force = false) => {
    if (isOfflineOnly || !cloudConfig.token) return;
    setIsLoadingScopes(true);
    try {
      await fetchScopes(force);
    } finally {
      setIsLoadingScopes(false);
    }
  };

  useEffect(() => {
    if (!isOfflineOnly && cloudConfig.token) {
      loadScopes(false);
    }
  }, [cloudConfig.token]);

  const handleSelectScope = async (scope: ActiveScope) => {
    setIsOpen(false);
    setIsCreatingWs(false);
    setEditingWsId(null);
    await setActiveScope(scope);
  };

  const handleSelectOfflineWorkspace = (id: string) => {
    switchOfflineWorkspace(id);
    setIsOpen(false);
    setIsCreatingWs(false);
    setEditingWsId(null);
  };

  const handleCreateWorkspace = () => {
    const trimmed = newWsName.trim();
    if (!trimmed) return;
    createOfflineWorkspace(trimmed);
    setNewWsName('');
    setIsCreatingWs(false);
    setIsOpen(false);
  };

  const handleRenameWorkspace = (id: string) => {
    const trimmed = editingWsName.trim();
    if (!trimmed) return;
    renameOfflineWorkspace(id, trimmed);
    setEditingWsId(null);
    setEditingWsName('');
  };

  const handleDeleteWorkspace = () => {
    if (!deletingWs) return;
    deleteOfflineWorkspace(deletingWs.id);
    setDeletingWs(null);
  };

  const handleDuplicateWorkspace = (ws: OfflineWorkspace, e: React.MouseEvent) => {
    e.stopPropagation();
    duplicateOfflineWorkspace(ws.id);
    setIsOpen(false);
  };

  const handleManualSync = async () => {
    await pullCloudDelta();
  };

  const jwtRole = getRoleFromJwt(cloudConfig.token);
  const scopeRole = (jwtRole === 'superadmin' || jwtRole === 'admin') ? 'admin' : activeScope?.role;

  const scopeLabel = isOffline
    ? (activeOfflineWs ? activeOfflineWs.name : 'Offline Workspace')
    : activeScope
    ? activeScope.type === 'project'
      ? `${activeScope.teamName || 'Team'} / ${activeScope.name}`
      : activeScope.name
    : 'Select Workspace';

  const searchLower = search.toLowerCase();

  // Filter offline workspaces
  const filteredOfflineWorkspaces = offlineWorkspaces.filter(
    (w) =>
      !search ||
      w.name.toLowerCase().includes(searchLower) ||
      'offline workspace'.includes(searchLower) ||
      'local'.includes(searchLower)
  );

  // Filter cloud scopes based on search query
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
    <>
      <div className="relative z-30" ref={dropdownRef}>
        {/* Switcher Header Button */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              const next = !isOpen;
              setIsOpen(next);
              if (next && !isOfflineOnly && cloudConfig.token) loadScopes(false);
            }}
            className="group flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/90 px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-700 hover:bg-zinc-800 hover:text-white transition shadow-sm max-w-[280px]"
            title="Switch Workspace"
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

          {/* Sync Status Button (Cloud edition only) */}
          {!isOfflineOnly && !isOffline ? (
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
          ) : !isOfflineOnly ? (
            <div
              className="flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-400 select-none"
              title="Currently in Offline Workspace"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400"></span>
              <span className="hidden sm:inline">Offline</span>
            </div>
          ) : null}
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

            <div className="max-h-80 overflow-y-auto space-y-3 pr-1">
              {/* Section 1: Offline Workspaces */}
              <div>
                <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-400 flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Laptop className="h-3 w-3 text-amber-400" />
                    <span>Offline Workspaces</span>
                    <span className="rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1 py-0.2 text-[9px] font-medium lowercase">
                      {offlineWorkspaces.length}
                    </span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsCreatingWs(true);
                      setEditingWsId(null);
                    }}
                    className="flex items-center gap-1 text-[10px] font-medium text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 px-1.5 py-0.5 rounded transition"
                    title="Create new offline workspace"
                  >
                    <Plus className="h-3 w-3" />
                    <span>New</span>
                  </button>
                </div>

                {/* Inline Create Input */}
                {isCreatingWs && (
                  <div className="p-2 my-1 rounded-lg border border-amber-500/30 bg-amber-950/20 animate-in fade-in duration-100">
                    <div className="text-[10px] text-amber-400/90 font-medium mb-1">
                      New Offline Workspace Name
                    </div>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        autoFocus
                        placeholder="e.g. Project Alpha, Personal APIs..."
                        value={newWsName}
                        onChange={(e) => setNewWsName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleCreateWorkspace();
                          if (e.key === 'Escape') {
                            setIsCreatingWs(false);
                            setNewWsName('');
                          }
                        }}
                        className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-400 focus:outline-none"
                      />
                      <button
                        onClick={handleCreateWorkspace}
                        disabled={!newWsName.trim()}
                        className="rounded-md bg-amber-500 px-2.5 py-1 text-xs font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-40 transition"
                      >
                        Add
                      </button>
                      <button
                        onClick={() => {
                          setIsCreatingWs(false);
                          setNewWsName('');
                        }}
                        className="rounded-md p-1 text-zinc-400 hover:text-white transition"
                        title="Cancel"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}

                {/* Offline Workspaces List */}
                <div className="space-y-0.5 mt-1">
                  {filteredOfflineWorkspaces.map((ws) => {
                    const isSelected = isOffline && activeOfflineWorkspaceId === ws.id;
                    const isEditing = editingWsId === ws.id;

                    if (isEditing) {
                      return (
                        <div
                          key={ws.id}
                          className="flex items-center gap-1.5 p-1 rounded-lg bg-zinc-900 border border-amber-500/30 my-0.5"
                        >
                          <input
                            type="text"
                            autoFocus
                            value={editingWsName}
                            onChange={(e) => setEditingWsName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleRenameWorkspace(ws.id);
                              if (e.key === 'Escape') setEditingWsId(null);
                            }}
                            className="flex-1 rounded px-1.5 py-0.5 text-xs bg-zinc-800 text-zinc-100 focus:outline-none focus:ring-1 focus:ring-amber-400"
                          />
                          <button
                            onClick={() => handleRenameWorkspace(ws.id)}
                            className="p-1 text-emerald-400 hover:text-emerald-300 transition"
                            title="Save name"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => setEditingWsId(null)}
                            className="p-1 text-zinc-400 hover:text-zinc-200 transition"
                            title="Cancel"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={ws.id}
                        onClick={() => handleSelectOfflineWorkspace(ws.id)}
                        className={`group w-full flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition cursor-pointer ${
                          isSelected
                            ? 'bg-amber-500/10 text-amber-300 font-semibold border border-amber-500/30'
                            : 'text-zinc-300 hover:bg-zinc-900 hover:text-white border border-transparent'
                        }`}
                      >
                        <div className="flex items-center gap-2 truncate min-w-0 mr-2">
                          <Laptop className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                          <span className="truncate">{ws.name}</span>
                          {isSelected && (
                            <span className="rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 px-1 py-0.2 text-[9px] font-bold uppercase shrink-0">
                              Active
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          {/* Hover Action Buttons */}
                          <div className="hidden group-hover:flex items-center gap-0.5">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingWsId(ws.id);
                                setEditingWsName(ws.name);
                              }}
                              className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
                              title="Rename workspace"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                            <button
                              onClick={(e) => handleDuplicateWorkspace(ws, e)}
                              className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
                              title="Duplicate workspace"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                            {offlineWorkspaces.length > 1 && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeletingWs(ws);
                                }}
                                className="p-1 rounded text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 transition"
                                title="Delete workspace"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            )}
                          </div>

                          {isSelected && (
                            <Check className="h-3.5 w-3.5 text-amber-400 shrink-0 group-hover:hidden" />
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {filteredOfflineWorkspaces.length === 0 && (
                    <div className="py-2 text-center text-xs text-zinc-500">
                      No matching offline workspace found.
                    </div>
                  )}
                </div>
              </div>

              {/* Section 2: Online Workspaces (Cloud Sync) - Omitted in offline-only edition */}
              {!isOfflineOnly && (
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
                                            role: proj.user_role || 'reader',
                                          })
                                        }
                                        className={`w-full flex items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition ${
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
              )}
            </div>

            {/* Footer Controls */}
            {!isOfflineOnly && cloudConfig.token && (
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

      {/* Confirmation Modal for Workspace Deletion */}
      <ConfirmModal
        isOpen={Boolean(deletingWs)}
        onClose={() => setDeletingWs(null)}
        onConfirm={handleDeleteWorkspace}
        title="Delete Offline Workspace"
        message={
          <span>
            Are you sure you want to delete <strong className="text-zinc-100">{deletingWs?.name}</strong>?
            All collections, environments, tabs, and history within this workspace will be permanently removed.
          </span>
        }
        confirmText="Delete Workspace"
        variant="danger"
      />
    </>
  );
};
