import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadUpdater(invoke = async () => {}) {
  const source = fs.readFileSync(new URL('../apps/native/src/androidUpdater.ts', import.meta.url), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, require: () => ({ invoke }), console });
  return exports;
}
const release = {
  tag_name: 'v1.3.4', html_url: 'https://github.com/adiputera/AirREST/releases/tag/v1.3.4',
  assets: [{ name: 'airrest-1.3.4-android-arm64.apk', size: 1024,
    browser_download_url: 'https://github.com/adiputera/AirREST/releases/download/v1.3.4/airrest-1.3.4-android-arm64.apk' }],
};
const status = (state, extra = {}) => ({ state, version: '1.3.4', progress: null, message: null, canInstall: false, ...extra });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function setup(overrides = {}) {
  const states = [], messages = [], busy = [];
  const port = { status: async () => status('idle'), start: async () => status('pending'),
    cancel: async () => status('idle'), install: async () => ({ action: 'installerOpened' }), ...overrides };
  const controller = loadUpdater().createAndroidUpdateController(port,
    value => states.push(value), value => messages.push(value), value => busy.push(value));
  return { controller, states, messages, busy };
}

test('stable versions compare correctly; malformed/prerelease versions are not installed', () => {
  const { isNewerVersion } = loadUpdater();
  for (const version of ['v1.3.4', 'android-v1.3.4', 'desktop-v1.3.4', '1.3.4']) assert.equal(isNewerVersion(version, '1.3.3'), true);
  for (const version of ['v1.3.3', 'v1.2.9', 'nonsense', 'v1.4.0-beta', '1.4']) assert.equal(isNewerVersion(version, '1.3.3'), false);
});

test('release validation rejects unsafe/missing APK metadata', () => {
  const { parseRelease } = loadUpdater();
  assert.equal(parseRelease(release).assets.length, 1);
  for (const asset of [null, { ...release.assets[0], size: 0 }, { ...release.assets[0], digest: 'invalid' },
    { ...release.assets[0], browser_download_url: 'http://example.com/update.apk' }]) {
    assert.equal(parseRelease({ ...release, assets: [asset] }), null);
  }
  assert.equal(parseRelease({ ...release, html_url: 'javascript:alert(1)' }), null);
  assert.equal(parseRelease({ ...release, assets: [] }), null);
});

test('cache restores release metadata across restart and rejects corrupt or wrong-repository cache', () => {
  const { readCachedRelease } = loadUpdater();
  const cached = JSON.stringify({ repo: 'adiputera/AirREST', checkedAt: 123, release });
  assert.equal(readCachedRelease(cached, 'adiputera/AirREST').release.tag_name, 'v1.3.4');
  assert.equal(readCachedRelease(cached, 'example/other'), null);
  assert.equal(readCachedRelease('{broken', 'adiputera/AirREST'), null);
});

test('native bridge sends release assets, with ABI selection delegated to Android', async () => {
  const calls = [];
  const { nativeAndroidUpdater } = loadUpdater(async (command, args) => { calls.push({ command, args }); });
  await nativeAndroidUpdater.start(release);
  await nativeAndroidUpdater.status();
  await nativeAndroidUpdater.install();
  await nativeAndroidUpdater.cancel();
  assert.deepEqual(calls.map(call => call.command), ['plugin:android-update|start', 'plugin:android-update|status', 'plugin:android-update|install', 'plugin:android-update|cancel']);
  assert.equal(calls[0].args.version, release.tag_name);
  assert.equal(calls[0].args.assets, release.assets);
});

test('download finishes only after native ready; reaching 100 bytes does not trigger install', async () => {
  let installed = 0;
  const sequence = [status('downloading', { progress: 99 }), status('ready', { progress: 100 })];
  const { controller, states } = setup({ status: async () => sequence.shift(), install: async () => { installed++; return { action: 'installerOpened' }; } });
  await controller.start(release);
  await controller.refresh();
  assert.equal(states.at(-1).state, 'downloading');
  await controller.refresh();
  assert.equal(states.at(-1).state, 'ready');
  assert.equal(installed, 0);
  await controller.install();
  assert.equal(installed, 1);
});

test('failed start releases busy state and allows retry', async () => {
  let count = 0;
  const { controller, states, messages, busy } = setup({ start: async () => { if (++count === 1) throw { message: 'Storage unavailable' }; return status('pending'); } });
  await controller.start(release);
  assert.equal(messages.at(-1), 'Storage unavailable');
  assert.equal(busy.at(-1), false);
  await controller.start(release);
  assert.equal(states.at(-1).state, 'pending');
  assert.equal(messages.at(-1), null);
});

test('stale status cannot resurrect a cancelled download', async () => {
  const pending = deferred();
  const { controller, states } = setup({ status: () => pending.promise });
  const poll = controller.refresh();
  await controller.cancel();
  pending.resolve(status('ready'));
  await poll;
  assert.deepEqual(states.map(value => value.state), ['idle']);
});

