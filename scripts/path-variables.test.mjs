import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function loadModule(relativePath, mockModules = {}) {
  const filePath = new URL(relativePath, import.meta.url);
  const source = fs.readFileSync(filePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (id) => {
      if (mockModules[id]) return mockModules[id];
      if (id.startsWith('@/lib/') || id.startsWith('./') || id.startsWith('../')) {
        return mockModules[id] || {};
      }
      return require(id);
    },
    Response,
    Blob,
    FormData,
    URL,
    URLSearchParams,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    AbortController,
    performance,
    setTimeout,
    clearTimeout,
    console,
    Map,
    Set,
    Date,
    Math,
  }, { filename: filePath.pathname });
  return exports;
}

test('urlParams: parsePathVariablesFromUrl', () => {
  const urlParams = loadModule('../packages/common/src/lib/urlParams.ts');

  // 1. Single path variable
  const r1 = urlParams.parsePathVariablesFromUrl('{{baseUrl}}/dynamic/rules/:id');
  assert.equal(r1.length, 1);
  assert.equal(r1[0].key, 'id');
  assert.equal(r1[0].value, '');

  // 2. Multiple path variables
  const r2 = urlParams.parsePathVariablesFromUrl('https://example.com/stores/:storeId/orders/:orderId/items/:itemId');
  assert.equal(r2.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(r2.map((v) => v.key))), ['storeId', 'orderId', 'itemId']);

  // 3. Ignore port number (:8080) and query parameters (:notParam)
  const r3 = urlParams.parsePathVariablesFromUrl('http://localhost:8080/api/v1/users/:userId?filter=:notParam#hash=:notHash');
  assert.equal(r3.length, 1);
  assert.equal(r3[0].key, 'userId');

  // 4. Preserving existing values and descriptions
  const existing = [
    { id: 'custom-1', key: 'userId', value: 'user_123', enabled: true, description: 'User ID' },
  ];
  const r4 = urlParams.parsePathVariablesFromUrl('http://localhost:8080/users/:userId/posts/:postId', existing);
  assert.equal(r4.length, 2);
  assert.equal(r4[0].id, 'custom-1');
  assert.equal(r4[0].key, 'userId');
  assert.equal(r4[0].value, 'user_123');
  assert.equal(r4[0].description, 'User ID');
  assert.equal(r4[1].key, 'postId');
  assert.equal(r4[1].value, '');
});

test('urlParams: substitutePathVariables', () => {
  const urlParams = loadModule('../packages/common/src/lib/urlParams.ts');

  // 1. Single substitution
  const url1 = urlParams.substitutePathVariables('{{baseUrl}}/dynamic/rules/:id', [
    { id: '1', key: 'id', value: '550e8400-e29b-41d4-a716-446655440000', enabled: true },
  ]);
  assert.equal(url1, '{{baseUrl}}/dynamic/rules/550e8400-e29b-41d4-a716-446655440000');

  // 2. Multiple substitutions with port and query preserved
  const url2 = urlParams.substitutePathVariables('http://localhost:8080/orgs/:orgId/projects/:projectId?ref=:orgId', [
    { id: '1', key: 'orgId', value: 'org_99', enabled: true },
    { id: '2', key: 'projectId', value: 'proj_42', enabled: true },
  ]);
  assert.equal(url2, 'http://localhost:8080/orgs/org_99/projects/proj_42?ref=:orgId');

  // 3. Disabled variable is skipped
  const url3 = urlParams.substitutePathVariables('https://example.com/items/:itemId', [
    { id: '1', key: 'itemId', value: 'item_1', enabled: false },
  ]);
  assert.equal(url3, 'https://example.com/items/:itemId');
});

test('fetcher & curl: prepareRequest and generateCurlCommand with path variables', () => {
  const urlParams = loadModule('../packages/common/src/lib/urlParams.ts');
  const fetcher = loadModule('../packages/common/src/lib/fetcher.ts', {
    './urlParams': urlParams,
    '../types/api': {},
    '../types/platform': {},
    './blobManager': { createTrackedBlobUrl: () => '' },
  });
  const curl = loadModule('../packages/common/src/lib/curl.ts', {
    './urlParams': urlParams,
    './fetcher': fetcher,
    '../types/api': {},
  });

  const request = {
    id: 'req-1',
    name: 'Get Rule by ID',
    method: 'GET',
    url: 'https://example.com/dynamic/rules/:id',
    params: [],
    pathVariables: [
      { id: 'pv-1', key: 'id', value: '550e8400-e29b-41d4-a716-446655440000', enabled: true },
    ],
    headers: [],
    auth: { type: 'none' },
    bodyType: 'none',
  };

  // Check fetcher prepareRequest
  const prep = fetcher.prepareRequest(request, {});
  assert.equal(prep.finalUrl, 'https://example.com/dynamic/rules/550e8400-e29b-41d4-a716-446655440000');

  // Check cURL generation
  const curlCmd = curl.generateCurlCommand(request, {});
  assert.ok(curlCmd.includes('https://example.com/dynamic/rules/550e8400-e29b-41d4-a716-446655440000'));
  assert.ok(!curlCmd.includes(':id'));
});

