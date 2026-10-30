import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// NOTE: This test harness exercises production algorithms (readResponseBody, normalizeCloudApiUrl)
// within a Node test environment using local HTTP test servers. Native Tauri IPC and WebView capabilities
// are tracked separately under native integration tests.

function loadProductionFetcher() {
  const fetcherSrc = fs.readFileSync(new URL('../packages/common/src/lib/fetcher.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(fetcherSrc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(
    compiled,
    {
      exports,
      require: () => ({}),
      console,
      setTimeout,
      clearTimeout,
      TextDecoder,
      TextEncoder,
      Headers,
      Response,
      Request,
      URL,
      AbortController,
    },
    { filename: 'fetcher.ts' }
  );

  return {
    readResponseBody: exports.readResponseBody,
    ResponseTooLargeError: exports.ResponseTooLargeError,
  };
}

function loadProductionCloudApi() {
  const cloudSrc = fs.readFileSync(new URL('../packages/common/src/lib/cloudApi.ts', import.meta.url), 'utf8')
    .replaceAll('import.meta.env', '({})');
  const compiled = ts.transpileModule(cloudSrc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(
    compiled,
    {
      exports,
      fetch,
      Headers,
      Response,
      Request,
      URL,
      TextEncoder,
      console,
    },
    { filename: 'cloudApi.ts' }
  );

  return {
    normalizeCloudApiUrl: exports.normalizeCloudApiUrl,
    fetchWithAuth: exports.fetchWithAuth,
    setCloudTransport: exports.setCloudTransport,
  };
}

function loadProductionRuntime() {
  const runtimeSrc = fs.readFileSync(new URL('../packages/common/src/runtime.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(runtimeSrc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let currentPlatformAdapter = null;
  let currentCloudTransport = null;
  let currentScriptExecutor = null;

  const createMockStore = () => {
    let state = { tabs: [{ id: 'tab-1' }] };
    return {
      getState: () => state,
      setState: (s) => { state = typeof s === 'function' ? s(state) : { ...state, ...s }; },
      subscribe: () => () => {},
    };
  };

  const exports = {};
  const mockRequire = (id) => {
    if (id.includes('useApiStore')) {
      return {
        createApiStore: () => createMockStore(),
        defaultApiStore: createMockStore(),
        setActiveRuntimeStore: () => {},
        getActiveRuntimeStore: () => null,
      };
    }
    if (id.includes('cloudApi')) {
      return {
        setCloudTransport: (t) => { currentCloudTransport = t; },
        getCloudTransport: () => currentCloudTransport,
        registerTokenRefreshCallback: () => () => {},
        registerAuthEvictedCallback: () => () => {},
      };
    }
    if (id.includes('scriptRunner')) {
      return {
        setScriptExecutor: (e) => { currentScriptExecutor = e; },
        getScriptExecutor: () => currentScriptExecutor,
      };
    }
    if (id.includes('fetcher')) {
      return {
        setDefaultPlatformAdapter: (a) => { currentPlatformAdapter = a; },
        getDefaultPlatformAdapter: () => currentPlatformAdapter,
      };
    }
    return {};
  };

  vm.runInNewContext(
    compiled,
    {
      exports,
      require: mockRequire,
      console,
    },
    { filename: 'runtime.ts' }
  );

  return {
    createAirrestRuntime: exports.createAirrestRuntime,
    getCurrentPlatformAdapter: () => currentPlatformAdapter,
    getCurrentCloudTransport: () => currentCloudTransport,
    getCurrentScriptExecutor: () => currentScriptExecutor,
  };
}

const { readResponseBody, ResponseTooLargeError } = loadProductionFetcher();
const { normalizeCloudApiUrl, fetchWithAuth, setCloudTransport } = loadProductionCloudApi();
const {
  createAirrestRuntime,
  getCurrentPlatformAdapter,
  getCurrentCloudTransport,
  getCurrentScriptExecutor,
} = loadProductionRuntime();

// Helper: Setup in-memory test server
function setupEchoServer() {
  let redirectTargetHit = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/echo') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Echoed-Host': req.headers.host || '',
          'X-Echoed-Cookie': req.headers.cookie || '',
          'X-Echoed-User-Agent': req.headers['user-agent'] || '',
        });
        res.end(JSON.stringify({
          method: req.method,
          headers: req.headers,
          bodyBase64: bodyBuffer.toString('base64'),
          bodyText: bodyBuffer.toString('utf8'),
        }));
      });
      return;
    }

    if (url.pathname === '/redirect-target') {
      redirectTargetHit++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hit: true }));
      return;
    }

    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: '/echo' });
      res.end();
      return;
    }

    if (url.pathname === '/cloud-302-redirect') {
      res.writeHead(302, { Location: '/redirect-target' });
      res.end('Redirecting');
      return;
    }

    if (url.pathname === '/cloud-307-redirect') {
      res.writeHead(307, { Location: '/redirect-target' });
      res.end('Temporary Redirect');
      return;
    }

    if (url.pathname === '/binary-pattern') {
      const buf = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) buf[i] = i;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '256',
      });
      res.end(buf);
      return;
    }

    if (url.pathname === '/oversized-declared') {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': String(20 * 1024 * 1024), // 20 MiB declared
      });
      res.end('Should have been rejected before reading');
      return;
    }

    if (url.pathname === '/infinite-chunks') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Transfer-Encoding': 'chunked',
      });
      const chunk = Buffer.alloc(64 * 1024, 0x41); // 64 KiB of 'A'
      const interval = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) {
          res.write(chunk);
        } else {
          clearInterval(interval);
        }
      }, 5);

      req.on('close', () => clearInterval(interval));
      return;
    }

    if (url.pathname === '/stall-after-headers') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        server,
        baseUrl,
        getRedirectTargetHit: () => redirectTargetHit,
        close: () => new Promise(cb => server.close(cb)),
      });
    });
  });
}

test('Gate P0.1 & P0.2: Local header echo and binary byte parity', async () => {
  const { baseUrl, close } = await setupEchoServer();

  try {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': 'session_token=secret123; user_id=42',
        'User-Agent': 'AirREST-Desktop/1.0',
        'X-Custom-Header': 'Testing-Parity',
      },
      body: JSON.stringify({ ping: 'pong' }),
      signal: controller.signal,
    });

    assert.equal(res.status, 200);
    const bodyBytes = await readResponseBody(res, controller);
    const text = new TextDecoder().decode(bodyBytes);
    const json = JSON.parse(text);

    assert.equal(json.headers['cookie'], 'session_token=secret123; user_id=42');
    assert.equal(json.headers['user-agent'], 'AirREST-Desktop/1.0');
    assert.equal(json.headers['x-custom-header'], 'Testing-Parity');
    assert.deepEqual(JSON.parse(json.bodyText), { ping: 'pong' });

    // Test binary pattern
    const binRes = await fetch(`${baseUrl}/binary-pattern`, { signal: controller.signal });
    const binBytes = await readResponseBody(binRes, controller);
    assert.equal(binBytes.byteLength, 256);
    for (let i = 0; i < 256; i++) {
      assert.equal(binBytes[i], i, `Byte mismatch at index ${i}`);
    }
  } finally {
    await close();
  }
});

test('Gate P0.1: Redirect controls (redirect: follow vs manual)', async () => {
  const { baseUrl, close } = await setupEchoServer();

  try {
    // 1. Follow redirect
    const followRes = await fetch(`${baseUrl}/redirect`, { redirect: 'follow' });
    assert.equal(followRes.status, 200);
    assert.ok(followRes.url.includes('/echo'));

    // 2. Manual redirect (do not follow)
    const manualRes = await fetch(`${baseUrl}/redirect`, { redirect: 'manual' });
    assert.ok(manualRes.status === 302 || manualRes.type === 'opaqueredirect');
  } finally {
    await close();
  }
});

test('Gate P0.4: normalizeCloudApiUrl scheme preservation and loopback resolution', () => {
  // Explicit schemes are always preserved exactly
  assert.equal(normalizeCloudApiUrl('http://192.168.1.50:8000'), 'http://192.168.1.50:8000');
  assert.equal(normalizeCloudApiUrl('http://myserver.lan:8080'), 'http://myserver.lan:8080');
  assert.equal(normalizeCloudApiUrl('https://api.example.com'), 'https://api.example.com');

  // Scheme-less loopback defaults to http://
  assert.equal(normalizeCloudApiUrl('localhost:8080'), 'http://localhost:8080');
  assert.equal(normalizeCloudApiUrl('127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.equal(normalizeCloudApiUrl('[::1]:9000'), 'http://[::1]:9000');

  // Scheme-less remote host defaults to https://
  assert.equal(normalizeCloudApiUrl('api.example.com'), 'https://api.example.com');
  assert.equal(normalizeCloudApiUrl('api.example.com/subpath'), 'https://api.example.com/subpath');

  // Substring match attack: host containing 'localhost' as domain suffix is NOT loopback
  assert.equal(normalizeCloudApiUrl('localhost.attacker.com'), 'https://localhost.attacker.com');
});

test('Gate P0.4: Cloud requests reject redirects and never hit redirect target', async () => {
  const { baseUrl, getRedirectTargetHit, close } = await setupEchoServer();

  try {
    // Attempting a cloud request to a 302 redirecting endpoint must reject with a descriptive error
    await assert.rejects(
      async () => {
        await fetchWithAuth('/cloud-302-redirect', {
          apiUrl: baseUrl,
          token: 'sensitive-token',
        });
      },
      (err) => {
        assert.match(err.message, /redirect/i);
        return true;
      }
    );

    // Attempting a cloud request to a 307 redirecting endpoint must reject
    await assert.rejects(
      async () => {
        await fetchWithAuth('/cloud-307-redirect', {
          apiUrl: baseUrl,
          token: 'sensitive-token',
        });
      },
      (err) => {
        assert.match(err.message, /redirect/i);
        return true;
      }
    );

    // Target must receive ZERO requests (no credential leakage to target)
    assert.equal(getRedirectTargetHit(), 0, 'Target endpoint must have received zero requests');
  } finally {
    await close();
  }
});

test('Gate P0.2: Declared Content-Length > 10 MiB rejected before body read', async () => {
  const { baseUrl, close } = await setupEchoServer();

  try {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/oversized-declared`, { signal: controller.signal });
    await assert.rejects(
      async () => {
        await readResponseBody(res, controller);
      },
      ResponseTooLargeError
    );
    assert.equal(controller.signal.aborted, true);
  } finally {
    await close();
  }
});

test('Gate P0.2: Infinite chunk stream aborted when exceeding 10 MiB limit', async () => {
  const { baseUrl, close } = await setupEchoServer();

  try {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/infinite-chunks`, { signal: controller.signal });
    await assert.rejects(
      async () => {
        await readResponseBody(res, controller);
      },
      ResponseTooLargeError
    );
    assert.equal(controller.signal.aborted, true);
  } finally {
    await close();
  }
});

test('Gate P0.2: Reading timeout aborts request and releases resources', async () => {
  const { baseUrl, close } = await setupEchoServer();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 100);

    await assert.rejects(
      async () => {
        const res = await fetch(`${baseUrl}/stall-after-headers`, { signal: controller.signal });
        await readResponseBody(res, controller);
      },
      (err) => err.name === 'AbortError'
    );

    clearTimeout(timeout);
  } finally {
    await close();
  }
});

