import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function loadModules() {
  const cache = new Map();
  const globals = {
    console,
    URL,
    URLSearchParams,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Map,
    Set,
    RegExp,
    Error,
    Number,
    String,
    Boolean,
    TextEncoder,
    crypto: globalThis.crypto,
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
    reportShare: load('packages/common/src/lib/reportShare.ts'),
    importBatch: load('packages/common/src/lib/importBatch.ts'),
  };
}

const { reportShare, importBatch } = loadModules();

function makePerfReport(overrides = {}) {
  return {
    id: 'perf-run-1',
    tabId: 'perf:collection:col-1',
    title: 'Orders API — Performance',
    sourceType: 'collection',
    sourceId: 'col-1',
    status: 'completed',
    startedAt: 1732600000000,
    finishedAt: 1732600030000,
    durationMs: 30000,
    engine: 'desktop_native',
    configSnapshot: {
      loadProfile: {
        profile: 'fixed',
        virtualUsers: 20,
        durationSeconds: 30,
        baseLoad: 1,
        thinkTimeMs: 0,
      },
      executionMode: 'sequential',
      setupItemCount: 0,
      runInLoopScripts: false,
      network: {
        requestTimeoutMs: 30000,
        requestTimeoutAuto: true,
        followRedirects: true,
        ignoreSslErrors: false,
      },
    },
    summary: {
      totalRequests: 120,
      totalErrors: 1,
      errorRatePct: 0.83,
      requestsPerSec: 4.0,
      peakRequestsPerSec: 8,
      peakRequestsAtMs: 1732600010000,
      avgMs: 42,
      minMs: 10,
      p90Ms: 80,
      p95Ms: 95,
      p99Ms: 110,
      maxMs: 140,
      bytesReceived: 24576,
    },
    setupResults: [
      {
        requestId: 'setup-1',
        name: 'Auth Login',
        method: 'POST',
        url: 'https://user:supersecret@api.example.com/auth?api_key=abc123&token={{apiToken}}',
        status: 200,
        timeMs: 12,
        success: true,
        updatedVariables: ['apiToken'],
      },
    ],
    endpoints: [
      {
        requestId: 'req-1',
        name: 'List Orders',
        method: 'GET',
        path: 'Orders / List Orders',
        totalRequests: 120,
        errorCount: 1,
        errorRatePct: 0.83,
        requestsPerSec: 4.0,
        maxRequestsPerSec: 8,
        avgMs: 42,
        minMs: 10,
        p90Ms: 80,
        p95Ms: 95,
        p99Ms: 110,
        maxMs: 140,
        bytesReceived: 24576,
      },
    ],
    timeSeries: [
      {
        second: 1,
        timestampMs: 1732600001000,
        virtualUsers: 20,
        requests: 4,
        errors: 0,
        requestsPerSec: 4,
        errorRatePct: 0,
        avgMs: 42,
        p90Ms: 80,
        p95Ms: 95,
        p99Ms: 110,
        minMs: 10,
        maxMs: 140,
      },
    ],
    errorSamples: [
      {
        id: 'err-sample-1',
        timestampMs: 1732600015000,
        requestId: 'req-1',
        requestName: 'List Orders',
        method: 'GET',
        url: 'https://api.example.com/orders?secret=topsecret&limit=10',
        status: 500,
        statusText: 'Internal Server Error',
        category: 'http_5xx',
        message: 'Internal Server Error',
        responseSnippet: 'Authorization: Bearer supersecrettoken123',
        timeMs: 120,
      },
    ],
    ...overrides,
  };
}

function makeFuncReport(overrides = {}) {
  return {
    id: 'func-run-1',
    title: 'Orders API — Runner',
    sourceType: 'folder',
    sourceId: 'fld-1',
    status: 'completed',
    startedAt: 1732600000000,
    finishedAt: 1732600005000,
    durationMs: 5000,
    plannedIterations: 1,
    completedIterations: 1,
    totalRequestsExecuted: 1,
    requestsPassed: 1,
    requestsFailed: 0,
    requestsErrored: 0,
    requestsSkipped: 0,
    totalTests: 2,
    testsPassed: 2,
    testsFailed: 0,
    avgResponseTimeMs: 55,
    totalBytes: 512,
    failedItemIds: [],
    config: {
      iterations: 1,
      delayMs: 0,
      persistResponses: true,
      keepVariableValues: false,
      stopOnError: 'never',
      requestTimeoutMs: 60000,
      followRedirects: true,
      ignoreSslErrors: false,
    },
    steps: [
      {
        stepId: 'step-1',
        iteration: 1,
        itemId: 'req-1',
        name: 'Create Order',
        method: 'POST',
        url: 'https://api.example.com/orders?access_token=secret-jwt-value&dryRun=true',
        status: 'passed',
        httpStatus: 201,
        durationMs: 55,
        responseSizeBytes: 512,
        testResults: [{ name: 'Status is 201', passed: true }],
        hasCapturedExchange: true,
      },
    ],
    ...overrides,
  };
}

