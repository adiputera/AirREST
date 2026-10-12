import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
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
} from '@/types/api';
import { executeApiRequest } from '@/lib/fetcher';
import {
  importPostmanCollection,
  importPostmanEnvironment,
  detectPostmanJsonType,
} from '@/lib/postman';
import { executePreRequestScript, executePostResponseScript } from '@/lib/scriptRunner';
import { parseQueryParamsFromUrl, buildUrlWithParams } from '@/lib/urlParams';

function generateId(): string {
  return Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
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
  preRequestScript: '// Example Pre-request Script:\n// pm.environment.set("timestamp", Date.now());\n// console.log("Request starting...");\n',
  postResponseScript: '// Example Tests / Post-response Script:\n// const data = pm.response.json();\n// if (data.token) pm.environment.set("token", data.token);\n',
  createdAt: Date.now(),
  updatedAt: Date.now(),
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
  createEnvironment: (name: string) => string;
  deleteEnvironment: (id: string) => void;
  updateEnvironment: (id: string, updates: Partial<Environment>) => void;
  addEnvironmentVariable: (envId: string) => void;
  updateEnvironmentVariable: (envId: string, varId: string, updates: Partial<EnvironmentVariable>) => void;
  removeEnvironmentVariable: (envId: string, varId: string) => void;
  importEnvironmentFromJson: (jsonStr: string) => { success: boolean; error?: string; environment?: Environment };
  importAnyPostmanJson: (jsonStr: string) => {
    success: boolean;
    type?: 'collection' | 'environment';
    name?: string;
    error?: string;
  };

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

  // Execution
  sendRequest: () => Promise<void>;

  // Collections & History
  createCollection: (name: string, description?: string) => string;
  saveRequestToCollection: (collectionId: string, folderId: string | null, request: ApiRequest) => void;
  addCollection: (collection: Collection) => void;
  importCollectionFromJson: (jsonStr: string) => { success: boolean; error?: string };
  deleteCollection: (id: string) => void;
  openRequestInTab: (request: ApiRequest) => void;
  clearHistory: () => void;
  deleteHistoryItem: (id: string) => void;
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

      // Environment actions
      setActiveEnvironmentId: (activeEnvironmentId) => set({ activeEnvironmentId }),

      createEnvironment: (name) => {
        const newEnv: Environment = {
          id: generateId(),
          name: name.trim() || 'New Environment',
          variables: [{ id: generateId(), key: '', value: '', enabled: true }],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set((state) => ({
          environments: [...state.environments, newEnv],
          activeEnvironmentId: newEnv.id,
        }));
        return newEnv.id;
      },

      deleteEnvironment: (id) => {
        set((state) => ({
          environments: state.environments.filter((e) => e.id !== id),
          activeEnvironmentId: state.activeEnvironmentId === id ? null : state.activeEnvironmentId,
        }));
      },

      updateEnvironment: (id, updates) => {
        set((state) => ({
          environments: state.environments.map((e) =>
            e.id === id ? { ...e, ...updates, updatedAt: Date.now() } : e
          ),
        }));
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
              preRequestScript: '',
              postResponseScript: '',
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
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
            const method = bodyType === 'graphql' && tab.method === 'GET' ? 'POST' : tab.method;
            return { ...tab, bodyType, rawType, method, updatedAt: Date.now() };
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

          set((s) => ({
            activeResponse: finalResponse,
            isLoading: false,
            history: [historyEntry, ...s.history].slice(0, 50),
          }));
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
        };
        set((state) => ({
          collections: [newCol, ...state.collections],
        }));
        return newCol.id;
      },

      saveRequestToCollection: (collectionId, folderId, request) => {
        set((state) => {
          const collections = state.collections.map((col) => {
            if (col.id !== collectionId) return col;

            const cleanReq: ApiRequest = JSON.parse(JSON.stringify(request));

            const insertOrUpdateInList = (items: CollectionItem[]): CollectionItem[] => {
              const existingIdx = items.findIndex(
                (item) => item.type === 'request' && (item.id === cleanReq.id || item.request?.id === cleanReq.id || item.name === cleanReq.name)
              );

              if (existingIdx >= 0) {
                const updated = [...items];
                updated[existingIdx] = {
                  ...updated[existingIdx],
                  name: cleanReq.name,
                  request: cleanReq,
                };
                return updated;
              }

              return [
                ...items,
                {
                  id: cleanReq.id || generateId(),
                  name: cleanReq.name || 'Untitled Request',
                  type: 'request',
                  request: cleanReq,
                },
              ];
            };

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

          return { collections };
        });
      },

      addCollection: (collection) => {
        set((state) => ({
          collections: [collection, ...state.collections],
        }));
      },

      importEnvironmentFromJson: (jsonStr) => {
        try {
          const imported = importPostmanEnvironment(jsonStr);
          set((state) => ({
            environments: [...state.environments, imported],
            activeEnvironmentId: imported.id,
          }));
          return { success: true, environment: imported };
        } catch (err: unknown) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to parse Postman environment',
          };
        }
      },

      importAnyPostmanJson: (jsonStr) => {
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
            get().addCollection(col);
            return { success: true, type: 'collection', name: col.name };
          }
        } catch (err: unknown) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to import Postman file',
          };
        }
      },

      importCollectionFromJson: (jsonStr) => {
        try {
          if (detectPostmanJsonType(jsonStr) === 'environment') {
            const envRes = get().importEnvironmentFromJson(jsonStr);
            if (envRes.success) {
              return { success: true };
            }
            return { success: false, error: envRes.error };
          }

          const imported = importPostmanCollection(jsonStr);
          get().addCollection(imported);
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

      clearHistory: () => set({ history: [] }),

      deleteHistoryItem: (id) => {
        set((state) => ({
          history: state.history.filter((h) => h.id !== id),
        }));
      },
    }),
    {
      name: 'api-tester-storage-v2',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        collections: state.collections,
        history: state.history,
        environments: state.environments,
        activeEnvironmentId: state.activeEnvironmentId,
      }),
    }
  )
);
