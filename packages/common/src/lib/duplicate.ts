import {
  ApiRequest,
  AuthConfig,
  BinaryFileData,
  Collection,
  CollectionItem,
  FormDataItem,
  KeyValuePair,
} from '../types/api';

export const MAX_DUPLICATE_NAME_RUNES = 150;
export const MAX_DUPLICATE_ITEMS = 5000;
export const MAX_DUPLICATE_DEPTH = 32;
export const DUPLICATE_NAME_SUFFIX = ' copy';

export interface DuplicateDependencies {
  generateId?: () => string;
  now?: () => number;
}

export class DuplicateValidationError extends Error {
  readonly code:
    | 'INVALID_NAME'
    | 'NAME_TOO_LONG'
    | 'INVALID_TREE'
    | 'CYCLE_DETECTED'
    | 'DEPTH_LIMIT_EXCEEDED'
    | 'ITEM_LIMIT_EXCEEDED'
    | 'TARGET_FOLDER_NOT_FOUND';

  constructor(
    code: DuplicateValidationError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'DuplicateValidationError';
    this.code = code;
  }
}

export interface DuplicateAttachmentSummary {
  hasFormDataFiles: boolean;
  formDataFileCount: number;
  hasBinaryFile: boolean;
  binaryFileCount: number;
}

function defaultGenerateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Counts Unicode code points (runes) rather than UTF-16 code units or UTF-8 bytes.
 */
export function countUnicodeRunes(value: string): number {
  return [...value].length;
}

/**
 * Validates a collection or item name against empty values, lone surrogates, and the 150-rune limit.
 */
export function validateDuplicateName(name: string, label = 'Name'): string {
  const raw = String(name ?? '');
  if (hasLoneSurrogate(raw)) {
    throw new DuplicateValidationError('INVALID_NAME', `${label} contains invalid Unicode characters.`);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new DuplicateValidationError('INVALID_NAME', `${label} is required.`);
  }
  const runeCount = countUnicodeRunes(trimmed);
  if (runeCount > MAX_DUPLICATE_NAME_RUNES) {
    throw new DuplicateValidationError(
      'NAME_TOO_LONG',
      `${label} exceeds the maximum length of ${MAX_DUPLICATE_NAME_RUNES} characters (${runeCount}/${MAX_DUPLICATE_NAME_RUNES}).`,
    );
  }
  return trimmed;
}

/**
 * Resolves the duplicated root name using container identity (same container appends literal " copy").
 */
export function resolveDuplicateName(
  sourceName: string,
  sameContainer: boolean,
  label = 'Name',
): string {
  const rawBase = String(sourceName ?? '');
  if (hasLoneSurrogate(rawBase)) {
    throw new DuplicateValidationError('INVALID_NAME', `${label} contains invalid Unicode characters.`);
  }
  const trimmedBase = rawBase.trim();
  if (!trimmedBase) {
    throw new DuplicateValidationError('INVALID_NAME', `${label} is required.`);
  }
  const candidate = sameContainer ? `${trimmedBase}${DUPLICATE_NAME_SUFFIX}` : trimmedBase;
  return validateDuplicateName(candidate, label);
}

/**
 * Computes the 1-based depth of a target folder inside a collection (0 for collection root),
 * or returns null if the folder ID does not exist as a folder.
 */
export function getTargetFolderDepth(
  items: CollectionItem[] | undefined,
  targetParentId: string | null | undefined,
): number | null {
  if (!targetParentId) return 0;
  const visited = new Set<string>();

  const walk = (list: CollectionItem[], depth: number): number | null => {
    if (depth > MAX_DUPLICATE_DEPTH + 1) return null;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      if (!item.id || visited.has(item.id)) continue;
      visited.add(item.id);
      if (item.type === 'folder') {
        if (item.id === targetParentId) return depth;
        if (Array.isArray(item.items)) {
          const found = walk(item.items, depth + 1);
          if (found !== null) return found;
        }
      }
    }
    return null;
  };

  return walk(items || [], 1);
}

/**
 * Validates item count, depth, cycles, and descendant names for a list of root items.
 * Returns { itemCount, maxDepth }.
 */
