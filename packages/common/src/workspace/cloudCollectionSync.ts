import type { Collection } from '../types/api';
import {
  createPartialCloudCollection,
  isPendingCloudCollection,
  retainPendingCloudCollections,
  reuseUnchangedCloudCollection,
  type CloudCollectionMetadata,
} from './cloudSyncCollections';

export type PendingCollectionPushResult =
  | { status: 'completed' }
  | { status: 'cancelled' }
  | { status: 'failed'; collection: Collection; error: unknown };

export interface PushPendingCloudCollectionsInput {
  collections: Collection[];
  upload: (collection: Collection) => Promise<void>;
  isCurrent: () => boolean;
  isAborted: () => boolean;
  onUploaded: (collection: Collection) => void;
}

/** Uploads local pending collections without deciding how a store presents failures. */
export async function pushPendingCloudCollections(
  input: PushPendingCloudCollectionsInput,
): Promise<PendingCollectionPushResult> {
  for (const collection of input.collections.filter(isPendingCloudCollection)) {
    if (!input.isCurrent()) return { status: 'cancelled' };
    try {
      await input.upload(collection);
      if (!input.isCurrent()) return { status: 'cancelled' };
      input.onUploaded(collection);
    } catch (error) {
      if (input.isAborted() || !input.isCurrent()) return { status: 'cancelled' };
      return { status: 'failed', collection, error };
    }
  }
  return { status: 'completed' };
}

export interface CloudCollectionDetail {
  deleted_at?: string | null;
}

export interface PullCloudCollectionsInput<Detail extends CloudCollectionDetail> {
  currentCollections: Collection[];
  fetchMetadata: () => Promise<CloudCollectionMetadata[]>;
  fetchDetail: (collectionId: string) => Promise<Detail | null | undefined>;
  buildCollection: (detail: Detail) => Collection;
  isCurrent: () => boolean;
  onDetailFetchError?: (metadata: CloudCollectionMetadata, error: unknown) => void;
}

export type PullCloudCollectionsResult =
  | { status: 'completed'; collections: Collection[]; partialCollectionCount: number }
  | { status: 'cancelled' };

/**
 * Reconciles metadata and details for cloud collections. Network operations are injected so
 * this remains independent of the cloud client and the store lifecycle.
 */
export async function pullCloudCollections<Detail extends CloudCollectionDetail>(
  input: PullCloudCollectionsInput<Detail>,
): Promise<PullCloudCollectionsResult> {
  const metadata = await input.fetchMetadata();
  if (!input.isCurrent()) return { status: 'cancelled' };

  const existingById = new Map(input.currentCollections.map((collection) => [collection.id, collection]));
  const collections: Collection[] = [];
  let partialCollectionCount = 0;

  for (const collectionMetadata of metadata) {
    if (collectionMetadata.deleted_at) continue;
    const existing = existingById.get(collectionMetadata.id);
    const cachedCollection = reuseUnchangedCloudCollection(existing, collectionMetadata);
    if (cachedCollection) {
      collections.push(cachedCollection);
      continue;
    }

    try {
      const detail = await input.fetchDetail(collectionMetadata.id);
      if (!input.isCurrent()) return { status: 'cancelled' };
      if (detail && !detail.deleted_at) {
        collections.push({ ...input.buildCollection(detail), _syncStatus: 'synced' });
      }
    } catch (error) {
      if (!input.isCurrent()) return { status: 'cancelled' };
      input.onDetailFetchError?.(collectionMetadata, error);
      partialCollectionCount += 1;
      collections.push(createPartialCloudCollection(collectionMetadata, existing));
    }
  }

  return {
    status: 'completed',
    collections: [
      ...collections,
      ...retainPendingCloudCollections(input.currentCollections, metadata.map((collection) => collection.id)),
    ],
    partialCollectionCount,
  };
}
