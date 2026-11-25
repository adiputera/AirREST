import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadAdapter(android, selection, options = {}) {
  const source = fs.readFileSync(new URL('../apps/native/src/adapters/tauriAdapter.ts', import.meta.url), 'utf8')
    .replaceAll('import.meta.url', '"file:///adapter.ts"');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const calls = [];
  const modules = {
    '@tauri-apps/plugin-dialog': {
      open: async (openOptions) => { calls.push(['open', openOptions]); return selection; },
      save: async (saveOptions) => { calls.push(['save', saveOptions]); return selection; },
    },
    '@tauri-apps/plugin-fs': {
      ...(options.stat ? { stat: options.stat } : {}),
      readTextFile: options.readTextFile || (async (path) => { calls.push(['read', path]); return '{"values":[]}'; }),
      writeTextFile: async (path, data) => { calls.push(['write', path, data]); },
      writeFile: async (path, data) => { calls.push(['write-bytes', path, data]); },
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (name) => modules[name] || {},
    __AIRREST_ANDROID__: android,
    console,
    Uint8Array,
  });
  return {
    adapter: exports.tauriAdapter,
    calls,
    classifyTauriNetworkError: exports.classifyTauriNetworkError,
    extractFilename: exports.extractFilename,
  };
}

test('Android content URIs are read as selected and never treated as filenames', async () => {
  const uri = 'content://documents/document/opaque%3A123';
  const { adapter, calls } = loadAdapter(true, uri);
  const result = await adapter.openFile({ filters: [{ name: 'JSON', extensions: ['json'] }] });
  assert.equal(result.filename, 'import.json');
  assert.equal(result.content, '{"values":[]}');
  assert.equal(calls[0][1].filters[0].extensions[0], 'application/json');
  assert.equal(calls[1][1], uri);
});

test('Desktop paths retain their filename and extension filter', async () => {
  const { adapter, calls } = loadAdapter(false, '/tmp/collection.json');
  const result = await adapter.openFile({ filters: [{ name: 'JSON', extensions: ['json'] }] });
  assert.equal(result.filename, 'collection.json');
  assert.equal(calls[0][1].filters[0].extensions[0], 'json');
});

test('Cancelled save returns false without writing a file', async () => {
  const { adapter, calls } = loadAdapter(true, null);
  assert.equal(await adapter.saveFile('collection.json', '{}'), false);
  assert.equal(calls.length, 1);
});

test('Android binary exports use the selected content URI unchanged', async () => {
  const uri = 'content://documents/document/export%3A456';
  const { adapter, calls } = loadAdapter(true, uri);
  const bytes = new Uint8Array([0, 127, 255]);
  assert.equal(await adapter.saveFile('response.bin', bytes), true);
  assert.equal(calls[1][0], 'write-bytes');
  assert.equal(calls[1][1], uri);
  assert.deepEqual([...calls[1][2]], [0, 127, 255]);
});

test('Android content URI with encoded filename extracts display name', async () => {
  const uri = 'content://com.android.providers.media.documents/document/document%3Amy_collection.json';
  const { adapter } = loadAdapter(true, uri);
  const result = await adapter.openFile({ filters: [{ name: 'JSON', extensions: ['json'] }] });
  assert.equal(result.filename, 'my_collection.json');
});

test('classifyTauriNetworkError categorizes SSL, DNS, connection refused, and timeout', () => {
  const { classifyTauriNetworkError } = loadAdapter(true, null);
  assert.equal(classifyTauriNetworkError(new Error('certificate verify failed')).category, 'ssl');
  assert.equal(classifyTauriNetworkError(new Error('javax.net.ssl.SSLHandshakeException: Trust anchor for certification path not found')).category, 'ssl');
  assert.equal(classifyTauriNetworkError(new Error('PKIX path building failed')).category, 'ssl');
  assert.equal(classifyTauriNetworkError(new Error('failed to lookup address information: nodename nor servname provided')).category, 'dns');
  assert.equal(classifyTauriNetworkError(new Error('connection refused: connect ECONNREFUSED')).category, 'connection_refused');
  assert.equal(classifyTauriNetworkError(new Error('request timed out')).category, 'timeout');
  assert.equal(classifyTauriNetworkError(new Error('unexpected internal failure')).category, 'other');
});