export function inspectDuplicateTree(
  items: CollectionItem[],
  options: { baseDepth?: number; validateNames?: boolean } = {},
): { itemCount: number; maxDepth: number } {
  const baseDepth = options.baseDepth ?? 0;
  const shouldValidateNames = options.validateNames ?? true;
  if (!Array.isArray(items)) {
    throw new DuplicateValidationError('INVALID_TREE', 'Collection items must be an array.');
  }

  let itemCount = 0;
  let maxDepth = 0;
  const seenObjectRefs = new Set<object>();
  const seenIds = new Set<string>();

  const walk = (list: CollectionItem[], depth: number): void => {
    if (list.length === 0) return;
    if (depth > MAX_DUPLICATE_DEPTH) {
      throw new DuplicateValidationError(
        'DEPTH_LIMIT_EXCEEDED',
        `Folder nesting exceeds the maximum depth of ${MAX_DUPLICATE_DEPTH} levels.`,
      );
    }

    for (const item of list) {
      if (!item || typeof item !== 'object') {
        throw new DuplicateValidationError('INVALID_TREE', 'Collection contains an invalid item entry.');
      }
      if (seenObjectRefs.has(item)) {
        throw new DuplicateValidationError('CYCLE_DETECTED', 'Circular item reference detected.');
      }
      seenObjectRefs.add(item);

      if (!item.id || typeof item.id !== 'string') {
        throw new DuplicateValidationError('INVALID_TREE', 'Collection item is missing an ID.');
      }
      if (seenIds.has(item.id)) {
        throw new DuplicateValidationError('CYCLE_DETECTED', `Duplicate or circular item ID detected: ${item.id}`);
      }
      seenIds.add(item.id);

      if (item.type !== 'folder' && item.type !== 'request') {
        throw new DuplicateValidationError('INVALID_TREE', `Unsupported item type: ${String((item as any).type)}`);
      }

      if (shouldValidateNames) {
        validateDuplicateName(item.name, item.type === 'folder' ? 'Folder name' : 'Request name');
      }

      itemCount += 1;
      if (itemCount > MAX_DUPLICATE_ITEMS) {
        throw new DuplicateValidationError(
          'ITEM_LIMIT_EXCEEDED',
          `Duplicate exceeds the maximum limit of ${MAX_DUPLICATE_ITEMS} items.`,
        );
      }

      if (depth > maxDepth) {
        maxDepth = depth;
      }

      if (item.type === 'folder') {
        if (item.items !== undefined && !Array.isArray(item.items)) {
          throw new DuplicateValidationError('INVALID_TREE', `Folder "${item.name}" has invalid child items.`);
        }
        if (item.items && item.items.length > 0) {
          walk(item.items, depth + 1);
        }
      }
    }
  };

  walk(items, baseDepth + 1);
  return { itemCount, maxDepth };
}

/**
 * Summarizes live/metadata file attachments inside a collection tree (used for offline -> cloud warnings).
 */
export function inspectDuplicateAttachments(items: CollectionItem[] | undefined): DuplicateAttachmentSummary {
  let formDataFileCount = 0;
  let binaryFileCount = 0;
  const visited = new Set<string>();

  const walk = (list: CollectionItem[], depth: number): void => {
    if (depth > MAX_DUPLICATE_DEPTH + 1) return;
    for (const item of list) {
      if (!item || typeof item !== 'object' || visited.has(item.id)) continue;
      visited.add(item.id);
      if (item.type === 'request' && item.request) {
        const formData = item.request.bodyFormData;
        if (item.request.bodyType === 'form-data' && Array.isArray(formData)) {
          for (const field of formData) {
            if (field && field.type === 'file' && (field.file || field.fileName || field.value || field.needsReselection)) {
              formDataFileCount += 1;
            }
          }
        }
        if (item.request.bodyType === 'binary' && item.request.bodyBinaryFile) {
          binaryFileCount += 1;
        }
      }
      if (item.type === 'folder' && Array.isArray(item.items)) {
        walk(item.items, depth + 1);
      }
    }
  };

  walk(items || [], 1);
  return {
    hasFormDataFiles: formDataFileCount > 0,
    formDataFileCount,
    hasBinaryFile: binaryFileCount > 0,
    binaryFileCount,
  };
}

