import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadRecovery() {
  const source = fs.readFileSync(new URL('../packages/common/src/workspace/cloudCacheRecovery.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, JSON }, { filename: 'packages/common/src/workspace/cloudCacheRecovery.ts' });
  return exports;
}

const emptyArchives = () => ({ version: 1, owners: {}, unclaimed: [] });

test('imports recovery archives only as unclaimed data', () => {
  const { importCloudCacheRecoveryBackup } = loadRecovery();
  const backup = JSON.stringify({
    format: 'AirREST cloud cache recovery',
    version: 1,
    archives: [{ scopeCache: { 'workspace:recoverable': { collections: [{ id: 'draft', items: [] }] } } }],
  });

  const result = importCloudCacheRecoveryBackup(emptyArchives(), backup);

  assert.equal(result.success, true);
  assert.equal(result.archiveCount, 1);
  assert.equal(result.archives.unclaimed[0].scopeCache['workspace:recoverable'].collections[0].id, 'draft');
  assert.equal(Object.keys(result.archives.owners).length, 0);
});

test('rejects malformed or prototype-polluting recovery data before it can enter persistence', () => {
  const { importCloudCacheRecoveryBackup } = loadRecovery();

  const malformed = importCloudCacheRecoveryBackup(emptyArchives(), '{');
  const unsafe = importCloudCacheRecoveryBackup(emptyArchives(),
    '{"format":"AirREST cloud cache recovery","version":1,"archives":[{"scopeCache":{"__proto__":{"polluted":true}}}]}');

  assert.equal(malformed.success, false);
  assert.match(malformed.error, /valid JSON/i);
  assert.equal(unsafe.success, false);
  assert.match(unsafe.error, /unsafe|invalid/i);
});

test('preserves opaque newer archives from a valid recovery file without opening them', () => {
  const { importCloudCacheRecoveryBackup } = loadRecovery();
  const futureArchive = { version: 2, payload: { retained: true } };
  const backup = JSON.stringify({
    format: 'AirREST cloud cache recovery', version: 1, archives: [], unsupportedArchives: [futureArchive],
  });

  const result = importCloudCacheRecoveryBackup(emptyArchives(), backup);

  assert.equal(result.success, true);
  assert.equal(result.unsupportedArchiveCount, 1);
  assert.equal(JSON.stringify(result.archives.unsupportedVersions), JSON.stringify([futureArchive]));
});
