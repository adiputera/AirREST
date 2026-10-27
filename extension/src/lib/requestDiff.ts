import {
  ApiRequest,
  Collection,
  CollectionItem,
  KeyValuePair,
  FormDataItem,
  AuthConfig,
  Environment,
  EnvironmentVariable,
} from '@/types/api';

/**
 * Normalizes a list of key-value pairs by ignoring rows that have both empty key and empty value.
 */
function normalizeKeyValue(list?: KeyValuePair[]): Array<{ key: string; value: string; enabled: boolean }> {
  if (!list || !Array.isArray(list)) return [];
  return list
    .filter((item) => {
      if (!item) return false;
      const k = String(item.key ?? '').trim();
      const v = String(item.value ?? '').trim();
      return k !== '' || v !== '';
    })
    .map((item) => ({
      key: String(item?.key ?? '').trim(),
      value: String(item?.value ?? '').trim(),
      enabled: Boolean(item?.enabled),
    }));
}

/**
 * Normalizes form-data rows by ignoring empty rows.
 */
function normalizeFormData(list?: FormDataItem[]): Array<{ key: string; value: string; type: string; enabled: boolean }> {
  if (!list || !Array.isArray(list)) return [];
  return list
    .filter((item) => {
      if (!item) return false;
      const k = String(item.key ?? '').trim();
      const v = String(item.value ?? '').trim();
      return k !== '' || v !== '';
    })
    .map((item) => ({
      key: String(item?.key ?? '').trim(),
      value: String(item?.value ?? '').trim(),
      type: item?.type || 'text',
      enabled: Boolean(item?.enabled),
    }));
}

/**
 * Normalizes authentication config.
 */
function normalizeAuth(auth?: AuthConfig) {
  if (!auth || auth.type === 'none') {
    return { type: 'none' };
  }
  if (auth.type === 'bearer') {
    return { type: 'bearer', bearerToken: String(auth.bearerToken ?? '').trim() };
  }
  if (auth.type === 'basic') {
    return {
      type: 'basic',
      basicUsername: String(auth.basicUsername ?? '').trim(),
      basicPassword: String(auth.basicPassword ?? '').trim(),
    };
  }
  if (auth.type === 'apikey') {
    return {
      type: 'apikey',
      key: String(auth.apiKeyKey ?? '').trim(),
      value: String(auth.apiKeyValue ?? '').trim(),
      in: auth.apiKeyIn || 'header',
    };
  }
  return { type: 'none' };
}

/**
 * Produces a stable, comparable object representing the meaningful content of an ApiRequest.
 */
export function normalizeRequestForDiff(req: ApiRequest) {
  return {
    name: String(req?.name ?? '').trim(),
    method: req?.method || 'GET',
    url: String(req?.url ?? '').trim(),
    params: normalizeKeyValue(req?.params),
    headers: normalizeKeyValue(req?.headers),
    auth: normalizeAuth(req?.auth),
    bodyType: req?.bodyType || 'none',
    rawType: req?.rawType || 'text',
    bodyContent: String(req?.bodyContent ?? '').trim(),
    graphqlQuery: String(req?.graphqlQuery ?? '').trim(),
    graphqlVariables: String(req?.graphqlVariables ?? '').trim(),
    bodyFormData: normalizeFormData(req?.bodyFormData),
    bodyUrlEncoded: normalizeKeyValue(req?.bodyUrlEncoded),
    binaryFile: req?.bodyBinaryFile
      ? { name: req.bodyBinaryFile.name, size: req.bodyBinaryFile.size }
      : null,
    preRequestScript: String(req?.preRequestScript ?? '').trim(),
    postResponseScript: String(req?.postResponseScript ?? '').trim(),
  };
}

/**
 * Checks if a request represents a pristine/empty tab (e.g. newly created via `+` button).
 */
export function isBlankRequest(req?: ApiRequest | null): boolean {
  if (!req) return true;
  const norm = normalizeRequestForDiff(req);
  const isDefaultName =
    norm.name === '' ||
    norm.name.toLowerCase() === 'untitled request' ||
    norm.name.toLowerCase() === 'new request';

  return (
    isDefaultName &&
    norm.method === 'GET' &&
    norm.url === '' &&
    norm.bodyContent === '' &&
    norm.graphqlQuery === '' &&
    norm.graphqlVariables === '' &&
    norm.params.length === 0 &&
    norm.headers.length === 0 &&
    norm.bodyFormData.length === 0 &&
    norm.bodyUrlEncoded.length === 0 &&
    norm.binaryFile === null &&
    norm.preRequestScript === '' &&
    norm.postResponseScript === '' &&
    norm.auth.type === 'none' &&
    (norm.bodyType === 'none' || norm.bodyType === 'raw' || norm.bodyType === 'json')
  );
}

