import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Tauri HTTP scope allows standard and custom ports for HTTP(S), including IPv6', {
  skip: typeof URLPattern === 'undefined' ? 'URLPattern is unavailable in this Node version' : false,
}, () => {
  const capability = JSON.parse(fs.readFileSync(new URL('../apps/native/src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
  const http = capability.permissions.find((permission) => permission.identifier === 'http:default');
  const patterns = http.allow.map(({ url }) => new URLPattern(url));
  const allowed = (url) => patterns.some((pattern) => pattern.test(url));
  for (const url of [
    'http://example.com/get',
    'https://example.com/get?user=tester',
    'http://localhost:8080/api',
    'http://10.0.2.2:18760/echo',
    'https://example.com:8443/api',
    'http://[::1]:3000/test',
  ]) assert.equal(allowed(url), true, url);
  assert.equal(allowed('ftp://example.com/file'), false);
});
