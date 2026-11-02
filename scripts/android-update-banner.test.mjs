import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadBannerLogic() {
  const source = fs.readFileSync(new URL('../apps/native/src/components/AndroidUpdateBanner.tsx', import.meta.url), 'utf8');
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

test('T-NAT-ANDROID: pickAndroidApkUrl prioritizes x86_64 on x86_64 userAgent, resets downloading state, and suppresses banner when 0 APKs', () => {
  const { pickAndroidApkUrl } = loadBannerLogic();

  const assets = [
    { name: 'airrest-1.3.0-android-arm64.apk', browser_download_url: 'https://github.com/.../arm64.apk' },
    { name: 'airrest-1.3.0-android-x86_64.apk', browser_download_url: 'https://github.com/.../x86_64.apk' },
  ];

  assert.equal(
    pickAndroidApkUrl(assets, 'https://github.com/fallback', 'Mozilla/5.0 (Linux; Android 14; sdk_gphone64_x86_64)'),
    'https://github.com/.../x86_64.apk',
    'x86_64 userAgent must select x86_64 APK'
  );

  const source = fs.readFileSync(new URL('../apps/native/src/components/AndroidUpdateBanner.tsx', import.meta.url), 'utf8');
  assert.match(source, /finally\s*\{\s*setDownloading\(false\);\s*\}/, 'handleDownload must reset downloading state in finally block');
  assert.match(
    source,
    /const targetUrl = releasePageUrl \|\| downloadUrl;/,
    'handleDownload must prioritize releasePageUrl to avoid in-app webview download stalls'
  );
  assert.match(
    source,
    /const hasApk = Boolean\(\s*release\.assets\?\.some\(\(a\) => a\.name\.endsWith\('\.apk'\) && a\.browser_download_url\?\.startsWith\('https:\/\/'\)\),\s*\);\s*if \(hasApk\) \{\s*localStorage\.setItem\(LAST_CHECK_KEY/,
    'LAST_CHECK_KEY and updateAvailable must only be set when release has at least one https .apk asset'
  );
});
