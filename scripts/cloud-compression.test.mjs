import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadCloudApi({ supportsCompression = true } = {}) {
  const source = fs.readFileSync(new URL('../packages/common/src/lib/cloudApi.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    AbortController,
    Blob,
    CompressionStream: supportsCompression ? CompressionStream : undefined,
    DecompressionStream,
    Headers,
    Map,
    Promise,
    Response,
    Set,
    TextEncoder,
    TextDecoder,
    URL,
    console,
    fetch,
  }, { filename: 'packages/common/src/lib/cloudApi.ts' });
  return exports;
}

test('gzip-compresses large sync imports and preserves bytes for transport replay', async () => {
  const api = loadCloudApi();
  let received;
  api.setCloudTransport({
    fetch: async (_url, init) => {
      received = init;
      return new Response('{}', { status: 200 });
    },
  });
  const payload = JSON.stringify({ collections: [{ body: 'x'.repeat(128 * 1024) }] });

  await api.fetchWithAuth('/api/v1/sync/import-batch', {
    apiUrl: 'https://example.com',
    body: payload,
  });

  assert.equal(received.headers['content-encoding'], 'gzip');
  assert.ok(received.body instanceof ArrayBuffer);
  const decompressed = await new Response(
    new Blob([received.body]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).text();
  assert.equal(decompressed, payload);
});

test('rejects oversized decoded sync imports before network IO', async () => {
  const api = loadCloudApi();
  api.setCloudTransport({ fetch: async () => assert.fail('must not send oversized import') });

  await assert.rejects(
    api.fetchWithAuth('/api/v1/sync/import-batch', {
      apiUrl: 'https://example.com',
      body: 'x'.repeat(16 * 1024 * 1024 + 1),
    }),
    /16 MiB decoded/,
  );
});

test('replays the same compressed import bytes after silent token refresh', async () => {
  const api = loadCloudApi();
  const requests = [];
  api.setCloudTransport({
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/auth/refresh')) {
        return new Response(JSON.stringify({ data: { token: 'rotated-token', refresh_token: 'rotated-refresh' } }), { status: 200 });
      }
      return new Response('{}', { status: requests.length === 1 ? 401 : 200 });
    },
  });

  await api.fetchWithAuth('/api/v1/sync/import-batch', {
    apiUrl: 'https://example.com',
    token: 'expired-token',
    refreshToken: 'refresh-token',
    body: JSON.stringify({ collections: [{ body: 'x'.repeat(128 * 1024) }] }),
  });

  assert.equal(requests.length, 3);
  assert.equal(requests[0].init.body, requests[2].init.body);
  assert.equal(requests[2].init.headers.authorization, 'Bearer rotated-token');
});

test('does not retry a gzip mutation when the server returns 415', async () => {
  const api = loadCloudApi();
  const requests = [];
  api.setCloudTransport({
    fetch: async (_url, init) => {
      requests.push(init);
      return new Response('{}', { status: 415 });
    },
  });
  const body = JSON.stringify({ collections: [{ body: 'x'.repeat(128 * 1024) }] });

  await api.fetchWithAuth('/api/v1/sync/import-batch', { apiUrl: 'https://example.com', body });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers['content-encoding'], 'gzip');
});

test('uses identity when gzip exceeds its budget but identity fits', async () => {
  const api = loadCloudApi();
  let received;
  api.setCloudTransport({
    fetch: async (_url, init) => {
      received = init;
      return new Response('{}', { status: 200 });
    },
  });
  const body = JSON.stringify({ collections: [{ body: randomBytes(3_000_000).toString('base64') }] });
  assert.ok(Buffer.byteLength(body) < 4 * 1024 * 1024);

  await api.fetchWithAuth('/api/v1/sync/import-batch', { apiUrl: 'https://example.com', body });

  assert.equal(received.headers['content-encoding'], undefined);
  assert.equal(received.body, body);
});

test('rejects malformed successful collection detail responses', async () => {
  const api = loadCloudApi();
  api.setCloudTransport({ fetch: async () => new Response('{truncated', { status: 200 }) });

  await assert.rejects(
    api.fetchCollectionById('https://example.com', 'token', 'collection-id'),
    /invalid JSON/,
  );
});

test('rejects collection detail responses beyond the decoded transfer limit', async () => {
  const api = loadCloudApi();
  api.setCloudTransport({
    fetch: async () => new Response('x'.repeat(16 * 1024 * 1024 + 1), { status: 200 }),
  });

  await assert.rejects(
    api.fetchCollectionById('https://example.com', 'token', 'collection-id'),
    /16 MiB decoded/,
  );
});

test('uses identity in clients without CompressionStream while the old limit permits it', async () => {
  const api = loadCloudApi({ supportsCompression: false });
  let received;
  api.setCloudTransport({
    fetch: async (_url, init) => {
      received = init;
      return new Response('{}', { status: 200 });
    },
  });
  const body = JSON.stringify({ collections: [{ body: 'x'.repeat(128 * 1024) }] });

  await api.fetchWithAuth('/api/v1/sync/import-batch', { apiUrl: 'https://example.com', body });

  assert.equal(received.headers['content-encoding'], undefined);
  assert.equal(received.body, body);
});

test('keeps large non-sync bodies within the existing identity limit', async () => {
  const api = loadCloudApi();
  api.setCloudTransport({ fetch: async () => assert.fail('must not send oversized body') });

  await assert.rejects(
    api.fetchWithAuth('/api/v1/auth/profile', {
      apiUrl: 'https://example.com',
      body: 'x'.repeat(4 * 1024 * 1024 + 1),
    }),
    /4 MiB/,
  );
});
