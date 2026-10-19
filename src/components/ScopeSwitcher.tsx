'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronDown,
  User,
  Users,
  FolderGit2,
  RefreshCw,
  ExternalLink,
  Laptop,
  LogOut,
  Search,
  Check,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import {
  fetchUserWorkspaces,
  fetchUserTeams,
  fetchTeamProjects,
} from '@/lib/cloudApi';
import { ActiveScope, CloudWorkspace, CloudTeam, CloudProject } from '@/types/api';
import { getRoleFromJwt } from '@/lib/jwt';

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

  const [workspaces, setWorkspaces] = useState<CloudWorkspace[]>([]);
  const [teamsWithProjects, setTeamsWithProjects] = useState<
    { team: CloudTeam; projects: CloudProject[] }[]
  >([]);

  const dropdownRef = useRef<HTMLDivElement>(null);

  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);
  const activeScope = cloudConfig.activeScope;
  const syncStatus = useApiStore((state) => state.syncStatus);
  const syncError = useApiStore((state) => state.syncError);

  const setActiveScope = useApiStore((state) => state.setActiveScope);
  const pullCloudDelta = useApiStore((state) => state.pullCloudDelta);
  const setWorkspaceMode = useApiStore((state) => state.setWorkspaceMode);
  const logoutCloud = useApiStore((state) => state.logoutCloud);

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

  // Load accessible workspaces and teams when opening or when token changes
  const loadScopes = async () => {
    if (workspaceMode !== 'cloud' || !cloudConfig.token) return;
    setIsLoadingScopes(true);
    try {
      const [wsList, teamList] = await Promise.all([
        fetchUserWorkspaces(cloudConfig.apiUrl, cloudConfig.token, cloudConfig.refreshToken).catch(() => []),
        fetchUserTeams(cloudConfig.apiUrl, cloudConfig.token, cloudConfig.refreshToken).catch(() => []),
      ]);

      setWorkspaces(wsList);

      // Fetch projects for each accessible team
      const teamProjects = await Promise.all(
        teamList.map(async (t) => {
          const projs = await fetchTeamProjects(
            cloudConfig.apiUrl,
            t.id,
            cloudConfig.token!,
            cloudConfig.refreshToken
          ).catch(() => []);
          return { team: t, projects: projs };
        })
      );

      setTeamsWithProjects(teamProjects);

      // Reconcile active project scope's role if updated on backend
      const currentScope = useApiStore.getState().cloudConfig.activeScope;
      if (currentScope?.type === 'project' && currentScope.id) {
        for (const tp of teamProjects) {
          const match = tp.projects.find((p) => p.id === currentScope.id);
          if (match && match.user_role && match.user_role !== currentScope.role) {
            useApiStore.setState((state) => ({
              cloudConfig: {
                ...state.cloudConfig,
                activeScope: {
                  ...state.cloudConfig.activeScope!,
                  role: match.user_role,
                },
              },
            }));
            break;
          }
        }
      }
    } catch (err) {
      console.error('Failed to load scopes:', err);
    } finally {
      setIsLoadingScopes(false);
    }
  };

  useEffect(() => {
    if (workspaceMode === 'cloud' && cloudConfig.token) {
      loadScopes();
    }
  }, [workspaceMode, cloudConfig.token]);

  const handleSelectScope = async (scope: ActiveScope) => {
    setIsOpen(false);
    await setActiveScope(scope);
  };

  const handleManualSync = async () => {
    await pullCloudDelta();
  };

  // If in Offline Mode
  if (workspaceMode === 'offline') {
    return (
      <div className="flex items-center gap-1.5">
        <button
          onClick={onOpenModeSelector}
          className="group flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/90 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800 hover:text-white transition shadow-sm"
          title="Click to configure workspace storage mode"
        >
          <Laptop className="h-3.5 w-3.5 text-zinc-400 group-hover:text-sky-400 transition" />
          <span className="font-semibold text-zinc-200">Local Storage</span>
          <span className="rounded-full bg-zinc-800 px-1.5 py-0.2 text-[10px] text-zinc-400 border border-zinc-700/50">
            Offline
          </span>
        </button>

        <button
          onClick={onOpenCloudAuth}
          className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-2 py-1 text-[11px] font-medium text-sky-400 hover:bg-sky-500/20 hover:text-sky-300 transition"
          title="Sign in to AirREST Cloud Sync"
        >
          Connect Cloud
        </button>
      </div>
    );
  }

  // Cloud Mode: Scope Selector
  const scopeLabel = activeScope
    ? activeScope.type === 'project'
      ? `${activeScope.teamName || 'Team'} / ${activeScope.name}`
      : activeScope.name
    : 'Select Workspace';

  const jwtRole = getRoleFromJwt(cloudConfig.token);
  const scopeRole = (jwtRole === 'superadmin' || jwtRole === 'admin') ? 'admin' : activeScope?.role;

  // Filter scopes based on search query
  const filteredWorkspaces = workspaces.filter((w) =>
    w.name.toLowerCase().includes(search.toLowerCase())
  );

  const filteredTeams = teamsWithProjects
    .map((tp) => ({
      team: tp.team,
      projects: tp.projects.filter(
        (p) =>
          p.name.toLowerCase().includes(search.toLowerCase()) ||
          tp.team.name.toLowerCase().includes(search.toLowerCase())
      ),
    }))
    .filter((tp) => tp.projects.length > 0 || tp.team.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="relative z-30" ref={dropdownRef}>
      {/* Switcher Button */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => {
            setIsOpen(!isOpen);
            if (!isOpen) loadScopes();
          }}
          className="group flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/90 px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-700 hover:bg-zinc-800 hover:text-white transition shadow-sm max-w-[280px]"
          title="Switch Team or Project"
        >
          {activeScope?.type === 'project' ? (
            <Users className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
          ) : (
            <User className="h-3.5 w-3.5 text-sky-400 shrink-0" />
          )}

          <span className="font-semibold truncate max-w-[170px]">{scopeLabel}</span>

          {scopeRole && (
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
          )}

          <ChevronDown
            className={`h-3.5 w-3.5 text-zinc-400 transition-transform ${
              isOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        {/* Sync Status Button */}
        <button
          onClick={handleManualSync}
          disabled={syncStatus === 'syncing'}
          className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
            syncStatus === 'syncing'
              ? 'border-sky-500/30 bg-sky-500/10 text-sky-400'
              : syncStatus === 'error'
              ? 'border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20'
              : 'border-zinc-800 bg-zinc-900/80 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
          }`}
          title={syncError ? `Sync Error: ${syncError}. Click to retry.` : 'Click to Synchronize with Cloud'}
        >
          {syncStatus === 'syncing' ? (
            <>
              <RefreshCw className="h-3 w-3 animate-spin text-sky-400" />
              <span className="hidden sm:inline">Syncing</span>
            </>
          ) : syncStatus === 'error' ? (
            <>
              <AlertTriangle className="h-3 w-3 text-rose-400" />
              <span className="hidden sm:inline">Retry Sync</span>
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
              <span className="hidden sm:inline">Synced</span>
            </>
          )}
        </button>
      </div>

      {/* Floating Scope Switcher Dropdown */}
      {isOpen && (
        <div className="absolute left-0 top-full mt-2 w-80 rounded-xl border border-zinc-800 bg-zinc-950 p-2 shadow-2xl shadow-black/90 z-50 animate-in fade-in zoom-in-95 duration-100">
          {/* Search Scope */}
          <div className="relative mb-2">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-500" />
            <input
              type="text"
              placeholder="Search teams & projects..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900/90 pl-8 pr-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
            />
          </div>

          {isLoadingScopes ? (
            <div className="flex items-center justify-center py-6 text-xs text-zinc-500 gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
              <span>Loading teams &amp; projects...</span>
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto space-y-3 pr-1">
              {/* Section 1: Personal Workspaces */}
              {filteredWorkspaces.length > 0 && (
                <div>
                  <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                    Personal Workspaces
                  </div>
                  <div className="space-y-0.5">
                    {filteredWorkspaces.map((ws) => {
                      const isSelected = activeScope?.type === 'workspace' && activeScope.id === ws.id;
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
                              ? 'bg-sky-500/10 text-sky-300 font-semibold'
                              : 'text-zinc-300 hover:bg-zinc-900 hover:text-white'
                          }`}
                        >
                          <div className="flex items-center gap-2 truncate">
                            <User className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                            <span className="truncate">{ws.name}</span>
                          </div>
                          {isSelected && <Check className="h-3.5 w-3.5 text-sky-400 shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Section 2: Teams & Projects */}
              {filteredTeams.length > 0 && (
                <div>
                  <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                    Team Projects
                  </div>
                  <div className="space-y-2 mt-1">
                    {filteredTeams.map(({ team, projects }) => (
                      <div key={team.id} className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-1.5">
                        <div className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] font-semibold text-zinc-300">
                          <Users className="h-3 w-3 text-indigo-400 shrink-0" />
                          <span className="truncate">{team.name}</span>
                        </div>

                        <div className="mt-1 space-y-0.5">
                          {projects.map((proj) => {
                            const isSelected =
                              activeScope?.type === 'project' && activeScope.id === proj.id;
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
                                    ? 'bg-indigo-500/20 text-indigo-300 font-semibold'
                                    : 'text-zinc-300 hover:bg-zinc-800 hover:text-white'
                                }`}
                              >
                                <div className="flex items-center gap-2 truncate">
                                  <FolderGit2 className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                                  <span className="truncate">{proj.name}</span>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
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
                </div>
              )}

              {filteredWorkspaces.length === 0 && filteredTeams.length === 0 && (
                <div className="py-4 text-center text-xs text-zinc-500">
                  No matching workspaces or team projects found.
                </div>
              )}
            </div>
          )}

          {/* Footer Controls */}
          <div className="mt-2 border-t border-zinc-800 pt-2 space-y-0.5">
            <button
              onClick={() => {
                setIsOpen(false);
                loadScopes();
                pullCloudDelta();
              }}
              className="w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900 hover:text-white transition"
            >
              <RefreshCw className="h-3.5 w-3.5 text-sky-400" />
              <span>Sync Cloud Changes Now</span>
            </button>

            <button
              onClick={() => {
                setIsOpen(false);
                setWorkspaceMode('offline');
              }}
              className="w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900 hover:text-white transition"
            >
              <Laptop className="h-3.5 w-3.5 text-zinc-400" />
              <span>Switch to Offline Storage</span>
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
        </div>
      )}
    </div>
  );
};
