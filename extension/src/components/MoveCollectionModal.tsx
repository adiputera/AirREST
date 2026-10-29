'use client';

import React, { useState, useEffect } from 'react';
import {
  FolderInput,
  Folder,
  X,
  Loader2,
  AlertCircle,
  Building2,
  User,
  ShieldCheck,
  ArrowRight,
  Laptop,
} from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import { Collection, ActiveScope } from '@/types/api';
import {
  fetchUserWorkspaces,
  fetchUserTeams,
  fetchTeamProjects,
} from '@/lib/cloudApi';
import { getRoleFromJwt, canModifyCollection, hasScopePermission } from '@/lib/jwt';
import { isOfflineOnly } from '@/lib/edition';

interface MoveCollectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  collection: Collection | null;
}

interface TargetOption {
  scope: ActiveScope;
  label: string;
  subLabel?: string;
  role?: string;
}

export const MoveCollectionModal: React.FC<MoveCollectionModalProps> = ({
  isOpen,
  onClose,
  collection,
}) => {
  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);
  const moveCollection = useApiStore((state) => state.moveCollection);

  const offlineWorkspaces = useApiStore((state) => state.offlineWorkspaces) || [];
  const activeOfflineWorkspaceId = useApiStore((state) => state.activeOfflineWorkspaceId);

  const [isLoadingTargets, setIsLoadingTargets] = useState(false);
  const [targetOptions, setTargetOptions] = useState<TargetOption[]>([]);
  const [selectedTargetScope, setSelectedTargetScope] = useState<ActiveScope | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const activeScope = cloudConfig.activeScope;
  const isSourceProject = workspaceMode === 'cloud' && activeScope?.type === 'project';
  const sourceTeamId = isSourceProject ? activeScope.teamId : undefined;

  const canMove =
    hasScopePermission(activeScope, 'collection:move', workspaceMode, cloudConfig.user?.role) &&
    canModifyCollection(collection?.minRole, activeScope, workspaceMode, cloudConfig.user?.role);

  // Load eligible target workspaces / projects
  useEffect(() => {
    if (!isOpen) {
      setTargetOptions([]);
      setSelectedTargetScope(null);
      setErrorMsg(null);
      return;
    }

    let isMounted = true;
    setIsLoadingTargets(true);
    setErrorMsg(null);

    const loadTargets = async () => {
      try {
        const options: TargetOption[] = [];

        // 1. Offline Workspaces (available in all editions)
        const otherOfflineWorkspaces = (offlineWorkspaces || []).filter(
          (w) => !(workspaceMode === 'offline' && w.id === activeOfflineWorkspaceId)
        );

        for (const ws of otherOfflineWorkspaces) {
          options.push({
            scope: {
              id: ws.id,
              name: ws.name,
              type: 'offline_workspace',
            },
            label: ws.name,
            subLabel: 'Offline Workspace (Local Storage)',
            role: 'Local',
          });
        }

        // 2. Cloud Workspaces & Projects (Full edition only, if authenticated)
        if (!isOfflineOnly && cloudConfig.token) {
          const effectiveUserRole = (cloudConfig.user?.role || getRoleFromJwt(cloudConfig.token) || '').toLowerCase();
          const isSuperadmin = effectiveUserRole === 'superadmin';

          const [workspaces, teams] = await Promise.all([
            fetchUserWorkspaces(cloudConfig.apiUrl, cloudConfig.token!, cloudConfig.refreshToken).catch(() => []),
            fetchUserTeams(cloudConfig.apiUrl, cloudConfig.token!, cloudConfig.refreshToken).catch(() => []),
          ]);

          const teamProjects = await Promise.all(
            teams.map(async (t) => {
              const projs = await fetchTeamProjects(
                cloudConfig.apiUrl,
                t.id,
                cloudConfig.token!,
                cloudConfig.refreshToken
              ).catch(() => []);
              return { team: t, projects: projs };
            })
          );

          // Personal Cloud Workspace Option
          for (const ws of workspaces) {
            const isCurrentWs = workspaceMode === 'cloud' && activeScope?.type === 'workspace' && activeScope.id === ws.id;
            if (!isCurrentWs && !isSourceProject) {
              options.push({
                scope: {
                  id: ws.id,
                  name: ws.name || 'Personal Workspace',
                  type: 'workspace',
                },
                label: ws.name || 'Personal Workspace',
                subLabel: 'Private Cloud Workspace',
                role: 'Owner',
              });
            }
          }

          // Team Projects Options
          for (const tp of teamProjects) {
            const isTeamAdmin =
              isSuperadmin ||
              tp.team.role === 'admin' ||
              tp.team.role === 'owner' ||
              (tp.team as any).user_role === 'admin' ||
              (tp.team as any).user_role === 'owner';

            if (isSourceProject && sourceTeamId && tp.team.id !== sourceTeamId) {
              continue;
            }

            for (const proj of tp.projects) {
              if (isSourceProject && proj.id === activeScope?.id) {
                continue;
              }

              const effectiveRole = isTeamAdmin ? 'admin' : proj.user_role;
              const isEligible =
                isSuperadmin ||
                isTeamAdmin ||
                hasScopePermission(
                  { type: 'project', role: effectiveRole, permissions: proj.permissions },
                  'collection:move',
                  'cloud',
                  cloudConfig.user?.role
                );

              if (isEligible) {
                options.push({
                  scope: {
                    id: proj.id,
                    name: proj.name,
                    type: 'project',
                    teamId: tp.team.id,
                    teamName: tp.team.name,
                    role: effectiveRole,
                    permissions: proj.permissions,
                  },
                  label: `${tp.team.name} / ${proj.name}`,
                  subLabel: `Team: ${tp.team.name}`,
                  role: effectiveRole ? effectiveRole.toUpperCase() : undefined,
                });
              }
            }
          }
        }

        if (!isMounted) return;

        setTargetOptions(options);
        if (options.length > 0) {
          setSelectedTargetScope(options[0].scope);
        }
      } catch (err: any) {
        if (!isMounted) return;
        setErrorMsg(err.message || 'Failed to load destination workspaces');
      } finally {
        if (isMounted) setIsLoadingTargets(false);
      }
    };

    loadTargets();

    return () => {
      isMounted = false;
    };
  }, [isOpen, cloudConfig.token, workspaceMode, activeOfflineWorkspaceId, offlineWorkspaces]);

  if (!isOpen || !collection) return null;

  const handleConfirmMove = async () => {
    if (!canMove) {
      setErrorMsg('You do not have permission to move this collection (insufficient role in current scope).');
      return;
    }
    if (!selectedTargetScope) return;
    setIsSubmitting(true);
    setErrorMsg(null);

    const result = await moveCollection(collection.id, selectedTargetScope);
    setIsSubmitting(false);

    if (result.success) {
      onClose();
    } else {
      setErrorMsg(result.error || 'Failed to move collection');
    }
  };

  const getSourceDisplay = () => {
    if (workspaceMode === 'offline') {
      const currentOfflineWs = (offlineWorkspaces || []).find((w) => w.id === activeOfflineWorkspaceId);
      return {
        title: currentOfflineWs ? currentOfflineWs.name : 'Offline Workspace',
        subtitle: 'Stored locally in browser',
        badge: 'Offline',
      };
    }
    if (activeScope?.type === 'project') {
      return {
        title: activeScope.name,
        subtitle: `Team: ${activeScope.teamName || 'Team'}`,
        badge: activeScope.role ? activeScope.role.toUpperCase() : 'Project',
      };
    }
    return {
      title: activeScope?.name || 'Personal Workspace',
      subtitle: 'Cloud Private Workspace',
      badge: 'Owner',
    };
  };

  const sourceInfo = getSourceDisplay();

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) {
          onClose();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150 select-none"
    >
      <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-zinc-800/80">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-400">
              <FolderInput className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-zinc-100">Move Collection</h3>
              <p className="text-xs text-zinc-400 mt-0.5">
                Relocate <span className="font-semibold text-zinc-200">&ldquo;{collection.name}&rdquo;</span> to another workspace.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Source info */}
        <div className="mt-4 rounded-xl border border-zinc-850 bg-zinc-900/40 p-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <Folder className="h-4 w-4 text-amber-400 shrink-0" />
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold">
                Current Location
              </div>
              <div className="text-xs font-bold text-zinc-200 truncate">{sourceInfo.title}</div>
              <div className="text-[11px] text-zinc-400 truncate">{sourceInfo.subtitle}</div>
            </div>
          </div>
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-bold text-zinc-300">
            {sourceInfo.badge}
          </span>
        </div>

        {/* Target selection */}
        <div className="mt-4">
          <label className="block text-xs font-semibold text-zinc-300 mb-2">
            Select Destination Workspace
          </label>

          {isLoadingTargets ? (
            <div className="flex items-center justify-center py-8 text-zinc-400 gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
              <span className="text-xs">Loading available workspaces...</span>
            </div>
          ) : targetOptions.length === 0 ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 text-center">
              <AlertCircle className="h-6 w-6 text-zinc-500 mx-auto" />
              <div className="text-xs font-bold text-zinc-300 mt-2">
                No Other Workspaces Available
              </div>
              <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed">
                Create another offline workspace or connect to a cloud account to move this collection.
              </p>
            </div>
          ) : (
            <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
              {targetOptions.map((opt) => {
                const isSelected = selectedTargetScope?.id === opt.scope.id;
                const isOfflineTarget = opt.scope.type === 'offline_workspace';

                return (
                  <div
                    key={opt.scope.id}
                    onClick={() => setSelectedTargetScope(opt.scope)}
                    className={`flex items-center justify-between p-2.5 rounded-xl border cursor-pointer transition ${
                      isSelected
                        ? isOfflineTarget
                          ? 'border-amber-500/50 bg-amber-500/10 text-white'
                          : 'border-sky-500/50 bg-sky-500/10 text-white'
                        : 'border-zinc-800/80 bg-zinc-900/30 hover:bg-zinc-900 text-zinc-300'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {isOfflineTarget ? (
                        <Laptop className={`h-4 w-4 shrink-0 ${isSelected ? 'text-amber-400' : 'text-zinc-500'}`} />
                      ) : opt.scope.type === 'workspace' ? (
                        <User className={`h-4 w-4 shrink-0 ${isSelected ? 'text-sky-400' : 'text-zinc-500'}`} />
                      ) : (
                        <Building2 className={`h-4 w-4 shrink-0 ${isSelected ? 'text-indigo-400' : 'text-zinc-500'}`} />
                      )}
                      <div className="min-w-0">
                        <div className="text-xs font-bold truncate">{opt.label}</div>
                        {opt.subLabel && (
                          <div className="text-[10px] text-zinc-400 truncate">{opt.subLabel}</div>
                        )}
                      </div>
                    </div>
                    {opt.role && (
                      <span
                        className={`text-[9px] font-bold px-2 py-0.5 rounded uppercase tracking-wider shrink-0 ${
                          isOfflineTarget
                            ? isSelected
                              ? 'bg-amber-500/20 text-amber-300'
                              : 'bg-amber-500/10 text-amber-400/80 border border-amber-500/20'
                            : isSelected
                            ? 'bg-sky-500/20 text-sky-300'
                            : 'bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        {opt.role}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Error notice */}
        {!canMove && (
          <div className="mt-3.5 flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>You have read-only access to this collection and cannot move it to another workspace.</span>
          </div>
        )}

        {errorMsg && (
          <div className="mt-3.5 flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Footer actions */}
        <div className="mt-6 flex items-center justify-end gap-2.5 pt-4 border-t border-zinc-800/80">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-xl px-4 py-2 text-xs font-medium text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirmMove}
            disabled={isSubmitting || !canMove || !selectedTargetScope || targetOptions.length === 0}
            className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 px-4 py-2 text-xs font-semibold text-zinc-950 shadow-lg shadow-amber-500/20 hover:from-amber-400 hover:to-amber-500 active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Moving...</span>
              </>
            ) : (
              <>
                <span>Move Collection</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
