import type {
  ApiRequest,
  CloudConfig,
  Collection,
  CollectionItem,
  Environment,
  EnvironmentVariable,
  HistoryItem,
  PendingDuplicateIntent,
  PendingExampleIntent,
} from '../types/api';
import type { NativeCredentialScope } from '../types/credentials';
import type { ImportTargetBinding } from '../lib/importBatch';
import {
  buildExampleSummariesFromExamples,
  cloneSavedExampleSummaries,
  cloneSavedExamplesList,
} from '../lib/examples';
import { parsePathVariablesFromUrl } from '../lib/urlParams';
import { buildEnvironmentsFromDelta } from '../lib/cloudSyncTransformer';
import { DEFAULT_OFFLINE_WORKSPACE_ID, type ApiStoreState } from './storeTypes';

export const FEATURE_POLICY_TTL_MS = 30 * 60 * 1000;
export const MAX_UNDO_HISTORY = 50;

export function matchesImportTarget(
  state: ApiStoreState,
  target: ImportTargetBinding,
  sessionGeneration: number,
): boolean {
  if (state.isSwitchingWorkspace) return false;
  const liveMode = state.workspaceMode === 'cloud' ? 'cloud' : 'offline';
  if (liveMode !== target.workspaceMode) return false;
  if (sessionGeneration !== target.sessionGeneration) return false;
  if (target.workspaceMode === 'offline') {
    return (state.activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID) === target.offlineWorkspaceId;
  }
  if (!state.cloudConfig?.token) return false;
  return (
    state.cloudConfig?.activeScope?.type === target.scopeType &&
    state.cloudConfig?.activeScope?.id === target.scopeId &&
    state.cloudConfig?.user?.id === target.cloudUserId &&
    state.cloudConfig?.apiUrl === target.cloudApiUrl
  );
}

export function getNativeCredentialScope(config: Pick<CloudConfig, 'apiUrl' | 'user'>): NativeCredentialScope | null {
  const apiUrl = config.apiUrl?.trim();
  const userId = config.user?.id?.trim();
  return apiUrl && userId ? { apiUrl, userId } : null;
}

export function sameNativeCredentialScope(
  left: NativeCredentialScope | null | undefined,
  right: NativeCredentialScope | null | undefined,
): boolean {
  return Boolean(left && right && left.apiUrl === right.apiUrl && left.userId === right.userId);
}