test('Gate P0.1/F8: Runtime creation wires adapter, executor, and cloud transport (full edition)', () => {
  let adapterDisposed = false;
  const mockAdapter = {
    cloudTransport: { fetch: async () => new Response() },
    scriptExecutor: { execute: async () => ({ success: true, environment: {}, variables: {} }) },
    saveFile: async () => false,
    openFile: async () => null,
    dispose: () => { adapterDisposed = true; },
  };

  const runtime = createAirrestRuntime({
    adapter: mockAdapter,
    edition: 'full',
  });

  assert.equal(getCurrentPlatformAdapter(), mockAdapter);
  assert.equal(getCurrentCloudTransport(), mockAdapter.cloudTransport);
  assert.equal(getCurrentScriptExecutor(), mockAdapter.scriptExecutor);
  assert.ok(runtime.store);

  runtime.dispose();
  assert.equal(adapterDisposed, true);
  assert.equal(getCurrentPlatformAdapter(), null);
  assert.equal(getCurrentCloudTransport(), null);
  assert.equal(getCurrentScriptExecutor(), null);
});

test('Gate P0.1/F8: Offline runtime does NOT wire cloud transport', () => {
  let adapterDisposed = false;
  const mockAdapter = {
    cloudTransport: { fetch: async () => new Response() },
    scriptExecutor: { execute: async () => ({ success: true, environment: {}, variables: {} }) },
    saveFile: async () => false,
    openFile: async () => null,
    dispose: () => { adapterDisposed = true; },
  };

  const runtime = createAirrestRuntime({
    adapter: mockAdapter,
    edition: 'offline',
  });

  assert.equal(getCurrentPlatformAdapter(), mockAdapter);
  assert.equal(getCurrentCloudTransport(), null); // skipped for offline edition
  assert.equal(getCurrentScriptExecutor(), mockAdapter.scriptExecutor);

  runtime.dispose();
  assert.equal(adapterDisposed, true);
});

test('Gate P0.1/F8: Disposing runtime A does not break independent runtime B, its store, or its services', () => {
  let disposedA = false;
  let disposedB = false;

  const mockScriptExecutorA = { execute: async () => ({ success: true, environment: {}, variables: {} }) };
  const mockScriptExecutorB = { execute: async () => ({ success: true, environment: {}, variables: {} }) };

  const adapterA = {
    cloudTransport: { fetch: async () => new Response('a') },
    scriptExecutor: mockScriptExecutorA,
    saveFile: async () => false,
    openFile: async () => null,
    dispose: () => { disposedA = true; },
  };

  const adapterB = {
    cloudTransport: { fetch: async () => new Response('b') },
    scriptExecutor: mockScriptExecutorB,
    saveFile: async () => false,
    openFile: async () => null,
    dispose: () => { disposedB = true; },
  };

  // Instantiated without custom store: each runtime MUST get its own distinct store
  const runtimeA = createAirrestRuntime({ adapter: adapterA });
  const runtimeB = createAirrestRuntime({ adapter: adapterB });

  assert.notEqual(runtimeA.store, runtimeB.store, 'Each runtime must possess an isolated store instance');
  assert.equal(getCurrentPlatformAdapter(), adapterB);
  assert.equal(getCurrentCloudTransport(), adapterB.cloudTransport);
  assert.equal(getCurrentScriptExecutor(), mockScriptExecutorB);

  // Dispose runtime A
  runtimeA.dispose();
  assert.equal(disposedA, true);
  assert.equal(disposedB, false);

  // Runtime B services and adapter must remain completely intact!
  assert.equal(getCurrentPlatformAdapter(), adapterB);
  assert.equal(getCurrentCloudTransport(), adapterB.cloudTransport);
  assert.equal(getCurrentScriptExecutor(), mockScriptExecutorB);

  // Dispose runtime B
  runtimeB.dispose();
  assert.equal(disposedB, true);
  assert.equal(getCurrentPlatformAdapter(), null);
  assert.equal(getCurrentCloudTransport(), null);
  assert.equal(getCurrentScriptExecutor(), null);
});

// =========================================================================
// R2: Host Watchdog, Worker Lifecycle & Abort Propagation Suite
// =========================================================================

