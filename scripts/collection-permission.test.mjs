import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Collection Permission: Modal exists and renders expected role options', () => {
  for (const filePath of [
    'packages/common/src/components/CollectionPermissionModal.tsx',
    'extension/src/components/CollectionPermissionModal.tsx',
  ]) {
    const content = fs.readFileSync(new URL(`../${filePath}`, import.meta.url), 'utf8');

    // Verify modal component exists
    assert.match(content, /export const CollectionPermissionModal/, `${filePath} must export CollectionPermissionModal`);

    // Verify 4 roles are defined
    assert.match(content, /role:\s*'reader'/);
    assert.match(content, /role:\s*'contributor'/);
    assert.match(content, /role:\s*'maintainer'/);
    assert.match(content, /role:\s*'admin'/);

    // Verify clean titles without production or restricted descriptions
    assert.match(content, /🔵 Maintainer\+/);
    assert.match(content, /🔴 Admin Only/);
    assert.doesNotMatch(content, /Production \/ Release/);
    assert.doesNotMatch(content, /Admin Only \(Restricted\)/);

    // Verify updateCollectionPermission is invoked
    assert.match(content, /updateCollectionPermission\(collection\.id,\s*selectedRole\)/);
  }
});

test('Collection Permission: Sidebar integrates Permission option in 3-dots menu', () => {
  for (const filePath of [
    'packages/common/src/components/Sidebar.tsx',
    'extension/src/components/Sidebar.tsx',
  ]) {
    const content = fs.readFileSync(new URL(`../${filePath}`, import.meta.url), 'utf8');

    // Verify canManageCollectionPermission calculation
    assert.match(content, /canManageCollectionPermission\s*=\s*isProjectScope\s*&&\s*\(isProjectAdmin\s*\|\|\s*isProjectMaintainer\)/);

    // Verify 3-dots menu has Permission option
    assert.match(content, /canManageCollectionPermission\s*&&/);
    assert.match(content, /setCollectionForPermission\(col\)/);
    assert.match(content, /<span>Permission<\/span>/);

    // Verify CollectionPermissionModal is rendered
    assert.match(content, /<CollectionPermissionModal[\s\S]*?collection=\{collectionForPermission\}/);
  }
});

test('Collection Permission: store and cloudApi support updating min_role', () => {
  for (const filePath of [
    'packages/common/src/store/useApiStore.ts',
    'extension/src/store/useApiStore.ts',
  ]) {
    const content = fs.readFileSync(new URL(`../${filePath}`, import.meta.url), 'utf8');
    assert.match(content, /updateCollectionPermission:\s*async\s*\(collectionId,\s*minRole\)/);
    assert.match(content, /updateScopeCollectionPermission/);
  }

  for (const filePath of [
    'packages/common/src/lib/cloudApi.ts',
    'extension/src/lib/cloudApi.ts',
  ]) {
    const content = fs.readFileSync(new URL(`../${filePath}`, import.meta.url), 'utf8');
    assert.match(content, /export async function updateScopeCollectionPermission/);
    assert.match(content, /fetchWithAuth\(`\/api\/v1\/collections\/\$\{collectionId\}`/);
    assert.match(content, /method:\s*'PUT'/);
    assert.match(content, /min_role:\s*minRole/);
  }
});

test('Environment Permission: Modal exists and replaces plain dropdown in EnvironmentModal', () => {
  for (const filePath of [
    'packages/common/src/components/EnvironmentPermissionModal.tsx',
    'extension/src/components/EnvironmentPermissionModal.tsx',
  ]) {
    const content = fs.readFileSync(new URL(`../${filePath}`, import.meta.url), 'utf8');

    // Verify modal component exists
    assert.match(content, /export const EnvironmentPermissionModal/, `${filePath} must export EnvironmentPermissionModal`);

    // Verify 4 roles are defined
    assert.match(content, /role:\s*'reader'/);
    assert.match(content, /role:\s*'contributor'/);
    assert.match(content, /role:\s*'maintainer'/);
    assert.match(content, /role:\s*'admin'/);

    // Verify clean titles without production or restricted descriptions
    assert.match(content, /🔵 Maintainer\+/);
    assert.match(content, /🔴 Admin Only/);
    assert.doesNotMatch(content, /Production \/ Release/);
    assert.doesNotMatch(content, /Admin Only \(Restricted\)/);
  }

  for (const filePath of [
    'packages/common/src/components/EnvironmentModal.tsx',
    'extension/src/components/EnvironmentModal.tsx',
  ]) {
    const content = fs.readFileSync(new URL(`../${filePath}`, import.meta.url), 'utf8');

    // Verify EnvironmentPermissionModal is imported and mounted
    assert.match(content, /import\s*\{\s*EnvironmentPermissionModal\s*\}\s*from\s*'\.\/EnvironmentPermissionModal'/);
    assert.match(content, /<EnvironmentPermissionModal/);

    // Verify button opens permission modal instead of native select dropdown
    assert.match(content, /onClick=\{\(\)\s*=>\s*setIsPermModalOpen\(true\)\}/);
    assert.match(content, /onClick=\{\(\)\s*=>\s*setIsNewEnvPermModalOpen\(true\)\}/);
    assert.doesNotMatch(content, /<select[^>]*value=\{currentEnv\.minRole/);
  }
});


