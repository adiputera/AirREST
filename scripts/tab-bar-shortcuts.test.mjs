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
    hasOpenBlockingModalWithDocument: (doc) => {
      const ex = {};
      vm.runInNewContext(compiled, { exports: ex, document: doc });
      return Boolean(ex.hasOpenBlockingModal());
    },
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
  assert.match(source, /airrest:close-active-tab/);
});

test('F08: macOS native menu replaces PredefinedMenuItem::close_window on Cmd+W with close_active_tab while preserving Edit menu', () => {
  const libRs = fs.readFileSync(
    new URL('../apps/native/src-tauri/src/lib.rs', import.meta.url),
    'utf8',
  );
  const nativeMain = fs.readFileSync(
    new URL('../apps/native/src/main.tsx', import.meta.url),
    'utf8',
  );

  assert.match(libRs, /#\[cfg\(target_os = "macos"\)\]/);
  assert.match(libRs, /"close_active_tab"/);
  assert.match(libRs, /Some\("CmdOrCtrl\+W"\)/);
  assert.match(libRs, /airrest:close-active-tab/);
  assert.match(libRs, /PredefinedMenuItem::undo/);
  assert.match(libRs, /PredefinedMenuItem::copy/);
  assert.match(libRs, /PredefinedMenuItem::paste/);
  assert.doesNotMatch(libRs, /PredefinedMenuItem::close_window/);
  assert.match(nativeMain, /listen\('airrest:close-active-tab'/);
  assert.match(nativeMain, /__AIRREST_MAC_NATIVE_CLOSE_TAB_MENU__/);
});

test('F05 & F09: hasOpenBlockingModal blocks on modals and workspace switch, but NOT on the window file-drag overlay', () => {
  const { hasOpenBlockingModalWithDocument } = loadTabBarShortcuts();
  const appSrc = fs.readFileSync(new URL('../packages/common/src/App.tsx', import.meta.url), 'utf8');
  assert.match(appSrc, /data-non-blocking-overlay="true"/);

  // Verify the selector explicitly excludes data-non-blocking-overlay="true"
  let capturedSelector = '';
  const fakeDoc = {
    querySelector(selector) {
      capturedSelector = selector;
      return null;
    },
  };
  assert.equal(hasOpenBlockingModalWithDocument(fakeDoc), false);
  assert.match(capturedSelector, /\[data-modal="true"\]/);
  assert.match(capturedSelector, /\[role="dialog"\]/);
  assert.match(capturedSelector, /\[data-payload-modal="true"\]/);
  assert.match(capturedSelector, /:not\(\[data-non-blocking-overlay="true"\]\)/);

  // Simulated DOM check: non-blocking drag overlay does NOT match, while modal dialogs DO match
  const matchesSelector = (el, selector) => {
    const parts = selector.split(',').map((s) => s.trim());
    return parts.some((part) => {
      if (part === '[data-modal="true"]') return el.attrs['data-modal'] === 'true';
      if (part === '[role="dialog"]') return el.attrs.role === 'dialog';
      if (part === '[data-payload-modal="true"]') return el.attrs['data-payload-modal'] === 'true';
      const zMatch = part.match(/^\.fixed\.inset-0\[class\*="([^"]+)"\](:not\(\[data-non-blocking-overlay="true"\]\))?$/);
      if (zMatch) {
        const cls = el.attrs.class || '';
        const hasFixedInset = cls.split(/\s+/).includes('fixed') && cls.split(/\s+/).includes('inset-0');
        const hasZ = cls.includes(zMatch[1]);
        const excluded = Boolean(zMatch[2]) && el.attrs['data-non-blocking-overlay'] === 'true';
        return hasFixedInset && hasZ && !excluded;
      }
      return false;
    });
  };

  const makeDoc = (elements) => ({
    querySelector: (selector) => elements.find((el) => matchesSelector(el, selector)) || null,
  });

  // 1. Only window file drag overlay mounted -> must NOT block dragover/drop
  assert.equal(
    hasOpenBlockingModalWithDocument(
      makeDoc([
        {
          attrs: {
            'aria-hidden': 'true',
            'data-non-blocking-overlay': 'true',
            class: 'pointer-events-none fixed inset-0 z-50 flex items-center justify-center',
          },
        },
      ]),
    ),
    false,
  );

  // 2. MoveRequestModal / ChangePasswordModal / PayloadBuilder / Workspace switch -> MUST block
  for (const el of [
    { attrs: { 'data-modal': 'true', role: 'dialog', class: 'fixed inset-0 z-50' } },
    { attrs: { 'data-payload-modal': 'true', class: 'fixed inset-0 z-50' } },
    { attrs: { 'data-modal': 'true', class: 'fixed inset-0 z-50' } },
  ]) {
    assert.equal(hasOpenBlockingModalWithDocument(makeDoc([el])), true);
  }
});

test('T-R1..T-R4: non-QWERTY macOS layouts do not misfire, desktop Ctrl/Cmd+W always prevents default, native repeat is throttled, and dirty close blurs editor', () => {
  const { isCloseActiveTabShortcut } = loadTabBarShortcuts();
  const tabBarSrc = fs.readFileSync(
    new URL('../packages/common/src/components/TabBar.tsx', import.meta.url),
    'utf8',
  );

  // T-R4: macOS AZERTY Cmd+Z / Option+Z (code KeyW, key z/Â) and Dvorak Option+, (code KeyW, key ≤) must NOT match
  assert.equal(
    isCloseActiveTabShortcut({ key: 'z', code: 'KeyW', metaKey: true }, { isDesktop: true, isMac: true }),
    false,
  );
  assert.equal(
    isCloseActiveTabShortcut({ key: 'Â', code: 'KeyW', altKey: true }, { isDesktop: true, isMac: true }),
    false,
  );
  assert.equal(
    isCloseActiveTabShortcut({ key: '≤', code: 'KeyW', altKey: true }, { isDesktop: true, isMac: true }),
    false,
  );

  // T-R1, T-R2, T-R3 contracts in TabBar.tsx
  assert.match(tabBarSrc, /if \(isDesktopRuntime && \(e\.ctrlKey \|\| e\.metaKey\)\) \{\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*triggerCloseActiveTab\(\);\s*return;\s*\}/);
  assert.match(tabBarSrc, /lastNativeCloseAtRef/);
  assert.match(tabBarSrc, /document\.activeElement\.blur\(\)/);
  assert.match(tabBarSrc, /unsavedCancelButtonRef\.current\?\.focus\(\)/);
});

test('T-R5 & T-R6: native close-tab listener only registers on Apple desktop with unlisten cleanup, and isApplePlatform handles userAgentData/platform/SSR', () => {
  const nativeMainSrc = fs.readFileSync(
    new URL('../apps/native/src/main.tsx', import.meta.url),
    'utf8',
  );
  assert.match(nativeMainSrc, /if \(isAppleDesktop\)/);
  assert.match(nativeMainSrc, /window\.addEventListener\('beforeunload', cleanupCloseTabListener, \{ once: true \}\)/);
  assert.match(nativeMainSrc, /hot\?\.dispose\([\s\S]*?cleanupCloseTabListener\(\);/);

  const source = fs.readFileSync(
    new URL('../packages/common/src/components/tabBarShortcuts.ts', import.meta.url),
    'utf8',
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const evalWithNav = (nav) => {
    const exports = {};
    vm.runInNewContext(compiled, { exports, navigator: nav });
    return Boolean(exports.isApplePlatform());
  };

  assert.equal(evalWithNav(undefined), false);
  assert.equal(evalWithNav({ userAgentData: { platform: 'macOS' }, platform: '' }), true);
  assert.equal(evalWithNav({ platform: 'MacIntel' }), true);
  assert.equal(evalWithNav({ platform: 'iPad' }), true);
  assert.equal(evalWithNav({ userAgentData: { platform: 'Linux' }, platform: 'Linux x86_64' }), false);
  assert.equal(evalWithNav({ userAgentData: { platform: 'Windows' }, platform: 'Win32' }), false);
});

test('getRequestShortcutLabels renders Ctrl+ shortcuts on Ubuntu/Windows and Command (⌘) shortcuts on macOS', () => {
  const source = fs.readFileSync(
    new URL('../packages/common/src/components/tabBarShortcuts.ts', import.meta.url),
    'utf8',
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const evalLabels = (nav, explicitIsMac) => {
    const exports = {};
    vm.runInNewContext(compiled, { exports, navigator: nav });
    const result = explicitIsMac === undefined
      ? exports.getRequestShortcutLabels()
      : exports.getRequestShortcutLabels(explicitIsMac);
    return { ...result };
  };

  assert.deepEqual(evalLabels({ userAgentData: { platform: 'Linux' }, platform: 'Linux x86_64' }), {
    send: 'Ctrl+Enter',
    save: 'Ctrl+S',
    undo: 'Ctrl+Z',
    redo: 'Ctrl+Y',
    paste: 'Ctrl+V',
  });
  assert.deepEqual(evalLabels({ userAgentData: { platform: 'Windows' }, platform: 'Win32' }), {
    send: 'Ctrl+Enter',
    save: 'Ctrl+S',
    undo: 'Ctrl+Z',
    redo: 'Ctrl+Y',
    paste: 'Ctrl+V',
  });
  assert.deepEqual(evalLabels({ userAgentData: { platform: 'macOS' }, platform: 'MacIntel' }), {
    send: '⌘+Enter',
    save: '⌘+S',
    undo: '⌘+Z',
    redo: '⌘+Shift+Z',
    paste: '⌘+V',
  });
  assert.equal(evalLabels(undefined, false).send, 'Ctrl+Enter');
  assert.equal(evalLabels(undefined, true).send, '⌘+Enter');

  const requestEditorSrc = fs.readFileSync(
    new URL('../packages/common/src/components/RequestEditor.tsx', import.meta.url),
    'utf8',
  );
  const emptyStudioSrc = fs.readFileSync(
    new URL('../packages/common/src/components/EmptyStudioView.tsx', import.meta.url),
    'utf8',
  );
  assert.match(requestEditorSrc, /getRequestShortcutLabels\(\)/);
  assert.match(requestEditorSrc, /\{shortcutLabels\.send\}/);
  assert.equal(requestEditorSrc.includes('>⌘+Enter</kbd>'), false);
  assert.match(emptyStudioSrc, /getRequestShortcutLabels\(\)/);
  assert.match(emptyStudioSrc, /\{shortcutLabels\.paste\}/);
});
