import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function loadStore({ executeApiRequest = async () => ({ status: 200, statusText: 'OK', data: '{"ok":true}', timeMs: 50, sizeBytes: 10, headers: {} }) } = {}) {
  const source = fs
    .readFileSync(new URL('../extension/src/store/useApiStore.ts', import.meta.url), 'utf8')
    .replaceAll('import.meta.env', '({})');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const appStorage = {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  };
  const noop = () => {};
  const modules = {
    '@/lib/storage': { appStorage },
    '@/lib/blobManager': { revokeBlobUrl: noop, revokeBlobUrls: noop },
    '@/lib/fetcher': { executeApiRequest },
    '@/lib/scriptRunner': {
      executePreRequestScript: async () => ({ success: true, environment: {}, variables: {} }),
      executePostResponseScript: async () => ({ success: true, environment: {}, variables: {} }),
    },
    '@/lib/postman': { importPostmanCollection: noop, importPostmanEnvironment: noop, detectPostmanJsonType: noop },
    '@/lib/urlParams': { parseQueryParamsFromUrl: () => [], buildUrlWithParams: (u) => u },
    '@/lib/cloudApi': {
      batchImportToScope: noop,
      registerTokenRefreshCallback: noop,
      registerAuthEvictedCallback: noop,
      createScopeEnvironment: noop,
      updateScopeEnvironment: noop,
      deleteScopeEnvironment: noop,
      deleteScopeCollection: noop,
      deleteScopeItem: noop,
      moveScopeCollection: noop,
      reorderCollectionItems: noop,
      fetchUserWorkspaces: noop,
      fetchUserTeams: noop,
      fetchTeamProjects: noop,
      fetchScopeCollections: noop,
      fetchCollectionById: noop,
      fetchScopeEnvironments: noop,
    },
    '@/lib/treeHelper': { reorderItemInTree: noop },
    '@/lib/cloudSyncTransformer': {
      buildCollectionFromDetails: (collection) => ({ ...collection, items: collection.items ?? [] }),
      buildEnvironmentsFromDelta: (environments) => (environments ?? []).map((environment) => ({
        ...environment,
        minRole: environment.min_role ?? environment.minRole ?? 'reader',
        createdAt: environment.createdAt ?? Date.now(),
        updatedAt: environment.updatedAt ?? Date.now(),
      })),
    },
    '@/lib/edition': { isOfflineOnly: true },
    '@/lib/requestDiff': {
      findSavedRequestInCollections: noop,
      alignCollectionItemIds: noop,
      flattenCollectionRequests: noop,
      alignEnvironmentVariableIds: noop,
    },
    '@/lib/jwt': { canModifyCollection: () => true, hasScopePermission: () => true },
  };

  let uuidCounter = 0;
  vm.runInNewContext(compiled, {
    exports,
    require: (id) => modules[id] ?? require(id),
    console,
    crypto: { randomUUID: () => `uuid-${++uuidCounter}` },
    Date,
    JSON,
    Math,
    Promise,
    AbortController,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
  }, { filename: 'extension/src/store/useApiStore.ts' });

  return exports.useApiStore;
}

