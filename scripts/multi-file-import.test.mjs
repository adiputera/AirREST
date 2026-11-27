import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const moduleCache = new Map();

function loadTsModule(relPath) {
  const absPath = path.resolve(ROOT, relPath);
  if (moduleCache.has(absPath)) {
    return moduleCache.get(absPath);
  }

  const source = fs.readFileSync(absPath, 'utf8');
  const compiled = ts.transpileModule(source, {
    fileName: absPath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  moduleCache.set(absPath, mod.exports);

  const localRequire = (specifier) => {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const candidate = path.resolve(path.dirname(absPath), specifier);
      const tsPath = candidate.endsWith('.ts') ? candidate : `${candidate}.ts`;
      if (fs.existsSync(tsPath)) {
        return loadTsModule(path.relative(ROOT, tsPath));
      }
      return {};
    }
    return require(specifier);
  };

  vm.runInNewContext(
    compiled,
    {
      module: mod,
      exports: mod.exports,
      require: localRequire,
      crypto: globalThis.crypto,
      console,
      Date,
      Math,
      Map,
      Set,
      Promise,
      FileReader: function SandboxFileReader() {
        return new globalThis.FileReader();
      },
    },
    { filename: absPath }
  );

  moduleCache.set(absPath, mod.exports);
  return mod.exports;
}

const importBatch = loadTsModule('packages/common/src/lib/importBatch.ts');

const SAMPLE_COLLECTION_JSON = JSON.stringify({
  info: {
    _postman_id: 'col-1',
    name: 'Product',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [
    {
      name: 'Auth',
      item: [
        {
          name: 'Get Token',
          request: { method: 'POST', url: 'https://example.com/auth' },
        },
      ],
    },
    {
      name: 'List Products',
      request: { method: 'GET', url: 'https://example.com/products' },
    },
  ],
});

const SAMPLE_ENV_JSON = JSON.stringify({
  id: 'env-1',
  name: 'staging',
  _postman_variable_scope: 'environment',
  values: [
    { key: 'base_url', value: 'https://api.example.com', enabled: true },
    { key: 'api_version', value: 'v1', enabled: true },
  ],
});

test('parseImportBatchFiles: parses mixed collection, environment, and invalid files accurately', () => {
  const items = importBatch.parseImportBatchFiles(
    [
      { filename: 'product-export.json', content: SAMPLE_COLLECTION_JSON },
      { filename: 'staging.postman_environment.json', content: SAMPLE_ENV_JSON },
      { filename: 'broken.json', content: '{invalid json' },
      { filename: 'random.json', content: JSON.stringify({ hello: 'world' }) },
      { filename: 'huge.json', content: '', error: 'Selected file exceeds maximum allowed limit of 16 MB.' },
    ],
    {
      existingCollections: [],
      existingEnvironments: [],
      canWriteCollection: true,
      canWriteEnvironment: true,
    }
  );

  assert.equal(items.length, 5);

  assert.equal(items[0].name, 'Product');
  assert.equal(items[0].type, 'collection');
  assert.equal(items[0].checked, true);
  assert.equal(items[0].disabled, false);
  assert.equal(items[0].hasConflict, false);
  assert.equal(items[0].itemCountLabel, '2 requests');

  assert.equal(items[1].name, 'staging');
  assert.equal(items[1].type, 'environment');
  assert.equal(items[1].checked, true);
  assert.equal(items[1].disabled, false);
  assert.equal(items[1].hasConflict, false);
  assert.equal(items[1].itemCountLabel, '2 variables');

  assert.equal(items[2].type, 'invalid');
  assert.equal(items[2].checked, false);
  assert.equal(items[2].disabled, true);
  assert.ok(items[2].error);

  assert.equal(items[3].type, 'invalid');
  assert.equal(items[3].checked, false);
  assert.equal(items[3].disabled, true);
  assert.match(items[3].error, /Unrecognized JSON format/);

  assert.equal(items[4].type, 'invalid');
  assert.equal(items[4].checked, false);
  assert.equal(items[4].disabled, true);
  assert.match(items[4].error, /16 MB/);

  const summary = importBatch.getImportBatchSelectionSummary(items);
  assert.deepEqual({ ...summary }, {
    total: 5,
    selectable: 2,
    selected: 2,
    invalid: 3,
    conflicts: 0,
    selectedConflicts: 0,
  });
});

test('toggleImportBatchItem & toggleAllImportBatchItems: respect unchecked items and disabled rows', () => {
  let items = importBatch.parseImportBatchFiles(
    [
      { filename: 'product.json', content: SAMPLE_COLLECTION_JSON },
      { filename: 'staging.json', content: SAMPLE_ENV_JSON },
      { filename: 'broken.json', content: '{bad' },
    ],
    {
      existingCollections: [],
      existingEnvironments: [],
      canWriteCollection: true,
      canWriteEnvironment: true,
    }
  );

  // Uncheck staging
  items = importBatch.toggleImportBatchItem(items, items[1].id);
  assert.equal(items[0].checked, true);
  assert.equal(items[1].checked, false);
  assert.equal(items[2].checked, false);

  // Attempt toggling disabled invalid item -> stays false
  items = importBatch.toggleImportBatchItem(items, items[2].id);
  assert.equal(items[2].checked, false);
  assert.equal(importBatch.getImportBatchSelectionSummary(items).selected, 1);

  // Toggle all off & back on -> disabled row remains unchecked
  items = importBatch.toggleAllImportBatchItems(items, false);
  assert.equal(importBatch.getImportBatchSelectionSummary(items).selected, 0);

  items = importBatch.toggleAllImportBatchItems(items, true);
  assert.equal(items[0].checked, true);
  assert.equal(items[1].checked, true);
  assert.equal(items[2].checked, false);
  assert.equal(importBatch.getImportBatchSelectionSummary(items).selected, 2);
});

test('parseImportBatchFiles: flags workspace conflicts including pending collections, and detects batch duplicates', () => {
  const items = importBatch.parseImportBatchFiles(
    [
      { filename: 'product-1.json', content: SAMPLE_COLLECTION_JSON },
      { filename: 'product-2.json', content: SAMPLE_COLLECTION_JSON },
      { filename: 'staging.json', content: SAMPLE_ENV_JSON },
    ],
    {
      existingCollections: [
        { id: 'c-pending', name: 'Product', items: [], _syncStatus: 'pending', createdAt: 1, updatedAt: 1 },
      ],
      existingEnvironments: [
        { id: 'e-1', name: 'STAGING', variables: [], createdAt: 1, updatedAt: 1 },
      ],
      canWriteCollection: true,
      canWriteEnvironment: true,
    }
  );

  // Pending collection from a prior operation MUST trigger a conflict on Product
  assert.equal(items[0].hasConflict, true);
  // Second Product in same batch also flags conflict
  assert.equal(items[1].hasConflict, true);
  // Case-insensitive conflict with existing environment
  assert.equal(items[2].hasConflict, true);

  // Explicit retry matching retryCollectionId + retryTargetKey clears conflict for that item only
  const targetKey = 'offline:ws-default-local';
  const retryItems = items.map((item, idx) =>
    idx === 0 ? { ...item, outcome: 'failed', retryCollectionId: 'c-pending', retryTargetKey: targetKey } : item
  );
  const recomputed = importBatch.recomputeBatchConflicts(
    retryItems,
    [{ id: 'c-pending', name: 'Product', items: [], _syncStatus: 'pending', createdAt: 1, updatedAt: 1 }],
    [{ id: 'e-1', name: 'STAGING', variables: [], createdAt: 1, updatedAt: 1 }],
    targetKey
  );
  assert.equal(recomputed[0].hasConflict, false);
  // Second Product is NOT the retry item, so it MUST still conflict with c-pending
  assert.equal(recomputed[1].hasConflict, true);
  assert.equal(recomputed[2].hasConflict, true);
});

test('parseImportBatchFiles: enforces RBAC write permissions per item type', () => {
  const items = importBatch.parseImportBatchFiles(
    [
      { filename: 'product.json', content: SAMPLE_COLLECTION_JSON },
      { filename: 'staging.json', content: SAMPLE_ENV_JSON },
    ],
    {
      existingCollections: [],
      existingEnvironments: [],
      canWriteCollection: false,
      canWriteEnvironment: true,
    }
  );

  assert.equal(items[0].disabled, true);
  assert.equal(items[0].checked, false);
  assert.match(items[0].error, /collection:write/);

  assert.equal(items[1].disabled, false);
  assert.equal(items[1].checked, true);
  assert.equal(items[1].error, undefined);
});

test('isStrictPostmanImportJson: matches Postman exports and rejects generic API JSON', () => {
  assert.equal(importBatch.isStrictPostmanImportJson(SAMPLE_COLLECTION_JSON), true);
  assert.equal(importBatch.isStrictPostmanImportJson(SAMPLE_ENV_JSON), true);
  assert.equal(
    importBatch.isStrictPostmanImportJson(JSON.stringify({ info: { name: 'Minimal' }, item: [] })),
    true
  );
  assert.equal(
    importBatch.isStrictPostmanImportJson(JSON.stringify({ name: 'Prod', values: [{ key: 'a', value: '1' }] })),
    true
  );

  // Generic JSON payloads must NOT trigger global import catch-all
  assert.equal(importBatch.isStrictPostmanImportJson(JSON.stringify({ items: [1, 2, 3] })), false);
  assert.equal(importBatch.isStrictPostmanImportJson(JSON.stringify({ values: [1, 2, 3] })), false);
  assert.equal(importBatch.isStrictPostmanImportJson(JSON.stringify([{ id: 1 }])), false);
  assert.equal(importBatch.isStrictPostmanImportJson('curl https://httpbin.org/get'), false);
});

test('isJsonCandidateFile & isEditableTarget & formatBatchImportSummary', () => {
  assert.equal(importBatch.isJsonCandidateFile({ name: 'Product.json', type: '' }), true);
  assert.equal(importBatch.isJsonCandidateFile({ name: 'blob', type: 'application/json; charset=utf-8' }), true);
  assert.equal(importBatch.isJsonCandidateFile({ name: 'photo.png', type: 'image/png' }), false);

  assert.equal(importBatch.isEditableTarget({ tagName: 'textarea' }), true);
  assert.equal(importBatch.isEditableTarget({ tagName: 'INPUT' }), true);
  assert.equal(importBatch.isEditableTarget({ tagName: 'div', isContentEditable: true }), true);
  assert.equal(
    importBatch.isEditableTarget({ tagName: 'div', closest: (sel) => (sel.includes('.cm-editor') ? {} : null) }),
    true
  );
  assert.equal(importBatch.isEditableTarget({ tagName: 'div', closest: () => null }), false);

  assert.equal(
    importBatch.formatBatchImportSummary({
      collectionsImported: 2,
      environmentsImported: 1,
      skipped: 1,
      failed: [],
    }),
    'Imported 2 collections and 1 environment (1 skipped).'
  );
  assert.equal(
    importBatch.formatBatchImportSummary({
      collectionsImported: 0,
      environmentsImported: 0,
      skipped: 2,
      failed: [],
    }),
    'No items imported (2 skipped).'
  );
});

test('UI & adapter contracts: multi-file input, checklist preview, Skip conflict action, and global catch-all', () => {
  const importModalSrc = fs.readFileSync(
    path.join(ROOT, 'packages/common/src/components/ImportModal.tsx'),
    'utf8'
  );
  const appSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/App.tsx'), 'utf8');
  const chromeAdapterSrc = fs.readFileSync(
    path.join(ROOT, 'apps/extension/src/adapters/chromeAdapter.ts'),
    'utf8'
  );

  assert.match(importModalSrc, /type="file"[\s\S]*?multiple/);
  assert.match(importModalSrc, /adapter\?\.openFiles/);
  assert.match(importModalSrc, /Review Files to Import/);
  assert.match(importModalSrc, /Import Selected/);
  assert.match(importModalSrc, /handleSkipConflict/);
  assert.match(importModalSrc, /Already exists/);
  assert.match(importModalSrc, /batchImportedIdsRef/);

  assert.match(appSrc, /isStrictPostmanImportJson/);
  assert.match(appSrc, /isJsonCandidateFile/);
  assert.match(appSrc, /Drop Postman \.json files to import/);
  assert.match(appSrc, /<ImportModal[\s\S]*?initialFiles=\{globalImportFiles\}/);

  assert.match(chromeAdapterSrc, /openFiles:\s*async/);
  assert.match(chromeAdapterSrc, /input\.multiple\s*=\s*multiple/);
});

function loadFullStoreModules() {
  const cache = new Map();
  const srcRoot = path.join(ROOT, 'packages/common/src');
  const globals = {
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    URL,
    URLSearchParams,
    Headers,
    Response,
    Request,
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    Blob,
    CompressionStream: globalThis.CompressionStream,
    performance,
    crypto: globalThis.crypto,
    fetch,
    Date,
    Math,
    Promise,
  };

  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.env', '({})');
    const compiled = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    }).outputText;

    const localRequire = (id) => {
      if (!id.startsWith('.')) return require(id);
      const base = path.resolve(path.dirname(file), id);
      const resolved = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find(
        (candidate) => {
          try {
            return fs.statSync(candidate).isFile();
          } catch {
            return false;
          }
        }
      );
      if (!resolved) throw new Error(`Cannot resolve ${id} from ${file}`);
      return load(resolved);
    };

    vm.runInNewContext(compiled, { ...globals, exports, require: localRequire }, { filename: file });
    return exports;
  }

  return {
    createApiStore: load(path.join(srcRoot, 'store/useApiStore.ts')).createApiStore,
    postman: load(path.join(srcRoot, 'lib/postman.ts')),
  };
}

