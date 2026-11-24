import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function createStoreHarness({ cloudClientOverrides = {}, storage: customStorageOverride, productPolicy } = {}) {
  const memoryStorage = new Map();
  const storage = customStorageOverride || {
    getItem: async (k) => (memoryStorage.has(k) ? memoryStorage.get(k) : null),
    setItem: async (k, v) => { memoryStorage.set(k, v); },
    removeItem: async (k) => { memoryStorage.delete(k); },
  };

  const modules = {};
  const loadTsFile = (absPath, extraGlobals = {}) => {
    if (modules[absPath]) return modules[absPath];
    const source = fs.readFileSync(absPath, 'utf8').replaceAll('import.meta.env', '({})');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const exports = {};
    modules[absPath] = exports;
    const resolveMod = (id) => {
      const base = id.split('/').at(-1);
      if (modules[id]) return modules[id];
      if (modules[base]) return modules[base];
      if (id.startsWith('.')) {
        const candidate = path.resolve(path.dirname(absPath), `${id}.ts`);
        if (fs.existsSync(candidate)) return loadTsFile(candidate, extraGlobals);
      }
      return require(id);
    };
    vm.runInNewContext(compiled, {
      exports,
      require: resolveMod,
      console,
      crypto,
      Date,
      JSON,
      Math,
      Promise,
      AbortController,
      AbortSignal,
      Headers,
      Response,
      Request,
      Blob,
      Set,
      Map,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Error,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
      ...extraGlobals,
    }, { filename: absPath });
    return exports;
  };
  const loadTsModule = (relPath, extraGlobals = {}) =>
    loadTsFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), relPath), extraGlobals);

  const noop = () => {};
  modules.storeContext = loadTsModule('../packages/common/src/store/storeContext.ts');
  modules.storage = {
    appStorage: storage,
    setItemInAllPersistenceCopies: async (k, v) => storage.setItem(k, v),
  };
  modules.nativeCredentials = {
    getNativeCredentialScope: (c) => (c?.apiUrl && c?.user?.id ? { apiUrl: c.apiUrl, userId: c.user.id } : null),
  };
  modules.theme = { applyTheme: noop };
  modules.fetcher = { executeApiRequest: async () => ({ status: 200, statusText: 'OK', data: '{}', timeMs: 1, sizeBytes: 2, headers: {} }) };
  modules.blobManager = { revokeBlobUrl: noop, revokeBlobUrls: noop, releaseRawBody: noop, releaseRawBodies: noop, evictRawBodiesToBudget: () => [] };
  modules.postman = { importPostmanCollection: noop, importPostmanEnvironment: noop, detectPostmanJsonType: noop };
  modules.scriptRunner = { executePreRequestScript: async () => ({ success: true, environment: {}, variables: {} }), executePostResponseScript: async () => ({ success: true, environment: {}, variables: {} }) };
  modules.urlParams = loadTsModule('../packages/common/src/lib/urlParams.ts');
  modules.productPolicy = loadTsModule('../packages/common/src/productPolicy.ts');
  modules.edition = loadTsModule('../packages/common/src/lib/edition.ts');
  modules.jwt = loadTsModule('../packages/common/src/lib/jwt.ts');
  modules.duplicate = loadTsModule('../packages/common/src/lib/duplicate.ts');
  modules.requestDiff = loadTsModule('../packages/common/src/lib/requestDiff.ts');
  modules.treeHelper = loadTsModule('../packages/common/src/lib/treeHelper.ts');
  modules.cloudSyncTransformer = loadTsModule('../packages/common/src/lib/cloudSyncTransformer.ts');
  modules.asyncOperationCoordinator = loadTsModule('../packages/common/src/store/asyncOperationCoordinator.ts');
  modules.scopeCache = loadTsModule('../packages/common/src/workspace/scopeCache.ts');
  modules.scopeSnapshot = loadTsModule('../packages/common/src/workspace/scopeSnapshot.ts');
  modules.cloudSession = loadTsModule('../packages/common/src/workspace/cloudSession.ts');
  modules.cloudScopeTransition = loadTsModule('../packages/common/src/workspace/cloudScopeTransition.ts');
  modules.workspaceModeTransition = loadTsModule('../packages/common/src/workspace/workspaceModeTransition.ts');
  modules.cloudDeltaState = loadTsModule('../packages/common/src/workspace/cloudDeltaState.ts');
  modules.persistence = loadTsModule('../packages/common/src/workspace/persistence.ts');
  modules.cloudCacheArchive = loadTsModule('../packages/common/src/workspace/cloudCacheArchive.ts');
  modules.cloudCollectionSync = loadTsModule('../packages/common/src/workspace/cloudCollectionSync.ts');
  modules.cloudWorkspaceSync = loadTsModule('../packages/common/src/workspace/cloudWorkspaceSync.ts');
  modules.cloudCacheRecovery = loadTsModule('../packages/common/src/workspace/cloudCacheRecovery.ts');
  modules.cloudApi = loadTsModule('../packages/common/src/lib/cloudApi.ts');

  const cloudClient = {
    ...modules.cloudApi.createCloudClient({ enabled: true }),
    fetchFeaturePolicy: async () => ({ flags: { 'collection.move': true, 'collection.delete': true, 'collection.export': true }, revision: 1, updated_at: '2026-11-24T00:00:00Z' }),
    ...cloudClientOverrides,
  };
  modules.cloudApi.CloudApiError = modules.cloudApi.CloudApiError;

  const storeMod = loadTsModule('../packages/common/src/store/useApiStore.ts');
  const createStore = async () => {
    const store = storeMod.createApiStore({
      storage,
      cloudClient,
      productPolicy: productPolicy || { edition: 'full', workspace: { cloud: true, offline: true } },
    });
    await store.persist.rehydrate();
    return store;
  };

  return { createStore, storage, memoryStorage, cloudClient, cloudApiMod: modules.cloudApi, transformer: modules.cloudSyncTransformer };
}

