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
  const moved = prepareCloudSessionUpdate(current, { apiUrl: 'https://other.example' }, normalize);
  for (const key of ['user', 'token', 'refreshToken', 'tokenExpiresAt', 'sessionKind', 'activeScope']) {
    assert.ok(Object.prototype.hasOwnProperty.call(moved.updates, key));
    assert.equal(moved.updates[key], undefined);
  }
  const switched = prepareCloudSessionUpdate(current, { apiUrl: 'https://other.example', user: { id: 'new' }, token: 'new-token' }, normalize);
  assert.equal(switched.updates.user.id, 'new');
  assert.equal(switched.updates.token, 'new-token');
  assert.equal(switched.updates.refreshToken, undefined);
  const differentUser = prepareCloudSessionUpdate(current, { user: { id: 'other' } }, normalize);
  assert.equal(differentUser.updates.token, undefined);
  assert.equal(differentUser.updates.refreshToken, undefined);
  assert.equal(differentUser.updates.activeScope, undefined);
  const sameUser = prepareCloudSessionUpdate(current, { user: { id: 'user-1', name: 'Updated' } }, normalize);
  assert.equal(Object.prototype.hasOwnProperty.call(sameUser.updates, 'token'), false);
  assert.equal(sameUser.startsNewSession, false);
  assert.equal(prepareCloudSessionUpdate({ apiUrl: 'https://api.example' }, { token: 'new-token' }, normalize).startsNewSession, true);
  assert.equal(prepareCloudSessionUpdate(current, { refreshToken: 'rotated-token' }, normalize).startsNewSession, false);
  assert.equal(prepareCloudSessionUpdate(current, { sessionKind: 'provider', token: undefined }, normalize).startsNewSession, true);
  const provider = { apiUrl: current.apiUrl, sessionKind: 'provider', user: current.user };
  assert.equal(prepareCloudSessionUpdate(provider, { sessionKind: 'provider' }, normalize).startsNewSession, true);
  assert.equal(prepareCloudSessionUpdate(provider, { sessionKind: undefined }, normalize).startsNewSession, true);
});

test('provider sessions require an identified user while bearer sessions remain compatible', () => {
  const { isCloudSessionActive } = loadCloudSession();
  assert.equal(isCloudSessionActive({ apiUrl: 'https://example.test' }), false);
  assert.equal(isCloudSessionActive({ apiUrl: 'https://example.test', token: 'token' }), true);
  assert.equal(isCloudSessionActive({ apiUrl: 'https://example.test', sessionKind: 'provider' }), false);
  assert.equal(isCloudSessionActive({ apiUrl: 'https://example.test', sessionKind: 'provider', user: { id: '  ' } }), false);
  assert.equal(isCloudSessionActive({ apiUrl: 'https://example.test', sessionKind: 'provider', user: { id: 'user' } }), true);
});
