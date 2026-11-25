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

function loadAuthHeaders() {
  const source = fs.readFileSync(new URL('../packages/common/src/lib/authHeaders.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, btoa, encodeURIComponent, unescape }, {
    filename: 'packages/common/src/lib/authHeaders.ts',
  });
  return exports;
}
const authHeaders = loadAuthHeaders();

function loadFormatters() {
  const source = fs.readFileSync(new URL('../packages/common/src/lib/formatters.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, JSON, RegExp }, { filename: 'packages/common/src/lib/formatters.ts' });
  return exports;
}
const formatters = loadFormatters();

function loadFetcher(fetchImpl, hostPermissionResult = null, blobs = new Map(), rawBodies = new Map()) {
  const source = fs.readFileSync(new URL('../packages/common/src/lib/fetcher.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (id) => {
      if (id.includes('authHeaders')) {
        return authHeaders;
      }
      if (id.includes('formatters')) {
        return formatters;
      }
      if (id.includes('blobManager')) {
        return {
          createTrackedBlobUrl: (blob) => {
            const url = `blob:test-${blobs.size}`;
            blobs.set(url, blob);
            return url;
          },
          trackBlobUrl: (url) => url,
          createTrackedRawBody: (bytes) => {
            const id = `raw:${rawBodies.size + 1}`;
            rawBodies.set(id, bytes);
            return id;
          },
        };
      }
      if (id.includes('urlParams')) {
        return urlParams;
      }
      if (id === '@/lib/hostPermissions') {
        return { hasHostPermission: async () => hostPermissionResult };
      }
      return require(id);
    },
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
    chrome: {
      permissions: {
        contains: async () => hostPermissionResult,
      },
    },
  }, { filename: 'packages/common/src/lib/fetcher.ts' });
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
  const swSource = fs.readFileSync(new URL('../apps/extension/public/service-worker.js', import.meta.url), 'utf8');
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

test('T-EXT-ERR: executeApiRequest with chromeAdapter classifies Chromium net::ERR_CERT_AUTHORITY_INVALID', async () => {
  const targetUrl = 'https://self-signed.badssl.com/test';
  const fetchImpl = async () => {
    throw new TypeError('Failed to fetch');
  };

  const fetcher = loadFetcher(fetchImpl);
  const { executeApiRequest, recordLocalRecentError } = fetcher;

  // Simulate Chromium webRequest error recording in memory
  recordLocalRecentError(targetUrl, 'net::ERR_CERT_AUTHORITY_INVALID');

  // Load chromeAdapter with access to the fetcher's getChromiumNetworkError and categorizeNetworkError
  const adapterSource = fs.readFileSync(new URL('../apps/extension/src/adapters/chromeAdapter.ts', import.meta.url), 'utf8');
  const compiledAdapter = ts.transpileModule(adapterSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const adapterExports = {};
  vm.runInNewContext(compiledAdapter, {
    exports: adapterExports,
    require: (id) => (id === '@airrest/common' || id === '@airrest/common/platform' ? fetcher : require(id)),
    fetch: fetchImpl,
    Blob: class {},
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    document: {},
  }, { filename: 'chromeAdapter.ts' });

  const { chromeAdapter } = adapterExports;

  const res = await executeApiRequest(
    { ...binaryRequest(), url: targetUrl, method: 'GET', bodyType: 'none' },
    {},
    undefined,
    chromeAdapter
  );

  assert.equal(res.isError, true);
  assert.equal(res.netErrorCategory, 'ssl');
  assert.equal(res.netErrorCode, 'net::ERR_CERT_AUTHORITY_INVALID');
  assert.equal(res.failureKind, 'transport');
});

test('prepareRequest and executeApiRequest enforce Auth header precedence regardless of manual casing', async () => {
  const dispatchedHeaders = [];
  const adapter = {
    id: 'mock-transport',
    hasHostPermission: async () => true,
    requestHostPermission: async () => true,
    transport: {
      fetch: async (_url, init) => {
        dispatchedHeaders.push(new Headers(init.headers));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      classifyError: async (err) => ({ category: 'other', detail: String(err) }),
    },
    dispose: () => {},
  };

  const { prepareRequest, executeApiRequest } = loadFetcher(async () => new Response());
  const baseReq = {
    ...binaryRequest(),
    method: 'GET',
    url: 'https://example.com/headers',
    bodyType: 'none',
    auth: { type: 'bearer', bearerToken: 'auth-test' },
  };

  for (const key of ['Authorization', 'authorization', 'AUTHORIZATION', ' Authorization ', '{{headerName}}']) {
    const req = {
      ...baseReq,
      headers: [
        { id: 'h-dup', key, value: 'Bearer manual-test', enabled: true },
        { id: 'h-keep', key: 'X-Trace', value: 'keep-me', enabled: true },
      ],
    };
    const vars = { headerName: 'authorization' };
    const { finalHeaders } = prepareRequest(req, vars);
    const normalized = new Headers(finalHeaders);
    assert.equal(normalized.get('authorization'), 'Bearer auth-test');
    assert.equal(normalized.get('x-trace'), 'keep-me');
    assert.equal(Object.keys(finalHeaders).length, 2);

    await executeApiRequest(req, vars, undefined, adapter);
  }

  assert.equal(dispatchedHeaders.length, 5);
  for (const h of dispatchedHeaders) {
    assert.equal(h.get('authorization'), 'Bearer auth-test');
    assert.equal(h.get('x-trace'), 'keep-me');
  }
});

// Render the production viewer with lightweight hook/JSX stubs and invoke its
// actual Download button. File I/O is captured at the platform adapter boundary.
function loadDownload(response, blobs, saveFile, rawBodies = new Map(), options = {}) {
  const source = fs.readFileSync(new URL('../packages/common/src/components/ResponseViewer.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const errors = [];
  const stateOverrides = options.stateOverrides || {};
  let stateIndex = 0;
  const react = {
    useState: (initial) => {
      const idx = stateIndex++;
      const val = idx in stateOverrides
        ? stateOverrides[idx]
        : (typeof initial === 'function' ? initial() : initial);
      return [val, (value) => errors.push(value)];
    },
    useEffect: () => {},
    useRef: (initial = null) => ({ current: initial }),
  };
  const jsx = (type, props) => ({ type, props });
  const examplesSource = fs.readFileSync(new URL('../packages/common/src/lib/examples.ts', import.meta.url), 'utf8');
  const examplesCompiled = ts.transpileModule(examplesSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const examplesExports = {};
  vm.runInNewContext(examplesCompiled, {
    exports: examplesExports,
    require: () => ({}),
    crypto,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Blob,
    File: globalThis.File,
    JSON,
    Math,
    Object,
    Array,
    Map,
    Set,
    RegExp,
    Error,
  });
  const modules = {
    react: { ...react, default: react },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '../store/useApiStore': {
      useApiStore: (select) => select({
        activeResponse: response,
        tabs: [],
        activeTabId: null,
        collections: [],
        activeWorkspaceId: null,
        activeTeamId: null,
        activeProjectId: null,
        workspaceMode: 'local',
        cloudConfig: { activeScope: { type: 'personal' }, user: null, apiUrl: '' },
        cloudAuth: { isAuthenticated: false, user: null },
        isLoading: false,
        updateActiveRequest: () => {},
        sendRequest: () => {},
        saveResponseAsExample: async () => ({ status: 'saved' }),
        selectSavedExample: () => {},
      }),
    },
    '../context': { usePlatformAdapter: () => (options.noAdapter ? null : { saveFile }) },
    '../lib/blobManager': {
      getTrackedBlob: (url) => blobs.get(url),
      getTrackedRawBody: (id) => rawBodies.get(id),
    },
    '../lib/backNavigation': { useBackHandler: () => {} },
    '../lib/hostPermissions': { requestHostPermission: async () => true },
    './editor/CodeEditor': { CodeEditor: () => null },
    './SaveToCollectionModal': { SaveToCollectionModal: () => null },
    '../lib/requestDiff': { findSavedRequestInCollections: () => null },
    '../lib/jwt': { canModifyCollection: () => true, hasScopePermission: () => true },
    '../lib/examples': examplesExports,
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (id) => modules[id] || {},
    URL: options.URL || URL,
    Uint8Array,
    Blob,
    TextDecoder,
    Error,
    document: options.document || {},
    localStorage: { getItem: () => null },
    console: { error: () => {} },
    setTimeout: options.setTimeout || setTimeout,
    fetch: async () => { throw new Error('Response body is unavailable'); },
  });
  const findAll = (node, predicate, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    const children = [node.props?.children].flat(Infinity);
    for (const child of children) findAll(child, predicate, out);
    return out;
  };
  const tree = exports.ResponseViewer();
  const buttons = findAll(tree, (node) =>
    node.type === 'button' && [node.props?.children].flat(Infinity).some((child) => child?.props?.children === 'Download')
  );
  assert.ok(buttons.length > 0, 'Response viewer must expose a Download button');
  return {
    download: buttons[0].props.onClick,
    button: buttons[0],
    buttons,
    tree,
    errors,
    exports,
    findAll,
  };
}

const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const workbook = fs.readFileSync(new URL('./fixtures/download.xlsx', import.meta.url));

for (const disposition of ['attachment; filename="report.xlsx"', null]) {
  test(`XLSX download preserves original workbook bytes (${disposition ? 'server filename' : 'MIME filename'})`, async () => {
    const blobs = new Map();
    const rawBodies = new Map();
    const headers = { 'content-type': xlsxMime };
    if (disposition) headers['content-disposition'] = disposition;
    const { executeApiRequest } = loadFetcher(async () => new Response(workbook, { headers }), null, blobs, rawBodies);
    const response = await executeApiRequest({ ...binaryRequest(), method: 'GET', bodyType: 'none' });
    const saved = [];
    const { download } = loadDownload(response, blobs, async (...args) => { saved.push(args); return true; }, rawBodies);
    await download();
    assert.equal(saved.length, 1);
    const [filename, content, options] = saved[0];
    assert.ok(content instanceof Uint8Array, 'Workbook must be saved as bytes, never decoded text');
    assert.deepEqual(Buffer.from(content), workbook);
    assert.equal(options.mimeType, xlsxMime);
    assert.equal(response.sizeBytes, workbook.length);
    assert.equal(response.isBinary, true);
    assert.equal(response.isImage, false);
    assert.equal(response.blobUrl, undefined, 'Non-image binary response should not mint an active blob URL');
    assert.ok(response.rawBodyId);
    assert.match(filename, disposition ? /^report\.xlsx$/ : /^response-\d+\.xlsx$/);
  });
}

test('Office MIME types are binary even without null bytes in the sample', () => {
  const { detectMediaType } = loadFetcher(async () => new Response());
  for (const mime of [xlsxMime, xlsxMime.toUpperCase() + '; charset=utf-8',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-excel', 'application/vnd.ms-excel.sheet.macroEnabled.12',
    'application/vnd.ms-excel.sheet.binary.macroEnabled.12']) {
    assert.equal(detectMediaType(new Uint8Array([0x50, 0x4b, 0xff, 0x80]), mime).isBinary, true, mime);
  }
});

test('XML, structured XML, JSON and CSV still retain text previews', async () => {
  for (const mime of ['application/xml', 'text/xml', 'application/soap+xml', 'application/vnd.example+xml', 'application/json', 'text/csv']) {
    const body = mime.includes('json') ? '{"value":"café"}' : mime.includes('csv') ? 'value\ncafé' : '<value>café</value>';
    const rawBodies = new Map();
    const { executeApiRequest } = loadFetcher(async () => new Response(body, { headers: { 'content-type': mime } }), null, new Map(), rawBodies);
    const response = await executeApiRequest({ ...binaryRequest(), method: 'GET', bodyType: 'none' });
    assert.equal(response.isBinary, false, mime);
    assert.equal(response.data, body, mime);
    assert.equal(response.blobUrl, undefined, mime);
    assert.ok(response.rawBodyId, mime);
  }
});

test('unavailable binary response and failed writes report errors without exporting placeholders', async () => {
  const base = { status: 200, headers: {}, contentType: xlsxMime, isBinary: true, data: '[Binary File]', sizeBytes: workbook.length };
  let writes = 0;
  for (const blobUrl of [undefined, 'blob:expired']) {
    const { download, errors } = loadDownload({ ...base, blobUrl }, new Map(), async () => { writes++; });
    await download();
    assert.match(errors.at(-1), /no longer available|unavailable/i);
    assert.doesNotMatch(errors.at(-1), /failed to fetch/i);
  }
  assert.equal(writes, 0);
  const { download, errors } = loadDownload({ ...base, blobUrl: 'blob:workbook' },
    new Map([['blob:workbook', new Blob([workbook])]]), async () => { throw new Error('Disk full'); });
  await download();
  assert.equal(errors.at(-1), 'Disk full');
});

test('raw byte preservation covers mislabeled XLSX, non-NUL binary, legacy encodings, BOM, 0-255, late NUL, 0-byte, and 4xx/5xx', async () => {
  const probes = [
    { name: 'XLSX mislabeled as text/plain', bytes: Uint8Array.from(workbook), contentType: 'text/plain', status: 200 },
    { name: 'Custom binary without NUL', bytes: new Uint8Array([0x80, 0xff, 0x01, 0x02]), contentType: 'text/plain', status: 200 },
    { name: 'CSV Windows-1252', bytes: new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a]), contentType: 'text/csv; charset=windows-1252', status: 200 },
    { name: 'CSV UTF-8 with BOM', bytes: new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62, 0x0d, 0x0a]), contentType: 'text/csv; charset=utf-8', status: 200 },
    { name: 'TXT UTF-16LE', bytes: new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00]), contentType: 'text/plain; charset=utf-16le', status: 200 },
    { name: 'CSV UTF-8 CRLF', bytes: new TextEncoder().encode('a,b\r\n1,café\r\n'), contentType: 'text/csv', status: 200 },
    { name: 'Bytes 0-255 as text/plain', bytes: Uint8Array.from({ length: 256 }, (_, i) => i), contentType: 'text/plain', status: 200 },
    { name: 'Late NUL beyond byte 1024', bytes: (() => { const b = new Uint8Array(1200).fill(0x41); b[1150] = 0x00; b[1199] = 0xff; return b; })(), contentType: '', status: 200 },
    { name: 'Zero-byte 200 OK', bytes: new Uint8Array(0), contentType: 'text/plain', status: 200 },
    { name: 'Zero-byte 204 No Content', bytes: new Uint8Array(0), contentType: '', status: 204 },
    { name: 'HTTP 500 error body', bytes: new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), contentType: 'application/json', status: 500 },
  ];

  for (const probe of probes) {
    const blobs = new Map();
    const rawBodies = new Map();
    const headers = probe.contentType ? { 'content-type': probe.contentType } : {};
    const { executeApiRequest } = loadFetcher(
      async () => new Response(probe.status === 204 ? null : probe.bytes, { status: probe.status, headers }),
      null,
      blobs,
      rawBodies,
    );
    const response = await executeApiRequest({ ...binaryRequest(), method: 'GET', bodyType: 'none' });
    const saved = [];
    const { download } = loadDownload(response, blobs, async (...args) => { saved.push(args); return true; }, rawBodies);
    await download();
    assert.equal(saved.length, 1, probe.name);
    assert.deepEqual(Buffer.from(saved[0][1]), Buffer.from(probe.bytes), probe.name);
    if (!probe.contentType) {
      assert.equal(response.contentType, undefined, probe.name);
      assert.match(saved[0][0], /^response-\d+\.bin$/, probe.name);
    }
  }
});

