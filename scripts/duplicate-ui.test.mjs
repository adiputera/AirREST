import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const RealReact = require('react');

function transpileTsx(relPath) {
  const absPath = path.join(ROOT, relPath);
  const src = fs.readFileSync(absPath, 'utf8');
  return ts.transpileModule(src, {
    fileName: absPath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
}

function loadTsModule(relPath, customModules = {}) {
  const compiled = transpileTsx(relPath);
  const mod = { exports: {} };
  const fn = new Function('require', 'module', 'exports', 'window', 'document', 'crypto', compiled);
  const stubRequire = (id) => {
    if (id in customModules) return customModules[id];
    const base = path.basename(id, path.extname(id));
    if (base in customModules) return customModules[base];
    return require(id);
  };
  return { fn, mod, stubRequire };
}

function createIconProxy() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        return function MockIcon(props) {
          return RealReact.createElement('svg', { ...props, 'data-icon': String(prop) });
        };
      },
    },
  );
}

function createModalHarness() {
  const states = [];
  const effects = [];
  const memos = [];
  const refs = [];
  const callbacks = [];
  const listeners = new Map();
  let stateIdx = 0;
  let effectIdx = 0;
  let memoIdx = 0;
  let refIdx = 0;
  let callbackIdx = 0;
  let dirty = false;

  const mockWindow = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchKey(key) {
      let prevented = false;
      for (const fn of listeners.get('keydown') || []) {
        fn({
          key,
          preventDefault() {
            prevented = true;
          },
        });
      }
      return prevented;
    },
  };

  let activeElement = null;
  const mockDocument = {
    get activeElement() {
      return activeElement;
    },
    setActiveElement(el) {
      activeElement = el;
    },
  };

  function depsChanged(prev, next) {
    if (!prev || !next) return true;
    if (prev.length !== next.length) return true;
    for (let i = 0; i < prev.length; i++) {
      if (!Object.is(prev[i], next[i])) return true;
    }
    return false;
  }

  const MockReact = {
    Fragment: RealReact.Fragment,
    createElement: RealReact.createElement,
    useState(initial) {
      const idx = stateIdx++;
      if (!(idx in states)) {
        states[idx] = typeof initial === 'function' ? initial() : initial;
      }
      const setState = (updater) => {
        const nextVal = typeof updater === 'function' ? updater(states[idx]) : updater;
        if (!Object.is(states[idx], nextVal)) {
          states[idx] = nextVal;
          dirty = true;
        }
      };
      return [states[idx], setState];
    },
    useRef(initial) {
      const idx = refIdx++;
      if (!(idx in refs)) {
        refs[idx] = { current: initial };
      }
      return refs[idx];
    },
    useMemo(factory, deps) {
      const idx = memoIdx++;
      if (!memos[idx] || depsChanged(memos[idx].deps, deps)) {
        memos[idx] = { deps, value: factory() };
      }
      return memos[idx].value;
    },
    useCallback(fn, deps) {
      const idx = callbackIdx++;
      if (!callbacks[idx] || depsChanged(callbacks[idx].deps, deps)) {
        callbacks[idx] = { deps, value: fn };
      }
      return callbacks[idx].value;
    },
    useEffect(fn, deps) {
      const idx = effectIdx++;
      const prev = effects[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        effects[idx] = { deps, fn, cleanup: prev?.cleanup, pending: true };
      }
    },
  };

  const api = {
    MockReact,
    mockWindow,
    mockDocument,
    mount(Component, initialProps) {
      let currentProps = initialProps;
      let tree = null;
      const runEffects = () => {
        for (const eff of effects) {
          if (eff?.pending) {
            eff.pending = false;
            if (typeof eff.cleanup === 'function') {
              eff.cleanup();
            }
            eff.cleanup = eff.fn();
          }
        }
      };
      const renderOnce = () => {
        stateIdx = 0;
        effectIdx = 0;
        memoIdx = 0;
        refIdx = 0;
        callbackIdx = 0;
        dirty = false;
        tree = Component(currentProps);
        runEffects();
        return tree;
      };
      const flush = async (ticks = 6) => {
        for (let i = 0; i < ticks; i++) {
          await new Promise((r) => setTimeout(r, 0));
          if (dirty) renderOnce();
        }
        return tree;
      };
      renderOnce();
      return {
        get tree() {
          return tree;
        },
        update(nextProps) {
          currentProps = { ...currentProps, ...nextProps };
          renderOnce();
        },
        rerender() {
          renderOnce();
        },
        flush,
      };
    },
  };
  return api;
}

function collectText(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (typeof node === 'object' && node.props) return collectText(node.props.children);
  return '';
}

function findElements(node, predicate, acc = []) {
  if (node == null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) findElements(item, predicate, acc);
    return acc;
  }
  if (predicate(node)) acc.push(node);
  if (node.props?.children) findElements(node.props.children, predicate, acc);
  return acc;
}

function loadDuplicateDeps(storeState, overrides = {}) {
  const jwt = (() => {
    const m = { exports: {} };
    new Function('module', 'exports', transpileTsx('packages/common/src/lib/jwt.ts'))(m, m.exports);
    return m.exports;
  })();
  const examples = (() => {
    const m = { exports: {} };
    new Function('module', 'exports', 'require', transpileTsx('packages/common/src/lib/examples.ts'))(m, m.exports, () => ({}));
    return m.exports;
  })();
  const duplicate = (() => {
    const m = { exports: {} };
    new Function('module', 'exports', 'require', transpileTsx('packages/common/src/lib/duplicate.ts'))(
      m,
      m.exports,
      (id) => (id.includes('examples') ? examples : require(id)),
    );
    return m.exports;
  })();
  const requestDiff = (() => {
    const m = { exports: {} };
    new Function('module', 'exports', 'require', transpileTsx('packages/common/src/lib/requestDiff.ts'))(
      m,
      m.exports,
      (id) => (id.includes('examples') ? examples : require(id)),
    );
    return m.exports;
  })();

  let opSeq = 1;
  const stablePolicy = overrides.productPolicy || {
    workspace: { offline: true, cloud: true },
  };
  return {
    jwt,
    duplicate,
    requestDiff,
    useApiStore: (selector) => selector(storeState),
    cloudSession: {
      isCloudSessionActive: (cfg) => Boolean(cfg?.apiUrl && cfg?.token && cfg?.user),
    },
    cloudApi: overrides.cloudApi || {
      fetchUserWorkspaces: async () => [],
      fetchUserTeams: async () => [],
      fetchTeamProjects: async () => [],
    },
    context: {
      useCloudClient: () => overrides.cloudClient ?? null,
      useProductPolicy: () => stablePolicy,
    },
    backNavigation: {
      useBackHandler: () => { },
    },
    nextUuid: () => `op-${opSeq++}`,
  };
}

function loadDuplicateCollectionModal(harness, storeState, overrides = {}) {
  const deps = loadDuplicateDeps(storeState, overrides);
  const { fn, mod, stubRequire } = loadTsModule('packages/common/src/components/DuplicateCollectionModal.tsx', {
    react: harness.MockReact,
    'lucide-react': createIconProxy(),
    useApiStore: { useApiStore: deps.useApiStore },
    cloudSession: deps.cloudSession,
    api: {},
    cloudApi: deps.cloudApi,
    jwt: deps.jwt,
    duplicate: deps.duplicate,
    context: deps.context,
    backNavigation: deps.backNavigation,
  });
  fn(stubRequire, mod, mod.exports, harness.mockWindow, harness.mockDocument, { randomUUID: deps.nextUuid });
  return mod.exports.DuplicateCollectionModal;
}

