import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadCoordinator() {
  const source = fs.readFileSync(
    new URL('../packages/common/src/store/asyncOperationCoordinator.ts', import.meta.url),
    'utf8',
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, AbortController }, {
    filename: 'packages/common/src/store/asyncOperationCoordinator.ts',
  });
  return exports;
}

test('session invalidation aborts outstanding work and rejects stale completions', () => {
  const { createAsyncOperationCoordinator } = loadCoordinator();
  let disposed = false;
  const coordinator = createAsyncOperationCoordinator({ isDisposed: () => disposed });
  const operation = coordinator.begin();

  assert.equal(coordinator.isCurrent(operation), true);
  coordinator.invalidate({ session: true });
  assert.equal(operation.controller.signal.aborted, true);
  assert.equal(coordinator.isCurrent(operation), false);

  disposed = true;
  const afterDispose = coordinator.begin();
  assert.equal(afterDispose.controller.signal.aborted, true);
});
