import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const tick = () => new Promise(setImmediate);
const json = (data, status = 200) => new Response(JSON.stringify({ data }), { status });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Use the same TypeScript/VM approach as security-client.test.mjs. No server or credentials required.
function load(file, overrides = {}, globals = {}) {
  const source = read(file).replaceAll('import.meta.env', 'VITE_ENV');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, console, Headers, Response, TextEncoder, Error, VITE_ENV: {},
    require: (id) => id in overrides ? overrides[id] : require(id),
    ...globals,
  }, { filename: file });
  return exports;
}

function session(fetch, env = {}, persisted = null) {
  const api = load('hub/src/lib/api.ts', {}, { fetch, VITE_ENV: env });
  const { useHubStore: store } = load('hub/src/store/useHubStore.ts', { '../lib/api': api }, {
    VITE_ENV: env,
    localStorage: { getItem: () => persisted, setItem() {}, removeItem() {} },
  });
  return { api, store };
}
const user = { id: 'user', name: 'Tester', email: 'tester@example.com', role: 'superadmin' };
function login(store, id = 'old') {
  store.getState().setAuth({ ...user, id }, `${id}-access`, `${id}-refresh`, '2030-01-01T00:00:00Z');
}
function request(api, store, endpoint = '/api/v1/teams') {
  const { apiUrl, token, refreshToken } = store.getState();
  return api.fetchWithAuth(endpoint, { apiUrl, token, refreshToken });
}

test('changing servers clears credentials, selection, and navigation before the next request', async () => {
  const calls = [];
  const { api, store } = session(async (url, options) => {
    calls.push({ url, options });
    return json([]);
  });
  login(store);
  store.getState().setSelectedTeamId('team');
  store.getState().setSelectedProjectId('project');
  store.getState().setActiveTab('superadmin');
  store.getState().setApiUrl('https://example.com/');
  assert.equal(store.getState().token, null);
  assert.equal(store.getState().refreshToken, null);
  assert.equal(store.getState().user, null);
  assert.equal(store.getState().selectedTeamId, null);
  assert.equal(store.getState().selectedProjectId, null);
  assert.equal(store.getState().activeTab, 'teams');
  await request(api, store);
  assert.equal(calls[0].options.headers.has('Authorization'), false);
  assert.equal(calls.length, 1);
});

test('saving the same normalized server keeps the session', () => {
  const { store } = session(() => assert.fail('unexpected fetch'));
  login(store);
  store.getState().setApiUrl(` ${store.getState().apiUrl}/// `);
  assert.equal(store.getState().token, 'old-access');
});

test('configured server migration clears persisted credentials', () => {
  const persisted = JSON.stringify({ state: { apiUrl: 'http://localhost:8080', token: 'old-access', refreshToken: 'old-refresh', user }, version: 0 });
  const { store } = session(() => assert.fail('unexpected fetch'), { VITE_API_URL: 'https://example.com' }, persisted);
  assert.equal(store.getState().apiUrl, 'https://example.com');
  assert.equal(store.getState().token, null);
});

for (const refreshStatus of [200, 401]) {
  test(`late refresh ${refreshStatus} cannot replace or evict a new login`, async () => {
    const refresh = deferred();
    let calls = 0;
    const { api, store } = session(async (url) => {
      calls++;
      return url.endsWith('/auth/refresh') ? refresh.promise : json({}, 401);
    });
    login(store);
    const old = assert.rejects(request(api, store), /Session changed/);
    await tick();
    store.getState().logout();
    login(store, 'new');
    refresh.resolve(json({ token: 'renewed-old', refresh_token: 'renewed-old-refresh' }, refreshStatus));
    await old;
    assert.equal(store.getState().token, 'new-access');
    assert.equal(calls, 2, 'obsolete requests must not retry');
  });
}

test('a late initial 401 cannot refresh after switching servers', async () => {
  const response = deferred();
  let calls = 0;
  const { api, store } = session(() => { calls++; return response.promise; });
  login(store);
  const old = assert.rejects(request(api, store), /Session changed/);
  store.getState().setApiUrl('https://example.com');
  login(store, 'new');
  response.resolve(json({}, 401));
  await old;
  assert.equal(calls, 1);
  assert.equal(store.getState().token, 'new-access');
});

