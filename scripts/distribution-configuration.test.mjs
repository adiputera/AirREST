import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const root = new URL('..', import.meta.url);

function loadModule(relativePath, dependencies = {}) {
  const source = fs.readFileSync(new URL(relativePath, root), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    Object,
    URL,
    require: (specifier) => dependencies[specifier],
  }, { filename: relativePath });
  return module.exports;
}

const productPolicy = loadModule('packages/common/src/productPolicy.ts');
const configuration = loadModule('packages/common/src/distributionConfig.ts', {
  './productPolicy': productPolicy,
});

test('should canonicalize a valid composition configuration', () => {
  const config = configuration.createApplicationDistributionConfig({
    backend: { apiUrl: 'https://api.example.com/v1/', allowCustomUrl: false },
    auth: { providerId: 'browser-sso' },
    workspace: { edition: 'cloud' },
    updates: {
      androidReleaseRepository: 'example/mobile-client',
      desktopUpdaterEndpoint: 'https://updates.example.com/latest.json',
    },
  });

  assert.equal(config.backend.apiUrl, 'https://api.example.com/v1');
  assert.equal(config.backend.allowCustomUrl, false);
  assert.equal(config.auth.providerId, 'browser-sso');
  assert.equal(config.workspace.policy.edition, 'cloud');
  assert.equal(config.workspace.policy.workspace.offline, false);
  assert.equal(config.updates.androidReleaseRepository, 'example/mobile-client');
  assert.equal(config.updates.desktopUpdaterEndpoint, 'https://updates.example.com/latest.json');
  assert.equal(Object.isFrozen(config), true);
});

test('should reject malformed or unsafe composition configuration at startup', () => {
  const invalidConfigurations = [
    { backend: { apiUrl: 'https://user:secret@example.com' } },
    { backend: { apiUrl: 'https://api.example.com?token=secret' } },
    { backend: { apiUrl: 'http://api.example.com' } },
    { auth: { providerId: 'Bad Provider' } },
    { workspace: { policy: { edition: 'cloud', workspace: { cloud: true, offline: true } } } },
    { updates: { androidReleaseRepository: 'example/mobile/client' } },
    { updates: { desktopUpdaterEndpoint: 'http://updates.example.com/latest.json' } },
  ];

  for (const value of invalidConfigurations) {
    assert.throws(() => configuration.createApplicationDistributionConfig(value));
  }
});

test('should keep native update-source selection in composition and expose explicit public config exports', () => {
  const nativeMain = fs.readFileSync(new URL('apps/native/src/main.tsx', root), 'utf8');
  const nativeConfiguration = fs.readFileSync(new URL('apps/native/src/distributionConfig.ts', root), 'utf8');
  const extensionMain = fs.readFileSync(new URL('apps/extension/src/main.tsx', root), 'utf8');
  const banner = fs.readFileSync(new URL('apps/native/src/components/AndroidUpdateBanner.tsx', root), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(new URL('packages/common/package.json', root), 'utf8'));

  assert.match(nativeMain, /nativeDistributionConfig/);
  assert.match(nativeConfiguration, /createApplicationDistributionConfig/);
  assert.match(extensionMain, /createApplicationDistributionConfig/);
  assert.doesNotMatch(extensionMain, /from ['"]@airrest\/common['"]/);
  assert.doesNotMatch(banner, /repo\s*=\s*['"]/);
  assert.equal(packageJson.exports['./configuration'], './src/public/configuration.ts');
});
