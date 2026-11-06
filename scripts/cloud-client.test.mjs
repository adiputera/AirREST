import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadCloudApi() {
  const source = fs.readFileSync(new URL('../packages/common/src/lib/cloudApi.ts', import.meta.url), 'utf8')
    .replaceAll('import.meta.env', '({})');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    fetch: () => { throw new Error('default fetch should not be called'); },
    Headers,
    Response,
    Request,
    URL,
    TextEncoder,
    TextDecoder,
    Blob,
    CompressionStream,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
  }, { filename: 'packages/common/src/lib/cloudApi.ts' });
  return exports;
}

test('cloud clients keep their transports isolated from each other and from the legacy default', async () => {
  const { createCloudClient } = loadCloudApi();
  const received = [];
  const first = createCloudClient({
    transport: {
      fetch: async (url) => {
        received.push(['first', url]);
        return new Response('{"data": []}', { status: 200 });
      },
    },
  });
  const second = createCloudClient({
    transport: {
      fetch: async (url) => {
        received.push(['second', url]);
        return new Response('{"data": []}', { status: 200 });
      },
    },
  });

  await first.fetchWithAuth('/one', { apiUrl: 'https://one.example' });
  await second.fetchWithAuth('/two', { apiUrl: 'https://two.example' });
  await second.fetchUserWorkspaces('https://two.example', 'token');
  await second.deleteScopeItem('https://two.example', 'token', 'item-1');
  first.dispose();

  assert.deepEqual(received, [
    ['first', 'https://one.example/one'],
    ['second', 'https://two.example/two'],
    ['second', 'https://two.example/api/v1/workspaces'],
    ['second', 'https://two.example/api/v1/items/item-1'],
  ]);
  assert.equal(first.getTransport(), null);
  assert.notEqual(second.getTransport(), null);
});
