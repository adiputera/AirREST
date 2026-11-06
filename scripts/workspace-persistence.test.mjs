import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadWorkspacePersistence() {
  const cacheSource = ts.transpileModule(
    fs.readFileSync(new URL('../packages/common/src/workspace/scopeCache.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const cacheExports = {};
  vm.runInNewContext(cacheSource, { exports: cacheExports });
  const source = ts.transpileModule(
    fs.readFileSync(new URL('../packages/common/src/workspace/persistence.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require: () => cacheExports });
  return exports;
}

const resources = {
  collections: [{ id: 'collection-1', items: [] }], environments: [], activeEnvironmentId: null,
  tabs: [{ id: 'tab-1', attachment: 'source' }], activeTabId: 'tab-1', history: [{ id: 'history-1' }],
};
const serializers = {
  serializeRequest: (request) => ({ ...request, attachment: undefined }),
  serializeCollection: (collection) => ({ ...collection, persisted: true }),
  serializeHistory: (history) => history.map((entry) => ({ ...entry, persisted: true })),
};

test('persistence snapshots the active offline workspace using attachment-safe values', () => {
  const { preparePersistedWorkspaceCaches } = loadWorkspacePersistence();
  const result = preparePersistedWorkspaceCaches({
    workspaceMode: 'offline', activeOfflineWorkspaceId: 'offline-1', lastSyncedAt: null,
    resources, offlineScopeCache: {}, scopeCache: {}, ...serializers,
  });

  const snapshot = result.offlineScopeCache['offline-1'];
  assert.equal(snapshot.tabs[0].attachment, undefined);
  assert.equal(snapshot.collections[0].persisted, true);
  assert.equal(snapshot.history[0].persisted, true);
  assert.equal(Object.keys(result.scopeCache).length, 0);
});

test('persistence snapshots the active cloud scope and normalizes saved scope caches', () => {
  const { normalizePersistedWorkspaceScopeCache, preparePersistedWorkspaceCaches } = loadWorkspacePersistence();
  const result = preparePersistedWorkspaceCaches({
    workspaceMode: 'cloud', activeCloudScope: { type: 'project', id: 'project-1', name: 'Project 1' }, lastSyncedAt: 123,
    resources, offlineScopeCache: {}, scopeCache: {}, ...serializers,
  });
  const normalized = normalizePersistedWorkspaceScopeCache(result.scopeCache, {
    normalizeRequest: (request) => ({ ...request, normalized: true }),
    normalizeCollections: (collections) => collections.map((collection) => ({ ...collection, normalized: true })),
    normalizeHistory: (history) => history.map((entry) => ({ ...entry, normalized: true })),
  });

  const snapshot = normalized['project:project-1'];
  assert.equal(snapshot.lastSyncedAt, 123);
  assert.equal(snapshot.tabs[0].normalized, true);
  assert.equal(snapshot.collections[0].normalized, true);
  assert.equal(snapshot.history[0].normalized, true);
});
