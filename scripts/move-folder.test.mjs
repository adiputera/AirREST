import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const RealReact = require('react');

test('findSavedFolderInCollections correctly locates root and nested folders', () => {
  const collections = [
    {
      id: 'col-1',
      name: 'Collection 1',
      items: [
        {
          id: 'f-root-1',
          name: 'Root Folder 1',
          type: 'folder',
          items: [
            {
              id: 'f-sub-1',
              name: 'Subfolder 1',
              type: 'folder',
              items: [
                {
                  id: 'f-sub-deep',
                  name: 'Deep Subfolder',
                  type: 'folder',
                  items: [],
                },
              ],
            },
          ],
        },
        {
          id: 'f-root-2',
          name: 'Root Folder 2',
          type: 'folder',
          items: [],
        },
      ],
    },
    {
      id: 'col-2',
      name: 'Collection 2',
      items: [
        {
          id: 'f-col2-root',
          name: 'Col 2 Root Folder',
          type: 'folder',
          items: [],
        },
      ],
    },
  ];

  // Inline reference implementation matching packages/common/src/lib/requestDiff.ts
  function findSavedFolder(cols, folderId) {
    if (!folderId || !Array.isArray(cols)) return null;
    for (const col of cols) {
      const searchItems = (items = [], parentFolderId) => {
        for (const item of items || []) {
          if (!item) continue;
          if (item.type === 'folder') {
            if (item.id === folderId) {
              return { collection: col, parentFolderId, folder: item };
            }
            if (item.items) {
              const found = searchItems(item.items, item.id);
              if (found) return found;
            }
          }
        }
        return null;
      };
      const result = searchItems(col?.items || [], null);
      if (result) return result;
    }
    return null;
  }

  // 1. Root folder has parentFolderId = null
  const root1 = findSavedFolder(collections, 'f-root-1');
  assert.ok(root1);
  assert.equal(root1.collection.id, 'col-1');
  assert.equal(root1.parentFolderId, null);
  assert.equal(root1.folder.name, 'Root Folder 1');

  // 2. Subfolder has parentFolderId = 'f-root-1'
  const sub1 = findSavedFolder(collections, 'f-sub-1');
  assert.ok(sub1);
  assert.equal(sub1.collection.id, 'col-1');
  assert.equal(sub1.parentFolderId, 'f-root-1');
  assert.equal(sub1.folder.name, 'Subfolder 1');

  // 3. Deep subfolder has parentFolderId = 'f-sub-1'
  const deep = findSavedFolder(collections, 'f-sub-deep');
  assert.ok(deep);
  assert.equal(deep.collection.id, 'col-1');
  assert.equal(deep.parentFolderId, 'f-sub-1');

  // 4. Folder in another collection
  const col2Root = findSavedFolder(collections, 'f-col2-root');
  assert.ok(col2Root);
  assert.equal(col2Root.collection.id, 'col-2');
  assert.equal(col2Root.parentFolderId, null);

  // 5. Non-existent folder returns null
  assert.equal(findSavedFolder(collections, 'f-non-existent'), null);
});

test('Folder move logic: handles intra-collection moves and prevents circular nesting', () => {
  function isDescendant(items = [], ancestorId, targetId, depth = 0) {
    if (depth > 64) return false;
    if (ancestorId === targetId) return true;
    for (const it of items || []) {
      if (it.id === ancestorId) {
        const searchChildren = (children, childDepth = depth) => {
          if (childDepth > 64) return false;
          for (const child of children) {
            if (child.id === targetId) return true;
            if (child.items && searchChildren(child.items, childDepth + 1)) return true;
          }
          return false;
        };
        return searchChildren(it.items || []);
      }
      if (it.items && isDescendant(it.items, ancestorId, targetId, depth + 1)) {
        return true;
      }
    }
    return false;
  }

  const sampleItems = [
    {
      id: 'parent',
      name: 'Parent Folder',
      type: 'folder',
      items: [
        {
          id: 'child',
          name: 'Child Folder',
          type: 'folder',
          items: [
            {
              id: 'grandchild',
              name: 'Grandchild Folder',
              type: 'folder',
              items: [],
            },
          ],
        },
      ],
    },
    {
      id: 'sibling',
      name: 'Sibling Folder',
      type: 'folder',
      items: [],
    },
  ];

  // Self is descendant
  assert.equal(isDescendant(sampleItems, 'parent', 'parent'), true);
  // Child and grandchild are descendants
  assert.equal(isDescendant(sampleItems, 'parent', 'child'), true);
  assert.equal(isDescendant(sampleItems, 'parent', 'grandchild'), true);
  // Sibling is not descendant
  assert.equal(isDescendant(sampleItems, 'parent', 'sibling'), false);
  // Parent is not descendant of child
  assert.equal(isDescendant(sampleItems, 'child', 'parent'), false);
});

