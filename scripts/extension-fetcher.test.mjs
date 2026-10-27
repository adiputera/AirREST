import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function loadFetcher(fetchImpl, hostPermissionResult = null) {
  const source = fs.readFileSync(new URL('../extension/src/lib/fetcher.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (id) => id === '@/lib/blobManager'
      ? { trackBlobUrl: (url) => url }
      : id === '@/lib/hostPermissions'
        ? { hasHostPermission: async () => hostPermissionResult }
      : require(id),
    fetch: fetchImpl,
    Response,
    Blob,
    FormData,
    URL,
    URLSearchParams,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    AbortController,
    performance,
    setTimeout,
    clearTimeout,
    console,
  }, { filename: 'extension/src/lib/fetcher.ts' });
  return exports;
}

function binaryRequest() {
  return {
    id: 'request-1',
    name: 'Upload',
    method: 'POST',
    url: 'https://example.com/upload',
    params: [],
    headers: [],
    auth: { type: 'none' },
    bodyType: 'binary',
    bodyContent: '',
    createdAt: 1,
    updatedAt: 1,
  };
}

test('blocks a restored binary attachment instead of sending an object body', () => {
  const { prepareRequest } = loadFetcher(async () => new Response());
  const request = {
    ...binaryRequest(),
    bodyBinaryFile: { name: 'report.csv', size: 32, type: 'text/csv', needsReselection: true },
  };

  assert.throws(() => prepareRequest(request), /report\.csv.*selected again/i);
});

test('does not require a disabled multipart file row', () => {
  const { prepareRequest } = loadFetcher(async () => new Response());
  const request = {
    ...binaryRequest(),
    bodyType: 'form-data',
    bodyFormData: [{ id: 'field-1', key: 'archive', value: 'archive.zip', type: 'file', enabled: false, needsReselection: true }],
  };

  const prepared = prepareRequest(request);
  assert.ok(prepared.finalBody instanceof FormData);
});

test('stops a streamed response once it exceeds the 10 MiB cap', async () => {
  const limit = 10 * 1024 * 1024;
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(limit));
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const { executeApiRequest } = loadFetcher(async () => new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  }));

  const response = await executeApiRequest({ ...binaryRequest(), method: 'GET', bodyType: 'none' });

  assert.equal(response.failureKind, 'response_too_large');
  assert.equal(response.statusText, 'Response Too Large');
  assert.equal(cancelled, true);
});

test('returns a distinct cancellation response', async () => {
  const { executeApiRequest } = loadFetcher((_url, options) => new Promise((_, reject) => {
    if (options.signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const controller = new AbortController();
  const pending = executeApiRequest({ ...binaryRequest(), method: 'GET', bodyType: 'none' }, {}, controller.signal);
  controller.abort();

  const response = await pending;
  assert.equal(response.failureKind, 'cancelled');
  assert.equal(response.statusText, 'Request Cancelled');
});

test('reports withheld host access before starting fetch', async () => {
  let fetchCalls = 0;
  const { executeApiRequest } = loadFetcher(async () => {
    fetchCalls += 1;
    return new Response();
  }, false);

  const response = await executeApiRequest({ ...binaryRequest(), method: 'GET', bodyType: 'none' });
  assert.equal(fetchCalls, 0);
  assert.equal(response.failureKind, 'host_permission');
  assert.equal(response.statusText, 'Host Permission Required');
});
