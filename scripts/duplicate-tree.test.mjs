import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadDuplicateModule() {
  const compile = (file) => ts.transpileModule(
    fs.readFileSync(new URL(file, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const examplesExports = {};
  vm.runInNewContext(compile('../packages/common/src/lib/examples.ts'), {
    exports: examplesExports,
    require: () => ({}),
    crypto,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Error,
    Date,
    Math,
    JSON,
    TextEncoder,
    TextDecoder,
  });
  const exports = {};
  vm.runInNewContext(compile('../packages/common/src/lib/duplicate.ts'), {
    exports,
    require: (id) => (id.includes('examples') ? examplesExports : {}),
    crypto,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Error,
    Date,
    Math,
  }, { filename: 'packages/common/src/lib/duplicate.ts' });
  return exports;
}

function makeDeps(startId = 1, fixedNow = 1700000000000) {
  let seq = startId;
  return {
    generateId: () => `dup-id-${seq++}`,
    now: () => fixedNow,
  };
}

function createRichCollectionFixture() {
  const liveFormFile = { name: 'avatar.png', size: 1024, type: 'image/png' };
  const liveBinaryFile = { name: 'payload.bin', size: 2048, type: 'application/octet-stream' };

  return {
    id: 'col-src',
    name: 'Product APIs',
    description: 'Core APIs',
    version: 7,
    minRole: 'maintainer',
    isPartial: false,
    _syncStatus: 'synced',
    _needsMoveReconciliation: true,
    _origin: 'cloud',
    createdAt: 1000,
    updatedAt: 2000,
    items: [
      {
        id: 'folder-empty',
        name: 'Empty Folder',
        type: 'folder',
        items: [],
      },
      {
        id: 'folder-nested',
        name: 'Users',
        type: 'folder',
        items: [
          {
            id: 'folder-l2',
            name: 'V2',
            type: 'folder',
            items: [
              {
                id: 'req-nested',
                name: 'Get User',
                type: 'request',
                request: {
                  id: 'req-nested',
                  name: 'Get User',
                  method: 'POST',
                  url: 'https://httpbin.org/get?user={{envUser}}&tag=api',
                  params: [{ id: 'p1', key: 'user', value: 'tester', enabled: false, description: 'disabled param' }],
                  pathVariables: [{ id: 'pv1', key: 'id', value: '42', enabled: true }],
                  headers: [{ id: 'h1', key: 'X-Custom', value: 'abc', enabled: false }],
                  auth: { type: 'apikey', apiKeyKey: 'X-API-Key', apiKeyValue: 'dummy-key', apiKeyIn: 'header' },
                  bodyType: 'form-data',
                  rawType: 'json',
                  bodyContent: '{"hello":"world"}',
                  graphqlQuery: 'query { viewer { id } }',
                  graphqlVariables: '{"a":1}',
                  bodyFormData: [
                    { id: 'fd1', key: 'meta', type: 'text', value: 'v1', enabled: true },
                    { id: 'fd2', key: 'file', type: 'file', value: 'avatar.png', file: liveFormFile, fileName: 'avatar.png', fileSize: 1024, fileType: 'image/png', enabled: true },
                  ],
                  bodyUrlEncoded: [{ id: 'ue1', key: 'k', value: 'v', enabled: true }],
                  preRequestScript: 'console.log("pre")',
                  postResponseScript: 'console.log("post")',
                  deletedFromCollection: 'old-col',
                  createdAt: 100,
                  updatedAt: 200,
                },
              },
            ],
          },
        ],
      },
      {
        id: 'req-binary',
        name: 'Upload Binary',
        type: 'request',
        request: {
          id: 'req-binary',
          name: 'Upload Binary',
          method: 'PUT',
          url: 'https://httpbin.org/get?user=tester&tag=api',
          params: [],
          pathVariables: [],
          headers: [],
          auth: { type: 'bearer', bearerToken: 'dummy-token' },
          bodyType: 'binary',
          bodyContent: '',
          bodyBinaryFile: {
            name: 'payload.bin',
            size: 2048,
            type: 'application/octet-stream',
            file: liveBinaryFile,
          },
          createdAt: 100,
          updatedAt: 200,
        },
      },
    ],
  };
}

test('U01: collection naming follows container identity', () => {
  const mod = loadDuplicateModule();
  const src = createRichCollectionFixture();

  const sameWsCopy = mod.duplicateCollectionTree(src, {
    sameContainer: true,
    targetOrigin: 'offline',
    deps: makeDeps(),
  });
  assert.equal(sameWsCopy.name, 'Product APIs copy');

  const diffWsCopy = mod.duplicateCollectionTree(src, {
    sameContainer: false,
    targetOrigin: 'offline',
    deps: makeDeps(),
  });
  assert.equal(diffWsCopy.name, 'Product APIs');
});

test('U02 & U03: folder/request naming, subtree structure, empty folder, and self/descendant insertion', () => {
  const mod = loadDuplicateModule();
  const src = createRichCollectionFixture();

  const sameColFolder = mod.duplicateItemSubtree(src.items[1], {
    sameCollection: true,
    targetParentDepth: 1,
    deps: makeDeps(10),
  });
  assert.equal(sameColFolder.name, 'Users copy');
  assert.equal(sameColFolder.items[0].name, 'V2');
  assert.equal(sameColFolder.items[0].items[0].name, 'Get User');
  assert.equal(sameColFolder.items[0].items[0].request.name, 'Get User');

  const diffColReq = mod.duplicateItemSubtree(src.items[2], {
    sameCollection: false,
    targetParentDepth: 0,
    deps: makeDeps(50),
  });
  assert.equal(diffColReq.name, 'Upload Binary');
  assert.equal(diffColReq.request.name, 'Upload Binary');

  // Self-insertion: snapshot-first clone inserted into source folder itself without infinite recursion
  const insertedIntoSelf = mod.insertItemIntoCollectionTree(src.items, sameColFolder, 'folder-nested');
  assert.ok(insertedIntoSelf);
  const targetFolder = insertedIntoSelf.find((it) => it.id === 'folder-nested');
  assert.equal(targetFolder.items.length, 2);
  assert.equal(targetFolder.items[1].id, sameColFolder.id);
  assert.equal(targetFolder.items[1].name, 'Users copy');

  // Empty folder copy preserves empty items array
  const emptyCopy = mod.duplicateItemSubtree(src.items[0], {
    sameCollection: true,
    deps: makeDeps(80),
  });
  assert.equal(emptyCopy.name, 'Empty Folder copy');
  assert.deepEqual(emptyCopy.items, []);
});

test('U04 & U05: unique new IDs, no mutable aliasing, full config preservation, and cloud sanitization', () => {
  const mod = loadDuplicateModule();
  const src = createRichCollectionFixture();
  const before = JSON.stringify(src);

  const localCopy = mod.duplicateCollectionTree(src, {
    sameContainer: true,
    targetOrigin: 'offline',
    deps: makeDeps(100),
  });

  // Clean sync/cache flags and new IDs
  assert.notEqual(localCopy.id, src.id);
  assert.equal(localCopy.version, undefined);
  assert.equal(localCopy._syncStatus, undefined);
  assert.equal(localCopy._needsMoveReconciliation, undefined);
  assert.equal(localCopy.isPartial, undefined);
  assert.equal(localCopy._origin, 'offline');
  assert.equal(localCopy.minRole, 'maintainer');

  const copiedReqNode = localCopy.items[1].items[0].items[0];
  const srcReqNode = src.items[1].items[0].items[0];
  assert.notEqual(copiedReqNode.id, srcReqNode.id);
  assert.equal(copiedReqNode.id, copiedReqNode.request.id);
  assert.equal(copiedReqNode.request.deletedFromCollection, undefined);
  assert.equal(copiedReqNode.request.bodyFormData[1].file.name, 'avatar.png');

  // Mutating auth/pathVariables/params/headers/bodyFormData on copy must not mutate source
  copiedReqNode.request.auth.apiKeyValue = 'changed';
  copiedReqNode.request.pathVariables[0].value = '99';
  copiedReqNode.request.params[0].enabled = true;
  copiedReqNode.request.headers[0].value = 'mutated';
  copiedReqNode.request.bodyFormData[0].value = 'mutated';
  assert.equal(JSON.stringify(src), before);

  // Offline -> cloud sanitization marks form-data files needsReselection and strips live File & binary file
  const attachmentSummary = mod.inspectDuplicateAttachments(src.items);
  assert.equal(attachmentSummary.hasFormDataFiles, true);
  assert.equal(attachmentSummary.formDataFileCount, 1);
  assert.equal(attachmentSummary.hasBinaryFile, true);
  assert.equal(attachmentSummary.binaryFileCount, 1);

  const cloudCopy = mod.duplicateCollectionTree(src, {
    sameContainer: false,
    targetOrigin: 'cloud',
    sanitizeForCloud: true,
    deps: makeDeps(200),
  });
  assert.equal(cloudCopy.minRole, 'reader');
  const cloudFormFile = cloudCopy.items[1].items[0].items[0].request.bodyFormData[1];
  assert.equal(cloudFormFile.file, undefined);
  assert.equal(cloudFormFile.needsReselection, true);
  assert.equal(cloudFormFile.fileName, 'avatar.png');
  assert.equal(cloudFormFile.fileSize, 1024);
  assert.equal(cloudFormFile.fileType, 'image/png');
  assert.equal(cloudCopy.items[2].request.bodyBinaryFile, undefined);
});

test('U06 & RR5: repeated duplicates and final Unicode rune length boundary (150 vs 151)', () => {
  const mod = loadDuplicateModule();

  // Repeated duplicates on same source produce same name with distinct IDs
  const item = { id: 'r1', name: 'A', type: 'request', request: { id: 'r1', name: 'A', method: 'GET', url: 'https://httpbin.org/get?user=tester&tag=api', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '', createdAt: 1, updatedAt: 1 } };
  const copy1 = mod.duplicateItemSubtree(item, { sameCollection: true, deps: makeDeps(1) });
  const copy2 = mod.duplicateItemSubtree(item, { sameCollection: true, deps: makeDeps(50) });
  assert.equal(copy1.name, 'A copy');
  assert.equal(copy2.name, 'A copy');
  assert.notEqual(copy1.id, copy2.id);

  // Copy of "A copy" -> "A copy copy"
  const copyOfCopy = mod.duplicateItemSubtree(copy1, { sameCollection: true, deps: makeDeps(90) });
  assert.equal(copyOfCopy.name, 'A copy copy');

  // 40 emojis = 40 code points (160 UTF-8 bytes) + " copy" = 45 runes -> accepted!
  const emoji40 = '🚀'.repeat(40);
  const emojiCopy = mod.duplicateItemSubtree(
    { ...item, name: emoji40, request: { ...item.request, name: emoji40 } },
    { sameCollection: true, deps: makeDeps(100) },
  );
  assert.equal(mod.countUnicodeRunes(emojiCopy.name), 45);

  // 145 runes + " copy" = 150 runes -> accepted
  const runes145 = '😀'.repeat(145);
  const ok150 = mod.duplicateItemSubtree(
    { ...item, name: runes145, request: { ...item.request, name: runes145 } },
    { sameCollection: true, deps: makeDeps(110) },
  );
  assert.equal(mod.countUnicodeRunes(ok150.name), 150);

  // 146 runes + " copy" = 151 runes -> rejected
  const runes146 = '😀'.repeat(146);
  assert.throws(
    () => mod.duplicateItemSubtree(
      { ...item, name: runes146, request: { ...item.request, name: runes146 } },
      { sameCollection: true, deps: makeDeps(120) },
    ),
    (err) => err.code === 'NAME_TOO_LONG',
  );

  // 150 runes in different container (no suffix) -> accepted
  const runes150 = 'あ'.repeat(150);
  const diffContainer150 = mod.duplicateItemSubtree(
    { ...item, name: runes150, request: { ...item.request, name: runes150 } },
    { sameCollection: false, deps: makeDeps(130) },
  );
  assert.equal(mod.countUnicodeRunes(diffContainer150.name), 150);

  // Descendant > 150 runes rejected
  const badCollection = {
    id: 'c-bad',
    name: 'Valid Root',
    items: [{ id: 'f1', name: 'x'.repeat(151), type: 'folder', items: [] }],
  };
  assert.throws(
    () => mod.duplicateCollectionTree(badCollection, { sameContainer: false, deps: makeDeps(140) }),
    (err) => err.code === 'NAME_TOO_LONG',
  );
});

test('U07: rejects cycles, depth > 32 (including targetParentDepth + subtreeDepth), and > 5000 items before mutation', () => {
  const mod = loadDuplicateModule();

  // Cycle detection
  const cyclicFolder = { id: 'f-cyc', name: 'Cycle', type: 'folder', items: [] };
  cyclicFolder.items.push(cyclicFolder);
  assert.throws(
    () => mod.duplicateCollectionTree({ id: 'c1', name: 'Col', items: [cyclicFolder] }, { sameContainer: false, deps: makeDeps() }),
    (err) => err.code === 'CYCLE_DETECTED',
  );

  // Depth 32 passes, depth 33 fails (targetParentDepth + subtreeDepth)
  let deep32 = { id: 'leaf', name: 'Leaf', type: 'folder', items: [] };
  for (let i = 31; i >= 1; i--) {
    deep32 = { id: `f-${i}`, name: `F${i}`, type: 'folder', items: [deep32] };
  }
  const col32 = mod.duplicateCollectionTree(
    { id: 'c32', name: 'Deep32', items: [deep32] },
    { sameContainer: false, deps: makeDeps() },
  );
  assert.equal(col32.items.length, 1);

  assert.throws(
    () => mod.duplicateItemSubtree(deep32, { sameCollection: false, targetParentDepth: 1, deps: makeDeps() }),
    (err) => err.code === 'DEPTH_LIMIT_EXCEEDED',
  );

  // Combined depth: subtree of 5 levels inside targetParentDepth 27 = 32 (OK) vs 28 = 33 (reject)
  let sub5 = { id: 's5', name: 'S5', type: 'folder', items: [] };
  for (let i = 4; i >= 1; i--) {
    sub5 = { id: `s${i}`, name: `S${i}`, type: 'folder', items: [sub5] };
  }
  const okSub5 = mod.duplicateItemSubtree(sub5, { sameCollection: false, targetParentDepth: 27, deps: makeDeps() });
  assert.equal(okSub5.name, 'S1');
  assert.throws(
    () => mod.duplicateItemSubtree(sub5, { sameCollection: false, targetParentDepth: 28, deps: makeDeps() }),
    (err) => err.code === 'DEPTH_LIMIT_EXCEEDED',
  );

  // 5000 items allowed vs 5001 rejected
  const mkReq = (i) => ({ id: `r-${i}`, name: `R${i}`, type: 'request', request: { id: `r-${i}`, name: `R${i}`, method: 'GET', url: '', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '', createdAt: 1, updatedAt: 1 } });
  const items5000 = Array.from({ length: 5000 }, (_, i) => mkReq(i));
  const ok5000 = mod.duplicateCollectionTree({ id: 'c5000', name: 'C5000', items: items5000 }, { sameContainer: false, deps: makeDeps() });
  assert.equal(ok5000.items.length, 5000);

  const items5001 = Array.from({ length: 5001 }, (_, i) => mkReq(i));
  assert.throws(
    () => mod.duplicateCollectionTree({ id: 'c5001', name: 'C5001', items: items5001 }, { sameContainer: false, deps: makeDeps() }),
    (err) => err.code === 'ITEM_LIMIT_EXCEEDED',
  );
});
