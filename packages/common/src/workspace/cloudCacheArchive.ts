import type { ActiveScope, CloudConfig, ScopesCacheData, WorkspaceMode } from '../types/api';
import { getScopeCacheKey } from './scopeCache';
import { snapshotWorkspaceResources, type WorkspaceResourceState, type WorkspaceScopeSnapshot } from './scopeSnapshot';

export interface CloudCacheArchive {
  scopeCache: Record<string, WorkspaceScopeSnapshot>;
  scopesCache?: ScopesCacheData;
  /** Kept for recovery when a cloud snapshot cannot be associated with a scope. */
  unscoped?: WorkspaceScopeSnapshot[];
}

export interface CloudCacheArchiveState {
  version: 1;
  owners: Record<string, CloudCacheArchive>;
  /** Preserved for recovery only; never automatically associated with an account. */
  unclaimed: CloudCacheArchive[];
  /** Opaque archives from newer formats, retained across downgrades without opening them. */
  unsupportedVersions?: unknown[];
}

export interface CloudCacheCapture {
  config: CloudConfig;
  workspaceMode: WorkspaceMode;
  scopeCache: Record<string, WorkspaceScopeSnapshot>;
  scopesCache?: ScopesCacheData;
  resources: WorkspaceResourceState;
  lastSyncedAt: number | null;
}

/** The key contains identity metadata only, never credentials. */
export function cloudCacheOwnerKey(
  config: Pick<CloudConfig, 'apiUrl' | 'user'>,
  normalizeApiUrl: (url?: string) => string,
): string | null {
  const userId = config.user?.id;
  if (!userId || !config.apiUrl) return null;
  const apiUrl = normalizeApiUrl(config.apiUrl);
  if (!apiUrl) return null;
  try {
    const parsed = new URL(apiUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  } catch {
    return null;
  }
  return JSON.stringify([apiUrl, userId]);
}

export function emptyCloudCacheArchives(): CloudCacheArchiveState {
  return { version: 1, owners: {}, unclaimed: [] };
}

/** Save the current scope before removing it from the active session. */
export function captureCloudCache(input: CloudCacheCapture): CloudCacheArchive {
  const scopeCache = { ...input.scopeCache };
  let unscoped: WorkspaceScopeSnapshot[] | undefined;
  if (input.workspaceMode === 'cloud' && input.config.activeScope?.id) {
    const key = getScopeCacheKey(input.config.activeScope);
    scopeCache[key] = {
      ...scopeCache[key],
      ...snapshotWorkspaceResources(input.resources, input.lastSyncedAt),
    };
  } else if (input.workspaceMode === 'cloud') {
    unscoped = [snapshotWorkspaceResources(input.resources, input.lastSyncedAt)];
  }
  return { scopeCache, ...(input.scopesCache ? { scopesCache: input.scopesCache } : {}), ...(unscoped ? { unscoped } : {}) };
}

export function archiveCloudCache(
  archives: CloudCacheArchiveState,
  ownerKey: string | null,
  snapshot: CloudCacheArchive,
): CloudCacheArchiveState {
  if (Object.keys(snapshot.scopeCache).length === 0 && !snapshot.scopesCache && !snapshot.unscoped) return archives;
  if (!ownerKey) return { ...archives, unclaimed: [...archives.unclaimed, snapshot] };
  const previousUnscoped = archives.owners[ownerKey]?.unscoped || [];
  const unscoped = [...previousUnscoped, ...(snapshot.unscoped || [])];
  return { ...archives, owners: { ...archives.owners, [ownerKey]: { ...snapshot, ...(unscoped.length ? { unscoped } : {}) } } };
}

export function readCloudCache(
  archives: CloudCacheArchiveState,
  ownerKey: string | null,
): CloudCacheArchive {
  return (ownerKey && archives.owners[ownerKey]) || { scopeCache: {} };
}

export function getArchivedScope(
  archive: CloudCacheArchive,
  scope?: ActiveScope | null,
): WorkspaceScopeSnapshot | undefined {
  return scope?.id ? archive.scopeCache[getScopeCacheKey(scope)] : undefined;
}
