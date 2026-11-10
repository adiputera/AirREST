import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function loadStore({ executePreRequestScript, executeApiRequest, cloudApi = {}, isOfflineOnly = true }) {
  const source = fs
    .readFileSync(new URL('../packages/common/src/store/useApiStore.ts', import.meta.url), 'utf8')
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
    'storage': { appStorage },
    'blobManager': { revokeBlobUrl: noop, revokeBlobUrls: noop },
    'fetcher': { executeApiRequest },
    'scriptRunner': { executePreRequestScript, executePostResponseScript: async () => ({ success: true, environment: {}, variables: {} }) },
    'postman': { importPostmanCollection: noop, importPostmanEnvironment: noop, detectPostmanJsonType: noop },
    'urlParams': { parseQueryParamsFromUrl: noop, parsePathVariablesFromUrl: () => [], buildUrlWithParams: noop },
    'asyncOperationCoordinator': {
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
          complete: (operation) => controllers.delete(operation.controller),
          isCurrent: (operation) => !isDisposed() && !operation.controller.signal.aborted && operation.sessionGeneration === sessionGeneration && operation.scopeGeneration === scopeGeneration,
          invalidate: ({ session = false } = {}) => {
            if (session) sessionGeneration++;
            scopeGeneration++;
            for (const controller of controllers) controller.abort();
            controllers.clear();
          },
        };
      },
    },
    'scopeCache': {
      getScopeCacheKey: (scope) => scope?.id ? `${scope.type}:${scope.id}` : 'default',
      resolveCachedScopeTabs: (entry, createInitialTab) => {
        const tabs = entry?.tabs?.length ? entry.tabs : [createInitialTab()];
        return {
          tabs,
          activeTabId: entry?.activeTabId && tabs.some((tab) => tab.id === entry.activeTabId)
            ? entry.activeTabId
            : tabs[0].id,
        };
      },
      isScopeCacheFresh: (entry, ttlMs, now = Date.now()) => Boolean(entry?.lastSyncedAt && now - entry.lastSyncedAt < ttlMs &&
        !entry.collections?.some((item) => item._syncStatus === 'pending' || (item._origin === 'cloud' && typeof item.version !== 'number'))),
    },
    'scopeSnapshot': {
      snapshotWorkspaceResources: (resources, lastSyncedAt) => ({
        ...resources,
        ...(lastSyncedAt !== undefined ? { lastSyncedAt } : {}),
      }),
      createEmptyWorkspaceSnapshot: (createInitialTab) => {
        const initialTab = createInitialTab();
        return { collections: [], environments: [], activeEnvironmentId: null, tabs: [initialTab], activeTabId: initialTab.id, history: [] };
      },
      restoreWorkspaceResources: (snapshot, createInitialTab) => {
        const initialTab = createInitialTab;
        const source = snapshot || (() => {
          const tab = initialTab();
          return { collections: [], environments: [], activeEnvironmentId: null, tabs: [tab], activeTabId: tab.id, history: [] };
        })();
        const tabs = source.tabs?.length ? source.tabs : [initialTab()];
        return {
          collections: source.collections || [], environments: source.environments || [], activeEnvironmentId: source.activeEnvironmentId || null,
          tabs, activeTabId: source.activeTabId && tabs.some((tab) => tab.id === source.activeTabId) ? source.activeTabId : tabs[0].id,
          history: source.history || [],
        };
      },
    },
    'cloudSession': {
      isCloudSessionActive: (config) => Boolean(config.token || (config.sessionKind === 'provider' && config.user?.id)),
      prepareCloudSessionUpdate: (current, requested, normalizeApiUrl) => {
        const updates = { ...requested };
        if (updates.apiUrl !== undefined) updates.apiUrl = normalizeApiUrl(updates.apiUrl);
        if (updates.apiUrl !== undefined && updates.apiUrl !== current.apiUrl) {
          for (const key of ['user', 'token', 'refreshToken', 'tokenExpiresAt', 'sessionKind', 'activeScope']) {
            if (!Object.prototype.hasOwnProperty.call(updates, key)) updates[key] = undefined;
          }
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'user') && updates.user?.id !== current.user?.id) {
          for (const key of ['token', 'refreshToken', 'tokenExpiresAt', 'sessionKind', 'activeScope']) {
            if (!Object.prototype.hasOwnProperty.call(updates, key)) updates[key] = undefined;
          }
        }
        return {
          updates,
          startsNewSession: (updates.apiUrl !== undefined && updates.apiUrl !== current.apiUrl) ||
            (updates.user?.id !== undefined && updates.user.id !== current.user?.id) ||
            (updates.token !== undefined && !current.token),
        };
      },
    },
    'cloudScopeTransition': {
      isActiveCloudScope: (workspaceMode, activeCloudScope, targetScope) => workspaceMode === 'cloud' && activeCloudScope?.type === targetScope.type && activeCloudScope?.id === targetScope.id,
      prepareCloudScopeTransition: ({ workspaceMode, activeCloudScope, targetScope, activeOfflineWorkspaceId, offlineScopeCache, scopeCache, resources, lastSyncedAt, forceSync, cacheTtlMs, createInitialTab }) => {
        const offline = { ...offlineScopeCache };
        const cloud = { ...scopeCache };
        if (workspaceMode === 'offline') offline[activeOfflineWorkspaceId] = { ...resources };
        else if (activeCloudScope) cloud[`${activeCloudScope.type}:${activeCloudScope.id}`] = { ...cloud[`${activeCloudScope.type}:${activeCloudScope.id}`], ...resources, lastSyncedAt };
        const target = cloud[`${targetScope.type}:${targetScope.id}`];
        const tabs = target?.tabs?.length ? target.tabs : [createInitialTab()];
        return {
          isSameScope: workspaceMode === 'cloud' && activeCloudScope?.type === targetScope.type && activeCloudScope?.id === targetScope.id,
          offlineScopeCache: offline, scopeCache: cloud, targetCache: target,
          targetResources: { collections: target?.collections || [], environments: target?.environments || [], activeEnvironmentId: target?.activeEnvironmentId || null, tabs, activeTabId: target?.activeTabId && tabs.some((tab) => tab.id === target.activeTabId) ? target.activeTabId : tabs[0].id, history: target?.history || [] },
          isFresh: !forceSync && Boolean(target?.lastSyncedAt && Date.now() - target.lastSyncedAt < cacheTtlMs),
        };
      },
    },
    'workspaceModeTransition': {
      prepareWorkspaceModeTransition: ({ currentWorkspaceMode, nextWorkspaceMode, activeCloudScope, activeOfflineWorkspaceId, fallbackOfflineWorkspaceId, offlineScopeCache, scopeCache, resources, lastSyncedAt, cacheTtlMs, createInitialTab }) => {
        const offline = { ...offlineScopeCache };
        const cloud = { ...scopeCache };
        if (nextWorkspaceMode === 'offline') {
          if (activeCloudScope) cloud[`${activeCloudScope.type}:${activeCloudScope.id}`] = { ...cloud[`${activeCloudScope.type}:${activeCloudScope.id}`], ...resources, lastSyncedAt };
          const targetCache = offline[activeOfflineWorkspaceId || fallbackOfflineWorkspaceId] || (() => { const tab = createInitialTab(); return { collections: [], environments: [], activeEnvironmentId: null, tabs: [tab], activeTabId: tab.id, history: [] }; })();
          const tabs = targetCache.tabs?.length ? targetCache.tabs : [createInitialTab()];
          return { offlineScopeCache: offline, scopeCache: cloud, targetCache, targetResources: { collections: targetCache.collections || [], environments: targetCache.environments || [], activeEnvironmentId: targetCache.activeEnvironmentId || null, tabs, activeTabId: targetCache.activeTabId && tabs.some((tab) => tab.id === targetCache.activeTabId) ? targetCache.activeTabId : tabs[0].id, history: targetCache.history || [] }, isCloudCacheFresh: false };
        }
        if (currentWorkspaceMode === 'offline' && activeOfflineWorkspaceId) offline[activeOfflineWorkspaceId] = { ...resources };
        const targetCache = activeCloudScope ? cloud[`${activeCloudScope.type}:${activeCloudScope.id}`] : undefined;
        const tabs = targetCache?.tabs?.length ? targetCache.tabs : [createInitialTab()];
        return { offlineScopeCache: offline, scopeCache: cloud, targetCache, targetResources: { collections: targetCache?.collections || [], environments: targetCache?.environments || [], activeEnvironmentId: targetCache?.activeEnvironmentId || null, tabs, activeTabId: targetCache?.activeTabId && tabs.some((tab) => tab.id === targetCache.activeTabId) ? targetCache.activeTabId : tabs[0].id, history: targetCache?.history || [] }, isCloudCacheFresh: Boolean(targetCache?.lastSyncedAt && Date.now() - targetCache.lastSyncedAt < cacheTtlMs) };
      },
    },
    'cloudDeltaState': {
      prepareCloudDeltaState: ({ scope, scopeCache, collections, pulledEnvironments, currentEnvironments, activeEnvironmentId, tabs, activeTabId, history, partialCollectionCount, syncedAt }) => {
        const environments = pulledEnvironments.map((environment) => {
          const current = currentEnvironments.find((candidate) => candidate.id === environment.id);
          return current ? { ...environment, variables: environment.variables.map((variable) => {
            const local = current.variables.find((candidate) => candidate.id === variable.id || candidate.key === variable.key);
            return { ...variable, currentValue: local?.currentValue !== undefined ? local.currentValue : variable.initialValue };
          }) } : environment;
        });
        const nextActiveEnvironmentId = environments.some((environment) => environment.id === activeEnvironmentId) ? activeEnvironmentId : (environments[0]?.id || null);
        const key = `${scope.type}:${scope.id}`;
        const hasPartial = partialCollectionCount > 0;
        return { collections, environments, activeEnvironmentId: nextActiveEnvironmentId, scopeCache: { ...scopeCache, [key]: { ...scopeCache[key], collections, environments, activeEnvironmentId: nextActiveEnvironmentId, tabs, activeTabId, history, lastSyncedAt: syncedAt } }, syncStatus: hasPartial ? 'error' : 'synced', syncError: hasPartial ? `${partialCollectionCount} collection detail${partialCollectionCount === 1 ? '' : 's'} could not be loaded. Click sync to retry.` : null, lastSyncedAt: syncedAt };
      },
    },
    'persistence': {
      preparePersistedWorkspaceCaches: ({ workspaceMode, activeOfflineWorkspaceId, activeCloudScope, lastSyncedAt, resources, offlineScopeCache, scopeCache, serializeRequest, serializeCollection, serializeHistory }) => {
        const serializeCache = (cache) => Object.fromEntries(Object.entries(cache).map(([key, entry]) => [key, { ...entry, tabs: (entry.tabs || []).map(serializeRequest), collections: (entry.collections || []).map(serializeCollection), history: serializeHistory(entry.history || []) }]));
        const offline = serializeCache(offlineScopeCache);
        const cloud = serializeCache(scopeCache);
        if (workspaceMode === 'offline' && activeOfflineWorkspaceId) offline[activeOfflineWorkspaceId] = { ...offline[activeOfflineWorkspaceId], collections: resources.collections.map(serializeCollection), environments: resources.environments, activeEnvironmentId: resources.activeEnvironmentId, tabs: resources.tabs.map(serializeRequest), activeTabId: resources.activeTabId, history: serializeHistory(resources.history) };
        if (workspaceMode === 'cloud' && activeCloudScope) { const key = `${activeCloudScope.type}:${activeCloudScope.id}`; cloud[key] = { ...cloud[key], collections: resources.collections.map(serializeCollection), environments: resources.environments, activeEnvironmentId: resources.activeEnvironmentId, tabs: resources.tabs.map(serializeRequest), activeTabId: resources.activeTabId, history: serializeHistory(resources.history), lastSyncedAt }; }
        return { offlineScopeCache: offline, scopeCache: cloud };
      },
      normalizePersistedWorkspaceScopeCache: (cache, normalizers) => Object.fromEntries(Object.entries(cache || {}).map(([key, entry]) => [key, { ...entry, tabs: (entry.tabs || []).map(normalizers.normalizeRequest), collections: normalizers.normalizeCollections(entry.collections || []), history: normalizers.normalizeHistory(entry.history || []) }])),
    },
    'cloudSyncCollections': {
      isPendingCloudCollection: (collection) => collection._syncStatus === 'pending' || (collection._origin === 'cloud' && typeof collection.version !== 'number'),
      reuseUnchangedCloudCollection: (existing, metadata) => {
        if (!existing || existing.isPartial) return null;
        const updatedAt = new Date(metadata.updated_at || 0).getTime();
        const unchanged = (typeof metadata.version === 'number' && existing.version === metadata.version) || (updatedAt > 0 && existing.updatedAt === updatedAt);
        return unchanged ? { ...existing, name: metadata.name, description: metadata.description || '', minRole: metadata.min_role || existing.minRole, version: metadata.version ?? existing.version, updatedAt: updatedAt || existing.updatedAt, _syncStatus: 'synced' } : null;
      },
      createPartialCloudCollection: (metadata, existing, now = Date.now()) => ({ id: metadata.id, name: metadata.name, description: metadata.description || '', items: existing?.items || [], minRole: metadata.min_role || existing?.minRole || 'reader', version: existing?.version, createdAt: new Date(metadata.created_at || now).getTime(), updatedAt: existing?.updatedAt || 0, _origin: 'cloud', isPartial: true, _syncStatus: 'synced' }),
      retainPendingCloudCollections: (collections, serverIds) => { const ids = new Set(serverIds); return collections.filter((collection) => !ids.has(collection.id) && (collection._syncStatus === 'pending' || typeof collection.version !== 'number')); },
    },
    'cloudCollectionSync': {
      pushPendingCloudCollections: async ({ collections, upload, isCurrent, isAborted, onUploaded }) => {
        for (const collection of collections.filter((candidate) => candidate._syncStatus === 'pending' || (candidate._origin === 'cloud' && typeof candidate.version !== 'number'))) {
          if (!isCurrent()) return { status: 'cancelled' };
          try { await upload(collection); } catch (error) { return isAborted() || !isCurrent() ? { status: 'cancelled' } : { status: 'failed', collection, error }; }
          if (!isCurrent()) return { status: 'cancelled' };
          onUploaded(collection);
        }
        return { status: 'completed' };
      },
      pullCloudCollections: async ({ currentCollections, fetchMetadata, fetchDetail, buildCollection, isCurrent, onDetailFetchError }) => {
        const metadata = await fetchMetadata();
        if (!isCurrent()) return { status: 'cancelled' };
        const currentById = new Map(currentCollections.map((collection) => [collection.id, collection]));
        const collections = [];
        let partialCollectionCount = 0;
        for (const item of metadata) {
          if (item.deleted_at) continue;
          const existing = currentById.get(item.id);
          const updatedAt = new Date(item.updated_at || 0).getTime();
          const unchanged = existing && !existing.isPartial && ((typeof item.version === 'number' && existing.version === item.version) || (updatedAt > 0 && existing.updatedAt === updatedAt));
          if (unchanged) { collections.push({ ...existing, name: item.name, description: item.description || '', minRole: item.min_role || existing.minRole, version: item.version ?? existing.version, updatedAt: updatedAt || existing.updatedAt, _syncStatus: 'synced' }); continue; }
          try {
            const detail = await fetchDetail(item.id);
            if (!isCurrent()) return { status: 'cancelled' };
            if (detail && !detail.deleted_at) collections.push({ ...buildCollection(detail), _syncStatus: 'synced' });
          } catch (error) {
            if (!isCurrent()) return { status: 'cancelled' };
            onDetailFetchError?.(item, error); partialCollectionCount++;
            collections.push({ id: item.id, name: item.name, description: item.description || '', items: existing?.items || [], minRole: item.min_role || existing?.minRole || 'reader', version: existing?.version, createdAt: new Date(item.created_at || Date.now()).getTime(), updatedAt: existing?.updatedAt || 0, _origin: 'cloud', isPartial: true, _syncStatus: 'synced' });
          }
        }
        const ids = new Set(metadata.map((item) => item.id));
        return { status: 'completed', collections: [...collections, ...currentCollections.filter((collection) => !ids.has(collection.id) && (collection._syncStatus === 'pending' || typeof collection.version !== 'number'))], partialCollectionCount };
      },
    },
    'cloudApi': {
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
      ...cloudApi,
    },
    'treeHelper': { reorderItemInTree: noop },
    'cloudSyncTransformer': {
      buildCollectionFromDetails: (collection) => ({ ...collection, items: collection.items ?? [] }),
      buildEnvironmentsFromDelta: (environments) => (environments ?? []).map((environment) => ({
        ...environment,
        minRole: environment.min_role ?? environment.minRole ?? 'reader',
        createdAt: environment.createdAt ?? Date.now(),
        updatedAt: environment.updatedAt ?? Date.now(),
      })),
    },
    'edition': {
      defaultProductPolicy: { workspace: { cloud: !isOfflineOnly } },
    },
    'requestDiff': {
      findSavedRequestInCollections: noop,
      alignCollectionItemIds: noop,
      flattenCollectionRequests: noop,
      alignEnvironmentVariableIds: noop,
    },
    'jwt': { canModifyCollection: () => true, hasScopePermission: () => true },
    'theme': { applyTheme: noop },
    'storeContext': { StoreContext: {} },
  };

  const loadWorkspaceModule = (name) => {
    const source = fs.readFileSync(new URL(`../packages/common/src/workspace/${name}.ts`, import.meta.url), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {};
    vm.runInNewContext(output, { exports, require: (id) => modules[id.split('/').at(-1)] || {}, Object, JSON, URL });
    return exports;
  };
  const policyExports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../packages/common/src/productPolicy.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: policyExports });
  modules.productPolicy = policyExports;
  modules.scopeSnapshot.snapshotWorkspaceResources = loadWorkspaceModule('scopeSnapshot').snapshotWorkspaceResources;
  modules.cloudCacheArchive = loadWorkspaceModule('cloudCacheArchive');
  modules.cloudCacheRecovery = loadWorkspaceModule('cloudCacheRecovery');
  modules.cloudWorkspaceSync = loadWorkspaceModule('cloudWorkspaceSync');
  const cachePersistence = loadWorkspaceModule('persistence');
  modules.persistence.serializeCloudCacheArchives = cachePersistence.serializeCloudCacheArchives;
  modules.persistence.normalizeCloudCacheArchives = cachePersistence.normalizeCloudCacheArchives;

  const resolveModule = (id) => {
    for (const [key, mod] of Object.entries(modules)) {
      if (id === key || id.endsWith(`/${key}`) || id.endsWith(`@/lib/${key}`)) {
        return mod;
      }
    }
    return require(id);
  };

  vm.runInNewContext(compiled, {
    exports,
    require: resolveModule,
    console,
    crypto: { randomUUID: () => 'test-id' },
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
  }, { filename: 'packages/common/src/store/useApiStore.ts' });

  return exports.useApiStore;
}

