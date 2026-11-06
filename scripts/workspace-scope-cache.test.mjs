import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadScopeCache() {
  const source = fs.readFileSync(
    new URL('../packages/common/src/workspace/scopeCache.ts', import.meta.url),
    'utf8',
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports }, {
    filename: 'packages/common/src/workspace/scopeCache.ts',
  });
  return exports;
}

test('scope cache helpers keep keys, tab selection, and TTL behavior stable', () => {
  const { getScopeCacheKey, isScopeCacheFresh, resolveCachedScopeTabs } = loadScopeCache();
  const cached = { tabs: [{ id: 'tab-1' }, { id: 'tab-2' }], activeTabId: 'tab-2', lastSyncedAt: 900 };

  assert.equal(getScopeCacheKey({ type: 'project', id: 'project-1' }), 'project:project-1');
  assert.equal(getScopeCacheKey(null), 'default');
  const cachedTabs = resolveCachedScopeTabs(cached, () => ({ id: 'new-tab' }));
  assert.equal(cachedTabs.tabs, cached.tabs);
  assert.equal(cachedTabs.activeTabId, 'tab-2');
  const repairedTabs = resolveCachedScopeTabs(
    { tabs: cached.tabs, activeTabId: 'missing' },
    () => ({ id: 'new-tab' }),
  );
  assert.equal(repairedTabs.tabs, cached.tabs);
  assert.equal(repairedTabs.activeTabId, 'tab-1');
  assert.equal(isScopeCacheFresh(cached, 200, 1_000), true);
  assert.equal(isScopeCacheFresh(cached, 50, 1_000), false);
});