const SAMPLE_COLLECTIONS = [
  {
    id: 'col-1',
    name: 'Orders API',
    items: [
      {
        id: 'fld-1',
        type: 'folder',
        name: 'Checkout',
        items: [
          {
            id: 'req-1',
            type: 'request',
            name: 'List Orders',
            request: { id: 'req-1', name: 'List Orders', method: 'GET', url: 'https://api.example.com/orders' },
          },
        ],
      },
    ],
  },
];

test('sanitizeUrlSecrets redacts sensitive credentials and query params while keeping template vars', () => {
  const cleaned = reportShare.sanitizeUrlSecrets(
    'https://admin:hunter2@api.example.com/v1/items?api_key=rawkey&token={{authToken}}&page=2&signature=sig123'
  );
  assert.ok(!cleaned.includes('hunter2'));
  assert.ok(!cleaned.includes('rawkey'));
  assert.ok(!cleaned.includes('sig123'));
  assert.match(cleaned, /page=2/);
  assert.match(cleaned, /\{\{authToken\}\}/);
  assert.match(cleaned, /api_key=%5BREDACTED%5D|api_key=\[REDACTED\]/);
});

test('export & parse shareable bundles preserve provenance metadata and redact secrets', () => {
  const perf = makePerfReport();
  const perfMeta = reportShare.buildSourceMetaFromContext(perf, SAMPLE_COLLECTIONS);
  assert.equal(perfMeta.sourceType, 'collection');
  assert.equal(perfMeta.sourceId, 'col-1');
  assert.equal(perfMeta.sourceCollectionName, 'Orders API');

  const perfJson = reportShare.exportShareablePerformanceReport(perf, perfMeta);
  assert.equal(reportShare.isStrictAirrestReportJson(perfJson), true);
  const parsedPerf = reportShare.parseShareableReportJson(perfJson);
  assert.equal(parsedPerf.error, undefined);
  assert.equal(parsedPerf.kind, 'performance');
  assert.equal(parsedPerf.perfReport.id, 'perf-run-1');
  assert.ok(!parsedPerf.perfReport.setupResults[0].url.includes('supersecret'));
  assert.ok(!parsedPerf.perfReport.setupResults[0].url.includes('abc123'));
  assert.ok(parsedPerf.perfReport.setupResults[0].url.includes('{{apiToken}}'));
  assert.ok(!parsedPerf.perfReport.errorSamples[0].url.includes('topsecret'));
  assert.ok(!parsedPerf.perfReport.errorSamples[0].responseSnippet.includes('supersecrettoken123'));

  const func = makeFuncReport();
  const funcMeta = reportShare.buildSourceMetaFromContext(func, SAMPLE_COLLECTIONS);
  assert.equal(funcMeta.sourceType, 'folder');
  assert.equal(funcMeta.sourceId, 'fld-1');
  assert.equal(funcMeta.sourceCollectionId, 'col-1');
  assert.equal(funcMeta.sourceCollectionName, 'Orders API');
  assert.equal(funcMeta.sourceName, 'Checkout');

  const funcJson = reportShare.exportShareableFunctionalReport(func, funcMeta);
  assert.equal(reportShare.isStrictAirrestReportJson(funcJson), true);
  const parsedFunc = reportShare.parseShareableReportJson(funcJson);
  assert.equal(parsedFunc.error, undefined);
  assert.equal(parsedFunc.kind, 'functional');
  assert.ok(!parsedFunc.funcReport.steps[0].url.includes('secret-jwt-value'));
  assert.equal(parsedFunc.funcReport.steps[0].hasCapturedExchange, false);
});

