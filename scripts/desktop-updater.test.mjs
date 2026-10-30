import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadDesktopUpdateModule() {
  const srcPath = new URL('../apps/desktop/src/components/DesktopUpdateBanner.tsx', import.meta.url);
  const src = fs.readFileSync(srcPath, 'utf8');
  const compiled = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;

  const exports = {};
  const module = { exports };
  vm.runInNewContext(
    compiled,
    {
      exports,
      module,
      require: (id) => {
        if (id === 'react') {
          return { useEffect: () => {}, useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }) };
        }
        if (id === 'react/jsx-runtime') {
          return { jsx: () => null, jsxs: () => null };
        }
        return {};
      },
      console,
      setTimeout,
      clearTimeout,
    },
    { filename: 'DesktopUpdateBanner.tsx' },
  );

  return module.exports;
}

const { detectDesktopPlatform, createUpdaterController } = loadDesktopUpdateModule();

function createMockUpdate(version = '0.1.2') {
  const calls = {
    download: 0,
    install: [],
    close: 0,
  };
  return {
    calls,
    update: {
      available: true,
      version,
      async download(onEvent) {
        calls.download += 1;
        if (onEvent) {
          onEvent({ event: 'Started', data: { contentLength: 1000 } });
          onEvent({ event: 'Progress', data: { chunkLength: 500 } });
          onEvent({ event: 'Progress', data: { chunkLength: 500 } });
          onEvent({ event: 'Finished' });
        }
      },
      async install(options) {
        calls.install.push(options ?? {});
      },
      async close() {
        calls.close += 1;
      },
    },
  };
}

test('T-UPDATER-1: detectDesktopPlatform identifies macOS, Windows, and Linux user agents', () => {
  assert.equal(
    detectDesktopPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'),
    'macos',
  );
  assert.equal(
    detectDesktopPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'),
    'windows',
  );
  assert.equal(
    detectDesktopPlatform('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'),
    'linux',
  );
});

test('T-UPDATER-2: macOS flow downloads and silently stages update on disk in background', async () => {
  const { calls, update } = createMockUpdate('0.1.2');
  const states = [];
  const progress = [];
  let relaunched = 0;

  const controller = createUpdaterController({
    platform: 'macos',
    checkUpdate: async () => update,
    relaunchApp: async () => {
      relaunched += 1;
    },
    onStateChange: (s) => states.push(s),
    onVersionChange: () => {},
    onProgressChange: (p) => progress.push(p),
  });

  const ready = await controller.start();
  assert.equal(ready, true);
  assert.equal(calls.download, 1);
  assert.equal(calls.install.length, 1, 'macOS must stage install() on disk during background phase');
  assert.equal(controller.needsCloseHook(), false, 'macOS does not need window close hook once staged');
  assert.deepEqual(states, ['checking', 'downloading', 'ready']);
  assert.deepEqual(progress, [50, 100]);

  // Clicking Restart Sekarang on macOS should relaunch immediately without re-installing
  await controller.applyAndRestart();
  assert.equal(calls.install.length, 1);
  assert.equal(relaunched, 1);
});

test('T-UPDATER-3: Windows flow downloads in background; Restart sets restartAfterInstall:true, Close sets restartAfterInstall:false', async () => {
  // Case A: User clicks "Restart Sekarang"
  {
    const { calls, update } = createMockUpdate('0.1.2');
    const controller = createUpdaterController({
      platform: 'windows',
      checkUpdate: async () => update,
      relaunchApp: async () => {},
      onStateChange: () => {},
      onVersionChange: () => {},
      onProgressChange: () => {},
    });

    await controller.start();
    assert.equal(calls.download, 1);
    assert.equal(calls.install.length, 0, 'Windows must NOT run install() in background');
    assert.equal(controller.needsCloseHook(), true);

    await controller.applyAndRestart();
    assert.equal(calls.install.length, 1);
    assert.equal(calls.install[0].restartAfterInstall, true);
  }

  // Case B: User ignores banner and closes window (X)
  {
    const { calls, update } = createMockUpdate('0.1.2');
    const controller = createUpdaterController({
      platform: 'windows',
      checkUpdate: async () => update,
      relaunchApp: async () => {},
      onStateChange: () => {},
      onVersionChange: () => {},
      onProgressChange: () => {},
    });

    await controller.start();
    await controller.applyOnWindowClose();
    assert.equal(calls.install.length, 1);
    assert.equal(
      calls.install[0].restartAfterInstall,
      false,
      'Closing window on Windows must install WITHOUT relaunching app',
    );
  }
});

