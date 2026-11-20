import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadTabBarOverflow() {
  const source = fs.readFileSync(
    new URL('../packages/common/src/components/tabBarOverflow.ts', import.meta.url),
    'utf8'
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports });
  return exports;
}

test('should count request tabs clipped on each side of the viewport', () => {
  const { getTabOverflowCounts } = loadTabBarOverflow();
  const tabs = [
    { left: -40, right: 40 },
    { left: 48, right: 128 },
    { left: 136, right: 216 },
    { left: 224, right: 304 },
  ];

  const middle = getTabOverflowCounts({ left: 0, right: 200 }, tabs);
  assert.equal(middle.left, 1);
  assert.equal(middle.right, 2);

  const end = getTabOverflowCounts({ left: 0, right: 304 }, tabs);
  assert.equal(end.left, 1);
  assert.equal(end.right, 0);

  const full = getTabOverflowCounts({ left: -40, right: 304 }, tabs);
  assert.equal(full.left, 0);
  assert.equal(full.right, 0);
});

test('should calculate the minimum scroll needed to reveal a request tab', () => {
  const { getTabRevealScrollLeft, isTabFullyVisible } = loadTabBarOverflow();

  assert.equal(
    getTabRevealScrollLeft({ left: 0, right: 200 }, { left: 220, right: 300 }, 40),
    140
  );
  assert.equal(
    getTabRevealScrollLeft({ left: 0, right: 200 }, { left: -30, right: 70 }, 40),
    10
  );
  assert.equal(
    getTabRevealScrollLeft({ left: 0, right: 200 }, { left: 50, right: 150 }, 40),
    40
  );
  assert.equal(
    getTabRevealScrollLeft({ left: 0, right: 150 }, { left: 100, right: 300 }, 40),
    140
  );
  assert.equal(isTabFullyVisible({ left: 0, right: 200 }, { left: 1, right: 199 }), true);
  assert.equal(isTabFullyVisible({ left: 0, right: 200 }, { left: 1, right: 201.5 }), false);
});

test('should use a compact overflow count on narrow screens', () => {
  const { getCompactTabOverflowLabel } = loadTabBarOverflow();

  assert.equal(getCompactTabOverflowLabel(1), '1+');
  assert.equal(getCompactTabOverflowLabel(12), '12+');
});

test('should connect the tab bar viewport to overflow counts and explicit selection reveals', () => {
  const source = fs.readFileSync(
    new URL('../packages/common/src/components/TabBar.tsx', import.meta.url),
    'utf8'
  );

  assert.match(source, /tabRevealRevision/);
  assert.match(source, /ref=\{tabViewportRef\}/);
  assert.match(source, /getTabOverflowCounts/);
  assert.match(source, /getTabRevealScrollLeft/);
  assert.match(source, /more request tab/);
  assert.match(source, /getCompactTabOverflowLabel/);
  assert.match(source, /sm:hidden/);
  assert.match(source, /addEventListener\('wheel', handleTabWheel, \{ passive: false \}\)/);
  assert.match(source, /overflowFrameRef\.current = null/);
  assert.match(source, /scheduleActiveTabRevealOnResize/);
  assert.match(source, /ref=\{tabBarRef\}/);
  assert.match(source, /useLayoutEffect/);
});

test('should anchor the new-tab button to the last tab, right edge on overflow, or left edge when empty', () => {
  const source = fs.readFileSync(
    new URL('../packages/common/src/components/TabBar.tsx', import.meta.url),
    'utf8'
  );

  assert.doesNotMatch(source, /ref=\{tabViewportRef\}[^>]*flex-1/);
  assert.match(source, /className=\{hasTabs \? 'min-w-0 overflow-x-auto scrollbar-none' : 'hidden'\}/);
  assert.match(source, /ref=\{tabTrackRef\} className="flex w-max items-center gap-1\.5"/);
  assert.match(source, /hasTabs && tabOverflow\.left > 0/);
  assert.match(source, /hasTabs && tabOverflow\.right > 0/);
});
