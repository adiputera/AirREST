import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadCloudSyncCollections() {
  const source = ts.transpileModule(
    fs.readFileSync(new URL('../packages/common/src/workspace/cloudSyncCollections.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, Date });
  return exports;
}

const existing = {
  id: 'collection-1', name: 'Old', description: 'old', items: [{ id: 'request-1' }],
  version: 2, updatedAt: 100, createdAt: 10, _origin: 'cloud', _syncStatus: 'pending',
};

test('cloud sync collection helpers reuse unchanged data and retain pending local collections', () => {
  const { isPendingCloudCollection, retainPendingCloudCollections, reuseUnchangedCloudCollection } = loadCloudSyncCollections();
  const reused = reuseUnchangedCloudCollection(existing, { id: 'collection-1', name: 'New', version: 2, updated_at: '1970-01-01T00:00:00.100Z' });

  assert.equal(reused.items, existing.items);
  assert.equal(reused.name, 'New');
  assert.equal(reused._syncStatus, 'synced');
  assert.equal(isPendingCloudCollection(existing), true);
  assert.equal(retainPendingCloudCollections([existing, { ...existing, id: 'collection-2', version: 3, _syncStatus: 'synced' }], []).length, 1);
});

test('cloud sync collection helpers create a partial record when details cannot be loaded', () => {
  const { createPartialCloudCollection } = loadCloudSyncCollections();
  const partial = createPartialCloudCollection({ id: 'collection-1', name: 'Server collection', created_at: '1970-01-01T00:00:00.050Z' }, existing, 1_000);

  assert.equal(partial.isPartial, true);
  assert.equal(partial.items, existing.items);
  assert.equal(partial.createdAt, 50);
});
