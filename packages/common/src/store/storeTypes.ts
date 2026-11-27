import type { StateStorage } from 'zustand/middleware';
import type { ApiStore } from './storeContext';
import type {
  ActiveScope,
  ApiRequest,
  ApiResponse,
  AuthConfig,
  BinaryFileData,
  BodyType,
  CloudConfig,
  CloudProject,
  CloudWorkspace,
  Collection,
  CollectionItem,
  DuplicateActionResult,
  Environment,
  EnvironmentVariable,
  FeatureFlags,
  FeaturePolicy,
  FeaturePolicyStatus,
  FormDataItem,
  FunctionalRunReport,
  HistoryItem,
  KeyValuePair,
  OfflineWorkspace,
  OpenExampleTab,
  OpenPerformanceTab,
  PendingDuplicateIntent,
  PendingExampleIntent,
  PerformanceRunReport,
  ProjectRole,
  RawType,
  RequestTab,
  SavedExample,
  ScopesCacheData,
  SyncStatus,
  ThemeMode,
  WorkspaceMode,
} from '../types/api';
import type { PlatformAdapter } from '../types/platform';
import type {
  NativeCredentialScope,
  NativeCredentialState,
  NativeCredentialStorage,
} from '../types/credentials';
import type { ProductPolicy } from '../productPolicy';
import type { CloudClient } from '../lib/cloudApi';
import type { ImportTargetBinding } from '../lib/importBatch';
import type { WorkspaceScopeSnapshot } from '../workspace/scopeSnapshot';
import type { CloudCacheArchiveState } from '../workspace/cloudCacheArchive';

export type { ApiStore };

export const SCOPE_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours cache for workspace collections/environments
export const SCOPES_LIST_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours cache for workspace/project list

export type ScopeCacheEntry = WorkspaceScopeSnapshot;

export interface EnvironmentOccConflict {
  local: Environment;
  remote: Environment;
}

export interface SaveRequestToCollectionResult {
  success: boolean;
  sourceTabId?: string;
  savedRequestId?: string;
  cloudStatus: 'not-applicable' | 'pending';
  error?: string;
}

export interface SelectedSavedExample {
  collectionId: string;
  itemId: string;
  exampleId: string;
}

export interface SavedExampleActionResult {
  success: boolean;
  example?: SavedExample;
  error?: string;
  code?: string;
  reconcilePending?: boolean;
}

export interface LoadItemExamplesResult {
  success: boolean;
  item?: CollectionItem;
  error?: string;
  forbidden?: boolean;
  notFound?: boolean;
}

export interface HydrateCollectionExamplesResult {
  success: boolean;
  collection?: Collection;
  error?: string;
}

export interface TabUndoEntry {
  past: ApiRequest[];
  future: ApiRequest[];
}

export const DEFAULT_OFFLINE_WORKSPACE_ID = 'ws-default-local';

