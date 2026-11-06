import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function loadPasswordAuthProvider(loginUser) {
  const source = fs.readFileSync(new URL('../packages/common/src/auth/passwordAuthProvider.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (id) => id.includes('cloudApi') ? { loginUser } : {},
  }, { filename: 'packages/common/src/auth/passwordAuthProvider.ts' });
  return exports;
}

test('password provider validates credentials and maps the existing password login session', async () => {
  let received;
  const loginUser = async (...args) => {
    received = args;
    return {
      user: { id: 'user-1', email: 'user@example.com', name: 'Tester', role: 'member' },
      token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: '2030-01-01T00:00:00.000Z',
    };
  };
  const { passwordAuthProvider } = loadPasswordAuthProvider(loginUser);

  const session = await passwordAuthProvider.signIn({
    apiUrl: 'https://example.test',
    email: ' user@example.com ',
    password: 'secret',
  });

  assert.deepEqual(received, ['https://example.test', 'user@example.com', 'secret']);
  assert.equal(passwordAuthProvider.id, 'password');
  assert.equal(passwordAuthProvider.capabilities.passwordCredentials, true);
  assert.equal(session.accessToken, 'access-token');
  assert.equal(session.refreshToken, 'refresh-token');
  assert.equal(session.expiresAt, '2030-01-01T00:00:00.000Z');
  assert.equal(session.user.id, 'user-1');
});

test('password provider rejects missing credentials before making a network request', async () => {
  const { passwordAuthProvider } = loadPasswordAuthProvider(async () => {
    throw new Error('network should not be called');
  });

  await assert.rejects(
    passwordAuthProvider.signIn({ apiUrl: 'https://example.test', email: '', password: '' }),
    /email and password/i,
  );
});
