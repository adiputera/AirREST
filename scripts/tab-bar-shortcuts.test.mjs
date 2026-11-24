import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadTabBarShortcuts() {
  const source = fs.readFileSync(
    new URL('../packages/common/src/components/tabBarShortcuts.ts', import.meta.url),
    'utf8',
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports });
  return {
    isCloseActiveTabShortcut: (...args) => Boolean(exports.isCloseActiveTabShortcut(...args)),
    getCloseTabShortcutLabel: (...args) => String(exports.getCloseTabShortcutLabel(...args)),
  };
}

test('Alt+W matches close-active-tab shortcut across desktop, extension, and web platforms', () => {
  const { isCloseActiveTabShortcut } = loadTabBarShortcuts();

  for (const isDesktop of [false, true]) {
    assert.equal(
      isCloseActiveTabShortcut(
        { key: 'w', code: 'KeyW', altKey: true },
        { isDesktop, isMac: false },
      ),
      true,
    );
    assert.equal(
      isCloseActiveTabShortcut(
        { key: 'W', code: 'KeyW', altKey: true },
        { isDesktop, isMac: false },
      ),
      true,
    );
    // macOS Option+W produces '∑' for event.key with code 'KeyW'
    assert.equal(
      isCloseActiveTabShortcut(
        { key: '∑', code: 'KeyW', altKey: true },
        { isDesktop, isMac: true },
      ),
      true,
    );
  }
});

test('Ctrl+W and Cmd+W only match on desktop runtime and respect OS modifier conventions', () => {
  const { isCloseActiveTabShortcut } = loadTabBarShortcuts();

  // Browser / extension / hub must not intercept Ctrl+W or Cmd+W
  assert.equal(
    isCloseActiveTabShortcut(
      { key: 'w', code: 'KeyW', ctrlKey: true },
      { isDesktop: false, isMac: false },
    ),
    false,
  );
  assert.equal(
    isCloseActiveTabShortcut(
      { key: 'w', code: 'KeyW', metaKey: true },
      { isDesktop: false, isMac: true },
    ),
    false,
  );

  // Windows/Linux desktop uses Ctrl+W
  assert.equal(
    isCloseActiveTabShortcut(
      { key: 'w', code: 'KeyW', ctrlKey: true },
      { isDesktop: true, isMac: false },
    ),
    true,
  );
  assert.equal(
    isCloseActiveTabShortcut(
      { key: 'w', code: 'KeyW', metaKey: true },
      { isDesktop: true, isMac: false },
    ),
    false,
  );

  // macOS desktop uses Cmd+W
  assert.equal(
    isCloseActiveTabShortcut(
      { key: 'w', code: 'KeyW', metaKey: true },
      { isDesktop: true, isMac: true },
    ),
    true,
  );
  assert.equal(
    isCloseActiveTabShortcut(
      { key: 'w', code: 'KeyW', ctrlKey: true },
      { isDesktop: true, isMac: true },
    ),
    false,
  );
});

test('Close-tab shortcut ignores repeats, prevented events, AltGraph, extra modifiers, and non-W keys', () => {
  const { isCloseActiveTabShortcut } = loadTabBarShortcuts();

  assert.equal(
    isCloseActiveTabShortcut(
      { key: 'w', code: 'KeyW', altKey: true, repeat: true },
      { isDesktop: true, isMac: false },
    ),
    false,
  );
  assert.equal(
    isCloseActiveTabShortcut(
      { key: 'w', code: 'KeyW', ctrlKey: true, defaultPrevented: true },
      { isDesktop: true, isMac: false },
    ),
    false,
  );
  assert.equal(
    isCloseActiveTabShortcut(
      { key: 'w', code: 'KeyW', altKey: true, shiftKey: true },
      { isDesktop: true, isMac: false },
    ),
    false,
  );
  assert.equal(
    isCloseActiveTabShortcut(
      { key: 'w', code: 'KeyW', ctrlKey: true, altKey: true },
      { isDesktop: true, isMac: false },
    ),
    false,
  );
  assert.equal(
    isCloseActiveTabShortcut(
      {
        key: 'w',
        code: 'KeyW',
        altKey: true,
        getModifierState: (mod) => mod === 'AltGraph',
      },
      { isDesktop: true, isMac: false },
    ),
    false,
  );
  assert.equal(
    isCloseActiveTabShortcut(
      { key: 's', code: 'KeyS', ctrlKey: true },
      { isDesktop: true, isMac: false },
    ),
    false,
  );
});

test('getCloseTabShortcutLabel formats platform-appropriate shortcut hints', () => {
  const { getCloseTabShortcutLabel } = loadTabBarShortcuts();

  assert.equal(getCloseTabShortcutLabel({ isDesktop: true, isMac: false }), 'Ctrl+W / Alt+W');
  assert.equal(getCloseTabShortcutLabel({ isDesktop: true, isMac: true }), '⌘+W / Option+W');
  assert.equal(getCloseTabShortcutLabel({ isDesktop: false, isMac: false }), 'Alt+W');
  assert.equal(getCloseTabShortcutLabel({ isDesktop: false, isMac: true }), 'Option+W');
});

test('TabBar wires close-active-tab shortcut through handleRequestCloseTab with modal guards', () => {
  const source = fs.readFileSync(
    new URL('../packages/common/src/components/TabBar.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /isCloseActiveTabShortcut\(/);
  assert.match(source, /hasOpenBlockingModal\(\)/);
  assert.match(source, /tabIdsRef\.current\.includes\(currentActiveId\)/);
  assert.match(source, /handleRequestCloseTabRef\.current\(currentActiveId\)/);
});
