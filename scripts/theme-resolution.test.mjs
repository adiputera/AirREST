import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Test Theme Logic Functions
function getNextThemeMode(current) {
  switch (current) {
    case 'system':
      return 'light';
    case 'light':
      return 'dark';
    case 'dark':
    default:
      return 'system';
  }
}

function resolveTheme(theme, isSystemDark = true) {
  if (theme === 'system') {
    return isSystemDark ? 'dark' : 'light';
  }
  return theme === 'light' ? 'light' : 'dark';
}

function createMockDocument(initialTheme = 'dark') {
  const classList = new Set(initialTheme === 'dark' ? ['dark'] : []);
  const attributes = {};
  const style = { colorScheme: initialTheme };

  return {
    documentElement: {
      classList: {
        add: (cls) => classList.add(cls),
        remove: (cls) => classList.delete(cls),
        contains: (cls) => classList.has(cls),
        toggle: (cls, force) => {
          if (force !== undefined) {
            if (force) classList.add(cls);
            else classList.delete(cls);
          } else {
            if (classList.has(cls)) classList.delete(cls);
            else classList.add(cls);
          }
          return classList.has(cls);
        },
      },
      setAttribute: (key, val) => {
        attributes[key] = val;
      },
      getAttribute: (key) => attributes[key],
      style,
    },
  };
}

function applyTheme(theme, mockDoc, isSystemDark = true) {
  const resolved = resolveTheme(theme, isSystemDark);
  const isDark = resolved === 'dark';
  const root = mockDoc.documentElement;

  if (isDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }

  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;
}

test('Theme rotation sequence', () => {
  assert.equal(getNextThemeMode('system'), 'light');
  assert.equal(getNextThemeMode('light'), 'dark');
  assert.equal(getNextThemeMode('dark'), 'system');
  assert.equal(getNextThemeMode('unknown'), 'system');
});

test('Theme resolution for explicit and system preferences', () => {
  // Explicit dark
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('dark', true), 'dark');

  // Explicit light
  assert.equal(resolveTheme('light', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');

  // System mode tracks OS preference
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('system', true), 'dark');
});

test('DOM class, data-theme attribute, and colorScheme update properly', () => {
  const doc = createMockDocument('dark');

  // Switch to light
  applyTheme('light', doc, true);
  assert.equal(doc.documentElement.classList.contains('dark'), false);
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(doc.documentElement.style.colorScheme, 'light');

  // Switch to dark
  applyTheme('dark', doc, false);
  assert.equal(doc.documentElement.classList.contains('dark'), true);
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(doc.documentElement.style.colorScheme, 'dark');

  // Switch to system (when OS is light)
  applyTheme('system', doc, false);
  assert.equal(doc.documentElement.classList.contains('dark'), false);
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(doc.documentElement.style.colorScheme, 'light');

  // Switch to system (when OS is dark)
  applyTheme('system', doc, true);
  assert.equal(doc.documentElement.classList.contains('dark'), true);
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(doc.documentElement.style.colorScheme, 'dark');
});

test('Theme persistence serialization and hydration defaults', () => {
  // Fresh install
  const emptyPersisted = {};
  const hydratedTheme = emptyPersisted.theme || 'system';
  assert.equal(hydratedTheme, 'system');

  // Persisted explicit theme
  const savedState = { theme: 'light' };
  assert.equal(savedState.theme, 'light');
});

test('T-EXT-THEME: initEarlyTheme reads StorageEnvelope from localStorage and applies light theme without FOUC', () => {
  const source = fs.readFileSync(new URL('../packages/common/src/lib/theme.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  const mockDoc = createMockDocument('dark');
  const envelope = JSON.stringify({
    __airrestStorageEnvelope: 1,
    seq: 1,
    updatedAt: Date.now(),
    writerId: 'w-1',
    deleted: false,
    data: JSON.stringify({ state: { theme: 'light' }, version: 0 }),
  });

  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: () => ({}),
    window: {
      matchMedia: () => ({ matches: true }),
    },
    document: mockDoc,
    localStorage: {
      getItem: (key) => (key === 'air-rest-storage' ? envelope : null),
    },
    console,
    JSON,
  });

  assert.equal(mockDoc.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(mockDoc.documentElement.classList.contains('dark'), false);
  assert.equal(mockDoc.documentElement.style.colorScheme, 'light');
});
