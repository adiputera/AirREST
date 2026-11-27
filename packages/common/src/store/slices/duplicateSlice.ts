import type {
  ActiveScope,
  Collection,
  CollectionItem,
  PendingDuplicateIntent,
  ProjectRole,
} from '../../types/api';
import { CloudApiError, normalizeCloudApiUrl } from '../../lib/cloudApi';
import { buildCollectionFromDetails } from '../../lib/cloudSyncTransformer';
import {
  duplicateCollectionTree,
  duplicateItemSubtree,
  formatImportDuplicateCollectionPayload,
  getTargetFolderDepth,
  insertItemIntoCollectionTree,
  removeItemFromCollectionTree,
} from '../../lib/duplicate';
import {
  collectionHasSavedExamples,
  overlayPendingExampleIntentsOnCollections,
  preserveHydratedItemExamples,
} from '../../lib/examples';
import { canModifyCollection, hasScopePermission } from '../../lib/jwt';
import { findRequestAncestorIds } from '../../lib/treeHelper';
import { cloudCacheOwnerKey } from '../../workspace/cloudCacheArchive';
import { isCloudSessionActive } from '../../workspace/cloudSession';
import { getScopeCacheKey } from '../../workspace/scopeCache';
import { DEFAULT_OFFLINE_WORKSPACE_ID, type ApiStoreState } from '../storeTypes';
import {
  createInitialTab,
  withoutPendingDuplicateIntent,
  withReconcileRequiredIntent,
} from '../storeHelpers';
import type { StoreSliceContext } from '../sliceContext';

export type DuplicateSlice = Pick<
  ApiStoreState,
  | 'clearPendingDuplicateIntent'
  | 'retryPendingDuplicateIntent'
  | 'duplicateCollection'
  | 'duplicateCollectionItem'
>;

