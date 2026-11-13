import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const lucideReact = require('lucide-react');

function compileTsModule(relativePath, mockDeps = {}, globals = {}) {
  const fileUrl = new URL(relativePath, import.meta.url);
  const source = fs.readFileSync(fileUrl, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
  const exports = {};
  vm.runInNewContext(
    compiled,
    {
      exports,
      require: (id) => {
        if (id in mockDeps) return mockDeps[id];
        for (const [key, mod] of Object.entries(mockDeps)) {
          if (id.endsWith(key)) return mod;
        }
        return require(id);
      },
      React,
      btoa,
      encodeURIComponent,
      unescape,
      URL,
      URLSearchParams,
      Map,
      Set,
      Object,
      Array,
      Math,
      Date,
      setTimeout,
      clearTimeout,
      ...globals,
    },
    { filename: fileUrl.pathname }
  );
  return exports;
}

const authHeaders = compileTsModule('../packages/common/src/lib/authHeaders.ts');
const urlParams = compileTsModule('../packages/common/src/lib/urlParams.ts');
const fetcher = compileTsModule('../packages/common/src/lib/fetcher.ts', {
  './authHeaders': authHeaders,
  './urlParams': urlParams,
  './blobManager': { createTrackedBlobUrl: () => '' },
});

function loadUiComponents(envVariables = []) {
  const mockStoreHook = (selector) =>
    selector({
      environments: [
        {
          id: 'env-1',
          name: 'Test Env',
          variables: envVariables,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeEnvironmentId: envVariables.length > 0 ? 'env-1' : null,
    });

  const VariableInputMod = compileTsModule('../packages/common/src/components/VariableInput.tsx', {
    react: React,
    'react-dom': require('react-dom'),
    'lucide-react': lucideReact,
    '../store/useApiStore': { useApiStore: mockStoreHook },
  });

  const KeyValueEditorMod = compileTsModule('../packages/common/src/components/KeyValueEditor.tsx', {
    react: React,
    'react-dom': require('react-dom'),
    'lucide-react': lucideReact,
    './VariableInput': VariableInputMod,
  });

  return { VariableInputMod, KeyValueEditorMod };
}

test('authHeaders: None, Bearer, Basic, and API Key gates including empty and whitespace values', () => {
  assert.equal(authHeaders.resolveEffectiveAuthHeader({ type: 'none' }), null);
  assert.equal(authHeaders.deriveAuthHeaderPreview({ type: 'none' }), null);

  // Empty & whitespace Bearer
  assert.equal(authHeaders.resolveEffectiveAuthHeader({ type: 'bearer', bearerToken: '' }), null);
  assert.equal(authHeaders.resolveEffectiveAuthHeader({ type: 'bearer', bearerToken: '   \t ' }), null);
  assert.equal(authHeaders.deriveAuthHeaderPreview({ type: 'bearer', bearerToken: '   ' }), null);

  // Active Bearer
  const bearerEff = authHeaders.resolveEffectiveAuthHeader({ type: 'bearer', bearerToken: '  auth-test  ' });
  assert.equal(bearerEff.key, 'Authorization');
  assert.equal(bearerEff.normalizedKey, 'authorization');
  assert.equal(bearerEff.value, 'Bearer auth-test');

  const bearerPrev = authHeaders.deriveAuthHeaderPreview({ type: 'bearer', bearerToken: ' {{token}} ' });
  assert.equal(bearerPrev.key, 'Authorization');
  assert.equal(bearerPrev.value, 'Bearer {{token}}');
  assert.equal(bearerPrev.valueType, 'password');

  // Empty Basic
  assert.equal(authHeaders.resolveEffectiveAuthHeader({ type: 'basic', basicUsername: '', basicPassword: '' }), null);
  assert.equal(authHeaders.deriveAuthHeaderPreview({ type: 'basic', basicUsername: '', basicPassword: '' }), null);

  // Active Basic (username-only, password-only, Unicode)
  const basicUserOnly = authHeaders.resolveEffectiveAuthHeader({ type: 'basic', basicUsername: 'alice', basicPassword: '' });
  assert.equal(basicUserOnly.key, 'Authorization');
  assert.equal(basicUserOnly.value, `Basic ${btoa('alice:')}`);

  const basicUnicode = authHeaders.resolveEffectiveAuthHeader({
    type: 'basic',
    basicUsername: 'yusuf-α',
    basicPassword: 'päss🔑',
  });
  assert.equal(basicUnicode.value, `Basic ${btoa(unescape(encodeURIComponent('yusuf-α:päss🔑')))}`);
  const basicPreview = authHeaders.deriveAuthHeaderPreview({
    type: 'basic',
    basicUsername: 'yusuf-α',
    basicPassword: 'päss🔑',
  });
  assert.equal(basicPreview.valueType, 'password');
  assert.equal(basicPreview.value, basicUnicode.value);

  // API Key in header vs query & whitespace gates
  assert.equal(
    authHeaders.resolveEffectiveAuthHeader({
      type: 'apikey',
      apiKeyIn: 'header',
      apiKeyKey: '   ',
      apiKeyValue: 'secret',
    }),
    null
  );
  assert.equal(
    authHeaders.resolveEffectiveAuthHeader({
      type: 'apikey',
      apiKeyIn: 'header',
      apiKeyKey: 'X-API-Key',
      apiKeyValue: '   ',
    }),
    null
  );
  assert.equal(
    authHeaders.resolveEffectiveAuthHeader({
      type: 'apikey',
      apiKeyIn: 'query',
      apiKeyKey: 'Authorization',
      apiKeyValue: 'secret',
    }),
    null
  );
  const apiKeyHeader = authHeaders.resolveEffectiveAuthHeader({
    type: 'apikey',
    apiKeyIn: 'header',
    apiKeyKey: ' X-API-Key ',
    apiKeyValue: ' secret-val ',
  });
  assert.equal(apiKeyHeader.key, 'X-API-Key');
  assert.equal(apiKeyHeader.normalizedKey, 'x-api-key');
  assert.equal(apiKeyHeader.value, 'secret-val');

  const apiKeyPreview = authHeaders.deriveAuthHeaderPreview({
    type: 'apikey',
    apiKeyIn: 'header',
    apiKeyKey: ' X-API-Key ',
    apiKeyValue: ' secret-val ',
  });
  assert.equal(apiKeyPreview.valueType, 'password');
  assert.equal(apiKeyPreview.value, 'secret-val');
});

test('authHeaders: case-insensitive collision detection, multiple duplicates, disabled rows, and variable keys', () => {
  const originalHeaders = [
    { id: 'h1', key: 'authorization', value: 'Bearer manual-1', enabled: true },
    { id: 'h2', key: 'AUTHORIZATION', value: 'Bearer manual-2', enabled: true },
    { id: 'h3', key: ' Authorization ', value: 'Bearer manual-3', enabled: true },
    { id: 'h4', key: '{{dynKey}}', value: 'Bearer manual-4', enabled: true },
    { id: 'h5', key: 'authorization', value: 'Bearer disabled', enabled: false },
    { id: 'h6', key: '   ', value: 'empty-key', enabled: true },
    { id: 'h7', key: 'X-Custom', value: 'keep-value', enabled: true },
  ];
  const snapshot = JSON.stringify(originalHeaders);
  const vars = { dynKey: 'AuThOrIzAtIoN', token: 'auth-secret' };
  const resolveStatic = (s) => authHeaders.interpolateStaticVariables(s, vars);

  const analysis = authHeaders.analyzeHeadersForEditor(
    originalHeaders,
    { type: 'bearer', bearerToken: '{{token}}' },
    resolveStatic
  );

  assert.equal(JSON.stringify(originalHeaders), snapshot, 'Input headers must never be mutated');
  assert.ok(analysis.authPreview);
  assert.equal(analysis.authPreview.key, 'Authorization');
  assert.equal(analysis.authPreview.value, 'Bearer {{token}}');
  assert.equal(analysis.effectiveCount, 2, '1 Auth row + 1 non-overridden active manual header (X-Custom)');

  const expectedAuthWarning = 'This is a duplicate header and will be overridden by the Authorization header set in Auth tab';
  assert.equal(analysis.warningsById.h1, expectedAuthWarning);
  assert.equal(analysis.warningsById.h2, expectedAuthWarning);
  assert.equal(analysis.warningsById.h3, expectedAuthWarning);
  assert.equal(analysis.warningsById.h4, expectedAuthWarning);
  assert.equal(analysis.warningsById.h5, undefined, 'Disabled row must not receive warning');
  assert.equal(analysis.warningsById.h6, undefined, 'Empty key row must not receive warning');
  assert.equal(analysis.warningsById.h7, undefined, 'Non-colliding header must not receive warning');

  const resolvedManual = authHeaders.resolveManualHeaders(
    originalHeaders,
    analysis.authPreview.normalizedKey,
    resolveStatic
  );
  assert.deepEqual(JSON.parse(JSON.stringify(resolvedManual)), [{ id: 'h7', key: 'X-Custom', value: 'keep-value' }]);
});

test('authHeaders: API Key header named Authorization or custom header produces exact warning pattern', () => {
  const headers = [
    { id: 'h1', key: 'x-api-key', value: 'manual-key', enabled: true },
    { id: 'h2', key: 'authorization', value: 'manual-auth', enabled: true },
  ];

  const customApiKeyAnalysis = authHeaders.analyzeHeadersForEditor(
    headers,
    { type: 'apikey', apiKeyIn: 'header', apiKeyKey: 'X-API-Key', apiKeyValue: 'real-key' }
  );
  assert.equal(
    customApiKeyAnalysis.warningsById.h1,
    'This is a duplicate header and will be overridden by the X-API-Key header set in Auth tab'
  );
  assert.equal(customApiKeyAnalysis.warningsById.h2, undefined);
  assert.equal(customApiKeyAnalysis.effectiveCount, 2);

  const authNamedApiKeyAnalysis = authHeaders.analyzeHeadersForEditor(
    headers,
    { type: 'apikey', apiKeyIn: 'header', apiKeyKey: 'authorization', apiKeyValue: 'real-auth' }
  );
  assert.equal(
    authNamedApiKeyAnalysis.warningsById.h2,
    'This is a duplicate header and will be overridden by the Authorization header set in Auth tab'
  );
  assert.equal(authNamedApiKeyAnalysis.warningsById.h1, undefined);

  // API Key in query produces no readonly row and no warnings
  const queryApiKeyAnalysis = authHeaders.analyzeHeadersForEditor(
    headers,
    { type: 'apikey', apiKeyIn: 'query', apiKeyKey: 'Authorization', apiKeyValue: 'real-auth' }
  );
  assert.equal(queryApiKeyAnalysis.authPreview, null);
  assert.deepEqual(JSON.parse(JSON.stringify(queryApiKeyAnalysis.warningsById)), {});
  assert.equal(queryApiKeyAnalysis.effectiveCount, 2);
});

test('authHeaders & fetcher: preview does not consume dynamic random variables and dispatch evaluates once', () => {
  const originalRandom = Math.random;
  let randomCalls = 0;
  Math.random = () => {
    randomCalls += 1;
    return 0.42;
  };

  try {
    const req = {
      id: 'req-dyn',
      name: 'Dynamic',
      method: 'GET',
      url: 'https://example.com',
      params: [],
      headers: [
        { id: 'h1', key: 'Authorization', value: 'Bearer {{$randomInt}}', enabled: true },
        { id: 'h2', key: 'X-Nonce', value: '{{$randomInt}}', enabled: true },
      ],
      auth: { type: 'bearer', bearerToken: 'auth-token' },
      bodyType: 'none',
      bodyContent: '',
      createdAt: 1,
      updatedAt: 1,
    };

    // UI preview must not invoke Math.random
    const previewAnalysis = authHeaders.analyzeHeadersForEditor(
      req.headers,
      req.auth,
      (s) => authHeaders.interpolateStaticVariables(s, {})
    );
    assert.equal(randomCalls, 0, 'Preview analysis must not consume Math.random');
    assert.equal(previewAnalysis.authPreview.value, 'Bearer auth-token');

    // Final dispatch evaluates X-Nonce once and skips overridden Authorization value
    const prepared = fetcher.prepareRequest(req, {});
    assert.equal(randomCalls, 1, 'Dispatch must evaluate dynamic variable only once for non-overridden header');
    assert.equal(prepared.finalHeaders.Authorization, 'Bearer auth-token');
    assert.equal(prepared.finalHeaders['X-Nonce'], '421');
  } finally {
    Math.random = originalRandom;
  }
});

test('UI components: KeyValueEditor renders readonly Auth row, Basic password masking, AlertTriangle warning trigger, and keeps Params/url-encoded intact', () => {
  const { KeyValueEditorMod } = loadUiComponents([
    { id: 'v1', key: 'token', value: 'secret-token', initialValue: 'secret-token', currentValue: 'secret-token', enabled: true },
  ]);
  const { KeyValueEditor } = KeyValueEditorMod;

  const warningText = 'This is a duplicate header and will be overridden by the Authorization header set in Auth tab';
  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(KeyValueEditor, {
      items: [
        { id: 'm1', key: 'authorization', value: 'Bearer manual-test', enabled: true },
        { id: 'm2', key: 'X-Trace', value: '123', enabled: true },
      ],
      onUpdate: () => {},
      onAdd: () => {},
      onRemove: () => {},
      readonlyRows: [
        {
          id: '__auth_derived_header__:req-1:bearer',
          key: 'Authorization',
          value: 'Bearer {{token}}',
          valueType: 'password',
          badgeText: 'From Auth',
          actionLabel: 'Edit in Auth',
          onActionClick: () => {},
        },
      ],
      rowWarnings: { m1: warningText },
    })
  );

  assert.ok(html.includes('data-readonly-row="true"'), 'Readonly Auth row rendered');
  assert.ok(html.includes('From Auth'), 'From Auth badge rendered');
  assert.ok(html.includes('Edit in Auth'), 'Edit in Auth button rendered');
  assert.ok(html.includes('readOnly=""') || html.includes('readonly=""'), 'Readonly input attribute applied');
  assert.ok(html.includes('type="password"'), 'Bearer Auth preview defaults to masked password input');
  assert.ok(html.includes('aria-label="Show value"'), 'Bearer Auth preview provides explicit reveal toggle');
  assert.ok(html.includes('data-duplicate-warning-trigger="true"'), 'AlertTriangle warning button rendered');
  assert.ok(html.includes(warningText), 'Accessible warning text present via sr-only / aria-describedby');
  assert.ok(html.includes('aria-describedby="kv-warning-desc-m1"'), 'Warning button and input wired to warning description');

  // API Key auth row also defaults to masked password input
  const apiKeyHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(KeyValueEditor, {
      items: [],
      onUpdate: () => {},
      onAdd: () => {},
      onRemove: () => {},
      readonlyRows: [
        {
          id: '__auth_derived_header__:req-1:apikey',
          key: 'X-API-Key',
          value: 'secret-key-val',
          valueType: 'password',
          badgeText: 'From Auth',
          actionLabel: 'Edit in Auth',
          onActionClick: () => {},
        },
      ],
    })
  );
  assert.ok(apiKeyHtml.includes('type="password"'), 'API Key Auth preview defaults to masked password input');
  assert.ok(apiKeyHtml.includes('aria-label="Show value"'), 'API Key Auth preview provides explicit reveal toggle');

  // Basic auth row renders password-masked input with reveal button
  const basicHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(KeyValueEditor, {
      items: [],
      onUpdate: () => {},
      onAdd: () => {},
      onRemove: () => {},
      readonlyRows: [
        {
          id: '__auth_derived_header__:req-1:basic',
          key: 'Authorization',
          value: 'Basic dXNlcjpwYXNz',
          valueType: 'password',
          badgeText: 'From Auth',
          actionLabel: 'Edit in Auth',
          onActionClick: () => {},
        },
      ],
    })
  );
  assert.ok(basicHtml.includes('type="password"'), 'Basic Auth preview defaults to masked password input');
  assert.ok(basicHtml.includes('aria-label="Show value"'), 'Basic Auth preview provides explicit reveal toggle');

  // Params / x-www-form-urlencoded regression: no readonlyRows or rowWarnings renders cleanly
  const paramsHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(KeyValueEditor, {
      items: [{ id: 'p1', key: 'page', value: '1', enabled: true }],
      onUpdate: () => {},
      onAdd: () => {},
      onRemove: () => {},
    })
  );
  assert.ok(!paramsHtml.includes('data-readonly-row'), 'Default KeyValueEditor renders no readonly rows');
  assert.ok(!paramsHtml.includes('data-duplicate-warning-trigger'), 'Default KeyValueEditor renders no warning triggers');
});