test('T-NAT-FILE: openFile rejects oversized file exceeding 16 MiB limit before reading; calculateVersionCode produces 1003000 for 1.3.0', async () => {
  const source = fs.readFileSync(new URL('../apps/native/src/adapters/tauriAdapter.ts', import.meta.url), 'utf8')
    .replaceAll('import.meta.url', '"file:///adapter.ts"');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let readCalled = false;
  const modules = {
    '@tauri-apps/plugin-dialog': {
      open: async () => '/path/to/oversized.json',
    },
    '@tauri-apps/plugin-fs': {
      stat: async () => ({ size: 20 * 1024 * 1024, isFile: true }), // 20 MiB
      readTextFile: async () => { readCalled = true; return '{}'; },
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (name) => modules[name] || {},
    __AIRREST_ANDROID__: false,
    console,
    Uint8Array,
  });

  await assert.rejects(
    async () => {
      await exports.tauriAdapter.openFile();
    },
    (err) => {
      assert.match(err.message, /16 MB/i);
      return true;
    }
  );
  assert.equal(readCalled, false, 'readTextFile must not be called when stat reports oversized file');

  const { calculateVersionCode } = await import('../scripts/bump-desktop-version.mjs');
  assert.equal(calculateVersionCode('1.3.0'), 1003000);
});

test('zero-byte binary write and write failures propagate properly; Android SAF avoids text/plain coercion on non-txt filenames', async () => {
  const uri = 'content://documents/document/export%3Aempty';
  const { adapter, calls } = loadAdapter(true, uri);

  assert.equal(await adapter.saveFile('empty.bin', new Uint8Array(0), { mimeType: undefined }), true);
  assert.equal(calls[0][1].filters[0].extensions[0], 'application/octet-stream');
  assert.equal(calls[1][0], 'write-bytes');
  assert.equal(calls[1][2].byteLength, 0);

  await adapter.saveFile('report.xlsx', new Uint8Array([0x50, 0x4b]), { mimeType: 'text/plain' });
  assert.equal(
    calls[2][1].filters[0].extensions[0],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Android SAF filter must use extension MIME rather than mislabeled text/plain',
  );
});

test('openFiles supports desktop multi-select, Android content URIs, cancellation, and per-file size errors', async () => {
  // Desktop multi-file selection
  const desktop = loadAdapter(false, ['/tmp/product.json', '/tmp/staging.json']);
  const desktopResults = await desktop.adapter.openFiles({ filters: [{ name: 'JSON', extensions: ['json'] }] });
  assert.equal(desktop.calls[0][1].multiple, true);
  assert.equal(desktop.calls[0][1].filters[0].extensions[0], 'json');
  assert.equal(desktopResults.length, 2);
  assert.equal(desktopResults[0].filename, 'product.json');
  assert.equal(desktopResults[1].filename, 'staging.json');

  // Android multi-file content URIs
  const android = loadAdapter(true, [
    'content://documents/document/document%3Acollection.json',
    'content://documents/document/document%3Astaging.json',
  ]);
  const androidResults = await android.adapter.openFiles({ filters: [{ name: 'JSON', extensions: ['json'] }] });
  assert.equal(android.calls[0][1].multiple, true);
  assert.equal(android.calls[0][1].filters[0].extensions[0], 'application/json');
  assert.equal(androidResults.length, 2);
  assert.equal(androidResults[0].filename, 'collection.json');
  assert.equal(androidResults[1].filename, 'staging.json');

  // Cancelled multi-select returns empty array
  const cancelled = loadAdapter(false, null);
  const cancelledResults = await cancelled.adapter.openFiles();
  assert.equal(Array.isArray(cancelledResults), true);
  assert.equal(cancelledResults.length, 0);

  // Oversized file in batch reports per-file error without failing valid siblings
  const mixed = loadAdapter(false, ['/tmp/oversized.json', '/tmp/valid.json'], {
    stat: async (filePath) => ({
      size: filePath.includes('oversized') ? 20 * 1024 * 1024 : 32,
      isFile: true,
    }),
    readTextFile: async (filePath) => (filePath.includes('valid') ? '{"info":{"name":"Valid"},"item":[]}' : '{}'),
  });
  const mixedResults = await mixed.adapter.openFiles();
  assert.equal(mixedResults.length, 2);
  assert.equal(mixedResults[0].filename, 'oversized.json');
  assert.match(mixedResults[0].error, /16 MB/i);
  assert.equal(mixedResults[1].filename, 'valid.json');
  assert.equal(mixedResults[1].error, undefined);
  assert.match(mixedResults[1].content, /Valid/);
});