const toPlain = (v) => JSON.parse(JSON.stringify(v));

function makeSampleRequest(id, name, overrides = {}) {
  return {
    id,
    name,
    method: 'GET',
    url: 'https://httpbin.org/get?user=tester&tag=api',
    params: [{ id: 'p1', key: 'user', value: 'tester', enabled: true }],
    pathVariables: [{ id: 'pv1', key: 'id', value: '1', enabled: true }],
    headers: [{ id: 'h1', key: 'Accept', value: 'application/json', enabled: false }],
    auth: { type: 'bearer', bearerToken: 'dummy-tok' },
    bodyType: 'none',
    bodyContent: '',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

test('S01 & S02: offline duplicate works for same/different collections, target folders, and inactive offline workspaces without disturbing tabs/env/history', async () => {
  const { createStore } = createStoreHarness();
  const store = await createStore();
  const ws2Id = store.getState().createOfflineWorkspace('Workspace B');
  store.getState().switchOfflineWorkspace('default');

  const req1 = makeSampleRequest('req-1', 'Get Users');
  const col1 = {
    id: 'col-1',
    name: 'Product APIs',
    items: [
      { id: 'f-1', name: 'V1', type: 'folder', items: [] },
      { id: 'req-1', name: 'Get Users', type: 'request', request: req1 },
    ],
    createdAt: 1000,
    updatedAt: 1000,
    _origin: 'offline',
  };
  const col2 = {
    id: 'col-2',
    name: 'Other APIs',
    items: [{ id: 'f-2', name: 'Target Folder', type: 'folder', items: [] }],
    createdAt: 1000,
    updatedAt: 1000,
    _origin: 'offline',
  };

  store.setState({
    workspaceMode: 'offline',
    collections: [col1, col2],
    tabs: [{ ...req1, url: 'https://httpbin.org/get?draft=unsaved' }],
    activeTabId: req1.id,
    offlineScopeCache: {
      ...store.getState().offlineScopeCache,
      [ws2Id]: {
        collections: [],
        environments: [{ id: 'env-b', name: 'Env B', variables: [], createdAt: 1, updatedAt: 1 }],
        activeEnvironmentId: 'env-b',
        tabs: [makeSampleRequest('tab-b', 'Tab B')],
        activeTabId: 'tab-b',
        history: [{ id: 'hist-b', request: makeSampleRequest('hreq-b', 'Hist B'), timestamp: 5 }],
      },
    },
  });

  // Duplicate request into target folder in same collection -> "Get Users copy"
  const sameRes = await store.getState().duplicateCollectionItem('col-1', 'req-1', 'col-1', 'f-1');
  assert.equal(sameRes.success, true);
  assert.equal(sameRes.name, 'Get Users copy');
  assert.deepEqual(toPlain(sameRes.revealPathIds), ['col-1', 'f-1']);
  const updatedCol1 = store.getState().collections.find((c) => c.id === 'col-1');
  const f1 = updatedCol1.items.find((i) => i.id === 'f-1');
  assert.equal(f1.items.length, 1);
  assert.equal(f1.items[0].name, 'Get Users copy');
  assert.notEqual(f1.items[0].id, 'req-1');
  // Draft tab untouched and saved state used
  assert.equal(store.getState().tabs[0].url, 'https://httpbin.org/get?draft=unsaved');
  assert.equal(f1.items[0].request.url, 'https://httpbin.org/get?user=tester&tag=api');

  // Duplicate folder into another collection's folder -> keeps name
  const diffRes = await store.getState().duplicateCollectionItem('col-1', 'f-1', 'col-2', 'f-2');
  assert.equal(diffRes.success, true);
  assert.equal(diffRes.name, 'V1');
  assert.deepEqual(toPlain(diffRes.revealPathIds), ['col-2', 'f-2', diffRes.createdItemId]);

  // Duplicate collection into inactive Workspace B -> keeps name and preserves Workspace B env/tabs/history
  const wsBRes = await store.getState().duplicateCollection('col-1', { id: ws2Id, name: 'Workspace B', type: 'offline_workspace' });
  assert.equal(wsBRes.success, true);
  assert.equal(wsBRes.name, 'Product APIs');
  const wsBCache = store.getState().offlineScopeCache[ws2Id];
  assert.equal(wsBCache.collections.length, 1);
  assert.equal(wsBCache.collections[0].name, 'Product APIs');
  assert.equal(wsBCache.activeEnvironmentId, 'env-b');
  assert.equal(wsBCache.tabs[0].id, 'tab-b');
  assert.equal(wsBCache.history[0].id, 'hist-b');
});

test('S03, S07, S08 & RR3: offline -> cloud sanitizes attachments, preserves metadata on GET/rehydrate, and retries lost response with immutable intent even after offline edit', async () => {
  let uploadCalls = 0;
  let lastUploadedBody = null;
  let shouldDropFirstReply = true;

  const { createStore, storage, cloudApiMod, transformer } = createStoreHarness({
    cloudClientOverrides: {
      importDuplicateCollection: async (_apiUrl, _token, targetScope, collection, operationId) => {
        uploadCalls += 1;
        lastUploadedBody = { targetScope, collection, operationId };
        if (shouldDropFirstReply) {
          shouldDropFirstReply = false;
          throw new Error('network timeout after commit');
        }
        return {
          operation_id: operationId,
          status: 'committed',
          collection_id: 'cloud-col-1',
          project_id: targetScope.id,
          name: collection.name,
          min_role: 'reader',
          version: 1,
          updated_at: '2026-11-24T00:00:00Z',
          item_count: 1,
        };
      },
      fetchCollectionById: async () => ({
        id: 'cloud-col-1',
        project_id: 'proj-1',
        name: 'Offline Pack',
        min_role: 'reader',
        version: 1,
        created_at: '2026-11-24T00:00:00Z',
        updated_at: '2026-11-24T00:00:00Z',
        items: [{
          id: 'cloud-req-1',
          collection_id: 'cloud-col-1',
          parent_id: null,
          type: 'request',
          name: 'Upload Req',
          sort_order: 0,
          method: 'POST',
          url: 'https://httpbin.org/get?user=tester&tag=api',
          body_type: 'form-data',
          body_form_data: lastUploadedBody.collection.items[0].body_form_data,
        }],
      }),
    },
  });

  // Verify transformer preserves attachment metadata (R4 / S08)
  const built = transformer.buildCollectionFromDetails({
    id: 'c1',
    name: 'Test',
    items: [{
      id: 'r1',
      type: 'request',
      name: 'Req',
      body_type: 'form-data',
      body_form_data: [{ id: 'f1', key: 'doc', type: 'file', value: 'doc.pdf', fileName: 'doc.pdf', fileSize: 512, fileType: 'application/pdf', needsReselection: true, enabled: true }],
    }],
  });
  assert.equal(built.items[0].request.bodyFormData[0].fileName, 'doc.pdf');
  assert.equal(built.items[0].request.bodyFormData[0].fileSize, 512);
  assert.equal(built.items[0].request.bodyFormData[0].fileType, 'application/pdf');
  assert.equal(built.items[0].request.bodyFormData[0].needsReselection, true);

  const store = await createStore();
  const liveFile = { name: 'doc.pdf', size: 512, type: 'application/pdf' };
  const targetProject = { id: 'proj-1', name: 'Proj 1', type: 'project', role: 'contributor' };

  store.setState({
    workspaceMode: 'offline',
    cloudConfig: {
      apiUrl: 'https://api.example.com',
      token: 'tok-alice',
      user: { id: 'alice', email: 'alice@example.com', name: 'Alice', role: 'user' },
    },
    cloudCacheOwner: JSON.stringify(['https://api.example.com', 'alice']),
    scopeCache: {
      'project:proj-1': { collections: [{ id: 'stale', name: 'Stale', items: [], createdAt: 1, updatedAt: 1 }], environments: [], activeEnvironmentId: null, tabs: [], history: [] },
    },
    collections: [{
      id: 'off-col-1',
      name: 'Offline Pack',
      createdAt: 100,
      updatedAt: 100,
      _origin: 'offline',
      items: [{
        id: 'off-req-1',
        name: 'Upload Req',
        type: 'request',
        request: makeSampleRequest('off-req-1', 'Upload Req', {
          method: 'POST',
          bodyType: 'form-data',
          bodyFormData: [{ id: 'fd1', key: 'doc', type: 'file', value: 'doc.pdf', file: liveFile, fileName: 'doc.pdf', fileSize: 512, fileType: 'application/pdf', enabled: true }],
        }),
      }],
    }],
  });

  // First attempt drops reply after server commit -> intent remains persisted
  const firstAttempt = await store.getState().duplicateCollection('off-col-1', targetProject);
  assert.equal(firstAttempt.success, false);
  assert.equal(firstAttempt.reconcilePending, true);
  assert.ok(firstAttempt.operationId);
  const savedOpId = firstAttempt.operationId;
  assert.ok(store.getState().pendingDuplicateIntents[savedOpId]);
  assert.equal(lastUploadedBody.collection.items[0].body_form_data[0].needsReselection, true);
  assert.equal(lastUploadedBody.collection.items[0].body_form_data[0].file, undefined);

  // Edit the offline source collection after submit, then recreate store from persisted storage (restart simulation!)
  store.setState((s) => ({
    collections: s.collections.map((c) => ({ ...c, name: 'MUTATED AFTER SUBMIT' })),
  }));
  await store.getState().persistNativeCredentialState();

  const restartedStore = await createStore();
  assert.ok(restartedStore.getState().pendingDuplicateIntents[savedOpId]);

  const retryRes = await restartedStore.getState().retryPendingDuplicateIntent(savedOpId);
  assert.equal(retryRes.success, true);
  assert.equal(retryRes.operationId, savedOpId);
  assert.equal(retryRes.name, 'Offline Pack'); // Immutable saved intent payload used, NOT 'MUTATED AFTER SUBMIT'
  assert.equal(uploadCalls, 2);
  assert.equal(restartedStore.getState().pendingDuplicateIntents[savedOpId], undefined);
  assert.equal(restartedStore.getState().workspaceMode, 'offline');
  // Stale target cache was invalidated so next visit fetches fresh cloud data
  assert.equal(restartedStore.getState().scopeCache['project:proj-1'], undefined);
  // Active offline collections remain intact
  assert.equal(restartedStore.getState().collections[0].name, 'MUTATED AFTER SUBMIT');
});

test('S04, S05, S06 & RR9: blocks unauthorized/partial/syncing, rejects ABA stale completion, and coordinates concurrent lock', async () => {
  let resolveUpload;
  const { createStore } = createStoreHarness({
    cloudClientOverrides: {
      importDuplicateCollection: () => new Promise((resolve) => { resolveUpload = resolve; }),
      duplicateScopeItem: () => new Promise((resolve) => {
        setTimeout(() => resolve({
          operation_id: 'op-item',
          status: 'committed',
          root_item_id: 'new-item',
          target_collection_id: 'col-1',
          target_parent_id: null,
          target_collection_version: 2,
          name: 'Req copy',
          item_count: 1,
        }), 30);
      }),
      fetchCollectionById: async () => ({
        id: 'col-1',
        name: 'Col 1',
        min_role: 'contributor',
        version: 2,
        items: [
          { id: 'r1', type: 'request', name: 'Req', sort_order: 0 },
          { id: 'new-item', type: 'request', name: 'Req copy', sort_order: 1 },
        ],
      }),
    },
  });

  const store = await createStore();
  store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'https://api.example.com',
      token: 'tok-1',
      user: { id: 'alice', email: 'alice@example.com', name: 'Alice', role: 'user' },
      activeScope: { id: 'proj-1', name: 'Proj 1', type: 'project', role: 'reader' },
    },
    collections: [
      { id: 'col-1', name: 'Col 1', minRole: 'reader', items: [{ id: 'r1', name: 'Req', type: 'request', request: makeSampleRequest('r1', 'Req') }], createdAt: 1, updatedAt: 1, _origin: 'cloud' },
      { id: 'col-partial', name: 'Partial', minRole: 'reader', isPartial: true, items: [], createdAt: 1, updatedAt: 1, _origin: 'cloud' },
    ],
  });

  // S04: Reader rejected on item duplicate & project->personal rejected on collection duplicate
  const readerRes = await store.getState().duplicateCollectionItem('col-1', 'r1', 'col-1', null);
  assert.equal(readerRes.success, false);
  assert.match(readerRes.error, /Write access/);

  store.setState((s) => ({
    cloudConfig: { ...s.cloudConfig, activeScope: { id: 'proj-1', name: 'Proj 1', type: 'project', role: 'contributor' } },
  }));
  const projToPersonal = await store.getState().duplicateCollection('col-1', { id: 'ws-1', name: 'Personal', type: 'workspace' });
  assert.equal(projToPersonal.success, false);
  assert.match(projToPersonal.error, /personal workspaces/);

  const partialRes = await store.getState().duplicateCollectionItem('col-1', 'r1', 'col-partial', null);
  assert.equal(partialRes.success, false);
  assert.match(partialRes.error, /Load collection details/);

  // S06: Concurrent item duplicate lock blocks overlapping save & second duplicate
  const p1 = store.getState().duplicateCollectionItem('col-1', 'r1', 'col-1', null);
  const saveDuringDup = store.getState().saveRequestToCollection('col-1', null, makeSampleRequest('r1', 'Req'));
  assert.equal(saveDuringDup.success, false);
  assert.match(saveDuringDup.error, /move or duplicate/);
  const r1 = await p1;
  assert.equal(r1.success, true);

  // S05 / RR9: ABA logout -> login same account invalidates in-flight offline->cloud callback
  store.setState({
    workspaceMode: 'offline',
    collections: [{ id: 'off-1', name: 'Off 1', items: [], createdAt: 1, updatedAt: 1, _origin: 'offline' }],
    scopeCache: { 'workspace:ws-1': { collections: [{ id: 'keep-me', name: 'Keep', items: [], createdAt: 1, updatedAt: 1 }], environments: [], activeEnvironmentId: null, tabs: [], history: [] } },
  });
  const inflight = store.getState().duplicateCollection('off-1', { id: 'ws-1', name: 'WS 1', type: 'workspace' });
  await new Promise((r) => setTimeout(r, 10));
  // Logout and login SAME user Alice (ABA) while upload is in-flight
  await store.getState().logoutCloud();
  store.getState().setCloudConfig({
    apiUrl: 'https://api.example.com',
    token: 'tok-alice-new',
    user: { id: 'alice', email: 'alice@example.com', name: 'Alice', role: 'user' },
  });
  store.setState({
    scopeCache: { 'workspace:ws-1': { collections: [{ id: 'fresh-new-session', name: 'Fresh', items: [], createdAt: 1, updatedAt: 1 }], environments: [], activeEnvironmentId: null, tabs: [], history: [] } },
  });
  resolveUpload({ operation_id: 'x', status: 'committed', collection_id: 'c-old', workspace_id: 'ws-1', name: 'Off 1', min_role: 'reader', version: 1, updated_at: '2026-11-24T00:00:00Z', item_count: 0 });
  const staleOutcome = await inflight;
  assert.equal(staleOutcome.success, false);
  assert.equal(staleOutcome.error, 'Session changed');
  // Replacement session cache was NOT wiped or overwritten by stale callback!
  assert.equal(store.getState().scopeCache['workspace:ws-1'].collections[0].id, 'fresh-new-session');
});

