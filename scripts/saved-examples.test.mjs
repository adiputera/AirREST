import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function loadModuleGraph() {
  const cache = new Map();
  const globals = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    Headers,
    Response,
    Request,
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    performance,
    Blob,
    File: globalThis.File,
    FormData: globalThis.FormData,
    atob,
    btoa,
    crypto: globalThis.crypto,
    fetch: async () => {
      throw new Error('unexpected global fetch');
    },
    Date,
    Math,
    JSON,
    Object,
    Array,
    Uint8Array,
    Map,
    Set,
    RegExp,
    Error,
    Promise,
    Symbol,
    window: {
      addEventListener() { },
      removeEventListener() { },
      localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    },
    document: {
      documentElement: { classList: { toggle() { }, add() { }, remove() { } }, setAttribute() { }, removeAttribute() { }, style: {} },
    },
    navigator: { platform: 'Linux', clipboard: { writeText: async () => { } } },
  };

  function load(relPath, overrides = {}) {
    const absPath = path.resolve(ROOT, relPath);
    if (!Object.keys(overrides).length && cache.has(absPath)) {
      return cache.get(absPath);
    }
    const exports = {};
    if (!Object.keys(overrides).length) {
      cache.set(absPath, exports);
    }
    const source = fs.readFileSync(absPath, 'utf8').replaceAll('import.meta.env', '({ VITE_APP_EDITION: "full" })');
    const compiled = ts.transpileModule(source, {
      fileName: absPath,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    }).outputText;

    const localRequire = (id) => {
      if (id in overrides) return overrides[id];
      if (!id.startsWith('.')) return require(id);
      const base = path.resolve(path.dirname(absPath), id);
      const resolved = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((candidate) => {
        try {
          return fs.statSync(candidate).isFile();
        } catch {
          return false;
        }
      });
      if (!resolved) throw new Error(`Cannot resolve ${id} from ${relPath}`);
      return load(path.relative(ROOT, resolved), {});
    };

    vm.runInNewContext(compiled, { ...globals, exports, require: localRequire }, { filename: absPath });
    return exports;
  }

  return { load };
}