export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export const defaultRequest: ApiRequest = {
  id: 'req-default-1',
  name: 'New Request',
  method: 'GET',
  url: '',
  params: [{ id: 'p1', key: '', value: '', enabled: true }],
  pathVariables: [],
  headers: [{ id: 'h1', key: 'Accept', value: 'application/json', enabled: true }],
  auth: { type: 'none' },
  bodyType: 'none',
  rawType: 'text',
  bodyContent: '',
  graphqlQuery: '',
  graphqlVariables: '',
  bodyFormData: [],
  bodyUrlEncoded: [{ id: 'u1', key: '', value: '', enabled: true }],
  preRequestScript: '',
  postResponseScript: '',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

export function createInitialTab(): ApiRequest {
  return {
    id: generateId(),
    name: 'New Request',
    method: 'GET',
    url: '',
    params: [{ id: generateId(), key: '', value: '', enabled: true }],
    pathVariables: [],
    headers: [{ id: generateId(), key: '', value: '', enabled: true }],
    auth: { type: 'none' },
    bodyType: 'none',
    rawType: 'text',
    bodyContent: '',
    graphqlQuery: '',
    graphqlVariables: '',
    bodyFormData: [],
    bodyBinaryFile: undefined,
    bodyUrlEncoded: [{ id: generateId(), key: '', value: '', enabled: true }],
    preRequestScript: '',
    postResponseScript: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function hasLiveFile(value: unknown): value is File {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

export function isRequestIdentical(a: ApiRequest, b: ApiRequest): boolean {
  if (a.name !== b.name || a.method !== b.method || a.url !== b.url) return false;
  if (a.bodyType !== b.bodyType || a.rawType !== b.rawType || a.bodyContent !== b.bodyContent) return false;
  if (a.graphqlQuery !== b.graphqlQuery || a.graphqlVariables !== b.graphqlVariables) return false;
  if (a.preRequestScript !== b.preRequestScript || a.postResponseScript !== b.postResponseScript) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function cloneRequestPreservingAttachments(request: ApiRequest): ApiRequest {
  const pathVariables = parsePathVariablesFromUrl(request.url, request.pathVariables);
  return {
    ...request,
    params: (request.params || []).map((item) => ({ ...item })),
    pathVariables: pathVariables.map((item) => ({ ...item })),
    headers: (request.headers || []).map((item) => ({ ...item })),
    bodyFormData: request.bodyFormData?.map((item) => ({ ...item })),
    bodyUrlEncoded: request.bodyUrlEncoded?.map((item) => ({ ...item })),
    bodyBinaryFile: request.bodyBinaryFile ? { ...request.bodyBinaryFile } : undefined,
  };
}

export function cloneCollectionPreservingAttachments(collection: Collection): Collection {
  const cloneItems = (items: CollectionItem[]): CollectionItem[] => items.map((item) => ({
    ...item,
    request: item.request ? cloneRequestPreservingAttachments(item.request) : undefined,
    examples: Array.isArray(item.examples) ? cloneSavedExamplesList(item.examples, false) : undefined,
    exampleSummaries: Array.isArray(item.exampleSummaries) ? cloneSavedExampleSummaries(item.exampleSummaries) : undefined,
    items: item.items ? cloneItems(item.items) : undefined,
  }));
  return { ...collection, items: cloneItems(collection.items || []) };
}

export function serializeRequestAttachments(request: ApiRequest): ApiRequest {
  const copy = cloneRequestPreservingAttachments(request);
  copy.bodyFormData = copy.bodyFormData?.map((item) => {
    if (item.type !== 'file') return item;
    const { file, ...metadata } = item;
    return {
      ...metadata,
      fileName: hasLiveFile(file) ? file.name : item.fileName || item.value || '',
      fileSize: hasLiveFile(file) ? file.size : item.fileSize || 0,
      fileType: hasLiveFile(file) ? file.type : item.fileType || '',
      needsReselection: true,
    };
  });
  if (copy.bodyBinaryFile) {
    const { file, ...metadata } = copy.bodyBinaryFile;
    copy.bodyBinaryFile = {
      ...metadata,
      name: hasLiveFile(file) ? file.name : metadata.name || 'unnamed file',
      size: hasLiveFile(file) ? file.size : metadata.size || 0,
      type: hasLiveFile(file) ? file.type : metadata.type || '',
      needsReselection: true,
    };
  }
  return copy;
}

export function normalizePersistedRequestAttachments(request: ApiRequest): ApiRequest {
  const copy = cloneRequestPreservingAttachments(request);
  copy.bodyFormData = copy.bodyFormData?.map((item) => {
    if (item.type !== 'file' || hasLiveFile(item.file)) return item;
    const { file: _invalidFile, ...metadata } = item;
    return {
      ...metadata,
      fileName: item.fileName || item.value || '',
      fileSize: item.fileSize || 0,
      fileType: item.fileType || '',
      needsReselection: true,
    };
  });
  if (copy.bodyBinaryFile && !hasLiveFile(copy.bodyBinaryFile.file)) {
    const { file: _invalidFile, ...metadata } = copy.bodyBinaryFile;
    copy.bodyBinaryFile = {
      ...metadata,
      name: metadata.name || 'unnamed file',
      size: metadata.size || 0,
      type: metadata.type || '',
      needsReselection: true,
    };
  }
  return copy;
}

export function serializeCollectionAttachments(collection: Collection): Collection {
  const serializeItems = (items: CollectionItem[]): CollectionItem[] => items.map((item) => ({
    ...item,
    request: item.request ? serializeRequestAttachments(item.request) : undefined,
    examples: Array.isArray(item.examples) ? cloneSavedExamplesList(item.examples, false) : undefined,
    exampleSummaries: Array.isArray(item.exampleSummaries) ? cloneSavedExampleSummaries(item.exampleSummaries) : undefined,
    items: item.items ? serializeItems(item.items) : undefined,
  }));
  return { ...collection, items: serializeItems(collection.items || []) };
}

export function normalizeCollectionAttachments(collection: Collection): Collection {
  const normalizeItems = (items: CollectionItem[]): CollectionItem[] => items.map((item) => {
    const resolvedId = item.request?.id || item.id;
    const isRequest = item.type === 'request';
    const hasExplicitLoadedFlag = typeof item.examplesLoaded === 'boolean';
    const clonedExamples = Array.isArray(item.examples) ? cloneSavedExamplesList(item.examples, false) : undefined;
    const clonedSummaries = Array.isArray(item.exampleSummaries)
      ? cloneSavedExampleSummaries(item.exampleSummaries)
      : clonedExamples
        ? buildExampleSummariesFromExamples(clonedExamples)
        : undefined;
    return {
      ...item,
      request: item.request ? {
        ...normalizePersistedRequestAttachments(item.request),
        id: resolvedId,
        name: item.name || item.request.name || 'Untitled Request',
      } : undefined,
      ...(isRequest
        ? {
          examples: clonedExamples ?? (hasExplicitLoadedFlag && !item.examplesLoaded ? undefined : []),
          ...(clonedSummaries ? { exampleSummaries: clonedSummaries } : {}),
          exampleCount:
            typeof item.exampleCount === 'number'
              ? item.exampleCount
              : clonedExamples
                ? clonedExamples.length
                : clonedSummaries
                  ? clonedSummaries.length
                  : 0,
          examplesLoaded: hasExplicitLoadedFlag ? item.examplesLoaded : true,
        }
        : {}),
      items: item.items ? normalizeItems(item.items) : undefined,
    };
  });
  return { ...collection, items: normalizeItems(collection.items || []) };
}

export function ensureUniqueCollectionItemIds(collections: Collection[]): Collection[] {
  const seenIds = new Set<string>();

  const processItems = (items: CollectionItem[]): CollectionItem[] => {
    return (items || []).map((item) => {
      let itemId = item.id;
      if (seenIds.has(itemId)) {
        itemId = generateId();
      }
      seenIds.add(itemId);

      const updatedRequest = item.request
        ? {
          ...item.request,
          id: itemId,
        }
        : undefined;

      return {
        ...item,
        id: itemId,
        request: updatedRequest,
        items: item.items ? processItems(item.items) : undefined,
      };
    });
  };

  return (collections || []).map((col) => ({
    ...col,
    items: processItems(col.items || []),
  }));
}

export function serializeHistoryAttachments(history: HistoryItem[]): HistoryItem[] {
  return history.map((entry) => ({
    ...entry,
    request: serializeRequestAttachments(entry.request),
    response: entry.response
      ? {
        ...entry.response,
        blobUrl: undefined,
        rawBodyId: undefined,
        capturedRequest: entry.response.capturedRequest
          ? serializeRequestAttachments(entry.response.capturedRequest)
          : undefined,
      }
      : undefined,
  }));
}

export function normalizeHistoryAttachments(history: HistoryItem[]): HistoryItem[] {
  return history.map((entry) => ({
    ...entry,
    request: normalizePersistedRequestAttachments(entry.request),
    response: entry.response
      ? {
        ...entry.response,
        blobUrl: undefined,
        rawBodyId: undefined,
        capturedRequest: entry.response.capturedRequest
          ? normalizePersistedRequestAttachments(entry.response.capturedRequest)
          : undefined,
      }
      : undefined,
  }));
}

export const withoutPendingDuplicateIntent = (
  intents: Record<string, PendingDuplicateIntent> | undefined,
  targetOpId: string,
): Record<string, PendingDuplicateIntent> => {
  if (!intents || !(targetOpId in intents)) return intents || {};
  const next = { ...intents };
  delete next[targetOpId];
  return next;
};

export const withoutPendingExampleIntent = (
  intents: Record<string, PendingExampleIntent> | undefined,
  targetOpId: string,
): Record<string, PendingExampleIntent> => {
  if (!intents || !(targetOpId in intents)) return intents || {};
  const next = { ...intents };
  delete next[targetOpId];
  return next;
};

export const prunePendingExampleIntentsForTarget = (
  intents: Record<string, PendingExampleIntent> | undefined,
  collectionId: string,
  itemIds?: Set<string>,
): Record<string, PendingExampleIntent> => {
  if (!intents) return {};
  let changed = false;
  const next: Record<string, PendingExampleIntent> = {};
  for (const [opId, intent] of Object.entries(intents)) {
    const matchesCol = intent.collectionId === collectionId;
    const matchesItem = !itemIds || itemIds.has(intent.itemId);
    if (matchesCol && matchesItem) {
      changed = true;
      continue;
    }
    next[opId] = intent;
  }
  return changed ? next : intents;
};

export const withReconcileRequiredIntent = (
  intents: Record<string, PendingDuplicateIntent> | undefined,
  targetOpId: string,
  fallbackIntent: PendingDuplicateIntent,
  errorMessage: string,
): Record<string, PendingDuplicateIntent> => ({
  ...(intents || {}),
  [targetOpId]: {
    ...(intents?.[targetOpId] || fallbackIntent),
    status: 'reconcile_required',
    lastError: errorMessage,
  },
});

export function sanitizeVariablesForUpstream(vars: EnvironmentVariable[]) {
  return (vars || []).map((v) => ({
    id: v.id,
    key: v.key,
    value: v.initialValue ?? v.value ?? '',
    initialValue: v.initialValue ?? v.value ?? '',
    enabled: v.enabled !== false,
  }));
}

export function getRemoteEnvironment(data: unknown): Environment | null {
  const candidate = (data as { environment?: unknown })?.environment || data;
  return buildEnvironmentsFromDelta(candidate ? [candidate] : [])[0] || null;
}

export function preserveCurrentValues(remote: Environment, local: Environment): Environment {
  return {
    ...remote,
    variables: remote.variables.map((variable) => {
      const localVariable = local.variables.find((item) => item.key.trim() === variable.key.trim());
      return localVariable ? { ...variable, currentValue: localVariable.currentValue } : variable;
    }),
  };
}
