import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadSyncService(implementations) {
  const source = fs.readFileSync(new URL('../packages/common/src/workspace/cloudWorkspaceSync.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: () => implementations,
  }, { filename: 'packages/common/src/workspace/cloudWorkspaceSync.ts' });
  return exports;
}

test('coordinates pending uploads, collection reconciliation, and environment loading through injected operations', async () => {
  const calls = [];
  const { synchronizeCloudWorkspace } = loadSyncService({
    pushPendingCloudCollections: async ({ onUploaded }) => {
      calls.push('push');
      onUploaded({ id: 'pending' });
      return { status: 'completed' };
    },
    pullCloudCollections: async () => {
      calls.push('pull');
      return { status: 'completed', collections: [{ id: 'cloud', items: [] }], partialCollectionCount: 1 };
    },
  });

  const result = await synchronizeCloudWorkspace({
    currentCollections: [{ id: 'pending', items: [] }],
    uploadPendingCollection: async () => {},
    fetchCollectionMetadata: async () => [],
    fetchCollectionDetail: async () => null,
    fetchEnvironments: async () => { calls.push('environments'); return [{ id: 'env' }]; },
    buildCollection: (value) => value,
    buildEnvironments: (values) => values.map((value) => ({ ...value, variables: [] })),
    isCurrent: () => true,
    isAborted: () => false,
    onPendingCollectionUploaded: () => calls.push('uploaded'),
    onCollectionDetailFetchError: () => {},
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['push', 'uploaded', 'pull', 'environments']);
  assert.equal(result.collections[0].id, 'cloud');
  assert.equal(result.environments[0].id, 'env');
  assert.equal(result.partialCollectionCount, 1);
});

test('returns contextual pending-upload failures without fetching remote resources', async () => {
  let fetched = false;
  const { synchronizeCloudWorkspace } = loadSyncService({
    pushPendingCloudCollections: async () => ({ status: 'failed', collection: { id: 'pending', name: 'Pending', items: [] }, error: new Error('offline') }),
    pullCloudCollections: async () => { fetched = true; return { status: 'cancelled' }; },
  });

  const result = await synchronizeCloudWorkspace({
    currentCollections: [],
    uploadPendingCollection: async () => {},
    fetchCollectionMetadata: async () => [],
    fetchCollectionDetail: async () => null,
    fetchEnvironments: async () => [],
    buildCollection: (value) => value,
    buildEnvironments: () => [],
    isCurrent: () => true,
    isAborted: () => false,
    onPendingCollectionUploaded: () => {},
    onCollectionDetailFetchError: () => {},
  });

  assert.equal(result.status, 'push_failed');
  assert.equal(result.collection.name, 'Pending');
  assert.equal(fetched, false);
});

test('stops before environment loading when reconciliation is cancelled', async () => {
  let environmentFetches = 0;
  const { synchronizeCloudWorkspace } = loadSyncService({
    pushPendingCloudCollections: async () => ({ status: 'completed' }),
    pullCloudCollections: async () => ({ status: 'cancelled' }),
  });

  const result = await synchronizeCloudWorkspace({
    currentCollections: [],
    uploadPendingCollection: async () => {},
    fetchCollectionMetadata: async () => [],
    fetchCollectionDetail: async () => null,
    fetchEnvironments: async () => { environmentFetches++; return []; },
    buildCollection: (value) => value,
    buildEnvironments: () => [],
    isCurrent: () => true,
    isAborted: () => false,
    onPendingCollectionUploaded: () => {},
    onCollectionDetailFetchError: () => {},
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(environmentFetches, 0);
});
