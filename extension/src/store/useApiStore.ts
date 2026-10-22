import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { appStorage } from '@/lib/storage';
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
  OfflineWorkspace,
} from '@/types/api';
import { executeApiRequest } from '@/lib/fetcher';
import {
  importPostmanCollection,
  importPostmanEnvironment,
  detectPostmanJsonType,
} from '@/lib/postman';
import { executePreRequestScript, executePostResponseScript } from '@/lib/scriptRunner';
import { parseQueryParamsFromUrl, buildUrlWithParams } from '@/lib/urlParams';
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
  fetchUserTeams,
  fetchTeamProjects,
  fetchScopeCollections,
  fetchCollectionById,
  fetchScopeEnvironments,
} from '@/lib/cloudApi';
import { reorderItemInTree } from '@/lib/treeHelper';
import {
  buildCollectionsFromDelta,
  buildCollectionFromDetails,
  buildEnvironmentsFromDelta,
} from '@/lib/cloudSyncTransformer';
import { isOfflineOnly } from '@/lib/edition';
import {
  findSavedRequestInCollections,
  alignCollectionItemIds,
  flattenCollectionRequests,
  alignEnvironmentVariableIds,
} from '@/lib/requestDiff';

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

interface ApiStoreState {
  tabs: ApiRequest[];
  activeTabId: string;
  activeResponse: ApiResponse | null;
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
  addEnvironment: (env: Environment) => Promise<string>;
  replaceEnvironment: (existingId: string, incomingEnv: Environment) => Promise<void>;
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

  // Collections & History
  createCollection: (name: string, description?: string) => string;
  createFolder: (collectionId: string, parentFolderId: string | null, name?: string) => string;
  createRequestInCollection: (collectionId: string, folderId: string | null, name?: string) => ApiRequest;
  deleteCollectionItem: (collectionId: string, itemId: string) => void;
  saveRequestToCollection: (collectionId: string, folderId: string | null, request: ApiRequest) => void;
  saveActiveRequest: () => { success: boolean; isDirectSaved: boolean };
  addCollection: (collection: Collection) => Promise<void> | void;
  replaceCollection: (existingId: string, newCollection: Collection) => Promise<void>;
  importCollectionFromJson: (jsonStr: string) => Promise<{ success: boolean; error?: string }>;
  deleteCollection: (id: string) => void;
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
  openRequestInTab: (request: ApiRequest) => void;
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
  syncStatus: SyncStatus;
  lastSyncedAt: number | null;
  syncError: string | null;
  scopeCache?: Record<string, ScopeCacheEntry>;
  scopesCache?: ScopesCacheData;
  isSwitchingWorkspace?: boolean;

  setWorkspaceMode: (mode: WorkspaceMode) => void;
  setHasConfiguredMode: (configured: boolean) => void;
  setCloudConfig: (config: Partial<CloudConfig>) => void;
  setActiveScope: (scope: ActiveScope, forceSync?: boolean) => Promise<void>;
  fetchScopes: (force?: boolean) => Promise<void>;
  fetchProjectsForTeam: (teamId: string, force?: boolean) => Promise<CloudProject[]>;
  logoutCloud: () => void;
  setSyncStatus: (status: SyncStatus, error?: string | null) => void;
  pullCloudDelta: () => Promise<void>;
  importLocalToCloud: () => Promise<{ success: boolean; message: string }>;
}

const envSyncDebounceTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function scheduleEnvironmentCloudSync(
  envId: string,
  get: () => ApiStoreState,
  set: (fn: (state: ApiStoreState) => Partial<ApiStoreState>) => void
) {
  if (isOfflineOnly) return;

  if (envSyncDebounceTimers[envId]) {
    clearTimeout(envSyncDebounceTimers[envId]);
  }

  envSyncDebounceTimers[envId] = setTimeout(async () => {
    delete envSyncDebounceTimers[envId];

    const { workspaceMode, cloudConfig, environments } = get();
    if (workspaceMode !== 'cloud' || !cloudConfig.token) return;

    const currentEnv = environments.find((e) => e.id === envId);
    if (!currentEnv) return;

    try {
      const res = await updateScopeEnvironment(
        cloudConfig.apiUrl,
        cloudConfig.token,
        envId,
        {
          name: currentEnv.name,
          variables: currentEnv.variables,
          min_role: currentEnv.minRole,
          base_version: currentEnv.version || 1,
        },
        cloudConfig.refreshToken
      );

      if (res && typeof res.version === 'number') {
        set((s) => ({
          environments: s.environments.map((e) =>
            e.id === envId ? { ...e, version: res.version } : e
          ),
        }));
      }
    } catch (err: any) {
      if (err?.status === 409 && err?.data?.version) {
        console.warn('Environment conflict encountered, auto-recovering base version:', err.data.version);
        set((s) => ({
          environments: s.environments.map((e) =>
            e.id === envId ? { ...e, version: err.data.version } : e
          ),
        }));
        // Auto-retry once with the latest base_version from server
        try {
          const retryEnv = get().environments.find((e) => e.id === envId);
          if (retryEnv) {
            const retryRes = await updateScopeEnvironment(
              cloudConfig.apiUrl,
              cloudConfig.token,
              envId,
              {
                name: retryEnv.name,
                variables: retryEnv.variables,
                min_role: retryEnv.minRole,
                base_version: err.data.version,
              },
              cloudConfig.refreshToken
            );
            if (retryRes && typeof retryRes.version === 'number') {
              set((s) => ({
                environments: s.environments.map((e) =>
                  e.id === envId ? { ...e, version: retryRes.version } : e
                ),
              }));
              return;
            }
          }
        } catch (retryErr) {
          console.error('Failed to sync updated environment after conflict resolution:', retryErr);
        }
      } else {
        console.error('Failed to sync updated environment to cloud:', err);
      }
    }
  }, 300);
}

