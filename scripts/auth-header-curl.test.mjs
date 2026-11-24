import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function loadModule(relativePath, mockDeps = {}) {
  const fileUrl = new URL(relativePath, import.meta.url);
  const source = fs.readFileSync(fileUrl, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
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
      URL,
      URLSearchParams,
      FormData,
      Blob,
      btoa,
      encodeURIComponent,
      unescape,
    },
    { filename: fileUrl.pathname }
  );
  return exports;
}

const authHeaders = loadModule('../packages/common/src/lib/authHeaders.ts');
const urlParams = loadModule('../packages/common/src/lib/urlParams.ts');
const formatters = loadModule('../packages/common/src/lib/formatters.ts');
const fetcher = loadModule('../packages/common/src/lib/fetcher.ts', {
  './authHeaders': authHeaders,
  './urlParams': urlParams,
  './formatters': formatters,
  './blobManager': { createTrackedBlobUrl: () => '' },
});
const curl = loadModule('../packages/common/src/lib/curl.ts', {
  './authHeaders': authHeaders,
  './urlParams': urlParams,
  './formatters': formatters,
  './fetcher': fetcher,
});

const baseRequest = {
  id: 'curl-req-1',
  name: 'cURL Auth Test',
  method: 'GET',
  url: 'https://example.com/headers',
  params: [],
  bodyType: 'none',
  bodyContent: '',
  createdAt: 1,
  updatedAt: 1,
};

test('cURL export omits manual Authorization variants when Bearer Auth is active', () => {
  for (const key of ['Authorization', 'authorization', 'AUTHORIZATION', ' Authorization ', '{{headerName}}']) {
    const command = curl.generateCurlCommand(
      {
        ...baseRequest,
        headers: [
          { id: 'h1', key, value: 'Bearer manual-test', enabled: true },
          { id: 'h2', key: 'X-Keep', value: 'yes', enabled: true },
        ],
        auth: { type: 'bearer', bearerToken: 'auth-test' },
      },
      { headerName: 'authorization' }
    );

    assert.ok(command.includes('-H "Authorization: Bearer auth-test"'), 'cURL includes Auth header');
    assert.ok(command.includes('-H "X-Keep: yes"'), 'cURL keeps non-conflicting manual header');
    assert.ok(!command.includes('manual-test'), `cURL must omit overridden manual header (${key})`);
  }
});

test('cURL export omits manual Authorization when Basic Auth is active and omits -u ":" when Basic is empty', () => {
  const activeBasicCmd = curl.generateCurlCommand({
    ...baseRequest,
    headers: [
      { id: 'h1', key: 'authorization', value: 'Bearer manual-test', enabled: true },
      { id: 'h2', key: 'X-Keep', value: '1', enabled: true },
    ],
    auth: { type: 'basic', basicUsername: 'alice', basicPassword: 'secret' },
  });
  assert.ok(activeBasicCmd.includes('-u "alice:secret"'));
  assert.ok(activeBasicCmd.includes('-H "X-Keep: 1"'));
  assert.ok(!activeBasicCmd.includes('manual-test'));

  const emptyBasicCmd = curl.generateCurlCommand({
    ...baseRequest,
    headers: [{ id: 'h1', key: 'authorization', value: 'Bearer manual-test', enabled: true }],
    auth: { type: 'basic', basicUsername: '', basicPassword: '' },
  });
  assert.ok(!emptyBasicCmd.includes('-u ":"'), 'Empty Basic auth must not emit -u ":"');
  assert.ok(emptyBasicCmd.includes('-H "authorization: Bearer manual-test"'), 'Manual header preserved when Basic is empty');
});

test('cURL export filters conflicting API Key header and preserves Authorization when API Key is in query', () => {
  const headerApiKeyCmd = curl.generateCurlCommand({
    ...baseRequest,
    headers: [
      { id: 'h1', key: 'x-api-key', value: 'manual-key', enabled: true },
      { id: 'h2', key: 'Authorization', value: 'Bearer keep-auth', enabled: true },
    ],
    auth: { type: 'apikey', apiKeyIn: 'header', apiKeyKey: 'X-API-Key', apiKeyValue: 'auth-key' },
  });
  assert.ok(headerApiKeyCmd.includes('-H "X-API-Key: auth-key"'));
  assert.ok(headerApiKeyCmd.includes('-H "Authorization: Bearer keep-auth"'));
  assert.ok(!headerApiKeyCmd.includes('manual-key'));

  const queryApiKeyCmd = curl.generateCurlCommand({
    ...baseRequest,
    headers: [{ id: 'h1', key: 'Authorization', value: 'Bearer keep-auth', enabled: true }],
    auth: { type: 'apikey', apiKeyIn: 'query', apiKeyKey: 'Authorization', apiKeyValue: 'query-secret' },
  });
  assert.ok(queryApiKeyCmd.includes('Authorization=query-secret'));
  assert.ok(queryApiKeyCmd.includes('-H "Authorization: Bearer keep-auth"'));
});

