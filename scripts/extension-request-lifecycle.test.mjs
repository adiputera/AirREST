import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function loadStore({ executePreRequestScript, executeApiRequest, cloudApi = {}, isOfflineOnly = true }) {
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
    '@/lib/scriptRunner': { executePreRequestScript, executePostResponseScript: async () => ({ success: true, environment: {}, variables: {} }) },
    '@/lib/postman': { importPostmanCollection: noop, importPostmanEnvironment: noop, detectPostmanJsonType: noop },
    '@/lib/urlParams': { parseQueryParamsFromUrl: noop, buildUrlWithParams: noop },
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
      ...cloudApi,
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
    '@/lib/edition': { isOfflineOnly },
    '@/lib/requestDiff': {
      findSavedRequestInCollections: noop,
      alignCollectionItemIds: noop,
      flattenCollectionRequests: noop,
      alignEnvironmentVariableIds: noop,
    },
    '@/lib/jwt': { canModifyCollection: () => true, hasScopePermission: () => true },
  };

  vm.runInNewContext(compiled, {
    exports,
    require: (id) => modules[id] ?? require(id),
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
  }, { filename: 'extension/src/store/useApiStore.ts' });

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
  await new Promise((resolve) => setTimeout(resolve, 350));

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