test('resolveBodyContentTypeHeader returns expected defaults across methods and body types', () => {
  assert.equal(authHeaders.resolveBodyContentTypeHeader({ method: 'GET', bodyType: 'json' }), null);
  assert.equal(authHeaders.resolveBodyContentTypeHeader({ method: 'HEAD', bodyType: 'graphql' }), null);
  assert.equal(authHeaders.resolveBodyContentTypeHeader({ method: 'POST', bodyType: 'none' }), null);

  assert.deepEqual(
    { ...authHeaders.resolveBodyContentTypeHeader({ method: 'POST', bodyType: 'json' }) },
    {
      key: 'Content-Type',
      normalizedKey: 'content-type',
      value: 'application/json',
      isManagedByRuntime: false,
    }
  );
  assert.equal(
    authHeaders.resolveBodyContentTypeHeader({ method: 'POST', bodyType: 'graphql' })?.value,
    'application/json'
  );
  assert.equal(
    authHeaders.resolveBodyContentTypeHeader({ method: 'PUT', bodyType: 'xml' })?.value,
    'application/xml'
  );
  assert.equal(
    authHeaders.resolveBodyContentTypeHeader({ method: 'POST', bodyType: 'raw', rawType: 'json' })?.value,
    'application/json'
  );
  assert.equal(
    authHeaders.resolveBodyContentTypeHeader({ method: 'POST', bodyType: 'raw', rawType: 'xml' })?.value,
    'application/xml'
  );
  assert.equal(
    authHeaders.resolveBodyContentTypeHeader({ method: 'POST', bodyType: 'raw', rawType: 'html' })?.value,
    'text/html'
  );
  assert.equal(
    authHeaders.resolveBodyContentTypeHeader({ method: 'POST', bodyType: 'raw', rawType: 'text' })?.value,
    'text/plain'
  );
  assert.equal(
    authHeaders.resolveBodyContentTypeHeader({ method: 'POST', bodyType: 'x-www-form-urlencoded' })?.value,
    'application/x-www-form-urlencoded'
  );
  assert.equal(
    authHeaders.resolveBodyContentTypeHeader({
      method: 'POST',
      bodyType: 'binary',
      bodyBinaryFile: { name: 'doc.pdf', size: 12, type: 'application/pdf' },
    })?.value,
    'application/pdf'
  );
  assert.equal(
    authHeaders.resolveBodyContentTypeHeader({
      method: 'POST',
      bodyType: 'binary',
      bodyBinaryFile: { name: 'blob.bin', size: 12, type: '' },
    })?.value,
    'application/octet-stream'
  );

  const formDataHeader = authHeaders.resolveBodyContentTypeHeader({ method: 'POST', bodyType: 'form-data' });
  assert.equal(formDataHeader?.value, 'multipart/form-data');
  assert.equal(formDataHeader?.isManagedByRuntime, true);
});

