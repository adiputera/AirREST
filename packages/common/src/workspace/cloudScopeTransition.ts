import type { ActiveScope, ApiRequest, WorkspaceMode } from '../types/api';
import { getScopeCacheKey, isScopeCacheFresh } from './scopeCache';
import {
  restoreWorkspaceResources,
  snapshotWorkspaceResources,
  type WorkspaceResourceState,
  type WorkspaceScopeSnapshot,
} from './scopeSnapshot';

export interface CloudScopeTransitionInput {
  workspaceMode: WorkspaceMode;
  activeCloudScope?: ActiveScope | null;
  targetScope: ActiveScope;
  activeOfflineWorkspaceId: string;
  offlineScopeCache: Record<string, WorkspaceScopeSnapshot>;
  scopeCache: Record<string, WorkspaceScopeSnapshot>;
  resources: WorkspaceResourceState;
  lastSyncedAt: number | null;
  forceSync: boolean;
  cacheTtlMs: number;
  createInitialTab: () => ApiRequest;
}

export interface CloudScopeTransition {
  isSameScope: boolean;
  offlineScopeCache: Record<string, WorkspaceScopeSnapshot>;
  scopeCache: Record<string, WorkspaceScopeSnapshot>;
  targetCache?: WorkspaceScopeSnapshot;
  targetResources: WorkspaceResourceState;
  isFresh: boolean;
}

export function isActiveCloudScope(
  workspaceMode: WorkspaceMode,
  activeCloudScope: ActiveScope | null | undefined,
  targetScope: ActiveScope,
): boolean {
  return workspaceMode === 'cloud' &&
    activeCloudScope?.type === targetScope.type &&
    activeCloudScope?.id === targetScope.id;
}

/**
 * Prepares the local state change for a cloud scope switch.
 *
 * The caller owns persistence, UI state, invalidation, and remote synchronization.
 */
export function prepareCloudScopeTransition(input: CloudScopeTransitionInput): CloudScopeTransition {
  const isSameScope = isActiveCloudScope(input.workspaceMode, input.activeCloudScope, input.targetScope);
  const offlineScopeCache = { ...input.offlineScopeCache };
  const scopeCache = { ...input.scopeCache };

  if (input.workspaceMode === 'offline') {
    offlineScopeCache[input.activeOfflineWorkspaceId] = snapshotWorkspaceResources(input.resources);
  } else if (input.activeCloudScope) {
    const previousKey = getScopeCacheKey(input.activeCloudScope);
    scopeCache[previousKey] = {
      ...scopeCache[previousKey],
      ...snapshotWorkspaceResources(input.resources, input.lastSyncedAt),
    };
  }

  const targetCache = scopeCache[getScopeCacheKey(input.targetScope)];
  return {
    isSameScope,
    offlineScopeCache,
    scopeCache,
    targetCache,
    targetResources: restoreWorkspaceResources(targetCache, input.createInitialTab),
    isFresh: !input.forceSync && isScopeCacheFresh(targetCache, input.cacheTtlMs),
  };
}
