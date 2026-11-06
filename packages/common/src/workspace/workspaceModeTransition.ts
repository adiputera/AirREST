import type { ActiveScope, ApiRequest, WorkspaceMode } from '../types/api';
import { getScopeCacheKey, isScopeCacheFresh } from './scopeCache';
import {
  createEmptyWorkspaceSnapshot,
  restoreWorkspaceResources,
  snapshotWorkspaceResources,
  type WorkspaceResourceState,
  type WorkspaceScopeSnapshot,
} from './scopeSnapshot';

export interface WorkspaceModeTransitionInput {
  currentWorkspaceMode: WorkspaceMode;
  nextWorkspaceMode: WorkspaceMode;
  activeCloudScope?: ActiveScope;
  activeOfflineWorkspaceId?: string;
  fallbackOfflineWorkspaceId: string;
  offlineScopeCache: Record<string, WorkspaceScopeSnapshot>;
  scopeCache: Record<string, WorkspaceScopeSnapshot>;
  resources: WorkspaceResourceState;
  lastSyncedAt: number | null;
  cacheTtlMs: number;
  createInitialTab: () => ApiRequest;
}

export interface WorkspaceModeTransition {
  offlineScopeCache: Record<string, WorkspaceScopeSnapshot>;
  scopeCache: Record<string, WorkspaceScopeSnapshot>;
  targetCache?: WorkspaceScopeSnapshot;
  targetResources: WorkspaceResourceState;
  isCloudCacheFresh: boolean;
}

/**
 * Prepares cache and resource changes for a workspace-mode switch.
 *
 * The store retains responsibility for asynchronous work, persistence, and UI state.
 */
export function prepareWorkspaceModeTransition(input: WorkspaceModeTransitionInput): WorkspaceModeTransition {
  const offlineScopeCache = { ...input.offlineScopeCache };
  const scopeCache = { ...input.scopeCache };

  if (input.nextWorkspaceMode === 'offline') {
    if (input.activeCloudScope) {
      const activeScopeKey = getScopeCacheKey(input.activeCloudScope);
      scopeCache[activeScopeKey] = {
        ...scopeCache[activeScopeKey],
        ...snapshotWorkspaceResources(input.resources, input.lastSyncedAt),
      };
    }

    const offlineWorkspaceId = input.activeOfflineWorkspaceId ?? input.fallbackOfflineWorkspaceId;
    const targetCache = offlineScopeCache[offlineWorkspaceId]
      ?? createEmptyWorkspaceSnapshot(input.createInitialTab);
    return {
      offlineScopeCache,
      scopeCache,
      targetCache,
      targetResources: restoreWorkspaceResources(targetCache, input.createInitialTab),
      isCloudCacheFresh: false,
    };
  }

  if (input.currentWorkspaceMode === 'offline' && input.activeOfflineWorkspaceId) {
    offlineScopeCache[input.activeOfflineWorkspaceId] = snapshotWorkspaceResources(input.resources);
  }

  const targetCache = input.activeCloudScope
    ? scopeCache[getScopeCacheKey(input.activeCloudScope)]
    : undefined;
  return {
    offlineScopeCache,
    scopeCache,
    targetCache,
    targetResources: restoreWorkspaceResources(targetCache, input.createInitialTab),
    isCloudCacheFresh: isScopeCacheFresh(targetCache, input.cacheTtlMs),
  };
}