/**
 * Finds a saved request in collections that matches the given request ID.
 */
export function findSavedRequestInCollections(
  collections: Collection[],
  requestId: string
): { collection: Collection; folderId: string | null; savedRequest: ApiRequest } | null {
  if (!requestId || !Array.isArray(collections)) return null;

  for (const col of collections) {
    const searchItems = (
      items: CollectionItem[] = [],
      folderId: string | null
    ): { collection: Collection; folderId: string | null; savedRequest: ApiRequest } | null => {
      for (const item of items || []) {
        if (!item) continue;
        if (item.type === 'request' && item.request) {
          if (item.id === requestId || item.request.id === requestId) {
            return { collection: col, folderId, savedRequest: item.request };
          }
        }
        if (item.type === 'folder' && item.items) {
          const found = searchItems(item.items, item.id);
          if (found) return found;
        }
      }
      return null;
    };

    const result = searchItems(col?.items || [], null);
    if (result) return result;
  }

  return null;
}

/**
 * Determines whether a tab has unsaved changes.
 * 1. If it belongs to a saved collection item, compares with that saved item.
 * 2. If it is not in any collection, checks whether it has non-empty content compared to a blank request.
 */
export function isRequestModified(tab?: ApiRequest | null, collections: Collection[] = []): boolean {
  if (!tab || !tab.id) return false;

  const saved = findSavedRequestInCollections(collections || [], tab.id);

  if (saved) {
    const normTab = JSON.stringify(normalizeRequestForDiff(tab));
    const normSaved = JSON.stringify(normalizeRequestForDiff(saved.savedRequest));
    return normTab !== normSaved;
  }

  // Not in any collection: dirty if user has entered any data
  return !isBlankRequest(tab);
}

function makeUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface FlattenedCollectionRequest {
  id: string;
  name: string;
  path: string;
  method: string;
  url: string;
  request: ApiRequest;
}

export function flattenCollectionRequests(
  items: CollectionItem[],
  prefix = ''
): FlattenedCollectionRequest[] {
  const list: FlattenedCollectionRequest[] = [];
  if (!Array.isArray(items)) return list;

  for (const item of items) {
    const currentPath = prefix ? `${prefix} / ${item.name}` : item.name;
    if (item.type === 'folder' && item.items) {
      list.push(...flattenCollectionRequests(item.items, currentPath));
    } else if (item.type === 'request' && item.request) {
      list.push({
        id: item.id || item.request.id,
        name: item.name || item.request.name || 'Untitled Request',
        path: currentPath,
        method: (item.request.method || 'GET').toUpperCase(),
        url: item.request.url || '',
        request: item.request,
      });
    }
  }

  return list;
}

export interface CollectionRequestDiff {
  name: string;
  method: string;
  url: string;
  path: string;
  status: 'added' | 'removed' | 'modified';
}

export interface CollectionDiffSummary {
  existingName: string;
  incomingName: string;
  hasDifferences: boolean;
  totalExisting: number;
  totalIncoming: number;
  added: CollectionRequestDiff[];
  modified: CollectionRequestDiff[];
  removed: CollectionRequestDiff[];
  unchangedCount: number;
}

export function compareCollections(
  existingCol: Collection,
  incomingCol: Collection
): CollectionDiffSummary {
  const existingReqs = flattenCollectionRequests(existingCol.items || []);
  const incomingReqs = flattenCollectionRequests(incomingCol.items || []);

  const added: CollectionRequestDiff[] = [];
  const modified: CollectionRequestDiff[] = [];
  const removed: CollectionRequestDiff[] = [];
  let unchangedCount = 0;

  const matchedIncomingIndices = new Set<number>();

  for (const ex of existingReqs) {
    let matchIdx = incomingReqs.findIndex(
      (inc, idx) => !matchedIncomingIndices.has(idx) && inc.id && ex.id && inc.id === ex.id
    );

    if (matchIdx === -1) {
      matchIdx = incomingReqs.findIndex(
        (inc, idx) => !matchedIncomingIndices.has(idx) && inc.path.toLowerCase() === ex.path.toLowerCase()
      );
    }

    if (matchIdx === -1) {
      matchIdx = incomingReqs.findIndex(
        (inc, idx) =>
          !matchedIncomingIndices.has(idx) &&
          inc.method.toLowerCase() === ex.method.toLowerCase() &&
          inc.name.toLowerCase() === ex.name.toLowerCase()
      );
    }

    if (matchIdx >= 0) {
      matchedIncomingIndices.add(matchIdx);
      const inc = incomingReqs[matchIdx];

      const normEx = JSON.stringify(normalizeRequestForDiff(ex.request));
      const normInc = JSON.stringify(normalizeRequestForDiff(inc.request));

      if (normEx !== normInc) {
        modified.push({
          name: inc.name,
          method: inc.method,
          url: inc.url,
          path: inc.path,
          status: 'modified',
        });
      } else {
        unchangedCount++;
      }
    } else {
      removed.push({
        name: ex.name,
        method: ex.method,
        url: ex.url,
        path: ex.path,
        status: 'removed',
      });
    }
  }

  for (let i = 0; i < incomingReqs.length; i++) {
    if (!matchedIncomingIndices.has(i)) {
      const inc = incomingReqs[i];
      added.push({
        name: inc.name,
        method: inc.method,
        url: inc.url,
        path: inc.path,
        status: 'added',
      });
    }
  }

  const hasDifferences = added.length > 0 || modified.length > 0 || removed.length > 0;

  return {
    existingName: existingCol.name,
    incomingName: incomingCol.name,
    hasDifferences,
    totalExisting: existingReqs.length,
    totalIncoming: incomingReqs.length,
    added,
    modified,
    removed,
    unchangedCount,
  };
}

