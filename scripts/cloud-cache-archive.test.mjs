import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadModule(path, dependencies = {}) {
  const source = fs.readFileSync(new URL(`../packages/common/src/workspace/${path}.ts`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: (id) => dependencies[id] || {}, JSON, Object, URL });
  return exports;
}

const scopeCache = loadModule('scopeCache');
const snapshots = loadModule('scopeSnapshot', { './scopeCache': scopeCache });
const archive = loadModule('cloudCacheArchive', { './scopeCache': scopeCache, './scopeSnapshot': snapshots });
const normalize = (url) => url.trim().replace(/\/+$/, '').toLowerCase();
const scope = { type: 'workspace', id: 'same-scope' };
const resources = {
  collections: [{ id: 'draft', _syncStatus: 'pending' }], environments: [],
  activeEnvironmentId: null, tabs: [{ id: 'tab' }], activeTabId: 'tab', history: [],
};

test('archives preserve pending resources separately for each server and account', () => {
  const first = { apiUrl: 'https://one.example/', user: { id: 'user-1' }, activeScope: scope };
  const second = { apiUrl: 'https://one.example', user: { id: 'user-2' }, activeScope: scope };
  const otherServer = { apiUrl: 'https://two.example', user: { id: 'user-1' }, activeScope: scope };
  const firstKey = archive.cloudCacheOwnerKey(first, normalize);
  const secondKey = archive.cloudCacheOwnerKey(second, normalize);
  const otherKey = archive.cloudCacheOwnerKey(otherServer, normalize);
  assert.notEqual(firstKey, secondKey);
  assert.notEqual(firstKey, otherKey);
  assert.equal(firstKey, archive.cloudCacheOwnerKey({ ...first, apiUrl: ' HTTPS://ONE.EXAMPLE ' }, normalize));
  assert.equal(archive.cloudCacheOwnerKey({ apiUrl: 'https://broken host/user:secret', user: { id: 'user-1' } }, normalize), null);
  assert.equal(archive.cloudCacheOwnerKey({ apiUrl: 'https://user:secret@example.test', user: { id: 'user-1' } }, normalize), null);
  const captured = archive.captureCloudCache({ config: first, workspaceMode: 'cloud', scopeCache: {}, resources, lastSyncedAt: 42 });
  const archives = archive.archiveCloudCache(archive.emptyCloudCacheArchives(), firstKey, captured);
  assert.equal(archive.getArchivedScope(archive.readCloudCache(archives, firstKey), scope).collections[0]._syncStatus, 'pending');
  assert.equal(archive.getArchivedScope(archive.readCloudCache(archives, secondKey), scope), undefined);
  assert.equal(archive.getArchivedScope(archive.readCloudCache(archives, otherKey), scope), undefined);
  assert.equal(archive.getArchivedScope(captured, scope).lastSyncedAt, 42);
});

test('unidentified legacy data is retained but never restored into a signed-in account', () => {
  const capture = archive.captureCloudCache({ config: { apiUrl: 'https://example.test', activeScope: scope }, workspaceMode: 'cloud', scopeCache: {}, resources, lastSyncedAt: null });
  const result = archive.archiveCloudCache(archive.emptyCloudCacheArchives(), null, capture);
  assert.equal(result.unclaimed.length, 1);
  assert.equal(result.unclaimed[0].scopeCache['workspace:same-scope'].collections[0].id, 'draft');
  assert.equal(archive.getArchivedScope(archive.readCloudCache(result, JSON.stringify(['https://example.test', 'user'])), scope), undefined);
  assert.equal(archive.cloudCacheOwnerKey({ apiUrl: 'https://example.test' }, normalize), null);
});

test('cloud resources without a scope are retained for recovery but not automatically restored', () => {
  const captured = archive.captureCloudCache({ config: { apiUrl: 'https://example.test' }, workspaceMode: 'cloud', scopeCache: {}, resources, lastSyncedAt: null });
  const saved = archive.archiveCloudCache(archive.emptyCloudCacheArchives(), null, captured);
  assert.equal(saved.unclaimed[0].unscoped[0].collections[0]._syncStatus, 'pending');
  assert.equal(archive.getArchivedScope(archive.readCloudCache(saved, null), scope), undefined);
  const owner = JSON.stringify(['https://example.test', 'user']);
  const first = archive.archiveCloudCache(archive.emptyCloudCacheArchives(), owner, captured);
  const later = archive.archiveCloudCache(first, owner, { scopeCache: { 'workspace:other': { collections: [], environments: [] } } });
  assert.equal(later.owners[owner].unscoped[0].collections[0].id, 'draft');
});

test('header does not expose cloud-cache recovery controls', () => {
  const source = fs.readFileSync(new URL('../packages/common/src/components/Header.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Import preserved cloud data/);
  assert.doesNotMatch(source, /Download preserved cloud data/);
  assert.doesNotMatch(source, /Restore preserved data locally/);
});
