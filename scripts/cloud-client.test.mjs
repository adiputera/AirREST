import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadCloudApi() {
  const source = fs.readFileSync(new URL('../packages/common/src/lib/cloudApi.ts', import.meta.url), 'utf8')
    .replaceAll('import.meta.env', '({})');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    fetch: () => { throw new Error('default fetch should not be called'); },
    Headers,
    Response,
    Request,
    URL,
    TextEncoder,
    TextDecoder,
    Blob,
    CompressionStream,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
  }, { filename: 'packages/common/src/lib/cloudApi.ts' });
  return exports;
}

test('cloud clients keep their transports isolated from each other and from the legacy default', async () => {
  const { createCloudClient } = loadCloudApi();
  const received = [];
  const first = createCloudClient({
    transport: {
      fetch: async (url) => {
        received.push(['first', url]);
        return new Response('{"data": []}', { status: 200 });
      },
    },
  });
  const second = createCloudClient({
    transport: {
      fetch: async (url) => {
        received.push(['second', url]);
        return new Response('{"data": []}', { status: 200 });
      },
    },
  });

  await first.fetchWithAuth('/one', { apiUrl: 'https://one.example' });
  await second.fetchWithAuth('/two', { apiUrl: 'https://two.example' });
  await second.fetchUserWorkspaces('https://two.example', 'token');
  await second.deleteScopeItem('https://two.example', 'token', 'item-1');
  first.dispose();

  assert.deepEqual(received, [
    ['first', 'https://one.example/one'],
    ['second', 'https://two.example/two'],
    ['second', 'https://two.example/api/v1/workspaces'],
    ['second', 'https://two.example/api/v1/items/item-1'],
  ]);
  assert.equal(first.getTransport(), null);
  assert.notEqual(second.getTransport(), null);
});

test('a disabled cloud client rejects requests before invoking provider or transport', async () => {
  const { createCloudClient } = loadCloudApi();
  let calls = 0;
  const client = createCloudClient({ enabled: false,
    authorizeRequest: async () => { calls++; return new Response('{}'); },
    transport: { fetch: async () => { calls++; return new Response('{}'); } },
  });
  await assert.rejects(client.fetchWithAuth('/api/v1/workspaces', { apiUrl: 'https://example.test' }), /cloud access is disabled/i);
  await assert.rejects(client.loginUser('https://example.test', 'user@example.com', 'password'), /cloud access is disabled/i);
  assert.equal(calls, 0);
  client.dispose();
});

test('password login uses the owning client transport and forwards cancellation', async () => {
  const { createCloudClient, setCloudTransport } = loadCloudApi();
  const received = [];
  const transport = (name) => ({
    fetch: async (url, init) => {
      received.push({ name, url, signal: init.signal });
      return new Response(JSON.stringify({ data: {
        user: { id: name }, token: name, refresh_token: 'refresh', expires_at: '2030-01-01',
      } }), { status: 200 });
    },
  });
  setCloudTransport(transport('legacy'));
  const first = createCloudClient({ transport: transport('first') });
  const second = createCloudClient({ transport: transport('second') });
  const controller = new AbortController();

  assert.equal((await first.loginUser('https://one.example', 'one@example.com', 'secret', controller.signal)).token, 'first');
  first.dispose();
  assert.equal((await second.loginUser('https://two.example', 'two@example.com', 'secret')).token, 'second');
  assert.deepEqual(received.map(({ name }) => name), ['first', 'second']);
  assert.equal(received[0].signal, controller.signal);
  second.dispose();
});

test('custom authorization owns requests and does not invoke password refresh', async () => {
  const { createCloudClient } = loadCloudApi();
  const calls = [];
  const client = createCloudClient({
    transport: { fetch: async (url, init) => {
      calls.push({ url, authorization: init.headers.Authorization || init.headers.authorization });
      return new Response('{"error":"unauthorized"}', { status: 401 });
    } },
    authorizeRequest: async (request, send) => {
      const headers = new Headers(request.init.headers);
      headers.set('Authorization', 'Bearer custom-provider');
      return send({ ...request.init, headers });
    },
  });
  const evictions = [];
  client.registerAuthEvictedCallback((reason, failedToken) => evictions.push({ reason, failedToken }));
  const response = await client.fetchWithAuth('/api/v1/workspaces', {
    apiUrl: 'https://example.test', token: 'old', refreshToken: 'unrelated-refresh',
  });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, 'Bearer custom-provider');
  assert.equal(calls[0].url, 'https://example.test/api/v1/workspaces');
  assert.equal(evictions.length, 1);
  assert.equal(evictions[0].failedToken, 'old');
  client.dispose();
});

