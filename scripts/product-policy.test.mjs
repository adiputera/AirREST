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

test('injected policies are canonicalized and inconsistent or malformed capabilities are rejected', () => {
  const { createProductPolicy, validateProductPolicy } = loadProductPolicy();
  const injected = { edition: 'cloud', workspace: { offline: false, cloud: true } };
  const validated = validateProductPolicy(injected);
  assert.equal(validated, createProductPolicy('cloud'));
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated.workspace));
  injected.workspace.offline = true;
  assert.equal(validated.workspace.offline, false);
  for (const policy of [null, {}, { edition: 'unknown', workspace: {} }, { edition: 'cloud', workspace: { offline: true, cloud: true } }, { edition: 'full', workspace: { offline: 'true', cloud: true } }]) {
    assert.throws(() => validateProductPolicy(policy), /invalid/i);
  }
  assert.throws(() => createProductPolicy('unknown'), /unsupported/i);
});

test('workspace chooser renders only modes allowed by the active product', () => {
  const source = fs.readFileSync(new URL('../packages/common/src/components/ModeSelectorModal.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  const react = { __esModule: true, default: { createElement: (type, props, ...children) => ({ type, props, children }) } };
  const { createProductPolicy } = loadProductPolicy();
  const render = (edition) => {
    const modules = { react, 'lucide-react': {}, '../context': { useProductPolicy: () => createProductPolicy(edition) },
      '../store/useApiStore': { useApiStore: (selector) => selector({ workspaceMode: edition === 'offline' ? 'offline' : 'cloud', setWorkspaceMode() {} }) },
      '../lib/backNavigation': { useBackHandler() {} } };
    const exports = {};
    vm.runInNewContext(compiled, { exports, require: (id) => modules[id] || {} });
    return JSON.stringify(exports.ModeSelectorModal({ isOpen: true, onClose() {}, onSelectCloud() {} }));
  };
  assert.doesNotMatch(render('cloud'), /Offline Mode \(Local-First\)/);
  assert.match(render('cloud'), /Self-Hosted Sync Mode/);
  assert.doesNotMatch(render('offline'), /Self-Hosted Sync Mode/);
  assert.match(render('full'), /Offline Mode \(Local-First\)/);
  assert.match(render('full'), /Self-Hosted Sync Mode/);
});