test('a late retry 401 cannot evict a new login', async () => {
  const retry = deferred();
  let calls = 0;
  const { api, store } = session(async () => {
    calls++;
    if (calls === 1) return json({}, 401);
    if (calls === 2) return json({ token: 'renewed', refresh_token: 'renewed-refresh' });
    return retry.promise;
  });
  login(store);
  const old = assert.rejects(request(api, store), /Session changed/);
  await tick();
  login(store, 'new');
  retry.resolve(json({}, 401));
  await old;
  assert.equal(store.getState().token, 'new-access');
});

test('auth eviction callback rejects mismatched tokens and accepts matching tokens', () => {
  let evictionHandler;
  const fakeApi = {
    DEFAULT_API_URL: 'http://localhost:8080',
    registerHubTokenRefresh() {},
    registerHubAuthEvicted(cb) { evictionHandler = cb; },
    invalidateHubSession() {},
  };
  const { useHubStore: store } = load('hub/src/store/useHubStore.ts', { '../lib/api': fakeApi }, {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  login(store, 'active');
  assert.equal(store.getState().token, 'active-access');

  // Mismatched token or refresh token must not log out
  evictionHandler({ token: 'other-access', refreshToken: 'other-refresh' });
  assert.equal(store.getState().token, 'active-access');

  // Matching token logs out
  evictionHandler({ token: 'active-access', refreshToken: 'active-refresh' });
  assert.equal(store.getState().token, null);
});

test('concurrent requests in the same session share one refresh and retry successfully', async () => {
  const refresh = deferred();
  let refreshes = 0;
  const { api, store } = session(async (url, options) => {
    if (url.endsWith('/auth/refresh')) { refreshes++; return refresh.promise; }
    return json([], options.headers.get('Authorization') === 'Bearer renewed' ? 200 : 401);
  });
  login(store);
  const first = request(api, store);
  const second = request(api, store);
  await tick();
  refresh.resolve(json({ token: 'renewed', refresh_token: 'renewed-refresh' }));
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(refreshes, 1);
  assert.equal(store.getState().token, 'renewed');
});

test('a new session refresh is independent of an old pending refresh', async () => {
  const oldRefresh = deferred();
  const seen = [];
  const { api, store } = session(async (url, options) => {
    if (url.endsWith('/auth/refresh')) {
      const refreshToken = JSON.parse(options.body).refresh_token;
      seen.push(refreshToken);
      return refreshToken === 'old-refresh' ? oldRefresh.promise : json({ token: 'renewed-new', refresh_token: 'renewed-new-refresh' });
    }
    return json([], options.headers.get('Authorization') === 'Bearer renewed-new' ? 200 : 401);
  });
  login(store);
  const old = assert.rejects(request(api, store), /Session changed/);
  await tick();
  login(store, 'new');
  assert.equal((await request(api, store)).status, 200);
  assert.deepEqual(seen, ['old-refresh', 'new-refresh']);
  oldRefresh.resolve(json({}, 401));
  await old;
  assert.equal(store.getState().token, 'renewed-new');
});

test('logout and ordinary-user login reset and reject superadmin navigation', () => {
  const { store } = session(() => assert.fail('unexpected fetch'));
  login(store);
  store.getState().setActiveTab('superadmin');
  store.getState().logout();
  store.getState().setAuth({ ...user, role: 'user' }, 'access', 'refresh', 'future');
  assert.equal(store.getState().activeTab, 'teams');
  store.getState().setActiveTab('superadmin');
  assert.equal(store.getState().activeTab, 'teams');
});

// Named hook state avoids brittle numeric hook indexes while exercising the actual components.
function component(file, exportName, initialState = {}, api = {}) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'useState') {
      names.push(node.name.elements[0].getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  let index = 0;
  const state = { ...initialState };
  const effects = [];
  const store = { apiUrl: 'https://example.com', token: 'access', refreshToken: 'refresh', user, selectedTeamId: 't', selectedProjectId: 'p', activeTab: 'teams',
    setSelectedTeamId(id) { store.selectedTeamId = id; store.selectedProjectId = null; },
    setSelectedProjectId(id) { store.selectedProjectId = id; },
    setApiUrl(url) { store.apiUrl = url; },
    setAuth(user, token, refreshToken, tokenExpiresAt) { store.user = user; store.token = token; store.refreshToken = refreshToken; store.tokenExpiresAt = tokenExpiresAt; },
  };
  const useHubStore = Object.assign((selector) => selector(store), { getState: () => store });
  const stub = (name) => ({ [name]: () => React.createElement('span', null, name) });
  const reactOverride = { ...React,
    useState(initial) {
      const name = names[index++];
      if (!(name in state)) state[name] = initial;
      return [state[name], (value) => { state[name] = typeof value === 'function' ? value(state[name]) : value; }];
    },
    useEffect(effect) { effects.push(effect); },
    useRef(initial) { return { current: initial }; },
  };
  reactOverride.default = reactOverride;
  const overrides = {
    react: reactOverride,
    '../store/useHubStore': { useHubStore }, './store/useHubStore': { useHubStore },
    '../lib/api': api, './lib/api': api,
    '../lib/environmentVariables': load('hub/src/lib/environmentVariables.ts'),
    '../components/ConfirmModal': { ConfirmModal: () => null },
  };
  for (const name of ['Navbar', 'Sidebar']) overrides[`./components/${name}`] = stub(name);
  for (const name of ['LoginView', 'TeamsView', 'ProjectsView', 'SuperadminView']) overrides[`./pages/${name}`] = stub(name);
  const exports = load(file, overrides);
  return { state, store, effects, render() { index = 0; effects.length = 0; return exports[exportName](); } };
}
const base = { teams: [{ id: 't', name: 'Team' }], projects: [{ id: 'p', name: 'Project' }] };
const projects = (state, api) => component('hub/src/pages/ProjectsView.tsx', 'ProjectsView', { ...base, ...state }, api);

test('App refuses a stale superadmin tab for an ordinary user', () => {
  const h = component('hub/src/App.tsx', 'App');
  h.store.activeTab = 'superadmin';
  h.store.user = { ...user, role: 'user' };
  const html = renderToStaticMarkup(h.render());
  assert.match(html, /TeamsView/);
  assert.doesNotMatch(html, /SuperadminView/);
});

test('malformed environment variables do not crash rendering or filtering', () => {
  for (const variables of [[null], 'invalid-json', 'null', '{}', {}, [{ key: {} }]]) {
    for (const searchEnvironment of ['', 'missing']) {
      const h = projects({ projectSubTab: 'environments', searchEnvironment, environments: [{ id: 'e', name: 'Env', variables }] });
      assert.doesNotThrow(() => renderToStaticMarkup(h.render()));
    }
  }
});

test('normal and legacy environment variables retain values and disabled state', () => {
  const { normalizeEnvironmentVariables } = load('hub/src/lib/environmentVariables.ts');
  const variables = [{ key: 'host', value: 'https://example.com', enabled: false }, { key: 'retries', value: 3 }];
  for (const input of [variables, JSON.stringify(variables)]) {
    const result = normalizeEnvironmentVariables(input);
    assert.equal(result[0].value, 'https://example.com');
    assert.equal(result[0].enabled, false);
    assert.equal(result[1].value, '3');
    assert.equal(result[1].enabled, true);
  }
});

test('cyclic and excessively deep collection folders render a warning without overflowing', () => {
  const selfCycle = [{ id: 'a', parent_id: 'a', type: 'folder', name: 'A' }];
  const pairCycle = [{ id: 'a', parent_id: 'b', type: 'folder', name: 'A' }, { id: 'b', parent_id: 'a', type: 'folder', name: 'B' }];
  const deep = Array.from({ length: 150 }, (_, i) => ({ id: String(i), parent_id: i ? String(i - 1) : null, type: 'folder', name: String(i) }));
  for (const items of [selfCycle, pairCycle, deep]) {
    const h = projects({ projectSubTab: 'collections', collections: [{ id: 'c', name: 'Collection', items }] });
    assert.match(renderToStaticMarkup(h.render()), /cycle or excessive depth/);
  }
});

test('valid nested collection requests still render', () => {
  const items = [{ id: 'f', type: 'folder', name: 'Folder' }, { id: 'r', parent_id: 'f', type: 'request', name: 'Nested request', method: 'GET' }];
  const h = projects({ projectSubTab: 'collections', collections: [{ id: 'c', name: 'Collection', items }] });
  assert.match(renderToStaticMarkup(h.render()), /Nested request/);
});

for (const view of ['project', 'team']) {
  test(`late ${view} members cannot overwrite the new selection`, async () => {
    const old = deferred(), current = deferred();
    const h = view === 'project'
      ? projects({}, { apiListProjectMembers: (_url, _token, id) => id === 'p' ? old.promise : current.promise })
      : component('hub/src/pages/TeamsView.tsx', 'TeamsView', { teams: base.teams }, { apiListTeamMembers: (_url, _token, id) => id === 't' ? old.promise : current.promise });
    const effect = view === 'project' ? 2 : 1;
    const stateKey = view === 'project' ? 'projectMembers' : 'members';
    h.render();
    const cleanup = h.effects[effect]();
    cleanup();
    h.store[view === 'project' ? 'selectedProjectId' : 'selectedTeamId'] = 'new';
    h.render();
    h.effects[effect]();
    current.resolve([{ user_id: 'new-member' }]);
    await tick();
    old.resolve([{ user_id: 'old-member' }]);
    await tick();
    assert.equal(h.state[stateKey][0].user_id, 'new-member');
  });
}

test('late collection details cannot overwrite newly selected project resources', async () => {
  const old = deferred();
  const h = projects({}, {
    apiListProjectCollections: async (_url, _token, id) => [{ id }],
    apiListProjectEnvironments: async (_url, _token, id) => [{ id, name: id }],
    apiGetCollection: async (_url, _token, id) => id === 'p' ? old.promise : { id, name: id },
  });
  h.render();
  const cleanup = h.effects[3]();
  await tick();
  cleanup();
  h.store.selectedProjectId = 'new';
  h.render();
  h.effects[3]();
  await tick();
  old.resolve({ id: 'p', name: 'Old' });
  await tick();
  assert.equal(h.state.collections[0].id, 'new');
  assert.equal(h.state.environments[0].id, 'new');
});

test('late team project list cannot switch the selection back to the previous team', async () => {
  const old = deferred();
  const h = projects({}, {
    apiListTeamProjects: async (_url, _token, id) => id === 't' ? old.promise : [{ id: 'new-project', name: 'New project' }],
    apiListTeamMembers: async () => [],
  });
  h.render();
  const cleanup = h.effects[1]();
  cleanup();
  h.store.setSelectedTeamId('new-team');
  h.render();
  h.effects[1]();
  await tick();
  old.resolve([{ id: 'old-project', name: 'Old project' }]);
  await tick();
  assert.equal(h.store.selectedProjectId, 'new-project');
  assert.equal(h.state.projects[0].id, 'new-project');
});

test('member assignment finishing after navigation cannot replace the new project members', async () => {
  const members = deferred();
  const h = projects({ isAssignMemberOpen: true, selectedUserIdToAssign: 'invitee' }, {
    apiAddProjectMember: async () => {},
    apiListProjectMembers: () => members.promise,
  });
  function findForm(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'form') return node;
    for (const child of React.Children.toArray(node.props?.children)) {
      const found = findForm(child);
      if (found) return found;
    }
    return null;
  }
  const form = findForm(h.render());
  assert.ok(form, 'assignment modal must contain a form');
  const submission = form.props.onSubmit({ preventDefault() {} });
  await tick();
  h.store.selectedProjectId = 'new-project';
  h.state.projectMembers = [{ user_id: 'new-member' }];
  members.resolve([{ user_id: 'old-member' }]);
  await submission;
  assert.equal(h.state.projectMembers[0].user_id, 'new-member');
});

test('failed resource load clears prior project data and reports the error', async () => {
  const h = projects({ collections: [{ id: 'old', name: 'Old' }], environments: [{ id: 'old', name: 'Old' }] }, {
    apiListProjectCollections: async () => { throw new Error('Unavailable'); },
    apiListProjectEnvironments: async () => [],
  });
  h.render();
  h.effects[3]();
  await tick();
  assert.equal(h.state.collections.length, 0);
  assert.equal(h.state.environments.length, 0);
  assert.equal(h.state.isLoadingCollections, false);
  assert.equal(h.state.errorMsg, 'Unavailable');
});

function findElements(node, predicate, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (predicate(node)) acc.push(node);
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children];
  for (const child of children) {
    findElements(child, predicate, acc);
  }
  return acc;
}