test('strict report validation rejects Postman collections, environments, and arbitrary JSON', () => {
  const postmanCol = JSON.stringify({
    info: { name: 'Demo', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [],
  });
  const postmanEnv = JSON.stringify({
    name: 'Staging',
    values: [{ key: 'host', value: 'https://api.example.com', enabled: true }],
    _postman_variable_scope: 'environment',
  });

  assert.equal(reportShare.isStrictAirrestReportJson(postmanCol), false);
  assert.equal(reportShare.isStrictAirrestReportJson(postmanEnv), false);
  assert.equal(reportShare.isStrictAirrestReportJson('{"hello":"world"}'), false);
  assert.equal(reportShare.isStrictAirrestReportJson('[1,2,3]'), false);

  assert.ok(reportShare.parseShareableReportJson(postmanCol).error);
  assert.ok(reportShare.parseShareableReportJson(postmanEnv).error);
  assert.ok(reportShare.parseShareableReportJson('{bad json').error);
});

test('3-tier source resolution: exact_id, name_match, unmatched, plus partial cloud hydration candidate', () => {
  // Tier 1: exact folder match
  const exactRes = reportShare.resolveReportSourceTarget(
    {
      sourceType: 'folder',
      sourceId: 'fld-1',
      sourceCollectionId: 'col-1',
      sourceCollectionName: 'Orders API',
      sourceName: 'Checkout',
    },
    SAMPLE_COLLECTIONS
  );
  assert.equal(exactRes.tier, 'exact_id');
  assert.equal(exactRes.targetType, 'folder');
  assert.equal(exactRes.targetId, 'fld-1');

  // Tier 2: name match fallback when UUID changed after Postman Import as Copy
  const copiedCollections = [
    {
      id: 'col-copy-99',
      name: 'Orders API',
      items: [
        {
          id: 'fld-copy-99',
          type: 'folder',
          name: 'Checkout',
          items: [],
        },
      ],
    },
  ];
  const nameRes = reportShare.resolveReportSourceTarget(
    {
      sourceType: 'folder',
      sourceId: 'fld-original-gone',
      sourceCollectionId: 'col-original-gone',
      sourceCollectionName: 'Orders API',
      sourceName: 'Checkout',
    },
    copiedCollections
  );
  assert.equal(nameRes.tier, 'name_match');
  assert.equal(nameRes.targetType, 'folder');
  assert.equal(nameRes.targetId, 'fld-copy-99');

  // Tier 3: missing workspace collection -> unmatched session-only
  const missingRes = reportShare.resolveReportSourceTarget(
    {
      sourceType: 'collection',
      sourceId: 'col-unknown',
      sourceCollectionName: 'Billing Service',
      sourceName: 'Billing Service',
    },
    SAMPLE_COLLECTIONS
  );
  assert.equal(missingRes.tier, 'unmatched');
  assert.match(missingRes.reason, /Billing Service/);

  // Partial collection hydration check
  const partialCols = [{ id: 'col-1', name: 'Orders API', isPartial: true, items: [] }];
  const candidate = reportShare.findPartialCollectionCandidate(
    {
      sourceType: 'folder',
      sourceId: 'fld-1',
      sourceCollectionId: 'col-1',
      sourceCollectionName: 'Orders API',
      sourceName: 'Checkout',
    },
    partialCols
  );
  assert.equal(candidate?.id, 'col-1');
  assert.equal(
    reportShare.findPartialCollectionCandidate(
      { sourceType: 'folder', sourceId: 'fld-1', sourceName: 'Checkout' },
      SAMPLE_COLLECTIONS
    ),
    null
  );
});

test('bindImportedPerformanceReport and bindImportedFunctionalReport support attached copies and session-only mode', () => {
  const attachedPerf = reportShare.bindImportedPerformanceReport(
    makePerfReport(),
    {
      mode: 'attached',
      targetType: 'collection',
      targetId: 'col-99',
      targetCollection: { id: 'col-99', name: 'Orders Copy', items: [] },
      targetName: 'Orders Copy',
    },
    { filename: 'orders.airrest-report.json', forceNewId: true }
  );
  assert.notEqual(attachedPerf.id, 'perf-run-1');
  assert.equal(attachedPerf.tabId, 'perf:collection:col-99');
  assert.equal(attachedPerf.imported, true);
  assert.equal(attachedPerf.importedFilename, 'orders.airrest-report.json');

  const sessionPerf = reportShare.bindImportedPerformanceReport(
    makePerfReport(),
    { mode: 'session_only' },
    { filename: 'shared.airrest-report.json' }
  );
  assert.match(sessionPerf.tabId, /^perf:imported:/);
  assert.equal(sessionPerf.imported, true);

  const attachedFunc = reportShare.bindImportedFunctionalReport(
    makeFuncReport(),
    {
      mode: 'attached',
      targetType: 'collection',
      targetId: 'col-99',
      targetCollection: { id: 'col-99', name: 'Orders Copy', items: [] },
      targetName: 'Orders Copy',
    },
    { forceNewId: true }
  );
  assert.notEqual(attachedFunc.id, 'func-run-1');
  assert.equal(attachedFunc.sourceId, 'col-99');
  assert.equal(attachedFunc.steps[0].hasCapturedExchange, false);
});

test('parseImportBatchFiles handles mixed Postman + report files cleanly regardless of write permissions', () => {
  const perfJson = reportShare.exportShareablePerformanceReport(
    makePerfReport(),
    reportShare.buildSourceMetaFromContext(makePerfReport(), SAMPLE_COLLECTIONS)
  );
  const funcJson = reportShare.exportShareableFunctionalReport(
    makeFuncReport(),
    reportShare.buildSourceMetaFromContext(makeFuncReport(), SAMPLE_COLLECTIONS)
  );
  const postmanCol = JSON.stringify({
    info: { name: 'New API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [],
  });

  const items = importBatch.parseImportBatchFiles(
    [
      { filename: 'api.postman_collection.json', content: postmanCol },
      { filename: 'orders.airrest-report.json', content: perfJson },
      { filename: 'functional.airrest-report.json', content: funcJson },
    ],
    {
      existingCollections: [],
      existingEnvironments: [],
      canWriteCollection: false,
      canWriteEnvironment: false,
    }
  );

  assert.equal(items.length, 3);
  assert.equal(items[0].type, 'collection');
  assert.equal(items[0].disabled, true);
  assert.equal(items[1].type, 'performance_report');
  assert.equal(items[1].disabled, false);
  assert.equal(items[1].checked, true);
  assert.equal(items[2].type, 'functional_report');
  assert.equal(items[2].disabled, false);
  assert.equal(items[2].checked, true);

  assert.equal(
    importBatch.formatBatchImportSummary({
      collectionsImported: 1,
      environmentsImported: 1,
      reportsImported: 2,
      skipped: 0,
      failed: [],
    }),
    'Imported 1 collection, 1 environment, and 2 reports.'
  );
});

test('UI & store contracts for report share, import modal ordering, session banner, and tab cleanup', () => {
  const storeSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/store/useApiStore.ts'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/App.tsx'), 'utf8');
  const importModalSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/components/ImportModal.tsx'), 'utf8');
  const tabViewSrc = fs.readFileSync(
    path.join(ROOT, 'packages/common/src/components/performance/PerformanceTabView.tsx'),
    'utf8'
  );
  const perfViewSrc = fs.readFileSync(
    path.join(ROOT, 'packages/common/src/components/performance/PerformanceReportView.tsx'),
    'utf8'
  );
  const funcViewSrc = fs.readFileSync(
    path.join(ROOT, 'packages/common/src/components/performance/FunctionalReportView.tsx'),
    'utf8'
  );
  const tabBarSrc = fs.readFileSync(path.join(ROOT, 'packages/common/src/components/TabBar.tsx'), 'utf8');

  assert.match(storeSrc, /closingTab\.isSessionOnlyImported/);
  assert.match(appSrc, /isStrictAirrestReportJson/);
  assert.match(importModalSrc, /ReportImportResolveModal/);
  assert.match(importModalSrc, /Always process collections and environments before reports/);
  assert.match(tabViewSrc, /downloadShareBundle/);
  assert.match(tabViewSrc, /attachSessionReportToCollection/);
  assert.match(perfViewSrc, /Share \(\.airrest-report\.json\)/);
  assert.match(perfViewSrc, /Import Report \(\.airrest-report\.json\)/);
  assert.match(perfViewSrc, /SessionOnlyReportBanner/);
  assert.match(funcViewSrc, /Share \(\.airrest-report\.json\)/);
  assert.match(funcViewSrc, /Import Report \(\.airrest-report\.json\)/);
  assert.match(funcViewSrc, /SessionOnlyReportBanner/);
  assert.match(tabBarSrc, /perfTab\.isSessionOnlyImported/);
});
