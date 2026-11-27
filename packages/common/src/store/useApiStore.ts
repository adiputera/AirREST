import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import { useContext } from 'react';
import { StoreContext, ApiStore } from './storeContext';
import { appStorage } from '../lib/storage';
import type {
  ActiveScope,
  ApiRequest,
  ApiResponse,
  Collection,
  HistoryItem,
  ThemeMode,
} from '../types/api';
import { applyTheme } from '../lib/theme';
import { rebuildTrackedImageBlobUrl } from '../lib/fetcher';
import {
  evictRawBodiesToBudget,
  releaseRawBodies,
  releaseRawBody,
  revokeBlobUrls,
} from '../lib/blobManager';
import {
  batchImportToScope as legacyBatchImportToScope,
  createScopeEnvironment as legacyCreateScopeEnvironment,
  updateScopeEnvironment as legacyUpdateScopeEnvironment,
  deleteScopeEnvironment as legacyDeleteScopeEnvironment,
  deleteScopeCollection as legacyDeleteScopeCollection,
  updateScopeCollectionPermission as legacyUpdateScopeCollectionPermission,
  deleteScopeItem as legacyDeleteScopeItem,
  moveScopeCollection as legacyMoveScopeCollection,
  moveScopeItem as legacyMoveScopeItem,
  duplicateScopeCollection as legacyDuplicateScopeCollection,
  importDuplicateCollection as legacyImportDuplicateCollection,
  duplicateScopeItem as legacyDuplicateScopeItem,
  reorderCollectionItems as legacyReorderCollectionItems,
  patchScopeItemExamples as legacyPatchScopeItemExamples,
  fetchScopeItem as legacyFetchScopeItem,
  fetchScopeCollectionExamples as legacyFetchScopeCollectionExamples,
  replaceScopeCollection as legacyReplaceScopeCollection,
  fetchUserWorkspaces,
  createCloudWorkspace as legacyCreateCloudWorkspace,
  updateCloudWorkspace as legacyUpdateCloudWorkspace,
  deleteCloudWorkspace as legacyDeleteCloudWorkspace,
  fetchUserTeams,
  fetchTeamProjects,
  fetchScopeCollections,
  fetchCollectionById,
  fetchScopeEnvironments,
  fetchFeaturePolicy,
  normalizeCloudApiUrl,
} from '../lib/cloudApi';
import {
  clearFunctionalSessionHook,
  clearPerformanceDataRowsHook,
  stopActivePerformanceRun,
  stopFunctionalRunHook,
} from '../lib/examples';
import { validateProductPolicy } from '../productPolicy';
import { defaultProductPolicy } from '../lib/edition';
import { createAsyncOperationCoordinator, type AsyncOperation } from './asyncOperationCoordinator';
import { restoreWorkspaceResources } from '../workspace/scopeSnapshot';
import { isCloudSessionActive } from '../workspace/cloudSession';
import {
  normalizeCloudCacheArchives,
  normalizePersistedWorkspaceScopeCache,
  preparePersistedWorkspaceCaches,
  serializeCloudCacheArchives,
} from '../workspace/persistence';
import { archiveCloudCache, captureCloudCache, cloudCacheOwnerKey, emptyCloudCacheArchives } from '../workspace/cloudCacheArchive';
import {
  DEFAULT_OFFLINE_WORKSPACE_ID,
  defaultOfflineWorkspace,
  type ApiStoreState,
  type CreateApiStoreOptions,
  type ScopeCacheEntry,
} from './storeTypes';
import {
  cloneRequestPreservingAttachments,
  createInitialTab,
  defaultRequest,
  ensureUniqueCollectionItemIds,
  getNativeCredentialScope,
  isRequestIdentical,
  MAX_UNDO_HISTORY,
  normalizeCollectionAttachments,
  normalizeHistoryAttachments,
  normalizePersistedRequestAttachments,
  sameNativeCredentialScope,
  serializeCollectionAttachments,
  serializeHistoryAttachments,
  serializeRequestAttachments,
} from './storeHelpers';
import type {
  RuntimeCloudBindings,
  StoreSliceCollections,
  StoreSliceContext,
  StoreSliceGet,
  StoreSliceHelpers,
  StoreSliceRefs,
  StoreSliceSet,
} from './sliceContext';
import { createCloudAuthWorkspaceSlice } from './slices/cloudAuthWorkspaceSlice';
import { createCollectionCrudMoveSlice } from './slices/collectionCrudMoveSlice';
import { createDuplicateSlice } from './slices/duplicateSlice';
import { createEnvironmentSlice } from './slices/environmentSlice';
import { createExamplesAndPerformanceSlice } from './slices/examplesAndPerformanceSlice';
import { createRequestTabsSlice } from './slices/requestTabsSlice';

export type { ApiStore } from './storeContext';
export {
  SCOPE_CACHE_TTL_MS,
  SCOPES_LIST_CACHE_TTL_MS,
  DEFAULT_OFFLINE_WORKSPACE_ID,
  defaultOfflineWorkspace,
} from './storeTypes';
export type {
  ScopeCacheEntry,
  EnvironmentOccConflict,
  SaveRequestToCollectionResult,
  SelectedSavedExample,
  SavedExampleActionResult,
  LoadItemExamplesResult,
  HydrateCollectionExamplesResult,
  ApiStoreState,
  CreateApiStoreOptions,
} from './storeTypes';
export { sanitizeVariablesForUpstream } from './storeHelpers';

