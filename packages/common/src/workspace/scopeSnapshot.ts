import type { ApiRequest, Collection, Environment, HistoryItem } from '../types/api';
import { resolveCachedScopeTabs, type CachedScopeTabs } from './scopeCache';

export interface WorkspaceScopeSnapshot extends CachedScopeTabs<ApiRequest> {
  collections: Collection[];
  environments: Environment[];
  activeEnvironmentId?: string | null;
  history?: HistoryItem[];
}

export interface WorkspaceResourceState {
  collections: Collection[];
  environments: Environment[];
  activeEnvironmentId: string | null;
  tabs: ApiRequest[];
  activeTabId: string;
  history: HistoryItem[];
}

export function snapshotWorkspaceResources(
  resources: WorkspaceResourceState,
  lastSyncedAt?: number | null,
): WorkspaceScopeSnapshot {
  return {
    collections: resources.collections,
    environments: resources.environments,
    activeEnvironmentId: resources.activeEnvironmentId,
    tabs: resources.tabs,
    activeTabId: resources.activeTabId,
    history: resources.history,
    ...(lastSyncedAt !== undefined ? { lastSyncedAt } : {}),
  };
}

export function createEmptyWorkspaceSnapshot(createInitialTab: () => ApiRequest): WorkspaceScopeSnapshot {
  const initialTab = createInitialTab();
  return {
    collections: [],
    environments: [],
    activeEnvironmentId: null,
    tabs: [initialTab],
    activeTabId: initialTab.id,
    history: [],
  };
}

export function restoreWorkspaceResources(
  snapshot: WorkspaceScopeSnapshot | undefined,
  createInitialTab: () => ApiRequest,
): WorkspaceResourceState {
  const source = snapshot ?? createEmptyWorkspaceSnapshot(createInitialTab);
  const { tabs, activeTabId } = resolveCachedScopeTabs(source, createInitialTab);
  return {
    collections: source.collections || [],
    environments: source.environments || [],
    activeEnvironmentId: source.activeEnvironmentId || null,
    tabs,
    activeTabId,
    history: source.history || [],
  };
}
