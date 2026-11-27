import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../packages/common/src/', import.meta.url));
const quietConsole = { ...console, warn() {}, error() {} };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function loadCredentials() {
  const source = fs.readFileSync(new URL('../packages/common/src/lib/nativeCredentials.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, JSON, Error });
  return exports;
}

function loadProductionRuntime(extra = {}) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.env', '({})');
    const compiled = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    }).outputText;
    const localRequire = (id) => {
      if (!id.startsWith('.')) return require(id);
      const base = path.resolve(path.dirname(file), id);
      const resolved = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]
        .find((candidate) => {
          try {
            return fs.statSync(candidate).isFile();
          } catch {
            return false;
          }
        });
      if (!resolved) throw new Error(`Cannot resolve ${id} from ${file}`);
      return load(resolved);
    };
    vm.runInNewContext(compiled, {
      exports,
      require: localRequire,
      console: quietConsole,
      setTimeout,
      clearTimeout,
      URL,
      URLSearchParams,
      Headers,
      Response,
      Request,
      AbortController,
      AbortSignal,
      TextEncoder,
      TextDecoder,
      Blob,
      CompressionStream,
      performance,
      crypto: { randomUUID },
      fetch,
      Date,
      Math,
      ...extra,
    }, { filename: file });
    if (file === path.join(root, 'lib/storage.ts')) {
      exports.appStorage = Object.fromEntries(
        Object.entries(exports.appStorage).map(([key, method]) => [key, async (...args) => await method(...args)]),
      );
    }
    return exports;
  }
  return { load, create: load(path.join(root, 'runtime.ts')).createAirrestRuntime };
}

function createMemoryVault() {
  const records = new Map();
  return {
    records,
    read: async (scope) => records.get(JSON.stringify(scope)) || null,
    write: async (scope, record) => { records.set(JSON.stringify(scope), record); },
    remove: async (scope) => { records.delete(JSON.stringify(scope)); },
  };
}

function createTwoCopyStorage() {
  let idb = null;
  let local = null;
  let denyLocal = false;
  let denyIdb = false;
  let queue = Promise.resolve();
  const db = {
    transaction() {
      const tx = {};
      tx.objectStore = () => ({
        get() {
          const req = {};
          queueMicrotask(() => {
            req.result = idb === null ? undefined : idb;
            req.onsuccess();
          });
          return req;
        },
        put(value) {
          queueMicrotask(() => {
            if (denyIdb) {
              tx.error = new Error('idb write denied');
              tx.onerror?.();
              return;
            }
            idb = value;
            tx.oncomplete();
          });
          return {};
        },
      });
      return tx;
    },
  };
  return {
    globals: {
      indexedDB: { open() { const req = { result: db }; queueMicrotask(() => req.onsuccess()); return req; } },
      localStorage: {
        getItem: () => local,
        setItem: (_key, value) => {
          if (denyLocal) throw new Error('local write denied');
          local = value;
        },
      },
      navigator: {
        locks: {
          request(_name, callback) {
            const task = queue.then(callback, callback);
            queue = task.catch(() => {});
            return task;
          },
        },
      },
    },
    denyLocal: (value) => { denyLocal = value; },
    denyIdb: (value) => { denyIdb = value; },
    drain: async () => {
      await settle();
      await queue;
      await settle();
      await queue;
    },
    local: () => local,
    idb: () => idb,
    latest: () => JSON.parse(JSON.parse(idb).data),
    localData: () => JSON.parse(JSON.parse(local).data),
  };
}

function findElement(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  if (Array.isArray(node)) {
    for (const item of node) {
      const match = findElement(item, predicate);
      if (match) return match;
    }
    return null;
  }
  const children = node.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
  } else if (children) {
    const match = findElement(children, predicate);
    if (match) return match;
  }
  for (const child of node.children || []) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return null;
}

const policyResponse = () => new Response(JSON.stringify({
  data: { revision: 1, flags: { 'collection.move': true, 'collection.delete': true, 'collection.export': true } },
}));

const sessionA = {
  apiUrl: 'https://api.example.com',
  user: { id: 'a', name: 'Alice', email: 'alice@example.com', role: 'user' },
  token: 'dummy-access-a',
  refreshToken: 'dummy-refresh-a',
};

