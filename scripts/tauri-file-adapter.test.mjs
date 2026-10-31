import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadAdapter(android, selection) {
  const source = fs.readFileSync(new URL('../apps/desktop/src/adapters/tauriAdapter.ts', import.meta.url), 'utf8')
    .replaceAll('import.meta.url', '"file:///adapter.ts"');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const calls = [];
  const modules = {
    '@tauri-apps/plugin-dialog': {
      open: async (options) => { calls.push(['open', options]); return selection; },
      save: async (options) => { calls.push(['save', options]); return selection; },
    },
    '@tauri-apps/plugin-fs': {
      readTextFile: async (path) => { calls.push(['read', path]); return '{"values":[]}'; },
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
