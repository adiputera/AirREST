import {
  ApiRequest,
  Collection,
  CollectionItem,
  KeyValuePair,
  FormDataItem,
  AuthConfig,
} from '@/types/api';

/**
 * Normalizes a list of key-value pairs by ignoring rows that have both empty key and empty value.
 */
function normalizeKeyValue(list?: KeyValuePair[]): Array<{ key: string; value: string; enabled: boolean }> {
  if (!list || !Array.isArray(list)) return [];
  return list
    .filter((item) => (item.key && item.key.trim() !== '') || (item.value && item.value.trim() !== ''))
    .map((item) => ({
      key: (item.key || '').trim(),
      value: (item.value || '').trim(),
      enabled: Boolean(item.enabled),
    }));
}

/**
 * Normalizes form-data rows by ignoring empty rows.
 */
function normalizeFormData(list?: FormDataItem[]): Array<{ key: string; value: string; type: string; enabled: boolean }> {
  if (!list || !Array.isArray(list)) return [];
  return list
    .filter((item) => (item.key && item.key.trim() !== '') || (item.value && item.value.trim() !== ''))
    .map((item) => ({
      key: (item.key || '').trim(),
      value: (item.value || '').trim(),
      type: item.type || 'text',
      enabled: Boolean(item.enabled),
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
    return { type: 'bearer', bearerToken: (auth.bearerToken || '').trim() };
  }
  if (auth.type === 'basic') {
    return {
      type: 'basic',
      basicUsername: (auth.basicUsername || '').trim(),
      basicPassword: (auth.basicPassword || '').trim(),
    };
  }
  if (auth.type === 'apikey') {
    return {
      type: 'apikey',
      key: (auth.apiKeyKey || '').trim(),
      value: (auth.apiKeyValue || '').trim(),
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
    name: (req.name || '').trim(),
    method: req.method || 'GET',
    url: (req.url || '').trim(),
    params: normalizeKeyValue(req.params),
    headers: normalizeKeyValue(req.headers),
    auth: normalizeAuth(req.auth),
    bodyType: req.bodyType || 'none',
    rawType: req.rawType || 'text',
    bodyContent: (req.bodyContent || '').trim(),
    graphqlQuery: (req.graphqlQuery || '').trim(),
    graphqlVariables: (req.graphqlVariables || '').trim(),
    bodyFormData: normalizeFormData(req.bodyFormData),
    bodyUrlEncoded: normalizeKeyValue(req.bodyUrlEncoded),
    binaryFile: req.bodyBinaryFile
      ? { name: req.bodyBinaryFile.name, size: req.bodyBinaryFile.size }
      : null,
    preRequestScript: (req.preRequestScript || '').trim(),
    postResponseScript: (req.postResponseScript || '').trim(),
  };
}

/**
 * Checks if a request represents a pristine/empty tab (e.g. newly created via `+` button).
 */
export function isBlankRequest(req: ApiRequest): boolean {
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
      items: CollectionItem[],
      folderId: string | null
    ): { collection: Collection; folderId: string | null; savedRequest: ApiRequest } | null => {
      for (const item of items) {
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

    const result = searchItems(col.items, null);
    if (result) return result;
  }

  return null;
}

/**
 * Determines whether a tab has unsaved changes.
 * 1. If it belongs to a saved collection item, compares with that saved item.
 * 2. If it is not in any collection, checks whether it has non-empty content compared to a blank request.
 */
export function isRequestModified(tab: ApiRequest, collections: Collection[]): boolean {
  const saved = findSavedRequestInCollections(collections, tab.id);

  if (saved) {
    const normTab = JSON.stringify(normalizeRequestForDiff(tab));
    const normSaved = JSON.stringify(normalizeRequestForDiff(saved.savedRequest));
    return normTab !== normSaved;
  }

  // Not in any collection: dirty if user has entered any data
  return !isBlankRequest(tab);
}
