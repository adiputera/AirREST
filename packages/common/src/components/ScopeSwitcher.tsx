'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronDown,
  ChevronRight,
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
import { useApiStore } from '../store/useApiStore';
import { ActiveScope, OfflineWorkspace, CloudWorkspace, CloudProject } from '../types/api';
import { getRoleFromJwt } from '../lib/jwt';
import { isOfflineOnly } from '../lib/edition';
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

  // Online / Cloud Workspace Management State
  const [isCreatingCloudWs, setIsCreatingCloudWs] = useState(false);
  const [newCloudWsName, setNewCloudWsName] = useState('');
  const [editingCloudWsId, setEditingCloudWsId] = useState<string | null>(null);
  const [editingCloudWsName, setEditingCloudWsName] = useState('');
  const [deletingCloudWs, setDeletingCloudWs] = useState<CloudWorkspace | null>(null);
  const [isSubmittingCloudWs, setIsSubmittingCloudWs] = useState(false);
  const [cloudWsError, setCloudWsError] = useState<string | null>(null);

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

  const createCloudWorkspace = useApiStore((state) => state.createCloudWorkspace);
  const renameCloudWorkspace = useApiStore((state) => state.renameCloudWorkspace);
  const deleteCloudWorkspace = useApiStore((state) => state.deleteCloudWorkspace);

  const setActiveScope = useApiStore((state) => state.setActiveScope);
  const pullCloudDelta = useApiStore((state) => state.pullCloudDelta);
  const fetchScopes = useApiStore((state) => state.fetchScopes);
  const fetchProjectsForTeam = useApiStore((state) => state.fetchProjectsForTeam);
  const logoutCloud = useApiStore((state) => state.logoutCloud);

  const [expandedTeams, setExpandedTeams] = useState<Record<string, boolean>>({});
  const [loadingTeams, setLoadingTeams] = useState<Record<string, boolean>>({});
  const fetchedTeamsRef = React.useRef<Set<string>>(new Set());

  const workspaces = scopesCache?.workspaces || [];
  const teams = scopesCache?.teams || scopesCache?.teamsWithProjects?.map((tp) => tp.team) || [];
  const teamProjects: Record<string, CloudProject[] | undefined> = React.useMemo(() => {
    if (scopesCache?.teamProjects) {
      return scopesCache.teamProjects;
    }
    const map: Record<string, CloudProject[]> = {};
    if (scopesCache?.teamsWithProjects) {
      for (const tp of scopesCache.teamsWithProjects) {
        if (tp.team?.id && tp.projects && tp.projects.length > 0) {
          map[tp.team.id] = tp.projects;
        }
      }
    }
    return map;
  }, [scopesCache?.teamProjects, scopesCache?.teamsWithProjects]);

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

  // Load accessible workspaces and teams (uses 12-hour cache unless forced)
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

  // Auto-expand the currently active team project accordion and ensure projects are loaded
  useEffect(() => {
    if (activeScope?.type === 'project' && activeScope.teamId) {
      const activeTeamId = activeScope.teamId;
      setExpandedTeams((prev) => ({
        ...prev,
        [activeTeamId]: true,
      }));

      const isLoaded =
        fetchedTeamsRef.current.has(activeTeamId) ||
        Boolean(
          scopesCache?.teamProjects &&
            Object.prototype.hasOwnProperty.call(scopesCache.teamProjects, activeTeamId) &&
            (scopesCache.teamProjects[activeTeamId]?.length ?? 0) > 0
        );

      if (!isLoaded && !isOfflineOnly && cloudConfig.token) {
        setLoadingTeams((prev) => ({ ...prev, [activeTeamId]: true }));
        fetchProjectsForTeam(activeTeamId, true)
          .then(() => {
            fetchedTeamsRef.current.add(activeTeamId);
          })
          .finally(() => {
            setLoadingTeams((prev) => ({ ...prev, [activeTeamId]: false }));
          });
      }
    }
  }, [activeScope?.teamId, activeScope?.id]);

  const handleSelectScope = async (scope: ActiveScope) => {
    setIsOpen(false);
    setIsCreatingWs(false);
    setEditingWsId(null);
    setIsCreatingCloudWs(false);
    setEditingCloudWsId(null);
    setCloudWsError(null);
    await setActiveScope(scope);
  };

  const handleSelectOfflineWorkspace = (id: string) => {
    switchOfflineWorkspace(id);
    setIsOpen(false);
    setIsCreatingWs(false);
    setEditingWsId(null);
    setIsCreatingCloudWs(false);
    setEditingCloudWsId(null);
    setCloudWsError(null);
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

  const handleCreateCloudWorkspace = async () => {
    const trimmed = newCloudWsName.trim();
    if (!trimmed) return;
    setIsSubmittingCloudWs(true);
    setCloudWsError(null);
    const res = await createCloudWorkspace(trimmed);
    setIsSubmittingCloudWs(false);
    if (res.success) {
      setNewCloudWsName('');
      setIsCreatingCloudWs(false);
      setIsOpen(false);
    } else {
      setCloudWsError(res.error || 'Failed to create cloud workspace');
    }
  };

  const handleRenameCloudWorkspace = async (id: string) => {
    const trimmed = editingCloudWsName.trim();
    if (!trimmed) return;
    setIsSubmittingCloudWs(true);
    setCloudWsError(null);
    const res = await renameCloudWorkspace(id, trimmed);
    setIsSubmittingCloudWs(false);
    if (res.success) {
      setEditingCloudWsId(null);
      setEditingCloudWsName('');
    } else {
      setCloudWsError(res.error || 'Failed to rename cloud workspace');
    }
  };

  const handleDeleteCloudWorkspace = async () => {
    if (!deletingCloudWs) return;
    setIsSubmittingCloudWs(true);
    const res = await deleteCloudWorkspace(deletingCloudWs.id);
    setIsSubmittingCloudWs(false);
    if (res.success) {
      setDeletingCloudWs(null);
    } else {
      alert(res.error || 'Failed to delete workspace');
    }
  };

  const handleDuplicateWorkspace = (ws: OfflineWorkspace, e: React.MouseEvent) => {
    e.stopPropagation();
    duplicateOfflineWorkspace(ws.id);
    setIsOpen(false);
  };

  const handleManualSync = async () => {
    await pullCloudDelta();
  };

  const effectiveUserRole = (cloudConfig.user?.role || getRoleFromJwt(cloudConfig.token) || '').toLowerCase();
  const scopeRole = (effectiveUserRole === 'superadmin' || effectiveUserRole === 'admin') ? 'admin' : activeScope?.role;

  const scopeLabel = isOffline
    ? (activeOfflineWs ? activeOfflineWs.name : 'Offline Workspace')
    : activeScope
    ? activeScope.type === 'project'
      ? `${activeScope.teamName || 'Team'} / ${activeScope.name}`
      : activeScope.name
    : 'Select Workspace';

  const searchLower = search.toLowerCase();

  // Filter offline workspaces
  const filteredOfflineWorkspaces = (offlineWorkspaces || []).filter(
    (w) =>
      !search ||
      String(w?.name || '').toLowerCase().includes(searchLower) ||
      'offline workspace'.includes(searchLower) ||
      'local'.includes(searchLower)
  );

  // Filter cloud scopes based on search query
  const filteredWorkspaces = (workspaces || []).filter((w) =>
    String(w?.name || '').toLowerCase().includes(searchLower)
  );

  const isTeamExpanded = (teamId: string) => {
    if (searchLower) {
      const projs = teamProjects[teamId] || [];
      if (projs.some((p) => String(p?.name || '').toLowerCase().includes(searchLower))) {
        return true;
      }
    }
    return !!expandedTeams[teamId];
  };

  const filteredTeams = (teams || []).filter((team) => {
    if (!searchLower) return true;
    if (String(team?.name || '').toLowerCase().includes(searchLower)) return true;
    const projs = teamProjects[team.id] || [];
    return projs.some((p) => String(p?.name || '').toLowerCase().includes(searchLower));
  });

  const handleToggleTeam = async (teamId: string) => {
    const isCurrentlyOpen = isTeamExpanded(teamId);
    const next = !isCurrentlyOpen;
    setExpandedTeams((prev) => ({ ...prev, [teamId]: next }));

    const isLoaded =
      fetchedTeamsRef.current.has(teamId) ||
      Boolean(
        scopesCache?.teamProjects &&
          Object.prototype.hasOwnProperty.call(scopesCache.teamProjects, teamId) &&
          (scopesCache.teamProjects[teamId]?.length ?? 0) > 0
      );

    if (next && !isLoaded) {
      setLoadingTeams((prev) => ({ ...prev, [teamId]: true }));
      try {
        await fetchProjectsForTeam(teamId, true);
        fetchedTeamsRef.current.add(teamId);
      } finally {
        setLoadingTeams((prev) => ({ ...prev, [teamId]: false }));
      }
    }
  };

  const handleRefreshTeamProjects = async (teamId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setLoadingTeams((prev) => ({ ...prev, [teamId]: true }));
    try {
      await fetchProjectsForTeam(teamId, true);
      fetchedTeamsRef.current.add(teamId);
    } finally {
      setLoadingTeams((prev) => ({ ...prev, [teamId]: false }));
    }
  };

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
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          loadScopes(true);
                        }}
                        disabled={isLoadingScopes}
                        title="Refresh teams and personal workspaces list"
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-sky-400/80 hover:text-sky-300 hover:bg-sky-500/10 transition"
                      >
                        <RefreshCw className={`h-3 w-3 ${isLoadingScopes ? 'animate-spin' : ''}`} />
                        <span className="text-[9px] font-semibold uppercase tracking-wider">Refresh Teams</span>
                      </button>
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
                        <div>
                          <div className="px-2 py-0.5 text-[10px] font-semibold text-zinc-400 flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              <span>Personal</span>
                              <span className="rounded bg-sky-500/10 text-sky-400 border border-sky-500/20 px-1 py-0.2 text-[9px] font-medium lowercase">
                                {workspaces.length}
                              </span>
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setIsCreatingCloudWs(true);
                                setEditingCloudWsId(null);
                                setCloudWsError(null);
                              }}
                              className="flex items-center gap-1 text-[10px] font-medium text-sky-400 hover:text-sky-300 hover:bg-sky-500/10 px-1.5 py-0.5 rounded transition"
                              title="Create new online workspace"
                            >
                              <Plus className="h-3 w-3" />
                              <span>New</span>
                            </button>
                          </div>

                          {/* Inline Create Input for Cloud Workspace */}
                          {isCreatingCloudWs && (
                            <div className="p-2 my-1 rounded-lg border border-sky-500/30 bg-sky-950/20 animate-in fade-in duration-100">
                              <div className="text-[10px] text-sky-400/90 font-medium mb-1">
                                New Online Workspace Name
                              </div>
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="text"
                                  autoFocus
                                  placeholder="e.g. Project Beta, Personal Sandbox..."
                                  value={newCloudWsName}
                                  onChange={(e) => setNewCloudWsName(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleCreateCloudWorkspace();
                                    if (e.key === 'Escape') {
                                      setIsCreatingCloudWs(false);
                                      setNewCloudWsName('');
                                      setCloudWsError(null);
                                    }
                                  }}
                                  className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder-zinc-500 focus:border-sky-400 focus:outline-none"
                                />
                                <button
                                  onClick={handleCreateCloudWorkspace}
                                  disabled={!newCloudWsName.trim() || isSubmittingCloudWs}
                                  className="flex items-center gap-1 rounded-md bg-sky-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-sky-400 disabled:opacity-40 transition"
                                >
                                  {isSubmittingCloudWs ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Add'}
                                </button>
                                <button
                                  onClick={() => {
                                    setIsCreatingCloudWs(false);
                                    setNewCloudWsName('');
                                    setCloudWsError(null);
                                  }}
                                  className="rounded-md p-1 text-zinc-400 hover:text-white transition"
                                  title="Cancel"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                              {cloudWsError && (
                                <div className="text-[10px] text-rose-400 mt-1">{cloudWsError}</div>
                              )}
                            </div>
                          )}

                          {/* Workspaces List */}
                          <div className="space-y-0.5 mt-1">
                            {filteredWorkspaces.map((ws) => {
                              const isSelected =
                                !isOffline &&
                                activeScope?.type === 'workspace' &&
                                activeScope.id === ws.id;
                              const isEditing = editingCloudWsId === ws.id;

                              if (isEditing) {
                                return (
                                  <div
                                    key={ws.id}
                                    className="flex items-center gap-1.5 p-1 rounded-lg bg-zinc-900 border border-sky-500/30 my-0.5"
                                  >
                                    <input
                                      type="text"
                                      autoFocus
                                      value={editingCloudWsName}
                                      onChange={(e) => setEditingCloudWsName(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleRenameCloudWorkspace(ws.id);
                                        if (e.key === 'Escape') setEditingCloudWsId(null);
                                      }}
                                      className="flex-1 rounded px-1.5 py-0.5 text-xs bg-zinc-800 text-zinc-100 focus:outline-none focus:ring-1 focus:ring-sky-400"
                                    />
                                    <button
                                      onClick={() => handleRenameCloudWorkspace(ws.id)}
                                      disabled={isSubmittingCloudWs}
                                      className="p-1 text-emerald-400 hover:text-emerald-300 transition"
                                      title="Save name"
                                    >
                                      {isSubmittingCloudWs ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                    </button>
                                    <button
                                      onClick={() => setEditingCloudWsId(null)}
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
                                  onClick={() =>
                                    handleSelectScope({
                                      type: 'workspace',
                                      id: ws.id,
                                      name: ws.name,
                                      role: 'owner',
                                    })
                                  }
                                  className={`group w-full flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition cursor-pointer ${
                                    isSelected
                                      ? 'bg-sky-500/10 text-sky-300 font-semibold border border-sky-500/20'
                                      : 'text-zinc-300 hover:bg-zinc-900 hover:text-white border border-transparent'
                                  }`}
                                >
                                  <div className="flex items-center gap-2 truncate min-w-0 mr-2">
                                    <User className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                                    <span className="truncate">{ws.name}</span>
                                    {ws.is_default && (
                                      <span className="rounded bg-sky-500/10 text-sky-400/80 border border-sky-500/20 px-1 py-0.2 text-[8px] font-semibold shrink-0">
                                        Default
                                      </span>
                                    )}
                                  </div>

                                  <div className="flex items-center gap-1 shrink-0">
                                    {/* Hover Action Buttons */}
                                    <div className="hidden group-hover:flex items-center gap-0.5">
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setEditingCloudWsId(ws.id);
                                          setEditingCloudWsName(ws.name);
                                          setCloudWsError(null);
                                        }}
                                        className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
                                        title="Rename workspace"
                                      >
                                        <Pencil className="h-3 w-3" />
                                      </button>
                                      {!ws.is_default && (
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setDeletingCloudWs(ws);
                                          }}
                                          className="p-1 rounded text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 transition"
                                          title="Delete workspace"
                                        >
                                          <Trash2 className="h-3 w-3" />
                                        </button>
                                      )}
                                    </div>

                                    <span className="rounded bg-sky-500/10 text-sky-400 border border-sky-500/20 px-1 py-0.2 text-[9px] uppercase font-bold group-hover:hidden">
                                      Online
                                    </span>
                                    {isSelected && <Check className="h-3.5 w-3.5 text-sky-400 shrink-0 group-hover:hidden" />}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* Team Projects 2-Level Accordion */}
                        {filteredTeams.length > 0 && (
                          <div className="space-y-1.5">
                            <div className="px-2 py-0.5 text-[10px] font-semibold text-zinc-400 flex items-center justify-between">
                              <span>Team Projects</span>
                              <span className="text-[9px] text-zinc-500 font-normal">
                                Click team to expand
                              </span>
                            </div>
                            {filteredTeams.map((team) => {
                              const isExpanded = isTeamExpanded(team.id);
                              const projs = teamProjects[team.id];
                              const isLoadingThisTeam = loadingTeams[team.id];
                              const isTeamActive =
                                !isOffline &&
                                activeScope?.type === 'project' &&
                                activeScope.teamId === team.id;

                              return (
                                <div
                                  key={team.id}
                                  className="rounded-lg border border-zinc-800/70 bg-zinc-900/30 overflow-hidden transition"
                                >
                                  {/* Team Accordion Header */}
                                  <div
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => handleToggleTeam(team.id)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        handleToggleTeam(team.id);
                                      }
                                    }}
                                    className="w-full flex items-center justify-between px-2.5 py-1.5 text-left text-xs font-semibold text-zinc-200 hover:bg-zinc-850 hover:text-white transition group select-none cursor-pointer"
                                  >
                                    <div className="flex items-center gap-2 min-w-0 flex-1 mr-1">
                                      <ChevronRight
                                        className={`h-3.5 w-3.5 text-zinc-400 transition-transform duration-150 shrink-0 ${
                                          isExpanded ? 'rotate-90 text-indigo-400' : 'group-hover:text-zinc-200'
                                        }`}
                                      />
                                      <Users className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                                      <span className="truncate">{team.name}</span>
                                    </div>

                                    <div className="flex items-center gap-1.5 shrink-0">
                                      {isTeamActive && (
                                        <span
                                          className="h-1.5 w-1.5 rounded-full bg-indigo-400 shrink-0"
                                          title="Active team scope"
                                        />
                                      )}
                                      {isLoadingThisTeam ? (
                                        <Loader2 className="h-3 w-3 animate-spin text-indigo-400" />
                                      ) : projs !== undefined && (projs.length > 0 || fetchedTeamsRef.current.has(team.id)) ? (
                                        <div className="flex items-center gap-1">
                                          <button
                                            type="button"
                                            onClick={(e) => handleRefreshTeamProjects(team.id, e)}
                                            className="p-1 rounded text-zinc-500 hover:text-indigo-400 hover:bg-zinc-800 transition"
                                            title={`Refresh ${team.name} projects`}
                                          >
                                            <RefreshCw className="h-2.5 w-2.5" />
                                          </button>
                                          <span className="rounded-full bg-zinc-800/80 px-1.5 py-0.2 text-[9px] font-mono text-zinc-400">
                                            {projs.length}
                                          </span>
                                        </div>
                                      ) : (
                                        <span className="rounded bg-zinc-800/60 px-1.5 py-0.5 text-[9px] text-zinc-400 font-medium">
                                          Load
                                        </span>
                                      )}
                                    </div>
                                  </div>

                                  {/* Accordion Content: Projects */}
                                  {isExpanded && (
                                    <div className="border-t border-zinc-800/60 bg-zinc-950/40 p-1 space-y-0.5 animate-in fade-in duration-100">
                                      {isLoadingThisTeam && (!projs || projs.length === 0) ? (
                                        <div className="flex items-center justify-center py-2.5 text-xs text-zinc-500 gap-1.5">
                                          <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400" />
                                          <span>Loading projects...</span>
                                        </div>
                                      ) : !projs && !fetchedTeamsRef.current.has(team.id) ? (
                                        <div className="py-2 text-center text-[11px] text-zinc-500 italic">
                                          <button
                                            type="button"
                                            onClick={() => handleToggleTeam(team.id)}
                                            className="text-indigo-400 hover:underline"
                                          >
                                            Click to load projects
                                          </button>
                                        </div>
                                      ) : projs && projs.length === 0 ? (
                                        <div className="py-2 text-center text-[11px] text-zinc-500 italic">
                                          No projects in this team.
                                        </div>
                                      ) : projs ? (
                                        projs
                                          .filter(
                                            (proj) =>
                                              !searchLower ||
                                              String(team?.name || '').toLowerCase().includes(searchLower) ||
                                              String(proj?.name || '').toLowerCase().includes(searchLower)
                                          )
                                          .map((proj) => {
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
                                                    permissions: proj.permissions,
                                                  })
                                                }
                                                className={`w-full flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition ${
                                                  isSelected
                                                    ? 'bg-indigo-500/20 text-indigo-300 font-semibold border border-indigo-500/30'
                                                    : 'text-zinc-300 hover:bg-zinc-850 hover:text-white border border-transparent'
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
                                                  {isSelected && (
                                                    <Check className="h-3.5 w-3.5 text-indigo-400" />
                                                  )}
                                                </div>
                                              </button>
                                            );
                                          })
                                      ) : null}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
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
              <div className="mt-2 border-t border-zinc-800 pt-1.5">
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

      {/* Confirmation Modal for Offline Workspace Deletion */}
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

      {/* Confirmation Modal for Cloud Workspace Deletion */}
      <ConfirmModal
        isOpen={Boolean(deletingCloudWs)}
        onClose={() => setDeletingCloudWs(null)}
        onConfirm={handleDeleteCloudWorkspace}
        title="Delete Cloud Workspace"
        message={
          <span>
            Are you sure you want to delete <strong className="text-zinc-100">{deletingCloudWs?.name}</strong>?
            All collections and environments inside this cloud workspace will be permanently removed.
          </span>
        }
        confirmText="Delete Workspace"
        variant="danger"
        isLoading={isSubmittingCloudWs}
      />
    </>
  );
};