function createStoreHarness({ cloudOverrides = {}, executeApiRequest, customStorage, initialPersistedState } = {}) {
  const memory = new Map();
  if (initialPersistedState) {
    memory.set('air-rest-storage', JSON.stringify({ state: initialPersistedState, version: 0 }));
  }
  const storage = customStorage || {
    getItem: async (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: async (k, v) => {
      memory.set(k, v);
    },
    removeItem: async (k) => {
      memory.delete(k);
    },
  };

  const cache = new Map();
  const noop = () => { };
  const modules = {
    storage: {
      appStorage: storage,
      setItemInAllPersistenceCopies: async (k, v) => storage.setItem(k, v),
      onStorageCommit: () => noop,
    },
    nativeCredentials: {
      getNativeCredentialScope: (c) => (c?.apiUrl && c?.user?.id ? { apiUrl: c.apiUrl, userId: c.user.id } : null),
    },
    blobManager: {
      revokeBlobUrl: noop,
      revokeBlobUrls: noop,
      releaseRawBody: noop,
      releaseRawBodies: noop,
      evictRawBodiesToBudget: () => [],
      createTrackedBlobUrl: () => 'blob:mock',
      createTrackedRawBody: () => 'raw-id-1',
    },
    fetcher: {
      executeApiRequest: executeApiRequest || (async () => ({
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        data: '{"ok":true}',
        timeMs: 12,
        sizeBytes: 11,
      })),
    },
    scriptRunner: {
      executePreRequestScript: async (req) => ({ success: true, request: req, environment: {}, variables: {} }),
      executePostResponseScript: async () => ({ success: true, environment: {}, variables: {} }),
    },
    hostPermissions: {
      requestHostPermission: async () => true,
      hasHostPermission: async () => true,
    },
    theme: { applyTheme: noop },
  };

  const realGraph = loadModuleGraph();
  const realCloudApi = realGraph.load('packages/common/src/lib/cloudApi.ts');

  const cloudApiStub = {
    ...realCloudApi,
    CloudApiError: realCloudApi.CloudApiError,
    registerTokenRefreshCallback: noop,
    registerAuthEvictedCallback: noop,
    fetchUserWorkspaces: async () => [],
    fetchUserTeams: async () => [],
    fetchTeamProjects: async () => [],
    fetchScopeCollections: async () => [],
    fetchCollectionById: async () => {
      throw new Error('fetchCollectionById not mocked');
    },
    fetchScopeEnvironments: async () => [],
    fetchFeaturePolicy: async () => ({
      flags: { 'collection.move': true, 'collection.delete': true, 'collection.export': true },
      capabilities: { saved_examples: true },
      revision: 1,
      updated_at: '2026-11-25T00:00:00Z',
    }),
    patchScopeItemExamples: async () => {
      throw new Error('patchScopeItemExamples not mocked');
    },
    fetchScopeItem: async () => {
      throw new Error('fetchScopeItem not mocked');
    },
    fetchScopeCollectionExamples: async () => ({ collection_id: '', collection_version: 1, items: [], has_more: false }),
    replaceScopeCollection: async () => ({ collection_id: '', version: 2, replayed: false }),
    createScopeItem: async (_api, _tok, item) => ({ ...item, id: item.id || 'srv-item', version: 1 }),
    updateScopeItem: async (_api, _tok, id, item, baseVer) => ({ ...item, id, version: (baseVer || 1) + 1 }),
    deleteScopeItem: async () => ({ message: 'deleted' }),
    batchImportToScope: async (_api, _tok, payload) => ({
      imported: payload.collections?.length || 0,
      imported_collections: payload.collections?.length || 0,
      imported_environments: payload.environments?.length || 0,
      imported_examples: 0,
      item_versions: {},
    }),
    ...cloudOverrides,
  };

  function loadStoreFile(relPath) {
    const absPath = path.resolve(ROOT, relPath);
    if (cache.has(absPath)) return cache.get(absPath);
    const exports = {};
    cache.set(absPath, exports);
    const src = fs.readFileSync(absPath, 'utf8').replaceAll('import.meta.env', '({ VITE_APP_EDITION: "full" })');
    const compiled = ts.transpileModule(src, {
      fileName: absPath,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;

    const resolveMod = (id) => {
      if (!id.startsWith('.')) return require(id);
      const baseName = id.split('/').at(-1);
      if (baseName === 'cloudApi') return cloudApiStub;
      if (baseName in modules) return modules[baseName];
      const base = path.resolve(path.dirname(absPath), id);
      const resolved = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((c) => {
        try {
          return fs.statSync(c).isFile();
        } catch {
          return false;
        }
      });
      if (!resolved) throw new Error(`Cannot resolve ${id} from ${relPath}`);
      return loadStoreFile(path.relative(ROOT, resolved));
    };

    vm.runInNewContext(
      compiled,
      {
        exports,
        require: resolveMod,
        console,
        crypto: globalThis.crypto,
        Date,
        JSON,
        Math,
        Object,
        Array,
        Map,
        Set,
        RegExp,
        Error,
        Promise,
        Symbol,
        AbortController,
        AbortSignal,
        Headers,
        Response,
        Request,
        Blob,
        File: globalThis.File,
        setTimeout,
        clearTimeout,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
      },
      { filename: absPath },
    );
    return exports;
  }

  const storeMod = loadStoreFile('packages/common/src/store/useApiStore.ts');
  const examplesMod = loadStoreFile('packages/common/src/lib/examples.ts');
  return { storeMod, examplesMod, cloudApiStub, storage, memory };
}

test('Saved Examples: classifier, charset validation, HTTP reason phrase fallback, and request snapshots', async () => {
  const { load } = loadModuleGraph();
  const examples = load('packages/common/src/lib/examples.ts');
  const fetcher = load('packages/common/src/lib/fetcher.ts', {
    './blobManager': { createTrackedBlobUrl: () => 'blob:mock', createTrackedRawBody: () => 'raw:mock' },
  });

  // Allowed text formats & JSON scalar support
  for (const [ct, body, wantLang] of [
    ['application/json; charset=utf-8', '{"a":1}', 'json'],
    ['application/json', '42', 'json'],
    ['application/problem+json', '{"title":"Bad"}', 'json'],
    ['application/xml', '<root><ok/></root>', 'xml'],
    ['application/xml', '<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>', 'xml'],
    ['text/html; charset=utf-8', '<!doctype html><html><body>Hi</body></html>', 'html'],
    ['application/xhtml+xml', '<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>', 'html'],
    ['application/json, application/problem+json', '{"ok":true}', 'json'],
  ]) {
    const res = examples.evaluateResponseExampleEligibility({
      status: 404,
      statusText: '',
      headers: { 'Content-Type': ct },
      data: body,
      timeMs: 5,
      sizeBytes: body.length,
    });
    assert.equal(res.eligible, true, `Expected eligible for ${ct}`);
    assert.equal(res.previewLanguage, wantLang);
  }

  // Conflicting MIME header languages must be rejected
  {
    const conflict = examples.evaluateResponseExampleEligibility({
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json, text/html' },
      data: '{"ok":true}',
      timeMs: 1,
      sizeBytes: 11,
    });
    assert.equal(conflict.eligible, false);
  }

  // Rejects disallowed MIME, BOM-only, NUL byte, malformed content, pre-request script error, image/svg+xml
  for (const badRes of [
    { status: 0, headers: { 'content-type': 'application/json' }, data: '{}', failureKind: 'network' },
    { status: 200, headers: { 'content-type': 'application/json' }, data: '{}', scriptErrorStage: 'pre-request' },
    { status: 200, headers: { 'content-type': 'image/svg+xml' }, data: '<svg/>' },
    { status: 200, headers: { 'content-type': 'text/plain' }, data: 'hello' },
    { status: 200, headers: { 'content-type': 'application/json' }, data: '\uFEFF   ' },
    { status: 200, headers: { 'content-type': 'application/json' }, data: '"abc\u0000def"' },
    { status: 200, headers: { 'content-type': 'application/xml' }, data: '<root><unclosed>' },
    { status: 200, headers: { 'content-type': 'application/xhtml+xml' }, data: '<html><body><br></body></html>' },
    { status: 200, headers: { 'content-type': 'application/json' }, data: '{}', hasDecodingError: true },
  ]) {
    const res = examples.evaluateResponseExampleEligibility({ timeMs: 1, sizeBytes: 1, statusText: '', ...badRes });
    assert.equal(res.eligible, false, `Expected ineligible for ${JSON.stringify(badRes.headers)} / ${badRes.status}`);
  }

  // Mislabeled JPEG magic bytes -> detected as binary/image -> ineligible;
  // Mislabeled invalid UTF-8 JSON bytes -> executeApiRequest sets hasDecodingError=true -> ineligible
  {
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const jpegResp = await fetcher.executeApiRequest(
      { id: 'r-jpg', name: 'Jpg', method: 'GET', url: 'https://example.com/jpg', params: [], headers: [], bodyType: 'none', bodyContent: '' },
      {},
      undefined,
      {
        hasHostPermission: async () => true,
        transport: {
          fetch: async () =>
            new Response(jpegBytes, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }),
          classifyError: () => ({ category: 'unknown', message: 'error' }),
        },
      },
    );
    assert.equal(jpegResp.hasDecodingError, true, JSON.stringify(jpegResp));
    assert.equal(examples.evaluateResponseExampleEligibility(jpegResp).eligible, false);

    const invalidUtf8JsonBytes = new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
    const badCharsetResp = await fetcher.executeApiRequest(
      { id: 'r-utf8', name: 'Utf8', method: 'GET', url: 'https://example.com/utf8', params: [], headers: [], bodyType: 'none', bodyContent: '' },
      {},
      undefined,
      {
        hasHostPermission: async () => true,
        transport: {
          fetch: async () =>
            new Response(invalidUtf8JsonBytes, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }),
          classifyError: () => ({ category: 'unknown', message: 'error' }),
        },
      },
    );
    assert.equal(badCharsetResp.hasDecodingError, true);
    assert.equal(examples.evaluateResponseExampleEligibility(badCharsetResp).eligible, false);
  }

  // HTTP/2 empty statusText falls back to standard RFC reason phrase (including 3xx)
  assert.equal(examples.resolveHttpReasonPhrase(404, ''), 'Not Found');
  assert.equal(examples.resolveHttpReasonPhrase(304, 'Error'), 'Not Modified');
  assert.equal(examples.buildDefaultExampleName(201, ''), '201 Created');
  const http2RedirectResp = await fetcher.executeApiRequest(
    { id: 'r-307', name: '307', method: 'GET', url: 'https://example.com/307', params: [], headers: [], bodyType: 'none', bodyContent: '' },
    {},
    undefined,
    {
      hasHostPermission: async () => true,
      transport: {
        fetch: async () => new Response('{"moved":true}', { status: 307, statusText: '', headers: { 'content-type': 'application/json' } }),
        classifyError: () => ({ category: 'unknown', message: 'error' }),
      },
    },
  );
  assert.equal(http2RedirectResp.statusText, 'Temporary Redirect');

  // originalRequest snapshot preserves {{variables}}, strips JSON comments, includes auto-added headers, and redacts File objects
  const reqSnapshot = examples.buildOriginalRequestSnapshot({
    id: 'r1',
    name: 'Upload {{env}}',
    method: 'POST',
    url: 'https://example.com/users/{{id}}',
    params: [],
    pathVariables: [{ id: 'p1', key: 'id', value: '{{userId}}', enabled: true }],
    headers: [
      { id: 'h1', key: 'X-Env', value: '{{env}}', enabled: true },
      { id: 'h-ct', key: 'Content-Type', value: 'text/plain', enabled: true },
    ],
    auth: { type: 'bearer', bearerToken: '{{token}}' },
    bodyType: 'form-data',
    bodyFormData: [{ id: 'f1', key: 'avatar', type: 'file', value: 'me.png', fileName: 'avatar.png', file: { name: 'secret' }, enabled: true }],
  }, (u) => ({ raw: u }));
  assert.equal(reqSnapshot.url.raw, 'https://example.com/users/{{id}}');
  assert.equal(reqSnapshot.body.formdata[0].src, 'avatar.png');
  assert.equal('file' in reqSnapshot.body.formdata[0], false);
  // form-data overrides manual Content-Type, and Auth Bearer header is included
  assert.equal(reqSnapshot.header.some((h) => h.key === 'Authorization' && h.value === 'Bearer {{token}}'), true);
  assert.equal(reqSnapshot.header.some((h) => h.key === 'Content-Type' && h.value === 'multipart/form-data'), true);
  assert.equal(reqSnapshot.header.some((h) => h.key === 'Content-Type' && h.value === 'text/plain'), false);

  // JSON comment stripping + trailing commas + auto Content-Type + preserved {{var}} & URL strings
  const jsonReqSnapshot = examples.buildOriginalRequestSnapshot({
    id: 'r2',
    name: 'Create Rule',
    method: 'POST',
    url: 'https://example.com/rules',
    params: [],
    headers: [{ id: 'h1', key: 'Authorization', value: '{{droolsToken}}', enabled: true }],
    auth: { type: 'none' },
    bodyType: 'json',
    bodyContent: '{\n  "id": "001-222", // optional comment\n  // "disabledField": true,\n  "url": "https://example.com/a//b",\n  "name": "{{ruleName}}",\n}',
  }, (u) => ({ raw: u }));
  assert.equal(jsonReqSnapshot.body.raw.includes('optional comment'), false);
  assert.equal(jsonReqSnapshot.body.raw.includes('disabledField'), false);
  assert.equal(jsonReqSnapshot.body.raw.includes('https://example.com/a//b'), true);
  assert.equal(jsonReqSnapshot.body.raw.includes('{{ruleName}}'), true);
  assert.equal(jsonReqSnapshot.header.some((h) => h.key === 'Content-Type' && h.value === 'application/json'), true);

  // Legacy snapshot fallback: backfills auto Content-Type, strips legacy JSON comments, and detects JSON language
  const exampleSnapshot = load('packages/common/src/lib/exampleSnapshot.ts');
  const legacyOrigReq = {
    method: 'POST',
    url: { raw: 'https://example.com/rules' },
    header: [{ key: 'Authorization', value: '{{token}}' }],
    body: {
      mode: 'raw',
      raw: '{\n  "id": "001", // legacy comment\n  // "commented": 1,\n  "tag": "{{tag}}"\n}',
      options: { raw: { language: 'json' } },
    },
  };
  const legacyHeaders = exampleSnapshot.resolveSnapshotDisplayHeaders(legacyOrigReq);
  assert.equal(legacyHeaders.length, 2);
  assert.equal(legacyHeaders[1].key, 'Content-Type');
  assert.equal(legacyHeaders[1].value, 'application/json');
  assert.equal(legacyHeaders[1].autoSource, 'body');

  const resolvedLegacyBody = exampleSnapshot.resolveSnapshotBody(legacyOrigReq.body, legacyHeaders);
  assert.equal(resolvedLegacyBody.language, 'json');
  assert.equal(resolvedLegacyBody.isJson, true);
  assert.equal(resolvedLegacyBody.rawContent.includes('legacy comment'), false);
  assert.equal(resolvedLegacyBody.rawContent.includes('commented'), false);
  assert.equal(resolvedLegacyBody.prettyContent.includes('{{tag}}'), true);
});

test('Saved Examples: Postman v2.1 round-trip skips folder/corrupt responses, strips internal fields, and blocks unhydrated export', () => {
  const { load } = loadModuleGraph();
  const postman = load('packages/common/src/lib/postman.ts');

  const input = {
    info: { name: 'Examples Test', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      {
        name: 'Folder With Bad Responses',
        response: [{ name: 'Should Skip', code: 200, header: [{ key: 'Content-Type', value: 'application/json' }], body: '{}' }],
        item: [
          {
            name: 'Get User',
            request: { method: 'GET', url: 'https://httpbin.org/get?user=tester&tag=api' },
            response: [
              {
                name: '200 OK',
                status: 'OK',
                code: 200,
                _postman_previewlanguage: 'json',
                header: [{ key: 'Content-Type', value: 'application/json' }],
                body: '{"ok":true}',
                __proto__: { polluted: true },
              },
              {
                name: 'Corrupt XML',
                status: 'Bad',
                code: 500,
                header: [{ key: 'Content-Type', value: 'application/xml' }],
                body: '<unclosed>',
              },
            ],
          },
          {
            name: 'Zero Examples Request',
            request: { method: 'GET', url: 'https://example.com/empty' },
          },
        ],
      },
    ],
  };

  const { collection, exampleImportSummary } = postman.importPostmanCollectionWithSummary(JSON.stringify(input));
  assert.equal(exampleImportSummary.imported, 1);
  assert.equal(exampleImportSummary.skipped, 2); // 1 folder response + 1 corrupt XML

  const folder = collection.items[0];
  const reqWithEx = folder.items[0];
  const reqWithoutEx = folder.items[1];
  assert.equal(reqWithEx.examples.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(reqWithEx.examples[0], 'polluted'), false);
  assert.equal(reqWithEx.examplesLoaded, true);
  assert.equal(reqWithoutEx.examples.length, 0);

  // Round-trip export strips internal id/revision and writes response: [] for 0-example items
  const exported = JSON.parse(postman.exportPostmanCollection(collection));
  const exportedItem1 = exported.item[0].item[0];
  const exportedItem2 = exported.item[0].item[1];
  assert.equal(exportedItem1.response.length, 1);
  assert.equal('id' in exportedItem1.response[0], false);
  assert.equal('revision' in exportedItem1.response[0], false);
  assert.deepEqual(exportedItem2.response, []);

  // Must throw when exporting a collection with unloaded examples (examplesLoaded: false & exampleCount > 0)
  const unhydrated = {
    ...collection,
    items: [{
      ...reqWithEx,
      examples: undefined,
      examplesLoaded: false,
      exampleCount: 1,
    }],
  };
  assert.throws(() => postman.exportPostmanCollection(unhydrated), /all saved examples are loaded/i);
});

test('Saved Examples store lifecycle: capturedRequest, QuotaExceededError rollback, lazy hydration, OCC retry, capability gate & cleanup', async () => {
  const colId = '11111111-1111-4111-8111-111111111111';
  const itemId = '22222222-2222-4222-8222-222222222222';
  let serverExamples = [];
  let serverItemVersion = 1;
  let patchAttempts = 0;
  let allowSavedExamples = true;

  let failAllQuota = false;
  const memory = new Map();
  const quotaStorage = {
    getItem: async (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: async (k, v) => {
      if (failAllQuota) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      memory.set(k, v);
    },
    removeItem: async (k) => memory.delete(k),
  };

  let inFlightSendResolve;
  const harness = createStoreHarness({
    customStorage: quotaStorage,
    executeApiRequest: () =>
      new Promise((resolve) => {
        inFlightSendResolve = resolve;
      }),
    cloudOverrides: {
      fetchFeaturePolicy: async () => ({
        flags: { 'collection.move': true, 'collection.delete': true, 'collection.export': true },
        capabilities: { saved_examples: allowSavedExamples },
        revision: allowSavedExamples ? 1 : 2,
        updated_at: '2026-11-25T00:00:00Z',
      }),
      fetchScopeItem: async () => ({
        id: itemId,
        collection_id: colId,
        type: 'request',
        name: 'Get Data',
        method: 'GET',
        url: 'https://example.com/{{v}}',
        examples: serverExamples,
        example_count: serverExamples.length,
        examples_loaded: true,
        version: serverItemVersion,
        created_at: '2026-11-25T00:00:00Z',
        updated_at: '2026-11-25T00:00:00Z',
      }),
      patchScopeItemExamples: async (_api, _tok, _itemId, payload) => {
        patchAttempts++;
        if (payload.base_version !== serverItemVersion) {
          const err = new harness.cloudApiStub.CloudApiError('Version conflict', 409, {
            id: itemId,
            collection_id: colId,
            type: 'request',
            name: 'Get Data',
            examples: serverExamples,
            example_count: serverExamples.length,
            examples_loaded: true,
            version: serverItemVersion,
          });
          throw err;
        }
        serverItemVersion++;
        if (payload.op === 'add') {
          serverExamples = [...serverExamples, { ...payload.example, revision: 1 }];
        } else if (payload.op === 'rename') {
          serverExamples = serverExamples.map((e) =>
            e.id === payload.example_id ? { ...e, name: payload.name, revision: e.revision + 1 } : e
          );
        } else if (payload.op === 'delete') {
          serverExamples = serverExamples.filter((e) => e.id !== payload.example_id);
        }
        return {
          id: itemId,
          collection_id: colId,
          type: 'request',
          name: 'Get Data',
          examples: serverExamples,
          example_count: serverExamples.length,
          examples_loaded: true,
          version: serverItemVersion,
        };
      },
    },
  });

  const store = harness.storeMod.createApiStore({
    storage: quotaStorage,
    cloudClient: harness.cloudApiStub,
    productPolicy: { edition: 'full', workspace: { cloud: true, offline: true } },
  });
  await store.persist.rehydrate();

  // Local test: capturedRequest snapshot at send start + QuotaExceededError rollback
  store.setState({
    collections: [{
      id: colId,
      name: 'C1',
      items: [{
        id: itemId,
        type: 'request',
        name: 'Get Data',
        request: { id: itemId, name: 'Get Data', method: 'GET', url: 'https://example.com/{{initial}}', params: [], headers: [], bodyType: 'none', bodyContent: '' },
        examples: [{ id: 'ex-0', revision: 1, name: 'Existing', status: 'OK', code: 200, header: [{ key: 'Content-Type', value: 'application/json' }], body: '{}' }],
        exampleCount: 1,
        examplesLoaded: true,
        version: 1,
      }],
      createdAt: 1,
      updatedAt: 1,
    }],
    tabs: [{ id: 'tab-1', name: 'Get Data', method: 'GET', url: 'https://example.com/{{initial}}', params: [], headers: [], bodyType: 'none', bodyContent: '' }],
    activeTabId: 'tab-1',
  });

  const sendPromise = store.getState().sendRequest();
  await new Promise((r) => setImmediate(r));
  // Mutate active tab URL while send is in flight -> capturedRequest must keep {{initial}}!
  store.getState().updateActiveRequest({ url: 'https://example.com/mutated' });
  inFlightSendResolve({
    status: 200,
    statusText: '',
    headers: { 'Content-Type': 'application/json' },
    data: '{"saved":true}',
    timeMs: 5,
    sizeBytes: 14,
  });
  await sendPromise;

  const activeResp = store.getState().activeResponse;
  assert.equal(activeResp.capturedRequest?.url, 'https://example.com/{{initial}}');

  // QuotaExceededError rollback must restore prior item without crashing
  failAllQuota = true;
  const quotaRes = await store.getState().saveResponseAsExample({
    collectionId: colId,
    itemId,
    name: 'Quota Fail',
    response: activeResp,
  });
  failAllQuota = false;
  assert.equal(quotaRes.success, false);
  assert.match(quotaRes.error, /quota/i);
  assert.equal(store.getState().collections[0].items[0].examples.length, 1);

  // Save normally in local mode + Replace saveRequestToCollection must preserve examples
  const localSave = await store.getState().saveResponseAsExample({
    collectionId: colId,
    itemId,
    name: 'Valid Local',
    response: activeResp,
  });
  assert.equal(localSave.success, true);
  assert.equal(store.getState().collections[0].items[0].examples.length, 2);

  await store.getState().saveRequestToCollection(
    { id: 'tab-1', name: 'Get Data', method: 'GET', url: 'https://example.com/v2', params: [], headers: [], bodyType: 'none', bodyContent: '' },
    colId,
    { mode: 'replace', existingItemId: itemId },
  );
  assert.equal(store.getState().collections[0].items[0].examples.length, 2);

  // Cloud mode: lazy load on examplesLoaded=false + 409 OCC retry
  serverExamples = [
    { id: 'srv-ex-1', revision: 1, name: 'Server Ex', status: 'OK', code: 200, header: [{ key: 'Content-Type', value: 'application/json' }], body: '{"v":1}' },
  ];
  serverItemVersion = 2; // Local thinks version=1 -> triggers 409 once, then retries & succeeds!
  patchAttempts = 0;

  store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'https://api.example.com',
      token: 'tok-1',
      refreshToken: 'ref-1',
      user: { id: 'u-1', role: 'user' },
      activeScope: { type: 'personal', id: 'ws-1', role: 'admin', permissions: ['collection:write'] },
    },
    collections: [{
      id: colId,
      name: 'Cloud Col',
      _origin: 'cloud',
      minRole: 'reader',
      version: 1,
      items: [{
        id: itemId,
        type: 'request',
        name: 'Get Data',
        request: { id: itemId, name: 'Get Data', method: 'GET', url: 'https://example.com/{{initial}}', params: [], headers: [], bodyType: 'none', bodyContent: '' },
        examplesLoaded: false,
        exampleCount: 1,
        version: 1,
      }],
      createdAt: 1,
      updatedAt: 1,
    }],
  });

  const cloudAddRes = await store.getState().saveResponseAsExample({
    collectionId: colId,
    itemId,
    name: 'Cloud Ex',
    response: activeResp,
  });
  assert.equal(cloudAddRes.success, true);
  assert.equal(patchAttempts, 2); // 1x 409 conflict + 1x rebased retry
  assert.equal(store.getState().collections[0].items[0].examples.length, 2);

  // Rename & delete in cloud mode
  const addedId = cloudAddRes.example.id;
  const renameRes = await store.getState().renameSavedExample({
    collectionId: colId,
    itemId,
    exampleId: addedId,
    name: 'Cloud Ex Renamed',
  });
  assert.equal(renameRes.success, true);
  assert.equal(store.getState().collections[0].items[0].examples.find((e) => e.id === addedId)?.name, 'Cloud Ex Renamed');

  const delExRes = await store.getState().deleteSavedExample({
    collectionId: colId,
    itemId,
    exampleId: addedId,
  });
  assert.equal(delExRes.success, true);
  assert.equal(store.getState().collections[0].items[0].examples.length, 1);

  // Capability & confirmation gates:
  // 1) Server returns imported_examples=0 despite capability=true -> rejects & rolls back
  await assert.rejects(
    () =>
      store.getState().addCollection({
        name: 'Local With Examples',
        items: [{
          id: 'i-new',
          type: 'request',
          name: 'R',
          request: { id: 'i-new', name: 'R', method: 'GET', url: 'https://example.com', params: [], headers: [], bodyType: 'none', bodyContent: '' },
          examples: [{ id: 'e1', revision: 1, name: 'Ex', status: 'OK', code: 200, header: [{ key: 'Content-Type', value: 'application/json' }], body: '{}' }],
        }],
      }),
    /did not confirm saved examples/i,
  );

  // 2) Server policy lacks capabilities.saved_examples -> fails closed on saveResponseAsExample & addCollection
  allowSavedExamples = false;
  store.setState({ featurePolicy: null, featurePolicyStatus: 'idle', featurePolicyFetchedAt: null });
  const unsupportedSave = await store.getState().saveResponseAsExample({
    collectionId: colId,
    itemId,
    name: 'Blocked Ex',
    response: activeResp,
  });
  assert.equal(unsupportedSave.success, false);
  assert.match(unsupportedSave.error, /does not support saved examples/i);

  // deleteCollection cleans up selectedExample
  store.setState({
    selectedExample: { collectionId: colId, itemId, exampleId: 'srv-ex-1' },
    collections: store.getState().collections.map((c) => ({ ...c, items: [] })), // skip remote item conflict
  });
  await store.getState().deleteCollectionItem(colId, itemId);
  assert.equal(store.getState().selectedExample, null);
});