function loadDuplicateItemModal(harness, storeState, overrides = {}) {
  const deps = loadDuplicateDeps(storeState, overrides);
  const { fn, mod, stubRequire } = loadTsModule('packages/common/src/components/DuplicateItemModal.tsx', {
    react: harness.MockReact,
    'lucide-react': createIconProxy(),
    useApiStore: { useApiStore: deps.useApiStore },
    api: {},
    requestDiff: deps.requestDiff,
    duplicate: deps.duplicate,
    MethodBadge: {
      MethodBadge: ({ method }) => RealReact.createElement('span', null, method),
    },
    jwt: deps.jwt,
    context: deps.context,
    backNavigation: deps.backNavigation,
  });
  fn(stubRequire, mod, mod.exports, harness.mockWindow, harness.mockDocument, { randomUUID: deps.nextUuid });
  return mod.exports.DuplicateItemModal;
}

test('E01/E02 Sidebar source wires Duplicate Collection, Folder, and Request menus with write gating and reveal expansion', () => {
  const sidebarSrc = fs.readFileSync(
    path.join(ROOT, 'packages/common/src/components/Sidebar.tsx'),
    'utf8',
  );

  // Icons & modals imported and mounted
  assert.match(sidebarSrc, /import\s*\{\s*DuplicateCollectionModal\s*\}\s*from\s*'\.\/DuplicateCollectionModal'/);
  assert.match(sidebarSrc, /import\s*\{\s*DuplicateItemModal\s*\}\s*from\s*'\.\/DuplicateItemModal'/);
  assert.match(sidebarSrc, /import\s*\{\s*PendingDuplicateRecovery\s*\}\s*from\s*'\.\/PendingDuplicateRecovery'/);
  assert.match(sidebarSrc, /<PendingDuplicateRecovery\s*\/>/);
  assert.match(sidebarSrc, /<DuplicateCollectionModal[\s\S]*?returnFocusTo=\{collectionToDuplicate\?\.trigger\}/);
  assert.match(sidebarSrc, /<DuplicateItemModal[\s\S]*?returnFocusTo=\{itemToDuplicate\?\.trigger\}/);

  // All 3 levels expose Duplicate action and pass trigger ref for focus restoration
  assert.match(sidebarSrc, /<span>Duplicate Collection<\/span>/);
  assert.match(sidebarSrc, /<span>Duplicate Folder<\/span>/);
  assert.match(sidebarSrc, /<span>Duplicate Request<\/span>/);
  assert.match(sidebarSrc, /onRequestDuplicateItem\?\.\(item,\s*collectionId,\s*buttonRef\.current\)/);

  // Duplicate Collection is inside canEditCol block (hidden for reader), NOT gated by isMoveEnabled/canMoveScope
  const colMenuMatch = sidebarSrc.match(
    /\{canEditCol && \(\s*<>([\s\S]*?)\{canMoveScope &&/,
  );
  assert.ok(colMenuMatch, 'Duplicate Collection must sit inside canEditCol block before canMoveScope');
  assert.match(colMenuMatch[1], /<span>Duplicate Collection<\/span>/);
  assert.doesNotMatch(colMenuMatch[1], /isMoveEnabled/);

  // Folder & Request duplicate menus sit inside canEdit gates
  const folderMenuMatch = sidebarSrc.match(/\{canEdit && \(\s*<>([\s\S]*?)<span>Duplicate Folder<\/span>/);
  assert.ok(folderMenuMatch, 'Duplicate Folder must be gated by canEdit');
  const reqMenuMatch = sidebarSrc.match(/\{canEdit && \(\s*<div[\s\S]*?<span>Duplicate Request<\/span>/);
  assert.ok(reqMenuMatch, 'Duplicate Request must be gated by canEdit');

  // Keyboard focus & mobile touch visibility on 3-dots trigger wrappers
  const triggerMatches = sidebarSrc.match(/hidden max-md:flex group-hover:flex group-focus-within:flex/g) || [];
  assert.ok(
    triggerMatches.length >= 3,
    `Expected mobile + keyboard focus-within visibility on collection, folder, and request triggers (found ${triggerMatches.length})`,
  );

  // lastDuplicateReveal expands revealed collection and folders
  assert.match(sidebarSrc, /const lastDuplicateReveal = useApiStore\(\(state\) => state\.lastDuplicateReveal\);/);
  assert.match(sidebarSrc, /if \(!lastDuplicateReveal \|\| lastDuplicateReveal\.pathIds\.length === 0\) return;/);
  assert.match(sidebarSrc, /setCollapsedCollections\(\(prev\) => \(\{ \.\.\.prev, \[collectionId\]: false \}\)\)/);
  assert.match(sidebarSrc, /setOpenFolders\(\(prev\) => \(\{/);
});

test('E01 DuplicateCollectionModal: enforces scope matrix, shows clamp & offline attachment warnings, supports partial failure retry, Escape & focus return, and double-submit lock', async () => {
  const harness = createModalHarness();
  let focusRestored = false;
  const triggerEl = { focus() { focusRestored = true; } };
  let closeCount = 0;

  let duplicateCalls = [];
  let resolveDuplicate;
  const storeState = {
    workspaceMode: 'offline',
    offlineWorkspaces: [
      { id: 'off-1', name: 'Local Default' },
      { id: 'off-2', name: 'Secondary Local' },
    ],
    activeOfflineWorkspaceId: 'off-1',
    cloudConfig: {
      apiUrl: 'https://cloud.example.com',
      token: 'tok-123',
      refreshToken: 'ref-123',
      user: { id: 'u-1', role: 'user' },
      activeScope: null,
    },
    duplicateCollection: (collectionId, targetScope, opts) => {
      duplicateCalls.push({ collectionId, targetScope, opts });
      return new Promise((resolve) => {
        resolveDuplicate = resolve;
      });
    },
  };

  let failTeamsOnce = false;
  const cloudClient = {
    fetchUserWorkspaces: async () => [{ id: 'ws-p1', name: 'Personal Cloud' }],
    fetchUserTeams: async () => {
      if (failTeamsOnce) {
        failTeamsOnce = false;
        throw new Error('Teams offline');
      }
      return [{ id: 'team-1', name: 'Core Team', role: 'member' }];
    },
    fetchTeamProjects: async () => [
      { id: 'proj-write', name: 'Writable Project', user_role: 'contributor' },
      { id: 'proj-read', name: 'ReadOnly Project', user_role: 'reader' },
    ],
  };

  const Modal = loadDuplicateCollectionModal(harness, storeState, { cloudClient });
  const sourceCollection = {
    id: 'col-1',
    name: 'Auth API',
    minRole: 'admin',
    items: [
      {
        id: 'req-1',
        type: 'request',
        name: 'Upload FormData',
        request: {
          id: 'req-1',
          method: 'POST',
          url: 'https://httpbin.org/post',
          headers: [],
          params: [],
          bodyType: 'form-data',
          bodyFormData: [{ key: 'doc', type: 'file', fileName: 'a.txt', value: 'local' }],
        },
      },
      {
        id: 'req-2',
        type: 'request',
        name: 'Upload Binary',
        request: {
          id: 'req-2',
          method: 'PUT',
          url: 'https://httpbin.org/put',
          headers: [],
          params: [],
          bodyType: 'binary',
          bodyBinaryFile: { name: 'bin.dat', size: 12, type: 'application/octet-stream' },
        },
      },
    ],
  };

  const inst = harness.mount(Modal, {
    isOpen: true,
    onClose: () => { closeCount++; },
    collection: sourceCollection,
    returnFocusTo: triggerEl,
  });

  await inst.flush();

  // Verify accessible dialog role & attributes
  const dialogs = findElements(inst.tree, (n) => n.props?.role === 'dialog');
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].props['aria-modal'], 'true');
  assert.equal(dialogs[0].props['aria-labelledby'], 'duplicate-collection-title');
  assert.equal(dialogs[0].props.tabIndex, -1);

  // Verify target list includes Local Default (current), Secondary Local, Personal Cloud, Writable Project, but excludes ReadOnly Project
  const optionButtons = findElements(
    inst.tree,
    (n) => n.type === 'button' && collectText(n).match(/Local Default|Secondary Local|Personal Cloud|Core Team|ReadOnly Project/),
  );
  const labels = optionButtons.map((b) => collectText(b));
  assert.equal(labels.some((t) => t.includes('Local Default')), true);
  assert.equal(labels.some((t) => t.includes('Secondary Local')), true);
  assert.equal(labels.some((t) => t.includes('Personal Cloud')), true);
  assert.equal(labels.some((t) => t.includes('Core Team / Writable Project')), true);
  assert.equal(labels.some((t) => t.includes('ReadOnly Project')), false);

  // Same offline workspace preview adds ' copy'
  assert.equal(collectText(inst.tree).includes('Auth API copy'), true);

  // Select Writable Project (cross-scope -> unchanged name + minRole clamp notice + offline->cloud attachment warning)
  const projBtn = optionButtons.find((b) => collectText(b).includes('Core Team / Writable Project'));
  projBtn.props.onClick();
  await inst.flush();

  const textOnProject = collectText(inst.tree);
  assert.equal(textOnProject.includes('Result Name PreviewAuth API'), true);
  assert.equal(textOnProject.includes('form-data file attachment(s) will keep metadata only'), true);
  assert.equal(textOnProject.includes('local binary file attachment(s) are local-only'), true);

  // Double-submit click triggers only 1 call while in-flight, and Escape is blocked while submitting
  const submitBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Duplicate Collection')).pop();
  submitBtn.props.onClick();
  await inst.flush(1);
  assert.equal(duplicateCalls.length, 1);
  assert.equal(harness.mockWindow.dispatchKey('Escape'), false);
  assert.equal(closeCount, 0);

  // Re-click disabled submit button while submitting -> no duplicate call
  const busySubmitBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Duplicating...'))[0];
  assert.equal(busySubmitBtn.props.disabled, true);
  busySubmitBtn.props.onClick?.();
  assert.equal(duplicateCalls.length, 1);

  // Return reconcilePending failure -> keeps same operationId for Retry Duplicate
  resolveDuplicate({ success: false, reconcilePending: true, error: 'Network dropped during duplicate' });
  await inst.flush();
  assert.equal(collectText(inst.tree).includes('Network dropped during duplicate'), true);
  const retryBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Retry Duplicate'))[0];
  assert.ok(retryBtn);
  const firstOpId = duplicateCalls[0].opts.operationId;
  retryBtn.props.onClick();
  await inst.flush(1);
  assert.equal(duplicateCalls.length, 2);
  assert.equal(duplicateCalls[1].opts.operationId, firstOpId);

  // Complete cleanly -> calls onClose, and closing restores focus to trigger element
  resolveDuplicate({ success: true });
  await inst.flush();
  assert.equal(closeCount, 1);

  inst.update({ isOpen: false });
  await inst.flush();
  assert.equal(focusRestored, true);
});

test('E01 DuplicateCollectionModal: blocks project -> personal and handles partial discovery failure retry', async () => {
  const harness = createModalHarness();
  const storeState = {
    workspaceMode: 'cloud',
    offlineWorkspaces: [{ id: 'off-1', name: 'Local Default' }],
    activeOfflineWorkspaceId: 'off-1',
    cloudConfig: {
      apiUrl: 'https://cloud.example.com',
      token: 'tok-123',
      refreshToken: 'ref-123',
      user: { id: 'u-1', role: 'user' },
      activeScope: { id: 'proj-src', name: 'Source Project', type: 'project', role: 'maintainer' },
    },
    duplicateCollection: async () => ({ success: true }),
  };

  let failTeams = true;
  const cloudClient = {
    fetchUserWorkspaces: async () => [{ id: 'ws-p1', name: 'Personal Cloud' }],
    fetchUserTeams: async () => {
      if (failTeams) {
        failTeams = false;
        throw new Error('Team API timeout');
      }
      return [{ id: 'team-2', name: 'Beta Team', role: 'member' }];
    },
    fetchTeamProjects: async () => [
      { id: 'proj-src', name: 'Source Project', user_role: 'admin' },
      { id: 'proj-dest', name: 'Dest Project', user_role: 'contributor' },
    ],
  };

  const Modal = loadDuplicateCollectionModal(harness, storeState, { cloudClient });
  const inst = harness.mount(Modal, {
    isOpen: true,
    onClose: () => { },
    collection: { id: 'col-p', name: 'Cloud Col', minRole: 'admin', items: [] },
  });
  await inst.flush();

  // Partial failure shows warning + Retry button, and Personal Cloud + Local Default are NOT offered from project source
  const partialText = collectText(inst.tree);
  assert.equal(partialText.includes('Some cloud destinations failed to load'), true);
  assert.equal(partialText.includes('Personal Cloud'), false);
  assert.equal(partialText.includes('Local Default'), false);

  const retryLoadBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n) === 'Retry')[0];
  assert.ok(retryLoadBtn);
  retryLoadBtn.props.onClick();
  await inst.flush();

  const reloadedText = collectText(inst.tree);
  assert.equal(reloadedText.includes('Beta Team / Dest Project'), true);
  assert.equal(reloadedText.includes('Personal Cloud'), false);

  // Select Beta Team / Dest Project (user role contributor < source minRole admin) -> minRole clamp warning shown
  const destBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Beta Team / Dest Project'))[0];
  assert.ok(destBtn);
  destBtn.props.onClick();
  await inst.flush();
  assert.equal(collectText(inst.tree).includes('lowered from admin to contributor'), true);
});

test('E02 DuplicateItemModal: folder picker, lazy partial load & retry, same/cross collection name, rune/depth validation, Escape & double-submit', async () => {
  const harness = createModalHarness();
  let focusRestored = false;
  const triggerEl = { focus() { focusRestored = true; } };
  let closeCount = 0;

  let loadCalls = 0;
  let shouldFailLoad = true;
  const duplicateItemCalls = [];
  let resolveDupItem;

  const storeState = {
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'https://cloud.example.com',
      token: 'tok',
      user: { id: 'u1', role: 'user' },
      activeScope: { id: 'ws1', name: 'Personal', type: 'workspace' },
    },
    collections: [
      {
        id: 'col-src',
        name: 'Source Col',
        minRole: 'reader',
        items: [
          {
            id: 'f-1',
            type: 'folder',
            name: 'Users',
            items: [
              {
                id: 'req-src',
                type: 'request',
                name: 'Get Profile',
                request: { id: 'req-src', method: 'GET', url: 'https://httpbin.org/get', headers: [], params: [] },
              },
            ],
          },
        ],
      },
      {
        id: 'col-partial',
        name: 'Lazy Col',
        minRole: 'reader',
        isPartial: true,
        items: [],
      },
      {
        id: 'col-readonly',
        name: 'Locked Col',
        minRole: 'admin',
        items: [],
      },
    ],
    loadCollectionDetails: async (colId) => {
      loadCalls++;
      if (shouldFailLoad) {
        shouldFailLoad = false;
        return { success: false, error: 'Failed to load folders' };
      }
      storeState.collections = storeState.collections.map((c) =>
        c.id === colId
          ? {
            ...c,
            isPartial: false,
            items: [{ id: 'f-dest', type: 'folder', name: 'Dest Folder', items: [] }],
          }
          : c,
      );
      return { success: true };
    },
    duplicateCollectionItem: (srcColId, itemId, targetCollectionId, targetParentId, opts) => {
      duplicateItemCalls.push({ srcColId, itemId, targetCollectionId, targetParentId, opts });
      return new Promise((resolve) => {
        resolveDupItem = resolve;
      });
    },
  };

  // Switch activeScope to contributor on project so Locked Col (minRole admin) is read-only
  storeState.cloudConfig.activeScope = { id: 'proj-1', name: 'Proj', type: 'project', role: 'contributor' };

  const Modal = loadDuplicateItemModal(harness, storeState);
  const folderItem = storeState.collections[0].items[0];
  const inst = harness.mount(Modal, {
    isOpen: true,
    onClose: () => { closeCount++; },
    item: folderItem,
    sourceCollectionId: 'col-src',
    returnFocusTo: triggerEl,
  });
  await inst.flush();

  // Same collection appends ' copy' and renders Locked Col disabled
  assert.equal(collectText(inst.tree).includes('Result Name: Users copy'), true);
  const colOptions = findElements(inst.tree, (n) => n.type === 'option');
  const lockedOpt = colOptions.find((o) => collectText(o).includes('Locked Col'));
  assert.equal(lockedOpt.props.disabled, true);

  // Switch to partial target collection -> triggers lazy load and shows failure + Retry
  const colSelect = findElements(inst.tree, (n) => n.props?.id === 'duplicate-target-collection')[0];
  colSelect.props.onChange({ target: { value: 'col-partial' } });
  await inst.flush();
  assert.equal(loadCalls, 1);
  assert.equal(collectText(inst.tree).includes('Failed to load folders'), true);

  // Retry succeeds and populates Dest Folder, cross-collection keeps original name 'Users'
  const retryBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n) === 'Retry')[0];
  retryBtn.props.onClick();
  await inst.flush();
  assert.equal(loadCalls, 2);
  assert.equal(collectText(inst.tree).includes('Result Name: Users'), true);
  assert.equal(collectText(inst.tree).includes('Dest Folder'), true);

  const folderSelect = findElements(inst.tree, (n) => n.props?.id === 'duplicate-target-folder')[0];
  folderSelect.props.onChange({ target: { value: 'f-dest' } });
  await inst.flush();

  // Submit -> double click blocked, Escape blocked while submitting
  const submitBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Duplicate Folder')).pop();
  submitBtn.props.onClick();
  await inst.flush(1);
  assert.equal(duplicateItemCalls.length, 1);
  assert.equal(duplicateItemCalls[0].targetCollectionId, 'col-partial');
  assert.equal(duplicateItemCalls[0].targetParentId, 'f-dest');
  assert.equal(harness.mockWindow.dispatchKey('Escape'), false);

  resolveDupItem({ success: true });
  await inst.flush();
  assert.equal(closeCount, 1);

  inst.update({ isOpen: false });
  await inst.flush();
  assert.equal(focusRestored, true);

  // Test rune limit (>150 Unicode runes) disables Duplicate Folder submit button with validation error
  const longName = 'a'.repeat(146);
  const longModalInst = harness.mount(loadDuplicateItemModal(harness, storeState), {
    isOpen: true,
    onClose: () => { },
    item: { id: 'f-long', type: 'folder', name: longName, items: [] },
    sourceCollectionId: 'col-src',
  });
  await longModalInst.flush();
  assert.match(collectText(longModalInst.tree), /exceeds the maximum length of 150 characters/);
  const disabledSubmit = findElements(longModalInst.tree, (n) => n.type === 'button' && collectText(n).includes('Duplicate Folder')).pop();
  assert.equal(disabledSubmit.props.disabled, true);

  // Test depth limit (>32 nesting levels) disables submit button
  let deepFolder = { id: 'f-leaf', type: 'folder', name: 'Leaf', items: [] };
  for (let d = 31; d >= 1; d--) {
    deepFolder = { id: `f-n-${d}`, type: 'folder', name: `N${d}`, items: [deepFolder] };
  }
  const depthStore = {
    ...storeState,
    collections: [
      { id: 'col-depth', name: 'Depth Col', minRole: 'reader', items: [deepFolder] },
    ],
  };
  const depthInst = harness.mount(loadDuplicateItemModal(harness, depthStore), {
    isOpen: true,
    onClose: () => { },
    item: { id: 'req-deep', type: 'request', name: 'Too Deep Req', request: { id: 'req-deep', method: 'GET', url: 'https://httpbin.org/get', headers: [], params: [] } },
    sourceCollectionId: 'col-depth',
  });
  await depthInst.flush();
  const depthFolderSel = findElements(depthInst.tree, (n) => n.props?.id === 'duplicate-target-folder')[0];
  depthFolderSel.props.onChange({ target: { value: 'f-leaf' } });
  await depthInst.flush();
  assert.match(collectText(depthInst.tree), /maximum depth of 32 levels/);
  const disabledDepthBtn = findElements(depthInst.tree, (n) => n.type === 'button' && collectText(n).includes('Duplicate Request')).pop();
  assert.equal(disabledDepthBtn.props.disabled, true);
});

test('E02 DuplicateItemModal: inline New Collection creation, validation, error preservation, and single-collection retry', async () => {
  const harness = createModalHarness();
  let createCalls = 0;
  let dupCalls = [];
  let failCreateOnce = true;
  let failDupOnce = true;
  let closeCount = 0;

  const storeState = {
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'https://cloud.example.com',
      token: 'tok',
      user: { id: 'u1', role: 'user' },
      activeScope: { id: 'proj-1', name: 'Proj', type: 'project', role: 'contributor' },
    },
    collections: [
      {
        id: 'col-src',
        name: 'Source Col',
        minRole: 'reader',
        items: [
          {
            id: 'req-src',
            type: 'request',
            name: 'Get Orders',
            request: { id: 'req-src', method: 'GET', url: 'https://httpbin.org/get', headers: [], params: [] },
          },
        ],
      },
    ],
    loadCollectionDetails: async () => ({ success: true }),
    createCollectionAsync: async (name) => {
      createCalls++;
      if (failCreateOnce) {
        failCreateOnce = false;
        return { success: false, error: 'Create collection failed' };
      }
      const newCol = { id: 'col-new-1', name, minRole: 'reader', isPartial: false, items: [] };
      storeState.collections = [newCol, ...storeState.collections];
      return { success: true, collectionId: newCol.id };
    },
    duplicateCollectionItem: async (srcColId, itemId, targetCollectionId, targetParentId, opts) => {
      dupCalls.push({ srcColId, itemId, targetCollectionId, targetParentId, opts });
      if (failDupOnce) {
        failDupOnce = false;
        return { success: false, reconcilePending: true, error: 'Temporary duplicate timeout' };
      }
      return { success: true };
    },
  };

  const Modal = loadDuplicateItemModal(harness, storeState);
  const inst = harness.mount(Modal, {
    isOpen: true,
    onClose: () => { closeCount++; },
    item: storeState.collections[0].items[0],
    sourceCollectionId: 'col-src',
  });
  await inst.flush();

  // Switch to inline New Collection mode
  const toggleBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('New Collection'))[0];
  assert.ok(toggleBtn);
  toggleBtn.props.onClick();
  await inst.flush();

  // New collection is cross-collection -> Result Name keeps 'Get Orders' without ' copy', folder locked to root
  const newColText = collectText(inst.tree);
  assert.equal(newColText.includes('Result Name: Get Orders'), true);
  assert.equal(newColText.includes('Get Orders copy'), false);
  assert.equal(newColText.includes('(Root of New Collection)'), true);

  // Empty new collection name keeps confirm button disabled
  const initialConfirmBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Duplicate Request')).pop();
  assert.equal(initialConfirmBtn.props.disabled, true);

  // Invalid >150 rune name shows live error and stays disabled
  const nameInput = findElements(inst.tree, (n) => n.type === 'input' && n.props?.id === 'duplicate-new-collection-name')[0];
  nameInput.props.onChange({ target: { value: 'x'.repeat(151) } });
  await inst.flush();
  assert.match(collectText(inst.tree), /Collection name exceeds the maximum length of 150/);
  const badLenConfirm = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Duplicate Request')).pop();
  assert.equal(badLenConfirm.props.disabled, true);

  // Enter valid name -> first createCollectionAsync fails and preserves input/error without calling duplicateCollectionItem
  const nameInput2 = findElements(inst.tree, (n) => n.type === 'input' && n.props?.id === 'duplicate-new-collection-name')[0];
  nameInput2.props.onChange({ target: { value: 'Orders API' } });
  await inst.flush();
  const validConfirm = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Duplicate Request')).pop();
  assert.equal(validConfirm.props.disabled, false);
  await validConfirm.props.onClick();
  await inst.flush();
  assert.equal(createCalls, 1);
  assert.equal(dupCalls.length, 0);
  assert.equal(collectText(inst.tree).includes('Create collection failed'), true);

  // Click again -> creates collection once, switches to Retry Duplicate on temporary duplicate timeout, and Retry reuses col-new-1 without creating another collection
  const confirmAgain = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Duplicate Request')).pop();
  await confirmAgain.props.onClick();
  await inst.flush();
  assert.equal(createCalls, 2);
  assert.equal(dupCalls.length, 1);
  assert.equal(dupCalls[0].targetCollectionId, 'col-new-1');
  assert.equal(dupCalls[0].targetParentId, null);
  assert.equal(collectText(inst.tree).includes('Temporary duplicate timeout'), true);

  const retryDupBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Retry Duplicate'))[0];
  assert.ok(retryDupBtn);
  await retryDupBtn.props.onClick();
  await inst.flush();
  assert.equal(createCalls, 2); // still 2! never created a third collection
  assert.equal(dupCalls.length, 2);
  assert.equal(dupCalls[1].targetCollectionId, 'col-new-1');
  assert.equal(dupCalls[1].opts.operationId, dupCalls[0].opts.operationId);
  assert.equal(closeCount, 1);
});

function loadPendingDuplicateRecovery(harness, storeState, overrides = {}) {
  const deps = loadDuplicateDeps(storeState, overrides);
  const { fn, mod, stubRequire } = loadTsModule('packages/common/src/components/PendingDuplicateRecovery.tsx', {
    react: harness.MockReact,
    'lucide-react': createIconProxy(),
    useApiStore: { useApiStore: deps.useApiStore },
    context: deps.context,
    duplicate: deps.duplicate,
  });
  fn(stubRequire, mod, mod.exports, harness.mockWindow, harness.mockDocument, { randomUUID: deps.nextUuid });
  return mod.exports.PendingDuplicateRecovery;
}

test('V7 & V8/V10 (UI): reopening DuplicateCollectionModal/DuplicateItemModal preserves durable recovery with original ID, isolates from new duplicate options, and PendingDuplicateRecovery gates by owner & distinguishes statuses', async () => {
  // 1. Collection modal: uncertain -> Escape close -> reopen -> Resume uses original opId and keeps single copy on server
  {
    const harness = createModalHarness();
    const operations = [];
    const serverCopies = new Set();
    let closes = 0;
    const aliceCfg = {
      apiUrl: 'https://api.example.com',
      token: 'tok-alice',
      user: { id: 'alice', role: 'user' },
      activeScope: { id: 'ws-a', type: 'workspace', name: 'Workspace A' },
    };
    const state = {
      workspaceMode: 'cloud',
      cloudConfig: aliceCfg,
      offlineWorkspaces: [],
      pendingDuplicateIntents: {},
      duplicateCollection: async (sourceCollectionId, targetScope, opts) => {
        operations.push({ sourceCollectionId, targetScope, opId: opts.operationId });
        serverCopies.add(opts.operationId);
        state.pendingDuplicateIntents = {
          ...state.pendingDuplicateIntents,
          [opts.operationId]: {
            operationId: opts.operationId,
            ownerKey: '["https://api.example.com","alice"]',
            kind: 'collection',
            sourceCollectionId,
            sourceName: 'Source',
            targetScope,
            createdAt: 100,
            status: 'reconcile_required',
            lastError: 'reply lost after commit',
          },
        };
        return { success: false, operationId: opts.operationId, reconcilePending: true, error: 'reply lost after commit' };
      },
      retryPendingDuplicateIntent: async (opId) => {
        const intent = state.pendingDuplicateIntents[opId];
        operations.push({ sourceCollectionId: intent.sourceCollectionId, targetScope: intent.targetScope, opId });
        serverCopies.add(opId);
        const next = { ...state.pendingDuplicateIntents };
        delete next[opId];
        state.pendingDuplicateIntents = next;
        return { success: true, operationId: opId, name: 'Source copy' };
      },
      clearPendingDuplicateIntent: (opId) => {
        const next = { ...state.pendingDuplicateIntents };
        delete next[opId];
        state.pendingDuplicateIntents = next;
      },
    };
    const Modal = loadDuplicateCollectionModal(harness, state, {
      cloudClient: {
        fetchUserWorkspaces: async () => [{ id: 'ws-a', name: 'Workspace A' }, { id: 'ws-b', name: 'Workspace B' }],
        fetchUserTeams: async () => [],
        fetchTeamProjects: async () => [],
      },
    });
    const col = { id: 'c1', name: 'Source', minRole: 'reader', items: [] };
    const inst = harness.mount(Modal, { isOpen: true, collection: col, onClose: () => closes++ });
    await inst.flush();

    const submitBtn = () => findElements(inst.tree, (n) => n.type === 'button' && collectText(n) === 'Duplicate Collection').at(-1);
    await submitBtn().props.onClick();
    await inst.flush();
    assert.equal(operations.length, 1);

    harness.mockWindow.dispatchKey('Escape');
    assert.equal(closes, 1);
    inst.update({ isOpen: false });
    await inst.flush();

    // Reopen modal -> Pending Duplicate Recovery card is visible; changing destination dropdown below does NOT erase or alter pending intent
    inst.update({ isOpen: true });
    await inst.flush();
    const wsBBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Workspace B'))[0];
    wsBBtn.props.onClick();
    await inst.flush();

    const resumeBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Resume Pending Duplicate'))[0];
    assert.ok(resumeBtn, 'Reopened modal must offer Resume Pending Duplicate');
    await resumeBtn.props.onClick();
    await inst.flush();

    assert.equal(operations.length, 2);
    assert.equal(operations[1].opId, operations[0].opId);
    assert.equal(operations[1].targetScope.id, 'ws-a');
    assert.equal(serverCopies.size, 1);
    assert.equal(closes, 2);
  }

  // 2. Item modal: uncertain -> close -> reopen -> Resume reuses original opId and keeps deleted/detailsUnavailable notices visible
  {
    const harness = createModalHarness();
    const itemOps = [];
    let closes = 0;
    const state = {
      workspaceMode: 'cloud',
      cloudConfig: {
        apiUrl: 'https://api.example.com',
        token: 'tok-alice',
        user: { id: 'alice', role: 'user' },
        activeScope: { id: 'ws-a', type: 'workspace', name: 'Workspace A' },
      },
      collections: [
        {
          id: 'c1',
          name: 'Col 1',
          minRole: 'reader',
          items: [{ id: 'r1', name: 'Get Users', type: 'request', request: { id: 'r1', method: 'GET', url: 'https://httpbin.org/get', headers: [], params: [] } }],
        },
        { id: 'c2', name: 'Col 2', minRole: 'reader', items: [] },
      ],
      pendingDuplicateIntents: {},
      loadCollectionDetails: async () => ({ success: true }),
      duplicateCollectionItem: async (srcColId, itemId, targetColId, targetParentId, opts) => {
        itemOps.push({ targetColId, opId: opts.operationId });
        state.pendingDuplicateIntents = {
          ...state.pendingDuplicateIntents,
          [opts.operationId]: {
            operationId: opts.operationId,
            ownerKey: '["https://api.example.com","alice"]',
            kind: 'item',
            sourceCollectionId: srcColId,
            sourceItemId: itemId,
            sourceName: 'Get Users',
            sourceItemType: 'request',
            targetCollectionId: targetColId,
            targetCollectionName: 'Col 1',
            targetParentId,
            createdAt: 100,
            status: 'reconcile_required',
          },
        };
        return { success: false, operationId: opts.operationId, reconcilePending: true, error: 'timeout' };
      },
      retryPendingDuplicateIntent: async (opId) => {
        const intent = state.pendingDuplicateIntents[opId];
        itemOps.push({ targetColId: intent.targetCollectionId, opId });
        const next = { ...state.pendingDuplicateIntents };
        delete next[opId];
        state.pendingDuplicateIntents = next;
        return { success: true, operationId: opId, name: 'Get Users copy', detailsUnavailable: true, detailsError: 'HTTP 413' };
      },
    };
    const ItemModal = loadDuplicateItemModal(harness, state);
    const inst = harness.mount(ItemModal, {
      isOpen: true,
      onClose: () => { closes++; },
      item: state.collections[0].items[0],
      sourceCollectionId: 'c1',
    });
    await inst.flush();
    const submitBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n) === 'Duplicate Request').at(-1);
    await submitBtn.props.onClick();
    await inst.flush();
    harness.mockWindow.dispatchKey('Escape');
    inst.update({ isOpen: false });
    await inst.flush();

    inst.update({ isOpen: true });
    await inst.flush();
    const resumeBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Resume Pending Duplicate'))[0];
    assert.ok(resumeBtn);
    await resumeBtn.props.onClick();
    await inst.flush();
    assert.equal(itemOps[1].opId, itemOps[0].opId);
    assert.match(collectText(inst.tree), /details are unavailable/i);
    assert.equal(closes, 1);
  }

  // 3. PendingDuplicateRecovery: works when source is gone, hides on account switch / offline-only, supports provider session, and distinguishes committed/partial/deleted/uncertain/rejected
  {
    const harness = createModalHarness();
    let mode = 'committed_partial';
    const state = {
      cloudConfig: {
        apiUrl: 'https://api.example.com',
        sessionKind: 'provider',
        user: { id: 'alice', role: 'user' },
      },
      collections: [], // source already deleted locally!
      pendingDuplicateIntents: {
        'op-alice': {
          operationId: 'op-alice',
          ownerKey: '["https://api.example.com","alice"]',
          kind: 'collection',
          sourceCollectionId: 'deleted-src',
          sourceName: 'Lost Collection',
          targetScope: { id: 'proj-1', name: 'Core Project', type: 'project' },
          createdAt: 200,
          status: 'reconcile_required',
          lastError: 'connection dropped',
        },
        'op-bob': {
          operationId: 'op-bob',
          ownerKey: '["https://api.example.com","bob"]',
          kind: 'collection',
          sourceCollectionId: 'bob-src',
          sourceName: 'Secret Bob Collection',
          targetScope: { id: 'ws-b', name: 'Bob WS', type: 'workspace' },
          createdAt: 300,
          status: 'reconcile_required',
        },
      },
      retryPendingDuplicateIntent: async (opId) => {
        if (mode === 'committed_partial') {
          const next = { ...state.pendingDuplicateIntents };
          delete next[opId];
          state.pendingDuplicateIntents = next;
          return { success: true, operationId: opId, name: 'Lost Collection', detailsUnavailable: true, detailsError: 'HTTP 403' };
        }
        return { success: true, operationId: opId, name: 'Lost Collection', deletedOnServer: true };
      },
      clearPendingDuplicateIntent: (opId) => {
        const next = { ...state.pendingDuplicateIntents };
        delete next[opId];
        state.pendingDuplicateIntents = next;
      },
    };
    const Banner = loadPendingDuplicateRecovery(harness, state);
    const inst = harness.mount(Banner, {});
    await inst.flush();

    const text = collectText(inst.tree);
    assert.equal(text.includes('Lost Collection'), true);
    assert.equal(text.includes('Secret Bob Collection'), false, 'Must never expose another account intent');

    // Switch to Bob -> Alice intent vanishes and Bob intent appears
    state.cloudConfig = { apiUrl: 'https://api.example.com', sessionKind: 'provider', user: { id: 'bob', role: 'user' } };
    inst.rerender();
    await inst.flush();
    const bobText = collectText(inst.tree);
    assert.equal(bobText.includes('Secret Bob Collection'), true);
    assert.equal(bobText.includes('Lost Collection'), false);

    // Switch back to Alice and Resume -> shows Committed (Details Unavailable) status
    state.cloudConfig = { apiUrl: 'https://api.example.com', sessionKind: 'provider', user: { id: 'alice', role: 'user' } };
    inst.rerender();
    await inst.flush();
    const resumeBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Resume'))[0];
    await resumeBtn.props.onClick();
    await inst.flush();
    assert.match(collectText(inst.tree), /Committed \(Details Unavailable\): Lost Collection/);

    // Deleted on server outcome
    mode = 'deleted';
    state.pendingDuplicateIntents = {
      'op-alice-2': {
        operationId: 'op-alice-2',
        ownerKey: '["https://api.example.com","alice"]',
        kind: 'item',
        sourceCollectionId: 'c1',
        sourceItemId: 'r1',
        sourceName: 'Deleted Copy Item',
        sourceItemType: 'request',
        targetCollectionId: 'c2',
        targetCollectionName: 'Target Col',
        createdAt: 400,
        status: 'reconcile_required',
      },
    };
    inst.rerender();
    await inst.flush();
    const resumeBtn2 = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Resume'))[0];
    await resumeBtn2.props.onClick();
    await inst.flush();
    assert.match(collectText(inst.tree), /Deleted \/ Expired: Lost Collection|Deleted \/ Expired: Deleted Copy Item/);
  }
});

