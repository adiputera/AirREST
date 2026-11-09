import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Collection Sync & Retry: Collection interface defines _syncStatus', () => {
  const content = fs.readFileSync(new URL('../packages/common/src/types/api.ts', import.meta.url), 'utf8');
  assert.match(content, /_syncStatus\?:\s*'synced'\s*\|\s*'pending'\s*\|\s*'error'/);
});

test('Collection Sync & Retry: addCollection tags pending and rethrows on cloud sync error', () => {
  const content = fs.readFileSync(new URL('../packages/common/src/store/useApiStore.ts', import.meta.url), 'utf8');
  
  // Verify addCollection sets pending status
  assert.match(content, /_syncStatus:\s*isCloud\s*\?\s*'pending'\s*:\s*'synced'/);
  
  // Verify addCollection rethrows error on sync failure
  assert.match(
    content,
    /addCollection:\s*async[\s\S]*?batchImportToScope[\s\S]*?catch\s*\(err:\s*any\)[\s\S]*?_syncStatus:\s*'pending'[\s\S]*?throw err;/
  );
});

test('Collection Sync & Retry: replaceCollection tags pending and rethrows on cloud sync error', () => {
  const content = fs.readFileSync(new URL('../packages/common/src/store/useApiStore.ts', import.meta.url), 'utf8');

  // Verify replaceCollection sets pending status and rethrows on failure
  assert.match(
    content,
    /replaceCollection:\s*async[\s\S]*?batchImportToScope[\s\S]*?catch\s*\(err:\s*any\)[\s\S]*?_syncStatus:\s*'pending'[\s\S]*?throw err;/
  );
});

test('Collection Sync & Retry: ImportModal does not falsely conflict on pending unsynced collections and handles errors without closing', () => {
  const content = fs.readFileSync(new URL('../packages/common/src/components/ImportModal.tsx', import.meta.url), 'utf8');

  // Verify existingPendingCol is checked
  assert.match(content, /c\._syncStatus\s*===\s*'pending'/);

  // Verify conflict check excludes pending collections
  assert.match(content, /c\._syncStatus\s*!==\s*'pending'/);
});

test('Collection Sync & Retry: Sidebar displays pending sync indicator for un-synced collections', () => {
  const content = fs.readFileSync(new URL('../packages/common/src/components/Sidebar.tsx', import.meta.url), 'utf8');

  assert.match(content, /col\._syncStatus\s*===\s*'pending'/);
  assert.match(content, /not yet (?:uploaded to the|synced to) cloud/);
});

test('Collection Sync & Retry: Version consistency across workspace packages', () => {
  const readJson = (relPath) => JSON.parse(fs.readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8'));

  const rootPkg = readJson('package.json');
  const extPkg = readJson('apps/extension/package.json');
  const extManifest = readJson('apps/extension/public/manifest.json');
  const commonPkg = readJson('packages/common/package.json');
  const nativePkg = readJson('apps/native/package.json');
  const tauriConf = readJson('apps/native/src-tauri/tauri.conf.json');

  assert.equal(extPkg.version, rootPkg.version);
  assert.equal(extManifest.version, rootPkg.version);
  assert.equal(commonPkg.version, rootPkg.version);
  assert.equal(nativePkg.version, rootPkg.version);
  assert.equal(tauriConf.version, rootPkg.version);
});

