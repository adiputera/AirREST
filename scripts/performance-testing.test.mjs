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

function loadCommonModules() {
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

  function load(relPath, overrides = {}) {
    const absPath = path.resolve(ROOT, relPath);
    if (!Object.keys(overrides).length && cache.has(absPath)) {
      return cache.get(absPath);
    }
    const exports = {};
    if (!Object.keys(overrides).length) {
      cache.set(absPath, exports);
    }
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
      if (id in overrides) return overrides[id];
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
      return load(path.relative(ROOT, resolved), overrides);
    };

    vm.runInNewContext(compiled, { ...globals, exports, require: localRequire }, { filename: absPath });
    return exports;
  }

  return {
    perfHistogram: load('packages/common/src/lib/perfHistogram.ts'),
    loadProfileMath: load('packages/common/src/lib/loadProfileMath.ts'),
    perfMetrics: load('packages/common/src/lib/perfMetrics.ts'),
    perfDataFile: load('packages/common/src/lib/perfDataFile.ts'),
    perfThresholds: load('packages/common/src/lib/perfThresholds.ts'),
    perfComparison: load('packages/common/src/lib/perfComparison.ts'),
    perfStorage: load('packages/common/src/lib/perfStorage.ts'),
    perfReportExporter: load('packages/common/src/lib/perfReportExporter.ts'),
    examples: load('packages/common/src/lib/examples.ts'),
    perfRunner: load('packages/common/src/lib/perfRunner.ts'),
  };
}

test('PerfHistogram computes accurate percentiles, merges, and spans high-latency tiers', () => {
  const { perfHistogram } = loadCommonModules();
  const h = new perfHistogram.PerfHistogram();
  for (let i = 1; i <= 100; i++) {
    h.record(i);
  }
  const summary = h.getSummary();
  assert.equal(summary.count, 100);
  assert.equal(summary.minMs, 1);
  assert.equal(summary.maxMs, 100);
  assert.equal(summary.avgMs, 51);
  assert.equal(summary.p90Ms, 90);
  assert.equal(summary.p95Ms, 95);
  assert.equal(summary.p99Ms, 99);

  const h2 = new perfHistogram.PerfHistogram();
  h2.record(2500);
  h.merge(h2);
  assert.equal(h.getSummary().maxMs, 2500);
});

test('loadProfileMath evaluates all 5 curve profiles, clamps handles, and enforces platform VU caps', () => {
  const { loadProfileMath } = loadCommonModules();

  assert.equal(loadProfileMath.getPlatformPerformanceLimits('desktop').maxVUs, 10000);
  assert.equal(loadProfileMath.getPlatformPerformanceLimits('extension').maxVUs, 30);
  assert.equal(loadProfileMath.getPlatformPerformanceLimits('android').maxVUs, 15);

  const baseCfg = loadProfileMath.createDefaultLoadProfileConfig(10000);
  const spikeCfg = {
    ...baseCfg,
    profile: 'spike',
    virtualUsers: 100,
    baseLoad: 10,
    durationValue: 100,
    durationUnit: 'seconds',
    handles: {
      ...baseCfg.handles,
      spike: [0.4, 0.5, 0.8],
    },
  };
  assert.equal(loadProfileMath.getTargetVusAtTime(spikeCfg, 10), 10);
  assert.equal(loadProfileMath.getTargetVusAtTime(spikeCfg, 50), 100);
  assert.equal(loadProfileMath.getTargetVusAtTime(spikeCfg, 90), 10);

  const stairCfg = {
    ...baseCfg,
    profile: 'staircase',
    virtualUsers: 90,
    baseLoad: 0,
    durationValue: 100,
    durationUnit: 'seconds',
    staircaseSteps: undefined,
  };
  assert.equal(loadProfileMath.getTargetVusAtTime(stairCfg, 10), 30);
  assert.equal(loadProfileMath.getTargetVusAtTime(stairCfg, 35), 60);
  assert.equal(loadProfileMath.getTargetVusAtTime(stairCfg, 60), 90);
  assert.equal(loadProfileMath.getTargetVusAtTime(stairCfg, 85), 0);

  // 2D Staircase step cap, minimum 5s clamping, resize, and per-step VU evaluation
  assert.equal(loadProfileMath.getMaxStaircaseSteps(5), 1);
  assert.equal(loadProfileMath.getMaxStaircaseSteps(20), 4);
  assert.equal(loadProfileMath.getMaxStaircaseSteps(120), 12);

  const normalized2d = loadProfileMath.normalizeStaircaseSteps(
    [
      { endNorm: 0.05, virtualUsers: 10 }, // 1s of 20s -> clamped to >= 5s (0.25)
      { endNorm: 0.6, virtualUsers: 50 },
      { endNorm: 1, virtualUsers: 80 }, // clamped down to peakVu=50
    ],
    50,
    5,
    20
  );
  assert.ok(normalized2d[0].endNorm >= 0.25 - 1e-9);
  assert.equal(normalized2d[2].virtualUsers, 50);

  const custom2dCfg = {
    ...baseCfg,
    profile: 'staircase',
    virtualUsers: 50,
    baseLoad: 5,
    durationValue: 20,
    durationUnit: 'seconds',
    staircaseSteps: normalized2d,
  };
  assert.equal(loadProfileMath.getTargetVusAtTime(custom2dCfg, 4), 10);
  assert.equal(loadProfileMath.getTargetVusAtTime(custom2dCfg, 6), 50);

  const resized = loadProfileMath.resizeStaircaseSteps(normalized2d, 6, 60, 5, 60);
  assert.equal(resized.length, 6);
  assert.equal(resized[0].virtualUsers, 10);

  const clamped = loadProfileMath.clampNormalizedHandles('peak', [0.99, 0.1, 0.2, 0.3], 60);
  assert.ok(clamped[0] < clamped[1] && clamped[1] < clamped[2] && clamped[2] < clamped[3]);
});