function configureRequest(store) {
  store.getState().updateActiveRequest({
    url: 'https://example.com/resource',
    preRequestScript: 'throw new Error("script failed")',
  });
}

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('should not dispatch HTTP when a pre-request script fails', async () => {
  let networkCalls = 0;
  const store = loadStore({
    executePreRequestScript: async () => ({ success: false, error: 'ReferenceError: token is not defined', environment: {}, variables: {} }),
    executeApiRequest: async () => {
      networkCalls += 1;
      throw new Error('HTTP must not run after a failed pre-request script');
    },
  });
  configureRequest(store);

  await store.getState().sendRequest();

  const state = store.getState();
  assert.equal(networkCalls, 0);
  assert.equal(state.isLoading, false);
  assert.equal(state.history.length, 0);
  assert.equal(state.activeResponse?.status, 0);
  assert.equal(state.activeResponse?.isError, true);
  assert.equal(state.activeResponse?.scriptErrorStage, 'pre-request');
  assert.match(state.activeResponse?.scriptError ?? '', /token is not defined/);
});

test('should show a fallback error when a pre-request script fails without details', async () => {
  let networkCalls = 0;
  const store = loadStore({
    executePreRequestScript: async () => ({ success: false, environment: {}, variables: {} }),
    executeApiRequest: async () => {
      networkCalls += 1;
      throw new Error('HTTP must not run after a failed pre-request script');
    },
  });
  configureRequest(store);

  await store.getState().sendRequest();

  assert.equal(networkCalls, 0);
  assert.equal(store.getState().activeResponse?.scriptError, 'The pre-request script failed before the request could be sent.');
});

