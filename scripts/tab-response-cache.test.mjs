import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function loadStore({ executeApiRequest = async () => ({ status: 200, statusText: 'OK', data: '{"ok":true}', timeMs: 50, sizeBytes: 10, headers: {} }), cloudClient, storage, productPolicy } = {}) {
  const source = fs
    .readFileSync(new URL('../packages/common/src/store/useApiStore.ts', import.meta.url), 'utf8')
    .replaceAll('import.meta.env', '({})');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const appStorage = storage || {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  };
  const noop = () => {};
  const modules = {
    'storage': { appStorage },
    'blobManager': { revokeBlobUrl: noop, revokeBlobUrls: noop },
    'fetcher': { executeApiRequest },
    'scriptRunner': {
      executePreRequestScript: async () => ({ success: true, environment: {}, variables: {} }),
      executePostResponseScript: async () => ({ success: true, environment: {}, variables: {} }),
    },
    'postman': { importPostmanCollection: noop, importPostmanEnvironment: noop, detectPostmanJsonType: noop },
    'urlParams': { parseQueryParamsFromUrl: () => [], parsePathVariablesFromUrl: () => [], buildUrlWithParams: (u) => u },
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
      snapshotWorkspaceResources: (resources, lastSyncedAt) => ({ ...resources, ...(lastSyncedAt !== undefined ? { lastSyncedAt } : {}) }),
      createEmptyWorkspaceSnapshot: (createInitialTab) => {
        const initialTab = createInitialTab();
        return { collections: [], environments: [], activeEnvironmentId: null, tabs: [initialTab], activeTabId: initialTab.id, history: [] };
      },
      restoreWorkspaceResources: (snapshot, createInitialTab) => {
        const source = snapshot || (() => {
          const tab = createInitialTab();
          return { collections: [], environments: [], activeEnvironmentId: null, tabs: [tab], activeTabId: tab.id, history: [] };
        })();
        const tabs = source.tabs?.length ? source.tabs : [createInitialTab()];
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
            (Object.prototype.hasOwnProperty.call(updates, 'sessionKind') &&
              (updates.sessionKind === 'provider' || updates.sessionKind !== current.sessionKind)) ||
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
      normalizeCloudApiUrl: (url) => url,
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
    'edition': { defaultProductPolicy: { workspace: { cloud: false } } },
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
  const requestDiff = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../packages/common/src/lib/requestDiff.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: requestDiff });
  modules.requestDiff = requestDiff;
  modules.cloudDeltaState = loadWorkspaceModule('cloudDeltaState');
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

  let uuidCounter = 0;
  vm.runInNewContext(compiled, {
    exports,
    require: resolveModule,
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
  }, { filename: 'packages/common/src/store/useApiStore.ts' });

  return cloudClient || productPolicy
    ? exports.createApiStore({ storage: appStorage, cloudClient, productPolicy: productPolicy || { edition: 'full', workspace: { cloud: true, offline: true } } })
    : exports.useApiStore;
}

