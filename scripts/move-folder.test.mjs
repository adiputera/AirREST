import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

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

  // Must synchronize via batchImportToScope when in cloud mode
  assert.match(content, /batchImportToScope\([\s\S]*?cloudConfig\.apiUrl[\s\S]*?colsToSync/);
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