test('S09 & RR10: storage failure rolls back local duplicate and blocks offline -> cloud upload before sending', async () => {
  let failWrites = false;
  let uploadAttempted = false;
  const failingStorage = {
    getItem: async () => null,
    setItem: async () => {
      if (failWrites) throw new Error('disk full');
    },
    removeItem: async () => {},
  };

  const { createStore } = createStoreHarness({
    storage: failingStorage,
    cloudClientOverrides: {
      importDuplicateCollection: async () => {
        uploadAttempted = true;
        throw new Error('should not be called');
      },
    },
  });

  const store = await createStore();
  store.setState({
    workspaceMode: 'offline',
    activeOfflineWorkspaceId: 'default',
    offlineWorkspaces: [{ id: 'default', name: 'Default', createdAt: 1, updatedAt: 1 }],
    cloudConfig: {
      apiUrl: 'https://api.example.com',
      token: 'tok',
      user: { id: 'alice', email: 'alice@example.com', name: 'Alice', role: 'user' },
    },
    collections: [{
      id: 'c-local',
      name: 'Local Col',
      items: [],
      createdAt: 1,
      updatedAt: 1,
      _origin: 'offline',
    }],
  });

  failWrites = true;
  const localFail = await store.getState().duplicateCollection('c-local', { id: 'default', name: 'Default', type: 'offline_workspace' });
  assert.equal(localFail.success, false);
  assert.match(localFail.error, /local storage/i);
  assert.equal(store.getState().collections.length, 1);

  const cloudFail = await store.getState().duplicateCollection('c-local', { id: 'ws-1', name: 'Cloud WS', type: 'workspace' });
  assert.equal(cloudFail.success, false);
  assert.equal(uploadAttempted, false);
  assert.deepEqual(toPlain(store.getState().pendingDuplicateIntents), {});
});

