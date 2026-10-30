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

function loadCommonModule(file, customRequires = {}) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replaceAll('import.meta.env', '({})');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const require = (id) => {
    if (customRequires[id]) return customRequires[id];
    if (id.includes('urlParams')) return loadCommonModule('packages/common/src/lib/urlParams.ts');
    return {};
  };
  vm.runInNewContext(compiled, { exports, require, Map, Set, console, URL, URLSearchParams, Date, JSON, atob, btoa, Buffer }, { filename: file });
  return exports;
}

test('T-C4 (C4): buildItemTree and convertPostmanItem safely handle cyclic parent references and bounded recursion', () => {
  for (const transformerPath of ['packages/common/src/lib/cloudSyncTransformer.ts', 'extension/src/lib/cloudSyncTransformer.ts']) {
    const { buildItemTree } = loadCommonModule(transformerPath);
    assert.equal(typeof buildItemTree, 'function');

    // 1. Cyclic parent reference (mutual cycle: item-1 -> item-2 -> item-1)
    const cyclicItems = [
      { id: 'item-1', name: 'Item 1', parent_id: 'item-2', type: 'folder' },
      { id: 'item-2', name: 'Item 2', parent_id: 'item-1', type: 'folder' },
    ];
    assert.doesNotThrow(() => {
      const tree = buildItemTree(cyclicItems, 'item-2');
      assert.ok(Array.isArray(tree));
    }, 'Mutual cycle must not throw RangeError');

    // 2. Self-referential item (item -> item)
    const selfCycle = [
      { id: 'self-1', name: 'Self Cycle', parent_id: 'self-1', type: 'folder' },
    ];
    assert.doesNotThrow(() => {
      const tree = buildItemTree(selfCycle, 'self-1');
      assert.ok(Array.isArray(tree));
    }, 'Self-referential item must not throw RangeError');

    // 3. Deeply nested hierarchy (> 32 levels)
    const deepItems = [];
    for (let i = 0; i < 40; i++) {
      deepItems.push({
        id: `node-${i}`,
        name: `Folder ${i}`,
        parent_id: i === 0 ? null : `node-${i - 1}`,
        type: 'folder',
      });
    }
    const deepTree = buildItemTree(deepItems, null);
    assert.ok(Array.isArray(deepTree));

    let current = deepTree[0];
    let measuredDepth = 0;
    while (current && current.items && current.items.length > 0) {
      measuredDepth++;
      current = current.items[0];
    }
    assert.ok(measuredDepth <= 32, `Recursion depth must be capped at 32, got ${measuredDepth}`);
  }

  // 4. Postman convertPostmanItem deeply nested structure (> 40 levels)
  const { convertPostmanItem } = loadCommonModule('packages/common/src/lib/postman.ts');
  assert.equal(typeof convertPostmanItem, 'function');

  let deepPostman = { name: 'Leaf Request', request: { url: 'https://example.com/test', method: 'GET' } };
  for (let i = 0; i < 45; i++) {
    deepPostman = { name: `Folder Level ${i}`, item: [deepPostman] };
  }

  assert.doesNotThrow(() => {
    const converted = convertPostmanItem(deepPostman);
    assert.ok(converted);

    let node = converted;
    let postmanDepth = 0;
    while (node && node.items && node.items.length > 0) {
      postmanDepth++;
      node = node.items[0];
    }
    assert.ok(postmanDepth <= 32, `Postman import depth must be capped at 32, got ${postmanDepth}`);
  }, 'convertPostmanItem must not throw RangeError on deeply nested items');
});

