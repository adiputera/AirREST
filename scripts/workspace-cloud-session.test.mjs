import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadCloudSession() {
  const source = ts.transpileModule(
    fs.readFileSync(new URL('../packages/common/src/workspace/cloudSession.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports });
  return exports;
}

test('cloud session updates normalize URLs and reset only on a session boundary', () => {
  const { prepareCloudSessionUpdate } = loadCloudSession();
  const current = { apiUrl: 'https://api.example', token: 'old-token', user: { id: 'user-1' } };
  const normalize = (url) => url.trim().replace(/\/$/, '');

  const unchanged = prepareCloudSessionUpdate(current, { apiUrl: ' https://api.example/ ' }, normalize);
  assert.equal(unchanged.updates.apiUrl, 'https://api.example');
  assert.equal(unchanged.startsNewSession, false);
  assert.equal(prepareCloudSessionUpdate(current, { apiUrl: 'https://other.example' }, normalize).startsNewSession, true);
  assert.equal(prepareCloudSessionUpdate({ apiUrl: 'https://api.example' }, { token: 'new-token' }, normalize).startsNewSession, true);
  assert.equal(prepareCloudSessionUpdate(current, { refreshToken: 'rotated-token' }, normalize).startsNewSession, false);
});
