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

test('F03: parseCurlCommand -> prepareRequest preserves percent-encoding, literal plus, fragments, templates, and mixed form bodies', () => {
  // 1. Pre-encoded query param ?q=a%2Fb must be encoded once so receiver decodes 'a/b'
  const encodedQueryReq = curl.tryParseCurlCommand('curl "https://api.example.com/search?q=a%2Fb"');
  assert.ok(encodedQueryReq);
  assert.equal(encodedQueryReq.params.find((p) => p.key === 'q')?.value, 'a/b');
  const preparedEncoded = fetcher.prepareRequest({ ...baseRequest, ...encodedQueryReq }, {});
  const parsedEncodedUrl = new URL(preparedEncoded.finalUrl);
  assert.equal(parsedEncodedUrl.searchParams.get('q'), 'a/b');

  // 2. -G --data-urlencode 'q=a&b' produces exactly one 'q' param with value 'a&b'
  const getUrlencode = curl.tryParseCurlCommand(
    `curl -G 'https://api.example.com/search' --data-urlencode 'q=a&b'`
  );
  assert.ok(getUrlencode);
  assert.equal(getUrlencode.method, 'GET');
  assert.equal(getUrlencode.params.filter((p) => p.key).length, 1);
  assert.equal(getUrlencode.params[0].key, 'q');
  assert.equal(getUrlencode.params[0].value, 'a&b');
  const preparedGetUrlencode = fetcher.prepareRequest({ ...baseRequest, ...getUrlencode }, {});
  const parsedGetUrl = new URL(preparedGetUrlencode.finalUrl);
  assert.deepEqual([...parsedGetUrl.searchParams.keys()], ['q']);
  assert.equal(parsedGetUrl.searchParams.get('q'), 'a&b');

  // 3. Literal plus (+), pre-existing query, and #fragment with -G --data-urlencode
  const plusFragReq = curl.tryParseCurlCommand(
    `curl -G 'https://api.example.com/search?x=1&space=a+b#sec' --data-urlencode 'q=a+b' --data-urlencode 'tpl={{tok}}'`
  );
  assert.ok(plusFragReq);
  assert.equal(plusFragReq.params.find((p) => p.key === 'x')?.value, '1');
  assert.equal(plusFragReq.params.find((p) => p.key === 'space')?.value, 'a b');
  assert.equal(plusFragReq.params.find((p) => p.key === 'q')?.value, 'a+b');
  assert.equal(plusFragReq.params.find((p) => p.key === 'tpl')?.value, '{{tok}}');
  const preparedPlusFrag = fetcher.prepareRequest(
    { ...baseRequest, ...plusFragReq },
    { tok: 'v+1&2' }
  );
  const parsedPlusFrag = new URL(preparedPlusFrag.finalUrl);
  assert.equal(parsedPlusFrag.hash, '#sec');
  assert.equal(parsedPlusFrag.searchParams.get('x'), '1');
  assert.equal(parsedPlusFrag.searchParams.get('space'), 'a b');
  assert.equal(parsedPlusFrag.searchParams.get('q'), 'a+b');
  assert.equal(parsedPlusFrag.searchParams.get('tpl'), 'v+1&2');

  // 4. POST -d 'a=1' --data-urlencode 'q=a&b' preserves both in order
  const mixedFormPost = curl.tryParseCurlCommand(
    `curl -X POST 'https://api.example.com/form' -d 'a=1' --data-urlencode 'q=a&b'`
  );
  assert.ok(mixedFormPost);
  assert.equal(mixedFormPost.bodyType, 'x-www-form-urlencoded');
  const preparedMixedForm = fetcher.prepareRequest({ ...baseRequest, ...mixedFormPost }, {});
  assert.equal(preparedMixedForm.finalBody, 'a=1&q=a%26b');

  // 5. POST with Content-Type: application/x-www-form-urlencoded and pre-encoded -d body does not double-encode
  const encodedFormPost = curl.tryParseCurlCommand(
    `curl -X POST 'https://api.example.com/form' -H 'Content-Type: application/x-www-form-urlencoded' -d 'path=a%2Fb&msg=hello+world&plus=a%2Bb'`
  );
  assert.ok(encodedFormPost);
  assert.equal(encodedFormPost.bodyType, 'x-www-form-urlencoded');
  const preparedEncodedForm = fetcher.prepareRequest({ ...baseRequest, ...encodedFormPost }, {});
  const formParams = new URLSearchParams(String(preparedEncodedForm.finalBody));
  assert.equal(formParams.get('path'), 'a/b');
  assert.equal(formParams.get('msg'), 'hello world');
  assert.equal(formParams.get('plus'), 'a+b');
});

