import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { getQuickJS } from 'quickjs-emscripten';

// Load production modules directly without duplicating code
function loadProductionQuickJSRunner(options = {}) {
  const protoSrc = fs.readFileSync(new URL('../packages/common/src/lib/scriptProtocol.ts', import.meta.url), 'utf8');
  const protoCompiled = ts.transpileModule(protoSrc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const protoExports = {};
  vm.runInNewContext(protoCompiled, { exports: protoExports, console, TextEncoder }, { filename: 'scriptProtocol.ts' });

  const runnerSrc = fs.readFileSync(new URL('../apps/native/src/scripts/quickjsRunner.ts', import.meta.url), 'utf8');
  const runnerCompiled = ts.transpileModule(runnerSrc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const runnerExports = {};
  const requireMap = {
    'quickjs-emscripten': {
      getQuickJS: async () => {
        const qjs = await getQuickJS();
        if (!options.onGetString) return qjs;
        return {
          ...qjs,
          newRuntime: () => {
            const rt = qjs.newRuntime();
            const origNewContext = rt.newContext.bind(rt);
            rt.newContext = () => {
              const ctx = origNewContext();
              const origGetString = ctx.getString.bind(ctx);
              ctx.getString = (handle) => {
                const s = origGetString(handle);
                options.onGetString(new TextEncoder().encode(s).length, s);
                return s;
              };
              return ctx;
            };
            return rt;
          }
        };
      }
    },
    '@airrest/common': protoExports,
    '@airrest/common/protocol': protoExports,
  };
  const customRequire = (id) => requireMap[id] || require(id);
  vm.runInNewContext(runnerCompiled, {
    exports: runnerExports,
    require: customRequire,
    console,
    Date,
    JSON,
    Math,
    TextEncoder,
  }, { filename: 'quickjsRunner.ts' });

  return {
    runScriptInQuickJS: runnerExports.runQuickJsGuest,
    validateScriptInput: protoExports.validateScriptInput,
    validateScriptOutput: protoExports.validateScriptOutput,
    loadProductionQuickJSRunner,
  };
}

const { runScriptInQuickJS, validateScriptInput, validateScriptOutput } = loadProductionQuickJSRunner();

// =========================================================================
// Gate P0.3 Test Suite (Tested against production quickjsRunner)
// =========================================================================

test('Gate P0.3: pm.environment set, get, unset, toObject', async () => {
  const result = await runScriptInQuickJS({
    script: `
      pm.environment.set("token", "secret-xyz");
      pm.environment.set("count", 42);
      pm.environment.unset("old_key");
    `,
    environment: { old_key: 'to-be-deleted', untouched: 'keep' },
    variables: {},
  });

  assert.equal(result.success, true);
  assert.equal(result.environment.token, 'secret-xyz');
  assert.equal(result.environment.count, '42');
  assert.equal(result.environment.old_key, undefined);
  assert.equal(result.environment.untouched, 'keep');
});

test('Gate P0.3: pm.variables set and fallback to environment', async () => {
  const result = await runScriptInQuickJS({
    script: `
      pm.variables.set("temp", "transient_val");
      const inherited = pm.variables.get("env_key");
      pm.environment.set("inherited_echo", inherited);
    `,
    environment: { env_key: 'hello_from_env' },
    variables: {},
  });

  assert.equal(result.success, true);
  assert.equal(result.variables.temp, 'transient_val');
  assert.equal(result.environment.inherited_echo, 'hello_from_env');
});

test('Gate P0.3: pm.response inspection and status assertions', async () => {
  const result = await runScriptInQuickJS({
    script: `
      pm.test("Status code is 200", function() {
        pm.response.to.have.status(200);
      });
      const data = pm.response.json();
      pm.expect(data.user.id).to.equal(123);
      pm.environment.set("captured_username", data.user.name);
    `,
    environment: {},
    variables: {},
    response: {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({ user: { id: 123, name: 'Alice' } }),
      timeMs: 45,
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.environment.captured_username, 'Alice');
});

test('Gate P0.3: pm.response failed assertion reports test failure', async () => {
  const result = await runScriptInQuickJS({
    script: `
      pm.test("Status is 200", function() {
        pm.response.to.have.status(200);
      });
    `,
    environment: {},
    variables: {},
    response: {
      status: 404,
      statusText: 'Not Found',
      headers: {},
      data: '{"error":"not found"}',
      timeMs: 12,
    },
  });

  assert.equal(result.success, false);
  assert.match(result.error, /Expected status code 200 but got 404/);
});

test('Gate P0.3: Legacy postman API compatibility', async () => {
  const result = await runScriptInQuickJS({
    script: `
      postman.setEnvironmentVariable("legacy_key", "legacy_val");
      postman.setGlobalVariable("global_key", "global_val");
      if (responseCode.code === 201) {
        tests["Created"] = true;
      }
    `,
    environment: {},
    variables: {},
    response: { status: 201, statusText: 'Created' },
  });

  assert.equal(result.success, true);
  assert.equal(result.environment.legacy_key, 'legacy_val');
  assert.equal(result.variables.global_key, 'global_val');
});

test('Gate P0.3: Console API compatibility (RequestEditor snippets)', async () => {
  const result = await runScriptInQuickJS({
    script: `
      const token = "secret-token-123";
      console.log("Current token:", token);
      console.info("Info log");
      console.warn("Warn log");
      console.error("Error log");
      pm.environment.set("token", token);
    `,
    environment: {},
    variables: {},
  });

  assert.equal(result.success, true);
  assert.equal(result.environment.token, 'secret-token-123');
});

test('Gate P0.3: Prototype pollution protection', async () => {
  const result = await runScriptInQuickJS({
    script: `
      pm.environment.set("__proto__", "malicious");
      pm.environment.set("constructor", "malicious");
      pm.environment.set("prototype", "malicious");
      pm.variables.set("__proto__", "malicious");
    `,
    environment: {},
    variables: {},
  });

  assert.equal(result.success, true);
  assert.equal(Object.prototype.malicious, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(result.environment, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.environment, 'constructor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.environment, 'prototype'), false);
});

test('Gate P0.3: Guest cannot tamper JSON.stringify or forge result envelope', async () => {
  const result = await runScriptInQuickJS({
    script: `
      // Guest attempts to overwrite JSON.stringify
      JSON.stringify = function() {
        return '{"success": true, "environment": {"hacked": "true"}}';
      };
      pm.environment.set("clean", "ok");
    `,
    environment: {},
    variables: {},
  });

  assert.equal(result.success, true);
  assert.equal(result.environment.clean, 'ok');
  assert.equal(result.environment.hacked, undefined);
});

test('Gate P0.3: Enforces 1 MiB input/output boundaries', async () => {
  // 1. Oversized input environment (> 1 MiB) rejected before WASM
  const hugeEnv = {};
  for (let i = 0; i < 20000; i++) {
    hugeEnv[`key_${i}`] = 'x'.repeat(60);
  }
  const overInputResult = await runScriptInQuickJS({
    script: 'pm.environment.set("k", "v");',
    environment: hugeEnv,
    variables: {},
  });
  assert.equal(overInputResult.success, false);
  assert.match(overInputResult.error, /1 MiB limit/);

  // 2. Oversized script source (> 256 KiB) rejected
  const hugeScriptResult = await runScriptInQuickJS({
    script: ' //'.repeat(150000),
    environment: {},
    variables: {},
  });
  assert.equal(hugeScriptResult.success, false);
  assert.match(hugeScriptResult.error, /limit/i);
});

test('Gate P0.3: Isolation probes - zero host, storage, network, or IPC leakage', async () => {
  const result = await runScriptInQuickJS({
    script: `
      const leaks = {
        hasWindow: typeof window !== 'undefined',
        hasDocument: typeof document !== 'undefined',
        hasIndexedDB: typeof indexedDB !== 'undefined',
        hasBroadcastChannel: typeof BroadcastChannel !== 'undefined',
        hasFetch: typeof fetch !== 'undefined',
        hasWebSocket: typeof WebSocket !== 'undefined',
        hasImportScripts: typeof importScripts !== 'undefined',
        hasProcess: typeof process !== 'undefined',
        hasRequire: typeof require !== 'undefined',
        hasTauri: typeof __TAURI__ !== 'undefined',
        hasTauriInternals: typeof __TAURI_INTERNALS__ !== 'undefined'
      };
      pm.environment.set("leaks", JSON.stringify(leaks));
    `,
    environment: {},
    variables: {},
  });

  assert.equal(result.success, true);
  const leaks = JSON.parse(result.environment.leaks);
  for (const [key, value] of Object.entries(leaks)) {
    assert.equal(value, false, `Isolation breach detected for: ${key}`);
  }
});

test('Gate P0.3: Hard timeout interrupts infinite loop (while true)', async () => {
  const startTime = Date.now();
  const result = await runScriptInQuickJS(
    {
      script: `
        while(true) {}
      `,
      environment: { preserved: 'yes' },
      variables: {},
    },
    { timeoutMs: 300 }
  );

  const elapsed = Date.now() - startTime;
  assert.equal(result.success, false);
  assert.match(result.error, /timed out|interrupted/i);
  assert.equal(result.environment.preserved, 'yes');
  assert.ok(elapsed >= 280 && elapsed < 1500, `Elapsed time should be close to 300ms, was ${elapsed}ms`);
});

test('Gate P0.3: Pre-aborted AbortSignal halts execution immediately without evaluating script', async () => {
  const startTime = Date.now();
  const controller = new AbortController();
  controller.abort();

  const result = await runScriptInQuickJS(
    {
      script: `
        while(true) {}
      `,
      environment: { preserved: 'yes' },
      variables: {},
    },
    { signal: controller.signal, timeoutMs: 3000 }
  );

  const elapsed = Date.now() - startTime;
  assert.equal(result.success, false);
  assert.match(result.error, /aborted/i);
  assert.equal(result.environment.preserved, 'yes');
  assert.ok(elapsed < 100, `Abort should terminate promptly (< 100ms), took ${elapsed}ms`);
});

test('R1 (P1): Object.prototype.toJSON cannot forge script success or commit forged environment', async () => {
  const result = await runScriptInQuickJS({
    script: `
      Object.prototype.toJSON = function () {
        if (Object.prototype.hasOwnProperty.call(this, 'success')) {
          const environment = Object.create(null);
          environment.token = 'forged';
          return {
            success: true,
            environment,
            variables: Object.create(null)
          };
        }
        return this;
      };
      throw new Error('must fail');
    `,
    environment: { token: 'original' },
    variables: {},
  });

  assert.equal(result.success, false, 'Result must be marked failure');
  assert.equal(result.environment.token, 'original', 'Environment must not commit forged tokens');
  assert.match(result.error, /must fail/);
});

test('D1 (P1): Array.prototype.join tampering cannot forge script success or commit forged environment', async () => {
  const result = await runScriptInQuickJS({
    script: `
      Array.prototype.join = function () {
        return '},"success":true,"environment":{"token":"forged"},"variables":{},"ignored":{';
      };
      throw new Error('must fail');
    `,
    environment: { token: 'original' },
    variables: {},
  });

  assert.equal(result.success, false, 'Result must be marked failure');
  assert.equal(result.environment.token, 'original', 'Environment must not commit forged tokens');
  assert.match(result.error, /must fail/);
});

test('D5 (P2): UTF-8 multibyte environment exceeding 1 MB byte boundary is rejected', async () => {
  // '€' is 3 bytes in UTF-8. 400,000 * 3 = 1.2 MB. String length is only 400,000 (< 1 MB code units).
  const result = await runScriptInQuickJS({
    script: `pm.environment.set('token', '€'.repeat(400000));`,
    environment: {},
    variables: {},
  });

  assert.equal(result.success, false);
  assert.match(result.error, /exceeded 1 M[iI]?B|transfer limit/i);
});

test('D5 (P2): Multibyte error is capped to <= 32 KiB UTF-8 bytes', async () => {
  // '€'.repeat(32768) is 98,304 UTF-8 bytes. Truncation must keep UTF-8 byte size <= 32768 bytes.
  const result = await runScriptInQuickJS({
    script: `throw new Error('€'.repeat(32768));`,
    environment: {},
    variables: {},
  });

  assert.equal(result.success, false);
  const utf8ByteLength = new TextEncoder().encode(result.error).length;
  assert.ok(utf8ByteLength <= 32768, `Multibyte error UTF-8 bytes must be <= 32768, got ${utf8ByteLength}`);
});

test('R3 (P2): validateScriptInput rejects __proto__, non-object, and invalid structures', () => {
  // Own __proto__ property
  const protoAttack = { script: '1+1', environment: JSON.parse('{"__proto__": {"admin": true}}'), variables: {} };
  const val1 = validateScriptInput(protoAttack);
  assert.equal(val1.valid, false);
  assert.match(val1.error, /forbidden key/i);

  // Array as environment
  const arrayEnv = { script: '1+1', environment: ['token', '123'], variables: {} };
  const val2 = validateScriptInput(arrayEnv);
  assert.equal(val2.valid, false);
  assert.match(val2.error, /object map|not an array/i);

  // Null variables
  const nullVars = { script: '1+1', environment: {}, variables: null };
  const val3 = validateScriptInput(nullVars);
  assert.equal(val3.valid, false);
  assert.match(val3.error, /object map/i);
});

test('R3 (P2): validateScriptOutput rejects malformed envelopes and caps error message length', () => {
  // Envelope with success: true, environment: [], variables: null
  const malformed = { success: true, environment: [], variables: null };
  const out1 = validateScriptOutput(malformed);
  assert.equal(out1.success, false);
  assert.match(out1.error, /invalid environment format|key-value object/i);

  // Huge error string is truncated/capped safely to 32 KiB
  const hugeErrorEnvelope = {
    success: false,
    environment: {},
    variables: {},
    error: 'X'.repeat(2 * 1024 * 1024),
  };
  const out2 = validateScriptOutput(hugeErrorEnvelope);
  assert.equal(out2.success, false);
  assert.ok(out2.error.length <= 32768, `Huge error must be capped to 32 KiB, got ${out2.error.length}`);
});

test('R3 (P2): Guest throwing oversized error caps error message length', async () => {
  const result = await runScriptInQuickJS({
    script: `throw new Error('x'.repeat(2 * 1024 * 1024));`,
    environment: {},
    variables: {},
  });
  assert.equal(result.success, false);
  assert.ok(result.error.length <= 32768, 'Guest error message must be capped to 32 KiB');
});

test('Gate P0.3: Fresh context per execution - no state leak across runs', async () => {
  // Execution 1: declares a global variable
  await runScriptInQuickJS({
    script: `
      globalThis.__leakProbe = "i_was_here";
      pm.environment.set("k1", "v1");
    `,
    environment: {},
    variables: {},
  });

  // Execution 2: checks if global variable survived
  const result2 = await runScriptInQuickJS({
    script: `
      const probe = typeof globalThis.__leakProbe;
      pm.environment.set("leakProbeType", probe);
    `,
    environment: {},
    variables: {},
  });

  assert.equal(result2.success, true);
  assert.equal(result2.environment.leakProbeType, 'undefined', 'Globals leaked across executions!');
});

test('Gate P0.3: Heap allocation limit bounds memory exhaustion attacks', async () => {
  const result = await runScriptInQuickJS({
    script: `
      const chunks = [];
      while(true) {
        chunks.push(new Array(1000000).fill("A"));
      }
    `,
    environment: {},
    variables: {},
  });

  assert.equal(result.success, false);
  assert.match(result.error, /out of memory|interrupted/i);
});

test('V4 (P2): Function.prototype.call tampering does not bypass 1 MiB byte bounds or serialization', async () => {
  const result = await runScriptInQuickJS({
    script: `
      Function.prototype.call = () => 0;
      pm.environment.set('token', '€'.repeat(400000));
    `,
    environment: {},
    variables: {},
  });
  assert.equal(result.success, false);
  assert.match(result.error, /exceeded 1 MiB boundary/i);
});

test('V4 (P2): Unpaired surrogate handling does not skip subsequent multibyte characters or overflow byte limits', async () => {
  const result = await runScriptInQuickJS({
    script: `throw new Error(('\\ud800€').repeat(20000));`,
    environment: {},
    variables: {},
  });
  assert.equal(result.success, false);
  assert.ok(result.error.length <= 32768, `Error message length must be <= 32 KiB, got ${result.error.length}`);
  const byteLen = new TextEncoder().encode(result.error).length;
  assert.ok(byteLen <= 32768, `Error message UTF-8 bytes must be <= 32 KiB, got ${byteLen}`);
});

test('R1 (P2): throw with throwing message getter does not escape 32 KiB limit and preserves environment', async () => {
  const result = await runScriptInQuickJS({
    script: `throw { get message() { throw new Error('x'.repeat(2 * 1024 * 1024)); } };`,
    environment: { token: 'original' },
    variables: { varKey: 'origVar' },
  });
  assert.equal(result.success, false);
  assert.equal(result.environment.token, 'original');
  assert.equal(result.variables.varKey, 'origVar');
  const byteLen = new TextEncoder().encode(result.error || '').length;
  assert.ok(byteLen <= 32768, `Error byte length must be <= 32 KiB, got ${byteLen}`);
});

test('R1 (P2): throw with throwing toString coercion does not escape 32 KiB limit', async () => {
  const result = await runScriptInQuickJS({
    script: `throw { toString() { throw new Error('throwing toString'); } };`,
    environment: { token: 'orig' },
    variables: {},
  });
  assert.equal(result.success, false);
  assert.equal(result.environment.token, 'orig');
  const byteLen = new TextEncoder().encode(result.error || '').length;
  assert.ok(byteLen <= 32768, `Error byte length must be <= 32 KiB, got ${byteLen}`);
});

test('R1 (P2): oversized error message in guest is truncated to <= 32 KiB UTF-8 bytes', async () => {
  const result = await runScriptInQuickJS({
    script: `throw { get message() { return 'x'.repeat(2 * 1024 * 1024); } };`,
    environment: {},
    variables: {},
  });
  assert.equal(result.success, false);
  const byteLen = new TextEncoder().encode(result.error || '').length;
  assert.ok(byteLen <= 32768, `Error byte length must be <= 32 KiB, got ${byteLen}`);
});

test('F1-A (P2): mutating descriptor and slice before timeout does not transfer > 32 KiB across boundary', async () => {
  let transferredBytes = 0;
  const instrumented = loadProductionQuickJSRunner({
    onGetString: (bytes) => {
      transferredBytes += bytes;
    },
  });

  const result = await instrumented.runScriptInQuickJS({
    script: `
      Object.getOwnPropertyDescriptor = function () {
        return { value: 'x'.repeat(2 * 1024 * 1024) };
      };
      String.prototype.slice = function () {
        return 'y'.repeat(2 * 1024 * 1024);
      };
      while (true) {}
    `,
    environment: { token: 'original' },
    variables: { varKey: 'origVal' },
  }, { timeoutMs: 50 });

  assert.equal(result.success, false);
  assert.equal(result.error, 'Script execution timed out.');
  assert.equal(result.environment.token, 'original');
  assert.equal(result.variables.varKey, 'origVal');
  assert.ok(
    transferredBytes <= 32768,
    `Host getString transfer must not exceed 32 KiB during timeout error handling, got ${transferredBytes} bytes`
  );
});

test('F1-B (P2): mutating descriptor with finite delay does not delay runner beyond timeout + cleanup budget', async () => {
  // Warm up QuickJS engine first
  await runScriptInQuickJS({ script: '1 + 1', environment: {}, variables: {} }, { timeoutMs: 50 });

  const start = Date.now();
  const result = await runScriptInQuickJS({
    script: `
      Object.getOwnPropertyDescriptor = function () {
        const until = Date.now() + 350;
        while (Date.now() < until) {}
        return { value: 'interrupted' };
      };
      while (true) {}
    `,
    environment: { envKey: 'initial' },
    variables: {},
  }, { timeoutMs: 50 });
  const duration = Date.now() - start;

  assert.equal(result.success, false);
  assert.equal(result.error, 'Script execution timed out.');
  assert.equal(result.environment.envKey, 'initial');
  assert.ok(
    duration < 250,
    `Probe with 50 ms timeout + 350 ms guest delay must not execute guest during fallback, took ${duration} ms`
  );
});

test('F1-C (P2): throwing proxy error with infinite loop in traps is safely bounded by cleanup interrupt', async () => {
  const start = Date.now();
  const result = await runScriptInQuickJS({
    script: `
      throw new Proxy(new Error('evil'), {
        get() { while (true) {} },
        getOwnPropertyDescriptor() { while (true) {} }
      });
    `,
    environment: { envKey: 'safe' },
    variables: {},
  }, { timeoutMs: 50 });
  const duration = Date.now() - start;

  assert.equal(result.success, false);
  assert.equal(result.error, 'Script execution timed out.');
  assert.equal(result.environment.envKey, 'safe');
  assert.ok(duration < 250, `Proxy infinite loop in traps took ${duration} ms (should be <= 250 ms)`);
});

test('T-G3 (P3): throwing proxy error with infinite loop in traps returns Script execution timed out with 2000ms main timeout', async () => {
  const start = Date.now();
  const result = await runScriptInQuickJS({
    script: `
      throw new Proxy({}, {
        getOwnPropertyDescriptor() { while (true) {} }
      });
    `,
    environment: { envKey: 'safe' },
    variables: {},
  }, { timeoutMs: 2000 });
  const duration = Date.now() - start;

  assert.equal(result.success, false);
  assert.equal(result.error, 'Script execution timed out.');
  assert.equal(result.environment.envKey, 'safe');
  assert.ok(duration < 350, `Cleanup interrupt must abort in ~50ms, took ${duration}ms`);
});