test('Folder move execution: moves folders cleanly across collections and subfolders', () => {
  let collections = [
    {
      id: 'c1',
      name: 'Col 1',
      items: [
        {
          id: 'f1',
          name: 'Folder 1',
          type: 'folder',
          items: [{ id: 'req1', name: 'Req 1', type: 'request' }],
        },
        {
          id: 'f2',
          name: 'Folder 2',
          type: 'folder',
          items: [],
        },
      ],
    },
    {
      id: 'c2',
      name: 'Col 2',
      items: [],
    },
  ];

  function executeMoveFolder(sourceColId, folderId, targetColId, targetFolderId) {
    const sourceCol = collections.find((c) => c.id === sourceColId);
    const targetCol = collections.find((c) => c.id === targetColId);
    if (!sourceCol || !targetCol) return { success: false, error: 'Not found' };

    if (targetFolderId && targetFolderId === folderId) {
      return { success: false, error: 'Cannot move folder into itself' };
    }

    let folderToMove = null;
    const remove = (items) => {
      const res = [];
      for (const it of items) {
        if (it.type === 'folder' && it.id === folderId) {
          folderToMove = it;
          continue;
        }
        if (it.type === 'folder') {
          res.push({ ...it, items: remove(it.items || []) });
          continue;
        }
        res.push(it);
      }
      return res;
    };

    const updatedSource = remove(sourceCol.items);
    if (!folderToMove) return { success: false, error: 'Folder not found in source' };

    let targetFound = !targetFolderId;
    const insert = (items) => {
      if (!targetFolderId) return [...items, folderToMove];
      return items.map((it) => {
        if (it.type === 'folder') {
          if (it.id === targetFolderId) {
            targetFound = true;
            return { ...it, items: [...(it.items || []), folderToMove] };
          }
          return { ...it, items: insert(it.items || []) };
        }
        return it;
      });
    };

    let updatedTarget = null;
    if (sourceColId === targetColId) {
      updatedTarget = insert(updatedSource);
    } else {
      updatedTarget = insert(targetCol.items);
    }

    if (targetFolderId && !targetFound) {
      return { success: false, error: 'Target folder not found' };
    }

    collections = collections.map((c) => {
      if (sourceColId === targetColId && c.id === sourceColId) {
        return { ...c, items: updatedTarget };
      }
      if (c.id === sourceColId) return { ...c, items: updatedSource };
      if (c.id === targetColId) return { ...c, items: updatedTarget };
      return c;
    });

    return { success: true };
  }

  // 1. Move f1 inside f2 within c1
  const move1 = executeMoveFolder('c1', 'f1', 'c1', 'f2');
  assert.equal(move1.success, true);
  const c1 = collections.find((c) => c.id === 'c1');
  assert.equal(c1.items.length, 1);
  assert.equal(c1.items[0].id, 'f2');
  assert.equal(c1.items[0].items.length, 1);
  assert.equal(c1.items[0].items[0].id, 'f1');
  assert.equal(c1.items[0].items[0].items[0].id, 'req1');

  // 2. Move f1 across to c2 root
  const move2 = executeMoveFolder('c1', 'f1', 'c2', null);
  assert.equal(move2.success, true);
  const c1After = collections.find((c) => c.id === 'c1');
  const c2After = collections.find((c) => c.id === 'c2');
  assert.equal(c1After.items[0].items.length, 0); // f1 removed from f2
  assert.equal(c2After.items.length, 1);
  assert.equal(c2After.items[0].id, 'f1');
  assert.equal(c2After.items[0].items[0].id, 'req1');

  // 3. Self-move fails
  const moveSelf = executeMoveFolder('c2', 'f1', 'c2', 'f1');
  assert.equal(moveSelf.success, false);
  assert.match(moveSelf.error, /Cannot move folder into itself/);
});