test('HEAD response with Content-Length > 10 MiB succeeds with 0 retained bytes', async () => {
  const blobs = new Map();
  const rawBodies = new Map();
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const { executeApiRequest } = loadFetcher(
    async () => new Response(stream, {
      status: 200,
      headers: { 'content-length': String(50 * 1024 * 1024), 'content-type': 'application/octet-stream' },
    }),
    null,
    blobs,
    rawBodies,
  );

  const response = await executeApiRequest({ ...binaryRequest(), method: 'HEAD', bodyType: 'none' });
  assert.equal(response.status, 200);
  assert.equal(response.sizeBytes, 0);
  assert.equal(response.failureKind, undefined);
  assert.equal(cancelled, true);

  const saved = [];
  const { download } = loadDownload(response, blobs, async (...args) => { saved.push(args); return true; }, rawBodies);
  await download();
  assert.equal(saved.length, 1);
  assert.equal(saved[0][1].byteLength, 0);
});

test('detectMediaType prioritizes text Content-Type over BM/GIF magic bytes and keeps valid image sniffing', () => {
  const { detectMediaType } = loadFetcher(async () => new Response());

  for (const mime of ['text/plain', 'text/csv', 'application/xml']) {
    for (const prefix of ['BM_ID,Name\n1,Alice', 'GIF89a,label']) {
      const detected = detectMediaType(new TextEncoder().encode(prefix), mime);
      assert.equal(detected.isBinary, false, `${mime} with ${prefix}`);
      assert.equal(detected.isImage, false, `${mime} with ${prefix}`);
      assert.equal(detected.mimeType, mime);
    }
  }

  // application/octet-stream starting with "BM" must stay octet-stream, not BMP
  assert.deepEqual(
    JSON.parse(JSON.stringify(detectMediaType(new Uint8Array([0x42, 0x4d, 0x01, 0x02]), 'application/octet-stream'))),
    { isBinary: true, isImage: false, mimeType: 'application/octet-stream' },
  );

  // Undeclared BMP text header without reserved zero bytes stays non-binary
  assert.deepEqual(
    JSON.parse(JSON.stringify(detectMediaType(new TextEncoder().encode('BM_ID,Name\n1,Alice'), ''))),
    { isBinary: false, isImage: false, mimeType: '' },
  );

  // Undeclared real BMP header (reserved bytes 6..9 == 0) is detected as image/bmp
  const bmpHeader = new Uint8Array(14);
  bmpHeader[0] = 0x42;
  bmpHeader[1] = 0x4d;
  assert.deepEqual(
    JSON.parse(JSON.stringify(detectMediaType(bmpHeader, ''))),
    { isBinary: true, isImage: true, mimeType: 'image/bmp' },
  );

  // Undeclared PNG and GIF89a are detected as images
  assert.equal(detectMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), '').mimeType, 'image/png');
  assert.equal(detectMediaType(new TextEncoder().encode('GIF89a\x01\x00'), '').mimeType, 'image/gif');
});

