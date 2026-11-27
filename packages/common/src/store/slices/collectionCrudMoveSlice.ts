import type { ApiRequest, Collection, CollectionItem, RequestTab } from '../../types/api';
import type { ImportTargetBinding } from '../../lib/importBatch';
import { CloudApiError, normalizeCloudApiUrl } from '../../lib/cloudApi';
import { buildCollectionFromDetails } from '../../lib/cloudSyncTransformer';
import { validateDuplicateName } from '../../lib/duplicate';
import {
  countCollectionSavedExamples,
  collectionHasSavedExamples,
  findCollectionItemById,
  makeExampleTabId,
  overlayPendingExampleIntentsOnCollections,
  preserveHydratedItemExamples,
  syncVisualTabOrder,
} from '../../lib/examples';
import { canModifyCollection, getUserScopeRank, hasScopePermission } from '../../lib/jwt';
import { detectPostmanJsonType, importPostmanCollection } from '../../lib/postman';
import {
  alignCollectionItemIds,
  collectAllItemIds,
  findSavedRequestInCollections,
} from '../../lib/requestDiff';
import { isDescendantOf, reorderItemInTree } from '../../lib/treeHelper';
import { cloudCacheOwnerKey } from '../../workspace/cloudCacheArchive';
import { isCloudSessionActive } from '../../workspace/cloudSession';
import { getScopeCacheKey } from '../../workspace/scopeCache';
import { DEFAULT_OFFLINE_WORKSPACE_ID, type ApiStoreState } from '../storeTypes';
import {
  cloneCollectionPreservingAttachments,
  cloneRequestPreservingAttachments,
  createInitialTab,
  generateId,
  matchesImportTarget,
  prunePendingExampleIntentsForTarget,
} from '../storeHelpers';
import type { StoreSliceContext } from '../sliceContext';

export type CollectionCrudMoveSlice = Pick<
  ApiStoreState,
  | 'createCollection'
  | 'createCollectionAsync'
  | 'renameCollection'
  | 'createFolder'
  | 'createRequestInCollection'
  | 'deleteCollectionItem'
  | 'renameCollectionItem'
  | 'saveRequestToCollection'
  | 'saveActiveRequest'
  | 'addCollection'
  | 'replaceCollection'
  | 'importAnyPostmanJson'
  | 'importCollectionFromJson'
  | 'deleteCollection'
  | 'updateCollectionPermission'
  | 'moveRequest'
  | 'moveFolder'
  | 'reorderItem'
  | 'moveCollection'
  | 'loadCollectionDetails'
>;