test('analyzeHeadersForEditor handles Body Content-Type override vs form-data runtime warning', () => {
  const manualCustom = [
    { id: 'c1', key: 'content-type', value: 'application/vnd.api+json', enabled: true },
    { id: 'h1', key: 'X-Trace', value: '1', enabled: true },
  ];

  // Non-form-data: manual Content-Type overrides From Body without error warning, count stays non-doubled
  const jsonWithOverride = authHeaders.analyzeHeadersForEditor(
    manualCustom,
    { type: 'none' },
    (s) => s,
    { method: 'POST', bodyType: 'json' }
  );
  assert.equal(jsonWithOverride.bodyContentTypePreview?.isOverridden, true);
  assert.equal(jsonWithOverride.bodyContentTypePreview?.overriddenBy, 'manual');
  assert.equal(jsonWithOverride.warningsById['c1'], undefined);
  assert.equal(jsonWithOverride.effectiveCount, 2);

  // Non-form-data without manual Content-Type: active From Body counts as 1
  const jsonDefaultOnly = authHeaders.analyzeHeadersForEditor(
    [{ id: 'h1', key: 'X-Trace', value: '1', enabled: true }],
    { type: 'none' },
    (s) => s,
    { method: 'POST', bodyType: 'json' }
  );
  assert.equal(jsonDefaultOnly.bodyContentTypePreview?.isOverridden, false);
  assert.equal(jsonDefaultOnly.effectiveCount, 2);

  // form-data: manual Content-Type receives warning, From Body is NOT marked overridden, count excludes overridden duplicate
  const formDataConflict = authHeaders.analyzeHeadersForEditor(
    manualCustom,
    { type: 'none' },
    (s) => s,
    { method: 'POST', bodyType: 'form-data' }
  );
  assert.equal(formDataConflict.bodyContentTypePreview?.isManagedByRuntime, true);
  assert.equal(formDataConflict.bodyContentTypePreview?.isOverridden, false);
  assert.equal(formDataConflict.warningsById['c1'], authHeaders.formatFormDataContentTypeWarning());
  assert.equal(formDataConflict.overriddenIds.has('c1'), true);
  assert.equal(formDataConflict.effectiveCount, 2);

  // Auth Content-Type overrides From Body on non-form-data
  const authContentTypeConflict = authHeaders.analyzeHeadersForEditor(
    [],
    { type: 'apikey', apiKeyIn: 'header', apiKeyKey: 'Content-Type', apiKeyValue: 'application/custom' },
    (s) => s,
    { method: 'POST', bodyType: 'graphql' }
  );
  assert.equal(authContentTypeConflict.bodyContentTypePreview?.isOverridden, true);
  assert.equal(authContentTypeConflict.bodyContentTypePreview?.overriddenBy, 'auth');
  assert.equal(authContentTypeConflict.effectiveCount, 1);

  // KeyValueEditor SSR renders From Body unmasked & overridden state
  const { KeyValueEditorMod } = loadUiComponents();
  const { KeyValueEditor } = KeyValueEditorMod;
  const bodyHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(KeyValueEditor, {
      items: [{ id: 'c1', key: 'Content-Type', value: 'application/vnd.api+json', enabled: true }],
      onUpdate: () => {},
      onAdd: () => {},
      onRemove: () => {},
      readonlyRows: [
        {
          id: '__body_content_type_header__:req-1:json:application/json',
          key: 'Content-Type',
          value: 'application/json',
          valueType: 'text',
          badgeText: 'From Body (Overridden)',
          actionLabel: 'Edit in Body',
          isOverridden: true,
          overriddenTitle: 'Overridden by your active manual Content-Type header',
          onActionClick: () => {},
        },
      ],
    })
  );
  assert.ok(bodyHtml.includes('From Body (Overridden)'), 'From Body overridden badge rendered');
  assert.ok(bodyHtml.includes('Edit in Body'), 'Edit in Body button rendered');
  assert.ok(bodyHtml.includes('data-overridden="true"'), 'Overridden attribute set on readonly row');
  assert.ok(!bodyHtml.includes('type="password"'), 'Content-Type row must remain unmasked plain text');
});
