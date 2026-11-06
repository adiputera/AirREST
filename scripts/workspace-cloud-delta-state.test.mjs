import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadCloudDeltaState() {
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
  vm.runInNewContext(compile('../packages/common/src/workspace/cloudDeltaState.ts'), {
    exports,
    require: (id) => id.includes('scopeCache') ? cacheExports : snapshotExports,
  });
  return exports;
}

test('cloud delta state retains local current values and persists the synchronized scope snapshot', () => {
  const { prepareCloudDeltaState } = loadCloudDeltaState();
  const state = prepareCloudDeltaState({
    scope: { type: 'workspace', id: 'workspace-1', name: 'Workspace 1' },
    scopeCache: {},
    collections: [{ id: 'collection-1', items: [] }],
    pulledEnvironments: [{ id: 'environment-1', name: 'Server', variables: [{ id: 'var-1', key: 'token', initialValue: 'server', currentValue: 'server', enabled: true }] }],
    currentEnvironments: [{ id: 'environment-1', name: 'Local', variables: [{ id: 'var-1', key: 'token', initialValue: 'server', currentValue: 'local', enabled: true }] }],
    activeEnvironmentId: 'environment-1', tabs: [{ id: 'tab-1' }], activeTabId: 'tab-1', history: [{ id: 'history-1' }],
    partialCollectionCount: 0, syncedAt: 1_000,
  });

  assert.equal(state.environments[0].variables[0].currentValue, 'local');
  assert.equal(state.activeEnvironmentId, 'environment-1');
  assert.equal(state.scopeCache['workspace:workspace-1'].lastSyncedAt, 1_000);
  assert.equal(state.syncStatus, 'synced');
});

test('cloud delta state chooses a valid environment and reports partial collection detail failures', () => {
  const { prepareCloudDeltaState } = loadCloudDeltaState();
  const state = prepareCloudDeltaState({
    scope: { type: 'project', id: 'project-1', name: 'Project 1' }, scopeCache: {}, collections: [],
    pulledEnvironments: [{ id: 'environment-2', name: 'Server', variables: [] }], currentEnvironments: [],
    activeEnvironmentId: 'missing', tabs: [{ id: 'tab-1' }], activeTabId: 'tab-1', history: [],
    partialCollectionCount: 2, syncedAt: 2_000,
  });

  assert.equal(state.activeEnvironmentId, 'environment-2');
  assert.equal(state.syncStatus, 'error');
  assert.match(state.syncError, /2 collection details/);
});