test('postman: import and export path variables with Postman collection', () => {
  const urlParams = loadModule('../packages/common/src/lib/urlParams.ts');
  const postman = loadModule('../packages/common/src/lib/postman.ts', {
    './urlParams': urlParams,
    '../types/api': {},
  });

  const sampleCollection = {
    info: {
      name: 'Rules Service API',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      {
        name: 'Get Rule by ID',
        request: {
          method: 'GET',
          header: [],
          url: {
            raw: '{{baseUrl}}/dynamic/rules/:id',
            host: ['{{baseUrl}}'],
            path: ['dynamic', 'rules', ':id'],
            variable: [
              {
                key: 'id',
                value: '550e8400-e29b-41d4-a716-446655440000',
                description: 'Rule ID',
              },
            ],
          },
        },
      },
      {
        name: 'Update Rule',
        request: {
          method: 'PUT',
          header: [],
          url: {
            raw: '{{baseUrl}}/dynamic/rules/:id',
            host: ['{{baseUrl}}'],
            path: ['dynamic', 'rules', ':id'],
            variable: [
              {
                key: 'id',
                value: '550e8400-e29b-41d4-a716-446655440000',
                description: 'Rule ID to update',
              },
            ],
          },
        },
      },
      {
        name: 'Delete Rule',
        request: {
          method: 'DELETE',
          header: [],
          url: {
            raw: '{{baseUrl}}/dynamic/rules/:id',
            host: ['{{baseUrl}}'],
            path: ['dynamic', 'rules', ':id'],
            variable: [
              {
                key: 'id',
                value: '550e8400-e29b-41d4-a716-446655440000',
                description: 'Rule ID to delete',
              },
            ],
          },
        },
      },
    ],
  };

  const rawJson = JSON.stringify(sampleCollection);

  const importedCol = postman.importPostmanCollection(rawJson);
  assert.ok(importedCol.items && importedCol.items.length > 0);

  // Helper to find request recursively
  function findRequest(items, name) {
    for (const item of items) {
      if (item.name === name && item.request) return item.request;
      if (item.items) {
        const found = findRequest(item.items, name);
        if (found) return found;
      }
    }
    return null;
  }

  // 1. Get Rule by ID
  const getRuleReq = findRequest(importedCol.items, 'Get Rule by ID');
  assert.ok(getRuleReq, 'Get Rule by ID should exist in imported collection');
  assert.ok(getRuleReq.pathVariables, 'Get Rule by ID should have pathVariables');
  assert.equal(getRuleReq.pathVariables.length, 1);
  assert.equal(getRuleReq.pathVariables[0].key, 'id');
  assert.equal(getRuleReq.pathVariables[0].value, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(getRuleReq.pathVariables[0].description, 'Rule ID');

  // 2. Update Rule
  const updateRuleReq = findRequest(importedCol.items, 'Update Rule');
  assert.ok(updateRuleReq, 'Update Rule should exist in imported collection');
  assert.equal(updateRuleReq.pathVariables[0].description, 'Rule ID to update');

  // 3. Delete Rule
  const deleteRuleReq = findRequest(importedCol.items, 'Delete Rule');
  assert.ok(deleteRuleReq, 'Delete Rule should exist in imported collection');
  assert.equal(deleteRuleReq.pathVariables[0].description, 'Rule ID to delete');

  // 4. Export collection back to Postman format
  const exportedJson = postman.exportPostmanCollection(importedCol);
  const exportedObj = JSON.parse(exportedJson);

  function findExportedItem(items, name) {
    for (const item of items) {
      if (item.name === name && item.request) return item;
      if (item.item) {
        const found = findExportedItem(item.item, name);
        if (found) return found;
      }
    }
    return null;
  }

  const exportedGetRule = findExportedItem(exportedObj.item, 'Get Rule by ID');
  assert.ok(exportedGetRule, 'Exported collection should have Get Rule by ID');
  assert.ok(exportedGetRule.request.url.variable, 'Exported request should have url.variable');
  assert.equal(exportedGetRule.request.url.variable.length, 1);
  assert.equal(exportedGetRule.request.url.variable[0].key, 'id');
  assert.equal(exportedGetRule.request.url.variable[0].value, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(exportedGetRule.request.url.variable[0].description, 'Rule ID');
});