test('offline addCollection & addEnvironment persist across reload, block pre-hydration overwrites, and recover zombie cloud mode', async () => {
  const { createApiStore, postman } = loadFullStoreModules();
  let persisted = null;
  let delayRead = false;
  let releaseRead = null;

  const asyncStorage = {
    getItem: async () => {
      if (delayRead) {
        await new Promise((resolve) => {
          releaseRead = resolve;
        });
      }
      return persisted;
    },
    setItem: async (_key, value) => {
      persisted = value;
    },
    removeItem: async () => {
      persisted = null;
    },
  };

  // 1. Fresh offline store: import Collection + Environment and verify reload keeps both
  const store1 = createApiStore({ storage: asyncStorage });
  await new Promise((resolve) => setImmediate(resolve));

  const parsedCol = postman.importPostmanCollection(SAMPLE_COLLECTION_JSON);
  const parsedEnv = postman.importPostmanEnvironment(SAMPLE_ENV_JSON);
  await store1.getState().addCollection(parsedCol);
  await store1.getState().addEnvironment(parsedEnv);

  const localWsId = store1.getState().activeOfflineWorkspaceId;
  assert.equal(store1.getState().offlineScopeCache[localWsId].collections.length, 1);
  assert.equal(store1.getState().offlineScopeCache[localWsId].environments.length, 1);
  store1.dispose();

  // 2. Simulate pre-hydration setState race during reload -> must NOT overwrite persisted data
  delayRead = true;
  const store2 = createApiStore({ storage: asyncStorage });
  store2.setState({ theme: 'dark' });
  releaseRead();
  delayRead = false;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(store2.getState().workspaceMode, 'offline');
  assert.equal(store2.getState().collections.length, 1);
  assert.equal(store2.getState().collections[0].name, 'Product');
  assert.equal(store2.getState().environments.length, 1);
  assert.equal(store2.getState().environments[0].name, 'staging');
  store2.dispose();

  // 3. Simulate zombie unauthenticated cloud mode in persisted storage (full edition)
  const snapshot = JSON.parse(persisted);
  snapshot.state.workspaceMode = 'cloud';
  snapshot.state.cloudConfig = { apiUrl: 'http://localhost:8080' };
  persisted = JSON.stringify(snapshot);

  const store3 = createApiStore({ storage: asyncStorage });
  await new Promise((resolve) => setImmediate(resolve));

  // Must fall back to offline mode and preserve offline workspace items across subsequent reloads
  assert.equal(store3.getState().workspaceMode, 'offline');
  assert.equal(store3.getState().collections.length, 1);
  assert.equal(store3.getState().collections[0].name, 'Product');

  const secondCol = postman.importPostmanCollection(
    JSON.stringify({
      info: {
        name: 'Orders',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [{ name: 'Get Orders', request: { method: 'GET', url: 'https://example.com/orders' } }],
    })
  );
  await store3.getState().addCollection(secondCol);
  store3.dispose();

  const store4 = createApiStore({ storage: asyncStorage });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store4.getState().workspaceMode, 'offline');
  assert.deepEqual(
    store4.getState().collections.map((c) => c.name),
    ['Orders', 'Product']
  );
  store4.dispose();
});