test('SuperadminView resets provision form state on close, reopen, and submit', async () => {
  let provisionCalls = 0;
  const h = component('hub/src/pages/SuperadminView.tsx', 'SuperadminView', {
    isProvisionOpen: true,
    newRole: 'superadmin',
    showNewPassword: true,
    newEmail: 'dirty@example.com',
    newPassword: 'dirtypassword123',
    newName: 'Dirty Name',
  }, {
    apiListAllUsers: async () => [],
    apiGetFeaturePolicy: async () => ({ revision: 1, flags: {} }),
    apiProvisionUser: async () => { provisionCalls++; return { id: 'new-user' }; },
  });

  const form = findElements(h.render(), (n) => n.type === 'form')[0];
  assert.ok(form, 'provision modal must contain a form');
  await form.props.onSubmit({ preventDefault() {} });

  assert.equal(provisionCalls, 1);
  assert.equal(h.state.isProvisionOpen, false);
  assert.equal(h.state.newRole, 'user');
  assert.equal(h.state.showNewPassword, false);
  assert.equal(h.state.newEmail, '');
  assert.equal(h.state.newPassword, '');
  assert.equal(h.state.newName, '');

  // Simulate dirty state again and clicking cancel
  h.state.isProvisionOpen = true;
  h.state.newRole = 'superadmin';
  h.state.showNewPassword = true;
  h.state.newEmail = 'cancel@example.com';
  const cancelButton = findElements(h.render(), (n) => n.type === 'button' && n.props?.children === 'Cancel')[0];
  assert.ok(cancelButton, 'must have cancel button');
  cancelButton.props.onClick();

  assert.equal(h.state.isProvisionOpen, false);
  assert.equal(h.state.newRole, 'user');
  assert.equal(h.state.showNewPassword, false);
  assert.equal(h.state.newEmail, '');
});