test('RR4: committed_deleted receipt does not resurrect deleted copy in active store', async () => {
  const { createStore } = createStoreHarness({
    cloudClientOverrides: {
      duplicateScopeCollection: async (_api, _tok, _colId, targetScope, opId) => ({
        operation_id: opId,
        status: 'committed_deleted',
        collection_id: 'col-deleted',
        project_id: targetScope.id,
        name: 'Ghost Col',
        min_role: 'contributor',
        version: 2,
        updated_at: '2026-11-24T00:00:00Z',
        item_count: 1,
      }),
    },
  });

  const store = await createStore();
  store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'https://api.example.com',
      token: 'tok',
      user: { id: 'alice', email: 'alice@example.com', name: 'Alice', role: 'user' },
      activeScope: { id: 'proj-1', name: 'Proj 1', type: 'project', role: 'contributor' },
    },
    collections: [{
      id: 'col-src',
      name: 'Source',
      minRole: 'reader',
      items: [],
      createdAt: 1,
      updatedAt: 1,
      _origin: 'cloud',
    }],
  });

  const res = await store.getState().duplicateCollection('col-src', { id: 'proj-1', name: 'Proj 1', type: 'project', role: 'contributor' });
  assert.equal(res.success, true);
  assert.equal(res.deletedOnServer, true);
  assert.equal(store.getState().collections.some((c) => c.id === 'col-deleted'), false);
});