test('computePeakRpsMetrics computes overall Max Req/s with timestamp and per-endpoint peaks', () => {
  const { perfMetrics } = loadCommonModules();
  const peak = perfMetrics.computePeakRpsMetrics({
    summary: {
      totalRequests: 100,
      errorCount: 0,
      errorRatePct: 0,
      requestsPerSec: 25,
      avgMs: 10,
      minMs: 2,
      maxMs: 40,
      p90Ms: 20,
      p95Ms: 25,
      p99Ms: 35,
      bytesReceived: 1024,
    },
    timeSeries: [
      {
        second: 0,
        timestampMs: 1700000001000,
        virtualUsers: 5,
        totalRequests: 18,
        errorCount: 0,
        errorRatePct: 0,
        requestsPerSec: 18,
        avgMs: 8,
        minMs: 2,
        maxMs: 20,
        p90Ms: 15,
        p95Ms: 18,
        p99Ms: 20,
        byRequest: {
          r1: { totalRequests: 10, errorCount: 0, errorRatePct: 0, requestsPerSec: 10, avgMs: 6, minMs: 2, maxMs: 12, p90Ms: 10, p95Ms: 11, p99Ms: 12 },
          r2: { totalRequests: 8, errorCount: 0, errorRatePct: 0, requestsPerSec: 8, avgMs: 10, minMs: 4, maxMs: 20, p90Ms: 18, p95Ms: 19, p99Ms: 20 },
        },
      },
      {
        second: 1,
        timestampMs: 1700000002000,
        virtualUsers: 10,
        totalRequests: 47,
        errorCount: 0,
        errorRatePct: 0,
        requestsPerSec: 47,
        avgMs: 12,
        minMs: 3,
        maxMs: 40,
        p90Ms: 25,
        p95Ms: 30,
        p99Ms: 38,
        byRequest: {
          r1: { totalRequests: 29, errorCount: 0, errorRatePct: 0, requestsPerSec: 29, avgMs: 9, minMs: 3, maxMs: 20, p90Ms: 18, p95Ms: 19, p99Ms: 20 },
          r2: { totalRequests: 18, errorCount: 0, errorRatePct: 0, requestsPerSec: 18, avgMs: 14, minMs: 5, maxMs: 40, p90Ms: 30, p95Ms: 35, p99Ms: 40 },
        },
      },
    ],
    endpoints: [
      { requestId: 'r1', name: 'A', method: 'GET', path: '/a', totalRequests: 39, errorCount: 0, errorRatePct: 0, requestsPerSec: 19.5, avgMs: 8, minMs: 2, maxMs: 20, p90Ms: 18, p95Ms: 19, p99Ms: 20, bytesReceived: 500 },
      { requestId: 'r2', name: 'B', method: 'POST', path: '/b', totalRequests: 26, errorCount: 0, errorRatePct: 0, requestsPerSec: 13, avgMs: 12, minMs: 4, maxMs: 40, p90Ms: 30, p95Ms: 35, p99Ms: 40, bytesReceived: 524 },
    ],
  });

  assert.equal(peak.overallMaxRps, 47);
  assert.equal(peak.overallPeakTimestampMs, 1700000002000);
  assert.equal(peak.byRequestMaxRps.r1, 29);
  assert.equal(peak.byRequestMaxRps.r2, 18);

  const fallbackPeak = perfMetrics.computePeakRpsMetrics({
    summary: {
      totalRequests: 10,
      errorCount: 0,
      errorRatePct: 0,
      requestsPerSec: 5,
      maxRequestsPerSec: 14,
      avgMs: 5,
      minMs: 2,
      maxMs: 10,
      p90Ms: 8,
      p95Ms: 9,
      p99Ms: 10,
      bytesReceived: 100,
    },
    timeSeries: [],
    endpoints: [
      { requestId: 'r1', name: 'A', method: 'GET', path: '/a', totalRequests: 10, errorCount: 0, errorRatePct: 0, requestsPerSec: 5, maxRequestsPerSec: 9, avgMs: 5, minMs: 2, maxMs: 10, p90Ms: 8, p95Ms: 9, p99Ms: 10, bytesReceived: 100 },
    ],
  });
  assert.equal(fallbackPeak.overallMaxRps, 14);
  assert.equal(fallbackPeak.overallPeakTimestampMs, null);
  assert.equal(fallbackPeak.byRequestMaxRps.r1, 9);
});