test('TeamsView resets add member form and role on open, cancel, and success', async () => {
  let addCalls = 0;
  const h = component('hub/src/pages/TeamsView.tsx', 'TeamsView', {
    teams: base.teams,
    isAddMemberOpen: true,
    newMemberRole: 'admin',
    userQuery: 'test query',
    selectedUsersToInvite: [{ id: 'u1', name: 'User 1' }],
  }, {
    apiListTeamMembers: async () => [],
    apiAddTeamMember: async () => { addCalls++; return {}; },
  });

  const form = findElements(h.render(), (n) => n.type === 'form')[0];
  await form.props.onSubmit({ preventDefault() {} });

  assert.equal(addCalls, 1);
  assert.equal(h.state.isAddMemberOpen, false);
  assert.equal(h.state.newMemberRole, 'member');
  assert.equal(h.state.userQuery, '');
  assert.equal(h.state.selectedUsersToInvite.length, 0);

  // Cancel also resets
  h.state.isAddMemberOpen = true;
  h.state.newMemberRole = 'admin';
  h.state.userQuery = 'another query';
  const cancelButton = findElements(h.render(), (n) => n.type === 'button' && n.props?.children === 'Cancel')[0];
  cancelButton.props.onClick();
  assert.equal(h.state.isAddMemberOpen, false);
  assert.equal(h.state.newMemberRole, 'member');
  assert.equal(h.state.userQuery, '');
});