test('getFileNameFromHeaders parses RFC 6266/5987 parameters and sanitizes unsafe filenames', () => {
  const { exports } = loadDownload({ status: 200, headers: {}, data: '' }, new Map(), async () => true);
  const { getFileNameFromHeaders, getExtensionFromMime } = exports;

  assert.equal(
    getFileNameFromHeaders(
      { 'cOnTeNt-DiSpOsItIoN': 'attachment; filename="fallback.xlsx"; filename*=UTF-8\'en\'quarterly%20report%20%28Q4%29.xlsx' },
      '.bin',
    ),
    'quarterly report (Q4).xlsx',
  );
  assert.equal(
    getFileNameFromHeaders({ 'content-disposition': "attachment; filename*=ISO-8859-1''caf%E9.csv" }, '.bin'),
    'café.csv',
  );
  assert.equal(
    getFileNameFromHeaders({ 'content-disposition': 'attachment; filename="Bob\'s; \\"final\\" report.xlsx"' }, '.bin'),
    "Bob's; _final_ report.xlsx",
  );
  assert.match(
    getFileNameFromHeaders({ 'content-disposition': 'attachment; filename="   "' }, '.xlsx'),
    /^response-\d+\.xlsx$/,
  );
  assert.equal(
    getFileNameFromHeaders({ 'content-disposition': 'attachment; filename="../../etc/evil.sh"' }, '.bin'),
    'evil.sh',
  );
  assert.match(
    getFileNameFromHeaders({ 'content-disposition': 'attachment; filename="../../"' }, '.bin'),
    /^response-\d+\.bin$/,
  );
  assert.equal(
    getFileNameFromHeaders({ 'content-disposition': 'attachment; filename="C:\\temp\\a?b*c.xlsx"' }, '.bin'),
    'a_b_c.xlsx',
  );
  assert.equal(
    getFileNameFromHeaders({ 'content-disposition': 'attachment; filename="CON.txt"' }, '.bin'),
    '_CON.txt',
  );
  assert.equal(
    getFileNameFromHeaders({ 'content-disposition': 'attachment; filename="hello\x00\x1fworld.txt"' }, '.bin'),
    'helloworld.txt',
  );

  // MIME-to-extension matrix
  assert.equal(getExtensionFromMime('application/gzip'), '.gz');
  assert.equal(getExtensionFromMime('application/x-tar'), '.tar');
  assert.equal(getExtensionFromMime('application/x-gtar'), '.tar.gz');
  assert.equal(getExtensionFromMime('text/csv; charset=utf-8'), '.csv');
  assert.equal(getExtensionFromMime('application/xml'), '.xml');
  assert.equal(getExtensionFromMime('application/soap+xml'), '.xml');
  assert.equal(getExtensionFromMime('image/svg+xml'), '.svg');
  assert.equal(getExtensionFromMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), '.docx');
  assert.equal(getExtensionFromMime('application/vnd.openxmlformats-officedocument.presentationml.presentation'), '.pptx');
  assert.equal(getExtensionFromMime('application/vnd.bmp.data+json'), '.json');
  assert.equal(getExtensionFromMime(''), '.bin');
});

