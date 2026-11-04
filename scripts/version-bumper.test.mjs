import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { updateVersionTargets } from './bump-desktop-version.mjs';

function writeFixture(rootDir, version) {
  const files = {
    'package.json': JSON.stringify({ name: 'airrest', version }),
    'apps/extension/package.json': JSON.stringify({ name: 'airrest-extension', version }),
    'apps/extension/public/manifest.json': JSON.stringify({ manifest_version: 3, version }),
    'apps/hub/package.json': JSON.stringify({ name: 'airrest-hub', version }),
    'apps/native/package.json': JSON.stringify({ name: 'airrest-desktop', version }),
    'apps/native/src-tauri/tauri.conf.json': JSON.stringify({ version }),
    'packages/common/package.json': JSON.stringify({ name: '@airrest/common', version }),
    'apps/native/src-tauri/Cargo.toml': `[package]\nversion = "${version}"\n`,
    'README.md': `[![Version](https://img.shields.io/badge/Version-${version}-blue.svg)](CHANGELOG.md)\n`,
    'packages/common/src/lib/postman.ts': `export const metadata = { _postman_exported_using: 'AirREST/${version}' };\n`,
  };

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}

test('version bumper updates prerelease badge and all release metadata in an isolated fixture', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airrest-version-bumper-'));
  try {
    writeFixture(rootDir, '1.3.5-beta.1');

    updateVersionTargets('1.3.5-beta.2', rootDir);

    const rootPackage = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    const hubPackage = JSON.parse(fs.readFileSync(path.join(rootDir, 'apps/hub/package.json'), 'utf8'));
    assert.equal(rootPackage.version, '1.3.5-beta.2');
    assert.equal(hubPackage.version, '1.3.5-beta.2');
    assert.match(fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8'), /Version-1\.3\.5-beta\.2-blue\.svg/);
    assert.match(fs.readFileSync(path.join(rootDir, 'packages/common/src/lib/postman.ts'), 'utf8'), /AirREST\/1\.3\.5-beta\.2/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