const sessionB = {
  apiUrl: 'https://api.example.com',
  user: { id: 'b', name: 'Bob', email: 'bob@example.com', role: 'user' },
  token: 'dummy-access-b',
  refreshToken: 'dummy-refresh-b',
};

test('native credential records reject malformed data and retain only supported fields', () => {
  const credentials = loadCredentials();
  const serialized = credentials.serializeNativeCredential({
    accessToken: 'access', refreshToken: 'refresh', expiresAt: '2030-01-01T00:00:00Z',
  });
  assert.equal(JSON.stringify(credentials.parseNativeCredential(serialized)), JSON.stringify({
    accessToken: 'access', refreshToken: 'refresh', expiresAt: '2030-01-01T00:00:00Z',
  }));
  assert.throws(() => credentials.serializeNativeCredential({ accessToken: '   ' }), /empty access token/i);
  assert.throws(() => credentials.parseNativeCredential('{"version":1,"accessToken":""}'), /unsupported format/i);
  assert.throws(() => credentials.parseNativeCredential('{"version":2,"accessToken":"access"}'), /unsupported format/i);
});

test('native credential scopes require both deployment and signed-in identity', () => {
  const credentials = loadCredentials();
  assert.equal(credentials.getNativeCredentialScope({ apiUrl: 'https://api.example', user: { id: 'user-a' } }).userId, 'user-a');
  assert.equal(credentials.getNativeCredentialScope({ apiUrl: 'https://api.example' }), null);
  assert.equal(credentials.getNativeCredentialScope({ apiUrl: 'https://api.example', user: { id: '  ' } }), null);
});

test('native platforms redact cloud tokens from shared persistence while extensions retain their current storage', () => {
  const source = [
    fs.readFileSync(new URL('../packages/common/src/store/useApiStore.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../packages/common/src/store/slices/cloudAuthWorkspaceSlice.ts', import.meta.url), 'utf8'),
  ].join('\n');
  assert.match(source, /const persistCloudCredentials = credentialStorage === undefined/);
  assert.match(source, /token: undefined,[\s\S]*refreshToken: undefined,[\s\S]*tokenExpiresAt: undefined/);
  assert.match(source, /setCloudSession: async/);
});

test('native migration retains a public identity, retries cleanup, and requires both legacy copies', () => {
  const store = [
    fs.readFileSync(new URL('../packages/common/src/store/useApiStore.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../packages/common/src/store/slices/cloudAuthWorkspaceSlice.ts', import.meta.url), 'utf8'),
  ].join('\n');
  const storage = fs.readFileSync(new URL('../packages/common/src/lib/storage.ts', import.meta.url), 'utf8');
  const runtime = fs.readFileSync(new URL('../packages/common/src/runtime.ts', import.meta.url), 'utf8');

  assert.match(store, /phase: state\.cloudConfig\.token\s*\?\s*'legacy-pending'\s*:\s*state\.nativeCredentialCleanupPending\s*\?\s*'cleanup-pending'\s*:\s*'ready'/);
  assert.match(store, /preserveLegacyCredentials = state\.nativeCredentialState\?\.phase === 'legacy-pending'/);
  assert.match(store, /nativeIdentityIsCurrent/);
  assert.match(store, /persistNativeCredentialState/);
  assert.match(store, /nativeCredentialCleanupPending/);
  assert.match(store, /nativeCredentialQueue/);
  assert.match(store, /operation !== nativeCredentialOperation/);
  assert.match(store, /phase: 'cleanup-pending'/);
  assert.match(store, /Protected credential storage did not confirm the migrated session/);
  assert.match(storage, /export async function setItemInAllPersistenceCopies/);
  assert.match(storage, /await idbSet\(name, serialized\);\s*setLocalItem\(name, serialized\);/);
  assert.match(runtime, /recoverNativeCredentials/);
});