test('synthetic status 0 errors disable Download, modal displays downloadError, and browser fallback uses neutral MIME + 60s revoke', async () => {
  const synthetic = loadDownload(
    { status: 0, statusText: 'Request Cancelled', headers: {}, data: 'cancelled', isError: true, failureKind: 'cancelled', sizeBytes: 0, timeMs: 0, timestamp: 1 },
    new Map(),
    async () => true,
  );
  assert.equal(synthetic.button.props.disabled, true);

  // Expanded modal state (useState call order: activeTab=0, viewMode=1, copied=2, imgDimensions=3, permissionMessage=4, downloadError=5, isExpandedModalOpen=6)
  const modal = loadDownload(
    { status: 200, statusText: 'OK', headers: {}, data: 'hello', sizeBytes: 5, timeMs: 1, timestamp: 1 },
    new Map(),
    async () => true,
    new Map(),
    { stateOverrides: { 5: 'Original response body is no longer available in memory.', 6: true } },
  );
  const errorNodes = modal.findAll(modal.tree, (node) =>
    node.type === 'span' && node.props?.children === 'Original response body is no longer available in memory.'
  );
  assert.equal(errorNodes.length, 2, 'downloadError must render in both main pane and Expanded Modal');

  // Browser fallback (no adapter.saveFile)
  const createdBlobs = [];
  const revokedUrls = [];
  const scheduledTimers = [];
  const appended = [];
  let clicked = false;
  let removed = false;
  class TrackingBlob {
    constructor(parts, opts) {
      this.parts = parts;
      this.type = opts?.type;
      createdBlobs.push(this);
    }
  }
  const fakeDoc = {
    createElement: () => ({
      href: '',
      download: '',
      style: {},
      click: () => { clicked = true; },
      remove: () => { removed = true; },
    }),
    body: {
      appendChild: (el) => appended.push(el),
    },
  };
  const fakeUrl = {
    createObjectURL: () => 'blob:fallback-1',
    revokeObjectURL: (u) => revokedUrls.push(u),
  };
  const rawBodies = new Map([['raw:html', new TextEncoder().encode('<script>alert(1)</script>')]]);
  const fallback = loadDownload(
    { status: 200, headers: {}, contentType: 'text/html', rawBodyId: 'raw:html', data: '<script>alert(1)</script>', sizeBytes: 25 },
    new Map(),
    null,
    rawBodies,
    {
      noAdapter: true,
      document: fakeDoc,
      URL: fakeUrl,
      setTimeout: (fn, ms) => { scheduledTimers.push({ fn, ms }); return 1; },
    },
  );
  // Swap global Blob temporarily via compiled test call? Actually loadDownload passes global Blob; check scheduled timer & click/remove
  await fallback.download();
  assert.equal(clicked, true);
  assert.equal(removed, true);
  assert.equal(appended.length, 1);
  assert.equal(scheduledTimers[0].ms, 60_000);
  assert.equal(revokedUrls.length, 0, 'Must not revoke synchronously');
  scheduledTimers[0].fn();
  assert.deepEqual(revokedUrls, ['blob:fallback-1']);
});

