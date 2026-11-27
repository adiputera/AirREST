import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadStorage(transactionOutcome) {
  const source = fs.readFileSync(new URL('../packages/common/src/lib/storage.ts', import.meta.url), 'utf8');
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
  }, { filename: 'packages/common/src/lib/storage.ts' });
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

test('serializes concurrent appStorage.setItem writes in FIFO order even when navigator.locks is unavailable', async () => {
  const source = fs.readFileSync(new URL('../packages/common/src/lib/storage.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const idbData = new Map();
  const localData = new Map();
  let getCallCount = 0;

  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const tx = {};
      tx.objectStore = () => ({
        get: (key) => {
          const callIndex = ++getCallCount;
          const request = {};
          // Delay first read longer than second if they raced without an in-process lock
          const delayMs = callIndex === 1 ? 15 : 1;
          setTimeout(() => {
            request.result = idbData.get(key);
            request.onsuccess?.();
          }, delayMs);
          return request;
        },
        put: (val, key) => {
          const request = {};
          queueMicrotask(() => {
            idbData.set(key, val);
            request.onsuccess?.();
            tx.oncomplete?.();
          });
          return request;
        },
        delete: (key) => {
          const request = {};
          queueMicrotask(() => {
            idbData.delete(key);
            request.onsuccess?.();
            tx.oncomplete?.();
          });
          return request;
        },
      });
      return tx;
    },
  };

  const indexedDB = {
    open: () => {
      const request = { result: db };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };

  const localStorage = {
    getItem: (key) => (localData.has(key) ? localData.get(key) : null),
    setItem: (key, val) => {
      localData.set(key, val);
    },
  };

  const exports = {};
  vm.runInNewContext(
    compiled,
    {
      exports,
      indexedDB,
      localStorage,
      navigator: {}, // non-secure HTTP context where navigator.locks is undefined
      console,
      Promise,
      Error,
      queueMicrotask,
      setTimeout,
    },
    { filename: 'packages/common/src/lib/storage.ts' }
  );

  await Promise.all([
    exports.appStorage.setItem('air-rest-storage', '{"collections":["first"]}'),
    exports.appStorage.setItem('air-rest-storage', '{"collections":["first","second"]}'),
  ]);

  const finalValue = await exports.appStorage.getItem('air-rest-storage');
  assert.equal(finalValue, '{"collections":["first","second"]}');
});

test('STU-01: evicts stale localStorage copy if IndexedDB succeeds and localStorage throws QuotaExceededError', async () => {
  const source = fs.readFileSync(new URL('../packages/common/src/lib/storage.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const idbData = new Map();
  const localData = new Map([['air-rest-storage', 'stale-old-data']]);

  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const tx = {};
      tx.objectStore = () => ({
        get: (key) => {
          const request = {};
          queueMicrotask(() => {
            request.result = idbData.get(key);
            request.onsuccess?.();
          });
          return request;
        },
        put: (val, key) => {
          const request = {};
          queueMicrotask(() => {
            idbData.set(key, val);
            request.onsuccess?.();
            tx.oncomplete?.();
          });
          return request;
        },
        delete: (key) => {
          const request = {};
          queueMicrotask(() => {
            idbData.delete(key);
            request.onsuccess?.();
            tx.oncomplete?.();
          });
          return request;
        },
      });
      return tx;
    },
  };

  const indexedDB = {
    open: () => {
      const request = { result: db };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };

  const localStorage = {
    getItem: (key) => (localData.has(key) ? localData.get(key) : null),
    setItem: () => {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    },
    removeItem: (key) => {
      localData.delete(key);
    },
  };

  const exports = {};
  vm.runInNewContext(
    compiled,
    {
      exports,
      indexedDB,
      localStorage,
      navigator: {},
      console,
      Promise,
      Error,
      queueMicrotask,
      setTimeout,
    },
    { filename: 'packages/common/src/lib/storage.ts' }
  );

  await exports.appStorage.setItem('air-rest-storage', '{"collections":["fresh-large-payload"]}');
  assert.equal(localData.has('air-rest-storage'), false, 'stale localStorage copy must be evicted on QuotaExceededError');
  const readBack = await exports.appStorage.getItem('air-rest-storage');
  assert.equal(readBack, '{"collections":["fresh-large-payload"]}');
});