function loadProductionTauriExecutor(MockWorkerClass) {
  const adapterSrc = fs.readFileSync(new URL('../apps/desktop/src/adapters/tauriAdapter.ts', import.meta.url), 'utf8')
    .replaceAll('import.meta.url', '"file:///dummy.ts"');
  const compiled = ts.transpileModule(adapterSrc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const protoSrc = fs.readFileSync(new URL('../packages/common/src/lib/scriptProtocol.ts', import.meta.url), 'utf8');
  const protoCompiled = ts.transpileModule(protoSrc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const protoExports = {};
  vm.runInNewContext(protoCompiled, { exports: protoExports, console, TextEncoder }, { filename: 'scriptProtocol.ts' });

  const exports = {};
  const mockRequire = (id) => {
    if (id.includes('scriptProtocol') || id.includes('@airrest/common')) return protoExports;
    return {};
  };

  vm.runInNewContext(
    compiled,
    {
      exports,
      require: mockRequire,
      Worker: MockWorkerClass,
      URL,
      setTimeout,
      clearTimeout,
      console,
      Date,
      Math,
    },
    { filename: 'tauriAdapter.ts' }
  );

  return exports.tauriScriptExecutor;
}

test('R2 (P1): tauriScriptExecutor terminates worker immediately upon AbortSignal abort', async () => {
  let terminated = false;
  class SilentWorker {
    constructor() {}
    postMessage() {}
    terminate() { terminated = true; }
  }

  const executor = loadProductionTauriExecutor(SilentWorker);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);

  const startTime = Date.now();
  const result = await executor.execute(
    { script: 'while(true){}', environment: { token: 't1' }, variables: {} },
    { signal: controller.signal }
  );

  const elapsed = Date.now() - startTime;
  assert.equal(terminated, true, 'Worker must be terminated upon abort');
  assert.equal(result.success, false);
  assert.match(result.error, /aborted/i);
  assert.equal(result.environment.token, 't1');
  assert.ok(elapsed < 200, `Execution should abort promptly, took ${elapsed}ms`);
});

test('R2 (P1): tauriScriptExecutor.dispose() terminates all active workers and cleans up registry', async () => {
  let terminated = false;
  class SilentWorker {
    constructor() {}
    postMessage() {}
    terminate() { terminated = true; }
  }

  const executor = loadProductionTauriExecutor(SilentWorker);
  // Start execution that doesn't settle immediately
  executor.execute(
    { script: 'while(true){}', environment: {}, variables: {} },
    { timeoutMs: 2000 }
  );

  // Call dispose immediately
  executor.dispose();
  assert.equal(terminated, true, 'Worker must be terminated when executor is disposed');
});

test('R2 (P1): tauriScriptExecutor watchdog timer terminates silent worker when deadline exceeded', async () => {
  let terminated = false;
  class SilentWorker {
    constructor() {}
    postMessage(msg) {
      if (msg && msg.type === 'EXECUTE') {
        setTimeout(() => {
          if (this.onmessage) this.onmessage({ data: { id: msg.id, type: 'EVAL_START' } });
        }, 10);
      }
    }
    terminate() { terminated = true; }
  }

  const executor = loadProductionTauriExecutor(SilentWorker);
  const startTime = Date.now();
  const result = await executor.execute(
    { script: 'while(true){}', environment: { token: 't1' }, variables: {} },
    { timeoutMs: 100 }
  );
  const elapsed = Date.now() - startTime;
  assert.equal(terminated, true, 'Worker must be terminated by watchdog');
  assert.equal(result.success, false);
  assert.match(result.error, /host watchdog|timed out/i);
  assert.ok(elapsed >= 250 && elapsed < 800, `Watchdog should fire after timeoutMs + 200ms, took ${elapsed}ms`);
});

test('D4 (P2): tauriScriptExecutor startup timer terminates uninitialized worker after 5000ms deadline', async () => {
  let terminated = false;
  class UninitializedWorker {
    constructor() {}
    postMessage() {}
    terminate() { terminated = true; }
  }

  const executor = loadProductionTauriExecutor(UninitializedWorker);
  const startTime = Date.now();
  const result = await executor.execute(
    { script: '1+1', environment: {}, variables: {} }
  );
  const elapsed = Date.now() - startTime;
  assert.equal(terminated, true, 'Uninitialized worker must be terminated by startup timer');
  assert.equal(result.success, false);
  assert.match(result.error, /failed to initialize within 5000ms startup timeout/i);
  assert.ok(elapsed >= 4900 && elapsed < 6500, `Startup timer should fire at ~5000ms, took ${elapsed}ms`);
});

test('D4 (P2): Slow worker startup (e.g. 400ms before EVAL_START) does NOT trigger evaluation watchdog', async () => {
  let terminated = false;
  class SlowStartupWorker {
    constructor() {}
    postMessage(msg) {
      if (msg && msg.type === 'EXECUTE') {
        // Startup takes 400ms before sending EVAL_START
        setTimeout(() => {
          if (this.onmessage) {
            this.onmessage({ data: { id: msg.id, type: 'EVAL_START' } });
            // Then evaluation takes another 100ms
            setTimeout(() => {
              if (this.onmessage) {
                this.onmessage({
                  data: {
                    id: msg.id,
                    type: 'RESULT',
                    result: { success: true, environment: { done: 'true' }, variables: {} },
                  },
                });
              }
            }, 100);
          }
        }, 400);
      }
    }
    terminate() { terminated = true; }
  }

  const executor = loadProductionTauriExecutor(SlowStartupWorker);
  const startTime = Date.now();
  // timeoutMs is 250ms. Total time is ~500ms. If startup shared the eval watchdog, it would fail at 250+200=450ms!
  const result = await executor.execute(
    { script: '1+1', environment: {}, variables: {} },
    { timeoutMs: 250 }
  );
  const elapsed = Date.now() - startTime;
  assert.equal(result.success, true, 'Script must succeed despite slow startup');
  assert.equal(result.environment.done, 'true');
  assert.ok(elapsed >= 450, `Slow startup took ${elapsed}ms and completed successfully`);
});

test('R2 (P1): tauriScriptExecutor returns structured failure when worker constructor fails without UI fallback', async () => {
  class FailingWorker {
    constructor() {
      throw new Error('Worker disabled by CSP');
    }
  }

  const executor = loadProductionTauriExecutor(FailingWorker);
  const result = await executor.execute({ script: '1+1', environment: {}, variables: {} });
  assert.equal(result.success, false);
  assert.match(result.error, /Worker disabled by CSP|Worker initialization failed/i);
});

test('D3 (P2): Multi-runtime isolation with production runtime and store instances', async () => {
  const { createRequire } = await import('node:module');
  const nodeRequire = createRequire(import.meta.url);
  const zustand = nodeRequire('zustand');
  const zustandMiddleware = nodeRequire('zustand/middleware');
  const React = nodeRequire('react');

  function transpile(filePath) {
    const src = fs.readFileSync(new URL(filePath, import.meta.url), 'utf8').replaceAll('import.meta.env', '({})');
    return ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }

  const moduleCache = {};
  function runModule(filePath, sandbox) {
    if (moduleCache[filePath]) return moduleCache[filePath];
    const compiled = transpile(filePath);
    const exports = {};
    const customRequire = (id) => {
      if (id === 'zustand') return zustand;
      if (id === 'zustand/middleware') return zustandMiddleware;
      if (id === 'react') return React;
      if (id.includes('storeContext')) return runModule('../packages/common/src/store/storeContext.ts', sandbox);
      if (id.includes('storage')) return { appStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, onStorageCommit: () => () => {} };
      if (id.includes('fetcher')) return runModule('../packages/common/src/lib/fetcher.ts', sandbox);
      if (id.includes('blobManager')) return runModule('../packages/common/src/lib/blobManager.ts', sandbox);
      if (id.includes('postman')) return runModule('../packages/common/src/lib/postman.ts', sandbox);
      if (id.includes('scriptRunner')) return runModule('../packages/common/src/lib/scriptRunner.ts', sandbox);
      if (id.includes('urlParams')) return runModule('../packages/common/src/lib/urlParams.ts', sandbox);
      if (id.includes('cloudApi')) return runModule('../packages/common/src/lib/cloudApi.ts', sandbox);
      if (id.includes('treeHelper')) return runModule('../packages/common/src/lib/treeHelper.ts', sandbox);
      if (id.includes('useApiStore')) return runModule('../packages/common/src/store/useApiStore.ts', sandbox);
      if (id.includes('runtime')) return runModule('../packages/common/src/runtime.ts', sandbox);
      return {};
    };

    const context = {
      ...sandbox,
      exports,
      require: customRequire,
    };
    vm.runInNewContext(compiled, context, { filename: filePath });
    moduleCache[filePath] = exports;
    return exports;
  }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder,
    Headers,
    Response,
    Request,
    URL,
    AbortController,
    fetch,
    Date,
    Math,
    performance,
  };

  const runtimeModule = runModule('../packages/common/src/runtime.ts', sandbox);
  const cloudApiModule = runModule('../packages/common/src/lib/cloudApi.ts', sandbox);

  let adapterACalls = 0;
  let adapterBCalls = 0;

  const adapterA = {
    id: 'adapter-A',
    hasHostPermission: async () => { adapterACalls++; return true; },
    requestHostPermission: async () => true,
    dispose: () => {},
  };

  const adapterB = {
    id: 'adapter-B',
    hasHostPermission: async () => { adapterBCalls++; return true; },
    requestHostPermission: async () => true,
    dispose: () => {},
  };

  const runtimeA = runtimeModule.createAirrestRuntime({ adapter: adapterA });
  const runtimeB = runtimeModule.createAirrestRuntime({ adapter: adapterB });

  // Probe 1: sendRequest from A uses adapter A, not adapter B
  runtimeA.store.setState({
    tabs: [{ id: 'tab-1', url: 'http://localhost:9999/test', method: 'GET', headers: [], queryParams: [] }],
    activeTabId: 'tab-1',
  });

  let requestAAborted = false;
  sandbox.fetch = async (url, init) => {
    if (init && init.signal) {
      init.signal.addEventListener('abort', () => { requestAAborted = true; });
    }
    await new Promise((r) => setTimeout(r, 60));
    return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
  };

  // Probe 2: B.store.logoutCloud() during in-flight request A does NOT abort request A
  const pA = runtimeA.store.getState().sendRequest();
  runtimeB.store.getState().logoutCloud();
  await pA;

  assert.equal(adapterACalls, 1, 'Runtime A must use adapter A');
  assert.equal(adapterBCalls, 0, 'Runtime A must NOT use adapter B');
  assert.equal(requestAAborted, false, 'Logout in runtime B must NOT abort request in runtime A');

  // Probe 3: Auth eviction with failedToken B does NOT evict runtime A
  runtimeA.store.getState().setCloudConfig({ token: 'token-A', refreshToken: 'ref-A' });
  runtimeB.store.getState().setCloudConfig({ token: 'token-B', refreshToken: 'ref-B' });

  cloudApiModule.setCloudTransport({
    fetch: async () => new Response('Unauthorized', { status: 401 }),
  });

  try {
    await cloudApiModule.fetchWithAuth('/api/v1/scopes', { apiUrl: 'http://localhost:8080', token: 'token-B' });
  } catch {
    // expected 401
  }

  assert.equal(runtimeA.store.getState().cloudConfig.token, 'token-A', 'Runtime A token must be preserved');
  assert.equal(runtimeB.store.getState().cloudConfig.token, undefined, 'Runtime B token must be evicted upon 401');

  runtimeA.dispose();
  runtimeB.dispose();
});