test('native adapters expose one read contract and use a Keystore-generated IV', () => {
  const rust = fs.readFileSync(new URL('../apps/native/src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const android = fs.readFileSync(new URL('../apps/native/src-tauri/gen/android/app/src/main/java/id/adiputera/airrest/NativeCredentialPlugin.kt', import.meta.url), 'utf8');

  assert.match(rust, /#\[tauri::command\(rename = "read"\)\]/);
  assert.match(rust, /struct CredentialReadResult[\s\S]*value: Option<String>/);
  assert.match(rust, /#\[tauri::command\(rename = "write"\)\]/);
  assert.match(rust, /#\[tauri::command\(rename = "remove"\)\]/);
  assert.match(android, /cipher\.init\(Cipher\.ENCRYPT_MODE, secretKey\(\)\)/);
  assert.match(android, /val nonce = cipher\.iv/);
  assert.doesNotMatch(android, /ENCRYPT_MODE, secretKey\(\), GCMParameterSpec/);
});

test('the native shell waits for credential recovery before exposing the application', () => {
  const source = fs.readFileSync(new URL('../apps/native/src/main.tsx', import.meta.url), 'utf8');
  assert.match(source, /runtime\.credentialReady\.finally\(\(\) => \{/);
  assert.match(source, /ReactDOM\.createRoot/);
});

test('both UserMenu and ScopeSwitcher route sign-out through the unified credential-clearing action', () => {
  const userMenu = fs.readFileSync(new URL('../packages/common/src/components/UserMenu.tsx', import.meta.url), 'utf8');
  const scopeSwitcher = fs.readFileSync(new URL('../packages/common/src/components/ScopeSwitcher.tsx', import.meta.url), 'utf8');
  const store = fs.readFileSync(new URL('../packages/common/src/store/slices/cloudAuthWorkspaceSlice.ts', import.meta.url), 'utf8');

  assert.match(userMenu, /signOutCloud/);
  assert.match(scopeSwitcher, /signOutCloud/);
  assert.match(store, /clearCloudCredentials\(credentialScope\)/);
  assert.match(store, /cloudConfig !== config/);
});

test('cleanup journal survives token rotation, account changes, and logout until both copies redact legacy secrets', async (t) => {
  const copies = createTwoCopyStorage();
  const { create } = loadProductionRuntime(copies.globals);
  const adapter = { dispose() {}, cloudTransport: { fetch: async () => policyResponse() } };

  const legacy = create({ adapter });
  await legacy.credentialReady;
  await settle();
  legacy.store.getState().setCloudConfig(sessionA);
  await copies.drain();
  legacy.dispose();

  // Deny localStorage writes during migration: vault succeeds, IDB redacts, localStorage keeps legacy token.
  copies.denyLocal(true);
  adapter.credentialStorage = createMemoryVault();
  const firstNative = create({ adapter });
  await firstNative.credentialReady;
  await copies.drain();
  assert.equal(copies.latest().state.nativeCredentialState.phase, 'cleanup-pending');
  assert.equal(copies.latest().state.nativeCredentialCleanupPending, true);
  assert.equal(copies.local().includes(sessionA.token), true);

  // Token refresh must keep cleanup pending while localStorage is still inaccessible.
  await firstNative.store.getState().setCloudSession({ token: 'dummy-new-a', refreshToken: 'dummy-new-refresh-a' });
  await copies.drain();
  assert.equal(copies.latest().state.nativeCredentialState.phase, 'cleanup-pending');
  assert.equal(copies.latest().state.nativeCredentialCleanupPending, true);

  // Account switch and logout must also retain the durable cleanup journal.
  await firstNative.store.getState().setCloudSession(sessionB);
  await copies.drain();
  assert.equal(copies.latest().state.nativeCredentialState.phase, 'cleanup-pending');
  assert.equal(copies.latest().state.nativeCredentialCleanupPending, true);

  firstNative.store.getState().logoutCloud();
  await copies.drain();
  assert.equal(copies.latest().state.nativeCredentialCleanupPending, true);
  assert.equal(copies.local().includes(sessionA.token), true);
  firstNative.dispose();

  // Next restart with no active cloud session resumes cleanup once localStorage becomes writable.
  copies.denyLocal(false);
  const secondNative = create({ adapter });
  t.after(() => secondNative.dispose());
  await secondNative.credentialReady;
  await copies.drain();

  assert.equal(copies.latest().state.nativeCredentialCleanupPending, undefined);
  assert.equal(copies.local().includes(sessionA.token), false);
  assert.equal(copies.localData().state.nativeCredentialCleanupPending, undefined);
});

test('cleanup retries when IndexedDB denies writes during migration', async (t) => {
  const copies = createTwoCopyStorage();
  const { create } = loadProductionRuntime(copies.globals);
  const adapter = { dispose() {}, cloudTransport: { fetch: async () => policyResponse() } };

  const legacy = create({ adapter });
  await legacy.credentialReady;
  await settle();
  legacy.store.getState().setCloudConfig(sessionA);
  await copies.drain();
  legacy.dispose();

  copies.denyIdb(true);
  adapter.credentialStorage = createMemoryVault();
  const firstNative = create({ adapter });
  await firstNative.credentialReady;
  await copies.drain();
  assert.equal(copies.localData().state.nativeCredentialState.phase, 'cleanup-pending');
  assert.equal(copies.localData().state.nativeCredentialCleanupPending, true);
  assert.equal(copies.idb().includes(sessionA.token), true);
  firstNative.dispose();

  copies.denyIdb(false);
  const secondNative = create({ adapter });
  t.after(() => secondNative.dispose());
  await secondNative.credentialReady;
  await copies.drain();

  assert.equal(copies.latest().state.nativeCredentialState.phase, 'ready');
  assert.equal(copies.latest().state.nativeCredentialCleanupPending, undefined);
  assert.equal(copies.idb().includes(sessionA.token), false);
  assert.equal(copies.local().includes(sessionA.token), false);
});

test('UserMenu and ScopeSwitcher sign-out callbacks remove vault credentials and make deletion failure retryable', async (t) => {
  const vault = createMemoryVault();
  let failRemove = true;
  const origRemove = vault.remove;
  vault.remove = async (scope) => {
    if (failRemove) throw new Error('vault locked');
    await origRemove(scope);
  };

  let saved = null;
  const storage = {
    getItem: async () => saved,
    setItem: async (_key, value) => { saved = value; },
    removeItem: async () => { saved = null; },
  };
  let providerSignOuts = 0;
  const authProvider = {
    id: 'password',
    capabilities: { passwordCredentials: true, editableProfile: false, passwordChange: false },
    signIn: async () => { throw new Error('unused'); },
    signOut: async () => { providerSignOuts++; },
  };

  const { load, create } = loadProductionRuntime();
  const runtime = create({
    adapter: { credentialStorage: vault, dispose() {}, cloudTransport: { fetch: async () => policyResponse() } },
    storage,
    authProvider,
  });
  t.after(() => runtime.dispose());
  await runtime.credentialReady;
  await runtime.store.getState().setCloudSession({
    ...sessionA,
    activeScope: { type: 'workspace', id: 'ws-a', name: 'WS A', role: 'owner' },
  });
  runtime.store.setState({
    workspaceMode: 'cloud',
    collections: [{ id: 'col-pending', name: 'Unsynced', items: [], _syncStatus: 'pending' }],
  });
  assert.equal(vault.records.size, 1);

  const renderComponent = (filePath) => {
    const source = fs.readFileSync(filePath, 'utf8');
    const compiled = ts.transpileModule(source, {
      fileName: filePath,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
    }).outputText;
    const selectorStore = (selector) => selector(runtime.store.getState());
    selectorStore.getState = runtime.store.getState;
    selectorStore.setState = runtime.store.setState;
    const states = [];
    const refs = [];
    let stateIdx = 0;
    let refIdx = 0;
    const useState = (initial) => {
      const idx = stateIdx++;
      if (!(idx in states)) states[idx] = initial;
      const setState = (next) => {
        states[idx] = typeof next === 'function' ? next(states[idx]) : next;
      };
      return [states[idx], setState];
    };
    const useRef = (initial) => {
      const idx = refIdx++;
      if (!(idx in refs)) refs[idx] = { current: initial };
      return refs[idx];
    };
    const resetHooks = () => {
      stateIdx = 0;
      refIdx = 0;
    };
    const useEffect = () => {};
    const useMemo = (fn) => fn();
    const react = {
      __esModule: true,
      default: {
        createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
        Fragment: 'fragment',
        useState,
        useRef,
        useEffect,
        useMemo,
      },
      useState,
      useRef,
      useEffect,
      useMemo,
    };
    const iconStub = new Proxy({}, { get: (_target, prop) => String(prop) });
    const confirmModal = () => null;
    const modules = {
      react,
      'lucide-react': iconStub,
      '../lib/backNavigation': { useBackHandler: () => {} },
      '../store/useApiStore': { useApiStore: selectorStore },
      '../store/storeContext': { useStoreContext: () => runtime.store },
      '../workspace/cloudSession': load(path.join(root, 'workspace/cloudSession.ts')),
      '../lib/jwt': load(path.join(root, 'lib/jwt.ts')),
      '../context': {
        useProductPolicy: () => runtime.productPolicy,
        useAuthProvider: () => runtime.authProvider,
      },
      './ConfirmModal': { ConfirmModal: confirmModal },
      './EditProfileModal': { EditProfileModal: () => null },
      './ChangePasswordModal': { ChangePasswordModal: () => null },
      './CloudAuthModal': { CloudAuthModal: () => null },
    };
    const exports = {};
    vm.runInNewContext(compiled, {
      exports,
      console: quietConsole,
      require: (id) => {
        if (!(id in modules)) throw new Error(`Unexpected module ${id}`);
        return modules[id];
      },
    }, { filename: filePath });
    return {
      render: (props) => {
        resetHooks();
        const fn = exports.ScopeSwitcher || exports.UserMenu;
        return fn(props);
      },
      confirmModal,
    };
  };

  // 1. ScopeSwitcher Sign Out & Disconnect fails gracefully when vault deletion throws, preserving session & work.
  const scopeSwitcherMod = renderComponent(path.join(root, 'components/ScopeSwitcher.tsx'));
  let switcherTree = scopeSwitcherMod.render({ onOpenModeSelector: () => {}, onOpenCloudAuth: () => {} });
  const toggleBtn = findElement(switcherTree, (el) => el.type === 'button' && typeof el.props?.onClick === 'function');
  assert.ok(toggleBtn, 'ScopeSwitcher must render toggle button');
  toggleBtn.props.onClick();
  switcherTree = scopeSwitcherMod.render({ onOpenModeSelector: () => {}, onOpenCloudAuth: () => {} });
  const signOutBtn = findElement(
    switcherTree,
    (el) => el.type === 'button' && JSON.stringify(el.children || []).includes('Sign Out'),
  );
  assert.ok(signOutBtn, 'ScopeSwitcher must render Sign Out & Disconnect');
  signOutBtn.props.onClick();
  await settle();
  await settle();

  assert.equal(providerSignOuts, 1);
  assert.equal(runtime.store.getState().cloudConfig.token, sessionA.token);
  assert.equal(runtime.store.getState().collections[0]?.id, 'col-pending');
  assert.equal(runtime.store.getState().syncStatus, 'error');
  assert.match(runtime.store.getState().syncError || '', /Sign-out could not clear protected credentials/i);
  assert.equal(vault.records.size, 1);

  // Re-opening ScopeSwitcher displays the visible sign-out error alert and allows retry.
  toggleBtn.props.onClick();
  switcherTree = scopeSwitcherMod.render({ onOpenModeSelector: () => {}, onOpenCloudAuth: () => {} });
  const errorAlert = findElement(switcherTree, (el) => el.props?.role === 'alert');
  assert.ok(errorAlert, 'ScopeSwitcher must render retryable sign-out failure alert');

  // 2. Retry succeeds via ScopeSwitcher when vault unlocks.
  failRemove = false;
  signOutBtn.props.onClick();
  await settle();
  await settle();
  assert.equal(providerSignOuts, 2);
  assert.equal(runtime.store.getState().cloudConfig.token, undefined);
  assert.equal(vault.records.size, 0);

  // 3. Re-sign in and verify UserMenu sign-out also removes the vault credential cleanly.
  await runtime.store.getState().setCloudSession(sessionA);
  assert.equal(vault.records.size, 1);
  const userMenuMod = renderComponent(path.join(root, 'components/UserMenu.tsx'));
  const userMenuTree = userMenuMod.render({});
  const signOutModal = findElement(
    userMenuTree,
    (el) => el.type === userMenuMod.confirmModal && el.props?.title === 'Sign Out',
  );
  assert.ok(signOutModal, 'UserMenu must render Sign Out confirmation modal');
  signOutModal.props.onConfirm();
  await settle();
  await settle();
  assert.equal(providerSignOuts, 3);
  assert.equal(runtime.store.getState().cloudConfig.token, undefined);
  assert.equal(vault.records.size, 0);
});