test('perfStorage isolates scopes, auto-prunes to 25 reports, and clears cloud reports on logout', async () => {
  const { perfStorage } = loadCommonModules();
  const scopeA = perfStorage.buildPerfScopeKey({
    workspaceMode: 'offline',
    activeOfflineWorkspaceId: 'ws-a',
  });
  const scopeCloud = perfStorage.buildPerfScopeKey({
    workspaceMode: 'cloud',
    cloudUserId: 'user-1',
    activeScopeType: 'project',
    activeScopeId: 'proj-9',
  });

  for (let i = 0; i < 30; i++) {
    await perfStorage.savePerfReport(scopeA, {
      id: `rep-a-${i}`,
      startedAt: 1000 + i * 10,
      title: `Run ${i}`,
    });
  }
  await perfStorage.savePerfReport(scopeCloud, {
    id: 'rep-cloud-1',
    startedAt: 5000,
    title: 'Cloud Run',
  });

  const listA = await perfStorage.listPerfReports(scopeA);
  assert.equal(listA.length, 25);
  assert.equal(listA[0].id, 'rep-a-29');
  assert.equal(listA[24].id, 'rep-a-5');

  await perfStorage.clearCloudPerfReports('user-1');
  const listCloudAfter = await perfStorage.listPerfReports(scopeCloud);
  assert.equal(listCloudAfter.length, 0);
  assert.equal((await perfStorage.listPerfReports(scopeA)).length, 25);
});

test('perfReportExporter produces standalone HTML without CDN scripts and escapes script-closing sequences', () => {
  const { perfReportExporter } = loadCommonModules();
  const sampleReport = {
    id: 'rep-html-1',
    tabId: 'perf:collection:c1',
    title: 'Smoke <script>alert(1)</script>',
    sourceType: 'collection',
    sourceId: 'c1',
    startedAt: Date.now(),
    finishedAt: Date.now() + 2000,
    durationMs: 2000,
    status: 'completed',
    engineMode: 'rust_native',
    platformId: 'desktop',
    executionMode: 'sequential',
    configSnapshot: {
      loadProfile: {
        profile: 'fixed',
        virtualUsers: 10,
        baseLoad: 2,
        durationValue: 5,
        durationUnit: 'seconds',
        handles: { fixed: [], ramp_up: [0.3], spike: [0.45, 0.5, 0.78], peak: [0.25, 0.35, 0.7, 0.82], staircase: [0.25, 0.5, 0.75] },
        thinkTimeMs: 0,
      },
      network: { requestTimeoutMs: 15000, followRedirects: true, ignoreSslErrors: false },
      requestCount: 1,
      setupRequestCount: 0,
      runInLoopScripts: false,
    },
    summary: {
      totalRequests: 42,
      errorCount: 1,
      errorRatePct: 2.38,
      requestsPerSec: 21,
      avgMs: 15,
      minMs: 4,
      maxMs: 90,
      p90Ms: 28,
      p95Ms: 40,
      p99Ms: 85,
      bytesReceived: 1200,
    },
    timeSeries: [
      {
        second: 0,
        timestampMs: Date.now(),
        virtualUsers: 10,
        totalRequests: 42,
        errorCount: 1,
        errorRatePct: 2.38,
        requestsPerSec: 42,
        avgMs: 15,
        minMs: 4,
        maxMs: 90,
        p90Ms: 28,
        p95Ms: 40,
        p99Ms: 85,
        byRequest: {},
      },
    ],
    endpoints: [
      {
        requestId: 'r1',
        name: 'Get Users',
        method: 'GET',
        path: 'Get Users',
        totalRequests: 42,
        errorCount: 1,
        errorRatePct: 2.38,
        requestsPerSec: 21,
        avgMs: 15,
        minMs: 4,
        maxMs: 90,
        p90Ms: 28,
        p95Ms: 40,
        p99Ms: 85,
        bytesReceived: 1200,
      },
    ],
    errorGroups: [],
    errorSamples: [],
    warnings: [],
  };

  const html = perfReportExporter.exportPerformanceReportHtml(sampleReport);
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('Max Req/s'));
  assert.ok(!html.includes('https://cdn.'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('\\u003cscript\\u003ealert(1)\\u003c/script\\u003e'));

  const json = JSON.parse(perfReportExporter.exportPerformanceReportJson(sampleReport));
  assert.equal(json.report.id, 'rep-html-1');
});