test('Follow-up P2 (UI): delayed Resume callback after A->B and A->B->A cannot leak outcome or unlock B, and active pending POST locks Dismiss & Resume while post-restart pending remains recoverable', async () => {
  // 1. Delayed Resume across A -> B (with B active Resume) and A -> B -> A
  {
    const harness = createModalHarness();
    const cfg = (id) => ({ apiUrl: 'https://api.example.com', sessionKind: 'provider', user: { id, role: 'user' } });
    const resolvers = {};
    const state = {
      cloudConfig: cfg('alice'),
      activeDuplicateOperationIds: {},
      pendingDuplicateIntents: {
        'op-alice': {
          operationId: 'op-alice',
          ownerKey: '["https://api.example.com","alice"]',
          kind: 'collection',
          sourceCollectionId: 'c-a',
          sourceName: 'Alice Private Collection',
          targetScope: { id: 'ws-a', name: 'Alice WS', type: 'workspace' },
          createdAt: 100,
          status: 'reconcile_required',
        },
        'op-bob': {
          operationId: 'op-bob',
          ownerKey: '["https://api.example.com","bob"]',
          kind: 'collection',
          sourceCollectionId: 'c-b',
          sourceName: 'Bob Collection',
          targetScope: { id: 'ws-b', name: 'Bob WS', type: 'workspace' },
          createdAt: 200,
          status: 'reconcile_required',
        },
      },
      retryPendingDuplicateIntent: (opId) => new Promise((resolve) => {
        resolvers[opId] = resolve;
      }),
      clearPendingDuplicateIntent: () => { },
    };

    const Banner = loadPendingDuplicateRecovery(harness, state);
    const inst = harness.mount(Banner, {});
    await inst.flush();

    // Alice starts Resume
    const aliceResume = findElements(inst.tree, (n) => n.type === 'button' && collectText(n) === 'Resume')[0];
    aliceResume.props.onClick();
    await inst.flush(1);

    // Switch to Bob (A -> B) and start Bob's Resume
    state.cloudConfig = cfg('bob');
    inst.rerender();
    await inst.flush();
    assert.equal(collectText(inst.tree).includes('Alice Private Collection'), false);

    const bobResume = findElements(inst.tree, (n) => n.type === 'button' && collectText(n) === 'Resume')[0];
    assert.equal(bobResume.props.disabled, false);
    bobResume.props.onClick();
    await inst.flush(1);
    const bobBusyResume = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Resuming'))[0];
    assert.equal(bobBusyResume.props.disabled, true);

    // Delayed Alice callback settles while Bob is active & in-flight -> must NOT reveal Alice label and must NOT unlock Bob!
    resolvers['op-alice']({ success: false, error: 'Session or scope changed.' });
    await inst.flush();
    assert.equal(collectText(inst.tree).includes('Alice Private Collection'), false);
    const bobStillBusy = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Resuming'))[0];
    assert.equal(bobStillBusy.props.disabled, true, 'Stale Alice callback must not clear Bob active lock');

    // Switch back to Alice (A -> B -> A) before Bob finishes, and verify Bob callback & another delayed A->B->A callback stay ignored
    state.cloudConfig = cfg('alice');
    inst.rerender();
    await inst.flush();
    resolvers['op-bob']({ success: true, name: 'Bob Collection' });
    await inst.flush();
    assert.equal(collectText(inst.tree).includes('Bob Collection'), false);

    // Now Alice clicks Resume in new generation 2, switches A -> B -> A to gen 4, then old gen 2 resolves -> ignored!
    const aliceResume2 = findElements(inst.tree, (n) => n.type === 'button' && collectText(n) === 'Resume')[0];
    aliceResume2.props.onClick();
    await inst.flush(1);
    const gen2Resolver = resolvers['op-alice'];

    state.cloudConfig = cfg('bob');
    inst.rerender();
    await inst.flush();
    state.cloudConfig = cfg('alice');
    inst.rerender();
    await inst.flush();

    gen2Resolver({ success: false, reconcilePending: true, error: 'stale gen 2 error' });
    await inst.flush();
    assert.equal(collectText(inst.tree).includes('stale gen 2 error'), false, 'A->B->A must ignore stale generation callback');
  }

  // 2. Active in-flight 'pending' submission disables Dismiss & Resume; post-restart 'pending' (no activeDuplicateOperationIds) enables both
  {
    const harness = createModalHarness();
    let dismissed = 0;
    let retried = 0;
    const state = {
      cloudConfig: { apiUrl: 'https://api.example.com', sessionKind: 'provider', user: { id: 'alice', role: 'user' } },
      activeDuplicateOperationIds: { 'op-live': true },
      pendingDuplicateIntents: {
        'op-live': {
          operationId: 'op-live',
          ownerKey: '["https://api.example.com","alice"]',
          kind: 'collection',
          sourceCollectionId: 'c1',
          sourceName: 'Inflight Collection',
          targetScope: { id: 'ws-a', name: 'Workspace A', type: 'workspace' },
          createdAt: 100,
          status: 'pending',
        },
      },
      retryPendingDuplicateIntent: async () => {
        retried++;
        return { success: true, operationId: 'op-live', name: 'Inflight Collection' };
      },
      clearPendingDuplicateIntent: () => {
        dismissed++;
      },
    };

    const Banner = loadPendingDuplicateRecovery(harness, state);
    const inst = harness.mount(Banner, {});
    await inst.flush();

    assert.equal(collectText(inst.tree).includes('In Progress'), true);
    const liveDismiss = findElements(inst.tree, (n) => n.type === 'button' && collectText(n) === 'Dismiss')[0];
    const liveResume = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Resuming'))[0];
    assert.equal(liveDismiss.props.disabled, true);
    assert.equal(liveResume.props.disabled, true);
    liveDismiss.props.onClick();
    liveResume.props.onClick();
    assert.equal(dismissed, 0);
    assert.equal(retried, 0);

    // Simulate post-restart state: same persisted status === 'pending', but runtime activeDuplicateOperationIds is empty
    state.activeDuplicateOperationIds = {};
    inst.rerender();
    await inst.flush();

    assert.equal(collectText(inst.tree).includes('Pending'), true);
    const restartDismiss = findElements(inst.tree, (n) => n.type === 'button' && collectText(n) === 'Dismiss')[0];
    const restartResume = findElements(inst.tree, (n) => n.type === 'button' && collectText(n) === 'Resume')[0];
    assert.equal(restartDismiss.props.disabled, false);
    assert.equal(restartResume.props.disabled, false);
    await restartResume.props.onClick();
    await inst.flush();
    assert.equal(retried, 1);
  }
});

