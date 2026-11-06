import type { Collection } from '../types/api';

export interface CloudCollectionMetadata {
  id: string;
  name: string;
  description?: string;
  min_role?: Collection['minRole'];
  version?: number;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export function isPendingCloudCollection(collection: Collection): boolean {
  return collection._syncStatus === 'pending' ||
    (collection._origin === 'cloud' && typeof collection.version !== 'number');
}

export function reuseUnchangedCloudCollection(
  existing: Collection | undefined,
  metadata: CloudCollectionMetadata,
): Collection | null {
  if (!existing || existing.isPartial) return null;
  const serverUpdatedAt = new Date(metadata.updated_at || 0).getTime();
  const unchanged = (typeof metadata.version === 'number' && existing.version === metadata.version) ||
    (serverUpdatedAt > 0 && existing.updatedAt === serverUpdatedAt);
  if (!unchanged) return null;
  return {
    ...existing,
    name: metadata.name,
    description: metadata.description || '',
    minRole: metadata.min_role || existing.minRole,
    version: metadata.version ?? existing.version,
    updatedAt: serverUpdatedAt || existing.updatedAt,
    _syncStatus: 'synced',
  };
}

export function createPartialCloudCollection(
  metadata: CloudCollectionMetadata,
  existing: Collection | undefined,
  now = Date.now(),
): Collection {
  return {
    id: metadata.id,
    name: metadata.name,
    description: metadata.description || '',
    items: existing?.items || [],
    minRole: metadata.min_role || existing?.minRole || 'reader',
    version: existing?.version,
    createdAt: new Date(metadata.created_at || now).getTime(),
    updatedAt: existing?.updatedAt || 0,
    _origin: 'cloud',
    isPartial: true,
    _syncStatus: 'synced',
  };
}

export function retainPendingCloudCollections(
  localCollections: Collection[],
  serverCollectionIds: Iterable<string>,
): Collection[] {
  const serverIds = new Set(serverCollectionIds);
  return localCollections.filter((collection) =>
    !serverIds.has(collection.id) &&
    (collection._syncStatus === 'pending' || typeof collection.version !== 'number'),
  );
}
