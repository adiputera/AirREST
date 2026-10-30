import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function loadUrlParams() {
  const source = fs.readFileSync(new URL('../packages/common/src/lib/urlParams.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, Math }, { filename: 'packages/common/src/lib/urlParams.ts' });
  return exports;
}
const urlParams = loadUrlParams();

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
      : id === '@/lib/urlParams'
        ? urlParams
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
    Map,
    Date,
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

test('T-S4: rejects requests with non-HTTP(S) schemes before calling fetch', async () => {
  let fetchCalls = 0;
  const { executeApiRequest } = loadFetcher(async () => {
    fetchCalls += 1;
    return new Response();
  }, null);

  for (const url of ['file:///etc/passwd', 'chrome-extension://abc']) {
    const response = await executeApiRequest({ ...binaryRequest(), url, method: 'GET', bodyType: 'none' });
    assert.equal(fetchCalls, 0, `fetch must not be called for ${url}`);
    assert.equal(response.failureKind, 'host_permission');
    assert.equal(response.statusText, 'Host Permission Required');
  }
});

test('T-C2 (C2): bounded memory for recent network errors enforces FIFO eviction and 30s TTL', () => {
  // 1. Test fetcher.ts recordLocalRecentError bounded capacity and FIFO
  const { recordLocalRecentError, localRecentErrors } = loadFetcher(async () => new Response());
  assert.equal(typeof recordLocalRecentError, 'function');
  assert.ok(localRecentErrors instanceof Map);

  localRecentErrors.clear();

  // Insert 250 errors sequentially
  for (let i = 0; i < 250; i++) {
    recordLocalRecentError(`https://example.com/api/item/${i}`, `net::ERR_CONNECTION_REFUSED_${i}`);
  }

  assert.equal(localRecentErrors.size, 100, 'localRecentErrors must be capped at 100 entries');
  assert.equal(localRecentErrors.has('https://example.com/api/item/0'), false, 'Oldest entry 0 must be evicted (FIFO)');
  assert.equal(localRecentErrors.has('https://example.com/api/item/149'), false, 'Old entry 149 must be evicted');
  assert.equal(localRecentErrors.has('https://example.com/api/item/150'), true, 'Entry 150 must be preserved');
  assert.equal(localRecentErrors.has('https://example.com/api/item/249'), true, 'Latest entry 249 must be preserved');

  // Test TTL purge (> 30 seconds)
  const pastTimestamp = Date.now() - 35000;
  for (const [key, val] of localRecentErrors.entries()) {
    val.timestamp = pastTimestamp;
  }
  recordLocalRecentError('https://example.com/api/item/new', 'net::ERR_NEW');
  assert.equal(localRecentErrors.size, 1, 'All expired entries older than 30s must be purged');
  assert.equal(localRecentErrors.has('https://example.com/api/item/new'), true);

  // 2. Test service-worker.js listener bounds capacity
  const swSource = fs.readFileSync(new URL('../extension/public/service-worker.js', import.meta.url), 'utf8');
  let webRequestListener = null;
  const mockChrome = {
    webRequest: {
      onErrorOccurred: {
        addListener: (fn) => { webRequestListener = fn; },
      },
    },
    runtime: {
      onMessage: { addListener: () => {} },
      getURL: () => '',
    },
    action: {
      onClicked: { addListener: () => {} },
    },
    tabs: {
      query: async () => [],
      create: async () => {},
      update: async () => {},
    },
  };

  const swSandbox = {
    chrome: mockChrome,
    Date,
    console,
  };
  vm.createContext(swSandbox);
  vm.runInContext(swSource, swSandbox);

  assert.ok(webRequestListener, 'service-worker.js must register onErrorOccurred listener');

  // Fire 150 errors through service worker listener
  for (let i = 0; i < 150; i++) {
    webRequestListener({
      url: `https://sw.example.com/resource/${i}`,
      error: `net::ERR_RESET_${i}`,
    });
  }

  // Check GET_RECENT_NETWORK_ERROR message handler
  let recordedError = null;
  // Read map size via vm context inspection or trigger message handler
  const messageListeners = [];
  mockChrome.runtime.onMessage.addListener = (fn) => messageListeners.push(fn);
  // Re-run listener query check
  const swExports = vm.runInContext(`
    ({
      size: recentNetworkErrors.size,
      hasOldest: recentNetworkErrors.has('https://sw.example.com/resource/0'),
      hasLatest: recentNetworkErrors.has('https://sw.example.com/resource/149')
    })
  `, swSandbox);

  assert.equal(swExports.size, 100, 'service-worker.js recentNetworkErrors must be capped at 100 entries');
  assert.equal(swExports.hasOldest, false, 'service worker must evict oldest entry (FIFO)');
  assert.equal(swExports.hasLatest, true, 'service worker must preserve latest entry');
});
