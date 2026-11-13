import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadUpdateStateModule() {
  const sourcePath = new URL('../apps/native/src/desktopUpdateState.ts', import.meta.url);
  const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, URL, JSON }, {
    filename: 'desktopUpdateState.ts',
  });
  return module.exports;
}

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

const state = loadUpdateStateModule();
const releaseUrl = 'https://github.com/example/airrest/releases/tag/desktop-v1.4.0';

test('derives only exact GitHub release pages from updater metadata', () => {
  assert.equal(state.readReleaseUrl({ release_url: releaseUrl }), releaseUrl);
  assert.equal(
    state.readReleaseUrl({ platforms: { 'windows-x86_64': {
      url: 'https://github.com/example/airrest/releases/download/desktop-v1.4.0/AirREST_1.4.0_x64-setup.exe',
    } } }),
    releaseUrl,
  );
  assert.equal(state.readReleaseUrl({ release_url: 'https://github.com/example/airrest/releases/latest' }), null);
  assert.equal(state.readReleaseUrl({ release_url: 'https://evil.example/releases/tag/v1.4.0' }), null);
});

test('promotes a pending update only when the installed version is running', () => {
  const storage = new MemoryStorage();
  state.rememberPendingUpdate({ version: '1.4.0', releaseUrl }, storage);

  assert.equal(state.reconcileInstalledUpdate('1.3.9', storage), null);
  assert.equal(JSON.stringify(state.reconcileInstalledUpdate('v1.4.0', storage)), JSON.stringify({ version: '1.4.0', releaseUrl }));
  assert.equal(JSON.stringify(state.readInstalledUpdate('1.4.0', storage)), JSON.stringify({ version: '1.4.0', releaseUrl }));
});

test('keeps the post-update message dismissed per installed version and tolerates damaged storage', () => {
  const storage = new MemoryStorage();
  state.rememberPendingUpdate({ version: '1.4.0', releaseUrl }, storage);
  state.reconcileInstalledUpdate('1.4.0', storage);
  state.dismissInstalledUpdate('1.4.0', storage);
  assert.equal(state.readInstalledUpdate('1.4.0', storage), null);

  storage.setItem(state.PENDING_UPDATE_KEY, '{invalid');
  assert.equal(state.reconcileInstalledUpdate('1.4.1', storage), null);
});