test('a stale custom-provider 401 cannot evict a newer session', async () => {
  const { createCloudClient } = loadCloudApi();
  let respond;
  const evictions = [];
  const client = createCloudClient({
    transport: { fetch: () => new Promise((resolve) => { respond = resolve; }) },
    authorizeRequest: (request, send) => send(request.init),
  });
  client.registerAuthEvictedCallback((reason, token) => evictions.push({ reason, token }));
  const request = client.fetchWithAuth('/api/v1/workspaces', { apiUrl: 'https://example.test', token: 'same-token' });
  await new Promise((resolve) => setImmediate(resolve));
  client.invalidateSession();
  respond(new Response('Unauthorized', { status: 401 }));
  await assert.rejects(request, /Session changed/);
  assert.equal(evictions.length, 0);
  client.dispose();
});

test('a final cookie 401 evicts only an active provider session', async () => {
  const { createCloudClient } = loadCloudApi();
  const evictions = [];
  const client = createCloudClient({
    transport: { fetch: async () => new Response('Unauthorized', { status: 401 }) },
    authorizeRequest: (request, send) => send(request.init),
  });
  client.registerAuthEvictedCallback((_reason, token) => evictions.push(token));
  await client.fetchWithAuth('/api/v1/workspaces', { apiUrl: 'https://example.test' });
  assert.equal(evictions.length, 0);
  client.setProviderSessionActive(true);
  await client.fetchWithAuth('/api/v1/workspaces', { apiUrl: 'https://example.test' });
  assert.equal(evictions.length, 1);
  assert.equal(evictions[0], undefined);
  client.dispose();
});

test('provider credentials are forwarded only by transports that explicitly support them', async () => {
  const { createCloudClient } = loadCloudApi();
  const received = [];
  const authorizeRequest = (request, send) => send({ ...request.init, credentials: 'include' });
  const supported = createCloudClient({
    authorizeRequest,
    transport: { supportsCredentials: true, fetch: async (_url, init) => {
      received.push(init.credentials);
      return new Response('{}');
    } },
  });
  const unsupported = createCloudClient({
    authorizeRequest,
    transport: { fetch: async () => { throw new Error('unsupported transport was called'); } },
  });
  await supported.fetchWithAuth('/api/v1/workspaces', { apiUrl: 'https://example.test' });
  assert.deepEqual(received, ['include']);
  await assert.rejects(
    unsupported.fetchWithAuth('/api/v1/workspaces', { apiUrl: 'https://example.test' }),
    /does not support credentialed requests/,
  );
  supported.dispose();
  unsupported.dispose();
});

test('tokenless provider can verify identity and call cloud APIs through its own cookie transport', async () => {
  const { createCloudClient, setCloudTransport } = loadCloudApi();
  setCloudTransport({ fetch: () => { throw new Error('legacy transport used'); } });
  const calls = [];
  const client = createCloudClient({
    authorizeRequest: (request, send) => send({ ...request.init, credentials: 'include' }),
    passwordRefresh: false,
    transport: { supportsCredentials: true, fetch: async (url, init) => {
      calls.push({ url, credentials: init.credentials, authorization: init.headers.authorization });
      const data = url.endsWith('/auth/me') ? { id: 'cookie-user' } : url.endsWith('/workspaces') ? [{ id: 'workspace' }] : {};
      return new Response(JSON.stringify({ data }), { status: 200 });
    } },
  });
  const controller = new AbortController();
  assert.equal((await client.getCurrentUser('https://example.test', undefined, undefined, controller.signal)).id, 'cookie-user');
  assert.equal((await client.fetchUserWorkspaces('https://example.test', undefined))[0].id, 'workspace');
  await client.deleteScopeItem('https://example.test', undefined, 'item');
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.credentials === 'include' && call.authorization === undefined));
  client.dispose();
});