test('perfRunner executes Pre-run Setup 1x, fails fast on setup errors, runs load against local HTTP server, and enforces single active run lock', async () => {
  const { perfRunner, loadProfileMath } = loadCommonModules();

  let tokenHits = 0;
  let dataHits = 0;
  let sawValidToken = 0;
  let failToken = false;

  const server = http.createServer((req, res) => {
    if (req.url === '/token') {
      tokenHits += 1;
      if (failToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid credentials' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'tok-xyz' }));
      return;
    }

    if (req.url === '/items') {
      dataHits += 1;
      if (req.headers.authorization === 'Bearer tok-xyz') {
        sawValidToken += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      return;
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('boom');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const mockScriptExecutor = {
      execute: async (input) => {
        const nextEnv = { ...input.environment };
        if (input.response?.data) {
          const parsed = JSON.parse(input.response.data);
          if (parsed.access_token) nextEnv.authToken = parsed.access_token;
        }
        return { success: true, environment: nextEnv, variables: { ...input.variables } };
      },
      dispose: () => {},
    };

    const mockAdapter = {
      platformId: 'extension',
      capabilities: {
        supportsCustomForbiddenHeaders: false,
        supportsIgnoreSslErrors: false,
        supportsNativeFileSystem: false,
        supportsManualRedirectResponse: false,
      },
      transport: {
        fetch: (url, init) => fetch(url, init),
        classifyError: async (err) => ({ category: 'other', detail: String(err) }),
      },
      cloudTransport: { fetch: (url, init) => fetch(url, init) },
      scriptExecutor: mockScriptExecutor,
      saveFile: async () => true,
      openFile: async () => null,
      hasHostPermission: async () => true,
      requestHostPermission: async () => true,
      dispose: () => {},
    };

    const makeReq = (id, name, method, url, postResponseScript = '') => ({
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
        auth: method === 'GET' ? { type: 'bearer', bearerToken: '{{authToken}}' } : { type: 'none' },
        bodyType: 'none',
        bodyContent: '',
        postResponseScript,
        createdAt: 1,
        updatedAt: 1,
      },
    });

    const items = [
      makeReq('setup-tok', 'Get Token', 'POST', `${baseUrl}/token`, 'pm.environment.set("authToken", pm.response.json().access_token);'),
      makeReq('load-items', 'List Items', 'GET', `${baseUrl}/items`),
      makeReq('load-err', 'Fail Endpoint', 'GET', `${baseUrl}/fail`),
    ];

    const cfg = loadProfileMath.createDefaultLoadProfileConfig(30);
    cfg.virtualUsers = 3;
    cfg.durationValue = 1; // clamped to 5s minimum by getDurationSeconds, we will stop early via stopActivePerformanceRun

    // 1. Fail-fast test on Pre-run Setup error
    failToken = true;
    const failedReport = await new Promise((resolve) => {
      void perfRunner.startPerformanceTest({
        tabId: 'perf:test:fail',
        title: 'Fail Setup Test',
        sourceType: 'collection',
        sourceId: 'c1',
        items,
        executionMode: 'pre_run_setup',
        setupItemIds: ['setup-tok'],
        runInLoopScripts: false,
        loadProfile: cfg,
        network: { requestTimeoutMs: 5000, followRedirects: true, ignoreSslErrors: false },
        initialVariables: {},
        adapter: mockAdapter,
        onUpdate: () => {},
        onFinish: resolve,
      });
    });

    assert.equal(failedReport.status, 'failed');
    assert.equal(tokenHits, 1);
    assert.equal(dataHits, 0);
    assert.match(failedReport.failureReason, /Pre-run setup "Get Token" failed/);

    // 2. Success Pre-run Setup 1x + Load loop + Single Active Run Lock + early stop
    failToken = false;
    tokenHits = 0;
    dataHits = 0;
    sawValidToken = 0;

    let finishedReport = null;
    const finishPromise = new Promise((resolve) => {
      void perfRunner
        .startPerformanceTest({
          tabId: 'perf:test:ok',
          title: 'Load Test OK',
          sourceType: 'collection',
          sourceId: 'c1',
          items,
          executionMode: 'pre_run_setup',
          setupItemIds: ['setup-tok'],
          runInLoopScripts: false,
          loadProfile: cfg,
          network: { requestTimeoutMs: 5000, followRedirects: true, ignoreSslErrors: false },
          initialVariables: {},
          adapter: mockAdapter,
          onUpdate: () => {},
          onFinish: (rep) => {
            finishedReport = rep;
            resolve(rep);
          },
        })
        .then(async (res) => {
          assert.equal(res.started, true);
          // Concurrent second run must be rejected by Single Active Run Lock
          const second = await perfRunner.startPerformanceTest({
            tabId: 'perf:test:second',
            title: 'Second',
            sourceType: 'collection',
            sourceId: 'c2',
            items,
            executionMode: 'sequential',
            setupItemIds: [],
            runInLoopScripts: false,
            loadProfile: cfg,
            network: { requestTimeoutMs: 5000, followRedirects: true, ignoreSslErrors: false },
            initialVariables: {},
            adapter: mockAdapter,
            onUpdate: () => {},
            onFinish: () => {},
          });
          assert.equal(second.started, false);
          assert.match(second.error, /already running/i);

          await new Promise((r) => setTimeout(r, 350));
          await perfRunner.stopActivePerformanceRun();
        });
    });

    await finishPromise;
    assert.ok(finishedReport);
    assert.equal(finishedReport.status, 'stopped');
    assert.equal(tokenHits, 1, 'Setup request must execute exactly 1 time');
    assert.ok(dataHits > 0, 'Loop requests must execute after setup');
    assert.equal(sawValidToken, dataHits, 'All loop requests must receive setup token');
    assert.equal(finishedReport.endpoints.length, 2, 'Setup request must be excluded from load endpoints');
    assert.ok(finishedReport.summary.maxRequestsPerSec > 0, 'Summary Max Req/s must be computed');
    assert.ok(
      finishedReport.endpoints.every((ep) => typeof ep.maxRequestsPerSec === 'number' && ep.maxRequestsPerSec >= 0),
      'Per-endpoint Max Req/s must be populated'
    );
    assert.ok(finishedReport.errorSamples.length > 0, '500 errors must be sampled');
    assert.ok(finishedReport.errorGroups.length > 0, 'Error groups must be populated');
  } finally {
    server.close();
  }
});

test('buildOrderedVisualTabs orders request, example, and performance tabs consistently', () => {
  const { examples } = loadCommonModules();
  const ordered = examples.buildOrderedVisualTabs(
    [{ id: 'req-1' }],
    [{ id: 'example:c1:r1:e1', collectionId: 'c1', itemId: 'r1', exampleId: 'e1' }],
    ['perf:collection:c1', 'req-1', 'example:c1:r1:e1'],
    [{ id: 'perf:collection:c1', title: 'Perf' }]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ordered.map((x) => `${x.kind}:${x.id}`))),
    ['performance:perf:collection:c1', 'request:req-1', 'example:example:c1:r1:e1']
  );
});

test('perfDataFile parses CSV/JSON, enforces platform caps, and selects deterministic row slices', () => {
  const { perfDataFile } = loadCommonModules();

  const csvContent = '\uFEFFuserId,note\r\n"u1","hello, ""world"""\r\nu2,simple\r\n\r\n';
  const parsedCsv = perfDataFile.parsePerformanceDataFile('users.csv', csvContent, 'desktop', 'sequential');
  assert.equal(parsedCsv.meta.format, 'csv');
  assert.equal(parsedCsv.meta.rowCount, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(parsedCsv.meta.columns)), ['userId', 'note']);
  assert.equal(parsedCsv.rows[0].userId, 'u1');
  assert.equal(parsedCsv.rows[0].note, 'hello, "world"');
  assert.equal(parsedCsv.rows[1].note, 'simple');

  const jsonContent = JSON.stringify([
    { id: 101, active: true, meta: { role: 'qa' } },
    { id: 102, note: null },
  ]);
  const parsedJson = perfDataFile.parsePerformanceDataFile('rows.json', jsonContent, 'extension', 'per_vu');
  assert.equal(parsedJson.meta.format, 'json');
  assert.deepEqual(JSON.parse(JSON.stringify(parsedJson.meta.columns)), ['id', 'active', 'meta', 'note']);
  assert.equal(parsedJson.rows[0].id, '101');
  assert.equal(parsedJson.rows[0].active, 'true');
  assert.equal(parsedJson.rows[0].meta, '{"role":"qa"}');
  assert.equal(parsedJson.rows[1].note, '');

  // Row limit enforcement on extension (max 10,000) vs desktop (max 50,000)
  const overExt = Array.from({ length: 10_001 }, (_, i) => ({ id: i }));
  assert.throws(
    () => perfDataFile.parsePerformanceDataFile('big.json', JSON.stringify(overExt), 'extension', 'sequential'),
    /exceeding the 10[,.]000 row limit/i
  );

  // Per-VU partition deterministic wrap-around parity
  assert.equal(perfDataFile.selectDataRowIndex('per_vu', 5, 0, 2, 0, 0), 0);
  assert.equal(perfDataFile.selectDataRowIndex('per_vu', 5, 0, 2, 2, 0), 0);
  assert.equal(perfDataFile.selectDataRowIndex('per_vu', 5, 1, 2, 0, 0), 2);
  assert.equal(perfDataFile.selectDataRowIndex('per_vu', 5, 1, 2, 2, 0), 4);
  assert.equal(perfDataFile.selectDataRowIndex('per_vu', 2, 3, 5, 0, 0), 1);
  assert.equal(perfDataFile.selectDataRowIndex('random', 5, 0, 2, 0, 0, () => 0.99), 4);
});