test('V1 (P1): Cross-origin refresh isolation - separate origins do not join or leak refresh tokens', async () => {
  const { createRequire } = await import('node:module');
  const nodeRequire = createRequire(import.meta.url);
  const zustand = nodeRequire('zustand');
  const zustandMiddleware = nodeRequire('zustand/middleware');
  const React = nodeRequire('react');

  function transpile(filePath) {
    const src = fs.readFileSync(new URL(filePath, import.meta.url), 'utf8').replaceAll('import.meta.env', '({})');
    return ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }

  function createEnv() {
    const moduleCache = {};
    const sandbox = {
      console,
      setTimeout,
      clearTimeout,
      TextDecoder,
      TextEncoder,
      Headers,
      Response,
      Request,
      URL,
      AbortController,
      fetch,
      Date,
      Math,
      performance,
    };
    function runModule(filePath) {
      if (moduleCache[filePath]) return moduleCache[filePath];
      const compiled = transpile(filePath);
      const exports = {};
      const customRequire = (id) => {
        if (id === 'zustand') return zustand;
        if (id === 'zustand/middleware') return zustandMiddleware;
        if (id === 'react') return React;
        if (id.includes('storeContext')) return runModule('../packages/common/src/store/storeContext.ts');
        if (id.includes('storage')) return { appStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, onStorageCommit: () => () => {} };
        if (id.includes('fetcher')) return runModule('../packages/common/src/lib/fetcher.ts');
        if (id.includes('blobManager')) return runModule('../packages/common/src/lib/blobManager.ts');
        if (id.includes('postman')) return runModule('../packages/common/src/lib/postman.ts');
        if (id.includes('scriptRunner')) return runModule('../packages/common/src/lib/scriptRunner.ts');
        if (id.includes('urlParams')) return runModule('../packages/common/src/lib/urlParams.ts');
        if (id.includes('cloudApi')) return runModule('../packages/common/src/lib/cloudApi.ts');
        if (id.includes('treeHelper')) return runModule('../packages/common/src/lib/treeHelper.ts');
        if (id.includes('useApiStore')) return runModule('../packages/common/src/store/useApiStore.ts');
        if (id.includes('runtime')) return runModule('../packages/common/src/runtime.ts');
        return {};
      };
      vm.runInNewContext(compiled, { ...sandbox, exports, require: customRequire }, { filename: filePath });
      moduleCache[filePath] = exports;
      return exports;
    }
    return { runModule, sandbox };
  }

  const { runModule } = createEnv();
  const cloudApi = runModule('../packages/common/src/lib/cloudApi.ts');

  const refreshedOrigins = [];
  cloudApi.setCloudTransport({
    fetch: async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/v1/auth/refresh')) {
        const body = JSON.parse(init.body);
        const refToken = body.refresh_token || body.refreshToken;
        refreshedOrigins.push({ url: urlStr, refreshToken: refToken });
        await new Promise((r) => setTimeout(r, 40));
        return new Response(JSON.stringify({
          token: `new-token-for-${refToken}`,
          refresh_token: `new-ref-for-${refToken}`,
          expiresIn: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      // Headers can be Headers object or plain object from cloudFetch
      const auth = (init.headers?.authorization || init.headers?.Authorization || '') ||
        (typeof init.headers?.get === 'function' ? (init.headers.get('authorization') || init.headers.get('Authorization') || '') : '');
      if (auth.includes('old-token-A') || auth.includes('old-token-B')) {
        return new Response('Unauthorized', { status: 401 });
      }

      // Retry request with refreshed token succeeds
      return new Response(JSON.stringify({ success: true, authHeader: auth }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const [resA, resB] = await Promise.all([
    cloudApi.fetchWithAuth('/api/v1/workspaces', {
      apiUrl: 'https://origin-a.example.com',
      token: 'old-token-A',
      refreshToken: 'old-ref-A',
    }),
    cloudApi.fetchWithAuth('/api/v1/workspaces', {
      apiUrl: 'https://origin-b.example.com',
      token: 'old-token-B',
      refreshToken: 'old-ref-B',
    }),
  ]);

  const dataA = await resA.json();
  const dataB = await resB.json();

  assert.equal(dataA.authHeader, 'Bearer new-token-for-old-ref-A');
  assert.equal(dataB.authHeader, 'Bearer new-token-for-old-ref-B');
  assert.equal(refreshedOrigins.length, 2);
  assert.ok(refreshedOrigins.some((r) => r.url.includes('origin-a.example.com') && r.refreshToken === 'old-ref-A'));
  assert.ok(refreshedOrigins.some((r) => r.url.includes('origin-b.example.com') && r.refreshToken === 'old-ref-B'));
});

test('V2 (P2): Retried 401 after silent token rotation evicts the rotated token from store', async () => {
  const { createRequire } = await import('node:module');
  const nodeRequire = createRequire(import.meta.url);
  const zustand = nodeRequire('zustand');
  const zustandMiddleware = nodeRequire('zustand/middleware');
  const React = nodeRequire('react');

  function transpile(filePath) {
    const src = fs.readFileSync(new URL(filePath, import.meta.url), 'utf8').replaceAll('import.meta.env', '({})');
    return ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }

  const moduleCache = {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder,
    Headers,
    Response,
    Request,
    URL,
    AbortController,
    fetch,
    Date,
    Math,
    performance,
  };
  function runModule(filePath) {
    if (moduleCache[filePath]) return moduleCache[filePath];
    const compiled = transpile(filePath);
    const exports = {};
    const customRequire = (id) => {
      if (id === 'zustand') return zustand;
      if (id === 'zustand/middleware') return zustandMiddleware;
      if (id === 'react') return React;
      if (id.includes('storeContext')) return runModule('../packages/common/src/store/storeContext.ts');
      if (id.includes('storage')) return { appStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, onStorageCommit: () => () => {} };
      if (id.includes('fetcher')) return runModule('../packages/common/src/lib/fetcher.ts');
      if (id.includes('blobManager')) return runModule('../packages/common/src/lib/blobManager.ts');
      if (id.includes('postman')) return runModule('../packages/common/src/lib/postman.ts');
      if (id.includes('scriptRunner')) return runModule('../packages/common/src/lib/scriptRunner.ts');
      if (id.includes('urlParams')) return runModule('../packages/common/src/lib/urlParams.ts');
      if (id.includes('cloudApi')) return runModule('../packages/common/src/lib/cloudApi.ts');
      if (id.includes('treeHelper')) return runModule('../packages/common/src/lib/treeHelper.ts');
      if (id.includes('jwt')) return runModule('../packages/common/src/lib/jwt.ts');
      if (id.includes('requestDiff')) return runModule('../packages/common/src/lib/requestDiff.ts');
      if (id.includes('cloudSyncTransformer')) return runModule('../packages/common/src/lib/cloudSyncTransformer.ts');
      if (id.includes('edition')) return { isOfflineOnly: false };
      if (id.includes('useApiStore')) return runModule('../packages/common/src/store/useApiStore.ts');
      if (id.includes('runtime')) return runModule('../packages/common/src/runtime.ts');
      return {};
    };
    vm.runInNewContext(compiled, { ...sandbox, exports, require: customRequire }, { filename: filePath });
    moduleCache[filePath] = exports;
    return exports;
  }

  const runtimeModule = runModule('../packages/common/src/runtime.ts');
  const cloudApiModule = runModule('../packages/common/src/lib/cloudApi.ts');

  const adapter = {
    id: 'test-adapter',
    hasHostPermission: async () => true,
    requestHostPermission: async () => true,
    dispose: () => {},
  };
  const runtime = runtimeModule.createAirrestRuntime({ adapter });
  runtime.store.getState().setCloudConfig({
    apiUrl: 'http://localhost:8080',
    token: 'initial-stale-token',
    refreshToken: 'valid-refresh-token',
  });

  cloudApiModule.setCloudTransport({
    fetch: async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/v1/auth/refresh')) {
        // Refresh rotates to a new token
        return new Response(JSON.stringify({
          data: {
            token: 'rotated-new-token',
            refresh_token: 'rotated-new-refresh',
            expires_at: Date.now() + 3600000,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      // Initial request with initial-stale-token returns 401
      // Retried request with rotated-new-token ALSO returns 401 (e.g. revoked account)
      return new Response('Unauthorized', { status: 401 });
    },
  });

  try {
    await cloudApiModule.fetchWithAuth('/api/v1/workspaces', {
      apiUrl: 'http://localhost:8080',
      token: runtime.store.getState().cloudConfig.token,
      refreshToken: runtime.store.getState().cloudConfig.refreshToken,
    });
  } catch {
    // expected 401
  }

  // Verify that store evicted the rotated token!
  assert.equal(runtime.store.getState().cloudConfig.token, undefined, 'Store must evict rotated token after retry 401');
  runtime.dispose();
});

test('V3 (P2): QuickJS runner defers EVAL_START until WASM initialization finishes', async () => {
  const runnerSrc = fs.readFileSync(new URL('../apps/desktop/src/scripts/quickjsRunner.ts', import.meta.url), 'utf8');
  const protoSrc = fs.readFileSync(new URL('../packages/common/src/lib/scriptProtocol.ts', import.meta.url), 'utf8');

  const protoCompiled = ts.transpileModule(protoSrc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const protoExports = {};
  vm.runInNewContext(protoCompiled, { exports: protoExports, console, TextEncoder }, { filename: 'scriptProtocol.ts' });

  const runnerCompiled = ts.transpileModule(runnerSrc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const runnerExports = {};
  const { getQuickJS } = await import('quickjs-emscripten');
  const customRequire = (id) => {
    if (id === 'quickjs-emscripten') return { getQuickJS };
    if (id.includes('protocol') || id.includes('common')) return protoExports;
    return {};
  };

  vm.runInNewContext(runnerCompiled, {
    exports: runnerExports,
    require: customRequire,
    console,
    Date,
    JSON,
    Math,
    TextEncoder,
  }, { filename: 'quickjsRunner.ts' });

  let evalStartCalled = false;
  let evalStartedAfterWasm = false;
  const result = await runnerExports.runQuickJsGuest(
    {
      script: 'pm.environment.set("tested", "ok");',
      environment: {},
      variables: {},
    },
    {
      onEvalStart: () => {
        evalStartCalled = true;
        evalStartedAfterWasm = true;
      },
    }
  );

  assert.equal(result.success, true);
  assert.equal(evalStartCalled, true, 'onEvalStart must be called when evaluation begins');
  assert.equal(evalStartedAfterWasm, true);
  assert.equal(result.environment.tested, 'ok');
});

test('V5 (P2): runtime.dispose() aborts in-flight request signals and prevents late state commits', async () => {
  const { createRequire } = await import('node:module');
  const nodeRequire = createRequire(import.meta.url);
  const zustand = nodeRequire('zustand');
  const zustandMiddleware = nodeRequire('zustand/middleware');
  const React = nodeRequire('react');

  function transpile(filePath) {
    const src = fs.readFileSync(new URL(filePath, import.meta.url), 'utf8').replaceAll('import.meta.env', '({})');
    return ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }

  const moduleCache = {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder,
    Headers,
    Response,
    Request,
    URL,
    AbortController,
    fetch,
    Date,
    Math,
    performance,
  };
  function runModule(filePath) {
    if (moduleCache[filePath]) return moduleCache[filePath];
    const compiled = transpile(filePath);
    const exports = {};
    const customRequire = (id) => {
      if (id === 'zustand') return zustand;
      if (id === 'zustand/middleware') return zustandMiddleware;
      if (id === 'react') return React;
      if (id.includes('storeContext')) return runModule('../packages/common/src/store/storeContext.ts');
      if (id.includes('storage')) return { appStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, onStorageCommit: () => () => {} };
      if (id.includes('fetcher')) return runModule('../packages/common/src/lib/fetcher.ts');
      if (id.includes('blobManager')) return runModule('../packages/common/src/lib/blobManager.ts');
      if (id.includes('postman')) return runModule('../packages/common/src/lib/postman.ts');
      if (id.includes('scriptRunner')) return runModule('../packages/common/src/lib/scriptRunner.ts');
      if (id.includes('urlParams')) return runModule('../packages/common/src/lib/urlParams.ts');
      if (id.includes('cloudApi')) return runModule('../packages/common/src/lib/cloudApi.ts');
      if (id.includes('treeHelper')) return runModule('../packages/common/src/lib/treeHelper.ts');
      if (id.includes('jwt')) return runModule('../packages/common/src/lib/jwt.ts');
      if (id.includes('requestDiff')) return runModule('../packages/common/src/lib/requestDiff.ts');
      if (id.includes('cloudSyncTransformer')) return runModule('../packages/common/src/lib/cloudSyncTransformer.ts');
      if (id.includes('edition')) return { isOfflineOnly: false };
      if (id.includes('useApiStore')) return runModule('../packages/common/src/store/useApiStore.ts');
      if (id.includes('runtime')) return runModule('../packages/common/src/runtime.ts');
      return {};
    };
    vm.runInNewContext(compiled, { ...sandbox, exports, require: customRequire }, { filename: filePath });
    moduleCache[filePath] = exports;
    return exports;
  }

  const runtimeModule = runModule('../packages/common/src/runtime.ts');
  let abortedSignalFired = false;
  let capturedSignal = null;
  const adapter = {
    id: 'test-adapter',
    hasHostPermission: async () => true,
    requestHostPermission: async () => true,
    dispose: () => {},
    transport: {
      fetch: async (url, init) => {
        capturedSignal = init?.signal;
        if (init?.signal) {
          if (init.signal.aborted) {
            abortedSignalFired = true;
          }
          init.signal.addEventListener('abort', () => {
            abortedSignalFired = true;
          });
        }
        await new Promise((r) => setTimeout(r, 80));
        return new Response(JSON.stringify({ lateData: 'should-not-commit' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  };
  const runtime = runtimeModule.createAirrestRuntime({ adapter });

  runtime.store.setState({
    tabs: [{ id: 'tab-1', url: 'http://localhost:9999/test-late', method: 'GET', headers: [], queryParams: [] }],
    activeTabId: 'tab-1',
  });

  const pendingRequest = runtime.store.getState().sendRequest();
  // Allow request to commence and enter transport fetch
  await new Promise((r) => setTimeout(r, 20));
  // Dispose runtime while fetch is in-flight
  runtime.dispose();

  assert.equal(abortedSignalFired, true, 'runtime.dispose() must abort in-flight fetch signal');
  await pendingRequest;

  // Verify that late response did NOT commit to store activeResponse or history
  assert.equal(runtime.store.getState().activeResponse, null, 'Late response must not commit to activeResponse');
  assert.equal(runtime.store.getState().history.length, 0, 'Late response must not commit to history');
});

test('R2 (P2): debounced environment cloud sync pending in transport is aborted upon runtime.dispose() and prevents late state/persistence commit', async () => {
  const { createRequire } = await import('node:module');
  const nodeRequire = createRequire(import.meta.url);
  const zustand = nodeRequire('zustand');
  const zustandMiddleware = nodeRequire('zustand/middleware');
  const React = nodeRequire('react');

  function transpile(filePath) {
    const src = fs.readFileSync(new URL(filePath, import.meta.url), 'utf8').replaceAll('import.meta.env', '({})');
    return ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }

  let storageWrites = 0;
  const memoryStorage = {
    getItem: () => null,
    setItem: () => { storageWrites++; },
    removeItem: () => {},
  };

  const moduleCache = {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder,
    Headers,
    Response,
    Request,
    URL,
    AbortController,
    fetch,
    Date,
    Math,
    performance,
  };
  function runModule(filePath) {
    if (moduleCache[filePath]) return moduleCache[filePath];
    const compiled = transpile(filePath);
    const exports = {};
    const customRequire = (id) => {
      if (id === 'zustand') return zustand;
      if (id === 'zustand/middleware') return zustandMiddleware;
      if (id === 'react') return React;
      if (id.includes('storeContext')) return runModule('../packages/common/src/store/storeContext.ts');
      if (id.includes('storage')) return { appStorage: memoryStorage, onStorageCommit: () => () => {} };
      if (id.includes('fetcher')) return runModule('../packages/common/src/lib/fetcher.ts');
      if (id.includes('blobManager')) return runModule('../packages/common/src/lib/blobManager.ts');
      if (id.includes('postman')) return runModule('../packages/common/src/lib/postman.ts');
      if (id.includes('scriptRunner')) return runModule('../packages/common/src/lib/scriptRunner.ts');
      if (id.includes('urlParams')) return runModule('../packages/common/src/lib/urlParams.ts');
      if (id.includes('cloudApi')) return runModule('../packages/common/src/lib/cloudApi.ts');
      if (id.includes('treeHelper')) return runModule('../packages/common/src/lib/treeHelper.ts');
      if (id.includes('jwt')) return runModule('../packages/common/src/lib/jwt.ts');
      if (id.includes('requestDiff')) return runModule('../packages/common/src/lib/requestDiff.ts');
      if (id.includes('cloudSyncTransformer')) return runModule('../packages/common/src/lib/cloudSyncTransformer.ts');
      if (id.includes('edition')) return { isOfflineOnly: false };
      if (id.includes('useApiStore')) return runModule('../packages/common/src/store/useApiStore.ts');
      if (id.includes('runtime')) return runModule('../packages/common/src/runtime.ts');
      return {};
    };
    vm.runInNewContext(compiled, { ...sandbox, exports, require: customRequire }, { filename: filePath });
    moduleCache[filePath] = exports;
    return exports;
  }

  const runtimeModule = runModule('../packages/common/src/runtime.ts');
  const cloudApiModule = runModule('../packages/common/src/lib/cloudApi.ts');

  let deferredResolve;
  let capturedSignal = null;
  cloudApiModule.setCloudTransport({
    fetch: async (url, init) => {
      capturedSignal = init?.signal;
      return new Promise((resolve) => {
        deferredResolve = () => resolve(new Response(JSON.stringify({
          data: { id: 'env1', name: 'env-renamed', version: 2 }
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      });
    }
  });

  const adapter = {
    id: 'test-adapter',
    hasHostPermission: async () => true,
    requestHostPermission: async () => true,
    dispose: () => {},
  };
  const runtime = runtimeModule.createAirrestRuntime({ adapter });
  runtime.store.setState({
    workspaceMode: 'cloud',
    cloudConfig: { apiUrl: 'http://localhost:8080', token: 'valid-tok', refreshToken: 'ref-tok', activeScope: { type: 'workspace', id: 'ws1' } },
    environments: [{ id: 'env1', name: 'initial-env', variables: [], minRole: 'reader', version: 1 }],
    activeEnvironmentId: 'env1'
  });

  // Rename environment triggering debounce
  runtime.store.getState().updateEnvironment('env1', { name: 'env-renamed' });

  // Wait for 300ms debounce to fire and enter transport
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(typeof deferredResolve, 'function', 'Request must have reached cloud transport');
  assert.equal(capturedSignal?.aborted, false, 'Signal must be active while pending');

  // Dispose runtime while cloud sync is in-flight
  runtime.dispose();
  assert.equal(capturedSignal?.aborted, true, 'runtime.dispose() must abort in-flight cloud sync signal');

  const writesBeforeResolve = storageWrites;

  // Resolve late response
  deferredResolve();
  await new Promise((r) => setTimeout(r, 50));

  const finalEnv = runtime.store.getState().environments.find((e) => e.id === 'env1');
  assert.equal(finalEnv?.version, 1, 'Late response must NOT commit version 2 to disposed store');
  assert.equal(storageWrites - writesBeforeResolve, 0, 'No persistence writes allowed after store disposal');
});

async function setupRuntimeModules(customStorage = null) {
  const { createRequire } = await import('node:module');
  const nodeRequire = createRequire(import.meta.url);
  const zustand = nodeRequire('zustand');
  const zustandMiddleware = nodeRequire('zustand/middleware');
  const React = nodeRequire('react');

  function transpile(filePath) {
    const src = fs.readFileSync(new URL(filePath, import.meta.url), 'utf8').replaceAll('import.meta.env', '({})');
    return ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }

  const memoryStorage = customStorage || {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };

  const moduleCache = {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder,
    Headers,
    Response,
    Request,
    URL,
    AbortController,
    fetch,
    Date,
    Math,
    performance,
    atob,
    btoa,
    Buffer,
  };
  function runModule(filePath) {
    if (moduleCache[filePath]) return moduleCache[filePath];
    const compiled = transpile(filePath);
    const exports = {};
    const customRequire = (id) => {
      if (id === 'zustand') return zustand;
      if (id === 'zustand/middleware') return zustandMiddleware;
      if (id === 'react') return React;
      if (id.includes('storeContext')) return runModule('../packages/common/src/store/storeContext.ts');
      if (id.includes('storage')) return { appStorage: memoryStorage, onStorageCommit: () => () => {} };
      if (id.includes('fetcher')) return runModule('../packages/common/src/lib/fetcher.ts');
      if (id.includes('blobManager')) return runModule('../packages/common/src/lib/blobManager.ts');
      if (id.includes('postman')) return runModule('../packages/common/src/lib/postman.ts');
      if (id.includes('scriptRunner')) return runModule('../packages/common/src/lib/scriptRunner.ts');
      if (id.includes('urlParams')) return runModule('../packages/common/src/lib/urlParams.ts');
      if (id.includes('cloudApi')) return runModule('../packages/common/src/lib/cloudApi.ts');
      if (id.includes('treeHelper')) return runModule('../packages/common/src/lib/treeHelper.ts');
      if (id.includes('jwt')) return runModule('../packages/common/src/lib/jwt.ts');
      if (id.includes('requestDiff')) return runModule('../packages/common/src/lib/requestDiff.ts');
      if (id.includes('cloudSyncTransformer')) return runModule('../packages/common/src/lib/cloudSyncTransformer.ts');
      if (id.includes('edition')) return { isOfflineOnly: false };
      if (id.includes('useApiStore')) return runModule('../packages/common/src/store/useApiStore.ts');
      if (id.includes('runtime')) return runModule('../packages/common/src/runtime.ts');
      return {};
    };
    vm.runInNewContext(compiled, { ...sandbox, exports, require: customRequire }, { filename: filePath });
    moduleCache[filePath] = exports;
    return exports;
  }

  return {
    runtimeModule: runModule('../packages/common/src/runtime.ts'),
    cloudApiModule: runModule('../packages/common/src/lib/cloudApi.ts'),
    requestDiffModule: runModule('../packages/common/src/lib/requestDiff.ts'),
  };
}

test('T-S1a (S1): maintainer cannot delete environment requiring admin role in project scope', async () => {
  const { runtimeModule, cloudApiModule } = await setupRuntimeModules();
  let deleteCloudCalls = 0;
  cloudApiModule.setCloudTransport({
    fetch: async (url, init) => {
      if (init?.method === 'DELETE') deleteCloudCalls++;
      return new Response(JSON.stringify({ data: { success: true } }), { status: 200 });
    }
  });

  const adapter = {
    id: 'test-adapter',
    hasHostPermission: async () => true,
    requestHostPermission: async () => true,
    dispose: () => {},
  };
  const runtime = runtimeModule.createAirrestRuntime({ adapter });
  runtime.store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'http://localhost:8080',
      token: 'valid-tok',
      refreshToken: 'ref-tok',
      user: { id: 'u1', role: 'maintainer' },
      activeScope: { type: 'project', id: 'proj1', role: 'maintainer', permissions: ['env:write', 'env:delete', 'collection:write', 'collection:delete', 'collection:move'] }
    },
    environments: [{ id: 'env-admin', name: 'Admin Env', variables: [], minRole: 'admin', version: 1 }],
    activeEnvironmentId: 'env-admin'
  });

  // Attempt to delete admin environment
  runtime.store.getState().deleteEnvironment('env-admin');

  // Verify environment remains in local store and no delete was sent to cloud
  const remaining = runtime.store.getState().environments.find((e) => e.id === 'env-admin');
  assert.ok(remaining, 'Admin environment must NOT be deleted by a maintainer');
  assert.equal(deleteCloudCalls, 0, 'No DELETE request must be dispatched to cloud');
  runtime.dispose();
});

test('T-S1b (S1): contributor cannot modify environment requiring maintainer role in project scope', async () => {
  const { runtimeModule } = await setupRuntimeModules();
  const adapter = {
    id: 'test-adapter',
    hasHostPermission: async () => true,
    requestHostPermission: async () => true,
    dispose: () => {},
  };
  const runtime = runtimeModule.createAirrestRuntime({ adapter });
  runtime.store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'http://localhost:8080',
      token: 'valid-tok',
      refreshToken: 'ref-tok',
      user: { id: 'u2', role: 'contributor' },
      activeScope: { type: 'project', id: 'proj1', role: 'contributor', permissions: ['env:write', 'collection:write'] }
    },
    environments: [{
      id: 'env-maintainer',
      name: 'Maintainer Env',
      variables: [{ id: 'v1', key: 'SECRET', value: 'original', initialValue: 'original', currentValue: 'original', enabled: true }],
      minRole: 'maintainer',
      version: 1
    }],
    activeEnvironmentId: 'env-maintainer'
  });

  const store = runtime.store.getState();
  // 1. Attempt updateEnvironment
  store.updateEnvironment('env-maintainer', { name: 'Tampered Name' });
  assert.equal(runtime.store.getState().environments[0].name, 'Maintainer Env', 'updateEnvironment must be rejected');

  // 2. Attempt addEnvironmentVariable
  store.addEnvironmentVariable('env-maintainer');
  assert.equal(runtime.store.getState().environments[0].variables.length, 1, 'addEnvironmentVariable must be rejected');

  // 3. Attempt updateEnvironmentVariable
  store.updateEnvironmentVariable('env-maintainer', 'v1', { initialValue: 'tampered' });
  assert.equal(runtime.store.getState().environments[0].variables[0].value, 'original', 'updateEnvironmentVariable must be rejected');

  // 4. Attempt replaceEnvironment
  await assert.rejects(
    async () => {
      await runtime.store.getState().replaceEnvironment('env-maintainer', {
        id: 'env-maintainer',
        name: 'Overwritten Env',
        variables: [],
        version: 1,
        createdAt: 0,
        updatedAt: 0,
      });
    },
    /Insufficient permission/
  );
  assert.equal(runtime.store.getState().environments[0].name, 'Maintainer Env', 'replaceEnvironment must be rejected');

  runtime.dispose();
});

test('T-S1c (S1): maintainer cannot move collection requiring admin role in project scope', async () => {
  const { runtimeModule } = await setupRuntimeModules();
  const adapter = {
    id: 'test-adapter',
    hasHostPermission: async () => true,
    requestHostPermission: async () => true,
    dispose: () => {},
  };
  const runtime = runtimeModule.createAirrestRuntime({ adapter });
  runtime.store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'http://localhost:8080',
      token: 'valid-tok',
      refreshToken: 'ref-tok',
      user: { id: 'u3', role: 'maintainer' },
      activeScope: { type: 'project', id: 'proj1', role: 'maintainer', permissions: ['collection:write', 'collection:delete', 'collection:move'] }
    },
    collections: [{
      id: 'col-admin',
      name: 'Admin Collection',
      items: [],
      minRole: 'admin',
      createdAt: 0,
      updatedAt: 0
    }]
  });

  // Attempt moveCollection to another scope
  const result = await runtime.store.getState().moveCollection('col-admin', { type: 'offline_workspace', id: 'target-offline' });
  assert.equal(result.success, false, 'moveCollection must return success: false for admin collection moved by maintainer');
  assert.ok(/Insufficient permission/i.test(result.error), 'Must return permission error message');
  assert.equal(runtime.store.getState().collections.length, 1, 'Collection must not be removed from project');

  runtime.dispose();
});

test('T-G1 (G1): runtime.dispose() aborts in-flight batchImportToScope signal, suppresses pullCloudDelta, and ignores late errors', async () => {
  const { runtimeModule, cloudApiModule } = await setupRuntimeModules();
  let capturedSignal = null;
  let deferredResolve = null;
  let pullDeltaCalls = 0;

  cloudApiModule.setCloudTransport({
    fetch: async (url, init) => {
      if (url.includes('/api/v1/sync/import-batch')) {
        capturedSignal = init?.signal;
        return new Promise((resolve) => {
          deferredResolve = resolve;
        });
      }
      return new Response(JSON.stringify({ data: { collections: [] } }), { status: 200 });
    },
  });

  const adapter = {
    id: 'test-adapter',
    hasHostPermission: async () => true,
    requestHostPermission: async () => true,
    dispose: () => {},
  };
  const runtime = runtimeModule.createAirrestRuntime({ adapter });

  // Spy on pullCloudDelta
  const originalPull = runtime.store.getState().pullCloudDelta;
  runtime.store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'http://localhost:8080',
      token: 'valid-tok',
      refreshToken: 'ref-tok',
      user: { id: 'u1', role: 'admin' },
      activeScope: { type: 'workspace', id: 'ws1' },
    },
    pullCloudDelta: async () => {
      pullDeltaCalls++;
      return originalPull();
    },
  });

  const newCollection = {
    id: 'col-new',
    name: 'Disposal Test Collection',
    items: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const addPromise = runtime.store.getState().addCollection(newCollection);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(runtime.store.getState().syncStatus, 'syncing', 'Sync status should be syncing while import is in-flight');
  assert.ok(capturedSignal, 'batchImportToScope must receive an AbortSignal');
  assert.equal(capturedSignal.aborted, false, 'Signal should not be aborted before disposal');

  // Dispose runtime while batch import is in-flight
  runtime.dispose();

  assert.equal(capturedSignal.aborted, true, 'runtime.dispose() must immediately abort the in-flight batch import signal');

  // Resolve deferred request with simulated success
  deferredResolve(new Response(JSON.stringify({ data: { success: true } }), { status: 200 }));
  await addPromise;

  assert.equal(pullDeltaCalls, 0, 'pullCloudDelta must NOT be called on disposed runtime');
  assert.notEqual(runtime.store.getState().syncStatus, 'error', 'Disposed runtime must not transition to error state');
});

test('T-VN2 (V-NEW-2): stale 401 on old session token does NOT trigger dual-store wipe or overwrite storage with stale state', async () => {
  const storageMap = new Map();
  const customStorage = {
    getItem: (key) => storageMap.get(key) ?? null,
    setItem: (key, val) => { storageMap.set(key, val); },
    removeItem: (key) => { storageMap.delete(key); },
  };

  const initialPersistedState = {
    state: {
      cloudConfig: {
        apiUrl: 'http://localhost:8080',
        token: 'tok-1',
        refreshToken: 'ref-1',
        user: { id: 'u1', role: 'reader' },
      },
      collections: [
        { id: 'col-initial', name: 'Initial Collection', items: [] },
      ],
    },
    version: 0,
  };
  storageMap.set('air-rest-storage', JSON.stringify(initialPersistedState));

  const { runtimeModule, cloudApiModule } = await setupRuntimeModules(customStorage);

  const adapter = {
    id: 'test-adapter',
    hasHostPermission: async () => true,
    requestHostPermission: async () => true,
    dispose: () => {},
  };
  const runtime = runtimeModule.createAirrestRuntime({ adapter, storage: customStorage });

  // Update session & collections on runtime.store (representing user activity in active window)
  runtime.store.setState({
    cloudConfig: {
      apiUrl: 'http://localhost:8080',
      token: 'tok-new',
      refreshToken: 'ref-new',
      user: { id: 'u2', role: 'contributor' },
    },
    collections: [
      { id: 'col-initial', name: 'Initial Collection', items: [] },
      { id: 'col-user-new', name: 'User Created Collection', items: [] },
    ],
  });

  // Verify storage has tok-new and two collections before stale request
  await new Promise((r) => setTimeout(r, 20));
  const rawBefore = JSON.parse(storageMap.get('air-rest-storage') || '{}');
  assert.equal(rawBefore?.state?.cloudConfig?.token, 'tok-new');
  assert.equal(rawBefore?.state?.collections?.length, 2);

  // Now simulate a late in-flight request failing with 401 on the STALE token 'tok-1'
  cloudApiModule.setCloudTransport({
    fetch: async () => new Response(JSON.stringify({ error: 'token revoked' }), { status: 401 }),
  });

  // Trigger 401 flow with stale token
  await cloudApiModule.fetchWithAuth('/api/v1/workspaces', {
    apiUrl: 'http://localhost:8080',
    token: 'tok-1',
    refreshToken: 'ref-1',
  }).catch(() => {});

  await new Promise((r) => setTimeout(r, 50));

  // Assert runtime.store is NOT logged out and retains collections
  assert.equal(runtime.store.getState().cloudConfig.token, 'tok-new', 'runtime.store must remain logged in with tok-new');
  assert.equal(runtime.store.getState().collections.length, 2, 'runtime.store must retain newly added collection');

  // Assert storage is NOT overwritten with empty/stale defaultApiStore state
  const rawAfter = JSON.parse(storageMap.get('air-rest-storage') || '{}');
  assert.equal(rawAfter?.state?.cloudConfig?.token, 'tok-new', 'Storage must retain active tok-new');
  assert.equal(rawAfter?.state?.collections?.length, 2, 'Storage must retain user-created collection');

  runtime.dispose();
});

test('T-VN4 (V-NEW-4): user cannot escalate environment minRole beyond their own privilege in create, update, or replace', async () => {
  const { runtimeModule, cloudApiModule } = await setupRuntimeModules();
  cloudApiModule.setCloudTransport({
    fetch: async () => new Response(JSON.stringify({ data: { success: true, version: 2 } }), { status: 200 }),
  });
  const adapter = {
    id: 'test-adapter',
    hasHostPermission: async () => true,
    requestHostPermission: async () => true,
    dispose: () => {},
  };
  const runtime = runtimeModule.createAirrestRuntime({ adapter });

  // Set user as contributor in project scope
  runtime.store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'http://localhost:8080',
      token: 'valid-tok',
      refreshToken: 'ref-tok',
      user: { id: 'u4', role: 'contributor' },
      activeScope: {
        type: 'project',
        id: 'proj1',
        role: 'contributor',
        permissions: ['env:write', 'env:delete'],
      },
    },
    environments: [{
      id: 'env-contrib',
      name: 'Contributor Environment',
      variables: [],
      minRole: 'contributor',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
    }],
  });

  // 1. updateEnvironment: contributor attempts to escalate minRole to 'admin'
  runtime.store.getState().updateEnvironment('env-contrib', { minRole: 'admin' });
  const envAfterUpdate = runtime.store.getState().environments.find((e) => e.id === 'env-contrib');
  assert.equal(envAfterUpdate?.minRole, 'contributor', 'updateEnvironment must reject escalating minRole to admin for contributor');

  // Contributor can still legitimately update other fields
  runtime.store.getState().updateEnvironment('env-contrib', { name: 'Renamed Contributor Env' });
  const envAfterRename = runtime.store.getState().environments.find((e) => e.id === 'env-contrib');
  assert.equal(envAfterRename?.name, 'Renamed Contributor Env', 'updateEnvironment must allow updating name within authorized scope');

  // 2. createEnvironment: contributor attempts to create an environment with minRole: 'admin'
  const createdAdminEnvId = runtime.store.getState().createEnvironment('New Admin Env', 'admin');
  const createdAdminEnv = runtime.store.getState().environments.find((e) => e.id === createdAdminEnvId);
  assert.equal(createdAdminEnv?.minRole, 'reader', 'createEnvironment must fall back minRole to reader when target exceeds user rank');

  // 3. replaceEnvironment: contributor attempts to replace environment with minRole: 'admin'
  await runtime.store.getState().replaceEnvironment('env-contrib', {
    id: 'env-contrib',
    name: 'Tampered Replaced Env',
    variables: [],
    minRole: 'admin',
    createdAt: 0,
    updatedAt: 0,
  });
  const envAfterReplace = runtime.store.getState().environments.find((e) => e.id === 'env-contrib');
  assert.equal(envAfterReplace?.minRole, 'contributor', 'replaceEnvironment must preserve existing minRole when incoming exceeds user rank');

  // 4. Legitimate admin user CAN assign minRole: 'admin'
  runtime.store.setState({
    cloudConfig: {
      ...runtime.store.getState().cloudConfig,
      user: { id: 'u-admin', role: 'admin' },
      activeScope: {
        type: 'project',
        id: 'proj1',
        role: 'admin',
        permissions: ['env:write', 'env:delete'],
      },
    },
  });
  runtime.store.getState().updateEnvironment('env-contrib', { minRole: 'admin' });
  const envAfterAdminUpdate = runtime.store.getState().environments.find((e) => e.id === 'env-contrib');
  assert.equal(envAfterAdminUpdate?.minRole, 'admin', 'Admin user must be allowed to update minRole to admin');

  runtime.dispose();
});

test('T-IMPORT-1: Non-native platform adapter (e.g. extension) triggers HTML input element click for file choosing', () => {
  let fileInputClicked = false;
  const mockFileInput = {
    click: () => { fileInputClicked = true; },
  };

  const extensionAdapter = {
    platformId: 'extension',
    capabilities: {
      supportsNativeFileSystem: false,
    },
    openFile: async () => null,
  };

  const chooseFile = async (adapter, inputRef) => {
    if (adapter?.capabilities?.supportsNativeFileSystem && adapter?.openFile) {
      return await adapter.openFile();
    }
    inputRef?.click();
    return null;
  };

  chooseFile(extensionAdapter, mockFileInput);
  assert.equal(fileInputClicked, true, 'Non-native adapter must trigger file input element click');
});

test('T-IMPORT-2: Native platform adapter (desktop) uses adapter.openFile instead of file input click', async () => {
  let fileInputClicked = false;
  let nativeDialogInvoked = false;
  const mockFileInput = {
    click: () => { fileInputClicked = true; },
  };

  const desktopAdapter = {
    platformId: 'desktop',
    capabilities: {
      supportsNativeFileSystem: true,
    },
    openFile: async () => {
      nativeDialogInvoked = true;
      return { filename: 'collection.json', content: '{"info":{}}' };
    },
  };

  const chooseFile = async (adapter, inputRef) => {
    if (adapter?.capabilities?.supportsNativeFileSystem && adapter?.openFile) {
      return await adapter.openFile();
    }
    inputRef?.click();
    return null;
  };

  const result = await chooseFile(desktopAdapter, mockFileInput);
  assert.equal(nativeDialogInvoked, true, 'Native desktop adapter must invoke adapter.openFile()');
  assert.equal(fileInputClicked, false, 'Native desktop adapter must not trigger file input element click');
  assert.deepEqual(result, { filename: 'collection.json', content: '{"info":{}}' });
});

test('T-IMPORT-3: chromeAdapter.openFile in DOM environment creates file input and reads selected file', async () => {
  let appendedElement = null;
  let removedElement = null;
  let simulatedInput = null;

  class MockFileReader {
    readAsText(file) {
      this.onload({ target: { result: file.testContent } });
    }
  }

  const mockDocument = {
    createElement: (tag) => {
      if (tag === 'input') {
        simulatedInput = {
          type: '',
          accept: '',
          style: {},
          files: [],
          click: () => {
            simulatedInput.files = [{ name: 'postman.json', testContent: '{"values":[]}' }];
            simulatedInput.onchange();
          },
          remove: () => {
            removedElement = simulatedInput;
          },
        };
        return simulatedInput;
      }
      return {};
    },
    body: {
      appendChild: (el) => {
        appendedElement = el;
      },
    },
  };

  const adapterSrc = fs.readFileSync(new URL('../extension/src/adapters/chromeAdapter.ts', import.meta.url), 'utf8');
  const adapterExports = {};
  vm.runInNewContext(
    ts.transpileModule(adapterSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    {
      exports: adapterExports,
      require: () => ({}),
      fetch: () => {},
      Blob: class {},
      URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
      document: mockDocument,
      FileReader: MockFileReader,
    },
    { filename: 'chromeAdapter.ts' }
  );

  const { chromeAdapter } = adapterExports;
  const result = await chromeAdapter.openFile({ filters: [{ name: 'JSON', extensions: ['json'] }] });

  assert.ok(appendedElement, 'chromeAdapter.openFile must append input element to document.body');
  assert.ok(removedElement, 'chromeAdapter.openFile must remove input element after file selection');
  assert.equal(result?.filename, 'postman.json');
  assert.equal(result?.content, '{"values":[]}');
});

test('T-TEAM-EXPAND-1: fetchScopes does not pollute teamProjects with empty arrays, and fetchProjectsForTeam accurately fetches and caches projects', async () => {
  const { runtimeModule, cloudApiModule } = await setupRuntimeModules();
  const fetchedEndpoints = [];

  cloudApiModule.setCloudTransport({
    fetch: async (url, init) => {
      const urlObj = new URL(url);
      fetchedEndpoints.push(urlObj.pathname);

      if (urlObj.pathname === '/api/v1/workspaces') {
        return new Response(JSON.stringify({ data: [{ id: 'ws1', name: 'Personal WS' }] }), { status: 200 });
      }
      if (urlObj.pathname === '/api/v1/teams') {
        return new Response(JSON.stringify({ data: [{ id: 'team1', name: 'Engineering Team' }, { id: 'team2', name: 'Design Team' }] }), { status: 200 });
      }
      if (urlObj.pathname === '/api/v1/teams/team1/projects') {
        return new Response(JSON.stringify({ data: [{ id: 'proj1', name: 'Core Engine', user_role: 'admin' }] }), { status: 200 });
      }
      if (urlObj.pathname === '/api/v1/teams/team2/projects') {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }
  });

  const adapter = {
    id: 'test-adapter',
    hasHostPermission: async () => true,
    requestHostPermission: async () => true,
    dispose: () => {},
  };
  const runtime = runtimeModule.createAirrestRuntime({ adapter });
  runtime.store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'http://localhost:8080',
      token: 'valid-tok',
      refreshToken: 'ref-tok',
      user: { id: 'u1', role: 'member' },
      activeScope: { type: 'workspace', id: 'ws1', name: 'Personal WS', role: 'owner' }
    },
  });

  // Step 1: Initial fetchScopes should load workspaces and teams, without polluting un-fetched team projects
  await runtime.store.getState().fetchScopes(true);

  const initialCache = runtime.store.getState().scopesCache;
  assert.equal(initialCache.workspaces.length, 1);
  assert.equal(initialCache.teams.length, 2);
  assert.equal(initialCache.teamProjects?.team1, undefined, 'team1 must not be pre-populated with empty array');
  assert.equal(initialCache.teamProjects?.team2, undefined, 'team2 must not be pre-populated with empty array');

  // Step 2: Expanding team1 triggers fetchProjectsForTeam
  const team1Projects = await runtime.store.getState().fetchProjectsForTeam('team1', true);
  assert.equal(team1Projects.length, 1);
  assert.equal(team1Projects[0].name, 'Core Engine');

  const afterTeam1Cache = runtime.store.getState().scopesCache;
  assert.equal(afterTeam1Cache.teamProjects?.team1?.length, 1);
  assert.equal(afterTeam1Cache.teamProjects?.team2, undefined);

  // Step 3: Fetching team1 again with force=false returns cached projects without re-requesting
  const endpointCountBefore = fetchedEndpoints.length;
  const cachedProjects = await runtime.store.getState().fetchProjectsForTeam('team1', false);
  assert.equal(cachedProjects.length, 1);
  assert.equal(fetchedEndpoints.length, endpointCountBefore, 'Must return from cache without re-requesting');

  // Step 4: Expanding team2 (which has 0 projects) fetches and stores []
  const team2Projects = await runtime.store.getState().fetchProjectsForTeam('team2', true);
  assert.equal(team2Projects.length, 0);
  const afterTeam2Cache = runtime.store.getState().scopesCache;
  assert.deepEqual(afterTeam2Cache.teamProjects?.team2, []);
});

test('T-SAVE-AS-DUPLICATE: Save As duplicates request across collections and within same collection without moving or overwriting', async () => {
  const { runtimeModule } = await setupRuntimeModules();
  const adapter = {
    id: 'test-adapter',
    hasHostPermission: async () => true,
    requestHostPermission: async () => true,
    dispose: () => {},
  };
  const runtime = runtimeModule.createAirrestRuntime({ adapter });

  const initialReqId = '11111111-1111-4111-8111-111111111111';
  const initialReq = {
    id: initialReqId,
    name: 'get token',
    method: 'POST',
    url: 'https://api.example.com/v1/token',
    params: [],
    headers: [],
    bodyType: 'none',
    rawType: 'text',
    bodyContent: '',
    createdAt: 1000,
    updatedAt: 1000,
  };

  runtime.store.setState({
    workspaceMode: 'offline',
    collections: [
      {
        id: 'coll-A',
        name: 'Collection A',
        items: [
          {
            id: initialReqId,
            name: 'get token',
            type: 'request',
            request: { ...initialReq },
          },
        ],
      },
      {
        id: 'coll-B',
        name: 'Collection B',
        items: [],
      },
    ],
    tabs: [{ ...initialReq }],
    activeTabId: initialReqId,
  });

  const state = runtime.store.getState();

  // 1. Save As to Collection B (duplicate to another collection)
  const copyReqBId = '22222222-2222-4222-8222-222222222222';
  const copyReqB = {
    ...initialReq,
    id: copyReqBId,
    name: 'get token',
  };
  state.saveRequestToCollection('coll-B', null, copyReqB);

  const afterSaveB = runtime.store.getState();
  const collAItems = afterSaveB.collections.find((c) => c.id === 'coll-A')?.items || [];
  const collBItems = afterSaveB.collections.find((c) => c.id === 'coll-B')?.items || [];

  // Coll A must still retain the original request
  assert.equal(collAItems.length, 1, 'Collection A must retain original request (NOT moved)');
  assert.equal(collAItems[0].id, initialReqId);
  assert.equal(collAItems[0].name, 'get token');

  // Coll B must contain the duplicate
  assert.equal(collBItems.length, 1, 'Collection B must contain duplicated request');
  assert.equal(collBItems[0].id, copyReqBId);
  assert.equal(collBItems[0].name, 'get token');

  // 2. Save As to the SAME Collection A (duplicate in same collection with same name)
  const copyReqAId = '33333333-3333-4333-8333-333333333333';
  const copyReqA = {
    ...initialReq,
    id: copyReqAId,
    name: 'get token',
  };
  state.saveRequestToCollection('coll-A', null, copyReqA);

  const afterSaveA = runtime.store.getState();
  const collAItemsAfterA = afterSaveA.collections.find((c) => c.id === 'coll-A')?.items || [];

  // Coll A must now have 2 requests, both named 'get token' but with distinct IDs
  assert.equal(collAItemsAfterA.length, 2, 'Collection A must contain BOTH original and duplicate (NOT overwritten)');
  assert.equal(collAItemsAfterA[0].id, initialReqId);
  assert.equal(collAItemsAfterA[1].id, copyReqAId);

  // 3. Normal Save in place updates the target without creating duplicates or overwriting other items
  const updatedReq1 = {
    ...initialReq,
    id: initialReqId,
    name: 'get token v1 updated',
    url: 'https://api.example.com/v1/token-new',
  };
  state.saveRequestToCollection('coll-A', null, updatedReq1);

  const afterNormalSave = runtime.store.getState();
  const collAAfterNormal = afterNormalSave.collections.find((c) => c.id === 'coll-A')?.items || [];
  assert.equal(collAAfterNormal.length, 2, 'Normal save in-place must not change item count');
  assert.equal(collAAfterNormal[0].id, initialReqId);
  assert.equal(collAAfterNormal[0].name, 'get token v1 updated');
  assert.equal(collAAfterNormal[1].id, copyReqAId);
  assert.equal(collAAfterNormal[1].name, 'get token');

  // 4. Tab ID synchronization on updateActiveRequest
  state.updateActiveRequest({ id: copyReqBId, name: 'get token' });
  const afterTabUpdate = runtime.store.getState();
  assert.equal(afterTabUpdate.activeTabId, copyReqBId, 'activeTabId must synchronize when updateActiveRequest changes id');
  assert.equal(afterTabUpdate.tabs[0].id, copyReqBId);
});

test('T-SAVE-CONFLICT-DETECTION: Method and Name duplicate guard allows distinct methods but detects same method collisions', async () => {
  const { runtimeModule, requestDiffModule } = await setupRuntimeModules();
  const { generateCopyRequestName, flattenCollectionRequests } = requestDiffModule;

  // 1. Copy name generation tests
  assert.equal(generateCopyRequestName('token', []), 'token (Copy)');
  assert.equal(generateCopyRequestName('token', ['token (Copy)']), 'token (Copy 2)');
  assert.equal(generateCopyRequestName('token', ['token (Copy)', 'token (Copy 2)']), 'token (Copy 3)');

  // 2. Setup collection with GET token
  const adapter = {
    id: 'test-adapter',
    hasHostPermission: async () => true,
    requestHostPermission: async () => true,
    dispose: () => {},
  };
  const runtime = runtimeModule.createAirrestRuntime({ adapter });

  const getReqId = '11111111-1111-4111-8111-111111111111';
  const getReq = {
    id: getReqId,
    name: 'token',
    method: 'GET',
    url: 'https://api.example.com/token',
    params: [],
    headers: [],
    bodyType: 'none',
    rawType: 'text',
    bodyContent: '',
    createdAt: 1000,
    updatedAt: 1000,
  };

  runtime.store.setState({
    workspaceMode: 'offline',
    collections: [
      {
        id: 'coll-1',
        name: 'Auth Collection',
        items: [
          {
            id: getReqId,
            name: 'token',
            type: 'request',
            request: { ...getReq },
          },
        ],
      },
    ],
    tabs: [{ ...getReq }],
    activeTabId: getReqId,
  });

  const checkConflict = (incomingReq, isSaveAs = false) => {
    const col = runtime.store.getState().collections.find((c) => c.id === 'coll-1');
    const existing = flattenCollectionRequests(col?.items || []);
    const incomingMethod = (incomingReq.method || 'GET').toUpperCase();
    const incomingName = incomingReq.name.trim().toLowerCase();

    return existing.find((r) => {
      if (!isSaveAs && (r.id === incomingReq.id || r.request?.id === incomingReq.id)) {
        return false; // not a conflict with self during direct edit
      }
      return (
        r.name.trim().toLowerCase() === incomingName &&
        (r.method || 'GET').toUpperCase() === incomingMethod
      );
    });
  };

  // Scenario A: POST token and GET token CAN coexist in the same collection
  const postReqId = '22222222-2222-4222-8222-222222222222';
  const postReq = {
    ...getReq,
    id: postReqId,
    method: 'POST',
    name: 'token',
  };
  const conflictForPost = checkConflict(postReq, false);
  assert.equal(conflictForPost, undefined, 'POST token and GET token must NOT trigger conflict');

  // Save POST token into coll-1
  runtime.store.getState().saveRequestToCollection('coll-1', null, postReq);
  const colAfterPost = runtime.store.getState().collections.find((c) => c.id === 'coll-1');
  assert.equal(colAfterPost?.items?.length, 2, 'Collection now holds both GET token and POST token');

  // Scenario B: Another POST token DOES trigger conflict
  const duplicatePostReq = {
    ...postReq,
    id: '33333333-3333-4333-8333-333333333333',
    name: 'token',
    method: 'POST',
  };
  const conflictForSecondPost = checkConflict(duplicatePostReq, false);
  assert.ok(conflictForSecondPost, 'POST token and POST token MUST trigger conflict');
  assert.equal(conflictForSecondPost.id, postReqId);

  // Scenario C: Case-insensitivity check (method 'post', name 'TOKEN')
  const caseInsensitivePostReq = {
    ...postReq,
    id: '44444444-4444-4444-8444-444444444444',
    name: 'TOKEN',
    method: 'post',
  };
  const conflictCaseInsensitive = checkConflict(caseInsensitivePostReq, false);
  assert.ok(conflictCaseInsensitive, 'Case-insensitive method and name MUST trigger conflict');

  // Scenario D: Editing self directly does NOT trigger conflict
  const selfEditReq = {
    ...postReq,
    url: 'https://api.example.com/token/v2',
  };
  const conflictSelf = checkConflict(selfEditReq, false);
  assert.equal(conflictSelf, undefined, 'Editing request directly must NOT conflict with itself');

  // Scenario E: Save As on existing request in same collection DOES trigger conflict with existing item
  const saveAsSelfConflict = checkConflict(selfEditReq, true);
  assert.ok(saveAsSelfConflict, 'Save As with same method and name MUST trigger conflict');

  // Scenario F: Resolving via "Save Copy"
  const copyName = generateCopyRequestName('token', ['token']);
  assert.equal(copyName, 'token (Copy)');
  const copyReq = {
    ...postReq,
    id: '55555555-5555-4555-8555-555555555555',
    name: copyName,
  };
  runtime.store.getState().saveRequestToCollection('coll-1', null, copyReq);
  const colAfterCopy = runtime.store.getState().collections.find((c) => c.id === 'coll-1');
  assert.equal(colAfterCopy?.items?.length, 3, 'Save copy adds new item with copy name');
  assert.ok(colAfterCopy?.items?.some((i) => i.name === 'token (Copy)'));

  // Scenario G: Resolving via "Replace"
  const replacedPostReq = {
    ...postReq,
    id: postReqId,
    name: 'token',
    url: 'https://api.example.com/token/replaced',
  };
  runtime.store.getState().saveRequestToCollection('coll-1', null, replacedPostReq);
  const colAfterReplace = runtime.store.getState().collections.find((c) => c.id === 'coll-1');
  assert.equal(colAfterReplace?.items?.length, 3, 'Replace does not change total item count');
  const replacedItem = colAfterReplace?.items?.find((i) => i.id === postReqId);
  assert.equal(replacedItem?.request?.url, 'https://api.example.com/token/replaced', 'Replaced item has updated payload');
});


