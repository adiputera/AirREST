import type { StoreApi } from 'zustand';
import type { StateStorage } from 'zustand/middleware';
import type {
  ActiveScope,
  ApiRequest,
  ApiResponse,
  Collection,
  CollectionItem,
  Environment,
  HistoryItem,
  PendingExampleIntent,
} from '../types/api';
import type { NativeCredentialStorage } from '../types/credentials';
import type { PlatformAdapter } from '../types/platform';
import type { ProductPolicy } from '../productPolicy';
import type { CloudClient } from '../lib/cloudApi';
import type { AsyncOperation, createAsyncOperationCoordinator } from './asyncOperationCoordinator';
import type {
  ApiStore,
  ApiStoreState,
  SavedExampleActionResult,
  ScopeCacheEntry,
  SelectedSavedExample,
  TabUndoEntry,
} from './storeTypes';

export type AsyncOperationCoordinator = ReturnType<typeof createAsyncOperationCoordinator>;
export type StoreSliceSet = StoreApi<ApiStoreState>['setState'];
export type StoreSliceGet = () => ApiStoreState;

export type RuntimeCloudBindings = Pick<
  CloudClient,
  | 'fetchFeaturePolicy'
  | 'fetchUserWorkspaces'
  | 'fetchUserTeams'
  | 'fetchTeamProjects'
  | 'fetchScopeCollections'
  | 'fetchCollectionById'
  | 'fetchScopeEnvironments'
  | 'batchImportToScope'
  | 'createScopeEnvironment'
  | 'updateScopeEnvironment'
  | 'deleteScopeEnvironment'
  | 'deleteScopeCollection'
  | 'updateScopeCollectionPermission'
  | 'deleteScopeItem'
  | 'moveScopeCollection'
  | 'moveScopeItem'
  | 'duplicateScopeCollection'
  | 'importDuplicateCollection'
  | 'duplicateScopeItem'
  | 'reorderCollectionItems'
  | 'patchScopeItemExamples'
  | 'fetchScopeItem'
  | 'fetchScopeCollectionExamples'
  | 'replaceScopeCollection'
  | 'createCloudWorkspace'
  | 'updateCloudWorkspace'
  | 'deleteCloudWorkspace'
>;

export interface StoreSliceRefs {
  isStoreDisposed: boolean;
  cloudSessionGeneration: number;
  collectionSaveSyncGeneration: number;
  activePullOperation: AsyncOperation | null;
  activeRequestOperation: AsyncOperation | null;
  activeRequestTabId: string | null;
  store: ApiStore | null;
}

export interface StoreSliceCollections {
  envSyncDebounceTimers: Record<string, ReturnType<typeof setTimeout>>;
  envSyncInFlight: Record<string, boolean>;
  envSyncQueued: Record<string, boolean>;
  envIdAliasMap: Map<string, string>;
  pendingEnvCreatePromises: Map<string, Promise<string | null>>;
  pendingEnvEditedWhileCreating: Set<string>;
  collectionSaveSyncRevisions: Map<string, number>;
  collectionSaveSyncQueues: Map<string, Promise<void>>;
  pendingReorderBaseSnapshots: Map<string, { items: CollectionItem[]; syncStatus?: Collection['_syncStatus'] }>;
  movingCollections: Map<string, symbol>;
  duplicatingCollections: Map<string, symbol>;
  inFlightDuplicateOperations: Set<string>;
  inFlightExampleOperations: Set<string>;
  tabUndoHistory: Record<string, TabUndoEntry>;
  undoTypingTimers: Record<string, ReturnType<typeof setTimeout>>;
  pendingTimers: Set<ReturnType<typeof setTimeout>>;
  asyncOperations: AsyncOperationCoordinator;
  sessionOperations: AsyncOperationCoordinator;
}