test('should dispatch HTTP after a successful pre-request script', async () => {
  let networkCalls = 0;
  const store = loadStore({
    executePreRequestScript: async () => ({ success: true, environment: {}, variables: {} }),
    executeApiRequest: async () => {
      networkCalls += 1;
      return {
        status: 200,
        statusText: 'OK',
        timeMs: 1,
        sizeBytes: 2,
        headers: {},
        data: '{}',
        timestamp: Date.now(),
      };
    },
  });
  configureRequest(store);

  await store.getState().sendRequest();

  assert.equal(networkCalls, 1);
  assert.equal(store.getState().activeResponse?.status, 200);
  assert.equal(store.getState().activeResponse?.scriptError, undefined);
});

test('should discard a request result after switching offline workspaces', async () => {
  let resolveRequest;
  let requestSignal;
  const store = loadStore({
    executePreRequestScript: async () => ({ success: true, environment: {}, variables: {} }),
    executeApiRequest: async (_request, _variables, signal) => {
      requestSignal = signal;
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    },
  });
  configureRequest(store);
  const sourceWorkspaceId = store.getState().activeOfflineWorkspaceId;

  const pendingRequest = store.getState().sendRequest();
  await nextTask();
  store.getState().createOfflineWorkspace('Second workspace');
  assert.equal(requestSignal?.aborted, true);

  resolveRequest({
    status: 200,
    statusText: 'OK',
    timeMs: 1,
    sizeBytes: 2,
    headers: {},
    data: '{}',
    timestamp: Date.now(),
  });
  await pendingRequest;

  assert.equal(store.getState().history.length, 0);
  assert.equal(store.getState().activeResponse, null);
  assert.equal(store.getState().offlineScopeCache[sourceWorkspaceId].history.length, 0);
});