test('cloud-only product rejects offline workspace commands and clears the live view on logout', async () => {
  const productPolicy = { edition: 'cloud', workspace: { cloud: true, offline: false } };
  const store = loadStore({ productPolicy, cloudClient: { fetchFeaturePolicy: async () => ({ revision: 1, flags: {} }) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getState().workspaceMode, 'cloud');
  const existing = store.getState().offlineWorkspaces.length;
  assert.equal(store.getState().createOfflineWorkspace('Disallowed'), '');
  assert.equal(store.getState().duplicateOfflineWorkspace('ws-default-local'), '');
  store.getState().switchOfflineWorkspace('ws-default-local');
  store.getState().setWorkspaceMode('offline');
  await store.getState().setActiveScope({ type: 'offline_workspace', id: 'ws-default-local', name: 'Local' });
  assert.equal(store.getState().workspaceMode, 'cloud');
  assert.equal(store.getState().offlineWorkspaces.length, existing);
  assert.equal(store.getState().recoverCloudCachesToOfflineWorkspaces().success, false);
  assert.equal((await store.getState().moveCollection('unused', { type: 'offline_workspace', id: 'local', name: 'Local' })).success, false);
  store.setState({ cloudConfig: { apiUrl: 'https://example.test', token: 'token', user: { id: 'a' }, activeScope: { type: 'workspace', id: 'a' } },
    collections: [{ id: 'cloud', name: 'Cloud', items: [] }] });
  store.getState().logoutCloud();
  assert.equal(store.getState().workspaceMode, 'cloud');
  assert.equal(store.getState().cloudConfig.token, undefined);
  assert.equal(store.getState().collections.length, 0);
  store.dispose();
});

test('offline-only product cannot switch to cloud through store commands', async () => {
  const store = loadStore({ productPolicy: { edition: 'offline', workspace: { cloud: false, offline: true } } });
  await new Promise((resolve) => setImmediate(resolve));
  store.getState().setWorkspaceMode('cloud');
  await store.getState().setActiveScope({ type: 'workspace', id: 'cloud', name: 'Cloud' });
  assert.equal(store.getState().workspaceMode, 'offline');
  assert.ok(store.getState().createOfflineWorkspace('Local'));
  store.dispose();
});

test('offline-only rejects cloud configuration and workspace commands even with persisted credentials', async () => {
  let calls = 0;
  const cloudClient = {
    createCloudWorkspace: async () => { calls++; }, updateCloudWorkspace: async () => { calls++; },
    deleteCloudWorkspace: async () => { calls++; }, batchImportToScope: async () => { calls++; },
    fetchUserWorkspaces: async () => { calls++; return []; }, fetchUserTeams: async () => { calls++; return []; },
  };
  const store = loadStore({ cloudClient, productPolicy: { edition: 'offline', workspace: { cloud: false, offline: true } } });
  await new Promise((resolve) => setImmediate(resolve));
  store.getState().setCloudConfig({ token: 'new-token', user: { id: 'one' } });
  assert.equal(store.getState().cloudConfig.token, undefined);
  store.setState({ cloudConfig: { apiUrl: 'https://example.test', token: 'old-token', activeScope: { type: 'workspace', id: 'saved' } } });
  assert.equal((await store.getState().createCloudWorkspace('name')).success, false);
  assert.equal((await store.getState().renameCloudWorkspace('saved', 'name')).success, false);
  assert.equal((await store.getState().deleteCloudWorkspace('saved')).success, false);
  assert.equal((await store.getState().importLocalToCloud()).success, false);
  await store.getState().fetchScopes(true);
  assert.equal(calls, 0);
  store.dispose();
});

test('cloud-only hydration hides a previously active offline workspace without deleting it', async () => {
  let saved = null;
  const storage = { getItem: async () => saved, setItem: async (_key, value) => { saved = value; }, removeItem: async () => { saved = null; } };
  const cloudClient = { fetchFeaturePolicy: async () => ({ revision: 1, flags: {} }) };
  const full = loadStore({ storage, cloudClient, productPolicy: { edition: 'full', workspace: { cloud: true, offline: true } } });
  await new Promise((resolve) => setImmediate(resolve));
  const collectionId = full.getState().createCollection('Local data');
  await new Promise((resolve) => setImmediate(resolve));
  full.dispose();
  const cloud = loadStore({ storage, cloudClient, productPolicy: { edition: 'cloud', workspace: { cloud: true, offline: false } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cloud.getState().workspaceMode, 'cloud');
  assert.equal(cloud.getState().collections.some((entry) => entry.id === collectionId), false);
  assert.equal(cloud.getState().offlineScopeCache['ws-default-local'].collections.some((entry) => entry.id === collectionId), true);
  cloud.dispose();
});

test('unknown archive versions survive store restart and can be downloaded without opening them', async () => {
  const future = { version: 2, payload: { pending: [{ id: 'future-draft', secret: 'keep' }] } };
  let saved = JSON.stringify({ state: { cloudCacheArchives: future }, version: 0 });
  const storage = { getItem: async () => saved, setItem: async (_key, value) => { saved = value; }, removeItem: async () => { saved = null; } };
  const policy = { edition: 'full', workspace: { cloud: true, offline: true } };
  const first = loadStore({ storage, productPolicy: policy });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.getState().cloudCacheArchives.unsupportedVersions[0].payload.pending[0].id, 'future-draft');
  assert.equal(first.getState().collections.some((item) => item.id === 'future-draft'), false);
  assert.equal(JSON.parse(first.getState().getCloudCacheRecoveryBackup()).unsupportedArchives[0].payload.pending[0].secret, 'keep');
  first.getState().setHasConfiguredMode(true);
  await new Promise((resolve) => setImmediate(resolve));
  first.dispose();
  const second = loadStore({ storage, productPolicy: policy });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.getState().cloudCacheArchives.unsupportedVersions[0].payload.pending[0].id, 'future-draft');
  assert.equal(second.getState().getCloudCacheRecoveryCount(), 0);
  second.dispose();
});

test('provider session data is archived at rest without restoring an unverified session', async () => {
  let saved = null;
  const storage = { getItem: async () => saved, setItem: async (_key, value) => { saved = value; }, removeItem: async () => { saved = null; } };
  const policy = { edition: 'cloud', workspace: { cloud: true, offline: false } };
  const first = loadStore({ storage, productPolicy: policy });
  await new Promise((resolve) => setImmediate(resolve));
  const owner = JSON.stringify(['https://example.test', 'user-one']);
  first.setState({
    workspaceMode: 'cloud', cloudCacheOwner: owner,
    cloudConfig: { apiUrl: 'https://example.test', sessionKind: 'provider', user: { id: 'user-one' }, activeScope: { type: 'workspace', id: 'shared' } },
    collections: [{ id: 'provider-draft', items: [], _syncStatus: 'pending' }],
    scopeCache: {}, scopesCache: { workspaces: [{ id: 'shared' }], teamsWithProjects: [], lastFetchedAt: 1 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const persisted = JSON.parse(saved).state;
  assert.equal(persisted.cloudConfig.user, undefined);
  assert.equal(persisted.cloudConfig.sessionKind, undefined);
  assert.equal(persisted.collections.length, 0);
  assert.equal(Object.keys(persisted.scopeCache).length, 0);
  assert.equal(persisted.cloudCacheArchives.owners[owner].scopeCache['workspace:shared'].collections[0].id, 'provider-draft');
  first.dispose();
  const second = loadStore({ storage, productPolicy: policy, cloudClient: { fetchFeaturePolicy: async () => ({ revision: 1, flags: {} }) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.getState().cloudConfig.user, undefined);
  assert.equal(second.getState().cloudConfig.sessionKind, undefined);
  assert.equal(second.getState().collections.length, 0);
  assert.equal(second.getState().cloudCacheArchives.owners[owner].scopeCache['workspace:shared'].collections[0]._syncStatus, 'pending');
  const scope = { type: 'workspace', id: 'shared', name: 'Shared' };
  second.getState().setCloudConfig({ sessionKind: 'provider', user: { id: 'other-user' }, activeScope: scope });
  assert.equal(second.getState().collections.some((entry) => entry.id === 'provider-draft'), false);
  second.getState().setCloudConfig({ sessionKind: 'provider', user: { id: 'user-one' }, activeScope: scope });
  assert.equal(second.getState().collections[0].id, 'provider-draft');
  assert.equal(second.getState().collections[0]._syncStatus, 'pending');
  second.dispose();
});

test('store synchronizes an identified provider session without a bearer token', async () => {
  const calls = [];
  const cloudClient = {
    batchImportToScope: async (_url, token, _scope, collections) => { calls.push(['upload', token, collections[0].id]); },
    fetchScopeCollections: async (_url, token) => { calls.push(['collections', token]); return []; },
    fetchScopeEnvironments: async (_url, token) => { calls.push(['environments', token]); return []; },
  };
  const store = loadStore({ cloudClient, productPolicy: { edition: 'cloud', workspace: { cloud: true, offline: false } } });
  await new Promise((resolve) => setImmediate(resolve));
  store.setState({
    workspaceMode: 'cloud', cloudCacheOwner: JSON.stringify(['https://example.test', 'user-one']),
    cloudConfig: { apiUrl: 'https://example.test', sessionKind: 'provider', user: { id: 'user-one' }, activeScope: { type: 'workspace', id: 'shared' } },
    collections: [{ id: 'draft', name: 'Draft', items: [], _syncStatus: 'pending', _origin: 'cloud' }],
  });
  await store.getState().pullCloudDelta();
  assert.deepEqual(calls.map((entry) => entry[0]), ['upload', 'collections', 'environments']);
  assert.ok(calls.every((entry) => entry[1] === undefined));
  assert.equal(store.getState().syncStatus, 'synced');
  store.dispose();
});

test('sync deletion keeps the active request and response, and saving reattaches the tab', async () => {
  const cloudClient = {
    fetchScopeCollections: async () => [],
    fetchScopeEnvironments: async () => [],
    batchImportToScope: async () => {},
  };
  const store = loadStore({ cloudClient });
  await new Promise((resolve) => setImmediate(resolve));
  const request = { ...store.getState().tabs[0], name: 'Example', url: 'https://example.com', bodyContent: 'local edits' };
  const response = { status: 200, data: 'retained response' };
  store.setState({
    workspaceMode: 'cloud',
    cloudConfig: { apiUrl: 'https://example.test', token: 'test-token', activeScope: { type: 'workspace', id: 'shared' } },
    collections: [{ id: 'original', name: 'Original', version: 1, _origin: 'cloud', items: [
      { id: request.id, type: 'request', request: { ...request, bodyContent: 'saved' } },
    ] }],
    tabs: [request], activeTabId: request.id, activeResponse: response, tabResponses: { [request.id]: response },
  });
  store.getState().updateActiveRequest({ name: 'Edited example' });
  await store.getState().pullCloudDelta();
  assert.equal(store.getState().collections.length, 0);
  assert.equal(store.getState().tabs[0].deletedFromCollection, 'Original');
  assert.equal(store.getState().tabs[0].bodyContent, 'local edits');
  assert.equal(store.getState().activeResponse, response);
  assert.equal(store.getState().tabResponses[request.id], response);
  assert.equal(store.getState().saveActiveRequest().isDirectSaved, false);
  store.getState().undoActiveRequest();
  assert.equal(store.getState().tabs[0].name, 'Example');
  assert.equal(store.getState().tabs[0].deletedFromCollection, 'Original');
  store.getState().redoActiveRequest();
  assert.equal(store.getState().tabs[0].name, 'Edited example');
  assert.equal(store.getState().tabs[0].deletedFromCollection, 'Original');
  store.getState().duplicateTab(request.id);
  assert.equal(store.getState().tabs[1].deletedFromCollection, undefined);
  store.getState().setActiveTabId(request.id);
  store.setState({ collections: [{ id: 'destination', name: 'Destination', items: [] }] });
  const target = { ...store.getState().tabs[0], id: 'new-request' };
  store.getState().saveRequestToCollection('destination', null, target);
  const saved = store.getState().collections[0].items[0].request;
  store.getState().updateActiveRequest({ id: saved.id, name: saved.name });
  assert.equal(saved.deletedFromCollection, undefined);
  assert.equal(saved.bodyContent, 'local edits');
  assert.equal(store.getState().tabs[0].deletedFromCollection, undefined);
  assert.equal(store.getState().activeTabId, saved.id);
  assert.equal(store.getState().tabResponses[saved.id], response);
  assert.equal(store.getState().saveActiveRequest().isDirectSaved, true);
  store.dispose();
});

test('failed sync keeps the saved tab unmarked', async () => {
  const store = loadStore({ cloudClient: { fetchScopeCollections: async () => { throw new Error('Offline'); } } });
  await new Promise((resolve) => setImmediate(resolve));
  const request = store.getState().tabs[0];
  store.setState({ workspaceMode: 'cloud', cloudConfig: { apiUrl: 'https://example.test', token: 'test-token', activeScope: { type: 'workspace', id: 'shared' } },
    collections: [{ id: 'original', name: 'Original', version: 1, items: [{ id: request.id, type: 'request', request }] }],
  });
  await store.getState().pullCloudDelta();
  assert.equal(store.getState().syncStatus, 'error');
  assert.equal(store.getState().tabs[0].deletedFromCollection, undefined);
  assert.equal(store.getState().collections.length, 1);
  store.dispose();
});

test('late provider uploads cannot modify a replacement session', async () => {
  let finishUpload;
  const cloudClient = {
    batchImportToScope: () => new Promise((resolve) => { finishUpload = resolve; }),
    fetchFeaturePolicy: async () => ({ revision: 1, flags: {} }),
  };
  const store = loadStore({ cloudClient, productPolicy: { edition: 'cloud', workspace: { cloud: true, offline: false } } });
  await new Promise((resolve) => setImmediate(resolve));
  const scope = { type: 'workspace', id: 'shared', name: 'Shared' };
  store.setState({
    workspaceMode: 'cloud', cloudCacheOwner: JSON.stringify(['https://example.test', 'one']),
    cloudConfig: { apiUrl: 'https://example.test', sessionKind: 'provider', user: { id: 'one' }, activeScope: scope },
    collections: [{ id: 'draft', name: 'Draft', items: [], _syncStatus: 'pending', _origin: 'cloud' }],
  });
  const pending = store.getState().pullCloudDelta();
  await new Promise((resolve) => setImmediate(resolve));
  store.getState().setCloudConfig({ sessionKind: 'provider', user: { id: 'two' }, activeScope: scope });
  finishUpload();
  await pending;
  assert.equal(store.getState().cloudConfig.user.id, 'two');
  assert.equal(store.getState().collections.some((entry) => entry.id === 'draft'), false);
  const firstOwner = JSON.stringify(['https://example.test', 'one']);
  assert.equal(store.getState().cloudCacheArchives.owners[firstOwner].scopeCache['workspace:shared'].collections[0]._syncStatus, 'pending');
  store.dispose();
});

test('provider reauthentication preserves the previous scope and refuses unverified scopes', async () => {
  const cloudClient = { fetchFeaturePolicy: async () => ({ revision: 1, flags: {} }) };
  const store = loadStore({ cloudClient, productPolicy: { edition: 'cloud', workspace: { cloud: true, offline: false } } });
  await new Promise((resolve) => setImmediate(resolve));
  const owner = JSON.stringify(['https://example.test', 'one']);
  const scopeA = { type: 'workspace', id: 'a', name: 'A' };
  const scopeB = { type: 'workspace', id: 'b', name: 'B' };
  store.setState({
    workspaceMode: 'cloud', cloudCacheOwner: owner,
    cloudConfig: { apiUrl: 'https://example.test', sessionKind: 'provider', user: { id: 'one' }, activeScope: scopeA },
    collections: [{ id: 'draft-a', name: 'A', items: [], _syncStatus: 'pending' }],
    scopeCache: {}, scopesCache: { workspaces: [scopeA], teamsWithProjects: [], lastFetchedAt: Date.now() },
  });
  store.getState().setCloudConfig({ sessionKind: 'provider', user: { id: 'one' }, activeScope: scopeB });
  assert.equal(store.getState().collections.some((entry) => entry.id === 'draft-a'), false);
  assert.equal(store.getState().cloudCacheArchives.owners[owner].scopeCache['workspace:a'].collections[0].id, 'draft-a');
  assert.equal(store.getState().scopesCache, undefined);
  await store.getState().setActiveScope(scopeA);
  assert.equal(store.getState().cloudConfig.activeScope.id, 'b');
  assert.match(store.getState().syncError, /not been verified/);
  store.dispose();
});

test('revoked provider project is archived and closed even when the verified project list is empty', async () => {
  const cloudClient = {
    fetchUserWorkspaces: async () => [],
    fetchUserTeams: async () => [{ id: 'team', name: 'Team' }],
    fetchTeamProjects: async () => [],
  };
  const store = loadStore({ cloudClient, productPolicy: { edition: 'cloud', workspace: { cloud: true, offline: false } } });
  await new Promise((resolve) => setImmediate(resolve));
  const owner = JSON.stringify(['https://example.test', 'one']);
  store.setState({
    workspaceMode: 'cloud', cloudCacheOwner: owner,
    cloudConfig: { apiUrl: 'https://example.test', sessionKind: 'provider', user: { id: 'one' }, activeScope: { type: 'project', id: 'project', teamId: 'team', name: 'Project' } },
    collections: [{ id: 'pending', name: 'Pending', items: [], _syncStatus: 'pending' }], scopesCache: undefined,
  });
  await store.getState().fetchScopes(true);
  assert.equal(store.getState().cloudConfig.sessionKind, undefined);
  assert.equal(store.getState().collections.length, 0);
  assert.equal(store.getState().cloudCacheArchives.owners[owner].scopeCache['project:project'].collections[0]._syncStatus, 'pending');
  assert.match(store.getState().syncError, /revoked/);
  store.dispose();
});

test('a failed project-list request does not misclassify access as revoked', async () => {
  const cloudClient = {
    fetchUserWorkspaces: async () => [],
    fetchUserTeams: async () => [{ id: 'team', name: 'Team' }],
    fetchTeamProjects: async () => { throw new Error('network unavailable'); },
  };
  const store = loadStore({ cloudClient, productPolicy: { edition: 'cloud', workspace: { cloud: true, offline: false } } });
  await new Promise((resolve) => setImmediate(resolve));
  store.setState({ cloudConfig: { apiUrl: 'https://example.test', sessionKind: 'provider', user: { id: 'one' }, activeScope: { type: 'project', id: 'project', teamId: 'team', name: 'Project' } }, scopesCache: undefined });
  await store.getState().fetchScopes(true);
  assert.equal(store.getState().cloudConfig.sessionKind, 'provider');
  assert.equal(store.getState().cloudConfig.activeScope.id, 'project');
  store.dispose();
});

test('revoked provider workspace is closed without deleting pending changes', async () => {
  const cloudClient = { fetchUserWorkspaces: async () => [], fetchUserTeams: async () => [] };
  const store = loadStore({ cloudClient, productPolicy: { edition: 'cloud', workspace: { cloud: true, offline: false } } });
  await new Promise((resolve) => setImmediate(resolve));
  const owner = JSON.stringify(['https://example.test', 'one']);
  store.setState({ workspaceMode: 'cloud', cloudCacheOwner: owner,
    cloudConfig: { apiUrl: 'https://example.test', sessionKind: 'provider', user: { id: 'one' }, activeScope: { type: 'workspace', id: 'workspace', name: 'Workspace' } },
    collections: [{ id: 'pending', name: 'Pending', items: [], _syncStatus: 'pending' }], scopesCache: undefined });
  await store.getState().fetchScopes(true);
  assert.equal(store.getState().cloudConfig.sessionKind, undefined);
  assert.equal(store.getState().collections.length, 0);
  assert.equal(store.getState().cloudCacheArchives.owners[owner].scopeCache['workspace:workspace'].collections[0].id, 'pending');
  store.dispose();
});

test('cloud-only closes a revoked project when team discovery returns no project or forbids access', async () => {
  for (const forbidden of [false, true]) {
    const cloudClient = { fetchTeamProjects: async () => {
      if (forbidden) throw Object.assign(new Error('forbidden'), { status: 403 });
      return [];
    } };
    const store = loadStore({ cloudClient, productPolicy: { edition: 'cloud', workspace: { cloud: true, offline: false } } });
    await new Promise((resolve) => setImmediate(resolve));
    const owner = JSON.stringify(['https://example.test', 'one']);
    store.setState({ workspaceMode: 'cloud', cloudCacheOwner: owner,
      cloudConfig: { apiUrl: 'https://example.test', sessionKind: 'provider', user: { id: 'one' }, activeScope: { type: 'project', id: 'project', teamId: 'team', name: 'Project' } },
      collections: [{ id: 'pending', name: 'Pending', items: [], _syncStatus: 'pending' }], scopesCache: undefined });
    await store.getState().fetchProjectsForTeam('team', true);
    assert.equal(store.getState().workspaceMode, 'cloud');
    assert.equal(store.getState().cloudConfig.sessionKind, undefined);
    assert.equal(store.getState().collections.length, 0);
    assert.equal(store.getState().cloudCacheArchives.owners[owner].scopeCache['project:project'].collections[0].id, 'pending');
    assert.match(store.getState().syncError, /sign-in/);
    store.dispose();
  }
});

test('cloud-only provider can select a newly created workspace before the first scope refresh', async () => {
  const cloudClient = {
    createCloudWorkspace: async () => ({ id: 'new-workspace', name: 'Created' }),
    fetchFeaturePolicy: async () => ({ revision: 1, flags: {} }),
    fetchScopeCollections: async () => [], fetchScopeEnvironments: async () => [],
  };
  const store = loadStore({ cloudClient, productPolicy: { edition: 'cloud', workspace: { cloud: true, offline: false } } });
  await new Promise((resolve) => setImmediate(resolve));
  store.setState({ cloudConfig: { apiUrl: 'https://example.test', sessionKind: 'provider', user: { id: 'one' } }, scopesCache: undefined });
  const result = await store.getState().createCloudWorkspace('Created');
  assert.equal(result.success, true);
  assert.equal(store.getState().cloudConfig.activeScope.id, 'new-workspace');
  assert.equal(store.getState().scopesCache.workspaces[0].id, 'new-workspace');
  assert.equal(store.getState().scopesCache.lastFetchedAt, 0);
  store.dispose();
});

test('late cloud workspace mutations do not alter a replacement session', async () => {
  for (const action of ['create', 'rename', 'delete']) {
    let finish;
    let signal;
    const defer = (...args) => { signal = args.at(-1); return new Promise((resolve) => { finish = resolve; }); };
    const cloudClient = { createCloudWorkspace: defer, updateCloudWorkspace: defer, deleteCloudWorkspace: defer,
      fetchFeaturePolicy: async () => ({ revision: 1, flags: {} }) };
    const store = loadStore({ cloudClient, productPolicy: { edition: 'cloud', workspace: { cloud: true, offline: false } } });
    await new Promise((resolve) => setImmediate(resolve));
    const scope = { type: 'workspace', id: 'one-workspace', name: 'One' };
    store.setState({ cloudConfig: { apiUrl: 'https://example.test', sessionKind: 'provider', user: { id: 'one' }, activeScope: scope },
      scopesCache: { workspaces: [{ id: 'one-workspace', name: 'One' }], teamsWithProjects: [], lastFetchedAt: 1 } });
    const pending = action === 'create' ? store.getState().createCloudWorkspace('Created')
      : action === 'rename' ? store.getState().renameCloudWorkspace('one-workspace', 'Renamed')
        : store.getState().deleteCloudWorkspace('one-workspace');
    store.getState().setCloudConfig({ sessionKind: 'provider', user: { id: 'two' }, activeScope: scope });
    assert.equal(signal.aborted, true);
    finish({ id: 'one-workspace', name: 'Renamed' });
    const result = await pending;
    assert.equal(result.success, false);
    assert.equal(store.getState().cloudConfig.user.id, 'two');
    assert.equal(store.getState().scopesCache, undefined);
    store.dispose();
  }
});

test('hydration quarantines a persisted provider marker and its active data', async () => {
  const owner = JSON.stringify(['https://example.test', 'user-one']);
  let saved = JSON.stringify({ version: 0, state: {
    workspaceMode: 'cloud', cloudCacheOwner: owner,
    cloudConfig: { apiUrl: 'https://example.test', sessionKind: 'provider', user: { id: 'user-one' }, activeScope: { type: 'workspace', id: 'shared' } },
    collections: [{ id: 'draft', items: [], _syncStatus: 'pending' }], environments: [], tabs: [], history: [], scopeCache: {},
  } });
  const storage = { getItem: async () => saved, setItem: async (_key, value) => { saved = value; }, removeItem: async () => { saved = null; } };
  const store = loadStore({ storage, productPolicy: { edition: 'cloud', workspace: { cloud: true, offline: false } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getState().cloudConfig.sessionKind, undefined);
  assert.equal(store.getState().cloudConfig.user, undefined);
  assert.equal(store.getState().collections.length, 0);
  assert.equal(store.getState().cloudCacheArchives.owners[owner].scopeCache['workspace:shared'].collections[0].id, 'draft');
  store.dispose();
});

test('legacy cloud data without proven ownership is quarantined on hydration and remains idempotent', async () => {
  let saved = JSON.stringify({ version: 0, state: {
    workspaceMode: 'cloud',
    cloudConfig: { apiUrl: 'https://example.test', token: 'legacy-token', user: { id: 'unverified' }, activeScope: { type: 'workspace', id: 'shared', name: 'Shared' } },
    collections: [{ id: 'legacy-draft', name: 'Draft', items: [], _syncStatus: 'pending' }], environments: [], tabs: [], history: [], scopeCache: {},
  } });
  const storage = { getItem: async () => saved, setItem: async (_key, value) => { saved = value; }, removeItem: async () => { saved = null; } };
  const policy = { edition: 'cloud', workspace: { cloud: true, offline: false } };
  const first = loadStore({ storage, productPolicy: policy });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.getState().cloudConfig.token, undefined);
  assert.equal(first.getState().collections.length, 0);
  assert.equal(first.getState().cloudCacheArchives.unclaimed[0].scopeCache['workspace:shared'].collections[0].id, 'legacy-draft');
  first.getState().setHasConfiguredMode(true);
  await new Promise((resolve) => setImmediate(resolve));
  first.dispose();
  const second = loadStore({ storage, productPolicy: policy });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.getState().cloudCacheArchives.unclaimed.length, 1);
  assert.equal(second.getState().cloudCacheArchives.unclaimed[0].scopeCache['workspace:shared'].collections[0]._syncStatus, 'pending');
  assert.equal(second.getState().collections.length, 0);
  second.dispose();
});

test('switching cloud accounts preserves pending data without exposing it to another account', async () => {
  const cloudClient = { fetchFeaturePolicy: async () => ({ revision: 1, flags: {} }) };
  const store = loadStore({ cloudClient });
  const scope = { type: 'workspace', id: 'shared-id', name: 'Workspace' };
  const pending = { id: 'pending-a', name: 'Pending', items: [], _syncStatus: 'pending', _origin: 'cloud' };
  store.setState({
    workspaceMode: 'cloud',
    cloudConfig: { apiUrl: 'https://example.test', token: 'token-a', user: { id: 'a' }, activeScope: scope },
    cloudCacheOwner: JSON.stringify(['https://example.test', 'a']),
    scopeCache: {}, collections: [pending], environments: [], history: [], lastSyncedAt: Date.now(),
  });

  store.getState().setCloudConfig({ token: 'token-b', user: { id: 'b' }, activeScope: scope });
  assert.equal(store.getState().collections.length, 0);
  assert.equal(Object.keys(store.getState().scopeCache).length, 0);
  const ownerA = JSON.stringify(['https://example.test', 'a']);
  assert.equal(store.getState().cloudCacheArchives.owners[ownerA].scopeCache['workspace:shared-id'].collections[0].id, 'pending-a');

  store.getState().setCloudConfig({ token: 'token-a-new', user: { id: 'a' }, activeScope: scope });
  assert.equal(store.getState().collections[0].id, 'pending-a');
  assert.equal(store.getState().collections[0]._syncStatus, 'pending');
  store.getState().logoutCloud();
  assert.equal(store.getState().collections.some((item) => item.id === 'pending-a'), false);
  assert.equal(store.getState().cloudCacheArchives.owners[ownerA].scopeCache['workspace:shared-id'].collections[0].id, 'pending-a');
  const persisted = store.persist.getOptions().partialize(store.getState());
  assert.equal(persisted.cloudCacheArchives.owners[ownerA].scopeCache['workspace:shared-id'].collections[0].id, 'pending-a');
  store.dispose();
});

test('a pending cloud cache survives logout and restart for its verified owner', async () => {
  let saved = null;
  const storage = { getItem: async () => saved, setItem: async (_key, value) => { saved = value; }, removeItem: async () => { saved = null; } };
  const cloudClient = { fetchFeaturePolicy: async () => ({ revision: 1, flags: {} }) };
  const scope = { type: 'workspace', id: 'workspace-1', name: 'Workspace' };
  const first = loadStore({ cloudClient, storage });
  await new Promise((resolve) => setImmediate(resolve));
  first.setState({ workspaceMode: 'cloud', cloudConfig: { apiUrl: 'https://example.test', token: 'token', user: { id: 'user-1' }, activeScope: scope },
    cloudCacheOwner: JSON.stringify(['https://example.test', 'user-1']),
    collections: [{ id: 'pending', name: 'Pending', items: [], _syncStatus: 'pending', _origin: 'cloud' }], lastSyncedAt: Date.now() });
  first.getState().logoutCloud();
  await new Promise((resolve) => setImmediate(resolve));
  first.dispose();

  const restored = loadStore({ cloudClient, storage });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restored.getState().cloudConfig.token, undefined);
  assert.equal(restored.getState().collections.some((entry) => entry.id === 'pending'), false);
  restored.getState().setCloudConfig({ apiUrl: 'https://example.test', token: 'new-token', user: { id: 'user-1' }, activeScope: scope });
  restored.getState().setWorkspaceMode('cloud');
  assert.equal(restored.getState().collections[0].id, 'pending');
  assert.equal(restored.getState().collections[0]._syncStatus, 'pending');
  restored.dispose();
});

test('legacy cache without an ownership marker is preserved without assuming its owner', () => {
  const store = loadStore({ cloudClient: { fetchFeaturePolicy: async () => ({ revision: 1, flags: {} }) } });
  const scope = { type: 'workspace', id: 'workspace-1', name: 'Workspace' };
  store.setState({ workspaceMode: 'cloud', cloudConfig: { apiUrl: 'https://example.test', token: 'credential-secret-123', user: { id: 'a' }, activeScope: scope },
    cloudCacheOwner: null, collections: [{ id: 'legacy-pending', name: 'Pending', items: [], _syncStatus: 'pending' }],
    environments: [{ id: 'env-1', name: 'Environment', variables: [{ id: 'value', key: 'k', currentValue: 'original', enabled: true }] }] });
  store.getState().logoutCloud();
  const archived = store.getState().cloudCacheArchives;
  assert.equal(archived.unclaimed[0].scopeCache['workspace:workspace-1'].collections[0].id, 'legacy-pending');
  assert.equal(archived.owners[JSON.stringify(['https://example.test', 'a'])], undefined);
  const backup = JSON.parse(store.getState().getCloudCacheRecoveryBackup());
  assert.equal(backup.format, 'AirREST cloud cache recovery');
  assert.equal(backup.archives[0].scopeCache['workspace:workspace-1'].collections[0].id, 'legacy-pending');
  assert.equal(JSON.stringify(backup).includes('credential-secret-123'), false);
  assert.equal(store.getState().cloudCacheArchives.unclaimed.length, 1);
  const recovered = store.getState().recoverCloudCachesToOfflineWorkspaces();
  assert.equal(recovered.success, true);
  assert.equal(recovered.workspaceCount, 1);
  const workspace = store.getState().offlineWorkspaces.find((entry) => entry.name === 'Recovered workspace 1');
  assert.ok(workspace);
  assert.equal(store.getState().offlineScopeCache[workspace.id].collections[0].id, 'legacy-pending');
  assert.equal(store.getState().offlineScopeCache[workspace.id].collections[0]._origin, 'offline');
  assert.equal(store.getState().cloudCacheArchives.unclaimed.length, 1);
  store.getState().offlineScopeCache[workspace.id].collections[0].name = 'Edited copy';
  store.getState().offlineScopeCache[workspace.id].environments[0].variables[0].currentValue = 'edited';
  assert.equal(store.getState().cloudCacheArchives.unclaimed[0].scopeCache['workspace:workspace-1'].collections[0].name, 'Pending');
  assert.equal(store.getState().cloudCacheArchives.unclaimed[0].scopeCache['workspace:workspace-1'].environments[0].variables[0].currentValue, 'original');
  store.dispose();
});

test('an imported recovery backup stays unclaimed until it is explicitly copied to an offline workspace', () => {
  const store = loadStore({ productPolicy: { edition: 'full', workspace: { cloud: true, offline: true } } });
  const backup = JSON.stringify({
    format: 'AirREST cloud cache recovery', version: 1,
    archives: [{ scopeCache: { 'workspace:imported': {
      collections: [{ id: 'imported-draft', name: 'Imported', items: [], _syncStatus: 'pending' }],
      environments: [], tabs: [], history: [],
    } } }],
  });

  const imported = store.getState().importCloudCacheRecoveryBackup(backup);

  assert.equal(imported.success, true);
  assert.equal(store.getState().cloudCacheArchives.unclaimed.length, 1);
  assert.equal(store.getState().collections.some((collection) => collection.id === 'imported-draft'), false);
  const recovered = store.getState().recoverCloudCachesToOfflineWorkspaces();
  assert.equal(recovered.success, true);
  assert.equal(store.getState().offlineWorkspaces.some((workspace) =>
    store.getState().offlineScopeCache[workspace.id]?.collections.some((collection) => collection.id === 'imported-draft'),
  ), true);
  store.dispose();
});

test('changing server clears the previous active scope and retains its pending snapshot', () => {
  const store = loadStore({ cloudClient: { fetchFeaturePolicy: async () => ({ revision: 1, flags: {} }) } });
  const scope = { type: 'workspace', id: 'scope-1', name: 'Workspace' };
  const owner = JSON.stringify(['https://one.example', 'user-1']);
  const otherOwner = JSON.stringify(['https://two.example', 'user-1']);
  store.setState({ workspaceMode: 'cloud', cloudConfig: { apiUrl: 'https://one.example', token: 'token', refreshToken: 'refresh', user: { id: 'user-1' }, activeScope: scope },
    cloudCacheOwner: owner, cloudCacheArchives: { version: 1, unclaimed: [], owners: { [otherOwner]: { scopeCache: { 'workspace:scope-1': { collections: [{ id: 'other-server', name: 'Other', items: [] }] } } } } },
    collections: [{ id: 'pending', name: 'Pending', items: [], _syncStatus: 'pending' }] });
  store.getState().setCloudConfig({ apiUrl: 'https://two.example' });
  assert.equal(store.getState().cloudConfig.activeScope, undefined);
  assert.equal(store.getState().cloudConfig.user, undefined);
  assert.equal(store.getState().cloudConfig.token, undefined);
  assert.equal(store.getState().cloudConfig.refreshToken, undefined);
  assert.equal(store.getState().cloudCacheOwner, null);
  assert.equal(store.getState().collections.length, 0);
  assert.equal(store.getState().cloudCacheArchives.owners[owner].scopeCache['workspace:scope-1'].collections[0].id, 'pending');
  assert.equal(store.getState().cloudCacheArchives.owners[otherOwner].scopeCache['workspace:scope-1'].collections[0].id, 'other-server');
  store.getState().setCloudConfig({ user: { id: 'user-1' }, activeScope: scope });
  assert.equal(store.getState().cloudCacheOwner, null);
  assert.equal(store.getState().collections.length, 0);
  store.dispose();
});

test('changing user without new credentials cannot open another user cache', async () => {
  const store = loadStore({ cloudClient: { fetchFeaturePolicy: async () => ({ revision: 1, flags: {} }) } });
  await new Promise((resolve) => setImmediate(resolve));
  const scope = { type: 'workspace', id: 'shared', name: 'Shared' };
  const firstOwner = JSON.stringify(['https://example.test', 'one']);
  const secondOwner = JSON.stringify(['https://example.test', 'two']);
  store.setState({ workspaceMode: 'cloud', cloudCacheOwner: firstOwner,
    cloudConfig: { apiUrl: 'https://example.test', token: 'one-token', refreshToken: 'one-refresh', user: { id: 'one' }, activeScope: scope },
    cloudCacheArchives: { version: 1, unclaimed: [], owners: { [secondOwner]: { scopeCache: { 'workspace:shared': { collections: [{ id: 'two-draft', items: [] }] } } } } },
    collections: [{ id: 'one-draft', items: [], _syncStatus: 'pending' }] });
  store.getState().setCloudConfig({ user: { id: 'two' }, activeScope: scope });
  assert.equal(store.getState().cloudConfig.token, undefined);
  assert.equal(store.getState().cloudConfig.refreshToken, undefined);
  assert.equal(store.getState().cloudCacheOwner, null);
  assert.equal(store.getState().collections.length, 0);
  assert.equal(store.getState().cloudCacheArchives.owners[firstOwner].scopeCache['workspace:shared'].collections[0].id, 'one-draft');
  assert.equal(store.getState().cloudCacheArchives.owners[secondOwner].scopeCache['workspace:shared'].collections[0].id, 'two-draft');
  store.dispose();
});

test('feature policy accepts token rotation within a session and rejects results from a previous session', async () => {
  const requests = [];
  const cloudClient = { fetchFeaturePolicy: (_url, _token, _refresh, signal) => new Promise((resolve) => requests.push({ resolve, signal })) };
  const store = loadStore({ cloudClient });
  const policy = { revision: 1, flags: {} };

  store.getState().setCloudConfig({ apiUrl: 'https://example.test', token: 'old', refreshToken: 'refresh', user: { id: 'one' } });
  const generation = store.getState().getCloudSessionGeneration();
  assert.equal(requests.length, 1);
  store.getState().setCloudConfig({ token: 'rotated', refreshToken: 'new-refresh' });
  assert.equal(store.getState().getCloudSessionGeneration(), generation);
  requests[0].resolve(policy);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getState().featurePolicyStatus, 'ready');
  assert.equal(store.getState().featurePolicy.revision, 1);

  const oldRequest = store.getState().refreshFeaturePolicy(true);
  store.getState().setCloudConfig({ token: 'other', user: { id: 'two' } });
  assert.notEqual(store.getState().getCloudSessionGeneration(), generation);
  assert.equal(requests[1].signal.aborted, true);
  assert.equal(requests.length, 3);
  requests[1].resolve({ revision: 2, flags: {} });
  await oldRequest;
  assert.equal(store.getState().featurePolicyStatus, 'loading');
  requests[2].resolve({ revision: 3, flags: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getState().featurePolicy.revision, 3);
  store.dispose();
});

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

test('T-EXT-TAB: switching tabs while sendRequest is in-flight does not overwrite activeResponse on new tab, and deleteOfflineWorkspace does not leak into offlineScopeCache', async () => {
  let resolveReq;
  const reqPromise = new Promise((r) => { resolveReq = r; });
  const store = loadStore({
    executeApiRequest: () => reqPromise,
  });
  store.getState();
  await new Promise((resolve) => setImmediate(resolve));
  const tab1Id = store.getState().activeTabId;
  store.getState().updateActiveRequest({ url: 'https://api.example.com/slow' });

  // Start request on Tab 1
  const pendingSend = store.getState().sendRequest();

  // Switch to Tab 2 before Tab 1 finishes
  store.getState().createTab({ name: 'Tab 2', url: 'https://api.example.com/fast' });
  const tab2Id = store.getState().activeTabId;
  assert.notEqual(tab1Id, tab2Id);

  // Resolve Tab 1 request
  resolveReq({
    status: 200,
    statusText: 'OK',
    data: '{"tab1":true}',
    timeMs: 50,
    sizeBytes: 13,
    headers: {},
    timestamp: Date.now(),
  });
  await pendingSend;

  // Tab 2 is still active, so activeResponse must remain null while Tab 1 response is cached in tabResponses[tab1Id]
  assert.equal(store.getState().activeTabId, tab2Id);
  assert.equal(store.getState().activeResponse, null, 'activeResponse on Tab 2 must not be overwritten by Tab 1 completion');
  assert.equal(store.getState().tabResponses?.[tab1Id]?.data, '{"tab1":true}', 'Tab 1 response must be cached in tabResponses');

  // Verify deleteOfflineWorkspace does not re-snapshot deleted workspace into offlineScopeCache
  const wsId = store.getState().createOfflineWorkspace('Temp Offline Workspace');
  store.getState().switchOfflineWorkspace(wsId);
  assert.equal(store.getState().activeOfflineWorkspaceId, wsId);

  store.getState().deleteOfflineWorkspace(wsId);
  assert.notEqual(store.getState().activeOfflineWorkspaceId, wsId);
  assert.equal(store.getState().offlineScopeCache?.[wsId], undefined, 'Deleted offline workspace must not remain in offlineScopeCache');
});
