import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadCloudScopeTransition() {
  const compile = (path) => ts.transpileModule(
    fs.readFileSync(new URL(path, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const cacheExports = {};
  vm.runInNewContext(compile('../packages/common/src/workspace/scopeCache.ts'), { exports: cacheExports });
  const snapshotExports = {};
  vm.runInNewContext(compile('../packages/common/src/workspace/scopeSnapshot.ts'), {
    exports: snapshotExports,
    require: () => cacheExports,
  });
  const exports = {};
  vm.runInNewContext(compile('../packages/common/src/workspace/cloudScopeTransition.ts'), {
    exports,
    require: (id) => id.includes('scopeCache') ? cacheExports : snapshotExports,
  });
  return exports;
}

const scope = { type: 'workspace', id: 'scope-1', name: 'Scope 1' };
const targetScope = { type: 'project', id: 'scope-2', name: 'Scope 2' };
const resources = {
  collections: [{ id: 'collection-1' }],
  environments: [{ id: 'environment-1' }],
  activeEnvironmentId: 'environment-1',
  tabs: [{ id: 'tab-1' }],
  activeTabId: 'tab-1',
  history: [{ id: 'history-1' }],
};

test('cloud scope transitions snapshot the source and restore a fresh target cache', () => {
  const { prepareCloudScopeTransition } = loadCloudScopeTransition();
  const syncedAt = Date.now();
  const targetCache = {
    collections: [{ id: 'collection-2' }],
    environments: [],
    activeEnvironmentId: null,
    tabs: [{ id: 'tab-2' }],
    activeTabId: 'tab-2',
    history: [{ id: 'history-2' }],
    lastSyncedAt: syncedAt,
  };
  const transition = prepareCloudScopeTransition({
    workspaceMode: 'cloud',
    activeCloudScope: scope,
    targetScope,
    activeOfflineWorkspaceId: 'offline-1',
    offlineScopeCache: {},
    scopeCache: { 'project:scope-2': targetCache },
    resources,
    lastSyncedAt: 900,
    forceSync: false,
    cacheTtlMs: 100,
    createInitialTab: () => ({ id: 'new-tab' }),
  });

  assert.equal(transition.isSameScope, false);
  assert.equal(transition.scopeCache['workspace:scope-1'].collections, resources.collections);
  assert.equal(transition.scopeCache['workspace:scope-1'].lastSyncedAt, 900);
  assert.equal(transition.targetResources.collections, targetCache.collections);
  assert.equal(transition.targetResources.tabs, targetCache.tabs);
  assert.equal(transition.isFresh, true);
});

test('offline transitions preserve the active local workspace and force sync bypasses freshness', () => {
  const { prepareCloudScopeTransition } = loadCloudScopeTransition();
  const transition = prepareCloudScopeTransition({
    workspaceMode: 'offline',
    targetScope: scope,
    activeOfflineWorkspaceId: 'offline-1',
    offlineScopeCache: {},
    scopeCache: {
      'workspace:scope-1': {
        collections: [], environments: [], activeEnvironmentId: null,
        tabs: [{ id: 'tab-2' }], activeTabId: 'tab-2', history: [], lastSyncedAt: Date.now(),
      },
    },
    resources,
    lastSyncedAt: null,
    forceSync: true,
    cacheTtlMs: 60_000,
    createInitialTab: () => ({ id: 'new-tab' }),
  });

  assert.equal(transition.offlineScopeCache['offline-1'].history, resources.history);
  assert.equal(transition.targetResources.activeTabId, 'tab-2');
  assert.equal(transition.isFresh, false);
});

test('matching cloud scopes retain the early-return signal for the store facade', () => {
  const { prepareCloudScopeTransition } = loadCloudScopeTransition();
  const transition = prepareCloudScopeTransition({
    workspaceMode: 'cloud',
    activeCloudScope: scope,
    targetScope: scope,
    activeOfflineWorkspaceId: 'offline-1',
    offlineScopeCache: {},
    scopeCache: {},
    resources,
    lastSyncedAt: null,
    forceSync: false,
    cacheTtlMs: 60_000,
    createInitialTab: () => ({ id: 'new-tab' }),
  });

  assert.equal(transition.isSameScope, true);
});
