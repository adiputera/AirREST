import type { ActiveScope, ApiRequest, Collection, HistoryItem, WorkspaceMode } from '../types/api';
import { getScopeCacheKey } from './scopeCache';
import type { WorkspaceResourceState, WorkspaceScopeSnapshot } from './scopeSnapshot';

export interface WorkspaceCachePersistenceInput {
  workspaceMode: WorkspaceMode;
  activeOfflineWorkspaceId?: string;
  activeCloudScope?: ActiveScope;
  lastSyncedAt: number | null;
  resources: WorkspaceResourceState;
  offlineScopeCache: Record<string, WorkspaceScopeSnapshot>;
  scopeCache: Record<string, WorkspaceScopeSnapshot>;
  serializeRequest: (request: ApiRequest) => ApiRequest;
  serializeCollection: (collection: Collection) => Collection;
  serializeHistory: (history: HistoryItem[]) => HistoryItem[];
}

export interface WorkspaceCacheNormalizers {
  normalizeRequest: (request: ApiRequest) => ApiRequest;
  normalizeCollections: (collections: Collection[]) => Collection[];
  normalizeHistory: (history: HistoryItem[]) => HistoryItem[];
}

function serializeScopeCache(
  cache: Record<string, WorkspaceScopeSnapshot>,
  input: Pick<WorkspaceCachePersistenceInput, 'serializeRequest' | 'serializeCollection' | 'serializeHistory'>,
): Record<string, WorkspaceScopeSnapshot> {
  return Object.fromEntries(Object.entries(cache).map(([key, entry]) => [
    key,
    {
      ...entry,
      tabs: (entry.tabs || []).map(input.serializeRequest),
      collections: (entry.collections || []).map(input.serializeCollection),
      history: input.serializeHistory(entry.history || []),
    },
  ]));
}

export function preparePersistedWorkspaceCaches(
  input: WorkspaceCachePersistenceInput,
): Pick<WorkspaceCachePersistenceInput, 'offlineScopeCache' | 'scopeCache'> {
  let offlineScopeCache = serializeScopeCache(input.offlineScopeCache, input);
  if (input.workspaceMode === 'offline' && input.activeOfflineWorkspaceId) {
    offlineScopeCache = {
      ...offlineScopeCache,
      [input.activeOfflineWorkspaceId]: {
        ...(offlineScopeCache[input.activeOfflineWorkspaceId] || {}),
        collections: input.resources.collections.map(input.serializeCollection),
        environments: input.resources.environments,
        activeEnvironmentId: input.resources.activeEnvironmentId,
        tabs: input.resources.tabs.map(input.serializeRequest),
        activeTabId: input.resources.activeTabId,
        history: input.serializeHistory(input.resources.history),
      },
    };
  }

  let scopeCache = serializeScopeCache(input.scopeCache, input);
  if (input.workspaceMode === 'cloud' && input.activeCloudScope) {
    const scopeKey = getScopeCacheKey(input.activeCloudScope);
    scopeCache = {
      ...scopeCache,
      [scopeKey]: {
        ...(scopeCache[scopeKey] || {}),
        collections: input.resources.collections.map(input.serializeCollection),
        environments: input.resources.environments,
        activeEnvironmentId: input.resources.activeEnvironmentId,
        tabs: input.resources.tabs.map(input.serializeRequest),
        activeTabId: input.resources.activeTabId,
        history: input.serializeHistory(input.resources.history),
        lastSyncedAt: input.lastSyncedAt,
      },
    };
  }

  return { offlineScopeCache, scopeCache };
}

export function normalizePersistedWorkspaceScopeCache(
  cache: Record<string, WorkspaceScopeSnapshot> | undefined,
  normalizers: WorkspaceCacheNormalizers,
): Record<string, WorkspaceScopeSnapshot> {
  return Object.fromEntries(Object.entries(cache || {}).map(([key, entry]) => [
    key,
    {
      ...entry,
      tabs: (entry.tabs || []).map(normalizers.normalizeRequest),
      collections: normalizers.normalizeCollections(entry.collections || []),
      history: normalizers.normalizeHistory(entry.history || []),
    },
  ]));
}