export function createCollectionCrudMoveSlice(ctx: StoreSliceContext): CollectionCrudMoveSlice {
  const { set, get, isOfflineOnly, allowsOfflineWorkspace, cloudClient, refs, collections, helpers } = ctx;
  const {
    batchImportToScope,
    replaceScopeCollection,
    fetchScopeCollections: fetchScopeCollectionsForRuntime,
    fetchCollectionById: fetchCollectionByIdForRuntime,
    deleteScopeCollection,
    updateScopeCollectionPermission,
    deleteScopeItem,
    moveScopeCollection,
    moveScopeItem,
    reorderCollectionItems,
  } = cloudClient;
  const {
    movingCollections,
    duplicatingCollections,
    pendingReorderBaseSnapshots,
    collectionSaveSyncRevisions,
    collectionSaveSyncQueues,
    tabUndoHistory,
    undoTypingTimers,
  } = collections;
  const {
    beginAsyncOperation,
    completeAsyncOperation,
    isAsyncOperationCurrent,
    enqueueCollectionSyncTask,
    queueSavedCollectionSync,
    flushStorePersistence,
  } = helpers;

  async function commitItemMove(
    itemId: string,
    sourceCollectionId: string,
    targetCollectionId: string,
    targetParentId: string | null,
    commit: () => void,
  ): Promise<{ success: boolean; error?: string }> {
    const { workspaceMode, cloudConfig } = get();
    if (workspaceMode !== 'cloud') {
      commit();
      return { success: true };
    }
    const scope = cloudConfig.activeScope;
    if (isOfflineOnly || !isCloudSessionActive(cloudConfig) || !scope) {
      return { success: false, error: 'Sign in before moving cloud items.' };
    }
    if (refs.activePullOperation && isAsyncOperationCurrent(refs.activePullOperation)) {
      return { success: false, error: 'Wait for workspace sync to finish before moving items.' };
    }
    const ids = [...new Set([sourceCollectionId, targetCollectionId])];
    if (get().collections.some((col) => ids.includes(col.id) && col._needsMoveReconciliation)) {
      return { success: false, error: 'Sync the workspace to confirm the previous move before moving items again.' };
    }
    if (ids.some((id) => movingCollections.has(id) || duplicatingCollections.has(id))) {
      return { success: false, error: 'A move or duplicate operation is already in progress for this collection.' };
    }
    const lock = Symbol('item move');
    ids.forEach((id) => movingCollections.set(id, lock));
    const operation = beginAsyncOperation();
    try {
      await Promise.all(ids.map((id) => collectionSaveSyncQueues.get(`${scope.type}:${scope.id}:${id}`)));
      if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled.' };
      if (get().collections.some((col) => ids.includes(col.id) && col._syncStatus === 'pending')) {
        return { success: false, error: 'Sync pending changes in both collections before moving this item.' };
      }
      // Persist before sending: after a lost reply or restart, these old trees must
      // be fetched from the server before any import can recreate moved items.
      set((state) => ({ collections: state.collections.map((col) => ids.includes(col.id) ? { ...col, _needsMoveReconciliation: true } : col) }));
      await moveScopeItem(cloudConfig.apiUrl, get().cloudConfig.token, itemId, sourceCollectionId, targetCollectionId, targetParentId, get().cloudConfig.refreshToken, operation.controller.signal);
      if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled.' };
      commit();
      set((state) => {
        const activeScopeKey = state.cloudConfig.activeScope ? getScopeCacheKey(state.cloudConfig.activeScope) : null;
        const updatedScopeCache = { ...(state.scopeCache || {}) };
        if (activeScopeKey && updatedScopeCache[activeScopeKey]) {
          updatedScopeCache[activeScopeKey] = {
            ...updatedScopeCache[activeScopeKey],
            lastSyncedAt: 0,
          };
        }
        const movedIds = new Set<string>([itemId]);
        for (const colId of [sourceCollectionId, targetCollectionId]) {
          const col = state.collections.find((c) => c.id === colId);
          const movedNode = col ? findCollectionItemById(col.items, itemId) : undefined;
          if (movedNode) {
            for (const descendantId of collectAllItemIds([movedNode])) {
              movedIds.add(descendantId);
            }
          }
        }
        const nextOpenExampleTabs = (state.openExampleTabs || []).map((ex) =>
          ex.collectionId === sourceCollectionId && movedIds.has(ex.itemId) && sourceCollectionId !== targetCollectionId
            ? {
              ...ex,
              collectionId: targetCollectionId,
              id: makeExampleTabId({
                collectionId: targetCollectionId,
                itemId: ex.itemId,
                exampleId: ex.exampleId,
              }),
            }
            : ex
        );
        const tabIdRewrite = new Map<string, string>();
        (state.openExampleTabs || []).forEach((oldEx, idx) => {
          const nextEx = nextOpenExampleTabs[idx];
          if (nextEx && oldEx.id !== nextEx.id) {
            tabIdRewrite.set(oldEx.id, nextEx.id);
          }
        });
        const nextTabOrder = tabIdRewrite.size > 0
          ? syncVisualTabOrder(
            state.tabs,
            nextOpenExampleTabs,
            (state.tabOrder || []).map((id) => tabIdRewrite.get(id) ?? id),
            state.openPerformanceTabs,
          )
          : state.tabOrder;
        return {
          collections: state.collections.map((col) =>
            ids.includes(col.id)
              ? {
                ...col,
                version: typeof col.version === 'number' ? col.version + 1 : col.version,
                _needsMoveReconciliation: undefined,
              }
              : col
          ),
          openExampleTabs: nextOpenExampleTabs,
          tabOrder: nextTabOrder,
          selectedExample:
            state.selectedExample &&
              state.selectedExample.collectionId === sourceCollectionId &&
              movedIds.has(state.selectedExample.itemId) &&
              sourceCollectionId !== targetCollectionId
              ? { ...state.selectedExample, collectionId: targetCollectionId }
              : state.selectedExample,
          scopeCache: updatedScopeCache,
        };
      });
      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to move item to the target collection.';
      if (isAsyncOperationCurrent(operation)) {
        const rejected = error instanceof CloudApiError && [400, 403, 404].includes(error.status);
        set((state) => ({
          syncStatus: 'error', syncError: message,
          collections: rejected ? state.collections.map((col) => ids.includes(col.id) ? { ...col, _needsMoveReconciliation: undefined } : col) : state.collections,
        }));
      }
      return { success: false, error: message };
    } finally {
      completeAsyncOperation(operation);
      ids.forEach((id) => { if (movingCollections.get(id) === lock) movingCollections.delete(id); });
    }
  }

  helpers.commitItemMove = commitItemMove;

  return {
    createCollection: (name, description = '') => {
      const { workspaceMode, cloudConfig } = get();
      if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
        if (!hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role)) {
          console.warn('Insufficient permissions to create collection in project scope');
          return '';
        }
      }

      const isCloud = workspaceMode === 'cloud';
      const newCol: Collection = {
        id: generateId(),
        name: name.trim() || 'New Collection',
        description: description.trim(),
        items: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        _origin: isCloud ? 'cloud' : 'offline',
        _syncStatus: isCloud ? 'pending' : 'synced',
      };
      set((state) => ({
        collections: [newCol, ...state.collections],
      }));

      if (!isOfflineOnly && isCloud && isCloudSessionActive(cloudConfig) && cloudConfig.activeScope) {
        const revision = (collectionSaveSyncRevisions.get(newCol.id) ?? 0) + 1;
        collectionSaveSyncRevisions.set(newCol.id, revision);
        queueSavedCollectionSync(
          cloneCollectionPreservingAttachments(newCol),
          cloudConfig.activeScope,
          cloudConfig,
          revision,
          get,
          set,
          'Failed to sync created collection to cloud',
        );
      }

      return newCol.id;
    },

    createCollectionAsync: async (name, description = '') => {
      const { workspaceMode, cloudConfig, activeOfflineWorkspaceId } = get();
      if (!hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role)) {
        return { success: false, error: 'Write permission in the active workspace is required to create a collection.' };
      }

      let validatedName: string;
      try {
        validatedName = validateDuplicateName(name, 'Collection name');
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : 'Invalid collection name.' };
      }

      const isCloud = workspaceMode === 'cloud';
      const now = Date.now();
      const newCol: Collection = {
        id: generateId(),
        name: validatedName,
        description: description.trim(),
        items: [],
        createdAt: now,
        updatedAt: now,
        _origin: isCloud ? 'cloud' : 'offline',
        _syncStatus: 'synced',
        ...(isCloud ? { version: 1, minRole: 'reader' as const, isPartial: false } : {}),
      };

      if (!isCloud) {
        const capturedOfflineWsId = activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
        set((state) => {
          const nextCollections = [newCol, ...state.collections];
          return {
            collections: nextCollections,
            offlineWorkspaces: (state.offlineWorkspaces || []).map((w) =>
              w.id === capturedOfflineWsId ? { ...w, updatedAt: Date.now() } : w,
            ),
          };
        });
        try {
          await get().persistStoreState();
          return { success: true, collectionId: newCol.id };
        } catch {
          set((state) => {
            const isTargetActive =
              state.workspaceMode === 'offline' &&
              (state.activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID) === capturedOfflineWsId;
            const prevCache = state.offlineScopeCache || {};
            const cachedEntry = prevCache[capturedOfflineWsId];
            const nextOfflineCache = cachedEntry
              ? {
                ...prevCache,
                [capturedOfflineWsId]: {
                  ...cachedEntry,
                  collections: (cachedEntry.collections || []).filter((c) => c.id !== newCol.id),
                },
              }
              : prevCache;
            const nextOfflineWorkspaces = (state.offlineWorkspaces || []).map((w) => {
              if (w.id !== capturedOfflineWsId) return w;
              const wsWithCols = w as typeof w & { collections?: Collection[] };
              if (!Array.isArray(wsWithCols.collections)) return w;
              return {
                ...w,
                collections: wsWithCols.collections.filter((c) => c.id !== newCol.id),
              };
            });
            return {
              ...(isTargetActive
                ? { collections: state.collections.filter((c) => c.id !== newCol.id) }
                : {}),
              offlineScopeCache: nextOfflineCache,
              offlineWorkspaces: nextOfflineWorkspaces,
            };
          });
          return { success: false, error: 'Failed to persist new collection.' };
        }
      }

      if (isOfflineOnly || !isCloudSessionActive(cloudConfig) || !cloudConfig.activeScope) {
        return { success: false, error: 'Cloud session required to create a cloud collection.' };
      }
      if (refs.activePullOperation && isAsyncOperationCurrent(refs.activePullOperation)) {
        return { success: false, error: 'Wait for workspace sync to finish before creating a collection.' };
      }

      const capturedSessionGen = refs.cloudSessionGeneration;
      const currentOwnerKey = cloudCacheOwnerKey(cloudConfig, normalizeCloudApiUrl);
      const operation = beginAsyncOperation();
      try {
        await batchImportToScope(
          cloudConfig.apiUrl,
          cloudConfig.token,
          cloudConfig.activeScope,
          [newCol],
          cloudConfig.refreshToken,
          operation.controller.signal,
        );
        if (
          !isAsyncOperationCurrent(operation) ||
          refs.isStoreDisposed ||
          refs.cloudSessionGeneration !== capturedSessionGen ||
          cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) !== currentOwnerKey
        ) {
          return { success: false, error: 'Session or workspace changed before creation finished.' };
        }

        const scopeKey = getScopeCacheKey(cloudConfig.activeScope);
        set((state) => {
          const nextCollections = [newCol, ...state.collections];
          const prevScopeCache = state.scopeCache || {};
          const existingScopeEntry = prevScopeCache[scopeKey];
          const nextScopeCache = existingScopeEntry
            ? {
              ...prevScopeCache,
              [scopeKey]: { ...existingScopeEntry, collections: nextCollections, lastSyncedAt: Date.now() },
            }
            : prevScopeCache;
          return {
            collections: nextCollections,
            scopeCache: nextScopeCache,
          };
        });
        return { success: true, collectionId: newCol.id };
      } catch (err: unknown) {
        if (operation.controller.signal.aborted || !isAsyncOperationCurrent(operation)) {
          return { success: false, error: 'Collection creation cancelled.' };
        }
        return { success: false, error: err instanceof Error ? err.message : 'Failed to create collection in cloud.' };
      } finally {
        completeAsyncOperation(operation);
      }
    },

    renameCollection: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;

      const { workspaceMode, cloudConfig, collections: storeCols } = get();
      if (movingCollections.has(id) || duplicatingCollections.has(id)) {
        set({ syncError: 'Wait for the collection move or duplicate to finish before renaming.' });
        return;
      }
      const col = storeCols.find((c) => c.id === id);
      if (col?._needsMoveReconciliation || col?.isPartial) {
        set({
          syncError: col?.isPartial
            ? 'Wait for collection details to finish loading before renaming.'
            : 'Sync the workspace to confirm the previous move before renaming.',
        });
        return;
      }
      if (col) {
        if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          console.warn(`User lacks permission to rename collection "${col.name}"`);
          return;
        }
      }

      const shouldSync = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);

      if (shouldSync) {
        pendingReorderBaseSnapshots.delete(id);
      }

      set((state) => ({
        collections: state.collections.map((c) => {
          if (c.id !== id) return c;
          return {
            ...c,
            name: trimmed,
            updatedAt: Date.now(),
            ...(shouldSync ? { _syncStatus: 'pending' as const } : {}),
          };
        }),
      }));

      const updatedCols = get().collections;
      if (shouldSync && cloudConfig.activeScope) {
        const updatedCol = updatedCols.find((c) => c.id === id);
        if (updatedCol) {
          const revision = (collectionSaveSyncRevisions.get(id) ?? 0) + 1;
          collectionSaveSyncRevisions.set(id, revision);
          queueSavedCollectionSync(
            cloneCollectionPreservingAttachments(updatedCol),
            cloudConfig.activeScope,
            cloudConfig,
            revision,
            get,
            set,
            'Failed to sync renamed collection to cloud',
          );
        }
      }
    },

    createFolder: (collectionId, parentFolderId, name) => {
      const { workspaceMode, cloudConfig, collections: storeCols } = get();
      if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
        set({ syncError: 'Wait for the collection move or duplicate to finish before creating a folder.' });
        return '';
      }
      const col = storeCols.find((c) => c.id === collectionId);
      if (col?._needsMoveReconciliation || col?.isPartial) {
        set({ syncError: 'Sync the collection before creating a folder.' });
        return '';
      }
      if (col) {
        if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          console.warn(`User lacks permission to add folder to collection "${col.name}"`);
          return '';
        }
      }

      const newFolderId = generateId();
      const folderName = name?.trim() || 'New Folder';
      const newFolder: CollectionItem = {
        id: newFolderId,
        name: folderName,
        type: 'folder',
        items: [],
      };
      const shouldSync = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);

      if (shouldSync) {
        pendingReorderBaseSnapshots.delete(collectionId);
      }

      set((state) => {
        const updateItems = (items: CollectionItem[]): CollectionItem[] => {
          if (!parentFolderId) {
            return [...items, newFolder];
          }
          return items.map((item) => {
            if (item.type === 'folder') {
              if (item.id === parentFolderId) {
                return {
                  ...item,
                  items: [...(item.items || []), newFolder],
                };
              }
              return {
                ...item,
                items: updateItems(item.items || []),
              };
            }
            return item;
          });
        };

        const nextCollections = state.collections.map((c) => {
          if (c.id !== collectionId) return c;
          return {
            ...c,
            items: updateItems(c.items),
            updatedAt: Date.now(),
            ...(shouldSync ? { _syncStatus: 'pending' as const } : {}),
          };
        });

        return {
          collections: nextCollections,
        };
      });

      const updatedCols = get().collections;
      if (shouldSync && cloudConfig.activeScope) {
        const updatedCol = updatedCols.find((c) => c.id === collectionId);
        if (updatedCol) {
          const revision = (collectionSaveSyncRevisions.get(collectionId) ?? 0) + 1;
          collectionSaveSyncRevisions.set(collectionId, revision);
          queueSavedCollectionSync(
            cloneCollectionPreservingAttachments(updatedCol),
            cloudConfig.activeScope,
            cloudConfig,
            revision,
            get,
            set,
            'Failed to sync created folder to cloud',
          );
        }
      }

      return newFolderId;
    },

    createRequestInCollection: (collectionId, folderId, name) => {
      const { workspaceMode, cloudConfig, collections: storeCols } = get();
      if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
        set({ syncError: 'Wait for the collection move or duplicate to finish before creating a request.' });
        return null;
      }
      const col = storeCols.find((c) => c.id === collectionId);
      if (col?._needsMoveReconciliation || col?.isPartial) {
        set({ syncError: 'Sync the collection before creating a request.' });
        return null;
      }
      if (col) {
        if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          console.warn(`User lacks permission to add request to collection "${col.name}"`);
          return null;
        }
      }

      const reqId = generateId();
      const reqName = name?.trim() || 'New Request';
      const newReq: ApiRequest = {
        id: reqId,
        name: reqName,
        method: 'GET',
        url: '',
        params: [{ id: generateId(), key: '', value: '', enabled: true }],
        headers: [{ id: generateId(), key: '', value: '', enabled: true }],
        auth: { type: 'none' },
        bodyType: 'none',
        rawType: 'text',
        bodyContent: '',
        graphqlQuery: '',
        graphqlVariables: '',
        bodyFormData: [],
        bodyUrlEncoded: [{ id: generateId(), key: '', value: '', enabled: true }],
        preRequestScript: '',
        postResponseScript: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const newColItem: CollectionItem = {
        id: reqId,
        name: reqName,
        type: 'request',
        request: newReq,
      };
      const shouldSync = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);

      if (shouldSync) {
        pendingReorderBaseSnapshots.delete(collectionId);
      }

      set((state) => {
        const updateItems = (items: CollectionItem[]): CollectionItem[] => {
          if (!folderId) {
            return [...items, newColItem];
          }
          return items.map((item) => {
            if (item.type === 'folder') {
              if (item.id === folderId) {
                return {
                  ...item,
                  items: [...(item.items || []), newColItem],
                };
              }
              return {
                ...item,
                items: updateItems(item.items || []),
              };
            }
            return item;
          });
        };

        const nextCollections = state.collections.map((c) => {
          if (c.id !== collectionId) return c;
          return {
            ...c,
            items: updateItems(c.items),
            updatedAt: Date.now(),
            ...(shouldSync ? { _syncStatus: 'pending' as const } : {}),
          };
        });

        return {
          collections: nextCollections,
          tabs: [...state.tabs, newReq],
          activeTabId: reqId,
          activeResponse: null,
          selectedExample: null,
          selectedPerformanceTabId: null,
          tabOrder: [...syncVisualTabOrder(state.tabs, state.openExampleTabs, state.tabOrder, state.openPerformanceTabs), reqId],
          tabRevealRevision: state.tabRevealRevision + 1,
          canUndoActiveRequest: false,
          canRedoActiveRequest: false,
        };
      });

      const updatedCols = get().collections;
      if (shouldSync && cloudConfig.activeScope) {
        const updatedCol = updatedCols.find((c) => c.id === collectionId);
        if (updatedCol) {
          const revision = (collectionSaveSyncRevisions.get(collectionId) ?? 0) + 1;
          collectionSaveSyncRevisions.set(collectionId, revision);
          queueSavedCollectionSync(
            cloneCollectionPreservingAttachments(updatedCol),
            cloudConfig.activeScope,
            cloudConfig,
            revision,
            get,
            set,
            'Failed to sync created request to cloud',
          );
        }
      }

      return newReq;
    },

    deleteCollectionItem: (collectionId, itemId) => {
      const { workspaceMode, cloudConfig, collections: storeCols } = get();
      if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
        set({ syncError: 'Wait for the collection move or duplicate to finish before deleting items.' });
        return;
      }
      const col = storeCols.find((c) => c.id === collectionId);
      if (col?._needsMoveReconciliation || col?.isPartial) {
        set({ syncError: 'Sync the collection before deleting items.' });
        return;
      }
      if (col) {
        if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          console.warn(`User lacks permission to delete item from collection "${col.name}"`);
          return;
        }
      }
      const shouldSync = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);

      if (shouldSync) {
        pendingReorderBaseSnapshots.delete(collectionId);
      }

      set((state) => {
        const deletedIds = new Set<string>();
        const collectTargetIds = (items: CollectionItem[]) => {
          for (const item of items) {
            if (!item) continue;
            if (item.id === itemId) {
              deletedIds.add(item.id);
              if (item.type === 'folder' && item.items) {
                for (const childId of collectAllItemIds(item.items)) {
                  deletedIds.add(childId);
                }
              }
              return;
            }
            if (item.type === 'folder' && item.items) {
              collectTargetIds(item.items);
            }
          }
        };
        const targetCol = state.collections.find((c) => c.id === collectionId);
        if (targetCol) collectTargetIds(targetCol.items || []);
        if (deletedIds.size === 0) deletedIds.add(itemId);

        const filterItems = (items: CollectionItem[]): CollectionItem[] => {
          return items
            .filter((item) => item.id !== itemId)
            .map((item) => {
              if (item.type === 'folder' && item.items) {
                return {
                  ...item,
                  items: filterItems(item.items),
                };
              }
              return item;
            });
        };

        const nextCollections = state.collections.map((c) => {
          if (c.id !== collectionId) return c;
          return {
            ...c,
            items: filterItems(c.items),
            updatedAt: Date.now(),
            ...(shouldSync ? { _syncStatus: 'pending' as const } : {}),
          };
        });

        return {
          collections: nextCollections,
          ...helpers.pruneExampleTabsState(
            state,
            (sel) => !(sel.collectionId === collectionId && deletedIds.has(sel.itemId)),
          ),
          pendingExampleIntents: prunePendingExampleIntentsForTarget(
            state.pendingExampleIntents,
            collectionId,
            deletedIds,
          ),
        };
      });

      const updatedCols = get().collections;
      if (shouldSync && cloudConfig.activeScope) {
        const syncScope = cloudConfig.activeScope;
        const updatedCol = updatedCols.find((c) => c.id === collectionId);
        const snapshotCol = updatedCol ? cloneCollectionPreservingAttachments(updatedCol) : null;
        const revision = (collectionSaveSyncRevisions.get(collectionId) ?? 0) + 1;
        collectionSaveSyncRevisions.set(collectionId, revision);
        void enqueueCollectionSyncTask(collectionId, syncScope, async (operation, generation) => {
          try {
            const liveCloudConfig = get().cloudConfig;
            const activeApiUrl = liveCloudConfig.apiUrl || cloudConfig.apiUrl;
            const activeToken = liveCloudConfig.token || cloudConfig.token;
            const activeRefreshToken = liveCloudConfig.refreshToken ?? cloudConfig.refreshToken;
            await deleteScopeItem(
              activeApiUrl,
              activeToken,
              itemId,
              activeRefreshToken,
              operation.controller.signal
            ).catch((err) => {
              if (!isAsyncOperationCurrent(operation)) return;
              console.error('Failed to delete item from cloud:', err);
            });
            if (
              !isAsyncOperationCurrent(operation) ||
              generation !== refs.collectionSaveSyncGeneration ||
              refs.isStoreDisposed
            ) {
              return;
            }
            if (snapshotCol) {
              await batchImportToScope(
                activeApiUrl,
                activeToken,
                syncScope,
                [snapshotCol],
                activeRefreshToken,
                operation.controller.signal,
                { includeExamples: false },
              );
              if (
                !isAsyncOperationCurrent(operation) ||
                generation !== refs.collectionSaveSyncGeneration ||
                collectionSaveSyncRevisions.get(collectionId) !== revision ||
                get().cloudConfig.activeScope?.id !== syncScope.id ||
                get().cloudConfig.activeScope?.type !== syncScope.type
              ) {
                return;
              }
              set((state) => ({
                collections: state.collections.map((c) =>
                  c.id === collectionId ? { ...c, _syncStatus: 'synced' } : c
                ),
              }));
            }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (err: any) {
            if (
              operation.controller.signal.aborted ||
              !isAsyncOperationCurrent(operation) ||
              generation !== refs.collectionSaveSyncGeneration ||
              collectionSaveSyncRevisions.get(collectionId) !== revision
            ) {
              return;
            }
            console.error('Failed to sync item deletion to cloud:', err);
            set((state) => ({
              collections: state.collections.map((c) =>
                c.id === collectionId ? { ...c, _syncStatus: 'pending' } : c
              ),
              syncStatus: 'error',
              syncError: err.message || 'Failed to sync item deletion to cloud',
            }));
          }
        });
      }
    },

    renameCollectionItem: (collectionId, itemId, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;

      const { workspaceMode, cloudConfig, collections: storeCols } = get();
      if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
        set({ syncError: 'Wait for the collection move or duplicate to finish before renaming items.' });
        return;
      }
      const col = storeCols.find((c) => c.id === collectionId);
      if (col?._needsMoveReconciliation || col?.isPartial) {
        set({ syncError: 'Sync the collection before renaming items.' });
        return;
      }
      if (col) {
        if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          console.warn(`User lacks permission to rename item in collection "${col.name}"`);
          return;
        }
      }
      const shouldSync = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);

      if (shouldSync) {
        pendingReorderBaseSnapshots.delete(collectionId);
      }

      set((state) => {
        const updateItems = (items: CollectionItem[]): CollectionItem[] => {
          return items.map((item) => {
            if (item.id === itemId) {
              const updated: CollectionItem = {
                ...item,
                name: trimmed,
              };
              if (item.type === 'request' && item.request) {
                updated.request = {
                  ...item.request,
                  name: trimmed,
                };
              }
              return updated;
            }
            if (item.type === 'folder' && item.items) {
              return {
                ...item,
                items: updateItems(item.items),
              };
            }
            return item;
          });
        };

        const nextCollections = state.collections.map((c) => {
          if (c.id !== collectionId) return c;
          return {
            ...c,
            items: updateItems(c.items),
            updatedAt: Date.now(),
            ...(shouldSync ? { _syncStatus: 'pending' as const } : {}),
          };
        });

        // Synchronize any open tabs with this item
        const tabs = state.tabs.map((tab) => {
          if (tab.id === itemId) {
            return {
              ...tab,
              name: trimmed,
            };
          }
          return tab;
        });

        return {
          collections: nextCollections,
          tabs,
        };
      });

      const updatedCols = get().collections;
      if (shouldSync && cloudConfig.activeScope) {
        const updatedCol = updatedCols.find((c) => c.id === collectionId);
        if (updatedCol) {
          const revision = (collectionSaveSyncRevisions.get(collectionId) ?? 0) + 1;
          collectionSaveSyncRevisions.set(collectionId, revision);
          queueSavedCollectionSync(
            cloneCollectionPreservingAttachments(updatedCol),
            cloudConfig.activeScope,
            cloudConfig,
            revision,
            get,
            set,
            'Failed to sync renamed item to cloud',
          );
        }
      }
    },

    saveRequestToCollection: (collectionId, folderId, request, sourceTabId) => {
      const { workspaceMode, cloudConfig, collections: storeCols, tabs } = get();
      if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
        return { success: false, cloudStatus: 'not-applicable', error: 'Wait for the collection move or duplicate to finish before saving.' };
      }
      const collection = storeCols.find((candidate) => candidate.id === collectionId);
      if (!collection) {
        return { success: false, cloudStatus: 'not-applicable', error: 'The target collection no longer exists.' };
      }
      if (collection._needsMoveReconciliation) {
        return { success: false, cloudStatus: 'not-applicable', error: 'Sync the workspace to confirm the previous move before saving.' };
      }
      if (collection.isPartial) {
        return { success: false, cloudStatus: 'not-applicable', error: 'Wait for collection details to finish loading before saving.' };
      }
      if (!canModifyCollection(collection.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
        return { success: false, cloudStatus: 'not-applicable', error: `Collection "${collection.name}" is read-only.` };
      }

      const findFolder = (items: CollectionItem[]): CollectionItem | undefined => {
        for (const item of items) {
          if (item.type !== 'folder') continue;
          if (item.id === folderId) return item;
          const nested = findFolder(item.items || []);
          if (nested) return nested;
        }
        return undefined;
      };
      const targetItems = folderId ? findFolder(collection.items || [])?.items : collection.items || [];
      if (!targetItems) {
        return { success: false, cloudStatus: 'not-applicable', error: 'The target folder no longer exists.' };
      }
      if (sourceTabId && !tabs.some((tab) => tab.id === sourceTabId)) {
        return { success: false, sourceTabId, cloudStatus: 'not-applicable', error: 'The source tab is no longer open.' };
      }

      const existingItem = targetItems.find(
        (item) => item.type === 'request' && (item.id === request.id || item.request?.id === request.id),
      );
      const savedRequestId = existingItem?.id ?? (request.id.trim() || generateId());
      const targetTabAlreadyOpen = sourceTabId && savedRequestId !== sourceTabId && tabs.some((tab) => tab.id === savedRequestId);
      if (targetTabAlreadyOpen) {
        return {
          success: false,
          sourceTabId,
          cloudStatus: 'not-applicable',
          error: 'The request being replaced is already open in another tab. Close it before replacing.',
        };
      }

      const shouldSync = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && cloudConfig.activeScope;
      if (shouldSync) {
        pendingReorderBaseSnapshots.delete(collectionId);
      }
      const cleanRequest: RequestTab = cloneRequestPreservingAttachments({ ...request, id: savedRequestId });
      delete cleanRequest.deletedFromCollection;

      set((state) => {
        const insertOrUpdateInList = (items: CollectionItem[]): CollectionItem[] => {
          const existingIndex = items.findIndex(
            (item) => item.type === 'request' && (item.id === savedRequestId || item.request?.id === savedRequestId),
          );
          if (existingIndex >= 0) {
            const updated = [...items];
            updated[existingIndex] = { ...updated[existingIndex], name: cleanRequest.name, request: cleanRequest };
            return updated;
          }
          return [...items, {
            id: savedRequestId,
            name: cleanRequest.name || 'Untitled Request',
            type: 'request',
            request: cleanRequest,
            examples: [],
            exampleSummaries: [],
            exampleCount: 0,
            examplesLoaded: true,
          }];
        };
        const updateFolderItems = (items: CollectionItem[]): CollectionItem[] => items.map((item) => {
          if (item.type !== 'folder') return item;
          if (item.id === folderId) return { ...item, items: insertOrUpdateInList(item.items || []) };
          return { ...item, items: updateFolderItems(item.items || []) };
        });

        const nextCollections = state.collections.map((candidate) => candidate.id === collectionId
          ? {
            ...candidate,
            items: folderId ? updateFolderItems(candidate.items || []) : insertOrUpdateInList(candidate.items || []),
            updatedAt: Date.now(),
            ...(shouldSync ? { _syncStatus: 'pending' as const } : {}),
          }
          : candidate,
        );

        if (!sourceTabId) return { collections: nextCollections };

        if (sourceTabId !== savedRequestId) {
          const sourceHistory = tabUndoHistory[sourceTabId];
          if (sourceHistory) {
            tabUndoHistory[savedRequestId] = sourceHistory;
            delete tabUndoHistory[sourceTabId];
          }
          // The typing timer closure deletes the key it was created for, so moving it to the
          // new ID would leave a stale entry that merges the next edit into the pre-save group.
          const sourceTimer = undoTypingTimers[sourceTabId];
          if (sourceTimer) {
            clearTimeout(sourceTimer);
            delete undoTypingTimers[sourceTabId];
          }
        }

        const nextTabResponses = { ...(state.tabResponses || {}) };
        if (sourceTabId !== savedRequestId && nextTabResponses[sourceTabId]) {
          nextTabResponses[savedRequestId] = nextTabResponses[sourceTabId];
          delete nextTabResponses[sourceTabId];
        }
        const nextActiveTabId = state.activeTabId === sourceTabId ? savedRequestId : state.activeTabId;
        const nextTabOrder = sourceTabId !== savedRequestId
          ? (state.tabOrder || []).map((tabId) => (tabId === sourceTabId ? savedRequestId : tabId))
          : state.tabOrder;
        return {
          collections: nextCollections,
          tabs: state.tabs.map((tab) => tab.id === sourceTabId
            ? { ...tab, id: savedRequestId, name: cleanRequest.name, updatedAt: Date.now() }
            : tab,
          ),
          activeTabId: nextActiveTabId,
          tabOrder: nextTabOrder,
          tabResponses: nextTabResponses,
          activeResponse: nextActiveTabId === state.activeTabId
            ? state.activeResponse
            : nextTabResponses[nextActiveTabId] || null,
          canUndoActiveRequest: (tabUndoHistory[nextActiveTabId]?.past.length ?? 0) > 0,
          canRedoActiveRequest: (tabUndoHistory[nextActiveTabId]?.future.length ?? 0) > 0,
        };
      });

      const syncScope = shouldSync ? cloudConfig.activeScope : undefined;
      if (syncScope) {
        const updatedCollection = get().collections.find((candidate) => candidate.id === collectionId);
        if (updatedCollection) {
          const revision = (collectionSaveSyncRevisions.get(collectionId) ?? 0) + 1;
          collectionSaveSyncRevisions.set(collectionId, revision);
          queueSavedCollectionSync(
            cloneCollectionPreservingAttachments(updatedCollection),
            syncScope,
            cloudConfig,
            revision,
            get,
            set,
          );
        }
      }

      return {
        success: true,
        ...(sourceTabId ? { sourceTabId } : {}),
        savedRequestId,
        cloudStatus: shouldSync ? 'pending' : 'not-applicable',
      };
    },

    saveActiveRequest: () => {
      const { tabs, activeTabId, collections: storeCols, saveRequestToCollection, workspaceMode, cloudConfig } = get();
      const currentTab = tabs.find((t) => t.id === activeTabId);
      if (!currentTab) return { success: false, isDirectSaved: false };

      const saved = findSavedRequestInCollections(storeCols, currentTab.id);
      if (saved) {
        if (!canModifyCollection(saved.collection.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          return { success: false, isDirectSaved: false };
        }
        const result = saveRequestToCollection(saved.collection.id, saved.folderId, currentTab, currentTab.id);
        return { success: result.success, isDirectSaved: result.success };
      }

      return { success: false, isDirectSaved: false };
    },

    addCollection: async (collection, options?: { target?: ImportTargetBinding; isRetry?: boolean }) => {
      if (options?.target && !matchesImportTarget(get(), options.target, refs.cloudSessionGeneration)) {
        throw new Error('Workspace changed before collection import could be applied.');
      }

      const { workspaceMode, cloudConfig } = get();
      if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
        if (!hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role)) {
          console.warn('Insufficient permissions to add collections in project scope');
          throw new Error('Insufficient permissions to add collections in project scope (requires collection:write)');
        }
      }

      const isCloud = workspaceMode === 'cloud';
      const taggedCol: Collection = {
        ...collection,
        _origin: isCloud ? 'cloud' : 'offline',
        _syncStatus: isCloud ? 'pending' : 'synced',
      };
      set((state) => {
        const exists = state.collections.some((c) => c.id === taggedCol.id);
        const nextCollections = exists
          ? state.collections.map((c) => (c.id === taggedCol.id ? taggedCol : c))
          : [taggedCol, ...state.collections];
        const localId = state.activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
        const nextOfflineCache =
          state.workspaceMode === 'offline'
            ? {
              ...(state.offlineScopeCache || {}),
              [localId]: {
                environments: state.environments,
                activeEnvironmentId: state.activeEnvironmentId,
                tabs: state.tabs,
                activeTabId: state.activeTabId,
                history: state.history,
                ...(state.offlineScopeCache?.[localId] || {}),
                collections: nextCollections,
              },
            }
            : state.offlineScopeCache;
        return {
          collections: nextCollections,
          offlineScopeCache: nextOfflineCache,
        };
      });

      if (!isOfflineOnly && isCloud && isCloudSessionActive(cloudConfig) && cloudConfig.activeScope) {
        const expectedExamples = countCollectionSavedExamples(collection);
        if (expectedExamples > 0) {
          const supported = await helpers.ensureSavedExamplesCapability();
          if (!supported) {
            throw new Error('This cloud server does not support Saved Examples. Update the server or remove examples before uploading.');
          }
        }
        const operation = beginAsyncOperation();
        const targetScope = cloudConfig.activeScope;
        const capturedSessionGen = refs.cloudSessionGeneration;
        let uploadSucceeded = false;
        const isSameTargetScope = () => {
          const live = get();
          return (
            !refs.isStoreDisposed &&
            refs.cloudSessionGeneration === capturedSessionGen &&
            live.workspaceMode === 'cloud' &&
            live.cloudConfig.activeScope?.id === targetScope.id &&
            live.cloudConfig.activeScope?.type === targetScope.type
          );
        };
        const markCollectionSyncedInTargetScope = (remoteVersion?: number) => {
          if (refs.isStoreDisposed || refs.cloudSessionGeneration !== capturedSessionGen) return;
          const applySynced = (c: Collection): Collection =>
            c.id === taggedCol.id
              ? {
                ...c,
                _syncStatus: 'synced',
                ...(typeof remoteVersion === 'number' ? { version: remoteVersion } : {}),
              }
              : c;
          if (isSameTargetScope()) {
            set((state) => ({
              collections: state.collections.map(applySynced),
            }));
            return;
          }
          const targetKey = getScopeCacheKey(targetScope);
          set((state) => {
            const cached = state.scopeCache?.[targetKey];
            if (!cached) return {};
            return {
              scopeCache: {
                ...state.scopeCache,
                [targetKey]: {
                  ...cached,
                  collections: (cached.collections || []).map(applySynced),
                },
              },
            };
          });
        };
        try {
          set({ syncStatus: 'syncing', syncError: null });
          let alreadyOnServer = false;
          let matchedRemoteVersion: number | undefined = undefined;
          if (options?.isRetry) {
            const remoteCols = await fetchScopeCollectionsForRuntime(
              cloudConfig.apiUrl,
              cloudConfig.token,
              targetScope,
              cloudConfig.refreshToken,
              operation.controller.signal
            );
            if (refs.isStoreDisposed || refs.cloudSessionGeneration !== capturedSessionGen) return;
            const matchedRemote = Array.isArray(remoteCols)
              ? remoteCols.find((rc) => rc.id === taggedCol.id)
              : undefined;
            alreadyOnServer = Boolean(matchedRemote);
            if (matchedRemote) {
              if (expectedExamples > 0) {
                try {
                  const detailRaw = await fetchCollectionByIdForRuntime(
                    cloudConfig.apiUrl,
                    cloudConfig.token,
                    taggedCol.id,
                    cloudConfig.refreshToken,
                    operation.controller.signal,
                  );
                  const detailCol = detailRaw ? buildCollectionFromDetails(detailRaw) : null;
                  const remoteExampleCount = countCollectionSavedExamples(detailCol);
                  alreadyOnServer = remoteExampleCount >= expectedExamples;
                } catch {
                  alreadyOnServer = false;
                }
              } else {
                alreadyOnServer = true;
              }
              if (alreadyOnServer) {
                matchedRemoteVersion =
                  typeof matchedRemote.version === 'number' ? matchedRemote.version : 1;
              }
            }
            if (!alreadyOnServer && (!isAsyncOperationCurrent(operation) || operation.controller.signal.aborted)) {
              if (isSameTargetScope()) {
                throw new Error('Import operation was cancelled before completion.');
              }
              return;
            }
          }

          if (!alreadyOnServer) {
            const batchResult = await batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              targetScope,
              [collection],
              cloudConfig.refreshToken,
              operation.controller.signal
            );
            if (
              expectedExamples > 0 &&
              (typeof batchResult?.imported_examples !== 'number' ||
                batchResult.imported_examples < expectedExamples)
            ) {
              throw new Error(`Cloud server did not confirm saved examples during import of "${collection.name}".`);
            }
          }
          uploadSucceeded = true;
          if (refs.isStoreDisposed || refs.cloudSessionGeneration !== capturedSessionGen) return;
          markCollectionSyncedInTargetScope(matchedRemoteVersion);
          if (!isSameTargetScope() || !isAsyncOperationCurrent(operation)) return;
          await get().pullCloudDelta();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          if (!uploadSucceeded && (operation.controller.signal.aborted || !isAsyncOperationCurrent(operation))) {
            if (!refs.isStoreDisposed && isSameTargetScope()) {
              throw new Error('Import operation was cancelled before completion.');
            }
            return;
          }
          if (operation.controller.signal.aborted || !isAsyncOperationCurrent(operation) || refs.isStoreDisposed || !isSameTargetScope()) return;
          set((state) => ({
            collections: uploadSucceeded
              ? state.collections
              : state.collections.map((c) =>
                c.id === taggedCol.id ? { ...c, _syncStatus: 'pending' } : c
              ),
            syncStatus: 'error',
            syncError: err.message || 'Failed to sync collection to cloud',
          }));
          throw err;
        } finally {
          completeAsyncOperation(operation);
        }
      } else {
        await flushStorePersistence();
      }
    },

    replaceCollection: async (existingId: string, newCollection: Collection, options?: { target?: ImportTargetBinding }) => {
      if (options?.target && !matchesImportTarget(get(), options.target, refs.cloudSessionGeneration)) {
        throw new Error('Workspace changed before collection replacement could be applied.');
      }

      const state = get();
      if (movingCollections.has(existingId) || duplicatingCollections.has(existingId)) {
        throw new Error('Wait for the collection move or duplicate to finish before replacing.');
      }
      const existingCol = state.collections.find((c) => c.id === existingId);
      if (!existingCol) {
        throw new Error('Existing collection not found');
      }
      if (existingCol._needsMoveReconciliation) {
        throw new Error('Sync the workspace to confirm the previous move before replacing.');
      }

      if (!canModifyCollection(existingCol.minRole, state.cloudConfig.activeScope, state.workspaceMode, state.cloudConfig.user?.role)) {
        throw new Error(`Insufficient permissions to replace collection "${existingCol.name}"`);
      }

      const isCloud = state.workspaceMode === 'cloud';
      let resolvedExistingCol = existingCol;
      if (!isOfflineOnly && isCloud && isCloudSessionActive(state.cloudConfig) && state.cloudConfig.activeScope) {
        if (collectionHasSavedExamples(newCollection)) {
          const supported = await helpers.ensureSavedExamplesCapability();
          if (!supported) {
            throw new Error('This cloud server does not support Saved Examples. Update the server or remove examples before replacing.');
          }
        }
        if (resolvedExistingCol.isPartial) {
          const loaded = await get().loadCollectionDetails(existingId);
          if (!loaded.success || !loaded.collection) {
            throw new Error(loaded.error || 'Failed to load collection details before replacing.');
          }
          resolvedExistingCol = loaded.collection;
        }
      }

      const alignedItems = alignCollectionItemIds(resolvedExistingCol.items || [], newCollection.items || []);
      const baseVersion = typeof resolvedExistingCol.version === 'number' ? resolvedExistingCol.version : 1;

      const replacedCol: Collection = {
        ...newCollection,
        id: existingId,
        name: newCollection.name,
        minRole: newCollection.minRole || resolvedExistingCol.minRole,
        version: baseVersion,
        items: alignedItems,
        updatedAt: Date.now(),
        _origin: isCloud ? 'cloud' : 'offline',
        _syncStatus: isCloud ? 'pending' : 'synced',
      };

      set((s) => {
        const nextCollections = s.collections.map((c) => (c.id === existingId ? replacedCol : c));
        const localId = s.activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
        const nextOfflineCache =
          s.workspaceMode === 'offline'
            ? {
              ...(s.offlineScopeCache || {}),
              [localId]: {
                environments: s.environments,
                activeEnvironmentId: s.activeEnvironmentId,
                tabs: s.tabs,
                activeTabId: s.activeTabId,
                history: s.history,
                ...(s.offlineScopeCache?.[localId] || {}),
                collections: nextCollections,
              },
            }
            : s.offlineScopeCache;
        return {
          collections: nextCollections,
          offlineScopeCache: nextOfflineCache,
          ...helpers.pruneExampleTabsState(
            s,
            (sel) => sel.collectionId !== existingId || helpers.isSelectedExampleStillPresent(nextCollections, sel),
          ),
        };
      });

      const { workspaceMode, cloudConfig } = get();
      if (!isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && cloudConfig.activeScope) {
        const operation = beginAsyncOperation();
        const targetScope = cloudConfig.activeScope;
        const capturedSessionGen = refs.cloudSessionGeneration;
        const replaceOperationId = crypto.randomUUID();
        let uploadSucceeded = false;
        const isSameTargetScope = () => {
          const live = get();
          return (
            !refs.isStoreDisposed &&
            refs.cloudSessionGeneration === capturedSessionGen &&
            live.workspaceMode === 'cloud' &&
            live.cloudConfig.activeScope?.id === targetScope.id &&
            live.cloudConfig.activeScope?.type === targetScope.type
          );
        };
        try {
          set({ syncStatus: 'syncing', syncError: null });

          if (!isAsyncOperationCurrent(operation) || operation.controller.signal.aborted) {
            if (!refs.isStoreDisposed && isSameTargetScope()) {
              throw new Error('Import operation was cancelled before completion.');
            }
            return;
          }
          if (!isSameTargetScope()) return;
          const receipt = await replaceScopeCollection(
            cloudConfig.apiUrl,
            cloudConfig.token,
            existingId,
            replacedCol,
            baseVersion,
            replaceOperationId,
            cloudConfig.refreshToken,
            operation.controller.signal,
          );
          uploadSucceeded = true;
          if (refs.isStoreDisposed || refs.cloudSessionGeneration !== capturedSessionGen) return;
          const nextVersion = typeof receipt?.version === 'number' ? receipt.version : baseVersion + 1;
          if (isSameTargetScope()) {
            set((s) => ({
              collections: s.collections.map((c) =>
                c.id === existingId ? { ...c, version: nextVersion, _syncStatus: 'synced' } : c
              ),
            }));
            if (isAsyncOperationCurrent(operation)) {
              await get().pullCloudDelta();
            }
          } else {
            const targetKey = getScopeCacheKey(targetScope);
            set((s) => {
              const cached = s.scopeCache?.[targetKey];
              if (!cached) return {};
              return {
                scopeCache: {
                  ...s.scopeCache,
                  [targetKey]: {
                    ...cached,
                    collections: (cached.collections || []).map((c) =>
                      c.id === existingId ? { ...c, version: nextVersion, _syncStatus: 'synced' } : c
                    ),
                  },
                },
              };
            });
            return;
          }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          if (!uploadSucceeded && (operation.controller.signal.aborted || !isAsyncOperationCurrent(operation))) {
            if (!refs.isStoreDisposed && isSameTargetScope()) {
              throw new Error('Import operation was cancelled before completion.');
            }
            return;
          }
          if (operation.controller.signal.aborted || !isAsyncOperationCurrent(operation) || refs.isStoreDisposed || !isSameTargetScope()) return;
          set((s) => ({
            collections: uploadSucceeded
              ? s.collections
              : s.collections.map((c) =>
                c.id === existingId ? { ...c, _syncStatus: 'pending' } : c
              ),
            syncStatus: 'error',
            syncError: err.message || 'Failed to sync replaced collection',
          }));
          throw err;
        } finally {
          completeAsyncOperation(operation);
        }
      } else {
        await flushStorePersistence();
      }
    },

    importAnyPostmanJson: async (jsonStr) => {
      try {
        const { workspaceMode, cloudConfig } = get();
        const detected = detectPostmanJsonType(jsonStr);
        if (detected === 'environment') {
          if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
            if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role)) {
              return { success: false, error: 'Insufficient permission to import environments into this scope (requires env:write)' };
            }
          }
          const res = get().importEnvironmentFromJson(jsonStr);
          if (res.success && res.environment) {
            return { success: true, type: 'environment', name: res.environment.name };
          }
          return { success: false, error: res.error };
        } else {
          if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
            if (!hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role)) {
              return { success: false, error: 'Insufficient permission to import collections into this scope (requires collection:write)' };
            }
          }
          const col = importPostmanCollection(jsonStr);
          await get().addCollection(col);
          return { success: true, type: 'collection', name: col.name };
        }
      } catch (err: unknown) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to import Postman file',
        };
      }
    },

    importCollectionFromJson: async (jsonStr) => {
      try {
        const { workspaceMode, cloudConfig } = get();
        if (detectPostmanJsonType(jsonStr) === 'environment') {
          const envRes = get().importEnvironmentFromJson(jsonStr);
          if (envRes.success) {
            return { success: true };
          }
          return { success: false, error: envRes.error };
        }

        if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role)) {
            return { success: false, error: 'Insufficient permission to import collections into this scope (requires collection:write)' };
          }
        }

        const imported = importPostmanCollection(jsonStr);
        await get().addCollection(imported);
        return { success: true };
      } catch (err: unknown) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to parse Postman collection',
        };
      }
    },

    deleteCollection: async (id) => {
      const { workspaceMode, cloudConfig, collections: storeCols } = get();
      if (movingCollections.has(id) || duplicatingCollections.has(id)) {
        return { success: false, error: 'A move or duplicate operation is already in progress for this collection.' };
      }
      const col = storeCols.find((c) => c.id === id);
      if (workspaceMode === 'cloud' && !get().isFeatureEnabled('collection.delete')) {
        void get().refreshFeaturePolicy(true);
        return { success: false, error: 'Collection deletion is disabled or feature policy is unavailable.' };
      }
      if (col) {
        if (!hasScopePermission(cloudConfig.activeScope, 'collection:delete', workspaceMode, cloudConfig.user?.role)) {
          console.warn(`User lacks permission to delete collection "${col.name}"`);
          return { success: false, error: 'You do not have permission to delete this collection.' };
        }
        if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          console.warn(`User lacks permission to delete collection "${col.name}"`);
          return { success: false, error: 'You do not have permission to delete this collection.' };
        }
      }

      if (!isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig)) {
        const operation = beginAsyncOperation();
        try {
          await deleteScopeCollection(
            cloudConfig.apiUrl,
            cloudConfig.token,
            id,
            cloudConfig.refreshToken,
            operation.controller.signal
          );
          if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled.' };
          set((state) => ({
            collections: state.collections.filter((c) => c.id !== id),
            ...helpers.pruneExampleTabsState(state, (sel) => sel.collectionId !== id),
            pendingExampleIntents: prunePendingExampleIntentsForTarget(state.pendingExampleIntents, id),
          }));
          return { success: true };
        } catch (err) {
          if (err instanceof CloudApiError && err.code === 'FEATURE_DISABLED') {
            void get().refreshFeaturePolicy(true);
          }
          if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled.' };
          console.error('Failed to delete collection from cloud:', err);
          return { success: false, error: err instanceof Error ? err.message : 'Failed to delete collection.' };
        } finally {
          completeAsyncOperation(operation);
        }
      }
      set((state) => ({
        collections: state.collections.filter((c) => c.id !== id),
        ...helpers.pruneExampleTabsState(state, (sel) => sel.collectionId !== id),
        pendingExampleIntents: prunePendingExampleIntentsForTarget(state.pendingExampleIntents, id),
      }));
      return { success: true };
    },

    updateCollectionPermission: async (collectionId, minRole) => {
      const { workspaceMode, cloudConfig, collections: storeCols } = get();
      const col = storeCols.find((c) => c.id === collectionId);
      if (!col) return { success: false, error: 'Collection not found' };

      if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
        const isProjectAdmin = hasScopePermission(cloudConfig.activeScope, '*', workspaceMode, cloudConfig.user?.role);
        const isProjectMaintainer = hasScopePermission(cloudConfig.activeScope, 'collection:delete', workspaceMode, cloudConfig.user?.role);
        if (!isProjectAdmin && !isProjectMaintainer) {
          return { success: false, error: 'You do not have permission to manage permissions for this collection.' };
        }
        const userRank = getUserScopeRank(workspaceMode, cloudConfig.activeScope, cloudConfig.token, cloudConfig.user);
        const roleRanks: Record<string, number> = { admin: 4, maintainer: 3, contributor: 2, reader: 1 };
        if ((roleRanks[minRole] || 1) > userRank) {
          return { success: false, error: 'You cannot set a minimum role higher than your own role.' };
        }
      }

      if (!isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && cloudConfig.activeScope?.type === 'project') {
        const operation = beginAsyncOperation();
        try {
          const updated = await updateScopeCollectionPermission(
            cloudConfig.apiUrl,
            cloudConfig.token,
            collectionId,
            minRole,
            col.version || 1,
            cloudConfig.refreshToken,
            operation.controller.signal
          );
          if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled.' };
          set((state) => ({
            collections: state.collections.map((c) =>
              c.id === collectionId
                ? {
                  ...c,
                  minRole,
                  version: typeof updated?.version === 'number' ? updated.version : (c.version || 1) + 1,
                  updatedAt: Date.now(),
                }
                : c
            ),
          }));
          return { success: true };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled.' };
          console.error('Failed to update collection permission:', err);
          return { success: false, error: err.message || 'Failed to update collection permission.' };
        } finally {
          completeAsyncOperation(operation);
        }
      }

      set((state) => ({
        collections: state.collections.map((c) =>
          c.id === collectionId ? { ...c, minRole, updatedAt: Date.now() } : c
        ),
      }));
      return { success: true };
    },

    moveRequest: async (sourceCollectionId, requestId, targetCollectionId, targetFolderId) => {
      const { collections: storeCols, workspaceMode, cloudConfig } = get();
      const sourceCol = storeCols.find((c) => c.id === sourceCollectionId);
      const targetCol = storeCols.find((c) => c.id === targetCollectionId);

      if (!sourceCol) {
        return { success: false, error: 'Source collection not found' };
      }
      if (!targetCol) {
        return { success: false, error: 'Target collection not found' };
      }
      if (sourceCol.isPartial) {
        return { success: false, error: 'Source collection is only partially loaded. Sync or reload details before moving items.' };
      }
      if (targetCol.isPartial) {
        return { success: false, error: 'Target collection is only partially loaded. Sync or reload details before moving items.' };
      }

      if (!canModifyCollection(sourceCol.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
        return { success: false, error: 'Cannot move request: source collection is read-only' };
      }
      if (!canModifyCollection(targetCol.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
        return { success: false, error: 'Cannot move request: target collection is read-only' };
      }

      const applyRequestMove = (cols: Collection[]): {
        foundItem: CollectionItem | null;
        targetFolderFound: boolean;
        nextCollections: Collection[];
      } => {
        const curSource = cols.find((c) => c.id === sourceCollectionId);
        const curTarget = cols.find((c) => c.id === targetCollectionId);
        if (!curSource || !curTarget) {
          return { foundItem: null, targetFolderFound: false, nextCollections: cols };
        }

        let itemToMove: CollectionItem | null = null;
        const removeItem = (items: CollectionItem[]): CollectionItem[] => {
          const result: CollectionItem[] = [];
          for (const it of items) {
            if (!itemToMove && it.type === 'request' && (it.id === requestId || it.request?.id === requestId)) {
              itemToMove = it;
              continue;
            }
            if (it.type === 'folder') {
              result.push({
                ...it,
                items: removeItem(it.items || []),
              });
              continue;
            }
            result.push(it);
          }
          return result;
        };

        const updatedSourceItems = removeItem(curSource.items || []);
        if (!itemToMove) {
          return { foundItem: null, targetFolderFound: false, nextCollections: cols };
        }

        let targetFolderFound = !targetFolderId;
        const insertItem = (items: CollectionItem[]): CollectionItem[] => {
          if (!targetFolderId) {
            return [...items, itemToMove!];
          }
          return items.map((it) => {
            if (it.type === 'folder') {
              if (it.id === targetFolderId) {
                targetFolderFound = true;
                return {
                  ...it,
                  items: [...(it.items || []), itemToMove!],
                };
              }
              return {
                ...it,
                items: insertItem(it.items || []),
              };
            }
            return it;
          });
        };

        const updatedTargetItems = insertItem(
          sourceCollectionId === targetCollectionId ? updatedSourceItems : (curTarget.items || [])
        );
        if (!targetFolderFound) {
          return { foundItem: itemToMove, targetFolderFound: false, nextCollections: cols };
        }

        const now = Date.now();
        const nextCollections = cols.map((col) => {
          if (sourceCollectionId === targetCollectionId && col.id === sourceCollectionId) {
            return { ...col, items: updatedTargetItems, updatedAt: now };
          }
          if (col.id === sourceCollectionId) {
            return { ...col, items: updatedSourceItems, updatedAt: now };
          }
          if (col.id === targetCollectionId) {
            return { ...col, items: updatedTargetItems, updatedAt: now };
          }
          return col;
        });

        return { foundItem: itemToMove, targetFolderFound: true, nextCollections };
      };

      const findCurrentRequestFolderId = (items: CollectionItem[], parentId: string | null = null): string | null | undefined => {
        for (const it of items) {
          if (it.type === 'request' && (it.id === requestId || it.request?.id === requestId)) {
            return parentId;
          }
          if (it.type === 'folder' && it.items) {
            const found = findCurrentRequestFolderId(it.items, it.id);
            if (found !== undefined) return found;
          }
        }
        return undefined;
      };
      const currentFolderId = findCurrentRequestFolderId(sourceCol.items || []);
      if (
        currentFolderId !== undefined &&
        sourceCollectionId === targetCollectionId &&
        currentFolderId === (targetFolderId || null)
      ) {
        return { success: true };
      }

      const preview = applyRequestMove(storeCols);
      if (!preview.foundItem) {
        return { success: false, error: 'Request not found in source collection' };
      }
      if (!preview.targetFolderFound) {
        return { success: false, error: 'Target folder not found in target collection' };
      }

      return commitItemMove(preview.foundItem.id, sourceCollectionId, targetCollectionId, targetFolderId, () => {
        set((state) => {
          const committed = applyRequestMove(state.collections);
          if (!committed.foundItem || !committed.targetFolderFound) {
            return state;
          }
          return { collections: committed.nextCollections };
        });
      });
    },

    moveFolder: async (sourceCollectionId, folderId, targetCollectionId, targetFolderId) => {
      const { collections: storeCols, workspaceMode, cloudConfig } = get();
      const sourceCol = storeCols.find((c) => c.id === sourceCollectionId);
      const targetCol = storeCols.find((c) => c.id === targetCollectionId);

      if (!sourceCol) {
        return { success: false, error: 'Source collection not found' };
      }
      if (!targetCol) {
        return { success: false, error: 'Target collection not found' };
      }
      if (sourceCol.isPartial) {
        return { success: false, error: 'Source collection is only partially loaded. Sync or reload details before moving items.' };
      }
      if (targetCol.isPartial) {
        return { success: false, error: 'Target collection is only partially loaded. Sync or reload details before moving items.' };
      }

      if (!canModifyCollection(sourceCol.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
        return { success: false, error: 'Cannot move folder: source collection is read-only' };
      }
      if (!canModifyCollection(targetCol.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
        return { success: false, error: 'Cannot move folder: target collection is read-only' };
      }

      // Circular check: a folder cannot be moved into itself
      if (targetFolderId && targetFolderId === folderId) {
        return { success: false, error: 'Cannot move folder into itself' };
      }

      const applyFolderMove = (cols: Collection[]): {
        folderToMove: CollectionItem | null;
        isCycle: boolean;
        targetFolderFound: boolean;
        nextCollections: Collection[];
      } => {
        const curSource = cols.find((c) => c.id === sourceCollectionId);
        const curTarget = cols.find((c) => c.id === targetCollectionId);
        if (!curSource || !curTarget) {
          return { folderToMove: null, isCycle: false, targetFolderFound: false, nextCollections: cols };
        }

        let folderToMove: CollectionItem | null = null;
        const removeFolder = (items: CollectionItem[]): CollectionItem[] => {
          const result: CollectionItem[] = [];
          for (const it of items) {
            if (!folderToMove && it.type === 'folder' && it.id === folderId) {
              folderToMove = it;
              continue;
            }
            if (it.type === 'folder') {
              result.push({
                ...it,
                items: removeFolder(it.items || []),
              });
              continue;
            }
            result.push(it);
          }
          return result;
        };

        const updatedSourceItems = removeFolder(curSource.items || []);
        if (!folderToMove) {
          return { folderToMove: null, isCycle: false, targetFolderFound: false, nextCollections: cols };
        }

        // Circular check: if target is in the same collection, cannot move folder into any of its own subfolders
        if (sourceCollectionId === targetCollectionId && targetFolderId) {
          if (isDescendantOf([folderToMove], folderId, targetFolderId)) {
            return { folderToMove, isCycle: true, targetFolderFound: false, nextCollections: cols };
          }
        }

        let targetFolderFound = !targetFolderId;
        const insertFolder = (items: CollectionItem[]): CollectionItem[] => {
          if (!targetFolderId) {
            return [...items, folderToMove!];
          }
          return items.map((it) => {
            if (it.type === 'folder') {
              if (it.id === targetFolderId) {
                targetFolderFound = true;
                return {
                  ...it,
                  items: [...(it.items || []), folderToMove!],
                };
              }
              return {
                ...it,
                items: insertFolder(it.items || []),
              };
            }
            return it;
          });
        };

        const updatedTargetItems = insertFolder(
          sourceCollectionId === targetCollectionId ? updatedSourceItems : (curTarget.items || [])
        );
        if (targetFolderId && !targetFolderFound) {
          return { folderToMove, isCycle: false, targetFolderFound: false, nextCollections: cols };
        }

        const now = Date.now();
        const nextCollections = cols.map((col) => {
          if (sourceCollectionId === targetCollectionId && col.id === sourceCollectionId) {
            return { ...col, items: updatedTargetItems, updatedAt: now };
          }
          if (col.id === sourceCollectionId) {
            return { ...col, items: updatedSourceItems, updatedAt: now };
          }
          if (col.id === targetCollectionId) {
            return { ...col, items: updatedTargetItems, updatedAt: now };
          }
          return col;
        });

        return { folderToMove, isCycle: false, targetFolderFound: true, nextCollections };
      };

      const findCurrentParentFolderId = (items: CollectionItem[], parentId: string | null = null): string | null | undefined => {
        for (const it of items) {
          if (it.type === 'folder') {
            if (it.id === folderId) return parentId;
            if (it.items) {
              const found = findCurrentParentFolderId(it.items, it.id);
              if (found !== undefined) return found;
            }
          }
        }
        return undefined;
      };
      const currentParentId = findCurrentParentFolderId(sourceCol.items || []);
      if (
        currentParentId !== undefined &&
        sourceCollectionId === targetCollectionId &&
        currentParentId === (targetFolderId || null)
      ) {
        return { success: true };
      }

      const preview = applyFolderMove(storeCols);
      const folderToMove = preview.folderToMove;
      if (!folderToMove) {
        return { success: false, error: 'Folder not found in source collection' };
      }
      if (preview.isCycle) {
        return { success: false, error: 'Cannot move folder into one of its subfolders' };
      }
      if (targetFolderId && !preview.targetFolderFound) {
        return { success: false, error: 'Target folder not found in target collection' };
      }

      return commitItemMove((folderToMove as CollectionItem).id, sourceCollectionId, targetCollectionId, targetFolderId, () => {
        set((state) => {
          const committed = applyFolderMove(state.collections);
          if (!committed.folderToMove || committed.isCycle || (targetFolderId && !committed.targetFolderFound)) {
            return state;
          }
          return { collections: committed.nextCollections };
        });
      });
    },

    reorderItem: async (collectionId, activeId, targetId, position) => {
      const { collections: storeCols, workspaceMode, cloudConfig } = get();
      if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
        return { success: false, error: 'A move or duplicate operation is already in progress for this collection.' };
      }
      const col = storeCols.find((c) => c.id === collectionId);
      if (!col) return { success: false, error: 'Collection not found' };
      if (col._needsMoveReconciliation || col.isPartial) {
        return { success: false, error: 'Sync the collection before reordering items.' };
      }

      if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
        return { success: false, error: 'User lacks permission to reorder items in this collection' };
      }

      const previousItems = col.items;
      const previousSyncStatus = col._syncStatus;
      const result = reorderItemInTree(col.items, activeId, targetId, position);
      if (!result) return { success: false, error: 'Invalid reorder operation' };

      const { updatedItems, payload } = result;
      const shouldSync = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);

      if (shouldSync && !pendingReorderBaseSnapshots.has(collectionId)) {
        pendingReorderBaseSnapshots.set(collectionId, {
          items: previousItems,
          syncStatus: previousSyncStatus,
        });
      }

      set((state) => ({
        collections: state.collections.map((c) => {
          if (c.id !== collectionId) return c;
          return {
            ...c,
            items: updatedItems,
            updatedAt: Date.now(),
            ...(shouldSync ? { _syncStatus: 'pending' as const } : {}),
          };
        }),
      }));

      const token = cloudConfig.token;
      if (shouldSync && cloudConfig.activeScope) {
        const syncScope = cloudConfig.activeScope;
        const revision = (collectionSaveSyncRevisions.get(collectionId) ?? 0) + 1;
        collectionSaveSyncRevisions.set(collectionId, revision);
        void enqueueCollectionSyncTask(collectionId, syncScope, async (operation, generation) => {
          const send = async () => {
            const liveCloudConfig = get().cloudConfig;
            await reorderCollectionItems(
              liveCloudConfig.apiUrl || cloudConfig.apiUrl,
              liveCloudConfig.token || token,
              collectionId,
              payload,
              liveCloudConfig.refreshToken ?? cloudConfig.refreshToken,
              operation.controller.signal,
            );
          };
          try {
            try {
              await send();
            } catch {
              if (
                operation.controller.signal.aborted ||
                !isAsyncOperationCurrent(operation) ||
                generation !== refs.collectionSaveSyncGeneration
              ) {
                return;
              }
              // Retry once after 250ms for transient race condition or network glitch
              await new Promise((r) => setTimeout(r, 250));
              if (
                operation.controller.signal.aborted ||
                !isAsyncOperationCurrent(operation) ||
                generation !== refs.collectionSaveSyncGeneration
              ) {
                return;
              }
              await send();
            }
            if (
              !isAsyncOperationCurrent(operation) ||
              generation !== refs.collectionSaveSyncGeneration ||
              collectionSaveSyncRevisions.get(collectionId) !== revision ||
              get().cloudConfig.activeScope?.id !== syncScope.id ||
              get().cloudConfig.activeScope?.type !== syncScope.type
            ) {
              return;
            }
            pendingReorderBaseSnapshots.delete(collectionId);
            set((state) => {
              const activeScopeKey = state.cloudConfig.activeScope ? getScopeCacheKey(state.cloudConfig.activeScope) : null;
              const updatedScopeCache = { ...(state.scopeCache || {}) };
              if (activeScopeKey && updatedScopeCache[activeScopeKey]) {
                updatedScopeCache[activeScopeKey] = {
                  ...updatedScopeCache[activeScopeKey],
                  lastSyncedAt: 0,
                };
              }
              return {
                collections: state.collections.map((c) =>
                  c.id === collectionId
                    ? {
                      ...c,
                      version: typeof c.version === 'number' ? c.version + 1 : c.version,
                      _syncStatus: 'synced',
                    }
                    : c
                ),
                scopeCache: updatedScopeCache,
                ...(state.syncStatus === 'error' ? { syncStatus: 'idle', syncError: null } : {}),
              };
            });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (retryErr: any) {
            if (
              operation.controller.signal.aborted ||
              !isAsyncOperationCurrent(operation) ||
              generation !== refs.collectionSaveSyncGeneration ||
              collectionSaveSyncRevisions.get(collectionId) !== revision
            ) {
              return;
            }
            console.error('Failed to sync reordered items to cloud:', retryErr);
            const rejected = retryErr instanceof CloudApiError && [400, 403, 404, 409].includes(retryErr.status);
            const rollbackBase = rejected ? pendingReorderBaseSnapshots.get(collectionId) : undefined;
            if (rejected) {
              pendingReorderBaseSnapshots.delete(collectionId);
            }
            set((state) => ({
              collections: state.collections.map((c) => {
                if (c.id !== collectionId) return c;
                return rejected && rollbackBase
                  ? { ...c, items: rollbackBase.items, _syncStatus: rollbackBase.syncStatus ?? 'synced', updatedAt: Date.now() }
                  : { ...c, _syncStatus: 'pending' };
              }),
              syncStatus: 'error',
              syncError: retryErr.message || 'Failed to sync reordered items to cloud',
            }));
          }
        });
      }

      return { success: true };
    },

    moveCollection: async (collectionId, targetScope) => {
      const {
        workspaceMode,
        collections: storeCols,
        cloudConfig,
        activeOfflineWorkspaceId,
      } = get();

      if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
        return { success: false, error: 'A move or duplicate operation is already in progress for this collection.' };
      }

      // 1. Target is an offline workspace
      if (targetScope.type === 'offline_workspace') {
        if (!allowsOfflineWorkspace) return { success: false, error: 'Offline workspaces are disabled for this product.' };
        const col = storeCols.find((c) => c.id === collectionId);
        if (!col) {
          return { success: false, error: 'Collection not found' };
        }
        if (col._needsMoveReconciliation) {
          return { success: false, error: 'Sync the workspace to confirm the previous move before moving this collection.' };
        }

        if (workspaceMode === 'cloud') {
          if (cloudConfig.activeScope?.type === 'project' &&
            (!hasScopePermission(cloudConfig.activeScope, 'collection:move', workspaceMode, cloudConfig.user?.role) ||
              !canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role))) {
            return { success: false, error: 'Insufficient permission to move collection from this project' };
          }
          if (cloudConfig.activeScope?.type === 'project') {
            return { success: false, error: 'Collections in projects cannot be moved to personal workspaces.' };
          }
          return { success: false, error: 'Moving cloud collections to offline workspaces is unavailable.' };
        }

        if (workspaceMode === 'offline' && targetScope.id === activeOfflineWorkspaceId) {
          return { success: false, error: 'Cannot move to the current active workspace' };
        }
        if (!get().offlineWorkspaces?.some((w) => w.id === targetScope.id)) {
          return { success: false, error: 'Target offline workspace not found.' };
        }

        set((state) => {
          const latestCol = state.collections.find((c) => c.id === collectionId);
          if (!latestCol) return {};
          const remainingActive = state.collections.filter((c) => c.id !== collectionId);
          const updatedOfflineCache = { ...(state.offlineScopeCache || {}) };

          if (state.workspaceMode === 'offline' && state.activeOfflineWorkspaceId) {
            updatedOfflineCache[state.activeOfflineWorkspaceId] = {
              ...(updatedOfflineCache[state.activeOfflineWorkspaceId] || {}),
              collections: remainingActive,
              environments: state.environments,
              activeEnvironmentId: state.activeEnvironmentId,
              tabs: state.tabs,
              activeTabId: state.activeTabId,
              history: state.history,
            };
          }

          const targetEntry = updatedOfflineCache[targetScope.id] || {
            collections: [],
            environments: [],
            tabs: [createInitialTab()],
            history: [],
          };

          const existingTargetCols = (targetEntry.collections || []).filter((c) => c.id !== collectionId);
          updatedOfflineCache[targetScope.id] = {
            ...targetEntry,
            collections: [...existingTargetCols, { ...latestCol, _origin: 'offline' }],
          };

          return {
            collections: remainingActive,
            offlineScopeCache: updatedOfflineCache,
            ...helpers.pruneExampleTabsState(state, (sel) => sel.collectionId !== collectionId),
          };
        });

        await flushStorePersistence();
        return { success: true };
      }

      if (isOfflineOnly) {
        return { success: false, error: 'Offline edition cannot move collections to online scopes' };
      }

      if (workspaceMode === 'offline') {
        // Moving from offline to online scope
        const col = storeCols.find((c) => c.id === collectionId);
        if (!col) {
          return { success: false, error: 'Collection not found' };
        }
        if (!isCloudSessionActive(cloudConfig)) {
          return { success: false, error: 'Cloud authentication required to move collection to an online workspace' };
        }

        const sourceOfflineWorkspaceId = activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
        const capturedSessionGen = refs.cloudSessionGeneration;
        const lock = Symbol('collection move offline-to-cloud');
        movingCollections.set(collectionId, lock);
        const operation = beginAsyncOperation();

        try {
          const policy = await get().refreshFeaturePolicy();
          if (
            !isAsyncOperationCurrent(operation) ||
            refs.isStoreDisposed ||
            refs.cloudSessionGeneration !== capturedSessionGen ||
            get().workspaceMode !== 'offline' ||
            (get().activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID) !== sourceOfflineWorkspaceId
          ) {
            return { success: false, error: 'Operation cancelled' };
          }
          if (!policy?.flags['collection.move']) {
            return { success: false, error: 'Collection move is disabled or feature policy is unavailable.' };
          }

          const latestCol = get().collections.find((c) => c.id === collectionId);
          if (!latestCol) {
            return { success: false, error: 'Collection not found' };
          }
          if (
            collectionHasSavedExamples(latestCol) &&
            policy?.capabilities?.saved_examples !== true
          ) {
            return {
              success: false,
              error: 'This cloud server does not support Saved Examples. Update the server before moving collections with examples.',
            };
          }

          set({ syncStatus: 'syncing', syncError: null });
          await batchImportToScope(
            cloudConfig.apiUrl,
            cloudConfig.token,
            targetScope,
            [latestCol],
            cloudConfig.refreshToken,
            operation.controller.signal
          );
          if (
            !isAsyncOperationCurrent(operation) ||
            refs.isStoreDisposed ||
            refs.cloudSessionGeneration !== capturedSessionGen
          ) {
            return { success: false, error: 'Operation cancelled' };
          }

          const targetKey = getScopeCacheKey(targetScope);
          set((state) => {
            const remainingActive = state.collections.filter((c) => c.id !== collectionId);
            const updatedOfflineCache = { ...(state.offlineScopeCache || {}) };
            if (updatedOfflineCache[sourceOfflineWorkspaceId]) {
              updatedOfflineCache[sourceOfflineWorkspaceId] = {
                ...updatedOfflineCache[sourceOfflineWorkspaceId],
                collections: (updatedOfflineCache[sourceOfflineWorkspaceId].collections || []).filter(
                  (c) => c.id !== collectionId
                ),
              };
            }

            // Invalidate target scope cache freshness without inserting an unversioned _origin:'cloud'
            // stub (which would otherwise trigger a duplicate pending re-upload on scope switch)
            const updatedScopeCache = { ...(state.scopeCache || {}) };
            if (updatedScopeCache[targetKey]) {
              updatedScopeCache[targetKey] = {
                ...updatedScopeCache[targetKey],
                collections: (updatedScopeCache[targetKey].collections || []).filter(
                  (c) => c.id !== collectionId
                ),
                lastSyncedAt: 0,
              };
            }

            return {
              collections: remainingActive,
              offlineScopeCache: updatedOfflineCache,
              scopeCache: updatedScopeCache,
              ...helpers.pruneExampleTabsState(state, (sel) => sel.collectionId !== collectionId),
              syncStatus: 'idle',
            };
          });

          return { success: true };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled' };
          set({ syncStatus: 'error', syncError: err.message || 'Failed to move collection' });
          return { success: false, error: err.message || 'Failed to move collection' };
        } finally {
          completeAsyncOperation(operation);
          if (movingCollections.get(collectionId) === lock) movingCollections.delete(collectionId);
        }
      } else {
        // Moving from an online scope to another online scope
        const col = storeCols.find((c) => c.id === collectionId);
        if (!col) {
          return { success: false, error: 'Collection not found' };
        }
        if (col._needsMoveReconciliation) {
          return { success: false, error: 'Sync the workspace to confirm the previous move before moving this collection.' };
        }
        if (col._syncStatus === 'pending') {
          return { success: false, error: 'Sync pending changes in this collection before moving it.' };
        }
        if (!isCloudSessionActive(cloudConfig) || !cloudConfig.activeScope) {
          return { success: false, error: 'Not connected to cloud' };
        }
        if (refs.activePullOperation && isAsyncOperationCurrent(refs.activePullOperation)) {
          return { success: false, error: 'Wait for workspace sync to finish before moving collections.' };
        }
        if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'collection:move', workspaceMode, cloudConfig.user?.role) ||
            !canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            return { success: false, error: 'Insufficient permission to move collection from this project' };
          }
        }

        const sourceScope = cloudConfig.activeScope;
        const lock = Symbol('collection move cloud-to-cloud');
        movingCollections.set(collectionId, lock);
        const operation = beginAsyncOperation();
        try {
          if (!get().isFeatureEnabled('collection.move')) {
            const policy = await get().refreshFeaturePolicy();
            if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled' };
            if (!policy?.flags['collection.move']) {
              return { success: false, error: 'Collection move is disabled or feature policy is unavailable.' };
            }
          }

          await collectionSaveSyncQueues.get(`${sourceScope.type}:${sourceScope.id}:${collectionId}`);
          if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled' };

          const latestCol = get().collections.find((c) => c.id === collectionId);
          if (!latestCol) {
            return { success: false, error: 'Collection not found' };
          }
          if (latestCol._syncStatus === 'pending') {
            return { success: false, error: 'Sync pending changes in this collection before moving it.' };
          }

          // Persist reconciliation flag before sending: after a lost reply, prevent local saves
          // from re-importing this collection into the source scope until cloud sync reconciles.
          set((state) => ({
            syncStatus: 'syncing',
            syncError: null,
            collections: state.collections.map((c) =>
              c.id === collectionId ? { ...c, _needsMoveReconciliation: true } : c
            ),
          }));
          await moveScopeCollection(
            cloudConfig.apiUrl,
            cloudConfig.token,
            collectionId,
            targetScope,
            cloudConfig.refreshToken,
            operation.controller.signal
          );
          if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled' };

          const currentScopeKey = getScopeCacheKey(sourceScope);
          const targetScopeKey = getScopeCacheKey(targetScope);
          set((state) => {
            const remainingCols = state.collections.filter((c) => c.id !== collectionId);
            const updatedScopeCache = { ...(state.scopeCache || {}) };

            if (updatedScopeCache[currentScopeKey]) {
              updatedScopeCache[currentScopeKey] = {
                ...updatedScopeCache[currentScopeKey],
                collections: (updatedScopeCache[currentScopeKey].collections || []).filter((c) => c.id !== collectionId),
              };
            }

            if (updatedScopeCache[targetScopeKey]) {
              const movedEntry: Collection = {
                ...latestCol,
                version: typeof latestCol.version === 'number' ? latestCol.version + 1 : 2,
                _syncStatus: 'synced',
                _needsMoveReconciliation: undefined,
              };
              updatedScopeCache[targetScopeKey] = {
                ...updatedScopeCache[targetScopeKey],
                collections: [
                  ...(updatedScopeCache[targetScopeKey].collections || []).filter((c) => c.id !== collectionId),
                  movedEntry,
                ],
                lastSyncedAt: 0,
              };
            }

            return {
              collections: remainingCols,
              scopeCache: updatedScopeCache,
              ...helpers.pruneExampleTabsState(state, (sel) => sel.collectionId !== collectionId),
              syncStatus: 'idle',
            };
          });

          return { success: true };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled' };
          if (err instanceof CloudApiError && err.code === 'FEATURE_DISABLED') {
            void get().refreshFeaturePolicy(true);
          }
          const rejected = err instanceof CloudApiError && [400, 403, 404, 409].includes(err.status);
          set((state) => ({
            syncStatus: 'error',
            syncError: err.message || 'Failed to move collection',
            collections: rejected
              ? state.collections.map((c) =>
                c.id === collectionId ? { ...c, _needsMoveReconciliation: undefined } : c
              )
              : state.collections,
          }));
          return { success: false, error: err.message || 'Failed to move collection' };
        } finally {
          completeAsyncOperation(operation);
          if (movingCollections.get(collectionId) === lock) movingCollections.delete(collectionId);
        }
      }
    },

    loadCollectionDetails: async (collectionId) => {
      if (isOfflineOnly) {
        return { success: false, error: 'Cloud collections are disabled for this product.' };
      }
      const { workspaceMode, cloudConfig } = get();
      if (workspaceMode !== 'cloud' || !isCloudSessionActive(cloudConfig) || !cloudConfig.activeScope) {
        return { success: false, error: 'Sign in to load cloud collection details.' };
      }
      const operation = beginAsyncOperation();
      try {
        const raw = await fetchCollectionByIdForRuntime(
          cloudConfig.apiUrl,
          cloudConfig.token,
          collectionId,
          cloudConfig.refreshToken,
          operation.controller.signal,
        );
        if (!isAsyncOperationCurrent(operation)) {
          return { success: false, error: 'Session or scope changed.' };
        }
        const currentOwnerKey = cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl);
        const built = buildCollectionFromDetails(raw);
        set((state) => {
          const exists = state.collections.some((c) => c.id === built.id);
          const nextCollections = exists
            ? state.collections.map((c) => {
              if (c.id !== built.id) return c;
              if (c._syncStatus === 'pending') return c;
              const hydratedItems = preserveHydratedItemExamples(built.items || [], c.items || []);
              return {
                ...built,
                items: hydratedItems,
                ...(c._needsMoveReconciliation ? { _needsMoveReconciliation: true } : {}),
              };
            })
            : [...state.collections, built];
          const overlaid = overlayPendingExampleIntentsOnCollections(
            nextCollections,
            state.pendingExampleIntents,
            currentOwnerKey,
            state.cloudConfig.activeScope,
          );
          return { collections: overlaid };
        });
        return { success: true, collection: built };
      } catch (err: unknown) {
        if (!isAsyncOperationCurrent(operation)) {
          return { success: false, error: 'Operation cancelled.' };
        }
        return { success: false, error: err instanceof Error ? err.message : 'Failed to load collection details.' };
      } finally {
        completeAsyncOperation(operation);
      }
    },
  };
}
