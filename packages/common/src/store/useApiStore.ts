import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import { useContext } from 'react';
import { StoreContext, ApiStore } from './storeContext';
export type { ApiStore } from './storeContext';
import { appStorage } from '../lib/storage';
import {
  ApiRequest,
  ApiResponse,
  Collection,
  CollectionItem,
  HistoryItem,
  KeyValuePair,
  BodyType,
  AuthConfig,
  Environment,
  EnvironmentVariable,
  FormDataItem,
  BinaryFileData,
  RawType,
  WorkspaceMode,
  CloudConfig,
  ActiveScope,
  SyncStatus,
  ScopesCacheData,
  CloudProject,
  CloudWorkspace,
  OfflineWorkspace,
  FeaturePolicy,
  FeaturePolicyStatus,
  FeatureFlags,
} from '../types/api';
import { executeApiRequest } from '../lib/fetcher';
import type { PlatformAdapter } from '../types/platform';
import { revokeBlobUrl, revokeBlobUrls } from '../lib/blobManager';
import {
  importPostmanCollection,
  importPostmanEnvironment,
  detectPostmanJsonType,
} from '../lib/postman';
import { executePreRequestScript, executePostResponseScript } from '../lib/scriptRunner';
import { parseQueryParamsFromUrl, parsePathVariablesFromUrl, buildUrlWithParams } from '../lib/urlParams';
import {
  batchImportToScope,
  registerTokenRefreshCallback,
  registerAuthEvictedCallback,
  createScopeEnvironment,
  updateScopeEnvironment,
  deleteScopeEnvironment,
  deleteScopeCollection,
  deleteScopeItem,
  moveScopeCollection,
  reorderCollectionItems,
  fetchUserWorkspaces,
  createCloudWorkspace,
  updateCloudWorkspace,
  deleteCloudWorkspace,
  fetchUserTeams,
  fetchTeamProjects,
  fetchScopeCollections,
  fetchCollectionById,
  fetchScopeEnvironments,
  fetchFeaturePolicy,
  CloudApiError,
  normalizeCloudApiUrl,
} from '../lib/cloudApi';
import { reorderItemInTree } from '../lib/treeHelper';
import {
  buildCollectionFromDetails,
  buildEnvironmentsFromDelta,
} from '../lib/cloudSyncTransformer';
import { isOfflineOnly } from '../lib/edition';
import {
  findSavedRequestInCollections,
  alignCollectionItemIds,
  flattenCollectionRequests,
  alignEnvironmentVariableIds,
} from '../lib/requestDiff';
import { canModifyCollection, canModifyEnvironment, hasScopePermission } from '../lib/jwt';

