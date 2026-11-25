'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
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
import { useApiStore } from '../store/useApiStore';
import { isCloudSessionActive } from '../workspace/cloudSession';
import { Collection, ActiveScope } from '../types/api';
import {
  fetchUserWorkspaces,
  fetchUserTeams,
  fetchTeamProjects,
} from '../lib/cloudApi';
import { getRoleFromJwt, canModifyCollection, hasScopePermission } from '../lib/jwt';
import { useCloudClient, useProductPolicy } from '../context';
import { useBackHandler } from '../lib/backNavigation';

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
  const cloudClient = useCloudClient();
  const productPolicy = useProductPolicy();
  const isOfflineOnly = !productPolicy.workspace.cloud;
  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);
  const moveCollection = useApiStore((state) => state.moveCollection);

  const offlineWorkspaces = useApiStore((state) => state.offlineWorkspaces) || [];
  const activeOfflineWorkspaceId = useApiStore((state) => state.activeOfflineWorkspaceId);

  const [isLoadingTargets, setIsLoadingTargets] = useState(false);
  const [targetOptions, setTargetOptions] = useState<TargetOption[]>([]);
  const [selectedTargetScope, setSelectedTargetScope] = useState<ActiveScope | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [targetFetchError, setTargetFetchError] = useState<string | null>(null);
  const [retryCounter, setRetryCounter] = useState(0);
  const isMountedRef = useRef(true);
  const contextGenRef = useRef(0);
  const targetsLoadGenRef = useRef(0);
  useBackHandler(isOpen && Boolean(collection), () => { if (!isSubmitting) onClose(); }, 20);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const activeScope = cloudConfig.activeScope;
  const isSourceProject = workspaceMode === 'cloud' && activeScope?.type === 'project';
  const sourceTeamId = isSourceProject ? activeScope.teamId : undefined;

  const canMove =
    hasScopePermission(activeScope, 'collection:move', workspaceMode, cloudConfig.user?.role) &&
    canModifyCollection(collection?.minRole, activeScope, workspaceMode, cloudConfig.user?.role);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, isSubmitting, onClose]);

  const hasCloudSession = isCloudSessionActive(cloudConfig);
  const cloudApiUrl = cloudConfig.apiUrl;
  const cloudUserId = cloudConfig.user?.id;
  const cloudUserRole = cloudConfig.user?.role;
  const activeScopeId = activeScope?.id;
  const activeScopeType = activeScope?.type;
  const activeScopeTeamId = activeScope?.teamId;

  const loadTargets = useCallback(async (signal?: AbortSignal) => {
    const gen = ++targetsLoadGenRef.current;
    setIsLoadingTargets(true);
    setErrorMsg(null);
    setTargetFetchError(null);

    try {
      const options: TargetOption[] = [];
      const liveState = useApiStore.getState();
      const liveCloudConfig = liveState.cloudConfig;
      const liveOfflineWorkspaces = liveState.offlineWorkspaces || [];

      // 1. Offline Workspaces (only available when source itself is in Offline mode)
      const otherOfflineWorkspaces =
        workspaceMode !== 'offline' || productPolicy.workspace.offline === false
          ? []
          : liveOfflineWorkspaces.filter(
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
      let hadFetchFailure = false;
      let firstFetchError: string | null = null;
      const captureFailure = (err: unknown) => {
        if (signal?.aborted) return;
        hadFetchFailure = true;
        if (!firstFetchError) {
          firstFetchError = err instanceof Error ? err.message : 'Failed to load destination workspaces';
        }
      };

      if (!isOfflineOnly && isCloudSessionActive(liveCloudConfig)) {
        const effectiveUserRole = (liveCloudConfig.user?.role || getRoleFromJwt(liveCloudConfig.token) || '').toLowerCase();
        const isSuperadmin = effectiveUserRole === 'superadmin';

        const [workspaces, teams] = await Promise.all([
          (cloudClient?.fetchUserWorkspaces ?? fetchUserWorkspaces)(
            liveCloudConfig.apiUrl,
            liveCloudConfig.token,
            liveCloudConfig.refreshToken,
            signal
          ).catch((err) => {
            captureFailure(err);
            return [] as Awaited<ReturnType<typeof fetchUserWorkspaces>>;
          }),
          (cloudClient?.fetchUserTeams ?? fetchUserTeams)(
            liveCloudConfig.apiUrl,
            liveCloudConfig.token,
            liveCloudConfig.refreshToken,
            signal
          ).catch((err) => {
            captureFailure(err);
            return [] as Awaited<ReturnType<typeof fetchUserTeams>>;
          }),
        ]);

        const teamProjects = await Promise.all(
          teams.map(async (t) => {
            const projs = await (cloudClient?.fetchTeamProjects ?? fetchTeamProjects)(
              liveCloudConfig.apiUrl,
              t.id,
              liveCloudConfig.token,
              liveCloudConfig.refreshToken,
              signal,
            ).catch((err) => {
              captureFailure(err);
              return [] as Awaited<ReturnType<typeof fetchTeamProjects>>;
            });
            return { team: t, projects: projs };
          })
        );

        // Personal Cloud Workspace Option
        for (const ws of workspaces) {
          const isCurrentWs = workspaceMode === 'cloud' && activeScopeType === 'workspace' && activeScopeId === ws.id;
          if (!isCurrentWs && !isSourceProject) {
            options.push({
              scope: {
                id: ws.id,
                name: ws.name || 'Default Workspace',
                type: 'workspace',
              },
              label: ws.name || 'Default Workspace',
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
            if (isSourceProject && proj.id === activeScopeId) {
              continue;
            }

            const effectiveRole = isTeamAdmin ? 'admin' : proj.user_role;
            const targetProjectScope: ActiveScope = {
              type: 'project',
              id: proj.id,
              name: proj.name,
              teamId: tp.team.id,
              teamName: tp.team.name,
              role: effectiveRole,
              permissions: proj.permissions,
            };
            const isEligible =
              isSuperadmin ||
              isTeamAdmin ||
              (hasScopePermission(targetProjectScope, 'collection:move', 'cloud', liveCloudConfig.user?.role) &&
                canModifyCollection(collection?.minRole, targetProjectScope, 'cloud', liveCloudConfig.user?.role));

            if (isEligible) {
              options.push({
                scope: targetProjectScope,
                label: `${tp.team.name} / ${proj.name}`,
                subLabel: `Team: ${tp.team.name}`,
                role: effectiveRole ? effectiveRole.toUpperCase() : undefined,
              });
            }
          }
        }
      }

      if (!isMountedRef.current || targetsLoadGenRef.current !== gen || signal?.aborted) return;

      if (hadFetchFailure) {
        setTargetFetchError(firstFetchError || 'Failed to load destination workspaces');
      }
      setTargetOptions(options);
      setSelectedTargetScope(options.length > 0 ? options[0].scope : null);
    } catch (err: any) {
      if (!isMountedRef.current || targetsLoadGenRef.current !== gen || signal?.aborted) return;
      setTargetFetchError(err.message || 'Failed to load destination workspaces');
      setErrorMsg(err.message || 'Failed to load destination workspaces');
      setTargetOptions([]);
      setSelectedTargetScope(null);
    } finally {
      if (isMountedRef.current && targetsLoadGenRef.current === gen && !signal?.aborted) {
        setIsLoadingTargets(false);
      }
    }
  }, [
    workspaceMode,
    productPolicy.workspace.offline,
    activeOfflineWorkspaceId,
    isOfflineOnly,
    hasCloudSession,
    cloudApiUrl,
    cloudUserId,
    cloudUserRole,
    cloudClient,
    activeScopeId,
    activeScopeType,
    isSourceProject,
    sourceTeamId,
    collection?.minRole,
  ]);

  // Reset modal context & submit state when open/collection/scope changes
  useEffect(() => {
    contextGenRef.current += 1;
    setIsSubmitting(false);
    if (!isOpen) {
      targetsLoadGenRef.current += 1;
      setTargetOptions([]);
      setSelectedTargetScope(null);
      setErrorMsg(null);
      setTargetFetchError(null);
      setIsLoadingTargets(false);
    }
    return () => {
      contextGenRef.current += 1;
    };
  }, [
    isOpen,
    collection?.id,
    workspaceMode,
    activeOfflineWorkspaceId,
    activeScopeType,
    activeScopeId,
    activeScopeTeamId,
    cloudUserId,
  ]);

  // Load eligible target workspaces / projects
  useEffect(() => {
    if (!isOpen) return;

    const controller = new AbortController();
    void loadTargets(controller.signal);

    return () => {
      targetsLoadGenRef.current += 1;
      controller.abort();
    };
  }, [
    isOpen,
    retryCounter,
    loadTargets,
    collection?.id,
  ]);

  if (!isOpen || !collection) return null;

  const handleConfirmMove = async () => {
    if (!canMove) {
      setErrorMsg('You do not have permission to move this collection (insufficient role in current scope).');
      return;
    }
    if (!selectedTargetScope) return;
    const submitGen = contextGenRef.current;
    setIsSubmitting(true);
    setErrorMsg(null);

    const result = await moveCollection(collection.id, selectedTargetScope);
    if (!isMountedRef.current || contextGenRef.current !== submitGen) return;
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
      title: activeScope?.name || 'Default Workspace',
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
      data-modal="true"
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150 select-none"
    >
      <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-line">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-500 dark:text-amber-400">
              <FolderInput className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-tx-primary">Move Collection</h3>
              <p className="text-xs text-tx-muted mt-0.5">
                Relocate <span className="font-semibold text-tx-primary">&ldquo;{collection.name}&rdquo;</span> to another workspace.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg p-1 text-tx-muted hover:text-tx-primary hover:bg-hover transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Source info */}
        <div className="mt-4 rounded-xl border border-line bg-card p-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <Folder className="h-4 w-4 text-amber-500 dark:text-amber-400 shrink-0" />
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wider text-tx-muted font-semibold">
                Current Location
              </div>
              <div className="text-xs font-bold text-tx-primary truncate">{sourceInfo.title}</div>
              <div className="text-[11px] text-tx-muted truncate">{sourceInfo.subtitle}</div>
            </div>
          </div>
          <span className="rounded-full bg-element px-2 py-0.5 text-[10px] font-bold text-tx-secondary">
            {sourceInfo.badge}
          </span>
        </div>

        {/* Target selection */}
        <div className="mt-4">
          <label className="block text-xs font-semibold text-tx-secondary mb-2">
            Select Destination Workspace
          </label>

          {isLoadingTargets ? (
            <div className="flex items-center justify-center py-8 text-tx-muted gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-sky-500 dark:text-sky-400" />
              <span className="text-xs">Loading available workspaces...</span>
            </div>
          ) : targetFetchError && targetOptions.length === 0 ? (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-center">
              <AlertCircle className="h-6 w-6 text-rose-500 dark:text-rose-400 mx-auto" />
              <div className="text-xs font-bold text-rose-500 dark:text-rose-300 mt-2">
                Failed to Load Destination Workspaces
              </div>
              <p className="text-[11px] text-tx-muted mt-1 leading-relaxed">
                {targetFetchError}
              </p>
              <button
                type="button"
                onClick={() => setRetryCounter((n) => n + 1)}
                className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-[11px] font-semibold text-rose-500 dark:text-rose-300 hover:bg-rose-500/20 transition"
              >
                Retry
              </button>
            </div>
          ) : targetOptions.length === 0 ? (
            <div className="rounded-xl border border-line bg-card/30 p-4 text-center">
              <AlertCircle className="h-6 w-6 text-tx-muted mx-auto" />
              <div className="text-xs font-bold text-tx-secondary mt-2">
                No Other Workspaces Available
              </div>
              <p className="text-[11px] text-tx-muted mt-1 leading-relaxed">
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
                    onClick={() => {
                      if (!isSubmitting) setSelectedTargetScope(opt.scope);
                    }}
                    className={`flex items-center justify-between p-2.5 rounded-xl border cursor-pointer transition ${
                      isSelected
                        ? isOfflineTarget
                          ? 'border-amber-500/50 bg-amber-500/10 text-tx-primary'
                          : 'border-sky-500/50 bg-sky-500/10 text-tx-primary'
                        : 'border-line bg-card hover:bg-hover text-tx-secondary'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {isOfflineTarget ? (
                        <Laptop className={`h-4 w-4 shrink-0 ${isSelected ? 'text-amber-500 dark:text-amber-400' : 'text-tx-muted'}`} />
                      ) : opt.scope.type === 'workspace' ? (
                        <User className={`h-4 w-4 shrink-0 ${isSelected ? 'text-sky-500 dark:text-sky-400' : 'text-tx-muted'}`} />
                      ) : (
                        <Building2 className={`h-4 w-4 shrink-0 ${isSelected ? 'text-indigo-500 dark:text-indigo-400' : 'text-tx-muted'}`} />
                      )}
                      <div className="min-w-0">
                        <div className="text-xs font-bold truncate text-tx-primary">{opt.label}</div>
                        {opt.subLabel && (
                          <div className="text-[10px] text-tx-muted truncate">{opt.subLabel}</div>
                        )}
                      </div>
                    </div>
                    {opt.role && (
                      <span
                        className={`text-[9px] font-bold px-2 py-0.5 rounded uppercase tracking-wider shrink-0 ${
                          isOfflineTarget
                            ? isSelected
                              ? 'bg-amber-500/20 text-amber-600 dark:text-amber-300'
                              : 'bg-amber-500/10 text-amber-600 dark:text-amber-400/80 border border-amber-500/20'
                            : isSelected
                            ? 'bg-sky-500/20 text-sky-600 dark:text-sky-300'
                            : 'bg-element text-tx-muted'
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

        {targetFetchError && targetOptions.length > 0 && (
          <div className="mt-3.5 flex items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-500 dark:text-amber-300">
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span className="truncate">Some destination workspaces failed to load: {targetFetchError}</span>
            </div>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => setRetryCounter((n) => n + 1)}
              className="shrink-0 rounded-md border border-amber-500/30 px-2 py-0.5 text-[11px] font-semibold hover:bg-amber-500/20 disabled:opacity-40 disabled:pointer-events-none"
            >
              Retry
            </button>
          </div>
        )}

        {/* Error notice */}
        {!canMove && (
          <div className="mt-3.5 flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-500 dark:text-rose-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>You have read-only access to this collection and cannot move it to another workspace.</span>
          </div>
        )}

        {errorMsg && (
          <div className="mt-3.5 flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-500 dark:text-rose-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Footer actions */}
        <div className="mt-6 flex items-center justify-end gap-2.5 pt-4 border-t border-line">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-xl px-4 py-2 text-xs font-medium text-tx-muted hover:bg-hover hover:text-tx-primary transition"
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