export const defaultOfflineWorkspace: OfflineWorkspace = {
  id: DEFAULT_OFFLINE_WORKSPACE_ID,
  name: 'Default Workspace',
  description: 'Default local workspace on this device',
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

export interface ApiStoreState {
  tabs: RequestTab[];
  activeTabId: string;
  activeResponse: ApiResponse | null;
  tabResponses: Record<string, ApiResponse>;
  tabRevealRevision: number;
  isLoading: boolean;
  collections: Collection[];
  history: HistoryItem[];
  sidebarTab: 'collections' | 'history';

  // Request Undo & Redo
  canUndoActiveRequest: boolean;
  canRedoActiveRequest: boolean;
  undoActiveRequest: () => void;
  redoActiveRequest: () => void;

  // Theming
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;

  // Environments
  environments: Environment[];
  activeEnvironmentId: string | null;
  setActiveEnvironmentId: (id: string | null) => void;
  createEnvironment: (name: string, minRole?: 'admin' | 'maintainer' | 'contributor' | 'reader') => string;
  deleteEnvironment: (id: string) => void;
  updateEnvironment: (id: string, updates: Partial<Environment>) => void;
  addEnvironmentVariable: (envId: string) => void;
  updateEnvironmentVariable: (envId: string, varId: string, updates: Partial<EnvironmentVariable>) => void;
  removeEnvironmentVariable: (envId: string, varId: string) => void;
  resetEnvironmentCurrentValues: (envId: string) => void;
  persistEnvironmentCurrentValues: (envId: string) => void;
  addEnvironment: (env: Environment, options?: { target?: ImportTargetBinding; isRetry?: boolean }) => Promise<string>;
  replaceEnvironment: (existingId: string, incomingEnv: Environment, options?: { target?: ImportTargetBinding }) => Promise<void>;
  environmentOccConflict: EnvironmentOccConflict | null;
  discardEnvironmentOccConflict: () => void;
  overwriteEnvironmentOccConflict: () => Promise<void>;
  importEnvironmentFromJson: (jsonStr: string) => { success: boolean; error?: string; environment?: Environment };
  importAnyPostmanJson: (jsonStr: string) => Promise<{
    success: boolean;
    type?: 'collection' | 'environment';
    name?: string;
    error?: string;
  }>;

  // Navigation & Tabs
  setSidebarTab: (tab: 'collections' | 'history') => void;
  setActiveTabId: (id: string) => void;
  createTab: (initial?: Partial<ApiRequest>) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeAllTabs: () => void;
  closeTabsToRight: (id: string) => void;
  duplicateTab: (id: string) => void;
  updateActiveRequest: (updates: Partial<ApiRequest>) => void;

  // Request Builders
  updateParam: (id: string, updates: Partial<KeyValuePair>) => void;
  addParam: () => void;
  removeParam: (id: string) => void;
  updatePathVariable: (id: string, updates: Partial<KeyValuePair>) => void;

  updateHeader: (id: string, updates: Partial<KeyValuePair>) => void;
  addHeader: () => void;
  removeHeader: (id: string) => void;

  updateAuth: (auth: Partial<AuthConfig>) => void;
  setBodyType: (type: BodyType) => void;
  setRawType: (rawType: RawType) => void;
  setBodyContent: (content: string, isDiscrete?: boolean) => void;
  setGraphqlQuery: (query: string, isDiscrete?: boolean) => void;
  setGraphqlVariables: (variables: string, isDiscrete?: boolean) => void;
  setPreRequestScript: (script: string, isDiscrete?: boolean) => void;
  setPostResponseScript: (script: string, isDiscrete?: boolean) => void;

  // Form-Data & Binary Items
  updateFormDataItem: (id: string, updates: Partial<FormDataItem>) => void;
  addFormDataItem: () => void;
  removeFormDataItem: (id: string) => void;
  setBodyBinaryFile: (file?: BinaryFileData) => void;

  // URL-Encoded Form Items
  updateUrlEncodedItem: (id: string, updates: Partial<KeyValuePair>) => void;
  addUrlEncodedItem: () => void;
  removeUrlEncodedItem: (id: string) => void;
  setUrlEncodedItems: (items: KeyValuePair[]) => void;

  // Execution
  sendRequest: () => Promise<void>;
  cancelActiveRequest: () => void;

  // Collections & History
  createCollection: (name: string, description?: string) => string;
  createCollectionAsync: (
    name: string,
    description?: string
  ) => Promise<{ success: boolean; collectionId?: string; error?: string }>;
  renameCollection: (id: string, name: string) => void;
  createFolder: (collectionId: string, parentFolderId: string | null, name?: string) => string;
  createRequestInCollection: (collectionId: string, folderId: string | null, name?: string) => ApiRequest | null;
  deleteCollectionItem: (collectionId: string, itemId: string) => void;
  renameCollectionItem: (collectionId: string, itemId: string, name: string) => void;
  saveRequestToCollection: (
    collectionId: string,
    folderId: string | null,
    request: ApiRequest,
    sourceTabId?: string,
  ) => SaveRequestToCollectionResult;
  saveActiveRequest: () => { success: boolean; isDirectSaved: boolean };
  addCollection: (collection: Collection, options?: { target?: ImportTargetBinding; isRetry?: boolean }) => Promise<void> | void;
  replaceCollection: (existingId: string, newCollection: Collection, options?: { target?: ImportTargetBinding }) => Promise<void>;
  importCollectionFromJson: (jsonStr: string) => Promise<{ success: boolean; error?: string }>;
  deleteCollection: (id: string) => Promise<{ success: boolean; error?: string }>;
  updateCollectionPermission: (
    collectionId: string,
    minRole: ProjectRole
  ) => Promise<{ success: boolean; error?: string }>;
  moveCollection: (collectionId: string, targetScope: ActiveScope) => Promise<{ success: boolean; error?: string }>;
  duplicateCollection: (
    collectionId: string,
    targetScope: ActiveScope,
    options?: { operationId?: string }
  ) => Promise<DuplicateActionResult>;
  duplicateCollectionItem: (
    sourceCollectionId: string,
    itemId: string,
    targetCollectionId: string,
    targetParentId: string | null,
    options?: { operationId?: string }
  ) => Promise<DuplicateActionResult>;
  loadCollectionDetails: (
    collectionId: string
  ) => Promise<{ success: boolean; collection?: Collection; error?: string }>;
  openExampleTabs: OpenExampleTab[];
  openPerformanceTabs: OpenPerformanceTab[];
  tabOrder: string[];
  selectedExample: SelectedSavedExample | null;
  selectedPerformanceTabId: string | null;
  performanceReports: Record<string, PerformanceRunReport>;
  functionalReports: Record<string, FunctionalRunReport>;
  selectSavedExample: (selection: SelectedSavedExample | null) => void;
  closeExampleTab: (tabId: string) => void;
  openPerformanceTestTab: (
    config: Omit<OpenPerformanceTab, 'id' | 'createdAt' | 'viewMode'> & {
      id?: string;
      viewMode?: OpenPerformanceTab['viewMode'];
    }
  ) => string;
  selectPerformanceTab: (tabId: string | null) => void;
  updatePerformanceTab: (
    tabId: string,
    updater: Partial<OpenPerformanceTab> | ((prev: OpenPerformanceTab) => OpenPerformanceTab)
  ) => void;
  closePerformanceTab: (tabId: string) => void;
  setPerformanceReport: (report: PerformanceRunReport) => void;
  setFunctionalReport: (report: FunctionalRunReport) => void;
  removePerformanceReport: (reportId: string) => void;
  removeFunctionalReport: (reportId: string) => void;
  applyEnvironmentVariableUpdates: (
    updates: Record<string, string>,
    unsetKeys?: string[],
    targetEnvId?: string
  ) => string[];
  pendingExampleIntents: Record<string, PendingExampleIntent>;
  saveResponseAsExample: (input: {
    collectionId: string;
    itemId: string;
    name?: string;
    response: ApiResponse;
    fallbackRequest?: ApiRequest;
  }) => Promise<SavedExampleActionResult>;
  renameSavedExample: (input: {
    collectionId: string;
    itemId: string;
    exampleId: string;
    name: string;
  }) => Promise<SavedExampleActionResult>;
  deleteSavedExample: (input: {
    collectionId: string;
    itemId: string;
    exampleId: string;
  }) => Promise<SavedExampleActionResult>;
  loadItemExamples: (collectionId: string, itemId: string) => Promise<LoadItemExamplesResult>;
  hydrateCollectionExamples: (
    collectionId: string,
    options?: { includeBody?: boolean }
  ) => Promise<HydrateCollectionExamplesResult>;
  retryPendingExampleIntent: (operationId: string) => Promise<SavedExampleActionResult>;
  clearPendingExampleIntent: (operationId: string) => void;
  pendingDuplicateIntents: Record<string, PendingDuplicateIntent>;
  /** Runtime-only IDs of duplicate operations actively in flight in this session (never persisted). */
  activeDuplicateOperationIds: Record<string, boolean>;
  lastDuplicateReveal: { pathIds: string[]; revision: number } | null;
  retryPendingDuplicateIntent: (operationId: string) => Promise<DuplicateActionResult>;
  clearPendingDuplicateIntent: (operationId: string) => void;
  moveRequest: (
    sourceCollectionId: string,
    requestId: string,
    targetCollectionId: string,
    targetFolderId: string | null
  ) => Promise<{ success: boolean; error?: string }>;
  moveFolder: (
    sourceCollectionId: string,
    folderId: string,
    targetCollectionId: string,
    targetFolderId: string | null
  ) => Promise<{ success: boolean; error?: string }>;
  reorderItem: (
    collectionId: string,
    activeId: string,
    targetId: string,
    position: 'before' | 'after' | 'inside'
  ) => Promise<{ success: boolean; error?: string }>;
  openRequestInTab: (request: ApiRequest, initialResponse?: ApiResponse) => void;
  clearHistory: () => void;
  deleteHistoryItem: (id: string) => void;

  // Offline Workspaces
  offlineWorkspaces?: OfflineWorkspace[];
  activeOfflineWorkspaceId?: string;
  offlineScopeCache?: Record<string, ScopeCacheEntry>;
  createOfflineWorkspace: (name: string, description?: string) => string;
  switchOfflineWorkspace: (workspaceId: string, skipSnapshot?: boolean) => void;
  renameOfflineWorkspace: (id: string, name: string) => void;
  deleteOfflineWorkspace: (id: string) => { success: boolean; error?: string };
  duplicateOfflineWorkspace: (id: string, newName?: string) => string;

  // Workspace Mode & Cloud Synchronization
  workspaceMode: WorkspaceMode;
  hasConfiguredMode: boolean;
  cloudConfig: CloudConfig;
  /** Public identity and migration state for credentials held by the native vault. */
  nativeCredentialState?: NativeCredentialState;
  /** Durable cleanup journal retained across rotations, account switches, and sign-out until both copies redact legacy secrets. */
  nativeCredentialCleanupPending?: boolean;
  featurePolicy: FeaturePolicy | null;
  featurePolicyStatus: FeaturePolicyStatus;
  featurePolicyFetchedAt: number | null;
  syncStatus: SyncStatus;
  lastSyncedAt: number | null;
  syncError: string | null;
  scopeCache?: Record<string, ScopeCacheEntry>;
  /** Owner of the active cache; missing for legacy data with uncertain provenance. */
  cloudCacheOwner: string | null;
  cloudCacheArchives: CloudCacheArchiveState;
  scopesCache?: ScopesCacheData;
  isSwitchingWorkspace?: boolean;

  setWorkspaceMode: (mode: WorkspaceMode) => void;
  setHasConfiguredMode: (configured: boolean) => void;
  setCloudConfig: (config: Partial<CloudConfig>) => void;
  /** Writes password-provider credentials to the platform vault before updating session state. */
  setCloudSession: (config: Partial<CloudConfig>) => Promise<void>;
  /** Removes the current password-provider credential from the platform vault. */
  clearCloudCredentials: (scope?: NativeCredentialScope) => Promise<void>;
  setNativeCredentialState: (state?: NativeCredentialState) => void;
  /** Persists the current redacted native state to both legacy persistence copies. */
  persistStoreState: () => Promise<void>;
  persistNativeCredentialState: () => Promise<void>;
  /** Retries physical-copy redaction and clears the cleanup journal only after both copies succeed. */
  completePendingCredentialCleanup: () => Promise<boolean>;
  /** Coordinates startup vault restoration and legacy migration with all other vault mutations. */
  recoverNativeCredentials: (options?: { isCancelled?: () => boolean }) => Promise<void>;
  /** Signs out through provider sign-out and vault deletion, keeping the session retryable if deletion fails. */
  signOutCloud: (options?: {
    authProvider?: {
      signOut?: (request: {
        apiUrl: string;
        user?: CloudConfig['user'];
        accessToken?: string;
        refreshToken?: string;
      }) => Promise<void>;
    };
  }) => Promise<{ success: boolean; error?: string }>;
  /** Removes any vaulted credential for an evicted or scope-revoked session and clears active cloud state. */
  evictCloudSession: (scope?: NativeCredentialScope) => void;
  getCloudSessionGeneration: () => number;
  getCloudCacheRecoveryCount: () => number;
  getCloudCacheRecoveryBackup: () => string;
  importCloudCacheRecoveryBackup: (serialized: string) => { success: boolean; archiveCount: number; unsupportedArchiveCount: number; error?: string };
  recoverCloudCachesToOfflineWorkspaces: () => { success: boolean; workspaceCount: number; error?: string };
  refreshFeaturePolicy: (force?: boolean) => Promise<FeaturePolicy | null>;
  isFeatureEnabled: (feature: keyof FeatureFlags) => boolean;
  setActiveScope: (scope: ActiveScope, forceSync?: boolean) => Promise<void>;
  fetchScopes: (force?: boolean) => Promise<void>;
  fetchProjectsForTeam: (teamId: string, force?: boolean) => Promise<CloudProject[]>;
  logoutCloud: () => void;
  setSyncStatus: (status: SyncStatus, error?: string | null) => void;
  pullCloudDelta: () => Promise<void>;
  importLocalToCloud: () => Promise<{ success: boolean; message: string }>;
  createCloudWorkspace: (name: string, description?: string) => Promise<{ success: boolean; workspace?: CloudWorkspace; error?: string }>;
  renameCloudWorkspace: (id: string, name: string) => Promise<{ success: boolean; error?: string }>;
  deleteCloudWorkspace: (id: string) => Promise<{ success: boolean; error?: string }>;
}

export interface CreateApiStoreOptions {
  storage?: StateStorage;
  adapter?: PlatformAdapter;
  credentialStorage?: NativeCredentialStorage;
  productPolicy?: ProductPolicy;
  cloudClient?: CloudClient;
}