test('createCollectionAsync works in offline and cloud modes, rejects invalid/failed cloud creation without phantom collections, and supports immediate item duplicate', async () => {
  let failCloudImport = true;
  let dupTargetIdSeen = null;
  const { createStore } = createStoreHarness({
    cloudClientOverrides: {
      batchImportToScope: async (_api, _tok, _scope, cols) => {
        if (failCloudImport) {
          failCloudImport = false;
          throw new Error('Server unavailable');
        }
        return { message: `imported ${cols.length}` };
      },
      duplicateScopeItem: async (_api, _tok, _itemId, _srcColId, targetColId, targetParentId, opId) => {
        dupTargetIdSeen = targetColId;
        return {
          operation_id: opId,
          status: 'committed',
          root_item_id: 'dup-req-new-col',
          root_item_type: 'request',
          target_collection_id: targetColId,
          target_parent_id: targetParentId ?? null,
          name: 'Health',
          collection_version: 2,
          item_count: 1,
          updated_at: '2026-11-24T00:00:00Z',
        };
      },
      fetchCollectionById: async (_api, _tok, colId) => ({
        id: colId,
        name: 'Brand New Cloud',
        version: 2,
        min_role: 'reader',
        items: [
          {
            id: 'dup-req-new-col',
            type: 'request',
            name: 'Health',
            request: { id: 'dup-req-new-col', method: 'GET', url: 'https://httpbin.org/get', headers: [], params: [] },
          },
        ],
      }),
    },
  });

  const store = await createStore();

  // 1. Offline mode creates synced collection immediately and rejects >150 runes
  const badOffline = await store.getState().createCollectionAsync('a'.repeat(151));
  assert.equal(badOffline.success, false);
  assert.match(badOffline.error, /150/);

  const okOffline = await store.getState().createCollectionAsync('Fresh Offline');
  assert.equal(okOffline.success, true);
  assert.ok(okOffline.collectionId);
  assert.equal(store.getState().collections[0].name, 'Fresh Offline');
  assert.equal(store.getState().collections[0]._syncStatus, 'synced');

  // 2. Cloud mode leaves no phantom collection when batchImportToScope fails, then creates synced collection & allows immediate duplicateCollectionItem
  store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'https://api.example.com',
      token: 'tok',
      user: { id: 'alice', email: 'alice@example.com', name: 'Alice', role: 'user' },
      activeScope: { id: 'proj-1', name: 'Proj 1', type: 'project', role: 'contributor' },
    },
    collections: [{
      id: 'col-src',
      name: 'Source Cloud',
      minRole: 'reader',
      version: 1,
      items: [
        {
          id: 'req-1',
          type: 'request',
          name: 'Health',
          request: { id: 'req-1', method: 'GET', url: 'https://httpbin.org/get', headers: [], params: [] },
        },
      ],
      createdAt: 1,
      updatedAt: 1,
      _origin: 'cloud',
      _syncStatus: 'synced',
    }],
  });

  const failCreate = await store.getState().createCollectionAsync('Brand New Cloud');
  assert.equal(failCreate.success, false);
  assert.match(failCreate.error, /Server unavailable/);
  assert.equal(store.getState().collections.length, 1);

  const okCloud = await store.getState().createCollectionAsync('Brand New Cloud');
  assert.equal(okCloud.success, true);
  assert.ok(okCloud.collectionId);
  assert.equal(store.getState().collections.length, 2);
  assert.equal(store.getState().collections[0]._syncStatus, 'synced');

  const dupRes = await store.getState().duplicateCollectionItem('col-src', 'req-1', okCloud.collectionId, null);
  assert.equal(dupRes.success, true);
  assert.equal(dupTargetIdSeen, okCloud.collectionId);
  assert.equal(dupRes.name, 'Health');
});