test('T-UPDATER-4: Linux flow defers install() until Restart or Window Close to prevent unexpected pkexec prompts', async () => {
  const { calls, update } = createMockUpdate('0.1.2');
  let relaunched = 0;

  const controller = createUpdaterController({
    platform: 'linux',
    checkUpdate: async () => update,
    relaunchApp: async () => {
      relaunched += 1;
    },
    onStateChange: () => {},
    onVersionChange: () => {},
    onProgressChange: () => {},
  });

  await controller.start();
  assert.equal(calls.download, 1);
  assert.equal(calls.install.length, 0, 'Linux must NOT run install() in background');
  assert.equal(controller.needsCloseHook(), true);

  await controller.applyAndRestart();
  assert.equal(calls.install.length, 1);
  assert.equal(relaunched, 1);
});

test('T-UPDATER-5: Re-entrancy guard prevents duplicate install() and dispose() releases uninstalled resource', async () => {
  const { calls, update } = createMockUpdate('0.1.2');
  const controller = createUpdaterController({
    platform: 'windows',
    checkUpdate: async () => update,
    relaunchApp: async () => {},
    onStateChange: () => {},
    onVersionChange: () => {},
    onProgressChange: () => {},
  });

  await controller.start();
  await Promise.all([controller.applyAndRestart(), controller.applyOnWindowClose()]);
  assert.equal(calls.install.length, 1, 'Concurrent restart and close must invoke install() only once');

  // Uninstalled resource cleanup on dispose
  const { calls: calls2, update: update2 } = createMockUpdate('0.1.3');
  const controller2 = createUpdaterController({
    platform: 'windows',
    checkUpdate: async () => update2,
    relaunchApp: async () => {},
    onStateChange: () => {},
    onVersionChange: () => {},
    onProgressChange: () => {},
  });
  await controller2.start();
  await controller2.dispose();
  assert.equal(calls2.close, 1, 'Disposing before install must release Rust Update resource');
});

test('T-UPDATER-6: Tauri config, capabilities, and GitHub workflow contracts are synchronized', () => {
  const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
  const tauriConf = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
  );
  const capabilities = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'apps/desktop/src-tauri/capabilities/default.json'), 'utf8'),
  );
  const workflow = fs.readFileSync(
    path.join(rootDir, '.github/workflows/desktop-release.yml'),
    'utf8',
  );
  const libRs = fs.readFileSync(
    path.join(rootDir, 'apps/desktop/src-tauri/src/lib.rs'),
    'utf8',
  );

  assert.equal(tauriConf.bundle.createUpdaterArtifacts, true);
  assert.equal(tauriConf.bundle.macOS.signingIdentity, '-');
  assert.equal(tauriConf.plugins?.updater?.pubkey, '');
  assert.ok(libRs.includes('option_env!("TAURI_UPDATER_PUBLIC_KEY")'));
  assert.deepEqual(tauriConf.plugins?.updater?.endpoints, [
    'https://github.com/adiputera/AirREST/releases/latest/download/latest.json',
  ]);

  assert.ok(capabilities.permissions.includes('updater:default'));
  assert.ok(capabilities.permissions.includes('process:allow-restart'));
  assert.ok(capabilities.permissions.includes('core:window:allow-destroy'));

  assert.ok(workflow.includes('TAURI_SIGNING_PRIVATE_KEY'));
  assert.ok(workflow.includes('TAURI_UPDATER_PUBLIC_KEY'));
  assert.ok(workflow.includes('includeUpdaterJson: true'));
});
