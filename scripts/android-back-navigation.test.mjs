import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadNavigation() {
  const source = fs.readFileSync(new URL('../packages/common/src/lib/backNavigation.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: () => ({}) });
  return exports;
}

test('Back closes the topmost overlay before the drawer and only then falls through', () => {
  const { registerBackHandler, dispatchBack } = loadNavigation();
  const calls = [];
  const removeDrawer = registerBackHandler(() => calls.push('drawer'), 10);
  const removeDialog = registerBackHandler(() => calls.push('dialog'), 20);
  const removeConfirm = registerBackHandler(() => calls.push('confirm'), 30);
  assert.equal(dispatchBack(), true);
  removeConfirm();
  assert.equal(dispatchBack(), true);
  removeDialog();
  assert.equal(dispatchBack(), true);
  removeDrawer();
  assert.equal(dispatchBack(), false);
  assert.deepEqual(calls, ['confirm', 'dialog', 'drawer']);
});

test('Equal priority uses the most recently opened overlay and cleanup is idempotent', () => {
  const { registerBackHandler, dispatchBack } = loadNavigation();
  const calls = [];
  const removeFirst = registerBackHandler(() => calls.push('first'), 20);
  const removeSecond = registerBackHandler(() => calls.push('second'), 20);
  dispatchBack();
  removeSecond();
  removeSecond();
  dispatchBack();
  removeFirst();
  assert.deepEqual(calls, ['second', 'first']);
});

test('A busy overlay consumes Back without invoking a lower handler', () => {
  const { registerBackHandler, dispatchBack } = loadNavigation();
  let closed = false;
  registerBackHandler(() => { closed = true; }, 10);
  registerBackHandler(() => {}, 30);
  assert.equal(dispatchBack(), true);
  assert.equal(closed, false);
});
