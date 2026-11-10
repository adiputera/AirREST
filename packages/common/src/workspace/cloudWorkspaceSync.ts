import type { Collection, Environment } from '../types/api';
import {
  pullCloudCollections,
  pushPendingCloudCollections,
  type CloudCollectionDetail,
  type PullCloudCollectionsInput,
} from './cloudCollectionSync';

export type CloudWorkspaceSyncResult =
  | {
    status: 'completed';
    collections: Collection[];
    environments: Environment[];
    partialCollectionCount: number;
  }
  | { status: 'cancelled' }
  | { status: 'push_failed'; collection: Collection; error: unknown };

export interface CloudWorkspaceSyncInput<Detail extends CloudCollectionDetail, RawEnvironment> {
  currentCollections: Collection[];
  uploadPendingCollection: (collection: Collection) => Promise<void>;
  fetchCollectionMetadata: PullCloudCollectionsInput<Detail>['fetchMetadata'];
  fetchCollectionDetail: PullCloudCollectionsInput<Detail>['fetchDetail'];
  fetchEnvironments: () => Promise<RawEnvironment[]>;
  buildCollection: PullCloudCollectionsInput<Detail>['buildCollection'];
  buildEnvironments: (environments: RawEnvironment[]) => Environment[];
  isCurrent: () => boolean;
  isAborted: () => boolean;
  onPendingCollectionUploaded: (collection: Collection) => void;
  onCollectionDetailFetchError: PullCloudCollectionsInput<Detail>['onDetailFetchError'];
}

/**
 * Reconciles one cloud workspace through injected I/O operations.
 *
 * It intentionally owns no store state: callers decide how to present progress,
 * errors, and completed resources. That keeps the sync lifecycle reusable by a
 * runtime-specific store without coupling the service to Zustand.
 */
export async function synchronizeCloudWorkspace<Detail extends CloudCollectionDetail, RawEnvironment>(
  input: CloudWorkspaceSyncInput<Detail, RawEnvironment>,
): Promise<CloudWorkspaceSyncResult> {
  const pushed = await pushPendingCloudCollections({
    collections: input.currentCollections,
    upload: input.uploadPendingCollection,
    isCurrent: input.isCurrent,
    isAborted: input.isAborted,
    onUploaded: input.onPendingCollectionUploaded,
  });
  if (pushed.status === 'cancelled') return pushed;
  if (pushed.status === 'failed') {
    return { status: 'push_failed', collection: pushed.collection, error: pushed.error };
  }

  const pulled = await pullCloudCollections({
    currentCollections: input.currentCollections,
    fetchMetadata: input.fetchCollectionMetadata,
    fetchDetail: input.fetchCollectionDetail,
    buildCollection: input.buildCollection,
    isCurrent: input.isCurrent,
    onDetailFetchError: input.onCollectionDetailFetchError,
  });
  if (pulled.status === 'cancelled') return pulled;

  const rawEnvironments = await input.fetchEnvironments();
  if (!input.isCurrent()) return { status: 'cancelled' };

  return {
    status: 'completed',
    collections: pulled.collections,
    environments: input.buildEnvironments(rawEnvironments),
    partialCollectionCount: pulled.partialCollectionCount,
  };
}
