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
      FileReader: globalThis.FileReader,
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
  assert.deepEqual(summary, {
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

test('parseImportBatchFiles: flags workspace conflicts, ignores pending collections, and detects batch duplicates', () => {
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

  // Pending collection does not trigger false conflict on first Product
  assert.equal(items[0].hasConflict, false);
  // Second Product in same batch conflicts with first
  assert.equal(items[1].hasConflict, true);
  // Case-insensitive conflict with existing environment
  assert.equal(items[2].hasConflict, true);

  // Unchecking the first Product clears batch-internal conflict on the second Product
  const uncheckedFirst = importBatch.recomputeBatchConflicts(
    importBatch.toggleImportBatchItem(items, items[0].id),
    [{ id: 'c-pending', name: 'Product', items: [], _syncStatus: 'pending', createdAt: 1, updatedAt: 1 }],
    [{ id: 'e-1', name: 'STAGING', variables: [], createdAt: 1, updatedAt: 1 }]
  );
  assert.equal(uncheckedFirst[0].checked, false);
  assert.equal(uncheckedFirst[1].hasConflict, false);
  assert.equal(uncheckedFirst[2].hasConflict, true);
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
