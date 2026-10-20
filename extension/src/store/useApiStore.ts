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
  pullScopeDelta,
  batchImportToScope,
  registerTokenRefreshCallback,
  createScopeEnvironment,
  updateScopeEnvironment,
  deleteScopeEnvironment,
  deleteScopeCollection,
  deleteScopeItem,
  moveScopeCollection,
  fetchUserWorkspaces,
  fetchUserTeams,
  fetchTeamProjects,
} from '@/lib/cloudApi';
import {
  buildCollectionsFromDelta,
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

const defaultEnvironments: Environment[] = [
  {
    id: 'env-localhost',
    name: 'Localhost',
    variables: [
      { id: 'v1', key: 'baseUrl', value: 'http://localhost:3000', enabled: true },
      { id: 'v2', key: 'port', value: '3000', enabled: true },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'env-jsonplaceholder',
    name: 'JSONPlaceholder',
    variables: [
      { id: 'v3', key: 'baseUrl', value: 'https://jsonplaceholder.typicode.com', enabled: true },
      { id: 'v4', key: 'userId', value: '1', enabled: true },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

const defaultRequest: ApiRequest = {
  id: 'req-default-1',
  name: 'Sample GET Request',
  method: 'GET',
  url: '{{baseUrl}}/todos/{{userId}}',
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
  preRequestScript: '// Example Pre-request Script:\n// pm.environment.set("timestamp", Date.now());\n// console.log("Request starting...");\n',
  postResponseScript: '// Example Tests / Post-response Script:\n// const data = pm.response.json();\n// if (data.token) pm.environment.set("token", data.token);\n',
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

export const SCOPE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache for workspace collections/environments
export const SCOPES_LIST_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache for workspace/project list

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
  saveRequestToCollection: (collectionId: string, folderId: string | null, request: ApiRequest) => void;
  saveActiveRequest: () => { success: boolean; isDirectSaved: boolean };
  addCollection: (collection: Collection) => Promise<void> | void;
  replaceCollection: (existingId: string, newCollection: Collection) => Promise<void>;
  importCollectionFromJson: (jsonStr: string) => Promise<{ success: boolean; error?: string }>;
  deleteCollection: (id: string) => void;
  moveCollection: (collectionId: string, targetScope: ActiveScope) => Promise<{ success: boolean; error?: string }>;
  openRequestInTab: (request: ApiRequest) => void;
  clearHistory: () => void;
  deleteHistoryItem: (id: string) => void;

  // Workspace Mode & Cloud Synchronization
  workspaceMode: WorkspaceMode;
  hasConfiguredMode: boolean;
  cloudConfig: CloudConfig;
  syncStatus: SyncStatus;
  lastSyncedAt: number | null;
  syncError: string | null;
  offlineCollections?: Collection[];
  offlineEnvironments?: Environment[];
  offlineActiveEnvironmentId?: string | null;
  offlineTabs?: ApiRequest[];
  offlineActiveTabId?: string;
  offlineHistory?: HistoryItem[];
  scopeCache?: Record<string, ScopeCacheEntry>;
  scopesCache?: ScopesCacheData;
  isSwitchingWorkspace?: boolean;

  setWorkspaceMode: (mode: WorkspaceMode) => void;
  setHasConfiguredMode: (configured: boolean) => void;
  setCloudConfig: (config: Partial<CloudConfig>) => void;
  setActiveScope: (scope: ActiveScope, forceSync?: boolean) => Promise<void>;
  fetchScopes: (force?: boolean) => Promise<void>;
  logoutCloud: () => void;
  setSyncStatus: (status: SyncStatus, error?: string | null) => void;
  pullCloudDelta: () => Promise<void>;
  importLocalToCloud: () => Promise<{ success: boolean; message: string }>;
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
      environments: defaultEnvironments,
      activeEnvironmentId: 'env-jsonplaceholder',

      // Workspace Mode & Cloud Sync State
      workspaceMode: 'offline',
      hasConfiguredMode: isOfflineOnly ? true : false,
      cloudConfig: {
        apiUrl: 'http://localhost:8080',
      },
      syncStatus: 'idle',
      lastSyncedAt: null,
      syncError: null,
      offlineCollections: [],
      offlineEnvironments: defaultEnvironments,
      offlineActiveEnvironmentId: 'env-jsonplaceholder',
      offlineTabs: [defaultRequest],
      offlineActiveTabId: defaultRequest.id,
      offlineHistory: [],
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

          const {
            offlineCollections,
            offlineEnvironments,
            offlineActiveEnvironmentId,
            offlineTabs,
            offlineActiveTabId,
            offlineHistory,
          } = get();

          const restoredTabs =
            offlineTabs && offlineTabs.length > 0
              ? offlineTabs
              : [createInitialTab()];
          const restoredActiveTabId =
            offlineActiveTabId && restoredTabs.some((t) => t.id === offlineActiveTabId)
              ? offlineActiveTabId
              : restoredTabs[0].id;

          set({
            workspaceMode: 'offline',
            hasConfiguredMode: true,
            scopeCache: updatedScopeCache,
            collections: offlineCollections || [],
            environments: (offlineEnvironments && offlineEnvironments.length > 0) ? offlineEnvironments : defaultEnvironments,
            activeEnvironmentId: offlineActiveEnvironmentId || defaultEnvironments[0]?.id || null,
            tabs: restoredTabs,
            activeTabId: restoredActiveTabId,
            activeResponse: null,
            history: offlineHistory || [],
            syncStatus: 'idle',
            syncError: null,
          });

          setTimeout(() => {
            set({ isSwitchingWorkspace: false });
          }, 250);
        } else {
          // Entering cloud mode: snapshot current offline state only if we were actually in offline mode
          const isCurrentlyOffline = get().workspaceMode === 'offline';
          const { collections, environments, activeEnvironmentId, cloudConfig, scopeCache, tabs, activeTabId, history } = get();
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
            offlineCollections: isCurrentlyOffline ? collections : (get().offlineCollections || []),
            offlineEnvironments: isCurrentlyOffline ? environments : (get().offlineEnvironments || defaultEnvironments),
            offlineActiveEnvironmentId: isCurrentlyOffline ? activeEnvironmentId : (get().offlineActiveEnvironmentId || null),
            offlineTabs: isCurrentlyOffline ? tabs : (get().offlineTabs || [createInitialTab()]),
            offlineActiveTabId: isCurrentlyOffline ? activeTabId : (get().offlineActiveTabId || ''),
            offlineHistory: isCurrentlyOffline ? history : (get().offlineHistory || []),
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
          set({
            offlineCollections: collections,
            offlineEnvironments: environments,
            offlineActiveEnvironmentId: activeEnvironmentId,
            offlineTabs: tabs,
            offlineActiveTabId: activeTabId,
            offlineHistory: history,
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
        const { offlineCollections, offlineEnvironments, offlineActiveEnvironmentId, offlineTabs, offlineActiveTabId, offlineHistory, scopeCache } = get();

        // 1. Collect all collection IDs belonging to any cloud scope or currently loaded in cloud mode
        const cloudColIds = new Set<string>();
        if (scopeCache) {
          for (const entry of Object.values(scopeCache)) {
            if (entry.collections) {
              for (const c of entry.collections) {
                cloudColIds.add(c.id);
              }
            }
          }
        }
        if (get().workspaceMode === 'cloud' && get().collections) {
          for (const c of get().collections) {
            cloudColIds.add(c.id);
          }
        }

        // 2. Filter out any cloud-specific collections that leaked into offlineCollections
        const pureOfflineCollections = (offlineCollections || []).filter(
          (c) => c._origin === 'offline' || (!cloudColIds.has(c.id) && c._origin !== 'cloud')
        );

        const restoredTabs =
          offlineTabs && offlineTabs.length > 0
            ? offlineTabs
            : [createInitialTab()];
        const restoredActiveTabId =
          offlineActiveTabId && restoredTabs.some((t) => t.id === offlineActiveTabId)
            ? offlineActiveTabId
            : restoredTabs[0].id;

        set((state) => ({
          workspaceMode: 'offline',
          collections: pureOfflineCollections,
          offlineCollections: pureOfflineCollections,
          environments: (offlineEnvironments && offlineEnvironments.length > 0) ? offlineEnvironments : defaultEnvironments,
          activeEnvironmentId: offlineActiveEnvironmentId || defaultEnvironments[0]?.id || null,
          tabs: restoredTabs,
          activeTabId: restoredActiveTabId,
          activeResponse: null,
          history: offlineHistory || [],
          offlineHistory: offlineHistory || [],
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
          const delta = await pullScopeDelta(
            cloudConfig.apiUrl,
            cloudConfig.token,
            cloudConfig.activeScope,
            null,
            cloudConfig.refreshToken
          );
          const pulledCols = buildCollectionsFromDelta(delta.collections, delta.items);
          const pulledEnvs = buildEnvironmentsFromDelta(delta.environments);

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
        const { cloudConfig, offlineCollections, collections } = get();
        const colsToImport = (offlineCollections && offlineCollections.length > 0)
          ? offlineCollections
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
          (scopesCache.workspaces.length > 0 || scopesCache.teamsWithProjects.length > 0)
        );

        if (isFresh) {
          return;
        }

        try {
          const [wsList, teamList] = await Promise.all([
            fetchUserWorkspaces(cloudConfig.apiUrl, cloudConfig.token, cloudConfig.refreshToken).catch(() => []),
            fetchUserTeams(cloudConfig.apiUrl, cloudConfig.token, cloudConfig.refreshToken).catch(() => []),
          ]);

          const teamProjects = await Promise.all(
            teamList.map(async (t) => {
              const projs = await fetchTeamProjects(
                cloudConfig.apiUrl,
                t.id,
                cloudConfig.token!,
                cloudConfig.refreshToken
              ).catch(() => []);
              return { team: t, projects: projs };
            })
          );

          set({
            scopesCache: {
              workspaces: wsList,
              teamsWithProjects: teamProjects,
              lastFetchedAt: Date.now(),
            },
          });

          // Reconcile active project scope's role if updated on backend
          const currentScope = get().cloudConfig.activeScope;
          if (currentScope?.type === 'project' && currentScope.id) {
            for (const tp of teamProjects) {
              const match = tp.projects.find((p) => p.id === currentScope.id);
              if (match && match.user_role && match.user_role !== currentScope.role) {
                set((state) => ({
                  cloudConfig: {
                    ...state.cloudConfig,
                    activeScope: {
                      ...state.cloudConfig.activeScope!,
                      role: match.user_role,
                    },
                  },
                }));
                break;
              }
            }
          }
        } catch (err) {
          console.error('Failed to load scopes:', err);
        }
      },

      // Environment actions
      setActiveEnvironmentId: (activeEnvironmentId) =>
        set((state) => ({
          activeEnvironmentId,
          offlineActiveEnvironmentId: state.workspaceMode === 'offline' ? activeEnvironmentId : state.offlineActiveEnvironmentId,
        })),

      createEnvironment: (name, minRole = 'reader') => {
        const newEnv: Environment = {
          id: generateId(),
          name: name.trim() || 'New Environment',
          variables: [{ id: generateId(), key: '', value: '', enabled: true }],
          minRole,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set((state) => ({
          environments: [...state.environments, newEnv],
          activeEnvironmentId: newEnv.id,
          offlineEnvironments: state.workspaceMode === 'offline'
            ? [...(state.offlineEnvironments || defaultEnvironments), newEnv]
            : state.offlineEnvironments,
          offlineActiveEnvironmentId: state.workspaceMode === 'offline'
            ? newEnv.id
            : state.offlineActiveEnvironmentId,
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
                environments: state.environments.map((e) => (e.id === newEnv.id ? { ...e, id: created.id } : e)),
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
        set((state) => ({
          environments: state.environments.filter((e) => e.id !== id),
          activeEnvironmentId: state.activeEnvironmentId === id ? null : state.activeEnvironmentId,
          offlineEnvironments: state.workspaceMode === 'offline'
            ? (state.offlineEnvironments || defaultEnvironments).filter((e) => e.id !== id)
            : state.offlineEnvironments,
          offlineActiveEnvironmentId: state.workspaceMode === 'offline' && state.offlineActiveEnvironmentId === id
            ? null
            : state.offlineActiveEnvironmentId,
        }));

        const { workspaceMode, cloudConfig } = get();
        if (workspaceMode === 'cloud' && cloudConfig.token) {
          deleteScopeEnvironment(cloudConfig.apiUrl, cloudConfig.token, id, cloudConfig.refreshToken).catch((err) => {
            console.error('Failed to delete environment from cloud:', err);
          });
        }
      },

      updateEnvironment: (id, updates) => {
        let updatedEnv: Environment | undefined;
        set((state) => {
          const updatedEnvs = state.environments.map((e) => {
            if (e.id === id) {
              updatedEnv = { ...e, ...updates, updatedAt: Date.now() };
              return updatedEnv;
            }
            return e;
          });
          return {
            environments: updatedEnvs,
            offlineEnvironments: state.workspaceMode === 'offline' ? updatedEnvs : state.offlineEnvironments,
          };
        });

        const { workspaceMode, cloudConfig } = get();
        if (workspaceMode === 'cloud' && cloudConfig.token && updatedEnv) {
          updateScopeEnvironment(
            cloudConfig.apiUrl,
            cloudConfig.token,
            id,
            {
              name: updatedEnv.name,
              variables: updatedEnv.variables,
              min_role: updatedEnv.minRole,
            },
            cloudConfig.refreshToken
          ).catch((err) => {
            console.error('Failed to sync updated environment to cloud:', err);
          });
        }
      },

      addEnvironmentVariable: (envId) => {
        let updatedEnv: Environment | undefined;
        set((state) => {
          const updatedEnvs = state.environments.map((e) => {
            if (e.id !== envId) return e;
            updatedEnv = {
              ...e,
              variables: [...e.variables, { id: generateId(), key: '', value: '', enabled: true }],
              updatedAt: Date.now(),
            };
            return updatedEnv;
          });
          return {
            environments: updatedEnvs,
            offlineEnvironments: state.workspaceMode === 'offline' ? updatedEnvs : state.offlineEnvironments,
          };
        });

        const { workspaceMode, cloudConfig } = get();
        if (workspaceMode === 'cloud' && cloudConfig.token && updatedEnv) {
          updateScopeEnvironment(
            cloudConfig.apiUrl,
            cloudConfig.token,
            envId,
            {
              name: updatedEnv.name,
              variables: updatedEnv.variables,
              min_role: updatedEnv.minRole,
            },
            cloudConfig.refreshToken
          ).catch(() => {});
        }
      },

      updateEnvironmentVariable: (envId, varId, updates) => {
        let updatedEnv: Environment | undefined;
        set((state) => {
          const updatedEnvs = state.environments.map((e) => {
            if (e.id !== envId) return e;
            updatedEnv = {
              ...e,
              variables: e.variables.map((v) => (v.id === varId ? { ...v, ...updates } : v)),
              updatedAt: Date.now(),
            };
            return updatedEnv;
          });
          return {
            environments: updatedEnvs,
            offlineEnvironments: state.workspaceMode === 'offline' ? updatedEnvs : state.offlineEnvironments,
          };
        });

        const { workspaceMode, cloudConfig } = get();
        if (workspaceMode === 'cloud' && cloudConfig.token && updatedEnv) {
          updateScopeEnvironment(
            cloudConfig.apiUrl,
            cloudConfig.token,
            envId,
            {
              name: updatedEnv.name,
              variables: updatedEnv.variables,
              min_role: updatedEnv.minRole,
            },
            cloudConfig.refreshToken
          ).catch(() => {});
        }
      },

      removeEnvironmentVariable: (envId, varId) => {
        let updatedEnv: Environment | undefined;
        set((state) => {
          const updatedEnvs = state.environments.map((e) => {
            if (e.id !== envId) return e;
            updatedEnv = {
              ...e,
              variables: e.variables.filter((v) => v.id !== varId),
              updatedAt: Date.now(),
            };
            return updatedEnv;
          });
          return {
            environments: updatedEnvs,
            offlineEnvironments: state.workspaceMode === 'offline' ? updatedEnvs : state.offlineEnvironments,
          };
        });

        const { workspaceMode, cloudConfig } = get();
        if (workspaceMode === 'cloud' && cloudConfig.token && updatedEnv) {
          updateScopeEnvironment(
            cloudConfig.apiUrl,
            cloudConfig.token,
            envId,
            {
              name: updatedEnv.name,
              variables: updatedEnv.variables,
              min_role: updatedEnv.minRole,
            },
            cloudConfig.refreshToken
          ).catch(() => {});
        }
      },

      addEnvironment: async (env: Environment) => {
        set((state) => ({
          environments: [...state.environments, env],
          activeEnvironmentId: env.id,
          offlineEnvironments: state.workspaceMode === 'offline'
            ? [...(state.offlineEnvironments || defaultEnvironments), env]
            : state.offlineEnvironments,
          offlineActiveEnvironmentId: state.workspaceMode === 'offline'
            ? env.id
            : state.offlineActiveEnvironmentId,
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
                environments: state.environments.map((e) => (e.id === env.id ? { ...e, id: created.id } : e)),
                activeEnvironmentId: state.activeEnvironmentId === env.id ? created.id : state.activeEnvironmentId,
                offlineEnvironments: state.workspaceMode === 'offline'
                  ? (state.offlineEnvironments || []).map((e) => (e.id === env.id ? { ...e, id: created.id } : e))
                  : state.offlineEnvironments,
                offlineActiveEnvironmentId: state.offlineActiveEnvironmentId === env.id ? created.id : state.offlineActiveEnvironmentId,
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
          updatedAt: Date.now(),
        };

        set((s) => ({
          environments: s.environments.map((e) => (e.id === existingId ? replacedEnv : e)),
          activeEnvironmentId: existingId,
          offlineEnvironments: s.workspaceMode === 'offline'
            ? (s.offlineEnvironments || defaultEnvironments).map((e) => (e.id === existingId ? replacedEnv : e))
            : s.offlineEnvironments,
          offlineActiveEnvironmentId: s.workspaceMode === 'offline'
            ? existingId
            : s.offlineActiveEnvironmentId,
        }));

        const { workspaceMode, cloudConfig } = get();
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token && cloudConfig.activeScope) {
          try {
            await updateScopeEnvironment(
              cloudConfig.apiUrl,
              cloudConfig.token,
              existingId,
              {
                name: replacedEnv.name,
                variables: replacedEnv.variables,
                min_role: replacedEnv.minRole,
              },
              cloudConfig.refreshToken
            );
          } catch (err: any) {
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
                offlineHistory: newHistory,
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
          offlineCollections: state.workspaceMode === 'offline'
            ? [newCol, ...(state.offlineCollections || [])]
            : state.offlineCollections,
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
            offlineCollections: state.workspaceMode === 'offline' ? collections : state.offlineCollections,
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
          offlineCollections: state.workspaceMode === 'offline'
            ? [taggedCol, ...(state.offlineCollections || [])]
            : state.offlineCollections,
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
          offlineCollections: s.workspaceMode === 'offline'
            ? (s.offlineCollections || []).map((c) => (c.id === existingId ? replacedCol : c))
            : s.offlineCollections,
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
            offlineEnvironments: state.workspaceMode === 'offline'
              ? [...(state.offlineEnvironments || defaultEnvironments), imported]
              : state.offlineEnvironments,
            offlineActiveEnvironmentId: state.workspaceMode === 'offline'
              ? imported.id
              : state.offlineActiveEnvironmentId,
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
                  environments: state.environments.map((e) => (e.id === imported.id ? { ...e, id: created.id } : e)),
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
          offlineCollections: state.workspaceMode === 'offline'
            ? (state.offlineCollections || []).filter((c) => c.id !== id)
            : state.offlineCollections,
        }));

        const { workspaceMode, cloudConfig } = get();
        if (!isOfflineOnly && workspaceMode === 'cloud' && cloudConfig.token) {
          deleteScopeCollection(cloudConfig.apiUrl, cloudConfig.token, id, cloudConfig.refreshToken).catch((err) => {
            console.error('Failed to delete collection from cloud:', err);
          });
        }
      },

      moveCollection: async (collectionId, targetScope) => {
        const { workspaceMode, collections, offlineCollections, cloudConfig } = get();
        if (isOfflineOnly) {
          return { success: false, error: 'Offline edition cannot move collections to online scopes' };
        }

        if (workspaceMode === 'offline') {
          // Moving from offline to online scope
          const col = (offlineCollections || collections).find((c) => c.id === collectionId);
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

            // Remove from offline collections
            const remainingOffline = (offlineCollections || []).filter((c) => c.id !== collectionId);
            const remainingActive = collections.filter((c) => c.id !== collectionId);

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
              offlineCollections: remainingOffline,
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
            return { history: [], offlineHistory: [] };
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
              offlineHistory: newHistory,
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
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        collections: state.collections,
        history: state.history,
        environments: state.environments,
        activeEnvironmentId: state.activeEnvironmentId,
        offlineCollections: state.offlineCollections,
        offlineEnvironments: state.offlineEnvironments,
        offlineActiveEnvironmentId: state.offlineActiveEnvironmentId,
        offlineTabs: state.offlineTabs,
        offlineActiveTabId: state.offlineActiveTabId,
        offlineHistory: state.offlineHistory,
        scopeCache: state.scopeCache,
        scopesCache: state.scopesCache,
        workspaceMode: isOfflineOnly ? 'offline' : state.workspaceMode,
        hasConfiguredMode: isOfflineOnly ? true : state.hasConfiguredMode,
        cloudConfig: state.cloudConfig,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (state.workspaceMode === 'offline') {
          if (!state.offlineCollections) {
            state.offlineCollections = [];
          }
          if (!state.offlineEnvironments || state.offlineEnvironments.length === 0) {
            state.offlineEnvironments = defaultEnvironments;
          }
          if (!state.offlineActiveEnvironmentId) {
            state.offlineActiveEnvironmentId = defaultEnvironments[0]?.id || null;
          }
          if (!state.offlineTabs || state.offlineTabs.length === 0) {
            state.offlineTabs = [createInitialTab()];
            state.offlineActiveTabId = state.offlineTabs[0].id;
          }
          if (!state.offlineHistory) {
            state.offlineHistory = state.history || [];
          }
        } else {
          if (!state.offlineHistory) {
            state.offlineHistory = [];
          }
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
}
