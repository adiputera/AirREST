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

  vm.runInNewContext(inlineScript, { window, location, console, TextEncoder });
  if (!messageListener) throw new Error('sandbox did not register a message listener');

  return {
    dispatch({
      origin,
      source = parent,
      script = "pm.environment.set('verified', 'yes');",
      environment = {},
      variables = {},
      request,
      iterationData,
      ports,
      response = { status: 200, statusText: 'OK', data: '{}' },
    }) {
      messageListener({
        origin,
        source,
        ports,
        data: {
          id: 'test-script',
          script,
          environment,
          variables,
          iterationData,
          request,
          response,
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

test('extension sandbox supports pm.iterationData and variable lookup precedence', () => {
  const harness = createSandboxHarness({ protocol: 'chrome-extension:', hostname: 'example-extension' });
  harness.dispatch({
    origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    iterationData: { userId: 'u-42', role: 'admin' },
    script: `
      pm.environment.set('userId', 'from-env');
      pm.variables.set('localOnly', 'v-1');
      pm.environment.set('resolvedUserId', pm.variables.get('userId'));
      pm.environment.set('iterRole', pm.iterationData.get('role'));
      pm.environment.set('hasRole', String(pm.iterationData.has('role')));
      pm.environment.set('iterKeys', Object.keys(pm.iterationData.toObject()).sort().join(','));
    `,
  });

  const env = harness.messages[0].message.environment;
  assert.equal(env.resolvedUserId, 'u-42');
  assert.equal(env.iterRole, 'admin');
  assert.equal(env.hasRole, 'true');
  assert.equal(env.iterKeys, 'role,userId');
});

test('extension sandbox supports structured pm.test, Chai subset, legacy tests[], and setNextRequest', () => {
  const harness = createSandboxHarness({ protocol: 'chrome-extension:', hostname: 'example-extension' });
  harness.dispatch({
    origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    response: {
      status: 201,
      statusText: 'Created',
      headers: { 'X-Request-Id': 'req-9' },
      data: JSON.stringify({ id: 7, items: ['a', 'b'], profile: { role: 'owner' } }),
      timeMs: 24,
    },
    script: `
      const json = pm.response.json();
      pm.test("Intentional failure does not abort", () => {
        pm.expect(json.id).to.be(999);
      });
      pm.test("Chai assertions and pm.response helpers", () => {
        pm.response.to.have.status(201);
        pm.response.to.have.header("x-request-id", "req-9");
        pm.response.to.have.jsonBody("profile.role", "owner");
        pm.expect(json.items).to.have.lengthOf(2).and.to.include("b");
        pm.expect(json.profile).to.eql({ role: "owner" });
        pm.expect(pm.response.responseTime).to.be.below(50);
      });
      tests["Legacy fail check"] = false;
      pm.environment.set("persistedAfterFail", "ok");
      pm.execution.setNextRequest("Next Endpoint");
    `,
  });

  const msg = harness.messages[0].message;
  assert.equal(msg.success, true, msg.error);
  assert.equal(msg.environment.persistedAfterFail, 'ok');
  assert.equal(msg.nextRequest, 'Next Endpoint');
  assert.equal(msg.testResults.length, 3);
  assert.equal(msg.testResults[0].passed, false);
  assert.equal(msg.testResults[1].passed, true, msg.testResults[1].error);
  assert.equal(msg.testResults[2].name, 'Legacy fail check');
  assert.equal(msg.testResults[2].passed, false);
});

test('EXT-01: chromeScriptExecutor forwards request and iterationData to runScriptInSandbox', () => {
  const chromeAdapterSrc = fs.readFileSync(new URL('../apps/extension/src/adapters/chromeAdapter.ts', import.meta.url), 'utf8');
  assert.match(chromeAdapterSrc, /request:\s*input\.request/);
  assert.match(chromeAdapterSrc, /iterationData:\s*input\.iterationData/);
});

test('EXT-02: sandbox uses null-prototype maps, supports MessagePort reply, and rejects oversized return payloads', () => {
  const harness = createSandboxHarness({ protocol: 'chrome-extension:', hostname: 'example-extension' });
  const portReplies = [];
  const mockPort = {
    postMessage: (data) => portReplies.push(data),
    close: () => {},
  };
  harness.dispatch(
    {
      origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      ports: [mockPort],
      environment: { existingKey: 'initial' },
      variables: { __proto__: 'ignored' },
      script: `
        pm.environment.set("hasProtoKey", String("toString" in pm.environment.toObject()));
        pm.environment.unset("existingKey");
        pm.variables.set("big", "x".repeat(2 * 1024 * 1024 + 128));
      `,
    },
  );

  // When a reply port is passed, reply arrives on MessagePort rather than window.parent
  assert.equal(harness.messages.length, 0);
  assert.equal(portReplies.length, 1);
  assert.equal(portReplies[0].success, false);
  assert.match(portReplies[0].error, /2 MiB|maximum/i);
});

test('EXT-02: sandbox uses captured harness intrinsics even if user script mutates global JSON/Object/TextEncoder', () => {
  const harness = createSandboxHarness({ protocol: 'chrome-extension:', hostname: 'example-extension' });
  const portReplies = [];
  const mockPort = {
    postMessage: (data) => portReplies.push(data),
    close: () => {},
  };
  harness.dispatch({
    origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    ports: [mockPort],
    environment: { clean: '1' },
    script: `
      JSON.stringify = function () { throw new Error('hijacked JSON.stringify'); };
      Object.keys = function () { return []; };
      Object.defineProperty = function () { throw new Error('hijacked defineProperty'); };
      globalThis.TextEncoder = function () { throw new Error('hijacked TextEncoder'); };
      pm.environment.set('afterTamper', 'safe-value');
      pm.test('survived tamper', function () {
        pm.expect(pm.environment.get('afterTamper')).to.equal('safe-value');
      });
    `,
  });

  assert.equal(portReplies.length, 1);
  assert.equal(portReplies[0].success, true);
  assert.equal(portReplies[0].environment.clean, '1');
  assert.equal(portReplies[0].environment.afterTamper, 'safe-value');
  assert.equal(portReplies[0].testResults.length, 1);
  assert.equal(portReplies[0].testResults[0].passed, true);
});
