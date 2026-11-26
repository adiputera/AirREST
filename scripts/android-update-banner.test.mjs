import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadUpdater(invoke = async () => {}) {
  const source = fs.readFileSync(new URL('../apps/native/src/androidUpdater.ts', import.meta.url), 'utf8');
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    { exports, require: () => ({ invoke }), console },
  );
  return exports;
}

const release = {
  tag_name: 'v1.3.4',
  html_url: 'https://github.com/adiputera/AirREST/releases/tag/v1.3.4',
  assets: [
    {
      name: 'airrest-1.3.4-android-arm64.apk',
      size: 1024,
      browser_download_url:
        'https://github.com/adiputera/AirREST/releases/download/v1.3.4/airrest-1.3.4-android-arm64.apk',
    },
  ],
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test('stable versions compare correctly; malformed/prerelease versions are not installed', () => {
  const { isNewerVersion } = loadUpdater();
  for (const version of ['v1.3.4', 'android-v1.3.4', 'desktop-v1.3.4', '1.3.4']) {
    assert.equal(isNewerVersion(version, '1.3.3'), true);
  }
  for (const version of ['v1.3.3', 'v1.2.9', 'nonsense', 'v1.4.0-beta', '1.4']) {
    assert.equal(isNewerVersion(version, '1.3.3'), false);
  }
});

test('release validation rejects unsafe/missing APK metadata', () => {
  const { parseRelease } = loadUpdater();
  assert.equal(parseRelease(release).assets.length, 1);
  for (const asset of [
    null,
    { ...release.assets[0], size: 0 },
    { ...release.assets[0], digest: 'invalid' },
    { ...release.assets[0], browser_download_url: 'http://example.com/update.apk' },
  ]) {
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

test('native bridge delegates direct APK and release-page launches to the external browser plugin', async () => {
  const calls = [];
  const { nativeAndroidUpdater } = loadUpdater(async (command, args) => {
    calls.push({ command, args });
    return { target: command.endsWith('|download') ? 'apk' : 'releasePage', url: release.html_url };
  });
  await nativeAndroidUpdater.download(release);
  await nativeAndroidUpdater.browse(release);
  assert.deepEqual(
    calls.map((call) => call.command),
    ['plugin:android-update|download', 'plugin:android-update|browse'],
  );
  assert.equal(calls[0].args.version, release.tag_name);
  assert.equal(calls[0].args.htmlUrl, release.html_url);
  assert.equal(calls[0].args.assets, release.assets);
  assert.equal(calls[1].args.version, release.tag_name);
  assert.equal(calls[1].args.url, release.html_url);
});

function bannerHarness({ cached = true, downloadResult, invokeHandler } = {}) {
  const slots = [];
  const effects = [];
  const cleanups = [];
  const calls = [];
  let cursor = 0;
  const storage = new Map(
    cached
      ? [['airrest_android_release_cache', JSON.stringify({ repo: 'adiputera/AirREST', checkedAt: Date.now(), release })]]
      : [],
  );
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [
        slots[index],
        (next) => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      return (slots[index] ||= { current: initial });
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || deps.some((dep, i) => dep !== slots[index][i])) effects.push(effect);
      slots[index] = deps;
    },
  };
  const logic = loadUpdater(async (command, args) => {
    calls.push({ command, args });
    if (invokeHandler) return invokeHandler(command, args);
    if (command.endsWith('|download')) {
      return (
        downloadResult ?? {
          target: 'apk',
          url: release.assets[0].browser_download_url,
        }
      );
    }
    return { target: 'releasePage', url: release.html_url };
  });
  const exports = {};
  const source = fs.readFileSync(
    new URL('../apps/native/src/components/AndroidUpdateBanner.tsx', import.meta.url),
    'utf8',
  );
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    }).outputText,
    {
      exports,
      require: (name) => {
        if (name === 'react') return react;
        if (name === '../androidUpdater') return logic;
        throw new Error(`Unexpected import: ${name}`);
      },
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      fetch: async () => ({ ok: false }),
      AbortController,
      console,
      setTimeout: () => 1,
      clearTimeout() {},
    },
  );
  const render = () => {
    cursor = 0;
    return exports.AndroidUpdateBanner({ repo: 'adiputera/AirREST', currentVersion: '1.3.3' });
  };
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return render();
  };
  return {
    calls,
    storage,
    render,
    settle,
    async mount() {
      render();
      effects.splice(0).forEach((effect) => cleanups.push(effect()));
      return settle();
    },
    unmount() {
      cleanups.forEach((cleanup) => cleanup?.());
    },
  };
}