test('should discard a cloud pull result after logout', async () => {
  let resolveCollections;
  const store = loadStore({
    executePreRequestScript: async () => ({ success: true, environment: {}, variables: {} }),
    executeApiRequest: async () => {
      throw new Error('not used');
    },
    cloudApi: {
      fetchScopeCollections: () => new Promise((resolve) => {
        resolveCollections = resolve;
      }),
      fetchScopeEnvironments: async () => [],
      fetchCollectionById: async () => ({ id: 'collection-1', name: 'Cloud collection', items: [] }),
    },
    isOfflineOnly: false,
  });
  store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'https://example.com',
      token: 'access-token',
      activeScope: { type: 'workspace', id: 'workspace-1', name: 'Workspace' },
    },
    collections: [],
  });

  const pendingPull = store.getState().pullCloudDelta();
  await nextTask();
  store.getState().logoutCloud();
  resolveCollections([{ id: 'collection-1', name: 'Cloud collection', version: 1 }]);
  await pendingPull;

  assert.equal(store.getState().workspaceMode, 'offline');
  assert.equal(store.getState().cloudConfig.token, undefined);
  assert.equal(store.getState().collections.length, 0);
});

test('should retry incomplete collection details when metadata is unchanged', async () => {
  let detailCalls = 0;
  const store = loadStore({
    executePreRequestScript: async () => ({ success: true, environment: {}, variables: {} }),
    executeApiRequest: async () => {
      throw new Error('not used');
    },
    cloudApi: {
      fetchScopeCollections: async () => [{
        id: 'collection-1',
        name: 'Cloud collection',
        min_role: 'admin',
        version: 2,
        updated_at: '2030-01-01T00:00:00.000Z',
      }],
      fetchCollectionById: async () => {
        detailCalls += 1;
        throw new Error('temporary detail failure');
      },
      fetchScopeEnvironments: async () => [],
    },
    isOfflineOnly: false,
  });
  store.getState();
  await new Promise((resolve) => setImmediate(resolve));
  store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'https://example.com',
      token: 'access-token',
      activeScope: { type: 'workspace', id: 'workspace-1', name: 'Workspace' },
    },
    collections: [],
  });

  await store.getState().pullCloudDelta();
  await store.getState().pullCloudDelta();

  const collection = store.getState().collections[0];
  assert.equal(detailCalls, 2);
  assert.equal(collection.isPartial, true);
  assert.equal(collection.minRole, 'admin');
  assert.equal(collection.version, undefined);
});