test('Regression (Codex Review): provider-session pendingDuplicateIntents survive persist, committed item duplicate tolerates post-commit GET failure, replay works after source delete, workspace switch protects offline rollback, and moved replay targets authoritative scope', async () => {
  // 1. Provider session persists pendingDuplicateIntents
  {
    const h = createStoreHarness({
      cloudClientOverrides: {
        importDuplicateCollection: async () => { throw new Error('reply lost after commit'); },
      },
    });
    const s = await h.createStore();
    s.setState({
      workspaceMode: 'offline',
      cloudConfig: {
        apiUrl: 'https://api.example.com',
        sessionKind: 'provider',
        user: { id: 'alice', role: 'user', email: 'alice@example.com', name: 'Alice' },
        activeScope: { id: 'ws-a', name: 'A', type: 'workspace' },
      },
      collections: [{ id: 'c1', name: 'Source', items: [], minRole: 'reader', createdAt: 1, updatedAt: 1, _origin: 'offline' }],
    });
    const res = await s.getState().duplicateCollection('c1', { id: 'ws-b', name: 'B', type: 'workspace' });
    assert.equal(res.reconcilePending, true);
    await s.getState().persistNativeCredentialState();
    const persisted = JSON.parse(await h.storage.getItem('air-rest-storage')).state;
    assert.equal(Object.keys(persisted.pendingDuplicateIntents).length, 1);
  }

  // 2. Committed item duplicate followed by GET 413 clears intent, marks collection partial, and reports success
  {
    let mutations = 0;
    const h = createStoreHarness();
    h.cloudClient.duplicateScopeItem = async (_url, _tok, _itemId, _srcCol, targetCol, targetParent, opId) => {
      mutations++;
      return {
        operation_id: opId,
        status: 'committed',
        root_item_id: 'copy-r1',
        target_collection_id: targetCol,
        target_parent_id: targetParent ?? null,
        target_collection_version: 2,
        name: 'Request copy',
        item_count: 1,
      };
    };
    h.cloudClient.fetchCollectionById = async () => {
      throw new h.cloudApiMod.CloudApiError('response exceeds transfer limit', 413, 'RESPONSE_PAYLOAD_TOO_LARGE');
    };
    const s = await h.createStore();
    s.setState({
      workspaceMode: 'cloud',
      cloudConfig: {
        apiUrl: 'https://api.example.com',
        token: 'tok',
        user: { id: 'alice', role: 'user', email: 'alice@example.com', name: 'Alice' },
        activeScope: { id: 'ws-a', name: 'A', type: 'workspace' },
      },
      collections: [{
        id: 'c1',
        name: 'Source',
        items: [{ id: 'r1', name: 'Request', type: 'request', request: makeSampleRequest('r1', 'Request') }],
        minRole: 'reader',
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        _origin: 'cloud',
      }],
    });
    const result = await s.getState().duplicateCollectionItem('c1', 'r1', 'c1', null);
    assert.equal(mutations, 1);
    assert.equal(result.success, true);
    assert.equal(result.createdItemId, 'copy-r1');
    assert.deepEqual(toPlain(s.getState().pendingDuplicateIntents), {});
    assert.equal(s.getState().collections[0].isPartial, true);
    assert.equal(s.getState().collections[0].version, 2);
  }

  // 3. Replay succeeds after source item is removed locally
  {
    let calls = 0;
    const h = createStoreHarness({
      cloudClientOverrides: {
        duplicateScopeItem: async (_url, _tok, _itemId, _srcCol, targetCol, targetParent, opId) => {
          if (++calls === 1) throw new Error('reply lost after commit');
          return {
            operation_id: opId,
            status: 'committed',
            root_item_id: 'copy-r1',
            target_collection_id: targetCol,
            target_parent_id: targetParent ?? null,
            target_collection_version: 2,
            name: 'Request copy',
            item_count: 1,
          };
        },
        fetchCollectionById: async () => ({
          id: 'c1',
          name: 'Source',
          min_role: 'reader',
          version: 2,
          items: [{ id: 'copy-r1', name: 'Request copy', type: 'request', request: makeSampleRequest('copy-r1', 'Request copy') }],
        }),
      },
    });
    const s = await h.createStore();
    s.setState({
      workspaceMode: 'cloud',
      cloudConfig: {
        apiUrl: 'https://api.example.com',
        token: 'tok',
        user: { id: 'alice', role: 'user', email: 'alice@example.com', name: 'Alice' },
        activeScope: { id: 'ws-a', name: 'A', type: 'workspace' },
      },
      collections: [{
        id: 'c1',
        name: 'Source',
        items: [{ id: 'r1', name: 'Request', type: 'request', request: makeSampleRequest('r1', 'Request') }],
        minRole: 'reader',
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        _origin: 'cloud',
      }],
    });
    const first = await s.getState().duplicateCollectionItem('c1', 'r1', 'c1', null);
    assert.equal(first.reconcilePending, true);
    s.setState({ collections: [{ id: 'c1', name: 'Source', items: [], minRole: 'reader', version: 1, createdAt: 1, updatedAt: 1, _origin: 'cloud' }] });
    const retry = await s.getState().retryPendingDuplicateIntent(first.operationId);
    assert.equal(calls, 2);
    assert.equal(retry.success, true);
    assert.equal(retry.createdItemId, 'copy-r1');
    assert.deepEqual(toPlain(s.getState().pendingDuplicateIntents), {});
  }

  // 4. Failed local durability flush after workspace switch does not restore workspace A's snapshot over workspace B
  {
    const h = createStoreHarness();
    const s = await h.createStore();
    let rejectFlush;
    const flush = new Promise((_, reject) => { rejectFlush = reject; });
    s.setState({
      workspaceMode: 'offline',
      activeOfflineWorkspaceId: 'a',
      offlineWorkspaces: [{ id: 'a', name: 'A', createdAt: 1, updatedAt: 1 }, { id: 'b', name: 'B', createdAt: 1, updatedAt: 1 }],
      offlineScopeCache: {},
      collections: [{ id: 'c1', name: 'A col', items: [], createdAt: 1, updatedAt: 1, _origin: 'offline' }],
      persistNativeCredentialState: () => flush,
    });
    const op = s.getState().duplicateCollection('c1', { id: 'a', name: 'A', type: 'offline_workspace' });
    s.getState().switchOfflineWorkspace('b');
    s.setState({ collections: [{ id: 'b-only', name: 'B data', items: [], createdAt: 1, updatedAt: 1, _origin: 'offline' }] });
    rejectFlush(new Error('storage failed'));
    const res = await op;
    assert.equal(res.success, false);
    assert.equal(s.getState().activeOfflineWorkspaceId, 'b');
    assert.equal(s.getState().collections[0].id, 'b-only');
    assert.equal(s.getState().offlineScopeCache.a.collections.length, 1);
    assert.equal(s.getState().offlineScopeCache.a.collections[0].id, 'c1');
  }

  // 5. Replayed collection receipt whose server scope moved to ws-b does not insert foreign collection into active ws-a
  {
    let calls = 0;
    const h = createStoreHarness({
      cloudClientOverrides: {
        duplicateScopeCollection: async (_url, _tok, _src, _scope, opId) => {
          if (++calls === 1) throw new Error('reply lost');
          return {
            operation_id: opId,
            status: 'committed',
            collection_id: 'moved-copy',
            workspace_id: 'ws-b',
            name: 'Moved copy',
            min_role: 'reader',
            version: 3,
            updated_at: '2026-11-24T00:00:00Z',
            item_count: 0,
          };
        },
        fetchCollectionById: async () => ({
          id: 'moved-copy',
          workspace_id: 'ws-b',
          name: 'Moved copy',
          min_role: 'reader',
          version: 3,
          items: [],
        }),
      },
    });
    const s = await h.createStore();
    const activeScope = { id: 'ws-a', name: 'A', type: 'workspace' };
    s.setState({
      workspaceMode: 'cloud',
      cloudConfig: {
        apiUrl: 'https://api.example.com',
        token: 'tok',
        user: { id: 'alice', role: 'user', email: 'alice@example.com', name: 'Alice' },
        activeScope,
      },
      collections: [{ id: 'c1', name: 'Source', items: [], minRole: 'reader', version: 1, createdAt: 1, updatedAt: 1, _origin: 'cloud' }],
    });
    const first = await s.getState().duplicateCollection('c1', activeScope);
    const retry = await s.getState().retryPendingDuplicateIntent(first.operationId);
    assert.equal(retry.success, true);
    assert.equal(s.getState().cloudConfig.activeScope.id, 'ws-a');
    assert.equal(s.getState().collections.some((c) => c.id === 'moved-copy'), false);
    assert.equal(retry.targetScope.id, 'ws-b');
  }
});