test('invalidating a client session isolates pending refreshes even if refresh tokens match', async () => {
  const { createCloudClient } = loadCloudApi();
  const pending = [];
  const callbacks = [];
  const client = createCloudClient({ transport: { fetch: async (url) => {
    if (url.endsWith('/auth/refresh')) return new Promise((resolve) => pending.push(resolve));
    return new Response('{}', { status: 401 });
  } } });
  client.registerTokenRefreshCallback((tokens) => callbacks.push(tokens.token));
  const options = { apiUrl: 'https://example.test', token: 'old', refreshToken: 'same' };
  const first = client.fetchWithAuth('/api/v1/workspaces', options);
  await new Promise((resolve) => setImmediate(resolve));
  client.invalidateSession();
  const second = client.fetchWithAuth('/api/v1/workspaces', options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[0](new Response(JSON.stringify({ data: { token: 'stale', refresh_token: 'rotated' } })));
  await assert.rejects(first, /session changed/i);
  assert.deepEqual(callbacks, []);
  pending[1](new Response(JSON.stringify({ data: { token: 'current', refresh_token: 'rotated' } })));
  await second;
  assert.deepEqual(callbacks, ['current']);
  client.dispose();
});

test('account actions use their own client transport', async () => {
  const { createCloudClient, setCloudTransport } = loadCloudApi();
  setCloudTransport({ fetch: () => { throw new Error('legacy transport used'); } });
  const calls = [];
  const client = createCloudClient({ transport: { fetch: async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ data: url.endsWith('/password')
      ? { user: { id: 'one' }, token: 'replacement', refresh_token: 'replacement-refresh' }
      : { id: 'one', name: 'Tester' } }));
  } } });
  assert.equal((await client.updateUserProfile('https://example.test', 'Tester', 'token')).name, 'Tester');
  assert.equal((await client.changeUserPassword('https://example.test', 'old', 'new', 'token')).token, 'replacement');
  assert.deepEqual(calls, ['https://example.test/api/v1/auth/profile', 'https://example.test/api/v1/auth/password']);
  client.dispose();
});