test('should not retry an environment write after an OCC conflict', async () => {
  let updateCalls = 0;
  const store = loadStore({
    executePreRequestScript: async () => ({ success: true, environment: {}, variables: {} }),
    executeApiRequest: async () => {
      throw new Error('not used');
    },
    cloudApi: {
      updateScopeEnvironment: async () => {
        updateCalls += 1;
        const error = new Error('conflict');
        error.status = 409;
        error.data = { version: 2 };
        throw error;
      },
    },
    isOfflineOnly: false,
  });
  store.getState();
  await new Promise((resolve) => setImmediate(resolve));
  store.setState({
    workspaceMode: 'cloud',
    cloudConfig: { apiUrl: 'https://example.com', token: 'access-token' },
    environments: [{
      id: 'environment-1',
      name: 'Environment',
      variables: [],
      minRole: 'reader',
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    }],
  });

  store.getState().updateEnvironment('environment-1', { name: 'Changed name' });
  await new Promise((resolve) => setTimeout(resolve, 1300));

  assert.equal(updateCalls, 1);
  assert.equal(store.getState().syncStatus, 'error');
  assert.match(store.getState().syncError ?? '', /conflict/i);
});

test('persists attachment metadata without serializing invalid file handles', () => {
  const store = loadStore({
    executePreRequestScript: async () => ({ success: true, environment: {}, variables: {} }),
    executeApiRequest: async () => {
      throw new Error('not used');
    },
  });
  const tab = store.getState().tabs[0];
  store.setState({
    tabs: [{
      ...tab,
      bodyType: 'form-data',
      bodyFormData: [{
        id: 'file-1',
        key: 'upload',
        value: 'report.csv',
        type: 'file',
        enabled: true,
        file: {},
      }],
      bodyBinaryFile: { name: 'archive.zip', size: 42, type: 'application/zip', file: {} },
    }],
  });

  const persisted = store.persist.getOptions().partialize(store.getState());
  const savedTab = persisted.tabs[0];
  assert.equal(savedTab.bodyFormData[0].file, undefined);
  assert.equal(savedTab.bodyFormData[0].fileName, 'report.csv');
  assert.equal(savedTab.bodyFormData[0].needsReselection, true);
  assert.equal(savedTab.bodyBinaryFile.file, undefined);
  assert.equal(savedTab.bodyBinaryFile.needsReselection, true);
});

test('requires an explicit OCC choice before resubmitting an environment draft', async () => {
  const payloads = [];
  let updateCalls = 0;
  const store = loadStore({
    executePreRequestScript: async () => ({ success: true, environment: {}, variables: {} }),
    executeApiRequest: async () => { throw new Error('not used'); },
    isOfflineOnly: false,
    cloudApi: {
      updateScopeEnvironment: async (_apiUrl, _token, _id, payload) => {
        payloads.push(payload);
        updateCalls += 1;
        if (updateCalls === 1) {
          const error = new Error('conflict');
          error.status = 409;
          error.data = {
            id: 'environment-1', name: 'Server environment', variables: [], version: 2,
            created_at: '2030-01-01T00:00:00.000Z', updated_at: '2030-01-01T00:00:00.000Z',
          };
          throw error;
        }
        return { version: 3 };
      },
    },
  });
  store.getState();
  await new Promise((resolve) => setImmediate(resolve));
  store.setState({
    workspaceMode: 'cloud',
    cloudConfig: { apiUrl: 'https://example.com', token: 'access-token', activeScope: { type: 'workspace', id: 'workspace-1', name: 'Workspace' } },
    environments: [{ id: 'environment-1', name: 'Local environment', variables: [], version: 1, createdAt: 1, updatedAt: 1 }],
  });

  await assert.rejects(store.getState().replaceEnvironment('environment-1', {
    id: 'environment-1', name: 'Local draft', variables: [], version: 1, createdAt: 1, updatedAt: 1,
  }));
  assert.equal(store.getState().environmentOccConflict?.remote.version, 2);
  assert.equal(updateCalls, 1);

  await store.getState().overwriteEnvironmentOccConflict();
  assert.equal(updateCalls, 2);
  assert.equal(payloads[1].base_version, 2);
  assert.equal(store.getState().environmentOccConflict, null);
  assert.equal(store.getState().environments[0].version, 3);
});

function loadSandboxRunner(domEnv = {}) {
  const protoSrc = fs.readFileSync(new URL('../packages/common/src/lib/scriptProtocol.ts', import.meta.url), 'utf8');
  const protoCompiled = ts.transpileModule(protoSrc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const protoExports = {};
  vm.runInNewContext(protoCompiled, { exports: protoExports, console, TextEncoder }, { filename: 'scriptProtocol.ts' });

  const runnerSrc = fs.readFileSync(new URL('../packages/common/src/lib/scriptRunner.ts', import.meta.url), 'utf8');
  const runnerCompiled = ts.transpileModule(runnerSrc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const runnerExports = {};

  vm.runInNewContext(runnerCompiled, {
    exports: runnerExports,
    require: (id) => {
      if (id === './scriptProtocol' || id === '../lib/scriptProtocol' || id.endsWith('scriptProtocol')) {
        return protoExports;
      }
      return require(id);
    },
    console,
    Date,
    JSON,
    Math,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) },
    ...domEnv,
  }, { filename: 'scriptRunner.ts' });

  return {
    ...runnerExports,
    protoExports,
  };
}