export function generateCopyCollectionName(baseName: string, existingNames: string[]): string {
  const lowerNames = (existingNames || []).map((n) => String(n ?? '').toLowerCase().trim());
  let candidate = `${baseName} (Copy)`;
  let counter = 2;

  while (lowerNames.includes(candidate.toLowerCase().trim())) {
    candidate = `${baseName} (Copy ${counter})`;
    counter++;
  }

  return candidate;
}

export function cloneCollectionWithNewIds(col: Collection, newName: string): Collection {
  const cloneRequest = (request: ApiRequest): ApiRequest => ({
    ...request,
    params: (request.params || []).map((pair) => ({ ...pair })),
    headers: (request.headers || []).map((pair) => ({ ...pair })),
    bodyFormData: request.bodyFormData?.map((field) => ({ ...field })),
    bodyUrlEncoded: request.bodyUrlEncoded?.map((pair) => ({ ...pair })),
    bodyBinaryFile: request.bodyBinaryFile ? { ...request.bodyBinaryFile } : undefined,
  });
  const cloneItems = (items: CollectionItem[]): CollectionItem[] => {
    return items.map((item) => {
      const newItemId = makeUUID();

      if (item.type === 'folder') {
        return {
          ...item,
          id: newItemId,
          items: cloneItems(item.items || []),
        };
      }

      const reqClone: ApiRequest | undefined = item.request
        ? {
            ...cloneRequest(item.request),
            id: newItemId,
          }
        : undefined;

      return {
        ...item,
        id: newItemId,
        request: reqClone,
      };
    });
  };

  const newColId = makeUUID();

  return {
    ...col,
    id: newColId,
    name: newName,
    items: cloneItems(col.items || []),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function alignCollectionItemIds(
  existingItems: CollectionItem[],
  incomingItems: CollectionItem[]
): CollectionItem[] {
  const existingFlat = flattenCollectionRequests(existingItems);

  const alignList = (items: CollectionItem[], prefix = ''): CollectionItem[] => {
    return items.map((item) => {
      const currentPath = prefix ? `${prefix} / ${item.name}` : item.name;
      if (item.type === 'folder') {
        return {
          ...item,
          id: item.id || makeUUID(),
          items: alignList(item.items || [], currentPath),
        };
      }

      const match = existingFlat.find(
        (ex) => (ex.id && item.id && ex.id === item.id) || ex.path.toLowerCase() === currentPath.toLowerCase()
      );

      const isValidUUID = item.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id);
      const resolvedId = match ? match.id : (isValidUUID ? item.id : makeUUID());

      const updatedReq = item.request
        ? { ...item.request, id: resolvedId }
        : undefined;

      return {
        ...item,
        id: resolvedId,
        request: updatedReq,
      };
    });
  };

  return alignList(incomingItems);
}

export interface EnvironmentVariableDiff {
  key: string;
  oldValue?: string;
  newValue?: string;
  oldEnabled?: boolean;
  newEnabled?: boolean;
  status: 'added' | 'removed' | 'modified';
}

export interface EnvironmentDiffSummary {
  existingName: string;
  incomingName: string;
  hasDifferences: boolean;
  totalExisting: number;
  totalIncoming: number;
  added: EnvironmentVariableDiff[];
  modified: EnvironmentVariableDiff[];
  removed: EnvironmentVariableDiff[];
  unchangedCount: number;
}

/**
 * Compares two environments variable-by-variable and produces a summary of additions, modifications, and removals.
 */
export function compareEnvironments(
  existingEnv: Environment,
  incomingEnv: Environment
): EnvironmentDiffSummary {
  const existingVars = (existingEnv.variables || [])
    .filter((v) => v && String(v.key ?? '').trim() !== '')
    .map((v) => ({
      id: v.id,
      key: String(v.key ?? '').trim(),
      value: String(v.initialValue ?? v.value ?? ''),
      enabled: v.enabled !== false,
    }));

  const incomingVars = (incomingEnv.variables || [])
    .filter((v) => v && String(v.key ?? '').trim() !== '')
    .map((v) => ({
      id: v.id,
      key: String(v.key ?? '').trim(),
      value: String(v.initialValue ?? v.value ?? ''),
      enabled: v.enabled !== false,
    }));

  const added: EnvironmentVariableDiff[] = [];
  const modified: EnvironmentVariableDiff[] = [];
  const removed: EnvironmentVariableDiff[] = [];
  let unchangedCount = 0;

  const matchedIncomingIndices = new Set<number>();

  for (const ex of existingVars) {
    let matchIdx = incomingVars.findIndex(
      (inc, idx) => !matchedIncomingIndices.has(idx) && inc.key === ex.key
    );

    if (matchIdx === -1) {
      matchIdx = incomingVars.findIndex(
        (inc, idx) =>
          !matchedIncomingIndices.has(idx) &&
          inc.key.toLowerCase() === ex.key.toLowerCase()
      );
    }

    if (matchIdx >= 0) {
      matchedIncomingIndices.add(matchIdx);
      const inc = incomingVars[matchIdx];

      if (inc.value !== ex.value || inc.enabled !== ex.enabled) {
        modified.push({
          key: inc.key,
          oldValue: ex.value,
          newValue: inc.value,
          oldEnabled: ex.enabled,
          newEnabled: inc.enabled,
          status: 'modified',
        });
      } else {
        unchangedCount++;
      }
    } else {
      removed.push({
        key: ex.key,
        oldValue: ex.value,
        oldEnabled: ex.enabled,
        status: 'removed',
      });
    }
  }

  for (let i = 0; i < incomingVars.length; i++) {
    if (!matchedIncomingIndices.has(i)) {
      const inc = incomingVars[i];
      added.push({
        key: inc.key,
        newValue: inc.value,
        newEnabled: inc.enabled,
        status: 'added',
      });
    }
  }

  const hasDifferences = added.length > 0 || modified.length > 0 || removed.length > 0;

  return {
    existingName: existingEnv.name,
    incomingName: incomingEnv.name,
    hasDifferences,
    totalExisting: existingVars.length,
    totalIncoming: incomingVars.length,
    added,
    modified,
    removed,
    unchangedCount,
  };
}

/**
 * Generates an unused copy name for duplicate environments (e.g., "Dev (Copy)", "Dev (Copy 2)").
 */
export function generateCopyEnvironmentName(baseName: string, existingNames: string[]): string {
  const lowerNames = (existingNames || []).map((n) => String(n ?? '').toLowerCase().trim());
  let candidate = `${baseName} (Copy)`;
  let counter = 2;

  while (lowerNames.includes(candidate.toLowerCase().trim())) {
    candidate = `${baseName} (Copy ${counter})`;
    counter++;
  }

  return candidate;
}

/**
 * Clones an environment with brand new UUIDs and a new name.
 */
export function cloneEnvironmentWithNewIds(env: Environment, newName: string): Environment {
  return {
    ...JSON.parse(JSON.stringify(env)),
    id: makeUUID(),
    name: newName,
    variables: (env.variables || []).map((v) => {
      const initialVal = String(v.initialValue ?? v.value ?? '');
      const currentVal = String(v.currentValue ?? v.value ?? initialVal);
      return {
        ...v,
        id: makeUUID(),
        value: initialVal,
        initialValue: initialVal,
        currentValue: currentVal,
      };
    }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Aligns incoming variable IDs with existing variable IDs when matching keys exist.
 */
export function alignEnvironmentVariableIds(
  existingVars: EnvironmentVariable[],
  incomingVars: EnvironmentVariable[]
): EnvironmentVariable[] {
  const existingMap = new Map<string, string>();
  for (const ex of existingVars) {
    if (ex.key) {
      existingMap.set(ex.key.trim().toLowerCase(), ex.id);
    }
  }

  return incomingVars.map((inc) => {
    const matchedId = existingMap.get(String(inc.key ?? '').trim().toLowerCase());
    const isValidUUID =
      inc.id &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(inc.id);

    const initialVal = String(inc.initialValue ?? inc.value ?? '');
    const currentVal = String(inc.currentValue ?? inc.value ?? initialVal);

    return {
      ...inc,
      id: matchedId || (isValidUUID ? inc.id : makeUUID()),
      initialValue: initialVal,
      currentValue: currentVal,
      value: initialVal,
    };
  });
}