test('runtime ignores delayed eviction errors after a new session or disposal', () => {
  const source = fs.readFileSync(new URL('../packages/common/src/runtime.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let eviction;
  const timers = new Map();
  let nextTimer = 0;
  let activeStore = null;
  let defaultAdapter = null;
  let defaultTransport = null;
  let executor = null;
  const events = [];
  let onStateChange;
  let sessionGeneration = 0;
  let invalidations = 0;
  const noop = () => {};
  const unregister = () => noop;
  const cloudClient = {
    loginUser: noop,
    registerTokenRefreshCallback: unregister,
    registerAuthEvictedCallback: (callback) => { eviction = callback; return noop; },
    invalidateSession: () => { invalidations++; },
    dispose: noop,
  };
  const modules = {
    './store/useApiStore': { setActiveRuntimeStore: (value) => { activeStore = value; }, getActiveRuntimeStore: () => activeStore },
    './lib/cloudApi': { setCloudTransport: (value) => { defaultTransport = value; }, getCloudTransport: () => defaultTransport, registerTokenRefreshCallback: unregister, registerAuthEvictedCallback: unregister },
    './lib/fetcher': { setDefaultPlatformAdapter: (value) => { defaultAdapter = value; }, getDefaultPlatformAdapter: () => defaultAdapter },
    './lib/scriptRunner': { setScriptExecutor: (value) => { executor = value; }, getScriptExecutor: () => executor },
    './productPolicy': { createProductPolicy: () => ({ edition: 'full', workspace: { cloud: true } }) },
    './auth/passwordAuthProvider': { createPasswordAuthProvider: () => ({}) },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, require: (id) => modules[id],
    window: { dispatchEvent: (event) => events.push(event) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const state = { cloudConfig: { token: 'old-token' }, syncError: null, getCloudSessionGeneration: () => sessionGeneration };
  state.logoutCloud = () => { state.cloudConfig = {}; state.syncError = null; };
  const store = { getState: () => state, setState: (updates) => Object.assign(state, updates), subscribe: (callback) => { onStateChange = callback; return noop; }, dispose: noop };
  const runtime = exports.createAirrestRuntime({ adapter: { dispose: noop }, store, cloudClient });

  sessionGeneration++;
  onStateChange(state);
  onStateChange(state);
  assert.equal(invalidations, 1);

  eviction('expired', 'unrelated-token');
  assert.equal(timers.size, 0);
  eviction('expired', 'old-token');
  assert.equal(timers.size, 1);
  assert.equal(events[0].detail.store, store);
  for (const callback of timers.values()) callback();
  timers.clear();
  assert.equal(state.syncError, 'expired');
  state.cloudConfig = { token: 'old-token' };
  eviction('expired', 'old-token');
  state.cloudConfig = { token: 'new-token' };
  for (const callback of timers.values()) callback();
  timers.clear();
  assert.equal(state.syncError, null);
  eviction('expired again', 'new-token');
  runtime.dispose();
  assert.equal(timers.size, 0);
  assert.equal(state.syncError, null);
});

test('runtime callbacks stay isolated from the legacy client unless explicitly enabled', () => {
  const source = fs.readFileSync(new URL('../packages/common/src/runtime.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const noop = () => {};
  const globals = { refresh: new Set(), eviction: new Set() };
  const register = (set) => (callback) => { set.add(callback); return () => set.delete(callback); };
  let activeStore = null;
  let adapter = null;
  let transport = null;
  let executor = null;
  const modules = {
    './store/useApiStore': { setActiveRuntimeStore: (v) => { activeStore = v; }, getActiveRuntimeStore: () => activeStore },
    './lib/cloudApi': {
      setCloudTransport: (v) => { transport = v; }, getCloudTransport: () => transport,
      registerTokenRefreshCallback: register(globals.refresh), registerAuthEvictedCallback: register(globals.eviction),
    },
    './lib/fetcher': { setDefaultPlatformAdapter: (v) => { adapter = v; }, getDefaultPlatformAdapter: () => adapter },
    './lib/scriptRunner': { setScriptExecutor: (v) => { executor = v; }, getScriptExecutor: () => executor },
    './productPolicy': { createProductPolicy: () => ({ edition: 'full', workspace: { cloud: true } }) },
    './auth/passwordAuthProvider': { createPasswordAuthProvider: () => ({}) },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: (id) => modules[id], setTimeout, clearTimeout });
  const make = (legacyCloudCallbacks = false) => {
    const callbacks = {};
    const state = { cloudConfig: { token: 'same-access', refreshToken: 'same-refresh' } };
    state.setCloudConfig = (updates) => Object.assign(state.cloudConfig, updates);
    state.logoutCloud = () => { state.cloudConfig = {}; };
    state.getCloudSessionGeneration = () => 0;
    const store = { getState: () => state, subscribe: () => noop, dispose: noop };
    const client = {
      loginUser: noop, invalidateSession: noop, dispose: noop,
      registerTokenRefreshCallback: (cb) => { callbacks.refresh = cb; return noop; },
      registerAuthEvictedCallback: (cb) => { callbacks.eviction = cb; return noop; },
    };
    const runtime = exports.createAirrestRuntime({ adapter: { dispose: noop }, store, cloudClient: client, legacyCloudCallbacks });
    return { runtime, state, callbacks };
  };
  const first = make();
  const second = make();
  assert.equal(globals.refresh.size, 0);
  assert.equal(globals.eviction.size, 0);
  first.callbacks.refresh({ token: 'first-refreshed', refreshToken: 'new', previousRefreshToken: 'same-refresh' });
  assert.equal(first.state.cloudConfig.token, 'first-refreshed');
  assert.equal(second.state.cloudConfig.token, 'same-access');

  const legacy = make(true);
  assert.equal(globals.refresh.size, 1);
  for (const callback of globals.refresh) callback({ token: 'legacy-refreshed', refreshToken: 'new', previousRefreshToken: 'same-refresh' });
  assert.equal(legacy.state.cloudConfig.token, 'legacy-refreshed');
  assert.equal(second.state.cloudConfig.token, 'same-access');
  const later = make();
  for (const callback of globals.eviction) callback('expired', 'legacy-refreshed');
  assert.equal(legacy.state.cloudConfig.token, 'legacy-refreshed');
  later.runtime.dispose();
  legacy.runtime.dispose();
  second.runtime.dispose();
  first.runtime.dispose();
  assert.equal(globals.refresh.size, 0);
  assert.equal(globals.eviction.size, 0);
});

test('a provider 401 signs out only its own runtime and preserves the other session', async () => {
  const cloudApi = loadCloudApi();
  const source = fs.readFileSync(new URL('../packages/common/src/runtime.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const noop = () => {};
  let activeStore = null;
  let defaultAdapter = null;
  let executor = null;
  const modules = {
    './store/useApiStore': { setActiveRuntimeStore: (v) => { activeStore = v; }, getActiveRuntimeStore: () => activeStore },
    './lib/cloudApi': cloudApi,
    './lib/fetcher': { setDefaultPlatformAdapter: (v) => { defaultAdapter = v; }, getDefaultPlatformAdapter: () => defaultAdapter },
    './lib/scriptRunner': { setScriptExecutor: (v) => { executor = v; }, getScriptExecutor: () => executor },
    './workspace/cloudSession': { isCloudSessionActive: (config) => Boolean(config.token || (config.sessionKind === 'provider' && config.user?.id)) },
    './productPolicy': { createProductPolicy: () => ({ edition: 'full', workspace: { cloud: true } }) },
    './auth/passwordAuthProvider': { createPasswordAuthProvider: () => ({}) },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: (id) => modules[id], setTimeout, clearTimeout });
  const make = (id) => {
    let generation = 0;
    let observer = noop;
    const state = { cloudConfig: { apiUrl: 'https://example.test', sessionKind: 'provider', user: { id } },
      getCloudSessionGeneration: () => generation };
    state.logoutCloud = () => { state.cloudConfig = { apiUrl: 'https://example.test' }; generation++; observer(state); };
    const store = { getState: () => state, subscribe: (callback) => { observer = callback; return noop; }, setState: noop, dispose: noop };
    const cloudClient = cloudApi.createCloudClient({ transport: { fetch: async () => new Response('Unauthorized', { status: 401 }) },
      authorizeRequest: (request, send) => send(request.init) });
    return { state, cloudClient, runtime: exports.createAirrestRuntime({ adapter: { dispose: noop }, store, cloudClient }) };
  };
  const first = make('one');
  const second = make('two');
  await assert.rejects(first.cloudClient.fetchWithAuth('/api/v1/workspaces', { apiUrl: 'https://example.test' }), /Session changed/);
  assert.equal(first.state.cloudConfig.user, undefined);
  assert.equal(second.state.cloudConfig.user.id, 'two');
  first.runtime.dispose();
  second.runtime.dispose();
});

test('platform adapter selection follows the runtime context and retains the legacy fallback', () => {
  const source = fs.readFileSync(new URL('../packages/common/src/context.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  let contextValue = null;
  const legacy = { platformId: 'legacy' };
  const modules = {
    react: { __esModule: true, default: { createElement: () => {} }, createContext: () => ({}), useContext: () => contextValue },
    './store/storeContext': { StoreContext: {} }, './lib/edition': { defaultProductPolicy: {} },
    './auth/passwordAuthProvider': { passwordAuthProvider: {} }, './lib/fetcher': { getDefaultPlatformAdapter: () => legacy },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: (id) => modules[id] || {} });
  const first = { platformId: 'first' };
  const second = { platformId: 'second' };
  contextValue = { adapter: first };
  assert.equal(exports.usePlatformAdapter(), first);
  contextValue = { adapter: second };
  assert.equal(exports.usePlatformAdapter(), second);
  contextValue = null;
  assert.equal(exports.usePlatformAdapter(), legacy);
});

function renderLoginModal({ authProvider, cloudClient, store, onClose = () => {}, hooks, platformAdapter = null, productPolicy = { workspace: { offline: true, cloud: true } } }) {
  const source = fs.readFileSync(new URL('../packages/common/src/components/CloudAuthModal.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const createElement = (type, props, ...children) => ({ type, props: props || {}, children });
  let stateIndex = 0;
  let refIndex = 0;
  const react = {
    __esModule: true, default: { createElement, Fragment: 'fragment' },
    useState: (initial) => {
      if (!hooks) return [initial, () => {}];
      const index = stateIndex++;
      if (!(index in hooks.states)) hooks.states[index] = initial;
      return [hooks.states[index], (value) => { hooks.states[index] = value; }];
    },
    useRef: (value) => {
      if (!hooks) return { current: value };
      const index = refIndex++;
      return hooks.refs[index] || (hooks.refs[index] = { current: value });
    },
    useEffect: () => {},
  };
  const modules = {
    react,
    'lucide-react': {},
    '../lib/backNavigation': { useBackHandler: () => {} },
    '../store/useApiStore': { useApiStore: store },
    '../store/storeContext': { useStoreContext: () => store },
    '../lib/cloudApi': {
      normalizeCloudApiUrl: (url) => url,
      fetchUserWorkspaces: () => { throw new Error('legacy transport used'); },
      fetchUserTeams: () => { throw new Error('legacy transport used'); },
      fetchTeamProjects: () => { throw new Error('legacy transport used'); },
    },
    '../lib/jwt': { getRoleFromJwt: () => null },
    '../workspace/cloudSession': { isCloudSessionActive: (config) => Boolean(config.token || (config.sessionKind === 'provider' && config.user?.id)) },
    '../context': { useAuthProvider: () => authProvider, useCloudClient: () => cloudClient, useProductPolicy: () => productPolicy, usePlatformAdapter: () => platformAdapter },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: (id) => modules[id], AbortController, console });
  return exports.CloudAuthModal({ isOpen: true, onClose });
}

function findElement(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

function createLoginStore() {
  let generation = 0;
  const state = {
    cloudConfig: { apiUrl: 'https://example.test' }, collections: [], offlineScopeCache: {},
    activeOfflineWorkspaceId: 'local-default', workspaceMode: 'offline',
    setCloudConfig: (config) => { state.cloudConfig = config; generation++; },
    getCloudSessionGeneration: () => generation,
    setWorkspaceMode: (mode) => { state.workspaceMode = mode; },
    setActiveScope: async () => {}, pullCloudDelta: async () => {}, importLocalToCloud: async () => {},
  };
  const store = (selector) => selector(state);
  store.getState = () => state;
  return store;
}

test('login scope discovery uses the runtime client and ignores a closed login', async () => {
  const user = { id: 'user-1', role: 'member' };
  const calls = [];
  let finishSignIn;
  const store = createLoginStore();
  const authProvider = {
    capabilities: { passwordCredentials: false },
    signIn: ({ signal }) => new Promise((resolve) => { finishSignIn = () => resolve({ user, accessToken: 'token' }); calls.push(['sign-in', signal]); }),
  };
  const cloudClient = {
    fetchUserWorkspaces: async (_url, _token, _refresh, signal) => { calls.push(['workspaces', signal]); return [{ id: 'workspace-1', name: 'Test', is_default: true }]; },
  };
  const first = renderLoginModal({ authProvider, cloudClient, store });
  const submit = findElement(first, (element) => element.type === 'form').props.onSubmit;
  const pending = submit({ preventDefault() {} });
  findElement(first, (element) => element.props.title === 'Close').props.onClick();
  assert.equal(calls[0][1].aborted, true);
  finishSignIn();
  await pending;
  assert.equal(calls.length, 1);
  assert.equal(store.getState().cloudConfig.token, undefined);

  const second = renderLoginModal({ authProvider, cloudClient, store });
  const next = findElement(second, (element) => element.type === 'form').props.onSubmit({ preventDefault() {} });
  finishSignIn();
  await next;
  assert.equal(calls[2][0], 'workspaces');
  assert.equal(calls[1][1], calls[2][1]);
  assert.equal(store.getState().cloudConfig.activeScope.id, 'workspace-1');
});

test('login form follows the provider password capability', () => {
  const store = createLoginStore();
  const provider = { capabilities: { passwordCredentials: false }, signIn: async () => ({}) };
  const withoutPassword = renderLoginModal({ store, authProvider: provider, cloudClient: {} });
  assert.equal(findElement(withoutPassword, (element) => element.type === 'input' && element.props.type === 'password'), null);
  provider.capabilities.passwordCredentials = true;
  const withPassword = renderLoginModal({ store, authProvider: provider, cloudClient: {} });
  assert.ok(findElement(withPassword, (element) => element.type === 'input' && element.props.type === 'password'));
});

test('cloud-only login cannot be dismissed until a session exists', () => {
  const store = createLoginStore();
  let closed = 0;
  const args = { store, authProvider: { capabilities: { passwordCredentials: false } }, cloudClient: {},
    productPolicy: { workspace: { offline: false, cloud: true } }, onClose: () => { closed++; } };
  const unauthenticated = renderLoginModal(args);
  assert.equal(findElement(unauthenticated, (element) => element.props.title === 'Close'), null);
  const backdrop = {};
  unauthenticated.props.onClick({ target: backdrop, currentTarget: backdrop });
  assert.equal(closed, 0);
  store.getState().setCloudConfig({ apiUrl: 'https://example.test', token: 'token', user: { id: 'one' } });
  const authenticated = renderLoginModal(args);
  findElement(authenticated, (element) => element.props.title === 'Close').props.onClick();
  assert.equal(closed, 1);
});

test('cloud-only sign-in offers the preserved-data download before authentication', async () => {
  const store = createLoginStore();
  const calls = [];
  store.getState().cloudCacheArchives = { unclaimed: [{ scopeCache: {} }], unsupportedVersions: [] };
  store.getState().getCloudCacheRecoveryBackup = () => '{"archives":[]}';
  const tree = renderLoginModal({ store, authProvider: { capabilities: { passwordCredentials: false } }, cloudClient: {},
    productPolicy: { workspace: { offline: false, cloud: true } },
    platformAdapter: { saveFile: async (...args) => { calls.push(args); return true; } } });
  const download = findElement(tree, (element) => element.type === 'button' && element.children.includes('Download preserved data'));
  assert.ok(download);
  download.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0][0], 'airrest-cloud-cache-recovery.json');
  assert.equal(calls[0][1], '{"archives":[]}');
  assert.equal(store.getState().cloudConfig.token, undefined);
});

test('a late initial pull cannot complete login after the active session changes', async () => {
  const store = createLoginStore();
  let finishPull;
  let closed = 0;
  store.getState().setActiveScope = () => new Promise((resolve) => { finishPull = resolve; });
  const tree = renderLoginModal({
    store,
    onClose: () => { closed++; },
    authProvider: { capabilities: { passwordCredentials: false }, signIn: async () => ({ user: { id: 'one' }, accessToken: 'same' }) },
    cloudClient: { fetchUserWorkspaces: async () => [{ id: 'one', name: 'One' }] },
  });
  const pending = findElement(tree, (element) => element.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getState().cloudConfig.user.id, 'one');
  store.getState().setCloudConfig({ apiUrl: 'https://example.test', token: 'same', user: { id: 'two' } });
  finishPull();
  await pending;
  assert.equal(store.getState().cloudConfig.user.id, 'two');
  assert.equal(closed, 0);
});

test('a local-import prompt cannot upload to a replacement session', async () => {
  const store = createLoginStore();
  const hooks = { states: [], refs: [] };
  let imports = 0;
  store.getState().collections = [{ id: 'local' }];
  store.getState().importLocalToCloud = async () => { imports++; };
  const args = {
    store, hooks,
    authProvider: { capabilities: { passwordCredentials: false }, signIn: async () => ({ user: { id: 'one' }, accessToken: 'same' }) },
    cloudClient: { fetchUserWorkspaces: async () => [{ id: 'one', name: 'One' }] },
  };
  const tree = renderLoginModal(args);
  await findElement(tree, (element) => element.type === 'form').props.onSubmit({ preventDefault() {} });
  const prompt = renderLoginModal(args);
  const button = findElement(prompt, (element) => element.type === 'button' && element.children.includes('Yes, Import Local Collections'));
  assert.ok(button);
  store.getState().setCloudConfig({ apiUrl: 'https://example.test', token: 'same', user: { id: 'two' } });
  await button.props.onClick();
  assert.equal(imports, 0);
  assert.equal(store.getState().cloudConfig.user.id, 'two');
});

test('login cannot replace a session changed while scope discovery is pending', async () => {
  const store = createLoginStore();
  let finishScopes;
  let scopeSignal;
  const tree = renderLoginModal({
    store,
    authProvider: { capabilities: { passwordCredentials: false }, signIn: async () => ({ user: { id: 'one', role: 'member' }, accessToken: 'old' }) },
    cloudClient: { fetchUserWorkspaces: (_url, _token, _refresh, signal) => new Promise((resolve) => { scopeSignal = signal; finishScopes = resolve; }) },
  });
  const pending = findElement(tree, (element) => element.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  store.getState().setCloudConfig({ apiUrl: 'https://example.test', token: 'new', user: { id: 'two' } });
  finishScopes([{ id: 'workspace-1', name: 'Test' }]);
  await pending;
  assert.equal(scopeSignal.aborted, false);
  assert.equal(store.getState().cloudConfig.token, 'new');
  assert.equal(store.getState().workspaceMode, 'offline');
});

test('login rejects unsupported or unidentified sessions before loading cloud data', async () => {
  for (const session of [
    { user: { id: 'one' } },
    { user: { id: 'one' }, accessToken: '  ' },
    { user: {}, accessToken: 'token' },
    { user: { id: '  ' }, accessToken: 'token' },
  ]) {
    const store = createLoginStore();
    let scopeCalls = 0;
    const tree = renderLoginModal({
      store,
      authProvider: { capabilities: { passwordCredentials: false }, signIn: async () => session },
      cloudClient: { fetchUserWorkspaces: async () => { scopeCalls++; return []; } },
    });
    await findElement(tree, (element) => element.type === 'form').props.onSubmit({ preventDefault() {} });
    assert.equal(scopeCalls, 0);
    assert.equal(store.getState().cloudConfig.token, undefined);
    assert.equal(store.getState().workspaceMode, 'offline');
  }
});

test('tokenless login verifies the provider identity before and after discovering scopes', async () => {
  const store = createLoginStore();
  const calls = [];
  const authProvider = { capabilities: { passwordCredentials: false }, authorizeRequest: (_req, send) => send({}),
    signIn: async () => ({ user: { id: 'one', role: 'superadmin' } }) };
  const cloudClient = {
    getCurrentUser: async () => { calls.push('verify'); return { id: 'one', role: 'member' }; },
    fetchUserWorkspaces: async () => { calls.push('scopes'); return [{ id: 'ws', name: 'Workspace' }]; },
  };
  const tree = renderLoginModal({ store, authProvider, cloudClient });
  await findElement(tree, (element) => element.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls, ['verify', 'scopes', 'verify']);
  assert.equal(store.getState().cloudConfig.sessionKind, 'provider');
  assert.equal(store.getState().cloudConfig.token, undefined);
  assert.equal(store.getState().cloudConfig.user.id, 'one');
  assert.equal(store.getState().cloudConfig.user.role, 'member');
});

test('tokenless login never opens cache if the verified identity changes during scope discovery', async () => {
  const store = createLoginStore();
  let count = 0;
  const authProvider = { capabilities: { passwordCredentials: false }, authorizeRequest: (_req, send) => send({}),
    signIn: async () => ({ user: { id: 'one' } }) };
  const cloudClient = {
    getCurrentUser: async () => ({ id: ++count === 1 ? 'one' : 'two' }),
    fetchUserWorkspaces: async () => [{ id: 'ws', name: 'Workspace' }],
  };
  const tree = renderLoginModal({ store, authProvider, cloudClient });
  await findElement(tree, (element) => element.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(count, 2);
  assert.equal(store.getState().cloudConfig.user, undefined);
  assert.equal(store.getState().workspaceMode, 'offline');
});

test('a custom provider signs in and performs cloud operations without password refresh', async () => {
  const { createCloudClient } = loadCloudApi();
  const requests = [];
  const authProvider = {
    capabilities: { passwordCredentials: false },
    signIn: async () => ({
      user: { id: 'user-1', role: 'member' }, accessToken: 'provider-session', refreshToken: 'provider-owned',
    }),
    authorizeRequest: async (request, send) => {
      const headers = new Headers(request.init.headers);
      headers.set('Authorization', `Bearer ${request.token}`);
      return send({ ...request.init, headers });
    },
  };
  const cloudClient = createCloudClient({
    authorizeRequest: authProvider.authorizeRequest,
    passwordRefresh: false,
    transport: { fetch: async (url, init) => {
      requests.push({ url, authorization: init.headers.authorization || init.headers.Authorization });
      const data = url.endsWith('/workspaces') ? [{ id: 'workspace-1', name: 'Workspace', is_default: true }] : {};
      return new Response(JSON.stringify({ data }), { status: 200 });
    } },
  });
  const store = createLoginStore();
  const tree = renderLoginModal({ authProvider, cloudClient, store });
  await findElement(tree, (element) => element.type === 'form').props.onSubmit({ preventDefault() {} });
  const session = store.getState().cloudConfig;
  assert.equal(session.user.id, 'user-1');
  assert.equal(session.activeScope.id, 'workspace-1');
  await cloudClient.deleteScopeItem(session.apiUrl, session.token, 'item-1', session.refreshToken);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.authorization === 'Bearer provider-session'));
  assert.ok(requests.every((request) => !request.url.endsWith('/auth/refresh')));
  cloudClient.dispose();
});

test('provider sign-out cannot log out a replacement session', async () => {
  const source = fs.readFileSync(new URL('../packages/common/src/components/UserMenu.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  let generation = 1;
  let finishSignOut;
  let logouts = 0;
  let received;
  const state = { cloudConfig: { apiUrl: 'https://example.test', token: 'old', user: { id: 'one', name: 'Tester', role: 'user' } }, getCloudSessionGeneration: () => generation, logoutCloud: () => { logouts++; } };
  const store = (selector) => selector(state);
  store.getState = () => state;
  const confirmModal = () => {};
  const editModal = () => {};
  const passwordModal = () => {};
  const capabilities = { editableProfile: false, passwordChange: false };
  const react = { __esModule: true, default: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: 'fragment' }, useState: (initial) => [initial, () => {}], useRef: (current) => ({ current }), useEffect: () => {} };
  const modules = {
    react, 'lucide-react': {}, '../lib/backNavigation': { useBackHandler: () => {} },
    '../store/useApiStore': { useApiStore: store }, '../store/storeContext': { useStoreContext: () => store },
    '../workspace/cloudSession': { isCloudSessionActive: (config) => Boolean(config.token || (config.sessionKind === 'provider' && config.user?.id)) },
    '../context': { useProductPolicy: () => ({ workspace: { cloud: true } }), useAuthProvider: () => ({ capabilities, signOut: (request) => new Promise((resolve) => { received = request; finishSignOut = resolve; }) }) },
    './ConfirmModal': { ConfirmModal: confirmModal }, './EditProfileModal': { EditProfileModal: editModal }, './ChangePasswordModal': { ChangePasswordModal: passwordModal }, './CloudAuthModal': {},
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: (id) => modules[id], console });
  const tree = exports.UserMenu({});
  assert.equal(findElement(tree, (element) => element.type === editModal), null);
  assert.equal(findElement(tree, (element) => element.type === passwordModal), null);
  capabilities.editableProfile = true;
  capabilities.passwordChange = true;
  const withAccountControls = exports.UserMenu({});
  assert.ok(findElement(withAccountControls, (element) => element.type === editModal));
  assert.ok(findElement(withAccountControls, (element) => element.type === passwordModal));
  findElement(tree, (element) => element.type === confirmModal).props.onConfirm();
  assert.equal(received.accessToken, 'old');
  generation++;
  finishSignOut();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logouts, 0);
});