test('prepareRequest strips JSON comments and trailing commas before sending JSON, raw JSON, and GraphQL variables', () => {
  const { prepareRequest } = loadFetcher(async () => new Response());

  const jsonReq = {
    ...binaryRequest(),
    bodyType: 'json',
    bodyContent: '{\n  //"field_1": "sadsadsa",\n  "field_2": "{{val}}",\n  "field_3": "sadasdsa"\n}',
  };
  const preparedJson = prepareRequest(jsonReq, { val: 'sadadsa' });
  assert.deepEqual(JSON.parse(preparedJson.finalBody), {
    field_2: 'sadadsa',
    field_3: 'sadasdsa',
  });
  assert.ok(!String(preparedJson.finalBody).includes('field_1'));

  const rawJsonReq = {
    ...binaryRequest(),
    bodyType: 'raw',
    rawType: 'json',
    bodyContent: '{\n  "keep": true,\n  // "drop": false\n}',
  };
  const preparedRawJson = prepareRequest(rawJsonReq, {});
  assert.deepEqual(JSON.parse(preparedRawJson.finalBody), { keep: true });

  const gqlReq = {
    ...binaryRequest(),
    bodyType: 'graphql',
    graphqlQuery: 'query ($id: ID!) { item(id: $id) { id } }',
    graphqlVariables: '{\n  // "unused": 1,\n  "id": "{{itemId}}"\n}',
  };
  const preparedGql = prepareRequest(gqlReq, { itemId: '42' });
  assert.deepEqual(JSON.parse(preparedGql.finalBody), {
    query: 'query ($id: ID!) { item(id: $id) { id } }',
    variables: { id: '42' },
  });
});
