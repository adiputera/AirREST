import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const sandboxPage = fs.readFileSync(new URL('../apps/extension/public/sandbox.html', import.meta.url), 'utf8');
const inlineScript = sandboxPage.match(/<script>([\s\S]*?)<\/script>/)?.[1];

if (!inlineScript) {
  throw new Error('sandbox.html must contain one inline script');
}

function createSandboxHarness(location) {
  const messages = [];
  let messageListener;
  const parent = {
    postMessage(message, targetOrigin) {
      messages.push({ message, targetOrigin });
    },
  };
  const window = {
    parent,
    addEventListener(eventName, listener) {
      if (eventName === 'message') messageListener = listener;
    },
  };

  vm.runInNewContext(inlineScript, { window, location, console });
  if (!messageListener) throw new Error('sandbox did not register a message listener');

  return {
    dispatch({ origin, source = parent, script = "pm.environment.set('verified', 'yes');", request }) {
      messageListener({
        origin,
        source,
        data: {
          id: 'test-script',
          script,
          environment: {},
          variables: {},
          request,
          response: { status: 200, statusText: 'OK', data: '{}' },
        },
      });
    },
    messages,
  };
}

test('extension sandbox accepts only extension-parent messages in packaged mode', () => {
  const harness = createSandboxHarness({ protocol: 'chrome-extension:', hostname: 'example-extension' });

  harness.dispatch({ origin: 'https://example.com' });
  harness.dispatch({ origin: 'http://localhost:5173' });
  harness.dispatch({ origin: 'null' });
  assert.equal(harness.messages.length, 0);

  harness.dispatch({ origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' });
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].targetOrigin, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.messages[0].message.environment)), { verified: 'yes' });
});

test('extension sandbox accepts loopback parent messages only in development mode', () => {
  const harness = createSandboxHarness({ protocol: 'http:', hostname: 'localhost' });

  harness.dispatch({ origin: 'http://localhost:5173' });
  assert.equal(harness.messages.length, 1);

  harness.dispatch({ origin: 'https://example.com' });
  assert.equal(harness.messages.length, 1);
});

test('extension sandbox rejects messages from a window other than its parent and blocks prototype keys', () => {
  const harness = createSandboxHarness({ protocol: 'chrome-extension:', hostname: 'example-extension' });

  harness.dispatch({
    origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    source: { postMessage() {} },
  });
  assert.equal(harness.messages.length, 0);

  harness.dispatch({
    origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    script: "pm.environment.set('__proto__', 'unsafe'); pm.environment.set('safe', 'value');",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.messages[0].message.environment)), { safe: 'value' });
});

test('extension sandbox supports pm.request inspection and mutation', () => {
  const harness = createSandboxHarness({ protocol: 'chrome-extension:', hostname: 'example-extension' });

  harness.dispatch({
    origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    request: {
      url: 'https://api.example.com/api/v1/login?userId=alfian&password=Admin123',
      method: 'POST',
      headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
      params: [
        { key: 'userId', value: 'alfian', enabled: true },
        { key: 'password', value: 'Admin123', enabled: true },
      ],
    },
    script: `
      const pwd = pm.request.url.query.get("password");
      pm.environment.set("pwd_read", pwd);
      pm.request.url.query.upsert({ key: "encryptedPassword", value: "enc_hex_val" });
      pm.request.headers.upsert({ key: "X-Client", value: "airrest" });
    `,
  });

  assert.equal(harness.messages.length, 1);
  const msg = harness.messages[0].message;
  assert.equal(msg.success, true);
  assert.equal(msg.environment.pwd_read, 'Admin123');
  assert.ok(msg.mutatedRequest);
  assert.ok(msg.mutatedRequest.queryParams.some((q) => q.key === 'encryptedPassword' && q.value === 'enc_hex_val'));
  assert.ok(msg.mutatedRequest.headers.some((h) => h.key === 'X-Client' && h.value === 'airrest'));
  assert.ok(msg.mutatedRequest.url.includes('encryptedPassword=enc_hex_val'));
});

test('extension sandbox supports CryptoJS AES and SHA256 operations', () => {
  const harness = createSandboxHarness({ protocol: 'chrome-extension:', hostname: 'example-extension' });

  harness.dispatch({
    origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    request: {
      url: 'https://api.example.com/api/v1/login?userId=alfian&password=Admin123',
      method: 'POST',
      params: [{ key: 'password', value: 'Admin123', enabled: true }],
    },
    script: `
      const plainPassword = pm.request.url.query.get("password");
      const key = CryptoJS.enc.Utf8.parse("41927327183612631268126389127654");
      const iv = CryptoJS.enc.Utf8.parse("KHGTDBCGEKSATGFV");

      const encrypted = CryptoJS.AES.encrypt(
        CryptoJS.enc.Utf8.parse(plainPassword),
        key,
        { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
      );
      const encryptedHex = encrypted.ciphertext.toString(CryptoJS.enc.Hex);
      pm.request.url.query.upsert({ key: "encryptedPassword", value: encryptedHex });
    `,
  });

  assert.equal(harness.messages.length, 1);
  const msg = harness.messages[0].message;
  assert.equal(msg.success, true);
  assert.ok(msg.mutatedRequest);
  assert.ok(msg.mutatedRequest.queryParams.some((q) => q.key === 'encryptedPassword' && q.value === '4b4f02b6dfb678f85cd88823dc2d18d4'));
});