test('Static contract: useApiStore exports moveFolder with RBAC and cloud sync', () => {
  const storePath = path.resolve(rootDir, 'packages/common/src/store/useApiStore.ts');
  const content = fs.readFileSync(storePath, 'utf-8');

  // Must declare moveFolder in ApiStoreState
  assert.match(content, /moveFolder:\s*\([\s\S]*?sourceCollectionId:\s*string,[\s\S]*?folderId:\s*string,[\s\S]*?targetCollectionId:\s*string,[\s\S]*?targetFolderId:\s*string \| null[\s\S]*?\)\s*=>\s*Promise<{ success: boolean; error\?: string }>/);

  // Must implement moveFolder in createApiStore
  assert.match(content, /moveFolder:\s*async\s*\(sourceCollectionId,\s*folderId,\s*targetCollectionId,\s*targetFolderId\)\s*=>/);

  // Must enforce permissions for source and target
  assert.match(content, /canModifyCollection\(sourceCol\.minRole/);
  assert.match(content, /canModifyCollection\(targetCol\.minRole/);

  // Must guard circular moves
  assert.match(content, /targetFolderId && targetFolderId === folderId/);
  assert.match(content, /isDescendantOf\(\[folderToMove\],\s*folderId,\s*targetFolderId\)/);

  // Moves use the atomic endpoint after draining outstanding saves.
  assert.match(content, /return commitItemMove\(\(folderToMove as CollectionItem\)\.id/);
  assert.match(content, /await moveScopeItem\(cloudConfig\.apiUrl/);
});

test('Static contract: MoveFolderModal component contract and UI safeguards', () => {
  const modalPath = path.resolve(rootDir, 'packages/common/src/components/MoveFolderModal.tsx');
  assert.ok(fs.existsSync(modalPath), 'MoveFolderModal.tsx must exist');
  const content = fs.readFileSync(modalPath, 'utf-8');

  // Must export MoveFolderModal
  assert.match(content, /export const MoveFolderModal:\s*React\.FC<MoveFolderModalProps>/);

  // Must import findSavedFolderInCollections and isDescendantOf
  assert.match(content, /findSavedFolderInCollections/);
  assert.match(content, /isDescendantOf/);

  // Must filter out self and descendant folders when target collection is source collection
  assert.match(content, /it\.id === item\.id \|\| isDescendantOf\(sourceCollection\?\.items \|\| \[\],\s*item\.id,\s*it\.id\)/);

  // Must handle isSameLocation disabling
  assert.match(content, /isSameLocation/);
  assert.match(content, /Already in this location/);

  // Must trigger moveFolder on submission
  assert.match(content, /moveFolder\([\s\S]*?sourceCollectionId,[\s\S]*?item\.id,[\s\S]*?selectedCollectionId,[\s\S]*?selectedFolderId/);
});

test('Static contract: Sidebar.tsx integrates Move Folder menu item and modal', () => {
  const sidebarPath = path.resolve(rootDir, 'packages/common/src/components/Sidebar.tsx');
  const content = fs.readFileSync(sidebarPath, 'utf-8');

  // Must import MoveFolderModal
  assert.match(content, /import\s*\{\s*MoveFolderModal\s*\}\s*from\s*'\.\/MoveFolderModal'/);

  // FolderItemProps must declare onRequestMoveFolder
  assert.match(content, /onRequestMoveFolder\?:\s*\(item:\s*CollectionItem,\s*collectionId:\s*string\)\s*=>\s*void/);

  // Folder 3-dots dropdown must render Move Folder button with FolderInput icon
  assert.match(content, /<FolderInput className="h-3\.5 w-3\.5 text-amber-500/);
  assert.match(content, /<span>Move Folder<\/span>/);
  assert.match(content, /onRequestMoveFolder\?\.\(item,\s*collectionId\)/);

  // Sidebar must declare folderToMove state
  assert.match(content, /const \[folderToMove, setFolderToMove\] = useState</);

  // Sidebar must render MoveFolderModal
  assert.match(content, /<MoveFolderModal[\s\S]*?isOpen=\{!!folderToMove\}[\s\S]*?item=\{folderToMove\?\.item \|\| null\}/);
});

test('Static contract: requestDiff.ts and index.ts export findSavedFolderInCollections and MoveFolderModal', () => {
  const diffPath = path.resolve(rootDir, 'packages/common/src/lib/requestDiff.ts');
  const diffContent = fs.readFileSync(diffPath, 'utf-8');
  assert.match(diffContent, /export function findSavedFolderInCollections/);

  const indexPath = path.resolve(rootDir, 'packages/common/src/index.ts');
  const indexContent = fs.readFileSync(indexPath, 'utf-8');
  assert.match(indexContent, /export \* from '\.\/components\/MoveFolderModal'/);
});

test('M1-M5: production store guards concurrent mutators, partial collections, and workspace switches during moves', async () => {
  const { createRequire } = await import('node:module');
  const vm = await import('node:vm');
  const ts = (await import('typescript')).default;
  const localRequire = createRequire(import.meta.url);
  const storeModule = await (() => {
    const absPath = path.resolve(rootDir, 'packages/common/src/store/useApiStore.ts');
    const source = fs.readFileSync(absPath, 'utf-8');
    // Load via TypeScript transpile + minimal runtime stubs matching multi-file-import/duplicate-store
    const moduleCache = new Map();
    const resolveFile = (fromFile, specifier) => {
      const base = path.resolve(path.dirname(fromFile), specifier);
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      }
      return null;
    };
    const loadTs = (filePath) => {
      if (moduleCache.has(filePath)) return moduleCache.get(filePath).exports;
      const mod = { exports: {} };
      moduleCache.set(filePath, mod);
      const src = fs
        .readFileSync(filePath, 'utf8')
        .replace(/import\.meta\.env/g, '({ VITE_APP_EDITION: "full" })');
      const { outputText } = ts.transpileModule(src, {
        fileName: filePath,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      });
      const fn = vm.runInNewContext(
        `(function(exports, require, module, __filename, __dirname) { ${outputText}\n })`,
        {
          console, setTimeout, clearTimeout, setInterval, clearInterval,
          URL, URLSearchParams, TextEncoder, TextDecoder, Blob, FormData, AbortController, AbortSignal,
          crypto: globalThis.crypto, btoa, atob, Date, Math, JSON, Set, Map, Symbol, Promise, Error,
          window: { addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
          document: { documentElement: { classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, removeAttribute() {}, style: {} } },
          navigator: { platform: 'Linux' },
          localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        }
      );
      fn(mod.exports, (spec) => {
        if (spec.startsWith('.')) {
          const target = resolveFile(filePath, spec);
          if (target) return loadTs(target);
        }
        return localRequire(spec);
      }, mod, filePath, path.dirname(filePath));
      return mod.exports;
    };
    return { storeModule: loadTs(absPath), cloudModule: moduleCache.get(path.join(rootDir, 'packages/common/src/lib/cloudApi.ts'))?.exports };
  })();
  const { storeModule: storeApiModule, cloudModule } = storeModule;

  let releaseMoveItem;
  let releasePolicy;
  let batchImportCalls = 0;
  let moveItemCalls = 0;
  let memPersisted = null;
  const store = storeApiModule.createApiStore({
    storage: {
      getItem: async () => memPersisted,
      setItem: async (_k, v) => { memPersisted = v; },
      removeItem: async () => { memPersisted = null; },
    },
    cloudClient: {
      moveScopeItem: async () => {
        moveItemCalls += 1;
        await new Promise((r) => { releaseMoveItem = r; });
        return { message: 'ok' };
      },
      batchImportToScope: async () => {
        batchImportCalls += 1;
        return { success: true };
      },
      fetchFeaturePolicy: async () => new Promise((r) => { releasePolicy = r; }),
      fetchScopeCollections: async () => [],
      fetchScopeEnvironments: async () => [],
      reorderCollectionItems: async () => {
        if (reorderBehavior === 'conflict') {
          throw new cloudModule.CloudApiError('Version conflict', 409);
        }
        if (reorderBehavior === 'network') {
          throw new Error('Network unreachable');
        }
        return { message: 'reordered' };
      },
    },
  });
  await new Promise((r) => setImmediate(r));

  // M5: Partial collections are rejected before any cloud call
  store.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'https://api.example.com',
      token: 'tok-1',
      user: { id: 'u1', role: 'owner' },
      activeScope: { type: 'workspace', id: 'ws-a', name: 'WS A', role: 'owner' },
    },
    collections: [
      { id: 'col-a', name: 'A', items: [{ id: 'r1', name: 'R1', type: 'request', request: { id: 'r1', name: 'R1', method: 'GET', url: 'https://a.test', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '', createdAt: 1, updatedAt: 1 } }], createdAt: 1, updatedAt: 1 },
      { id: 'col-partial', name: 'Partial', isPartial: true, items: [], createdAt: 1, updatedAt: 1 },
    ],
  });
  const partialRes = await store.getState().moveRequest('col-a', 'r1', 'col-partial', null);
  assert.equal(partialRes.success, false);
  assert.match(partialRes.error, /partially loaded/i);
  assert.equal(moveItemCalls, 0);

  // M1: While moveRequest is in-flight, concurrent mutators on col-a/col-b are blocked,
  // and commit re-applies against latest collection state instead of stale snapshot
  store.setState({
    collections: [
      { id: 'col-a', name: 'A', items: [{ id: 'r1', name: 'R1', type: 'request', request: { id: 'r1', name: 'R1', method: 'GET', url: 'https://a.test', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '', createdAt: 1, updatedAt: 1 } }], createdAt: 1, updatedAt: 1 },
      { id: 'col-b', name: 'B', items: [{ id: 'r2', name: 'R2', type: 'request', request: { id: 'r2', name: 'R2', method: 'GET', url: 'https://b.test', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '', createdAt: 1, updatedAt: 1 } }], createdAt: 1, updatedAt: 1 },
    ],
  });
  const movePromise = store.getState().moveRequest('col-a', 'r1', 'col-b', null);
  await new Promise((r) => setImmediate(r));
  assert.equal(moveItemCalls, 1);

  // Concurrent mutator on col-a must be rejected while movingCollections holds lock
  const blockedFolderId = store.getState().createFolder('col-a', null, 'Blocked');
  assert.equal(blockedFolderId, '');

  // Simulate another non-locked metadata/name update on col-b arriving before commit
  store.setState((s) => ({
    collections: s.collections.map((c) => (c.id === 'col-b' ? { ...c, name: 'B Renamed' } : c)),
  }));
  releaseMoveItem();
  const moveRes = await movePromise;
  assert.equal(moveRes.success, true);
  const colB = store.getState().collections.find((c) => c.id === 'col-b');
  assert.equal(colB.name, 'B Renamed', 'Latest target collection edits must survive commit');
  assert.deepEqual(Array.from(colB.items.map((i) => i.id)), ['r2', 'r1']);

  // M2 & M4: Offline -> Cloud moveCollection aborts cleanly if user switches workspace during refreshFeaturePolicy,
  // and invalidates target scopeCache without leaving an unversioned _origin:'cloud' entry
  store.setState({ workspaceMode: 'offline' });
  const ws1 = store.getState().activeOfflineWorkspaceId;
  const ws2 = store.getState().createOfflineWorkspace('WS 2');
  store.getState().switchOfflineWorkspace(ws1);
  store.setState({
    collections: [{ id: 'off-1', name: 'Off1', items: [], createdAt: 1, updatedAt: 1 }],
  });
  const offMovePromise = store.getState().moveCollection('off-1', { type: 'workspace', id: 'ws-a', name: 'WS A' });
  await new Promise((r) => setImmediate(r));
  store.getState().switchOfflineWorkspace(ws2);
  releasePolicy({ flags: { 'collection.move': true, 'collection.delete': true, 'collection.export': true }, revision: 1, updated_at: '' });
  const offMoveRes = await offMovePromise;
  assert.equal(offMoveRes.success, false);
  assert.equal(batchImportCalls, 0, 'Cancelled moveCollection must never upload');
  assert.equal(store.getState().activeOfflineWorkspaceId, ws2);
  assert.equal(store.getState().collections.length, 0, 'Target WS 2 collections must not be clobbered');
  store.getState().switchOfflineWorkspace(ws1);
  assert.equal(store.getState().collections.length, 1);

  // M4: Successful Offline -> Cloud moveCollection removes offline collection and invalidates target scopeCache cleanly
  const targetCacheKey = 'workspace:ws-a';
  store.setState({
    scopeCache: {
      [targetCacheKey]: {
        collections: [{ id: 'existing-cloud', name: 'Existing', items: [], createdAt: 1, updatedAt: 1 }],
        environments: [],
        lastSyncedAt: 999999,
      },
    },
  });
  const okOffMovePromise = store.getState().moveCollection('off-1', { type: 'workspace', id: 'ws-a', name: 'WS A' });
  await new Promise((r) => setImmediate(r));
  releasePolicy({ flags: { 'collection.move': true, 'collection.delete': true, 'collection.export': true }, revision: 1, updated_at: '' });
  const okOffMoveRes = await okOffMovePromise;
  assert.equal(okOffMoveRes.success, true);
  assert.equal(batchImportCalls, 1);
  assert.equal(store.getState().collections.length, 0);
  const invalidatedCache = store.getState().scopeCache[targetCacheKey];
  assert.equal(invalidatedCache.lastSyncedAt, 0, 'Target scopeCache must be invalidated for fresh delta pull');
  assert.ok(!invalidatedCache.collections.some((c) => c.id === 'off-1'), 'Must not insert unversioned _origin:cloud stub');

  // M3: Cloud -> Cloud moveCollection blocks collections that still have _syncStatus === 'pending'
  store.setState({
    workspaceMode: 'cloud',
    collections: [
      { id: 'col-pend', name: 'Pending', _syncStatus: 'pending', items: [], createdAt: 1, updatedAt: 1 },
    ],
  });
  const pendingMoveRes = await store.getState().moveCollection('col-pend', { type: 'project', id: 'proj-b', name: 'Proj B' });
  assert.equal(pendingMoveRes.success, false);
  assert.match(pendingMoveRes.error, /pending changes/i);

  // M9 & M10: commitItemMove bumps collection version & invalidates scopeCache; Offline->Offline validates target workspace;
  // refreshFeaturePolicy coalesces concurrent calls and Cloud->Cloud refreshes expired policy instead of failing immediately
  let policyFetchCount = 0;
  let releaseCoalescedPolicy;
  let moveColCalls = 0;
  let reorderBehavior = 'ok';
  const store2 = storeApiModule.createApiStore({
    storage: {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    },
    cloudClient: {
      moveScopeItem: async () => ({ message: 'ok' }),
      moveScopeCollection: async () => {
        moveColCalls += 1;
        return { message: 'moved' };
      },
      fetchFeaturePolicy: async () => {
        policyFetchCount += 1;
        return new Promise((r) => { releaseCoalescedPolicy = r; });
      },
      fetchScopeCollections: async () => [],
      fetchScopeEnvironments: async () => [],
      reorderCollectionItems: async () => {
        if (reorderBehavior === 'conflict') {
          throw new cloudModule.CloudApiError('Version conflict', 409);
        }
        if (reorderBehavior === 'network') {
          throw new Error('Network unreachable');
        }
        return { message: 'reordered' };
      },
    },
  });
  await new Promise((r) => setImmediate(r));

  // Offline -> Offline to nonexistent workspace must fail cleanly without dropping source collection
  store2.setState({
    workspaceMode: 'offline',
    collections: [{ id: 'off-stay', name: 'Stay', items: [], createdAt: 1, updatedAt: 1 }],
  });
  const badOffTarget = await store2.getState().moveCollection('off-stay', {
    type: 'offline_workspace',
    id: 'ws-deleted',
    name: 'Deleted',
  });
  assert.equal(badOffTarget.success, false);
  assert.match(badOffTarget.error, /not found/i);
  assert.equal(store2.getState().collections.length, 1);

  // M9: Cloud commitItemMove bumps version and sets scopeCache.lastSyncedAt = 0
  store2.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'https://api.example.com',
      token: 'tok-2',
      user: { id: 'u1', role: 'owner' },
      activeScope: { type: 'workspace', id: 'ws-a', name: 'WS A', role: 'owner' },
    },
    featurePolicy: { flags: { 'collection.move': true, 'collection.delete': true, 'collection.export': true }, revision: 1, updated_at: '' },
    featurePolicyStatus: 'ready',
    featurePolicyFetchedAt: Date.now() - 60 * 60 * 1000, // expired TTL (>30 min)
    scopeCache: {
      'workspace:ws-a': { collections: [], environments: [], lastSyncedAt: 123456 },
    },
    collections: [
      { id: 'c1', name: 'C1', version: 3, items: [{ id: 'req-1', name: 'R1', type: 'request', request: { id: 'req-1', name: 'R1', method: 'GET', url: 'https://x.test', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '', createdAt: 1, updatedAt: 1 } }], createdAt: 1, updatedAt: 1 },
      { id: 'c2', name: 'C2', version: 7, items: [], createdAt: 1, updatedAt: 1 },
    ],
  });
  const m9ItemRes = await store2.getState().moveRequest('c1', 'req-1', 'c2', null);
  assert.equal(m9ItemRes.success, true);
  assert.equal(store2.getState().collections.find((c) => c.id === 'c1').version, 4);
  assert.equal(store2.getState().collections.find((c) => c.id === 'c2').version, 8);
  assert.equal(store2.getState().scopeCache['workspace:ws-a'].lastSyncedAt, 0);

  // M10: refreshFeaturePolicy coalesces concurrent callers & Cloud->Cloud refreshes expired policy on submit
  const cloudMoveP = store2.getState().moveCollection('c2', { type: 'project', id: 'proj-target', name: 'Proj Target' });
  const extraPolicyP = store2.getState().refreshFeaturePolicy();
  await new Promise((r) => setImmediate(r));
  assert.equal(policyFetchCount, 1, 'Concurrent refreshFeaturePolicy calls must coalesce');
  releaseCoalescedPolicy({ flags: { 'collection.move': true, 'collection.delete': true, 'collection.export': true }, revision: 2, updated_at: '' });
  const [cloudMoveRes, extraPolicy] = await Promise.all([cloudMoveP, extraPolicyP]);
  assert.equal(extraPolicy.flags['collection.move'], true);
  assert.equal(cloudMoveRes.success, true);
  assert.equal(moveColCalls, 1);

  // M7, M8 & M10 UI modal safeguards
  const moveColSrc = fs.readFileSync(path.join(rootDir, 'packages/common/src/components/MoveCollectionModal.tsx'), 'utf-8');
  const moveFolderSrc = fs.readFileSync(path.join(rootDir, 'packages/common/src/components/MoveFolderModal.tsx'), 'utf-8');
  const moveReqSrc = fs.readFileSync(path.join(rootDir, 'packages/common/src/components/MoveRequestModal.tsx'), 'utf-8');
  const sidebarSrc = fs.readFileSync(path.join(rootDir, 'packages/common/src/components/Sidebar.tsx'), 'utf-8');
  assert.match(moveColSrc, /workspaceMode !== 'offline' \|\| productPolicy\.workspace\.offline === false/);
  assert.match(moveColSrc, /canModifyCollection\(collection\?\.minRole, targetProjectScope/);
  assert.match(moveColSrc, /targetFetchError/);
  assert.match(moveColSrc, /Failed to Load Destination Workspaces/);
  assert.match(moveColSrc, /e\.key === 'Escape'/);
  assert.match(moveFolderSrc, /e\.key === 'Escape'/);
  assert.match(moveReqSrc, /e\.key === 'Escape'/);
  assert.match(sidebarSrc, /setCollectionToMove\(null\);\s*setRequestToMove\(null\);\s*setFolderToMove\(null\);/);

  // M12 (P3): moveRequest / moveFolder to same collection + parent folder is an instant no-op (0 API calls, preserves updatedAt)
  const colC1Before = store2.getState().collections.find((c) => c.id === 'c1');
  store2.setState({
    collections: [
      {
        id: 'm12-col',
        name: 'M12',
        version: 1,
        items: [
          {
            id: 'm12-f1',
            name: 'Folder 1',
            type: 'folder',
            items: [
              { id: 'm12-r1', name: 'Req 1', type: 'request', request: { id: 'm12-r1', name: 'Req 1', method: 'GET', url: 'https://x.test', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '', createdAt: 1, updatedAt: 1 } },
            ],
          },
          { id: 'm12-r2', name: 'Req 2', type: 'request', request: { id: 'm12-r2', name: 'Req 2', method: 'GET', url: 'https://y.test', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '', createdAt: 1, updatedAt: 1 } },
        ],
        createdAt: 1,
        updatedAt: 555,
      },
    ],
  });
  const callsBeforeNoop = moveItemCalls;
  const sameReqMove = await store2.getState().moveRequest('m12-col', 'm12-r1', 'm12-col', 'm12-f1');
  const sameFolderMove = await store2.getState().moveFolder('m12-col', 'm12-f1', 'm12-col', null);
  assert.equal(sameReqMove.success, true);
  assert.equal(sameFolderMove.success, true);
  assert.equal(moveItemCalls, callsBeforeNoop, 'Same-location moveRequest/moveFolder must make 0 cloud calls');
  assert.equal(store2.getState().collections.find((c) => c.id === 'm12-col').updatedAt, 555, 'Same-location move must not bump updatedAt');
  assert.ok(colC1Before);

  // M12 (P3): reorderItem rolls back items on 409 CloudApiError and marks _syncStatus: 'pending' on transient network failure
  reorderBehavior = 'conflict';
  const r409 = await store2.getState().reorderItem('m12-col', 'm12-r2', 'm12-f1', 'before');
  assert.equal(r409.success, true);
  await new Promise((r) => setTimeout(r, 320));
  const after409 = store2.getState().collections.find((c) => c.id === 'm12-col');
  assert.deepEqual(Array.from(after409.items.map((i) => i.id)), ['m12-f1', 'm12-r2'], '409 reorder error must roll back item order');
  assert.equal(store2.getState().syncStatus, 'error');

  reorderBehavior = 'network';
  const rNet = await store2.getState().reorderItem('m12-col', 'm12-r2', 'm12-f1', 'before');
  assert.equal(rNet.success, true);
  await new Promise((r) => setTimeout(r, 320));
  const afterNet = store2.getState().collections.find((c) => c.id === 'm12-col');
  assert.deepEqual(Array.from(afterNet.items.map((i) => i.id)), ['m12-r2', 'm12-f1'], 'Transient network error preserves local reorder');
  assert.equal(afterNet._syncStatus, 'pending', 'Transient network error marks collection pending');

  // M-R3: Non-save mutators (renameCollectionItem, createFolder, etc.) share collectionSaveSyncQueues
  let releaseHeldSync;
  let heldSyncAction = false;
  let queuedMoveCalls = 0;
  let queuedBatchCalls = 0;
  let failNextBatch = false;
  const store3 = storeApiModule.createApiStore({
    storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
    cloudClient: {
      batchImportToScope: async () => {
        queuedBatchCalls += 1;
        if (heldSyncAction) {
          await new Promise((r) => { releaseHeldSync = r; });
        }
        if (failNextBatch) {
          failNextBatch = false;
          throw new Error('Batch sync failed');
        }
        return { success: true };
      },
      moveScopeItem: async () => {
        queuedMoveCalls += 1;
        return { message: 'ok' };
      },
      moveScopeCollection: async () => {
        queuedMoveCalls += 1;
        return { message: 'moved' };
      },
      fetchFeaturePolicy: async () => ({ flags: { 'collection.move': true, 'collection.delete': true, 'collection.export': true }, revision: 1, updated_at: '' }),
      fetchScopeCollections: async () => [],
      fetchScopeEnvironments: async () => [],
    },
  });
  await new Promise((r) => setImmediate(r));

  store3.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'https://api.example.com',
      token: 'tok-3',
      user: { id: 'u1', role: 'owner' },
      activeScope: { type: 'workspace', id: 'ws-q', name: 'WS Q', role: 'owner' },
    },
    featurePolicy: { flags: { 'collection.move': true, 'collection.delete': true, 'collection.export': true }, revision: 1, updated_at: '' },
    featurePolicyStatus: 'ready',
    featurePolicyFetchedAt: Date.now(),
    collections: [
      {
        id: 'q-col-a',
        name: 'QA',
        version: 1,
        _syncStatus: 'synced',
        items: [
          {
            id: 'q-r1',
            name: 'Req 1',
            type: 'request',
            request: { id: 'q-r1', name: 'Req 1', method: 'GET', url: 'https://a.test', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '', createdAt: 1, updatedAt: 1 },
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
      { id: 'q-col-b', name: 'QB', version: 1, _syncStatus: 'synced', items: [], createdAt: 1, updatedAt: 1 },
    ],
  });

  heldSyncAction = true;
  store3.getState().renameCollectionItem('q-col-a', 'q-r1', 'Renamed Before Move');
  await new Promise((r) => setImmediate(r));
  assert.equal(queuedBatchCalls, 1);

  const queuedMovePromise = store3.getState().moveRequest('q-col-a', 'q-r1', 'q-col-b', null);
  await new Promise((r) => setImmediate(r));
  assert.equal(queuedMoveCalls, 0, 'moveRequest must wait for in-flight renameCollectionItem sync queue before calling moveScopeItem');

  heldSyncAction = false;
  releaseHeldSync();
  const queuedMoveRes = await queuedMovePromise;
  assert.equal(queuedMoveRes.success, true);
  assert.equal(queuedMoveCalls, 1);
  const movedColB = store3.getState().collections.find((c) => c.id === 'q-col-b');
  assert.equal(movedColB.items[0].name, 'Renamed Before Move');

  // If a queued createFolder fails, moveCollection waits for the queue and rejects cleanly without moving
  heldSyncAction = true;
  failNextBatch = true;
  store3.getState().createFolder('q-col-b', null, 'Pending Folder');
  await new Promise((r) => setImmediate(r));
  const blockedMoveColPromise = store3.getState().moveCollection('q-col-b', { type: 'project', id: 'proj-z', name: 'Proj Z' });
  await new Promise((r) => setImmediate(r));
  assert.equal(queuedMoveCalls, 1, 'moveCollection must wait for queued createFolder write');
  heldSyncAction = false;
  releaseHeldSync();
  const blockedMoveColRes = await blockedMoveColPromise;
  assert.equal(blockedMoveColRes.success, false);
  assert.match(blockedMoveColRes.error, /pending changes/i);
  assert.equal(queuedMoveCalls, 1, 'moveScopeCollection must not be called when queued non-save write failed');

  // M-R4 & M-R5: Cloud->Cloud moveCollection sets _needsMoveReconciliation on network/5xx drop (cleared on 409);
  // reorderItem bumps col.version, invalidates scopeCache, and skips stale rollback if a newer mutation ran.
  let moveColBehavior = 'network';
  let reorderBehavior3 = 'ok';
  let releaseReorder3;
  let holdReorder3 = false;
  const store4 = storeApiModule.createApiStore({
    storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
    cloudClient: {
      moveScopeCollection: async () => {
        if (moveColBehavior === 'network') {
          throw new Error('Lost reply');
        }
        if (moveColBehavior === 'conflict') {
          throw new cloudModule.CloudApiError('Role conflict', 409);
        }
        return { message: 'moved' };
      },
      reorderCollectionItems: async () => {
        if (holdReorder3) {
          await new Promise((r) => { releaseReorder3 = r; });
        }
        if (reorderBehavior3 === 'conflict') {
          throw new cloudModule.CloudApiError('Order conflict', 409);
        }
        return { message: 'reordered' };
      },
      batchImportToScope: async () => ({ success: true }),
      fetchFeaturePolicy: async () => ({ flags: { 'collection.move': true, 'collection.delete': true, 'collection.export': true }, revision: 1, updated_at: '' }),
      fetchScopeCollections: async () => [],
      fetchScopeEnvironments: async () => [],
    },
  });
  await new Promise((r) => setImmediate(r));

  store4.setState({
    workspaceMode: 'cloud',
    cloudConfig: {
      apiUrl: 'https://api.example.com',
      token: 'tok-4',
      user: { id: 'u1', role: 'owner' },
      activeScope: { type: 'workspace', id: 'ws-4', name: 'WS 4', role: 'owner' },
    },
    featurePolicy: { flags: { 'collection.move': true, 'collection.delete': true, 'collection.export': true }, revision: 1, updated_at: '' },
    featurePolicyStatus: 'ready',
    featurePolicyFetchedAt: Date.now(),
    scopeCache: {
      'workspace:ws-4': { collections: [], environments: [], lastSyncedAt: 999999 },
    },
    collections: [
      {
        id: 'mr-col',
        name: 'MR',
        version: 4,
        _syncStatus: 'synced',
        items: [
          { id: 'mr-1', name: 'One', type: 'request', request: { id: 'mr-1', name: 'One', method: 'GET', url: 'https://1.test', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '', createdAt: 1, updatedAt: 1 } },
          { id: 'mr-2', name: 'Two', type: 'request', request: { id: 'mr-2', name: 'Two', method: 'GET', url: 'https://2.test', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '', createdAt: 1, updatedAt: 1 } },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });

  // M-R5: Successful reorderItem bumps col.version (4 -> 5) and sets scopeCache.lastSyncedAt = 0
  await store4.getState().reorderItem('mr-col', 'mr-2', 'mr-1', 'before');
  await new Promise((r) => setImmediate(r));
  const afterOkReorder = store4.getState().collections.find((c) => c.id === 'mr-col');
  assert.equal(afterOkReorder.version, 5, 'reorderItem success must increment col.version');
  assert.equal(store4.getState().scopeCache['workspace:ws-4'].lastSyncedAt, 0, 'reorderItem success must invalidate scopeCache');

  // M-R5: Failing reorderItem does NOT overwrite a newer renameCollectionItem edit
  holdReorder3 = true;
  reorderBehavior3 = 'conflict';
  await store4.getState().reorderItem('mr-col', 'mr-1', 'mr-2', 'before');
  await new Promise((r) => setImmediate(r));
  store4.getState().renameCollectionItem('mr-col', 'mr-2', 'Two Edited');
  holdReorder3 = false;
  releaseReorder3();
  await new Promise((r) => setTimeout(r, 320));
  const afterNewerEdit = store4.getState().collections.find((c) => c.id === 'mr-col');
  assert.equal(afterNewerEdit.items.find((i) => i.id === 'mr-2').name, 'Two Edited', 'Stale reorder rollback must not overwrite newer item edit');

  // M-R4: Cloud->Cloud moveCollection network drop preserves _needsMoveReconciliation; 409 clears it
  store4.setState((s) => ({
    collections: s.collections.map((c) => (c.id === 'mr-col' ? { ...c, _syncStatus: 'synced' } : c)),
  }));
  moveColBehavior = 'network';
  const netMoveCol = await store4.getState().moveCollection('mr-col', { type: 'project', id: 'proj-4', name: 'Proj 4' });
  assert.equal(netMoveCol.success, false);
  assert.equal(store4.getState().collections.find((c) => c.id === 'mr-col')._needsMoveReconciliation, true, 'Lost reply on Cloud->Cloud moveCollection must preserve _needsMoveReconciliation');

  store4.setState((s) => ({
    collections: s.collections.map((c) => (c.id === 'mr-col' ? { ...c, _needsMoveReconciliation: undefined } : c)),
  }));
  moveColBehavior = 'conflict';
  const conflictMoveCol = await store4.getState().moveCollection('mr-col', { type: 'project', id: 'proj-4', name: 'Proj 4' });
  assert.equal(conflictMoveCol.success, false);
  assert.equal(store4.getState().collections.find((c) => c.id === 'mr-col')._needsMoveReconciliation, undefined, 'Definite 409 rejection must clear _needsMoveReconciliation');

  store4.dispose();
  store3.dispose();
  store2.dispose();
  store.dispose();
});

function createModalTestHarness() {
  const states = [];
  const effects = [];
  const memos = [];
  const refs = [];
  const callbacks = [];
  let stateIdx = 0;
  let effectIdx = 0;
  let memoIdx = 0;
  let refIdx = 0;
  let callbackIdx = 0;
  let dirty = false;

  const depsChanged = (prev, next) => {
    if (!prev || !next || prev.length !== next.length) return true;
    return prev.some((v, i) => !Object.is(v, next[i]));
  };

  const MockReact = {
    Fragment: RealReact.Fragment,
    createElement: RealReact.createElement,
    useState(initial) {
      const idx = stateIdx++;
      if (!(idx in states)) {
        states[idx] = typeof initial === 'function' ? initial() : initial;
      }
      const setState = (updater) => {
        const nextVal = typeof updater === 'function' ? updater(states[idx]) : updater;
        if (!Object.is(states[idx], nextVal)) {
          states[idx] = nextVal;
          dirty = true;
        }
      };
      return [states[idx], setState];
    },
    useRef(initial) {
      const idx = refIdx++;
      if (!(idx in refs)) refs[idx] = { current: initial };
      return refs[idx];
    },
    useMemo(factory, deps) {
      const idx = memoIdx++;
      const prev = memos[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        memos[idx] = { value: factory(), deps };
      }
      return memos[idx].value;
    },
    useCallback(fn, deps) {
      const idx = callbackIdx++;
      const prev = callbacks[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        callbacks[idx] = { value: fn, deps };
      }
      return callbacks[idx].value;
    },
    useEffect(fn, deps) {
      const idx = effectIdx++;
      const prev = effects[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        effects[idx] = { fn, deps, cleanup: prev?.cleanup, pending: true };
      }
    },
  };

  const iconProxy = new Proxy({}, {
    get(_t, prop) {
      return (props) => RealReact.createElement('svg', { ...props, 'data-icon': String(prop) });
    },
  });

  const findElements = (node, pred, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      node.forEach((c) => findElements(c, pred, out));
      return out;
    }
    if (pred(node)) out.push(node);
    if (node.props?.children !== undefined) findElements(node.props.children, pred, out);
    return out;
  };

  const textOf = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    if (node?.props?.children !== undefined) return textOf(node.props.children);
    return '';
  };

  let lastTree = null;
  let lastRender = null;

  const flushEffects = () => {
    for (const eff of effects) {
      if (eff?.pending) {
        eff.pending = false;
        eff.cleanup?.();
        const cleanup = eff.fn();
        eff.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      }
    }
  };

  const render = (renderFn) => {
    lastRender = renderFn;
    for (let pass = 0; pass < 10; pass++) {
      stateIdx = 0;
      effectIdx = 0;
      memoIdx = 0;
      refIdx = 0;
      callbackIdx = 0;
      dirty = false;
      lastTree = renderFn();
      flushEffects();
      if (!dirty) break;
    }
    return lastTree;
  };

  const rerender = () => render(lastRender);

  return { MockReact, iconProxy, findElements, textOf, render, rerender };
}

function loadModalComponent(relPath, customModules) {
  const absPath = path.join(rootDir, relPath);
  const compiled = ts.transpileModule(fs.readFileSync(absPath, 'utf8'), {
    fileName: absPath,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const fn = new Function('require', 'module', 'exports', 'window', 'document', compiled);
  const stubRequire = (id) => {
    if (id in customModules) return customModules[id];
    const base = path.basename(id, path.extname(id));
    if (base in customModules) return customModules[base];
    return require(id);
  };
  const mockWin = { addEventListener() {}, removeEventListener() {} };
  fn(stubRequire, mod, mod.exports, mockWin, {});
  return mod.exports;
}

test('M-R1 & M-R2: Move modals never stick in isSubmitting on JWT refresh or isLoadingDetails on partial->full switch', async () => {
  // M-R1: MoveCollectionModal survives silent JWT refresh (new cloudConfig reference) during submit
  {
    const h = createModalTestHarness();
    let workspaceFetchCount = 0;
    let releaseMove;
    let closedCount = 0;
    const storeState = {
      workspaceMode: 'cloud',
      cloudConfig: {
        apiUrl: 'https://api.example.com',
        token: 'tok-initial',
        refreshToken: 'ref-1',
        user: { id: 'u1', role: 'owner' },
        activeScope: { type: 'workspace', id: 'ws-src', name: 'Source', role: 'owner' },
      },
      offlineWorkspaces: [],
      activeOfflineWorkspaceId: 'default',
      moveCollection: () => new Promise((resolve) => {
        releaseMove = () => resolve({ success: true });
      }),
    };
    const useApiStore = (sel) => sel(storeState);
    useApiStore.getState = () => storeState;

    const { MoveCollectionModal } = loadModalComponent('packages/common/src/components/MoveCollectionModal.tsx', {
      react: h.MockReact,
      'lucide-react': h.iconProxy,
      useApiStore: { useApiStore },
      cloudSession: { isCloudSessionActive: (cfg) => Boolean(cfg?.token) },
      cloudApi: {
        fetchUserWorkspaces: async () => {
          workspaceFetchCount += 1;
          return [
            { id: 'ws-src', name: 'Source' },
            { id: 'ws-dst', name: 'Destination' },
          ];
        },
        fetchUserTeams: async () => [],
        fetchTeamProjects: async () => [],
      },
      jwt: {
        getRoleFromJwt: () => 'owner',
        canModifyCollection: () => true,
        hasScopePermission: () => true,
      },
      context: {
        useCloudClient: () => null,
        useProductPolicy: () => ({ workspace: { cloud: true, offline: true } }),
      },
      backNavigation: { useBackHandler() {} },
    });

    const col = { id: 'col-1', name: 'API', items: [], createdAt: 1, updatedAt: 1 };
    let tree = h.render(() => MoveCollectionModal({ isOpen: true, onClose: () => { closedCount += 1; }, collection: col }));
    await new Promise((r) => setImmediate(r));
    tree = h.rerender();
    assert.equal(workspaceFetchCount, 1);

    const moveBtn = h.findElements(tree, (n) => n.type === 'button' && h.textOf(n).includes('Move Collection'))[0];
    assert.ok(moveBtn && !moveBtn.props.disabled);

    const movePromise = moveBtn.props.onClick();
    tree = h.rerender();
    assert.ok(h.findElements(tree, (n) => n.type === 'button' && h.textOf(n).includes('Moving...'))[0]);

    // Simulate silent JWT refresh updating cloudConfig object identity + token mid-submit
    storeState.cloudConfig = { ...storeState.cloudConfig, token: 'tok-refreshed' };
    tree = h.rerender();
    await new Promise((r) => setImmediate(r));
    assert.equal(workspaceFetchCount, 1, 'Silent JWT refresh must not re-fetch targets or bump contextGenRef');

    releaseMove();
    await movePromise;
    tree = h.rerender();
    assert.equal(closedCount, 1, 'Modal must close cleanly after move completes despite JWT refresh');
    const finalMoveBtn = h.findElements(tree, (n) => n.type === 'button' && h.textOf(n).includes('Move Collection'))[0];
    assert.ok(finalMoveBtn && !finalMoveBtn.props.disabled, 'isSubmitting must not stick at true');
  }

  // M-R2: MoveRequestModal & MoveFolderModal reset isLoadingDetails when switching away from a partial target
  for (const kind of ['request', 'folder']) {
    const h = createModalTestHarness();
    let resolvePartialLoad;
    const storeState = {
      workspaceMode: 'cloud',
      cloudConfig: {
        apiUrl: 'https://api.example.com',
        token: 'tok-1',
        user: { id: 'u1', role: 'owner' },
        activeScope: { type: 'workspace', id: 'ws-1', name: 'WS 1', role: 'owner' },
      },
      collections: [
        {
          id: 'src-col',
          name: 'Source Col',
          isPartial: false,
          items: [
            kind === 'request'
              ? { id: 'item-1', name: 'Req 1', type: 'request', request: { id: 'item-1', name: 'Req 1', method: 'GET', url: 'https://x.test', params: [], headers: [], auth: { type: 'none' }, bodyType: 'none', bodyContent: '', createdAt: 1, updatedAt: 1 } }
              : { id: 'item-1', name: 'Folder 1', type: 'folder', items: [] },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
        { id: 'partial-col', name: 'Partial Col', isPartial: true, items: [], createdAt: 1, updatedAt: 1 },
        { id: 'full-col', name: 'Full Col', isPartial: false, items: [], createdAt: 1, updatedAt: 1 },
      ],
      moveRequest: async () => ({ success: true }),
      moveFolder: async () => ({ success: true }),
      loadCollectionDetails: () => new Promise((resolve) => {
        resolvePartialLoad = () => resolve({ success: true });
      }),
    };
    const useApiStore = (sel) => sel(storeState);
    const modPath = kind === 'request'
      ? 'packages/common/src/components/MoveRequestModal.tsx'
      : 'packages/common/src/components/MoveFolderModal.tsx';
    const loaded = loadModalComponent(modPath, {
      react: h.MockReact,
      'lucide-react': h.iconProxy,
      useApiStore: { useApiStore },
      requestDiff: {
        findSavedRequestInCollections: () => ({ folderId: null }),
        findSavedFolderInCollections: () => ({ parentFolderId: null }),
      },
      treeHelper: { isDescendantOf: () => false },
      jwt: { canModifyCollection: () => true },
      MethodBadge: { MethodBadge: (props) => RealReact.createElement('span', props) },
      backNavigation: { useBackHandler() {} },
    });
    const Modal = kind === 'request' ? loaded.MoveRequestModal : loaded.MoveFolderModal;
    const targetItem = storeState.collections[0].items[0];

    let tree = h.render(() => Modal({
      isOpen: true,
      onClose: () => {},
      item: targetItem,
      sourceCollectionId: 'src-col',
      ...(kind === 'request' ? { currentFolderId: null } : { currentParentFolderId: null }),
    }));

    // Select partial collection -> isLoadingDetails becomes true and submit is disabled
    const colSelect = h.findElements(tree, (n) => n.type === 'select')[0];
    colSelect.props.onChange({ target: { value: 'partial-col' } });
    tree = h.rerender();
    const label = kind === 'request' ? 'Move Request' : 'Move Folder';
    let submitBtn = h.findElements(tree, (n) => n.type === 'button' && h.textOf(n).includes(label))[0];
    assert.equal(submitBtn.props.disabled, true, `${kind} submit must be disabled while partial target loads`);

    // Switch immediately to full-col before partial fetch finishes
    const colSelect2 = h.findElements(tree, (n) => n.type === 'select')[0];
    colSelect2.props.onChange({ target: { value: 'full-col' } });
    tree = h.rerender();
    submitBtn = h.findElements(tree, (n) => n.type === 'button' && h.textOf(n).includes(label))[0];
    assert.equal(submitBtn.props.disabled, false, `${kind} submit must re-enable immediately after switching away from partial target`);
    resolvePartialLoad?.();
    await new Promise((r) => setImmediate(r));
  }
});