test('C9 (P3): DuplicateItemModal honors isOfflineOnly owner scoping, DuplicateCollectionModal locks X/targets during resume, RequestEditor uses useStoreContext', async () => {
  // 1. DuplicateItemModal passes !productPolicy.workspace.cloud to getOwnedPendingDuplicateIntents
  {
    const harness = createModalHarness();
    const state = {
      workspaceMode: 'offline',
      collections: [
        {
          id: 'c1',
          name: 'Col 1',
          items: [
            {
              id: 'r1',
              name: 'Req 1',
              type: 'request',
              request: { id: 'r1', name: 'Req 1', method: 'GET', url: 'https://a.test', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '' },
            },
          ],
        },
      ],
      cloudConfig: { apiUrl: 'https://api.example.com', sessionKind: 'provider', user: { id: 'alice', role: 'user' } },
      pendingDuplicateIntents: {
        'op-cloud-only': {
          operationId: 'op-cloud-only',
          ownerKey: '["https://api.example.com","alice"]',
          kind: 'item',
          sourceCollectionId: 'c1',
          sourceItemId: 'r1',
          sourceName: 'Leaked Cloud Recovery',
          targetCollectionId: 'c1',
          createdAt: 100,
          status: 'reconcile_required',
        },
      },
      duplicateCollectionItem: async () => ({ success: true }),
      retryPendingDuplicateIntent: async () => ({ success: true }),
      clearPendingDuplicateIntent: () => { },
      activeDuplicateOperationIds: {},
    };
    const Modal = loadDuplicateItemModal(harness, state, {
      productPolicy: { workspace: { offline: true, cloud: false } },
    });
    const inst = harness.mount(Modal, {
      isOpen: true,
      collectionId: 'c1',
      itemId: 'r1',
      itemType: 'request',
      itemName: 'Req 1',
      onClose: () => { },
    });
    await inst.flush();
    assert.equal(
      collectText(inst.tree).includes('Leaked Cloud Recovery'),
      false,
      'Offline-only DuplicateItemModal must not surface cloud-owned recovery intents',
    );
  }

  // 2. DuplicateCollectionModal disables X close and destination target buttons while resumingOpId !== null
  {
    const harness = createModalHarness();
    let resolveResume;
    let closeCalls = 0;
    const state = {
      workspaceMode: 'cloud',
      collections: [{ id: 'c1', name: 'Col 1', items: [] }],
      offlineWorkspaces: [],
      cloudConfig: {
        apiUrl: 'https://api.example.com',
        token: 'tok',
        sessionKind: 'provider',
        user: { id: 'alice', role: 'owner' },
        activeScope: { type: 'workspace', id: 'ws-a', name: 'WS A', role: 'owner' },
      },
      pendingDuplicateIntents: {
        'op-resuming': {
          operationId: 'op-resuming',
          ownerKey: '["https://api.example.com","alice"]',
          kind: 'collection',
          sourceCollectionId: 'c1',
          sourceName: 'Col 1',
          targetScope: { type: 'workspace', id: 'ws-a', name: 'WS A', role: 'owner' },
          createdAt: 100,
          status: 'reconcile_required',
        },
      },
      activeDuplicateOperationIds: {},
      retryPendingDuplicateIntent: async () => new Promise((r) => { resolveResume = r; }),
      clearPendingDuplicateIntent: () => { },
      duplicateCollection: async () => ({ success: true }),
    };
    const Modal = loadDuplicateCollectionModal(harness, state, {
      cloudApi: {
        fetchUserWorkspaces: async () => [{ id: 'ws-a', name: 'WS A', role: 'owner' }],
        fetchUserTeams: async () => [],
        fetchTeamProjects: async () => [],
      },
    });
    const inst = harness.mount(Modal, {
      isOpen: true,
      collection: state.collections[0],
      onClose: () => { closeCalls++; },
    });
    await inst.flush();
    const resumeBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Resume Pending Duplicate'))[0];
    assert.ok(resumeBtn);
    resumeBtn.props.onClick();
    await inst.flush();

    const closeBtn = findElements(inst.tree, (n) => n.type === 'button' && n.props['aria-label'] === 'Close modal')[0];
    const wsBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('WS A'))[0];
    assert.equal(closeBtn.props.disabled, true, 'Close button must be disabled while resumingOpId !== null');
    assert.equal(wsBtn.props.disabled, true, 'Destination scope buttons must be disabled while resumingOpId !== null');
    closeBtn.props.onClick();
    assert.equal(closeCalls, 0);
    resolveResume({ success: true, operationId: 'op-resuming', name: 'Col 1' });
    await inst.flush();
  }

  // 3. RequestEditor resolves active store via useStoreContext() || useApiStore
  const reqEditorSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/components/RequestEditor.tsx'), 'utf8');
  assert.match(reqEditorSrc, /useStoreContext\(\)\s*\|\|\s*useApiStore/);

  // 4. C-R1: Closing DuplicateCollectionModal mid-submit resets isSubmitting on reopen
  {
    const harness = createModalHarness();
    let releaseDup;
    const state = {
      workspaceMode: 'offline',
      collections: [{ id: 'c1', name: 'Col 1', items: [] }],
      offlineWorkspaces: [
        { id: 'ws-1', name: 'Local 1' },
        { id: 'ws-2', name: 'Local 2' },
      ],
      activeOfflineWorkspaceId: 'ws-1',
      cloudConfig: { apiUrl: '', token: '', user: null, activeScope: null },
      pendingDuplicateIntents: {},
      activeDuplicateOperationIds: {},
      duplicateCollection: () => new Promise((resolve) => { releaseDup = resolve; }),
    };
    const Modal = loadDuplicateCollectionModal(harness, state, {});
    const inst = harness.mount(Modal, {
      isOpen: true,
      collection: state.collections[0],
      onClose: () => {},
    });
    await inst.flush();
    const submitBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Duplicate Collection'))[0];
    assert.ok(submitBtn && !submitBtn.props.disabled);
    const pendingSubmit = submitBtn.props.onClick();
    await inst.flush();
    assert.ok(findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Duplicating...'))[0]);

    // Close modal before duplicateCollection resolves, then reopen
    inst.update({ isOpen: false, collection: state.collections[0], onClose: () => {} });
    await inst.flush();
    inst.update({ isOpen: true, collection: state.collections[0], onClose: () => {} });
    await inst.flush();
    const reopenedSubmit = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Duplicate Collection'))[0];
    assert.ok(reopenedSubmit && !reopenedSubmit.props.disabled, 'Reopened DuplicateCollectionModal must not stay stuck in isSubmitting');
    releaseDup({ success: true });
    await pendingSubmit;
  }

  // 5. C-R3: EnvironmentConflictModal displays errorMsg and EnvironmentModal passes conflictErrorMsg + retryCopyEnvDraftRef
  const envConflictSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/components/EnvironmentConflictModal.tsx'), 'utf8');
  const envModalSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/components/EnvironmentModal.tsx'), 'utf8');
  assert.match(envConflictSrc, /errorMsg\s*=\s*null/);
  assert.match(envModalSrc, /errorMsg=\{conflictErrorMsg\}/);
  assert.match(envModalSrc, /retryCopyEnvDraftRef/);

  // 6. C-R5: EnvironmentModal sanitizes exported filename to alphanumeric + hyphens
  assert.match(envModalSrc, /\.replace\(\/\[\^a-z0-9\]\+\/g,\s*'-'\)\s*\.replace\(\/\^-\+\|-\+\$\/g,\s*''\)\s*\|\|\s*'environment'/);

  // 7. C-R6: DuplicateItemModal disables X close and target selectors while resumingOpId !== null
  {
    const harness = createModalHarness();
    let resolveResume;
    let closeCalls = 0;
    const state = {
      workspaceMode: 'cloud',
      collections: [
        {
          id: 'c1',
          name: 'Col 1',
          items: [{ id: 'r1', name: 'Req 1', type: 'request', request: { id: 'r1', name: 'Req 1', method: 'GET', url: 'https://a.test', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '' } }],
        },
      ],
      offlineWorkspaces: [],
      cloudConfig: {
        apiUrl: 'https://api.example.com',
        token: 'tok',
        sessionKind: 'provider',
        user: { id: 'alice', role: 'owner' },
        activeScope: { type: 'workspace', id: 'ws-a', name: 'WS A', role: 'owner' },
      },
      pendingDuplicateIntents: {
        'op-item-resuming': {
          operationId: 'op-item-resuming',
          ownerKey: '["https://api.example.com","alice"]',
          kind: 'item',
          sourceCollectionId: 'c1',
          sourceItemId: 'r1',
          sourceItemType: 'request',
          sourceName: 'Req 1',
          targetScope: { type: 'workspace', id: 'ws-a', name: 'WS A', role: 'owner' },
          createdAt: 100,
          status: 'reconcile_required',
        },
      },
      activeDuplicateOperationIds: {},
      retryPendingDuplicateIntent: async () => new Promise((r) => { resolveResume = r; }),
      clearPendingDuplicateIntent: () => { },
      duplicateItem: async () => ({ success: true }),
    };
    const Modal = loadDuplicateItemModal(harness, state, {
      cloudApi: {
        fetchUserWorkspaces: async () => [{ id: 'ws-a', name: 'WS A', role: 'owner' }],
        fetchUserTeams: async () => [],
        fetchTeamProjects: async () => [],
      },
    });
    const inst = harness.mount(Modal, {
      isOpen: true,
      sourceCollectionId: 'c1',
      item: state.collections[0].items[0],
      onClose: () => { closeCalls++; },
    });
    await inst.flush();
    const resumeBtn = findElements(inst.tree, (n) => n.type === 'button' && collectText(n).includes('Resume Pending Duplicate'))[0];
    assert.ok(resumeBtn);
    resumeBtn.props.onClick();
    await inst.flush();

    const closeBtn = findElements(inst.tree, (n) => n.type === 'button' && n.props['aria-label'] === 'Close modal')[0];
    const selects = findElements(inst.tree, (n) => n.type === 'select');
    assert.equal(closeBtn.props.disabled, true, 'DuplicateItemModal close button must be disabled while resumingOpId !== null');
    assert.ok(selects.length >= 1 && selects.every((s) => s.props.disabled === true), 'Target selects must be disabled while resumingOpId !== null');
    closeBtn.props.onClick();
    assert.equal(closeCalls, 0);
    resolveResume({ success: true, operationId: 'op-item-resuming', name: 'Req 1' });
    await inst.flush();
  }

  // 8. C-R7: EnvironmentConflictModal stops Escape propagation and EnvironmentModal skips parent close while child dialogs are open
  assert.match(envConflictSrc, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*onClose\(\);/);
  assert.match(envModalSrc, /if \(conflict \|\| showDeleteConfirm \|\| isPermModalOpen \|\| isNewEnvPermModalOpen\) \{\s*return;\s*\}/);
});