test('T-SEMI-PERSIST-1: Response is cached per-tab and restored when switching tabs in memory', async () => {
  const store = loadStore({
    executeApiRequest: async (req) => ({
      status: req.url.includes('/token') ? 200 : 201,
      statusText: req.url.includes('/token') ? 'OK' : 'Created',
      data: req.url.includes('/token') ? '{"token":"xyz123"}' : '{"product":"item-1"}',
      timeMs: 42,
      sizeBytes: 25,
      headers: { 'content-type': 'application/json' },
      requestUrl: req.url,
      timestamp: Date.now(),
    }),
  });

  // 1. Setup Tab 1: "Get Token"
  const tab1Id = store.getState().activeTabId;
  store.getState().updateActiveRequest({ name: 'Get Token', url: 'https://api.example.com/token' });

  // Execute Tab 1
  await store.getState().sendRequest();

  assert.equal(store.getState().activeResponse?.status, 200);
  assert.equal(store.getState().activeResponse?.data, '{"token":"xyz123"}');
  assert.equal(store.getState().tabResponses?.[tab1Id]?.data, '{"token":"xyz123"}');

  // 2. Create Tab 2: "Get Product"
  store.getState().createTab({ name: 'Get Product', url: 'https://api.example.com/product' });
  const tab2Id = store.getState().activeTabId;
  assert.notEqual(tab1Id, tab2Id);

  // Tab 2 has not executed yet -> activeResponse must be null
  assert.equal(store.getState().activeResponse, null);
  // Tab 1 response must still be preserved in tabResponses
  assert.equal(store.getState().tabResponses?.[tab1Id]?.data, '{"token":"xyz123"}');

  // 3. Execute Tab 2
  await store.getState().sendRequest();
  assert.equal(store.getState().activeResponse?.status, 201);
  assert.equal(store.getState().activeResponse?.data, '{"product":"item-1"}');
  assert.equal(store.getState().tabResponses?.[tab2Id]?.data, '{"product":"item-1"}');

  // 4. Switch back to Tab 1 ("Get Token")
  store.getState().setActiveTabId(tab1Id);
  assert.equal(store.getState().activeTabId, tab1Id);
  // Active response must be restored to Tab 1's response!
  assert.equal(store.getState().activeResponse?.status, 200);
  assert.equal(store.getState().activeResponse?.data, '{"token":"xyz123"}');

  // 5. Switch back to Tab 2 ("Get Product")
  store.getState().setActiveTabId(tab2Id);
  assert.equal(store.getState().activeTabId, tab2Id);
  // Active response must be restored to Tab 2's response!
  assert.equal(store.getState().activeResponse?.status, 201);
  assert.equal(store.getState().activeResponse?.data, '{"product":"item-1"}');
});

test('T-SEMI-PERSIST-2: Closing a tab purges its in-memory response and activates adjacent tab response', async () => {
  const store = loadStore({
    executeApiRequest: async (req) => ({
      status: 200,
      statusText: 'OK',
      data: req.url,
      timeMs: 10,
      sizeBytes: 10,
      headers: {},
      timestamp: Date.now(),
    }),
  });

  const tab1Id = store.getState().activeTabId;
  store.getState().updateActiveRequest({ url: 'https://api.example.com/one' });
  await store.getState().sendRequest();

  store.getState().createTab({ url: 'https://api.example.com/two' });
  const tab2Id = store.getState().activeTabId;
  await store.getState().sendRequest();

  assert.equal(store.getState().tabResponses?.[tab1Id]?.data, 'https://api.example.com/one');
  assert.equal(store.getState().tabResponses?.[tab2Id]?.data, 'https://api.example.com/two');

  // Close Tab 2 while it's active
  store.getState().closeTab(tab2Id);

  // Tab 2 response should be purged from memory
  assert.equal(store.getState().tabResponses?.[tab2Id], undefined);
  // Active tab falls back to Tab 1, and its response is active
  assert.equal(store.getState().activeTabId, tab1Id);
  assert.equal(store.getState().activeResponse?.data, 'https://api.example.com/one');
});

