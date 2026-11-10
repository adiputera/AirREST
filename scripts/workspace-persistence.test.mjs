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

test('archived and unclaimed caches survive serialization and hydration without file handles', () => {
  const { serializeCloudCacheArchives, normalizeCloudCacheArchives } = loadWorkspacePersistence();
  const snapshot = { ...resources, lastSyncedAt: 123 };
  const source = { version: 1, owners: { owner: { scopeCache: { 'workspace:one': snapshot }, unscoped: [snapshot] } }, unclaimed: [{ scopeCache: { 'workspace:unknown': snapshot }, unscoped: [snapshot] }] };
  const serialized = serializeCloudCacheArchives(source, serializers);
  assert.equal(serialized.owners.owner.scopeCache['workspace:one'].tabs[0].attachment, undefined);
  assert.equal(serialized.unclaimed[0].scopeCache['workspace:unknown'].collections[0].persisted, true);
  assert.equal(serialized.owners.owner.unscoped[0].tabs[0].attachment, undefined);
  const normalized = normalizeCloudCacheArchives(JSON.parse(JSON.stringify(serialized)), {
    normalizeRequest: (value) => value,
    normalizeCollections: (values) => values,
    normalizeHistory: (values) => values,
  });
  assert.equal(normalized.owners.owner.scopeCache['workspace:one'].lastSyncedAt, 123);
  assert.equal(normalized.unclaimed[0].scopeCache['workspace:unknown'].collections[0].id, 'collection-1');
  assert.equal(normalized.unclaimed[0].unscoped[0].collections[0].id, 'collection-1');
  const again = normalizeCloudCacheArchives(JSON.parse(JSON.stringify(normalized)), {
    normalizeRequest: (value) => value,
    normalizeCollections: (values) => values,
    normalizeHistory: (values) => values,
  });
  assert.equal(JSON.stringify(again), JSON.stringify(normalized));
});

test('unknown archive versions survive repeated normalization and serialization as opaque data', () => {
  const { serializeCloudCacheArchives, normalizeCloudCacheArchives } = loadWorkspacePersistence();
  const future = { version: 2, owners: { someone: { pending: [{ id: 'draft', value: 'unchanged' }] } }, futureField: [1, 2] };
  const normalizers = { normalizeRequest: (value) => value, normalizeCollections: (value) => value, normalizeHistory: (value) => value };
  const first = normalizeCloudCacheArchives(future, normalizers);
  assert.equal(Object.keys(first.owners).length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(first.unsupportedVersions)), [future]);
  const serialized = serializeCloudCacheArchives(first, serializers);
  const second = normalizeCloudCacheArchives(JSON.parse(JSON.stringify(serialized)), normalizers);
  assert.deepEqual(JSON.parse(JSON.stringify(second.unsupportedVersions)), [future]);
  assert.equal(second.unclaimed.length, 0);
});

test('unversioned archive data migrates to version 1 while malformed entries remain unavailable', () => {
  const { normalizeCloudCacheArchives } = loadWorkspacePersistence();
  const snapshot = { ...resources, lastSyncedAt: 456 };
  const legacy = {
    owners: { owner: { scopeCache: { 'workspace:legacy': snapshot } }, malformed: { unscoped: 'not-an-array' } },
    unclaimed: [{ scopeCache: { 'workspace:unclaimed': snapshot } }, { scopeCache: 'not-an-object' }],
  };
  const normalizers = { normalizeRequest: (value) => value, normalizeCollections: (value) => value, normalizeHistory: (value) => value };

  const migrated = normalizeCloudCacheArchives(legacy, normalizers);

  assert.equal(migrated.version, 1);
  assert.equal(migrated.owners.owner.scopeCache['workspace:legacy'].lastSyncedAt, 456);
  assert.equal(migrated.owners.malformed, undefined);
  assert.equal(migrated.unclaimed.length, 1);
  assert.equal(migrated.unclaimed[0].scopeCache['workspace:unclaimed'].collections[0].id, 'collection-1');
});
