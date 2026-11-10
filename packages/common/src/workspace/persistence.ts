import type { ActiveScope, ApiRequest, Collection, HistoryItem, WorkspaceMode } from '../types/api';
import { getScopeCacheKey } from './scopeCache';
import type { WorkspaceResourceState, WorkspaceScopeSnapshot } from './scopeSnapshot';
import type { CloudCacheArchiveState } from './cloudCacheArchive';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCloudCacheArchive(value: unknown): value is CloudCacheArchiveState['unclaimed'][number] {
  return isRecord(value) && isRecord(value.scopeCache) &&
    (value.scopesCache === undefined || isRecord(value.scopesCache)) &&
    (value.unscoped === undefined || (Array.isArray(value.unscoped) && value.unscoped.every(isRecord)));
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

export function serializeCloudCacheArchives(
  archives: CloudCacheArchiveState,
  serializers: Pick<WorkspaceCachePersistenceInput, 'serializeRequest' | 'serializeCollection' | 'serializeHistory'>,
): CloudCacheArchiveState {
  const serializeArchive = (entry: CloudCacheArchiveState['unclaimed'][number]) => ({
    ...entry,
    scopeCache: serializeScopeCache(entry.scopeCache, serializers),
    ...(entry.unscoped ? { unscoped: entry.unscoped.map((snapshot) => serializeScopeCache({ unscoped: snapshot }, serializers).unscoped) } : {}),
  });
  return {
    version: 1,
    owners: Object.fromEntries(Object.entries(archives.owners).map(([key, value]) => [key, serializeArchive(value)])),
    unclaimed: archives.unclaimed.map(serializeArchive),
    ...(archives.unsupportedVersions?.length ? { unsupportedVersions: archives.unsupportedVersions } : {}),
  };
}

export function normalizeCloudCacheArchives(
  archives: unknown,
  normalizers: WorkspaceCacheNormalizers,
): CloudCacheArchiveState {
  if (archives === undefined || archives === null) return { version: 1, owners: {}, unclaimed: [] };
  if (!isRecord(archives)) {
    return { version: 1, owners: {}, unclaimed: [], unsupportedVersions: [archives] };
  }

  // The initial archive shape did not write a version. It is structurally
  // compatible with v1, so migrate it in place rather than quarantining data.
  const isLegacyUnversionedArchive = archives.version === undefined &&
    (archives.owners !== undefined || archives.unclaimed !== undefined);
  if (archives.version !== 1 && !isLegacyUnversionedArchive) {
    return { version: 1, owners: {}, unclaimed: [], unsupportedVersions: [archives] };
  }

  const normalizeArchive = (entry: CloudCacheArchiveState['unclaimed'][number]) => ({
    ...entry,
    scopeCache: normalizePersistedWorkspaceScopeCache(entry.scopeCache, normalizers),
    ...(entry.unscoped ? { unscoped: entry.unscoped.map((snapshot) => normalizePersistedWorkspaceScopeCache({ unscoped: snapshot }, normalizers).unscoped) } : {}),
  });
  const owners = isRecord(archives.owners)
    ? Object.fromEntries(Object.entries(archives.owners)
      .filter((entry): entry is [string, CloudCacheArchiveState['unclaimed'][number]] => isCloudCacheArchive(entry[1]))
      .map(([key, value]) => [key, normalizeArchive(value)]))
    : {};
  const unclaimed = Array.isArray(archives.unclaimed)
    ? archives.unclaimed.filter(isCloudCacheArchive).map(normalizeArchive)
    : [];
  const unsupportedVersions = Array.isArray(archives.unsupportedVersions)
    ? archives.unsupportedVersions
    : [];

  return {
    version: 1,
    owners,
    unclaimed,
    ...(unsupportedVersions.length ? { unsupportedVersions } : {}),
  };
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