test('duplicate taps and overlapping polls do not enqueue duplicate commands', async () => {
  const pending = deferred(); let starts = 0, polls = 0;
  const { controller } = setup({ start: () => { starts++; return pending.promise; }, status: async () => { polls++; return status('idle'); } });
  const first = controller.start(release);
  await controller.start(release);
  await controller.refresh();
  assert.equal(starts, 1); assert.equal(polls, 0);
  pending.resolve(status('pending')); await first;
});

test('installation permission requires return and another user tap; cancellation remains retryable', async () => {
  let attempts = 0;
  const { controller, messages } = setup({ install: async () => ({ action: ++attempts === 1 ? 'permissionRequired' : 'installerOpened' }) });
  await controller.install(); assert.match(messages.at(-1), /Allow AirREST/);
  await controller.install(); assert.match(messages.at(-1), /If cancelled/);
});

test('installer and query failures are visible and do not strand busy state', async () => {
  const { controller, messages, busy } = setup({ install: async () => { throw 'No installer'; }, status: async () => { throw Error('Download service unavailable'); } });
  await controller.install(); assert.equal(messages.at(-1), 'No installer'); assert.equal(busy.at(-1), false);
  await controller.refresh(); assert.equal(messages.at(-1), 'Download service unavailable');
});

test('restart restores native download; unmounted controller ignores pending results', async () => {
  const { controller, states } = setup({ status: async () => status('ready') });
  await controller.refresh(); assert.equal(states.at(-1).state, 'ready');
  const pending = deferred();
  const second = setup({ status: () => pending.promise });
  const poll = second.controller.refresh(); second.controller.dispose(); pending.resolve(status('ready')); await poll;
  assert.equal(second.states.length, 0);
});

function bannerHarness({ savedStatus = status('idle'), cached = true, openerFailure = false } = {}) {
  const slots = [], effects = [], cleanups = [], listeners = new Map(), calls = [];
  let cursor = 0, currentStatus = savedStatus;
  const storage = new Map(cached ? [['airrest_android_release_cache', JSON.stringify({ repo: 'adiputera/AirREST', checkedAt: Date.now(), release })]] : []);
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || deps.some((dep, i) => dep !== slots[index][i])) effects.push(effect);
      slots[index] = deps;
    },
  };
  const logic = loadUpdater(async (command) => {
    calls.push(command);
    if (command.endsWith('|status')) return currentStatus;
    if (command.endsWith('|start')) return currentStatus = status('pending');
    if (command.endsWith('|cancel')) return currentStatus = status('idle');
    return { action: 'permissionRequired' };
  });
  const events = { addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name) };
  const exports = {};
  const source = fs.readFileSync(new URL('../apps/native/src/components/AndroidUpdateBanner.tsx', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText, {
    exports, require: name => name === 'react' ? react : name === '../androidUpdater' ? logic : {
      openUrl: async () => { calls.push('browser'); if (openerFailure) throw Error('No browser'); },
    },
    document: { hidden: false, ...events }, window: events,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    fetch: async () => ({ ok: false }), AbortController, console,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {},
  });
  const render = () => { cursor = 0; return exports.AndroidUpdateBanner({ currentVersion: '1.3.3' }); };
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); return render(); };
  return { calls, storage, render, settle,
    async mount() { render(); effects.splice(0).forEach(effect => cleanups.push(effect())); return settle(); },
    async refresh(value) { currentStatus = value; listeners.get('focus')(); return settle(); },
    unmount() { cleanups.forEach(cleanup => cleanup?.()); },
  };
}
const textOf = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : tree?.children?.map(textOf).join('') || '';
function findButton(tree, label) {
  if (tree?.type === 'button' && textOf(tree) === label) return tree;
  for (const child of tree?.children || []) { const found = findButton(child, label); if (found) return found; }
  return null;
}

test('banner uses native download, shows verification, then opens permission flow only on Install tap', async () => {
  const app = bannerHarness();
  let tree = await app.mount();
  assert.ok(findButton(tree, 'Download APK'));
  findButton(tree, 'Download APK').props.onClick();
  tree = await app.settle();
  assert.match(textOf(tree), /Waiting for download/);
  assert.equal(app.calls.includes('browser'), false);
  tree = await app.refresh(status('verifying'));
  assert.match(textOf(tree), /Checking APK/);
  assert.equal(findButton(tree, 'Install APK'), null);
  tree = await app.refresh(status('ready', { progress: 100 }));
  assert.equal(app.calls.includes('plugin:android-update|install'), false);
  findButton(tree, 'Install APK').props.onClick();
  tree = await app.settle();
  assert.match(textOf(tree), /Allow AirREST to install apps/);
  app.unmount();
});

test('banner restores a downloaded APK offline without release metadata', async () => {
  const app = bannerHarness({ savedStatus: status('ready'), cached: false });
  const tree = await app.mount();
  assert.ok(findButton(tree, 'Install APK'));
  assert.match(textOf(tree), /1.3.4/);
  app.unmount();
});

test('manual browser fallback reports errors and does not replace native download', async () => {
  const app = bannerHarness({ openerFailure: true });
  let tree = await app.mount();
  findButton(tree, 'Manual download').props.onClick();
  tree = await app.settle();
  assert.match(textOf(tree), /Could not open the release page/);
  assert.ok(findButton(tree, 'Download APK'));
  app.unmount();
});