test('T-VN3 (V-NEW-3): getUserScopeRank strictly prioritizes user.role over untrusted JWT claims', () => {
  for (const jwtPath of ['packages/common/src/lib/jwt.ts', 'extension/src/lib/jwt.ts']) {
    const { getUserScopeRank } = loadCommonModule(jwtPath);
    assert.equal(typeof getUserScopeRank, 'function', `${jwtPath} must export getUserScopeRank`);

    // Forged JWT containing { role: 'superadmin' } in payload
    const forgedSuperadminPayload = Buffer.from(JSON.stringify({ role: 'superadmin', user_id: 'bad-actor' })).toString('base64url');
    const forgedToken = `header.${forgedSuperadminPayload}.signature`;

    // 1. User has verified server role 'reader' in a project scope where scope role is 'reader'
    // Even though JWT claims superadmin, user.role 'reader' MUST NOT be overridden to admin rank 4
    const readerRank = getUserScopeRank(
      'cloud',
      { type: 'project', role: 'reader' },
      forgedToken,
      { role: 'reader' }
    );
    assert.equal(readerRank, 1, `${jwtPath}: verified user.role='reader' must not be overridden by JWT superadmin claim`);

    // 2. User has verified server role 'contributor' in a project scope where scope role is 'contributor'
    const contributorRank = getUserScopeRank(
      'cloud',
      { type: 'project', role: 'contributor' },
      forgedToken,
      { role: 'contributor' }
    );
    assert.equal(contributorRank, 2, `${jwtPath}: verified user.role='contributor' must return scope rank 2, not rank 4`);

    // 3. User has verified server role 'superadmin' -> rank 4
    const superadminRank = getUserScopeRank(
      'cloud',
      { type: 'project', role: 'reader' },
      null,
      { role: 'superadmin' }
    );
    assert.equal(superadminRank, 4, `${jwtPath}: verified user.role='superadmin' must return rank 4`);

    // 4. Fallback to JWT role only when user object or user.role is absent/null
    const fallbackRank = getUserScopeRank(
      'cloud',
      { type: 'project', role: 'reader' },
      forgedToken,
      null
    );
    assert.equal(fallbackRank, 4, `${jwtPath}: absence of user.role should fall back to JWT claim`);
  }
});

test('T-READER-PERMS: reader level has read-only capability and cannot write collections in project scope', () => {
  for (const jwtPath of ['packages/common/src/lib/jwt.ts', 'extension/src/lib/jwt.ts']) {
    const { hasScopePermission, canModifyCollection } = loadCommonModule(jwtPath);

    const readerProjectScope = { type: 'project', role: 'reader' };
    const contributorProjectScope = { type: 'project', role: 'contributor' };
    const personalScope = { type: 'workspace', role: 'owner' };
    const offlineScope = { type: 'offline_workspace', role: 'admin' };

    // 1. Reader in project scope: collection:read is allowed, but collection:write is denied
    assert.equal(
      hasScopePermission(readerProjectScope, 'collection:read', 'cloud', 'reader'),
      true,
      `${jwtPath}: reader must have collection:read permission`
    );
    assert.equal(
      hasScopePermission(readerProjectScope, 'collection:write', 'cloud', 'reader'),
      false,
      `${jwtPath}: reader must NOT have collection:write permission`
    );
    assert.equal(
      canModifyCollection('reader', readerProjectScope, 'cloud', 'reader'),
      false,
      `${jwtPath}: reader must not be able to modify collection in project scope`
    );

    // 2. Contributor in project scope: collection:write is allowed for reader/contributor collections
    assert.equal(
      hasScopePermission(contributorProjectScope, 'collection:write', 'cloud', 'contributor'),
      true,
      `${jwtPath}: contributor must have collection:write permission`
    );
    assert.equal(
      canModifyCollection('reader', contributorProjectScope, 'cloud', 'contributor'),
      true,
      `${jwtPath}: contributor can modify reader-level collection`
    );
    assert.equal(
      canModifyCollection('maintainer', contributorProjectScope, 'cloud', 'contributor'),
      false,
      `${jwtPath}: contributor cannot modify maintainer-restricted collection`
    );

    // 3. Personal workspace / offline mode always bypasses project role restrictions
    assert.equal(
      hasScopePermission(personalScope, 'collection:write', 'cloud', 'reader'),
      true,
      `${jwtPath}: personal workspace must allow collection:write even for reader account`
    );
    assert.equal(
      hasScopePermission(offlineScope, 'collection:write', 'offline', 'reader'),
      true,
      `${jwtPath}: offline workspace must allow collection:write`
    );
    assert.equal(
      canModifyCollection('admin', offlineScope, 'offline', 'reader'),
      true,
      `${jwtPath}: offline workspace allows modifying any collection`
    );
  }
});