export interface StoreSliceHelpers {
  beginAsyncOperation: () => AsyncOperation;
  completeAsyncOperation: (operation: AsyncOperation) => void;
  isAsyncOperationCurrent: (operation: AsyncOperation) => boolean;
  invalidateAsyncOperations: (options?: { session?: boolean }) => void;
  safeSetTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  pushTabSnapshot: (tabId: string, currentTab: ApiRequest, isTyping?: boolean) => void;
  safeReleaseRawBody: (id?: string) => void;
  safeReleaseRawBodies: (ids: Iterable<string | undefined>) => void;
  safeEvictRawBodiesToBudget: (pinnedIds: Iterable<string>) => void;
  stripHistoryBlobUrls: (history: HistoryItem[] | undefined) => HistoryItem[];
  stripBackgroundCacheBlobUrls: (
    cache: Record<string, ScopeCacheEntry> | undefined,
    activeKey?: string | null,
  ) => Record<string, ScopeCacheEntry>;
  ensureResponseImageBlobUrl: (response: ApiResponse | null | undefined) => ApiResponse | null | undefined;
  collectProtectedResponseHandles: (
    responses: Iterable<ApiResponse | null | undefined>,
    histories: Array<Array<HistoryItem> | undefined>,
    rawOnlyHistories?: Array<Array<HistoryItem> | undefined>,
  ) => { blobUrls: Set<string>; rawBodyIds: Set<string> };
  revokeUnreferencedResponses: (
    candidates: Iterable<ApiResponse | null | undefined>,
    protectedResponses: Iterable<ApiResponse | null | undefined>,
    protectedHistories: Array<Array<HistoryItem> | undefined>,
    rawOnlyHistories?: Array<Array<HistoryItem> | undefined>,
  ) => void;
  revokeUnreferencedTabBlobs: (
    prevTabResponses: Record<string, ApiResponse> | undefined,
    prevActiveResponse: ApiResponse | null | undefined,
    protectedHistories: Array<Array<HistoryItem> | undefined>,
    rawOnlyHistories?: Array<Array<HistoryItem> | undefined>,
    prevHistory?: Array<HistoryItem>,
  ) => void;
  enqueueCollectionSyncTask: (
    collectionId: string,
    scope: ActiveScope,
    work: (operation: AsyncOperation, generation: number) => Promise<void>,
  ) => Promise<void>;
  queueSavedCollectionSync: (
    collection: Collection,
    scope: ActiveScope,
    cloudConfig: ApiStoreState['cloudConfig'],
    revision: number,
    get: StoreSliceGet,
    set: StoreSliceSet,
    errorPrefix?: string,
  ) => void;
  getPersistOptions: () => ReturnType<ApiStore['persist']['getOptions']>;
  flushStorePersistence: () => Promise<void>;

  // Slice-registered cross-slice helpers (invoked at runtime only)
  resolveCanonicalEnvId: (envId: string) => string;
  isCloudEnvSyncActive: (state: Pick<ApiStoreState, 'workspaceMode' | 'cloudConfig'>) => boolean;
  dispatchCloudEnvironmentCreate: (
    newEnv: Environment,
    scope: NonNullable<ApiStoreState['cloudConfig']['activeScope']>,
    initialStamp: number,
    get: StoreSliceGet,
    set: StoreSliceSet,
  ) => void;
  scheduleEnvironmentCloudSync: (
    rawEnvId: string,
    get: StoreSliceGet,
    set: StoreSliceSet,
  ) => void;
  isSelectedExampleStillPresent: (
    collections: Collection[],
    selection: SelectedSavedExample | null | undefined,
  ) => boolean;
  pruneExampleTabsState: (
    state: Pick<ApiStoreState, 'openExampleTabs' | 'openPerformanceTabs' | 'selectedExample' | 'tabOrder' | 'tabs'>,
    shouldKeep: (selection: SelectedSavedExample) => boolean,
  ) => Pick<ApiStoreState, 'openExampleTabs' | 'selectedExample' | 'tabOrder'>;
  ensureSavedExamplesCapability: (forceCloudCheck?: boolean) => Promise<boolean>;
  commitServerItemToStore: (
    collectionId: string,
    itemId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    serverItem: any,
    targetScope?: ActiveScope,
    intentToRemove?: string,
  ) => void;
  executeExampleIntent: (
    intent: PendingExampleIntent,
    opts?: {
      preMutationCollections?: Collection[];
      apiUrl?: string;
      token?: string;
      refreshToken?: string;
      signal?: AbortSignal;
    },
  ) => Promise<SavedExampleActionResult>;
  replayPendingExampleIntentsForScope: (
    targetScope: ActiveScope,
    apiUrl: string,
    token: string | undefined,
    refreshToken: string | undefined,
    signal: AbortSignal,
  ) => Promise<void>;
  commitItemMove: (
    itemId: string,
    sourceCollectionId: string,
    targetCollectionId: string,
    targetParentId: string | null,
    commit: () => void,
  ) => Promise<{ success: boolean; error?: string }>;
}

export interface StoreSliceContext {
  set: StoreSliceSet;
  get: StoreSliceGet;
  customStorage: StateStorage;
  boundAdapter: PlatformAdapter | undefined;
  credentialStorage: NativeCredentialStorage | undefined;
  persistCloudCredentials: boolean;
  productPolicy: ProductPolicy;
  isOfflineOnly: boolean;
  allowsOfflineWorkspace: boolean;
  cloudClient: RuntimeCloudBindings;
  refs: StoreSliceRefs;
  collections: StoreSliceCollections;
  helpers: StoreSliceHelpers;
}
