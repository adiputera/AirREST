import { Collection, CollectionItem, Environment, EnvironmentVariable, ApiRequest } from '../types/api';


/**
 * Builds a single frontend Collection from a detailed backend collection object (with its items).
 */
export function buildCollectionFromDetails(bc: any): Collection {
  const colItems = (bc.items || []).filter((item: any) => !item.deleted_at);
  const nestedItems = buildItemTree(colItems, null);

  return {
    id: bc.id,
    name: bc.name,
    description: bc.description || '',
    items: nestedItems,
    version: typeof bc.version === 'number' ? bc.version : undefined,
    minRole: bc.min_role || 'reader',
    isPartial: false,
    createdAt: new Date(bc.created_at || Date.now()).getTime(),
    updatedAt: new Date(bc.updated_at || Date.now()).getTime(),
    _origin: 'cloud',
  };
}

export const MAX_TREE_DEPTH = 32;

export function buildItemTree(
  items: any[],
  parentId: string | null = null,
  depth: number = 0,
  visited: Set<string> = new Set(),
  groupedByParent?: Map<string | null, any[]>
): CollectionItem[] {
  if (depth > MAX_TREE_DEPTH || !Array.isArray(items)) {
    return [];
  }

  // Pre-group by parent_id on root invocation to reduce complexity from O(N^2) to O(N)
  let parentMap = groupedByParent;
  if (!parentMap) {
    parentMap = new Map<string | null, any[]>();
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const pid = item.parent_id || null;
      const list = parentMap.get(pid);
      if (list) {
        list.push(item);
      } else {
        parentMap.set(pid, [item]);
      }
    }
  }

  const matching = parentMap.get(parentId) || [];
  // Sort by sort_order
  const sorted = [...matching].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  return sorted.flatMap<CollectionItem>((item) => {
    if (!item.id || visited.has(item.id)) {
      // Detected cycle or missing ID; break recursion safely
      return [];
    }

    const nextVisited = new Set(visited);
    nextVisited.add(item.id);

    if (item.type === 'folder') {
      return [{
        id: item.id,
        name: item.name,
        type: 'folder' as const,
        items: buildItemTree(items, item.id, depth + 1, nextVisited, parentMap),
      }];
    }

    // Parse request
    const req: ApiRequest = {
      id: item.id,
      name: item.name,
      method: (item.method || 'GET').toUpperCase() as any,
      url: item.url || '',
      params: safeJsonArray(item.params, [{ id: 'p1', key: '', value: '', enabled: true }]),
      headers: safeJsonArray(item.headers, [{ id: 'h1', key: 'Accept', value: 'application/json', enabled: true }]),
      auth: safeJsonObject(item.auth, { type: 'none' }) as any,
      bodyType: item.body_type || 'none',
      rawType: item.raw_type || 'text',
      bodyContent: item.body_content || '',
      graphqlQuery: item.graphql_query || '',
      graphqlVariables: item.graphql_variables || '',
      bodyFormData: item.body_type === 'x-www-form-urlencoded' ? [] : safeJsonArray(item.body_form_data, []),
      bodyUrlEncoded: item.body_type === 'x-www-form-urlencoded' ? safeJsonArray(item.body_form_data, []) : [],
      preRequestScript: item.pre_request_script || '',
      postResponseScript: item.post_response_script || '',
      createdAt: new Date(item.created_at || Date.now()).getTime(),
      updatedAt: new Date(item.updated_at || Date.now()).getTime(),
    };

    return [{
      id: item.id,
      name: item.name,
      type: 'request' as const,
      request: req,
    }];
  });
}

/**
 * Transforms backend environment rows into frontend Environment models.
 */
export function buildEnvironmentsFromDelta(backendEnvs: any[]): Environment[] {
  return (backendEnvs || [])
    .filter((e) => !e.deleted_at)
    .map((e) => {
      const parsedVars = safeJsonArray(e.variables, []);
      const variables: EnvironmentVariable[] = (Array.isArray(parsedVars) ? parsedVars : []).map((v: any) => {
        const initialVal = String(v?.initialValue ?? v?.initial_value ?? v?.value ?? '');
        const currentVal = String(v?.currentValue ?? v?.current_value ?? v?.value ?? initialVal);
        return {
          id: String(v?.id || Math.random().toString(36).substring(2, 9)),
          key: String(v?.key ?? ''),
          value: initialVal,
          initialValue: initialVal,
          currentValue: currentVal,
          enabled: v?.enabled !== false,
        };
      });
      return {
        id: e.id,
        name: e.name,
        variables,
        minRole: e.min_role || 'reader',
        version: typeof e.version === 'number' ? e.version : 1,
        createdAt: new Date(e.created_at || Date.now()).getTime(),
        updatedAt: new Date(e.updated_at || Date.now()).getTime(),
      };
    });
}

export function safeJsonArray(val: any, fallback: any[]): any[] {
  if (val === null || val === undefined) return fallback;
  let parsed = val;
  if (typeof val === 'string') {
    try {
      parsed = JSON.parse(val);
    } catch {
      return fallback;
    }
  }
  if (!Array.isArray(parsed)) return fallback;
  return parsed
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({
      id: String(item.id || Math.random().toString(36).substring(2, 9)),
      key: String(item.key ?? ''),
      value: String(item.value ?? ''),
      enabled: item.enabled !== false,
      ...(item.description ? { description: String(item.description) } : {}),
      ...(item.type ? { type: item.type } : {}),
    }));
}

export function safeJsonObject(val: any, fallback: Record<string, any>): Record<string, any> {
  if (val === null || val === undefined) return fallback;
  let parsed = val;
  if (typeof val === 'string') {
    try {
      parsed = JSON.parse(val);
    } catch {
      return fallback;
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback;
  return parsed;
}

export function safeJsonParse(val: any, fallback: any): any {
  if (!val) return fallback;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}
