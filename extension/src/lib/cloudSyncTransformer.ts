import { Collection, CollectionItem, Environment, ApiRequest } from '@/types/api';

/**
 * Transforms flat backend collection and item delta into nested frontend Collection structures.
 */
export function buildCollectionsFromDelta(backendCollections: any[], backendItems: any[]): Collection[] {
  // 1. Group active (non-tombstone) items by collection ID
  const activeItems = (backendItems || []).filter((item) => !item.deleted_at);
  const itemsByCollection = new Map<string, any[]>();

  for (const item of activeItems) {
    const colId = item.collection_id;
    if (!itemsByCollection.has(colId)) {
      itemsByCollection.set(colId, []);
    }
    itemsByCollection.get(colId)!.push(item);
  }

  // 2. Build collection trees
  const result: Collection[] = [];

  for (const bc of backendCollections || []) {
    if (bc.deleted_at) continue; // Skip tombstones

    const colItems = itemsByCollection.get(bc.id) || [];
    const nestedItems = buildItemTree(colItems, null);

    result.push({
      id: bc.id,
      name: bc.name,
      description: bc.description || '',
      items: nestedItems,
      createdAt: new Date(bc.created_at || Date.now()).getTime(),
      updatedAt: new Date(bc.updated_at || Date.now()).getTime(),
      _origin: 'cloud',
    });
  }

  return result;
}

function buildItemTree(items: any[], parentId: string | null): CollectionItem[] {
  const matching = items.filter((item) => {
    if (!parentId) {
      return !item.parent_id;
    }
    return item.parent_id === parentId;
  });

  // Sort by sort_order
  matching.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  return matching.map((item) => {
    if (item.type === 'folder') {
      return {
        id: item.id,
        name: item.name,
        type: 'folder',
        items: buildItemTree(items, item.id),
      };
    }

    // Parse request
    const req: ApiRequest = {
      id: item.id,
      name: item.name,
      method: (item.method || 'GET').toUpperCase() as any,
      url: item.url || '',
      params: safeJsonParse(item.params, [{ id: 'p1', key: '', value: '', enabled: true }]),
      headers: safeJsonParse(item.headers, [{ id: 'h1', key: 'Accept', value: 'application/json', enabled: true }]),
      auth: safeJsonParse(item.auth, { type: 'none' }),
      bodyType: item.body_type || 'none',
      rawType: item.raw_type || 'text',
      bodyContent: item.body_content || '',
      graphqlQuery: item.graphql_query || '',
      graphqlVariables: item.graphql_variables || '',
      bodyFormData: item.body_type === 'x-www-form-urlencoded' ? [] : safeJsonParse(item.body_form_data, []),
      bodyUrlEncoded: item.body_type === 'x-www-form-urlencoded' ? safeJsonParse(item.body_form_data, []) : [],
      preRequestScript: item.pre_request_script || '',
      postResponseScript: item.post_response_script || '',
      createdAt: new Date(item.created_at || Date.now()).getTime(),
      updatedAt: new Date(item.updated_at || Date.now()).getTime(),
    };

    return {
      id: item.id,
      name: item.name,
      type: 'request',
      request: req,
    };
  });
}

/**
 * Transforms backend environment rows into frontend Environment models.
 */
export function buildEnvironmentsFromDelta(backendEnvs: any[]): Environment[] {
  return (backendEnvs || [])
    .filter((e) => !e.deleted_at)
    .map((e) => {
      const parsedVars = safeJsonParse(e.variables, []);
      return {
        id: e.id,
        name: e.name,
        variables: Array.isArray(parsedVars) ? parsedVars : [],
        minRole: e.min_role || 'reader',
        createdAt: new Date(e.created_at || Date.now()).getTime(),
        updatedAt: new Date(e.updated_at || Date.now()).getTime(),
      };
    });
}

function safeJsonParse(val: any, fallback: any): any {
  if (!val) return fallback;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}