test('cURL GraphQL omits default Content-Type when API Key sets Content-Type (mixed case, with or without manual duplicate)', () => {
  for (const authKey of ['Content-Type', 'content-type', 'CONTENT-TYPE']) {
    for (const withManualDuplicate of [true, false]) {
      const req = {
        ...baseRequest,
        method: 'POST',
        url: 'https://example.com/graphql',
        bodyType: 'graphql',
        graphqlQuery: '{ ping }',
        headers: withManualDuplicate
          ? [{ id: 'h1', key: 'Content-Type', value: 'application/manual', enabled: true }]
          : [],
        auth: { type: 'apikey', apiKeyIn: 'header', apiKeyKey: authKey, apiKeyValue: 'application/auth' },
      };

      const cmd = curl.generateCurlCommand(req);
      const prepared = fetcher.prepareRequest(req, {});

      const ctMatches = cmd.match(/-H\s+"content-type:\s*([^"]+)"/gi) || [];
      assert.equal(ctMatches.length, 1, `Expected 1 Content-Type option for authKey=${authKey}, got: ${cmd}`);
      assert.ok(ctMatches[0].includes('application/auth'), `Expected application/auth in cURL, got: ${ctMatches[0]}`);
      assert.ok(!cmd.includes('application/manual'), 'Overridden manual Content-Type must be omitted');
      assert.ok(!cmd.includes('application/json'), 'Default GraphQL Content-Type must be omitted when Auth sets Content-Type');

      const preparedCtEntries = Object.entries(prepared.finalHeaders).filter(
        ([k]) => k.toLowerCase() === 'content-type'
      );
      assert.equal(preparedCtEntries.length, 1);
      assert.equal(preparedCtEntries[0][1], 'application/auth');
    }
  }

  // GraphQL with Auth None still adds default Content-Type once
  const noneReq = {
    ...baseRequest,
    method: 'POST',
    url: 'https://example.com/graphql',
    bodyType: 'graphql',
    graphqlQuery: '{ ping }',
    headers: [],
    auth: { type: 'none' },
  };
  const noneCmd = curl.generateCurlCommand(noneReq);
  const noneCtMatches = noneCmd.match(/-H\s+"content-type:\s*([^"]+)"/gi) || [];
  assert.equal(noneCtMatches.length, 1);
  assert.ok(noneCtMatches[0].includes('application/json'));

  // GraphQL with Bearer Auth retains default Content-Type alongside single Authorization header
  const bearerReq = {
    ...baseRequest,
    method: 'POST',
    url: 'https://example.com/graphql',
    bodyType: 'graphql',
    graphqlQuery: '{ ping }',
    headers: [{ id: 'h1', key: 'authorization', value: 'Bearer manual', enabled: true }],
    auth: { type: 'bearer', bearerToken: 'auth-token' },
  };
  const bearerCmd = curl.generateCurlCommand(bearerReq);
  assert.equal((bearerCmd.match(/-H\s+"content-type:/gi) || []).length, 1);
  assert.equal((bearerCmd.match(/-H\s+"authorization:/gi) || []).length, 1);
  assert.ok(bearerCmd.includes('-H "Authorization: Bearer auth-token"'));
});

test('cURL and fetcher stay in parity for Body default Content-Type, manual non-form-data override, and form-data exclusion', () => {
  // Default JSON / XML / raw html / urlencoded emit default Content-Type when no manual header is provided
  const defaultBodies = [
    { bodyType: 'json', bodyContent: '{"a":1}', expected: 'application/json' },
    { bodyType: 'xml', bodyContent: '<a/>', expected: 'application/xml' },
    { bodyType: 'raw', rawType: 'html', bodyContent: '<p>hi</p>', expected: 'text/html' },
    { bodyType: 'x-www-form-urlencoded', bodyContent: 'a=1', expected: 'application/x-www-form-urlencoded' },
  ];
  for (const spec of defaultBodies) {
    const req = {
      ...baseRequest,
      method: 'POST',
      ...spec,
      headers: [],
      auth: { type: 'none' },
    };
    const cmd = curl.generateCurlCommand(req);
    const prepared = fetcher.prepareRequest(req, {});
    assert.ok(
      cmd.includes(`-H "Content-Type: ${spec.expected}"`),
      `cURL should emit default ${spec.expected} for ${spec.bodyType}, got: ${cmd}`
    );
    assert.equal(prepared.finalHeaders['Content-Type'], spec.expected);
  }

  // Non-form-data manual Content-Type overrides default in both cURL and fetcher
  const manualOverrideReq = {
    ...baseRequest,
    method: 'POST',
    bodyType: 'json',
    bodyContent: '{"data":{}}',
    headers: [{ id: 'c1', key: 'content-type', value: 'application/vnd.api+json', enabled: true }],
    auth: { type: 'none' },
  };
  const overrideCmd = curl.generateCurlCommand(manualOverrideReq);
  const overridePrepared = fetcher.prepareRequest(manualOverrideReq, {});
  assert.equal((overrideCmd.match(/-H\s+"content-type:/gi) || []).length, 1);
  assert.ok(overrideCmd.includes('-H "content-type: application/vnd.api+json"'));
  assert.ok(!overrideCmd.includes('application/json'));
  assert.equal(overridePrepared.finalHeaders['content-type'], 'application/vnd.api+json');
  assert.equal(overridePrepared.finalHeaders['Content-Type'], undefined);

  // form-data excludes manual Content-Type (case-insensitive) in both cURL and fetcher
  const formDataReq = {
    ...baseRequest,
    method: 'POST',
    bodyType: 'form-data',
    bodyFormData: [{ id: 'f1', key: 'name', value: 'alice', type: 'text', enabled: true }],
    headers: [
      { id: 'c1', key: 'CoNtEnT-TyPe', value: 'application/json', enabled: true },
      { id: 'h1', key: 'X-Custom', value: 'yes', enabled: true },
    ],
    auth: { type: 'none' },
  };
  const formCmd = curl.generateCurlCommand(formDataReq);
  const formPrepared = fetcher.prepareRequest(formDataReq, {});
  assert.equal((formCmd.match(/-H\s+"content-type:/gi) || []).length, 0, 'cURL form-data must omit manual Content-Type');
  assert.ok(formCmd.includes('-H "X-Custom: yes"'));
  assert.ok(formCmd.includes('-F "name=alice"'));
  const preparedCtKeys = Object.keys(formPrepared.finalHeaders).filter((k) => k.toLowerCase() === 'content-type');
  assert.equal(preparedCtKeys.length, 0, 'fetcher form-data must omit Content-Type so boundary is runtime-managed');
  assert.equal(formPrepared.finalHeaders['X-Custom'], 'yes');
});

test('cURL export strips JSON comments while parseCurlCommand preserves comments and detects JSON bodyType', () => {
  const rawWithComment = '{\n  //"field_1": "sadsadsa",\n  "field_2": "sadadsa",\n  "field_3": "sadasdsa"\n}';
  const cmd = curl.generateCurlCommand({
    ...baseRequest,
    method: 'POST',
    bodyType: 'json',
    bodyContent: rawWithComment,
    headers: [],
    auth: { type: 'none' },
  });

  assert.ok(!cmd.includes('field_1'), 'Generated cURL must not include commented JSON fields');
  assert.ok(cmd.includes('"field_2": "sadadsa"'));
  assert.ok(cmd.includes('"field_3": "sadasdsa"'));

  const imported = curl.parseCurlCommand(
    `curl --url 'https://httpbin.org/post' -H 'content-type: application/json' --data-raw '// leading\n${rawWithComment}'`
  );
  assert.equal(imported.bodyType, 'json');
  assert.equal(imported.rawType, 'json');
  assert.ok(imported.bodyContent.includes('//"field_1": "sadsadsa"'));
});

test('isCurlCommand and tryParseCurlCommand reject plain URLs/JSON and accept valid cURL variants', () => {
  // Plain URLs, variables, JSON, and non-curl text must NEVER be misidentified as cURL
  for (const nonCurl of [
    '',
    '   ',
    'https://api.example.com/v1/users',
    'http://localhost:8080/health?check=1',
    '{{baseUrl}}/api/v1/curl/items',
    '{"curl": "https://api.example.com"}',
    'curl',
    'curl   ',
    'curly https://api.example.com',
    'curl-command https://api.example.com',
    'curl -X POST', // no URL
  ]) {
    assert.equal(
      curl.tryParseCurlCommand(nonCurl),
      null,
      `Expected tryParseCurlCommand to return null for: ${nonCurl}`
    );
  }

  // Valid cURL invocations (standard, multiline continuation after curl, curl.exe, shell prompt, leading comment)
  const validVariants = [
    'curl https://api.example.com/v1/users',
    'curl \\\n  https://api.example.com/v1/users',
    'curl.exe -X GET "https://api.example.com/v1/users"',
    '$ curl -X GET https://api.example.com/v1/users',
    '# Fetch users endpoint\ncurl https://api.example.com/v1/users',
    'curl "{{baseUrl}}"',
    'curl localhost:8080',
  ];

  for (const cmd of validVariants) {
    assert.equal(curl.isCurlCommand(cmd), true, `Expected isCurlCommand=true for: ${cmd}`);
    const parsed = curl.tryParseCurlCommand(cmd);
    assert.ok(parsed && parsed.url, `Expected non-empty parsed url for: ${cmd}`);
  }
});

test('parseCurlCommand handles escaped quotes, ANSI-C $ quotes, attached/= flags, -G, -I, and non-URL path flags', () => {
  // 1. Double-quoted JSON with escaped quotes \"
  const doubleQuoted = curl.tryParseCurlCommand(
    'curl -X POST "https://api.example.com/users" -H "Content-Type: application/json" -d "{\\"name\\":\\"Alice\\",\\"role\\":\\"admin\\"}"'
  );
  assert.ok(doubleQuoted);
  assert.equal(doubleQuoted.method, 'POST');
  assert.equal(doubleQuoted.bodyType, 'json');
  assert.deepEqual(JSON.parse(doubleQuoted.bodyContent), { name: 'Alice', role: 'admin' });

  // 2. Single-quoted JSON with bash '\'' escape (round-trip with generateCurlCommand)
  const singleEscaped = curl.tryParseCurlCommand(
    `curl -X POST "https://api.example.com/books" -d '{"author":"O'\\''Reilly","title":"REST"}'`
  );
  assert.ok(singleEscaped);
  assert.equal(singleEscaped.bodyType, 'json');
  assert.deepEqual(JSON.parse(singleEscaped.bodyContent), { author: "O'Reilly", title: 'REST' });

  // 3. Chrome DevTools ANSI-C $'...' quoting
  const ansiC = curl.tryParseCurlCommand(
    `curl 'https://api.example.com/events' \\\n  -H 'content-type: application/json' \\\n  --data-raw $'{\\n  "event": "login",\\n  "quote": "O\\'Reilly"\\n}'`
  );
  assert.ok(ansiC);
  assert.equal(ansiC.method, 'POST');
  assert.equal(ansiC.bodyType, 'json');
  assert.deepEqual(JSON.parse(ansiC.bodyContent), { event: 'login', quote: "O'Reilly" });

  // 4. Attached short flags (-XPUT, -H...) and --flag=value plus non-URL path flags (-o /tmp/out.json)
  const attachedAndEquals = curl.tryParseCurlCommand(
    'curl -o /tmp/out.json --cacert /etc/ssl/ca.pem -XPUT --url="https://api.example.com/items/:id?env={{envName}}" --header="X-Custom: 42" --oauth2-bearer="my-token"'
  );
  assert.ok(attachedAndEquals);
  assert.equal(attachedAndEquals.method, 'PUT');
  assert.equal(attachedAndEquals.url, 'https://api.example.com/items/:id?env={{envName}}');
  assert.equal(attachedAndEquals.auth.type, 'bearer');
  assert.equal(attachedAndEquals.auth.bearerToken, 'my-token');
  assert.ok(attachedAndEquals.headers.some((h) => h.key === 'X-Custom' && h.value === '42'));
  assert.ok(attachedAndEquals.params.some((p) => p.key === 'env' && p.value === '{{envName}}'));
  assert.ok(attachedAndEquals.pathVariables.some((pv) => pv.key === 'id'));

  // 5. -G / --get moves -d payloads to query string and keeps GET
  const getWithData = curl.tryParseCurlCommand(
    'curl -G "https://api.example.com/search" -d "q=airrest" --data-urlencode "tag=api"'
  );
  assert.ok(getWithData);
  assert.equal(getWithData.method, 'GET');
  assert.equal(getWithData.bodyType, 'none');
  assert.equal(getWithData.url, 'https://api.example.com/search?q=airrest&tag=api');
  assert.ok(getWithData.params.some((p) => p.key === 'q' && p.value === 'airrest'));
  assert.ok(getWithData.params.some((p) => p.key === 'tag' && p.value === 'api'));

  // 6. -I / --head sets method to HEAD and ensures default empty header row when no headers are passed
  const headReq = curl.tryParseCurlCommand('curl -I https://api.example.com/ping');
  assert.ok(headReq);
  assert.equal(headReq.method, 'HEAD');
  assert.equal(headReq.headers.length, 1);
  assert.equal(headReq.headers[0].key, '');
});

