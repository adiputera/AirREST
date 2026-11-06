import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadWorkspaceModeTransition() {
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
  vm.runInNewContext(compile('../packages/common/src/workspace/workspaceModeTransition.ts'), {
    exports,
    require: (id) => id.includes('scopeCache') ? cacheExports : snapshotExports,
  });
  return exports;
}

const cloudScope = { type: 'workspace', id: 'cloud-1', name: 'Cloud 1' };
const resources = {
  collections: [{ id: 'collection-1' }], environments: [{ id: 'environment-1' }],
  activeEnvironmentId: 'environment-1', tabs: [{ id: 'tab-1' }], activeTabId: 'tab-1', history: [{ id: 'history-1' }],
};

test('leaving cloud snapshots the current scope and restores the selected offline workspace', () => {
  const { prepareWorkspaceModeTransition } = loadWorkspaceModeTransition();
  const offlineCache = {
    'offline-1': {
      collections: [{ id: 'offline-collection' }], environments: [], activeEnvironmentId: null,
      tabs: [{ id: 'offline-tab' }], activeTabId: 'offline-tab', history: [{ id: 'offline-history' }],
    },
  };
  const transition = prepareWorkspaceModeTransition({
    currentWorkspaceMode: 'cloud', nextWorkspaceMode: 'offline', activeCloudScope: cloudScope,
    activeOfflineWorkspaceId: 'offline-1', fallbackOfflineWorkspaceId: 'default-offline',
    offlineScopeCache: offlineCache, scopeCache: {}, resources, lastSyncedAt: 500,
    cacheTtlMs: 100, createInitialTab: () => ({ id: 'new-tab' }),
  });

  assert.equal(transition.scopeCache['workspace:cloud-1'].collections, resources.collections);
  assert.equal(transition.scopeCache['workspace:cloud-1'].lastSyncedAt, 500);
  assert.equal(transition.targetResources.collections, offlineCache['offline-1'].collections);
  assert.equal(transition.targetResources.activeTabId, 'offline-tab');
});

test('entering cloud snapshots an identified offline workspace and restores a fresh cloud cache', () => {
  const { prepareWorkspaceModeTransition } = loadWorkspaceModeTransition();
  const syncedAt = Date.now();
  const cloudCache = {
    'workspace:cloud-1': {
      collections: [{ id: 'cloud-collection' }], environments: [], activeEnvironmentId: null,
      tabs: [{ id: 'cloud-tab' }], activeTabId: 'cloud-tab', history: [], lastSyncedAt: syncedAt,
    },
  };
  const transition = prepareWorkspaceModeTransition({
    currentWorkspaceMode: 'offline', nextWorkspaceMode: 'cloud', activeCloudScope: cloudScope,
    activeOfflineWorkspaceId: 'offline-1', fallbackOfflineWorkspaceId: 'default-offline',
    offlineScopeCache: {}, scopeCache: cloudCache, resources, lastSyncedAt: null,
    cacheTtlMs: 60_000, createInitialTab: () => ({ id: 'new-tab' }),
  });

  assert.equal(transition.offlineScopeCache['offline-1'].history, resources.history);
  assert.equal(transition.targetResources.collections, cloudCache['workspace:cloud-1'].collections);
  assert.equal(transition.isCloudCacheFresh, true);
});

test('entering cloud without an active offline workspace does not create a synthetic snapshot', () => {
  const { prepareWorkspaceModeTransition } = loadWorkspaceModeTransition();
  const transition = prepareWorkspaceModeTransition({
    currentWorkspaceMode: 'offline', nextWorkspaceMode: 'cloud', activeOfflineWorkspaceId: undefined,
    fallbackOfflineWorkspaceId: 'default-offline', offlineScopeCache: {}, scopeCache: {}, resources,
    lastSyncedAt: null, cacheTtlMs: 60_000, createInitialTab: () => ({ id: 'new-tab' }),
  });

  assert.equal(Object.keys(transition.offlineScopeCache).length, 0);
  assert.equal(transition.targetResources.activeTabId, 'new-tab');
});
