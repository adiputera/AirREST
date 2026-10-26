import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Exercise the actual TypeScript API modules with controlled HTTP responses.
// import.meta.env is supplied by Vite in production; tests use its empty default.
function loadClient(file, fetch) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replaceAll('import.meta.env', '({})');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, fetch, Headers, Response, TextEncoder, console }, { filename: file });
  return exports;
}

for (const file of ['extension/src/lib/cloudApi.ts', 'hub/src/lib/api.ts']) {
  const registerEviction = file.startsWith('extension') ? 'registerAuthEvictedCallback' : 'registerHubAuthEvicted';
  test(`${file}: revoked refresh signs out`, async () => {
    let calls = 0;
    let evictions = 0;
    const api = loadClient(file, async () => { calls++; return new Response('{}', { status: 401 }); });
    api[registerEviction](() => evictions++);
    const res = await api.fetchWithAuth('/api/v1/auth/me', { apiUrl: 'https://example.com', token: 'old-access', refreshToken: 'old-refresh' });
    assert.equal(res.status, 401);
    assert.equal(calls, 2);
    assert.equal(evictions, 1);
  });
  test(`${file}: temporary refresh failure preserves session`, async () => {
    let calls = 0;
    let evictions = 0;
    const api = loadClient(file, async () => new Response('{}', { status: ++calls === 1 ? 401 : 503 }));
    api[registerEviction](() => evictions++);
    await api.fetchWithAuth('/api/v1/auth/me', { apiUrl: 'https://example.com', token: 'access', refreshToken: 'refresh' });
    assert.equal(evictions, 0);
  });
  test(`${file}: reset between refresh and retry signs out`, async () => {
    let calls = 0;
    let evictions = 0;
    const api = loadClient(file, async () => ++calls === 2
      ? new Response(JSON.stringify({ data: { token: 'new-access', refresh_token: 'new-refresh', expires_at: '2030-01-01T00:00:00Z' } }))
      : new Response('{}', { status: 401 }));
    api[registerEviction](() => evictions++);
    await api.fetchWithAuth('/api/v1/auth/me', { apiUrl: 'https://example.com', token: 'old-access', refreshToken: 'old-refresh' });
    assert.equal(calls, 3);
    assert.equal(evictions, 1);
  });
  test(`${file}: oversized requests fail before network IO`, async () => {
    const api = loadClient(file, async () => { assert.fail('must not send oversized body'); });
    await assert.rejects(api.fetchWithAuth('/api/v1/sync/import-batch', { apiUrl: 'https://example.com', body: 'x'.repeat(4 * 1024 * 1024 + 1) }), /4 MiB/);
  });
}

test('password change returns a replacement token pair without evicting the current session', async () => {
  let evictions = 0;
  let status = 400;
  const api = loadClient('extension/src/lib/cloudApi.ts', async () => new Response(JSON.stringify({
    data: status === 200
      ? { user: { id: 'user-1' }, token: 'replacement-access', refresh_token: 'replacement-refresh', expires_at: '2030-01-01T00:00:00Z' }
      : { message: 'password updated' },
    error: 'incorrect password',
  }), { status }));
  api.registerAuthEvictedCallback(() => evictions++);
  await assert.rejects(api.changeUserPassword('https://example.com', 'old', 'new', 'access'), /incorrect/);
  assert.equal(evictions, 0);
  status = 200;
  const session = await api.changeUserPassword('https://example.com', 'old', 'new', 'access');
  assert.equal(session.token, 'replacement-access');
  assert.equal(session.refresh_token, 'replacement-refresh');
  assert.equal(evictions, 0);
});

test('import count and depth limits fail before network IO', async () => {
  const api = loadClient('extension/src/lib/cloudApi.ts', async () => { assert.fail('must not send oversized import'); });
  await assert.rejects(api.batchImportToScope('https://example.com', 'token', 'workspace', Array.from({ length: 101 }, () => ({ items: [] }))), /100 collections/);
  let items = [{ name: 'leaf' }];
  for (let i = 0; i < 32; i++) items = [{ name: 'folder', items }];
  await assert.rejects(api.batchImportToScope('https://example.com', 'token', 'workspace', [{ items }]), /32 folder levels/);
});
