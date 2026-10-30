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
    '@/lib/urlParams': { parseQueryParamsFromUrl: noop, parsePathVariablesFromUrl: () => [], buildUrlWithParams: noop },
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
  for (const file of ['../packages/common/src/components/ResponseViewer.tsx', '../extension/src/components/ResponseViewer.tsx']) {
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

  const adapterSrc = fs.readFileSync(new URL('../extension/src/adapters/chromeAdapter.ts', import.meta.url), 'utf8');
  const adapterExports = {};
  vm.runInNewContext(
    ts.transpileModule(adapterSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    {
      exports: adapterExports,
      require: (id) => (id === '@airrest/common' ? commonMock : require(id)),
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
            registerTokenRefreshCallback: () => () => {},
            registerAuthEvictedCallback: () => () => {},
          };
        }
        if (id.includes('scriptRunner')) return runnerExports;
        if (id.includes('fetcher')) return { setDefaultPlatformAdapter: () => {}, getDefaultPlatformAdapter: () => null };
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