test('ProjectsView resets assign member form and role on open, cancel, and success', async () => {
  let assignCalls = 0;
  const h = projects({
    isAssignMemberOpen: true,
    assignedRole: 'admin',
    memberFilterQuery: 'filter',
    selectedUserIdsToAssign: ['u1'],
  }, {
    apiListProjectMembers: async () => [],
    apiAddProjectMember: async () => { assignCalls++; return {}; },
  });

  const form = findElements(h.render(), (n) => n.type === 'form')[0];
  await form.props.onSubmit({ preventDefault() {} });

  assert.equal(assignCalls, 1);
  assert.equal(h.state.isAssignMemberOpen, false);
  assert.equal(h.state.assignedRole, 'contributor');
  assert.equal(h.state.memberFilterQuery, '');
  assert.equal(h.state.selectedUserIdsToAssign.length, 0);

  // Cancel also resets
  h.state.isAssignMemberOpen = true;
  h.state.assignedRole = 'admin';
  h.state.memberFilterQuery = 'filter 2';
  const cancelButton = findElements(h.render(), (n) => n.type === 'button' && n.props?.children === 'Cancel')[0];
  cancelButton.props.onClick();
  assert.equal(h.state.isAssignMemberOpen, false);
  assert.equal(h.state.assignedRole, 'contributor');
  assert.equal(h.state.memberFilterQuery, '');
});

test('LoginView clears password and resets showPassword on mount and submit', async () => {
  let loginCalls = 0;
  const h = component('hub/src/pages/LoginView.tsx', 'LoginView', {
    password: 'dirtypassword123',
    showPassword: true,
  }, {
    apiLogin: async () => { loginCalls++; return { user: { id: 'u' }, token: 't', refresh_token: 'r', expires_at: '2030' }; },
  });
  h.render();
  h.effects[0]();
  assert.equal(h.state.password, '');
  assert.equal(h.state.showPassword, false);

  h.state.password = 'mysecret';
  h.state.showPassword = true;
  const form = findElements(h.render(), (n) => n.type === 'form')[0];
  await form.props.onSubmit({ preventDefault() {} });
  assert.equal(loginCalls, 1);
  assert.equal(h.state.password, '');
  assert.equal(h.state.showPassword, false);
});