const textOf = (tree) =>
  typeof tree === 'string' || typeof tree === 'number'
    ? String(tree)
    : tree?.children?.map(textOf).join('') || '';

function findButton(tree, label) {
  if (tree?.type === 'button' && textOf(tree) === label) return tree;
  for (const child of tree?.children || []) {
    const found = findButton(child, label);
    if (found) return found;
  }
  return null;
}

test('Download APK opens direct APK in external browser and shows Downloads guidance', async () => {
  const app = bannerHarness();
  let tree = await app.mount();
  const button = findButton(tree, 'Download APK');
  assert.ok(button);
  assert.ok(findButton(tree, 'Release page'));
  button.props.onClick();
  tree = await app.settle();
  assert.deepEqual(
    app.calls.map((c) => c.command),
    ['plugin:android-update|download'],
  );
  assert.match(textOf(tree), /Opened the APK download in your browser/);
  assert.match(textOf(tree), /open the file from Downloads to install/);
  app.unmount();
});

test('ABI fallback opens release page in external browser with fallback message', async () => {
  const app = bannerHarness({
    downloadResult: { target: 'releasePage', url: release.html_url },
  });
  let tree = await app.mount();
  findButton(tree, 'Download APK').props.onClick();
  tree = await app.settle();
  assert.match(textOf(tree), /no direct APK matched this device/);
  app.unmount();
});

test('Release page button opens GitHub release page in external browser', async () => {
  const app = bannerHarness();
  let tree = await app.mount();
  findButton(tree, 'Release page').props.onClick();
  tree = await app.settle();
  assert.deepEqual(
    app.calls.map((c) => c.command),
    ['plugin:android-update|browse'],
  );
  assert.match(textOf(tree), /Opened the release page in your browser/);
  app.unmount();
});

test('duplicate taps while opening are ignored and failures release busy state', async () => {
  const pending = deferred();
  let count = 0;
  const app = bannerHarness({
    invokeHandler: () => {
      if (++count === 1) return pending.promise;
      return Promise.resolve({ target: 'apk', url: release.assets[0].browser_download_url });
    },
  });
  let tree = await app.mount();
  findButton(tree, 'Download APK').props.onClick();
  findButton(app.render(), 'Opening…').props.onClick();
  assert.equal(app.calls.length, 1);
  pending.reject(new Error('No external browser was found'));
  tree = await app.settle();
  assert.match(textOf(tree), /No external browser was found/);
  const retryButton = findButton(tree, 'Download APK');
  assert.ok(retryButton);
  assert.equal(retryButton.props.disabled, false);
  retryButton.props.onClick();
  tree = await app.settle();
  assert.equal(app.calls.length, 2);
  assert.match(textOf(tree), /Opened the APK download in your browser/);
  app.unmount();
});

test('dismiss hides the banner and persists dismissed tag', async () => {
  const app = bannerHarness();
  let tree = await app.mount();
  const closeButton = findButton(tree, '✕');
  assert.ok(closeButton);
  closeButton.props.onClick();
  tree = app.render();
  assert.equal(tree, null);
  assert.equal(app.storage.get('airrest_android_dismissed_version'), 'v1.3.4');
  app.unmount();
});

test('Android manifest and plugin remove REQUEST_INSTALL_PACKAGES and in-app installer/browser patterns', () => {
  const manifest = fs.readFileSync(
    new URL('../apps/native/src-tauri/gen/android/app/src/main/AndroidManifest.xml', import.meta.url),
    'utf8',
  );
  const filePaths = fs.readFileSync(
    new URL('../apps/native/src-tauri/gen/android/app/src/main/res/xml/file_paths.xml', import.meta.url),
    'utf8',
  );
  const plugin = fs.readFileSync(
    new URL(
      '../apps/native/src-tauri/gen/android/app/src/main/java/id/adiputera/airrest/AndroidUpdatePlugin.kt',
      import.meta.url,
    ),
    'utf8',
  );
  const banner = fs.readFileSync(
    new URL('../apps/native/src/components/AndroidUpdateBanner.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(manifest, /REQUEST_INSTALL_PACKAGES/);
  assert.match(manifest, /androidx\.core\.content\.FileProvider/);
  assert.doesNotMatch(filePaths, /apk_updates/);

  assert.match(plugin, /Intent\.ACTION_VIEW/);
  assert.match(plugin, /Intent\.FLAG_ACTIVITY_NEW_TASK/);
  assert.match(plugin, /selector\s*=\s*browserSelector/);
  assert.doesNotMatch(plugin, /DownloadManager|CustomTabsIntent|FileProvider|ACTION_MANAGE_UNKNOWN_APP_SOURCES/);

  assert.doesNotMatch(banner, /@tauri-apps\/plugin-opener/);
});