test('perfThresholds evaluates all metrics/operators and enforces warm-up & consecutive auto-stop breaches', () => {
  const { perfThresholds } = loadCommonModules();

  const report = {
    summary: {
      totalRequests: 200,
      errorCount: 4,
      errorRatePct: 2.0,
      requestsPerSec: 40,
      maxRequestsPerSec: 65,
      avgMs: 120,
      minMs: 20,
      maxMs: 600,
      p90Ms: 250,
      p95Ms: 380,
      p99Ms: 520,
      bytesReceived: 1024,
    },
    timeSeries: [
      { second: 0, timestampMs: 1000, virtualUsers: 5, totalRequests: 65, errorCount: 0, errorRatePct: 0, requestsPerSec: 65, avgMs: 90, minMs: 20, maxMs: 200, p90Ms: 150, p95Ms: 180, p99Ms: 195 },
    ],
    endpoints: [
      {
        requestId: 'ep-1',
        name: 'Orders',
        method: 'GET',
        path: '/orders',
        totalRequests: 200,
        errorCount: 4,
        errorRatePct: 2.0,
        requestsPerSec: 40,
        maxRequestsPerSec: 65,
        avgMs: 120,
        minMs: 20,
        maxMs: 600,
        p90Ms: 250,
        p95Ms: 380,
        p99Ms: 520,
        bytesReceived: 1024,
      },
    ],
  };

  const sla = perfThresholds.evaluatePerformanceThresholds(report, {
    abortGracePeriodSec: 10,
    abortConsecutiveBreaches: 3,
    rules: [
      { id: 'r1', enabled: true, targetRequestId: 'overall', metric: 'p95Ms', operator: 'lt', value: 400 },
      { id: 'r2', enabled: true, targetRequestId: 'overall', metric: 'maxRequestsPerSec', operator: 'gte', value: 60 },
      { id: 'r3', enabled: true, targetRequestId: 'ep-1', metric: 'errorRatePct', operator: 'lte', value: 1.5 },
    ],
  });
  assert.equal(sla.status, 'failed');
  assert.equal(sla.passedCount, 2);
  assert.equal(sla.failedCount, 1);
  assert.equal(sla.results[2].passed, false);

  const tracker = perfThresholds.createAutoStopTracker({
    abortGracePeriodSec: 5,
    abortConsecutiveBreaches: 3,
    rules: [
      { id: 'abort1', enabled: true, targetRequestId: 'overall', metric: 'errorRatePct', operator: 'lt', value: 1, abortOnFail: true },
    ],
  });
  assert.equal(tracker.evaluateTick(report, 3).shouldAbort, false); // inside warm-up
  assert.equal(tracker.evaluateTick(report, 6).shouldAbort, false); // streak 1
  assert.equal(tracker.evaluateTick(report, 7).shouldAbort, false); // streak 2
  const abortDecision = tracker.evaluateTick(report, 8); // streak 3 -> abort
  assert.equal(abortDecision.shouldAbort, true);
  assert.equal(abortDecision.ruleId, 'abort1');
});

