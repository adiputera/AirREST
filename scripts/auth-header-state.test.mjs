import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function transpileRun(relativePath, resolveModule, extraGlobals = {}) {
  const fileUrl = new URL(relativePath, import.meta.url);
  const source = fs.readFileSync(fileUrl, 'utf8').replaceAll('import.meta.env', '({})');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports = {};
  vm.runInNewContext(
    compiled,
    {
      exports,
      require: resolveModule,
      console,
      setTimeout,
      clearTimeout,
      AbortController,
      URL,
      URLSearchParams,
      Headers,
      Response,
      Blob,
      FormData,
      TextDecoder,
      Uint8Array,
      ArrayBuffer,
      performance,
      crypto,
      btoa,
      encodeURIComponent,
      unescape,
      Object,
      Array,
      Map,
      Set,
      Date,
      Math,
      JSON,
      ...extraGlobals,
    },
    { filename: fileUrl.pathname }
  );
  return exports;
}

function setupStoreHarness({ fetchImpl, preScriptImpl }) {
  const storageMap = new Map();
  const appStorage = {
    getItem: async (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: async (k, v) => {
      storageMap.set(k, v);
    },
    removeItem: async (k) => {
      storageMap.delete(k);
    },
  };

  const authHeaders = transpileRun('../packages/common/src/lib/authHeaders.ts', (id) => require(id));
  const urlParams = transpileRun('../packages/common/src/lib/urlParams.ts', (id) => require(id));
  const requestDiff = transpileRun('../packages/common/src/lib/requestDiff.ts', (id) => require(id));
  const postman = transpileRun('../packages/common/src/lib/postman.ts', (id) => {
    if (id.includes('urlParams')) return urlParams;
    return require(id);
  });
  const fetcher = transpileRun('../packages/common/src/lib/fetcher.ts', (id) => {
    if (id.includes('authHeaders')) return authHeaders;
    if (id.includes('urlParams')) return urlParams;
    if (id.includes('blobManager')) return { createTrackedBlobUrl: () => '' };
    return require(id);
  });

  const noop = () => {};
  const modules = {
    storage: { appStorage },
    blobManager: { revokeBlobUrl: noop, revokeBlobUrls: noop },
    fetcher,
    authHeaders,
    postman,
    urlParams,
    requestDiff,
    scriptRunner: {
      executePreRequestScript:
        preScriptImpl ||
        (async (_script, env, vars) => ({
          success: true,
          environment: env,
          variables: vars,
        })),
      executePostResponseScript: async (_script, _resp, env, vars) => ({
        success: true,
        environment: env,
        variables: vars,
      }),
    },
    asyncOperationCoordinator: {
      createAsyncOperationCoordinator: ({ isDisposed }) => {
        let sessionGeneration = 0;
        let scopeGeneration = 0;
        const controllers = new Set();
        return {
          begin: () => {
            const controller = new AbortController();
            if (isDisposed()) controller.abort();
            controllers.add(controller);
            return { controller, sessionGeneration, scopeGeneration };
          },
          complete: (op) => controllers.delete(op.controller),
          isCurrent: (op) =>
            !isDisposed() &&
            !op.controller.signal.aborted &&
            op.sessionGeneration === sessionGeneration &&
            op.scopeGeneration === scopeGeneration,
          invalidate: ({ session = false } = {}) => {
            if (session) sessionGeneration++;
            scopeGeneration++;
            for (const c of controllers) c.abort();
            controllers.clear();
          },
        };
      },
    },
    scopeCache: {
      getScopeCacheKey: (scope) => (scope?.id ? `${scope.type}:${scope.id}` : 'default'),
      resolveCachedScopeTabs: (entry, createInitialTab) => {
        const tabs = entry?.tabs?.length ? entry.tabs : [createInitialTab()];
        return { tabs, activeTabId: entry?.activeTabId || tabs[0].id };
      },
      isScopeCacheFresh: () => false,
    },
    scopeSnapshot: {
      snapshotWorkspaceResources: (res, lastSyncedAt) => ({ ...res, ...(lastSyncedAt !== undefined ? { lastSyncedAt } : {}) }),
      createEmptyWorkspaceSnapshot: (createInitialTab) => {
        const tab = createInitialTab();
        return { collections: [], environments: [], activeEnvironmentId: null, tabs: [tab], activeTabId: tab.id, history: [] };
      },
      restoreWorkspaceResources: (snap, createInitialTab) => {
        const tab = createInitialTab();
        return {
          collections: snap?.collections || [],
          environments: snap?.environments || [],
          activeEnvironmentId: snap?.activeEnvironmentId || null,
          tabs: snap?.tabs?.length ? snap.tabs : [tab],
          activeTabId: snap?.activeTabId || tab.id,
          history: snap?.history || [],
        };
      },
    },
    cloudSession: {
      isCloudSessionActive: () => false,
      prepareCloudSessionUpdate: (cur, req) => ({ updates: req, startsNewSession: false }),
    },
    cloudScopeTransition: {
      isActiveCloudScope: () => false,
      prepareCloudScopeTransition: () => ({}),
    },
    workspaceModeTransition: {
      prepareWorkspaceModeTransition: () => ({}),
    },
    persistence: {
      preparePersistedWorkspaceCaches: () => ({ offlineScopeCache: {}, scopeCache: {} }),
      normalizePersistedWorkspaceScopeCache: (cache) => cache || {},
      serializeCloudCacheArchives: () => ({}),
      normalizeCloudCacheArchives: () => ({}),
    },
    cloudSyncCollections: {
      isPendingCloudCollection: () => false,
      reuseUnchangedCloudCollection: () => null,
      createPartialCloudCollection: () => ({}),
      retainPendingCloudCollections: (cols) => cols,
    },
    cloudCollectionSync: {
      pushPendingCloudCollections: async () => ({ status: 'completed' }),
      pullCloudCollections: async () => ({ status: 'completed', collections: [], partialCollectionCount: 0 }),
    },
    cloudDeltaState: {
      planCloudDeltaState: () => ({}),
    },
    cloudWorkspaceSync: {
      runCloudWorkspaceSync: async () => ({ status: 'completed' }),
    },
    cloudApi: {
      normalizeCloudApiUrl: (u) => u,
      batchImportToScope: noop,
      registerTokenRefreshCallback: noop,
      registerAuthEvictedCallback: noop,
    },
    treeHelper: { reorderItemInTree: noop },
    cloudSyncTransformer: {
      buildCollectionFromDetails: (c) => c,
      buildEnvironmentsFromDelta: (e) => e,
    },
    edition: { defaultProductPolicy: { workspace: { cloud: false } } },
    jwt: { canModifyCollection: () => true, hasScopePermission: () => true },
    theme: { applyTheme: noop },
    storeContext: { StoreContext: {} },
  };

  const resolveModule = (id) => {
    if (id === 'zustand' || id === 'zustand/middleware' || id === 'react') {
      return require(id);
    }
    const clean = id.split('/').at(-1);
    if (clean && clean in modules) return modules[clean];
    for (const [key, mod] of Object.entries(modules)) {
      if (id.endsWith(`/${key}`) || id.endsWith(`@/lib/${key}`)) return mod;
    }
    return {};
  };

  modules.cloudCacheArchive = transpileRun('../packages/common/src/workspace/cloudCacheArchive.ts', resolveModule);
  modules.cloudCacheRecovery = transpileRun('../packages/common/src/workspace/cloudCacheRecovery.ts', resolveModule);
  modules.persistence = transpileRun('../packages/common/src/workspace/persistence.ts', resolveModule);
  modules.productPolicy = transpileRun('../packages/common/src/productPolicy.ts', (id) => require(id));

  const storeMod = transpileRun('../packages/common/src/store/useApiStore.ts', resolveModule);

  const adapter = {
    id: 'test-adapter',
    hasHostPermission: async () => true,
    requestHostPermission: async () => true,
    transport: {
      fetch: fetchImpl,
      classifyError: async (e) => ({ category: 'other', detail: String(e) }),
    },
    dispose: () => {},
  };

  const store = storeMod.createApiStore({ adapter });
  return {
    store,
    postman,
    storageMap,
    recreateStore: () => storeMod.createApiStore({ adapter }),
  };
}

test('store: pre-request script mutating authorization or token variable still yields Auth header on dispatch', async () => {
  const sentHeadersList = [];
  const { store } = setupStoreHarness({
    fetchImpl: async (_url, init) => {
      sentHeadersList.push(new Headers(init.headers));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    preScriptImpl: async (_script, env) => ({
      success: true,
      environment: { ...env, token: 'script-updated-token' },
      variables: {},
      mutatedRequest: {
        headers: [
          { key: 'authorization', value: 'Bearer script-manual-override' },
          { key: 'X-Script-Tag', value: 'from-script' },
        ],
      },
    }),
  });

  const activeTabId = store.getState().activeTabId;
  store.getState().updateActiveRequest({
    url: 'https://example.com/headers',
    auth: { type: 'bearer', bearerToken: '{{token}}' },
    headers: [{ id: 'h1', key: 'authorization', value: 'Bearer manual-initial', enabled: true }],
    preRequestScript: 'pm.request.headers.upsert({ key: "authorization", value: "Bearer script-manual-override" })',
  });

  await store.getState().sendRequest();

  assert.equal(sentHeadersList.length, 1);
  assert.equal(sentHeadersList[0].get('authorization'), 'Bearer script-updated-token');
  assert.equal(sentHeadersList[0].get('x-script-tag'), 'from-script');
  assert.equal(store.getState().tabs.find((t) => t.id === activeTabId).headers.length, 1);
});

test('store: save, reload snapshot, duplicate, undo/redo, Auth None fallback, and Postman export never persist synthetic Auth rows', async () => {
  const { store, postman, recreateStore } = setupStoreHarness({
    fetchImpl: async () => new Response('ok', { status: 200 }),
  });

  // Wait for initial store hydration before mutating
  await store.persist.rehydrate();

  store.getState().updateActiveRequest({
    name: 'Auth Persistence Test',
    url: 'https://example.com/test',
    auth: { type: 'bearer', bearerToken: 'auth-secret' },
    headers: [{ id: 'h-manual', key: 'authorization', value: 'Bearer manual-kept', enabled: true }],
  });

  // Save into a new collection
  store.getState().createCollection('Test Collection');
  const colId = store.getState().collections[0].id;
  const activeTab = store.getState().tabs[0];
  const saveResult = store.getState().saveRequestToCollection(colId, null, activeTab, activeTab.id);
  const savedTabId = saveResult.savedRequestId || store.getState().activeTabId;

  const savedReq = store.getState().collections[0].items[0].request;
  assert.equal(savedReq.headers.length, 1);
  assert.equal(savedReq.headers[0].value, 'Bearer manual-kept');
  assert.equal(savedReq.auth.type, 'bearer');

  // Allow Zustand persist middleware flush, then reload into a fresh store instance
  await new Promise((r) => setTimeout(r, 25));
  const reloadedStore = recreateStore();
  await reloadedStore.persist.rehydrate();
  const reloadedReq = reloadedStore.getState().collections[0]?.items[0]?.request;
  assert.ok(reloadedReq, 'Saved request must survive storage reload');
  assert.equal(reloadedReq.headers.length, 1);
  assert.equal(reloadedReq.headers[0].value, 'Bearer manual-kept');
  assert.equal(reloadedReq.auth.type, 'bearer');

  // Duplicate tab also retains only original headers + auth
  store.getState().duplicateTab(savedTabId);
  const dupTab = store.getState().tabs[1];
  assert.equal(
    dupTab?.headers?.[0]?.value,
    'Bearer manual-kept',
    `Unexpected dupTab=${JSON.stringify(dupTab)} tabs=${JSON.stringify(store.getState().tabs)}`
  );
  assert.equal(dupTab.auth.type, 'bearer');

  // Postman export preserves separate auth and original manual header without synthetic duplicate
  const exported = JSON.parse(postman.exportPostmanCollection(store.getState().collections[0]));
  assert.equal(exported.item[0].request.header.length, 1);
  assert.equal(exported.item[0].request.header[0].value, 'Bearer manual-kept');
  assert.equal(exported.item[0].request.auth.type, 'bearer');

  // Switching Auth to None preserves manual header; undo restores Bearer; redo returns to None
  store.getState().updateAuth({ type: 'none' });
  const activeAfterNone = store.getState().tabs.find((t) => t.id === store.getState().activeTabId);
  assert.equal(activeAfterNone.auth.type, 'none');
  assert.equal(activeAfterNone.headers.length, 1);
  assert.equal(activeAfterNone.headers[0].value, 'Bearer manual-kept');

  store.getState().undoActiveRequest();
  const activeAfterUndo = store.getState().tabs.find((t) => t.id === store.getState().activeTabId);
  assert.equal(activeAfterUndo.auth.type, 'bearer');
  assert.equal(activeAfterUndo.headers.length, 1);
  assert.equal(activeAfterUndo.headers[0].value, 'Bearer manual-kept');

  store.getState().redoActiveRequest();
  const activeAfterRedo = store.getState().tabs.find((t) => t.id === store.getState().activeTabId);
  assert.equal(activeAfterRedo.auth.type, 'none');
  assert.equal(activeAfterRedo.headers.length, 1);
  assert.equal(activeAfterRedo.headers[0].value, 'Bearer manual-kept');
});