export function createDuplicateSlice(ctx: StoreSliceContext): DuplicateSlice {
  const { set, get, isOfflineOnly, allowsOfflineWorkspace, cloudClient, refs, collections, helpers } = ctx;
  const {
    fetchCollectionById: fetchCollectionByIdForRuntime,
    duplicateScopeCollection,
    importDuplicateCollection,
    duplicateScopeItem,
  } = cloudClient;
  const {
    movingCollections,
    duplicatingCollections,
    collectionSaveSyncQueues,
    inFlightDuplicateOperations,
  } = collections;
  const {
    beginAsyncOperation,
    completeAsyncOperation,
    isAsyncOperationCurrent,
  } = helpers;

  const markDuplicateOperationInFlight = (targetOpId: string) => {
    inFlightDuplicateOperations.add(targetOpId);
    set((state) => ({
      activeDuplicateOperationIds: {
        ...(state.activeDuplicateOperationIds || {}),
        [targetOpId]: true,
      },
    }));
  };

  const clearDuplicateOperationInFlight = (targetOpId: string) => {
    inFlightDuplicateOperations.delete(targetOpId);
    if (refs.isStoreDisposed) return;
    set((state) => {
      if (!state.activeDuplicateOperationIds?.[targetOpId]) return state;
      const next = { ...state.activeDuplicateOperationIds };
      delete next[targetOpId];
      return { activeDuplicateOperationIds: next };
    });
  };

  return {
    clearPendingDuplicateIntent: (operationId) => {
      if (inFlightDuplicateOperations.has(operationId) || get().activeDuplicateOperationIds?.[operationId]) {
        return;
      }
      set((state) => {
        if (!state.pendingDuplicateIntents?.[operationId]) return state;
        return { pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, operationId) };
      });
    },

    retryPendingDuplicateIntent: async (operationId) => {
      if (inFlightDuplicateOperations.has(operationId) || get().activeDuplicateOperationIds?.[operationId]) {
        return {
          success: false,
          operationId,
          reconcilePending: true,
          error: 'Duplicate operation is already in progress.',
        };
      }
      const intent = get().pendingDuplicateIntents?.[operationId];
      if (!intent) {
        return { success: false, error: 'Pending duplicate intent not found.' };
      }
      const currentOwner = cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl);
      if (intent.ownerKey !== null && intent.ownerKey !== currentOwner) {
        return { success: false, error: 'This pending duplicate belongs to a different cloud account.' };
      }
      if (intent.kind === 'item') {
        if (!intent.targetCollectionId) {
          return { success: false, error: 'Pending item duplicate intent is missing target collection.' };
        }
        return get().duplicateCollectionItem(
          intent.sourceCollectionId,
          intent.sourceItemId || '',
          intent.targetCollectionId,
          intent.targetParentId ?? null,
          { operationId: intent.operationId },
        );
      }
      if (!intent.targetScope) {
        return { success: false, error: 'Pending collection duplicate intent is missing target scope.' };
      }
      return get().duplicateCollection(intent.sourceCollectionId, intent.targetScope, {
        operationId: intent.operationId,
      });
    },

    duplicateCollection: async (collectionId, targetScope, actionOptions) => {
      const flushPersisted = async () => {
        await get().persistStoreState();
      };
      const findCollectionNodePath = (col: Collection): string[] => [col.id];
      const stateAtStart = get();
      const {
        workspaceMode,
        collections: storeCols,
        cloudConfig,
        offlineWorkspaces,
        activeOfflineWorkspaceId,
      } = stateAtStart;

      const existingIntent = actionOptions?.operationId
        ? stateAtStart.pendingDuplicateIntents?.[actionOptions.operationId]
        : undefined;
      const currentOwnerKey = isCloudSessionActive(cloudConfig)
        ? cloudCacheOwnerKey(cloudConfig, normalizeCloudApiUrl)
        : null;

      const resolveReceiptScopeKey = (
        receipt: { workspace_id?: string | null; project_id?: string | null },
        fallbackScopeKey: string,
      ): string => {
        if (receipt.workspace_id) return `workspace:${receipt.workspace_id}`;
        if (receipt.project_id) return `project:${receipt.project_id}`;
        return fallbackScopeKey;
      };

      const resolveReceiptTargetScope = (
        receipt: { workspace_id?: string | null; project_id?: string | null },
        fallbackScope: ActiveScope,
      ): ActiveScope => {
        if (receipt.workspace_id) {
          return fallbackScope.type === 'workspace' && fallbackScope.id === receipt.workspace_id
            ? fallbackScope
            : { id: receipt.workspace_id, name: fallbackScope.name, type: 'workspace' };
        }
        if (receipt.project_id) {
          return fallbackScope.type === 'project' && fallbackScope.id === receipt.project_id
            ? fallbackScope
            : { id: receipt.project_id, name: fallbackScope.name, type: 'project' };
        }
        return fallbackScope;
      };

      // Shared reconciliation for a committed/replayed collection duplicate receipt (import_duplicate or collection).
      const finalizeCommittedCollectionReceipt = async (
        opId: string,
        receipt: {
          collection_id: string;
          workspace_id?: string | null;
          project_id?: string | null;
          name: string;
          min_role: ProjectRole;
          version: number;
          status: string;
        },
        fallbackTargetScope: ActiveScope,
        capturedSessionGen: number,
        ownerKey: string,
        operationSignal: AbortSignal,
        checkActiveOp: () => boolean,
      ): Promise<ReturnType<ApiStoreState['duplicateCollection']> extends Promise<infer R> ? R : never> => {
        const fallbackScopeKey = getScopeCacheKey(fallbackTargetScope);
        const authoritativeScopeKey = resolveReceiptScopeKey(receipt, fallbackScopeKey);
        const resolvedTargetScope = resolveReceiptTargetScope(receipt, fallbackTargetScope);

        const latestState = get();
        const latestActiveScopeKey =
          latestState.workspaceMode === 'cloud' && latestState.cloudConfig.activeScope
            ? getScopeCacheKey(latestState.cloudConfig.activeScope)
            : null;
        const matchesActiveScope =
          latestActiveScopeKey !== null && latestActiveScopeKey === authoritativeScopeKey;

        const clearAffectedScopeCaches = (
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          baseCache: Record<string, any> | undefined,
          extraScopeKey?: string | null,
        ) => {
          const nextScopeCache = { ...(baseCache || {}) };
          delete nextScopeCache[authoritativeScopeKey];
          if (fallbackScopeKey !== authoritativeScopeKey) {
            delete nextScopeCache[fallbackScopeKey];
          }
          if (extraScopeKey && extraScopeKey !== authoritativeScopeKey && extraScopeKey !== fallbackScopeKey) {
            delete nextScopeCache[extraScopeKey];
          }
          return nextScopeCache;
        };

        if (receipt.status === 'committed_deleted') {
          set((state) => ({
            pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
            scopeCache: clearAffectedScopeCaches(state.scopeCache),
            syncStatus: 'idle',
            ...(matchesActiveScope
              ? { collections: state.collections.filter((c) => c.id !== receipt.collection_id) }
              : {}),
          }));
          return {
            success: true,
            operationId: opId,
            createdCollectionId: receipt.collection_id,
            targetScope: resolvedTargetScope,
            name: receipt.name,
            minRole: receipt.min_role,
            deletedOnServer: true,
          };
        }

        if (matchesActiveScope && checkActiveOp()) {
          let createdCol: Collection | undefined;
          let rawMatchesActive = true;
          let rawScopeKey: string | null = null;
          let detailsError: string | undefined;
          try {
            const liveCloud = get().cloudConfig;
            const raw = await fetchCollectionByIdForRuntime(
              liveCloud.apiUrl,
              liveCloud.token,
              receipt.collection_id,
              liveCloud.refreshToken,
              operationSignal,
            );
            rawScopeKey = raw?.workspace_id
              ? `workspace:${raw.workspace_id}`
              : raw?.project_id
                ? `project:${raw.project_id}`
                : null;
            if (rawScopeKey && rawScopeKey !== latestActiveScopeKey) {
              rawMatchesActive = false;
            } else {
              createdCol = buildCollectionFromDetails(raw);
            }
          } catch (err: unknown) {
            detailsError = err instanceof Error ? err.message : 'Failed to load collection details.';
            createdCol = {
              id: receipt.collection_id,
              name: receipt.name,
              items: [],
              version: receipt.version,
              minRole: receipt.min_role,
              isPartial: true,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              _origin: 'cloud',
            };
          }
          if (
            !checkActiveOp() ||
            refs.cloudSessionGeneration !== capturedSessionGen ||
            cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) !== ownerKey
          ) {
            if (
              !refs.isStoreDisposed &&
              refs.cloudSessionGeneration === capturedSessionGen &&
              cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === ownerKey
            ) {
              set((state) => ({
                pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
                scopeCache: clearAffectedScopeCaches(state.scopeCache, rawScopeKey),
                syncStatus: 'idle',
              }));
            }
            return { success: false, operationId: opId, error: 'Session or scope changed.' };
          }
          const stateAfterFetch = get();
          const postFetchActiveScopeKey =
            stateAfterFetch.workspaceMode === 'cloud' && stateAfterFetch.cloudConfig.activeScope
              ? getScopeCacheKey(stateAfterFetch.cloudConfig.activeScope)
              : null;
          if (rawMatchesActive && createdCol && postFetchActiveScopeKey === authoritativeScopeKey) {
            set((state) => {
              const filtered = state.collections.filter((c) => c.id !== createdCol!.id);
              return {
                pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
                scopeCache: clearAffectedScopeCaches(state.scopeCache, rawScopeKey),
                collections: [...filtered, createdCol!],
                lastDuplicateReveal: {
                  pathIds: [createdCol!.id],
                  revision: (state.lastDuplicateReveal?.revision ?? 0) + 1,
                },
                syncStatus: 'idle',
              };
            });
            return {
              success: true,
              operationId: opId,
              createdCollectionId: receipt.collection_id,
              targetScope: resolvedTargetScope,
              name: createdCol.name,
              minRole: createdCol.minRole,
              ...(detailsError ? { detailsUnavailable: true, detailsError } : {}),
              revealPathIds: [createdCol.id],
            };
          }
        }

        set((state) => ({
          pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
          scopeCache: clearAffectedScopeCaches(state.scopeCache),
          syncStatus: 'idle',
        }));
        return {
          success: true,
          operationId: opId,
          createdCollectionId: receipt.collection_id,
          targetScope: resolvedTargetScope,
          name: receipt.name,
          minRole: receipt.min_role,
        };
      };

      // Replay path for persisted intents (even if source collection/item disappeared locally after submit).
      if (existingIntent && targetScope.type !== 'offline_workspace') {
        if (isOfflineOnly || !isCloudSessionActive(cloudConfig) || !currentOwnerKey || existingIntent.ownerKey !== currentOwnerKey) {
          return { success: false, error: 'Sign in with the owning cloud account to reconcile this duplicate.' };
        }
        if (existingIntent.kind === 'import_duplicate' && existingIntent.sanitizedPayload) {
          if (inFlightDuplicateOperations.has(existingIntent.operationId)) {
            return {
              success: false,
              operationId: existingIntent.operationId,
              reconcilePending: true,
              error: 'Duplicate operation is already in progress.',
            };
          }
          markDuplicateOperationInFlight(existingIntent.operationId);
          const operation = beginAsyncOperation();
          const capturedSessionGen = refs.cloudSessionGeneration;
          try {
            set({ syncStatus: 'syncing', syncError: null });
            const liveCloudReplay = get().cloudConfig;
            const receipt = await importDuplicateCollection(
              liveCloudReplay.apiUrl,
              liveCloudReplay.token,
              targetScope,
              existingIntent.sanitizedPayload,
              existingIntent.operationId,
              liveCloudReplay.refreshToken,
              operation.controller.signal,
            );
            const stillSameOwner =
              !refs.isStoreDisposed &&
              refs.cloudSessionGeneration === capturedSessionGen &&
              currentOwnerKey !== null &&
              cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
            if (!stillSameOwner) {
              return { success: false, error: 'Session changed', operationId: existingIntent.operationId };
            }
            return await finalizeCommittedCollectionReceipt(
              existingIntent.operationId,
              receipt,
              targetScope,
              capturedSessionGen,
              currentOwnerKey,
              operation.controller.signal,
              () => !refs.isStoreDisposed && isAsyncOperationCurrent(operation),
            );
          } catch (err: unknown) {
            const rejected = err instanceof CloudApiError && [400, 403, 404, 409, 413, 415].includes(err.status);
            const errMsg = err instanceof Error ? err.message : 'Failed to upload duplicated collection';
            const stillSameOwner =
              !refs.isStoreDisposed &&
              refs.cloudSessionGeneration === capturedSessionGen &&
              currentOwnerKey !== null &&
              cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
            if (stillSameOwner) {
              set((state) => ({
                pendingDuplicateIntents: rejected
                  ? withoutPendingDuplicateIntent(state.pendingDuplicateIntents, existingIntent.operationId)
                  : withReconcileRequiredIntent(
                    state.pendingDuplicateIntents,
                    existingIntent.operationId,
                    existingIntent,
                    errMsg,
                  ),
                syncStatus: 'error',
                syncError: errMsg,
              }));
            }
            return {
              success: false,
              operationId: existingIntent.operationId,
              reconcilePending: !rejected,
              error: errMsg,
            };
          } finally {
            completeAsyncOperation(operation);
            clearDuplicateOperationInFlight(existingIntent.operationId);
          }
        }

        if (existingIntent.kind === 'collection') {
          if (inFlightDuplicateOperations.has(existingIntent.operationId) || duplicatingCollections.has(collectionId)) {
            return { success: false, error: 'Another move or duplicate operation is in progress for this collection.' };
          }
          markDuplicateOperationInFlight(existingIntent.operationId);
          const lock = Symbol('collection duplicate replay');
          duplicatingCollections.set(collectionId, lock);
          const operation = beginAsyncOperation();
          const capturedSessionGen = refs.cloudSessionGeneration;
          try {
            set({ syncStatus: 'syncing', syncError: null });
            const liveCloudDup = get().cloudConfig;
            const receipt = await duplicateScopeCollection(
              liveCloudDup.apiUrl,
              liveCloudDup.token,
              existingIntent.sourceCollectionId,
              targetScope,
              existingIntent.operationId,
              liveCloudDup.refreshToken,
              operation.controller.signal,
            );
            const stillSameOwner =
              !refs.isStoreDisposed &&
              refs.cloudSessionGeneration === capturedSessionGen &&
              currentOwnerKey !== null &&
              cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
            if (!stillSameOwner) {
              return { success: false, error: 'Session changed.', operationId: existingIntent.operationId };
            }
            return await finalizeCommittedCollectionReceipt(
              existingIntent.operationId,
              receipt,
              targetScope,
              capturedSessionGen,
              currentOwnerKey,
              operation.controller.signal,
              () => !refs.isStoreDisposed && isAsyncOperationCurrent(operation),
            );
          } catch (err: unknown) {
            const rejected = err instanceof CloudApiError && [400, 403, 404, 409, 413].includes(err.status);
            const errMsg = err instanceof Error ? err.message : 'Failed to duplicate collection';
            const stillSameOwner =
              !refs.isStoreDisposed &&
              refs.cloudSessionGeneration === capturedSessionGen &&
              currentOwnerKey !== null &&
              cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
            if (stillSameOwner) {
              set((state) => ({
                pendingDuplicateIntents: rejected
                  ? withoutPendingDuplicateIntent(state.pendingDuplicateIntents, existingIntent.operationId)
                  : withReconcileRequiredIntent(
                    state.pendingDuplicateIntents,
                    existingIntent.operationId,
                    existingIntent,
                    errMsg,
                  ),
                syncStatus: 'error',
                syncError: errMsg,
              }));
            }
            return {
              success: false,
              operationId: existingIntent.operationId,
              reconcilePending: !rejected,
              error: errMsg,
            };
          } finally {
            completeAsyncOperation(operation);
            clearDuplicateOperationInFlight(existingIntent.operationId);
            if (duplicatingCollections.get(collectionId) === lock) {
              duplicatingCollections.delete(collectionId);
            }
          }
        }
      }

      const sourceCol = storeCols.find((c) => c.id === collectionId);
      if (!sourceCol) {
        return { success: false, error: 'Source collection not found.' };
      }
      if (sourceCol._needsMoveReconciliation) {
        return { success: false, error: 'Sync the workspace to confirm the previous move before duplicating.' };
      }

      // 1. Target is an offline workspace
      if (targetScope.type === 'offline_workspace') {
        if (!allowsOfflineWorkspace) {
          return { success: false, error: 'Offline workspaces are disabled for this product.' };
        }
        if (workspaceMode === 'cloud') {
          return { success: false, error: 'Duplicating cloud collections to offline workspaces is not supported.' };
        }
        const targetExists = (offlineWorkspaces || []).some((w) => w.id === targetScope.id);
        if (!targetExists) {
          return { success: false, error: 'Target offline workspace no longer exists.' };
        }

        let cloned: Collection;
        try {
          cloned = duplicateCollectionTree(sourceCol, {
            sameContainer: targetScope.id === activeOfflineWorkspaceId,
            targetOrigin: 'offline',
          });
        } catch (err: unknown) {
          return { success: false, error: err instanceof Error ? err.message : 'Invalid collection for duplication.' };
        }

        const hadTargetCacheBefore = Boolean((get().offlineScopeCache || {})[targetScope.id]);
        const prevReveal = get().lastDuplicateReveal;
        const isSameOfflineWs = targetScope.id === activeOfflineWorkspaceId;
        let appliedRevealRevision: number | null = null;

        if (isSameOfflineWs) {
          set((state) => {
            appliedRevealRevision = (state.lastDuplicateReveal?.revision ?? 0) + 1;
            return {
              collections: [...state.collections, cloned],
              lastDuplicateReveal: {
                pathIds: findCollectionNodePath(cloned),
                revision: appliedRevealRevision,
              },
            };
          });
        } else {
          set((state) => {
            const prevCache = state.offlineScopeCache || {};
            const targetEntry = prevCache[targetScope.id] || {
              collections: [],
              environments: [],
              activeEnvironmentId: null,
              tabs: [createInitialTab()],
              history: [],
            };
            return {
              offlineScopeCache: {
                ...prevCache,
                [targetScope.id]: {
                  ...targetEntry,
                  collections: [...(targetEntry.collections || []), cloned],
                },
              },
            };
          });
        }

        try {
          await flushPersisted();
        } catch {
          // Roll back only the newly created clone by ID from the target workspace's latest state.
          set((state) => {
            const isTargetActive =
              state.workspaceMode === 'offline' && state.activeOfflineWorkspaceId === targetScope.id;
            const prevCache = state.offlineScopeCache || {};
            let nextOfflineCache = prevCache;
            if (prevCache[targetScope.id]) {
              const filteredCachedCollections = (prevCache[targetScope.id].collections || []).filter(
                (c) => c.id !== cloned.id,
              );
              if (
                !isTargetActive &&
                !hadTargetCacheBefore &&
                filteredCachedCollections.length === 0 &&
                (prevCache[targetScope.id].environments || []).length === 0 &&
                (prevCache[targetScope.id].history || []).length === 0
              ) {
                nextOfflineCache = { ...prevCache };
                delete nextOfflineCache[targetScope.id];
              } else {
                nextOfflineCache = {
                  ...prevCache,
                  [targetScope.id]: {
                    ...prevCache[targetScope.id],
                    collections: filteredCachedCollections,
                  },
                };
              }
            }
            const nextReveal =
              appliedRevealRevision !== null && state.lastDuplicateReveal?.revision === appliedRevealRevision
                ? prevReveal
                : state.lastDuplicateReveal;
            return {
              ...(isTargetActive
                ? { collections: state.collections.filter((c) => c.id !== cloned.id) }
                : {}),
              offlineScopeCache: nextOfflineCache,
              lastDuplicateReveal: nextReveal,
            };
          });
          return { success: false, error: 'Failed to persist duplicated collection to local storage.' };
        }

        return {
          success: true,
          createdCollectionId: cloned.id,
          targetScope,
          name: cloned.name,
          minRole: cloned.minRole,
          ...(isSameOfflineWs ? { revealPathIds: [cloned.id] } : {}),
        };
      }

      // 2. Cloud targets require cloud policy and active session
      if (isOfflineOnly) {
        return { success: false, error: 'Offline edition cannot duplicate collections to cloud workspaces.' };
      }
      if (!isCloudSessionActive(cloudConfig) || !currentOwnerKey) {
        return { success: false, error: 'Cloud authentication required to duplicate to a cloud workspace.' };
      }

      // 2a. Offline -> Cloud upload duplicate
      if (workspaceMode === 'offline') {
        if (
          targetScope.type === 'project' &&
          !hasScopePermission(targetScope, 'collection:write', 'cloud', cloudConfig.user?.role)
        ) {
          return { success: false, error: 'Write permission in the target project is required.' };
        }
        if (collectionHasSavedExamples(sourceCol)) {
          const supported = await helpers.ensureSavedExamplesCapability(true);
          if (!supported) {
            return {
              success: false,
              error: 'This cloud server does not support Saved Examples. Update the server before uploading collections with examples.',
            };
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let sanitizedPayload: { name: string; description?: string; items: any[] };
        try {
          const sanitizedCol = duplicateCollectionTree(sourceCol, {
            sameContainer: false,
            targetOrigin: 'cloud',
            sanitizeForCloud: true,
          });
          sanitizedPayload = formatImportDuplicateCollectionPayload(sanitizedCol);
        } catch (err: unknown) {
          return { success: false, error: err instanceof Error ? err.message : 'Invalid collection for cloud upload.' };
        }

        const opId = actionOptions?.operationId || crypto.randomUUID();
        if (inFlightDuplicateOperations.has(opId)) {
          return {
            success: false,
            operationId: opId,
            reconcilePending: true,
            error: 'Duplicate operation is already in progress.',
          };
        }
        const intent: PendingDuplicateIntent = {
          operationId: opId,
          ownerKey: currentOwnerKey,
          kind: 'import_duplicate',
          sourceCollectionId: sourceCol.id,
          sourceName: sourceCol.name,
          sourceOfflineWorkspaceId: activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID,
          targetScope,
          sanitizedPayload,
          createdAt: Date.now(),
          status: 'pending',
        };

        const operation = beginAsyncOperation();
        const capturedSessionGen = refs.cloudSessionGeneration;
        markDuplicateOperationInFlight(opId);
        set((state) => ({
          pendingDuplicateIntents: { ...(state.pendingDuplicateIntents || {}), [opId]: intent },
        }));
        try {
          try {
            await flushPersisted();
          } catch {
            set((state) => ({
              pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
            }));
            return { success: false, error: 'Failed to persist duplicate intent before uploading.' };
          }

          const stillValidBeforeUpload =
            !refs.isStoreDisposed &&
            isAsyncOperationCurrent(operation) &&
            refs.cloudSessionGeneration === capturedSessionGen &&
            isCloudSessionActive(get().cloudConfig) &&
            cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
          if (!stillValidBeforeUpload) {
            set((state) => ({
              pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
            }));
            return { success: false, operationId: opId, error: 'Session or scope changed.' };
          }

          try {
            set({ syncStatus: 'syncing', syncError: null });
            const liveCloudImpDup = get().cloudConfig;
            const receipt = await importDuplicateCollection(
              liveCloudImpDup.apiUrl,
              liveCloudImpDup.token,
              targetScope,
              sanitizedPayload,
              opId,
              liveCloudImpDup.refreshToken,
              operation.controller.signal,
            );
            const stillSameOwner =
              !refs.isStoreDisposed &&
              refs.cloudSessionGeneration === capturedSessionGen &&
              cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
            if (!stillSameOwner) {
              return { success: false, operationId: opId, error: 'Session changed' };
            }
            return await finalizeCommittedCollectionReceipt(
              opId,
              receipt,
              targetScope,
              capturedSessionGen,
              currentOwnerKey,
              operation.controller.signal,
              () =>
                !refs.isStoreDisposed &&
                refs.cloudSessionGeneration === capturedSessionGen &&
                cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey,
            );
          } catch (err: unknown) {
            const rejected = err instanceof CloudApiError && [400, 401, 403, 404, 409, 413, 415].includes(err.status);
            const errMsg = err instanceof Error ? err.message : 'Failed to upload duplicated collection';
            const stillSameOwner =
              !refs.isStoreDisposed &&
              refs.cloudSessionGeneration === capturedSessionGen &&
              cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
            if (stillSameOwner) {
              set((state) => ({
                pendingDuplicateIntents: rejected
                  ? withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId)
                  : withReconcileRequiredIntent(state.pendingDuplicateIntents, opId, intent, errMsg),
                syncStatus: 'error',
                syncError: errMsg,
              }));
            }
            return {
              success: false,
              operationId: opId,
              reconcilePending: !rejected,
              error: errMsg,
            };
          }
        } finally {
          completeAsyncOperation(operation);
          clearDuplicateOperationInFlight(opId);
        }
      }

      // 2b. Cloud -> Cloud duplicate
      const activeScope = cloudConfig.activeScope;
      if (!activeScope) {
        return { success: false, error: 'No active cloud workspace selected.' };
      }
      if (activeScope.type === 'project' && targetScope.type === 'workspace') {
        return { success: false, error: 'Collections in projects cannot be duplicated to personal workspaces.' };
      }
      if (!canModifyCollection(sourceCol.minRole, activeScope, 'cloud', cloudConfig.user?.role)) {
        return { success: false, error: 'Write access to the source collection is required.' };
      }
      if (
        targetScope.type === 'project' &&
        !hasScopePermission(targetScope, 'collection:write', 'cloud', cloudConfig.user?.role)
      ) {
        return { success: false, error: 'Write permission in the target project is required.' };
      }
      if (refs.activePullOperation && isAsyncOperationCurrent(refs.activePullOperation)) {
        return { success: false, error: 'Wait for workspace sync to finish before duplicating.' };
      }
      if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
        return { success: false, error: 'Another move or duplicate operation is in progress for this collection.' };
      }

      const opId = existingIntent?.operationId || actionOptions?.operationId || crypto.randomUUID();
      if (inFlightDuplicateOperations.has(opId)) {
        return {
          success: false,
          operationId: opId,
          reconcilePending: true,
          error: 'Duplicate operation is already in progress.',
        };
      }
      const lock = Symbol('collection duplicate');
      duplicatingCollections.set(collectionId, lock);
      const operation = beginAsyncOperation();
      const capturedSessionGen = refs.cloudSessionGeneration;
      const intent: PendingDuplicateIntent = existingIntent || {
        operationId: opId,
        ownerKey: currentOwnerKey,
        kind: 'collection',
        sourceCollectionId: collectionId,
        sourceName: sourceCol.name,
        sourceScope: activeScope,
        targetScope,
        createdAt: Date.now(),
        status: 'pending',
      };

      markDuplicateOperationInFlight(opId);
      try {
        await collectionSaveSyncQueues.get(`${activeScope.type}:${activeScope.id}:${collectionId}`);
        if (!isAsyncOperationCurrent(operation)) {
          return { success: false, error: 'Operation cancelled.' };
        }
        const latestCol = get().collections.find((c) => c.id === collectionId);
        if (!latestCol) {
          return { success: false, error: 'Source collection not found.' };
        }
        if (latestCol._syncStatus === 'pending' || latestCol._needsMoveReconciliation) {
          return { success: false, error: 'Sync pending changes in this collection before duplicating.' };
        }

        set((state) => ({
          pendingDuplicateIntents: { ...(state.pendingDuplicateIntents || {}), [opId]: intent },
        }));
        try {
          await flushPersisted();
        } catch {
          set((state) => ({
            pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
          }));
          return { success: false, error: 'Failed to persist duplicate intent.' };
        }

        if (
          !isAsyncOperationCurrent(operation) ||
          refs.cloudSessionGeneration !== capturedSessionGen ||
          cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) !== currentOwnerKey
        ) {
          set((state) => ({
            pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
          }));
          return { success: false, operationId: opId, error: 'Session or scope changed.' };
        }

        set({ syncStatus: 'syncing', syncError: null });
        const liveCloudMainDup = get().cloudConfig;
        const receipt = await duplicateScopeCollection(
          liveCloudMainDup.apiUrl,
          liveCloudMainDup.token,
          collectionId,
          targetScope,
          opId,
          liveCloudMainDup.refreshToken,
          operation.controller.signal,
        );
        const stillSameOwner =
          !refs.isStoreDisposed &&
          refs.cloudSessionGeneration === capturedSessionGen &&
          currentOwnerKey !== null &&
          cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
        if (!stillSameOwner) {
          return { success: false, operationId: opId, error: 'Session changed.' };
        }

        return await finalizeCommittedCollectionReceipt(
          opId,
          receipt,
          targetScope,
          capturedSessionGen,
          currentOwnerKey,
          operation.controller.signal,
          () => isAsyncOperationCurrent(operation),
        );
      } catch (err: unknown) {
        const rejected = err instanceof CloudApiError && [400, 401, 403, 404, 409, 413].includes(err.status);
        const errMsg = err instanceof Error ? err.message : 'Failed to duplicate collection';
        const stillSameOwner =
          !refs.isStoreDisposed &&
          refs.cloudSessionGeneration === capturedSessionGen &&
          currentOwnerKey !== null &&
          cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
        if (stillSameOwner) {
          set((state) => ({
            pendingDuplicateIntents: rejected
              ? withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId)
              : withReconcileRequiredIntent(state.pendingDuplicateIntents, opId, intent, errMsg),
            syncStatus: 'error',
            syncError: errMsg,
          }));
        }
        return {
          success: false,
          operationId: opId,
          reconcilePending: !rejected,
          error: errMsg,
        };
      } finally {
        completeAsyncOperation(operation);
        clearDuplicateOperationInFlight(opId);
        if (duplicatingCollections.get(collectionId) === lock) {
          duplicatingCollections.delete(collectionId);
        }
      }
    },

    duplicateCollectionItem: async (sourceCollectionId, itemId, targetCollectionId, targetParentId, actionOptions) => {
      const flushPersisted = async () => {
        await get().persistStoreState();
      };
      const findSavedItemInTree = (items: CollectionItem[]): CollectionItem | null => {
        for (const it of items) {
          if (it.id === itemId || (it.type === 'request' && it.request?.id === itemId)) {
            return it;
          }
          if (it.type === 'folder' && Array.isArray(it.items)) {
            const found = findSavedItemInTree(it.items);
            if (found) return found;
          }
        }
        return null;
      };
      const findFolderRevealPath = (items: CollectionItem[], targetId: string): string[] | null => {
        for (const it of items) {
          if (it.id === targetId) return [it.id];
          if (it.type === 'folder' && Array.isArray(it.items)) {
            const sub = findFolderRevealPath(it.items, targetId);
            if (sub) return [it.id, ...sub];
          }
        }
        return null;
      };

      const stateAtStart = get();
      const { workspaceMode, collections: storeCols, cloudConfig, activeOfflineWorkspaceId } = stateAtStart;
      const existingIntent = actionOptions?.operationId
        ? stateAtStart.pendingDuplicateIntents?.[actionOptions.operationId]
        : undefined;
      const currentOwnerKey = cloudCacheOwnerKey(cloudConfig, normalizeCloudApiUrl);

      // Shared reconciliation once duplicateScopeItem commits on the server.
      // Post-commit GET failures must never turn a committed server mutation into a failure.
      const finalizeCommittedItemReceipt = async (
        opId: string,
        receipt: {
          root_item_id: string;
          target_collection_id: string;
          target_parent_id?: string | null;
          target_collection_version: number;
          name: string;
          status: string;
        },
        capturedSessionGen: number,
        ownerKey: string,
        operationSignal: AbortSignal,
        checkActiveOp: () => boolean,
      ): Promise<ReturnType<ApiStoreState['duplicateCollectionItem']> extends Promise<infer R> ? R : never> => {
        if (receipt.status === 'committed_deleted') {
          set((state) => ({
            pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
            syncStatus: 'idle',
          }));
          return {
            success: true,
            operationId: opId,
            createdItemId: receipt.root_item_id,
            targetCollectionId: receipt.target_collection_id,
            targetParentId: receipt.target_parent_id ?? null,
            name: receipt.name,
            deletedOnServer: true,
          };
        }

        let refreshedTargetCol: Collection | null = null;
        let rawMatchesActiveScope = true;
        let rawScopeKey: string | null = null;
        let detailsError: string | undefined;
        try {
          const liveCloudItemGet = get().cloudConfig;
          const rawTargetCol = await fetchCollectionByIdForRuntime(
            liveCloudItemGet.apiUrl,
            liveCloudItemGet.token,
            receipt.target_collection_id,
            liveCloudItemGet.refreshToken,
            operationSignal,
          );
          const activeScopeNow = get().cloudConfig.activeScope;
          const activeScopeKeyNow =
            get().workspaceMode === 'cloud' && activeScopeNow ? getScopeCacheKey(activeScopeNow) : null;
          rawScopeKey = rawTargetCol?.workspace_id
            ? `workspace:${rawTargetCol.workspace_id}`
            : rawTargetCol?.project_id
              ? `project:${rawTargetCol.project_id}`
              : null;
          if (rawScopeKey && (!activeScopeKeyNow || rawScopeKey !== activeScopeKeyNow)) {
            rawMatchesActiveScope = false;
          } else {
            refreshedTargetCol = buildCollectionFromDetails(rawTargetCol);
          }
        } catch (err: unknown) {
          refreshedTargetCol = null;
          detailsError = err instanceof Error ? err.message : 'Failed to load target collection details.';
        }

        if (
          !checkActiveOp() ||
          refs.cloudSessionGeneration !== capturedSessionGen ||
          cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) !== ownerKey
        ) {
          if (
            !refs.isStoreDisposed &&
            refs.cloudSessionGeneration === capturedSessionGen &&
            cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === ownerKey
          ) {
            set((state) => {
              const nextScopeCache = { ...(state.scopeCache || {}) };
              for (const [k, entry] of Object.entries(nextScopeCache)) {
                if (k === rawScopeKey || entry?.collections?.some((c) => c.id === receipt.target_collection_id)) {
                  delete nextScopeCache[k];
                }
              }
              return {
                pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
                scopeCache: nextScopeCache,
                syncStatus: 'idle',
              };
            });
          }
          return { success: false, operationId: opId, error: 'Session or scope changed.' };
        }

        if (refreshedTargetCol && rawMatchesActiveScope) {
          const revealFromReq = findRequestAncestorIds([refreshedTargetCol], receipt.root_item_id);
          const revealIds = revealFromReq.length > 0
            ? revealFromReq
            : [
              refreshedTargetCol.id,
              ...(findFolderRevealPath(refreshedTargetCol.items || [], receipt.root_item_id) || []),
            ];

          set((state) => {
            const existingTarget = state.collections.find((c) => c.id === refreshedTargetCol!.id);
            const preservedTarget = existingTarget
              ? {
                ...refreshedTargetCol!,
                items: preserveHydratedItemExamples(refreshedTargetCol!.items || [], existingTarget.items || []),
              }
              : refreshedTargetCol!;
            const updatedTarget = existingTarget
              ? state.collections.map((c) => (c.id === preservedTarget.id ? preservedTarget : c))
              : state.collections;
            const nextCollections = overlayPendingExampleIntentsOnCollections(
              updatedTarget,
              state.pendingExampleIntents,
              ownerKey,
              state.cloudConfig.activeScope,
            );
            return {
              pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
              collections: nextCollections,
              lastDuplicateReveal: {
                pathIds: revealIds,
                revision: (state.lastDuplicateReveal?.revision ?? 0) + 1,
              },
              syncStatus: 'idle',
            };
          });

          return {
            success: true,
            operationId: opId,
            createdItemId: receipt.root_item_id,
            targetCollectionId: receipt.target_collection_id,
            targetParentId: receipt.target_parent_id ?? null,
            name: receipt.name,
            revealPathIds: revealIds,
          };
        }

        // Server commit succeeded, but post-commit GET failed or collection belongs to an inactive scope.
        set((state) => {
          const nextScopeCache =
            !rawMatchesActiveScope && rawScopeKey && state.scopeCache?.[rawScopeKey]
              ? (() => {
                const copy = { ...(state.scopeCache || {}) };
                delete copy[rawScopeKey!];
                return copy;
              })()
              : state.scopeCache;
          return {
            pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
            scopeCache: nextScopeCache,
            collections:
              rawMatchesActiveScope && state.workspaceMode === 'cloud'
                ? state.collections.map((c) =>
                  c.id === receipt.target_collection_id
                    ? {
                      ...c,
                      version: receipt.target_collection_version ?? c.version,
                      isPartial: true,
                      updatedAt: Date.now(),
                    }
                    : c,
                )
                : state.collections,
            syncStatus: 'idle',
          };
        });

        return {
          success: true,
          operationId: opId,
          createdItemId: receipt.root_item_id,
          targetCollectionId: receipt.target_collection_id,
          targetParentId: receipt.target_parent_id ?? null,
          name: receipt.name,
          ...(detailsError ? { detailsUnavailable: true, detailsError } : {}),
        };
      };

      // Replay path for persisted item duplicate intents even if source item/collection changed locally.
      if (existingIntent && existingIntent.kind === 'item') {
        if (isOfflineOnly || !isCloudSessionActive(cloudConfig) || !currentOwnerKey) {
          return { success: false, error: 'Sign in before duplicating cloud items.' };
        }
        if (existingIntent.ownerKey !== currentOwnerKey) {
          return { success: false, error: 'This pending duplicate belongs to a different cloud account.' };
        }
        if (refs.activePullOperation && isAsyncOperationCurrent(refs.activePullOperation)) {
          return { success: false, error: 'Wait for workspace sync to finish before duplicating items.' };
        }
        const replaySourceColId = existingIntent.sourceCollectionId;
        const replayTargetColId = existingIntent.targetCollectionId || targetCollectionId;
        const replayIds = [...new Set([replaySourceColId, replayTargetColId])];
        if (inFlightDuplicateOperations.has(existingIntent.operationId) || replayIds.some((id) => movingCollections.has(id) || duplicatingCollections.has(id))) {
          return { success: false, error: 'A move or duplicate operation is already in progress for this collection.' };
        }
        markDuplicateOperationInFlight(existingIntent.operationId);
        const lock = Symbol('item duplicate replay');
        replayIds.forEach((id) => duplicatingCollections.set(id, lock));
        const operation = beginAsyncOperation();
        const capturedSessionGen = refs.cloudSessionGeneration;
        try {
          set({ syncStatus: 'syncing', syncError: null });
          const liveCloudItemReplay = get().cloudConfig;
          const receipt = await duplicateScopeItem(
            liveCloudItemReplay.apiUrl,
            liveCloudItemReplay.token,
            existingIntent.sourceItemId || itemId,
            replaySourceColId,
            replayTargetColId,
            existingIntent.targetParentId ?? targetParentId,
            existingIntent.operationId,
            liveCloudItemReplay.refreshToken,
            operation.controller.signal,
          );
          const stillSameOwner =
            !refs.isStoreDisposed &&
            refs.cloudSessionGeneration === capturedSessionGen &&
            currentOwnerKey !== null &&
            cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
          if (!stillSameOwner) {
            return { success: false, operationId: existingIntent.operationId, error: 'Session changed.' };
          }
          return await finalizeCommittedItemReceipt(
            existingIntent.operationId,
            receipt,
            capturedSessionGen,
            currentOwnerKey,
            operation.controller.signal,
            () => isAsyncOperationCurrent(operation),
          );
        } catch (err: unknown) {
          const rejected = err instanceof CloudApiError && [400, 403, 404, 409, 413].includes(err.status);
          const errMsg = err instanceof Error ? err.message : 'Failed to duplicate item';
          const stillSameOwner =
            !refs.isStoreDisposed &&
            refs.cloudSessionGeneration === capturedSessionGen &&
            currentOwnerKey !== null &&
            cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
          if (stillSameOwner) {
            set((state) => ({
              pendingDuplicateIntents: rejected
                ? withoutPendingDuplicateIntent(state.pendingDuplicateIntents, existingIntent.operationId)
                : withReconcileRequiredIntent(
                  state.pendingDuplicateIntents,
                  existingIntent.operationId,
                  existingIntent,
                  errMsg,
                ),
              syncStatus: 'error',
              syncError: errMsg,
            }));
          }
          return {
            success: false,
            operationId: existingIntent.operationId,
            reconcilePending: !rejected,
            error: errMsg,
          };
        } finally {
          completeAsyncOperation(operation);
          clearDuplicateOperationInFlight(existingIntent.operationId);
          replayIds.forEach((id) => {
            if (duplicatingCollections.get(id) === lock) duplicatingCollections.delete(id);
          });
        }
      }

      const sourceCol = storeCols.find((c) => c.id === sourceCollectionId);
      const targetCol = storeCols.find((c) => c.id === targetCollectionId);
      if (!sourceCol) return { success: false, error: 'Source collection not found.' };
      if (!targetCol) return { success: false, error: 'Target collection not found.' };
      if (sourceCol._needsMoveReconciliation || targetCol._needsMoveReconciliation) {
        return { success: false, error: 'Sync the workspace to confirm the previous move before duplicating.' };
      }
      if (sourceCol.isPartial || targetCol.isPartial) {
        return { success: false, error: 'Load collection details before duplicating.' };
      }
      if (!canModifyCollection(sourceCol.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
        return { success: false, error: 'Write access to the source collection is required.' };
      }
      if (!canModifyCollection(targetCol.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
        return { success: false, error: 'Write access to the target collection is required.' };
      }

      const savedItem = findSavedItemInTree(sourceCol.items || []);
      if (!savedItem) {
        return { success: false, error: 'Item not found in source collection.' };
      }

      const targetParentDepth = getTargetFolderDepth(targetCol.items || [], targetParentId);
      if (targetParentDepth === null) {
        return { success: false, error: 'Target folder not found in target collection.' };
      }

      // 1. Offline item duplicate
      if (workspaceMode !== 'cloud') {
        let clonedItem: CollectionItem;
        try {
          clonedItem = duplicateItemSubtree(savedItem, {
            sameCollection: sourceCollectionId === targetCollectionId,
            targetParentDepth,
          });
        } catch (err: unknown) {
          return { success: false, error: err instanceof Error ? err.message : 'Invalid item for duplication.' };
        }

        const nextTargetItems = insertItemIntoCollectionTree(targetCol.items || [], clonedItem, targetParentId);
        if (!nextTargetItems) {
          return { success: false, error: 'Target folder not found in target collection.' };
        }

        const capturedOfflineWsId = activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
        const prevReveal = get().lastDuplicateReveal;
        let appliedRevealRevision: number | null = null;
        const revealIds = [
          targetCollectionId,
          ...(targetParentId ? (findFolderRevealPath(nextTargetItems, targetParentId) || [targetParentId]) : []),
          ...(clonedItem.type === 'folder' ? [clonedItem.id] : []),
        ];

        set((state) => {
          appliedRevealRevision = (state.lastDuplicateReveal?.revision ?? 0) + 1;
          return {
            collections: state.collections.map((c) =>
              c.id === targetCollectionId
                ? { ...c, items: nextTargetItems, updatedAt: Date.now() }
                : c,
            ),
            lastDuplicateReveal: {
              pathIds: revealIds,
              revision: appliedRevealRevision,
            },
          };
        });

        try {
          await flushPersisted();
        } catch {
          set((state) => {
            const isTargetActive =
              state.workspaceMode === 'offline' &&
              (state.activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID) === capturedOfflineWsId;
            const stripClonedItem = (cols: Collection[]) =>
              cols.map((c) => {
                if (c.id !== targetCollectionId) return c;
                const { items, removed } = removeItemFromCollectionTree(c.items || [], clonedItem.id);
                return removed ? { ...c, items } : c;
              });
            const prevCache = state.offlineScopeCache || {};
            const cachedTarget = prevCache[capturedOfflineWsId];
            const nextOfflineCache = cachedTarget
              ? {
                ...prevCache,
                [capturedOfflineWsId]: {
                  ...cachedTarget,
                  collections: stripClonedItem(cachedTarget.collections || []),
                },
              }
              : prevCache;
            const nextReveal =
              appliedRevealRevision !== null && state.lastDuplicateReveal?.revision === appliedRevealRevision
                ? prevReveal
                : state.lastDuplicateReveal;
            return {
              ...(isTargetActive ? { collections: stripClonedItem(state.collections) } : {}),
              offlineScopeCache: nextOfflineCache,
              lastDuplicateReveal: nextReveal,
            };
          });
          return { success: false, error: 'Failed to persist duplicated item to local storage.' };
        }

        return {
          success: true,
          createdItemId: clonedItem.id,
          targetCollectionId,
          targetParentId,
          name: clonedItem.name,
          revealPathIds: revealIds,
        };
      }

      // 2. Cloud item duplicate (run client validation first so invalid names/depth fail fast without network)
      try {
        duplicateItemSubtree(savedItem, {
          sameCollection: sourceCollectionId === targetCollectionId,
          targetParentDepth,
        });
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : 'Invalid item for duplication.' };
      }

      const scope = cloudConfig.activeScope;
      if (isOfflineOnly || !isCloudSessionActive(cloudConfig) || !scope || !currentOwnerKey) {
        return { success: false, error: 'Sign in before duplicating cloud items.' };
      }
      if (refs.activePullOperation && isAsyncOperationCurrent(refs.activePullOperation)) {
        return { success: false, error: 'Wait for workspace sync to finish before duplicating items.' };
      }

      const ids = [...new Set([sourceCollectionId, targetCollectionId])];
      if (ids.some((id) => movingCollections.has(id) || duplicatingCollections.has(id))) {
        return { success: false, error: 'A move or duplicate operation is already in progress for this collection.' };
      }

      const opId = actionOptions?.operationId || crypto.randomUUID();
      if (inFlightDuplicateOperations.has(opId)) {
        return {
          success: false,
          operationId: opId,
          reconcilePending: true,
          error: 'Duplicate operation is already in progress.',
        };
      }

      const lock = Symbol('item duplicate');
      ids.forEach((id) => duplicatingCollections.set(id, lock));
      const operation = beginAsyncOperation();
      const capturedSessionGen = refs.cloudSessionGeneration;
      const intent: PendingDuplicateIntent = {
        operationId: opId,
        ownerKey: currentOwnerKey,
        kind: 'item',
        sourceCollectionId,
        sourceItemId: savedItem.id,
        sourceName: savedItem.name,
        sourceItemType: savedItem.type,
        sourceScope: scope,
        targetScope: scope,
        targetCollectionId,
        targetCollectionName: targetCol.name,
        targetParentId,
        createdAt: Date.now(),
        status: 'pending',
      };

      markDuplicateOperationInFlight(opId);
      try {
        await Promise.all(ids.map((id) => collectionSaveSyncQueues.get(`${scope.type}:${scope.id}:${id}`)));
        if (!isAsyncOperationCurrent(operation)) {
          return { success: false, error: 'Operation cancelled.' };
        }
        if (get().collections.some((col) => ids.includes(col.id) && (col._syncStatus === 'pending' || col._needsMoveReconciliation))) {
          return { success: false, error: 'Sync pending changes in both collections before duplicating.' };
        }

        set((state) => ({
          pendingDuplicateIntents: { ...(state.pendingDuplicateIntents || {}), [opId]: intent },
        }));
        try {
          await flushPersisted();
        } catch {
          set((state) => ({
            pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
          }));
          return { success: false, error: 'Failed to persist duplicate intent.' };
        }

        if (
          !isAsyncOperationCurrent(operation) ||
          refs.cloudSessionGeneration !== capturedSessionGen ||
          cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) !== currentOwnerKey
        ) {
          set((state) => ({
            pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
          }));
          return { success: false, operationId: opId, error: 'Session or scope changed.' };
        }

        const liveCloudItemDup = get().cloudConfig;
        const receipt = await duplicateScopeItem(
          liveCloudItemDup.apiUrl,
          liveCloudItemDup.token,
          savedItem.id,
          sourceCollectionId,
          targetCollectionId,
          targetParentId,
          opId,
          liveCloudItemDup.refreshToken,
          operation.controller.signal,
        );
        const stillSameOwner =
          !refs.isStoreDisposed &&
          refs.cloudSessionGeneration === capturedSessionGen &&
          currentOwnerKey !== null &&
          cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
        if (!stillSameOwner) {
          return { success: false, operationId: opId, error: 'Session changed.' };
        }

        return await finalizeCommittedItemReceipt(
          opId,
          receipt,
          capturedSessionGen,
          currentOwnerKey,
          operation.controller.signal,
          () => isAsyncOperationCurrent(operation),
        );
      } catch (err: unknown) {
        const rejected = err instanceof CloudApiError && [400, 401, 403, 404, 409, 413].includes(err.status);
        const errMsg = err instanceof Error ? err.message : 'Failed to duplicate item';
        const stillSameOwner =
          !refs.isStoreDisposed &&
          refs.cloudSessionGeneration === capturedSessionGen &&
          currentOwnerKey !== null &&
          cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
        if (stillSameOwner) {
          set((state) => ({
            pendingDuplicateIntents: rejected
              ? withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId)
              : withReconcileRequiredIntent(state.pendingDuplicateIntents, opId, intent, errMsg),
            syncStatus: 'error',
            syncError: errMsg,
          }));
        }
        return {
          success: false,
          operationId: opId,
          reconcilePending: !rejected,
          error: errMsg,
        };
      } finally {
        completeAsyncOperation(operation);
        clearDuplicateOperationInFlight(opId);
        ids.forEach((id) => {
          if (duplicatingCollections.get(id) === lock) duplicatingCollections.delete(id);
        });
      }
    },
  };
}
