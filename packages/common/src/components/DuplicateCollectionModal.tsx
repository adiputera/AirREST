'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Copy,
  Folder,
  X,
  Loader2,
  AlertCircle,
  AlertTriangle,
  Building2,
  User,
  Laptop,
  RefreshCw,
} from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { isCloudSessionActive } from '../workspace/cloudSession';
import { Collection, ActiveScope } from '../types/api';
import {
  fetchUserWorkspaces,
  fetchUserTeams,
  fetchTeamProjects,
} from '../lib/cloudApi';
import { getRoleFromJwt, canModifyCollection, hasScopePermission, ROLE_RANK } from '../lib/jwt';
import { resolveDuplicateName, inspectDuplicateAttachments } from '../lib/duplicate';
import { useCloudClient, useProductPolicy } from '../context';
import { useBackHandler } from '../lib/backNavigation';

interface DuplicateCollectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  collection: Collection | null;
  returnFocusTo?: HTMLElement | null;
}

interface TargetOption {
  scope: ActiveScope;
  label: string;
  subLabel?: string;
  role?: string;
  isCurrent: boolean;
}

export const DuplicateCollectionModal: React.FC<DuplicateCollectionModalProps> = ({
  isOpen,
  onClose,
  collection,
  returnFocusTo,
}) => {
  const cloudClient = useCloudClient();
  const productPolicy = useProductPolicy();
  const isOfflineOnly = !productPolicy.workspace.cloud;
  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);
  const duplicateCollection = useApiStore((state) => state.duplicateCollection);
  const offlineWorkspaces = useApiStore((state) => state.offlineWorkspaces) || [];
  const activeOfflineWorkspaceId = useApiStore((state) => state.activeOfflineWorkspaceId);

  const [isLoadingTargets, setIsLoadingTargets] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [targetOptions, setTargetOptions] = useState<TargetOption[]>([]);
  const [selectedTargetScope, setSelectedTargetScope] = useState<ActiveScope | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reconcilePending, setReconcilePending] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const pendingOpIdRef = useRef<string | null>(null);

  const handleClose = useCallback(() => {
    if (isSubmitting) return;
    pendingOpIdRef.current = null;
    setReconcilePending(false);
    setErrorMsg(null);
    onClose();
  }, [isSubmitting, onClose]);

  useBackHandler(isOpen && Boolean(collection), handleClose, 20);

  // Capture/restore trigger focus and support Escape close
  useEffect(() => {
    if (isOpen && collection) {
      previousFocusRef.current = returnFocusTo || (document.activeElement as HTMLElement | null);
      setTimeout(() => {
        dialogRef.current?.focus();
      }, 0);
      return;
    }
    if (!isOpen && previousFocusRef.current) {
      previousFocusRef.current.focus?.();
      previousFocusRef.current = null;
    }
  }, [isOpen, collection, returnFocusTo]);

  useEffect(() => {
    if (!isOpen || !collection) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, collection, isSubmitting, handleClose]);

  const activeScope = cloudConfig.activeScope;
  const isSourceProject = workspaceMode === 'cloud' && activeScope?.type === 'project';

  const canWriteSource = canModifyCollection(
    collection?.minRole,
    activeScope,
    workspaceMode,
    cloudConfig.user?.role,
  );

  // Load eligible destinations per scope matrix
  useEffect(() => {
    if (!isOpen || !collection) {
      setTargetOptions([]);
      setSelectedTargetScope(null);
      setErrorMsg(null);
      setDiscoveryError(null);
      setReconcilePending(false);
      pendingOpIdRef.current = null;
      return;
    }

    let isMounted = true;
    const controller = new AbortController();
    setIsLoadingTargets(true);
    setErrorMsg(null);
    setDiscoveryError(null);

    const loadTargets = async () => {
      try {
        const options: TargetOption[] = [];
        let partialFailures = 0;

        // 1. Offline destinations (only when source is offline and offline workspaces are enabled)
        if (workspaceMode === 'offline' && productPolicy.workspace.offline !== false) {
          for (const ws of offlineWorkspaces) {
            const isCurrent = ws.id === activeOfflineWorkspaceId;
            options.push({
              scope: {
                id: ws.id,
                name: ws.name,
                type: 'offline_workspace',
              },
              label: ws.name,
              subLabel: isCurrent ? 'Current Offline Workspace' : 'Offline Workspace (Local Storage)',
              role: 'Local',
              isCurrent,
            });
          }
        }

        // 2. Cloud destinations (when cloud policy enabled and cloud session active)
        if (!isOfflineOnly && isCloudSessionActive(cloudConfig)) {
          const effectiveUserRole = (cloudConfig.user?.role || getRoleFromJwt(cloudConfig.token) || '').toLowerCase();
          const isSuperadmin = effectiveUserRole === 'superadmin';

          const [wsResult, teamsResult] = await Promise.allSettled([
            (cloudClient?.fetchUserWorkspaces ?? fetchUserWorkspaces)(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.refreshToken,
              controller.signal,
            ),
            (cloudClient?.fetchUserTeams ?? fetchUserTeams)(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.refreshToken,
              controller.signal,
            ),
          ]);

          if (controller.signal.aborted || !isMounted) return;

          const workspaces = wsResult.status === 'fulfilled' ? wsResult.value : [];
          const teams = teamsResult.status === 'fulfilled' ? teamsResult.value : [];
          if (wsResult.status === 'rejected') partialFailures++;
          if (teamsResult.status === 'rejected') partialFailures++;

          const teamProjects = await Promise.all(
            teams.map(async (t) => {
              try {
                const projs = await (cloudClient?.fetchTeamProjects ?? fetchTeamProjects)(
                  cloudConfig.apiUrl,
                  t.id,
                  cloudConfig.token,
                  cloudConfig.refreshToken,
                  controller.signal,
                );
                return { team: t, projects: projs };
              } catch {
                partialFailures++;
                return { team: t, projects: [] };
              }
            }),
          );

          if (controller.signal.aborted || !isMounted) return;

          // Personal cloud workspaces: allowed for offline -> cloud and personal -> personal; NEVER project -> personal
          if (!isSourceProject) {
            for (const ws of workspaces) {
              const isCurrent =
                workspaceMode === 'cloud' &&
                activeScope?.type === 'workspace' &&
                activeScope.id === ws.id;
              options.push({
                scope: {
                  id: ws.id,
                  name: ws.name || 'Default Workspace',
                  type: 'workspace',
                },
                label: ws.name || 'Default Workspace',
                subLabel: isCurrent ? 'Current Personal Cloud Workspace' : 'Personal Cloud Workspace',
                role: 'Owner',
                isCurrent,
              });
            }
          }

          // Project cloud targets: allowed for offline -> cloud, personal -> project, and project -> project (any team with write)
          for (const tp of teamProjects) {
            const isTeamAdmin =
              isSuperadmin ||
              tp.team.role === 'admin' ||
              tp.team.role === 'owner' ||
              (tp.team as any).user_role === 'admin' ||
              (tp.team as any).user_role === 'owner';

            for (const proj of tp.projects) {
              const effectiveRole = isTeamAdmin ? 'admin' : proj.user_role;
              const hasWrite =
                isSuperadmin ||
                isTeamAdmin ||
                hasScopePermission(
                  { type: 'project', role: effectiveRole, permissions: proj.permissions },
                  'collection:write',
                  'cloud',
                  cloudConfig.user?.role,
                );
              if (!hasWrite) continue;

              const isCurrent =
                workspaceMode === 'cloud' &&
                activeScope?.type === 'project' &&
                activeScope.id === proj.id;

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
                subLabel: isCurrent ? `Current Project · Team: ${tp.team.name}` : `Team: ${tp.team.name}`,
                role: effectiveRole ? effectiveRole.toUpperCase() : undefined,
                isCurrent,
              });
            }
          }

          if (partialFailures > 0) {
            setDiscoveryError('Some cloud destinations failed to load. You can retry or pick from the loaded targets.');
          }
        }

        if (!isMounted) return;
        setTargetOptions(options);
        const currentOption = options.find((opt) => opt.isCurrent) || options[0] || null;
        setSelectedTargetScope(currentOption ? currentOption.scope : null);
      } catch (err: any) {
        if (!isMounted || controller.signal.aborted) return;
        setDiscoveryError(err?.message || 'Failed to load destination workspaces');
      } finally {
        if (isMounted) setIsLoadingTargets(false);
      }
    };

    void loadTargets();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [
    isOpen,
    collection?.id,
    cloudClient,
    productPolicy,
    isOfflineOnly,
    cloudConfig.apiUrl,
    cloudConfig.token,
    cloudConfig.refreshToken,
    cloudConfig.user?.id,
    cloudConfig.user?.role,
    workspaceMode,
    activeScope?.type,
    activeScope?.id,
    activeOfflineWorkspaceId,
    offlineWorkspaces,
    isSourceProject,
    reloadNonce,
  ]);

  const isSameContainer = useMemo(() => {
    if (!selectedTargetScope) return false;
    if (workspaceMode === 'offline') {
      return (
        selectedTargetScope.type === 'offline_workspace' &&
        selectedTargetScope.id === activeOfflineWorkspaceId
      );
    }
    return (
      selectedTargetScope.type === activeScope?.type &&
      selectedTargetScope.id === activeScope?.id
    );
  }, [selectedTargetScope, workspaceMode, activeOfflineWorkspaceId, activeScope?.type, activeScope?.id]);

  const namePreview = useMemo(() => {
    if (!collection) return { name: '', error: null as string | null };
    try {
      return {
        name: resolveDuplicateName(collection.name, isSameContainer, 'Collection name'),
        error: null as string | null,
      };
    } catch (err: any) {
      return {
        name: '',
        error: err?.message || 'Invalid collection name.',
      };
    }
  }, [collection, isSameContainer]);

  const minRoleClampNotice = useMemo(() => {
    if (!collection || workspaceMode !== 'cloud' || selectedTargetScope?.type !== 'project') {
      return null;
    }
    const effectiveUserRole = (cloudConfig.user?.role || getRoleFromJwt(cloudConfig.token) || '').toLowerCase();
    if (effectiveUserRole === 'superadmin') return null;

    const sourceMinRole = (collection.minRole || 'reader').toLowerCase();
    const targetRole = (selectedTargetScope.role || 'reader').toLowerCase();
    if ((ROLE_RANK[targetRole] || 1) < (ROLE_RANK[sourceMinRole] || 1)) {
      return `Your role in "${selectedTargetScope.name}" is ${targetRole}. The copy's minimum role will be lowered from ${sourceMinRole} to ${targetRole} so you can access it.`;
    }
    return null;
  }, [collection, workspaceMode, selectedTargetScope, cloudConfig.user?.role, cloudConfig.token]);

  const offlineToCloudAttachmentWarning = useMemo(() => {
    if (!collection || workspaceMode !== 'offline' || !selectedTargetScope || selectedTargetScope.type === 'offline_workspace') {
      return null;
    }
    const summary = inspectDuplicateAttachments(collection.items);
    if (!summary.hasBinaryFile && !summary.hasFormDataFiles) return null;
    const parts: string[] = [];
    if (summary.hasFormDataFiles) {
      parts.push(`${summary.formDataFileCount} form-data file attachment(s) will keep metadata only and require file reselection in cloud.`);
    }
    if (summary.hasBinaryFile) {
      parts.push(`${summary.binaryFileCount} local binary file attachment(s) are local-only and will not be stored in cloud.`);
    }
    return parts.join(' ');
  }, [collection, workspaceMode, selectedTargetScope]);

  if (!isOpen || !collection) return null;

  const handleConfirmDuplicate = async () => {
    if (!canWriteSource) {
      setErrorMsg('You do not have write permission to duplicate this collection.');
      return;
    }
    if (!selectedTargetScope || namePreview.error || isSubmitting) return;

    const opId = pendingOpIdRef.current || crypto.randomUUID();
    pendingOpIdRef.current = opId;
    setIsSubmitting(true);
    setErrorMsg(null);

    const result = await duplicateCollection(collection.id, selectedTargetScope, { operationId: opId });
    setIsSubmitting(false);

    if (result.success) {
      pendingOpIdRef.current = null;
      setReconcilePending(false);
      onClose();
      return;
    }

    if (result.reconcilePending) {
      setReconcilePending(true);
      setErrorMsg(result.error || 'Duplicate status uncertain after network error. Click Retry to safely reconcile.');
    } else {
      pendingOpIdRef.current = null;
      setReconcilePending(false);
      setErrorMsg(result.error || 'Failed to duplicate collection');
    }
  };

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) handleClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150 select-none"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="duplicate-collection-title"
        tabIndex={-1}
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-line bg-surface p-6 shadow-2xl focus:outline-none"
      >
        <div className="flex items-start justify-between pb-4 border-b border-line">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 bg-sky-500/10 text-sky-500 dark:text-sky-400">
              <Copy className="h-5 w-5" />
            </div>
            <div>
              <h3 id="duplicate-collection-title" className="text-sm font-bold text-tx-primary">
                Duplicate Collection
              </h3>
              <p className="text-xs text-tx-muted mt-0.5">
                Copy <span className="font-semibold text-tx-primary">&ldquo;{collection.name}&rdquo;</span> to a workspace or project.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={isSubmitting}
            aria-label="Close modal"
            className="rounded-lg p-1 text-tx-muted hover:text-tx-primary hover:bg-hover transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Name Preview */}
        <div className="mt-4 rounded-xl border border-line bg-card p-3">
          <div className="text-[11px] uppercase tracking-wider text-tx-muted font-semibold">
            Result Name Preview
          </div>
          <div className="mt-1 flex items-center gap-2">
            <Folder className="h-4 w-4 text-sky-500 dark:text-sky-400 shrink-0" />
            <span className="text-xs font-bold text-tx-primary truncate">
              {namePreview.name || collection.name}
            </span>
          </div>
          {selectedTargetScope && (
            <div className="text-[11px] text-tx-muted mt-1 truncate">
              Destination: <span className="text-tx-secondary font-medium">{selectedTargetScope.name}</span>
            </div>
          )}
        </div>

        {/* Target selection */}
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <label className="block text-xs font-semibold text-tx-secondary">
              Select Destination Workspace
            </label>
            {discoveryError && (
              <button
                type="button"
                onClick={() => setReloadNonce((n) => n + 1)}
                disabled={isLoadingTargets || isSubmitting}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-500 hover:text-sky-400"
              >
                <RefreshCw className="h-3 w-3" />
                <span>Retry</span>
              </button>
            )}
          </div>

          {isLoadingTargets ? (
            <div className="flex items-center justify-center py-8 text-tx-muted gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-sky-500 dark:text-sky-400" />
              <span className="text-xs">Loading available destinations...</span>
            </div>
          ) : targetOptions.length === 0 ? (
            <div className="rounded-xl border border-line bg-card/30 p-4 text-center">
              <AlertCircle className="h-6 w-6 text-tx-muted mx-auto" />
              <div className="text-xs font-bold text-tx-secondary mt-2">
                {discoveryError ? 'Failed to Load Destinations' : 'No Eligible Destinations Available'}
              </div>
              <p className="text-[11px] text-tx-muted mt-1 leading-relaxed">
                {discoveryError || 'You need write access on a destination workspace or project to duplicate this collection.'}
              </p>
            </div>
          ) : (
            <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
              {targetOptions.map((opt) => {
                const isSelected =
                  selectedTargetScope?.id === opt.scope.id &&
                  selectedTargetScope?.type === opt.scope.type;
                const isOfflineTarget = opt.scope.type === 'offline_workspace';

                return (
                  <button
                    key={`${opt.scope.type}:${opt.scope.id}`}
                    type="button"
                    onClick={() => {
                      if (isSubmitting) return;
                      pendingOpIdRef.current = null;
                      setReconcilePending(false);
                      setErrorMsg(null);
                      setSelectedTargetScope(opt.scope);
                    }}
                    className={`w-full text-left flex items-center justify-between p-2.5 rounded-xl border transition ${
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
                      <span className="text-[9px] font-bold px-2 py-0.5 rounded uppercase tracking-wider shrink-0 bg-element text-tx-muted">
                        {opt.role}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {discoveryError && targetOptions.length > 0 && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 p-2.5 text-xs text-amber-500 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{discoveryError}</span>
          </div>
        )}

        {minRoleClampNotice && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{minRoleClampNotice}</span>
          </div>
        )}

        {offlineToCloudAttachmentWarning && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{offlineToCloudAttachmentWarning}</span>
          </div>
        )}

        {!canWriteSource && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-500 dark:text-rose-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>Write access to this collection is required to duplicate it.</span>
          </div>
        )}

        {namePreview.error && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-500 dark:text-rose-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{namePreview.error}</span>
          </div>
        )}

        {errorMsg && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-500 dark:text-rose-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-2.5 pt-4 border-t border-line">
          <button
            type="button"
            onClick={handleClose}
            disabled={isSubmitting}
            className="rounded-xl px-4 py-2 text-xs font-medium text-tx-muted hover:bg-hover hover:text-tx-primary transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirmDuplicate}
            disabled={
              isSubmitting ||
              isLoadingTargets ||
              !canWriteSource ||
              !selectedTargetScope ||
              Boolean(namePreview.error)
            }
            className="flex items-center gap-1.5 rounded-xl bg-sky-500 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-sky-500/20 hover:bg-sky-400 disabled:opacity-40 disabled:pointer-events-none transition"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Duplicating...</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span>{reconcilePending ? 'Retry Duplicate' : 'Duplicate Collection'}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