test('perfComparison & perfReportExporter produce KPI/endpoint deltas, CSV sheets, and SLA HTML', () => {
  const { perfComparison, perfReportExporter } = loadCommonModules();

  const base = {
    id: 'rep-base',
    tabId: 'perf:1',
    title: 'Checkout API',
    sourceType: 'collection',
    sourceId: 'col-1',
    startedAt: 1700000000000,
    finishedAt: 1700000005000,
    durationMs: 5000,
    status: 'completed',
    engineMode: 'rust_native',
    platformId: 'desktop',
    executionMode: 'sequential',
    configSnapshot: {
      loadProfile: { profile: 'fixed', virtualUsers: 20, baseLoad: 0, durationValue: 5, durationUnit: 'seconds', handles: {}, thinkTimeMs: 0 },
      network: { requestTimeoutMs: 15000, followRedirects: true, ignoreSslErrors: false },
      requestCount: 2,
      setupRequestCount: 0,
      runInLoopScripts: false,
    },
    summary: { totalRequests: 500, errorCount: 10, errorRatePct: 2.0, requestsPerSec: 100, maxRequestsPerSec: 120, avgMs: 200, minMs: 50, maxMs: 500, p90Ms: 300, p95Ms: 350, p99Ms: 450, bytesReceived: 5000 },
    timeSeries: [
      { second: 0, timestampMs: 1700000000000, virtualUsers: 20, totalRequests: 250, errorCount: 5, errorRatePct: 2, requestsPerSec: 100, avgMs: 200, minMs: 50, maxMs: 400, p90Ms: 300, p95Ms: 350, p99Ms: 390 },
    ],
    endpoints: [
      { requestId: 'a', name: 'Login, User', method: 'POST', path: '/login', totalRequests: 250, errorCount: 5, errorRatePct: 2, requestsPerSec: 50, maxRequestsPerSec: 60, avgMs: 180, minMs: 40, maxMs: 400, p90Ms: 260, p95Ms: 310, p99Ms: 380, bytesReceived: 2000 },
      { requestId: 'old', name: 'Legacy', method: 'GET', path: '/old', totalRequests: 250, errorCount: 5, errorRatePct: 2, requestsPerSec: 50, maxRequestsPerSec: 60, avgMs: 220, minMs: 60, maxMs: 500, p90Ms: 320, p95Ms: 380, p99Ms: 450, bytesReceived: 3000 },
    ],
    errorGroups: [],
    errorSamples: [],
    warnings: [],
  };

  const cur = {
    ...base,
    id: 'rep-cur',
    startedAt: 1700000100000,
    slaResult: {
      status: 'passed',
      passedCount: 1,
      failedCount: 0,
      totalCount: 1,
      autoAborted: false,
      results: [{ ruleId: 'r1', targetRequestId: 'overall', targetLabel: 'All requests (Overall)', metric: 'avgMs', operator: 'lt', expected: 250, actual: 150, passed: true, abortOnFail: false }],
    },
    summary: { ...base.summary, totalRequests: 700, errorCount: 0, errorRatePct: 0, requestsPerSec: 140, maxRequestsPerSec: 170, avgMs: 150, p95Ms: 240 },
    endpoints: [
      { requestId: 'a', name: 'Login, User', method: 'POST', path: '/login', totalRequests: 400, errorCount: 0, errorRatePct: 0, requestsPerSec: 80, maxRequestsPerSec: 100, avgMs: 140, minMs: 30, maxMs: 280, p90Ms: 210, p95Ms: 240, p99Ms: 270, bytesReceived: 3200 },
      { requestId: 'new-ep', name: 'Profile', method: 'GET', path: '/profile', totalRequests: 300, errorCount: 0, errorRatePct: 0, requestsPerSec: 60, maxRequestsPerSec: 70, avgMs: 160, minMs: 35, maxMs: 310, p90Ms: 230, p95Ms: 260, p99Ms: 300, bytesReceived: 2400 },
    ],
  };

  const cmp = perfComparison.computePerformanceComparison(cur, base);
  assert.equal(cmp.kpis.requestsPerSec.direction, 'improved');
  assert.equal(cmp.kpis.avgMs.direction, 'improved');
  assert.equal(cmp.endpoints.find((e) => e.matchStatus === 'matched').current.requestId, 'a');
  assert.equal(cmp.endpoints.find((e) => e.matchStatus === 'new').current.requestId, 'new-ep');
  assert.equal(cmp.endpoints.find((e) => e.matchStatus === 'removed').baseline.requestId, 'old');

  const csvEp = perfReportExporter.exportPerformanceEndpointsCsv(cur);
  assert.match(csvEp, /"Login, User"/);
  assert.match(csvEp, /Max Req\/s/);

  const csvTs = perfReportExporter.exportPerformanceTimeSeriesCsv(cur);
  assert.match(csvTs, /Elapsed \(s\),Timestamp \(ISO\),Virtual Users/);

  const html = perfReportExporter.exportPerformanceReportHtml(cur, base);
  assert.match(html, /SLA PASSED \(1\/1\)/);
  assert.match(html, /Comparing against baseline:/);

  const imported = perfComparison.parseImportedPerformanceReport(perfReportExporter.exportPerformanceReportJson(base));
  assert.equal(imported.report.id, 'rep-base');
});