test('F01: captureImportTarget/isImportTargetMatching bind imports to origin scope and session; store reconciles only origin scope', async () => {
  const { createApiStore, postman } = loadFullStoreModules();
  const stateA = {
    workspaceMode: 'cloud',
    activeOfflineWorkspaceId: 'ws-default-local',
    isSwitchingWorkspace: false,
    getCloudSessionGeneration: () => 1,
    cloudConfig: {
      apiUrl: 'https://api.example.com',
      token: 'tok-1',
      user: { id: 'u1' },
      activeScope: { type: 'project', id: 'proj-a' },
    },
  };
  const targetA = importBatch.captureImportTarget(stateA);
  assert.equal(importBatch.isImportTargetMatching(stateA, targetA), true);

  // Switching scope fails target check
  assert.equal(
    importBatch.isImportTargetMatching(
      { ...stateA, cloudConfig: { ...stateA.cloudConfig, activeScope: { type: 'project', id: 'proj-b' } } },
      targetA
    ),
    false
  );
  // New session generation with same scope ID fails target check
  assert.equal(
    importBatch.isImportTargetMatching({ ...stateA, getCloudSessionGeneration: () => 2 }, targetA),
    false
  );

  // Store test: bound addCollection rejects if target workspace changed before call
  let memPersisted1 = null;
  const store = createApiStore({
    storage: {
      getItem: async () => memPersisted1,
      setItem: async (_k, v) => { memPersisted1 = v; },
      removeItem: async () => { memPersisted1 = null; },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const ws1 = store.getState().activeOfflineWorkspaceId;
  const wsTarget1 = importBatch.captureImportTarget(store.getState());
  const ws2 = store.getState().createOfflineWorkspace('Workspace B');
  store.getState().switchOfflineWorkspace(ws2);

  const colA = postman.importPostmanCollection(SAMPLE_COLLECTION_JSON);
  await assert.rejects(
    () => store.getState().addCollection(colA, { target: wsTarget1 }),
    /Workspace changed/i
  );
  assert.equal(store.getState().collections.length, 0, 'Target B must receive zero mutations');
  store.getState().switchOfflineWorkspace(ws1);
  assert.equal(store.getState().collections.length, 0);
  store.dispose();
});

test('F01 & F02: ImportModal cancels remaining queue on close/scope change and treats pending drafts as conflicts', async () => {
  const importModalSrc = fs.readFileSync(
    path.join(ROOT, 'packages/common/src/components/ImportModal.tsx'),
    'utf8'
  );
  const appSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/App.tsx'), 'utf8');
  const moveReqSrc = fs.readFileSync(
    path.join(ROOT, 'packages/common/src/components/MoveRequestModal.tsx'),
    'utf8'
  );
  const changePwdSrc = fs.readFileSync(
    path.join(ROOT, 'packages/common/src/components/ChangePasswordModal.tsx'),
    'utf8'
  );

  // F01: ImportModal captures target and checks isRunCurrent
  assert.match(importModalSrc, /captureImportTarget/);
  assert.match(importModalSrc, /isRunCurrent\(/);
  assert.match(importModalSrc, /invalidateActiveRun\(/);

  // F02: ImportModal tracks per-item outcome & retryCollectionId, never auto-reusing arbitrary pending collections
  assert.match(importModalSrc, /retryCollectionId/);
  assert.match(importModalSrc, /markBatchItemOutcome/);
  assert.doesNotMatch(importModalSrc, /const existingPendingCol =/);

  // F05: App uses shared hasOpenBlockingModal and modals expose consistent attributes
  assert.match(appSrc, /hasOpenBlockingModal/);
  assert.doesNotMatch(appSrc, /function isBlockingDialogOpen/);
  assert.match(moveReqSrc, /data-modal="true"/);
  assert.match(changePwdSrc, /data-modal="true"/);

  // Store-level F02 test: deferred cloud import + retry reconciliation checks origin scope
  let resolveBatch;
  let memPersisted2 = null;
  const fetchCollectionsCalls = [];
  const batchImportCalls = [];
  const { createApiStore, postman } = loadFullStoreModules();
  const store = createApiStore({
    storage: {
      getItem: async () => memPersisted2,
      setItem: async (_k, v) => { memPersisted2 = v; },
      removeItem: async () => { memPersisted2 = null; },
    },
    cloudClient: {
      batchImportToScope: async (_url, _tok, scope, cols) => {
        batchImportCalls.push({ scopeId: scope.id, colIds: cols.map((c) => c.id) });
        if (batchImportCalls.length === 1) {
          throw new Error('Network reply lost after server persisted');
        }
        if (batchImportCalls.length === 2) {
          return new Promise((r) => { resolveBatch = r; });
        }
      },
      fetchScopeCollections: async (_url, _tok, scope) => {
        fetchCollectionsCalls.push(scope.id);
        // Simulate server already persisted the first collection in ws-a
        return scope.id === 'ws-a' ? [{ id: col1.id, name: col1.name, version: 1 }] : [];
      },
      fetchCollectionById: async (_u, _t, id) => ({
        id,
        name: col1.name,
        description: '',
        min_role: 'reader',
        version: 1,
        items: [],
      }),
      fetchScopeEnvironments: async () => [],
      fetchFeaturePolicy: async () => ({ version: 1, flags: {}, fetchedAt: Date.now() }),
    },
  });
  await new Promise((r) => setImmediate(r));
  store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'https://api.example.com',
      token: 'tok-1',
      user: { id: 'u1', role: 'owner' },
      activeScope: { type: 'workspace', id: 'ws-a', name: 'WS A', role: 'owner' },
    },
  });

  const col1 = postman.importPostmanCollection(SAMPLE_COLLECTION_JSON);
  const targetA = importBatch.captureImportTarget(store.getState());
  await assert.rejects(
    () => store.getState().addCollection(col1, { target: targetA }),
    /Network reply lost/
  );
  assert.equal(store.getState().collections[0]._syncStatus, 'pending');

  // Explicit retry checks origin scope via fetchScopeCollections and avoids duplicate batchImportToScope
  await store.getState().addCollection(col1, { target: targetA, isRetry: true });
  assert.ok(fetchCollectionsCalls.includes('ws-a'));
  assert.equal(batchImportCalls.length, 1, 'Retry must NOT re-upload when server already has collection');

  // F01 store async reconciliation: start upload in WS A, switch to WS B before it resolves -> WS B untouched
  const col2 = postman.importPostmanCollection(
    JSON.stringify({ info: { name: 'Orders', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] })
  );
  const p2 = store.getState().addCollection(col2, { target: targetA });
  await new Promise((r) => setImmediate(r));
  await store.getState().setActiveScope({ type: 'workspace', id: 'ws-b', name: 'WS B', role: 'owner' });
  resolveBatch?.({ success: true });
  await p2;

  assert.equal(
    store.getState().collections.some((c) => c.id === col2.id),
    false,
    'Scope B must NOT receive Scope A collection after scope switch'
  );
  store.dispose();
});

test('F01 & F02 ImportModal component harness: close/scope-switch cancellation, timer isolation, pending conflict protection, and env/col partial retry', async () => {
  const RealReact = require('react');
  const tsCompiler = ts;

  const compileCjs = (relPath) => {
    const abs = path.join(ROOT, relPath);
    const src = fs.readFileSync(abs, 'utf8');
    return tsCompiler.transpileModule(src, {
      fileName: abs,
      compilerOptions: {
        module: tsCompiler.ModuleKind.CommonJS,
        target: tsCompiler.ScriptTarget.ES2022,
        jsx: tsCompiler.JsxEmit.React,
        esModuleInterop: true,
      },
    }).outputText;
  };

  // Load real helper modules in host realm
  const loadReal = (relPath, overrides = {}) => {
    const mod = { exports: {} };
    const code = compileCjs(relPath);
    const fn = new Function('require', 'module', 'exports', code);
    fn(
      (id) => {
        if (id in overrides) return overrides[id];
        return require(id);
      },
      mod,
      mod.exports
    );
    return mod.exports;
  };

  const urlParamsMod = loadReal('packages/common/src/lib/urlParams.ts');
  const examplesMod = loadReal('packages/common/src/lib/examples.ts');
  const perfMetricsMod = loadReal('packages/common/src/lib/perfMetrics.ts');
  const perfComparisonMod = loadReal('packages/common/src/lib/perfComparison.ts', {
    './examples': examplesMod,
    './perfMetrics': perfMetricsMod,
  });
  const reportShareMod = loadReal('packages/common/src/lib/reportShare.ts', {
    './examples': examplesMod,
    './perfComparison': perfComparisonMod,
  });
  const postmanMod = loadReal('packages/common/src/lib/postman.ts', {
    './urlParams': urlParamsMod,
    './examples': examplesMod,
  });
  const importBatchMod = loadReal('packages/common/src/lib/importBatch.ts', {
    './postman': postmanMod,
    './reportShare': reportShareMod,
  });
  const requestDiffMod = loadReal('packages/common/src/lib/requestDiff.ts', {
    './examples': examplesMod,
  });

  const createHarness = (initialStoreState) => {
    let storeState = initialStoreState;
    const activeStore = (selector) => selector(storeState);
    activeStore.getState = () => storeState;

    const states = [];
    const refs = [];
    const callbacks = [];
    const effects = [];
    let sIdx = 0;
    let rIdx = 0;
    let cIdx = 0;
    let eIdx = 0;
    const timers = [];
    let nextTimerId = 1;

    const depsChanged = (prevDeps, nextDeps) =>
      !prevDeps ||
      !nextDeps ||
      prevDeps.length !== nextDeps.length ||
      nextDeps.some((d, i) => !Object.is(d, prevDeps[i]));

    const fakeSetTimeout = (cb, ms) => {
      const id = nextTimerId++;
      timers.push({ id, cb, ms, cleared: false });
      return id;
    };
    const fakeClearTimeout = (id) => {
      const t = timers.find((x) => x.id === id);
      if (t) t.cleared = true;
    };

    const fakeReact = {
      ...RealReact,
      useState(init) {
        const idx = sIdx++;
        if (!(idx in states)) {
          states[idx] = typeof init === 'function' ? init() : init;
        }
        const setState = (val) => {
          states[idx] = typeof val === 'function' ? val(states[idx]) : val;
        };
        return [states[idx], setState];
      },
      useRef(init) {
        const idx = rIdx++;
        if (!(idx in refs)) refs[idx] = { current: init };
        return refs[idx];
      },
      useCallback(fn, deps) {
        const idx = cIdx++;
        const prev = callbacks[idx];
        if (!prev || depsChanged(prev.deps, deps)) {
          callbacks[idx] = { fn, deps };
        }
        return callbacks[idx].fn;
      },
      useEffect(fn, deps) {
        const idx = eIdx++;
        const prev = effects[idx];
        const changed = !prev || depsChanged(prev.deps, deps);
        effects[idx] = { fn, deps, cleanup: prev?.cleanup, pending: changed };
      },
    };

    const importModalCode = compileCjs('packages/common/src/components/ImportModal.tsx');
    const mod = { exports: {} };
    const fn = new Function(
      'require',
      'module',
      'exports',
      'setTimeout',
      'clearTimeout',
      'window',
      importModalCode
    );
    const noopIcon = new Proxy(
      {},
      { get: (_t, prop) => (p) => RealReact.createElement('svg', { 'data-icon': String(prop), ...p }) }
    );
    const mocks = {
      react: fakeReact,
      'lucide-react': noopIcon,
      '../store/useApiStore': { useApiStore: activeStore },
      '../store/storeContext': { useStoreContext: () => activeStore },
      '../lib/curl': { parseCurlCommand: () => ({}) },
      '../lib/postman': postmanMod,
      '../lib/importBatch': importBatchMod,
      '../lib/requestDiff': requestDiffMod,
      './MethodBadge': { MethodBadge: () => null },
      '../lib/editorHelper': { handleCodeEditorKeyDown: () => { } },
      '../lib/jwt': {
        canModifyCollection: () => true,
        canModifyEnvironment: () => true,
        hasScopePermission: () => true,
      },
      '../context': { usePlatformAdapter: () => ({ capabilities: {} }) },
      '../lib/backNavigation': { useBackHandler: () => { } },
      './requestEditorSectionState': {
        queueInitialRequestEditorSection: () => { },
        resolveInitialCurlSection: () => 'params',
      },
      '../lib/reportShare': reportShareMod,
      './performance/ReportImportResolveModal': { ReportImportResolveModal: () => null },
      './performance/useReportImporter': {
        useReportImporter: () => ({
          resolvePrompt: null,
          handleResolveChoice: () => { },
          cancelPendingPrompt: () => { },
          importReportContent: async () => ({ ok: true }),
          attachSessionReportToCollection: async () => ({ ok: true }),
          pickReportFileContent: async () => null,
        }),
      },
    };
    fn(
      (id) => (id in mocks ? mocks[id] : require(id)),
      mod,
      mod.exports,
      fakeSetTimeout,
      fakeClearTimeout,
      { addEventListener() { }, removeEventListener() { } }
    );

    const findElements = (node, pred, out = []) => {
      if (!node || typeof node !== 'object') return out;
      if (Array.isArray(node)) {
        node.forEach((child) => findElements(child, pred, out));
        return out;
      }
      if (pred(node)) out.push(node);
      if (node.props?.children) findElements(node.props.children, pred, out);
      return out;
    };

    const textOf = (node) => {
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (Array.isArray(node)) return node.map(textOf).join('');
      if (node && typeof node === 'object' && node.props?.children) return textOf(node.props.children);
      return '';
    };

    let lastProps = null;
    const render = (props = lastProps) => {
      lastProps = props;
      sIdx = 0;
      rIdx = 0;
      cIdx = 0;
      eIdx = 0;
      const tree = mod.exports.ImportModal(props);
      for (const eff of effects) {
        if (eff?.pending) {
          eff.pending = false;
          if (typeof eff.cleanup === 'function') eff.cleanup();
          eff.cleanup = eff.fn();
        }
      }
      return tree;
    };

    const flushTimers = () => {
      for (const t of [...timers]) {
        if (!t.cleared) {
          t.cleared = true;
          t.cb();
        }
      }
    };

    return {
      render,
      findElements,
      textOf,
      flushTimers,
      setStoreState: (next) => {
        storeState = next;
      },
      getStoreState: () => storeState,
    };
  };

  const makeColFile = (filename, name, url) => ({
    filename,
    content: JSON.stringify({
      info: { name, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'Req', request: { method: 'GET', url } }],
    }),
  });
  const makeEnvFile = (filename, name, val) => ({
    filename,
    content: JSON.stringify({
      name,
      _postman_variable_scope: 'environment',
      values: [{ key: 'baseUrl', value: val, enabled: true }],
    }),
  });

  // --- Scenario A (F01): Defer file 1 in Scope A, close modal, switch to Scope B, resolve file 1 -> 0 mutations to B ---
  {
    const recordedWrites = [];
    let resolveFirst;
    let sessionGen = 1;
    let isOpen = true;
    let closeCalls = 0;

    const baseState = {
      workspaceMode: 'cloud',
      activeOfflineWorkspaceId: 'ws-default-local',
      isSwitchingWorkspace: false,
      getCloudSessionGeneration: () => sessionGen,
      cloudConfig: {
        apiUrl: 'https://api.example.com',
        token: 'tok-1',
        user: { id: 'u1', role: 'owner' },
        activeScope: { type: 'project', id: 'scope-a', name: 'Scope A', role: 'owner' },
      },
      collections: [],
      environments: [],
      addCollection: async (col, opts) => {
        const curScope = h.getStoreState().cloudConfig.activeScope.id;
        recordedWrites.push({ scope: curScope, name: col.name, targetScope: opts?.target?.scopeId });
        if (col.name === 'First') {
          await new Promise((r) => { resolveFirst = r; });
        }
      },
      replaceCollection: async () => { },
      addEnvironment: async (env, opts) => {
        const curScope = h.getStoreState().cloudConfig.activeScope.id;
        recordedWrites.push({ scope: curScope, name: env.name, targetScope: opts?.target?.scopeId });
        return env.id;
      },
      replaceEnvironment: async () => { },
      createTab: () => { },
    };

    const h = createHarness(baseState);
    const files = [
      makeColFile('first.json', 'First', 'https://example.com/first'),
      makeColFile('second.json', 'Second', 'https://example.com/second'),
    ];
    let tree = h.render({ isOpen, initialFiles: files, onClose: () => { closeCalls += 1; isOpen = false; } });
    // Re-render once so batchItems state from openFilesIntoReview is visible
    tree = h.render({ isOpen, initialFiles: files, onClose: () => { closeCalls += 1; isOpen = false; } });

    const importBtn = h.findElements(tree, (n) => n.type === 'button' && h.textOf(n).includes('Import Selected'))[0];
    assert.ok(importBtn, 'Import Selected button should be rendered');

    const runPromise = importBtn.props.onClick();
    await new Promise((r) => setImmediate(r));
    assert.equal(recordedWrites.length, 1);
    assert.equal(recordedWrites[0].scope, 'scope-a');

    // User closes modal and switches to Scope B while First is still in flight
    isOpen = false;
    h.render({ isOpen: false, initialFiles: null, onClose: () => { closeCalls += 1; } });
    h.setStoreState({
      ...h.getStoreState(),
      cloudConfig: {
        ...h.getStoreState().cloudConfig,
        activeScope: { type: 'project', id: 'scope-b', name: 'Scope B', role: 'owner' },
      },
    });
    resolveFirst();
    await runPromise;

    assert.equal(recordedWrites.filter((w) => w.scope === 'scope-b').length, 0, 'Scope B must receive 0 writes');
    assert.equal(recordedWrites.length, 1, 'Second file must NOT execute after close/scope switch');

    // Now test old close timer vs newly reopened modal + sessionGen change with SAME scope ID
    isOpen = true;
    const singleFile = [makeColFile('solo.json', 'Solo', 'https://example.com/solo')];
    h.render({ isOpen: true, initialFiles: singleFile, onClose: () => { closeCalls += 1; } });
    tree = h.render({ isOpen: true, initialFiles: singleFile, onClose: () => { closeCalls += 1; } });
    const soloBtn = h.findElements(tree, (n) => n.type === 'button' && h.textOf(n).includes('Import Selected'))[0];
    await soloBtn.props.onClick();
    // Before 900ms timer fires, close & reopen modal with new files
    const closeBefore = closeCalls;
    h.render({ isOpen: false, initialFiles: null, onClose: () => { closeCalls += 1; } });
    h.render({ isOpen: true, initialFiles: files, onClose: () => { closeCalls += 1; } });
    h.flushTimers();
    assert.equal(closeCalls, closeBefore, 'Old batch close timer must NOT close newly reopened modal');

    // New session generation with the SAME scope ID stops queued environment import
    sessionGen = 2;
    const envFiles = [makeEnvFile('env.json', 'ProdEnv', 'https://prod.example.com')];
    h.render({ isOpen: true, initialFiles: envFiles, onClose: () => { } });
    tree = h.render({ isOpen: true, initialFiles: envFiles, onClose: () => { } });
    // Trigger conflict by putting existing ProdEnv in state, then bump sessionGen before clicking Replace/Copy
    h.setStoreState({
      ...h.getStoreState(),
      environments: [{ id: 'existing-env', name: 'ProdEnv', variables: [] }],
    });
    const envImportBtn = h.findElements(tree, (n) => n.type === 'button' && h.textOf(n).includes('Import Selected'))[0];
    await envImportBtn.props.onClick();
    tree = h.render({ isOpen: true, initialFiles: envFiles, onClose: () => { } });
    const copyBtn = h.findElements(tree, (n) => n.type === 'button' && h.textOf(n).includes('Import as Copy'))[0];
    assert.ok(copyBtn, 'Conflict dialog should appear for existing environment');
    sessionGen = 3; // Same scope-b ID, new session generation!
    const writesBeforeSessionBump = recordedWrites.length;
    await copyBtn.props.onClick();
    assert.equal(recordedWrites.length, writesBeforeSessionBump, 'New session generation with same scope ID must block conflict resolution');
  }

  // --- Scenario B (F02): Two same-name files; first fails sync leaving pending draft; second MUST prompt conflict ---
  {
    const colWrites = [];
    let failFirst = true;

    const h = createHarness({
      workspaceMode: 'cloud',
      activeOfflineWorkspaceId: 'ws-default-local',
      isSwitchingWorkspace: false,
      getCloudSessionGeneration: () => 1,
      cloudConfig: {
        apiUrl: 'https://api.example.com',
        token: 'tok-1',
        user: { id: 'u1', role: 'owner' },
        activeScope: { type: 'workspace', id: 'ws-a', name: 'WS A', role: 'owner' },
      },
      collections: [],
      environments: [],
      addCollection: async (col, opts) => {
        colWrites.push({ id: col.id, name: col.name, url: col.items?.[0]?.request?.url, isRetry: Boolean(opts?.isRetry) });
        const cur = h.getStoreState();
        const tagged = { ...col, _origin: 'cloud', _syncStatus: failFirst ? 'pending' : 'synced' };
        const exists = cur.collections.some((c) => c.id === col.id);
        h.setStoreState({
          ...cur,
          collections: exists
            ? cur.collections.map((c) => (c.id === col.id ? tagged : c))
            : [tagged, ...cur.collections],
        });
        if (failFirst) {
          failFirst = false;
          throw new Error('Simulated cloud timeout');
        }
      },
      replaceCollection: async (existingId, incoming) => {
        colWrites.push({ replacedId: existingId, name: incoming.name });
      },
      addEnvironment: async (env) => env.id,
      replaceEnvironment: async () => { },
      createTab: () => { },
    });

    const dupFiles = [
      makeColFile('first.json', 'Product', 'https://example.com/first'),
      makeColFile('second.json', 'Product', 'https://example.com/second'),
    ];
    h.render({ isOpen: true, initialFiles: dupFiles, onClose: () => { } });
    let tree = h.render({ isOpen: true, initialFiles: dupFiles, onClose: () => { } });
    const importBtn = h.findElements(tree, (n) => n.type === 'button' && h.textOf(n).includes('Import Selected'))[0];
    await importBtn.props.onClick();

    // After First fails and Second hits conflict: ONLY 1 write occurred (First), and First draft is intact!
    assert.equal(colWrites.length, 1, 'Second same-name file must NOT overwrite First before user decision');
    assert.equal(h.getStoreState().collections.length, 1);
    assert.equal(h.getStoreState().collections[0]._syncStatus, 'pending');
    assert.equal(h.getStoreState().collections[0].items[0].request.url, 'https://example.com/first');

    // Conflict dialog must be rendered for Second with Skip / Import as Copy / Replace
    tree = h.render({ isOpen: true, initialFiles: dupFiles, onClose: () => { } });
    const skipBtn = h.findElements(tree, (n) => n.type === 'button' && h.textOf(n).includes('Skip'))[0];
    const copyBtn = h.findElements(tree, (n) => n.type === 'button' && h.textOf(n).includes('Import as Copy'))[0];
    assert.ok(skipBtn && copyBtn, 'Conflict dialog must offer Skip and Import as Copy');

    // Choose Import as Copy -> Second gets a NEW UUID and First remains intact!
    await copyBtn.props.onClick();
    assert.equal(colWrites.length, 2);
    assert.notEqual(colWrites[1].id, colWrites[0].id, 'Import as Copy must assign a fresh UUID');
    assert.match(colWrites[1].name, /Copy/);
    assert.equal(
      h.getStoreState().collections.find((c) => c.id === colWrites[0].id).items[0].request.url,
      'https://example.com/first',
      'First pending draft content must remain intact'
    );

    // Partial retry: click Import Selected again -> ONLY failed First retries, reusing First's UUID with isRetry: true
    tree = h.render({ isOpen: true, initialFiles: dupFiles, onClose: () => { } });
    const retryBtn = h.findElements(tree, (n) => n.type === 'button' && h.textOf(n).includes('Import Selected (1)'))[0];
    assert.ok(retryBtn, 'Only the 1 failed item should remain selected for retry');
    await retryBtn.props.onClick();
    assert.equal(colWrites.length, 3);
    assert.equal(colWrites[2].id, colWrites[0].id, 'Explicit retry of failed item must reuse its pending draft UUID');
    assert.equal(colWrites[2].isRetry, true);
  }

  // --- Scenario C (F02 env partial retry): Failed cloud environment retry reuses retryEnvironmentId without false conflict ---
  {
    const envWrites = [];
    let failFirstEnv = true;

    const h = createHarness({
      workspaceMode: 'cloud',
      activeOfflineWorkspaceId: 'ws-default-local',
      isSwitchingWorkspace: false,
      getCloudSessionGeneration: () => 1,
      cloudConfig: {
        apiUrl: 'https://api.example.com',
        token: 'tok-1',
        user: { id: 'u1', role: 'owner' },
        activeScope: { type: 'workspace', id: 'ws-a', name: 'WS A', role: 'owner' },
      },
      collections: [],
      environments: [],
      addCollection: async () => { },
      replaceCollection: async () => { },
      addEnvironment: async (env, opts) => {
        envWrites.push({ id: env.id, name: env.name, isRetry: Boolean(opts?.isRetry) });
        const cur = h.getStoreState();
        const tagged = { ...env, _syncStatus: failFirstEnv ? 'pending' : 'synced' };
        const exists = cur.environments.some((e) => e.id === env.id);
        h.setStoreState({
          ...cur,
          environments: exists
            ? cur.environments.map((e) => (e.id === env.id ? tagged : e))
            : [...cur.environments, tagged],
        });
        if (failFirstEnv) {
          failFirstEnv = false;
          throw new Error('Env network timeout');
        }
        return env.id;
      },
      replaceEnvironment: async () => { },
      createTab: () => { },
    });

    const envFile = [makeEnvFile('staging.json', 'Staging', 'https://staging.example.com')];
    h.render({ isOpen: true, initialFiles: envFile, onClose: () => { } });
    let tree = h.render({ isOpen: true, initialFiles: envFile, onClose: () => { } });
    const importBtn = h.findElements(tree, (n) => n.type === 'button' && h.textOf(n).includes('Import Selected'))[0];
    await importBtn.props.onClick();
    assert.equal(envWrites.length, 1);
    assert.equal(h.getStoreState().environments.length, 1);

    // Retry must NOT prompt a false conflict dialog and must reuse the same local environment ID
    tree = h.render({ isOpen: true, initialFiles: envFile, onClose: () => { } });
    const retryBtn = h.findElements(tree, (n) => n.type === 'button' && h.textOf(n).includes('Import Selected (1)'))[0];
    assert.ok(retryBtn);
    await retryBtn.props.onClick();
    assert.equal(envWrites.length, 2);
    assert.equal(envWrites[1].id, envWrites[0].id, 'Explicit env retry must reuse its local draft ID');
    assert.equal(envWrites[1].isRetry, true);
    assert.equal(h.getStoreState().environments.length, 1, 'No duplicate local environment created on retry');
  }
});

test('I1, I2 & I3: JWT rotation keeps batch alive, file drops never navigate, and pending cloud env Replace creates instead of 404', async () => {
  const { createApiStore, postman } = loadFullStoreModules();

  // I1: Silent JWT token rotation (T1 -> T2) within same sessionGeneration keeps target matched
  const stateBeforeRefresh = {
    workspaceMode: 'cloud',
    activeOfflineWorkspaceId: 'ws-default-local',
    isSwitchingWorkspace: false,
    getCloudSessionGeneration: () => 5,
    cloudConfig: {
      apiUrl: 'https://api.example.com',
      token: 'tok-old',
      user: { id: 'u1' },
      activeScope: { type: 'project', id: 'proj-a' },
    },
  };
  const boundTarget = importBatch.captureImportTarget(stateBeforeRefresh);
  assert.equal(
    importBatch.isImportTargetMatching(
      { ...stateBeforeRefresh, cloudConfig: { ...stateBeforeRefresh.cloudConfig, token: 'tok-rotated' } },
      boundTarget
    ),
    true,
    'Silent JWT rotation must not abort an active batch target'
  );

  // I-R1: evaluateWindowFileDrop must NOT short-circuit when it calls preventDefault() itself
  {
    const makeDropEvent = (files, initialDefaultPrevented = false) => {
      const ev = {
        defaultPrevented: initialDefaultPrevented,
        preventDefaultCalls: 0,
        stopPropagationCalls: 0,
        dataTransfer: { files },
        preventDefault() {
          ev.preventDefaultCalls += 1;
          ev.defaultPrevented = true;
        },
        stopPropagation() {
          ev.stopPropagationCalls += 1;
        },
      };
      return ev;
    };

    const jsonDrop = makeDropEvent([{ name: 'collection.json', type: 'application/json' }]);
    const jsonDecision = importBatch.evaluateWindowFileDrop(jsonDrop, {
      hasHydrated: true,
      isSwitchingWorkspace: false,
      hasBlockingModal: false,
    });
    assert.equal(jsonDecision.shouldProcess, true, 'Valid JSON OS drop must proceed after preventDefault()');
    assert.equal(jsonDecision.files.length, 1);
    assert.equal(jsonDrop.preventDefaultCalls, 1);
    assert.equal(jsonDrop.stopPropagationCalls, 1);

    const pngDrop = makeDropEvent([{ name: 'image.png', type: 'image/png' }]);
    const pngDecision = importBatch.evaluateWindowFileDrop(pngDrop, {
      hasHydrated: true,
      isSwitchingWorkspace: false,
      hasBlockingModal: false,
    });
    assert.equal(pngDecision.shouldProcess, false);
    assert.equal(pngDrop.preventDefaultCalls, 1, 'Non-JSON file drop must still preventDefault() to stop WebView navigation');

    const modalDrop = makeDropEvent([{ name: 'collection.json', type: 'application/json' }]);
    const modalDecision = importBatch.evaluateWindowFileDrop(modalDrop, {
      hasHydrated: true,
      isSwitchingWorkspace: false,
      hasBlockingModal: true,
    });
    assert.equal(modalDecision.shouldProcess, false);
    assert.equal(modalDrop.preventDefaultCalls, 1);

    const alreadyHandledDrop = makeDropEvent([{ name: 'collection.json', type: 'application/json' }], true);
    const alreadyHandledDecision = importBatch.evaluateWindowFileDrop(alreadyHandledDrop, {
      hasHydrated: true,
      isSwitchingWorkspace: false,
      hasBlockingModal: false,
    });
    assert.equal(alreadyHandledDecision.shouldProcess, false);
    assert.equal(alreadyHandledDrop.preventDefaultCalls, 0);
  }

  // I2: App.tsx prevents default on non-JSON drops and ImportModal guards outer backdrop drop
  const appSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/App.tsx'), 'utf8');
  const modalSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/components/ImportModal.tsx'), 'utf8');
  assert.match(appSrc, /evaluateWindowFileDrop/);
  assert.match(modalSrc, /data-modal="true"[\s\S]*onDragOver=\{[\s\S]*onDrop=\{/);

  // I3: Failed cloud addEnvironment leaves _syncStatus='pending'; replaceEnvironment calls createScopeEnvironment (not PUT 404);
  //     and isRetry rejects name collision with different remote variables
  let memPersisted = null;
  let createCalls = 0;
  let updateCalls = 0;
  let updateMode = 'fail-404';
  let remoteEnvsToReturn = [];
  const store = createApiStore({
    storage: {
      getItem: async () => memPersisted,
      setItem: async (_k, v) => { memPersisted = v; },
      removeItem: async () => { memPersisted = null; },
    },
    cloudClient: {
      createScopeEnvironment: async (_u, _t, _scope, payload) => {
        createCalls += 1;
        if (createCalls === 1) throw new Error('Simulated create failure');
        return { id: 'server-env-uuid', name: payload.name, version: 1 };
      },
      updateScopeEnvironment: async (_u, _t, id, payload) => {
        updateCalls += 1;
        if (updateMode === 'fail-503') {
          const err = new Error('Service Unavailable');
          err.status = 503;
          throw err;
        }
        if (updateMode === 'fail-409') {
          const err = new Error('Conflict');
          err.status = 409;
          err.data = {
            environment: {
              id,
              name: payload.name,
              version: 9,
              variables: [{ id: 'v-remote', key: 'API', value: 'v-remote', initialValue: 'v-remote', currentValue: 'v-remote', enabled: true }],
            },
          };
          throw err;
        }
        if (updateMode === 'ok') {
          return { id, name: payload.name, version: (payload.base_version || 1) + 1 };
        }
        throw new Error('404 Not Found');
      },
      fetchScopeEnvironments: async () => remoteEnvsToReturn,
      fetchScopeCollections: async () => [],
      fetchFeaturePolicy: async () => ({ version: 1, flags: {}, fetchedAt: Date.now() }),
    },
  });
  await new Promise((r) => setImmediate(r));
  store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'https://api.example.com',
      token: 'tok-1',
      user: { id: 'u1', role: 'owner' },
      activeScope: { type: 'workspace', id: 'ws-a', name: 'WS A', role: 'owner' },
    },
  });

  const env1 = postman.importPostmanEnvironment(JSON.stringify({
    name: 'Staging',
    _postman_variable_scope: 'environment',
    values: [{ key: 'API', value: 'v1', enabled: true }],
  }));
  const env2 = postman.importPostmanEnvironment(JSON.stringify({
    name: 'Staging',
    _postman_variable_scope: 'environment',
    values: [{ key: 'API', value: 'v2', enabled: true }],
  }));

  const target = importBatch.captureImportTarget(store.getState());
  await assert.rejects(() => store.getState().addEnvironment(env1, { target }), /Simulated create failure/);
  assert.equal(store.getState().environments[0]._syncStatus, 'pending');

  // Replace against pending local draft must create on server (0 updateCalls) and mark synced with server ID
  await store.getState().replaceEnvironment(env1.id, env2, { target });
  assert.equal(createCalls, 2);
  assert.equal(updateCalls, 0);
  assert.equal(store.getState().environments[0].id, 'server-env-uuid');
  assert.equal(store.getState().environments[0]._syncStatus, 'synced');

  // Retry of a pending env when server already has a DIFFERENT env with the same name must reject instead of silently dropping local vars
  createCalls = 0;
  const env3 = postman.importPostmanEnvironment(JSON.stringify({
    name: 'Prod',
    _postman_variable_scope: 'environment',
    values: [{ key: 'SECRET', value: 'local-only', enabled: true }],
  }));
  await assert.rejects(() => store.getState().addEnvironment(env3, { target }), /Simulated create failure/);
  remoteEnvsToReturn = [
    { id: 'teammate-prod-id', name: 'Prod', version: 1, variables: [{ key: 'SECRET', value: 'teammate-val', enabled: true }] },
  ];
  await assert.rejects(
    () => store.getState().addEnvironment(env3, { target, isRetry: true }),
    /already exists on the server with different variables/
  );

  // I-R2: Synced server env that fails updateScopeEnvironment (503 or 409 OCC) must NOT call createScopeEnvironment on retry
  createCalls = 0;
  updateCalls = 0;
  updateMode = 'fail-503';
  const syncedServerEnv = {
    id: 'server-existing-env',
    name: 'SyncedProd',
    version: 3,
    _syncStatus: 'synced',
    variables: [{ id: 'v1', key: 'API', value: 'v1', initialValue: 'v1', currentValue: 'v1', enabled: true }],
    createdAt: 1,
    updatedAt: 1,
  };
  store.setState({ environments: [syncedServerEnv], activeEnvironmentId: syncedServerEnv.id });
  const incomingReplace1 = postman.importPostmanEnvironment(JSON.stringify({
    name: 'SyncedProd',
    _postman_variable_scope: 'environment',
    values: [{ key: 'API', value: 'v2', enabled: true }],
  }));
  await assert.rejects(() => store.getState().replaceEnvironment(syncedServerEnv.id, incomingReplace1, { target }), /Service Unavailable/);
  assert.equal(createCalls, 0);
  assert.equal(updateCalls, 1);
  assert.equal(store.getState().environments.find((e) => e.id === syncedServerEnv.id)?._syncStatus, 'pending');

  // Retry after transient 503 must call updateScopeEnvironment (NOT createScopeEnvironment)
  updateMode = 'ok';
  await store.getState().replaceEnvironment(syncedServerEnv.id, incomingReplace1, { target });
  assert.equal(createCalls, 0, 'Retrying replaceEnvironment on server-backed env must never call createScopeEnvironment');
  assert.equal(updateCalls, 2);
  const afterRetryEnv = store.getState().environments.find((e) => e.id === syncedServerEnv.id);
  assert.equal(afterRetryEnv?._syncStatus, 'synced');
  assert.equal(afterRetryEnv?.version, 4);

  // 409 OCC followed by overwriteEnvironmentOccConflict must clear _syncStatus to 'synced'
  updateMode = 'fail-409';
  const incomingReplace2 = postman.importPostmanEnvironment(JSON.stringify({
    name: 'SyncedProd',
    _postman_variable_scope: 'environment',
    values: [{ key: 'API', value: 'v3', enabled: true }],
  }));
  await assert.rejects(() => store.getState().replaceEnvironment(syncedServerEnv.id, incomingReplace2, { target }), /Conflict/);
  assert.ok(store.getState().environmentOccConflict);
  updateMode = 'ok';
  await store.getState().overwriteEnvironmentOccConflict();
  assert.equal(store.getState().environmentOccConflict, null);
  assert.equal(store.getState().environments.find((e) => e.id === syncedServerEnv.id)?._syncStatus, 'synced');
  await store.getState().replaceEnvironment(syncedServerEnv.id, incomingReplace2, { target });
  assert.equal(createCalls, 0, 'replaceEnvironment after OCC overwrite must still use updateScopeEnvironment');
  store.dispose();
});