export function createApiStore(
  customStorageOrOptions: StateStorage | CreateApiStoreOptions = appStorage,
  adapterParam?: CreateApiStoreOptions['adapter'],
): ApiStore {
  const options = (customStorageOrOptions && typeof (customStorageOrOptions as StateStorage).getItem === 'function')
    ? { storage: customStorageOrOptions as StateStorage, adapter: adapterParam }
    : ((customStorageOrOptions as CreateApiStoreOptions) || {});

  const customStorage = options.storage || appStorage;
  const boundAdapter = options.adapter || adapterParam;
  const credentialStorage = options.credentialStorage || boundAdapter?.credentialStorage;
  const persistCloudCredentials = credentialStorage === undefined;
  const productPolicy = options.productPolicy !== undefined ? validateProductPolicy(options.productPolicy) : defaultProductPolicy;
  const isOfflineOnly = !productPolicy.workspace.cloud;
  const allowsOfflineWorkspace = productPolicy.workspace.offline !== false;

  const cloudClient: RuntimeCloudBindings = {
    fetchFeaturePolicy: options.cloudClient?.fetchFeaturePolicy ?? fetchFeaturePolicy,
    fetchUserWorkspaces: options.cloudClient?.fetchUserWorkspaces ?? fetchUserWorkspaces,
    fetchUserTeams: options.cloudClient?.fetchUserTeams ?? fetchUserTeams,
    fetchTeamProjects: options.cloudClient?.fetchTeamProjects ?? fetchTeamProjects,
    fetchScopeCollections: options.cloudClient?.fetchScopeCollections ?? fetchScopeCollections,
    fetchCollectionById: options.cloudClient?.fetchCollectionById ?? fetchCollectionById,
    fetchScopeEnvironments: options.cloudClient?.fetchScopeEnvironments ?? fetchScopeEnvironments,
    batchImportToScope: options.cloudClient?.batchImportToScope
      ?? ((
        apiUrl: string,
        token: string | undefined,
        scope: ActiveScope | { id: string; type: 'workspace' | 'project' } | string,
        collectionsToImport: Collection[],
        refreshToken?: string,
        signal?: AbortSignal,
        importOptions?: { includeExamples?: boolean },
      ) => legacyBatchImportToScope(apiUrl, token, scope, collectionsToImport, refreshToken, signal, undefined, importOptions)),
    createScopeEnvironment: options.cloudClient?.createScopeEnvironment ?? legacyCreateScopeEnvironment,
    updateScopeEnvironment: options.cloudClient?.updateScopeEnvironment ?? legacyUpdateScopeEnvironment,
    deleteScopeEnvironment: options.cloudClient?.deleteScopeEnvironment ?? legacyDeleteScopeEnvironment,
    deleteScopeCollection: options.cloudClient?.deleteScopeCollection ?? legacyDeleteScopeCollection,
    updateScopeCollectionPermission: options.cloudClient?.updateScopeCollectionPermission ?? legacyUpdateScopeCollectionPermission,
    deleteScopeItem: options.cloudClient?.deleteScopeItem ?? legacyDeleteScopeItem,
    moveScopeCollection: options.cloudClient?.moveScopeCollection ?? legacyMoveScopeCollection,
    moveScopeItem: options.cloudClient?.moveScopeItem ?? legacyMoveScopeItem,
    duplicateScopeCollection: options.cloudClient?.duplicateScopeCollection ?? legacyDuplicateScopeCollection,
    importDuplicateCollection: options.cloudClient?.importDuplicateCollection ?? legacyImportDuplicateCollection,
    duplicateScopeItem: options.cloudClient?.duplicateScopeItem ?? legacyDuplicateScopeItem,
    reorderCollectionItems: options.cloudClient?.reorderCollectionItems ?? legacyReorderCollectionItems,
    patchScopeItemExamples: options.cloudClient?.patchScopeItemExamples ?? legacyPatchScopeItemExamples,
    fetchScopeItem: options.cloudClient?.fetchScopeItem ?? legacyFetchScopeItem,
    fetchScopeCollectionExamples: options.cloudClient?.fetchScopeCollectionExamples ?? legacyFetchScopeCollectionExamples,
    replaceScopeCollection: options.cloudClient?.replaceScopeCollection ?? legacyReplaceScopeCollection,
    createCloudWorkspace: options.cloudClient?.createCloudWorkspace ?? legacyCreateCloudWorkspace,
    updateCloudWorkspace: options.cloudClient?.updateCloudWorkspace ?? legacyUpdateCloudWorkspace,
    deleteCloudWorkspace: options.cloudClient?.deleteCloudWorkspace ?? legacyDeleteCloudWorkspace,
  };

  let hasCompletedInitialHydration = false;
  let initialHydrationPending = false;

  const refs: StoreSliceRefs = {
    isStoreDisposed: false,
    cloudSessionGeneration: 0,
    collectionSaveSyncGeneration: 0,
    activePullOperation: null,
    activeRequestOperation: null,
    activeRequestTabId: null,
    store: null,
  };

  const collections: StoreSliceCollections = {
    envSyncDebounceTimers: {},
    envSyncInFlight: {},
    envSyncQueued: {},
    envIdAliasMap: new Map(),
    pendingEnvCreatePromises: new Map(),
    pendingEnvEditedWhileCreating: new Set(),
    collectionSaveSyncRevisions: new Map(),
    collectionSaveSyncQueues: new Map(),
    pendingReorderBaseSnapshots: new Map(),
    movingCollections: new Map(),
    duplicatingCollections: new Map(),
    inFlightDuplicateOperations: new Set(),
    inFlightExampleOperations: new Set(),
    tabUndoHistory: {},
    undoTypingTimers: {},
    pendingTimers: new Set(),
    asyncOperations: createAsyncOperationCoordinator({
      isDisposed: () => refs.isStoreDisposed,
    }),
    // Feature policy belongs to a session, not an individual workspace scope.
    sessionOperations: createAsyncOperationCoordinator({
      isDisposed: () => refs.isStoreDisposed,
    }),
  };

  function pushTabSnapshot(tabId: string, currentTab: ApiRequest, isTyping = false) {
    if (refs.isStoreDisposed || !tabId || !currentTab) return;
    if (!collections.tabUndoHistory[tabId]) {
      collections.tabUndoHistory[tabId] = { past: [], future: [] };
    }
    const history = collections.tabUndoHistory[tabId];

    if (isTyping) {
      if (collections.undoTypingTimers[tabId]) {
        clearTimeout(collections.undoTypingTimers[tabId]);
        collections.undoTypingTimers[tabId] = setTimeout(() => {
          delete collections.undoTypingTimers[tabId];
        }, 500);
        return;
      }

      history.past.push(cloneRequestPreservingAttachments(currentTab));
      if (history.past.length > MAX_UNDO_HISTORY) {
        history.past.shift();
      }
      history.future = [];

      collections.undoTypingTimers[tabId] = setTimeout(() => {
        delete collections.undoTypingTimers[tabId];
      }, 500);
    } else {
      if (collections.undoTypingTimers[tabId]) {
        clearTimeout(collections.undoTypingTimers[tabId]);
        delete collections.undoTypingTimers[tabId];
      }

      const last = history.past[history.past.length - 1];
      if (last && isRequestIdentical(last, currentTab)) {
        return;
      }

      history.past.push(cloneRequestPreservingAttachments(currentTab));
      if (history.past.length > MAX_UNDO_HISTORY) {
        history.past.shift();
      }
      history.future = [];
    }
  }

  function safeSetTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      collections.pendingTimers.delete(timer);
      if (!refs.isStoreDisposed) {
        fn();
      }
    }, ms);
    collections.pendingTimers.add(timer);
    return timer;
  }

  function safeReleaseRawBody(id?: string): void {
    if (typeof releaseRawBody === 'function') {
      releaseRawBody(id);
    }
  }

  function safeReleaseRawBodies(ids: Iterable<string | undefined>): void {
    if (typeof releaseRawBodies === 'function') {
      releaseRawBodies(ids);
    }
  }

  function safeEvictRawBodiesToBudget(pinnedIds: Iterable<string>): void {
    if (typeof evictRawBodiesToBudget === 'function') {
      evictRawBodiesToBudget(pinnedIds);
    }
  }

  function stripHistoryBlobUrls(history: HistoryItem[] | undefined): HistoryItem[] {
    if (!history || history.length === 0) return [];
    return history.map((entry) =>
      entry.response?.blobUrl
        ? { ...entry, response: { ...entry.response, blobUrl: undefined } }
        : entry
    );
  }

  function stripBackgroundCacheBlobUrls(
    cache: Record<string, ScopeCacheEntry> | undefined,
    activeKey?: string | null
  ): Record<string, ScopeCacheEntry> {
    if (!cache) return {};
    const next: Record<string, ScopeCacheEntry> = {};
    for (const [key, entry] of Object.entries(cache)) {
      if (!entry) continue;
      next[key] =
        key === activeKey || !entry.history?.some((h) => h.response?.blobUrl)
          ? entry
          : { ...entry, history: stripHistoryBlobUrls(entry.history) };
    }
    return next;
  }

  function ensureResponseImageBlobUrl(response: ApiResponse | null | undefined): ApiResponse | null | undefined {
    if (!response || !response.isImage || response.blobUrl || !response.rawBodyId) {
      return response;
    }
    if (typeof rebuildTrackedImageBlobUrl !== 'function') return response;
    const rebuiltUrl = rebuildTrackedImageBlobUrl(response.rawBodyId, response.contentType);
    return rebuiltUrl ? { ...response, blobUrl: rebuiltUrl } : response;
  }

  function collectProtectedResponseHandles(
    responses: Iterable<ApiResponse | null | undefined>,
    histories: Array<Array<HistoryItem> | undefined>,
    rawOnlyHistories: Array<Array<HistoryItem> | undefined> = []
  ): { blobUrls: Set<string>; rawBodyIds: Set<string> } {
    const blobUrls = new Set<string>();
    const rawBodyIds = new Set<string>();
    for (const res of responses) {
      if (!res) continue;
      if (res.blobUrl) blobUrls.add(res.blobUrl);
      if (res.rawBodyId) rawBodyIds.add(res.rawBodyId);
    }
    for (const hist of histories) {
      if (!hist) continue;
      for (const item of hist) {
        if (item.response?.blobUrl) blobUrls.add(item.response.blobUrl);
        if (item.response?.rawBodyId) rawBodyIds.add(item.response.rawBodyId);
      }
    }
    for (const hist of rawOnlyHistories) {
      if (!hist) continue;
      for (const item of hist) {
        if (item.response?.rawBodyId) rawBodyIds.add(item.response.rawBodyId);
      }
    }
    return { blobUrls, rawBodyIds };
  }

  function revokeUnreferencedResponses(
    candidates: Iterable<ApiResponse | null | undefined>,
    protectedResponses: Iterable<ApiResponse | null | undefined>,
    protectedHistories: Array<Array<HistoryItem> | undefined>,
    rawOnlyHistories: Array<Array<HistoryItem> | undefined> = []
  ) {
    const { blobUrls: protectedBlobs, rawBodyIds: protectedRawIds } = collectProtectedResponseHandles(
      protectedResponses,
      protectedHistories,
      rawOnlyHistories
    );

    const blobsToRevoke = new Set<string>();
    const rawIdsToRelease = new Set<string>();
    for (const res of candidates) {
      if (!res) continue;
      if (res.blobUrl && !protectedBlobs.has(res.blobUrl)) {
        blobsToRevoke.add(res.blobUrl);
      }
      if (res.rawBodyId && !protectedRawIds.has(res.rawBodyId)) {
        rawIdsToRelease.add(res.rawBodyId);
      }
    }
    revokeBlobUrls(blobsToRevoke);
    safeReleaseRawBodies(rawIdsToRelease);
  }

  function revokeUnreferencedTabBlobs(
    prevTabResponses: Record<string, ApiResponse> | undefined,
    prevActiveResponse: ApiResponse | null | undefined,
    protectedHistories: Array<Array<HistoryItem> | undefined>,
    rawOnlyHistories: Array<Array<HistoryItem> | undefined> = [],
    prevHistory: Array<HistoryItem> | undefined = []
  ) {
    revokeUnreferencedResponses(
      [
        prevActiveResponse,
        ...(prevTabResponses ? Object.values(prevTabResponses) : []),
        ...(prevHistory || []).map((entry) => entry.response),
      ],
      [],
      protectedHistories,
      rawOnlyHistories
    );
  }

  function beginAsyncOperation(): AsyncOperation {
    return collections.asyncOperations.begin();
  }

  function completeAsyncOperation(operation: AsyncOperation) {
    collections.asyncOperations.complete(operation);
  }

  function isAsyncOperationCurrent(operation: AsyncOperation): boolean {
    return collections.asyncOperations.isCurrent(operation);
  }

  function enqueueCollectionSyncTask(
    collectionId: string,
    scope: ActiveScope,
    work: (operation: AsyncOperation, generation: number) => Promise<void>,
  ): Promise<void> {
    const queueKey = `${scope.type}:${scope.id}:${collectionId}`;
    const generation = refs.collectionSaveSyncGeneration;
    const previous = collections.collectionSaveSyncQueues.get(queueKey) ?? Promise.resolve();

    const task = previous.catch(() => undefined).then(async () => {
      if (generation !== refs.collectionSaveSyncGeneration || refs.isStoreDisposed) return;

      const operation = beginAsyncOperation();
      try {
        await work(operation, generation);
      } finally {
        completeAsyncOperation(operation);
      }
    });

    collections.collectionSaveSyncQueues.set(queueKey, task);
    void task.finally(() => {
      if (collections.collectionSaveSyncQueues.get(queueKey) === task) {
        collections.collectionSaveSyncQueues.delete(queueKey);
      }
    });
    return task;
  }

  function queueSavedCollectionSync(
    collection: Collection,
    scope: ActiveScope,
    cloudConfig: ApiStoreState['cloudConfig'],
    revision: number,
    getState: StoreSliceGet,
    setState: StoreSliceSet,
    errorPrefix = 'Failed to sync saved request to cloud',
  ): void {
    void enqueueCollectionSyncTask(collection.id, scope, async (operation, generation) => {
      try {
        const liveCloudConfig = getState().cloudConfig;
        await cloudClient.batchImportToScope(
          liveCloudConfig.apiUrl || cloudConfig.apiUrl,
          liveCloudConfig.token || cloudConfig.token,
          scope,
          [collection],
          liveCloudConfig.refreshToken ?? cloudConfig.refreshToken,
          operation.controller.signal,
          { includeExamples: false },
        );

        if (
          !isAsyncOperationCurrent(operation) ||
          generation !== refs.collectionSaveSyncGeneration ||
          collections.collectionSaveSyncRevisions.get(collection.id) !== revision ||
          getState().cloudConfig.activeScope?.id !== scope.id ||
          getState().cloudConfig.activeScope?.type !== scope.type
        ) {
          return;
        }

        setState((state) => ({
          collections: state.collections.map((candidate) =>
            candidate.id === collection.id ? { ...candidate, _syncStatus: 'synced' } : candidate,
          ),
        }));
      } catch (error: unknown) {
        if (
          operation.controller.signal.aborted ||
          !isAsyncOperationCurrent(operation) ||
          generation !== refs.collectionSaveSyncGeneration ||
          collections.collectionSaveSyncRevisions.get(collection.id) !== revision
        ) {
          return;
        }

        const message = error instanceof Error ? error.message : errorPrefix;
        console.error(`${errorPrefix}:`, error);
        setState((state) => ({
          collections: state.collections.map((candidate) =>
            candidate.id === collection.id ? { ...candidate, _syncStatus: 'pending' } : candidate,
          ),
          syncStatus: 'error',
          syncError: message,
        }));
      }
    });
  }

  function invalidateAsyncOperations({ session = false }: { session?: boolean } = {}) {
    collections.collectionSaveSyncQueues.clear();
    collections.collectionSaveSyncRevisions.clear();
    collections.pendingReorderBaseSnapshots.clear();
    collections.movingCollections.clear();
    collections.duplicatingCollections.clear();
    refs.collectionSaveSyncGeneration += 1;
    collections.asyncOperations.invalidate({ session });
    if (session) {
      refs.cloudSessionGeneration += 1;
      collections.envIdAliasMap.clear();
      collections.pendingEnvCreatePromises.clear();
      collections.pendingEnvEditedWhileCreating.clear();
      collections.sessionOperations.invalidate({ session: true });
    }
    for (const id of Object.keys(collections.envSyncDebounceTimers)) {
      clearTimeout(collections.envSyncDebounceTimers[id]);
      delete collections.envSyncDebounceTimers[id];
    }
    for (const id of Object.keys(collections.envSyncInFlight)) {
      delete collections.envSyncInFlight[id];
    }
    for (const id of Object.keys(collections.envSyncQueued)) {
      delete collections.envSyncQueued[id];
    }
    for (const timer of collections.pendingTimers) {
      clearTimeout(timer);
    }
    collections.pendingTimers.clear();
  }

  function getPersistOptions(): ReturnType<ApiStore['persist']['getOptions']> {
    return refs.store!.persist.getOptions();
  }

  async function flushStorePersistence() {
    const persistOpts = refs.store?.persist?.getOptions?.();
    if (!persistOpts?.name) return;
    const partialize = persistOpts.partialize;
    const persistedState = partialize ? partialize(refs.store!.getState()) : refs.store!.getState();
    const serialized = JSON.stringify({ state: persistedState, version: persistOpts.version ?? 0 });
    await customStorage.setItem(persistOpts.name, serialized);
  }

  const uninitializedHelper = (name: string) => () => {
    throw new Error(`Store slice helper "${name}" was invoked before slice initialization.`);
  };

  const helpers: StoreSliceHelpers = {
    beginAsyncOperation,
    completeAsyncOperation,
    isAsyncOperationCurrent,
    invalidateAsyncOperations,
    safeSetTimeout,
    pushTabSnapshot,
    safeReleaseRawBody,
    safeReleaseRawBodies,
    safeEvictRawBodiesToBudget,
    stripHistoryBlobUrls,
    stripBackgroundCacheBlobUrls,
    ensureResponseImageBlobUrl,
    collectProtectedResponseHandles,
    revokeUnreferencedResponses,
    revokeUnreferencedTabBlobs,
    enqueueCollectionSyncTask,
    queueSavedCollectionSync,
    getPersistOptions,
    flushStorePersistence,
    resolveCanonicalEnvId: uninitializedHelper('resolveCanonicalEnvId'),
    isCloudEnvSyncActive: uninitializedHelper('isCloudEnvSyncActive'),
    dispatchCloudEnvironmentCreate: uninitializedHelper('dispatchCloudEnvironmentCreate'),
    scheduleEnvironmentCloudSync: uninitializedHelper('scheduleEnvironmentCloudSync'),
    isSelectedExampleStillPresent: uninitializedHelper('isSelectedExampleStillPresent'),
    pruneExampleTabsState: uninitializedHelper('pruneExampleTabsState'),
    ensureSavedExamplesCapability: uninitializedHelper('ensureSavedExamplesCapability'),
    commitServerItemToStore: uninitializedHelper('commitServerItemToStore'),
    executeExampleIntent: uninitializedHelper('executeExampleIntent'),
    replayPendingExampleIntentsForScope: uninitializedHelper('replayPendingExampleIntentsForScope'),
    commitItemMove: uninitializedHelper('commitItemMove'),
  };

  const ctx: StoreSliceContext = {
    set: uninitializedHelper('set') as StoreSliceSet,
    get: uninitializedHelper('get') as StoreSliceGet,
    customStorage,
    boundAdapter,
    credentialStorage,
    persistCloudCredentials,
    productPolicy,
    isOfflineOnly,
    allowsOfflineWorkspace,
    cloudClient,
    refs,
    collections,
    helpers,
  };

  const store: ApiStore = create<ApiStoreState>()(
    persist(
      (rawSet, get) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const set: typeof rawSet = ((fnOrState: any, replace?: any) => {
          if (refs.isStoreDisposed) return;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (rawSet as any)(fnOrState, replace);
        }) as typeof rawSet;

        ctx.set = set;
        ctx.get = get;

        const environmentSlice = createEnvironmentSlice(ctx);
        const examplesAndPerformanceSlice = createExamplesAndPerformanceSlice(ctx);
        const collectionCrudMoveSlice = createCollectionCrudMoveSlice(ctx);
        const duplicateSlice = createDuplicateSlice(ctx);
        const requestTabsSlice = createRequestTabsSlice(ctx);
        const cloudAuthWorkspaceSlice = createCloudAuthWorkspaceSlice(ctx);

        return {
          tabs: [defaultRequest],
          activeTabId: defaultRequest.id,
          activeResponse: null,
          tabResponses: {},
          tabRevealRevision: 0,
          isLoading: false,
          collections: [],
          history: [],
          sidebarTab: 'collections',
          canUndoActiveRequest: false,
          canRedoActiveRequest: false,
          theme: 'system',
          setTheme: (newTheme: ThemeMode) => {
            applyTheme(newTheme);
            set({ theme: newTheme });
          },
          environments: [],
          activeEnvironmentId: null,

          // Offline Workspaces
          offlineWorkspaces: [defaultOfflineWorkspace],
          activeOfflineWorkspaceId: DEFAULT_OFFLINE_WORKSPACE_ID,
          offlineScopeCache: {
            [DEFAULT_OFFLINE_WORKSPACE_ID]: {
              collections: [],
              environments: [],
              activeEnvironmentId: null,
              tabs: [defaultRequest],
              activeTabId: defaultRequest.id,
              history: [],
            },
          },

          // Workspace Mode & Cloud Sync State
          workspaceMode: allowsOfflineWorkspace ? 'offline' : 'cloud',
          hasConfiguredMode: isOfflineOnly || !allowsOfflineWorkspace,
          cloudConfig: {
            apiUrl: 'http://localhost:8080',
          },
          nativeCredentialState: undefined,
          featurePolicy: null,
          featurePolicyStatus: 'idle',
          featurePolicyFetchedAt: null,
          syncStatus: 'idle',
          lastSyncedAt: null,
          syncError: null,
          environmentOccConflict: null,
          scopeCache: {},
          cloudCacheOwner: null,
          cloudCacheArchives: emptyCloudCacheArchives(),
          openExampleTabs: [],
          openPerformanceTabs: [],
          tabOrder: [],
          selectedExample: null,
          selectedPerformanceTabId: null,
          performanceReports: {},
          functionalReports: {},
          pendingExampleIntents: {},
          pendingDuplicateIntents: {},
          activeDuplicateOperationIds: {},
          lastDuplicateReveal: null,
          scopesCache: undefined,
          isSwitchingWorkspace: false,

          ...cloudAuthWorkspaceSlice,
          ...environmentSlice,
          ...requestTabsSlice,
          ...collectionCrudMoveSlice,
          ...examplesAndPerformanceSlice,
          ...duplicateSlice,
        };
      },
      {
        name: 'air-rest-storage',
        storage: createJSONStorage(() => ({
          getItem: (name) => customStorage.getItem(name),
          setItem: async (name, value) => {
            if (initialHydrationPending) {
              return;
            }
            try {
              await customStorage.setItem(name, value);
            } catch {
              // Background Zustand writes swallow unhandled rejections; explicit operations await persistNativeCredentialState().
            }
          },
          removeItem: (name) => customStorage.removeItem(name),
        })),
        partialize: (state) => {
          const providerSession = state.cloudConfig.sessionKind === 'provider';
          const nativeScope = getNativeCredentialScope(state.cloudConfig);
          const preserveLegacyCredentials = state.nativeCredentialState?.phase === 'legacy-pending' &&
            sameNativeCredentialScope(state.nativeCredentialState.scope, nativeScope);
          const hideProviderView = providerSession && state.workspaceMode === 'cloud';
          const providerOwner = cloudCacheOwnerKey(state.cloudConfig, normalizeCloudApiUrl);
          const archives = providerSession
            ? archiveCloudCache(
              state.cloudCacheArchives,
              state.cloudCacheOwner === providerOwner ? providerOwner : null,
              captureCloudCache({
                config: state.cloudConfig,
                workspaceMode: state.workspaceMode,
                scopeCache: state.scopeCache || {},
                scopesCache: state.scopesCache,
                resources: state,
                lastSyncedAt: state.lastSyncedAt,
              }),
            )
            : state.cloudCacheArchives;
          const persistedTabs = state.tabs.map(serializeRequestAttachments);
          const persistedCollections = state.collections.map(serializeCollectionAttachments);
          const persistedHistory = serializeHistoryAttachments(state.history);
          const { offlineScopeCache, scopeCache } = preparePersistedWorkspaceCaches({
            workspaceMode: state.workspaceMode,
            activeOfflineWorkspaceId: state.activeOfflineWorkspaceId,
            activeCloudScope: state.cloudConfig.activeScope,
            lastSyncedAt: state.lastSyncedAt,
            resources: {
              collections: state.collections,
              environments: state.environments,
              activeEnvironmentId: state.activeEnvironmentId,
              tabs: state.tabs,
              activeTabId: state.activeTabId,
              history: state.history,
            },
            offlineScopeCache: state.offlineScopeCache || {},
            scopeCache: state.scopeCache || {},
            serializeRequest: serializeRequestAttachments,
            serializeCollection: serializeCollectionAttachments,
            serializeHistory: serializeHistoryAttachments,
          });
          return {
            tabs: hideProviderView ? [] : persistedTabs,
            activeTabId: hideProviderView ? '' : state.activeTabId,
            collections: hideProviderView ? [] : persistedCollections,
            history: hideProviderView ? [] : persistedHistory,
            environments: hideProviderView ? [] : state.environments,
            activeEnvironmentId: hideProviderView ? null : state.activeEnvironmentId,
            offlineWorkspaces: state.offlineWorkspaces,
            activeOfflineWorkspaceId: state.activeOfflineWorkspaceId,
            offlineScopeCache,
            scopeCache: providerSession ? {} : scopeCache,
            cloudCacheOwner: providerSession ? null : state.cloudCacheOwner,
            cloudCacheArchives: serializeCloudCacheArchives(archives, {
              serializeRequest: serializeRequestAttachments,
              serializeCollection: serializeCollectionAttachments,
              serializeHistory: serializeHistoryAttachments,
            }),
            scopesCache: providerSession ? undefined : state.scopesCache,
            workspaceMode: isOfflineOnly ? 'offline' : !allowsOfflineWorkspace ? 'cloud' : state.workspaceMode,
            hasConfiguredMode: isOfflineOnly || !allowsOfflineWorkspace ? true : state.hasConfiguredMode,
            cloudConfig: providerSession
              ? { apiUrl: state.cloudConfig.apiUrl, hubUrl: state.cloudConfig.hubUrl }
              : persistCloudCredentials || preserveLegacyCredentials
                ? state.cloudConfig
                : {
                  ...state.cloudConfig,
                  token: undefined,
                  refreshToken: undefined,
                  tokenExpiresAt: undefined,
                },
            nativeCredentialState: state.nativeCredentialState,
            nativeCredentialCleanupPending: state.nativeCredentialCleanupPending ? true : undefined,
            pendingExampleIntents: state.pendingExampleIntents || {},
            pendingDuplicateIntents: state.pendingDuplicateIntents || {},
            theme: state.theme ?? 'system',
          };
        },
        onRehydrateStorage: () => {
          if (!hasCompletedInitialHydration) {
            initialHydrationPending = true;
          }
          return (state) => {
            hasCompletedInitialHydration = true;
            initialHydrationPending = false;
            if (!state) return;

            if (!state.theme) {
              state.theme = 'system';
            }
            applyTheme(state.theme);

            state.tabs = (state.tabs || []).map(normalizePersistedRequestAttachments);
            state.collections = ensureUniqueCollectionItemIds((state.collections || []).map(normalizeCollectionAttachments));
            state.history = normalizeHistoryAttachments(state.history || []);
            const cacheNormalizers = {
              normalizeRequest: normalizePersistedRequestAttachments,
              normalizeCollections: (cols: Collection[]) => ensureUniqueCollectionItemIds(
                cols.map(normalizeCollectionAttachments),
              ),
              normalizeHistory: normalizeHistoryAttachments,
            };
            state.offlineScopeCache = normalizePersistedWorkspaceScopeCache(state.offlineScopeCache, cacheNormalizers);
            state.scopeCache = normalizePersistedWorkspaceScopeCache(state.scopeCache, cacheNormalizers);
            state.cloudCacheArchives = normalizeCloudCacheArchives(state.cloudCacheArchives, cacheNormalizers);

            const legacyScope = credentialStorage ? getNativeCredentialScope(state.cloudConfig) : null;
            if (credentialStorage && state.nativeCredentialState?.phase === 'cleanup-pending') {
              state.nativeCredentialCleanupPending = true;
            }
            if (credentialStorage && !state.nativeCredentialState && legacyScope) {
              state.nativeCredentialState = {
                version: 1,
                scope: legacyScope,
                phase: state.cloudConfig.token
                  ? 'legacy-pending'
                  : state.nativeCredentialCleanupPending
                    ? 'cleanup-pending'
                    : 'ready',
              };
            } else if (
              credentialStorage &&
              state.nativeCredentialCleanupPending &&
              state.nativeCredentialState?.phase === 'ready'
            ) {
              state.nativeCredentialState = {
                ...state.nativeCredentialState,
                phase: 'cleanup-pending',
              };
            }

            // Older or externally written storage may contain a provider-session
            // marker. Treat it as unverified and retain its data only as an archive.
            if (state.cloudConfig?.sessionKind === 'provider') {
              const owner = cloudCacheOwnerKey(state.cloudConfig, normalizeCloudApiUrl);
              state.cloudCacheArchives = archiveCloudCache(
                state.cloudCacheArchives,
                state.cloudCacheOwner === owner ? owner : null,
                captureCloudCache({
                  config: state.cloudConfig,
                  workspaceMode: state.workspaceMode,
                  scopeCache: state.scopeCache || {},
                  scopesCache: state.scopesCache,
                  resources: state,
                  lastSyncedAt: state.lastSyncedAt,
                }),
              );
              if (state.workspaceMode === 'cloud') {
                Object.assign(state, restoreWorkspaceResources(undefined, createInitialTab), { lastSyncedAt: null });
              }
              state.cloudConfig = { apiUrl: state.cloudConfig.apiUrl, hubUrl: state.cloudConfig.hubUrl };
              state.cloudCacheOwner = null;
              state.scopeCache = {};
              state.scopesCache = undefined;
            } else {
              const nativeScope = getNativeCredentialScope(state.cloudConfig);
              const nativeIdentityIsCurrent = credentialStorage &&
                sameNativeCredentialScope(state.nativeCredentialState?.scope, nativeScope);
              const owner = (isCloudSessionActive(state.cloudConfig) || nativeIdentityIsCurrent)
                ? cloudCacheOwnerKey(state.cloudConfig, normalizeCloudApiUrl) : null;
              const hasUnownedData = Object.keys(state.scopeCache || {}).length > 0 || Boolean(state.scopesCache) ||
                (state.workspaceMode === 'cloud' && Boolean(state.cloudConfig.activeScope?.id ||
                  state.collections.length || state.environments.length || state.history.length));
              if (hasUnownedData && (!owner || state.cloudCacheOwner !== owner)) {
                state.cloudCacheArchives = archiveCloudCache(
                  state.cloudCacheArchives,
                  null,
                  captureCloudCache({
                    config: state.cloudConfig,
                    workspaceMode: state.workspaceMode,
                    scopeCache: state.scopeCache || {},
                    scopesCache: state.scopesCache,
                    resources: state,
                    lastSyncedAt: state.lastSyncedAt,
                  }),
                );
                if (state.workspaceMode === 'cloud') {
                  Object.assign(state, restoreWorkspaceResources(undefined, createInitialTab), { lastSyncedAt: null });
                }
                state.cloudConfig = { apiUrl: state.cloudConfig.apiUrl, hubUrl: state.cloudConfig.hubUrl };
                state.cloudCacheOwner = null;
                state.scopeCache = {};
                state.scopesCache = undefined;
              }
            }

            const hasRecoverableCloudIdentity = Boolean(
              isCloudSessionActive(state.cloudConfig) ||
              (credentialStorage &&
                sameNativeCredentialScope(
                  state.nativeCredentialState?.scope,
                  getNativeCredentialScope(state.cloudConfig)
                ))
            );

            if (
              state.workspaceMode === 'cloud' &&
              (isOfflineOnly || (allowsOfflineWorkspace && !hasRecoverableCloudIdentity))
            ) {
              const localId = state.activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
              const local = restoreWorkspaceResources(state.offlineScopeCache?.[localId], createInitialTab);
              Object.assign(state, local, {
                workspaceMode: 'offline',
                ...(isOfflineOnly ? { hasConfiguredMode: true } : {}),
                lastSyncedAt: null,
              });
            }

            // A cloud-only product must never reopen the active offline workspace.
            // Preserve the offline cache for other product profiles while clearing its live view.
            if (!allowsOfflineWorkspace && state.workspaceMode === 'offline') {
              const blank = restoreWorkspaceResources(undefined, createInitialTab);
              Object.assign(state, blank, { workspaceMode: 'cloud', hasConfiguredMode: true, lastSyncedAt: null });
            }

            if (state.cloudConfig?.apiUrl) {
              state.cloudConfig.apiUrl = normalizeCloudApiUrl(state.cloudConfig.apiUrl);
            }

            const persistedOfflineId = state.activeOfflineWorkspaceId;

            // 1. Ensure offlineWorkspaces has at least the default workspace
            if (!state.offlineWorkspaces || state.offlineWorkspaces.length === 0) {
              state.offlineWorkspaces = [defaultOfflineWorkspace];
              state.activeOfflineWorkspaceId = DEFAULT_OFFLINE_WORKSPACE_ID;
            }

            // 2. Ensure activeOfflineWorkspaceId is valid
            if (
              !state.activeOfflineWorkspaceId ||
              !state.offlineWorkspaces.some((w) => w.id === state.activeOfflineWorkspaceId)
            ) {
              state.activeOfflineWorkspaceId = state.offlineWorkspaces[0].id;
            }

            // 3. Ensure offlineScopeCache exists
            if (!state.offlineScopeCache) {
              state.offlineScopeCache = {};
            }

            const activeLocalId = state.activeOfflineWorkspaceId;
            if (
              persistedOfflineId &&
              persistedOfflineId !== activeLocalId &&
              state.offlineScopeCache[persistedOfflineId]
            ) {
              const existingTarget = state.offlineScopeCache[activeLocalId];
              const targetIsEmpty =
                !existingTarget ||
                (((existingTarget.collections || []).length === 0) &&
                  ((existingTarget.environments || []).length === 0));
              if (targetIsEmpty) {
                state.offlineScopeCache[activeLocalId] = state.offlineScopeCache[persistedOfflineId];
              }
            }

            if (!state.offlineScopeCache[activeLocalId]) {
              state.offlineScopeCache[activeLocalId] = {
                collections: state.workspaceMode === 'offline' ? state.collections : [],
                environments: state.workspaceMode === 'offline' ? state.environments : [],
                activeEnvironmentId: state.workspaceMode === 'offline' ? state.activeEnvironmentId : null,
                tabs: (state.workspaceMode === 'offline' && state.tabs && state.tabs.length > 0)
                  ? state.tabs
                  : [createInitialTab()],
                activeTabId: state.workspaceMode === 'offline' ? state.activeTabId : undefined,
                history: state.workspaceMode === 'offline' ? state.history : [],
              };
            }

            // 4. If currently in offline mode, ensure state aligns with the active offline workspace
            if (state.workspaceMode === 'offline') {
              const currentEntry = state.offlineScopeCache[activeLocalId];
              if (currentEntry) {
                if (
                  (currentEntry.collections || []).length === 0 &&
                  persistedOfflineId !== activeLocalId &&
                  (state.collections || []).length > 0
                ) {
                  currentEntry.collections = state.collections;
                }
                if (
                  (currentEntry.environments || []).length === 0 &&
                  persistedOfflineId !== activeLocalId &&
                  (state.environments || []).length > 0
                ) {
                  currentEntry.environments = state.environments;
                  currentEntry.activeEnvironmentId = state.activeEnvironmentId || null;
                }
                state.collections = currentEntry.collections || [];
                state.environments = currentEntry.environments || [];
                state.activeEnvironmentId = currentEntry.activeEnvironmentId || null;
                if (currentEntry.tabs && currentEntry.tabs.length > 0) {
                  state.tabs = currentEntry.tabs;
                  state.activeTabId = currentEntry.activeTabId && state.tabs.some((t) => t.id === currentEntry.activeTabId)
                    ? currentEntry.activeTabId
                    : state.tabs[0].id;
                }
                state.history = currentEntry.history || [];
              }
            }

            // 5. Ensure valid tab state and activeTabId alignment
            if (!state.tabs || !Array.isArray(state.tabs)) {
              state.tabs = [];
              state.activeTabId = '';
            } else if (state.tabs.length > 0 && (!state.activeTabId || !state.tabs.some((t) => t.id === state.activeTabId))) {
              state.activeTabId = state.tabs[0].id;
            } else if (state.tabs.length === 0) {
              state.activeTabId = '';
            }
            state.openExampleTabs = [];
            state.openPerformanceTabs = [];
            state.selectedExample = null;
            state.selectedPerformanceTabId = null;
            state.performanceReports = {};
            state.functionalReports = {};
            state.tabOrder = state.tabs.map((t) => t.id);
          };
        },
      }
    )
  );

  refs.store = store;

  const originalSetState = store.setState;
  Object.defineProperty(store, 'productPolicy', { value: productPolicy, enumerable: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store.setState = ((fnOrState: any, replace?: any) => {
    if (refs.isStoreDisposed) return;
    return originalSetState(fnOrState, replace);
  }) as typeof store.setState;

  (store as ApiStore).dispose = () => {
    void stopActivePerformanceRun?.();
    void stopFunctionalRunHook?.();
    clearPerformanceDataRowsHook?.();
    clearFunctionalSessionHook?.();
    const snapshot = store.getState();
    const { blobUrls, rawBodyIds } = collectProtectedResponseHandles(
      [snapshot.activeResponse, ...Object.values(snapshot.tabResponses || {})],
      [
        snapshot.history,
        ...Object.values(snapshot.scopeCache || {}).map((e) => e.history),
        ...Object.values(snapshot.offlineScopeCache || {}).map((e) => e.history),
      ]
    );
    revokeBlobUrls(blobUrls);
    safeReleaseRawBodies(rawBodyIds);

    refs.isStoreDisposed = true;
    for (const key of Object.keys(collections.undoTypingTimers)) {
      clearTimeout(collections.undoTypingTimers[key]);
      delete collections.undoTypingTimers[key];
    }
    for (const key of Object.keys(collections.tabUndoHistory)) {
      delete collections.tabUndoHistory[key];
    }
    invalidateAsyncOperations({ session: true });
  };

  return store as ApiStore;
}

let _activeRuntimeStore: ApiStore | null = null;
let _defaultApiStoreInstance: ApiStore | null = null;

export function setActiveRuntimeStore(store: ApiStore | null): void {
  _activeRuntimeStore = store;
}

export function getActiveRuntimeStore(): ApiStore | null {
  return _activeRuntimeStore;
}

export function getDefaultApiStore(): ApiStore {
  if (!_defaultApiStoreInstance) {
    _defaultApiStoreInstance = createApiStore();
  }
  return _defaultApiStoreInstance;
}

function resolveCurrentStore(contextStore?: ApiStore | null): ApiStore {
  return contextStore || _activeRuntimeStore || _defaultApiStoreInstance || getDefaultApiStore();
}

export const defaultApiStore: ApiStore = new Proxy({} as ApiStore, {
  get(_target, prop, receiver) {
    const store = resolveCurrentStore();
    const val = Reflect.get(store, prop, receiver);
    if (typeof val === 'function') {
      return val.bind(store);
    }
    return val;
  },
  apply(_target, thisArg, argArray) {
    const store = resolveCurrentStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Reflect.apply(store as any, thisArg, argArray);
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const useApiStore = ((...args: [any?, any?]) => {
  const contextStore = useContext(StoreContext);
  const store = resolveCurrentStore(contextStore);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (store as any)(...args);
}) as ApiStore;

const storeMethods = ['getState', 'setState', 'subscribe', 'destroy'] as const;
for (const method of storeMethods) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (useApiStore as any)[method] = (...args: any[]) => {
    const store = resolveCurrentStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (store as any)[method](...args);
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(useApiStore as any).dispose = () => {
  const store = resolveCurrentStore();
  return store.dispose?.();
};
Object.defineProperty(useApiStore, 'persist', {
  get: () => resolveCurrentStore().persist,
  configurable: true,
});
