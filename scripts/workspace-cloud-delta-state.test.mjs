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
  const requestDiff = {};
  vm.runInNewContext(compile('../packages/common/src/lib/requestDiff.ts'), { exports: requestDiff });
  vm.runInNewContext(compile('../packages/common/src/workspace/cloudDeltaState.ts'), {
    exports,
    require: (id) => id.includes('requestDiff') ? requestDiff : id.includes('scopeCache') ? cacheExports : snapshotExports,
  });
  return exports;
}

function deletionInput() {
  const request = { id: 'request-1', name: 'Example', url: 'https://example.com', bodyContent: 'saved' };
  const collection = { id: 'collection-1', name: 'Original', items: [
    { id: 'folder-1', type: 'folder', items: [{ id: request.id, type: 'request', request }] },
  ] };
  return {
    scope: { type: 'workspace', id: 'workspace-1' }, scopeCache: {},
    currentCollections: [collection], collections: [],
    tabs: [{ ...request, bodyContent: 'local edits' }, { id: 'new-tab', name: 'Draft' }],
    activeTabId: request.id, history: [], pulledEnvironments: [], currentEnvironments: [],
    activeEnvironmentId: null, partialCollectionCount: 0, syncedAt: 3000,
  };
}

for (const removal of ['request', 'folder', 'collection']) {
  test(`sync marks open tabs when their ${removal} is deleted and retains local edits`, () => {
    const { prepareCloudDeltaState } = loadCloudDeltaState();
    const input = deletionInput();
    if (removal !== 'collection') {
      input.collections = [{ ...input.currentCollections[0], items: removal === 'folder' ? [] : [
        { id: 'folder-1', type: 'folder', items: [] },
      ] }];
    }
    const state = prepareCloudDeltaState(input);
    assert.equal(state.tabs[0].deletedFromCollection, 'Original');
    assert.equal(state.tabs[0].bodyContent, 'local edits');
    assert.equal(state.tabs[0].id, input.activeTabId);
    assert.equal(state.tabs[1].deletedFromCollection, undefined);
    assert.equal(state.scopeCache['workspace:workspace-1'].tabs, state.tabs);
    assert.equal(input.tabs[0].deletedFromCollection, undefined);
    const repeated = prepareCloudDeltaState({ ...input, currentCollections: state.collections, tabs: state.tabs });
    assert.equal(repeated.tabs[0].deletedFromCollection, 'Original');
  });
}

test('partial collection details do not mark a request deleted', () => {
  const { prepareCloudDeltaState } = loadCloudDeltaState();
  const input = deletionInput();
  input.collections = [{ ...input.currentCollections[0], items: [], isPartial: true }];
  input.partialCollectionCount = 1;
  assert.equal(prepareCloudDeltaState(input).tabs[0].deletedFromCollection, undefined);
});

test('restored or moved requests clear the deletion marker without overwriting local edits', () => {
  const { prepareCloudDeltaState } = loadCloudDeltaState();
  const input = deletionInput();
  input.tabs[0].deletedFromCollection = 'Original';
  input.collections = [{ ...input.currentCollections[0], id: 'destination', name: 'Destination' }];
  const state = prepareCloudDeltaState(input);
  assert.equal(state.tabs[0].deletedFromCollection, undefined);
  assert.equal(state.tabs[0].bodyContent, 'local edits');
});

test('cloud delta state retains local current values and persists the synchronized scope snapshot', () => {
  const { prepareCloudDeltaState } = loadCloudDeltaState();
  const state = prepareCloudDeltaState({
    scope: { type: 'workspace', id: 'workspace-1', name: 'Workspace 1' },
    scopeCache: {},
    collections: [{ id: 'collection-1', items: [] }],
    currentCollections: [],
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
    currentCollections: [],
    pulledEnvironments: [{ id: 'environment-2', name: 'Server', variables: [] }], currentEnvironments: [],
    activeEnvironmentId: 'missing', tabs: [{ id: 'tab-1' }], activeTabId: 'tab-1', history: [],
    partialCollectionCount: 2, syncedAt: 2_000,
  });

  assert.equal(state.activeEnvironmentId, 'environment-2');
  assert.equal(state.syncStatus, 'error');
  assert.match(state.syncError, /2 collection details/);
});