test('I4, I5, I7, I8 & I9: Sidebar file drops bubble, UTF-8 16MB guard, abort/perm throws, folder Replace cleanup, and copy retry reuse', async () => {
  const { createApiStore, postman } = loadFullStoreModules();
  const requestDiff = loadTsModule('packages/common/src/lib/requestDiff.ts');
  const sidebarSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/components/Sidebar.tsx'), 'utf8');
  const importModalSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/components/ImportModal.tsx'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/App.tsx'), 'utf8');

  // I4: Sidebar does not swallow external OS file drops when draggedItem is null
  assert.match(sidebarSrc, /const handleDrop = \(e: React\.DragEvent\) => \{\s*if \(!draggedItem\)/);
  assert.match(sidebarSrc, /onDrop=\{\(e\) => \{\s*if \(!draggedItem\) return;/);

  // I5: UTF-8 byte length check rejects multi-byte >16 MiB even when .length < 16 MiB
  const sixMillionCjk = '中'.repeat(6 * 1024 * 1024);
  const cjkBatch = importBatch.parseImportBatchFiles(
    [{ filename: 'cjk.json', content: sixMillionCjk }],
    { existingCollections: [], existingEnvironments: [], canWriteCollection: true, canWriteEnvironment: true }
  );
  assert.equal(cjkBatch[0].type, 'invalid');
  assert.match(cjkBatch[0].error, /16 MB/i);
  assert.match(importModalSrc, /getImportUtf8ByteLength\(jsonText\) > MAX_IMPORT_FILE_BYTES/);

  // I7 & I9 UI guards
  assert.match(importModalSrc, /retryCopyDraftRef/);
  assert.match(importModalSrc, /activeStore\.getState\(\)\.environmentOccConflict/);
  assert.match(appSrc, /if \(isDisposed \|\| hasOpenBlockingModal\(\) \|\| activeStore\.getState\(\)\.isSwitchingWorkspace\) return;/);

  // I9 & I-R3: alignCollectionItemIds preserves matched folder UUIDs and never assigns duplicate IDs to same-named requests
  const existingFolderId = '11111111-1111-4111-8111-111111111111';
  const reqGetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const reqPostId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  const aligned = requestDiff.alignCollectionItemIds(
    [
      {
        id: existingFolderId,
        name: 'Auth',
        type: 'folder',
        items: [
          { id: reqGetId, name: 'Users', type: 'request', request: { id: reqGetId, name: 'Users', method: 'GET', url: 'https://a.test/users', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '' } },
          { id: reqPostId, name: 'Users', type: 'request', request: { id: reqPostId, name: 'Users', method: 'POST', url: 'https://a.test/users', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '' } },
        ],
      },
    ],
    [
      {
        id: '',
        name: 'Auth',
        type: 'folder',
        items: [
          { id: 'fresh-1', name: 'Users', type: 'request', request: { id: 'fresh-1', name: 'Users', method: 'GET', url: 'https://a.test/users', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '' } },
          { id: 'fresh-2', name: 'Users', type: 'request', request: { id: 'fresh-2', name: 'Users', method: 'POST', url: 'https://a.test/users', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '' } },
        ],
      },
    ]
  );
  assert.equal(aligned[0].id, existingFolderId);
  assert.equal(aligned[0].items[0].id, reqGetId);
  assert.equal(aligned[0].items[1].id, reqPostId);
  assert.notEqual(aligned[0].items[0].id, aligned[0].items[1].id, 'Duplicate-named requests must keep distinct aligned IDs');

  // I8 & I9 Store behavioral checks: permission throw, same-scope abort rejects, atomic replaceCollection removes omitted folders/requests & keeps minRole
  const deletedItemIds = [];
  let replacedCollectionPayload = null;
  let holdBatch = true;
  let ignoreBatchAbort = false;
  let releaseHeldBatch;
  let collectionsDeltaPayload = [];
  const store = createApiStore({
    storage: { getItem: async () => null, setItem: async () => { }, removeItem: async () => { } },
    cloudClient: {
      deleteScopeItem: async (_u, _t, id) => {
        deletedItemIds.push(id);
        return { message: 'deleted' };
      },
      replaceScopeCollection: async (_u, _t, id, collection, baseVersion) => {
        replacedCollectionPayload = { id, collection, baseVersion };
        collectionsDeltaPayload = collectionsDeltaPayload.map((c) =>
          c.id === id ? { ...c, version: (baseVersion || 1) + 1, items: collection.items || [] } : c
        );
        return { collection_id: id, version: (baseVersion || 1) + 1, replayed: false };
      },
      batchImportToScope: async (_u, _t, _s, _c, _r, signal) => {
        if (!holdBatch) return { success: true };
        return new Promise((resolve, reject) => {
          releaseHeldBatch = resolve;
          if (!ignoreBatchAbort) {
            if (signal?.aborted) {
              reject(new Error('Aborted'));
              return;
            }
            signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
          }
        });
      },
      fetchScopeCollections: async () => collectionsDeltaPayload,
      fetchCollectionById: async (_u, _t, id) => collectionsDeltaPayload.find((c) => c.id === id) || { id, name: 'Mock', version: 1, items: [] },
      fetchScopeEnvironments: async () => [],
      fetchFeaturePolicy: async () => ({
        version: 1,
        flags: {},
        capabilities: { saved_examples: true },
        fetchedAt: Date.now(),
      }),
    },
  });
  await new Promise((r) => setImmediate(r));

  // Project scope viewer without env:write must reject
  store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'https://api.example.com',
      token: 'tok-1',
      user: { id: 'u1', role: 'user' },
      activeScope: { type: 'project', id: 'proj-1', name: 'Proj 1', role: 'viewer' },
    },
  });
  const envViewer = postman.importPostmanEnvironment(SAMPLE_ENV_JSON);
  await assert.rejects(() => store.getState().addEnvironment(envViewer), /env:write/);

  // Same-scope forceSync cancelling in-flight addCollection must throw instead of resolving silently
  store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'https://api.example.com',
      token: 'tok-1',
      user: { id: 'u1', role: 'owner' },
      activeScope: { type: 'workspace', id: 'ws-a', name: 'WS A', role: 'owner' },
    },
  });
  const colAbort = postman.importPostmanCollection(SAMPLE_COLLECTION_JSON);
  const targetA = importBatch.captureImportTarget(store.getState());
  const addPromise = store.getState().addCollection(colAbort, { target: targetA });
  await new Promise((r) => setImmediate(r));
  // Trigger same-scope forceSync via setActiveScope(..., true)
  const forceSyncPromise = store.getState().setActiveScope({ type: 'workspace', id: 'ws-a', name: 'WS A', role: 'owner' }, true);
  await assert.rejects(() => addPromise, /cancelled/i);
  releaseHeldBatch?.({ success: true });
  await forceSyncPromise;

  // I9: replaceCollection deletes removed folders as well as requests and keeps existing minRole
  holdBatch = false;
  const oldFolderId = '22222222-2222-4222-8222-222222222222';
  const oldReqId = '33333333-3333-4333-8333-333333333333';
  const existingCol = {
    id: 'col-replace-i9',
    name: 'API',
    minRole: 'maintainer',
    version: 2,
    items: [
      { id: oldFolderId, name: 'LegacyFolder', type: 'folder', items: [{ id: oldReqId, name: 'OldReq', type: 'request', request: { id: oldReqId, name: 'OldReq', method: 'GET', url: 'https://a.test', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '', createdAt: 1, updatedAt: 1 } }] },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
  collectionsDeltaPayload = [{ id: existingCol.id, name: 'API', version: 2, min_role: 'maintainer', items: [] }];
  store.setState({ collections: [existingCol] });
  const incomingReplacement = postman.importPostmanCollection(
    JSON.stringify({ info: { name: 'API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] })
  );
  await store.getState().replaceCollection(existingCol.id, incomingReplacement);
  assert.ok(replacedCollectionPayload, 'replaceCollection must use atomic replace endpoint on cloud');
  assert.equal(replacedCollectionPayload.collection.items.length, 0, 'atomic replace must omit removed folders and requests');
  assert.equal(store.getState().collections[0].minRole, 'maintainer');

  // I10 (P3): Edge cases (strict empty-array env guard, permission recompute, A->B->A live reconcile, ImportModal back/name coercion)
  assert.equal(
    importBatch.isStrictPostmanImportJson('{"name":"Any","values":[]}'),
    false,
    'isStrictPostmanImportJson must reject bare {"name":"Any","values":[]} without environment scope',
  );
  assert.equal(
    importBatch.isStrictPostmanImportJson('{"_postman_variable_scope":"environment","name":"Any","values":[]}'),
    true,
    'isStrictPostmanImportJson must still accept valid empty Postman environment with _postman_variable_scope',
  );

  const permRecomputed = importBatch.recomputeBatchConflicts(
    [
      {
        id: 'i10-col',
        filename: 'c.json',
        name: 'New Col',
        type: 'collection',
        checked: true,
        disabled: false,
        hasConflict: false,
        parsedCollection: { id: 'c-new', name: 'New Col', items: [], createdAt: 1, updatedAt: 1 },
      },
    ],
    [],
    [],
    'workspace:ws-a',
    { canWriteCollection: false, canWriteEnvironment: true },
  );
  assert.equal(permRecomputed[0].disabled, true);
  assert.equal(permRecomputed[0].checked, false);
  assert.match(permRecomputed[0].error || '', /permission/i);

  // Rapid same-session Scope A -> B -> A during addCollection reconciles onto live state.collections
  const colABA = postman.importPostmanCollection(
    JSON.stringify({
      info: { name: 'ABA Synced', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'Ping', request: { method: 'GET', url: 'https://example.com/ping' } }],
    }),
  );
  collectionsDeltaPayload = [];
  store.setState({
    lastSyncedAt: Date.now(),
    scopeCache: {
      ...(store.getState().scopeCache || {}),
      'workspace:ws-b': { collections: [], environments: [], activeEnvironmentId: null, tabs: [], history: [], lastSyncedAt: Date.now() },
    },
  });
  holdBatch = true;
  ignoreBatchAbort = true;
  const targetForABA = importBatch.captureImportTarget(store.getState());
  const abaPromise = store.getState().addCollection(colABA, { target: targetForABA });
  await new Promise((r) => setImmediate(r));
  holdBatch = false;
  await store.getState().setActiveScope({ type: 'workspace', id: 'ws-b', name: 'WS B', role: 'owner' });
  await store.getState().setActiveScope({ type: 'workspace', id: 'ws-a', name: 'WS A', role: 'owner' });
  releaseHeldBatch?.({ success: true });
  await abaPromise;
  ignoreBatchAbort = false;
  const reconciledColABA = store.getState().collections.find((c) => c.id === colABA.id);
  assert.equal(reconciledColABA?._syncStatus, 'synced', 'Rapid A->B->A return must reconcile onto live collections');

  const importModalI10Src = fs.readFileSync(path.join(ROOT, 'packages/common/src/components/ImportModal.tsx'), 'utf-8');
  assert.match(importModalI10Src, /invalidateActiveRun\(\);/);
  assert.match(importModalI10Src, /String\(e\.name \?\? ''\)\.trim\(\)/);
  assert.match(importModalI10Src, /String\(c\.name \?\? ''\)\.trim\(\)/);

  // I-R4..I-R6: readBrowserFiles 50-file & 64-MiB limits, non-Postman {items:[...]} rejection, and unconditional conflict back invalidation
  assert.equal(importBatch.MAX_IMPORT_BATCH_FILES, 50);
  assert.equal(importBatch.MAX_IMPORT_BATCH_TOTAL_BYTES, 64 * 1024 * 1024);

  const origFileReader = globalThis.FileReader;
  class MockFileReader {
    readAsText(file) {
      queueMicrotask(() => {
        if (this.onload) {
          this.onload({ target: { result: file._content ?? '{}' } });
        }
      });
    }
  }
  globalThis.FileReader = MockFileReader;
  try {
    const fiftyOne = Array.from({ length: 51 }, (_, i) => ({
      name: `c${i}.json`,
      size: 16,
      _content: '{}',
    }));
    const overCountRes = await importBatch.readBrowserFiles(fiftyOne, { requireJsonExtension: true });
    assert.equal(overCountRes.length, 1);
    assert.match(overCountRes[0].error || '', /50 files/);

    // 5 files x 14 MiB = 70 MiB (> 64 MiB batch ceiling; each under 16 MiB per-file ceiling)
    const fourteenMbText = 'a'.repeat(14 * 1024 * 1024);
    const fiveRealBig = Array.from({ length: 5 }, (_, i) => ({
      name: `real${i}.json`,
      size: fourteenMbText.length,
      _content: fourteenMbText,
    }));
    const overBytesRes = await importBatch.readBrowserFiles(fiveRealBig, { requireJsonExtension: true });
    assert.equal(overBytesRes.length, 5);
    assert.equal(overBytesRes[0].error, undefined);
    assert.equal(overBytesRes[3].error, undefined);
    assert.match(overBytesRes[4].error || '', /64 MB/);
  } finally {
    globalThis.FileReader = origFileReader;
  }

  // I-R5: arbitrary { items: [...] } JSON must be detected as unknown and rejected by ImportModal
  assert.equal(postman.detectPostmanJsonType('{"items":[1,2,3]}'), 'unknown');
  assert.match(importModalI10Src, /if \(detected === 'unknown'\)/);

  // I-R6: backing out of conflict always calls invalidateActiveRun()
  assert.match(importModalI10Src, /const handleBackFromConflict = \(\) => \{\s*invalidateActiveRun\(\);/);

  store.dispose();
});
