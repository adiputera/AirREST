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
    dispatch({ origin, source = parent, script = "pm.environment.set('verified', 'yes');" }) {
      messageListener({
        origin,
        source,
        data: {
          id: 'test-script',
          script,
          environment: {},
          variables: {},
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
