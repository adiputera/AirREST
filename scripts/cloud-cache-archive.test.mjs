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

test('recovery control writes the selected backup through the owning runtime adapter', async () => {
  const source = fs.readFileSync(new URL('../packages/common/src/components/Header.tsx', import.meta.url), 'utf8').replaceAll('import.meta.env', '({})');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  const calls = [];
  const runtime = { adapter: { platformId: 'desktop', saveFile: async (...args) => { calls.push(args); return true; } } };
  const state = { environments: [], activeEnvironmentId: null, hasConfiguredMode: true, workspaceMode: 'offline', cloudConfig: {},
    cloudCacheOwner: null, cloudCacheArchives: { unclaimed: [{ scopeCache: {} }], owners: {} },
    getCloudCacheRecoveryCount: () => 1,
    getCloudCacheRecoveryBackup: () => '{"format":"AirREST cloud cache recovery"}', setActiveEnvironmentId() {} };
  const react = { __esModule: true, default: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: 'fragment' },
    useState: (value) => [value, () => {}], useEffect: () => {}, useRef: (value) => ({ current: value }) };
  const modules = { react, 'lucide-react': {}, '../store/useApiStore': { useApiStore: (selector) => selector(state) },
    '../context': { usePlatformAdapter: () => runtime.adapter, useProductPolicy: () => ({ workspace: { cloud: true } }) },
    '../lib/fetcher': { getDefaultPlatformAdapter: () => null }, '../lib/backNavigation': { useBackHandler: () => {} },
    '../lib/jwt': { hasScopePermission: () => true } };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: (id) => modules[id] || {}, setTimeout });
  const tree = exports.Header({});
  function find(node) {
    if (Array.isArray(node)) return node.map(find).find(Boolean);
    if (!node || typeof node !== 'object') return null;
    if (node.props?.['aria-label'] === 'Download preserved cloud data') return node;
    return find(node.children);
  }
  const control = find(tree);
  assert.ok(control);
  control.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0][0], 'airrest-cloud-cache-recovery.json');
  assert.equal(calls[0][1], '{"format":"AirREST cloud cache recovery"}');
  assert.equal(state.cloudCacheArchives.unclaimed.length, 1);
  const secondCalls = [];
  runtime.adapter = { platformId: 'desktop', saveFile: async (...args) => { secondCalls.push(args); return true; } };
  const secondTree = exports.Header({});
  find(secondTree).props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(secondCalls[0][0], 'airrest-cloud-cache-recovery.json');
  state.getCloudCacheRecoveryCount = () => 0;
  state.cloudCacheArchives = { unclaimed: [], owners: {}, unsupportedVersions: [{ version: 2 }] };
  const unsupportedTree = exports.Header({});
  assert.ok(find(unsupportedTree), 'unsupported archives remain downloadable');
  function findRestore(node) {
    if (Array.isArray(node)) return node.map(findRestore).find(Boolean);
    if (!node || typeof node !== 'object') return null;
    if (node.props?.['aria-label'] === 'Restore preserved data locally') return node;
    return findRestore(node.children);
  }
  assert.equal(findRestore(unsupportedTree), undefined);
});