export const useApiStore = create<ApiStoreState>()(
  persist(
    (set, get) => ({
      tabs: [defaultRequest],
      activeTabId: defaultRequest.id,
      activeResponse: null,
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
      syncStatus: 'idle',
      lastSyncedAt: null,
      syncError: null,
      scopeCache: {},
      scopesCache: undefined,
      isSwitchingWorkspace: false,

      setWorkspaceMode: (workspaceMode) => {
        const currentMode = get().workspaceMode;
        if (currentMode === workspaceMode) return;

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
            history: restoredHistory,
            syncStatus: 'idle',
            syncError: null,
          });

          setTimeout(() => {
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
            setTimeout(() => {
              set({ isSwitchingWorkspace: false });
            }, 100);
          }
        }
      },
      setHasConfiguredMode: (hasConfiguredMode) =>
        set({
          hasConfiguredMode: isOfflineOnly ? true : hasConfiguredMode,
        }),
      setCloudConfig: (updates) =>
        set((state) => ({
          cloudConfig: { ...state.cloudConfig, ...updates },
        })),
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
          history: targetCache?.history || [],
          lastSyncedAt: targetCache?.lastSyncedAt || null,
          syncStatus: isFresh ? 'synced' : 'syncing',
          syncError: null,
        }));

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
          history: localEntry.history || [],
          scopeCache: {},
          scopesCache: undefined,
          cloudConfig: {
            apiUrl: state.cloudConfig.apiUrl || 'http://localhost:8080',
          },
          syncStatus: 'idle',
          syncError: null,
          lastSyncedAt: null,
        }));

        setTimeout(() => {
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
        set({ syncStatus: 'syncing', syncError: null });
        try {
          // For all cloud scopes (workspace & project):
          // Pull lightweight collection list (metadata only: id, name, version, updated_at),
          // then fetch each modified/new collection 1-by-1 to prevent Vercel FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE.
          const colList = await fetchScopeCollections(
            cloudConfig.apiUrl,
            cloudConfig.token,
            cloudConfig.activeScope,
            cloudConfig.refreshToken
          );

          const existingColsMap = new Map<string, Collection>(
            (get().collections || []).map((c) => [c.id, c])
          );
          const pulledCols: Collection[] = [];

          for (const colMeta of colList) {
            if (colMeta.deleted_at) continue;

            const existing = existingColsMap.get(colMeta.id);
            const serverUpdatedAt = new Date(colMeta.updated_at || 0).getTime();
            const serverVersion = colMeta.version;

            // Smart cache: If collection already exists locally and neither version nor updatedAt changed, reuse existing items
            if (
              existing &&
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
                cloudConfig.refreshToken
              );
              if (detail && !detail.deleted_at) {
                pulledCols.push(buildCollectionFromDetails(detail));
              }
            } catch (colErr) {
              console.warn(`Failed to fetch details for collection ${colMeta.id}:`, colErr);
              pulledCols.push({
                id: colMeta.id,
                name: colMeta.name,
                description: colMeta.description || '',
                items: existing?.items || [],
                version: serverVersion,
                createdAt: new Date(colMeta.created_at || Date.now()).getTime(),
                updatedAt: new Date(colMeta.updated_at || Date.now()).getTime(),
                _origin: 'cloud',
              });
            }
          }

          const envList = await fetchScopeEnvironments(
            cloudConfig.apiUrl,
            cloudConfig.token,
            cloudConfig.activeScope,
            cloudConfig.refreshToken
          );
          const pulledEnvs = buildEnvironmentsFromDelta(envList);

          const targetActiveId = pulledEnvs.some((e) => e.id === get().activeEnvironmentId)
            ? get().activeEnvironmentId
            : (pulledEnvs[0]?.id || null);

          const scopeKey = getScopeKey(cloudConfig.activeScope);
          const currentScopeCache = get().scopeCache?.[scopeKey];
          const updatedScopeCache = {
            ...(get().scopeCache || {}),
            [scopeKey]: {
              ...currentScopeCache,
              collections: pulledCols,
              environments: pulledEnvs,
              activeEnvironmentId: targetActiveId,
              lastSyncedAt: Date.now(),
              tabs: get().tabs,
              activeTabId: get().activeTabId,
              history: get().history,
            },
          };

          set({
            collections: pulledCols,
            environments: pulledEnvs,
            activeEnvironmentId: targetActiveId,
            scopeCache: updatedScopeCache,
            syncStatus: 'synced',
            lastSyncedAt: Date.now(),
            syncError: null,
          });
        } catch (err: any) {
          set({
            syncStatus: 'error',
            syncError: err.message || 'Cloud sync failed',
          });
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
        try {
          set({ syncStatus: 'syncing', syncError: null });
          await batchImportToScope(
            cloudConfig.apiUrl,
            cloudConfig.token,
            cloudConfig.activeScope,
            colsToImport,
            cloudConfig.refreshToken
          );
          await get().pullCloudDelta();
          return { success: true, message: `Successfully imported ${colsToImport.length} collection(s) to cloud` };
        } catch (err: any) {
          set({ syncStatus: 'error', syncError: err.message || 'Import failed' });
          return { success: false, message: err.message || 'Import failed' };
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

        try {
          const [wsList, teamList] = await Promise.all([
            fetchUserWorkspaces(cloudConfig.apiUrl, cloudConfig.token, cloudConfig.refreshToken).catch(() => []),
            fetchUserTeams(cloudConfig.apiUrl, cloudConfig.token, cloudConfig.refreshToken).catch(() => []),
          ]);

          const currentTeamProjects: Record<string, CloudProject[]> = {
            ...(scopesCache?.teamProjects || {}),
          };

          // Migrate legacy teamsWithProjects cache if teamProjects is empty
          if (Object.keys(currentTeamProjects).length === 0 && scopesCache?.teamsWithProjects) {
            for (const tp of scopesCache.teamsWithProjects) {
              if (tp.team?.id && tp.projects) {
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
                cloudConfig.refreshToken
              );
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
              } else if (match && match.user_role && match.user_role !== currentScope.role) {
                // Reconcile active project scope's role if updated on backend
                set((state) => ({
                  cloudConfig: {
                    ...state.cloudConfig,
                    activeScope: {
                      ...state.cloudConfig.activeScope!,
                      role: match.user_role,
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
          console.error('Failed to load scopes:', err);
        }
      },

      fetchProjectsForTeam: async (teamId: string, force = false) => {
        if (isOfflineOnly) return [];
        const { cloudConfig, scopesCache } = get();
        if (!cloudConfig.token || !teamId) return [];

        if (!force && scopesCache?.teamProjects?.[teamId]) {
          return scopesCache.teamProjects[teamId];
        }

        try {
          const projects = await fetchTeamProjects(
            cloudConfig.apiUrl,
            teamId,
            cloudConfig.token,
            cloudConfig.refreshToken
          );

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
          history: targetEntry.history || [],
          syncStatus: 'idle',
          syncError: null,
        });

        setTimeout(() => {
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

        const clonedCollections = JSON.parse(JSON.stringify(sourceData.collections || []));
        const clonedEnvironments = JSON.parse(JSON.stringify(sourceData.environments || []));
        const clonedTabs = JSON.parse(
          JSON.stringify(sourceData.tabs && sourceData.tabs.length > 0 ? sourceData.tabs : [createInitialTab()])
        );

        updatedOfflineCache[newId] = {
          collections: clonedCollections,
          environments: clonedEnvironments,
          activeEnvironmentId: sourceData.activeEnvironmentId || null,
          tabs: clonedTabs,
          activeTabId: clonedTabs[0]?.id || '',
          history: [...(sourceData.history || [])],
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
        const newEnv: Environment = {
          id: generateId(),
          name: name.trim() || 'New Environment',
          variables: [{ id: generateId(), key: '', value: '', enabled: true }],
          minRole,
          version: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set((state) => ({
          environments: [...state.environments, newEnv],
          activeEnvironmentId: newEnv.id,
        }));

        const { workspaceMode, cloudConfig } = get();
        if (workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          createScopeEnvironment(
            cloudConfig.apiUrl,
            cloudConfig.token,
            cloudConfig.activeScope,
            {
              name: newEnv.name,
              variables: newEnv.variables,
              min_role: newEnv.minRole,
            },
            cloudConfig.refreshToken
          ).then((created) => {
            if (created && created.id) {
              set((state) => ({
                environments: state.environments.map((e) =>
                  e.id === newEnv.id
                    ? { ...e, id: created.id, version: created.version || 1 }
                    : e
                ),
                activeEnvironmentId: state.activeEnvironmentId === newEnv.id ? created.id : state.activeEnvironmentId,
              }));
            }
          }).catch((err) => {
            console.error('Failed to sync created environment to cloud:', err);
          });
        }

        return newEnv.id;
      },

      deleteEnvironment: (id) => {
        if (envSyncDebounceTimers[id]) {
          clearTimeout(envSyncDebounceTimers[id]);
          delete envSyncDebounceTimers[id];
        }

        set((state) => ({
          environments: state.environments.filter((e) => e.id !== id),
          activeEnvironmentId: state.activeEnvironmentId === id ? null : state.activeEnvironmentId,
        }));

        const { workspaceMode, cloudConfig } = get();
        if (workspaceMode === 'cloud' && cloudConfig.token) {
          deleteScopeEnvironment(cloudConfig.apiUrl, cloudConfig.token, id, cloudConfig.refreshToken).catch((err) => {
            console.error('Failed to delete environment from cloud:', err);
          });
        }
      },

      updateEnvironment: (id, updates) => {
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
        set((state) => ({
          environments: state.environments.map((e) => {
            if (e.id !== envId) return e;
            return {
              ...e,
              variables: [...e.variables, { id: generateId(), key: '', value: '', enabled: true }],
              updatedAt: Date.now(),
            };
          }),
        }));

        scheduleEnvironmentCloudSync(envId, get, set);
      },

      updateEnvironmentVariable: (envId, varId, updates) => {
        set((state) => ({
          environments: state.environments.map((e) => {
            if (e.id !== envId) return e;
            return {
              ...e,
              variables: e.variables.map((v) => (v.id === varId ? { ...v, ...updates } : v)),
              updatedAt: Date.now(),
            };
          }),
        }));

        scheduleEnvironmentCloudSync(envId, get, set);
      },

      removeEnvironmentVariable: (envId, varId) => {
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

      addEnvironment: async (env: Environment) => {
        set((state) => ({
          environments: [...state.environments, env],
          activeEnvironmentId: env.id,
        }));

        const { workspaceMode, cloudConfig } = get();
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          try {
            const created = await createScopeEnvironment(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              {
                name: env.name,
                variables: env.variables,
                min_role: env.minRole || 'reader',
              },
              cloudConfig.refreshToken
            );
            if (created && created.id) {
              set((state) => ({
                environments: state.environments.map((e) =>
                  e.id === env.id ? { ...e, id: created.id, version: created.version || 1 } : e
                ),
                activeEnvironmentId: state.activeEnvironmentId === env.id ? created.id : state.activeEnvironmentId,
              }));
              return created.id;
            }
          } catch (err: any) {
            console.error('Failed to sync environment to cloud:', err);
          }
        }
        return env.id;
      },

      replaceEnvironment: async (existingId: string, incomingEnv: Environment) => {
        if (envSyncDebounceTimers[existingId]) {
          clearTimeout(envSyncDebounceTimers[existingId]);
          delete envSyncDebounceTimers[existingId];
        }

        const state = get();
        const existingEnv = state.environments.find((e) => e.id === existingId);
        if (!existingEnv) {
          throw new Error('Existing environment not found');
        }

        const alignedVars = alignEnvironmentVariableIds(existingEnv.variables || [], incomingEnv.variables || []);

        const replacedEnv: Environment = {
          ...incomingEnv,
          id: existingId,
          name: incomingEnv.name,
          variables: alignedVars,
          minRole: incomingEnv.minRole || existingEnv.minRole,
          version: existingEnv.version || 1,
          updatedAt: Date.now(),
        };

        set((s) => ({
          environments: s.environments.map((e) => (e.id === existingId ? replacedEnv : e)),
          activeEnvironmentId: existingId,
        }));

        const { workspaceMode, cloudConfig } = get();
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          try {
            const res = await updateScopeEnvironment(
              cloudConfig.apiUrl,
              cloudConfig.token,
              existingId,
              {
                name: replacedEnv.name,
                variables: replacedEnv.variables,
                min_role: replacedEnv.minRole,
                base_version: replacedEnv.version || 1,
              },
              cloudConfig.refreshToken
            );
            if (res && typeof res.version === 'number') {
              set((s) => ({
                environments: s.environments.map((e) =>
                  e.id === existingId ? { ...e, version: res.version } : e
                ),
              }));
            }
          } catch (err: any) {
            if (err?.status === 409 && err?.data?.version) {
              console.warn('Conflict while replacing environment, retrying with server version:', err.data.version);
              const retryRes = await updateScopeEnvironment(
                cloudConfig.apiUrl,
                cloudConfig.token,
                existingId,
                {
                  name: replacedEnv.name,
                  variables: replacedEnv.variables,
                  min_role: replacedEnv.minRole,
                  base_version: err.data.version,
                },
                cloudConfig.refreshToken
              );
              if (retryRes && typeof retryRes.version === 'number') {
                set((s) => ({
                  environments: s.environments.map((e) =>
                    e.id === existingId ? { ...e, version: retryRes.version } : e
                  ),
                }));
                return;
              }
            }
            console.error('Failed to sync replaced environment to cloud:', err);
            throw err;
          }
        }
      },

      setSidebarTab: (sidebarTab) => set({ sidebarTab }),

      setActiveTabId: (activeTabId) => {
        set({ activeTabId, activeResponse: null });
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
          if (state.tabs.length <= 1) {
            const resetTab = createInitialTab();
            return { tabs: [resetTab], activeTabId: resetTab.id, activeResponse: null };
          }

          const filteredTabs = state.tabs.filter((t) => t.id !== id);
          let newActiveId = state.activeTabId;
          if (state.activeTabId === id) {
            const closingIndex = state.tabs.findIndex((t) => t.id === id);
            const nextTab = state.tabs[closingIndex + 1] || state.tabs[closingIndex - 1];
            newActiveId = nextTab.id;
          }

          return {
            tabs: filteredTabs,
            activeTabId: newActiveId,
            activeResponse: null,
          };
        });
      },

      closeOtherTabs: (id) => {
        set((state) => {
          const targetTab = state.tabs.find((t) => t.id === id);
          if (!targetTab) return state;
          return {
            tabs: [targetTab],
            activeTabId: id,
            activeResponse: state.activeTabId === id ? state.activeResponse : null,
          };
        });
      },

      closeAllTabs: () => {
        set(() => {
          const resetTab: ApiRequest = {
            id: generateId(),
            name: 'New Request',
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
            bodyBinaryFile: undefined,
            bodyUrlEncoded: [{ id: generateId(), key: '', value: '', enabled: true }],
            preRequestScript: '',
            postResponseScript: '',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          return {
            tabs: [resetTab],
            activeTabId: resetTab.id,
            activeResponse: null,
          };
        });
      },

      closeTabsToRight: (id) => {
        set((state) => {
          const index = state.tabs.findIndex((t) => t.id === id);
          if (index === -1) return state;
          const remainingTabs = state.tabs.slice(0, index + 1);
          const wasActiveClosed = !remainingTabs.some((t) => t.id === state.activeTabId);
          return {
            tabs: remainingTabs,
            activeTabId: wasActiveClosed ? id : state.activeTabId,
            activeResponse: wasActiveClosed ? null : state.activeResponse,
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
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.id !== state.activeTabId) return tab;
            if (updates.url !== undefined && updates.params === undefined && updates.url !== tab.url) {
              const syncedParams = parseQueryParamsFromUrl(updates.url, tab.params);
              return { ...tab, ...updates, params: syncedParams, updatedAt: Date.now() };
            }
            return { ...tab, ...updates, updatedAt: Date.now() };
          }),
        }));
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

        set({ isLoading: true, activeResponse: null });

        try {
          // 1. Collect current active environment variables
          const activeEnv = state.environments.find((e) => e.id === state.activeEnvironmentId);
          const envVarsMap: Record<string, string> = {};
          if (activeEnv) {
            activeEnv.variables.forEach((v) => {
              if (v.enabled && v.key.trim() !== '') {
                envVarsMap[v.key.trim()] = v.value;
              }
            });
          }

          // 2. Execute Pre-request Script (if present)
          const scriptResult = await executePreRequestScript(
            activeReq.preRequestScript || '',
            envVarsMap,
            {}
          );

          // Update environment with any modifications made by pm.environment.set()
          if (scriptResult.success && activeEnv) {
            const updatedVariables = [...activeEnv.variables];
            Object.entries(scriptResult.environment).forEach(([key, val]) => {
              const existingIdx = updatedVariables.findIndex((v) => v.key.trim() === key);
              if (existingIdx >= 0) {
                updatedVariables[existingIdx].value = val;
              } else {
                updatedVariables.push({ id: generateId(), key, value: val, enabled: true });
              }
            });

            state.updateEnvironment(activeEnv.id, { variables: updatedVariables });
          }

          // Merge environment variables and script runtime variables
          const finalVariables = {
            ...scriptResult.environment,
            ...scriptResult.variables,
          };

          // 3. Dispatch API request with interpolated variables
          const response = await executeApiRequest(activeReq, finalVariables);

          // 4. Execute Post-response script (tests, token extraction)
          let scriptError: string | undefined;
          const updatedKeys: string[] = [];

          if (activeReq.postResponseScript && activeReq.postResponseScript.trim()) {
            const postScriptResult = await executePostResponseScript(
              activeReq.postResponseScript,
              response,
              finalVariables,
              scriptResult.variables
            );

            if (postScriptResult.success && activeEnv) {
              const updatedVariables = [...activeEnv.variables];
              Object.entries(postScriptResult.environment).forEach(([key, val]) => {
                const existingIdx = updatedVariables.findIndex((v) => v.key.trim() === key);
                if (existingIdx >= 0) {
                  if (updatedVariables[existingIdx].value !== val) {
                    updatedKeys.push(key);
                  }
                  updatedVariables[existingIdx] = {
                    ...updatedVariables[existingIdx],
                    value: val,
                  };
                } else {
                  updatedKeys.push(key);
                  updatedVariables.push({
                    id: generateId(),
                    key,
                    value: val,
                    enabled: true,
                  });
                }
              });

              state.updateEnvironment(activeEnv.id, { variables: updatedVariables });
            } else if (!postScriptResult.success && postScriptResult.error) {
              scriptError = postScriptResult.error;
            }
          }

          const finalResponse: ApiResponse = {
            ...response,
            scriptError,
            updatedEnvVars: updatedKeys.length > 0 ? updatedKeys : undefined,
          };

          const historyEntry: HistoryItem = {
            id: generateId(),
            request: JSON.parse(JSON.stringify(activeReq)),
            response: finalResponse,
            timestamp: Date.now(),
          };

          set((s) => {
            const newHistory = [historyEntry, ...s.history].slice(0, 50);
            if (s.workspaceMode === 'offline') {
              return {
                activeResponse: finalResponse,
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
              isLoading: false,
              history: newHistory,
              scopeCache: updatedScopeCache,
            };
          });
        } catch (err: unknown) {
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

          set({ activeResponse: fallbackResponse, isLoading: false });
        }
      },

      createCollection: (name, description = '') => {
        const newCol: Collection = {
          id: generateId(),
          name: name.trim() || 'New Collection',
          description: description.trim(),
          items: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          _origin: get().workspaceMode === 'offline' ? 'offline' : 'cloud',
        };
        set((state) => ({
          collections: [newCol, ...state.collections],
        }));

        const { workspaceMode, cloudConfig } = get();
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          batchImportToScope(
            cloudConfig.apiUrl,
            cloudConfig.token,
            cloudConfig.activeScope,
            [newCol],
            cloudConfig.refreshToken
          ).catch((err) => {
            console.error('Failed to sync created collection to cloud:', err);
          });
        }

        return newCol.id;
      },

      createFolder: (collectionId, parentFolderId, name) => {
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

        const { workspaceMode, cloudConfig, collections } = get();
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          const updatedCol = collections.find((c) => c.id === collectionId);
          if (updatedCol) {
            batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              [updatedCol],
              cloudConfig.refreshToken
            ).catch((err) => console.error('Failed to sync created folder to cloud:', err));
          }
        }

        return newFolderId;
      },

      createRequestInCollection: (collectionId, folderId, name) => {
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

        const { workspaceMode, cloudConfig, collections } = get();
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          const updatedCol = collections.find((c) => c.id === collectionId);
          if (updatedCol) {
            batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              [updatedCol],
              cloudConfig.refreshToken
            ).catch((err) => console.error('Failed to sync created request to cloud:', err));
          }
        }

        return newReq;
      },

      deleteCollectionItem: (collectionId, itemId) => {
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

        const { workspaceMode, cloudConfig, collections } = get();
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          deleteScopeItem(
            cloudConfig.apiUrl,
            cloudConfig.token,
            itemId,
            cloudConfig.refreshToken
          ).catch((err) => console.error('Failed to delete item from cloud:', err));

          const updatedCol = collections.find((c) => c.id === collectionId);
          if (updatedCol) {
            batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              [updatedCol],
              cloudConfig.refreshToken
            ).catch((err) => console.error('Failed to sync item deletion to cloud:', err));
          }
        }
      },

      saveRequestToCollection: (collectionId, folderId, request) => {
        let assignedReqId = request.id;

        set((state) => {
          const cleanReq: ApiRequest = JSON.parse(JSON.stringify(request));

          const insertOrUpdateInList = (items: CollectionItem[]): CollectionItem[] => {
            const existingIdx = items.findIndex(
              (item) => item.type === 'request' && (item.id === cleanReq.id || item.request?.id === cleanReq.id || item.name === cleanReq.name)
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
            if (tab.id === request.id || tab.name === request.name) {
              return { ...tab, id: assignedReqId, name: cleanReq.name };
            }
            return tab;
          });

          return {
            collections,
            tabs,
          };
        });

        const { workspaceMode, cloudConfig, collections } = get();
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          const updatedCol = collections.find((c) => c.id === collectionId);
          if (updatedCol) {
            batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              [updatedCol],
              cloudConfig.refreshToken
            ).catch((err) => console.error('Failed to sync updated collection item to cloud:', err));
          }
        }
      },

      saveActiveRequest: () => {
        const { tabs, activeTabId, collections, saveRequestToCollection } = get();
        const currentTab = tabs.find((t) => t.id === activeTabId);
        if (!currentTab) return { success: false, isDirectSaved: false };

        const saved = findSavedRequestInCollections(collections, currentTab.id);
        if (saved) {
          saveRequestToCollection(saved.collection.id, saved.folderId, currentTab);
          return { success: true, isDirectSaved: true };
        }

        return { success: false, isDirectSaved: false };
      },

      addCollection: async (collection) => {
        const taggedCol: Collection = {
          ...collection,
          _origin: get().workspaceMode === 'offline' ? 'offline' : 'cloud',
        };
        set((state) => ({
          collections: [taggedCol, ...state.collections],
        }));

        const { workspaceMode, cloudConfig } = get();
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          try {
            set({ syncStatus: 'syncing', syncError: null });
            await batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              [collection],
              cloudConfig.refreshToken
            );
            await get().pullCloudDelta();
          } catch (err: any) {
            set({ syncStatus: 'error', syncError: err.message || 'Failed to sync collection to cloud' });
          }
        }
      },

      replaceCollection: async (existingId: string, newCollection: Collection) => {
        const state = get();
        const existingCol = state.collections.find((c) => c.id === existingId);
        if (!existingCol) {
          throw new Error('Existing collection not found');
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
          try {
            set({ syncStatus: 'syncing', syncError: null });

            for (const remId of removedItemIds) {
              await deleteScopeItem(
                cloudConfig.apiUrl,
                cloudConfig.token,
                remId,
                cloudConfig.refreshToken
              ).catch((err) => console.error('Failed to delete removed item from cloud:', err));
            }

            await batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              [replacedCol],
              cloudConfig.refreshToken
            );
            await get().pullCloudDelta();
          } catch (err: any) {
            set({ syncStatus: 'error', syncError: err.message || 'Failed to sync replaced collection' });
          }
        }
      },

      importEnvironmentFromJson: (jsonStr) => {
        try {
          const imported = importPostmanEnvironment(jsonStr);
          set((state) => ({
            environments: [...state.environments, imported],
            activeEnvironmentId: imported.id,
          }));

          const { workspaceMode, cloudConfig } = get();
          if (workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
            createScopeEnvironment(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              {
                name: imported.name,
                variables: imported.variables,
                min_role: imported.minRole || 'reader',
              },
              cloudConfig.refreshToken
            ).then((created) => {
              if (created?.id) {
                set((state) => ({
                  environments: state.environments.map((e) =>
                    e.id === imported.id ? { ...e, id: created.id, version: created.version || 1 } : e
                  ),
                  activeEnvironmentId: state.activeEnvironmentId === imported.id ? created.id : state.activeEnvironmentId,
                }));
              }
            }).catch((err) => {
              console.error('Failed to sync imported environment to cloud:', err);
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
          const detected = detectPostmanJsonType(jsonStr);
          if (detected === 'environment') {
            const res = get().importEnvironmentFromJson(jsonStr);
            if (res.success && res.environment) {
              return { success: true, type: 'environment', name: res.environment.name };
            }
            return { success: false, error: res.error };
          } else {
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
          if (detectPostmanJsonType(jsonStr) === 'environment') {
            const envRes = get().importEnvironmentFromJson(jsonStr);
            if (envRes.success) {
              return { success: true };
            }
            return { success: false, error: envRes.error };
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

      deleteCollection: (id) => {
        set((state) => ({
          collections: state.collections.filter((c) => c.id !== id),
        }));

        const { workspaceMode, cloudConfig } = get();
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token) {
          deleteScopeCollection(cloudConfig.apiUrl, cloudConfig.token, id, cloudConfig.refreshToken).catch((err) => {
            console.error('Failed to delete collection from cloud:', err);
          });
        }
      },

      moveRequest: async (sourceCollectionId, requestId, targetCollectionId, targetFolderId) => {
        const { collections } = get();
        const sourceCol = collections.find((c) => c.id === sourceCollectionId);
        const targetCol = collections.find((c) => c.id === targetCollectionId);

        if (!sourceCol) {
          return { success: false, error: 'Source collection not found' };
        }
        if (!targetCol) {
          return { success: false, error: 'Target collection not found' };
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
        const { workspaceMode, cloudConfig, collections: currentCols } = get();
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          const colsToSync = currentCols.filter(
            (c) => c.id === sourceCollectionId || c.id === targetCollectionId
          );
          if (colsToSync.length > 0) {
            batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              colsToSync,
              cloudConfig.refreshToken
            )
              .then(() => {
                if (get().syncStatus === 'error') {
                  set({ syncStatus: 'idle', syncError: null });
                }
              })
              .catch((err) => {
                console.error('Failed to sync moved request to cloud:', err);
                set({ syncStatus: 'error', syncError: err.message || 'Failed to sync moved request to cloud' });
              });
          }
        }

        return { success: true };
      },

      reorderItem: async (collectionId, activeId, targetId, position) => {
        const { collections } = get();
        const col = collections.find((c) => c.id === collectionId);
        if (!col) return { success: false, error: 'Collection not found' };

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

        const { workspaceMode, cloudConfig } = get();
        const token = cloudConfig.token;
        if (!isOfflineOnly && workspaceMode === 'cloud' && token) {
          const sendReorder = async () => {
            try {
              await reorderCollectionItems(
                cloudConfig.apiUrl,
                token,
                collectionId,
                payload,
                cloudConfig.refreshToken
              );
              if (get().syncStatus === 'error') {
                set({ syncStatus: 'idle', syncError: null });
              }
            } catch (err: any) {
              // Retry once after 250ms for transient race condition or network glitch
              await new Promise((r) => setTimeout(r, 250));
              try {
                await reorderCollectionItems(
                  cloudConfig.apiUrl,
                  token,
                  collectionId,
                  payload,
                  cloudConfig.refreshToken
                );
                if (get().syncStatus === 'error') {
                  set({ syncStatus: 'idle', syncError: null });
                }
              } catch (retryErr: any) {
                console.error('Failed to sync reordered items to cloud:', retryErr);
                set({ syncStatus: 'error', syncError: retryErr.message || 'Failed to sync reordered items to cloud' });
              }
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

          try {
            set({ syncStatus: 'syncing', syncError: null });
            await batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              targetScope,
              [col],
              cloudConfig.refreshToken
            );

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
            set({ syncStatus: 'error', syncError: err.message || 'Failed to move collection' });
            return { success: false, error: err.message || 'Failed to move collection' };
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

          try {
            set({ syncStatus: 'syncing', syncError: null });
            await moveScopeCollection(
              cloudConfig.apiUrl,
              cloudConfig.token,
              collectionId,
              targetScope,
              cloudConfig.refreshToken
            );

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
            set({ syncStatus: 'error', syncError: err.message || 'Failed to move collection' });
            return { success: false, error: err.message || 'Failed to move collection' };
          }
        }
      },

      openRequestInTab: (request) => {
        set((state) => {
          const existingTab = state.tabs.find(
            (t) => t.id === request.id || (t.name === request.name && t.url === request.url && t.method === request.method)
          );
          if (existingTab) {
            return {
              activeTabId: existingTab.id,
              activeResponse: null,
            };
          }

          const newTab: ApiRequest = {
            ...JSON.parse(JSON.stringify(request)),
            id: request.id || generateId(),
          };

          return {
            tabs: [...state.tabs, newTab],
            activeTabId: newTab.id,
            activeResponse: null,
          };
        });
      },

      clearHistory: () => {
        set((s) => {
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
    }),
    {
      name: 'air-rest-storage',
      storage: createJSONStorage(() => appStorage),
      partialize: (state) => {
        let syncOfflineCache = state.offlineScopeCache || {};
        if (state.workspaceMode === 'offline' && state.activeOfflineWorkspaceId) {
          syncOfflineCache = {
            ...syncOfflineCache,
            [state.activeOfflineWorkspaceId]: {
              ...(syncOfflineCache[state.activeOfflineWorkspaceId] || {}),
              collections: state.collections,
              environments: state.environments,
              activeEnvironmentId: state.activeEnvironmentId,
              tabs: state.tabs,
              activeTabId: state.activeTabId,
              history: state.history,
            },
          };
        }
        let syncCloudCache = state.scopeCache || {};
        if (state.workspaceMode === 'cloud' && state.cloudConfig.activeScope) {
          const key = getScopeKey(state.cloudConfig.activeScope);
          syncCloudCache = {
            ...syncCloudCache,
            [key]: {
              ...(syncCloudCache[key] || {}),
              collections: state.collections,
              environments: state.environments,
              activeEnvironmentId: state.activeEnvironmentId,
              tabs: state.tabs,
              activeTabId: state.activeTabId,
              history: state.history,
              lastSyncedAt: state.lastSyncedAt,
            },
          };
        }
        return {
          tabs: state.tabs,
          activeTabId: state.activeTabId,
          collections: state.collections,
          history: state.history,
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

        // 5. Ensure state always has at least one valid tab and a valid activeTabId
        if (!state.tabs || !Array.isArray(state.tabs) || state.tabs.length === 0) {
          const initialTab = createInitialTab();
          state.tabs = [initialTab];
          state.activeTabId = initialTab.id;
        } else if (!state.activeTabId || !state.tabs.some((t) => t.id === state.activeTabId)) {
          state.activeTabId = state.tabs[0].id;
        }
      },
    }
  )
);

// Register silent background refresh listener to keep cloudConfig tokens up to date
if (!isOfflineOnly) {
  registerTokenRefreshCallback((newTokens) => {
    useApiStore.getState().setCloudConfig({
      token: newTokens.token,
      refreshToken: newTokens.refreshToken,
      tokenExpiresAt: newTokens.expiresAt,
    });
  });

  registerAuthEvictedCallback((reason) => {
    const state = useApiStore.getState();
    if (state.workspaceMode === 'cloud') {
      state.logoutCloud();
      setTimeout(() => {
        useApiStore.setState({ syncError: reason });
      }, 300);
    }
  });
}
