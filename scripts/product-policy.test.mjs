import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadProductPolicy() {
  const source = fs.readFileSync(new URL('../packages/common/src/productPolicy.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, Object }, { filename: 'packages/common/src/productPolicy.ts' });
  return exports;
}

test('should preserve offline-only capabilities for the offline policy', () => {
  const { createProductPolicy } = loadProductPolicy();

  const policy = createProductPolicy('offline');

  assert.equal(policy.edition, 'offline');
  assert.equal(policy.workspace.offline, true);
  assert.equal(policy.workspace.cloud, false);
});

test('should preserve mixed local and cloud capabilities for the full policy', () => {
  const { createProductPolicy } = loadProductPolicy();

  const policy = createProductPolicy('full');

  assert.equal(policy.edition, 'full');
  assert.equal(policy.workspace.offline, true);
  assert.equal(policy.workspace.cloud, true);
});

test('should expose cloud-only capabilities without changing the shared Studio', () => {
  const { createProductPolicy } = loadProductPolicy();

  const policy = createProductPolicy('cloud');

  assert.equal(policy.edition, 'cloud');
  assert.equal(policy.workspace.offline, false);
  assert.equal(policy.workspace.cloud, true);
});

test('should reject an unsupported product edition at the configuration boundary', () => {
  const { parseProductEdition } = loadProductPolicy();

  assert.equal(parseProductEdition('offline'), 'offline');
  assert.equal(parseProductEdition('full'), 'full');
  assert.equal(parseProductEdition('cloud'), 'cloud');
  assert.throws(() => parseProductEdition('unknown'), /unsupported product edition/i);
});