const FEATURE_POLICY_TTL_MS = 30 * 60 * 1000;

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const defaultRequest: ApiRequest = {
  id: 'req-default-1',
  name: 'New Request',
  method: 'GET',
  url: '',
  params: [{ id: 'p1', key: '', value: '', enabled: true }],
  pathVariables: [],
  headers: [{ id: 'h1', key: 'Accept', value: 'application/json', enabled: true }],
  auth: { type: 'none' },
  bodyType: 'none',
  rawType: 'text',
  bodyContent: '',
  graphqlQuery: '',
  graphqlVariables: '',
  bodyFormData: [],
  bodyUrlEncoded: [{ id: 'u1', key: '', value: '', enabled: true }],
  preRequestScript: '',
  postResponseScript: '',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function createInitialTab(): ApiRequest {
  return {
    id: generateId(),
    name: 'New Request',
    method: 'GET',
    url: '',
    params: [{ id: generateId(), key: '', value: '', enabled: true }],
    pathVariables: [],
    headers: [{ id: generateId(), key: '', value: '', enabled: true }],
    auth: { type: 'none' },
    bodyType: 'none',
    rawType: 'text',
    bodyContent: '',
    graphqlQuery: '',
    graphqlVariables: '',
    bodyFormData: [],
    bodyBinaryFile: undefined,
    bodyUrlEncoded: [{ id: generateId(), key: '', value: '', enabled: true }],
    preRequestScript: '',
    postResponseScript: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function hasLiveFile(value: unknown): value is File {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function cloneRequestPreservingAttachments(request: ApiRequest): ApiRequest {
  const pathVariables = parsePathVariablesFromUrl(request.url, request.pathVariables);
  return {
    ...request,
    params: (request.params || []).map((item) => ({ ...item })),
    pathVariables: pathVariables.map((item) => ({ ...item })),
    headers: (request.headers || []).map((item) => ({ ...item })),
    bodyFormData: request.bodyFormData?.map((item) => ({ ...item })),
    bodyUrlEncoded: request.bodyUrlEncoded?.map((item) => ({ ...item })),
    bodyBinaryFile: request.bodyBinaryFile ? { ...request.bodyBinaryFile } : undefined,
  };
}

function cloneCollectionPreservingAttachments(collection: Collection): Collection {
  const cloneItems = (items: CollectionItem[]): CollectionItem[] => items.map((item) => ({
    ...item,
    request: item.request ? cloneRequestPreservingAttachments(item.request) : undefined,
    items: item.items ? cloneItems(item.items) : undefined,
  }));
  return { ...collection, items: cloneItems(collection.items || []) };
}

function serializeRequestAttachments(request: ApiRequest): ApiRequest {
  const copy = cloneRequestPreservingAttachments(request);
  copy.bodyFormData = copy.bodyFormData?.map((item) => {
    if (item.type !== 'file') return item;
    const { file, ...metadata } = item;
    return {
      ...metadata,
      fileName: hasLiveFile(file) ? file.name : item.fileName || item.value || '',
      fileSize: hasLiveFile(file) ? file.size : item.fileSize || 0,
      fileType: hasLiveFile(file) ? file.type : item.fileType || '',
      needsReselection: true,
    };
  });
  if (copy.bodyBinaryFile) {
    const { file, ...metadata } = copy.bodyBinaryFile;
    copy.bodyBinaryFile = {
      ...metadata,
      name: hasLiveFile(file) ? file.name : metadata.name || 'unnamed file',
      size: hasLiveFile(file) ? file.size : metadata.size || 0,
      type: hasLiveFile(file) ? file.type : metadata.type || '',
      needsReselection: true,
    };
  }
  return copy;
}

function normalizePersistedRequestAttachments(request: ApiRequest): ApiRequest {
  const copy = cloneRequestPreservingAttachments(request);
  copy.bodyFormData = copy.bodyFormData?.map((item) => {
    if (item.type !== 'file' || hasLiveFile(item.file)) return item;
    const { file: _invalidFile, ...metadata } = item;
    return {
      ...metadata,
      fileName: item.fileName || item.value || '',
      fileSize: item.fileSize || 0,
      fileType: item.fileType || '',
      needsReselection: true,
    };
  });
  if (copy.bodyBinaryFile && !hasLiveFile(copy.bodyBinaryFile.file)) {
    const { file: _invalidFile, ...metadata } = copy.bodyBinaryFile;
    copy.bodyBinaryFile = {
      ...metadata,
      name: metadata.name || 'unnamed file',
      size: metadata.size || 0,
      type: metadata.type || '',
      needsReselection: true,
    };
  }
  return copy;
}

function serializeCollectionAttachments(collection: Collection): Collection {
  const serializeItems = (items: CollectionItem[]): CollectionItem[] => items.map((item) => ({
    ...item,
    request: item.request ? serializeRequestAttachments(item.request) : undefined,
    items: item.items ? serializeItems(item.items) : undefined,
  }));
  return { ...collection, items: serializeItems(collection.items || []) };
}

function normalizeCollectionAttachments(collection: Collection): Collection {
  const normalizeItems = (items: CollectionItem[]): CollectionItem[] => items.map((item) => {
    const resolvedId = item.request?.id || item.id;
    return {
      ...item,
      request: item.request ? {
        ...normalizePersistedRequestAttachments(item.request),
        id: resolvedId,
        name: item.name || item.request.name || 'Untitled Request',
      } : undefined,
      items: item.items ? normalizeItems(item.items) : undefined,
    };
  });
  return { ...collection, items: normalizeItems(collection.items || []) };
}

function ensureUniqueCollectionItemIds(collections: Collection[]): Collection[] {
  const seenIds = new Set<string>();

  const processItems = (items: CollectionItem[]): CollectionItem[] => {
    return (items || []).map((item) => {
      let itemId = item.id;
      if (seenIds.has(itemId)) {
        itemId = generateId();
      }
      seenIds.add(itemId);

      const updatedRequest = item.request
        ? {
            ...item.request,
            id: itemId,
          }
        : undefined;

      return {
        ...item,
        id: itemId,
        request: updatedRequest,
        items: item.items ? processItems(item.items) : undefined,
      };
    });
  };

  return (collections || []).map((col) => ({
    ...col,
    items: processItems(col.items || []),
  }));
}

function serializeHistoryAttachments(history: HistoryItem[]): HistoryItem[] {
  return history.map((entry) => ({
    ...entry,
    request: serializeRequestAttachments(entry.request),
    response: entry.response ? { ...entry.response, blobUrl: undefined } : undefined,
  }));
}

function normalizeHistoryAttachments(history: HistoryItem[]): HistoryItem[] {
  return history.map((entry) => ({
    ...entry,
    request: normalizePersistedRequestAttachments(entry.request),
    response: entry.response ? { ...entry.response, blobUrl: undefined } : undefined,
  }));
}

export const SCOPE_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours cache for workspace collections/environments
export const SCOPES_LIST_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours cache for workspace/project list

export interface ScopeCacheEntry {
  collections: Collection[];
  environments: Environment[];
  activeEnvironmentId?: string | null;
  lastSyncedAt?: number | null;
  tabs?: ApiRequest[];
  activeTabId?: string;
  history?: HistoryItem[];
}

export interface EnvironmentOccConflict {
  local: Environment;
  remote: Environment;
}

function getScopeKey(scope?: ActiveScope | null): string {
  if (!scope || !scope.id) return 'default';
  return `${scope.type}:${scope.id}`;
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
  tabs: ApiRequest[];
  activeTabId: string;
  activeResponse: ApiResponse | null;
  tabResponses: Record<string, ApiResponse>;
  isLoading: boolean;
  collections: Collection[];
  history: HistoryItem[];
  sidebarTab: 'collections' | 'history';

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
  addEnvironment: (env: Environment) => Promise<string>;
  replaceEnvironment: (existingId: string, incomingEnv: Environment) => Promise<void>;
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
  setBodyContent: (content: string) => void;
  setGraphqlQuery: (query: string) => void;
  setGraphqlVariables: (variables: string) => void;
  setPreRequestScript: (script: string) => void;
  setPostResponseScript: (script: string) => void;

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
  renameCollection: (id: string, name: string) => void;
  createFolder: (collectionId: string, parentFolderId: string | null, name?: string) => string;
  createRequestInCollection: (collectionId: string, folderId: string | null, name?: string) => ApiRequest | null;
  deleteCollectionItem: (collectionId: string, itemId: string) => void;
  renameCollectionItem: (collectionId: string, itemId: string, name: string) => void;
  saveRequestToCollection: (collectionId: string, folderId: string | null, request: ApiRequest) => void;
  saveActiveRequest: () => { success: boolean; isDirectSaved: boolean };
  addCollection: (collection: Collection) => Promise<void> | void;
  replaceCollection: (existingId: string, newCollection: Collection) => Promise<void>;
  importCollectionFromJson: (jsonStr: string) => Promise<{ success: boolean; error?: string }>;
  deleteCollection: (id: string) => Promise<{ success: boolean; error?: string }>;
  moveCollection: (collectionId: string, targetScope: ActiveScope) => Promise<{ success: boolean; error?: string }>;
  moveRequest: (
    sourceCollectionId: string,
    requestId: string,
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
  switchOfflineWorkspace: (workspaceId: string) => void;
  renameOfflineWorkspace: (id: string, name: string) => void;
  deleteOfflineWorkspace: (id: string) => { success: boolean; error?: string };
  duplicateOfflineWorkspace: (id: string, newName?: string) => string;

  // Workspace Mode & Cloud Synchronization
  workspaceMode: WorkspaceMode;
  hasConfiguredMode: boolean;
  cloudConfig: CloudConfig;
  featurePolicy: FeaturePolicy | null;
  featurePolicyStatus: FeaturePolicyStatus;
  featurePolicyFetchedAt: number | null;
  syncStatus: SyncStatus;
  lastSyncedAt: number | null;
  syncError: string | null;
  scopeCache?: Record<string, ScopeCacheEntry>;
  scopesCache?: ScopesCacheData;
  isSwitchingWorkspace?: boolean;

  setWorkspaceMode: (mode: WorkspaceMode) => void;
  setHasConfiguredMode: (configured: boolean) => void;
  setCloudConfig: (config: Partial<CloudConfig>) => void;
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

export function sanitizeVariablesForUpstream(vars: EnvironmentVariable[]) {
  return (vars || []).map((v) => ({
    id: v.id,
    key: v.key,
    value: v.initialValue ?? v.value ?? '',
    initialValue: v.initialValue ?? v.value ?? '',
    enabled: v.enabled !== false,
  }));
}

function getRemoteEnvironment(data: unknown): Environment | null {
  const candidate = (data as { environment?: unknown })?.environment || data;
  return buildEnvironmentsFromDelta(candidate ? [candidate] : [])[0] || null;
}

function preserveCurrentValues(remote: Environment, local: Environment): Environment {
  return {
    ...remote,
    variables: remote.variables.map((variable) => {
      const localVariable = local.variables.find((item) => item.key.trim() === variable.key.trim());
      return localVariable ? { ...variable, currentValue: localVariable.currentValue } : variable;
    }),
  };
}

export interface CreateApiStoreOptions {
  storage?: StateStorage;
  adapter?: PlatformAdapter;
}

export function createApiStore(
  customStorageOrOptions: StateStorage | CreateApiStoreOptions = appStorage,
  adapterParam?: PlatformAdapter
): ApiStore {
  const options = (customStorageOrOptions && typeof (customStorageOrOptions as StateStorage).getItem === 'function')
    ? { storage: customStorageOrOptions as StateStorage, adapter: adapterParam }
    : ((customStorageOrOptions as CreateApiStoreOptions) || {});

  const customStorage = options.storage || appStorage;
  const boundAdapter = options.adapter || adapterParam;

  const envSyncDebounceTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  let isStoreDisposed = false;

  function safeSetTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      if (!isStoreDisposed) {
        fn();
      }
    }, ms);
    pendingTimers.add(timer);
    return timer;
  }

  interface AsyncOperation {
    controller: AbortController;
    sessionGeneration: number;
    scopeGeneration: number;
  }

  let sessionGeneration = 0;
  let scopeGeneration = 0;
  const activeOperationControllers = new Set<AbortController>();
  let activePullOperation: AsyncOperation | null = null;
  let activeRequestOperation: AsyncOperation | null = null;

  function beginAsyncOperation(): AsyncOperation {
    const controller = new AbortController();
    if (isStoreDisposed) {
      controller.abort();
    }
    activeOperationControllers.add(controller);
    return { controller, sessionGeneration, scopeGeneration };
  }

  function completeAsyncOperation(operation: AsyncOperation) {
    activeOperationControllers.delete(operation.controller);
  }

  function isAsyncOperationCurrent(operation: AsyncOperation): boolean {
    return !isStoreDisposed &&
      !operation.controller.signal.aborted &&
      operation.sessionGeneration === sessionGeneration &&
      operation.scopeGeneration === scopeGeneration;
  }

  function invalidateAsyncOperations({ session = false }: { session?: boolean } = {}) {
    if (session) sessionGeneration += 1;
    scopeGeneration += 1;
    for (const controller of activeOperationControllers) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
    activeOperationControllers.clear();
    for (const id of Object.keys(envSyncDebounceTimers)) {
      clearTimeout(envSyncDebounceTimers[id]);
      delete envSyncDebounceTimers[id];
    }
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
  }

  function scheduleEnvironmentCloudSync(
    envId: string,
    get: () => ApiStoreState,
    set: (fn: (state: ApiStoreState) => Partial<ApiStoreState>) => void
  ) {
    if (isOfflineOnly || isStoreDisposed) return;

    if (envSyncDebounceTimers[envId]) {
      clearTimeout(envSyncDebounceTimers[envId]);
      delete envSyncDebounceTimers[envId];
    }

    envSyncDebounceTimers[envId] = setTimeout(async () => {
      delete envSyncDebounceTimers[envId];

      if (isStoreDisposed) return;
      const { workspaceMode, cloudConfig, environments } = get();
      if (workspaceMode !== 'cloud' || !cloudConfig.token) return;

      const currentEnv = environments.find((e) => e.id === envId);
      if (!currentEnv) return;

      const operation = beginAsyncOperation();
      try {
        const res = await updateScopeEnvironment(
          cloudConfig.apiUrl,
          cloudConfig.token,
          envId,
          {
            name: currentEnv.name,
            variables: sanitizeVariablesForUpstream(currentEnv.variables),
            min_role: currentEnv.minRole,
            base_version: currentEnv.version || 1,
          },
          cloudConfig.refreshToken,
          operation.controller.signal
        );

        if (!isAsyncOperationCurrent(operation)) return;

        if (res && typeof res.version === 'number') {
          set((s) => {
            if (!isAsyncOperationCurrent(operation)) return {};
            return {
              environments: s.environments.map((e) =>
                e.id === envId ? { ...e, version: res.version } : e
              ),
            };
          });
        }
      } catch (err: any) {
        if (!isAsyncOperationCurrent(operation)) return;
        if (err?.status === 409) {
          const remote = getRemoteEnvironment(err.data);
          console.warn('Environment sync conflict requires explicit resolution:', err);
          set((state) => {
            if (!isAsyncOperationCurrent(operation)) return {};
            return {
              syncStatus: 'error',
              syncError: 'Environment changes conflict with a newer server version. Review the conflict before saving again.',
              environmentOccConflict: remote
                ? { local: state.environments.find((environment) => environment.id === envId) || currentEnv, remote }
                : null,
            };
          });
          return;
        }
        console.error('Failed to sync updated environment to cloud:', err);
      } finally {
        completeAsyncOperation(operation);
      }
    }, 300);
  }

  const store = create<ApiStoreState>()(
  persist(
    (rawSet, get) => {
      const set: typeof rawSet = ((fnOrState: any, replace?: any) => {
        if (isStoreDisposed) return;
        return (rawSet as any)(fnOrState, replace);
      }) as typeof rawSet;
      return {
      tabs: [defaultRequest],
      activeTabId: defaultRequest.id,
      activeResponse: null,
      tabResponses: {},
      isLoading: false,
      collections: [],
      history: [],
      sidebarTab: 'collections',
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
      workspaceMode: 'offline',
      hasConfiguredMode: isOfflineOnly ? true : false,
      cloudConfig: {
        apiUrl: 'http://localhost:8080',
      },
      featurePolicy: null,
      featurePolicyStatus: 'idle',
      featurePolicyFetchedAt: null,
      syncStatus: 'idle',
      lastSyncedAt: null,
      syncError: null,
      environmentOccConflict: null,
      scopeCache: {},
      scopesCache: undefined,
      isSwitchingWorkspace: false,

      setWorkspaceMode: (workspaceMode) => {
        const currentMode = get().workspaceMode;
        if (currentMode === workspaceMode) return;

        invalidateAsyncOperations();
        set({ isSwitchingWorkspace: true });

        if (workspaceMode === 'offline') {
          // Save current cloud scope data into scopeCache before leaving
          const activeScope = get().cloudConfig.activeScope;
          const updatedScopeCache = { ...(get().scopeCache || {}) };
          if (activeScope) {
            const scopeKey = getScopeKey(activeScope);
            const prevEntry = updatedScopeCache[scopeKey];
            updatedScopeCache[scopeKey] = {
              ...prevEntry,
              collections: get().collections,
              environments: get().environments,
              activeEnvironmentId: get().activeEnvironmentId,
              lastSyncedAt: get().lastSyncedAt,
              tabs: get().tabs,
              activeTabId: get().activeTabId,
              history: get().history,
            };
          }

          const activeLocalId = get().activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
          const localEntry = (get().offlineScopeCache || {})[activeLocalId] || {
            collections: [],
            environments: [],
            activeEnvironmentId: null,
            tabs: [createInitialTab()],
            activeTabId: '',
            history: [],
          };

          const restoredCollections = localEntry.collections || [];
          const restoredEnvironments = localEntry.environments || [];
          const restoredActiveEnvId = localEntry.activeEnvironmentId || null;
          const rawTabs = (localEntry.tabs && localEntry.tabs.length > 0) ? localEntry.tabs : [createInitialTab()];
          const restoredTabs = rawTabs;
          const rawActiveTabId = localEntry.activeTabId;
          const restoredActiveTabId = rawActiveTabId && restoredTabs.some((t) => t.id === rawActiveTabId)
            ? rawActiveTabId
            : restoredTabs[0].id;
          const restoredHistory = localEntry.history || [];

          set({
            workspaceMode: 'offline',
            hasConfiguredMode: true,
            scopeCache: updatedScopeCache,
            collections: restoredCollections,
            environments: restoredEnvironments,
            activeEnvironmentId: restoredActiveEnvId,
            tabs: restoredTabs,
            activeTabId: restoredActiveTabId,
            activeResponse: null,
            tabResponses: {},
            isLoading: false,
            history: restoredHistory,
            syncStatus: 'idle',
            syncError: null,
          });

          safeSetTimeout(() => {
            set({ isSwitchingWorkspace: false });
          }, 250);
        } else {
          // Entering cloud mode: snapshot current offline state only if we were actually in offline mode
          const isCurrentlyOffline = get().workspaceMode === 'offline';
          const {
            collections,
            environments,
            activeEnvironmentId,
            cloudConfig,
            scopeCache,
            tabs,
            activeTabId,
            history,
            offlineScopeCache,
            activeOfflineWorkspaceId,
          } = get();

          const updatedOfflineCache = { ...(offlineScopeCache || {}) };
          if (isCurrentlyOffline && activeOfflineWorkspaceId) {
            updatedOfflineCache[activeOfflineWorkspaceId] = {
              collections,
              environments,
              activeEnvironmentId,
              tabs,
              activeTabId,
              history,
            };
          }

          const targetScope = cloudConfig.activeScope;
          const cached = targetScope ? scopeCache?.[getScopeKey(targetScope)] : null;

          const restoredTabs =
            cached?.tabs && cached.tabs.length > 0
              ? cached.tabs
              : [createInitialTab()];
          const restoredActiveTabId =
            cached?.activeTabId && restoredTabs.some((t) => t.id === cached.activeTabId)
              ? cached.activeTabId
              : restoredTabs[0].id;

          const isFresh = Boolean(
            cached?.lastSyncedAt &&
            Date.now() - cached.lastSyncedAt < SCOPE_CACHE_TTL_MS
          );

          set({
            workspaceMode: isOfflineOnly ? 'offline' : 'cloud',
            hasConfiguredMode: true,
            offlineScopeCache: updatedOfflineCache,
            collections: cached ? cached.collections : [],
            environments: cached ? cached.environments : [],
            activeEnvironmentId: cached ? (cached.activeEnvironmentId || null) : null,
            tabs: restoredTabs,
            activeTabId: restoredActiveTabId,
            activeResponse: null,
            tabResponses: {},
            isLoading: false,
            history: cached?.history || [],
            lastSyncedAt: cached?.lastSyncedAt || null,
            syncStatus: isFresh ? 'synced' : (targetScope ? 'syncing' : 'idle'),
            syncError: null,
          });

          if (!isOfflineOnly && targetScope && cloudConfig.token && !isFresh) {
            get()
              .pullCloudDelta()
              .finally(() => {
                set({ isSwitchingWorkspace: false });
              });
          } else {
            safeSetTimeout(() => {
              set({ isSwitchingWorkspace: false });
            }, 100);
          }
        }
      },
      setHasConfiguredMode: (hasConfiguredMode) =>
        set({
          hasConfiguredMode: isOfflineOnly ? true : hasConfiguredMode,
        }),
      setCloudConfig: (updates) => {
        const currentConfig = get().cloudConfig;
        const normalizedUpdates: Partial<CloudConfig> = { ...updates };
        if (normalizedUpdates.apiUrl !== undefined) {
          normalizedUpdates.apiUrl = normalizeCloudApiUrl(normalizedUpdates.apiUrl);
        }
        const isNewSession =
          (normalizedUpdates.apiUrl !== undefined && normalizedUpdates.apiUrl !== currentConfig.apiUrl) ||
          (normalizedUpdates.user?.id !== undefined && normalizedUpdates.user.id !== currentConfig.user?.id) ||
          (normalizedUpdates.token !== undefined && !currentConfig.token);
        if (isNewSession) invalidateAsyncOperations({ session: true });
        set((state) => ({
          cloudConfig: { ...state.cloudConfig, ...normalizedUpdates },
          ...(isNewSession
            ? { featurePolicy: null, featurePolicyStatus: 'idle' as FeaturePolicyStatus, featurePolicyFetchedAt: null }
            : {}),
        }));
        if (!isOfflineOnly && get().cloudConfig.token) {
          void get().refreshFeaturePolicy(isNewSession);
        }
      },
      refreshFeaturePolicy: async (force = false) => {
        if (isOfflineOnly) return null;
        const state = get();
        const { cloudConfig, featurePolicyFetchedAt, featurePolicyStatus } = state;
        if (!cloudConfig.token) return null;
        const isFresh = featurePolicyFetchedAt !== null && Date.now() - featurePolicyFetchedAt < FEATURE_POLICY_TTL_MS;
        if (!force && isFresh && featurePolicyStatus === 'ready') return state.featurePolicy;
        if (featurePolicyStatus === 'loading') return null;

        const requestToken = cloudConfig.token;
        const requestApiUrl = cloudConfig.apiUrl;
        set({ featurePolicyStatus: 'loading' });
        try {
          const policy = await fetchFeaturePolicy(requestApiUrl, requestToken, cloudConfig.refreshToken);
          const current = get().cloudConfig;
          if (current.token !== requestToken || current.apiUrl !== requestApiUrl) return null;
          set({ featurePolicy: policy, featurePolicyStatus: 'ready', featurePolicyFetchedAt: Date.now() });
          return policy;
        } catch (err) {
          const current = get().cloudConfig;
          if (current.token !== requestToken || current.apiUrl !== requestApiUrl) return null;
          console.error('Failed to refresh feature policy:', err);
          set({ featurePolicyStatus: 'error' });
          return null;
        }
      },
      isFeatureEnabled: (feature) => {
        const state = get();
        if (isOfflineOnly || state.workspaceMode === 'offline') return true;
        const isFresh = state.featurePolicyFetchedAt !== null && Date.now() - state.featurePolicyFetchedAt < FEATURE_POLICY_TTL_MS;
        return state.featurePolicyStatus === 'ready' && isFresh && state.featurePolicy?.flags[feature] === true;
      },
      setActiveScope: async (scope, forceSync = false) => {
        const {
          workspaceMode,
          collections,
          environments,
          activeEnvironmentId,
          cloudConfig,
          scopeCache,
          lastSyncedAt,
          tabs,
          activeTabId,
          history,
        } = get();

        const isSameScope =
          workspaceMode === 'cloud' &&
          cloudConfig.activeScope &&
          cloudConfig.activeScope.type === scope.type &&
          cloudConfig.activeScope.id === scope.id;

        if (isSameScope && !forceSync && get().syncStatus !== 'idle') {
          return;
        }

        if (!isSameScope || forceSync) invalidateAsyncOperations();

        const updatedScopeCache = { ...(scopeCache || {}) };

        // If transitioning from offline mode, snapshot offline state
        if (workspaceMode === 'offline') {
          const activeLocalId = get().activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
          const updatedOfflineCache = { ...(get().offlineScopeCache || {}) };
          updatedOfflineCache[activeLocalId] = {
            collections,
            environments,
            activeEnvironmentId,
            tabs,
            activeTabId,
            history,
          };
          set({
            offlineScopeCache: updatedOfflineCache,
          });
        } else if (cloudConfig.activeScope) {
          // If transitioning from another cloud scope, snapshot old cloud scope into scopeCache
          const prevKey = getScopeKey(cloudConfig.activeScope);
          const prevEntry = updatedScopeCache[prevKey];
          updatedScopeCache[prevKey] = {
            ...prevEntry,
            collections,
            environments,
            activeEnvironmentId,
            lastSyncedAt,
            tabs,
            activeTabId,
            history,
          };
        }

        // Check if target scope already has cached data in local storage
        const targetCache = updatedScopeCache[getScopeKey(scope)];

        const targetTabs =
          targetCache?.tabs && targetCache.tabs.length > 0
            ? targetCache.tabs
            : [createInitialTab()];
        const targetActiveTabId =
          targetCache?.activeTabId && targetTabs.some((t) => t.id === targetCache.activeTabId)
            ? targetCache.activeTabId
            : targetTabs[0].id;

        const isFresh = Boolean(
          !forceSync &&
          targetCache &&
          targetCache.lastSyncedAt &&
          Date.now() - targetCache.lastSyncedAt < SCOPE_CACHE_TTL_MS
        );

        set((state) => ({
          workspaceMode: 'cloud',
          cloudConfig: {
            ...state.cloudConfig,
            activeScope: scope,
          },
          scopeCache: updatedScopeCache,
          // Load cached data immediately for instant switching, or empty array if newly created/visited
          collections: targetCache ? targetCache.collections : [],
          environments: targetCache ? targetCache.environments : [],
          activeEnvironmentId: targetCache ? (targetCache.activeEnvironmentId || null) : null,
          tabs: targetTabs,
          activeTabId: targetActiveTabId,
          activeResponse: null,
          tabResponses: {},
          isLoading: false,
          history: targetCache?.history || [],
          lastSyncedAt: targetCache?.lastSyncedAt || null,
          syncStatus: isFresh ? 'synced' : 'syncing',
          syncError: null,
        }));

        // The policy is global, but refresh it on every cloud scope change so
        // a user does not keep an old capability snapshot while navigating.
        void get().refreshFeaturePolicy(true);

        if (!isFresh) {
          set({ isSwitchingWorkspace: true });
          try {
            await get().pullCloudDelta();
          } finally {
            set({ isSwitchingWorkspace: false });
          }
        }
      },
      logoutCloud: () => {
        invalidateAsyncOperations({ session: true });
        set({ isSwitchingWorkspace: true });
        const { offlineScopeCache, activeOfflineWorkspaceId } = get();
        const activeLocalId = activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
        const localEntry = (offlineScopeCache || {})[activeLocalId] || {
          collections: [],
          environments: [],
          activeEnvironmentId: null,
          tabs: [createInitialTab()],
          history: [],
        };

        const restoredTabs =
          localEntry.tabs && localEntry.tabs.length > 0
            ? localEntry.tabs
            : [createInitialTab()];
        const restoredActiveTabId =
          localEntry.activeTabId && restoredTabs.some((t) => t.id === localEntry.activeTabId)
            ? localEntry.activeTabId
            : restoredTabs[0].id;

        set((state) => ({
          workspaceMode: 'offline',
          collections: localEntry.collections || [],
          environments: localEntry.environments || [],
          activeEnvironmentId: localEntry.activeEnvironmentId || null,
          tabs: restoredTabs,
          activeTabId: restoredActiveTabId,
          activeResponse: null,
          tabResponses: {},
          isLoading: false,
          history: localEntry.history || [],
          scopeCache: {},
          scopesCache: undefined,
          cloudConfig: {
            apiUrl: state.cloudConfig.apiUrl || 'http://localhost:8080',
          },
          featurePolicy: null,
          featurePolicyStatus: 'idle',
          featurePolicyFetchedAt: null,
          syncStatus: 'idle',
          syncError: null,
          lastSyncedAt: null,
        }));

        safeSetTimeout(() => {
          set({ isSwitchingWorkspace: false });
        }, 250);
      },
      setSyncStatus: (syncStatus, syncError = null) => set({ syncStatus, syncError }),
      pullCloudDelta: async () => {
        if (isOfflineOnly) return;
        const { workspaceMode, cloudConfig } = get();
        if (workspaceMode !== 'cloud' || !cloudConfig.token || !cloudConfig.activeScope) {
          return;
        }
        activePullOperation?.controller.abort();
        const operation = beginAsyncOperation();
        activePullOperation = operation;
        const requestedScope = cloudConfig.activeScope;
        set({ syncStatus: 'syncing', syncError: null });
        try {
          // For all cloud scopes (workspace & project):
          // Pull lightweight collection list (metadata only: id, name, version, updated_at),
          // then fetch each modified/new collection 1-by-1 to prevent Vercel FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE.
          const colList = await fetchScopeCollections(
            cloudConfig.apiUrl,
            cloudConfig.token,
            requestedScope,
            cloudConfig.refreshToken,
            operation.controller.signal
          );
          if (!isAsyncOperationCurrent(operation)) return;

          const existingColsMap = new Map<string, Collection>(
            (get().collections || []).map((c) => [c.id, c])
          );
          const pulledCols: Collection[] = [];
          let partialCollectionCount = 0;

          for (const colMeta of colList) {
            if (colMeta.deleted_at) continue;

            const existing = existingColsMap.get(colMeta.id);
            const serverUpdatedAt = new Date(colMeta.updated_at || 0).getTime();
            const serverVersion = colMeta.version;

            // Smart cache: If collection already exists locally and neither version nor updatedAt changed, reuse existing items
            if (
              existing && !existing.isPartial &&
              ((typeof serverVersion === 'number' && existing.version === serverVersion) ||
                (serverUpdatedAt > 0 && existing.updatedAt === serverUpdatedAt))
            ) {
              pulledCols.push({
                ...existing,
                name: colMeta.name,
                description: colMeta.description || '',
                minRole: colMeta.min_role || existing.minRole,
                version: serverVersion ?? existing.version,
                updatedAt: serverUpdatedAt || existing.updatedAt,
              });
              continue;
            }

            // Otherwise, fetch 1-by-1 only for new or modified collections
            try {
              const detail = await fetchCollectionById(
                cloudConfig.apiUrl,
                cloudConfig.token,
                colMeta.id,
                cloudConfig.refreshToken,
                operation.controller.signal
              );
              if (!isAsyncOperationCurrent(operation)) return;
              if (detail && !detail.deleted_at) {
                pulledCols.push(buildCollectionFromDetails(detail));
              }
            } catch (colErr) {
              if (!isAsyncOperationCurrent(operation)) return;
              console.warn(`Failed to fetch details for collection ${colMeta.id}:`, colErr);
              partialCollectionCount += 1;
              pulledCols.push({
                id: colMeta.id,
                name: colMeta.name,
                description: colMeta.description || '',
                items: existing?.items || [],
                minRole: colMeta.min_role || existing?.minRole || 'reader',
                version: existing?.version,
                createdAt: new Date(colMeta.created_at || Date.now()).getTime(),
                updatedAt: existing?.updatedAt || 0,
                _origin: 'cloud',
                isPartial: true,
              });
            }
          }

          const envList = await fetchScopeEnvironments(
            cloudConfig.apiUrl,
            cloudConfig.token,
            requestedScope,
            cloudConfig.refreshToken,
            operation.controller.signal
          );
          if (!isAsyncOperationCurrent(operation)) return;
          const pulledEnvs = buildEnvironmentsFromDelta(envList);

          // Preserve local currentValues if they already exist in current store
          const currentEnvs = get().environments || [];
          const preservedEnvs = pulledEnvs.map((pe) => {
            const localEnv = currentEnvs.find((ce) => ce.id === pe.id);
            if (!localEnv) return pe;
            return {
              ...pe,
              variables: pe.variables.map((pv) => {
                const localVar = localEnv.variables.find((lv) => lv.id === pv.id || lv.key === pv.key);
                return {
                  ...pv,
                  currentValue: localVar?.currentValue !== undefined ? localVar.currentValue : pv.initialValue,
                };
              }),
            };
          });

          const targetActiveId = preservedEnvs.some((e) => e.id === get().activeEnvironmentId)
            ? get().activeEnvironmentId
            : (preservedEnvs[0]?.id || null);

          const scopeKey = getScopeKey(requestedScope);
          const currentScopeCache = get().scopeCache?.[scopeKey];
          const updatedScopeCache = {
            ...(get().scopeCache || {}),
            [scopeKey]: {
              ...currentScopeCache,
              collections: pulledCols,
              environments: preservedEnvs,
              activeEnvironmentId: targetActiveId,
              lastSyncedAt: Date.now(),
              tabs: get().tabs,
              activeTabId: get().activeTabId,
              history: get().history,
            },
          };

          set({
            collections: pulledCols,
            environments: preservedEnvs,
            activeEnvironmentId: targetActiveId,
            scopeCache: updatedScopeCache,
            syncStatus: partialCollectionCount > 0 ? 'error' : 'synced',
            lastSyncedAt: Date.now(),
            syncError: partialCollectionCount > 0
              ? `${partialCollectionCount} collection detail${partialCollectionCount === 1 ? '' : 's'} could not be loaded. Click sync to retry.`
              : null,
          });
        } catch (err: unknown) {
          if (!isAsyncOperationCurrent(operation)) return;
          const errorMsg = err instanceof Error ? err.message : String(err);
          set({
            syncStatus: 'error',
            syncError: errorMsg || 'Cloud sync failed',
          });
        } finally {
          completeAsyncOperation(operation);
          if (activePullOperation === operation) activePullOperation = null;
        }
      },
      importLocalToCloud: async () => {
        const { cloudConfig, offlineScopeCache, activeOfflineWorkspaceId, collections } = get();
        const activeLocalId = activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
        const localEntry = (offlineScopeCache || {})[activeLocalId];
        const colsToImport = (localEntry?.collections && localEntry.collections.length > 0)
          ? localEntry.collections
          : collections;

        if (!cloudConfig.token || !cloudConfig.activeScope) {
          return { success: false, message: 'Not connected to a cloud workspace or project' };
        }
        if (colsToImport.length === 0) {
          return { success: false, message: 'No local collections found to import' };
        }

        let importedCount = 0;
        const operation = beginAsyncOperation();
        try {
          set({ syncStatus: 'syncing', syncError: null });
          for (let i = 0; i < colsToImport.length; i++) {
            if (!isAsyncOperationCurrent(operation)) return { success: false, message: 'Operation cancelled' };
            const col = colsToImport[i];
            if (colsToImport.length > 1) {
              set({
                syncStatus: 'syncing',
                syncError: `Importing collection ${i + 1} of ${colsToImport.length} (${col.name})...`,
              });
            }
            await batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              [col],
              cloudConfig.refreshToken,
              operation.controller.signal
            );
            importedCount++;
          }
          if (!isAsyncOperationCurrent(operation)) return { success: false, message: 'Operation cancelled' };
          await get().pullCloudDelta();
          if (!isAsyncOperationCurrent(operation)) return { success: false, message: 'Operation cancelled' };
          set({ syncStatus: 'synced', syncError: null });
          return { success: true, message: `Successfully imported ${colsToImport.length} collection(s) to cloud` };
        } catch (err: any) {
          if (!isAsyncOperationCurrent(operation)) return { success: false, message: 'Operation cancelled' };
          if (importedCount > 0) {
            try {
              await get().pullCloudDelta();
            } catch {
              // ignore delta pull error during failure recovery
            }
          }
          const failMsg = importedCount > 0
            ? `Imported ${importedCount} of ${colsToImport.length} collection(s). Error on remaining: ${err.message || 'Import failed'}`
            : (err.message || 'Import failed');
          set({ syncStatus: 'error', syncError: failMsg });
          return { success: false, message: failMsg };
        } finally {
          completeAsyncOperation(operation);
        }
      },
      createCloudWorkspace: async (name, description) => {
        const { cloudConfig, scopesCache } = get();
        if (!cloudConfig.token) return { success: false, error: 'Not authenticated' };
        const trimmed = name.trim();
        if (!trimmed) return { success: false, error: 'Workspace name is required' };

        try {
          const newWs = await createCloudWorkspace(
            cloudConfig.apiUrl,
            cloudConfig.token,
            { name: trimmed, description: description?.trim() },
            cloudConfig.refreshToken
          );

          if (scopesCache) {
            const updatedWorkspaces = [...(scopesCache.workspaces || []), newWs];
            set({
              scopesCache: {
                ...scopesCache,
                workspaces: updatedWorkspaces,
              },
            });
          }

          await get().setActiveScope({
            type: 'workspace',
            id: newWs.id,
            name: newWs.name,
            role: 'owner',
          });

          return { success: true, workspace: newWs };
        } catch (err: any) {
          return { success: false, error: err.message || 'Failed to create workspace' };
        }
      },
      renameCloudWorkspace: async (id, name) => {
        const { cloudConfig, scopesCache } = get();
        if (!cloudConfig.token) return { success: false, error: 'Not authenticated' };
        const trimmed = name.trim();
        if (!trimmed) return { success: false, error: 'Workspace name is required' };

        try {
          const updatedWs = await updateCloudWorkspace(
            cloudConfig.apiUrl,
            cloudConfig.token,
            id,
            { name: trimmed },
            cloudConfig.refreshToken
          );

          if (scopesCache) {
            const updatedWorkspaces = (scopesCache.workspaces || []).map((w) =>
              w.id === id ? { ...w, name: updatedWs.name } : w
            );
            set({
              scopesCache: {
                ...scopesCache,
                workspaces: updatedWorkspaces,
              },
            });
          }

          if (cloudConfig.activeScope?.type === 'workspace' && cloudConfig.activeScope.id === id) {
            set({
              cloudConfig: {
                ...cloudConfig,
                activeScope: {
                  ...cloudConfig.activeScope,
                  name: updatedWs.name,
                },
              },
            });
          }

          return { success: true };
        } catch (err: any) {
          return { success: false, error: err.message || 'Failed to rename workspace' };
        }
      },
      deleteCloudWorkspace: async (id) => {
        const { cloudConfig, scopesCache } = get();
        if (!cloudConfig.token) return { success: false, error: 'Not authenticated' };

        try {
          await deleteCloudWorkspace(
            cloudConfig.apiUrl,
            cloudConfig.token,
            id,
            cloudConfig.refreshToken
          );

          const currentWorkspaces = scopesCache?.workspaces || [];
          const remainingWorkspaces = currentWorkspaces.filter((w) => w.id !== id);

          if (cloudConfig.activeScope?.type === 'workspace' && cloudConfig.activeScope.id === id) {
            const fallbackWs = remainingWorkspaces.find((w) => w.is_default) || remainingWorkspaces[0];
            if (fallbackWs) {
              await get().setActiveScope({
                type: 'workspace',
                id: fallbackWs.id,
                name: fallbackWs.name,
                role: 'owner',
              });
            }
          }

          if (scopesCache) {
            set({
              scopesCache: {
                ...scopesCache,
                workspaces: remainingWorkspaces,
              },
            });
          }

          return { success: true };
        } catch (err: any) {
          return { success: false, error: err.message || 'Failed to delete workspace' };
        }
      },
      fetchScopes: async (force = false) => {
        if (isOfflineOnly) return;
        const { cloudConfig, scopesCache } = get();
        if (!cloudConfig.token) return;

        const isFresh = Boolean(
          !force &&
          scopesCache?.lastFetchedAt &&
          Date.now() - scopesCache.lastFetchedAt < SCOPES_LIST_CACHE_TTL_MS &&
          (scopesCache.workspaces.length > 0 || (scopesCache.teams && scopesCache.teams.length > 0) || (scopesCache.teamsWithProjects && scopesCache.teamsWithProjects.length > 0))
        );

        if (isFresh) {
          return;
        }

        const operation = beginAsyncOperation();
        try {
          const [wsList, teamList] = await Promise.all([
            fetchUserWorkspaces(cloudConfig.apiUrl, cloudConfig.token, cloudConfig.refreshToken, operation.controller.signal).catch(() => []),
            fetchUserTeams(cloudConfig.apiUrl, cloudConfig.token, cloudConfig.refreshToken, operation.controller.signal).catch(() => []),
          ]);
          if (!isAsyncOperationCurrent(operation)) return;

          const currentTeamProjects: Record<string, CloudProject[]> = {};
          if (scopesCache?.teamProjects) {
            for (const [tId, pList] of Object.entries(scopesCache.teamProjects)) {
              if (Array.isArray(pList) && pList.length > 0) {
                currentTeamProjects[tId] = pList;
              }
            }
          }

          // Migrate legacy teamsWithProjects cache if teamProjects is empty
          if (Object.keys(currentTeamProjects).length === 0 && scopesCache?.teamsWithProjects) {
            for (const tp of scopesCache.teamsWithProjects) {
              if (tp.team?.id && tp.projects && tp.projects.length > 0) {
                currentTeamProjects[tp.team.id] = tp.projects;
              }
            }
          }

          // If current active scope is a project, prefill its team projects to reconcile user role
          const currentScope = get().cloudConfig.activeScope;
          if (currentScope?.type === 'project' && currentScope.teamId) {
            try {
              const activeTeamProjects = await fetchTeamProjects(
                cloudConfig.apiUrl,
                currentScope.teamId,
                cloudConfig.token!,
                cloudConfig.refreshToken,
                operation.controller.signal
              );
              if (!isAsyncOperationCurrent(operation)) return;
              currentTeamProjects[currentScope.teamId] = activeTeamProjects;
            } catch {
              // ignore background fetch error
            }
          }

          // Clean up orphan team projects from cache if user is no longer in that team
          const validTeamIds = new Set(teamList.map((t) => t.id));
          for (const cachedTeamId of Object.keys(currentTeamProjects)) {
            if (!validTeamIds.has(cachedTeamId)) {
              delete currentTeamProjects[cachedTeamId];
            }
          }

          const teamProjects = teamList.map((t) => ({
            team: t,
            projects: currentTeamProjects[t.id] || [],
          }));

          set({
            scopesCache: {
              workspaces: wsList,
              teams: teamList,
              teamProjects: currentTeamProjects,
              teamsWithProjects: teamProjects,
              lastFetchedAt: Date.now(),
            },
          });

          // Check if active project scope was removed or user's role changed
          if (currentScope?.type === 'project') {
            let accessRevoked = false;
            // Case 1: user removed from the team
            if (currentScope.teamId && !validTeamIds.has(currentScope.teamId)) {
              accessRevoked = true;
            } else if (currentScope.teamId && currentScope.id) {
              // Case 2: user removed from this specific project
              const projectsForActiveTeam = currentTeamProjects[currentScope.teamId] || [];
              const match = projectsForActiveTeam.find((p) => p.id === currentScope.id);
              if (!match && projectsForActiveTeam.length > 0) {
                accessRevoked = true;
              } else if (
                match &&
                (match.user_role !== currentScope.role ||
                  JSON.stringify(match.permissions) !== JSON.stringify(currentScope.permissions))
              ) {
                // Reconcile active project scope's role and permissions if updated on backend
                set((state) => ({
                  cloudConfig: {
                    ...state.cloudConfig,
                    activeScope: {
                      ...state.cloudConfig.activeScope!,
                      role: match.user_role,
                      permissions: match.permissions,
                    },
                  },
                }));
              }
            }

            if (accessRevoked) {
              const defaultWs = wsList[0];
              if (defaultWs) {
                await get().setActiveScope(
                  {
                    type: 'workspace',
                    id: defaultWs.id,
                    name: defaultWs.name,
                    role: 'owner',
                  },
                  true
                );
              } else {
                get().switchOfflineWorkspace(get().activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID);
              }
              set({
                syncError: `Access to "${currentScope.name}" was revoked. Switched to ${
                  defaultWs ? defaultWs.name : 'Offline Workspace'
                }.`,
              });
            }
          }
        } catch (err) {
          if (!isAsyncOperationCurrent(operation)) return;
          console.error('Failed to load scopes:', err);
        } finally {
          completeAsyncOperation(operation);
        }
      },

      fetchProjectsForTeam: async (teamId: string, force = false) => {
        if (isOfflineOnly) return [];
        const { cloudConfig, scopesCache } = get();
        if (!cloudConfig.token || !teamId) return [];

        const hasCached = Boolean(
          scopesCache?.teamProjects &&
          Object.prototype.hasOwnProperty.call(scopesCache.teamProjects, teamId)
        );
        if (!force && hasCached && scopesCache?.teamProjects?.[teamId] && scopesCache.teamProjects[teamId].length > 0) {
          return scopesCache.teamProjects[teamId];
        }

        const operation = beginAsyncOperation();
        try {
          const projects = await fetchTeamProjects(
            cloudConfig.apiUrl,
            teamId,
            cloudConfig.token,
            cloudConfig.refreshToken,
            operation.controller.signal
          );
          if (!isAsyncOperationCurrent(operation)) return [];

          const updatedTeamProjects = {
            ...(scopesCache?.teamProjects || {}),
            [teamId]: projects,
          };

          const teams = scopesCache?.teams || [];
          const updatedTeamsWithProjects = teams.map((t) => ({
            team: t,
            projects: updatedTeamProjects[t.id] || [],
          }));

          set({
            scopesCache: {
              workspaces: scopesCache?.workspaces || [],
              teams,
              teamProjects: updatedTeamProjects,
              teamsWithProjects: updatedTeamsWithProjects,
              lastFetchedAt: scopesCache?.lastFetchedAt || Date.now(),
            },
          });

          // Check if active project scope was in this team and user has been unassigned
          const currentScope = get().cloudConfig.activeScope;
          if (
            currentScope?.type === 'project' &&
            currentScope.teamId === teamId &&
            currentScope.id &&
            !projects.some((p) => p.id === currentScope.id)
          ) {
            const defaultWs = scopesCache?.workspaces?.[0];
            if (defaultWs) {
              await get().setActiveScope(
                {
                  type: 'workspace',
                  id: defaultWs.id,
                  name: defaultWs.name,
                  role: 'owner',
                },
                true
              );
            } else {
              get().switchOfflineWorkspace(get().activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID);
            }
            set({
              syncError: `Access to "${currentScope.name}" was revoked. Switched to ${
                defaultWs ? defaultWs.name : 'Offline Workspace'
              }.`,
            });
          }

          return projects;
        } catch (err: any) {
          if (!isAsyncOperationCurrent(operation)) return [];
          console.error(`Failed to fetch projects for team ${teamId}:`, err);

          // If 403 Forbidden: user has been kicked from the team
          const isForbidden =
            err?.message?.toLowerCase().includes('forbidden') ||
            err?.message?.toLowerCase().includes('not found') ||
            err?.status === 403;

          if (isForbidden) {
            const updatedTeams = (scopesCache?.teams || []).filter((t) => t.id !== teamId);
            const updatedTeamProjects = { ...(scopesCache?.teamProjects || {}) };
            delete updatedTeamProjects[teamId];

            set({
              scopesCache: {
                workspaces: scopesCache?.workspaces || [],
                teams: updatedTeams,
                teamProjects: updatedTeamProjects,
                teamsWithProjects: updatedTeams.map((t) => ({
                  team: t,
                  projects: updatedTeamProjects[t.id] || [],
                })),
                lastFetchedAt: Date.now(),
              },
            });

            const currentScope = get().cloudConfig.activeScope;
            if (currentScope?.type === 'project' && currentScope.teamId === teamId) {
              const defaultWs = scopesCache?.workspaces?.[0];
              if (defaultWs) {
                await get().setActiveScope(
                  {
                    type: 'workspace',
                    id: defaultWs.id,
                    name: defaultWs.name,
                    role: 'owner',
                  },
                  true
                );
              } else {
                get().switchOfflineWorkspace(get().activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID);
              }
              set({
                syncError: `Removed from team. Switched to ${
                  defaultWs ? defaultWs.name : 'Offline Workspace'
                }.`,
              });
            }
          }
          return [];
        } finally {
          completeAsyncOperation(operation);
        }
      },

      // Offline Workspaces Actions
      createOfflineWorkspace: (name, description) => {
        const trimmedName = name.trim() || 'New Workspace';
        const newId = `ws_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const newWs: OfflineWorkspace = {
          id: newId,
          name: trimmedName,
          description: description?.trim(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        const {
          workspaceMode,
          activeOfflineWorkspaceId,
          offlineWorkspaces,
          offlineScopeCache,
          collections,
          environments,
          activeEnvironmentId,
          tabs,
          activeTabId,
          history,
        } = get();

        const updatedOfflineCache = { ...(offlineScopeCache || {}) };
        if (workspaceMode === 'offline' && activeOfflineWorkspaceId) {
          updatedOfflineCache[activeOfflineWorkspaceId] = {
            collections,
            environments,
            activeEnvironmentId,
            tabs,
            activeTabId,
            history,
          };
        }

        const initialTab = createInitialTab();
        updatedOfflineCache[newId] = {
          collections: [],
          environments: [],
          activeEnvironmentId: null,
          tabs: [initialTab],
          activeTabId: initialTab.id,
          history: [],
        };

        set({
          offlineWorkspaces: [...(offlineWorkspaces || [defaultOfflineWorkspace]), newWs],
          offlineScopeCache: updatedOfflineCache,
        });

        get().switchOfflineWorkspace(newId);
        return newId;
      },

      switchOfflineWorkspace: (workspaceId) => {
        const {
          activeOfflineWorkspaceId,
          offlineScopeCache,
          workspaceMode,
          cloudConfig,
          scopeCache,
          collections,
          environments,
          activeEnvironmentId,
          tabs,
          activeTabId,
          history,
          lastSyncedAt,
        } = get();

        if (workspaceMode === 'offline' && activeOfflineWorkspaceId === workspaceId) {
          return;
        }

        invalidateAsyncOperations();
        set({ isSwitchingWorkspace: true });

        const updatedOfflineCache = { ...(offlineScopeCache || {}) };
        const updatedScopeCache = { ...(scopeCache || {}) };

        if (workspaceMode === 'offline' && activeOfflineWorkspaceId) {
          updatedOfflineCache[activeOfflineWorkspaceId] = {
            collections,
            environments,
            activeEnvironmentId,
            tabs,
            activeTabId,
            history,
          };
        } else if (cloudConfig.activeScope) {
          const cloudKey = getScopeKey(cloudConfig.activeScope);
          updatedScopeCache[cloudKey] = {
            ...(updatedScopeCache[cloudKey] || {}),
            collections,
            environments,
            activeEnvironmentId,
            lastSyncedAt,
            tabs,
            activeTabId,
            history,
          };
        }

        const targetEntry = updatedOfflineCache[workspaceId] || {
          collections: [],
          environments: [],
          activeEnvironmentId: null,
          tabs: [createInitialTab()],
          activeTabId: '',
          history: [],
        };

        const restoredTabs =
          targetEntry.tabs && targetEntry.tabs.length > 0
            ? targetEntry.tabs
            : [createInitialTab()];
        const restoredActiveTabId =
          targetEntry.activeTabId && restoredTabs.some((t) => t.id === targetEntry.activeTabId)
            ? targetEntry.activeTabId
            : restoredTabs[0].id;

        set({
          workspaceMode: 'offline',
          hasConfiguredMode: true,
          activeOfflineWorkspaceId: workspaceId,
          offlineScopeCache: updatedOfflineCache,
          scopeCache: updatedScopeCache,
          collections: targetEntry.collections || [],
          environments: targetEntry.environments || [],
          activeEnvironmentId: targetEntry.activeEnvironmentId || null,
          tabs: restoredTabs,
          activeTabId: restoredActiveTabId,
          activeResponse: null,
          tabResponses: {},
          isLoading: false,
          history: targetEntry.history || [],
          syncStatus: 'idle',
          syncError: null,
        });

        safeSetTimeout(() => {
          set({ isSwitchingWorkspace: false });
        }, 80);
      },

      renameOfflineWorkspace: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        set((state) => ({
          offlineWorkspaces: (state.offlineWorkspaces || [defaultOfflineWorkspace]).map((w) =>
            w.id === id ? { ...w, name: trimmed, updatedAt: Date.now() } : w
          ),
        }));
      },

      deleteOfflineWorkspace: (id) => {
        const { offlineWorkspaces, activeOfflineWorkspaceId, offlineScopeCache } = get();
        const list = offlineWorkspaces || [defaultOfflineWorkspace];
        if (list.length <= 1) {
          return { success: false, error: 'Cannot delete the only offline workspace' };
        }

        const remainingWorkspaces = list.filter((w) => w.id !== id);
        const updatedOfflineCache = { ...(offlineScopeCache || {}) };
        revokeBlobUrls((updatedOfflineCache[id]?.history || []).map((entry) => entry.response?.blobUrl));
        delete updatedOfflineCache[id];

        if (activeOfflineWorkspaceId === id) {
          const nextWs = remainingWorkspaces[0];
          set({
            offlineWorkspaces: remainingWorkspaces,
            offlineScopeCache: updatedOfflineCache,
          });
          get().switchOfflineWorkspace(nextWs.id);
        } else {
          set({
            offlineWorkspaces: remainingWorkspaces,
            offlineScopeCache: updatedOfflineCache,
          });
        }

        return { success: true };
      },

      duplicateOfflineWorkspace: (id, newName) => {
        const {
          offlineWorkspaces,
          activeOfflineWorkspaceId,
          offlineScopeCache,
          workspaceMode,
          collections,
          environments,
          activeEnvironmentId,
          tabs,
          activeTabId,
          history,
        } = get();

        const list = offlineWorkspaces || [defaultOfflineWorkspace];
        const sourceWs = list.find((w) => w.id === id);
        if (!sourceWs) return '';

        const updatedOfflineCache = { ...(offlineScopeCache || {}) };
        if (workspaceMode === 'offline' && activeOfflineWorkspaceId === id) {
          updatedOfflineCache[id] = {
            collections,
            environments,
            activeEnvironmentId,
            tabs,
            activeTabId,
            history,
          };
        }

        const sourceData = updatedOfflineCache[id] || {
          collections: [],
          environments: [],
          activeEnvironmentId: null,
          tabs: [createInitialTab()],
          activeTabId: '',
          history: [],
        };

        const newId = `ws_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const cloneName = newName?.trim() || `${sourceWs.name} (Copy)`;
        const clonedWs: OfflineWorkspace = {
          id: newId,
          name: cloneName,
          description: sourceWs.description,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        const clonedCollections = (sourceData.collections || []).map(cloneCollectionPreservingAttachments);
        const clonedEnvironments = JSON.parse(JSON.stringify(sourceData.environments || []));
        const clonedTabs = (sourceData.tabs && sourceData.tabs.length > 0 ? sourceData.tabs : [createInitialTab()])
          .map((tab) => normalizePersistedRequestAttachments(serializeRequestAttachments(tab)));

        updatedOfflineCache[newId] = {
          collections: clonedCollections,
          environments: clonedEnvironments,
          activeEnvironmentId: sourceData.activeEnvironmentId || null,
          tabs: clonedTabs,
          activeTabId: clonedTabs[0]?.id || '',
          history: (sourceData.history || []).map((entry) => ({
            ...entry,
            request: cloneRequestPreservingAttachments(entry.request),
            response: entry.response ? { ...entry.response } : undefined,
          })),
        };

        set({
          offlineWorkspaces: [...list, clonedWs],
          offlineScopeCache: updatedOfflineCache,
        });

        get().switchOfflineWorkspace(newId);
        return newId;
      },

      // Environment actions
      setActiveEnvironmentId: (activeEnvironmentId) =>
        set({ activeEnvironmentId }),

      createEnvironment: (name, minRole = 'reader') => {
        const { workspaceMode, cloudConfig } = get();
        let effectiveMinRole = minRole;
        if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role)) {
            console.warn('User lacks permission to create environment in this scope');
            return '';
          }
          if (effectiveMinRole && !canModifyEnvironment(effectiveMinRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            effectiveMinRole = 'reader';
          }
        }

        const newEnv: Environment = {
          id: generateId(),
          name: name.trim() || 'New Environment',
          variables: [{ id: generateId(), key: '', value: '', initialValue: '', currentValue: '', enabled: true }],
          minRole: effectiveMinRole,
          version: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set((state) => ({
          environments: [...state.environments, newEnv],
          activeEnvironmentId: newEnv.id,
        }));

        if (workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          const operation = beginAsyncOperation();
          createScopeEnvironment(
            cloudConfig.apiUrl,
            cloudConfig.token,
            cloudConfig.activeScope,
            {
              name: newEnv.name,
              variables: sanitizeVariablesForUpstream(newEnv.variables),
              min_role: newEnv.minRole,
            },
            cloudConfig.refreshToken,
            operation.controller.signal
          ).then((created) => {
            if (!isAsyncOperationCurrent(operation)) return;
            if (created && created.id) {
              set((state) => {
                if (!isAsyncOperationCurrent(operation)) return {};
                return {
                  environments: state.environments.map((e) =>
                    e.id === newEnv.id
                      ? { ...e, id: created.id, version: created.version || 1 }
                      : e
                  ),
                  activeEnvironmentId: state.activeEnvironmentId === newEnv.id ? created.id : state.activeEnvironmentId,
                };
              });
            }
          }).catch((err) => {
            if (!isAsyncOperationCurrent(operation)) return;
            console.error('Failed to sync created environment to cloud:', err);
          }).finally(() => {
            completeAsyncOperation(operation);
          });
        }

        return newEnv.id;
      },

      deleteEnvironment: (id) => {
        const { workspaceMode, cloudConfig, environments } = get();
        const env = environments.find((e) => e.id === id);
        if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:delete', workspaceMode, cloudConfig.user?.role) ||
              !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn(`User lacks permission to delete environment "${env.name}"`);
            return;
          }
        }

        if (envSyncDebounceTimers[id]) {
          clearTimeout(envSyncDebounceTimers[id]);
          delete envSyncDebounceTimers[id];
        }

        set((state) => ({
          environments: state.environments.filter((e) => e.id !== id),
          activeEnvironmentId: state.activeEnvironmentId === id ? null : state.activeEnvironmentId,
        }));

        if (workspaceMode === 'cloud' && cloudConfig.token) {
          const operation = beginAsyncOperation();
          deleteScopeEnvironment(
            cloudConfig.apiUrl,
            cloudConfig.token,
            id,
            cloudConfig.refreshToken,
            operation.controller.signal
          ).catch((err) => {
            if (!isAsyncOperationCurrent(operation)) return;
            console.error('Failed to delete environment from cloud:', err);
          }).finally(() => {
            completeAsyncOperation(operation);
          });
        }
      },

      updateEnvironment: (id, updates) => {
        const { workspaceMode, cloudConfig, environments } = get();
        const env = environments.find((e) => e.id === id);
        if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
              !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn(`User lacks permission to update environment "${env.name}"`);
            return;
          }
          if (updates.minRole && !canModifyEnvironment(updates.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn(`User lacks permission to assign minRole "${updates.minRole}" to environment "${env.name}"`);
            return;
          }
        }

        set((state) => ({
          environments: state.environments.map((e) => {
            if (e.id === id) {
              return { ...e, ...updates, updatedAt: Date.now() };
            }
            return e;
          }),
        }));

        scheduleEnvironmentCloudSync(id, get, set);
      },

      addEnvironmentVariable: (envId) => {
        const { workspaceMode, cloudConfig, environments } = get();
        const env = environments.find((e) => e.id === envId);
        if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
              !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn('User lacks permission to modify environments in this scope');
            return;
          }
        }

        set((state) => ({
          environments: state.environments.map((e) => {
            if (e.id !== envId) return e;
            return {
              ...e,
              variables: [
                ...e.variables,
                { id: generateId(), key: '', value: '', initialValue: '', currentValue: '', enabled: true },
              ],
              updatedAt: Date.now(),
            };
          }),
        }));

        scheduleEnvironmentCloudSync(envId, get, set);
      },

      updateEnvironmentVariable: (envId, varId, updates) => {
        const updateKeys = Object.keys(updates);
        const isOnlyCurrentValue = updateKeys.length === 1 && updateKeys[0] === 'currentValue';

        if (!isOnlyCurrentValue) {
          const { workspaceMode, cloudConfig, environments } = get();
          const env = environments.find((e) => e.id === envId);
          if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
            if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
                !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
              console.warn('User lacks permission to modify environments in this scope');
              return;
            }
          }
        }

        set((state) => ({
          environments: state.environments.map((e) => {
            if (e.id !== envId) return e;
            return {
              ...e,
              variables: e.variables.map((v) => {
                if (v.id !== varId) return v;
                const next = { ...v, ...updates };
                if (updates.initialValue !== undefined) {
                  next.value = updates.initialValue;
                }
                return next;
              }),
              updatedAt: Date.now(),
            };
          }),
        }));

        if (!isOnlyCurrentValue) {
          scheduleEnvironmentCloudSync(envId, get, set);
        }
      },

      removeEnvironmentVariable: (envId, varId) => {
        const { workspaceMode, cloudConfig, environments } = get();
        const env = environments.find((e) => e.id === envId);
        if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
              !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn('User lacks permission to modify environments in this scope');
            return;
          }
        }

        set((state) => ({
          environments: state.environments.map((e) => {
            if (e.id !== envId) return e;
            return {
              ...e,
              variables: e.variables.filter((v) => v.id !== varId),
              updatedAt: Date.now(),
            };
          }),
        }));

        scheduleEnvironmentCloudSync(envId, get, set);
      },

      resetEnvironmentCurrentValues: (envId) => {
        set((state) => ({
          environments: state.environments.map((e) => {
            if (e.id !== envId) return e;
            return {
              ...e,
              variables: e.variables.map((v) => ({
                ...v,
                currentValue: v.initialValue ?? v.value ?? '',
              })),
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      persistEnvironmentCurrentValues: (envId) => {
        const { workspaceMode, cloudConfig, environments } = get();
        const env = environments.find((e) => e.id === envId);
        if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
              !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn('User lacks permission to modify environments in this scope');
            return;
          }
        }

        set((state) => ({
          environments: state.environments.map((e) => {
            if (e.id !== envId) return e;
            return {
              ...e,
              variables: e.variables.map((v) => {
                const effective = v.currentValue ?? v.initialValue ?? v.value ?? '';
                return {
                  ...v,
                  initialValue: effective,
                  value: effective,
                };
              }),
              updatedAt: Date.now(),
            };
          }),
        }));

        scheduleEnvironmentCloudSync(envId, get, set);
      },

      addEnvironment: async (env: Environment) => {
        const { workspaceMode, cloudConfig } = get();
        if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role)) {
            console.warn('User lacks permission to add environment in this scope');
            return env.id;
          }
        }

        set((state) => ({
          environments: [...state.environments, env],
          activeEnvironmentId: env.id,
        }));

        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          const operation = beginAsyncOperation();
          try {
            const created = await createScopeEnvironment(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              {
                name: env.name,
                variables: sanitizeVariablesForUpstream(env.variables),
                min_role: env.minRole || 'reader',
              },
              cloudConfig.refreshToken,
              operation.controller.signal
            );
            if (!isAsyncOperationCurrent(operation)) return env.id;
            if (created && created.id) {
              set((state) => {
                if (!isAsyncOperationCurrent(operation)) return {};
                return {
                  environments: state.environments.map((e) =>
                    e.id === env.id ? { ...e, id: created.id, version: created.version || 1 } : e
                  ),
                  activeEnvironmentId: state.activeEnvironmentId === env.id ? created.id : state.activeEnvironmentId,
                };
              });
              return created.id;
            }
          } catch (err: any) {
            if (!isAsyncOperationCurrent(operation)) return env.id;
            console.error('Failed to sync environment to cloud:', err);
          } finally {
            completeAsyncOperation(operation);
          }
        }
        return env.id;
      },

      replaceEnvironment: async (existingId: string, incomingEnv: Environment) => {
        const { workspaceMode, cloudConfig } = get();
        const state = get();
        const existingEnv = state.environments.find((e) => e.id === existingId);
        if (!existingEnv) {
          throw new Error('Existing environment not found');
        }

        if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
              !canModifyEnvironment(existingEnv.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            throw new Error('Insufficient permission to modify environments in this scope (requires env:write and adequate role)');
          }
        }

        if (envSyncDebounceTimers[existingId]) {
          clearTimeout(envSyncDebounceTimers[existingId]);
          delete envSyncDebounceTimers[existingId];
        }

        const alignedVars = alignEnvironmentVariableIds(existingEnv.variables || [], incomingEnv.variables || []);

        let effectiveMinRole = incomingEnv.minRole || existingEnv.minRole;
        if (incomingEnv.minRole && incomingEnv.minRole !== existingEnv.minRole && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!canModifyEnvironment(incomingEnv.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            effectiveMinRole = existingEnv.minRole;
          }
        }

        const replacedEnv: Environment = {
          ...incomingEnv,
          id: existingId,
          name: incomingEnv.name,
          variables: alignedVars,
          minRole: effectiveMinRole,
          version: existingEnv.version || 1,
          updatedAt: Date.now(),
        };

        set((s) => ({
          environments: s.environments.map((e) => (e.id === existingId ? replacedEnv : e)),
          activeEnvironmentId: existingId,
        }));

        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          const operation = beginAsyncOperation();
          try {
            const res = await updateScopeEnvironment(
              cloudConfig.apiUrl,
              cloudConfig.token,
              existingId,
              {
                name: replacedEnv.name,
                variables: sanitizeVariablesForUpstream(replacedEnv.variables),
                min_role: replacedEnv.minRole,
                base_version: replacedEnv.version || 1,
              },
              cloudConfig.refreshToken,
              operation.controller.signal
            );
            if (!isAsyncOperationCurrent(operation)) return;
            if (res && typeof res.version === 'number') {
              set((s) => {
                if (!isAsyncOperationCurrent(operation)) return {};
                return {
                  environments: s.environments.map((e) =>
                    e.id === existingId ? { ...e, version: res.version } : e
                  ),
                };
              });
            }
          } catch (err: any) {
            if (!isAsyncOperationCurrent(operation)) return;
            if (err?.status === 409) {
              const remote = getRemoteEnvironment(err.data);
              set((state) => {
                if (!isAsyncOperationCurrent(operation)) return {};
                return {
                  syncStatus: 'error',
                  syncError: 'Environment changes conflict with a newer server version. Review the conflict before saving again.',
                  environmentOccConflict: remote ? { local: replacedEnv, remote } : null,
                };
              });
            }
            console.error('Failed to sync replaced environment to cloud:', err);
            throw err;
          } finally {
            completeAsyncOperation(operation);
          }
        }
      },

      discardEnvironmentOccConflict: () => {
        const conflict = get().environmentOccConflict;
        if (!conflict) return;
        const resolved = preserveCurrentValues(conflict.remote, conflict.local);
        set((state) => ({
          environments: state.environments.map((environment) => environment.id === resolved.id ? resolved : environment),
          environmentOccConflict: null,
          syncStatus: 'idle',
          syncError: null,
        }));
      },

      overwriteEnvironmentOccConflict: async () => {
        const state = get();
        const conflict = state.environmentOccConflict;
        const { cloudConfig, workspaceMode } = state;
        if (!conflict || workspaceMode !== 'cloud' || !cloudConfig.token || !cloudConfig.activeScope) return;
        if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role)) {
          set({ syncStatus: 'error', syncError: 'You no longer have permission to update this environment.' });
          return;
        }
        const operation = beginAsyncOperation();
        try {
          const response = await updateScopeEnvironment(
            cloudConfig.apiUrl,
            cloudConfig.token,
            conflict.local.id,
            {
              name: conflict.local.name,
              variables: sanitizeVariablesForUpstream(conflict.local.variables),
              min_role: conflict.local.minRole,
              base_version: conflict.remote.version || 1,
            },
            cloudConfig.refreshToken,
            operation.controller.signal
          );
          if (!isAsyncOperationCurrent(operation)) return;
          set((current) => {
            if (!isAsyncOperationCurrent(operation)) return {};
            return {
              environments: current.environments.map((environment) => environment.id === conflict.local.id
                ? { ...environment, version: response.version || conflict.remote.version }
                : environment),
              environmentOccConflict: null,
              syncStatus: 'synced',
              syncError: null,
            };
          });
        } catch (err: any) {
          if (!isAsyncOperationCurrent(operation)) return;
          const remote = err?.status === 409 ? getRemoteEnvironment(err.data) : null;
          set((current) => {
            if (!isAsyncOperationCurrent(operation)) return {};
            return {
              environmentOccConflict: remote ? { local: conflict.local, remote } : current.environmentOccConflict,
              syncStatus: 'error',
              syncError: err?.status === 409
                ? 'The server changed again. Review the latest version before saving.'
                : err?.message || 'Failed to update environment.',
            };
          });
        } finally {
          completeAsyncOperation(operation);
        }
      },

      setSidebarTab: (sidebarTab) => set({ sidebarTab }),

      setActiveTabId: (activeTabId) => {
        set((state) => ({
          activeTabId,
          activeResponse: state.tabResponses?.[activeTabId] || null,
        }));
      },

      createTab: (initial) => {
        const newReq: ApiRequest = {
          id: generateId(),
          name: initial?.name || 'Untitled Request',
          method: initial?.method || 'GET',
          url: initial?.url || '',
          params: initial?.params || [{ id: generateId(), key: '', value: '', enabled: true }],
          headers: initial?.headers || [{ id: generateId(), key: '', value: '', enabled: true }],
          auth: initial?.auth || { type: 'none' },
          bodyType: initial?.bodyType || 'none',
          rawType: initial?.rawType || 'text',
          bodyContent: initial?.bodyContent || '',
          graphqlQuery: initial?.graphqlQuery || '',
          graphqlVariables: initial?.graphqlVariables || '',
          bodyFormData: initial?.bodyFormData || [],
          bodyBinaryFile: initial?.bodyBinaryFile,
          bodyUrlEncoded: initial?.bodyUrlEncoded || [{ id: generateId(), key: '', value: '', enabled: true }],
          preRequestScript: initial?.preRequestScript || '',
          postResponseScript: initial?.postResponseScript || '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        set((state) => ({
          tabs: [...state.tabs, newReq],
          activeTabId: newReq.id,
          activeResponse: null,
        }));
      },

      closeTab: (id) => {
        set((state) => {
          const closedResponse = state.tabResponses?.[id];
          if (closedResponse?.blobUrl) {
            const isReferencedInHistory = state.history.some((h) => h.response?.blobUrl === closedResponse.blobUrl);
            const isReferencedInOtherTab = Object.entries(state.tabResponses || {}).some(
              ([tabId, res]) => tabId !== id && res?.blobUrl === closedResponse.blobUrl
            );
            if (!isReferencedInHistory && !isReferencedInOtherTab) {
              revokeBlobUrl(closedResponse.blobUrl);
            }
          }

          const nextTabResponses = { ...(state.tabResponses || {}) };
          delete nextTabResponses[id];

          const filteredTabs = state.tabs.filter((t) => t.id !== id);
          if (filteredTabs.length === 0) {
            return {
              tabs: [],
              activeTabId: '',
              activeResponse: null,
              tabResponses: nextTabResponses,
            };
          }

          let newActiveId = state.activeTabId;
          if (state.activeTabId === id) {
            const closingIndex = state.tabs.findIndex((t) => t.id === id);
            const nextTab = filteredTabs[closingIndex] || filteredTabs[closingIndex - 1] || filteredTabs[0];
            newActiveId = nextTab.id;
          }

          return {
            tabs: filteredTabs,
            activeTabId: newActiveId,
            activeResponse: nextTabResponses[newActiveId] || null,
            tabResponses: nextTabResponses,
          };
        });
      },

      closeOtherTabs: (id) => {
        set((state) => {
          const targetTab = state.tabs.find((t) => t.id === id);
          if (!targetTab) return state;

          const nextTabResponses: Record<string, ApiResponse> = {};
          if (state.tabResponses?.[id]) {
            nextTabResponses[id] = state.tabResponses[id];
          }

          Object.entries(state.tabResponses || {}).forEach(([tabId, res]) => {
            if (tabId !== id && res?.blobUrl) {
              const isReferencedInHistory = state.history.some((h) => h.response?.blobUrl === res.blobUrl);
              if (!isReferencedInHistory && nextTabResponses[id]?.blobUrl !== res.blobUrl) {
                revokeBlobUrl(res.blobUrl);
              }
            }
          });

          return {
            tabs: [targetTab],
            activeTabId: id,
            activeResponse: nextTabResponses[id] || null,
            tabResponses: nextTabResponses,
          };
        });
      },

      closeAllTabs: () => {
        set((state) => {
          Object.values(state.tabResponses || {}).forEach((res) => {
            if (res?.blobUrl) {
              const isReferencedInHistory = state.history.some((h) => h.response?.blobUrl === res.blobUrl);
              if (!isReferencedInHistory) {
                revokeBlobUrl(res.blobUrl);
              }
            }
          });

          return {
            tabs: [],
            activeTabId: '',
            activeResponse: null,
            tabResponses: {},
          };
        });
      },

      closeTabsToRight: (id) => {
        set((state) => {
          const index = state.tabs.findIndex((t) => t.id === id);
          if (index === -1) return state;
          const remainingTabs = state.tabs.slice(0, index + 1);
          const remainingIds = new Set(remainingTabs.map((t) => t.id));
          const wasActiveClosed = !remainingTabs.some((t) => t.id === state.activeTabId);
          const nextActiveId = wasActiveClosed ? id : state.activeTabId;

          const nextTabResponses: Record<string, ApiResponse> = {};
          Object.entries(state.tabResponses || {}).forEach(([tabId, res]) => {
            if (remainingIds.has(tabId)) {
              nextTabResponses[tabId] = res;
            } else if (res?.blobUrl) {
              const isReferencedInHistory = state.history.some((h) => h.response?.blobUrl === res.blobUrl);
              if (!isReferencedInHistory) {
                revokeBlobUrl(res.blobUrl);
              }
            }
          });

          return {
            tabs: remainingTabs,
            activeTabId: nextActiveId,
            activeResponse: nextTabResponses[nextActiveId] || null,
            tabResponses: nextTabResponses,
          };
        });
      },

      duplicateTab: (id) => {
        set((state) => {
          const sourceTab = state.tabs.find((t) => t.id === id);
          if (!sourceTab) return state;
          const duplicatedTab: ApiRequest = {
            ...sourceTab,
            id: generateId(),
            name: `${sourceTab.name || 'Untitled Request'} (Copy)`,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            params: sourceTab.params.map((p) => ({ ...p, id: generateId() })),
            headers: sourceTab.headers.map((h) => ({ ...h, id: generateId() })),
            bodyFormData: sourceTab.bodyFormData ? sourceTab.bodyFormData.map((f) => ({ ...f, id: generateId() })) : [],
            bodyUrlEncoded: sourceTab.bodyUrlEncoded ? sourceTab.bodyUrlEncoded.map((u) => ({ ...u, id: generateId() })) : [{ id: generateId(), key: '', value: '', enabled: true }],
          };
          const index = state.tabs.findIndex((t) => t.id === id);
          const newTabs = [...state.tabs];
          newTabs.splice(index + 1, 0, duplicatedTab);
          return {
            tabs: newTabs,
            activeTabId: duplicatedTab.id,
            activeResponse: null,
          };
        });
      },

      updateActiveRequest: (updates) => {
        set((state) => {
          const nextActiveTabId = updates.id !== undefined ? updates.id : state.activeTabId;
          let nextTabResponses = state.tabResponses;
          if (updates.id !== undefined && updates.id !== state.activeTabId && state.tabResponses?.[state.activeTabId]) {
            nextTabResponses = { ...(state.tabResponses || {}) };
            nextTabResponses[updates.id] = nextTabResponses[state.activeTabId];
            delete nextTabResponses[state.activeTabId];
          }
          return {
            activeTabId: nextActiveTabId,
            tabResponses: nextTabResponses,
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              if (updates.url !== undefined && updates.url !== tab.url) {
                const syncedParams = updates.params !== undefined ? updates.params : parseQueryParamsFromUrl(updates.url, tab.params);
                const syncedPathVars = updates.pathVariables !== undefined ? updates.pathVariables : parsePathVariablesFromUrl(updates.url, tab.pathVariables);
                return { ...tab, ...updates, params: syncedParams, pathVariables: syncedPathVars, updatedAt: Date.now() };
              }
              return { ...tab, ...updates, updatedAt: Date.now() };
            }),
          };
        });
      },

      updateParam: (id, updates) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            const updatedParams = tab.params.map((p) => (p.id === id ? { ...p, ...updates } : p));
            const updatedUrl = buildUrlWithParams(tab.url, updatedParams);
            return { ...tab, params: updatedParams, url: updatedUrl, updatedAt: Date.now() };
          }),
        }));
      },

      addParam: () => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            const updatedParams = [...tab.params, { id: generateId(), key: '', value: '', enabled: true }];
            const updatedUrl = buildUrlWithParams(tab.url, updatedParams);
            return {
              ...tab,
              params: updatedParams,
              url: updatedUrl,
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      removeParam: (id) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            const updatedParams = tab.params.filter((p) => p.id !== id);
            const updatedUrl = buildUrlWithParams(tab.url, updatedParams);
            return {
              ...tab,
              params: updatedParams,
              url: updatedUrl,
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      updatePathVariable: (id, updates) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            const updatedPathVars = (tab.pathVariables || []).map((pv) =>
              pv.id === id ? { ...pv, ...updates } : pv
            );
            return {
              ...tab,
              pathVariables: updatedPathVars,
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      updateHeader: (id, updates) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            const updatedHeaders = tab.headers.map((h) => (h.id === id ? { ...h, ...updates } : h));
            return { ...tab, headers: updatedHeaders, updatedAt: Date.now() };
          }),
        }));
      },

      addHeader: () => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            return {
              ...tab,
              headers: [...tab.headers, { id: generateId(), key: '', value: '', enabled: true }],
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      removeHeader: (id) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            return {
              ...tab,
              headers: tab.headers.filter((h) => h.id !== id),
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      updateAuth: (authUpdates) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            return {
              ...tab,
              auth: { ...tab.auth, ...authUpdates },
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      setBodyType: (bodyType) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            let rawType = tab.rawType || 'text';
            if (bodyType === 'json') rawType = 'json';
            else if (bodyType === 'xml') rawType = 'xml';
            const method = (bodyType === 'graphql' || bodyType === 'form-data' || bodyType === 'x-www-form-urlencoded') && tab.method === 'GET' ? 'POST' : tab.method;

            let bodyUrlEncoded = tab.bodyUrlEncoded;
            if (bodyType === 'x-www-form-urlencoded') {
              const hasRealItems =
                bodyUrlEncoded &&
                bodyUrlEncoded.some(
                  (item) => String(item?.key ?? '').trim() || String(item?.value ?? '').trim()
                );
              if (!hasRealItems) {
                const trimmedBody = (tab.bodyContent || '').trim();
                if (trimmedBody.startsWith('{')) {
                  try {
                    const parsed = JSON.parse(trimmedBody);
                    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                      const items: KeyValuePair[] = Object.entries(parsed).map(([k, v]) => ({
                        id: generateId(),
                        key: k,
                        value: typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''),
                        enabled: true,
                      }));
                      if (items.length > 0) bodyUrlEncoded = items;
                    }
                  } catch {
                    // ignore JSON parse error
                  }
                } else if (trimmedBody.includes('=')) {
                  try {
                    const params = new URLSearchParams(trimmedBody);
                    const items: KeyValuePair[] = [];
                    params.forEach((v, k) => {
                      items.push({ id: generateId(), key: k, value: v, enabled: true });
                    });
                    if (items.length > 0) bodyUrlEncoded = items;
                  } catch {
                    // ignore
                  }
                }
              }

              if (!bodyUrlEncoded || bodyUrlEncoded.length === 0) {
                bodyUrlEncoded = [{ id: generateId(), key: '', value: '', enabled: true }];
              }
            }

            return { ...tab, bodyType, rawType, method, bodyUrlEncoded, updatedAt: Date.now() };
          }),
        }));
      },

      setRawType: (rawType) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            return { ...tab, rawType, updatedAt: Date.now() };
          }),
        }));
      },

      setBodyContent: (bodyContent) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            return { ...tab, bodyContent, updatedAt: Date.now() };
          }),
        }));
      },

      setGraphqlQuery: (graphqlQuery) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            return { ...tab, graphqlQuery, updatedAt: Date.now() };
          }),
        }));
      },

      setGraphqlVariables: (graphqlVariables) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            return { ...tab, graphqlVariables, updatedAt: Date.now() };
          }),
        }));
      },

      setPreRequestScript: (preRequestScript) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            return { ...tab, preRequestScript, updatedAt: Date.now() };
          }),
        }));
      },

      setPostResponseScript: (postResponseScript) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            return { ...tab, postResponseScript, updatedAt: Date.now() };
          }),
        }));
      },

      // Form Data actions
      updateFormDataItem: (id, updates) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            const currentList = tab.bodyFormData || [];
            return {
              ...tab,
              bodyFormData: currentList.map((item) => (item.id === id ? { ...item, ...updates } : item)),
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      addFormDataItem: () => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            const currentList = tab.bodyFormData || [];
            return {
              ...tab,
              bodyFormData: [
                ...currentList,
                { id: generateId(), key: '', type: 'text', value: '', enabled: true },
              ],
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      removeFormDataItem: (id) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            const currentList = tab.bodyFormData || [];
            return {
              ...tab,
              bodyFormData: currentList.filter((item) => item.id !== id),
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      setBodyBinaryFile: (bodyBinaryFile) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            return { ...tab, bodyBinaryFile, updatedAt: Date.now() };
          }),
        }));
      },

      // URL-Encoded Form actions
      updateUrlEncodedItem: (id, updates) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            const currentList = tab.bodyUrlEncoded || [];
            return {
              ...tab,
              bodyUrlEncoded: currentList.map((item) => (item.id === id ? { ...item, ...updates } : item)),
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      addUrlEncodedItem: () => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            const currentList = tab.bodyUrlEncoded || [];
            return {
              ...tab,
              bodyUrlEncoded: [
                ...currentList,
                { id: generateId(), key: '', value: '', enabled: true },
              ],
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      removeUrlEncodedItem: (id) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            const currentList = tab.bodyUrlEncoded || [];
            return {
              ...tab,
              bodyUrlEncoded: currentList.filter((item) => item.id !== id),
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      setUrlEncodedItems: (items) => {
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            return {
              ...tab,
              bodyUrlEncoded: items,
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      sendRequest: async () => {
        const state = get();
        const activeReq = state.tabs.find((t) => t.id === state.activeTabId);
        if (!activeReq || !activeReq.url.trim() || state.isLoading) return;

        const operation = beginAsyncOperation();
        activeRequestOperation = operation;
        set((s) => {
          const nextTabResponses = { ...(s.tabResponses || {}) };
          delete nextTabResponses[activeReq.id];
          return {
            isLoading: true,
            activeResponse: null,
            tabResponses: nextTabResponses,
          };
        });

        try {
          // 1. Collect current active environment variables
          const activeEnv = state.environments.find((e) => e.id === state.activeEnvironmentId);
          const envVarsMap: Record<string, string> = {};
          if (activeEnv) {
            activeEnv.variables.forEach((v) => {
              if (v.enabled && v.key.trim() !== '') {
                const effVal = v.currentValue !== undefined && v.currentValue !== ''
                  ? v.currentValue
                  : (v.initialValue ?? v.value ?? '');
                envVarsMap[v.key.trim()] = effVal;
              }
            });
          }

          // 2. Execute Pre-request Script (if present)
          const scriptResult = await executePreRequestScript(
            activeReq.preRequestScript || '',
            envVarsMap,
            {},
            { signal: operation.controller.signal, scriptExecutor: boundAdapter?.scriptExecutor }
          );

          if (!isAsyncOperationCurrent(operation)) return;

          if (!scriptResult.success) {
            const scriptError = scriptResult.error || 'The pre-request script failed before the request could be sent.';
            const scriptFailureResponse: ApiResponse = {
              status: 0,
              statusText: 'Pre-request Script Failed',
              timeMs: 0,
              sizeBytes: 0,
              headers: {},
              data: 'Request was not sent because its pre-request script failed.',
              isError: true,
              errorDetail: scriptError,
              scriptError,
              scriptErrorStage: 'pre-request',
              requestUrl: activeReq.url,
              timestamp: Date.now(),
            };

            set((s) => ({
              activeResponse: scriptFailureResponse,
              tabResponses: { ...(s.tabResponses || {}), [activeReq.id]: scriptFailureResponse },
              isLoading: false,
            }));
            return;
          }

          // Update environment with any modifications made by pm.environment.set() (updates currentValue ONLY without upstream sync)
          if (activeEnv) {
            set((s) => ({
              environments: s.environments.map((e) => {
                if (e.id !== activeEnv.id) return e;
                const updatedVariables = [...e.variables];
                Object.entries(scriptResult.environment).forEach(([key, val]) => {
                  const existingIdx = updatedVariables.findIndex((v) => v.key.trim() === key);
                  if (existingIdx >= 0) {
                    updatedVariables[existingIdx] = {
                      ...updatedVariables[existingIdx],
                      currentValue: val,
                    };
                  } else {
                    updatedVariables.push({
                      id: generateId(),
                      key,
                      value: '',
                      initialValue: '',
                      currentValue: val,
                      enabled: true,
                    });
                  }
                });
                return {
                  ...e,
                  variables: updatedVariables,
                  updatedAt: Date.now(),
                };
              }),
            }));
          }

          // Merge environment variables and script runtime variables
          const finalVariables = {
            ...scriptResult.environment,
            ...scriptResult.variables,
          };

          // 3. Dispatch API request with interpolated variables
          const response = await executeApiRequest(
            activeReq,
            finalVariables,
            operation.controller.signal,
            boundAdapter
          );
          if (!isAsyncOperationCurrent(operation)) return;

          // 4. Execute Post-response script (tests, token extraction)
          let scriptError: string | undefined;
          let scriptErrorStage: ApiResponse['scriptErrorStage'];
          const updatedKeys: string[] = [];

          if (!response.failureKind && activeReq.postResponseScript && activeReq.postResponseScript.trim()) {
            const postScriptResult = await executePostResponseScript(
              activeReq.postResponseScript,
              response,
              finalVariables,
              scriptResult.variables,
              { signal: operation.controller.signal, scriptExecutor: boundAdapter?.scriptExecutor }
            );

            if (!isAsyncOperationCurrent(operation)) return;

            if (postScriptResult.success && activeEnv) {
              set((s) => ({
                environments: s.environments.map((e) => {
                  if (e.id !== activeEnv.id) return e;
                  const updatedVariables = [...e.variables];
                  Object.entries(postScriptResult.environment).forEach(([key, val]) => {
                    const existingIdx = updatedVariables.findIndex((v) => v.key.trim() === key);
                    if (existingIdx >= 0) {
                      if (updatedVariables[existingIdx].currentValue !== val) {
                        updatedKeys.push(key);
                      }
                      updatedVariables[existingIdx] = {
                        ...updatedVariables[existingIdx],
                        currentValue: val,
                      };
                    } else {
                      updatedKeys.push(key);
                      updatedVariables.push({
                        id: generateId(),
                        key,
                        value: '',
                        initialValue: '',
                        currentValue: val,
                        enabled: true,
                      });
                    }
                  });
                  return {
                    ...e,
                    variables: updatedVariables,
                    updatedAt: Date.now(),
                  };
                }),
              }));
            } else if (!postScriptResult.success && postScriptResult.error) {
              scriptError = postScriptResult.error;
              scriptErrorStage = 'post-response';
            }
          }

          const finalResponse: ApiResponse = {
            ...response,
            scriptError,
            scriptErrorStage,
            updatedEnvVars: updatedKeys.length > 0 ? updatedKeys : undefined,
          };

          const historyEntry: HistoryItem = {
            id: generateId(),
            request: cloneRequestPreservingAttachments(activeReq),
            response: finalResponse,
            timestamp: Date.now(),
          };

          set((s) => {
            const evictedHistory = s.history.slice(49);
            revokeBlobUrls(evictedHistory.map((entry) => entry.response?.blobUrl));
            const newHistory = [historyEntry, ...s.history].slice(0, 50);
            const updatedTabResponses = {
              ...(s.tabResponses || {}),
              [activeReq.id]: finalResponse,
            };
            if (s.workspaceMode === 'offline') {
              return {
                activeResponse: finalResponse,
                tabResponses: updatedTabResponses,
                isLoading: false,
                history: newHistory,
              };
            }

            const activeScope = s.cloudConfig.activeScope;
            let updatedScopeCache = s.scopeCache;
            if (activeScope) {
              const scopeKey = getScopeKey(activeScope);
              const entry = (s.scopeCache || {})[scopeKey] || {
                collections: s.collections,
                environments: s.environments,
              };
              updatedScopeCache = {
                ...(s.scopeCache || {}),
                [scopeKey]: {
                  ...entry,
                  history: newHistory,
                },
              };
            }

            return {
              activeResponse: finalResponse,
              tabResponses: updatedTabResponses,
              isLoading: false,
              history: newHistory,
              scopeCache: updatedScopeCache,
            };
          });
        } catch (err: unknown) {
          if (!isAsyncOperationCurrent(operation)) return;
          const errorMsg = err instanceof Error ? err.message : String(err);
          const fallbackResponse: ApiResponse = {
            status: 0,
            statusText: 'Client Error',
            timeMs: 0,
            sizeBytes: 0,
            headers: {},
            data: `Failed to initiate request: ${errorMsg}`,
            isError: true,
            errorDetail: errorMsg,
            requestUrl: activeReq.url,
            timestamp: Date.now(),
          };

          set((s) => ({
            activeResponse: fallbackResponse,
            tabResponses: { ...(s.tabResponses || {}), [activeReq.id]: fallbackResponse },
            isLoading: false,
          }));
        } finally {
          if (activeRequestOperation === operation) activeRequestOperation = null;
          completeAsyncOperation(operation);
        }
      },

      cancelActiveRequest: () => {
        const operation = activeRequestOperation;
        if (!operation || operation.controller.signal.aborted) return;
        operation.controller.abort();
        activeRequestOperation = null;
        set((state) => {
          const cancelledResponse: ApiResponse = {
            status: 0,
            statusText: 'Request Cancelled',
            timeMs: 0,
            sizeBytes: 0,
            headers: {},
            data: 'Request was cancelled before a complete response was received.',
            isError: true,
            failureKind: 'cancelled',
            requestUrl: state.tabs.find((tab) => tab.id === state.activeTabId)?.url,
            timestamp: Date.now(),
          };
          return {
            isLoading: false,
            activeResponse: cancelledResponse,
            tabResponses: { ...(state.tabResponses || {}), [state.activeTabId]: cancelledResponse },
          };
        });
      },

      createCollection: (name, description = '') => {
        const { workspaceMode, cloudConfig } = get();
        if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role)) {
            console.warn('Insufficient permissions to create collection in project scope');
            return '';
          }
        }

        const newCol: Collection = {
          id: generateId(),
          name: name.trim() || 'New Collection',
          description: description.trim(),
          items: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          _origin: workspaceMode === 'offline' ? 'offline' : 'cloud',
        };
        set((state) => ({
          collections: [newCol, ...state.collections],
        }));

        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          const operation = beginAsyncOperation();
          batchImportToScope(
            cloudConfig.apiUrl,
            cloudConfig.token,
            cloudConfig.activeScope,
            [newCol],
            cloudConfig.refreshToken,
            operation.controller.signal
          ).catch((err) => {
            if (operation.controller.signal.aborted || !isAsyncOperationCurrent(operation)) return;
            console.error('Failed to sync created collection to cloud:', err);
          }).finally(() => {
            completeAsyncOperation(operation);
          });
        }

        return newCol.id;
      },

      renameCollection: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;

        const { workspaceMode, cloudConfig, collections } = get();
        const col = collections.find((c) => c.id === id);
        if (col) {
          if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn(`User lacks permission to rename collection "${col.name}"`);
            return;
          }
        }

        set((state) => ({
          collections: state.collections.map((col) => {
            if (col.id !== id) return col;
            return {
              ...col,
              name: trimmed,
              updatedAt: Date.now(),
            };
          }),
        }));

        const updatedCols = get().collections;
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          const updatedCol = updatedCols.find((c) => c.id === id);
          if (updatedCol) {
            const operation = beginAsyncOperation();
            batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              [updatedCol],
              cloudConfig.refreshToken,
              operation.controller.signal
            ).catch((err) => {
              if (operation.controller.signal.aborted || !isAsyncOperationCurrent(operation)) return;
              console.error('Failed to sync renamed collection to cloud:', err);
            }).finally(() => {
              completeAsyncOperation(operation);
            });
          }
        }
      },

      createFolder: (collectionId, parentFolderId, name) => {
        const { workspaceMode, cloudConfig, collections } = get();
        const col = collections.find((c) => c.id === collectionId);
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

          const collections = state.collections.map((col) => {
            if (col.id !== collectionId) return col;
            return {
              ...col,
              items: updateItems(col.items),
              updatedAt: Date.now(),
            };
          });

          return {
            collections,
          };
        });

        const updatedCols = get().collections;
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          const updatedCol = updatedCols.find((c) => c.id === collectionId);
          if (updatedCol) {
            const operation = beginAsyncOperation();
            batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              [updatedCol],
              cloudConfig.refreshToken,
              operation.controller.signal
            ).catch((err) => {
              if (operation.controller.signal.aborted || !isAsyncOperationCurrent(operation)) return;
              console.error('Failed to sync created folder to cloud:', err);
            }).finally(() => {
              completeAsyncOperation(operation);
            });
          }
        }

        return newFolderId;
      },

      createRequestInCollection: (collectionId, folderId, name) => {
        const { workspaceMode, cloudConfig, collections } = get();
        const col = collections.find((c) => c.id === collectionId);
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

          const collections = state.collections.map((col) => {
            if (col.id !== collectionId) return col;
            return {
              ...col,
              items: updateItems(col.items),
              updatedAt: Date.now(),
            };
          });

          return {
            collections,
            tabs: [...state.tabs, newReq],
            activeTabId: reqId,
            activeResponse: null,
          };
        });

        const updatedCols = get().collections;
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          const updatedCol = updatedCols.find((c) => c.id === collectionId);
          if (updatedCol) {
            const operation = beginAsyncOperation();
            batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              [updatedCol],
              cloudConfig.refreshToken,
              operation.controller.signal
            ).catch((err) => {
              if (operation.controller.signal.aborted || !isAsyncOperationCurrent(operation)) return;
              console.error('Failed to sync created request to cloud:', err);
            }).finally(() => {
              completeAsyncOperation(operation);
            });
          }
        }

        return newReq;
      },

      deleteCollectionItem: (collectionId, itemId) => {
        const { workspaceMode, cloudConfig, collections } = get();
        const col = collections.find((c) => c.id === collectionId);
        if (col) {
          if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn(`User lacks permission to delete item from collection "${col.name}"`);
            return;
          }
        }

        set((state) => {
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

          const collections = state.collections.map((col) => {
            if (col.id !== collectionId) return col;
            return {
              ...col,
              items: filterItems(col.items),
              updatedAt: Date.now(),
            };
          });

          return {
            collections,
          };
        });

        const updatedCols = get().collections;
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          const operation = beginAsyncOperation();
          deleteScopeItem(
            cloudConfig.apiUrl,
            cloudConfig.token,
            itemId,
            cloudConfig.refreshToken,
            operation.controller.signal
          ).catch((err) => {
            if (!isAsyncOperationCurrent(operation)) return;
            console.error('Failed to delete item from cloud:', err);
          }).finally(() => {
            completeAsyncOperation(operation);
          });

          const updatedCol = updatedCols.find((c) => c.id === collectionId);
          if (updatedCol) {
            const batchOp = beginAsyncOperation();
            batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              [updatedCol],
              cloudConfig.refreshToken,
              batchOp.controller.signal
            ).catch((err) => {
              if (!isAsyncOperationCurrent(batchOp)) return;
              console.error('Failed to sync item deletion to cloud:', err);
            }).finally(() => {
              completeAsyncOperation(batchOp);
            });
          }
        }
      },

      renameCollectionItem: (collectionId, itemId, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;

        const { workspaceMode, cloudConfig, collections } = get();
        const col = collections.find((c) => c.id === collectionId);
        if (col) {
          if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn(`User lacks permission to rename item in collection "${col.name}"`);
            return;
          }
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

          const collections = state.collections.map((col) => {
            if (col.id !== collectionId) return col;
            return {
              ...col,
              items: updateItems(col.items),
              updatedAt: Date.now(),
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
            collections,
            tabs,
          };
        });

        const updatedCols = get().collections;
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          const updatedCol = updatedCols.find((c) => c.id === collectionId);
          if (updatedCol) {
            const operation = beginAsyncOperation();
            batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              [updatedCol],
              cloudConfig.refreshToken,
              operation.controller.signal
            ).catch((err) => {
              if (operation.controller.signal.aborted || !isAsyncOperationCurrent(operation)) return;
              console.error('Failed to sync renamed item to cloud:', err);
            }).finally(() => {
              completeAsyncOperation(operation);
            });
          }
        }
      },

      saveRequestToCollection: (collectionId, folderId, request) => {
        const { workspaceMode, cloudConfig, collections } = get();
        const col = collections.find((c) => c.id === collectionId);
        if (col) {
          if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn(`User lacks permission to modify collection "${col.name}"`);
            return;
          }
        }

        let assignedReqId = request.id;

        set((state) => {
          const cleanReq = cloneRequestPreservingAttachments(request);

          const insertOrUpdateInList = (items: CollectionItem[]): CollectionItem[] => {
            const existingIdx = items.findIndex(
              (item) => item.type === 'request' && (item.id === cleanReq.id || item.request?.id === cleanReq.id)
            );

            if (existingIdx >= 0) {
              const updated = [...items];
              assignedReqId = updated[existingIdx].id;
              cleanReq.id = assignedReqId;
              updated[existingIdx] = {
                ...updated[existingIdx],
                name: cleanReq.name,
                request: cleanReq,
              };
              return updated;
            }

            const isUUID = cleanReq.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanReq.id);
            assignedReqId = isUUID ? cleanReq.id : generateId();
            cleanReq.id = assignedReqId;

            return [
              ...items,
              {
                id: assignedReqId,
                name: cleanReq.name || 'Untitled Request',
                type: 'request',
                request: cleanReq,
              },
            ];
          };

          const collections = state.collections.map((col) => {
            if (col.id !== collectionId) return col;

            if (!folderId) {
              return {
                ...col,
                items: insertOrUpdateInList(col.items),
                updatedAt: Date.now(),
              };
            }

            const updateFolderItems = (items: CollectionItem[]): CollectionItem[] => {
              return items.map((item) => {
                if (item.type === 'folder') {
                  if (item.id === folderId) {
                    return {
                      ...item,
                      items: insertOrUpdateInList(item.items || []),
                    };
                  }
                  return {
                    ...item,
                    items: updateFolderItems(item.items || []),
                  };
                }
                return item;
              });
            };

            return {
              ...col,
              items: updateFolderItems(col.items),
              updatedAt: Date.now(),
            };
          });

          const tabs = state.tabs.map((tab) => {
            if (tab.id === request.id) {
              return { ...tab, id: assignedReqId, name: cleanReq.name };
            }
            return tab;
          });

          const nextActiveTabId = state.activeTabId === request.id ? assignedReqId : state.activeTabId;

          return {
            collections,
            tabs,
            activeTabId: nextActiveTabId,
          };
        });

        const updatedCols = get().collections;
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          const updatedCol = updatedCols.find((c) => c.id === collectionId);
          if (updatedCol) {
            const operation = beginAsyncOperation();
            batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              [updatedCol],
              cloudConfig.refreshToken,
              operation.controller.signal
            ).catch((err) => {
              if (operation.controller.signal.aborted || !isAsyncOperationCurrent(operation)) return;
              console.error('Failed to sync updated collection item to cloud:', err);
            }).finally(() => {
              completeAsyncOperation(operation);
            });
          }
        }
      },

      saveActiveRequest: () => {
        const { tabs, activeTabId, collections, saveRequestToCollection, workspaceMode, cloudConfig } = get();
        const currentTab = tabs.find((t) => t.id === activeTabId);
        if (!currentTab) return { success: false, isDirectSaved: false };

        const saved = findSavedRequestInCollections(collections, currentTab.id);
        if (saved) {
          if (!canModifyCollection(saved.collection.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            return { success: false, isDirectSaved: false };
          }
          saveRequestToCollection(saved.collection.id, saved.folderId, currentTab);
          return { success: true, isDirectSaved: true };
        }

        return { success: false, isDirectSaved: false };
      },

      addCollection: async (collection) => {
        const { workspaceMode, cloudConfig } = get();
        if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role)) {
            console.warn('Insufficient permissions to add collections in project scope');
            return;
          }
        }

        const taggedCol: Collection = {
          ...collection,
          _origin: get().workspaceMode === 'offline' ? 'offline' : 'cloud',
        };
        set((state) => ({
          collections: [taggedCol, ...state.collections],
        }));

        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          const operation = beginAsyncOperation();
          const targetScope = cloudConfig.activeScope;
          try {
            set({ syncStatus: 'syncing', syncError: null });
            await batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              targetScope,
              [collection],
              cloudConfig.refreshToken,
              operation.controller.signal
            );
            if (!isAsyncOperationCurrent(operation) || isStoreDisposed) return;
            if (get().cloudConfig.activeScope?.id !== targetScope.id) return;
            await get().pullCloudDelta();
          } catch (err: any) {
            if (operation.controller.signal.aborted || !isAsyncOperationCurrent(operation) || isStoreDisposed) return;
            set({ syncStatus: 'error', syncError: err.message || 'Failed to sync collection to cloud' });
          } finally {
            completeAsyncOperation(operation);
          }
        }
      },

      replaceCollection: async (existingId: string, newCollection: Collection) => {
        const state = get();
        const existingCol = state.collections.find((c) => c.id === existingId);
        if (!existingCol) {
          throw new Error('Existing collection not found');
        }

        if (!canModifyCollection(existingCol.minRole, state.cloudConfig.activeScope, state.workspaceMode, state.cloudConfig.user?.role)) {
          throw new Error(`Insufficient permissions to replace collection "${existingCol.name}"`);
        }

        const alignedItems = alignCollectionItemIds(existingCol.items || [], newCollection.items || []);
        const existingFlat = flattenCollectionRequests(existingCol.items || []);
        const newFlat = flattenCollectionRequests(alignedItems);
        const newIds = new Set(newFlat.map((i) => i.id).filter(Boolean));
        const removedItemIds = existingFlat
          .map((i) => i.id)
          .filter((id) => id && !newIds.has(id));

        const replacedCol: Collection = {
          ...newCollection,
          id: existingId,
          name: newCollection.name,
          items: alignedItems,
          updatedAt: Date.now(),
          _origin: get().workspaceMode === 'offline' ? 'offline' : 'cloud',
        };

        set((s) => ({
          collections: s.collections.map((c) => (c.id === existingId ? replacedCol : c)),
        }));

        const { workspaceMode, cloudConfig } = get();
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          const operation = beginAsyncOperation();
          try {
            set({ syncStatus: 'syncing', syncError: null });

            for (const remId of removedItemIds) {
              if (!isAsyncOperationCurrent(operation)) return;
              await deleteScopeItem(
                cloudConfig.apiUrl,
                cloudConfig.token,
                remId,
                cloudConfig.refreshToken,
                operation.controller.signal
              ).catch((err) => {
                if (!isAsyncOperationCurrent(operation)) return;
                console.error('Failed to delete removed item from cloud:', err);
              });
            }

            if (!isAsyncOperationCurrent(operation)) return;
            await batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              [replacedCol],
              cloudConfig.refreshToken,
              operation.controller.signal
            );
            if (!isAsyncOperationCurrent(operation)) return;
            await get().pullCloudDelta();
          } catch (err: any) {
            if (!isAsyncOperationCurrent(operation)) return;
            set({ syncStatus: 'error', syncError: err.message || 'Failed to sync replaced collection' });
          } finally {
            completeAsyncOperation(operation);
          }
        }
      },

      importEnvironmentFromJson: (jsonStr) => {
        try {
          const { workspaceMode, cloudConfig } = get();
          if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
            if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role)) {
              return { success: false, error: 'Insufficient permission to import environments into this scope (requires env:write)' };
            }
          }

          const imported = importPostmanEnvironment(jsonStr);
          set((state) => ({
            environments: [...state.environments, imported],
            activeEnvironmentId: imported.id,
          }));

          if (workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
            const operation = beginAsyncOperation();
            createScopeEnvironment(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              {
                name: imported.name,
                variables: sanitizeVariablesForUpstream(imported.variables),
                min_role: imported.minRole || 'reader',
              },
              cloudConfig.refreshToken,
              operation.controller.signal
            ).then((created) => {
              if (!isAsyncOperationCurrent(operation)) return;
              if (created?.id) {
                set((state) => {
                  if (!isAsyncOperationCurrent(operation)) return {};
                  return {
                    environments: state.environments.map((e) =>
                      e.id === imported.id ? { ...e, id: created.id, version: created.version || 1 } : e
                    ),
                    activeEnvironmentId: state.activeEnvironmentId === imported.id ? created.id : state.activeEnvironmentId,
                  };
                });
              }
            }).catch((err) => {
              if (!isAsyncOperationCurrent(operation)) return;
              console.error('Failed to sync imported environment to cloud:', err);
            }).finally(() => {
              completeAsyncOperation(operation);
            });
          }

          return { success: true, environment: imported };
        } catch (err: unknown) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to parse Postman environment',
          };
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
        const { workspaceMode, cloudConfig, collections } = get();
        const col = collections.find((c) => c.id === id);
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

        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token) {
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
            set((state) => ({ collections: state.collections.filter((c) => c.id !== id) }));
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
        set((state) => ({ collections: state.collections.filter((c) => c.id !== id) }));
        return { success: true };
      },

      moveRequest: async (sourceCollectionId, requestId, targetCollectionId, targetFolderId) => {
        const { collections, workspaceMode, cloudConfig } = get();
        const sourceCol = collections.find((c) => c.id === sourceCollectionId);
        const targetCol = collections.find((c) => c.id === targetCollectionId);

        if (!sourceCol) {
          return { success: false, error: 'Source collection not found' };
        }
        if (!targetCol) {
          return { success: false, error: 'Target collection not found' };
        }

        if (!canModifyCollection(sourceCol.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          return { success: false, error: 'Cannot move request: source collection is read-only' };
        }
        if (!canModifyCollection(targetCol.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          return { success: false, error: 'Cannot move request: target collection is read-only' };
        }

        // 1. Locate and extract the item from source collection
        let itemToMove: CollectionItem | null = null;

        const removeItem = (items: CollectionItem[]): CollectionItem[] => {
          const result: CollectionItem[] = [];
          for (const it of items) {
            if (it.type === 'request' && (it.id === requestId || it.request?.id === requestId)) {
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

        const updatedSourceItems = removeItem(sourceCol.items);

        if (!itemToMove) {
          return { success: false, error: 'Request not found in source collection' };
        }

        // 2. Insert item into target collection
        const insertItem = (items: CollectionItem[]): CollectionItem[] => {
          if (!targetFolderId) {
            return [...items, itemToMove!];
          }
          return items.map((it) => {
            if (it.type === 'folder') {
              if (it.id === targetFolderId) {
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

        set((state) => {
          let newCollections: Collection[];

          if (sourceCollectionId === targetCollectionId) {
            // Move within the same collection
            const updatedItemsWithInsert = insertItem(updatedSourceItems);
            newCollections = state.collections.map((col) => {
              if (col.id !== sourceCollectionId) return col;
              return {
                ...col,
                items: updatedItemsWithInsert,
                updatedAt: Date.now(),
              };
            });
          } else {
            // Move across different collections
            newCollections = state.collections.map((col) => {
              if (col.id === sourceCollectionId) {
                return {
                  ...col,
                  items: updatedSourceItems,
                  updatedAt: Date.now(),
                };
              }
              if (col.id === targetCollectionId) {
                return {
                  ...col,
                  items: insertItem(col.items),
                  updatedAt: Date.now(),
                };
              }
              return col;
            });
          }

          return { collections: newCollections };
        });

        // 3. Sync to Cloud if active
        const currentCols = get().collections;
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          const colsToSync = currentCols.filter(
            (c) => c.id === sourceCollectionId || c.id === targetCollectionId
          );
          if (colsToSync.length > 0) {
            const operation = beginAsyncOperation();
            batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              colsToSync,
              cloudConfig.refreshToken,
              operation.controller.signal
            )
              .then(() => {
                if (!isAsyncOperationCurrent(operation)) return;
                if (get().syncStatus === 'error') {
                  set({ syncStatus: 'idle', syncError: null });
                }
              })
              .catch((err) => {
                if (!isAsyncOperationCurrent(operation)) return;
                console.error('Failed to sync moved request to cloud:', err);
                set({ syncStatus: 'error', syncError: err.message || 'Failed to sync moved request to cloud' });
              })
              .finally(() => {
                completeAsyncOperation(operation);
              });
          }
        }

        return { success: true };
      },

      reorderItem: async (collectionId, activeId, targetId, position) => {
        const { collections, workspaceMode, cloudConfig } = get();
        const col = collections.find((c) => c.id === collectionId);
        if (!col) return { success: false, error: 'Collection not found' };

        if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          return { success: false, error: 'User lacks permission to reorder items in this collection' };
        }

        const result = reorderItemInTree(col.items, activeId, targetId, position);
        if (!result) return { success: false, error: 'Invalid reorder operation' };

        const { updatedItems, payload } = result;

        set((state) => ({
          collections: state.collections.map((c) => {
            if (c.id !== collectionId) return c;
            return {
              ...c,
              items: updatedItems,
              updatedAt: Date.now(),
            };
          }),
        }));

        const token = cloudConfig.token;
        if (!isOfflineOnly && workspaceMode === 'cloud' && token) {
          const sendReorder = async () => {
            const operation = beginAsyncOperation();
            try {
              await reorderCollectionItems(
                cloudConfig.apiUrl,
                token,
                collectionId,
                payload,
                cloudConfig.refreshToken,
                operation.controller.signal
              );
              if (!isAsyncOperationCurrent(operation)) return;
              if (get().syncStatus === 'error') {
                set({ syncStatus: 'idle', syncError: null });
              }
            } catch (err: any) {
              if (!isAsyncOperationCurrent(operation)) return;
              // Retry once after 250ms for transient race condition or network glitch
              await new Promise((r) => setTimeout(r, 250));
              if (!isAsyncOperationCurrent(operation)) return;
              try {
                await reorderCollectionItems(
                  cloudConfig.apiUrl,
                  token,
                  collectionId,
                  payload,
                  cloudConfig.refreshToken,
                  operation.controller.signal
                );
                if (!isAsyncOperationCurrent(operation)) return;
                if (get().syncStatus === 'error') {
                  set({ syncStatus: 'idle', syncError: null });
                }
              } catch (retryErr: any) {
                if (!isAsyncOperationCurrent(operation)) return;
                console.error('Failed to sync reordered items to cloud:', retryErr);
                set({ syncStatus: 'error', syncError: retryErr.message || 'Failed to sync reordered items to cloud' });
              }
            } finally {
              completeAsyncOperation(operation);
            }
          };
          sendReorder();
        }

        return { success: true };
      },

      moveCollection: async (collectionId, targetScope) => {
        const {
          workspaceMode,
          collections,
          cloudConfig,
          activeOfflineWorkspaceId,
          offlineScopeCache,
          scopeCache,
        } = get();

        // 1. Target is an offline workspace
        if (targetScope.type === 'offline_workspace') {
          const col = collections.find((c) => c.id === collectionId);
          if (!col) {
            return { success: false, error: 'Collection not found' };
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

          const remainingActive = collections.filter((c) => c.id !== collectionId);
          const updatedOfflineCache = { ...(offlineScopeCache || {}) };

          if (workspaceMode === 'offline' && activeOfflineWorkspaceId) {
            updatedOfflineCache[activeOfflineWorkspaceId] = {
              ...(updatedOfflineCache[activeOfflineWorkspaceId] || {}),
              collections: remainingActive,
              environments: get().environments,
              activeEnvironmentId: get().activeEnvironmentId,
              tabs: get().tabs,
              activeTabId: get().activeTabId,
              history: get().history,
            };
          }

          const targetEntry = updatedOfflineCache[targetScope.id] || {
            collections: [],
            environments: [],
            tabs: [createInitialTab()],
            history: [],
          };

          updatedOfflineCache[targetScope.id] = {
            ...targetEntry,
            collections: [...(targetEntry.collections || []), { ...col, _origin: 'offline' }],
          };

          set({
            collections: remainingActive,
            offlineScopeCache: updatedOfflineCache,
          });

          return { success: true };
        }

        if (isOfflineOnly) {
          return { success: false, error: 'Offline edition cannot move collections to online scopes' };
        }

        if (workspaceMode === 'offline') {
          // Moving from offline to online scope
          const col = collections.find((c) => c.id === collectionId);
          if (!col) {
            return { success: false, error: 'Collection not found' };
          }
          if (!cloudConfig.token) {
            return { success: false, error: 'Cloud authentication required to move collection to an online workspace' };
          }

          const policy = await get().refreshFeaturePolicy();
          if (!policy?.flags['collection.move']) {
            return { success: false, error: 'Collection move is disabled or feature policy is unavailable.' };
          }

          const operation = beginAsyncOperation();
          try {
            set({ syncStatus: 'syncing', syncError: null });
            await batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              targetScope,
              [col],
              cloudConfig.refreshToken,
              operation.controller.signal
            );
            if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled' };

            // Remove from active offline workspace cache
            const remainingActive = collections.filter((c) => c.id !== collectionId);

            const updatedOfflineCache = { ...(offlineScopeCache || {}) };
            if (activeOfflineWorkspaceId && updatedOfflineCache[activeOfflineWorkspaceId]) {
              updatedOfflineCache[activeOfflineWorkspaceId] = {
                ...updatedOfflineCache[activeOfflineWorkspaceId],
                collections: remainingActive,
              };
            }

            // Update target scope cache if present
            const targetKey = getScopeKey(targetScope);
            const updatedScopeCache = { ...(get().scopeCache || {}) };
            if (updatedScopeCache[targetKey]) {
              const existingInTarget = updatedScopeCache[targetKey].collections || [];
              updatedScopeCache[targetKey] = {
                ...updatedScopeCache[targetKey],
                collections: [...existingInTarget, { ...col, _origin: 'cloud' }],
              };
            }

            set({
              collections: remainingActive,
              offlineScopeCache: updatedOfflineCache,
              scopeCache: updatedScopeCache,
              syncStatus: 'idle',
            });

            return { success: true };
          } catch (err: any) {
            if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled' };
            set({ syncStatus: 'error', syncError: err.message || 'Failed to move collection' });
            return { success: false, error: err.message || 'Failed to move collection' };
          } finally {
            completeAsyncOperation(operation);
          }
        } else {
          // Moving from an online scope to another online scope
          const col = collections.find((c) => c.id === collectionId);
          if (!col) {
            return { success: false, error: 'Collection not found' };
          }
          if (!cloudConfig.token || !cloudConfig.activeScope) {
            return { success: false, error: 'Not connected to cloud' };
          }
          if (!get().isFeatureEnabled('collection.move')) {
            void get().refreshFeaturePolicy(true);
            return { success: false, error: 'Collection move is disabled or feature policy is unavailable.' };
          }
          if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
            if (!hasScopePermission(cloudConfig.activeScope, 'collection:move', workspaceMode, cloudConfig.user?.role) ||
                !canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
              return { success: false, error: 'Insufficient permission to move collection from this project' };
            }
          }

          const operation = beginAsyncOperation();
          try {
            set({ syncStatus: 'syncing', syncError: null });
            await moveScopeCollection(
              cloudConfig.apiUrl,
              cloudConfig.token,
              collectionId,
              targetScope,
              cloudConfig.refreshToken,
              operation.controller.signal
            );
            if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled' };

            // Remove from current scope
            const remainingCols = collections.filter((c) => c.id !== collectionId);
            const currentScopeKey = getScopeKey(cloudConfig.activeScope);
            const targetScopeKey = getScopeKey(targetScope);
            const updatedScopeCache = { ...(get().scopeCache || {}) };

            if (updatedScopeCache[currentScopeKey]) {
              updatedScopeCache[currentScopeKey] = {
                ...updatedScopeCache[currentScopeKey],
                collections: (updatedScopeCache[currentScopeKey].collections || []).filter((c) => c.id !== collectionId),
              };
            }

            if (updatedScopeCache[targetScopeKey]) {
              updatedScopeCache[targetScopeKey] = {
                ...updatedScopeCache[targetScopeKey],
                collections: [...(updatedScopeCache[targetScopeKey].collections || []), col],
              };
            }

            set({
              collections: remainingCols,
              scopeCache: updatedScopeCache,
              syncStatus: 'idle',
            });

            return { success: true };
          } catch (err: any) {
            if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled' };
            if (err instanceof CloudApiError && err.code === 'FEATURE_DISABLED') {
              void get().refreshFeaturePolicy(true);
            }
            set({ syncStatus: 'error', syncError: err.message || 'Failed to move collection' });
            return { success: false, error: err.message || 'Failed to move collection' };
          } finally {
            completeAsyncOperation(operation);
          }
        }
      },

      openRequestInTab: (request, initialResponse) => {
        set((state) => {
          const targetId = request.id;
          const existingTab = targetId
            ? state.tabs.find((t) => t.id === targetId)
            : undefined;

          if (existingTab) {
            const restoredResponse = state.tabResponses?.[existingTab.id] || initialResponse || null;
            const nextTabResponses = initialResponse && !state.tabResponses?.[existingTab.id]
              ? { ...(state.tabResponses || {}), [existingTab.id]: initialResponse }
              : state.tabResponses;
            return {
              activeTabId: existingTab.id,
              activeResponse: restoredResponse,
              tabResponses: nextTabResponses,
            };
          }

          const newTab: ApiRequest = {
            ...cloneRequestPreservingAttachments(request),
            id: targetId || generateId(),
          };

          const nextTabResponses = initialResponse
            ? { ...(state.tabResponses || {}), [newTab.id]: initialResponse }
            : state.tabResponses;

          return {
            tabs: [...state.tabs, newTab],
            activeTabId: newTab.id,
            activeResponse: initialResponse || null,
            tabResponses: nextTabResponses,
          };
        });
      },

      clearHistory: () => {
        set((s) => {
          const activeTabBlobUrls = new Set(
            Object.values(s.tabResponses || {})
              .map((r) => r?.blobUrl)
              .filter(Boolean)
          );
          if (s.activeResponse?.blobUrl) {
            activeTabBlobUrls.add(s.activeResponse.blobUrl);
          }
          revokeBlobUrls(s.history
            .filter((entry) => !entry.response?.blobUrl || !activeTabBlobUrls.has(entry.response.blobUrl))
            .map((entry) => entry.response?.blobUrl));
          if (s.workspaceMode === 'offline') {
            return { history: [] };
          }
          const activeScope = s.cloudConfig.activeScope;
          let updatedScopeCache = s.scopeCache;
          if (activeScope) {
            const scopeKey = getScopeKey(activeScope);
            const entry = (s.scopeCache || {})[scopeKey];
            if (entry) {
              updatedScopeCache = {
                ...(s.scopeCache || {}),
                [scopeKey]: {
                  ...entry,
                  history: [],
                },
              };
            }
          }
          return {
            history: [],
            scopeCache: updatedScopeCache,
          };
        });
      },

      deleteHistoryItem: (id) => {
        set((state) => {
          const deleted = state.history.find((item) => item.id === id);
          const isReferencedInTabs = Object.values(state.tabResponses || {}).some(
            (r) => r?.blobUrl === deleted?.response?.blobUrl
          ) || state.activeResponse?.blobUrl === deleted?.response?.blobUrl;
          if (!isReferencedInTabs) {
            revokeBlobUrl(deleted?.response?.blobUrl);
          }
          const newHistory = state.history.filter((h) => h.id !== id);
          if (state.workspaceMode === 'offline') {
            return {
              history: newHistory,
            };
          }
          const activeScope = state.cloudConfig.activeScope;
          let updatedScopeCache = state.scopeCache;
          if (activeScope) {
            const scopeKey = getScopeKey(activeScope);
            const entry = (state.scopeCache || {})[scopeKey];
            if (entry) {
              updatedScopeCache = {
                ...(state.scopeCache || {}),
                [scopeKey]: {
                  ...entry,
                  history: newHistory,
                },
              };
            }
          }
          return {
            history: newHistory,
            scopeCache: updatedScopeCache,
          };
        });
      },
    };
  },
  {
      name: 'air-rest-storage',
      storage: createJSONStorage(() => customStorage),
      partialize: (state) => {
        const persistedTabs = state.tabs.map(serializeRequestAttachments);
        const persistedCollections = state.collections.map(serializeCollectionAttachments);
        const persistedHistory = serializeHistoryAttachments(state.history);
        let syncOfflineCache = Object.fromEntries(Object.entries(state.offlineScopeCache || {}).map(([key, entry]) => [
          key,
          {
            ...entry,
            tabs: (entry.tabs || []).map(serializeRequestAttachments),
            collections: (entry.collections || []).map(serializeCollectionAttachments),
            history: serializeHistoryAttachments(entry.history || []),
          },
        ]));
        if (state.workspaceMode === 'offline' && state.activeOfflineWorkspaceId) {
          syncOfflineCache = {
            ...syncOfflineCache,
            [state.activeOfflineWorkspaceId]: {
              ...(syncOfflineCache[state.activeOfflineWorkspaceId] || {}),
              collections: persistedCollections,
              environments: state.environments,
              activeEnvironmentId: state.activeEnvironmentId,
              tabs: persistedTabs,
              activeTabId: state.activeTabId,
              history: persistedHistory,
            },
          };
        }
        let syncCloudCache = Object.fromEntries(Object.entries(state.scopeCache || {}).map(([key, entry]) => [
          key,
          {
            ...entry,
            tabs: (entry.tabs || []).map(serializeRequestAttachments),
            collections: (entry.collections || []).map(serializeCollectionAttachments),
            history: serializeHistoryAttachments(entry.history || []),
          },
        ]));
        if (state.workspaceMode === 'cloud' && state.cloudConfig.activeScope) {
          const key = getScopeKey(state.cloudConfig.activeScope);
          syncCloudCache = {
            ...syncCloudCache,
            [key]: {
              ...(syncCloudCache[key] || {}),
              collections: persistedCollections,
              environments: state.environments,
              activeEnvironmentId: state.activeEnvironmentId,
              tabs: persistedTabs,
              activeTabId: state.activeTabId,
              history: persistedHistory,
              lastSyncedAt: state.lastSyncedAt,
            },
          };
        }
        return {
          tabs: persistedTabs,
          activeTabId: state.activeTabId,
          collections: persistedCollections,
          history: persistedHistory,
          environments: state.environments,
          activeEnvironmentId: state.activeEnvironmentId,
          offlineWorkspaces: state.offlineWorkspaces,
          activeOfflineWorkspaceId: state.activeOfflineWorkspaceId,
          offlineScopeCache: syncOfflineCache,
          scopeCache: syncCloudCache,
          scopesCache: state.scopesCache,
          workspaceMode: isOfflineOnly ? 'offline' : state.workspaceMode,
          hasConfiguredMode: isOfflineOnly ? true : state.hasConfiguredMode,
          cloudConfig: state.cloudConfig,
        };
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return;

        state.tabs = (state.tabs || []).map(normalizePersistedRequestAttachments);
        state.collections = ensureUniqueCollectionItemIds((state.collections || []).map(normalizeCollectionAttachments));
        state.history = normalizeHistoryAttachments(state.history || []);
        state.offlineScopeCache = Object.fromEntries(Object.entries(state.offlineScopeCache || {}).map(([key, entry]) => [
          key,
          {
            ...entry,
            tabs: (entry.tabs || []).map(normalizePersistedRequestAttachments),
            collections: ensureUniqueCollectionItemIds((entry.collections || []).map(normalizeCollectionAttachments)),
            history: normalizeHistoryAttachments(entry.history || []),
          },
        ]));
        state.scopeCache = Object.fromEntries(Object.entries(state.scopeCache || {}).map(([key, entry]) => [
          key,
          {
            ...entry,
            tabs: (entry.tabs || []).map(normalizePersistedRequestAttachments),
            collections: ensureUniqueCollectionItemIds((entry.collections || []).map(normalizeCollectionAttachments)),
            history: normalizeHistoryAttachments(entry.history || []),
          },
        ]));

        if (state.cloudConfig?.apiUrl) {
          state.cloudConfig.apiUrl = normalizeCloudApiUrl(state.cloudConfig.apiUrl);
        }

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
      },
    }
  )
);

  const originalSetState = store.setState;
  store.setState = ((fnOrState: any, replace?: any) => {
    if (isStoreDisposed) return;
    return originalSetState(fnOrState, replace);
  }) as typeof store.setState;

  (store as ApiStore).dispose = () => {
    isStoreDisposed = true;
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
    return Reflect.apply(store as any, thisArg, argArray);
  },
});

export const useApiStore = ((...args: [any?, any?]) => {
  const contextStore = useContext(StoreContext);
  const store = resolveCurrentStore(contextStore);
  return (store as any)(...args);
}) as ApiStore;

const storeMethods = ['getState', 'setState', 'subscribe', 'destroy'] as const;
for (const method of storeMethods) {
  (useApiStore as any)[method] = (...args: any[]) => {
    const store = resolveCurrentStore();
    return (store as any)[method](...args);
  };
}
(useApiStore as any).dispose = () => {
  const store = resolveCurrentStore();
  return store.dispose?.();
};
Object.defineProperty(useApiStore, 'persist', {
  get: () => resolveCurrentStore().persist,
  configurable: true,
});