test('T-S2 (S2): runScriptInSandbox ignores MessageEvent from foreign sources and accepts matching iframe source', async () => {
  let postedMessage = null;
  const messageListeners = [];
  const mockContentWindow = {
    postMessage: (data) => {
      postedMessage = data;
    },
  };
  let removed = false;
  const mockIframe = {
    style: {},
    src: '',
    contentWindow: mockContentWindow,
    remove: () => {
      removed = true;
    },
    onload: null,
  };
  const mockDocument = {
    createElement: (tag) => {
      if (tag === 'iframe') return mockIframe;
      return {};
    },
    body: {
      appendChild: (el) => {
        if (el.onload) el.onload();
      },
    },
  };
  const mockWindow = {
    addEventListener: (type, fn) => {
      if (type === 'message') messageListeners.push(fn);
    },
    removeEventListener: (type, fn) => {
      const idx = messageListeners.indexOf(fn);
      if (idx !== -1) messageListeners.splice(idx, 1);
    },
  };

  const { runScriptInSandbox } = loadSandboxRunner({
    document: mockDocument,
    window: mockWindow,
  });

  const runPromise = runScriptInSandbox('pm.environment.set("k", "v")', undefined, { initial: 'yes' }, {});

  // Wait for postMessage to be dispatched
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(postedMessage, 'Script runner must post message to iframe content window');

  // 1. Dispatch forged message from a foreign source (e.g. another window or iframe)
  const foreignSource = { postMessage: () => {} };
  for (const listener of [...messageListeners]) {
    listener({
      source: foreignSource,
      data: {
        id: postedMessage.id,
        success: true,
        environment: { forged: 'true' },
        variables: {},
      },
    });
  }

  // Ensure foreign message was ignored and runner did not resolve
  let resolvedEarly = false;
  runPromise.then(() => { resolvedEarly = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(resolvedEarly, false, 'Message from foreign source must be strictly ignored');

  // 2. Dispatch valid message from the actual iframe content window with matching ID
  for (const listener of [...messageListeners]) {
    listener({
      source: mockContentWindow,
      data: {
        id: postedMessage.id,
        success: true,
        environment: { initial: 'yes', k: 'v' },
        variables: {},
      },
    });
  }

  const result = await runPromise;
  assert.equal(result.success, true);
  assert.equal(result.environment.k, 'v');
  assert.equal(result.environment.forged, undefined);
  assert.equal(removed, false);
});

test('T-S2 (C3): runScriptInSandbox tears down hanging iframe from DOM on timeout', async () => {
  let removed = false;
  const mockContentWindow = { postMessage: () => {} };
  const mockIframe = {
    style: {},
    src: '',
    contentWindow: mockContentWindow,
    remove: () => {
      removed = true;
    },
    onload: null,
  };
  const mockDocument = {
    createElement: (tag) => {
      if (tag === 'iframe') return mockIframe;
      return {};
    },
    body: {
      appendChild: (el) => {
        if (el.onload) el.onload();
      },
    },
  };
  const messageListeners = [];
  const mockWindow = {
    addEventListener: (type, fn) => {
      if (type === 'message') messageListeners.push(fn);
    },
    removeEventListener: (type, fn) => {
      const idx = messageListeners.indexOf(fn);
      if (idx !== -1) messageListeners.splice(idx, 1);
    },
  };

  let timerFn = null;
  const customSetTimeout = (fn, ms) => {
    if (ms === 2000) {
      timerFn = fn;
      return 12345;
    }
    return setTimeout(fn, ms);
  };

  const { runScriptInSandbox } = loadSandboxRunner({
    document: mockDocument,
    window: mockWindow,
    setTimeout: customSetTimeout,
  });

  const runPromise = runScriptInSandbox('while(true){}', undefined, { envKey: 'val' }, {});
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(timerFn, 'Timeout handler must be registered');
  assert.equal(removed, false, 'Iframe should not be removed before timeout');

  // Trigger timeout (simulating 2000ms expiration while iframe is frozen in while(true){})
  timerFn();

  const result = await runPromise;
  assert.equal(result.success, false);
  assert.match(result.error, /timed out after 2000ms/i);
  assert.equal(removed, true, 'Hanging iframe must be removed from DOM via iframe.remove()');
  assert.equal(result.environment.envKey, 'val');
});

function loadResponseViewerHelpers(filePath) {
  const source = fs.readFileSync(new URL(filePath, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  const mockModules = {
    'react': { useState: () => [], useEffect: () => {}, useMemo: () => ({}), useRef: () => ({}) },
    'lucide-react': new Proxy({}, { get: () => () => null }),
    'prismjs': {},
    '@/lib/utils': { cn: (...args) => args.join(' ') },
    '../lib/utils': { cn: (...args) => args.join(' ') },
  };
  const sandbox = {
    require: (id) => mockModules[id] || {},
    exports,
    module: { exports },
    console,
    decodeURIComponent,
  };
  vm.createContext(sandbox);
  vm.runInContext(compiled, sandbox);
  return exports;
}

test('T-C1 (C1): safeDecodeURIComponent and getFileNameFromHeaders handle malformed URI in Content-Disposition', () => {
  for (const file of ['../packages/common/src/components/ResponseViewer.tsx']) {
    const helpers = loadResponseViewerHelpers(file);
    const { safeDecodeURIComponent, getFileNameFromHeaders } = helpers;

    assert.equal(typeof safeDecodeURIComponent, 'function', `${file} must export safeDecodeURIComponent`);
    assert.equal(typeof getFileNameFromHeaders, 'function', `${file} must export getFileNameFromHeaders`);

    // Valid percent-encoded filename
    assert.equal(
      getFileNameFromHeaders({ 'content-disposition': 'attachment; filename="data%20export.csv"' }, '.csv'),
      'data export.csv',
      'Should decode valid percent-encoding'
    );

    // Malformed percent-encoding with standalone percent (would throw URIError with naked decodeURIComponent)
    assert.equal(
      getFileNameFromHeaders({ 'content-disposition': 'attachment; filename="report_100%.pdf"' }, '.pdf'),
      'report_100%.pdf',
      'Should gracefully retain raw string when URI decoding fails'
    );

    // Incomplete multibyte percent encoding
    assert.equal(
      getFileNameFromHeaders({ 'Content-Disposition': 'inline; filename="bad_%E0%A4%A_encoding.txt"' }, '.txt'),
      'bad_%E0%A4%A_encoding.txt',
      'Should gracefully handle invalid UTF-8 sequence'
    );

    // Fallback when Content-Disposition is absent
    const defaultName = getFileNameFromHeaders({}, '.json');
    assert.match(defaultName, /^response-\d+\.json$/, 'Should generate timestamped default name');
  }
});

function loadExtensionRuntime(domEnv = {}) {
  const protoSrc = fs.readFileSync(new URL('../packages/common/src/lib/scriptProtocol.ts', import.meta.url), 'utf8');
  const protoExports = {};
  vm.runInNewContext(
    ts.transpileModule(protoSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports: protoExports, console, TextEncoder },
    { filename: 'scriptProtocol.ts' }
  );

  const runnerSrc = fs.readFileSync(new URL('../packages/common/src/lib/scriptRunner.ts', import.meta.url), 'utf8');
  const runnerExports = {};
  vm.runInNewContext(
    ts.transpileModule(runnerSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    {
      exports: runnerExports,
      require: (id) => (id.includes('scriptProtocol') ? protoExports : require(id)),
      console,
      Date,
      JSON,
      Math,
      Promise,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      crypto: { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) },
      ...domEnv,
    },
    { filename: 'scriptRunner.ts' }
  );

  const commonMock = {
    ...runnerExports,
    hasHostPermission: async () => true,
    requestHostPermission: async () => true,
    categorizeNetworkError: () => 'other',
  };

  const adapterSrc = fs.readFileSync(new URL('../apps/extension/src/adapters/chromeAdapter.ts', import.meta.url), 'utf8');
  const adapterExports = {};
  vm.runInNewContext(
    ts.transpileModule(adapterSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    {
      exports: adapterExports,
      require: (id) => (id === '@airrest/common' || id === '@airrest/common/platform' ? commonMock : require(id)),
      fetch: () => {},
      Blob: class {},
      URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
      document: domEnv.document || {},
    },
    { filename: 'chromeAdapter.ts' }
  );

  const runtimeSrc = fs.readFileSync(new URL('../packages/common/src/runtime.ts', import.meta.url), 'utf8');
  const runtimeExports = {};
  vm.runInNewContext(
    ts.transpileModule(runtimeSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    {
      exports: runtimeExports,
      require: (id) => {
        if (id.includes('useApiStore')) {
          let s = {};
          return {
            createApiStore: () => ({ getState: () => s, setState: (v) => { s = { ...s, ...v }; }, subscribe: () => () => {}, dispose: () => {} }),
            setActiveRuntimeStore: () => {},
            getActiveRuntimeStore: () => null,
          };
        }
        if (id.includes('cloudApi')) {
          return {
            setCloudTransport: () => {},
            getCloudTransport: () => null,
            createCloudClient: () => ({
              loginUser: async () => { throw new Error('not configured'); },
              getTransport: () => null,
              setTransport: () => {},
              registerTokenRefreshCallback: () => () => {},
              registerAuthEvictedCallback: () => () => {},
              dispose: () => {},
            }),
            registerTokenRefreshCallback: () => () => {},
            registerAuthEvictedCallback: () => () => {},
          };
        }
        if (id.includes('scriptRunner')) return runnerExports;
        if (id.includes('cloudSession')) return { isCloudSessionActive: (config) => Boolean(config.token || (config.sessionKind === 'provider' && config.user?.id)) };
        if (id.includes('fetcher')) return { setDefaultPlatformAdapter: () => {}, getDefaultPlatformAdapter: () => null };
        if (id.includes('distributionConfig')) return { validateApplicationDistributionConfig: (config) => config };
        if (id.includes('productPolicy')) {
          return { createProductPolicy: (edition) => ({ edition, workspace: { cloud: edition !== 'offline' } }) };
        }
        if (id.includes('passwordAuthProvider')) {
          return { createPasswordAuthProvider: () => ({ id: 'password', capabilities: {}, signIn: async () => { throw new Error('not configured'); } }) };
        }
        return require(id);
      },
    },
    { filename: 'runtime.ts' }
  );

  return {
    runnerExports,
    adapterExports,
    runtimeExports,
  };
}

test('T-VN1 (V-NEW-1): createAirrestRuntime with chromeAdapter executes pre-request and post-response scripts without infinite recursion', async () => {
  let postedMessage = null;
  const messageListeners = [];
  const mockContentWindow = {
    postMessage: (data) => {
      postedMessage = data;
    },
  };
  let removed = false;
  const mockIframe = {
    style: {},
    src: '',
    contentWindow: mockContentWindow,
    remove: () => {
      removed = true;
    },
    onload: null,
  };
  const mockDocument = {
    createElement: (tag) => {
      if (tag === 'iframe') return mockIframe;
      return {};
    },
    body: {
      appendChild: (el) => {
        if (el.onload) el.onload();
      },
    },
  };
  const mockWindow = {
    addEventListener: (type, fn) => {
      if (type === 'message') messageListeners.push(fn);
    },
    removeEventListener: (type, fn) => {
      const idx = messageListeners.indexOf(fn);
      if (idx !== -1) messageListeners.splice(idx, 1);
    },
  };

  const { runnerExports, adapterExports, runtimeExports } = loadExtensionRuntime({
    document: mockDocument,
    window: mockWindow,
  });

  const { chromeAdapter } = adapterExports;
  const { createAirrestRuntime } = runtimeExports;
  const { executePreRequestScript, executePostResponseScript } = runnerExports;

  const runtime = createAirrestRuntime({ adapter: chromeAdapter });

  // 1. Execute pre-request script via runnerExports.executePreRequestScript
  const prePromise = executePreRequestScript('pm.environment.set("token", "abc")', { envVar: '1' }, { reqVar: '2' });
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(postedMessage, 'Must post message to iframe');
  assert.equal(postedMessage.script, 'pm.environment.set("token", "abc")');

  // Respond with simulated sandbox execution result
  for (const listener of [...messageListeners]) {
    listener({
      source: mockContentWindow,
      data: {
        id: postedMessage.id,
        success: true,
        environment: { envVar: '1', token: 'abc' },
        variables: { reqVar: '2' },
      },
    });
  }

  const preResult = await prePromise;
  assert.equal(preResult.success, true);
  assert.equal(preResult.environment.token, 'abc');

  // 2. Execute post-response script
  postedMessage = null;
  const postPromise = executePostResponseScript(
    'pm.test("status is 200", () => {})',
    { status: 200, statusText: 'OK', headers: {}, data: '{"ok":true}', timeMs: 42 },
    preResult.environment,
    preResult.variables
  );
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(postedMessage, 'Must post message to iframe for post-response script');
  assert.equal(postedMessage.response.status, 200);

  for (const listener of [...messageListeners]) {
    listener({
      source: mockContentWindow,
      data: {
        id: postedMessage.id,
        success: true,
        environment: { envVar: '1', token: 'abc', extracted: 'yes' },
        variables: { reqVar: '2' },
      },
    });
  }

  const postResult = await postPromise;
  assert.equal(postResult.success, true);
  assert.equal(postResult.environment.extracted, 'yes');

  // 3. Verify clean disposal
  runtime.dispose();
  assert.equal(removed, true, 'runtime.dispose() must tear down sandbox iframe');
});

test('T-EXT-CSP: manifest.json and sandbox.html CSP hardening & prototype isolation', async () => {
  // 1. Verify manifest.json CSP
  const manifestRaw = fs.readFileSync(new URL('../apps/extension/public/manifest.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  assert.ok(manifest.content_security_policy, 'manifest.json must define content_security_policy');
  assert.match(manifest.content_security_policy.sandbox, /default-src\s+'none'/);
  assert.match(manifest.content_security_policy.sandbox, /sandbox\s+allow-scripts/);
  assert.match(manifest.content_security_policy.extension_pages, /object-src\s+'none'/);

  // 2. Verify sandbox.html CSP meta tag
  const sandboxHtml = fs.readFileSync(new URL('../apps/extension/public/sandbox.html', import.meta.url), 'utf8');
  assert.match(sandboxHtml, /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*default-src\s+'none'[^"]*"/i);

  // 3. Verify scriptRunner sets sandbox attribute
  const runnerSource = fs.readFileSync(new URL('../packages/common/src/lib/scriptRunner.ts', import.meta.url), 'utf8');
  assert.match(runnerSource, /setAttribute\(\s*['"]sandbox['"]\s*,\s*['"]allow-scripts['"]\s*\)/);

  // 4. Verify prototype isolation in sandbox execution
  let messageHandler = null;
  const mockSandboxWindow = {
    addEventListener: (type, fn) => {
      if (type === 'message') messageHandler = fn;
    },
    removeEventListener: () => {},
  };
  const mockParent = {
    postMessage: (data) => {
      mockParent.lastData = data;
    },
    lastData: null,
  };

  const scriptMatch = sandboxHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'sandbox.html must contain script tag');

  const sandboxContext = {
    window: mockSandboxWindow,
    document: {},
    console,
    Date,
    JSON,
    Object,
    String,
    Function,
    Error,
  };
  mockSandboxWindow.parent = mockParent;

  vm.createContext(sandboxContext);
  vm.runInContext(scriptMatch[1], sandboxContext);

  assert.ok(messageHandler, 'sandbox.html must register message event listener');

  // Trigger execution querying Object.prototype properties ('toString', 'valueOf', 'constructor')
  const testId = 'test-proto-isolation';
  messageHandler({
    source: mockParent,
    origin: 'chrome-extension://test-extension-id',
    data: {
      id: testId,
      script: `
        pm.test('Prototype isolation', () => {
          pm.expect(pm.variables.get('toString')).to.be(undefined);
          pm.expect(pm.environment.get('valueOf')).to.be(undefined);
          pm.expect(postman.getGlobalVariable('constructor')).to.be(undefined);
          pm.environment.set('custom', 'ok');
        });
      `,
      environment: {},
      variables: {},
    },
  });

  assert.ok(mockParent.lastData, 'Sandbox must reply to parent window');
  assert.equal(mockParent.lastData.id, testId);
  assert.equal(mockParent.lastData.success, true, `Script should pass without prototype pollution: ${mockParent.lastData.error}`);
  assert.equal(mockParent.lastData.environment.custom, 'ok');
});

test('T-EXT-SANDBOX: reserved sandbox parameter redeclaration explains how to fix it', () => {
  const sandboxHtml = fs.readFileSync(new URL('../apps/extension/public/sandbox.html', import.meta.url), 'utf8');
  const scriptMatch = sandboxHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'sandbox.html must contain script tag');

  let messageHandler = null;
  const mockSandboxWindow = {
    addEventListener: (type, fn) => {
      if (type === 'message') messageHandler = fn;
    },
  };
  const mockParent = {
    postMessage: (data) => {
      mockParent.lastData = data;
    },
    lastData: null,
  };
  mockSandboxWindow.parent = mockParent;

  const sandboxContext = vm.createContext({
    window: mockSandboxWindow,
    location: { protocol: 'chrome-extension:', hostname: '' },
    JSON,
    Object,
    String,
    Function,
    Error,
    RegExp,
  });
  vm.runInContext(scriptMatch[1], sandboxContext);

  assert.equal(typeof messageHandler, 'function');
  messageHandler({
    source: mockParent,
    origin: 'chrome-extension://test-extension-id',
    data: {
      id: 'reserved-parameter-error',
      script: 'const response = pm.response.json();',
      response: { status: 200, statusText: 'OK', headers: {}, data: '{}' },
    },
  });

  assert.equal(mockParent.lastData.success, false);
  assert.match(mockParent.lastData.error, /Parameter 'response' is already used by the internal sandbox/);
  assert.match(mockParent.lastData.error, /responseJson/);
});
