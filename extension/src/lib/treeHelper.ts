import { CollectionItem } from '@/types/api';
import { ReorderItemPayload } from './cloudApi';

/**
 * Checks whether targetId is the ancestor itself or any nested descendant of ancestorId.
 * Used to prevent circular dependency (e.g. moving a parent folder into its child).
 */
export function isDescendantOf(
  items: CollectionItem[],
  ancestorId: string,
  targetId: string
): boolean {
  if (ancestorId === targetId) return true;

  for (const it of items) {
    if (it.id === ancestorId) {
      const searchChildren = (children: CollectionItem[]): boolean => {
        for (const child of children) {
          if (child.id === targetId) return true;
          if (child.items && searchChildren(child.items)) return true;
        }
        return false;
      };
      return searchChildren(it.items || []);
    }
    if (it.items && isDescendantOf(it.items, ancestorId, targetId)) {
      return true;
    }
  }

  return false;
}

/**
 * Recursively flattens all collection items into reorder payloads containing parent_id and sort_order.
 */
export function flattenReorderPositions(
  items: CollectionItem[],
  parentId: string | null = null
): ReorderItemPayload[] {
  const result: ReorderItemPayload[] = [];
  items.forEach((item, index) => {
    result.push({
      id: item.id,
      parent_id: parentId,
      sort_order: index,
    });
    if (item.type === 'folder' && item.items && item.items.length > 0) {
      result.push(...flattenReorderPositions(item.items, item.id));
    }
  });
  return result;
}

/**
 * Reorders or reparents an item within a collection's item tree.
 * Returns the newly structured items and flat payload for cloud synchronization, or null if invalid.
 */
export function reorderItemInTree(
  items: CollectionItem[],
  activeId: string,
  targetId: string,
  position: 'before' | 'after' | 'inside'
): { updatedItems: CollectionItem[]; payload: ReorderItemPayload[] } | null {
  if (activeId === targetId) return null;

  // Prevent circular movement (folder into its own descendants)
  if (isDescendantOf(items, activeId, targetId)) {
    return null;
  }

  // Clone deeply
  const cloned: CollectionItem[] = JSON.parse(JSON.stringify(items));

  // Extract active item
  let activeItem: CollectionItem | null = null;

  const extractItem = (list: CollectionItem[]): CollectionItem[] => {
    const res: CollectionItem[] = [];
    for (const it of list) {
      if (it.id === activeId) {
        activeItem = it;
        continue;
      }
      if (it.type === 'folder' && it.items) {
        res.push({
          ...it,
          items: extractItem(it.items),
        });
      } else {
        res.push(it);
      }
    }
    return res;
  };

  const remaining = extractItem(cloned);
  if (!activeItem) return null;

  // Insert active item at target
  const insertItem = (list: CollectionItem[]): { list: CollectionItem[]; inserted: boolean } => {
    const targetIdx = list.findIndex((it) => it.id === targetId);

    if (targetIdx >= 0) {
      if (position === 'inside') {
        const target = list[targetIdx];
        if (target.type === 'folder') {
          const updatedTarget = {
            ...target,
            items: [...(target.items || []), activeItem!],
          };
          const newList = [...list];
          newList[targetIdx] = updatedTarget;
          return { list: newList, inserted: true };
        }
      } else if (position === 'before') {
        const newList = [...list];
        newList.splice(targetIdx, 0, activeItem!);
        return { list: newList, inserted: true };
      } else if (position === 'after') {
        const newList = [...list];
        newList.splice(targetIdx + 1, 0, activeItem!);
        return { list: newList, inserted: true };
      }
    }

    // Traverse subfolders
    let didInsert = false;
    const newList = list.map((it) => {
      if (didInsert || it.type !== 'folder' || !it.items) return it;
      const sub = insertItem(it.items);
      if (sub.inserted) {
        didInsert = true;
        return { ...it, items: sub.list };
      }
      return it;
    });

    return { list: newList, inserted: didInsert };
  };

  const { list: updatedItems, inserted } = insertItem(remaining);
  if (!inserted) return null;

  const payload = flattenReorderPositions(updatedItems, null);
  return { updatedItems, payload };
}