function cloneAuthConfig(auth?: AuthConfig): AuthConfig {
  if (!auth || typeof auth !== 'object') {
    return { type: 'none' };
  }
  return {
    type: auth.type || 'none',
    ...(auth.bearerToken !== undefined ? { bearerToken: auth.bearerToken } : {}),
    ...(auth.basicUsername !== undefined ? { basicUsername: auth.basicUsername } : {}),
    ...(auth.basicPassword !== undefined ? { basicPassword: auth.basicPassword } : {}),
    ...(auth.apiKeyKey !== undefined ? { apiKeyKey: auth.apiKeyKey } : {}),
    ...(auth.apiKeyValue !== undefined ? { apiKeyValue: auth.apiKeyValue } : {}),
    ...(auth.apiKeyIn !== undefined ? { apiKeyIn: auth.apiKeyIn } : {}),
  };
}

function cloneKeyValuePairs(
  pairs: KeyValuePair[] | undefined,
  generateId: () => string,
): KeyValuePair[] {
  if (!Array.isArray(pairs)) return [];
  return pairs.map((pair) => ({
    id: generateId(),
    key: String(pair?.key ?? ''),
    value: String(pair?.value ?? ''),
    enabled: pair?.enabled !== false,
    ...(pair?.description !== undefined ? { description: String(pair.description) } : {}),
  }));
}

function cloneFormDataItems(
  items: FormDataItem[] | undefined,
  generateId: () => string,
  sanitizeForCloud: boolean,
): FormDataItem[] | undefined {
  if (!Array.isArray(items)) return undefined;
  return items.map((field) => {
    const type: 'text' | 'file' = field?.type === 'file' ? 'file' : 'text';
    if (type === 'file') {
      const fileName = field.file?.name ?? field.fileName ?? (field.value || undefined);
      const fileSize = field.file?.size ?? field.fileSize;
      const fileType = field.file?.type ?? field.fileType;
      const hasFileRef = Boolean(field.file || fileName || field.needsReselection);

      if (sanitizeForCloud) {
        return {
          id: generateId(),
          key: String(field?.key ?? ''),
          type: 'file',
          value: String(fileName ?? field?.value ?? ''),
          ...(fileName !== undefined ? { fileName: String(fileName) } : {}),
          ...(typeof fileSize === 'number' && Number.isFinite(fileSize) ? { fileSize } : {}),
          ...(fileType !== undefined ? { fileType: String(fileType) } : {}),
          ...(hasFileRef ? { needsReselection: true } : {}),
          enabled: field?.enabled !== false,
        };
      }

      return {
        id: generateId(),
        key: String(field?.key ?? ''),
        type: 'file',
        value: String(field?.value ?? fileName ?? ''),
        ...(field.file ? { file: field.file } : {}),
        ...(fileName !== undefined ? { fileName: String(fileName) } : {}),
        ...(typeof fileSize === 'number' && Number.isFinite(fileSize) ? { fileSize } : {}),
        ...(fileType !== undefined ? { fileType: String(fileType) } : {}),
        ...(field.needsReselection ? { needsReselection: true } : {}),
        enabled: field?.enabled !== false,
      };
    }

    return {
      id: generateId(),
      key: String(field?.key ?? ''),
      type: 'text',
      value: String(field?.value ?? ''),
      enabled: field?.enabled !== false,
    };
  });
}

function cloneBinaryFileData(
  binary: BinaryFileData | undefined,
  sanitizeForCloud: boolean,
): BinaryFileData | undefined {
  if (!binary || sanitizeForCloud) return undefined;
  return {
    name: String(binary.name ?? ''),
    size: Number(binary.size ?? 0),
    type: String(binary.type ?? ''),
    ...(binary.file ? { file: binary.file } : {}),
    ...(binary.needsReselection ? { needsReselection: true } : {}),
  };
}

