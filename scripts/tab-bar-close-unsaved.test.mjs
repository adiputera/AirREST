import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadTabBarClosePlan() {
  const source = fs.readFileSync(
    new URL('../packages/common/src/components/tabBarClosePlan.ts', import.meta.url),
    'utf8',
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports });
  return {
    buildTabClosePlan: (...args) => JSON.parse(JSON.stringify(exports.buildTabClosePlan(...args))),
    resolveNextDirtyTab: (...args) => JSON.parse(JSON.stringify(exports.resolveNextDirtyTab(...args))),
    collectRemainingTabIdsToDiscard: (...args) =>
      JSON.parse(JSON.stringify(exports.collectRemainingTabIdsToDiscard(...args))),
  };
}

test('Close All plan partitions 5 tabs with 3 unsaved changes and 2 clean tabs in order', () => {
  const { buildTabClosePlan } = loadTabBarClosePlan();
  const tabs = [
    { id: 't1', dirty: true },
    { id: 't2', dirty: false },
    { id: 't3', dirty: true },
    { id: 't4', dirty: false },
    { id: 't5', dirty: true },
  ];

  const plan = buildTabClosePlan(tabs, { type: 'all' }, (tab) => tab.dirty);
  assert.deepEqual(plan.cleanTabIds, ['t2', 't4']);
  assert.deepEqual(
    plan.dirtyTabs.map((tab) => tab.id),
    ['t1', 't3', 't5'],
  );
});

test('Close Other Tabs and Close Tabs to the Right respect scope boundaries and dirty flags', () => {
  const { buildTabClosePlan } = loadTabBarClosePlan();
  const tabs = [
    { id: 't1', dirty: true },
    { id: 't2', dirty: false },
    { id: 't3', dirty: true },
    { id: 't4', dirty: true },
  ];

  const othersPlan = buildTabClosePlan(tabs, { type: 'others', keepTabId: 't3' }, (tab) => tab.dirty);
  assert.deepEqual(othersPlan.cleanTabIds, ['t2']);
  assert.deepEqual(
    othersPlan.dirtyTabs.map((tab) => tab.id),
    ['t1', 't4'],
  );

  const missingOthers = buildTabClosePlan(tabs, { type: 'others', keepTabId: 'missing' }, (tab) => tab.dirty);
  assert.deepEqual(missingOthers.targetTabs, []);

  const rightPlan = buildTabClosePlan(tabs, { type: 'right', pivotTabId: 't2' }, (tab) => tab.dirty);
  assert.deepEqual(rightPlan.cleanTabIds, []);
  assert.deepEqual(
    rightPlan.dirtyTabs.map((tab) => tab.id),
    ['t3', 't4'],
  );

  const lastRightPlan = buildTabClosePlan(tabs, { type: 'right', pivotTabId: 't4' }, (tab) => tab.dirty);
  assert.deepEqual(lastRightPlan.targetTabs, []);
});

test('resolveNextDirtyTab advances through dirty tabs, skips missing tabs, and closes newly clean tabs', () => {
  const { resolveNextDirtyTab } = loadTabBarClosePlan();
  const liveTabs = [
    { id: 't2', dirty: false },
    { id: 't3', dirty: true },
    { id: 't4', dirty: true },
  ];

  const step1 = resolveNextDirtyTab(['missing', 't2', 't3', 't4'], liveTabs, (tab) => tab.dirty);
  assert.equal(step1.nextTab?.id, 't3');
  assert.deepEqual(step1.remainingTabIds, ['t4']);
  assert.deepEqual(step1.cleanTabIdsToClose, ['t2']);

  const step2 = resolveNextDirtyTab(step1.remainingTabIds, liveTabs, (tab) => tab.dirty);
  assert.equal(step2.nextTab?.id, 't4');
  assert.deepEqual(step2.remainingTabIds, []);
  assert.deepEqual(step2.cleanTabIdsToClose, []);

  const done = resolveNextDirtyTab(step2.remainingTabIds, liveTabs, (tab) => tab.dirty);
  assert.equal(done.nextTab, null);
  assert.deepEqual(done.remainingTabIds, []);
  assert.deepEqual(done.cleanTabIdsToClose, []);
});

test('TabBar routes all close actions through unsaved-change confirmation queueing', () => {
  const source = fs.readFileSync(
    new URL('../packages/common/src/components/TabBar.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /handleRequestCloseScope\(\{ type: 'others', keepTabId: id \}\)/);
  assert.match(source, /handleRequestCloseScope\(\{ type: 'right', pivotTabId: id \}\)/);
  const closeAllMatches = source.match(/handleRequestCloseScope\(\{ type: 'all' \}\)/g) || [];
  assert.equal(closeAllMatches.length, 2, 'Both tab and bar context menus must route Close All through handleRequestCloseScope');
  assert.doesNotMatch(source, /onClick=\{\(\) => \{\s*close(?:AllTabs|OtherTabs|TabsToRight)\(/);
  assert.match(source, /useBackHandler\(Boolean\(unsavedConfirmTab\), handleCancelClose, 30\)/);
  assert.match(source, /if \(e\.key === 'Escape'\)\s*\{\s*handleCancelClose\(\);/);
  assert.match(source, /advanceCloseQueue\(\);/);
  assert.match(source, /clearPendingCloseQueue\(\);/);
  assert.match(source, /key=\{unsavedConfirmTab\.id\}/);
  assert.match(source, /handleConfirmDiscardAll/);
  assert.match(source, /Discard All \(\{closeBatchRemainingCount \+ 1\}\)/);
});

test('collectRemainingTabIdsToDiscard returns deduplicated live tab IDs without touching unrelated tabs', () => {
  const { collectRemainingTabIdsToDiscard } = loadTabBarClosePlan();
  const liveTabs = [{ id: 'keep' }, { id: 't1' }, { id: 't2' }, { id: 't3' }];

  const ids = collectRemainingTabIdsToDiscard('t1', ['t2', 'missing', 't1', 't3'], liveTabs);
  assert.deepEqual(ids, ['t1', 't2', 't3']);
});
