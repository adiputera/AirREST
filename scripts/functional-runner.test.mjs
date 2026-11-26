import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function loadFunctionalModules() {
  const cache = new Map();
  const globals = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    Headers,
    Response,
    Request,
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    performance,
    Blob,
    FormData: globalThis.FormData,
    fetch: globalThis.fetch,
    atob,
    btoa,
    crypto: globalThis.crypto,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Uint8Array,
    Uint32Array,
    Map,
    Set,
    RegExp,
    Error,
    Promise,
    Number,
    String,
    Boolean,
  };

  function load(relPath) {
    const absPath = path.resolve(ROOT, relPath);
    if (cache.has(absPath)) return cache.get(absPath);
    const exports = {};
    cache.set(absPath, exports);
    const source = fs.readFileSync(absPath, 'utf8');
    const compiled = ts.transpileModule(source, {
      fileName: absPath,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText;

    const localRequire = (id) => {
      if (!id.startsWith('.')) return require(id);
      const base = path.resolve(path.dirname(absPath), id);
      const resolved = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((c) => {
        try {
          return fs.statSync(c).isFile();
        } catch {
          return false;
        }
      });
      if (!resolved) throw new Error(`Cannot resolve ${id} from ${relPath}`);
      return load(path.relative(ROOT, resolved));
    };

    vm.runInNewContext(compiled, { ...globals, exports, require: localRequire }, { filename: absPath });
    return exports;
  }

  return {
    functionalRunner: load('packages/common/src/lib/functionalRunner.ts'),
    functionalSessionStore: load('packages/common/src/lib/functionalSessionStore.ts'),
    functionalReportExporter: load('packages/common/src/lib/functionalReportExporter.ts'),
    perfStorage: load('packages/common/src/lib/perfStorage.ts'),
    perfLaunch: load('packages/common/src/lib/perfLaunch.ts'),
  };
}

function makeDescriptor(id, name, method, url, overrides = {}) {
  return {
    id,
    itemId: id,
    name,
    method,
    path: name,
    selected: true,
    request: {
      id,
      name,
      method,
      url,
      params: [],
      headers: [],
      auth: { type: 'none' },
      bodyType: 'none',
      bodyContent: '',
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    },
  };
}

function createScriptStubExecutor(handlers) {
  return {
    execute: async (input) => {
      const fn = handlers[input.script];
      if (!fn) {
        return {
          success: true,
          environment: { ...input.environment },
          variables: { ...input.variables },
        };
      }
      return fn(input);
    },
    dispose: () => {},
  };
}

test('functionalRunner executes sequential iterations with CSV wrap-around, Keep variable values, and session capture', async () => {
  const { functionalRunner, functionalSessionStore, perfLaunch } = loadFunctionalModules();
  functionalSessionStore.clearAllFunctionalSessions();

  const seenCalls = [];
  const server = http.createServer((req, res) => {
    seenCalls.push({ url: req.url, auth: req.headers.authorization || '' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const committed = [];
    const items = [
      makeDescriptor('r1', 'Login', 'POST', `${baseUrl}/login?u={{user}}`, {
        postResponseScript: 'script:login-post',
      }),
      makeDescriptor('r2', 'Profile', 'GET', `${baseUrl}/profile?u={{user}}`, {
        auth: { type: 'bearer', bearerToken: '{{token}}' },
        postResponseScript: 'script:profile-post',
      }),
    ];

    const adapter = {
      platformId: 'web',
      scriptExecutor: createScriptStubExecutor({
        'script:login-post': (input) => ({
          success: true,
          environment: {
            ...input.environment,
            token: `tok-${input.iterationData?.user || 'none'}`,
          },
          variables: { ...input.variables },
          testResults: [{ name: 'Login returns 200', passed: true, durationMs: 2 }],
        }),
        'script:profile-post': (input) => ({
          success: true,
          environment: { ...input.environment },
          variables: { ...input.variables },
          testResults: [
            {
              name: 'Profile matches user',
              passed: Boolean(input.iterationData?.user),
              durationMs: 3,
            },
          ],
        }),
      }),
      transport: {
        fetch: (url, init) => fetch(url, init),
        classifyError: async (err) => ({ category: 'other', detail: String(err) }),
      },
    };

    const cfg = {
      ...perfLaunch.createDefaultFunctionalRunnerConfig(),
      iterations: 3,
      keepVariableValues: true,
      persistResponses: true,
    };

    const report = await new Promise((resolve) => {
      void functionalRunner.startFunctionalRun({
        tabId: 'func-tab-1',
        title: 'Users Smoke',
        sourceType: 'collection',
        sourceId: 'col-1',
        items,
        config: cfg,
        dataFileMeta: {
          filename: 'users.csv',
          format: 'csv',
          fileBytes: 30,
          rowCount: 2,
          columns: ['user'],
          previewRows: [],
          readMode: 'sequential',
        },
        dataRows: [{ user: 'alice' }, { user: 'bob' }],
        initialVariables: { existing: '1' },
        adapter,
        onCommitEnvironmentUpdates: (env, unsetKeys) => {
          committed.push({ env, unsetKeys });
          return Object.keys(env);
        },
        onUpdate: () => {},
        onFinish: resolve,
      });
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.completedIterations, 3);
    assert.equal(report.totalRequestsExecuted, 6);
    assert.equal(report.testsPassed, 6);
    assert.equal(report.testsFailed, 0);
    // Iteration 1 -> alice, Iteration 2 -> bob, Iteration 3 wraps -> alice
    assert.deepEqual(
      seenCalls.map((c) => c.url),
      [
        '/login?u=alice',
        '/profile?u=alice',
        '/login?u=bob',
        '/profile?u=bob',
        '/login?u=alice',
        '/profile?u=alice',
      ]
    );
    assert.equal(seenCalls[1].auth, 'Bearer tok-alice');
    assert.equal(seenCalls[3].auth, 'Bearer tok-bob');
    assert.equal(committed.length, 1);
    assert.equal(committed[0].env.token, 'tok-alice');
    assert.ok(report.updatedEnvVars.includes('token'));

    const cap = functionalSessionStore.getFunctionalCapturedExchange(report.id, report.steps[0].id);
    assert.ok(cap, 'Captured exchange must exist in session store');
    assert.match(cap.responseBody, /"ok":true/);
    assert.equal(cap.dataRow.user, 'alice');
  } finally {
    server.close();
  }
});

test('functionalRunner honors stopOnError policies, setNextRequest branching, loop guard, and JUnit/HTML export', async () => {
  const { functionalRunner, functionalReportExporter, perfLaunch } = loadFunctionalModules();

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: req.url }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Test Stop on failed test marks remaining steps in iteration as skipped
    const adapterFail = {
      platformId: 'web',
      scriptExecutor: createScriptStubExecutor({
        'script:fail': (input) => ({
          success: true,
          environment: input.environment,
          variables: input.variables,
          testResults: [{ name: 'Must pass', passed: false, error: 'Boom <xml> & failed' }],
        }),
      }),
      transport: {
        fetch: (url, init) => fetch(url, init),
        classifyError: async (err) => ({ category: 'other', detail: String(err) }),
      },
    };

    const failReport = await new Promise((resolve) => {
      void functionalRunner.startFunctionalRun({
        tabId: 'func-stop',
        title: 'Stop <Run>',
        sourceType: 'collection',
        sourceId: 'c1',
        items: [
          makeDescriptor('s1', 'Step 1', 'GET', `${baseUrl}/1`, { postResponseScript: 'script:fail' }),
          makeDescriptor('s2', 'Step 2', 'GET', `${baseUrl}/2`),
        ],
        config: {
          ...perfLaunch.createDefaultFunctionalRunnerConfig(),
          stopOnError: 'failed_test',
          persistResponses: false,
        },
        initialVariables: {},
        adapter: adapterFail,
        onUpdate: () => {},
        onFinish: resolve,
      });
    });

    assert.equal(failReport.status, 'failed');
    assert.equal(failReport.requestsFailed, 1);
    assert.equal(failReport.requestsSkipped, 1);
    assert.deepEqual(failReport.failedItemIds, ['s1']);
    assert.equal(failReport.steps[0].captureSkippedReason, 'disabled');

    const html = functionalReportExporter.exportFunctionalReportHtml(failReport);
    assert.ok(html.includes('&lt;Run&gt;'));
    const xml = functionalReportExporter.exportFunctionalReportJunitXml(failReport);
    assert.ok(xml.includes('tests="2" failures="1" errors="0" skipped="1"'));
    assert.ok(xml.includes('&lt;xml&gt; &amp; failed'));
    assert.ok(xml.includes('<skipped '));

    // 2. Test setNextRequest jump (Step 1 jumps directly to Step 3, skipping Step 2)
    const visited = [];
    const adapterJump = {
      platformId: 'web',
      scriptExecutor: createScriptStubExecutor({
        'script:jump-to-3': (input) => {
          visited.push('Step 1');
          return {
            success: true,
            environment: input.environment,
            variables: input.variables,
            nextRequest: 'Step 3',
          };
        },
        'script:record-3': (input) => {
          visited.push('Step 3');
          return {
            success: true,
            environment: input.environment,
            variables: input.variables,
            nextRequest: null,
          };
        },
      }),
      transport: {
        fetch: (url, init) => fetch(url, init),
        classifyError: async (err) => ({ category: 'other', detail: String(err) }),
      },
    };

    const jumpReport = await new Promise((resolve) => {
      void functionalRunner.startFunctionalRun({
        tabId: 'func-jump',
        title: 'Branch Run',
        sourceType: 'collection',
        sourceId: 'c1',
        items: [
          makeDescriptor('j1', 'Step 1', 'GET', `${baseUrl}/1`, { postResponseScript: 'script:jump-to-3' }),
          makeDescriptor('j2', 'Step 2', 'GET', `${baseUrl}/2`),
          makeDescriptor('j3', 'Step 3', 'GET', `${baseUrl}/3`, { postResponseScript: 'script:record-3' }),
        ],
        config: perfLaunch.createDefaultFunctionalRunnerConfig(),
        initialVariables: {},
        adapter: adapterJump,
        onUpdate: () => {},
        onFinish: resolve,
      });
    });

    assert.equal(jumpReport.status, 'completed');
    assert.deepEqual(visited, ['Step 1', 'Step 3']);
    assert.equal(jumpReport.totalRequestsExecuted, 2);

    // 3. Test setNextRequest self-loop guard
    const adapterLoop = {
      platformId: 'web',
      scriptExecutor: createScriptStubExecutor({
        'script:self-loop': (input) => ({
          success: true,
          environment: input.environment,
          variables: input.variables,
          nextRequest: 'Loop Step',
        }),
      }),
      transport: {
        fetch: (url, init) => fetch(url, init),
        classifyError: async (err) => ({ category: 'other', detail: String(err) }),
      },
    };

    const loopReport = await new Promise((resolve) => {
      void functionalRunner.startFunctionalRun({
        tabId: 'func-loop-guard',
        title: 'Loop Guard Run',
        sourceType: 'collection',
        sourceId: 'c1',
        items: [
          makeDescriptor('l1', 'Loop Step', 'GET', `${baseUrl}/loop`, { postResponseScript: 'script:self-loop' }),
        ],
        config: perfLaunch.createDefaultFunctionalRunnerConfig(),
        initialVariables: {},
        adapter: adapterLoop,
        onUpdate: () => {},
        onFinish: resolve,
      });
    });

    assert.equal(loopReport.status, 'failed');
    assert.match(loopReport.stopReason || '', /loop guard/i);
  } finally {
    server.close();
  }
});

test('functionalSessionStore enforces 128 KiB per-body truncation and 500 step / 16 MiB caps + perfStorage strips bodies', async () => {
  const { functionalSessionStore, perfStorage, perfLaunch } = loadFunctionalModules();
  functionalSessionStore.clearAllFunctionalSessions();

  const hugeBody = 'X'.repeat(200 * 1024);
  const res = functionalSessionStore.captureFunctionalExchange('run-cap', 'tab-cap', 'step-1', {
    requestMethod: 'POST',
    requestUrl: 'https://example.com',
    requestHeaders: {},
    requestBody: hugeBody,
    responseHeaders: {},
    responseBody: hugeBody,
  });
  assert.equal(res.captured, true);
  const saved = functionalSessionStore.getFunctionalCapturedExchange('run-cap', 'step-1');
  assert.equal(saved.requestBodyTruncated, true);
  assert.equal(saved.responseBodyTruncated, true);
  assert.ok(new TextEncoder().encode(saved.responseBody).length <= 128 * 1024);

  // Fill remaining steps up to 500 limit cleanly
  for (let i = 2; i <= 500; i++) {
    const ok = functionalSessionStore.captureFunctionalExchange('run-cap', 'tab-cap', `step-${i}`, {
      requestMethod: 'GET',
      requestUrl: 'https://example.com',
      requestHeaders: {},
      responseHeaders: {},
      responseBody: 'ok',
    });
    assert.equal(ok.captured, true);
  }
  const overCap = functionalSessionStore.captureFunctionalExchange('run-cap', 'tab-cap', 'step-501', {
    requestMethod: 'GET',
    requestUrl: 'https://example.com',
    requestHeaders: {},
    responseHeaders: {},
    responseBody: 'ok',
  });
  assert.equal(overCap.captured, false);
  assert.equal(overCap.reason, 'step_limit');

  // Verify perfStorage saveFunctionalReport strips hasCapturedExchange & isolates scopes
  await perfStorage.saveFunctionalReport('cloud:u1:workspace:w1', {
    id: 'func-stored-1',
    tabId: 'tab-cap',
    title: 'Cloud Functional',
    sourceType: 'collection',
    sourceId: 'c1',
    status: 'completed',
    startedAt: 1000,
    durationMs: 500,
    config: perfLaunch.createDefaultFunctionalRunnerConfig(),
    plannedIterations: 1,
    completedIterations: 1,
    totalRequestsExecuted: 1,
    requestsPassed: 1,
    requestsFailed: 0,
    requestsErrored: 0,
    requestsSkipped: 0,
    totalTests: 0,
    testsPassed: 0,
    testsFailed: 0,
    avgResponseTimeMs: 10,
    steps: [
      {
        id: 'step-1',
        iteration: 1,
        stepIndex: 0,
        itemId: 'i1',
        name: 'Req',
        method: 'GET',
        url: 'https://example.com',
        status: 'passed',
        httpStatus: 200,
        statusText: 'OK',
        timeMs: 10,
        sizeBytes: 2,
        testResults: [],
        testsPassed: 0,
        testsFailed: 0,
        hasCapturedExchange: true,
        timestamp: 1000,
      },
    ],
    failedItemIds: [],
  });

  const stored = await perfStorage.listFunctionalReports('cloud:u1:workspace:w1');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].steps[0].hasCapturedExchange, false);

  await perfStorage.clearCloudPerfReports('u1');
  assert.equal((await perfStorage.listFunctionalReports('cloud:u1:workspace:w1')).length, 0);
});

test('reorderRunnerItems moves dragged items before or after any target cleanly', () => {
  const { perfLaunch } = loadFunctionalModules();
  const list = [
    makeDescriptor('a', 'First', 'GET', 'https://example.com/1'),
    makeDescriptor('b', 'Second', 'GET', 'https://example.com/2'),
    makeDescriptor('c', 'Third', 'GET', 'https://example.com/3'),
    makeDescriptor('d', 'Fourth', 'GET', 'https://example.com/4'),
  ];

  // Drag last item ('d') before first item ('a')
  const movedTop = perfLaunch.reorderRunnerItems(list, 'd', 'a', 'before');
  assert.equal(movedTop.map((x) => x.id).join(','), 'd,a,b,c');

  // Drag first item ('a') after last item ('d')
  const movedBottom = perfLaunch.reorderRunnerItems(list, 'a', 'd', 'after');
  assert.equal(movedBottom.map((x) => x.id).join(','), 'b,c,d,a');

  // No-op when active === target
  assert.equal(perfLaunch.reorderRunnerItems(list, 'b', 'b', 'before'), list);
});