test('perfRunner binds CSV/JSON rows + pm.iterationData, enforces SLA auto-stop, and handles 401 token refresh', async () => {
  const { perfRunner, loadProfileMath } = loadCommonModules();

  let tokenEpoch = 0;
  let seenRowParam = [];
  let seenScriptIter = [];
  let acceptOldToken = false;

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/auth') {
      tokenEpoch += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: `tok-${tokenEpoch}` }));
      return;
    }
    if (u.pathname === '/echo') {
      const user = u.searchParams.get('user');
      if (user) seenRowParam.push(user);
      if (u.searchParams.get('iterHdr') === 'from-script') seenScriptIter.push('from-script');
      if (!acceptOldToken && tokenEpoch === 1 && req.headers.authorization === 'Bearer tok-1') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expired' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(500);
    res.end('err');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const mockScriptExecutor = {
      execute: async (input) => {
        const nextEnv = { ...input.environment };
        if (input.response?.data) {
          const parsed = JSON.parse(input.response.data);
          if (parsed.token) nextEnv.authToken = parsed.token;
        }
        if (input.iterationData?.flag && input.request) {
          const baseUrlOnly = input.request.url.split('?')[0];
          return {
            success: true,
            environment: nextEnv,
            variables: { ...input.variables },
            mutatedRequest: {
              url: baseUrlOnly,
              queryParams: [
                ...(input.request.params || []).filter((p) => p.enabled !== false),
                { key: 'iterHdr', value: input.iterationData.flag },
              ],
            },
          };
        }
        return { success: true, environment: nextEnv, variables: { ...input.variables } };
      },
      dispose: () => {},
    };

    const mockAdapter = {
      platformId: 'extension',
      capabilities: { supportsCustomForbiddenHeaders: false, supportsIgnoreSslErrors: false, supportsNativeFileSystem: false, supportsManualRedirectResponse: false },
      transport: {
        fetch: (url, init) => fetch(url, init),
        classifyError: async (err) => ({ category: 'other', detail: String(err) }),
      },
      cloudTransport: { fetch: (url, init) => fetch(url, init) },
      scriptExecutor: mockScriptExecutor,
      saveFile: async () => true,
      openFile: async () => null,
      hasHostPermission: async () => true,
      requestHostPermission: async () => true,
      dispose: () => {},
    };

    const items = [
      {
        id: 'setup-1',
        itemId: 'setup-1',
        name: 'Auth',
        method: 'POST',
        path: 'Auth',
        selected: true,
        request: {
          id: 'setup-1',
          name: 'Auth',
          method: 'POST',
          url: `${baseUrl}/auth`,
          params: [],
          headers: [],
          auth: { type: 'none' },
          bodyType: 'none',
          bodyContent: '',
          postResponseScript: 'pm.environment.set("authToken", pm.response.json().token);',
          createdAt: 1,
          updatedAt: 1,
        },
      },
      {
        id: 'loop-1',
        itemId: 'loop-1',
        name: 'Echo',
        method: 'GET',
        path: 'Echo',
        selected: true,
        request: {
          id: 'loop-1',
          name: 'Echo',
          method: 'GET',
          url: `${baseUrl}/echo?user={{userId}}`,
          params: [{ id: 'p1', key: 'user', value: '{{userId}}', enabled: true }],
          headers: [],
          auth: { type: 'bearer', bearerToken: '{{authToken}}' },
          bodyType: 'none',
          bodyContent: '',
          preRequestScript: '/* triggers mockScriptExecutor iterationData injection */',
          createdAt: 1,
          updatedAt: 1,
        },
      },
    ];

    const cfg = loadProfileMath.createDefaultLoadProfileConfig(30);
    cfg.virtualUsers = 2;
    cfg.durationValue = 5;
    cfg.thinkTimeMs = 40;

    // Run with Data File + pm.iterationData + 401 refresh + Auto-stop after grace=0, consecutive=2 on errorRatePct < 100 (or failing rule)
    // First test: 401 recovery stops after user call (confirming data row substitution, iterationData, and 401 refresh attempt)
    const rep = await new Promise((resolve) => {
      void perfRunner
        .startPerformanceTest({
          tabId: 'perf:2a',
          title: 'Phase 2A Test',
          sourceType: 'collection',
          sourceId: 'c1',
          items,
          executionMode: 'pre_run_setup',
          setupItemIds: ['setup-1'],
          setupRefresh: { enabled: false, intervalValue: 1, intervalUnit: 'minutes', refreshOn401: true, cooldownSec: 15 },
          runInLoopScripts: true,
          loadProfile: cfg,
          network: { requestTimeoutMs: 5000, followRedirects: true, ignoreSslErrors: false },
          dataFileMeta: { filename: 'users.csv', format: 'csv', fileBytes: 40, rowCount: 2, columns: ['userId', 'flag'], previewRows: [], readMode: 'sequential' },
          dataRows: [
            { userId: 'alice', flag: 'from-script' },
            { userId: 'bob', flag: 'from-script' },
          ],
          thresholds: {
            abortGracePeriodSec: 0,
            abortConsecutiveBreaches: 2,
            rules: [
              { id: 't1', enabled: true, targetRequestId: 'overall', metric: 'errorRatePct', operator: 'lt', value: 5, abortOnFail: true },
            ],
          },
          initialVariables: { userId: 'env-default' },
          adapter: mockAdapter,
          onUpdate: () => {},
          onFinish: resolve,
        });
    });

    assert.equal(rep.status, 'stopped');
    assert.equal(rep.autoAborted, true, 'Should auto-abort on sustained 401 breach');
    assert.equal(rep.slaResult.status, 'failed');
    assert.ok(seenRowParam.includes('alice') && seenRowParam.includes('bob'), 'CSV rows must override env userId');
    assert.ok(seenScriptIter.length > 0, 'pm.iterationData must be forwarded to script sandbox');
    assert.ok(rep.setupRefreshStats && rep.setupRefreshStats.attempts >= 1, '401 must trigger setup refresh');
  } finally {
    server.close();
  }
});

test('computeDefaultPerformanceTimeoutMs & clampPerformanceTimeoutMs track 1-minute cap and duration limit', () => {
  const { loadProfileMath } = loadCommonModules();
  assert.equal(loadProfileMath.computeDefaultPerformanceTimeoutMs(10), 10_000);
  assert.equal(loadProfileMath.computeDefaultPerformanceTimeoutMs(30), 30_000);
  assert.equal(loadProfileMath.computeDefaultPerformanceTimeoutMs(60), 60_000);
  assert.equal(loadProfileMath.computeDefaultPerformanceTimeoutMs(300), 60_000);

  assert.equal(loadProfileMath.clampPerformanceTimeoutMs(45_000, 20), 20_000);
  assert.equal(loadProfileMath.clampPerformanceTimeoutMs(15_000, 60), 15_000);
  assert.equal(loadProfileMath.clampPerformanceTimeoutMs(200, 10), 500);
  assert.equal(loadProfileMath.clampPerformanceTimeoutMs(400_000, 600), 300_000);
});