test('T-SEMI-PERSIST-3: openRequestInTab restores existing tab response or sets initial response', async () => {
  const store = loadStore();

  const tab1 = store.getState().tabs[0];
  const mockResponse = {
    status: 200,
    statusText: 'OK',
    data: '{"fromHistory":true}',
    timeMs: 15,
    sizeBytes: 20,
    headers: {},
    timestamp: Date.now(),
  };

  // Open existing tab with initialResponse
  store.getState().openRequestInTab(tab1, mockResponse);
  assert.equal(store.getState().activeTabId, tab1.id);
  assert.equal(store.getState().activeResponse?.data, '{"fromHistory":true}');
  assert.equal(store.getState().tabResponses?.[tab1.id]?.data, '{"fromHistory":true}');

  // Open a new request with initialResponse
  const newReq = {
    id: 'req-from-collection',
    name: 'Collection Req',
    method: 'POST',
    url: 'https://api.example.com/coll',
    params: [],
    headers: [],
    auth: { type: 'none' },
    bodyType: 'none',
    rawType: 'text',
    bodyContent: '',
    graphqlQuery: '',
    graphqlVariables: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const collResponse = {
    status: 204,
    statusText: 'No Content',
    data: '',
    timeMs: 8,
    sizeBytes: 0,
    headers: {},
    timestamp: Date.now(),
  };

  store.getState().openRequestInTab(newReq, collResponse);
  assert.equal(store.getState().activeTabId, 'req-from-collection');
  assert.equal(store.getState().activeResponse?.status, 204);
  assert.equal(store.getState().tabResponses?.['req-from-collection']?.status, 204);
});

test('T-SEMI-PERSIST-4: updateActiveRequest id change migrates tabResponses', async () => {
  const store = loadStore({
    executeApiRequest: async () => ({
      status: 200,
      statusText: 'OK',
      data: '{"saved":true}',
      timeMs: 12,
      sizeBytes: 15,
      headers: {},
      timestamp: Date.now(),
    }),
  });

  const oldId = store.getState().activeTabId;
  store.getState().updateActiveRequest({ url: 'https://api.example.com/save' });
  await store.getState().sendRequest();

  assert.equal(store.getState().tabResponses?.[oldId]?.data, '{"saved":true}');

  // Emulate Save To Collection assigning a new ID to the active tab
  const newId = 'saved-request-uuid-99';
  store.getState().updateActiveRequest({ id: newId, name: 'Saved Req' });

  assert.equal(store.getState().activeTabId, newId);
  assert.equal(store.getState().tabResponses?.[oldId], undefined, 'Old ID should be cleared');
  assert.equal(store.getState().tabResponses?.[newId]?.data, '{"saved":true}', 'New ID should inherit cached response');
  assert.equal(store.getState().activeResponse?.data, '{"saved":true}');
});

test('T-SEMI-PERSIST-5: partialize excludes tabResponses and activeResponse (strictly session-only)', async () => {
  const store = loadStore();
  const persistOptions = store.persist.getOptions();

  const mockState = {
    ...store.getState(),
    activeResponse: { status: 200, statusText: 'OK', data: 'leak?', timeMs: 1, sizeBytes: 1, headers: {}, timestamp: 1 },
    tabResponses: { 'tab-1': { status: 200, statusText: 'OK', data: 'leak?', timeMs: 1, sizeBytes: 1, headers: {}, timestamp: 1 } },
  };

  const serialized = persistOptions.partialize(mockState);

  assert.equal(serialized.activeResponse, undefined, 'activeResponse must NOT be persisted in partialize');
  assert.equal(serialized.tabResponses, undefined, 'tabResponses must NOT be persisted in partialize');
});

test('T-SEMI-PERSIST-6: Closing the last remaining tab results in 0 tabs and empty activeTabId', async () => {
  const store = loadStore();
  assert.equal(store.getState().tabs.length, 1);
  const onlyTabId = store.getState().tabs[0].id;

  store.getState().closeTab(onlyTabId);

  assert.equal(store.getState().tabs.length, 0, 'Tabs array must be empty');
  assert.equal(store.getState().activeTabId, '', 'activeTabId must be empty string');
  assert.equal(store.getState().activeResponse, null);
});

test('T-SEMI-PERSIST-7: closeAllTabs clears all tabs to 0 tabs', async () => {
  const store = loadStore();
  store.getState().createTab({ name: 'Tab 2' });
  store.getState().createTab({ name: 'Tab 3' });
  assert.equal(store.getState().tabs.length, 3);

  store.getState().closeAllTabs();

  assert.equal(store.getState().tabs.length, 0, 'closeAllTabs must leave 0 tabs');
  assert.equal(store.getState().activeTabId, '');
  assert.equal(store.getState().activeResponse, null);
  assert.equal(Object.keys(store.getState().tabResponses || {}).length, 0);
});

test('T-SEMI-PERSIST-8: createTab from 0 tabs successfully opens a single active tab', async () => {
  const store = loadStore();
  store.getState().closeAllTabs();
  assert.equal(store.getState().tabs.length, 0);

  store.getState().createTab({ name: 'Brand New Tab', url: 'https://api.example.com/start' });

  assert.equal(store.getState().tabs.length, 1);
  assert.equal(store.getState().tabs[0].name, 'Brand New Tab');
  assert.equal(store.getState().activeTabId, store.getState().tabs[0].id);
  assert.equal(store.getState().activeResponse, null);
});


