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

// Load the real runtime, store and cloud client together. Only the platform
// transport, storage and React rendering are substituted at their boundaries.
function loadProductionModules() {
  const cache = new Map();
  const globals = { console, setTimeout, clearTimeout, URL, URLSearchParams, Headers, Response, Request,
    AbortController, AbortSignal, TextEncoder, TextDecoder, Blob, CompressionStream, performance,
    crypto: { randomUUID }, fetch, Date, Math };
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.env', '({})');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
    } }).outputText;
    const localRequire = (id) => {
      if (!id.startsWith('.')) return require(id);
      const base = path.resolve(path.dirname(file), id);
      const resolved = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((candidate) => {
        try { return fs.statSync(candidate).isFile(); } catch { return false; }
      });
      if (!resolved) throw new Error(`Cannot resolve ${id} from ${file}`);
      return load(resolved);
    };
    vm.runInNewContext(compiled, { ...globals, exports, require: localRequire }, { filename: file });
    return exports;
  }
  return { load, globals };
}

function renderLogin(load, globals, runtime) {
  const store = runtime.store;
  const selectorStore = (selector) => selector(store.getState());
  selectorStore.getState = store.getState;
  const createElement = (type, props, ...children) => ({ type, props: props || {}, children });
  const react = { __esModule: true, default: { createElement, Fragment: 'fragment' },
    useState: (initial) => [initial, () => {}], useRef: (value) => ({ current: value }), useEffect: () => {} };
  const source = fs.readFileSync(path.join(root, 'components/CloudAuthModal.tsx'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  const modules = {
    react, 'lucide-react': {}, '../lib/backNavigation': { useBackHandler: () => {} },
    '../store/useApiStore': { useApiStore: selectorStore }, '../store/storeContext': { useStoreContext: () => selectorStore },
    '../lib/cloudApi': load(path.join(root, 'lib/cloudApi.ts')), '../lib/jwt': load(path.join(root, 'lib/jwt.ts')),
    '../workspace/cloudSession': load(path.join(root, 'workspace/cloudSession.ts')),
    '../context': { useAuthProvider: () => runtime.authProvider, useCloudClient: () => runtime.cloudClient,
      useProductPolicy: () => runtime.productPolicy, usePlatformAdapter: () => runtime.adapter },
  };
  const exports = {};
  vm.runInNewContext(compiled, { ...globals, exports, require: (id) => {
    if (!(id in modules)) throw new Error(`Unexpected UI dependency ${id}`);
    return modules[id];
  } });
  return exports.CloudAuthModal({ isOpen: true, onClose: () => {} });
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}

test('tokenless provider login, restart, account isolation, pending retry and expiry use the real runtime', async () => {
  const { load, globals } = loadProductionModules();
  const { createAirrestRuntime } = load(path.join(root, 'runtime.ts'));
  let saved = null;
  let userId = 'one';
  let rejectRequests = false;
  let delayOldRequest = false;
  let finishOldRequest;
  const calls = [];
  const storage = { getItem: async () => saved, setItem: async (_key, value) => { saved = value; }, removeItem: async () => { saved = null; } };
  const provider = { id: 'cookie', capabilities: { passwordCredentials: false, editableProfile: false, passwordChange: false },
    signIn: async () => ({ user: { id: userId, role: 'reader' } }),
    authorizeRequest: (request, send) => send({ ...request.init, credentials: 'include' }) };
  const adapter = { dispose() {}, cloudTransport: { supportsCredentials: true, fetch: async (url, init) => {
    const target = new URL(url);
    calls.push({ user: userId, path: target.pathname, credentials: init.credentials, authorization: init.headers.authorization });
    if (rejectRequests) return new Response('{"error":"expired"}', { status: 401 });
    if (delayOldRequest && userId === 'two' && target.pathname.endsWith('/collections')) {
      return new Promise((resolve) => { finishOldRequest = () => resolve(new Response('{"data":[]}', { status: 200 })); });
    }
    let data = {};
    if (target.pathname.endsWith('/auth/me')) data = { id: userId, role: 'member', email: `${userId}@example.com` };
    else if (target.pathname.endsWith('/workspaces')) data = [{ id: 'shared', name: 'Shared', is_default: true }];
    else if (target.pathname.endsWith('/feature-policy')) data = { revision: 1, flags: { 'collection.move': true, 'collection.delete': true, 'collection.export': true } };
    else if (target.pathname.endsWith('/collections') || target.pathname.endsWith('/environments') || target.pathname.endsWith('/teams')) data = [];
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  } } };
  const create = async () => {
    const runtime = createAirrestRuntime({ adapter, edition: 'cloud', authProvider: provider, storage });
    await new Promise((resolve) => setImmediate(resolve));
    return runtime;
  };
  const login = async (runtime) => {
    const tree = renderLogin(load, globals, runtime);
    await find(tree, (element) => element.type === 'form').props.onSubmit({ preventDefault() {} });
  };

  const first = await create();
  await login(first);
  assert.equal(first.store.getState().cloudConfig.sessionKind, 'provider');
  assert.equal(first.store.getState().cloudConfig.user.id, 'one');
  first.store.setState({ collections: [{ id: 'draft', name: 'Draft', items: [], _syncStatus: 'pending', _origin: 'cloud' }] });
  await new Promise((resolve) => setImmediate(resolve));
  first.dispose();

  const second = await create();
  assert.equal(second.store.getState().cloudConfig.user, undefined);
  assert.equal(second.store.getState().collections.length, 0);
  userId = 'two';
  await login(second);
  assert.equal(second.store.getState().cloudConfig.user.id, 'two');
  assert.equal(second.store.getState().collections.some((entry) => entry.id === 'draft'), false);
  assert.equal(calls.some((entry) => entry.user === 'two' && entry.path.endsWith('/sync/import-batch')), false);

  delayOldRequest = true;
  const staleRequest = second.cloudClient.fetchScopeCollections('http://localhost:8080', undefined, { type: 'workspace', id: 'shared' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof finishOldRequest, 'function');
  userId = 'one';
  await login(second);
  finishOldRequest();
  await assert.rejects(staleRequest, /Session changed/);
  assert.equal(second.store.getState().cloudConfig.user.id, 'one');
  assert.ok(calls.some((entry) => entry.user === 'one' && entry.path.endsWith('/sync/import-batch')));
  assert.ok(calls.every((entry) => entry.credentials === 'include' && entry.authorization === undefined));
  second.store.setState({ collections: [{ id: 'second-draft', name: 'Draft', items: [], _syncStatus: 'pending', _origin: 'cloud' }] });
  rejectRequests = true;
  await assert.rejects(second.cloudClient.fetchUserWorkspaces('https://example.test', undefined), /Session changed/);
  assert.equal(second.store.getState().cloudConfig.user, undefined);
  const owner = JSON.stringify(['http://localhost:8080', 'one']);
  assert.equal(second.store.getState().cloudCacheArchives.owners[owner].scopeCache['workspace:shared'].collections[0].id, 'second-draft');
  second.dispose();
});

test('simultaneous provider runtimes keep transports and session expiry isolated', async () => {
  const { load } = loadProductionModules();
  const { createAirrestRuntime } = load(path.join(root, 'runtime.ts'));
  const requests = [];
  const provider = { id: 'cookie', capabilities: { passwordCredentials: false, editableProfile: false, passwordChange: false },
    signIn: async () => ({ user: { id: 'same-user' } }),
    authorizeRequest: (request, send) => send({ ...request.init, credentials: 'include' }) };
  const create = (name) => {
    const storage = { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };
    const adapter = { dispose() {}, cloudTransport: { supportsCredentials: true, fetch: async (url) => {
      const target = new URL(url);
      requests.push([name, target.pathname]);
      if (target.pathname.endsWith('/feature-policy')) {
        return new Response(JSON.stringify({ data: { revision: 1, flags: { 'collection.move': true, 'collection.delete': true, 'collection.export': true } } }), { status: 200 });
      }
      return new Response(name === 'first' ? '{"data":[]}' : '{"error":"expired"}', { status: name === 'first' ? 200 : 401 });
    } } };
    return createAirrestRuntime({ adapter, edition: 'cloud', authProvider: provider, storage });
  };
  const first = create('first');
  const second = create('second');
  await new Promise((resolve) => setImmediate(resolve));
  for (const runtime of [first, second]) {
    runtime.store.getState().setCloudConfig({ apiUrl: 'https://example.test', sessionKind: 'provider', user: { id: 'same-user' } });
  }
  await first.cloudClient.fetchUserWorkspaces('https://example.test', undefined);
  await assert.rejects(second.cloudClient.fetchUserWorkspaces('https://example.test', undefined), /Session changed/);
  assert.equal(first.store.getState().cloudConfig.user.id, 'same-user');
  assert.equal(second.store.getState().cloudConfig.user, undefined);
  assert.ok(requests.some(([name, route]) => name === 'first' && route.endsWith('/workspaces')));
  assert.ok(requests.some(([name, route]) => name === 'second' && route.endsWith('/workspaces')));
  second.dispose();
  await first.cloudClient.fetchUserWorkspaces('https://example.test', undefined);
  assert.equal(first.store.getState().cloudConfig.user.id, 'same-user');
  first.dispose();
});

test('the extension forwards cookie credentials while the native transport rejects them', async () => {
  const { load, globals } = loadProductionModules();
  const { createCloudClient } = load(path.join(root, 'lib/cloudApi.ts'));
  const compile = (file) => ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8').replaceAll('import.meta.url', '"file:///adapter.js"'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let requestOptions;
  const extension = {};
  vm.runInNewContext(compile('../apps/extension/src/adapters/chromeAdapter.ts'), {
    ...globals, exports: extension, require: () => ({}),
    fetch: async (_url, init) => { requestOptions = init; return new Response('{"data":[]}', { status: 200 }); },
  });
  const authorizeRequest = (request, send) => send({ ...request.init, credentials: 'include' });
  const browserClient = createCloudClient({ transport: extension.chromeCloudTransport, authorizeRequest });
  await browserClient.fetchUserWorkspaces('https://example.test', undefined);
  assert.equal(requestOptions.credentials, 'include');
  assert.equal(requestOptions.redirect, 'manual');
  assert.equal(requestOptions.cache, 'no-store');
  browserClient.dispose();

  let nativeCalled = false;
  const native = {};
  vm.runInNewContext(compile('../apps/native/src/adapters/tauriAdapter.ts'), {
    ...globals, exports: native, require: (id) => id === '@tauri-apps/plugin-http'
      ? { fetch: () => { nativeCalled = true; throw new Error('native transport should not be called'); } }
      : {},
  });
  const nativeClient = createCloudClient({ transport: native.tauriCloudTransport, authorizeRequest });
  await assert.rejects(nativeClient.fetchUserWorkspaces('https://example.test', undefined), /does not support credentialed requests/);
  assert.equal(nativeCalled, false);
  nativeClient.dispose();
});

test('runtime rejects a store from a different product policy and store policy is immutable', () => {
  const { load } = loadProductionModules();
  const { createAirrestRuntime } = load(path.join(root, 'runtime.ts'));
  const { createApiStore } = load(path.join(root, 'store/useApiStore.ts'));
  const { createProductPolicy } = load(path.join(root, 'productPolicy.ts'));
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  assert.throws(() => createApiStore({ storage, productPolicy: { edition: 'cloud', workspace: { cloud: true, offline: true } } }), /invalid workspace policy/i);
  assert.throws(() => createApiStore({ storage, productPolicy: null }), /invalid product policy/i);
  assert.throws(() => createAirrestRuntime({ adapter: { dispose() {} }, productPolicy: null }), /invalid product policy/i);
  assert.throws(() => createAirrestRuntime({ adapter: { dispose() {} }, edition: 'offline', productPolicy: createProductPolicy('cloud') }), /must match/i);
  assert.throws(() => createAirrestRuntime({ adapter: { dispose() {} }, edition: 'offline', cloudClient: {} }), /cannot be injected/i);
  const supplied = { edition: 'offline', workspace: { cloud: false, offline: true } };
  const store = createApiStore({ storage, productPolicy: supplied });
  supplied.workspace.cloud = true;
  assert.equal(store.productPolicy, createProductPolicy('offline'));
  assert.equal(store.productPolicy.workspace.cloud, false);
  assert.throws(() => createAirrestRuntime({ adapter: { dispose() {} }, edition: 'cloud', store }), /different product policy/i);
  const runtime = createAirrestRuntime({ adapter: { dispose() {} }, edition: 'offline', store });
  assert.equal(runtime.productPolicy, store.productPolicy);
  runtime.dispose();
});

test('stable runtime entry exposes the same store and policy factories as legacy modules', () => {
  const { load } = loadProductionModules();
  const api = load(path.join(root, 'public/runtime.ts'));
  const storeModule = load(path.join(root, 'store/useApiStore.ts'));
  const policyModule = load(path.join(root, 'productPolicy.ts'));
  assert.equal(api.createApiStore, storeModule.createApiStore);
  assert.equal(api.createProductPolicy, policyModule.createProductPolicy);
  assert.equal(typeof storeModule.useApiStore, 'function');
  assert.equal(typeof api.createAirrestRuntime, 'function');
});

test('full profile restores the selected offline workspace after cloud sign-in and logout', async () => {
  const { load } = loadProductionModules();
  const { createAirrestRuntime } = load(path.join(root, 'runtime.ts'));
  let saved = null;
  const storage = { getItem: async () => saved, setItem: async (_key, value) => { saved = value; }, removeItem: async () => { saved = null; } };
  const adapter = { dispose() {}, cloudTransport: { fetch: async (url) => {
    const target = new URL(url);
    const data = target.pathname.endsWith('/feature-policy')
      ? { revision: 1, flags: { 'collection.move': true, 'collection.delete': true, 'collection.export': true } } : [];
    return new Response(JSON.stringify({ data }), { status: 200 });
  } } };
  const create = async () => {
    const runtime = createAirrestRuntime({ adapter, edition: 'full', storage });
    await new Promise((resolve) => setImmediate(resolve));
    return runtime;
  };
  const first = await create();
  assert.equal(first.store.getState().workspaceMode, 'offline');
  const localId = first.store.getState().createCollection('Local collection');
  const scope = { type: 'workspace', id: 'cloud', name: 'Cloud' };
  first.store.getState().setCloudConfig({ apiUrl: 'https://example.test', token: 'bearer', user: { id: 'one' }, activeScope: scope });
  first.store.getState().setWorkspaceMode('cloud');
  assert.equal(first.store.getState().workspaceMode, 'cloud');
  assert.equal(first.store.getState().collections.some((collection) => collection.id === localId), false);
  first.store.getState().logoutCloud();
  assert.equal(first.store.getState().workspaceMode, 'offline');
  assert.equal(first.store.getState().collections.some((collection) => collection.id === localId), true);
  await new Promise((resolve) => setImmediate(resolve));
  first.dispose();
  const second = await create();
  assert.equal(second.store.getState().workspaceMode, 'offline');
  assert.equal(second.store.getState().collections.some((collection) => collection.id === localId), true);
  second.dispose();
});

test('offline profile retains local data across restart and never invokes cloud transport', async () => {
  const { load } = loadProductionModules();
  const { createAirrestRuntime } = load(path.join(root, 'runtime.ts'));
  let saved = null;
  let cloudCalls = 0;
  const storage = { getItem: async () => saved, setItem: async (_key, value) => { saved = value; }, removeItem: async () => { saved = null; } };
  const adapter = { dispose() {}, cloudTransport: { fetch: async () => { cloudCalls++; throw new Error('cloud disabled'); } } };
  const create = async () => {
    const runtime = createAirrestRuntime({ adapter, edition: 'offline', storage });
    await new Promise((resolve) => setImmediate(resolve));
    return runtime;
  };
  const first = await create();
  const id = first.store.getState().createCollection('Local collection');
  await assert.rejects(first.cloudClient.fetchUserWorkspaces('https://example.test', undefined), /cloud access is disabled/i);
  first.store.getState().setCloudConfig({ apiUrl: 'https://example.test', token: 'token', user: { id: 'one' } });
  first.store.getState().setWorkspaceMode('cloud');
  assert.equal((await first.store.getState().createCloudWorkspace('disallowed')).success, false);
  assert.equal(first.store.getState().workspaceMode, 'offline');
  assert.equal(first.store.getState().cloudConfig.token, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  first.dispose();
  const second = await create();
  assert.equal(second.store.getState().collections.some((collection) => collection.id === id), true);
  assert.equal(cloudCalls, 0);
  second.dispose();
});
