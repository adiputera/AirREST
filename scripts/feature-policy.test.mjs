import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadCloudApi() {
  const source = fs.readFileSync(new URL('../packages/common/src/lib/cloudApi.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    AbortController,
    Blob,
    CompressionStream,
    Headers,
    Map,
    Promise,
    Response,
    Set,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    console,
    fetch,
  }, { filename: 'packages/common/src/lib/cloudApi.ts' });
  return exports;
}

const enabledPolicy = {
  revision: 7,
  flags: {
    'collection.move': true,
    'collection.delete': true,
    'collection.export': true,
  },
};

test('accepts a complete feature policy response', async () => {
  const api = loadCloudApi();
  api.setCloudTransport({
    fetch: async () => new Response(JSON.stringify({ data: enabledPolicy }), { status: 200 }),
  });

  assert.deepEqual(
    await api.fetchFeaturePolicy('https://example.com', 'token'),
    enabledPolicy,
  );
});

test('rejects incomplete feature policy responses', async () => {
  const api = loadCloudApi();
  api.setCloudTransport({
    fetch: async () => new Response(JSON.stringify({ data: { revision: 7, flags: { 'collection.move': true } } }), { status: 200 }),
  });

  await assert.rejects(
    api.fetchFeaturePolicy('https://example.com', 'token'),
    /invalid feature policy/,
  );
});

for (const [operation, invoke] of [
  ['move', (api) => api.moveScopeCollection('https://example.com', 'token', 'collection', { type: 'workspace', id: 'workspace' })],
  ['delete', (api) => api.deleteScopeCollection('https://example.com', 'token', 'collection')],
]) {
  test(`preserves FEATURE_DISABLED for collection ${operation}`, async () => {
    const api = loadCloudApi();
    api.setCloudTransport({
      fetch: async () => new Response(JSON.stringify({ error: 'This operation is disabled.', code: 'FEATURE_DISABLED' }), { status: 403 }),
    });

    await assert.rejects(invoke(api), (error) => {
      assert.equal(error.name, 'CloudApiError');
      assert.equal(error.status, 403);
      assert.equal(error.code, 'FEATURE_DISABLED');
      return true;
    });
  });
}