test('F09: Tauri desktop window disables native dragDrop interception so HTML5 drag-and-drop works on Windows', () => {
  const tauriConf = JSON.parse(
    fs.readFileSync(new URL('../apps/native/src-tauri/tauri.conf.json', import.meta.url), 'utf8')
  );
  assert.ok(Array.isArray(tauriConf.app?.windows) && tauriConf.app.windows.length > 0);
  assert.equal(tauriConf.app.windows[0].dragDropEnabled, false);
});

test('I5 & I6: Android SAF extractFilename ignores authority provider and enforces 16 MiB UTF-8 byte limit', async () => {
  const android = loadAdapter(true, [
    'content://com.android.providers.downloads.documents/document/msf%3A100001234',
    'content://com.android.externalstorage.documents/document/primary%3ADownload%2Fteam-api.json',
  ]);
  const res = await android.adapter.openFiles();
  assert.equal(res[0].filename, 'import.json', 'Must not return Android provider authority as filename');
  assert.equal(res[1].filename, 'team-api.json');

  // UTF-16 length < 16 MiB (6M CJK chars) but UTF-8 byte length is 18 MiB (> 16 MiB)
  const sixMillionCjk = '中'.repeat(6 * 1024 * 1024);
  const utf8Test = loadAdapter(false, ['/tmp/cjk-big.json'], {
    stat: async () => null,
    readTextFile: async () => sixMillionCjk,
  });
  const utf8Res = await utf8Test.adapter.openFiles();
  assert.match(utf8Res[0].error, /16 MB/i);
});

test('I-R4: tauriAdapter.openFiles enforces 50-file and 64 MiB aggregate batch caps', async () => {
  const manyPaths = Array.from({ length: 51 }, (_, i) => `/tmp/file-${i}.json`);
  const overCount = loadAdapter(false, manyPaths);
  const overCountRes = await overCount.adapter.openFiles();
  assert.equal(overCountRes.length, 1);
  assert.match(overCountRes[0].error || '', /50 files/i);

  // 5 files x 14 MiB = 70 MiB total (> 64 MiB batch limit, each under 16 MiB per-file limit)
  const fivePaths = Array.from({ length: 5 }, (_, i) => `/tmp/big-${i}.json`);
  const overBatch = loadAdapter(false, fivePaths, {
    stat: async () => ({ size: 14 * 1024 * 1024, isFile: true }),
    readTextFile: async () => 'a'.repeat(14 * 1024 * 1024),
  });
  const overBatchRes = await overBatch.adapter.openFiles();
  assert.equal(overBatchRes.length, 5);
  assert.equal(overBatchRes[0].error, undefined);
  assert.equal(overBatchRes[3].error, undefined);
  assert.match(overBatchRes[4].error || '', /64 MB/i);
});