test('Saved Examples pagination & version drift detection + delta overlay/preservation', async () => {
  const colId = '11111111-1111-4111-8111-111111111111';
  const item1 = '22222222-2222-4222-8222-222222222222';
  let pageCall = 0;

  const harness = createStoreHarness({
    cloudOverrides: {
      fetchScopeCollectionExamples: async (_api, _tok, _colId, opts) => {
        pageCall++;
        if (!opts?.cursor) {
          return {
            collection_id: colId,
            collection_version: 5,
            has_more: true,
            next_cursor: 'page-2',
            items: [{
              item_id: item1,
              item_version: 2,
              example_count: 1,
              examples_loaded: true,
              examples: [{ id: 'ex-1', revision: 1, name: 'P1', status: 'OK', code: 200, header: [{ key: 'Content-Type', value: 'application/json' }], body: '{}' }],
            }],
          };
        }
        return {
          collection_id: colId,
          collection_version: 5,
          has_more: false,
          items: [],
        };
      },
    },
  });

  const store = harness.storeMod.createApiStore({
    storage: harness.storage,
    cloudClient: harness.cloudApiStub,
    productPolicy: { edition: 'full', workspace: { cloud: true, offline: true } },
  });
  await store.persist.rehydrate();
  store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'https://api.example.com',
      token: 'tok',
      refreshToken: 'ref',
      user: { id: 'u1', role: 'user' },
      activeScope: { type: 'personal', id: 'ws1', role: 'admin', permissions: ['collection:write'] },
    },
    collections: [{
      id: colId,
      name: 'Col',
      version: 5,
      items: [{
        id: item1,
        type: 'request',
        name: 'Req 1',
        request: { id: item1, name: 'Req 1', method: 'GET', url: 'https://example.com', params: [], headers: [], bodyType: 'none', bodyContent: '' },
        exampleCount: 1,
        examplesLoaded: false,
        version: 2,
      }],
    }],
  });

  const hydRes = await store.getState().hydrateCollectionExamples(colId, { includeBody: true });
  assert.equal(hydRes.success, true);
  assert.equal(pageCall, 2);
  assert.equal(store.getState().collections[0].items[0].examplesLoaded, true);
  assert.equal(store.getState().collections[0].items[0].examples.length, 1);

  // preserveHydratedItemExamples carries forward matching version full bodies, and drops stale ones on version bump
  const existingItems = store.getState().collections[0].items;
  const pulledMatching = [{
    id: item1,
    type: 'request',
    name: 'Req 1',
    request: { id: item1, name: 'Req 1', method: 'GET', url: 'https://example.com', params: [], headers: [], bodyType: 'none', bodyContent: '' },
    exampleCount: 1,
    examplesLoaded: false,
    version: 2,
  }];
  const preserved = harness.examplesMod.preserveHydratedItemExamples(pulledMatching, existingItems);
  assert.equal(preserved[0].examplesLoaded, true);
  assert.equal(preserved[0].examples.length, 1);

  const pulledBumped = [{ ...pulledMatching[0], version: 3 }];
  const notPreserved = harness.examplesMod.preserveHydratedItemExamples(pulledBumped, existingItems);
  assert.equal(notPreserved[0].examplesLoaded, false);
  assert.equal(notPreserved[0].examples, undefined);
});