test('F04: parseCurlCommand preserves literal option-like operands without truncating while still supporting attached/equals flags', () => {
  const dashDebug = curl.tryParseCurlCommand(`curl https://api.example.com/items -d '-debug'`);
  assert.ok(dashDebug);
  assert.equal(dashDebug.method, 'POST');
  assert.equal(dashDebug.bodyContent, '-debug');

  const longFlagLike = curl.tryParseCurlCommand(
    `curl https://api.example.com/items --data-raw '--header=value'`
  );
  assert.ok(longFlagLike);
  assert.equal(longFlagLike.method, 'POST');
  assert.equal(longFlagLike.bodyContent, '--header=value');

  const realFlags = curl.tryParseCurlCommand(
    `curl -XPOST -H'X-Test: ok' --url=https://api.example.com/items -d '-value'`
  );
  assert.ok(realFlags);
  assert.equal(realFlags.method, 'POST');
  assert.equal(realFlags.url, 'https://api.example.com/items');
  assert.ok(realFlags.headers.some((h) => h.key === 'X-Test' && h.value === 'ok'));
  assert.equal(realFlags.bodyContent, '-value');

  // generateCurlCommand preserves duplicate keys, omits disabled params, and preserves #fragment
  const generated = curl.generateCurlCommand({
    id: 'req-curl-gen',
    name: 'Test',
    method: 'GET',
    url: 'https://api.example.com/search?tag=old&drop=1#frag',
    headers: [],
    params: [
      { id: 'p1', key: 'tag', value: 'a/b', enabled: true },
      { id: 'p2', key: 'tag', value: 'c+d', enabled: true },
      { id: 'p3', key: 'drop', value: '1', enabled: false },
    ],
    bodyType: 'none',
    bodyContent: '',
    auth: { type: 'none' },
  });
  assert.match(generated, /tag=a%2Fb&tag=c%2Bd#frag/);
  assert.doesNotMatch(generated, /drop=1/);
});

test('C1 & C2: generateCurlCommand safely quotes shell metacharacters and preserves template/schemeless URLs', () => {
  const maliciousCmd = curl.generateCurlCommand({
    ...baseRequest,
    method: 'POST',
    url: 'https://example.com/test?q=$(whoami)',
    params: [{ id: 'p0', key: '', value: '', enabled: true }],
    headers: [{ id: 'h1', key: 'If-None-Match', value: '"etag-123"', enabled: true }],
    auth: { type: 'basic', basicUsername: 'admin', basicPassword: 'p$ss"word`id`' },
    bodyType: 'x-www-form-urlencoded',
    bodyUrlEncoded: [{ id: 'u1', key: 'a', value: '$(whoami)', enabled: true }],
  });

  // All shell-active values must be single-quoted rather than double-quoted
  assert.ok(maliciousCmd.includes(`'https://example.com/test?q=$(whoami)'`), `URL must be single-quoted: ${maliciousCmd}`);
  assert.ok(maliciousCmd.includes(`-H 'If-None-Match: "etag-123"'`), `Quoted header must be single-quoted: ${maliciousCmd}`);
  assert.ok(maliciousCmd.includes(`-u 'admin:p$ss"word\`id\`'`), `Basic password with $/"/\` must be single-quoted: ${maliciousCmd}`);
  assert.ok(maliciousCmd.includes(`--data-urlencode 'a=$(whoami)'`), `Form param with $(...) must be single-quoted: ${maliciousCmd}`);

  // Round-trip through parseCurlCommand preserves exact values
  const reparsed = curl.parseCurlCommand(maliciousCmd);
  assert.equal(reparsed.headers.find((h) => h.key === 'If-None-Match')?.value, '"etag-123"');
  assert.equal(reparsed.auth.basicPassword, 'p$ss"word`id`');

  // C2: Unresolved {{baseUrl}} and schemeless localhost:8080/users with default empty param row must not be mangled
  const unresolvedCmd = curl.generateCurlCommand({
    ...baseRequest,
    url: '{{baseUrl}}/api/v1/users',
    params: [{ id: 'p0', key: '', value: '', enabled: true }],
    headers: [],
    auth: { type: 'none' },
  });
  assert.ok(unresolvedCmd.includes('"{{baseUrl}}/api/v1/users"'), `Unresolved {{baseUrl}} corrupted: ${unresolvedCmd}`);

  const localhostCmd = curl.generateCurlCommand({
    ...baseRequest,
    url: 'localhost:8080/users',
    params: [{ id: 'p0', key: '', value: '', enabled: true }],
    headers: [],
    auth: { type: 'none' },
  });
  assert.ok(localhostCmd.includes('"localhost:8080/users"'), `Schemeless localhost URL corrupted: ${localhostCmd}`);

  const templateWithParams = curl.generateCurlCommand({
    ...baseRequest,
    url: '{{baseUrl}}/items#sec',
    params: [{ id: 'p1', key: 'page', value: '2', enabled: true }],
    headers: [],
    auth: { type: 'none' },
  });
  assert.ok(templateWithParams.includes('"{{baseUrl}}/items?page=2#sec"'), `Template URL + params corrupted: ${templateWithParams}`);
});

test('C4-C7: form-data file @filename, API key #fragment, cURL parser (-d/-b/--json), async copy & paste scoping', () => {
  // C4: form-data file without File blob still emits -F "key=@filename" & API Key query stays before #fragment
  const fileAndApiKeyCmd = curl.generateCurlCommand({
    ...baseRequest,
    method: 'POST',
    url: '{{baseUrl}}/upload#done',
    params: [],
    headers: [],
    auth: { type: 'apikey', apiKeyIn: 'query', apiKeyKey: 'k', apiKeyValue: '123' },
    bodyType: 'form-data',
    bodyFormData: [{ id: 'f1', key: 'doc', value: 'report.pdf', fileName: 'report.pdf', type: 'file', enabled: true }],
  });
  assert.ok(fileAndApiKeyCmd.includes('"{{baseUrl}}/upload?k=123#done"'), `API key must stay before #fragment: ${fileAndApiKeyCmd}`);
  assert.ok(fileAndApiKeyCmd.includes('-F "doc=@report.pdf"'), `File form-data must emit @filename even without File blob: ${fileAndApiKeyCmd}`);

  // C6: -d "a=1&b=2" defaults to x-www-form-urlencoded; multi -b joins Cookies; --json respects custom Content-Type
  const urlEncodedCurl = curl.tryParseCurlCommand('curl -X POST https://example.com/form -d "a=1&b=2"');
  assert.equal(urlEncodedCurl.bodyType, 'x-www-form-urlencoded');
  assert.deepEqual(
    Array.from(urlEncodedCurl.bodyUrlEncoded.map((x) => [x.key, x.value])),
    [['a', '1'], ['b', '2']]
  );

  const multiCookieCurl = curl.tryParseCurlCommand('curl -b "a=1" -b "b=2" https://example.com');
  const cookieHeaders = multiCookieCurl.headers.filter((h) => h.key.toLowerCase() === 'cookie');
  assert.equal(cookieHeaders.length, 1);
  assert.equal(cookieHeaders[0].value, 'a=1; b=2');
  const preparedMultiCookie = fetcher.prepareRequest(
    {
      ...baseRequest,
      headers: [
        { id: 'c1', key: 'Cookie', value: 'a=1', enabled: true },
        { id: 'c2', key: 'cookie', value: 'b=2', enabled: true },
      ],
    },
    {}
  );
  assert.equal(preparedMultiCookie.finalHeaders.Cookie, 'a=1; b=2');

  const jsonCustomCt = curl.tryParseCurlCommand(
    `curl --json '{"a":1}' -H 'Content-Type: application/vnd.api+json' https://example.com`
  );
  const ctHeaders = jsonCustomCt.headers.filter((h) => h.key.toLowerCase() === 'content-type');
  assert.equal(ctHeaders.length, 1, 'Custom Content-Type must not be duplicated by --json');
  assert.equal(ctHeaders[0].value, 'application/vnd.api+json');

  // C5 & C7 source contracts
  const reqEditorSrc = fs.readFileSync(new URL('../packages/common/src/components/RequestEditor.tsx', import.meta.url), 'utf8');
  const appSrc = fs.readFileSync(new URL('../packages/common/src/App.tsx', import.meta.url), 'utf8');
  assert.match(reqEditorSrc, /const handleCopyCurl = async \(\) =>/);
  assert.match(reqEditorSrc, /await navigator\.clipboard\.writeText\(curlCmd\)/);
  assert.match(reqEditorSrc, /execCommand\('copy'\)/);
  assert.match(reqEditorSrc, /copyCurlError/);
  assert.match(appSrc, /if \(!isEditing\)\s*\{\s*const parsedCurl = tryParseCurlCommand/);

  // C-R2: @-prefixed form-data text values emit --form-string (and round-trip as text) & @-prefixed raw body emits --data-raw
  const atFormCmd = curl.generateCurlCommand({
    ...baseRequest,
    method: 'POST',
    url: 'https://example.com/post',
    headers: [],
    auth: { type: 'none' },
    bodyType: 'form-data',
    bodyFormData: [{ id: 'f1', key: 'handle', value: '@alice', type: 'text', enabled: true }],
  });
  assert.ok(atFormCmd.includes('--form-string "handle=@alice"'), `Expected --form-string for @-prefixed text field: ${atFormCmd}`);
  const atFormParsed = curl.tryParseCurlCommand(atFormCmd);
  assert.equal(atFormParsed.bodyType, 'form-data');
  assert.equal(atFormParsed.bodyFormData[0].type, 'text');
  assert.equal(atFormParsed.bodyFormData[0].value, '@alice');

  const atRawCmd = curl.generateCurlCommand({
    ...baseRequest,
    method: 'POST',
    url: 'https://example.com/raw',
    headers: [],
    auth: { type: 'none' },
    bodyType: 'raw',
    rawType: 'text',
    bodyContent: '@alice',
  });
  assert.ok(atRawCmd.includes('--data-raw "@alice"') || atRawCmd.includes("--data-raw '@alice'"), `Expected --data-raw for @-prefixed raw body: ${atRawCmd}`);

  // C-R4: substitutePathVariables preserves $-sequences such as $100 / $2b$10$hash literally
  const substitutedPriceUrl = urlParams.substitutePathVariables(
    'https://example.com/items/:price/users/:hash',
    [
      { id: 'p1', key: 'price', value: '$100', enabled: true },
      { id: 'p2', key: 'hash', value: '$2b$10$hash', enabled: true },
    ]
  );
  assert.equal(
    substitutedPriceUrl,
    'https://example.com/items/$100/users/$2b$10$hash',
  );

  // STU-20: UTF-8 Basic Auth credentials round-trip cleanly without Latin-1 mojibake
  const utf8User = 'üser_名';
  const utf8Pass = 'päss€word_🔐';
  const utf8Req = {
    ...baseRequest,
    method: 'GET',
    url: 'https://example.com/utf8-basic',
    headers: [],
    auth: { type: 'basic', basicUsername: utf8User, basicPassword: utf8Pass },
  };
  const utf8Curl = curl.generateCurlCommand(utf8Req);
  const parsedUtf8Curl = curl.tryParseCurlCommand(utf8Curl);
  assert.equal(parsedUtf8Curl.auth.type, 'basic');
  assert.equal(parsedUtf8Curl.auth.basicUsername, utf8User);
  assert.equal(parsedUtf8Curl.auth.basicPassword, utf8Pass);
});

