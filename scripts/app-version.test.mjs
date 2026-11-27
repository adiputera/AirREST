import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);

function loadAppVersionModule(overrides = {}) {
  const filePath = path.join(rootDir, 'packages/common/src/lib/appVersion.ts');
  const commonPkg = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'packages/common/package.json'), 'utf8')
  );
  const source = fs.readFileSync(filePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;

  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require: (specifier) => {
      if (specifier === '../../package.json') {
        return { default: commonPkg, ...commonPkg };
      }
      throw new Error(`Unexpected import: ${specifier}`);
    },
    ...overrides,
  });

  vm.runInContext(transpiled, context);
  return { mod: module.exports, commonPkg };
}

test('resolveAppVersion prefers buildVersion > manifestVersion > fallbackVersion', () => {
  const { mod } = loadAppVersionModule();
  assert.equal(
    mod.resolveAppVersion({
      buildVersion: '2.0.0',
      manifestVersion: '1.9.0',
      fallbackVersion: '1.5.0',
    }),
    '2.0.0'
  );
  assert.equal(
    mod.resolveAppVersion({
      buildVersion: '   ',
      manifestVersion: '1.9.0',
      fallbackVersion: '1.5.0',
    }),
    '1.9.0'
  );
  assert.equal(
    mod.resolveAppVersion({
      buildVersion: undefined,
      manifestVersion: '',
      fallbackVersion: '1.5.0',
    }),
    '1.5.0'
  );
  assert.equal(mod.resolveAppVersion({}), '');
});

test('formatAppVersionBadge normalizes leading v and handles prereleases', () => {
  const { mod } = loadAppVersionModule();
  assert.equal(mod.formatAppVersionBadge('1.5.0'), 'v1.5.0');
  assert.equal(mod.formatAppVersionBadge('v1.5.0'), 'v1.5.0');
  assert.equal(mod.formatAppVersionBadge('V1.5.0-beta.2'), 'v1.5.0-beta.2');
  assert.equal(mod.formatAppVersionBadge('  '), '');
});

test('getAppVersion reads __AIRREST_VERSION__, then chrome manifest, then common package.json', () => {
  const { mod: withBuild } = loadAppVersionModule({ __AIRREST_VERSION__: '9.8.7' });
  assert.equal(withBuild.getAppVersion(), '9.8.7');

  const { mod: withManifest } = loadAppVersionModule({
    chrome: {
      runtime: {
        getManifest: () => ({ version: '3.2.1', version_name: '3.2.1-rc.1' }),
      },
    },
  });
  assert.equal(withManifest.getAppVersion(), '3.2.1-rc.1');

  const { mod: fallbackOnly, commonPkg } = loadAppVersionModule();
  assert.equal(fallbackOnly.getAppVersion(), commonPkg.version);
});

test('extension and native vite configs inject __AIRREST_VERSION__ dynamically from package.json', () => {
  const extVite = fs.readFileSync(path.join(rootDir, 'apps/extension/vite.config.ts'), 'utf8');
  const nativeVite = fs.readFileSync(path.join(rootDir, 'apps/native/vite.config.ts'), 'utf8');
  const headerSource = fs.readFileSync(
    path.join(rootDir, 'packages/common/src/components/Header.tsx'),
    'utf8'
  );

  assert.match(extVite, /__AIRREST_VERSION__:\s*JSON\.stringify\(pkg\.version\)/);
  assert.match(nativeVite, /__AIRREST_VERSION__:\s*JSON\.stringify\(pkg\.version\)/);
  assert.match(headerSource, /formatAppVersionBadge\(getAppVersion\(\)\)/);
  assert.match(headerSource, /\{versionBadge\}/);
});