test('Saved Examples UI: SavedExampleViewer renders HTML strictly as CodeEditor text, blocks App send/save shortcuts, and Sidebar chevron/drag rules hold', () => {
  const viewerSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/components/SavedExampleViewer.tsx'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/App.tsx'), 'utf8');
  const sidebarSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/components/Sidebar.tsx'), 'utf8');

  // Strict security rule: HTML must never render in dangerouslySetInnerHTML or iframe
  assert.equal(viewerSrc.includes('dangerouslySetInnerHTML'), false);
  assert.equal(/<iframe\b/i.test(viewerSrc), false);
  assert.match(viewerSrc, /<CodeEditor[\s\S]*readOnly/);

  // App opens SavedExampleViewer even when tabs.length === 0 & blocks Ctrl+Enter / Ctrl+S while TabBar closes active example tab on Ctrl+W
  const tabBarSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/components/TabBar.tsx'), 'utf8');
  assert.match(appSrc, /selectedExample\s*\?\s*\(\s*<SavedExampleViewer\s*\/>/);
  assert.match(appSrc, /if\s*\(\s*!selectedExample\s*\)\s*return;[\s\S]*?key === 'enter' \|\| key === 's'/);
  assert.match(tabBarSrc, /selectedExampleRef\.current[\s\S]*?closeExampleTab\(makeExampleTabId\(selectedExampleRef\.current\)\)/);
  assert.match(tabBarSrc, /activeVisualTabId/);
  assert.match(viewerSrc, /resolveSnapshotDisplayHeaders/);
  assert.match(viewerSrc, /resolveSnapshotBody/);
  assert.match(viewerSrc, /Headers \(\{snapshotHeaders\.length\}\)/);

  // Sidebar chevron only on items with getItemExampleCount(item) > 0, child example row draggable={false}
  assert.match(sidebarSrc, /const exampleCount = getItemExampleCount\(item\)/);
  assert.match(sidebarSrc, /exampleCount > 0/);
  assert.match(sidebarSrc, /draggable=\{false\}/);
});

