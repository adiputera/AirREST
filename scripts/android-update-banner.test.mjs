import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadBannerLogic() {
  const source = fs.readFileSync(new URL('../apps/desktop/src/components/AndroidUpdateBanner.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
    },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: () => ({ openUrl: () => Promise.resolve() }),
    console,
    Date,
    parseInt,
    String,
    Math,
  });
  return exports;
}

test('isNewerVersion correctly evaluates semver versions with various prefixes', () => {
  const { isNewerVersion } = loadBannerLogic();

  // Newer versions
  assert.equal(isNewerVersion('1.2.1', '1.2.0'), true);
  assert.equal(isNewerVersion('v1.2.1', '1.2.0'), true);
  assert.equal(isNewerVersion('desktop-v1.3.0', '1.2.0'), true);
  assert.equal(isNewerVersion('android-v2.0.0', '1.2.0'), true);
  assert.equal(isNewerVersion('2.0.0', '1.9.9'), true);

  // Equal versions
  assert.equal(isNewerVersion('1.2.0', '1.2.0'), false);
  assert.equal(isNewerVersion('v1.2.0', '1.2.0'), false);
  assert.equal(isNewerVersion('desktop-v1.2.0', '1.2.0'), false);

  // Older versions
  assert.equal(isNewerVersion('1.1.9', '1.2.0'), false);
  assert.equal(isNewerVersion('v1.1.0', '1.2.0'), false);
  assert.equal(isNewerVersion('0.9.0', '1.2.0'), false);
});

test('pickAndroidApkUrl selects arm64 APK first, then universal, then fallback', () => {
  const { pickAndroidApkUrl } = loadBannerLogic();

  const assetsWithArm64 = [
    { name: 'airrest-1.2.1-android-x86_64.apk', browser_download_url: 'https://github.com/.../x86_64.apk' },
    { name: 'airrest-1.2.1-android-arm64.apk', browser_download_url: 'https://github.com/.../arm64.apk' },
    { name: 'airrest-1.2.1-android-universal.aab', browser_download_url: 'https://github.com/.../aab' },
  ];
  assert.equal(
    pickAndroidApkUrl(assetsWithArm64, 'https://github.com/fallback'),
    'https://github.com/.../arm64.apk'
  );

  const assetsUniversalOnly = [
    { name: 'airrest-1.2.1-android-universal.apk', browser_download_url: 'https://github.com/.../universal.apk' },
  ];
  assert.equal(
    pickAndroidApkUrl(assetsUniversalOnly, 'https://github.com/fallback'),
    'https://github.com/.../universal.apk'
  );

  const assetsWithoutApk = [
    { name: 'airrest-1.2.1-setup.exe', browser_download_url: 'https://github.com/.../exe' },
  ];
  assert.equal(
    pickAndroidApkUrl(assetsWithoutApk, 'https://github.com/fallback'),
    'https://github.com/fallback'
  );
});
