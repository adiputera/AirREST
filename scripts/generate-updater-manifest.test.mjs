import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUpdaterManifest, generateUpdaterManifest, selectUpdaterAssets } from './generate-updater-manifest.mjs';

const version = '1.3.6';
const names = [
  'AirREST_aarch64.app.tar.gz', 'AirREST_x64.app.tar.gz',
  'AirREST_1.3.6_amd64.AppImage', 'AirREST_1.3.6_x64-setup.exe',
  'AirREST_1.3.6_x64_en-US.msi', 'AirREST_1.3.6_amd64.deb', 'AirREST-1.3.6-1.x86_64.rpm',
];
const assets = names.flatMap((name, i) => [
  { name, id: i * 2, state: 'uploaded', size: 100 },
  { name: `${name}.sig`, id: i * 2 + 1, state: 'uploaded', size: 100 },
]);
const signatures = Object.fromEntries(names.map(name => [
  `${name}.sig`, Buffer.from(`untrusted comment: ${name}\nc2lnbmF0dXJl\ntrusted comment: timestamp:123\nc2lnbmF0dXJl\n`).toString('base64'),
]));
const metadata = { version, notes: 'Release notes', pubDate: '2026-11-06T07:11:16Z', repo: 'example/airrest', tag: 'v1.3.6' };
const build = (overrides = {}) => buildUpdaterManifest({
  ...metadata, bundles: selectUpdaterAssets(assets, version), signatures, ...overrides,
});

test('combines all desktop platforms and preserves installer aliases and exact signatures', () => {
  const manifest = build();
  assert.equal(Object.keys(manifest.platforms).length, 11);
  assert.deepEqual(manifest.platforms['windows-x86_64'], manifest.platforms['windows-x86_64-nsis']);
  assert.deepEqual(manifest.platforms['linux-x86_64'], manifest.platforms['linux-x86_64-appimage']);
  assert.equal(manifest.platforms['darwin-x86_64'].signature, signatures['AirREST_x64.app.tar.gz.sig']);
  assert.match(manifest.platforms['windows-x86_64-msi'].url, /v1\.3\.6\/AirREST_1\.3\.6_x64_en-US\.msi$/);
  assert.equal(manifest.pub_date, metadata.pubDate);
  assert.equal(manifest.notes, metadata.notes);
  assert.equal(manifest.release_tag, metadata.tag);
  assert.equal(manifest.release_url, 'https://github.com/example/airrest/releases/tag/v1.3.6');
});

test('rejects missing binaries or signatures for every required target', () => {
  for (const asset of assets.slice(0, 8)) {
    assert.throws(() => selectUpdaterAssets(assets.filter(a => a !== asset), version), /Missing or incomplete/);
  }
});

test('rejects incomplete uploads, duplicate assets and partially present optional installers', () => {
  assert.throws(() => selectUpdaterAssets([{ ...assets[0], size: 0 }, ...assets.slice(1)], version), /incomplete/);
  assert.throws(() => selectUpdaterAssets([{ ...assets[0], state: 'starter' }, ...assets.slice(1)], version), /incomplete/);
  assert.throws(() => selectUpdaterAssets([...assets, assets[0]], version), /Duplicate/);
  assert.throws(() => selectUpdaterAssets(assets.slice(0, 9), version), /\.msi\.sig/);
  assert.equal(selectUpdaterAssets(assets.slice(0, 8), version).length, 4);
});

test('rejects corrupt signatures, missing platform coverage and invalid metadata', () => {
  for (const signature of ['', 'c9PQo=', '<html>error</html>']) {
    assert.throws(() => build({ signatures: { ...signatures, 'AirREST_x64.app.tar.gz.sig': signature } }), /Invalid updater signature/);
  }
  assert.throws(() => build({ bundles: selectUpdaterAssets(assets, version).slice(1) }), /Missing updater target/);
  assert.throws(() => build({ version: 'invalid' }), /Invalid updater version/);
  assert.throws(() => build({ pubDate: 'invalid' }), /Invalid release date/);
  assert.throws(() => build({ repo: 'invalid?repo' }), /Invalid release repository or tag/);
});

test('encodes manual release tags and uses tagged download URLs for draft releases', () => {
  const manifest = build({ tag: 'preview/test' });
  assert.match(manifest.platforms['darwin-aarch64'].url, /download\/preview%2Ftest\//);
  assert.equal(manifest.release_url, 'https://github.com/example/airrest/releases/tag/preview%2Ftest');
});

test('GitHub adapter paginates assets and downloads signatures before returning a complete manifest', async () => {
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push(url);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    if (url.includes('/tags/')) return Response.json({ id: 42, body: metadata.notes, created_at: metadata.pubDate });
    if (url.includes('&page=1')) return Response.json(Array.from({ length: 100 }, (_, i) => ({ name: `unrelated-${i}` })));
    if (url.includes('&page=2')) return Response.json(assets);
    assert.equal(options.headers.Accept, 'application/octet-stream');
    const asset = assets.find(a => url.endsWith(`/assets/${a.id}`));
    assert.ok(asset?.name.endsWith('.sig'));
    return new Response(signatures[asset.name]);
  };
  const manifest = await generateUpdaterManifest({ ...metadata, fetchImpl, token: 'test-token' });
  assert.deepEqual(manifest, build());
  assert.equal(requested.length, 10);
});

test('GitHub failures and missing targets abort generation without fetching unrelated assets', async () => {
  await assert.rejects(generateUpdaterManifest({ ...metadata, fetchImpl: async () => new Response('', { status: 403 }) }), /GitHub request failed \(403\)/);
  let calls = 0;
  await assert.rejects(generateUpdaterManifest({ ...metadata, fetchImpl: async () => {
    calls++;
    return Response.json(calls === 1 ? { id: 42 } : assets.slice(0, 2));
  } }), /Missing or incomplete/);
  assert.equal(calls, 2);
  await assert.rejects(generateUpdaterManifest({ ...metadata, fetchImpl: async url => {
    if (url.includes('/tags/')) return Response.json({ id: 42 });
    if (url.includes('per_page=')) return Response.json(assets);
    return new Response('', { status: 404 });
  } }), /GitHub request failed \(404\)/);
});
