import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadCloudCollectionSync() {
  const compile = (filePath) => ts.transpileModule(
    fs.readFileSync(new URL(filePath, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const syncCollections = {};
  vm.runInNewContext(compile('../packages/common/src/workspace/cloudSyncCollections.ts'), { exports: syncCollections, Date });
  const exports = {};
  vm.runInNewContext(compile('../packages/common/src/workspace/cloudCollectionSync.ts'), {
    exports,
    require: (id) => id.includes('cloudSyncCollections') ? syncCollections : {},
    Date,
    Map,
    Set,
  });
  return exports;
}

const pendingCollection = {
  id: 'pending', name: 'Pending', description: '', items: [], version: undefined,
  createdAt: 1, updatedAt: 1, _origin: 'cloud', _syncStatus: 'pending',
};

test('cloud collection sync uploads pending collections and surfaces an upload failure without mutating the helper input', async () => {
  const { pushPendingCloudCollections } = loadCloudCollectionSync();
  const uploaded = [];
  const result = await pushPendingCloudCollections({
    collections: [pendingCollection],
    upload: async (collection) => { uploaded.push(collection.id); },
    isCurrent: () => true,
    isAborted: () => false,
    onUploaded: () => {},
  });
  assert.deepEqual(uploaded, ['pending']);
  assert.equal(result.status, 'completed');

  const failure = await pushPendingCloudCollections({
    collections: [pendingCollection],
    upload: async () => { throw new Error('network unavailable'); },
    isCurrent: () => true,
    isAborted: () => false,
    onUploaded: () => assert.fail('must not mark an unsuccessful upload as synced'),
  });
  assert.equal(failure.status, 'failed');
  assert.equal(failure.collection, pendingCollection);
});

test('cloud collection sync reuses unchanged data, retries incomplete details, and retains local pending records', async () => {
  const { pullCloudCollections } = loadCloudCollectionSync();
  const unchanged = { ...pendingCollection, id: 'unchanged', name: 'Old', version: 2, updatedAt: 100, _syncStatus: 'synced', items: [{ id: 'request-1' }] };
  const errors = [];
  const result = await pullCloudCollections({
    currentCollections: [unchanged, pendingCollection],
    fetchMetadata: async () => [
      { id: 'unchanged', name: 'Renamed', version: 2, updated_at: '1970-01-01T00:00:00.100Z' },
      { id: 'incomplete', name: 'Incomplete' },
    ],
    fetchDetail: async (id) => {
      if (id === 'incomplete') throw new Error('temporary detail failure');
      assert.fail(`unexpected detail request for ${id}`);
    },
    buildCollection: () => assert.fail('must not build a collection without details'),
    isCurrent: () => true,
    onDetailFetchError: (metadata) => errors.push(metadata.id),
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.partialCollectionCount, 1);
  assert.deepEqual(errors, ['incomplete']);
  assert.equal(result.collections[0].items, unchanged.items);
  assert.equal(result.collections[0].name, 'Renamed');
  assert.equal(result.collections[1].isPartial, true);
  assert.equal(result.collections[2].id, 'pending');
});