function cloneApiRequest(
  request: ApiRequest,
  newId: string,
  newName: string,
  timestamp: number,
  generateId: () => string,
  sanitizeForCloud: boolean,
): ApiRequest {
  const clonedBinary = cloneBinaryFileData(request.bodyBinaryFile, sanitizeForCloud);
  const clonedFormData = cloneFormDataItems(request.bodyFormData, generateId, sanitizeForCloud);
  const clonedUrlEncoded = Array.isArray(request.bodyUrlEncoded)
    ? cloneKeyValuePairs(request.bodyUrlEncoded, generateId)
    : undefined;

  return {
    id: newId,
    name: newName,
    method: request.method || 'GET',
    url: String(request.url ?? ''),
    params: cloneKeyValuePairs(request.params, generateId),
    pathVariables: cloneKeyValuePairs(request.pathVariables, generateId),
    headers: cloneKeyValuePairs(request.headers, generateId),
    auth: cloneAuthConfig(request.auth),
    bodyType: request.bodyType || 'none',
    ...(request.rawType !== undefined ? { rawType: request.rawType } : {}),
    bodyContent: String(request.bodyContent ?? ''),
    ...(request.graphqlQuery !== undefined ? { graphqlQuery: String(request.graphqlQuery) } : {}),
    ...(request.graphqlVariables !== undefined ? { graphqlVariables: String(request.graphqlVariables) } : {}),
    ...(clonedFormData !== undefined ? { bodyFormData: clonedFormData } : {}),
    ...(clonedBinary !== undefined ? { bodyBinaryFile: clonedBinary } : {}),
    ...(clonedUrlEncoded !== undefined ? { bodyUrlEncoded: clonedUrlEncoded } : {}),
    ...(request.preRequestScript !== undefined ? { preRequestScript: String(request.preRequestScript) } : {}),
    ...(request.postResponseScript !== undefined ? { postResponseScript: String(request.postResponseScript) } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function cloneItemNode(
  item: CollectionItem,
  nameOverride: string | null,
  timestamp: number,
  generateId: () => string,
  sanitizeForCloud: boolean,
): CollectionItem {
  const newItemId = generateId();
  const finalName = nameOverride !== null ? nameOverride : validateDuplicateName(item.name, item.type === 'folder' ? 'Folder name' : 'Request name');

  if (item.type === 'folder') {
    return {
      id: newItemId,
      name: finalName,
      type: 'folder',
      items: (item.items || []).map((child) =>
        cloneItemNode(child, null, timestamp, generateId, sanitizeForCloud),
      ),
    };
  }

  const sourceReq: ApiRequest = item.request || {
    id: item.id,
    name: item.name,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    auth: { type: 'none' },
    bodyType: 'none',
    bodyContent: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  return {
    id: newItemId,
    name: finalName,
    type: 'request',
    request: cloneApiRequest(sourceReq, newItemId, finalName, timestamp, generateId, sanitizeForCloud),
  };
}

export interface DuplicateCollectionOptions {
  sameContainer: boolean;
  targetOrigin?: 'offline' | 'cloud';
  sanitizeForCloud?: boolean;
  deps?: DuplicateDependencies;
}

/**
 * Snapshot-clones an entire collection with fresh IDs, clean sync metadata, and validated naming/limits.
 */
export function duplicateCollectionTree(
  source: Collection,
  options: DuplicateCollectionOptions,
): Collection {
  const generateId = options.deps?.generateId ?? defaultGenerateId;
  const now = options.deps?.now ?? Date.now;
  const sanitizeForCloud = Boolean(options.sanitizeForCloud);

  const newCollectionName = resolveDuplicateName(source.name, options.sameContainer, 'Collection name');
  inspectDuplicateTree(source.items || [], { baseDepth: 0, validateNames: true });

  const timestamp = now();
  const clonedItems = (source.items || []).map((item) =>
    cloneItemNode(item, null, timestamp, generateId, sanitizeForCloud),
  );

  return {
    id: generateId(),
    name: newCollectionName,
    ...(source.description !== undefined ? { description: source.description } : {}),
    items: clonedItems,
    ...(sanitizeForCloud
      ? { minRole: 'reader' as const }
      : source.minRole
      ? { minRole: source.minRole }
      : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    _origin: options.targetOrigin ?? (sanitizeForCloud ? 'cloud' : source._origin ?? 'offline'),
  };
}

export interface DuplicateItemOptions {
  sameCollection: boolean;
  targetParentDepth?: number;
  sanitizeForCloud?: boolean;
  deps?: DuplicateDependencies;
}

/**
 * Snapshot-clones a single folder subtree or saved request with fresh IDs and combined-depth validation.
 */
export function duplicateItemSubtree(
  sourceItem: CollectionItem,
  options: DuplicateItemOptions,
): CollectionItem {
  const generateId = options.deps?.generateId ?? defaultGenerateId;
  const now = options.deps?.now ?? Date.now;
  const sanitizeForCloud = Boolean(options.sanitizeForCloud);
  const targetParentDepth = options.targetParentDepth ?? 0;

  const rootLabel = sourceItem.type === 'folder' ? 'Folder name' : 'Request name';
  const newRootName = resolveDuplicateName(sourceItem.name, options.sameCollection, rootLabel);

  // Validate subtree items/depth (excluding root name which was just validated with suffix)
  const { maxDepth } = inspectDuplicateTree([sourceItem], {
    baseDepth: targetParentDepth,
    validateNames: false,
  });

  if (sourceItem.type === 'folder' && Array.isArray(sourceItem.items)) {
    // Validate all descendant names without modifying them
    inspectDuplicateTree(sourceItem.items, { baseDepth: targetParentDepth + 1, validateNames: true });
  }

  if (maxDepth > MAX_DUPLICATE_DEPTH) {
    throw new DuplicateValidationError(
      'DEPTH_LIMIT_EXCEEDED',
      `Folder nesting exceeds the maximum depth of ${MAX_DUPLICATE_DEPTH} levels.`,
    );
  }

  const timestamp = now();
  return cloneItemNode(sourceItem, newRootName, timestamp, generateId, sanitizeForCloud);
}

/**
 * Inserts an already-snapshotted duplicated item at the end of targetParentId (or root when null).
 * Returns null if targetParentId does not resolve to an existing folder.
 */
export function insertItemIntoCollectionTree(
  items: CollectionItem[],
  newItem: CollectionItem,
  targetParentId: string | null,
): CollectionItem[] | null {
  if (!targetParentId) {
    return [...items, newItem];
  }

  let inserted = false;
  const walk = (list: CollectionItem[]): CollectionItem[] =>
    list.map((it) => {
      if (it.type !== 'folder') return it;
      if (it.id === targetParentId) {
        inserted = true;
        return {
          ...it,
          items: [...(it.items || []), newItem],
        };
      }
      if (it.items && it.items.length > 0) {
        const nextChildren = walk(it.items);
        if (nextChildren !== it.items) {
          return { ...it, items: nextChildren };
        }
      }
      return it;
    });

  const next = walk(items);
  return inserted ? next : null;
}

/**
 * Formats a cloned collection into the deterministic payload expected by POST /api/v1/collections/import-duplicate.
 */
export function formatImportDuplicateCollectionPayload(col: Collection): {
  name: string;
  description: string;
  items: any[];
} {
  const formatItem = (item: CollectionItem, sortOrder: number): any => {
    if (item.type === 'folder') {
      return {
        type: 'folder',
        name: item.name,
        sort_order: sortOrder,
        items: (item.items || []).map((child, idx) => formatItem(child, idx)),
      };
    }

    const req = item.request;
    return {
      type: 'request',
      name: item.name,
      sort_order: sortOrder,
      method: req?.method || 'GET',
      url: req?.url || '',
      params: req?.params || [],
      path_variables: req?.pathVariables || [],
      headers: req?.headers || [],
      auth: req?.auth || { type: 'none' },
      body_type: req?.bodyType || 'none',
      raw_type: req?.rawType || 'text',
      body_content: req?.bodyContent || '',
      graphql_query: req?.graphqlQuery || '',
      graphql_variables: req?.graphqlVariables || '',
      body_form_data:
        req?.bodyType === 'x-www-form-urlencoded'
          ? req?.bodyUrlEncoded || []
          : req?.bodyFormData || [],
      pre_request_script: req?.preRequestScript || '',
      post_response_script: req?.postResponseScript || '',
      items: [],
    };
  };

  return {
    name: col.name,
    description: col.description || '',
    items: (col.items || []).map((item, idx) => formatItem(item, idx)),
  };
}