test('Saved Examples Tabs: dedicated session-only tabs, mixed tab ordering, adjacent focus on close, and close scopes', async () => {
  const colId = 'col-tabs-1';
  const reqAId = 'req-a';
  const reqBId = 'req-b';
  const harness = createStoreHarness();
  const store = harness.storeMod.createApiStore({
    storage: harness.storage,
    cloudClient: harness.cloudApiStub,
    productPolicy: { edition: 'full', workspace: { cloud: true, offline: true } },
  });
  await store.persist.rehydrate();

  store.setState({
    collections: [{
      id: colId,
      name: 'Demo',
      items: [
        {
          id: reqAId,
          type: 'request',
          name: 'Request A',
          request: { id: reqAId, name: 'Request A', method: 'GET', url: 'https://example.com/a', params: [], headers: [], bodyType: 'none', bodyContent: '' },
          examples: [{ id: 'ex-a1', revision: 1, name: '200 A', status: 'OK', code: 200, header: [{ key: 'Content-Type', value: 'application/json' }], body: '{"a":1}' }],
          exampleCount: 1,
          examplesLoaded: true,
        },
        {
          id: reqBId,
          type: 'request',
          name: 'Request B',
          request: { id: reqBId, name: 'Request B', method: 'POST', url: 'https://example.com/b', params: [], headers: [], bodyType: 'json', bodyContent: '{}' },
          examples: [
            { id: 'ex-b1', revision: 1, name: '400 Bad Request', status: 'Bad Request', code: 400, header: [{ key: 'Content-Type', value: 'application/json' }], body: '{"err":1}' },
            { id: 'ex-b2', revision: 1, name: '201 Created', status: 'Created', code: 201, header: [{ key: 'Content-Type', value: 'application/json' }], body: '{"id":2}' },
          ],
          exampleCount: 2,
          examplesLoaded: true,
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    }],
    tabs: [{ id: reqAId, name: 'Request A', method: 'GET', url: 'https://example.com/a', params: [], headers: [], bodyType: 'none', bodyContent: '' }],
    activeTabId: reqAId,
    tabOrder: [reqAId],
    openExampleTabs: [],
    selectedExample: null,
  });

  // Opening Request B's example while Request A is open creates a dedicated example tab and focuses it
  store.getState().selectSavedExample({ collectionId: colId, itemId: reqBId, exampleId: 'ex-b1' });
  const exB1TabId = harness.examplesMod.makeExampleTabId({ collectionId: colId, itemId: reqBId, exampleId: 'ex-b1' });
  assert.equal(store.getState().openExampleTabs.length, 1);
  assert.deepEqual([...store.getState().tabOrder], [reqAId, exB1TabId]);
  assert.equal(store.getState().selectedExample?.exampleId, 'ex-b1');

  // Switching back to Request A hides viewer without closing Example B tab
  store.getState().setActiveTabId(reqAId);
  assert.equal(store.getState().selectedExample, null);
  assert.equal(store.getState().openExampleTabs.length, 1);

  // Opening a second example tab appends to tabOrder
  store.getState().selectSavedExample({ collectionId: colId, itemId: reqBId, exampleId: 'ex-b2' });
  const exB2TabId = harness.examplesMod.makeExampleTabId({ collectionId: colId, itemId: reqBId, exampleId: 'ex-b2' });
  assert.deepEqual([...store.getState().tabOrder], [reqAId, exB1TabId, exB2TabId]);

  // Closing active example tab ex-b2 focuses adjacent tab ex-b1
  store.getState().closeExampleTab(exB2TabId);
  assert.equal(store.getState().openExampleTabs.length, 1);
  assert.equal(store.getState().selectedExample?.exampleId, 'ex-b1');

  // Closing active example tab ex-b1 focuses adjacent Request A tab
  store.getState().closeExampleTab(exB1TabId);
  assert.equal(store.getState().openExampleTabs.length, 0);
  assert.equal(store.getState().selectedExample, null);
  assert.equal(store.getState().activeTabId, reqAId);

  // Re-open examples and test closeTabsToRight + closeOtherTabs + session-only persistence
  store.getState().selectSavedExample({ collectionId: colId, itemId: reqBId, exampleId: 'ex-b1' });
  store.getState().selectSavedExample({ collectionId: colId, itemId: reqBId, exampleId: 'ex-b2' });
  store.getState().closeTabsToRight(exB1TabId);
  assert.deepEqual([...store.getState().tabOrder], [reqAId, exB1TabId]);
  assert.equal(store.getState().selectedExample?.exampleId, 'ex-b1');

  // closeOtherTabs keeping an example tab closes Request A and focuses that example tab
  store.getState().closeOtherTabs(exB1TabId);
  assert.equal(store.getState().tabs.length, 0);
  assert.deepEqual([...store.getState().tabOrder], [exB1TabId]);
  assert.equal(store.getState().selectedExample?.exampleId, 'ex-b1');

  // Deleting the example closes its open example tab cleanly
  await store.getState().deleteSavedExample({ collectionId: colId, itemId: reqBId, exampleId: 'ex-b1' });
  assert.equal(store.getState().openExampleTabs.length, 0);
  assert.equal(store.getState().selectedExample, null);
});
