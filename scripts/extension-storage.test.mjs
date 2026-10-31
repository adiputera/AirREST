import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadStorage(transactionOutcome) {
  const source = fs.readFileSync(new URL('../apps/extension/src/lib/storage.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const transaction = { error: new Error('transaction aborted') };
      transaction.objectStore = () => ({
        put: () => {
          const request = {};
          queueMicrotask(() => {
            request.onsuccess?.();
            if (transactionOutcome === 'abort') transaction.onabort?.();
            if (transactionOutcome === 'error') transaction.onerror?.();
            if (transactionOutcome === 'complete') transaction.oncomplete?.();
          });
          return request;
        },
        delete: () => {
          const request = {};
          queueMicrotask(() => {
            request.onsuccess?.();
            if (transactionOutcome === 'abort') transaction.onabort?.();
            if (transactionOutcome === 'error') transaction.onerror?.();
            if (transactionOutcome === 'complete') transaction.oncomplete?.();
          });
          return request;
        },
      });
      return transaction;
    },
  };
  const indexedDB = {
    open: () => {
      const request = { result: db };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  vm.runInNewContext(compiled, {
    exports,
    indexedDB,
    console,
    Promise,
    Error,
    queueMicrotask,
  }, { filename: 'apps/extension/src/lib/storage.ts' });
  return exports;
}

test('should reject an IndexedDB write when its transaction aborts after request success', async () => {
  const storage = loadStorage('abort');

  await assert.rejects(storage.idbSet('key', 'value'), /transaction aborted/);
});

test('should resolve IndexedDB writes and deletes only after transaction completion', async () => {
  const storage = loadStorage('complete');

  await storage.idbSet('key', 'value');
  await storage.idbDel('key');
});

test('selects the newest committed envelope and honors deletion tombstones', () => {
  const storage = loadStorage('complete');
  const older = JSON.stringify({ version: 1, timestamp: 10, revision: 1, writerId: 'first', data: 'old' });
  const newer = JSON.stringify({ version: 1, timestamp: 5, revision: 2, writerId: 'second', data: 'new' });
  const tombstone = JSON.stringify({ version: 1, timestamp: 20, revision: 3, writerId: 'third', deleted: true });

  assert.equal(storage.selectStoredValue([newer, older]), 'new');
  assert.equal(storage.selectStoredValue([older, tombstone]), null);
});
