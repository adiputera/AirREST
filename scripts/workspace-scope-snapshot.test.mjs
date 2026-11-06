import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadScopeSnapshot() {
  const cacheSource = ts.transpileModule(
    fs.readFileSync(new URL('../packages/common/src/workspace/scopeCache.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const cacheExports = {};
  vm.runInNewContext(cacheSource, { exports: cacheExports });
  const source = ts.transpileModule(
    fs.readFileSync(new URL('../packages/common/src/workspace/scopeSnapshot.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const exports = {};
  vm.runInNewContext(source, {
    exports,
    require: () => cacheExports,
  });
  return exports;
}

test('workspace snapshots retain cache resources and repair a stale active tab', () => {
  const { restoreWorkspaceResources, snapshotWorkspaceResources } = loadScopeSnapshot();
  const resources = {
    collections: [{ id: 'collection-1' }],
    environments: [{ id: 'environment-1' }],
    activeEnvironmentId: 'environment-1',
    tabs: [{ id: 'tab-1' }, { id: 'tab-2' }],
    activeTabId: 'missing-tab',
    history: [{ id: 'history-1' }],
  };
  const snapshot = snapshotWorkspaceResources(resources, 100);
  const restored = restoreWorkspaceResources(snapshot, () => ({ id: 'new-tab' }));

  assert.equal(snapshot.lastSyncedAt, 100);
  assert.equal(restored.collections, resources.collections);
  assert.equal(restored.environments, resources.environments);
  assert.equal(restored.activeEnvironmentId, 'environment-1');
  assert.equal(restored.tabs, resources.tabs);
  assert.equal(restored.activeTabId, 'tab-1');
  assert.equal(restored.history, resources.history);
});
