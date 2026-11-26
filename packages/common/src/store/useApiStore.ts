import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import { useContext } from 'react';
import { StoreContext, ApiStore } from './storeContext';
export type { ApiStore } from './storeContext';
import { appStorage, setItemInAllPersistenceCopies } from '../lib/storage';
import {
  ApiRequest,
  RequestTab,
  ApiResponse,
  Collection,
  CollectionItem,
  HistoryItem,
  KeyValuePair,
  BodyType,
  AuthConfig,
  Environment,
  EnvironmentVariable,
  FormDataItem,
  BinaryFileData,
  RawType,
  WorkspaceMode,
  CloudConfig,
  ActiveScope,
  SyncStatus,
  ScopesCacheData,
  CloudProject,
  CloudWorkspace,
  OfflineWorkspace,
  FeaturePolicy,
  FeaturePolicyStatus,
  FeatureFlags,
  ProjectRole,
  ThemeMode,
  PendingDuplicateIntent,
  PendingExampleIntent,
  DuplicateActionResult,
  OpenExampleTab,
  SavedExample,
  SavedExampleSummary,
} from '../types/api';
import { applyTheme } from '../lib/theme';
import { executeApiRequest } from '../lib/fetcher';
import type { PlatformAdapter, ScriptRequest } from '../types/platform';
import type { NativeCredentialState, NativeCredentialStorage, NativeCredentialScope } from '../types/credentials';
import {
  evictRawBodiesToBudget,
  releaseRawBodies,
  releaseRawBody,
  revokeBlobUrl,
  revokeBlobUrls,
} from '../lib/blobManager';
import {
  buildPostmanUrl,
  importPostmanCollection,
  importPostmanEnvironment,
  detectPostmanJsonType,
} from '../lib/postman';
import { executePreRequestScript, executePostResponseScript } from '../lib/scriptRunner';
import { parseQueryParamsFromUrl, parsePathVariablesFromUrl, buildUrlWithParams } from '../lib/urlParams';
import {
  batchImportToScope as legacyBatchImportToScope,
  createScopeEnvironment as legacyCreateScopeEnvironment,
  updateScopeEnvironment as legacyUpdateScopeEnvironment,
  deleteScopeEnvironment as legacyDeleteScopeEnvironment,
  deleteScopeCollection as legacyDeleteScopeCollection,
  updateScopeCollectionPermission as legacyUpdateScopeCollectionPermission,
  deleteScopeItem as legacyDeleteScopeItem,
  moveScopeCollection as legacyMoveScopeCollection,
  moveScopeItem as legacyMoveScopeItem,
  duplicateScopeCollection as legacyDuplicateScopeCollection,
  importDuplicateCollection as legacyImportDuplicateCollection,
  duplicateScopeItem as legacyDuplicateScopeItem,
  reorderCollectionItems as legacyReorderCollectionItems,
  patchScopeItemExamples as legacyPatchScopeItemExamples,
  fetchScopeItem as legacyFetchScopeItem,
  fetchScopeCollectionExamples as legacyFetchScopeCollectionExamples,
  replaceScopeCollection as legacyReplaceScopeCollection,
  fetchUserWorkspaces,
  createCloudWorkspace as legacyCreateCloudWorkspace,
  updateCloudWorkspace as legacyUpdateCloudWorkspace,
  deleteCloudWorkspace as legacyDeleteCloudWorkspace,
  fetchUserTeams,
  fetchTeamProjects,
  fetchScopeCollections,
  fetchCollectionById,
  fetchScopeEnvironments,
  fetchFeaturePolicy,
  CloudApiError,
  normalizeCloudApiUrl,
} from '../lib/cloudApi';
import type { CloudClient } from '../lib/cloudApi';
import {
  applyExampleMutationToItem,
  applyServerItemToLocalItem,
  buildDefaultExampleName,
  buildExampleSummariesFromExamples,
  buildOrderedVisualTabs,
  buildSavedExampleFromResponse,
  cloneSavedExamplesList,
  cloneSavedExampleSummaries,
  collectionHasSavedExamples,
  countCollectionSavedExamples,
  evaluateResponseExampleEligibility,
  findCollectionItemById,
  getExampleUtf8ByteLength,
  getItemExampleCount,
  hasUnloadedCollectionExamples,
  isExampleTabId,
  makeExampleTabId,
  MAX_SAVED_EXAMPLES_PER_ITEM,
  MAX_SAVED_EXAMPLES_TOTAL_BYTES_PER_ITEM,
  overlayPendingExampleIntentsOnCollections,
  preserveHydratedItemExamples,
  syncVisualTabOrder,
  updateCollectionItemById,
  validateSavedExampleName,
} from '../lib/examples';
import { reorderItemInTree, isDescendantOf, findRequestAncestorIds } from '../lib/treeHelper';
import {
  duplicateCollectionTree,
  duplicateItemSubtree,
  insertItemIntoCollectionTree,
  removeItemFromCollectionTree,
  formatImportDuplicateCollectionPayload,
  getTargetFolderDepth,
  validateDuplicateName,
} from '../lib/duplicate';
import {
  buildCollectionFromDetails,
  buildEnvironmentsFromDelta,
} from '../lib/cloudSyncTransformer';
import { defaultProductPolicy } from '../lib/edition';
import { validateProductPolicy, type ProductPolicy } from '../productPolicy';
import {
  findSavedRequestInCollections,
  alignCollectionItemIds,
  collectAllItemIds,
  flattenCollectionRequests,
  alignEnvironmentVariableIds,
} from '../lib/requestDiff';
import { canModifyCollection, canModifyEnvironment, hasScopePermission, getUserScopeRank } from '../lib/jwt';
import { createAsyncOperationCoordinator, type AsyncOperation } from './asyncOperationCoordinator';
import type { ImportTargetBinding } from '../lib/importBatch';

function matchesImportTarget(
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
import { getScopeCacheKey } from '../workspace/scopeCache';
import {
  createEmptyWorkspaceSnapshot,
  restoreWorkspaceResources,
  type WorkspaceScopeSnapshot,
} from '../workspace/scopeSnapshot';
import { isCloudSessionActive, prepareCloudSessionUpdate } from '../workspace/cloudSession';
import { isActiveCloudScope, prepareCloudScopeTransition } from '../workspace/cloudScopeTransition';
import { prepareWorkspaceModeTransition } from '../workspace/workspaceModeTransition';
import { prepareCloudDeltaState } from '../workspace/cloudDeltaState';
import { normalizeCloudCacheArchives, normalizePersistedWorkspaceScopeCache, preparePersistedWorkspaceCaches, serializeCloudCacheArchives } from '../workspace/persistence';
import { archiveCloudCache, captureCloudCache, cloudCacheOwnerKey, emptyCloudCacheArchives, getArchivedScope, readCloudCache, type CloudCacheArchiveState } from '../workspace/cloudCacheArchive';
import {
  synchronizeCloudWorkspace,
} from '../workspace/cloudWorkspaceSync';
import { importCloudCacheRecoveryBackup } from '../workspace/cloudCacheRecovery';

const FEATURE_POLICY_TTL_MS = 30 * 60 * 1000;

function getNativeCredentialScope(config: Pick<CloudConfig, 'apiUrl' | 'user'>): NativeCredentialScope | null {
  const apiUrl = config.apiUrl?.trim();
  const userId = config.user?.id?.trim();
  return apiUrl && userId ? { apiUrl, userId } : null;
}

function sameNativeCredentialScope(
  left: NativeCredentialScope | null | undefined,
  right: NativeCredentialScope | null | undefined,
): boolean {
  return Boolean(left && right && left.apiUrl === right.apiUrl && left.userId === right.userId);
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const defaultRequest: ApiRequest = {
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

function createInitialTab(): ApiRequest {
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

function hasLiveFile(value: unknown): value is File {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function cloneRequestPreservingAttachments(request: ApiRequest): ApiRequest {
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

function cloneCollectionPreservingAttachments(collection: Collection): Collection {
  const cloneItems = (items: CollectionItem[]): CollectionItem[] => items.map((item) => ({
    ...item,
    request: item.request ? cloneRequestPreservingAttachments(item.request) : undefined,
    examples: Array.isArray(item.examples) ? cloneSavedExamplesList(item.examples, false) : undefined,
    exampleSummaries: Array.isArray(item.exampleSummaries) ? cloneSavedExampleSummaries(item.exampleSummaries) : undefined,
    items: item.items ? cloneItems(item.items) : undefined,
  }));
  return { ...collection, items: cloneItems(collection.items || []) };
}

function serializeRequestAttachments(request: ApiRequest): ApiRequest {
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

function normalizePersistedRequestAttachments(request: ApiRequest): ApiRequest {
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

function serializeCollectionAttachments(collection: Collection): Collection {
  const serializeItems = (items: CollectionItem[]): CollectionItem[] => items.map((item) => ({
    ...item,
    request: item.request ? serializeRequestAttachments(item.request) : undefined,
    examples: Array.isArray(item.examples) ? cloneSavedExamplesList(item.examples, false) : undefined,
    exampleSummaries: Array.isArray(item.exampleSummaries) ? cloneSavedExampleSummaries(item.exampleSummaries) : undefined,
    items: item.items ? serializeItems(item.items) : undefined,
  }));
  return { ...collection, items: serializeItems(collection.items || []) };
}

function normalizeCollectionAttachments(collection: Collection): Collection {
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

function ensureUniqueCollectionItemIds(collections: Collection[]): Collection[] {
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

function serializeHistoryAttachments(history: HistoryItem[]): HistoryItem[] {
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

function normalizeHistoryAttachments(history: HistoryItem[]): HistoryItem[] {
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

export const SCOPE_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours cache for workspace collections/environments
export const SCOPES_LIST_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours cache for workspace/project list

export type ScopeCacheEntry = WorkspaceScopeSnapshot;

export interface EnvironmentOccConflict {
  local: Environment;
  remote: Environment;
}

export interface SaveRequestToCollectionResult {
  success: boolean;
  sourceTabId?: string;
  savedRequestId?: string;
  cloudStatus: 'not-applicable' | 'pending';
  error?: string;
}

export interface SelectedSavedExample {
  collectionId: string;
  itemId: string;
  exampleId: string;
}

export interface SavedExampleActionResult {
  success: boolean;
  example?: SavedExample;
  error?: string;
  code?: string;
  reconcilePending?: boolean;
}

export interface LoadItemExamplesResult {
  success: boolean;
  item?: CollectionItem;
  error?: string;
  forbidden?: boolean;
  notFound?: boolean;
}

export interface HydrateCollectionExamplesResult {
  success: boolean;
  collection?: Collection;
  error?: string;
}

export const DEFAULT_OFFLINE_WORKSPACE_ID = 'ws-default-local';

export const defaultOfflineWorkspace: OfflineWorkspace = {
  id: DEFAULT_OFFLINE_WORKSPACE_ID,
  name: 'Default Workspace',
  description: 'Default local workspace on this device',
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

export interface ApiStoreState {
  tabs: RequestTab[];
  activeTabId: string;
  activeResponse: ApiResponse | null;
  tabResponses: Record<string, ApiResponse>;
  tabRevealRevision: number;
  isLoading: boolean;
  collections: Collection[];
  history: HistoryItem[];
  sidebarTab: 'collections' | 'history';

  // Request Undo & Redo
  canUndoActiveRequest: boolean;
  canRedoActiveRequest: boolean;
  undoActiveRequest: () => void;
  redoActiveRequest: () => void;

  // Theming
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;

  // Environments
  environments: Environment[];
  activeEnvironmentId: string | null;
  setActiveEnvironmentId: (id: string | null) => void;
  createEnvironment: (name: string, minRole?: 'admin' | 'maintainer' | 'contributor' | 'reader') => string;
  deleteEnvironment: (id: string) => void;
  updateEnvironment: (id: string, updates: Partial<Environment>) => void;
  addEnvironmentVariable: (envId: string) => void;
  updateEnvironmentVariable: (envId: string, varId: string, updates: Partial<EnvironmentVariable>) => void;
  removeEnvironmentVariable: (envId: string, varId: string) => void;
  resetEnvironmentCurrentValues: (envId: string) => void;
  persistEnvironmentCurrentValues: (envId: string) => void;
  addEnvironment: (env: Environment, options?: { target?: ImportTargetBinding; isRetry?: boolean }) => Promise<string>;
  replaceEnvironment: (existingId: string, incomingEnv: Environment, options?: { target?: ImportTargetBinding }) => Promise<void>;
  environmentOccConflict: EnvironmentOccConflict | null;
  discardEnvironmentOccConflict: () => void;
  overwriteEnvironmentOccConflict: () => Promise<void>;
  importEnvironmentFromJson: (jsonStr: string) => { success: boolean; error?: string; environment?: Environment };
  importAnyPostmanJson: (jsonStr: string) => Promise<{
    success: boolean;
    type?: 'collection' | 'environment';
    name?: string;
    error?: string;
  }>;

  // Navigation & Tabs
  setSidebarTab: (tab: 'collections' | 'history') => void;
  setActiveTabId: (id: string) => void;
  createTab: (initial?: Partial<ApiRequest>) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeAllTabs: () => void;
  closeTabsToRight: (id: string) => void;
  duplicateTab: (id: string) => void;
  updateActiveRequest: (updates: Partial<ApiRequest>) => void;

  // Request Builders
  updateParam: (id: string, updates: Partial<KeyValuePair>) => void;
  addParam: () => void;
  removeParam: (id: string) => void;
  updatePathVariable: (id: string, updates: Partial<KeyValuePair>) => void;

  updateHeader: (id: string, updates: Partial<KeyValuePair>) => void;
  addHeader: () => void;
  removeHeader: (id: string) => void;

  updateAuth: (auth: Partial<AuthConfig>) => void;
  setBodyType: (type: BodyType) => void;
  setRawType: (rawType: RawType) => void;
  setBodyContent: (content: string, isDiscrete?: boolean) => void;
  setGraphqlQuery: (query: string, isDiscrete?: boolean) => void;
  setGraphqlVariables: (variables: string, isDiscrete?: boolean) => void;
  setPreRequestScript: (script: string, isDiscrete?: boolean) => void;
  setPostResponseScript: (script: string, isDiscrete?: boolean) => void;

  // Form-Data & Binary Items
  updateFormDataItem: (id: string, updates: Partial<FormDataItem>) => void;
  addFormDataItem: () => void;
  removeFormDataItem: (id: string) => void;
  setBodyBinaryFile: (file?: BinaryFileData) => void;

  // URL-Encoded Form Items
  updateUrlEncodedItem: (id: string, updates: Partial<KeyValuePair>) => void;
  addUrlEncodedItem: () => void;
  removeUrlEncodedItem: (id: string) => void;
  setUrlEncodedItems: (items: KeyValuePair[]) => void;

  // Execution
  sendRequest: () => Promise<void>;
  cancelActiveRequest: () => void;

  // Collections & History
  createCollection: (name: string, description?: string) => string;
  createCollectionAsync: (
    name: string,
    description?: string
  ) => Promise<{ success: boolean; collectionId?: string; error?: string }>;
  renameCollection: (id: string, name: string) => void;
  createFolder: (collectionId: string, parentFolderId: string | null, name?: string) => string;
  createRequestInCollection: (collectionId: string, folderId: string | null, name?: string) => ApiRequest | null;
  deleteCollectionItem: (collectionId: string, itemId: string) => void;
  renameCollectionItem: (collectionId: string, itemId: string, name: string) => void;
  saveRequestToCollection: (
    collectionId: string,
    folderId: string | null,
    request: ApiRequest,
    sourceTabId?: string,
  ) => SaveRequestToCollectionResult;
  saveActiveRequest: () => { success: boolean; isDirectSaved: boolean };
  addCollection: (collection: Collection, options?: { target?: ImportTargetBinding; isRetry?: boolean }) => Promise<void> | void;
  replaceCollection: (existingId: string, newCollection: Collection, options?: { target?: ImportTargetBinding }) => Promise<void>;
  importCollectionFromJson: (jsonStr: string) => Promise<{ success: boolean; error?: string }>;
  deleteCollection: (id: string) => Promise<{ success: boolean; error?: string }>;
  updateCollectionPermission: (
    collectionId: string,
    minRole: ProjectRole
  ) => Promise<{ success: boolean; error?: string }>;
  moveCollection: (collectionId: string, targetScope: ActiveScope) => Promise<{ success: boolean; error?: string }>;
  duplicateCollection: (
    collectionId: string,
    targetScope: ActiveScope,
    options?: { operationId?: string }
  ) => Promise<DuplicateActionResult>;
  duplicateCollectionItem: (
    sourceCollectionId: string,
    itemId: string,
    targetCollectionId: string,
    targetParentId: string | null,
    options?: { operationId?: string }
  ) => Promise<DuplicateActionResult>;
  loadCollectionDetails: (
    collectionId: string
  ) => Promise<{ success: boolean; collection?: Collection; error?: string }>;
  openExampleTabs: OpenExampleTab[];
  tabOrder: string[];
  selectedExample: SelectedSavedExample | null;
  selectSavedExample: (selection: SelectedSavedExample | null) => void;
  closeExampleTab: (tabId: string) => void;
  pendingExampleIntents: Record<string, PendingExampleIntent>;
  saveResponseAsExample: (input: {
    collectionId: string;
    itemId: string;
    name?: string;
    response: ApiResponse;
    fallbackRequest?: ApiRequest;
  }) => Promise<SavedExampleActionResult>;
  renameSavedExample: (input: {
    collectionId: string;
    itemId: string;
    exampleId: string;
    name: string;
  }) => Promise<SavedExampleActionResult>;
  deleteSavedExample: (input: {
    collectionId: string;
    itemId: string;
    exampleId: string;
  }) => Promise<SavedExampleActionResult>;
  loadItemExamples: (collectionId: string, itemId: string) => Promise<LoadItemExamplesResult>;
  hydrateCollectionExamples: (
    collectionId: string,
    options?: { includeBody?: boolean }
  ) => Promise<HydrateCollectionExamplesResult>;
  retryPendingExampleIntent: (operationId: string) => Promise<SavedExampleActionResult>;
  clearPendingExampleIntent: (operationId: string) => void;
  pendingDuplicateIntents: Record<string, PendingDuplicateIntent>;
  /** Runtime-only IDs of duplicate operations actively in flight in this session (never persisted). */
  activeDuplicateOperationIds: Record<string, boolean>;
  lastDuplicateReveal: { pathIds: string[]; revision: number } | null;
  retryPendingDuplicateIntent: (operationId: string) => Promise<DuplicateActionResult>;
  clearPendingDuplicateIntent: (operationId: string) => void;
  moveRequest: (
    sourceCollectionId: string,
    requestId: string,
    targetCollectionId: string,
    targetFolderId: string | null
  ) => Promise<{ success: boolean; error?: string }>;
  moveFolder: (
    sourceCollectionId: string,
    folderId: string,
    targetCollectionId: string,
    targetFolderId: string | null
  ) => Promise<{ success: boolean; error?: string }>;
  reorderItem: (
    collectionId: string,
    activeId: string,
    targetId: string,
    position: 'before' | 'after' | 'inside'
  ) => Promise<{ success: boolean; error?: string }>;
  openRequestInTab: (request: ApiRequest, initialResponse?: ApiResponse) => void;
  clearHistory: () => void;
  deleteHistoryItem: (id: string) => void;

  // Offline Workspaces
  offlineWorkspaces?: OfflineWorkspace[];
  activeOfflineWorkspaceId?: string;
  offlineScopeCache?: Record<string, ScopeCacheEntry>;
  createOfflineWorkspace: (name: string, description?: string) => string;
  switchOfflineWorkspace: (workspaceId: string, skipSnapshot?: boolean) => void;
  renameOfflineWorkspace: (id: string, name: string) => void;
  deleteOfflineWorkspace: (id: string) => { success: boolean; error?: string };
  duplicateOfflineWorkspace: (id: string, newName?: string) => string;

  // Workspace Mode & Cloud Synchronization
  workspaceMode: WorkspaceMode;
  hasConfiguredMode: boolean;
  cloudConfig: CloudConfig;
  /** Public identity and migration state for credentials held by the native vault. */
  nativeCredentialState?: NativeCredentialState;
  /** Durable cleanup journal retained across rotations, account switches, and sign-out until both copies redact legacy secrets. */
  nativeCredentialCleanupPending?: boolean;
  featurePolicy: FeaturePolicy | null;
  featurePolicyStatus: FeaturePolicyStatus;
  featurePolicyFetchedAt: number | null;
  syncStatus: SyncStatus;
  lastSyncedAt: number | null;
  syncError: string | null;
  scopeCache?: Record<string, ScopeCacheEntry>;
  /** Owner of the active cache; missing for legacy data with uncertain provenance. */
  cloudCacheOwner: string | null;
  cloudCacheArchives: CloudCacheArchiveState;
  scopesCache?: ScopesCacheData;
  isSwitchingWorkspace?: boolean;

  setWorkspaceMode: (mode: WorkspaceMode) => void;
  setHasConfiguredMode: (configured: boolean) => void;
  setCloudConfig: (config: Partial<CloudConfig>) => void;
  /** Writes password-provider credentials to the platform vault before updating session state. */
  setCloudSession: (config: Partial<CloudConfig>) => Promise<void>;
  /** Removes the current password-provider credential from the platform vault. */
  clearCloudCredentials: (scope?: NativeCredentialScope) => Promise<void>;
  setNativeCredentialState: (state?: NativeCredentialState) => void;
  /** Persists the current redacted native state to both legacy persistence copies. */
  persistNativeCredentialState: () => Promise<void>;
  /** Retries physical-copy redaction and clears the cleanup journal only after both copies succeed. */
  completePendingCredentialCleanup: () => Promise<boolean>;
  /** Coordinates startup vault restoration and legacy migration with all other vault mutations. */
  recoverNativeCredentials: (options?: { isCancelled?: () => boolean }) => Promise<void>;
  /** Signs out through provider sign-out and vault deletion, keeping the session retryable if deletion fails. */
  signOutCloud: (options?: {
    authProvider?: {
      signOut?: (request: {
        apiUrl: string;
        user?: CloudConfig['user'];
        accessToken?: string;
        refreshToken?: string;
      }) => Promise<void>;
    };
  }) => Promise<{ success: boolean; error?: string }>;
  /** Removes any vaulted credential for an evicted or scope-revoked session and clears active cloud state. */
  evictCloudSession: (scope?: NativeCredentialScope) => void;
  getCloudSessionGeneration: () => number;
  getCloudCacheRecoveryCount: () => number;
  getCloudCacheRecoveryBackup: () => string;
  importCloudCacheRecoveryBackup: (serialized: string) => { success: boolean; archiveCount: number; unsupportedArchiveCount: number; error?: string };
  recoverCloudCachesToOfflineWorkspaces: () => { success: boolean; workspaceCount: number; error?: string };
  refreshFeaturePolicy: (force?: boolean) => Promise<FeaturePolicy | null>;
  isFeatureEnabled: (feature: keyof FeatureFlags) => boolean;
  setActiveScope: (scope: ActiveScope, forceSync?: boolean) => Promise<void>;
  fetchScopes: (force?: boolean) => Promise<void>;
  fetchProjectsForTeam: (teamId: string, force?: boolean) => Promise<CloudProject[]>;
  logoutCloud: () => void;
  setSyncStatus: (status: SyncStatus, error?: string | null) => void;
  pullCloudDelta: () => Promise<void>;
  importLocalToCloud: () => Promise<{ success: boolean; message: string }>;
  createCloudWorkspace: (name: string, description?: string) => Promise<{ success: boolean; workspace?: CloudWorkspace; error?: string }>;
  renameCloudWorkspace: (id: string, name: string) => Promise<{ success: boolean; error?: string }>;
  deleteCloudWorkspace: (id: string) => Promise<{ success: boolean; error?: string }>;
}

const withoutPendingDuplicateIntent = (
  intents: Record<string, PendingDuplicateIntent> | undefined,
  targetOpId: string,
): Record<string, PendingDuplicateIntent> => {
  if (!intents || !(targetOpId in intents)) return intents || {};
  const next = { ...intents };
  delete next[targetOpId];
  return next;
};

const withoutPendingExampleIntent = (
  intents: Record<string, PendingExampleIntent> | undefined,
  targetOpId: string,
): Record<string, PendingExampleIntent> => {
  if (!intents || !(targetOpId in intents)) return intents || {};
  const next = { ...intents };
  delete next[targetOpId];
  return next;
};

const prunePendingExampleIntentsForTarget = (
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

const withReconcileRequiredIntent = (
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

function getRemoteEnvironment(data: unknown): Environment | null {
  const candidate = (data as { environment?: unknown })?.environment || data;
  return buildEnvironmentsFromDelta(candidate ? [candidate] : [])[0] || null;
}

function preserveCurrentValues(remote: Environment, local: Environment): Environment {
  return {
    ...remote,
    variables: remote.variables.map((variable) => {
      const localVariable = local.variables.find((item) => item.key.trim() === variable.key.trim());
      return localVariable ? { ...variable, currentValue: localVariable.currentValue } : variable;
    }),
  };
}

export interface CreateApiStoreOptions {
  storage?: StateStorage;
  adapter?: PlatformAdapter;
  credentialStorage?: NativeCredentialStorage;
  productPolicy?: ProductPolicy;
  cloudClient?: CloudClient;
}

export function createApiStore(
  customStorageOrOptions: StateStorage | CreateApiStoreOptions = appStorage,
  adapterParam?: PlatformAdapter
): ApiStore {
  const options = (customStorageOrOptions && typeof (customStorageOrOptions as StateStorage).getItem === 'function')
    ? { storage: customStorageOrOptions as StateStorage, adapter: adapterParam }
    : ((customStorageOrOptions as CreateApiStoreOptions) || {});

  const customStorage = options.storage || appStorage;
  const boundAdapter = options.adapter || adapterParam;
  const credentialStorage = options.credentialStorage || boundAdapter?.credentialStorage;
  const persistCloudCredentials = credentialStorage === undefined;
  const productPolicy = options.productPolicy !== undefined ? validateProductPolicy(options.productPolicy) : defaultProductPolicy;
  const isOfflineOnly = !productPolicy.workspace.cloud;
  const allowsOfflineWorkspace = productPolicy.workspace.offline !== false;
  const fetchFeaturePolicyForRuntime = options.cloudClient?.fetchFeaturePolicy ?? fetchFeaturePolicy;
  const fetchUserWorkspacesForRuntime = options.cloudClient?.fetchUserWorkspaces ?? fetchUserWorkspaces;
  const fetchUserTeamsForRuntime = options.cloudClient?.fetchUserTeams ?? fetchUserTeams;
  const fetchTeamProjectsForRuntime = options.cloudClient?.fetchTeamProjects ?? fetchTeamProjects;
  const fetchScopeCollectionsForRuntime = options.cloudClient?.fetchScopeCollections ?? fetchScopeCollections;
  const fetchCollectionByIdForRuntime = options.cloudClient?.fetchCollectionById ?? fetchCollectionById;
  const fetchScopeEnvironmentsForRuntime = options.cloudClient?.fetchScopeEnvironments ?? fetchScopeEnvironments;
  const batchImportToScope = options.cloudClient?.batchImportToScope
    ?? ((
      apiUrl: string,
      token: string | undefined,
      scope: ActiveScope | { id: string; type: 'workspace' | 'project' } | string,
      collections: Collection[],
      refreshToken?: string,
      signal?: AbortSignal,
      importOptions?: { includeExamples?: boolean },
    ) => legacyBatchImportToScope(apiUrl, token, scope, collections, refreshToken, signal, undefined, importOptions));
  const createScopeEnvironment = options.cloudClient?.createScopeEnvironment ?? legacyCreateScopeEnvironment;
  const updateScopeEnvironment = options.cloudClient?.updateScopeEnvironment ?? legacyUpdateScopeEnvironment;
  const deleteScopeEnvironment = options.cloudClient?.deleteScopeEnvironment ?? legacyDeleteScopeEnvironment;
  const deleteScopeCollection = options.cloudClient?.deleteScopeCollection ?? legacyDeleteScopeCollection;
  const updateScopeCollectionPermission = options.cloudClient?.updateScopeCollectionPermission ?? legacyUpdateScopeCollectionPermission;
  const deleteScopeItem = options.cloudClient?.deleteScopeItem ?? legacyDeleteScopeItem;
  const moveScopeCollection = options.cloudClient?.moveScopeCollection ?? legacyMoveScopeCollection;
  const moveScopeItem = options.cloudClient?.moveScopeItem ?? legacyMoveScopeItem;
  const duplicateScopeCollection = options.cloudClient?.duplicateScopeCollection ?? legacyDuplicateScopeCollection;
  const importDuplicateCollection = options.cloudClient?.importDuplicateCollection ?? legacyImportDuplicateCollection;
  const duplicateScopeItem = options.cloudClient?.duplicateScopeItem ?? legacyDuplicateScopeItem;
  const reorderCollectionItems = options.cloudClient?.reorderCollectionItems ?? legacyReorderCollectionItems;
  const patchScopeItemExamples = options.cloudClient?.patchScopeItemExamples ?? legacyPatchScopeItemExamples;
  const fetchScopeItem = options.cloudClient?.fetchScopeItem ?? legacyFetchScopeItem;
  const fetchScopeCollectionExamples = options.cloudClient?.fetchScopeCollectionExamples ?? legacyFetchScopeCollectionExamples;
  const replaceScopeCollection = options.cloudClient?.replaceScopeCollection ?? legacyReplaceScopeCollection;
  const createCloudWorkspace = options.cloudClient?.createCloudWorkspace ?? legacyCreateCloudWorkspace;
  const updateCloudWorkspace = options.cloudClient?.updateCloudWorkspace ?? legacyUpdateCloudWorkspace;
  const deleteCloudWorkspace = options.cloudClient?.deleteCloudWorkspace ?? legacyDeleteCloudWorkspace;

  const envSyncDebounceTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  const envSyncInFlight: Record<string, boolean> = {};
  const envSyncQueued: Record<string, boolean> = {};
  const collectionSaveSyncRevisions = new Map<string, number>();
  const collectionSaveSyncQueues = new Map<string, Promise<void>>();
  const pendingReorderBaseSnapshots = new Map<string, { items: CollectionItem[]; syncStatus?: Collection['_syncStatus'] }>();
  const movingCollections = new Map<string, symbol>();
  const duplicatingCollections = new Map<string, symbol>();
  const inFlightDuplicateOperations = new Set<string>();
  const inFlightExampleOperations = new Set<string>();
  let activeFeaturePolicyPromise: Promise<FeaturePolicy | null> | null = null;
  let activeFeaturePolicyKey: string | null = null;
  let collectionSaveSyncGeneration = 0;
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  let isStoreDisposed = false;
  let cloudSessionGeneration = 0;
  let nativeCredentialOperation = 0;
  let nativeCredentialQueue: Promise<void> = Promise.resolve();
  let cleanupInFlight: Promise<boolean> | null = null;
  let signOutInFlight: Promise<{ success: boolean; error?: string }> | null = null;
  let hasCompletedInitialHydration = false;
  let initialHydrationPending = false;

  function enqueueNativeCredentialOperation<T>(operation: () => Promise<T>): Promise<T> {
    const task = nativeCredentialQueue.then(operation, operation);
    nativeCredentialQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  const nativeCredentialRecordMatches = (
    expected: { accessToken: string; refreshToken?: string; expiresAt?: string },
    actual: { accessToken: string; refreshToken?: string; expiresAt?: string } | null,
  ) => Boolean(actual && actual.accessToken === expected.accessToken &&
    actual.refreshToken === expected.refreshToken && actual.expiresAt === expected.expiresAt);

  interface TabUndoEntry {
    past: ApiRequest[];
    future: ApiRequest[];
  }
  const tabUndoHistory: Record<string, TabUndoEntry> = {};
  const undoTypingTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  const MAX_UNDO_HISTORY = 50;

  function isRequestIdentical(a: ApiRequest, b: ApiRequest): boolean {
    if (a.name !== b.name || a.method !== b.method || a.url !== b.url) return false;
    if (a.bodyType !== b.bodyType || a.rawType !== b.rawType || a.bodyContent !== b.bodyContent) return false;
    if (a.graphqlQuery !== b.graphqlQuery || a.graphqlVariables !== b.graphqlVariables) return false;
    if (a.preRequestScript !== b.preRequestScript || a.postResponseScript !== b.postResponseScript) return false;
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function pushTabSnapshot(tabId: string, currentTab: ApiRequest, isTyping = false) {
    if (isStoreDisposed || !tabId || !currentTab) return;
    if (!tabUndoHistory[tabId]) {
      tabUndoHistory[tabId] = { past: [], future: [] };
    }
    const history = tabUndoHistory[tabId];

    if (isTyping) {
      if (undoTypingTimers[tabId]) {
        clearTimeout(undoTypingTimers[tabId]);
        undoTypingTimers[tabId] = setTimeout(() => {
          delete undoTypingTimers[tabId];
        }, 500);
        return;
      }

      history.past.push(cloneRequestPreservingAttachments(currentTab));
      if (history.past.length > MAX_UNDO_HISTORY) {
        history.past.shift();
      }
      history.future = [];

      undoTypingTimers[tabId] = setTimeout(() => {
        delete undoTypingTimers[tabId];
      }, 500);
    } else {
      if (undoTypingTimers[tabId]) {
        clearTimeout(undoTypingTimers[tabId]);
        delete undoTypingTimers[tabId];
      }

      const last = history.past[history.past.length - 1];
      if (last && isRequestIdentical(last, currentTab)) {
        return;
      }

      history.past.push(cloneRequestPreservingAttachments(currentTab));
      if (history.past.length > MAX_UNDO_HISTORY) {
        history.past.shift();
      }
      history.future = [];
    }
  }

  function safeSetTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      if (!isStoreDisposed) {
        fn();
      }
    }, ms);
    pendingTimers.add(timer);
    return timer;
  }

  const asyncOperations = createAsyncOperationCoordinator({
    isDisposed: () => isStoreDisposed,
  });
  // Feature policy belongs to a session, not an individual workspace scope.
  const sessionOperations = createAsyncOperationCoordinator({
    isDisposed: () => isStoreDisposed,
  });
  let activePullOperation: AsyncOperation | null = null;
  let activeRequestOperation: AsyncOperation | null = null;
  let activeRequestTabId: string | null = null;

  function safeReleaseRawBody(id?: string): void {
    if (typeof releaseRawBody === 'function') {
      releaseRawBody(id);
    }
  }

  function safeReleaseRawBodies(ids: Iterable<string | undefined>): void {
    if (typeof releaseRawBodies === 'function') {
      releaseRawBodies(ids);
    }
  }

  function safeEvictRawBodiesToBudget(pinnedIds: Iterable<string>): void {
    if (typeof evictRawBodiesToBudget === 'function') {
      evictRawBodiesToBudget(pinnedIds);
    }
  }

  function collectProtectedResponseHandles(
    responses: Iterable<ApiResponse | null | undefined>,
    histories: Array<Array<HistoryItem> | undefined>
  ): { blobUrls: Set<string>; rawBodyIds: Set<string> } {
    const blobUrls = new Set<string>();
    const rawBodyIds = new Set<string>();
    for (const res of responses) {
      if (!res) continue;
      if (res.blobUrl) blobUrls.add(res.blobUrl);
      if (res.rawBodyId) rawBodyIds.add(res.rawBodyId);
    }
    for (const hist of histories) {
      if (!hist) continue;
      for (const item of hist) {
        if (item.response?.blobUrl) blobUrls.add(item.response.blobUrl);
        if (item.response?.rawBodyId) rawBodyIds.add(item.response.rawBodyId);
      }
    }
    return { blobUrls, rawBodyIds };
  }

  function revokeUnreferencedResponses(
    candidates: Iterable<ApiResponse | null | undefined>,
    protectedResponses: Iterable<ApiResponse | null | undefined>,
    protectedHistories: Array<Array<HistoryItem> | undefined>
  ) {
    const { blobUrls: protectedBlobs, rawBodyIds: protectedRawIds } = collectProtectedResponseHandles(
      protectedResponses,
      protectedHistories
    );

    const blobsToRevoke = new Set<string>();
    const rawIdsToRelease = new Set<string>();
    for (const res of candidates) {
      if (!res) continue;
      if (res.blobUrl && !protectedBlobs.has(res.blobUrl)) {
        blobsToRevoke.add(res.blobUrl);
      }
      if (res.rawBodyId && !protectedRawIds.has(res.rawBodyId)) {
        rawIdsToRelease.add(res.rawBodyId);
      }
    }
    revokeBlobUrls(blobsToRevoke);
    safeReleaseRawBodies(rawIdsToRelease);
  }

  function revokeUnreferencedTabBlobs(
    prevTabResponses: Record<string, ApiResponse> | undefined,
    prevActiveResponse: ApiResponse | null | undefined,
    protectedHistories: Array<Array<HistoryItem> | undefined>
  ) {
    revokeUnreferencedResponses(
      [prevActiveResponse, ...(prevTabResponses ? Object.values(prevTabResponses) : [])],
      [],
      protectedHistories
    );
  }

  function beginAsyncOperation(): AsyncOperation {
    return asyncOperations.begin();
  }

  function completeAsyncOperation(operation: AsyncOperation) {
    asyncOperations.complete(operation);
  }

  function isAsyncOperationCurrent(operation: AsyncOperation): boolean {
    return asyncOperations.isCurrent(operation);
  }

  function enqueueCollectionSyncTask(
    collectionId: string,
    scope: ActiveScope,
    work: (operation: AsyncOperation, generation: number) => Promise<void>,
  ): Promise<void> {
    const queueKey = `${scope.type}:${scope.id}:${collectionId}`;
    const generation = collectionSaveSyncGeneration;
    const previous = collectionSaveSyncQueues.get(queueKey) ?? Promise.resolve();

    const task = previous.catch(() => undefined).then(async () => {
      if (generation !== collectionSaveSyncGeneration || isStoreDisposed) return;

      const operation = beginAsyncOperation();
      try {
        await work(operation, generation);
      } finally {
        completeAsyncOperation(operation);
      }
    });

    collectionSaveSyncQueues.set(queueKey, task);
    void task.finally(() => {
      if (collectionSaveSyncQueues.get(queueKey) === task) {
        collectionSaveSyncQueues.delete(queueKey);
      }
    });
    return task;
  }

  function queueSavedCollectionSync(
    collection: Collection,
    scope: ActiveScope,
    cloudConfig: ApiStoreState['cloudConfig'],
    revision: number,
    get: () => ApiStoreState,
    set: (fn: (state: ApiStoreState) => Partial<ApiStoreState>) => void,
    errorPrefix = 'Failed to sync saved request to cloud',
  ): void {
    void enqueueCollectionSyncTask(collection.id, scope, async (operation, generation) => {
      try {
        const liveCloudConfig = get().cloudConfig;
        await batchImportToScope(
          liveCloudConfig.apiUrl || cloudConfig.apiUrl,
          liveCloudConfig.token || cloudConfig.token,
          scope,
          [collection],
          liveCloudConfig.refreshToken ?? cloudConfig.refreshToken,
          operation.controller.signal,
          { includeExamples: false },
        );

        if (
          !isAsyncOperationCurrent(operation) ||
          generation !== collectionSaveSyncGeneration ||
          collectionSaveSyncRevisions.get(collection.id) !== revision ||
          get().cloudConfig.activeScope?.id !== scope.id ||
          get().cloudConfig.activeScope?.type !== scope.type
        ) {
          return;
        }

        set((state) => ({
          collections: state.collections.map((candidate) =>
            candidate.id === collection.id ? { ...candidate, _syncStatus: 'synced' } : candidate,
          ),
        }));
      } catch (error: unknown) {
        if (
          operation.controller.signal.aborted ||
          !isAsyncOperationCurrent(operation) ||
          generation !== collectionSaveSyncGeneration ||
          collectionSaveSyncRevisions.get(collection.id) !== revision
        ) {
          return;
        }

        const message = error instanceof Error ? error.message : errorPrefix;
        console.error(`${errorPrefix}:`, error);
        set((state) => ({
          collections: state.collections.map((candidate) =>
            candidate.id === collection.id ? { ...candidate, _syncStatus: 'pending' } : candidate,
          ),
          syncStatus: 'error',
          syncError: message,
        }));
      }
    });
  }

  function invalidateAsyncOperations({ session = false }: { session?: boolean } = {}) {
    collectionSaveSyncQueues.clear();
    collectionSaveSyncRevisions.clear();
    pendingReorderBaseSnapshots.clear();
    movingCollections.clear();
    duplicatingCollections.clear();
    collectionSaveSyncGeneration += 1;
    asyncOperations.invalidate({ session });
    if (session) {
      cloudSessionGeneration += 1;
      sessionOperations.invalidate({ session: true });
    }
    for (const id of Object.keys(envSyncDebounceTimers)) {
      clearTimeout(envSyncDebounceTimers[id]);
      delete envSyncDebounceTimers[id];
    }
    for (const id of Object.keys(envSyncInFlight)) {
      delete envSyncInFlight[id];
    }
    for (const id of Object.keys(envSyncQueued)) {
      delete envSyncQueued[id];
    }
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
  }

  function scheduleEnvironmentCloudSync(
    envId: string,
    get: () => ApiStoreState,
    set: (fn: (state: ApiStoreState) => Partial<ApiStoreState>) => void
  ) {
    if (isOfflineOnly || isStoreDisposed) return;

    if (envSyncDebounceTimers[envId]) {
      clearTimeout(envSyncDebounceTimers[envId]);
      delete envSyncDebounceTimers[envId];
    }

    envSyncDebounceTimers[envId] = setTimeout(async () => {
      delete envSyncDebounceTimers[envId];

      if (isStoreDisposed) return;
      const { workspaceMode, cloudConfig } = get();
      if (workspaceMode !== 'cloud' || !isCloudSessionActive(cloudConfig)) return;

      if (envSyncInFlight[envId]) {
        envSyncQueued[envId] = true;
        return;
      }

      const executeSync = async () => {
        if (isStoreDisposed) return;
        const state = get();
        if (state.workspaceMode !== 'cloud' || !isCloudSessionActive(state.cloudConfig)) return;

        const currentEnv = state.environments.find((e) => e.id === envId);
        if (!currentEnv) return;

        envSyncInFlight[envId] = true;
        const operation = beginAsyncOperation();
        try {
          const res = await updateScopeEnvironment(
            state.cloudConfig.apiUrl,
            state.cloudConfig.token,
            envId,
            {
              name: currentEnv.name,
              variables: sanitizeVariablesForUpstream(currentEnv.variables),
              min_role: currentEnv.minRole,
              base_version: currentEnv.version || 1,
            },
            state.cloudConfig.refreshToken,
            operation.controller.signal
          );

          if (!isAsyncOperationCurrent(operation)) return;

          if (res && typeof res.version === 'number') {
            set((s) => {
              if (!isAsyncOperationCurrent(operation)) return {};
              return {
                environments: s.environments.map((e) =>
                  e.id === envId ? { ...e, version: res.version } : e
                ),
              };
            });
          }
        } catch (err: any) {
          if (!isAsyncOperationCurrent(operation)) return;
          if (err?.status === 409) {
            const remote = getRemoteEnvironment(err.data);
            console.warn('Environment sync conflict requires explicit resolution:', err);
            set((currentState) => {
              if (!isAsyncOperationCurrent(operation)) return {};
              return {
                syncStatus: 'error',
                syncError: 'Environment changes conflict with a newer server version. Review the conflict before saving again.',
                environmentOccConflict: remote
                  ? { local: currentState.environments.find((environment) => environment.id === envId) || currentEnv, remote }
                  : null,
              };
            });
            return;
          }
          console.error('Failed to sync updated environment to cloud:', err);
        } finally {
          completeAsyncOperation(operation);
          delete envSyncInFlight[envId];
          if (envSyncQueued[envId]) {
            delete envSyncQueued[envId];
            void executeSync();
          }
        }
      };

      await executeSync();
    }, 1200);
  }

  async function commitItemMove(
    itemId: string,
    sourceCollectionId: string,
    targetCollectionId: string,
    targetParentId: string | null,
    commit: () => void,
  ): Promise<{ success: boolean; error?: string }> {
    const { workspaceMode, cloudConfig } = store.getState();
    if (workspaceMode !== 'cloud') {
      commit();
      return { success: true };
    }
    const scope = cloudConfig.activeScope;
    if (isOfflineOnly || !isCloudSessionActive(cloudConfig) || !scope) {
      return { success: false, error: 'Sign in before moving cloud items.' };
    }
    if (activePullOperation && isAsyncOperationCurrent(activePullOperation)) {
      return { success: false, error: 'Wait for workspace sync to finish before moving items.' };
    }
    const ids = [...new Set([sourceCollectionId, targetCollectionId])];
    if (store.getState().collections.some((col) => ids.includes(col.id) && col._needsMoveReconciliation)) {
      return { success: false, error: 'Sync the workspace to confirm the previous move before moving items again.' };
    }
    if (ids.some((id) => movingCollections.has(id) || duplicatingCollections.has(id))) {
      return { success: false, error: 'A move or duplicate operation is already in progress for this collection.' };
    }
    const lock = Symbol('item move');
    ids.forEach((id) => movingCollections.set(id, lock));
    const operation = beginAsyncOperation();
    try {
      await Promise.all(ids.map((id) => collectionSaveSyncQueues.get(`${scope.type}:${scope.id}:${id}`)));
      if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled.' };
      if (store.getState().collections.some((col) => ids.includes(col.id) && col._syncStatus === 'pending')) {
        return { success: false, error: 'Sync pending changes in both collections before moving this item.' };
      }
      // Persist before sending: after a lost reply or restart, these old trees must
      // be fetched from the server before any import can recreate moved items.
      store.setState((state) => ({ collections: state.collections.map((col) => ids.includes(col.id) ? { ...col, _needsMoveReconciliation: true } : col) }));
      await moveScopeItem(cloudConfig.apiUrl, cloudConfig.token, itemId, sourceCollectionId, targetCollectionId, targetParentId, cloudConfig.refreshToken, operation.controller.signal);
      if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled.' };
      commit();
      store.setState((state) => {
        const activeScopeKey = state.cloudConfig.activeScope ? getScopeCacheKey(state.cloudConfig.activeScope) : null;
        const updatedScopeCache = { ...(state.scopeCache || {}) };
        if (activeScopeKey && updatedScopeCache[activeScopeKey]) {
          updatedScopeCache[activeScopeKey] = {
            ...updatedScopeCache[activeScopeKey],
            lastSyncedAt: 0,
          };
        }
        const nextOpenExampleTabs = (state.openExampleTabs || []).map((ex) =>
          ex.collectionId === sourceCollectionId && ex.itemId === itemId && sourceCollectionId !== targetCollectionId
            ? {
                ...ex,
                collectionId: targetCollectionId,
                id: makeExampleTabId({
                  collectionId: targetCollectionId,
                  itemId: ex.itemId,
                  exampleId: ex.exampleId,
                }),
              }
            : ex
        );
        const tabIdRewrite = new Map<string, string>();
        (state.openExampleTabs || []).forEach((oldEx, idx) => {
          const nextEx = nextOpenExampleTabs[idx];
          if (nextEx && oldEx.id !== nextEx.id) {
            tabIdRewrite.set(oldEx.id, nextEx.id);
          }
        });
        const nextTabOrder = tabIdRewrite.size > 0
          ? syncVisualTabOrder(
              state.tabs,
              nextOpenExampleTabs,
              (state.tabOrder || []).map((id) => tabIdRewrite.get(id) ?? id),
            )
          : state.tabOrder;
        return {
          collections: state.collections.map((col) =>
            ids.includes(col.id)
              ? {
                  ...col,
                  version: typeof col.version === 'number' ? col.version + 1 : col.version,
                  _needsMoveReconciliation: undefined,
                }
              : col
          ),
          openExampleTabs: nextOpenExampleTabs,
          tabOrder: nextTabOrder,
          selectedExample:
            state.selectedExample &&
            state.selectedExample.collectionId === sourceCollectionId &&
            state.selectedExample.itemId === itemId &&
            sourceCollectionId !== targetCollectionId
              ? { ...state.selectedExample, collectionId: targetCollectionId }
              : state.selectedExample,
          scopeCache: updatedScopeCache,
        };
      });
      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to move item to the target collection.';
      if (isAsyncOperationCurrent(operation)) {
        const rejected = error instanceof CloudApiError && [400, 403, 404].includes(error.status);
        store.setState((state) => ({
          syncStatus: 'error', syncError: message,
          collections: rejected ? state.collections.map((col) => ids.includes(col.id) ? { ...col, _needsMoveReconciliation: undefined } : col) : state.collections,
        }));
      }
      return { success: false, error: message };
    } finally {
      completeAsyncOperation(operation);
      ids.forEach((id) => { if (movingCollections.get(id) === lock) movingCollections.delete(id); });
    }
  }

  const store: ApiStore = create<ApiStoreState>()(
  persist(
    (rawSet, get) => {
      const set: typeof rawSet = ((fnOrState: any, replace?: any) => {
        if (isStoreDisposed) return;
        return (rawSet as any)(fnOrState, replace);
      }) as typeof rawSet;
      const markDuplicateOperationInFlight = (targetOpId: string) => {
        inFlightDuplicateOperations.add(targetOpId);
        set((state) => ({
          activeDuplicateOperationIds: {
            ...(state.activeDuplicateOperationIds || {}),
            [targetOpId]: true,
          },
        }));
      };
      const clearDuplicateOperationInFlight = (targetOpId: string) => {
        inFlightDuplicateOperations.delete(targetOpId);
        if (isStoreDisposed) return;
        set((state) => {
          if (!state.activeDuplicateOperationIds?.[targetOpId]) return state;
          const next = { ...state.activeDuplicateOperationIds };
          delete next[targetOpId];
          return { activeDuplicateOperationIds: next };
        });
      };

      const isSelectedExampleStillPresent = (
        collections: Collection[],
        selection: SelectedSavedExample | null | undefined,
      ): boolean => {
        if (!selection) return false;
        const col = collections.find((c) => c.id === selection.collectionId);
        if (!col) return false;
        const item = findCollectionItemById(col.items, selection.itemId);
        if (!item || item.type !== 'request') return false;
        const inExamples = Array.isArray(item.examples)
          && item.examples.some((ex) => ex.id === selection.exampleId);
        const inSummaries = Array.isArray(item.exampleSummaries)
          && item.exampleSummaries.some((s) => s.id === selection.exampleId);
        return inExamples || inSummaries;
      };

      const pruneExampleTabsState = (
        state: Pick<ApiStoreState, 'openExampleTabs' | 'selectedExample' | 'tabOrder' | 'tabs'>,
        shouldKeep: (selection: SelectedSavedExample) => boolean,
      ): Pick<ApiStoreState, 'openExampleTabs' | 'selectedExample' | 'tabOrder'> => {
        const nextExampleTabs = (state.openExampleTabs || []).filter((ex) => shouldKeep(ex));
        const nextSelected = state.selectedExample && shouldKeep(state.selectedExample)
          ? state.selectedExample
          : null;
        return {
          openExampleTabs: nextExampleTabs,
          selectedExample: nextSelected,
          tabOrder: syncVisualTabOrder(state.tabs, nextExampleTabs, state.tabOrder),
        };
      };

      const ensureSavedExamplesCapability = async (forceCloudCheck = false): Promise<boolean> => {
        const live = get();
        if (isOfflineOnly) return false;
        if (!forceCloudCheck && live.workspaceMode !== 'cloud') return true;
        const isFresh =
          live.featurePolicyStatus === 'ready' &&
          live.featurePolicyFetchedAt !== null &&
          Date.now() - live.featurePolicyFetchedAt < FEATURE_POLICY_TTL_MS;
        let policy = live.featurePolicy;
        if (!isFresh || policy?.capabilities?.saved_examples !== true) {
          policy = await live.refreshFeaturePolicy(true);
        }
        return policy?.capabilities?.saved_examples === true;
      };

      const applyServerItemToCollectionsList = (
        cols: Collection[],
        collectionId: string,
        itemId: string,
        serverItem: any,
      ): Collection[] =>
        cols.map((col) => {
          if (col.id !== collectionId) return col;
          const updated = updateCollectionItemById(col.items || [], itemId, (item) =>
            applyServerItemToLocalItem(item, serverItem),
          );
          return updated.found ? { ...col, items: updated.items } : col;
        });

      const commitServerItemToStore = (
        collectionId: string,
        itemId: string,
        serverItem: any,
        targetScope?: ActiveScope,
        intentToRemove?: string,
      ) => {
        set((state) => {
          const nextIntents = intentToRemove
            ? withoutPendingExampleIntent(state.pendingExampleIntents, intentToRemove)
            : state.pendingExampleIntents;
          const isSameScope =
            !targetScope ||
            (state.workspaceMode === 'cloud' &&
              state.cloudConfig.activeScope?.id === targetScope.id &&
              state.cloudConfig.activeScope?.type === targetScope.type);
          if (isSameScope) {
            const nextCollections = applyServerItemToCollectionsList(
              state.collections,
              collectionId,
              itemId,
              serverItem,
            );
            return {
              collections: nextCollections,
              pendingExampleIntents: nextIntents,
              ...pruneExampleTabsState(state, (sel) => isSelectedExampleStillPresent(nextCollections, sel)),
            };
          }
          if (targetScope) {
            const scopeKey = getScopeCacheKey(targetScope);
            const entry = state.scopeCache?.[scopeKey];
            if (entry) {
              return {
                scopeCache: {
                  ...(state.scopeCache || {}),
                  [scopeKey]: {
                    ...entry,
                    collections: applyServerItemToCollectionsList(
                      entry.collections || [],
                      collectionId,
                      itemId,
                      serverItem,
                    ),
                  },
                },
                pendingExampleIntents: nextIntents,
              };
            }
          }
          return { pendingExampleIntents: nextIntents };
        });
      };

      const executeExampleIntent = async (
        intent: PendingExampleIntent,
        opts?: {
          preMutationCollections?: Collection[];
          apiUrl?: string;
          token?: string;
          refreshToken?: string;
          signal?: AbortSignal;
        },
      ): Promise<SavedExampleActionResult> => {
        if (inFlightExampleOperations.has(intent.operationId)) {
          return {
            success: false,
            reconcilePending: true,
            error: 'Saved example operation is already in progress.',
          };
        }
        inFlightExampleOperations.add(intent.operationId);
        const capturedSessionGen = cloudSessionGeneration;
        const operation = opts?.signal ? null : beginAsyncOperation();
        const signal = opts?.signal || operation?.controller.signal;
        let currentBaseVersion = intent.baseVersion ?? 1;
        const currentBaseExampleRev = intent.baseExampleRevision ?? 1;

        try {
          for (let attempt = 0; attempt < 4; attempt++) {
            const liveConfig = get().cloudConfig;
            const apiUrl = opts?.apiUrl || liveConfig.apiUrl;
            const token = opts?.token || liveConfig.token;
            const refreshToken = opts?.refreshToken ?? liveConfig.refreshToken;
            const currentOwnerKey = cloudCacheOwnerKey(liveConfig, normalizeCloudApiUrl);

            if (
              isStoreDisposed ||
              cloudSessionGeneration !== capturedSessionGen ||
              (intent.ownerKey !== null && currentOwnerKey !== intent.ownerKey)
            ) {
              return { success: false, error: 'Session or workspace changed before sync completed.' };
            }

            try {
              const serverItem = await patchScopeItemExamples(
                apiUrl,
                token,
                intent.itemId,
                {
                  operation_id: intent.operationId,
                  op: intent.op,
                  base_version: currentBaseVersion,
                  ...(intent.op === 'add' ? { example: intent.example } : {}),
                  ...(intent.op === 'rename'
                    ? {
                        example_id: intent.exampleId,
                        base_example_revision: currentBaseExampleRev,
                        name: intent.name,
                      }
                    : {}),
                  ...(intent.op === 'delete'
                    ? {
                        example_id: intent.exampleId,
                        base_example_revision: currentBaseExampleRev,
                      }
                    : {}),
                },
                refreshToken,
                signal,
              );

              if (
                isStoreDisposed ||
                cloudSessionGeneration !== capturedSessionGen ||
                (intent.ownerKey !== null &&
                  cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) !== intent.ownerKey)
              ) {
                return { success: false, error: 'Session changed before response could be applied.' };
              }

              commitServerItemToStore(
                intent.collectionId,
                intent.itemId,
                serverItem,
                intent.targetScope,
                intent.operationId,
              );
              await flushStorePersistence().catch(() => undefined);
              const matched = Array.isArray(serverItem?.examples)
                ? serverItem.examples.find((ex: SavedExample) => ex.id === intent.exampleId)
                : intent.example;
              return { success: true, example: matched };
            } catch (err: unknown) {
              if (signal?.aborted || isStoreDisposed || cloudSessionGeneration !== capturedSessionGen) {
                return { success: false, error: 'Operation cancelled.' };
              }

              if (err instanceof CloudApiError && err.status === 409 && attempt < 3) {
                try {
                  const latest = await fetchScopeItem(
                    apiUrl,
                    token,
                    intent.itemId,
                    refreshToken,
                    signal,
                  );
                  if (isStoreDisposed || cloudSessionGeneration !== capturedSessionGen) {
                    return { success: false, error: 'Operation cancelled.' };
                  }
                  const latestExamples: SavedExample[] = Array.isArray(latest?.examples) ? latest.examples : [];
                  const latestSummaries: SavedExampleSummary[] = Array.isArray(latest?.example_summaries)
                    ? latest.example_summaries
                    : [];

                  if (intent.op === 'add') {
                    if (latestExamples.some((ex) => ex.id === intent.exampleId)) {
                      commitServerItemToStore(intent.collectionId, intent.itemId, latest, intent.targetScope, intent.operationId);
                      await flushStorePersistence().catch(() => undefined);
                      return { success: true, example: latestExamples.find((ex) => ex.id === intent.exampleId) || intent.example };
                    }
                    const totalBytes =
                      latestExamples.reduce((sum, ex) => sum + getExampleUtf8ByteLength(JSON.stringify(ex)), 0) +
                      (intent.example ? getExampleUtf8ByteLength(JSON.stringify(intent.example)) : 0);
                    if (
                      latestExamples.length >= MAX_SAVED_EXAMPLES_PER_ITEM ||
                      totalBytes > MAX_SAVED_EXAMPLES_TOTAL_BYTES_PER_ITEM
                    ) {
                      commitServerItemToStore(intent.collectionId, intent.itemId, latest, intent.targetScope, intent.operationId);
                      await flushStorePersistence().catch(() => undefined);
                      return {
                        success: false,
                        error: 'Saved example limit reached on server item.',
                        code: 'LIMIT_EXCEEDED',
                      };
                    }
                    currentBaseVersion = typeof latest?.version === 'number' ? latest.version : currentBaseVersion;
                    continue;
                  }

                  const targetSummaryOrExample =
                    latestExamples.find((ex) => ex.id === intent.exampleId) ||
                    latestSummaries.find((s) => s.id === intent.exampleId);

                  if (intent.op === 'delete' && !targetSummaryOrExample) {
                    commitServerItemToStore(intent.collectionId, intent.itemId, latest, intent.targetScope, intent.operationId);
                    await flushStorePersistence().catch(() => undefined);
                    return { success: true };
                  }

                  if (
                    !targetSummaryOrExample ||
                    (typeof targetSummaryOrExample.revision === 'number' &&
                      targetSummaryOrExample.revision !== currentBaseExampleRev)
                  ) {
                    commitServerItemToStore(intent.collectionId, intent.itemId, latest, intent.targetScope, intent.operationId);
                    await flushStorePersistence().catch(() => undefined);
                    return {
                      success: false,
                      error:
                        intent.op === 'rename'
                          ? 'This saved example was modified or deleted on the server.'
                          : 'This saved example was modified on the server before deletion.',
                      code: 'CONFLICT',
                    };
                  }

                  currentBaseVersion = typeof latest?.version === 'number' ? latest.version : currentBaseVersion;
                  continue;
                } catch (fetchErr: unknown) {
                  if (fetchErr instanceof CloudApiError && (fetchErr.status === 403 || fetchErr.status === 404)) {
                    set((state) => ({
                      pendingExampleIntents: withoutPendingExampleIntent(state.pendingExampleIntents, intent.operationId),
                      ...(opts?.preMutationCollections && state.workspaceMode === 'cloud'
                        ? { collections: opts.preMutationCollections }
                        : {}),
                      ...(fetchErr.status === 404
                        ? pruneExampleTabsState(state, (sel) => sel.itemId !== intent.itemId)
                        : {}),
                    }));
                    await flushStorePersistence().catch(() => undefined);
                    return {
                      success: false,
                      error: fetchErr.status === 404 ? 'Item unavailable or deleted.' : fetchErr.message,
                      code: fetchErr.code,
                    };
                  }
                }
              }

              if (err instanceof CloudApiError && [400, 403, 404, 409, 413].includes(err.status)) {
                set((state) => ({
                  pendingExampleIntents: withoutPendingExampleIntent(state.pendingExampleIntents, intent.operationId),
                  ...(opts?.preMutationCollections ? { collections: opts.preMutationCollections } : {}),
                  ...(err.status === 404
                    ? pruneExampleTabsState(state, (sel) => sel.itemId !== intent.itemId)
                    : {}),
                }));
                await flushStorePersistence().catch(() => undefined);
                return {
                  success: false,
                  error: err.status === 404 ? 'Item unavailable or deleted.' : err.message,
                  code: err.code,
                };
              }

              const msg = err instanceof Error ? err.message : 'Failed to sync saved example.';
              set((state) => ({
                pendingExampleIntents: {
                  ...(state.pendingExampleIntents || {}),
                  [intent.operationId]: {
                    ...intent,
                    baseVersion: currentBaseVersion,
                    status: 'reconcile_required',
                    lastError: msg,
                  },
                },
              }));
              await flushStorePersistence().catch(() => undefined);
              return { success: false, reconcilePending: true, error: msg };
            }
          }

          return {
            success: false,
            reconcilePending: true,
            error: 'Saved example update conflicted repeatedly; sync to reconcile.',
          };
        } finally {
          inFlightExampleOperations.delete(intent.operationId);
          if (operation) completeAsyncOperation(operation);
        }
      };

      const replayPendingExampleIntentsForScope = async (
        targetScope: ActiveScope,
        apiUrl: string,
        token: string | undefined,
        refreshToken: string | undefined,
        signal: AbortSignal,
      ) => {
        const live = get();
        const ownerKey = cloudCacheOwnerKey(live.cloudConfig, normalizeCloudApiUrl);
        const pendingList = Object.values(live.pendingExampleIntents || {})
          .filter((intent) => {
            if (!intent) return false;
            if (intent.ownerKey !== null && ownerKey !== null && intent.ownerKey !== ownerKey) return false;
            if (intent.targetScope) {
              return intent.targetScope.id === targetScope.id && intent.targetScope.type === targetScope.type;
            }
            return true;
          })
          .sort((a, b) => a.createdAt - b.createdAt);

        for (const intent of pendingList) {
          if (signal.aborted || isStoreDisposed) break;
          await executeExampleIntent(intent, { apiUrl, token, refreshToken, signal });
        }
      };
      return {
      tabs: [defaultRequest],
      activeTabId: defaultRequest.id,
      activeResponse: null,
      tabResponses: {},
      tabRevealRevision: 0,
      isLoading: false,
      collections: [],
      history: [],
      sidebarTab: 'collections',
      canUndoActiveRequest: false,
      canRedoActiveRequest: false,
      theme: 'system',
      setTheme: (newTheme: ThemeMode) => {
        applyTheme(newTheme);
        set({ theme: newTheme });
      },
      environments: [],
      activeEnvironmentId: null,

      // Offline Workspaces
      offlineWorkspaces: [defaultOfflineWorkspace],
      activeOfflineWorkspaceId: DEFAULT_OFFLINE_WORKSPACE_ID,
      offlineScopeCache: {
        [DEFAULT_OFFLINE_WORKSPACE_ID]: {
          collections: [],
          environments: [],
          activeEnvironmentId: null,
          tabs: [defaultRequest],
          activeTabId: defaultRequest.id,
          history: [],
        },
      },

      // Workspace Mode & Cloud Sync State
      workspaceMode: allowsOfflineWorkspace ? 'offline' : 'cloud',
      hasConfiguredMode: isOfflineOnly || !allowsOfflineWorkspace,
      cloudConfig: {
        apiUrl: 'http://localhost:8080',
      },
      nativeCredentialState: undefined,
      featurePolicy: null,
      featurePolicyStatus: 'idle',
      featurePolicyFetchedAt: null,
      syncStatus: 'idle',
      lastSyncedAt: null,
      syncError: null,
      environmentOccConflict: null,
      scopeCache: {},
      cloudCacheOwner: null,
      cloudCacheArchives: emptyCloudCacheArchives(),
      openExampleTabs: [],
      tabOrder: [],
      selectedExample: null,
      pendingExampleIntents: {},
      pendingDuplicateIntents: {},
      activeDuplicateOperationIds: {},
      lastDuplicateReveal: null,
      scopesCache: undefined,
      isSwitchingWorkspace: false,

      setWorkspaceMode: (workspaceMode) => {
        if ((workspaceMode === 'offline' && !allowsOfflineWorkspace) || (workspaceMode === 'cloud' && isOfflineOnly)) return;
        const currentMode = get().workspaceMode;
        if (currentMode === workspaceMode) {
          if (!get().hasConfiguredMode) set({ hasConfiguredMode: true });
          return;
        }

        invalidateAsyncOperations();
        for (const key of Object.keys(tabUndoHistory)) {
          delete tabUndoHistory[key];
        }
        for (const key of Object.keys(undoTypingTimers)) {
          clearTimeout(undoTypingTimers[key]);
          delete undoTypingTimers[key];
        }
        set({ isSwitchingWorkspace: true });

        const state = get();
        const transition = prepareWorkspaceModeTransition({
          currentWorkspaceMode: currentMode,
          nextWorkspaceMode: workspaceMode,
          activeCloudScope: state.cloudConfig.activeScope,
          activeOfflineWorkspaceId: state.activeOfflineWorkspaceId,
          fallbackOfflineWorkspaceId: DEFAULT_OFFLINE_WORKSPACE_ID,
          offlineScopeCache: state.offlineScopeCache || {},
          scopeCache: state.scopeCache || {},
          resources: {
            collections: state.collections,
            environments: state.environments,
            activeEnvironmentId: state.activeEnvironmentId,
            tabs: state.tabs,
            activeTabId: state.activeTabId,
            history: state.history,
          },
          lastSyncedAt: state.lastSyncedAt,
          cacheTtlMs: SCOPE_CACHE_TTL_MS,
          createInitialTab,
        });

        if (workspaceMode === 'offline') {
          revokeUnreferencedTabBlobs(get().tabResponses, get().activeResponse, [
            transition.targetResources.history,
            ...Object.values(transition.scopeCache).map((entry) => entry.history),
            ...Object.values(get().offlineScopeCache || {}).map((e) => e.history),
          ]);

          set({
            workspaceMode: 'offline',
            hasConfiguredMode: true,
            scopeCache: transition.scopeCache,
            collections: transition.targetResources.collections,
            environments: transition.targetResources.environments,
            activeEnvironmentId: transition.targetResources.activeEnvironmentId,
            tabs: transition.targetResources.tabs,
            activeTabId: transition.targetResources.activeTabId,
            openExampleTabs: [],
            tabOrder: transition.targetResources.tabs.map((t) => t.id),
            selectedExample: null,
            activeResponse: null,
            tabResponses: {},
            isLoading: false,
            history: transition.targetResources.history,
            syncStatus: 'idle',
            syncError: null,
          });

          safeSetTimeout(() => {
            set({ isSwitchingWorkspace: false });
          }, 250);
        } else {
          revokeUnreferencedTabBlobs(get().tabResponses, get().activeResponse, [
            transition.targetResources.history,
            ...Object.values(transition.offlineScopeCache).map((entry) => entry.history),
            ...Object.values(transition.scopeCache).map((entry) => entry.history),
          ]);

          set({
            workspaceMode: isOfflineOnly ? 'offline' : 'cloud',
            hasConfiguredMode: true,
            offlineScopeCache: transition.offlineScopeCache,
            collections: transition.targetResources.collections,
            environments: transition.targetResources.environments,
            activeEnvironmentId: transition.targetResources.activeEnvironmentId,
            tabs: transition.targetResources.tabs,
            activeTabId: transition.targetResources.activeTabId,
            openExampleTabs: [],
            tabOrder: transition.targetResources.tabs.map((t) => t.id),
            selectedExample: null,
            activeResponse: null,
            tabResponses: {},
            isLoading: false,
            history: transition.targetResources.history,
            lastSyncedAt: transition.targetCache?.lastSyncedAt || null,
            syncStatus: transition.isCloudCacheFresh ? 'synced' : (state.cloudConfig.activeScope ? 'syncing' : 'idle'),
            syncError: null,
          });

          if (!isOfflineOnly && state.cloudConfig.activeScope && isCloudSessionActive(state.cloudConfig) && !transition.isCloudCacheFresh) {
            get()
              .pullCloudDelta()
              .finally(() => {
                set({ isSwitchingWorkspace: false });
              });
          } else {
            safeSetTimeout(() => {
              set({ isSwitchingWorkspace: false });
            }, 100);
          }
        }
      },
      setHasConfiguredMode: (hasConfiguredMode) =>
        set({
          hasConfiguredMode: isOfflineOnly || !allowsOfflineWorkspace ? true : hasConfiguredMode,
        }),
      setCloudConfig: (updates) => {
        if (isOfflineOnly) return;
        const before = get();
        const currentConfig = before.cloudConfig;
        const { updates: normalizedUpdates, startsNewSession } = prepareCloudSessionUpdate(
          currentConfig,
          updates,
          normalizeCloudApiUrl,
        );
        let nextConfig = { ...currentConfig, ...normalizedUpdates };
        const currentOwner = isCloudSessionActive(currentConfig) ? cloudCacheOwnerKey(currentConfig, normalizeCloudApiUrl) : null;
        const nextOwner = isCloudSessionActive(nextConfig) ? cloudCacheOwnerKey(nextConfig, normalizeCloudApiUrl) : null;
        const sessionChanged = startsNewSession || currentOwner !== nextOwner;
        let cacheTransition: Partial<ApiStoreState> = {};
        if (currentOwner !== nextOwner || startsNewSession) {
          if (!Object.prototype.hasOwnProperty.call(normalizedUpdates, 'activeScope')) {
            normalizedUpdates.activeScope = undefined;
            nextConfig = { ...nextConfig, activeScope: undefined };
          }
          const cloudCandidates: Array<ApiResponse | null | undefined> = [
            ...(before.workspaceMode === 'cloud'
              ? [before.activeResponse, ...Object.values(before.tabResponses || {}), ...before.history.map((h) => h.response)]
              : []),
            ...Object.values(before.scopeCache || {}).flatMap((entry) => (entry.history || []).map((h) => h.response)),
          ];
          const protectedResponses: Array<ApiResponse | null | undefined> = before.workspaceMode === 'offline'
            ? [before.activeResponse, ...Object.values(before.tabResponses || {})]
            : [];
          const protectedHistories: Array<Array<HistoryItem> | undefined> = [
            ...(before.workspaceMode === 'offline' ? [before.history] : []),
            ...Object.values(before.offlineScopeCache || {}).map((e) => e.history),
          ];
          revokeUnreferencedResponses(cloudCandidates, protectedResponses, protectedHistories);

          const snapshot = captureCloudCache({
            config: currentConfig,
            workspaceMode: before.workspaceMode,
            scopeCache: before.scopeCache || {},
            scopesCache: before.scopesCache,
            resources: before,
            lastSyncedAt: before.lastSyncedAt,
          });
          const provenOwner = before.cloudCacheOwner === currentOwner ? currentOwner : null;
          const cloudCacheArchives = archiveCloudCache(before.cloudCacheArchives, provenOwner, snapshot);
          const target = readCloudCache(cloudCacheArchives, nextOwner);
          cacheTransition = {
            cloudCacheArchives,
            cloudCacheOwner: nextOwner,
            scopeCache: target.scopeCache,
            // A provider may have lost scope access since this cache was saved.
            scopesCache: nextConfig.sessionKind === 'provider' ? undefined : target.scopesCache,
          };
          if (before.workspaceMode === 'cloud') {
            const targetSnapshot = getArchivedScope(target, nextConfig.activeScope);
            const resources = restoreWorkspaceResources(targetSnapshot, createInitialTab);
            cacheTransition = {
              ...cacheTransition,
              ...resources,
              activeResponse: null,
              tabResponses: {},
              isLoading: false,
              lastSyncedAt: targetSnapshot?.lastSyncedAt || null,
              syncStatus: 'idle',
              syncError: null,
            };
          }
        }
        if (sessionChanged) {
          nativeCredentialOperation += 1;
          invalidateAsyncOperations({ session: true });
        }
        const nextNativeScope = getNativeCredentialScope(nextConfig);
        const retainsNativeCredentialState = nextConfig.sessionKind !== 'provider' &&
          sameNativeCredentialScope(before.nativeCredentialState?.scope, nextNativeScope);
        set((state) => ({
          ...cacheTransition,
          cloudConfig: { ...state.cloudConfig, ...normalizedUpdates },
          ...(sessionChanged && !retainsNativeCredentialState ? { nativeCredentialState: undefined } : {}),
          ...(sessionChanged
            ? { featurePolicy: null, featurePolicyStatus: 'idle' as FeaturePolicyStatus, featurePolicyFetchedAt: null }
            : {}),
        }));
        if (!isOfflineOnly && isCloudSessionActive(get().cloudConfig)) {
          void get().refreshFeaturePolicy(sessionChanged);
        }
      },
      setCloudSession: async (updates) => {
        if (isOfflineOnly) return;
        const current = get().cloudConfig;
        const next = { ...current, ...updates };
        const isProviderSession = next.sessionKind === 'provider';
        if (credentialStorage && !isProviderSession && next.token) {
          const scope = getNativeCredentialScope(next);
          if (!scope) throw new Error('Cannot save cloud credentials without a server and signed-in account.');
          const record = {
            accessToken: next.token,
            ...(next.refreshToken ? { refreshToken: next.refreshToken } : {}),
            ...(next.tokenExpiresAt ? { expiresAt: next.tokenExpiresAt } : {}),
          };
          const operation = ++nativeCredentialOperation;
          await enqueueNativeCredentialOperation(async () => {
            if (operation !== nativeCredentialOperation || isStoreDisposed) return;
            await credentialStorage.write(scope, record);
            if (operation !== nativeCredentialOperation || isStoreDisposed) return;
            const confirmed = await credentialStorage.read(scope);
            if (!nativeCredentialRecordMatches(record, confirmed)) {
              throw new Error('Protected credential storage did not confirm the saved session.');
            }
            if (operation !== nativeCredentialOperation || isStoreDisposed) return;
            const cleanupPending = Boolean(
              get().nativeCredentialCleanupPending || get().nativeCredentialState?.phase === 'cleanup-pending',
            );
            get().setNativeCredentialState({
              version: 1,
              scope,
              phase: cleanupPending ? 'cleanup-pending' : 'ready',
            });
            get().setCloudConfig(updates);
            if (cleanupPending) {
              void get().completePendingCredentialCleanup().catch(() => undefined);
            }
          });
          return;
        }
        get().setCloudConfig(updates);
      },
      clearCloudCredentials: async (requestedScope) => {
        const scope = requestedScope || getNativeCredentialScope(get().cloudConfig);
        if (!credentialStorage || !scope) return;
        nativeCredentialOperation += 1;
        await enqueueNativeCredentialOperation(async () => {
          await credentialStorage.remove(scope);
        });
      },
      setNativeCredentialState: (nativeCredentialState) => set({ nativeCredentialState }),
      persistNativeCredentialState: async () => {
        const options = store.persist.getOptions();
        const partialize = options.partialize;
        const persistedState = partialize ? partialize(get()) : get();
        const serialized = JSON.stringify({ state: persistedState, version: options.version ?? 0 });
        const name = options.name;
        if (!name) throw new Error('Application storage has no persistence key.');
        if (customStorage === appStorage) {
          await setItemInAllPersistenceCopies(name, serialized);
        } else {
          await customStorage.setItem(name, serialized);
        }
      },
      completePendingCredentialCleanup: async () => {
        if (!credentialStorage || isStoreDisposed) return false;
        if (cleanupInFlight) return cleanupInFlight;
        const task = (async () => {
          const current = get();
          if (current.nativeCredentialState?.phase === 'legacy-pending') return false;
          if (!current.nativeCredentialCleanupPending && current.nativeCredentialState?.phase !== 'cleanup-pending') {
            return true;
          }
          if (!current.nativeCredentialCleanupPending) {
            set({ nativeCredentialCleanupPending: true });
          }
          await get().persistNativeCredentialState();
          if (isStoreDisposed) return false;
          if (get().nativeCredentialState?.phase === 'legacy-pending') return false;
          set((state) => ({
            nativeCredentialCleanupPending: false,
            ...(state.nativeCredentialState?.phase === 'cleanup-pending'
              ? { nativeCredentialState: { ...state.nativeCredentialState, phase: 'ready' } }
              : {}),
          }));
          return true;
        })().finally(() => {
          cleanupInFlight = null;
        });
        cleanupInFlight = task;
        return task;
      },
      recoverNativeCredentials: async (options) => {
        const isCancelled = () => isStoreDisposed || Boolean(options?.isCancelled?.());
        if (!credentialStorage || isCancelled() || isOfflineOnly) return;

        const initialConfig = get().cloudConfig;
        const scope = getNativeCredentialScope(initialConfig);
        if (!scope || initialConfig.sessionKind === 'provider') {
          if (
            (get().nativeCredentialCleanupPending || get().nativeCredentialState?.phase === 'cleanup-pending') &&
            get().nativeCredentialState?.phase !== 'legacy-pending'
          ) {
            await get().completePendingCredentialCleanup();
          }
          return;
        }

        const initialGeneration = cloudSessionGeneration;
        const initialNativeState = get().nativeCredentialState;
        const operation = ++nativeCredentialOperation;
        const hasCurrentScope = () =>
          !isCancelled() &&
          sameNativeCredentialScope(getNativeCredentialScope(get().cloudConfig), scope) &&
          sameNativeCredentialScope(get().nativeCredentialState?.scope, scope);
        const isCurrentRestore = () =>
          operation === nativeCredentialOperation &&
          cloudSessionGeneration === initialGeneration &&
          hasCurrentScope();

        const applyRestoredTokens = (record: {
          accessToken: string;
          refreshToken?: string;
          expiresAt?: string;
        }) => {
          const before = get();
          const currentConfig = before.cloudConfig;
          if (!sameNativeCredentialScope(getNativeCredentialScope(currentConfig), scope) || currentConfig.sessionKind === 'provider') {
            return;
          }
          const nextConfig: CloudConfig = {
            ...currentConfig,
            token: record.accessToken,
            refreshToken: record.refreshToken,
            tokenExpiresAt: record.expiresAt,
          };
          const nextOwner = isCloudSessionActive(nextConfig) ? cloudCacheOwnerKey(nextConfig, normalizeCloudApiUrl) : null;
          const preservesVerifiedOwner = Boolean(
            nextOwner &&
            before.cloudCacheOwner === nextOwner &&
            sameNativeCredentialScope(before.nativeCredentialState?.scope, scope),
          );
          if (!preservesVerifiedOwner) {
            get().setCloudConfig({
              token: record.accessToken,
              refreshToken: record.refreshToken,
              tokenExpiresAt: record.expiresAt,
            });
            return;
          }
          if (!currentConfig.token) {
            invalidateAsyncOperations({ session: true });
          }
          set((state) => ({
            cloudConfig: {
              ...state.cloudConfig,
              token: record.accessToken,
              refreshToken: record.refreshToken,
              tokenExpiresAt: record.expiresAt,
            },
            featurePolicy: null,
            featurePolicyStatus: 'idle' as FeaturePolicyStatus,
            featurePolicyFetchedAt: null,
          }));
          if (isCloudSessionActive(get().cloudConfig)) {
            void get().refreshFeaturePolicy(true);
          }
        };

        const restoreRecord = async (record: {
          accessToken: string;
          refreshToken?: string;
          expiresAt?: string;
        }) => {
          if (!isCurrentRestore()) return;
          const requiresCleanup =
            initialNativeState?.phase === 'legacy-pending' ||
            initialNativeState?.phase === 'cleanup-pending' ||
            Boolean(get().nativeCredentialCleanupPending);
          if (requiresCleanup) {
            set({
              nativeCredentialCleanupPending: true,
              nativeCredentialState: { version: 1, scope, phase: 'cleanup-pending' },
            });
          }
          applyRestoredTokens(record);
          if (!requiresCleanup) return;
          if (!hasCurrentScope() || operation !== nativeCredentialOperation || get().cloudConfig.token !== record.accessToken) {
            return;
          }
          await get().completePendingCredentialCleanup();
        };

        await enqueueNativeCredentialOperation(async () => {
          if (!isCurrentRestore()) return;
          let vaulted: { accessToken: string; refreshToken?: string; expiresAt?: string } | null;
          try {
            vaulted = await credentialStorage.read(scope);
          } catch (error) {
            if (
              (get().nativeCredentialCleanupPending || get().nativeCredentialState?.phase === 'cleanup-pending') &&
              get().nativeCredentialState?.phase !== 'legacy-pending' &&
              !get().cloudConfig.token
            ) {
              await get().completePendingCredentialCleanup().catch(() => false);
            }
            throw error;
          }
          if (!isCurrentRestore()) return;

          if (vaulted) {
            await restoreRecord(vaulted);
            return;
          }

          const latestCurrent = get().cloudConfig;
          if (!latestCurrent.token) {
            if (
              (get().nativeCredentialCleanupPending || get().nativeCredentialState?.phase === 'cleanup-pending') &&
              get().nativeCredentialState?.phase !== 'legacy-pending'
            ) {
              await get().completePendingCredentialCleanup().catch(() => false);
            }
            if (!isCurrentRestore()) return;
            get().logoutCloud();
            return;
          }

          const legacyRecord = {
            accessToken: latestCurrent.token,
            ...(latestCurrent.refreshToken ? { refreshToken: latestCurrent.refreshToken } : {}),
            ...(latestCurrent.tokenExpiresAt ? { expiresAt: latestCurrent.tokenExpiresAt } : {}),
          };
          await credentialStorage.write(scope, legacyRecord);
          if (!isCurrentRestore()) return;
          const confirmed = await credentialStorage.read(scope);
          if (!isCurrentRestore()) return;
          if (!nativeCredentialRecordMatches(legacyRecord, confirmed)) {
            throw new Error('Protected credential storage did not confirm the migrated session.');
          }
          await restoreRecord(legacyRecord);
        });
      },
      signOutCloud: async (options) => {
        if (signOutInFlight) return signOutInFlight;
        const task = (async () => {
          const generation = get().getCloudSessionGeneration();
          const config = get().cloudConfig;
          const credentialScope = getNativeCredentialScope(config);
          try {
            await options?.authProvider?.signOut?.({
              apiUrl: config.apiUrl || '',
              user: config.user,
              accessToken: config.token,
              refreshToken: config.refreshToken,
            });
          } catch (error) {
            console.warn('Provider sign-out failed:', error);
          }
          if (isStoreDisposed || get().getCloudSessionGeneration() !== generation || get().cloudConfig !== config) {
            return { success: false };
          }
          if (credentialScope && config.sessionKind !== 'provider') {
            try {
              await get().clearCloudCredentials(credentialScope);
            } catch (error) {
              console.warn('Sign-out could not clear protected credentials:', error);
              const message = 'Sign-out could not clear protected credentials. Please try again.';
              if (!isStoreDisposed && get().getCloudSessionGeneration() === generation) {
                set({ syncStatus: 'error', syncError: message });
              }
              return { success: false, error: message };
            }
          }
          if (isStoreDisposed || get().getCloudSessionGeneration() !== generation || get().cloudConfig !== config) {
            return { success: false };
          }
          get().logoutCloud();
          return { success: true };
        })().finally(() => {
          signOutInFlight = null;
        });
        signOutInFlight = task;
        return task;
      },
      evictCloudSession: (requestedScope) => {
        const currentConfig = get().cloudConfig;
        const scope = requestedScope || getNativeCredentialScope(currentConfig);
        if (scope && currentConfig.sessionKind !== 'provider') {
          void get().clearCloudCredentials(scope).catch((error: unknown) => {
            console.warn('Could not remove expired credentials:', error);
          });
        }
        get().logoutCloud();
      },
      getCloudSessionGeneration: () => cloudSessionGeneration,
      getCloudCacheRecoveryCount: () => {
        const state = get();
        const currentOwner = cloudCacheOwnerKey(state.cloudConfig, normalizeCloudApiUrl);
        const owned = isCloudSessionActive(state.cloudConfig) && currentOwner && state.cloudCacheOwner === currentOwner
          ? state.cloudCacheArchives.owners[currentOwner]?.unscoped?.length || 0 : 0;
        return state.cloudCacheArchives.unclaimed.length + owned;
      },
      getCloudCacheRecoveryBackup: () => {
        const state = get();
        const currentOwner = cloudCacheOwnerKey(state.cloudConfig, normalizeCloudApiUrl);
        const owned = isCloudSessionActive(state.cloudConfig) && currentOwner && state.cloudCacheOwner === currentOwner
          ? state.cloudCacheArchives.owners[currentOwner]?.unscoped || [] : [];
        const safe = serializeCloudCacheArchives({
          version: 1,
          owners: {},
          unclaimed: [...state.cloudCacheArchives.unclaimed, ...(owned.length ? [{ scopeCache: {}, unscoped: owned }] : [])],
        }, {
          serializeRequest: serializeRequestAttachments,
          serializeCollection: serializeCollectionAttachments,
          serializeHistory: serializeHistoryAttachments,
        });
        return JSON.stringify({
          format: 'AirREST cloud cache recovery', version: 1, archives: safe.unclaimed,
          ...(state.cloudCacheArchives.unsupportedVersions?.length
            ? { unsupportedArchives: state.cloudCacheArchives.unsupportedVersions } : {}),
        }, null, 2);
      },
      importCloudCacheRecoveryBackup: (serialized) => {
        const imported = importCloudCacheRecoveryBackup(get().cloudCacheArchives, serialized);
        if (!imported.success) {
          return { success: false, archiveCount: 0, unsupportedArchiveCount: 0, error: imported.error };
        }
        set({ cloudCacheArchives: normalizeCloudCacheArchives(imported.archives, {
          normalizeRequest: normalizePersistedRequestAttachments,
          normalizeCollections: (collections: Collection[]) => ensureUniqueCollectionItemIds(
            collections.map(normalizeCollectionAttachments),
          ),
          normalizeHistory: normalizeHistoryAttachments,
        }) });
        return {
          success: true,
          archiveCount: imported.archiveCount,
          unsupportedArchiveCount: imported.unsupportedArchiveCount,
        };
      },
      recoverCloudCachesToOfflineWorkspaces: () => {
        if (!allowsOfflineWorkspace) return { success: false, workspaceCount: 0, error: 'Offline workspaces are disabled for this product.' };
        const state = get();
        const currentOwner = cloudCacheOwnerKey(state.cloudConfig, normalizeCloudApiUrl);
        const owned = isCloudSessionActive(state.cloudConfig) && currentOwner && state.cloudCacheOwner === currentOwner
          ? state.cloudCacheArchives.owners[currentOwner]?.unscoped || [] : [];
        const snapshots = [
          ...state.cloudCacheArchives.unclaimed.flatMap((archive) => [
            ...Object.values(archive.scopeCache), ...(archive.unscoped || []),
          ]),
          ...owned,
        ];
        if (!snapshots.length) return { success: false, workspaceCount: 0, error: 'No preserved workspace data is available.' };
        const now = Date.now();
        const recovered: OfflineWorkspace[] = [];
        const offlineScopeCache = { ...(state.offlineScopeCache || {}) };
        for (const [index, snapshot] of snapshots.entries()) {
          const id = `ws_recovered_${generateId()}`;
          recovered.push({ id, name: `Recovered workspace ${index + 1}`, createdAt: now, updatedAt: now });
          const restored = restoreWorkspaceResources(snapshot, createInitialTab);
          offlineScopeCache[id] = {
            ...restored,
            collections: restored.collections.map((collection) => ({
              ...cloneCollectionPreservingAttachments(collection), _origin: 'offline', _syncStatus: 'synced',
            })),
            environments: JSON.parse(JSON.stringify(restored.environments)),
            tabs: restored.tabs.map(cloneRequestPreservingAttachments),
            history: restored.history.map((entry) => ({
              ...entry,
              request: cloneRequestPreservingAttachments(entry.request),
              response: entry.response ? { ...entry.response } : undefined,
            })),
          };
        }
        set({ offlineWorkspaces: [...(state.offlineWorkspaces || [defaultOfflineWorkspace]), ...recovered], offlineScopeCache });
        return { success: true, workspaceCount: recovered.length };
      },
      refreshFeaturePolicy: async (force = false) => {
        if (isOfflineOnly) return null;
        const state = get();
        const { cloudConfig, featurePolicyFetchedAt, featurePolicyStatus } = state;
        if (!isCloudSessionActive(cloudConfig)) return null;
        const isFresh = featurePolicyFetchedAt !== null && Date.now() - featurePolicyFetchedAt < FEATURE_POLICY_TTL_MS;
        if (!force && isFresh && featurePolicyStatus === 'ready') return state.featurePolicy;

        const requestKey = `${cloudSessionGeneration}:${cloudConfig.apiUrl}`;
        if (!force && activeFeaturePolicyPromise && activeFeaturePolicyKey === requestKey) {
          return activeFeaturePolicyPromise;
        }

        const operation = sessionOperations.begin();
        set({ featurePolicyStatus: 'loading' });
        const policyRef: { current: Promise<FeaturePolicy | null> | null } = { current: null };
        const fetchPromise = (async () => {
          try {
            const policy = await fetchFeaturePolicyForRuntime(cloudConfig.apiUrl, cloudConfig.token, cloudConfig.refreshToken, operation.controller.signal);
            if (!sessionOperations.isCurrent(operation)) return null;
            set({ featurePolicy: policy, featurePolicyStatus: 'ready', featurePolicyFetchedAt: Date.now() });
            return policy;
          } catch (err) {
            if (!sessionOperations.isCurrent(operation)) return null;
            console.error('Failed to refresh feature policy:', err);
            set({ featurePolicyStatus: 'error' });
            return null;
          } finally {
            if (activeFeaturePolicyPromise === policyRef.current) {
              activeFeaturePolicyPromise = null;
              activeFeaturePolicyKey = null;
            }
            sessionOperations.complete(operation);
          }
        })();
        policyRef.current = fetchPromise;

        activeFeaturePolicyPromise = fetchPromise;
        activeFeaturePolicyKey = requestKey;
        return fetchPromise;
      },
      isFeatureEnabled: (feature) => {
        const state = get();
        if (isOfflineOnly || state.workspaceMode === 'offline') return true;
        const isFresh = state.featurePolicyFetchedAt !== null && Date.now() - state.featurePolicyFetchedAt < FEATURE_POLICY_TTL_MS;
        return state.featurePolicyStatus === 'ready' && isFresh && state.featurePolicy?.flags[feature] === true;
      },
      setActiveScope: async (scope, forceSync = false) => {
        if (scope.type === 'offline_workspace') {
          if (allowsOfflineWorkspace) get().switchOfflineWorkspace(scope.id);
          return;
        }
        if (isOfflineOnly) return;
        const {
          workspaceMode,
          collections,
          environments,
          activeEnvironmentId,
          cloudConfig,
          scopeCache,
          lastSyncedAt,
          tabs,
          activeTabId,
          history,
        } = get();

        const isSameScope = isActiveCloudScope(workspaceMode, cloudConfig.activeScope, scope);
        if (cloudConfig.sessionKind === 'provider' && !isSameScope) {
          const available = get().scopesCache;
          const allowed = scope.type === 'workspace'
            ? available?.workspaces.some((workspace) => workspace.id === scope.id)
            : scope.type === 'project' && Object.values(available?.teamProjects || {})
              .some((projects) => projects.some((project) => project.id === scope.id));
          if (!allowed) {
            set({ syncError: 'This workspace or project has not been verified for the current session.' });
            return;
          }
        }
        if (isSameScope && !forceSync && get().syncStatus !== 'idle') {
          return;
        }

        const transition = prepareCloudScopeTransition({
          workspaceMode,
          activeCloudScope: cloudConfig.activeScope,
          targetScope: scope,
          activeOfflineWorkspaceId: get().activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID,
          offlineScopeCache: get().offlineScopeCache || {},
          scopeCache: scopeCache || {},
          resources: {
            collections,
            environments,
            activeEnvironmentId,
            tabs,
            activeTabId,
            history,
          },
          lastSyncedAt,
          forceSync,
          cacheTtlMs: SCOPE_CACHE_TTL_MS,
          createInitialTab,
        });

        if (!isSameScope || forceSync) invalidateAsyncOperations();

        revokeUnreferencedTabBlobs(get().tabResponses, get().activeResponse, [
          transition.targetCache?.history,
          ...Object.values(transition.scopeCache).map((entry) => entry.history),
          ...Object.values(transition.offlineScopeCache).map((entry) => entry.history),
        ]);

        set((state) => ({
          workspaceMode: 'cloud',
          cloudConfig: {
            ...state.cloudConfig,
            activeScope: scope,
          },
          scopeCache: transition.scopeCache,
          ...(workspaceMode === 'offline' ? { offlineScopeCache: transition.offlineScopeCache } : {}),
          collections: transition.targetResources.collections,
          environments: transition.targetResources.environments,
          activeEnvironmentId: transition.targetResources.activeEnvironmentId,
          tabs: transition.targetResources.tabs,
          activeTabId: transition.targetResources.activeTabId,
          openExampleTabs: [],
          tabOrder: transition.targetResources.tabs.map((t) => t.id),
          activeResponse: null,
          tabResponses: {},
          selectedExample: null,
          isLoading: false,
          history: transition.targetResources.history,
          lastSyncedAt: transition.targetCache?.lastSyncedAt || null,
          syncStatus: transition.isFresh ? 'synced' : 'syncing',
          syncError: null,
        }));

        // The policy is global, but refresh it on every cloud scope change so
        // a user does not keep an old capability snapshot while navigating.
        void get().refreshFeaturePolicy(true);

        if (!transition.isFresh) {
          set({ isSwitchingWorkspace: true });
          try {
            await get().pullCloudDelta();
          } finally {
            set({ isSwitchingWorkspace: false });
          }
        }
      },
      logoutCloud: () => {
        nativeCredentialOperation += 1;
        invalidateAsyncOperations({ session: true });
        set({ isSwitchingWorkspace: true });
        const { offlineScopeCache, activeOfflineWorkspaceId } = get();
        const activeLocalId = activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
        const localEntry = allowsOfflineWorkspace
          ? (offlineScopeCache || {})[activeLocalId] || createEmptyWorkspaceSnapshot(createInitialTab)
          : createEmptyWorkspaceSnapshot(createInitialTab);
        const restoredResources = restoreWorkspaceResources(localEntry, createInitialTab);

        const currentState = get();
        const captured = captureCloudCache({
          config: currentState.cloudConfig,
          workspaceMode: currentState.workspaceMode,
          scopeCache: currentState.scopeCache || {},
          scopesCache: currentState.scopesCache,
          resources: currentState,
          lastSyncedAt: currentState.lastSyncedAt,
        });
        const cloudCacheArchives = archiveCloudCache(
          currentState.cloudCacheArchives,
          currentState.cloudCacheOwner === cloudCacheOwnerKey(currentState.cloudConfig, normalizeCloudApiUrl)
            ? currentState.cloudCacheOwner : null,
          captured,
        );
        const candidateResponses: Array<ApiResponse | null | undefined> = [
          currentState.activeResponse,
          ...Object.values(currentState.tabResponses || {}),
          ...currentState.history.map((h) => h.response),
          ...Object.values(currentState.scopeCache || {}).flatMap((entry) =>
            (entry.history || []).map((h) => h.response)
          ),
        ];
        revokeUnreferencedResponses(candidateResponses, [], [
          localEntry.history,
          ...Object.values(offlineScopeCache || {}).map((entry) => entry.history),
        ]);

        const preserveCleanupPending = Boolean(
          currentState.nativeCredentialCleanupPending || currentState.nativeCredentialState?.phase === 'cleanup-pending',
        );

        set((state) => ({
          workspaceMode: allowsOfflineWorkspace ? 'offline' : 'cloud',
          collections: restoredResources.collections,
          environments: restoredResources.environments,
          activeEnvironmentId: restoredResources.activeEnvironmentId,
          tabs: restoredResources.tabs,
          activeTabId: restoredResources.activeTabId,
          openExampleTabs: [],
          tabOrder: restoredResources.tabs.map((t) => t.id),
          activeResponse: null,
          tabResponses: {},
          selectedExample: null,
          isLoading: false,
          history: restoredResources.history,
          scopeCache: {},
          cloudCacheOwner: null,
          cloudCacheArchives,
          scopesCache: undefined,
          cloudConfig: {
            apiUrl: state.cloudConfig.apiUrl || 'http://localhost:8080',
          },
          nativeCredentialState: undefined,
          nativeCredentialCleanupPending: preserveCleanupPending ? true : undefined,
          featurePolicy: null,
          featurePolicyStatus: 'idle',
          featurePolicyFetchedAt: null,
          syncStatus: 'idle',
          syncError: null,
          lastSyncedAt: null,
        }));

        if (preserveCleanupPending && credentialStorage) {
          void get().completePendingCredentialCleanup().catch(() => undefined);
        }

        safeSetTimeout(() => {
          set({ isSwitchingWorkspace: false });
        }, 250);
      },
      setSyncStatus: (syncStatus, syncError = null) => set({ syncStatus, syncError }),
      pullCloudDelta: async () => {
        if (isOfflineOnly || movingCollections.size > 0 || duplicatingCollections.size > 0) return;
        const { workspaceMode, cloudConfig } = get();
        if (workspaceMode !== 'cloud' || !isCloudSessionActive(cloudConfig) || !cloudConfig.activeScope) {
          return;
        }
        activePullOperation?.controller.abort();
        const operation = beginAsyncOperation();
        activePullOperation = operation;
        const requestedScope = cloudConfig.activeScope;
        const token = cloudConfig.token;
        set({ syncStatus: 'syncing', syncError: null });
        try {
          const syncResult = await synchronizeCloudWorkspace({
            currentCollections: get().collections || [],
            replayPendingExampleIntents: () =>
              replayPendingExampleIntentsForScope(
                requestedScope,
                cloudConfig.apiUrl,
                token,
                cloudConfig.refreshToken,
                operation.controller.signal,
              ),
            uploadPendingCollection: async (collection) => batchImportToScope(
              cloudConfig.apiUrl,
              token,
              requestedScope,
              [collection],
              cloudConfig.refreshToken,
              operation.controller.signal,
            ),
            fetchCollectionMetadata: () => fetchScopeCollectionsForRuntime(
              cloudConfig.apiUrl,
              token,
              requestedScope,
              cloudConfig.refreshToken,
              operation.controller.signal,
            ),
            fetchCollectionDetail: (collectionId) => fetchCollectionByIdForRuntime(
              cloudConfig.apiUrl,
              token,
              collectionId,
              cloudConfig.refreshToken,
              operation.controller.signal,
            ),
            fetchEnvironments: () => fetchScopeEnvironmentsForRuntime(
              cloudConfig.apiUrl,
              cloudConfig.token,
              requestedScope,
              cloudConfig.refreshToken,
              operation.controller.signal,
            ),
            buildCollection: buildCollectionFromDetails,
            buildEnvironments: buildEnvironmentsFromDelta,
            isCurrent: () => isAsyncOperationCurrent(operation),
            isAborted: () => operation.controller.signal.aborted,
            onPendingCollectionUploaded: (collection) => set((state) => ({
              collections: state.collections.map((candidate) =>
                candidate.id === collection.id ? { ...candidate, _syncStatus: 'synced' } : candidate,
              ),
            })),
            onCollectionDetailFetchError: (metadata, error) => console.warn(`Failed to fetch details for collection ${metadata.id}:`, error),
          });
          if (syncResult.status === 'cancelled') return;
          if (syncResult.status === 'push_failed') {
            console.warn(`Failed to push pending collection "${syncResult.collection.name}" to cloud:`, syncResult.error);
            const errorMessage = syncResult.error instanceof Error ? syncResult.error.message : String(syncResult.error);
            set({
              syncStatus: 'error',
              syncError: errorMessage || `Failed to upload pending collection "${syncResult.collection.name}"`,
            });
            return;
          }
          const currentState = get();
          const currentOwnerKey = cloudCacheOwnerKey(currentState.cloudConfig, normalizeCloudApiUrl);
          const overlaidCollections = overlayPendingExampleIntentsOnCollections(
            syncResult.collections,
            currentState.pendingExampleIntents,
            currentOwnerKey,
            requestedScope,
          );
          const deltaState = prepareCloudDeltaState({
            scope: requestedScope,
            scopeCache: currentState.scopeCache || {},
            collections: overlaidCollections,
            currentCollections: currentState.collections,
            pulledEnvironments: syncResult.environments,
            currentEnvironments: currentState.environments || [],
            activeEnvironmentId: currentState.activeEnvironmentId,
            tabs: currentState.tabs,
            activeTabId: currentState.activeTabId,
            history: currentState.history,
            partialCollectionCount: syncResult.partialCollectionCount,
            syncedAt: Date.now(),
          });

          set({
            ...deltaState,
            ...pruneExampleTabsState(currentState, (sel) => isSelectedExampleStillPresent(deltaState.collections, sel)),
          });
        } catch (err: unknown) {
          if (!isAsyncOperationCurrent(operation)) return;
          const errorMsg = err instanceof Error ? err.message : String(err);
          set({
            syncStatus: 'error',
            syncError: errorMsg || 'Cloud sync failed',
          });
        } finally {
          completeAsyncOperation(operation);
          if (activePullOperation === operation) activePullOperation = null;
        }
      },
      importLocalToCloud: async () => {
        if (isOfflineOnly) return { success: false, message: 'Cloud workspaces are disabled for this product.' };
        if (!allowsOfflineWorkspace) return { success: false, message: 'Offline workspaces are disabled for this product.' };
        const { cloudConfig, offlineScopeCache, activeOfflineWorkspaceId, collections } = get();
        const activeLocalId = activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
        const localEntry = (offlineScopeCache || {})[activeLocalId];
        const colsToImport = (localEntry?.collections && localEntry.collections.length > 0)
          ? localEntry.collections
          : collections;

        if (!isCloudSessionActive(cloudConfig) || !cloudConfig.activeScope) {
          return { success: false, message: 'Not connected to a cloud workspace or project' };
        }
        if (colsToImport.length === 0) {
          return { success: false, message: 'No local collections found to import' };
        }

        let importedCount = 0;
        const operation = beginAsyncOperation();
        try {
          set({ syncStatus: 'syncing', syncError: null });
          const hasAnySavedExamples = colsToImport.some((col) => collectionHasSavedExamples(col));
          if (hasAnySavedExamples) {
            const supported = await ensureSavedExamplesCapability();
            if (!isAsyncOperationCurrent(operation)) return { success: false, message: 'Operation cancelled' };
            if (!supported) {
              throw new Error('This cloud server does not support Saved Examples. Update the server before migrating local collections with examples.');
            }
          }
          for (let i = 0; i < colsToImport.length; i++) {
            if (!isAsyncOperationCurrent(operation)) return { success: false, message: 'Operation cancelled' };
            const col = colsToImport[i];
            if (colsToImport.length > 1) {
              set({
                syncStatus: 'syncing',
                syncError: `Importing collection ${i + 1} of ${colsToImport.length} (${col.name})...`,
              });
            }
            const expectedExamples = countCollectionSavedExamples(col);
            const batchResult = await batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              [col],
              cloudConfig.refreshToken,
              operation.controller.signal
            );
            if (
              expectedExamples > 0 &&
              (typeof batchResult?.imported_examples !== 'number' ||
                batchResult.imported_examples < expectedExamples)
            ) {
              throw new Error(`Cloud server dropped saved examples while importing "${col.name}".`);
            }
            importedCount++;
          }
          if (!isAsyncOperationCurrent(operation)) return { success: false, message: 'Operation cancelled' };
          await get().pullCloudDelta();
          if (!isAsyncOperationCurrent(operation)) return { success: false, message: 'Operation cancelled' };
          set({ syncStatus: 'synced', syncError: null });
          return { success: true, message: `Successfully imported ${colsToImport.length} collection(s) to cloud` };
        } catch (err: any) {
          if (!isAsyncOperationCurrent(operation)) return { success: false, message: 'Operation cancelled' };
          if (importedCount > 0) {
            try {
              await get().pullCloudDelta();
            } catch {
              // ignore delta pull error during failure recovery
            }
          }
          const failMsg = importedCount > 0
            ? `Imported ${importedCount} of ${colsToImport.length} collection(s). Error on remaining: ${err.message || 'Import failed'}`
            : (err.message || 'Import failed');
          set({ syncStatus: 'error', syncError: failMsg });
          return { success: false, message: failMsg };
        } finally {
          completeAsyncOperation(operation);
        }
      },
      createCloudWorkspace: async (name, description) => {
        if (isOfflineOnly) return { success: false, error: 'Cloud workspaces are disabled for this product.' };
        const { cloudConfig } = get();
        if (!isCloudSessionActive(cloudConfig)) return { success: false, error: 'Not authenticated' };
        const trimmed = name.trim();
        if (!trimmed) return { success: false, error: 'Workspace name is required' };

        const operation = beginAsyncOperation();
        const requestSessionGeneration = cloudSessionGeneration;
        try {
          const newWs = await createCloudWorkspace(
            cloudConfig.apiUrl,
            cloudConfig.token,
            { name: trimmed, description: description?.trim() },
            cloudConfig.refreshToken,
            operation.controller.signal
          );
          if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Session changed' };
          const scopesCache = get().scopesCache;
          set({ scopesCache: {
            workspaces: [...(scopesCache?.workspaces || []), newWs],
            teams: scopesCache?.teams || [],
            teamProjects: scopesCache?.teamProjects || {},
            teamsWithProjects: scopesCache?.teamsWithProjects || [],
            lastFetchedAt: scopesCache?.lastFetchedAt || 0,
          } });

          await get().setActiveScope({
            type: 'workspace',
            id: newWs.id,
            name: newWs.name,
            role: 'owner',
          });

          if (isStoreDisposed || cloudSessionGeneration !== requestSessionGeneration) return { success: false, error: 'Session changed' };

          return { success: true, workspace: newWs };
        } catch (err: any) {
          if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Session changed' };
          return { success: false, error: err.message || 'Failed to create workspace' };
        } finally {
          completeAsyncOperation(operation);
        }
      },
      renameCloudWorkspace: async (id, name) => {
        if (isOfflineOnly) return { success: false, error: 'Cloud workspaces are disabled for this product.' };
        const { cloudConfig } = get();
        if (!isCloudSessionActive(cloudConfig)) return { success: false, error: 'Not authenticated' };
        const trimmed = name.trim();
        if (!trimmed) return { success: false, error: 'Workspace name is required' };

        const operation = beginAsyncOperation();
        try {
          const updatedWs = await updateCloudWorkspace(
            cloudConfig.apiUrl,
            cloudConfig.token,
            id,
            { name: trimmed },
            cloudConfig.refreshToken,
            operation.controller.signal
          );
          if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Session changed' };
          const scopesCache = get().scopesCache;

          if (scopesCache) {
            const updatedWorkspaces = (scopesCache.workspaces || []).map((w) =>
              w.id === id ? { ...w, name: updatedWs.name } : w
            );
            set({
              scopesCache: {
                ...scopesCache,
                workspaces: updatedWorkspaces,
              },
            });
          }

          if (cloudConfig.activeScope?.type === 'workspace' && cloudConfig.activeScope.id === id) {
            set((state) => {
              if (state.cloudConfig.activeScope?.type !== 'workspace' || state.cloudConfig.activeScope.id !== id) return {};
              return {
                cloudConfig: {
                  ...state.cloudConfig,
                  activeScope: {
                    ...state.cloudConfig.activeScope,
                    name: updatedWs.name,
                  },
                },
              };
            });
          }

          return { success: true };
        } catch (err: any) {
          if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Session changed' };
          return { success: false, error: err.message || 'Failed to rename workspace' };
        } finally {
          completeAsyncOperation(operation);
        }
      },
      deleteCloudWorkspace: async (id) => {
        if (isOfflineOnly) return { success: false, error: 'Cloud workspaces are disabled for this product.' };
        const { cloudConfig } = get();
        if (!isCloudSessionActive(cloudConfig)) return { success: false, error: 'Not authenticated' };

        const operation = beginAsyncOperation();
        const requestSessionGeneration = cloudSessionGeneration;
        try {
          await deleteCloudWorkspace(
            cloudConfig.apiUrl,
            cloudConfig.token,
            id,
            cloudConfig.refreshToken,
            operation.controller.signal
          );
          if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Session changed' };
          const scopesCache = get().scopesCache;

          const currentWorkspaces = scopesCache?.workspaces || [];
          const remainingWorkspaces = currentWorkspaces.filter((w) => w.id !== id);

          if (cloudConfig.activeScope?.type === 'workspace' && cloudConfig.activeScope.id === id) {
            const fallbackWs = remainingWorkspaces.find((w) => w.is_default) || remainingWorkspaces[0];
            if (fallbackWs) {
              await get().setActiveScope({
                type: 'workspace',
                id: fallbackWs.id,
                name: fallbackWs.name,
                role: 'owner',
              });
              if (isStoreDisposed || cloudSessionGeneration !== requestSessionGeneration) return { success: false, error: 'Session changed' };
            }
          }

          if (scopesCache) {
            set((state) => state.scopesCache ? {
              scopesCache: {
                ...state.scopesCache,
                workspaces: state.scopesCache.workspaces.filter((workspace) => workspace.id !== id),
              },
            } : {});
          }

          return { success: true };
        } catch (err: any) {
          if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Session changed' };
          return { success: false, error: err.message || 'Failed to delete workspace' };
        } finally {
          completeAsyncOperation(operation);
        }
      },
      fetchScopes: async (force = false) => {
        if (isOfflineOnly) return;
        const { cloudConfig, scopesCache } = get();
        if (!isCloudSessionActive(cloudConfig)) return;

        const isFresh = Boolean(
          !force &&
          scopesCache?.lastFetchedAt &&
          Date.now() - scopesCache.lastFetchedAt < SCOPES_LIST_CACHE_TTL_MS &&
          (scopesCache.workspaces.length > 0 || (scopesCache.teams && scopesCache.teams.length > 0) || (scopesCache.teamsWithProjects && scopesCache.teamsWithProjects.length > 0))
        );

        if (isFresh) {
          return;
        }

        const operation = beginAsyncOperation();
        try {
          const [wsList, teamList] = await Promise.all([
            fetchUserWorkspacesForRuntime(cloudConfig.apiUrl, cloudConfig.token, cloudConfig.refreshToken, operation.controller.signal),
            fetchUserTeamsForRuntime(cloudConfig.apiUrl, cloudConfig.token, cloudConfig.refreshToken, operation.controller.signal),
          ]);
          if (!isAsyncOperationCurrent(operation)) return;

          const currentTeamProjects: Record<string, CloudProject[]> = {};
          if (scopesCache?.teamProjects) {
            for (const [tId, pList] of Object.entries(scopesCache.teamProjects)) {
              if (Array.isArray(pList) && pList.length > 0) {
                currentTeamProjects[tId] = pList;
              }
            }
          }

          // Migrate legacy teamsWithProjects cache if teamProjects is empty
          if (Object.keys(currentTeamProjects).length === 0 && scopesCache?.teamsWithProjects) {
            for (const tp of scopesCache.teamsWithProjects) {
              if (tp.team?.id && tp.projects && tp.projects.length > 0) {
                currentTeamProjects[tp.team.id] = tp.projects;
              }
            }
          }

          // If current active scope is a project, prefill its team projects to reconcile user role
          const currentScope = get().cloudConfig.activeScope;
          let activeProjectsVerified = false;
          if (currentScope?.type === 'project' && currentScope.teamId) {
            try {
              const activeTeamProjects = await fetchTeamProjectsForRuntime(
                cloudConfig.apiUrl,
                currentScope.teamId,
                cloudConfig.token!,
                cloudConfig.refreshToken,
                operation.controller.signal
              );
              if (!isAsyncOperationCurrent(operation)) return;
              currentTeamProjects[currentScope.teamId] = activeTeamProjects;
              activeProjectsVerified = true;
            } catch {
              // ignore background fetch error
            }
          }

          // Clean up orphan team projects from cache if user is no longer in that team
          const validTeamIds = new Set(teamList.map((t) => t.id));
          for (const cachedTeamId of Object.keys(currentTeamProjects)) {
            if (!validTeamIds.has(cachedTeamId)) {
              delete currentTeamProjects[cachedTeamId];
            }
          }

          const teamProjects = teamList.map((t) => ({
            team: t,
            projects: currentTeamProjects[t.id] || [],
          }));

          set({
            scopesCache: {
              workspaces: wsList,
              teams: teamList,
              teamProjects: currentTeamProjects,
              teamsWithProjects: teamProjects,
              lastFetchedAt: Date.now(),
            },
          });

          // Check if active project scope was removed or user's role changed
          if (currentScope?.type === 'project' ||
              (cloudConfig.sessionKind === 'provider' && currentScope?.type === 'workspace')) {
            let accessRevoked = currentScope.type === 'workspace' && !wsList.some((workspace) => workspace.id === currentScope.id);
            // Case 1: user removed from the team
            if (currentScope.type === 'project' && currentScope.teamId && !validTeamIds.has(currentScope.teamId)) {
              accessRevoked = true;
            } else if (currentScope.type === 'project' && currentScope.teamId && currentScope.id) {
              // Case 2: user removed from this specific project
              const projectsForActiveTeam = currentTeamProjects[currentScope.teamId] || [];
              const match = projectsForActiveTeam.find((p) => p.id === currentScope.id);
              if (!match && (activeProjectsVerified || projectsForActiveTeam.length > 0)) {
                accessRevoked = true;
              } else if (
                match &&
                (match.user_role !== currentScope.role ||
                  JSON.stringify(match.permissions) !== JSON.stringify(currentScope.permissions))
              ) {
                // Reconcile active project scope's role and permissions if updated on backend
                set((state) => ({
                  cloudConfig: {
                    ...state.cloudConfig,
                    activeScope: {
                      ...state.cloudConfig.activeScope!,
                      role: match.user_role,
                      permissions: match.permissions,
                    },
                  },
                }));
              }
            }

            if (accessRevoked) {
              const defaultWs = wsList[0];
              if (defaultWs) {
                await get().setActiveScope(
                  {
                    type: 'workspace',
                    id: defaultWs.id,
                    name: defaultWs.name,
                    role: 'owner',
                  },
                  true
                );
              } else if (allowsOfflineWorkspace) {
                get().switchOfflineWorkspace(get().activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID);
              } else {
                get().evictCloudSession();
              }
              set({
                syncError: `Access to "${currentScope.name}" was revoked. Switched to ${
                  defaultWs ? defaultWs.name : allowsOfflineWorkspace ? 'Offline Workspace' : 'sign-in'
                }.`,
              });
            }
          }
        } catch (err) {
          if (!isAsyncOperationCurrent(operation)) return;
          console.error('Failed to load scopes:', err);
        } finally {
          completeAsyncOperation(operation);
        }
      },

      fetchProjectsForTeam: async (teamId: string, force = false) => {
        if (isOfflineOnly) return [];
        const { cloudConfig, scopesCache } = get();
        if (!isCloudSessionActive(cloudConfig) || !teamId) return [];

        const hasCached = Boolean(
          scopesCache?.teamProjects &&
          Object.prototype.hasOwnProperty.call(scopesCache.teamProjects, teamId)
        );
        if (!force && hasCached && scopesCache?.teamProjects?.[teamId] && scopesCache.teamProjects[teamId].length > 0) {
          return scopesCache.teamProjects[teamId];
        }

        const operation = beginAsyncOperation();
        try {
          const projects = await fetchTeamProjectsForRuntime(
            cloudConfig.apiUrl,
            teamId,
            cloudConfig.token,
            cloudConfig.refreshToken,
            operation.controller.signal
          );
          if (!isAsyncOperationCurrent(operation)) return [];

          const updatedTeamProjects = {
            ...(scopesCache?.teamProjects || {}),
            [teamId]: projects,
          };

          const teams = scopesCache?.teams || [];
          const updatedTeamsWithProjects = teams.map((t) => ({
            team: t,
            projects: updatedTeamProjects[t.id] || [],
          }));

          set({
            scopesCache: {
              workspaces: scopesCache?.workspaces || [],
              teams,
              teamProjects: updatedTeamProjects,
              teamsWithProjects: updatedTeamsWithProjects,
              lastFetchedAt: scopesCache?.lastFetchedAt || Date.now(),
            },
          });

          // Check if active project scope was in this team and user has been unassigned
          const currentScope = get().cloudConfig.activeScope;
          if (
            currentScope?.type === 'project' &&
            currentScope.teamId === teamId &&
            currentScope.id &&
            !projects.some((p) => p.id === currentScope.id)
          ) {
            const defaultWs = scopesCache?.workspaces?.[0];
            if (defaultWs) {
              await get().setActiveScope(
                {
                  type: 'workspace',
                  id: defaultWs.id,
                  name: defaultWs.name,
                  role: 'owner',
                },
                true
              );
            } else if (allowsOfflineWorkspace) {
              get().switchOfflineWorkspace(get().activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID);
            } else {
              get().evictCloudSession();
            }
            set({
              syncError: `Access to "${currentScope.name}" was revoked. Switched to ${
                defaultWs ? defaultWs.name : allowsOfflineWorkspace ? 'Offline Workspace' : 'sign-in'
              }.`,
            });
          }

          return projects;
        } catch (err: any) {
          if (!isAsyncOperationCurrent(operation)) return [];
          console.error(`Failed to fetch projects for team ${teamId}:`, err);

          // If 403 Forbidden: user has been kicked from the team
          const isForbidden =
            err?.message?.toLowerCase().includes('forbidden') ||
            err?.message?.toLowerCase().includes('not found') ||
            err?.status === 403;

          if (isForbidden) {
            const updatedTeams = (scopesCache?.teams || []).filter((t) => t.id !== teamId);
            const updatedTeamProjects = { ...(scopesCache?.teamProjects || {}) };
            delete updatedTeamProjects[teamId];

            set({
              scopesCache: {
                workspaces: scopesCache?.workspaces || [],
                teams: updatedTeams,
                teamProjects: updatedTeamProjects,
                teamsWithProjects: updatedTeams.map((t) => ({
                  team: t,
                  projects: updatedTeamProjects[t.id] || [],
                })),
                lastFetchedAt: Date.now(),
              },
            });

            const currentScope = get().cloudConfig.activeScope;
            if (currentScope?.type === 'project' && currentScope.teamId === teamId) {
              const defaultWs = scopesCache?.workspaces?.[0];
              if (defaultWs) {
                await get().setActiveScope(
                  {
                    type: 'workspace',
                    id: defaultWs.id,
                    name: defaultWs.name,
                    role: 'owner',
                  },
                  true
                );
              } else if (allowsOfflineWorkspace) {
                get().switchOfflineWorkspace(get().activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID);
              } else {
                get().evictCloudSession();
              }
              set({
                syncError: `Removed from team. Switched to ${
                  defaultWs ? defaultWs.name : allowsOfflineWorkspace ? 'Offline Workspace' : 'sign-in'
                }.`,
              });
            }
          }
          return [];
        } finally {
          completeAsyncOperation(operation);
        }
      },

      // Offline Workspaces Actions
      createOfflineWorkspace: (name, description) => {
        if (!allowsOfflineWorkspace) return '';
        const trimmedName = name.trim() || 'New Workspace';
        const newId = `ws_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const newWs: OfflineWorkspace = {
          id: newId,
          name: trimmedName,
          description: description?.trim(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        const {
          workspaceMode,
          activeOfflineWorkspaceId,
          offlineWorkspaces,
          offlineScopeCache,
          collections,
          environments,
          activeEnvironmentId,
          tabs,
          activeTabId,
          history,
        } = get();

        const updatedOfflineCache = { ...(offlineScopeCache || {}) };
        if (workspaceMode === 'offline' && activeOfflineWorkspaceId) {
          updatedOfflineCache[activeOfflineWorkspaceId] = {
            collections,
            environments,
            activeEnvironmentId,
            tabs,
            activeTabId,
            history,
          };
        }

        const initialTab = createInitialTab();
        updatedOfflineCache[newId] = {
          collections: [],
          environments: [],
          activeEnvironmentId: null,
          tabs: [initialTab],
          activeTabId: initialTab.id,
          history: [],
        };

        set({
          offlineWorkspaces: [...(offlineWorkspaces || [defaultOfflineWorkspace]), newWs],
          offlineScopeCache: updatedOfflineCache,
        });

        get().switchOfflineWorkspace(newId);
        return newId;
      },

      switchOfflineWorkspace: (workspaceId, skipSnapshot = false) => {
        if (!allowsOfflineWorkspace) return;
        const {
          activeOfflineWorkspaceId,
          offlineScopeCache,
          workspaceMode,
          cloudConfig,
          scopeCache,
          collections,
          environments,
          activeEnvironmentId,
          tabs,
          activeTabId,
          history,
          lastSyncedAt,
        } = get();

        if (workspaceMode === 'offline' && activeOfflineWorkspaceId === workspaceId) {
          return;
        }

        invalidateAsyncOperations();
        for (const key of Object.keys(tabUndoHistory)) {
          delete tabUndoHistory[key];
        }
        for (const key of Object.keys(undoTypingTimers)) {
          clearTimeout(undoTypingTimers[key]);
          delete undoTypingTimers[key];
        }
        set({ isSwitchingWorkspace: true });

        const updatedOfflineCache = { ...(offlineScopeCache || {}) };
        const updatedScopeCache = { ...(scopeCache || {}) };

        if (!skipSnapshot) {
          if (workspaceMode === 'offline' && activeOfflineWorkspaceId) {
            updatedOfflineCache[activeOfflineWorkspaceId] = {
              collections,
              environments,
              activeEnvironmentId,
              tabs,
              activeTabId,
              history,
            };
          } else if (cloudConfig.activeScope) {
            const cloudKey = getScopeCacheKey(cloudConfig.activeScope);
            updatedScopeCache[cloudKey] = {
              ...(updatedScopeCache[cloudKey] || {}),
              collections,
              environments,
              activeEnvironmentId,
              lastSyncedAt,
              tabs,
              activeTabId,
              history,
            };
          }
        }

        const targetEntry = updatedOfflineCache[workspaceId] || {
          collections: [],
          environments: [],
          activeEnvironmentId: null,
          tabs: [createInitialTab()],
          activeTabId: '',
          history: [],
        };

        const restoredTabs =
          targetEntry.tabs && targetEntry.tabs.length > 0
            ? targetEntry.tabs
            : [createInitialTab()];
        const restoredActiveTabId =
          targetEntry.activeTabId && restoredTabs.some((t) => t.id === targetEntry.activeTabId)
            ? targetEntry.activeTabId
            : restoredTabs[0].id;

        revokeUnreferencedTabBlobs(get().tabResponses, get().activeResponse, [
          targetEntry.history,
          ...Object.values(updatedOfflineCache).map((e) => e.history),
          ...Object.values(updatedScopeCache).map((e) => e.history),
        ]);

        set({
          workspaceMode: 'offline',
          hasConfiguredMode: true,
          activeOfflineWorkspaceId: workspaceId,
          offlineScopeCache: updatedOfflineCache,
          scopeCache: updatedScopeCache,
          collections: targetEntry.collections || [],
          environments: targetEntry.environments || [],
          activeEnvironmentId: targetEntry.activeEnvironmentId || null,
          tabs: restoredTabs,
          activeTabId: restoredActiveTabId,
          openExampleTabs: [],
          tabOrder: restoredTabs.map((t) => t.id),
          activeResponse: null,
          tabResponses: {},
          selectedExample: null,
          isLoading: false,
          history: targetEntry.history || [],
          canUndoActiveRequest: false,
          canRedoActiveRequest: false,
          syncStatus: 'idle',
          syncError: null,
        });

        safeSetTimeout(() => {
          set({ isSwitchingWorkspace: false });
        }, 80);
      },

      renameOfflineWorkspace: (id, name) => {
        if (!allowsOfflineWorkspace) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        set((state) => ({
          offlineWorkspaces: (state.offlineWorkspaces || [defaultOfflineWorkspace]).map((w) =>
            w.id === id ? { ...w, name: trimmed, updatedAt: Date.now() } : w
          ),
        }));
      },

      deleteOfflineWorkspace: (id) => {
        if (!allowsOfflineWorkspace) return { success: false, error: 'Offline workspaces are disabled for this product.' };
        const { offlineWorkspaces, activeOfflineWorkspaceId, offlineScopeCache } = get();
        const list = offlineWorkspaces || [defaultOfflineWorkspace];
        if (list.length <= 1) {
          return { success: false, error: 'Cannot delete the only offline workspace' };
        }

        const remainingWorkspaces = list.filter((w) => w.id !== id);
        const updatedOfflineCache = { ...(offlineScopeCache || {}) };
        const deletedCacheHistory = updatedOfflineCache[id]?.history || [];
        delete updatedOfflineCache[id];

        const { workspaceMode, history: liveHistory, scopeCache: currentScopeCache } = get();
        const deletingLiveOffline = activeOfflineWorkspaceId === id && workspaceMode === 'offline';
        const candidateResponses: Array<ApiResponse | null | undefined> = [
          ...deletedCacheHistory.map((entry) => entry.response),
          ...(deletingLiveOffline ? liveHistory.map((entry) => entry.response) : []),
          ...(activeOfflineWorkspaceId === id
            ? [get().activeResponse, ...Object.values(get().tabResponses || {})]
            : []),
        ];
        const protectedResponses: Array<ApiResponse | null | undefined> =
          activeOfflineWorkspaceId !== id
            ? [get().activeResponse, ...Object.values(get().tabResponses || {})]
            : [];
        const protectedHistories: Array<Array<HistoryItem> | undefined> = [
          ...(deletingLiveOffline ? [] : [liveHistory]),
          ...Object.values(updatedOfflineCache).map((e) => e.history),
          ...Object.values(currentScopeCache || {}).map((e) => e.history),
        ];
        revokeUnreferencedResponses(candidateResponses, protectedResponses, protectedHistories);

        if (activeOfflineWorkspaceId === id) {
          const nextWs = remainingWorkspaces[0];

          set({
            offlineWorkspaces: remainingWorkspaces,
            offlineScopeCache: updatedOfflineCache,
          });
          get().switchOfflineWorkspace(nextWs.id, true);
        } else {
          set({
            offlineWorkspaces: remainingWorkspaces,
            offlineScopeCache: updatedOfflineCache,
          });
        }

        return { success: true };
      },

      duplicateOfflineWorkspace: (id, newName) => {
        if (!allowsOfflineWorkspace) return '';
        const {
          offlineWorkspaces,
          activeOfflineWorkspaceId,
          offlineScopeCache,
          workspaceMode,
          collections,
          environments,
          activeEnvironmentId,
          tabs,
          activeTabId,
          history,
        } = get();

        const list = offlineWorkspaces || [defaultOfflineWorkspace];
        const sourceWs = list.find((w) => w.id === id);
        if (!sourceWs) return '';

        const updatedOfflineCache = { ...(offlineScopeCache || {}) };
        if (workspaceMode === 'offline' && activeOfflineWorkspaceId === id) {
          updatedOfflineCache[id] = {
            collections,
            environments,
            activeEnvironmentId,
            tabs,
            activeTabId,
            history,
          };
        }

        const sourceData = updatedOfflineCache[id] || {
          collections: [],
          environments: [],
          activeEnvironmentId: null,
          tabs: [createInitialTab()],
          activeTabId: '',
          history: [],
        };

        const newId = `ws_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const cloneName = newName?.trim() || `${sourceWs.name} (Copy)`;
        const clonedWs: OfflineWorkspace = {
          id: newId,
          name: cloneName,
          description: sourceWs.description,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        const clonedCollections = (sourceData.collections || []).map(cloneCollectionPreservingAttachments);
        const clonedEnvironments = JSON.parse(JSON.stringify(sourceData.environments || []));
        const clonedTabs = (sourceData.tabs && sourceData.tabs.length > 0 ? sourceData.tabs : [createInitialTab()])
          .map((tab) => normalizePersistedRequestAttachments(serializeRequestAttachments(tab)));

        updatedOfflineCache[newId] = {
          collections: clonedCollections,
          environments: clonedEnvironments,
          activeEnvironmentId: sourceData.activeEnvironmentId || null,
          tabs: clonedTabs,
          activeTabId: clonedTabs[0]?.id || '',
          history: (sourceData.history || []).map((entry) => ({
            ...entry,
            request: cloneRequestPreservingAttachments(entry.request),
            response: entry.response ? { ...entry.response } : undefined,
          })),
        };

        set({
          offlineWorkspaces: [...list, clonedWs],
          offlineScopeCache: updatedOfflineCache,
        });

        get().switchOfflineWorkspace(newId);
        return newId;
      },

      // Environment actions
      setActiveEnvironmentId: (activeEnvironmentId) =>
        set({ activeEnvironmentId }),

      createEnvironment: (name, minRole = 'reader') => {
        const { workspaceMode, cloudConfig } = get();
        let effectiveMinRole = minRole;
        if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role)) {
            console.warn('User lacks permission to create environment in this scope');
            return '';
          }
          if (effectiveMinRole && !canModifyEnvironment(effectiveMinRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            effectiveMinRole = 'reader';
          }
        }

        const newEnv: Environment = {
          id: generateId(),
          name: name.trim() || 'New Environment',
          variables: [{ id: generateId(), key: '', value: '', initialValue: '', currentValue: '', enabled: true }],
          minRole: effectiveMinRole,
          version: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set((state) => ({
          environments: [...state.environments, newEnv],
          activeEnvironmentId: newEnv.id,
        }));

        if (workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && cloudConfig.activeScope) {
          const operation = beginAsyncOperation();
          createScopeEnvironment(
            cloudConfig.apiUrl,
            cloudConfig.token,
            cloudConfig.activeScope,
            {
              name: newEnv.name,
              variables: sanitizeVariablesForUpstream(newEnv.variables),
              min_role: newEnv.minRole,
            },
            cloudConfig.refreshToken,
            operation.controller.signal
          ).then((created) => {
            if (!isAsyncOperationCurrent(operation)) return;
            if (created && created.id) {
              set((state) => {
                if (!isAsyncOperationCurrent(operation)) return {};
                return {
                  environments: state.environments.map((e) =>
                    e.id === newEnv.id
                      ? { ...e, id: created.id, version: created.version || 1 }
                      : e
                  ),
                  activeEnvironmentId: state.activeEnvironmentId === newEnv.id ? created.id : state.activeEnvironmentId,
                };
              });
            }
          }).catch((err) => {
            if (!isAsyncOperationCurrent(operation)) return;
            console.error('Failed to sync created environment to cloud:', err);
          }).finally(() => {
            completeAsyncOperation(operation);
          });
        }

        return newEnv.id;
      },

      deleteEnvironment: (id) => {
        const { workspaceMode, cloudConfig, environments } = get();
        const env = environments.find((e) => e.id === id);
        if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:delete', workspaceMode, cloudConfig.user?.role) ||
              !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn(`User lacks permission to delete environment "${env.name}"`);
            return;
          }
        }

        if (envSyncDebounceTimers[id]) {
          clearTimeout(envSyncDebounceTimers[id]);
          delete envSyncDebounceTimers[id];
        }

        set((state) => ({
          environments: state.environments.filter((e) => e.id !== id),
          activeEnvironmentId: state.activeEnvironmentId === id ? null : state.activeEnvironmentId,
        }));

        if (workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig)) {
          const operation = beginAsyncOperation();
          deleteScopeEnvironment(
            cloudConfig.apiUrl,
            cloudConfig.token,
            id,
            cloudConfig.refreshToken,
            operation.controller.signal
          ).catch((err) => {
            if (!isAsyncOperationCurrent(operation)) return;
            console.error('Failed to delete environment from cloud:', err);
          }).finally(() => {
            completeAsyncOperation(operation);
          });
        }
      },

      updateEnvironment: (id, updates) => {
        const { workspaceMode, cloudConfig, environments } = get();
        const env = environments.find((e) => e.id === id);
        if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
              !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn(`User lacks permission to update environment "${env.name}"`);
            return;
          }
          if (updates.minRole && !canModifyEnvironment(updates.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn(`User lacks permission to assign minRole "${updates.minRole}" to environment "${env.name}"`);
            return;
          }
        }

        set((state) => ({
          environments: state.environments.map((e) => {
            if (e.id === id) {
              return { ...e, ...updates, updatedAt: Date.now() };
            }
            return e;
          }),
        }));

        scheduleEnvironmentCloudSync(id, get, set);
      },

      addEnvironmentVariable: (envId) => {
        const { workspaceMode, cloudConfig, environments } = get();
        const env = environments.find((e) => e.id === envId);
        if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
              !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn('User lacks permission to modify environments in this scope');
            return;
          }
        }

        set((state) => ({
          environments: state.environments.map((e) => {
            if (e.id !== envId) return e;
            return {
              ...e,
              variables: [
                ...e.variables,
                { id: generateId(), key: '', value: '', initialValue: '', currentValue: '', enabled: true },
              ],
              updatedAt: Date.now(),
            };
          }),
        }));

        scheduleEnvironmentCloudSync(envId, get, set);
      },

      updateEnvironmentVariable: (envId, varId, updates) => {
        const updateKeys = Object.keys(updates);
        const isOnlyCurrentValue = updateKeys.length === 1 && updateKeys[0] === 'currentValue';

        if (!isOnlyCurrentValue) {
          const { workspaceMode, cloudConfig, environments } = get();
          const env = environments.find((e) => e.id === envId);
          if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
            if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
                !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
              console.warn('User lacks permission to modify environments in this scope');
              return;
            }
          }
        }

        set((state) => ({
          environments: state.environments.map((e) => {
            if (e.id !== envId) return e;
            return {
              ...e,
              variables: e.variables.map((v) => {
                if (v.id !== varId) return v;
                const next = { ...v, ...updates };
                if (updates.initialValue !== undefined) {
                  next.value = updates.initialValue;
                }
                return next;
              }),
              updatedAt: Date.now(),
            };
          }),
        }));

        if (!isOnlyCurrentValue) {
          scheduleEnvironmentCloudSync(envId, get, set);
        }
      },

      removeEnvironmentVariable: (envId, varId) => {
        const { workspaceMode, cloudConfig, environments } = get();
        const env = environments.find((e) => e.id === envId);
        if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
              !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn('User lacks permission to modify environments in this scope');
            return;
          }
        }

        set((state) => ({
          environments: state.environments.map((e) => {
            if (e.id !== envId) return e;
            return {
              ...e,
              variables: e.variables.filter((v) => v.id !== varId),
              updatedAt: Date.now(),
            };
          }),
        }));

        scheduleEnvironmentCloudSync(envId, get, set);
      },

      resetEnvironmentCurrentValues: (envId) => {
        set((state) => ({
          environments: state.environments.map((e) => {
            if (e.id !== envId) return e;
            return {
              ...e,
              variables: e.variables.map((v) => ({
                ...v,
                currentValue: v.initialValue ?? v.value ?? '',
              })),
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      persistEnvironmentCurrentValues: (envId) => {
        const { workspaceMode, cloudConfig, environments } = get();
        const env = environments.find((e) => e.id === envId);
        if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
              !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn('User lacks permission to modify environments in this scope');
            return;
          }
        }

        set((state) => ({
          environments: state.environments.map((e) => {
            if (e.id !== envId) return e;
            return {
              ...e,
              variables: e.variables.map((v) => {
                const effective = v.currentValue ?? v.initialValue ?? v.value ?? '';
                return {
                  ...v,
                  initialValue: effective,
                  value: effective,
                };
              }),
              updatedAt: Date.now(),
            };
          }),
        }));

        scheduleEnvironmentCloudSync(envId, get, set);
      },

      addEnvironment: async (env: Environment, options?: { target?: ImportTargetBinding; isRetry?: boolean }) => {
        if (options?.target && !matchesImportTarget(get(), options.target, cloudSessionGeneration)) {
          throw new Error('Workspace changed before environment import could be applied.');
        }

        const { workspaceMode, cloudConfig } = get();
        if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role)) {
            console.warn('User lacks permission to add environment in this scope');
            throw new Error('Insufficient permission to add environments in this scope (requires env:write).');
          }
        }

        const isCloud = workspaceMode === 'cloud';
        const taggedEnv: Environment = {
          ...env,
          _syncStatus: isCloud ? 'pending' : 'synced',
          ...(isCloud ? { _pendingCreate: true } : {}),
        };

        set((state) => {
          const exists = state.environments.some((e) => e.id === taggedEnv.id);
          const nextEnvironments = exists
            ? state.environments.map((e) => (e.id === taggedEnv.id ? taggedEnv : e))
            : [...state.environments, taggedEnv];
          const localId = state.activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
          const nextOfflineCache =
            state.workspaceMode === 'offline'
              ? {
                  ...(state.offlineScopeCache || {}),
                  [localId]: {
                    collections: state.collections,
                    tabs: state.tabs,
                    activeTabId: state.activeTabId,
                    history: state.history,
                    ...(state.offlineScopeCache?.[localId] || {}),
                    environments: nextEnvironments,
                    activeEnvironmentId: taggedEnv.id,
                  },
                }
              : state.offlineScopeCache;
          return {
            environments: nextEnvironments,
            activeEnvironmentId: taggedEnv.id,
            offlineScopeCache: nextOfflineCache,
          };
        });

        if (!isOfflineOnly && isCloud && isCloudSessionActive(cloudConfig) && cloudConfig.activeScope) {
          const operation = beginAsyncOperation();
          const targetScope = cloudConfig.activeScope;
          const capturedSessionGen = cloudSessionGeneration;
          const isSameTargetScope = () => {
            const live = get();
            return (
              !isStoreDisposed &&
              cloudSessionGeneration === capturedSessionGen &&
              live.workspaceMode === 'cloud' &&
              live.cloudConfig.activeScope?.id === targetScope.id &&
              live.cloudConfig.activeScope?.type === targetScope.type
            );
          };
          const reconcileEnvToTargetScope = (remoteId: string, remoteVersion: number) => {
            if (isStoreDisposed || cloudSessionGeneration !== capturedSessionGen) return;
            if (isSameTargetScope()) {
              set((state) => ({
                environments: state.environments.map((e) =>
                  e.id === taggedEnv.id
                    ? { ...e, id: remoteId, version: remoteVersion, _syncStatus: 'synced', _pendingCreate: undefined }
                    : e
                ),
                activeEnvironmentId: state.activeEnvironmentId === taggedEnv.id ? remoteId : state.activeEnvironmentId,
              }));
              return;
            }
            const targetKey = getScopeCacheKey(targetScope);
            set((state) => {
              const cached = state.scopeCache?.[targetKey];
              if (!cached) return {};
              return {
                scopeCache: {
                  ...state.scopeCache,
                  [targetKey]: {
                    ...cached,
                    environments: (cached.environments || []).map((e) =>
                      e.id === taggedEnv.id
                        ? { ...e, id: remoteId, version: remoteVersion, _syncStatus: 'synced', _pendingCreate: undefined }
                        : e
                    ),
                    activeEnvironmentId: cached.activeEnvironmentId === taggedEnv.id ? remoteId : cached.activeEnvironmentId,
                  },
                },
              };
            });
          };
          try {
            if (options?.isRetry) {
              const remoteEnvs = await fetchScopeEnvironmentsForRuntime(
                cloudConfig.apiUrl,
                cloudConfig.token,
                targetScope,
                cloudConfig.refreshToken,
                operation.controller.signal
              );
              if (isStoreDisposed || cloudSessionGeneration !== capturedSessionGen) return taggedEnv.id;
              const normalizedName = String(taggedEnv.name ?? '').trim().toLowerCase();
              const matchedRemote = (remoteEnvs || []).find(
                (re) => String(re?.name ?? '').trim().toLowerCase() === normalizedName
              );
              if (matchedRemote?.id) {
                const localPayload = JSON.stringify(sanitizeVariablesForUpstream(taggedEnv.variables));
                const remotePayload = JSON.stringify(sanitizeVariablesForUpstream(matchedRemote.variables || []));
                if (localPayload !== remotePayload) {
                  throw new Error(
                    `An environment named "${taggedEnv.name}" already exists on the server with different variables.`
                  );
                }
                reconcileEnvToTargetScope(matchedRemote.id, matchedRemote.version || 1);
                if (isSameTargetScope() && isAsyncOperationCurrent(operation)) {
                  await flushStorePersistence();
                }
                return matchedRemote.id;
              }
              if (!isAsyncOperationCurrent(operation) || operation.controller.signal.aborted) {
                if (isSameTargetScope()) {
                  throw new Error('Import operation was cancelled before completion.');
                }
                return taggedEnv.id;
              }
            }

            const created = await createScopeEnvironment(
              cloudConfig.apiUrl,
              cloudConfig.token,
              targetScope,
              {
                name: taggedEnv.name,
                variables: sanitizeVariablesForUpstream(taggedEnv.variables),
                min_role: taggedEnv.minRole || 'reader',
              },
              cloudConfig.refreshToken,
              operation.controller.signal
            );
            if (isStoreDisposed || cloudSessionGeneration !== capturedSessionGen) return taggedEnv.id;
            if (created && created.id) {
              reconcileEnvToTargetScope(created.id, created.version || 1);
              if (isSameTargetScope() && isAsyncOperationCurrent(operation)) {
                await flushStorePersistence();
              }
              return created.id;
            }
          } catch (err: any) {
            if (!isAsyncOperationCurrent(operation) || operation.controller.signal.aborted) {
              if (isSameTargetScope()) {
                throw new Error('Import operation was cancelled before completion.');
              }
              return taggedEnv.id;
            }
            if (!isSameTargetScope()) return taggedEnv.id;
            console.error('Failed to sync environment to cloud:', err);
            set((state) => ({
              environments: state.environments.map((e) =>
                e.id === taggedEnv.id ? { ...e, _syncStatus: 'pending', _pendingCreate: true } : e
              ),
              syncStatus: 'error',
              syncError: err.message || 'Failed to sync environment to cloud',
            }));
            throw err;
          } finally {
            completeAsyncOperation(operation);
          }
        }
        await flushStorePersistence();
        return taggedEnv.id;
      },

      replaceEnvironment: async (existingId: string, incomingEnv: Environment, options?: { target?: ImportTargetBinding }) => {
        if (options?.target && !matchesImportTarget(get(), options.target, cloudSessionGeneration)) {
          throw new Error('Workspace changed before environment replacement could be applied.');
        }

        const { workspaceMode, cloudConfig } = get();
        const state = get();
        const existingEnv = state.environments.find((e) => e.id === existingId);
        if (!existingEnv) {
          throw new Error('Existing environment not found');
        }

        if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
              !canModifyEnvironment(existingEnv.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            throw new Error('Insufficient permission to modify environments in this scope (requires env:write and adequate role)');
          }
        }

        if (envSyncDebounceTimers[existingId]) {
          clearTimeout(envSyncDebounceTimers[existingId]);
          delete envSyncDebounceTimers[existingId];
        }

        const alignedVars = alignEnvironmentVariableIds(existingEnv.variables || [], incomingEnv.variables || []);

        let effectiveMinRole = incomingEnv.minRole || existingEnv.minRole;
        if (incomingEnv.minRole && incomingEnv.minRole !== existingEnv.minRole && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!canModifyEnvironment(incomingEnv.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            effectiveMinRole = existingEnv.minRole;
          }
        }

        const wasPendingLocalCreate = Boolean(existingEnv._pendingCreate);
        const isCloud = workspaceMode === 'cloud';
        const replacedEnv: Environment = {
          ...incomingEnv,
          id: existingId,
          name: incomingEnv.name,
          variables: alignedVars,
          minRole: effectiveMinRole,
          version: existingEnv.version || 1,
          _syncStatus: isCloud ? 'pending' : 'synced',
          _pendingCreate: isCloud && wasPendingLocalCreate ? true : undefined,
          updatedAt: Date.now(),
        };

        set((s) => {
          const nextEnvironments = s.environments.map((e) => (e.id === existingId ? replacedEnv : e));
          const localId = s.activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
          const nextOfflineCache =
            s.workspaceMode === 'offline'
              ? {
                  ...(s.offlineScopeCache || {}),
                  [localId]: {
                    collections: s.collections,
                    tabs: s.tabs,
                    activeTabId: s.activeTabId,
                    history: s.history,
                    ...(s.offlineScopeCache?.[localId] || {}),
                    environments: nextEnvironments,
                    activeEnvironmentId: existingId,
                  },
                }
              : s.offlineScopeCache;
          return {
            environments: nextEnvironments,
            activeEnvironmentId: existingId,
            offlineScopeCache: nextOfflineCache,
          };
        });

        if (!isOfflineOnly && isCloud && isCloudSessionActive(cloudConfig) && cloudConfig.activeScope) {
          const operation = beginAsyncOperation();
          const targetScope = cloudConfig.activeScope;
          const capturedSessionGen = cloudSessionGeneration;
          const isSameTargetScope = () => {
            const live = get();
            return (
              !isStoreDisposed &&
              cloudSessionGeneration === capturedSessionGen &&
              live.workspaceMode === 'cloud' &&
              live.cloudConfig.activeScope?.id === targetScope.id &&
              live.cloudConfig.activeScope?.type === targetScope.type
            );
          };
          const reconcileReplacedEnv = (remoteId: string, remoteVersion: number) => {
            if (isStoreDisposed || cloudSessionGeneration !== capturedSessionGen) return;
            if (isSameTargetScope()) {
              set((s) => ({
                environments: s.environments.map((e) =>
                  e.id === existingId ? { ...e, id: remoteId, version: remoteVersion, _syncStatus: 'synced', _pendingCreate: undefined } : e
                ),
                activeEnvironmentId: s.activeEnvironmentId === existingId ? remoteId : s.activeEnvironmentId,
              }));
            } else {
              const targetKey = getScopeCacheKey(targetScope);
              set((s) => {
                const cached = s.scopeCache?.[targetKey];
                if (!cached) return {};
                return {
                  scopeCache: {
                    ...s.scopeCache,
                    [targetKey]: {
                      ...cached,
                      environments: (cached.environments || []).map((e) =>
                        e.id === existingId ? { ...e, id: remoteId, version: remoteVersion, _syncStatus: 'synced', _pendingCreate: undefined } : e
                      ),
                      activeEnvironmentId: cached.activeEnvironmentId === existingId ? remoteId : cached.activeEnvironmentId,
                    },
                  },
                };
              });
            }
          };
          try {
            if (wasPendingLocalCreate) {
              const created = await createScopeEnvironment(
                cloudConfig.apiUrl,
                cloudConfig.token,
                targetScope,
                {
                  name: replacedEnv.name,
                  variables: sanitizeVariablesForUpstream(replacedEnv.variables),
                  min_role: replacedEnv.minRole || 'reader',
                },
                cloudConfig.refreshToken,
                operation.controller.signal
              );
              if (isStoreDisposed || cloudSessionGeneration !== capturedSessionGen) return;
              if (created && created.id) {
                reconcileReplacedEnv(created.id, created.version || 1);
              }
              if (!isSameTargetScope() || !isAsyncOperationCurrent(operation)) return;
            } else {
              const res = await updateScopeEnvironment(
                cloudConfig.apiUrl,
                cloudConfig.token,
                existingId,
                {
                  name: replacedEnv.name,
                  variables: sanitizeVariablesForUpstream(replacedEnv.variables),
                  min_role: replacedEnv.minRole,
                  base_version: replacedEnv.version || 1,
                },
                cloudConfig.refreshToken,
                operation.controller.signal
              );
              if (isStoreDisposed || cloudSessionGeneration !== capturedSessionGen) return;
              const nextVersion = res && typeof res.version === 'number' ? res.version : (replacedEnv.version || 1);
              reconcileReplacedEnv(existingId, nextVersion);
              if (!isSameTargetScope() || !isAsyncOperationCurrent(operation)) return;
            }
          } catch (err: any) {
            if (!isAsyncOperationCurrent(operation) || operation.controller.signal.aborted) {
              if (isSameTargetScope()) {
                throw new Error('Import operation was cancelled before completion.');
              }
              return;
            }
            if (!isSameTargetScope()) return;
            if (err?.status === 409) {
              const remote = getRemoteEnvironment(err.data);
              set((state) => {
                if (!isAsyncOperationCurrent(operation) || !isSameTargetScope()) return {};
                return {
                  syncStatus: 'error',
                  syncError: 'Environment changes conflict with a newer server version. Review the conflict before saving again.',
                  environmentOccConflict: remote ? { local: replacedEnv, remote } : null,
                };
              });
            }
            console.error('Failed to sync replaced environment to cloud:', err);
            throw err;
          } finally {
            completeAsyncOperation(operation);
          }
        }
        await flushStorePersistence();
      },

      discardEnvironmentOccConflict: () => {
        const conflict = get().environmentOccConflict;
        if (!conflict) return;
        const resolved = preserveCurrentValues(conflict.remote, conflict.local);
        set((state) => ({
          environments: state.environments.map((environment) => environment.id === resolved.id ? resolved : environment),
          environmentOccConflict: null,
          syncStatus: 'idle',
          syncError: null,
        }));
      },

      overwriteEnvironmentOccConflict: async () => {
        const state = get();
        const conflict = state.environmentOccConflict;
        const { cloudConfig, workspaceMode } = state;
        if (!conflict || workspaceMode !== 'cloud' || !isCloudSessionActive(cloudConfig) || !cloudConfig.activeScope) return;
        if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role)) {
          set({ syncStatus: 'error', syncError: 'You no longer have permission to update this environment.' });
          return;
        }
        const operation = beginAsyncOperation();
        try {
          const response = await updateScopeEnvironment(
            cloudConfig.apiUrl,
            cloudConfig.token,
            conflict.local.id,
            {
              name: conflict.local.name,
              variables: sanitizeVariablesForUpstream(conflict.local.variables),
              min_role: conflict.local.minRole,
              base_version: conflict.remote.version || 1,
            },
            cloudConfig.refreshToken,
            operation.controller.signal
          );
          if (!isAsyncOperationCurrent(operation)) return;
          set((current) => {
            if (!isAsyncOperationCurrent(operation)) return {};
            return {
              environments: current.environments.map((environment) => environment.id === conflict.local.id
                ? { ...environment, version: response.version || conflict.remote.version, _syncStatus: 'synced', _pendingCreate: undefined }
                : environment),
              environmentOccConflict: null,
              syncStatus: 'synced',
              syncError: null,
            };
          });
        } catch (err: any) {
          if (!isAsyncOperationCurrent(operation)) return;
          const remote = err?.status === 409 ? getRemoteEnvironment(err.data) : null;
          set((current) => {
            if (!isAsyncOperationCurrent(operation)) return {};
            return {
              environmentOccConflict: remote ? { local: conflict.local, remote } : current.environmentOccConflict,
              syncStatus: 'error',
              syncError: err?.status === 409
                ? 'The server changed again. Review the latest version before saving.'
                : err?.message || 'Failed to update environment.',
            };
          });
        } finally {
          completeAsyncOperation(operation);
        }
      },

      setSidebarTab: (sidebarTab) => set({ sidebarTab }),

      setActiveTabId: (activeTabId) => {
        set((state) => ({
          activeTabId,
          activeResponse: state.tabResponses?.[activeTabId] || null,
          selectedExample: null,
          tabRevealRevision: state.tabRevealRevision + 1,
          canUndoActiveRequest: (tabUndoHistory[activeTabId]?.past?.length ?? 0) > 0,
          canRedoActiveRequest: (tabUndoHistory[activeTabId]?.future?.length ?? 0) > 0,
        }));
      },

      createTab: (initial) => {
        const url = initial?.url || '';
        const newReq: ApiRequest = {
          id: generateId(),
          name: initial?.name || 'Untitled Request',
          method: initial?.method || 'GET',
          url,
          params: initial?.params?.length ? initial.params : parseQueryParamsFromUrl(url),
          pathVariables: initial?.pathVariables ?? parsePathVariablesFromUrl(url),
          headers: initial?.headers?.length ? initial.headers : [{ id: generateId(), key: '', value: '', enabled: true }],
          auth: initial?.auth || { type: 'none' },
          bodyType: initial?.bodyType || 'none',
          rawType: initial?.rawType || 'text',
          bodyContent: initial?.bodyContent || '',
          graphqlQuery: initial?.graphqlQuery || '',
          graphqlVariables: initial?.graphqlVariables || '',
          bodyFormData: initial?.bodyFormData || [],
          bodyBinaryFile: initial?.bodyBinaryFile,
          bodyUrlEncoded: initial?.bodyUrlEncoded?.length ? initial.bodyUrlEncoded : [{ id: generateId(), key: '', value: '', enabled: true }],
          preRequestScript: initial?.preRequestScript || '',
          postResponseScript: initial?.postResponseScript || '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        set((state) => ({
          tabs: [...state.tabs, newReq],
          activeTabId: newReq.id,
          activeResponse: null,
          selectedExample: null,
          tabOrder: [...syncVisualTabOrder(state.tabs, state.openExampleTabs, state.tabOrder), newReq.id],
          tabRevealRevision: state.tabRevealRevision + 1,
          canUndoActiveRequest: false,
          canRedoActiveRequest: false,
        }));
      },

      closeTab: (id) => {
        let aborted = false;
        if (activeRequestOperation && activeRequestTabId === id) {
          activeRequestOperation.controller.abort();
          activeRequestOperation = null;
          activeRequestTabId = null;
          aborted = true;
        }

        delete tabUndoHistory[id];
        if (undoTypingTimers[id]) {
          clearTimeout(undoTypingTimers[id]);
          delete undoTypingTimers[id];
        }

        set((state) => {
          const shouldResetLoading = aborted || (state.isLoading && state.activeTabId === id && !activeRequestOperation);
          const closedResponse = state.tabResponses?.[id];
          const remainingTabResponses = Object.entries(state.tabResponses || {})
            .filter(([tabId]) => tabId !== id)
            .map(([, res]) => res);
          revokeUnreferencedResponses(
            [closedResponse],
            remainingTabResponses,
            [
              state.history,
              ...Object.values(state.scopeCache || {}).map((e) => e.history),
              ...Object.values(state.offlineScopeCache || {}).map((e) => e.history),
            ]
          );

          const nextTabResponses = { ...(state.tabResponses || {}) };
          delete nextTabResponses[id];

          const ordered = buildOrderedVisualTabs(state.tabs, state.openExampleTabs, state.tabOrder);
          const closingVisualIndex = ordered.findIndex((entry) => entry.kind === 'request' && entry.id === id);
          const remainingOrdered = ordered.filter((entry) => entry.id !== id);
          const nextTabOrder = remainingOrdered.map((entry) => entry.id);
          const filteredTabs = state.tabs.filter((t) => t.id !== id);

          const wasRequestTabActive = !state.selectedExample && state.activeTabId === id;
          let newActiveId = state.activeTabId;
          let nextSelectedExample = state.selectedExample;
          let nextRevealRevision = state.tabRevealRevision;

          if (wasRequestTabActive) {
            const adj =
              remainingOrdered[closingVisualIndex] ||
              remainingOrdered[closingVisualIndex - 1] ||
              remainingOrdered[0];
            if (!adj) {
              newActiveId = '';
              nextSelectedExample = null;
            } else if (adj.kind === 'example') {
              nextSelectedExample = {
                collectionId: adj.exampleTab.collectionId,
                itemId: adj.exampleTab.itemId,
                exampleId: adj.exampleTab.exampleId,
              };
              newActiveId = filteredTabs[0]?.id || '';
              nextRevealRevision += 1;
            } else {
              newActiveId = adj.id;
              nextSelectedExample = null;
              nextRevealRevision += 1;
            }
          } else if (state.activeTabId === id) {
            const closingIndex = state.tabs.findIndex((t) => t.id === id);
            const fallbackTab = filteredTabs[closingIndex] || filteredTabs[closingIndex - 1] || filteredTabs[0];
            newActiveId = fallbackTab?.id || '';
          }

          return {
            tabs: filteredTabs,
            activeTabId: newActiveId,
            activeResponse: newActiveId ? (nextTabResponses[newActiveId] || null) : null,
            tabResponses: nextTabResponses,
            selectedExample: nextSelectedExample,
            tabOrder: nextTabOrder,
            tabRevealRevision: nextRevealRevision,
            canUndoActiveRequest: newActiveId ? (tabUndoHistory[newActiveId]?.past?.length ?? 0) > 0 : false,
            canRedoActiveRequest: newActiveId ? (tabUndoHistory[newActiveId]?.future?.length ?? 0) > 0 : false,
            ...(shouldResetLoading ? { isLoading: false } : {}),
          };
        });
      },

      closeOtherTabs: (id) => {
        if (isExampleTabId(id)) {
          const currentExample = (get().openExampleTabs || []).find((ex) => ex.id === id);
          if (!currentExample) return;

          if (activeRequestOperation) {
            activeRequestOperation.controller.abort();
            activeRequestOperation = null;
            activeRequestTabId = null;
          }
          for (const key of Object.keys(tabUndoHistory)) {
            delete tabUndoHistory[key];
          }
          for (const key of Object.keys(undoTypingTimers)) {
            clearTimeout(undoTypingTimers[key]);
            delete undoTypingTimers[key];
          }

          set((state) => {
            revokeUnreferencedResponses(
              [state.activeResponse, ...Object.values(state.tabResponses || {})],
              [],
              [
                state.history,
                ...Object.values(state.scopeCache || {}).map((e) => e.history),
                ...Object.values(state.offlineScopeCache || {}).map((e) => e.history),
              ]
            );
            return {
              tabs: [],
              activeTabId: '',
              activeResponse: null,
              tabResponses: {},
              openExampleTabs: [currentExample],
              tabOrder: [currentExample.id],
              selectedExample: {
                collectionId: currentExample.collectionId,
                itemId: currentExample.itemId,
                exampleId: currentExample.exampleId,
              },
              tabRevealRevision: state.tabRevealRevision + 1,
              isLoading: false,
              canUndoActiveRequest: false,
              canRedoActiveRequest: false,
            };
          });
          return;
        }

        let aborted = false;
        if (activeRequestOperation && activeRequestTabId && activeRequestTabId !== id) {
          activeRequestOperation.controller.abort();
          activeRequestOperation = null;
          activeRequestTabId = null;
          aborted = true;
        }

        for (const key of Object.keys(tabUndoHistory)) {
          if (key !== id) {
            delete tabUndoHistory[key];
          }
        }
        for (const key of Object.keys(undoTypingTimers)) {
          if (key !== id) {
            clearTimeout(undoTypingTimers[key]);
            delete undoTypingTimers[key];
          }
        }

        set((state) => {
          const targetTab = state.tabs.find((t) => t.id === id);
          if (!targetTab) return state;

          const shouldResetLoading = aborted || (state.isLoading && !activeRequestOperation);

          const nextTabResponses: Record<string, ApiResponse> = {};
          if (state.tabResponses?.[id]) {
            nextTabResponses[id] = state.tabResponses[id];
          }

          const removedResponses = Object.entries(state.tabResponses || {})
            .filter(([tabId]) => tabId !== id)
            .map(([, res]) => res);
          revokeUnreferencedResponses(
            removedResponses,
            nextTabResponses[id] ? [nextTabResponses[id]] : [],
            [
              state.history,
              ...Object.values(state.scopeCache || {}).map((e) => e.history),
              ...Object.values(state.offlineScopeCache || {}).map((e) => e.history),
            ]
          );

          return {
            tabs: [targetTab],
            activeTabId: id,
            activeResponse: nextTabResponses[id] || null,
            tabResponses: nextTabResponses,
            openExampleTabs: [],
            tabOrder: [id],
            selectedExample: null,
            tabRevealRevision: state.tabRevealRevision + 1,
            canUndoActiveRequest: (tabUndoHistory[id]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[id]?.future?.length ?? 0) > 0,
            ...(shouldResetLoading ? { isLoading: false } : {}),
          };
        });
      },

      closeAllTabs: () => {
        if (activeRequestOperation) {
          activeRequestOperation.controller.abort();
          activeRequestOperation = null;
          activeRequestTabId = null;
        }

        for (const key of Object.keys(tabUndoHistory)) {
          delete tabUndoHistory[key];
        }
        for (const key of Object.keys(undoTypingTimers)) {
          clearTimeout(undoTypingTimers[key]);
          delete undoTypingTimers[key];
        }

        set((state) => {
          revokeUnreferencedResponses(
            [state.activeResponse, ...Object.values(state.tabResponses || {})],
            [],
            [
              state.history,
              ...Object.values(state.scopeCache || {}).map((e) => e.history),
              ...Object.values(state.offlineScopeCache || {}).map((e) => e.history),
            ]
          );

          return {
            tabs: [],
            activeTabId: '',
            activeResponse: null,
            tabResponses: {},
            openExampleTabs: [],
            tabOrder: [],
            selectedExample: null,
            isLoading: false,
            canUndoActiveRequest: false,
            canRedoActiveRequest: false,
          };
        });
      },

      closeTabsToRight: (id) => {
        set((state) => {
          const ordered = buildOrderedVisualTabs(state.tabs, state.openExampleTabs, state.tabOrder);
          const pivotIndex = ordered.findIndex((entry) => entry.id === id);
          if (pivotIndex === -1) return state;

          const keptEntries = ordered.slice(0, pivotIndex + 1);
          const remainingTabs = keptEntries
            .filter((entry): entry is { kind: 'request'; id: string; tab: RequestTab } => entry.kind === 'request')
            .map((entry) => entry.tab);
          const remainingExampleTabs = keptEntries
            .filter((entry): entry is { kind: 'example'; id: string; exampleTab: OpenExampleTab } => entry.kind === 'example')
            .map((entry) => entry.exampleTab);
          const remainingOrder = keptEntries.map((entry) => entry.id);
          const remainingRequestIds = new Set(remainingTabs.map((t) => t.id));

          for (const key of Object.keys(tabUndoHistory)) {
            if (!remainingRequestIds.has(key)) {
              delete tabUndoHistory[key];
            }
          }
          for (const key of Object.keys(undoTypingTimers)) {
            if (!remainingRequestIds.has(key)) {
              clearTimeout(undoTypingTimers[key]);
              delete undoTypingTimers[key];
            }
          }

          let shouldResetLoading = false;
          if (activeRequestOperation && activeRequestTabId && !remainingRequestIds.has(activeRequestTabId)) {
            activeRequestOperation.controller.abort();
            activeRequestOperation = null;
            activeRequestTabId = null;
            shouldResetLoading = true;
          }

          const currentVisualId = state.selectedExample
            ? makeExampleTabId(state.selectedExample)
            : state.activeTabId;
          const wasCurrentVisualClosed = !keptEntries.some((entry) => entry.id === currentVisualId);
          const pivotEntry = keptEntries[pivotIndex];

          let nextActiveId = remainingRequestIds.has(state.activeTabId)
            ? state.activeTabId
            : (remainingTabs[0]?.id || '');
          let nextSelectedExample = state.selectedExample;
          let nextRevealRevision = state.tabRevealRevision;

          if (wasCurrentVisualClosed) {
            nextRevealRevision += 1;
            if (pivotEntry.kind === 'example') {
              nextSelectedExample = {
                collectionId: pivotEntry.exampleTab.collectionId,
                itemId: pivotEntry.exampleTab.itemId,
                exampleId: pivotEntry.exampleTab.exampleId,
              };
            } else {
              nextSelectedExample = null;
              nextActiveId = pivotEntry.id;
            }
          }

          const nextTabResponses: Record<string, ApiResponse> = {};
          const closedResponses: ApiResponse[] = [];
          Object.entries(state.tabResponses || {}).forEach(([tabId, res]) => {
            if (remainingRequestIds.has(tabId)) {
              nextTabResponses[tabId] = res;
            } else {
              closedResponses.push(res);
            }
          });
          revokeUnreferencedResponses(
            closedResponses,
            Object.values(nextTabResponses),
            [
              state.history,
              ...Object.values(state.scopeCache || {}).map((e) => e.history),
              ...Object.values(state.offlineScopeCache || {}).map((e) => e.history),
            ]
          );

          return {
            tabs: remainingTabs,
            activeTabId: nextActiveId,
            activeResponse: nextActiveId ? (nextTabResponses[nextActiveId] || null) : null,
            tabResponses: nextTabResponses,
            openExampleTabs: remainingExampleTabs,
            tabOrder: remainingOrder,
            selectedExample: nextSelectedExample,
            tabRevealRevision: nextRevealRevision,
            canUndoActiveRequest: nextActiveId ? (tabUndoHistory[nextActiveId]?.past?.length ?? 0) > 0 : false,
            canRedoActiveRequest: nextActiveId ? (tabUndoHistory[nextActiveId]?.future?.length ?? 0) > 0 : false,
            ...(shouldResetLoading ? { isLoading: false } : {}),
          };
        });
      },

      duplicateTab: (id) => {
        set((state) => {
          const sourceTab = state.tabs.find((t) => t.id === id);
          if (!sourceTab) return state;
          const duplicatedTab: RequestTab = {
            ...sourceTab,
            id: generateId(),
            name: `${sourceTab.name || 'Untitled Request'} (Copy)`,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            params: sourceTab.params.map((p) => ({ ...p, id: generateId() })),
            headers: sourceTab.headers.map((h) => ({ ...h, id: generateId() })),
            bodyFormData: sourceTab.bodyFormData ? sourceTab.bodyFormData.map((f) => ({ ...f, id: generateId() })) : [],
            bodyUrlEncoded: sourceTab.bodyUrlEncoded ? sourceTab.bodyUrlEncoded.map((u) => ({ ...u, id: generateId() })) : [{ id: generateId(), key: '', value: '', enabled: true }],
          };
          delete duplicatedTab.deletedFromCollection;
          const index = state.tabs.findIndex((t) => t.id === id);
          const newTabs = [...state.tabs];
          newTabs.splice(index + 1, 0, duplicatedTab);
          const currentOrder = syncVisualTabOrder(state.tabs, state.openExampleTabs, state.tabOrder);
          const orderIdx = currentOrder.indexOf(id);
          const nextOrder = [...currentOrder];
          if (orderIdx >= 0) {
            nextOrder.splice(orderIdx + 1, 0, duplicatedTab.id);
          } else {
            nextOrder.push(duplicatedTab.id);
          }
          return {
            tabs: newTabs,
            activeTabId: duplicatedTab.id,
            activeResponse: null,
            selectedExample: null,
            tabOrder: nextOrder,
            tabRevealRevision: state.tabRevealRevision + 1,
            canUndoActiveRequest: false,
            canRedoActiveRequest: false,
          };
        });
      },

      updateActiveRequest: (updates) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab) {
            if (updates.id !== undefined && updates.id !== state.activeTabId) {
              if (tabUndoHistory[state.activeTabId]) {
                tabUndoHistory[updates.id] = tabUndoHistory[state.activeTabId];
                delete tabUndoHistory[state.activeTabId];
              }
              if (undoTypingTimers[state.activeTabId]) {
                undoTypingTimers[updates.id] = undoTypingTimers[state.activeTabId];
                delete undoTypingTimers[state.activeTabId];
              }
            } else {
              let isTyping = false;
              if (updates.name !== undefined) {
                isTyping = Math.abs((updates.name || '').length - (currentTab.name || '').length) <= 1;
              } else if (updates.url !== undefined) {
                isTyping = Math.abs((updates.url || '').length - (currentTab.url || '').length) <= 1;
              }
              pushTabSnapshot(currentTab.id, currentTab, isTyping);
            }
          }

          const nextActiveTabId = updates.id !== undefined ? updates.id : state.activeTabId;
          let nextTabResponses = state.tabResponses;
          if (updates.id !== undefined && updates.id !== state.activeTabId && state.tabResponses?.[state.activeTabId]) {
            nextTabResponses = { ...(state.tabResponses || {}) };
            nextTabResponses[updates.id] = nextTabResponses[state.activeTabId];
            delete nextTabResponses[state.activeTabId];
          }
          const nextTabOrder = updates.id !== undefined && updates.id !== state.activeTabId
            ? (state.tabOrder || []).map((tabId) => (tabId === state.activeTabId ? updates.id! : tabId))
            : state.tabOrder;
          return {
            activeTabId: nextActiveTabId,
            tabResponses: nextTabResponses,
            tabOrder: nextTabOrder,
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              if (updates.id !== undefined && updates.id !== tab.id) {
                tab = { ...tab };
                delete tab.deletedFromCollection;
              }
              if (updates.url !== undefined && updates.url !== tab.url) {
                const syncedParams = updates.params !== undefined ? updates.params : parseQueryParamsFromUrl(updates.url, tab.params);
                const syncedPathVars = updates.pathVariables !== undefined ? updates.pathVariables : parsePathVariablesFromUrl(updates.url, tab.pathVariables);
                return { ...tab, ...updates, params: syncedParams, pathVariables: syncedPathVars, updatedAt: Date.now() };
              }
              return { ...tab, ...updates, updatedAt: Date.now() };
            }),
            canUndoActiveRequest: (tabUndoHistory[nextActiveTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[nextActiveTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      updateParam: (id, updates) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab) {
            pushTabSnapshot(currentTab.id, currentTab, true);
          }
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              const updatedParams = tab.params.map((p) => (p.id === id ? { ...p, ...updates } : p));
              const updatedUrl = buildUrlWithParams(tab.url, updatedParams);
              return { ...tab, params: updatedParams, url: updatedUrl, updatedAt: Date.now() };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      addParam: () => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab) {
            pushTabSnapshot(currentTab.id, currentTab, false);
          }
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              const updatedParams = [...tab.params, { id: generateId(), key: '', value: '', enabled: true }];
              const updatedUrl = buildUrlWithParams(tab.url, updatedParams);
              return {
                ...tab,
                params: updatedParams,
                url: updatedUrl,
                updatedAt: Date.now(),
              };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      removeParam: (id) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab) {
            pushTabSnapshot(currentTab.id, currentTab, false);
          }
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              const updatedParams = tab.params.filter((p) => p.id !== id);
              const updatedUrl = buildUrlWithParams(tab.url, updatedParams);
              return {
                ...tab,
                params: updatedParams,
                url: updatedUrl,
                updatedAt: Date.now(),
              };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      updatePathVariable: (id, updates) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab) {
            pushTabSnapshot(currentTab.id, currentTab, true);
          }
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              const updatedPathVars = (tab.pathVariables || []).map((pv) =>
                pv.id === id ? { ...pv, ...updates } : pv
              );
              return {
                ...tab,
                pathVariables: updatedPathVars,
                updatedAt: Date.now(),
              };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      updateHeader: (id, updates) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab) {
            pushTabSnapshot(currentTab.id, currentTab, true);
          }
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              const updatedHeaders = tab.headers.map((h) => (h.id === id ? { ...h, ...updates } : h));
              return { ...tab, headers: updatedHeaders, updatedAt: Date.now() };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      addHeader: () => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab) {
            pushTabSnapshot(currentTab.id, currentTab, false);
          }
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              return {
                ...tab,
                headers: [...tab.headers, { id: generateId(), key: '', value: '', enabled: true }],
                updatedAt: Date.now(),
              };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      removeHeader: (id) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab) {
            pushTabSnapshot(currentTab.id, currentTab, false);
          }
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              return {
                ...tab,
                headers: tab.headers.filter((h) => h.id !== id),
                updatedAt: Date.now(),
              };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      updateAuth: (authUpdates) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab) {
            const isTyping = authUpdates.type === undefined;
            pushTabSnapshot(currentTab.id, currentTab, isTyping);
          }
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              return {
                ...tab,
                auth: { ...tab.auth, ...authUpdates },
                updatedAt: Date.now(),
              };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      setBodyType: (bodyType) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab && currentTab.bodyType !== bodyType) {
            pushTabSnapshot(currentTab.id, currentTab, false);
          }
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              let rawType = tab.rawType || 'text';
              if (bodyType === 'json') rawType = 'json';
              else if (bodyType === 'xml') rawType = 'xml';
              const method = (bodyType === 'graphql' || bodyType === 'form-data' || bodyType === 'x-www-form-urlencoded') && tab.method === 'GET' ? 'POST' : tab.method;

              let bodyUrlEncoded = tab.bodyUrlEncoded;
              if (bodyType === 'x-www-form-urlencoded') {
                const hasRealItems =
                  bodyUrlEncoded &&
                  bodyUrlEncoded.some(
                    (item) => String(item?.key ?? '').trim() || String(item?.value ?? '').trim()
                  );
                if (!hasRealItems) {
                  const trimmedBody = (tab.bodyContent || '').trim();
                  if (trimmedBody.startsWith('{')) {
                    try {
                      const parsed = JSON.parse(trimmedBody);
                      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                        const items: KeyValuePair[] = Object.entries(parsed).map(([k, v]) => ({
                          id: generateId(),
                          key: k,
                          value: typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''),
                          enabled: true,
                        }));
                        if (items.length > 0) bodyUrlEncoded = items;
                      }
                    } catch {
                      // ignore JSON parse error
                    }
                  } else if (trimmedBody.includes('=')) {
                    try {
                      const params = new URLSearchParams(trimmedBody);
                      const items: KeyValuePair[] = [];
                      params.forEach((v, k) => {
                        items.push({ id: generateId(), key: k, value: v, enabled: true });
                      });
                      if (items.length > 0) bodyUrlEncoded = items;
                    } catch {
                      // ignore
                    }
                  }
                }

                if (!bodyUrlEncoded || bodyUrlEncoded.length === 0) {
                  bodyUrlEncoded = [{ id: generateId(), key: '', value: '', enabled: true }];
                }
              }

              return { ...tab, bodyType, rawType, method, bodyUrlEncoded, updatedAt: Date.now() };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      setRawType: (rawType) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab && currentTab.rawType !== rawType) {
            pushTabSnapshot(currentTab.id, currentTab, false);
          }
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              return { ...tab, rawType, updatedAt: Date.now() };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      setBodyContent: (bodyContent, isDiscrete?: boolean) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab && currentTab.bodyContent !== bodyContent) {
            const isTyping = isDiscrete ? false : Math.abs(bodyContent.length - (currentTab.bodyContent || '').length) <= 1;
            pushTabSnapshot(currentTab.id, currentTab, isTyping);
          }
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              return { ...tab, bodyContent, updatedAt: Date.now() };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      setGraphqlQuery: (graphqlQuery, isDiscrete?: boolean) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab && currentTab.graphqlQuery !== graphqlQuery) {
            const isTyping = isDiscrete ? false : Math.abs(graphqlQuery.length - (currentTab.graphqlQuery || '').length) <= 1;
            pushTabSnapshot(currentTab.id, currentTab, isTyping);
          }
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              return { ...tab, graphqlQuery, updatedAt: Date.now() };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      setGraphqlVariables: (graphqlVariables, isDiscrete?: boolean) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab && currentTab.graphqlVariables !== graphqlVariables) {
            const isTyping = isDiscrete ? false : Math.abs(graphqlVariables.length - (currentTab.graphqlVariables || '').length) <= 1;
            pushTabSnapshot(currentTab.id, currentTab, isTyping);
          }
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              return { ...tab, graphqlVariables, updatedAt: Date.now() };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      setPreRequestScript: (preRequestScript, isDiscrete?: boolean) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab && currentTab.preRequestScript !== preRequestScript) {
            const isTyping = isDiscrete ? false : Math.abs(preRequestScript.length - (currentTab.preRequestScript || '').length) <= 1;
            pushTabSnapshot(currentTab.id, currentTab, isTyping);
          }
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              return { ...tab, preRequestScript, updatedAt: Date.now() };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      setPostResponseScript: (postResponseScript, isDiscrete?: boolean) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab && currentTab.postResponseScript !== postResponseScript) {
            const isTyping = isDiscrete ? false : Math.abs(postResponseScript.length - (currentTab.postResponseScript || '').length) <= 1;
            pushTabSnapshot(currentTab.id, currentTab, isTyping);
          }
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              return { ...tab, postResponseScript, updatedAt: Date.now() };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      // Form Data actions
      updateFormDataItem: (id, updates) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab) {
            const isTyping = updates.type === undefined && updates.file === undefined;
            pushTabSnapshot(currentTab.id, currentTab, isTyping);
          }
          const currentList = currentTab?.bodyFormData || [];
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              return {
                ...tab,
                bodyFormData: currentList.map((item) => (item.id === id ? { ...item, ...updates } : item)),
                updatedAt: Date.now(),
              };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      addFormDataItem: () => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab) {
            pushTabSnapshot(currentTab.id, currentTab, false);
          }
          const currentList = currentTab?.bodyFormData || [];
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              return {
                ...tab,
                bodyFormData: [
                  ...currentList,
                  { id: generateId(), key: '', type: 'text', value: '', enabled: true },
                ],
                updatedAt: Date.now(),
              };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      removeFormDataItem: (id) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab) {
            pushTabSnapshot(currentTab.id, currentTab, false);
          }
          const currentList = currentTab?.bodyFormData || [];
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              return {
                ...tab,
                bodyFormData: currentList.filter((item) => item.id !== id),
                updatedAt: Date.now(),
              };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      setBodyBinaryFile: (bodyBinaryFile) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab) {
            pushTabSnapshot(currentTab.id, currentTab, false);
          }
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              return { ...tab, bodyBinaryFile, updatedAt: Date.now() };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      // URL-Encoded Form actions
      updateUrlEncodedItem: (id, updates) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab) {
            pushTabSnapshot(currentTab.id, currentTab, true);
          }
          const currentList = currentTab?.bodyUrlEncoded || [];
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              return {
                ...tab,
                bodyUrlEncoded: currentList.map((item) => (item.id === id ? { ...item, ...updates } : item)),
                updatedAt: Date.now(),
              };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      addUrlEncodedItem: () => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab) {
            pushTabSnapshot(currentTab.id, currentTab, false);
          }
          const currentList = currentTab?.bodyUrlEncoded || [];
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              return {
                ...tab,
                bodyUrlEncoded: [
                  ...currentList,
                  { id: generateId(), key: '', value: '', enabled: true },
                ],
                updatedAt: Date.now(),
              };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      removeUrlEncodedItem: (id) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab) {
            pushTabSnapshot(currentTab.id, currentTab, false);
          }
          const currentList = currentTab?.bodyUrlEncoded || [];
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              return {
                ...tab,
                bodyUrlEncoded: currentList.filter((item) => item.id !== id),
                updatedAt: Date.now(),
              };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      setUrlEncodedItems: (items) => {
        set((state) => {
          const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (currentTab) {
            pushTabSnapshot(currentTab.id, currentTab, false);
          }
          return {
            tabs: state.tabs.map((tab) => {
              if (tab.id !== state.activeTabId) return tab;
              return {
                ...tab,
                bodyUrlEncoded: items,
                updatedAt: Date.now(),
              };
            }),
            canUndoActiveRequest: (tabUndoHistory[state.activeTabId]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[state.activeTabId]?.future?.length ?? 0) > 0,
          };
        });
      },

      undoActiveRequest: () => {
        set((state) => {
          const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (!activeTab) return state;

          const history = tabUndoHistory[activeTab.id];
          if (!history || history.past.length === 0) return state;

          if (undoTypingTimers[activeTab.id]) {
            clearTimeout(undoTypingTimers[activeTab.id]);
            delete undoTypingTimers[activeTab.id];
          }

          const previousState = history.past.pop()!;
          history.future.push(cloneRequestPreservingAttachments(activeTab));
          if (history.future.length > MAX_UNDO_HISTORY) {
            history.future.shift();
          }

          const restoredTab: RequestTab = {
            ...cloneRequestPreservingAttachments(previousState),
            id: activeTab.id,
            deletedFromCollection: activeTab.deletedFromCollection,
          };

          return {
            tabs: state.tabs.map((t) => (t.id === activeTab.id ? restoredTab : t)),
            canUndoActiveRequest: history.past.length > 0,
            canRedoActiveRequest: history.future.length > 0,
          };
        });
      },

      redoActiveRequest: () => {
        set((state) => {
          const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (!activeTab) return state;

          const history = tabUndoHistory[activeTab.id];
          if (!history || history.future.length === 0) return state;

          if (undoTypingTimers[activeTab.id]) {
            clearTimeout(undoTypingTimers[activeTab.id]);
            delete undoTypingTimers[activeTab.id];
          }

          const nextState = history.future.pop()!;
          history.past.push(cloneRequestPreservingAttachments(activeTab));
          if (history.past.length > MAX_UNDO_HISTORY) {
            history.past.shift();
          }

          const restoredTab: RequestTab = {
            ...cloneRequestPreservingAttachments(nextState),
            id: activeTab.id,
            deletedFromCollection: activeTab.deletedFromCollection,
          };

          return {
            tabs: state.tabs.map((t) => (t.id === activeTab.id ? restoredTab : t)),
            canUndoActiveRequest: history.past.length > 0,
            canRedoActiveRequest: history.future.length > 0,
          };
        });
      },

      sendRequest: async () => {
        const state = get();
        const activeReq = state.tabs.find((t) => t.id === state.activeTabId);
        if (!activeReq || !activeReq.url.trim() || state.isLoading) return;
        const capturedRequest = cloneRequestPreservingAttachments(activeReq);

        const operation = beginAsyncOperation();
        activeRequestOperation = operation;
        activeRequestTabId = activeReq.id;
        set((s) => {
          const prevTabResponse = s.tabResponses?.[activeReq.id];
          const prevActive = s.activeTabId === activeReq.id ? s.activeResponse : undefined;
          const remainingTabResponses = Object.entries(s.tabResponses || {})
            .filter(([tabId]) => tabId !== activeReq.id)
            .map(([, res]) => res);
          revokeUnreferencedResponses(
            [prevTabResponse, prevActive],
            remainingTabResponses,
            [
              s.history,
              ...Object.values(s.scopeCache || {}).map((e) => e.history),
              ...Object.values(s.offlineScopeCache || {}).map((e) => e.history),
            ]
          );

          const nextTabResponses = { ...(s.tabResponses || {}) };
          delete nextTabResponses[activeReq.id];
          return {
            isLoading: true,
            activeResponse: null,
            tabResponses: nextTabResponses,
          };
        });

        try {
          // 1. Collect current active environment variables
          const activeEnv = state.environments.find((e) => e.id === state.activeEnvironmentId);
          const envVarsMap: Record<string, string> = {};
          if (activeEnv) {
            activeEnv.variables.forEach((v) => {
              if (v.enabled && v.key.trim() !== '') {
                const effVal = v.currentValue !== undefined && v.currentValue !== ''
                  ? v.currentValue
                  : (v.initialValue ?? v.value ?? '');
                envVarsMap[v.key.trim()] = effVal;
              }
            });
          }

          // Construct script request snapshot
          const scriptRequest: ScriptRequest = {
            url: activeReq.url,
            method: activeReq.method,
            headers: activeReq.headers,
            params: activeReq.params,
            body: {
              mode: activeReq.bodyType,
              raw: activeReq.bodyContent,
              urlencoded: activeReq.bodyUrlEncoded,
              formdata: activeReq.bodyFormData?.map((f) => ({ key: f.key, value: f.value, enabled: f.enabled })),
            },
          };

          // 2. Execute Pre-request Script (if present)
          const scriptResult = await executePreRequestScript(
            activeReq.preRequestScript || '',
            envVarsMap,
            {},
            { signal: operation.controller.signal, scriptExecutor: boundAdapter?.scriptExecutor, request: scriptRequest }
          );

          if (!isAsyncOperationCurrent(operation)) return;

          if (!scriptResult.success) {
            const scriptError = scriptResult.error || 'The pre-request script failed before the request could be sent.';
            const scriptFailureResponse: ApiResponse = {
              status: 0,
              statusText: 'Pre-request Script Failed',
              timeMs: 0,
              sizeBytes: 0,
              headers: {},
              data: 'Request was not sent because its pre-request script failed.',
              isError: true,
              errorDetail: scriptError,
              scriptError,
              scriptErrorStage: 'pre-request',
              requestUrl: activeReq.url,
              timestamp: Date.now(),
            };

            set((s) => ({
              activeResponse: scriptFailureResponse,
              tabResponses: { ...(s.tabResponses || {}), [activeReq.id]: scriptFailureResponse },
              isLoading: false,
            }));
            return;
          }

          // Update environment with any modifications made by pm.environment.set() (updates currentValue ONLY without upstream sync)
          if (activeEnv) {
            set((s) => ({
              environments: s.environments.map((e) => {
                if (e.id !== activeEnv.id) return e;
                const updatedVariables = [...e.variables];
                Object.entries(scriptResult.environment).forEach(([key, val]) => {
                  const existingIdx = updatedVariables.findIndex((v) => v.key.trim() === key);
                  if (existingIdx >= 0) {
                    updatedVariables[existingIdx] = {
                      ...updatedVariables[existingIdx],
                      currentValue: val,
                    };
                  } else {
                    updatedVariables.push({
                      id: generateId(),
                      key,
                      value: '',
                      initialValue: '',
                      currentValue: val,
                      enabled: true,
                    });
                  }
                });
                return {
                  ...e,
                  variables: updatedVariables,
                  updatedAt: Date.now(),
                };
              }),
            }));
          }

          // Merge environment variables and script runtime variables
          const finalVariables = {
            ...scriptResult.environment,
            ...scriptResult.variables,
          };

          // If the script mutated the request (query params, headers, url):
          let reqToSend = activeReq;
          if (scriptResult.mutatedRequest) {
            const { url: mutatedUrl, queryParams: mutatedQueryParams, headers: mutatedHeaders } = scriptResult.mutatedRequest;
            let effectiveUrl = activeReq.url;
            let effectiveParams = activeReq.params;
            let effectiveHeaders = activeReq.headers;

            if (mutatedQueryParams && mutatedQueryParams.length > 0) {
              effectiveParams = mutatedQueryParams.map((qp) => {
                const existing = (activeReq.params || []).find((p) => p.key === qp.key);
                return {
                  id: existing?.id || generateId(),
                  key: qp.key,
                  value: qp.value,
                  enabled: true,
                  description: existing?.description,
                };
              });
              if (mutatedUrl) {
                effectiveUrl = mutatedUrl;
              }
            } else if (mutatedUrl) {
              effectiveUrl = mutatedUrl;
            }

            if (mutatedHeaders && mutatedHeaders.length > 0) {
              effectiveHeaders = mutatedHeaders.map((mh) => {
                const existing = (activeReq.headers || []).find((h) => h.key.toLowerCase() === mh.key.toLowerCase());
                return {
                  id: existing?.id || generateId(),
                  key: mh.key,
                  value: mh.value,
                  enabled: true,
                  description: existing?.description,
                };
              });
            }

            reqToSend = {
              ...activeReq,
              url: effectiveUrl,
              params: effectiveParams,
              headers: effectiveHeaders,
            };
          }

          // 3. Dispatch API request with interpolated variables
          const response = await executeApiRequest(
            reqToSend,
            finalVariables,
            operation.controller.signal,
            boundAdapter
          );
          if (!isAsyncOperationCurrent(operation)) {
            revokeBlobUrl(response.blobUrl);
            safeReleaseRawBody(response.rawBodyId);
            return;
          }

          // 4. Execute Post-response script (tests, token extraction)
          let scriptError: string | undefined;
          let scriptErrorStage: ApiResponse['scriptErrorStage'];
          const updatedKeys: string[] = [];

          if (!response.failureKind && activeReq.postResponseScript && activeReq.postResponseScript.trim()) {
            const postScriptResult = await executePostResponseScript(
              activeReq.postResponseScript,
              response,
              finalVariables,
              scriptResult.variables,
              { signal: operation.controller.signal, scriptExecutor: boundAdapter?.scriptExecutor, request: scriptRequest }
            );

            if (!isAsyncOperationCurrent(operation)) {
              revokeBlobUrl(response.blobUrl);
              safeReleaseRawBody(response.rawBodyId);
              return;
            }

            if (postScriptResult.success && activeEnv) {
              set((s) => ({
                environments: s.environments.map((e) => {
                  if (e.id !== activeEnv.id) return e;
                  const updatedVariables = [...e.variables];
                  Object.entries(postScriptResult.environment).forEach(([key, val]) => {
                    const existingIdx = updatedVariables.findIndex((v) => v.key.trim() === key);
                    if (existingIdx >= 0) {
                      if (updatedVariables[existingIdx].currentValue !== val) {
                        updatedKeys.push(key);
                      }
                      updatedVariables[existingIdx] = {
                        ...updatedVariables[existingIdx],
                        currentValue: val,
                      };
                    } else {
                      updatedKeys.push(key);
                      updatedVariables.push({
                        id: generateId(),
                        key,
                        value: '',
                        initialValue: '',
                        currentValue: val,
                        enabled: true,
                      });
                    }
                  });
                  return {
                    ...e,
                    variables: updatedVariables,
                    updatedAt: Date.now(),
                  };
                }),
              }));
            } else if (!postScriptResult.success && postScriptResult.error) {
              scriptError = postScriptResult.error;
              scriptErrorStage = 'post-response';
            }
          }

          const finalResponse: ApiResponse = {
            ...response,
            scriptError,
            scriptErrorStage,
            updatedEnvVars: updatedKeys.length > 0 ? updatedKeys : undefined,
            capturedRequest,
          };

          const historyEntry: HistoryItem = {
            id: generateId(),
            request: cloneRequestPreservingAttachments(activeReq),
            response: finalResponse,
            timestamp: Date.now(),
          };

          set((s) => {
            const isCurrentTab = s.activeTabId === activeReq.id;
            const tabStillExists = s.tabs.some((t) => t.id === activeReq.id);

            const evictedHistory = s.history.slice(49);
            const newHistory = [historyEntry, ...s.history].slice(0, 50);
            const updatedTabResponses = tabStillExists
              ? {
                  ...(s.tabResponses || {}),
                  [activeReq.id]: finalResponse,
                }
              : (s.tabResponses || {});

            const nextActiveResponse = isCurrentTab ? finalResponse : s.activeResponse;
            const protectedResponses = [
              nextActiveResponse,
              ...Object.values(updatedTabResponses),
            ];
            revokeUnreferencedResponses(
              evictedHistory.map((entry) => entry.response),
              protectedResponses,
              [
                newHistory,
                ...Object.values(s.scopeCache || {}).map((e) => e.history),
                ...Object.values(s.offlineScopeCache || {}).map((e) => e.history),
              ]
            );

            const pinnedRawIds = new Set<string>();
            for (const res of protectedResponses) {
              if (res?.rawBodyId) pinnedRawIds.add(res.rawBodyId);
            }
            if (finalResponse.rawBodyId) pinnedRawIds.add(finalResponse.rawBodyId);
            safeEvictRawBodiesToBudget(pinnedRawIds);

            if (s.workspaceMode === 'offline') {
              return {
                ...(isCurrentTab ? { activeResponse: finalResponse } : {}),
                tabResponses: updatedTabResponses,
                isLoading: false,
                history: newHistory,
              };
            }

            const activeScope = s.cloudConfig.activeScope;
            let updatedScopeCache = s.scopeCache;
            if (activeScope) {
              const scopeKey = getScopeCacheKey(activeScope);
              const entry = (s.scopeCache || {})[scopeKey] || {
                collections: s.collections,
                environments: s.environments,
              };
              updatedScopeCache = {
                ...(s.scopeCache || {}),
                [scopeKey]: {
                  ...entry,
                  history: newHistory,
                },
              };
            }

            return {
              ...(isCurrentTab ? { activeResponse: finalResponse } : {}),
              tabResponses: updatedTabResponses,
              isLoading: false,
              history: newHistory,
              scopeCache: updatedScopeCache,
            };
          });
        } catch (err: unknown) {
          if (!isAsyncOperationCurrent(operation)) return;
          const errorMsg = err instanceof Error ? err.message : String(err);
          const fallbackResponse: ApiResponse = {
            status: 0,
            statusText: 'Client Error',
            timeMs: 0,
            sizeBytes: 0,
            headers: {},
            data: `Failed to initiate request: ${errorMsg}`,
            isError: true,
            errorDetail: errorMsg,
            requestUrl: activeReq.url,
            timestamp: Date.now(),
          };

          set((s) => {
            const isCurrentTab = s.activeTabId === activeReq.id;
            const tabStillExists = s.tabs.some((t) => t.id === activeReq.id);
            const updatedTabResponses = tabStillExists
              ? { ...(s.tabResponses || {}), [activeReq.id]: fallbackResponse }
              : (s.tabResponses || {});
            return {
              ...(isCurrentTab ? { activeResponse: fallbackResponse } : {}),
              tabResponses: updatedTabResponses,
              isLoading: false,
            };
          });
        } finally {
          if (activeRequestOperation === operation) {
            activeRequestOperation = null;
            activeRequestTabId = null;
          }
          completeAsyncOperation(operation);
        }
      },

      cancelActiveRequest: () => {
        const operation = activeRequestOperation;
        if (!operation || operation.controller.signal.aborted) return;
        operation.controller.abort();
        activeRequestOperation = null;
        activeRequestTabId = null;
        set((state) => {
          const prevTabResponse = state.tabResponses?.[state.activeTabId];
          const remainingTabResponses = Object.entries(state.tabResponses || {})
            .filter(([tabId]) => tabId !== state.activeTabId)
            .map(([, res]) => res);
          revokeUnreferencedResponses(
            [prevTabResponse, state.activeResponse],
            remainingTabResponses,
            [
              state.history,
              ...Object.values(state.scopeCache || {}).map((e) => e.history),
              ...Object.values(state.offlineScopeCache || {}).map((e) => e.history),
            ]
          );

          const cancelledResponse: ApiResponse = {
            status: 0,
            statusText: 'Request Cancelled',
            timeMs: 0,
            sizeBytes: 0,
            headers: {},
            data: 'Request was cancelled before a complete response was received.',
            isError: true,
            failureKind: 'cancelled',
            requestUrl: state.tabs.find((tab) => tab.id === state.activeTabId)?.url,
            timestamp: Date.now(),
          };
          return {
            isLoading: false,
            activeResponse: cancelledResponse,
            tabResponses: { ...(state.tabResponses || {}), [state.activeTabId]: cancelledResponse },
          };
        });
      },

      createCollection: (name, description = '') => {
        const { workspaceMode, cloudConfig } = get();
        if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role)) {
            console.warn('Insufficient permissions to create collection in project scope');
            return '';
          }
        }

        const isCloud = workspaceMode === 'cloud';
        const newCol: Collection = {
          id: generateId(),
          name: name.trim() || 'New Collection',
          description: description.trim(),
          items: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          _origin: isCloud ? 'cloud' : 'offline',
          _syncStatus: isCloud ? 'pending' : 'synced',
        };
        set((state) => ({
          collections: [newCol, ...state.collections],
        }));

        if (!isOfflineOnly && isCloud && isCloudSessionActive(cloudConfig) && cloudConfig.activeScope) {
          const revision = (collectionSaveSyncRevisions.get(newCol.id) ?? 0) + 1;
          collectionSaveSyncRevisions.set(newCol.id, revision);
          queueSavedCollectionSync(
            cloneCollectionPreservingAttachments(newCol),
            cloudConfig.activeScope,
            cloudConfig,
            revision,
            get,
            set,
            'Failed to sync created collection to cloud',
          );
        }

        return newCol.id;
      },

      createCollectionAsync: async (name, description = '') => {
        const { workspaceMode, cloudConfig, offlineWorkspaces, activeOfflineWorkspaceId } = get();
        if (!hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role)) {
          return { success: false, error: 'Write permission in the active workspace is required to create a collection.' };
        }

        let validatedName: string;
        try {
          validatedName = validateDuplicateName(name, 'Collection name');
        } catch (err: unknown) {
          return { success: false, error: err instanceof Error ? err.message : 'Invalid collection name.' };
        }

        const isCloud = workspaceMode === 'cloud';
        const now = Date.now();
        const newCol: Collection = {
          id: generateId(),
          name: validatedName,
          description: description.trim(),
          items: [],
          createdAt: now,
          updatedAt: now,
          _origin: isCloud ? 'cloud' : 'offline',
          _syncStatus: 'synced',
          ...(isCloud ? { version: 1, minRole: 'reader' as ProjectRole, isPartial: false } : {}),
        };

        if (!isCloud) {
          const capturedOfflineWsId = activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
          set((state) => {
            const nextCollections = [newCol, ...state.collections];
            return {
              collections: nextCollections,
              offlineWorkspaces: (state.offlineWorkspaces || []).map((w) =>
                w.id === capturedOfflineWsId ? { ...w, collections: nextCollections, updatedAt: Date.now() } : w,
              ),
            };
          });
          try {
            await get().persistNativeCredentialState();
            return { success: true, collectionId: newCol.id };
          } catch {
            set((state) => {
              const isTargetActive =
                state.workspaceMode === 'offline' &&
                (state.activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID) === capturedOfflineWsId;
              const prevCache = state.offlineScopeCache || {};
              const cachedEntry = prevCache[capturedOfflineWsId];
              const nextOfflineCache = cachedEntry
                ? {
                    ...prevCache,
                    [capturedOfflineWsId]: {
                      ...cachedEntry,
                      collections: (cachedEntry.collections || []).filter((c) => c.id !== newCol.id),
                    },
                  }
                : prevCache;
              const nextOfflineWorkspaces = (state.offlineWorkspaces || []).map((w) => {
                if (w.id !== capturedOfflineWsId) return w;
                const wsWithCols = w as typeof w & { collections?: Collection[] };
                if (!Array.isArray(wsWithCols.collections)) return w;
                return {
                  ...w,
                  collections: wsWithCols.collections.filter((c) => c.id !== newCol.id),
                };
              });
              return {
                ...(isTargetActive
                  ? { collections: state.collections.filter((c) => c.id !== newCol.id) }
                  : {}),
                offlineScopeCache: nextOfflineCache,
                offlineWorkspaces: nextOfflineWorkspaces,
              };
            });
            return { success: false, error: 'Failed to persist new collection.' };
          }
        }

        if (isOfflineOnly || !isCloudSessionActive(cloudConfig) || !cloudConfig.activeScope) {
          return { success: false, error: 'Cloud session required to create a cloud collection.' };
        }
        if (activePullOperation && isAsyncOperationCurrent(activePullOperation)) {
          return { success: false, error: 'Wait for workspace sync to finish before creating a collection.' };
        }

        const capturedSessionGen = cloudSessionGeneration;
        const currentOwnerKey = cloudCacheOwnerKey(cloudConfig, normalizeCloudApiUrl);
        const operation = beginAsyncOperation();
        try {
          await batchImportToScope(
            cloudConfig.apiUrl,
            cloudConfig.token,
            cloudConfig.activeScope,
            [newCol],
            cloudConfig.refreshToken,
            operation.controller.signal,
          );
          if (
            !isAsyncOperationCurrent(operation) ||
            isStoreDisposed ||
            cloudSessionGeneration !== capturedSessionGen ||
            cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) !== currentOwnerKey
          ) {
            return { success: false, error: 'Session or workspace changed before creation finished.' };
          }

          const scopeKey = getScopeCacheKey(cloudConfig.activeScope);
          set((state) => {
            const nextCollections = [newCol, ...state.collections];
            const prevScopeCache = state.scopeCache || {};
            const existingScopeEntry = prevScopeCache[scopeKey];
            const nextScopeCache = existingScopeEntry
              ? {
                  ...prevScopeCache,
                  [scopeKey]: { ...existingScopeEntry, collections: nextCollections, lastSyncedAt: Date.now() },
                }
              : prevScopeCache;
            return {
              collections: nextCollections,
              scopeCache: nextScopeCache,
            };
          });
          return { success: true, collectionId: newCol.id };
        } catch (err: unknown) {
          if (operation.controller.signal.aborted || !isAsyncOperationCurrent(operation)) {
            return { success: false, error: 'Collection creation cancelled.' };
          }
          return { success: false, error: err instanceof Error ? err.message : 'Failed to create collection in cloud.' };
        } finally {
          completeAsyncOperation(operation);
        }
      },

      renameCollection: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;

        const { workspaceMode, cloudConfig, collections } = get();
        if (movingCollections.has(id) || duplicatingCollections.has(id)) {
          set({ syncError: 'Wait for the collection move or duplicate to finish before renaming.' });
          return;
        }
        const col = collections.find((c) => c.id === id);
        if (col?._needsMoveReconciliation) {
          set({ syncError: 'Sync the workspace to confirm the previous move before renaming.' });
          return;
        }
        if (col) {
          if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn(`User lacks permission to rename collection "${col.name}"`);
            return;
          }
        }

        const shouldSync = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);

        if (shouldSync) {
          pendingReorderBaseSnapshots.delete(id);
        }

        set((state) => ({
          collections: state.collections.map((col) => {
            if (col.id !== id) return col;
            return {
              ...col,
              name: trimmed,
              updatedAt: Date.now(),
              ...(shouldSync ? { _syncStatus: 'pending' as const } : {}),
            };
          }),
        }));

        const updatedCols = get().collections;
        if (shouldSync && cloudConfig.activeScope) {
          const updatedCol = updatedCols.find((c) => c.id === id);
          if (updatedCol) {
            const revision = (collectionSaveSyncRevisions.get(id) ?? 0) + 1;
            collectionSaveSyncRevisions.set(id, revision);
            queueSavedCollectionSync(
              cloneCollectionPreservingAttachments(updatedCol),
              cloudConfig.activeScope,
              cloudConfig,
              revision,
              get,
              set,
              'Failed to sync renamed collection to cloud',
            );
          }
        }
      },

      createFolder: (collectionId, parentFolderId, name) => {
        const { workspaceMode, cloudConfig, collections } = get();
        if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
          set({ syncError: 'Wait for the collection move or duplicate to finish before creating a folder.' });
          return '';
        }
        const col = collections.find((c) => c.id === collectionId);
        if (col?._needsMoveReconciliation || col?.isPartial) {
          set({ syncError: 'Sync the collection before creating a folder.' });
          return '';
        }
        if (col) {
          if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn(`User lacks permission to add folder to collection "${col.name}"`);
            return '';
          }
        }

        const newFolderId = generateId();
        const folderName = name?.trim() || 'New Folder';
        const newFolder: CollectionItem = {
          id: newFolderId,
          name: folderName,
          type: 'folder',
          items: [],
        };
        const shouldSync = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);

        if (shouldSync) {
          pendingReorderBaseSnapshots.delete(collectionId);
        }

        set((state) => {
          const updateItems = (items: CollectionItem[]): CollectionItem[] => {
            if (!parentFolderId) {
              return [...items, newFolder];
            }
            return items.map((item) => {
              if (item.type === 'folder') {
                if (item.id === parentFolderId) {
                  return {
                    ...item,
                    items: [...(item.items || []), newFolder],
                  };
                }
                return {
                  ...item,
                  items: updateItems(item.items || []),
                };
              }
              return item;
            });
          };

          const collections = state.collections.map((col) => {
            if (col.id !== collectionId) return col;
            return {
              ...col,
              items: updateItems(col.items),
              updatedAt: Date.now(),
              ...(shouldSync ? { _syncStatus: 'pending' as const } : {}),
            };
          });

          return {
            collections,
          };
        });

        const updatedCols = get().collections;
        if (shouldSync && cloudConfig.activeScope) {
          const updatedCol = updatedCols.find((c) => c.id === collectionId);
          if (updatedCol) {
            const revision = (collectionSaveSyncRevisions.get(collectionId) ?? 0) + 1;
            collectionSaveSyncRevisions.set(collectionId, revision);
            queueSavedCollectionSync(
              cloneCollectionPreservingAttachments(updatedCol),
              cloudConfig.activeScope,
              cloudConfig,
              revision,
              get,
              set,
              'Failed to sync created folder to cloud',
            );
          }
        }

        return newFolderId;
      },

      createRequestInCollection: (collectionId, folderId, name) => {
        const { workspaceMode, cloudConfig, collections } = get();
        if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
          set({ syncError: 'Wait for the collection move or duplicate to finish before creating a request.' });
          return null;
        }
        const col = collections.find((c) => c.id === collectionId);
        if (col?._needsMoveReconciliation || col?.isPartial) {
          set({ syncError: 'Sync the collection before creating a request.' });
          return null;
        }
        if (col) {
          if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn(`User lacks permission to add request to collection "${col.name}"`);
            return null;
          }
        }

        const reqId = generateId();
        const reqName = name?.trim() || 'New Request';
        const newReq: ApiRequest = {
          id: reqId,
          name: reqName,
          method: 'GET',
          url: '',
          params: [{ id: generateId(), key: '', value: '', enabled: true }],
          headers: [{ id: generateId(), key: '', value: '', enabled: true }],
          auth: { type: 'none' },
          bodyType: 'none',
          rawType: 'text',
          bodyContent: '',
          graphqlQuery: '',
          graphqlVariables: '',
          bodyFormData: [],
          bodyUrlEncoded: [{ id: generateId(), key: '', value: '', enabled: true }],
          preRequestScript: '',
          postResponseScript: '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        const newColItem: CollectionItem = {
          id: reqId,
          name: reqName,
          type: 'request',
          request: newReq,
        };
        const shouldSync = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);

        if (shouldSync) {
          pendingReorderBaseSnapshots.delete(collectionId);
        }

        set((state) => {
          const updateItems = (items: CollectionItem[]): CollectionItem[] => {
            if (!folderId) {
              return [...items, newColItem];
            }
            return items.map((item) => {
              if (item.type === 'folder') {
                if (item.id === folderId) {
                  return {
                    ...item,
                    items: [...(item.items || []), newColItem],
                  };
                }
                return {
                  ...item,
                  items: updateItems(item.items || []),
                };
              }
              return item;
            });
          };

          const collections = state.collections.map((col) => {
            if (col.id !== collectionId) return col;
            return {
              ...col,
              items: updateItems(col.items),
              updatedAt: Date.now(),
              ...(shouldSync ? { _syncStatus: 'pending' as const } : {}),
            };
          });

          return {
            collections,
            tabs: [...state.tabs, newReq],
            activeTabId: reqId,
            activeResponse: null,
          };
        });

        const updatedCols = get().collections;
        if (shouldSync && cloudConfig.activeScope) {
          const updatedCol = updatedCols.find((c) => c.id === collectionId);
          if (updatedCol) {
            const revision = (collectionSaveSyncRevisions.get(collectionId) ?? 0) + 1;
            collectionSaveSyncRevisions.set(collectionId, revision);
            queueSavedCollectionSync(
              cloneCollectionPreservingAttachments(updatedCol),
              cloudConfig.activeScope,
              cloudConfig,
              revision,
              get,
              set,
              'Failed to sync created request to cloud',
            );
          }
        }

        return newReq;
      },

      deleteCollectionItem: (collectionId, itemId) => {
        const { workspaceMode, cloudConfig, collections } = get();
        if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
          set({ syncError: 'Wait for the collection move or duplicate to finish before deleting items.' });
          return;
        }
        const col = collections.find((c) => c.id === collectionId);
        if (col?._needsMoveReconciliation || col?.isPartial) {
          set({ syncError: 'Sync the collection before deleting items.' });
          return;
        }
        if (col) {
          if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn(`User lacks permission to delete item from collection "${col.name}"`);
            return;
          }
        }
        const shouldSync = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);

        if (shouldSync) {
          pendingReorderBaseSnapshots.delete(collectionId);
        }

        set((state) => {
          const deletedIds = new Set<string>();
          const collectTargetIds = (items: CollectionItem[]) => {
            for (const item of items) {
              if (!item) continue;
              if (item.id === itemId) {
                deletedIds.add(item.id);
                if (item.type === 'folder' && item.items) {
                  for (const childId of collectAllItemIds(item.items)) {
                    deletedIds.add(childId);
                  }
                }
                return;
              }
              if (item.type === 'folder' && item.items) {
                collectTargetIds(item.items);
              }
            }
          };
          const targetCol = state.collections.find((c) => c.id === collectionId);
          if (targetCol) collectTargetIds(targetCol.items || []);
          if (deletedIds.size === 0) deletedIds.add(itemId);

          const filterItems = (items: CollectionItem[]): CollectionItem[] => {
            return items
              .filter((item) => item.id !== itemId)
              .map((item) => {
                if (item.type === 'folder' && item.items) {
                  return {
                    ...item,
                    items: filterItems(item.items),
                  };
                }
                return item;
              });
          };

          const collections = state.collections.map((col) => {
            if (col.id !== collectionId) return col;
            return {
              ...col,
              items: filterItems(col.items),
              updatedAt: Date.now(),
              ...(shouldSync ? { _syncStatus: 'pending' as const } : {}),
            };
          });

          return {
            collections,
            ...pruneExampleTabsState(
              state,
              (sel) => !(sel.collectionId === collectionId && deletedIds.has(sel.itemId)),
            ),
            pendingExampleIntents: prunePendingExampleIntentsForTarget(
              state.pendingExampleIntents,
              collectionId,
              deletedIds,
            ),
          };
        });

        const updatedCols = get().collections;
        if (shouldSync && cloudConfig.activeScope) {
          const syncScope = cloudConfig.activeScope;
          const updatedCol = updatedCols.find((c) => c.id === collectionId);
          const snapshotCol = updatedCol ? cloneCollectionPreservingAttachments(updatedCol) : null;
          const revision = (collectionSaveSyncRevisions.get(collectionId) ?? 0) + 1;
          collectionSaveSyncRevisions.set(collectionId, revision);
          void enqueueCollectionSyncTask(collectionId, syncScope, async (operation, generation) => {
            try {
              const liveCloudConfig = get().cloudConfig;
              const activeApiUrl = liveCloudConfig.apiUrl || cloudConfig.apiUrl;
              const activeToken = liveCloudConfig.token || cloudConfig.token;
              const activeRefreshToken = liveCloudConfig.refreshToken ?? cloudConfig.refreshToken;
              await deleteScopeItem(
                activeApiUrl,
                activeToken,
                itemId,
                activeRefreshToken,
                operation.controller.signal
              ).catch((err) => {
                if (!isAsyncOperationCurrent(operation)) return;
                console.error('Failed to delete item from cloud:', err);
              });
              if (
                !isAsyncOperationCurrent(operation) ||
                generation !== collectionSaveSyncGeneration ||
                isStoreDisposed
              ) {
                return;
              }
              if (snapshotCol) {
                await batchImportToScope(
                  activeApiUrl,
                  activeToken,
                  syncScope,
                  [snapshotCol],
                  activeRefreshToken,
                  operation.controller.signal,
                  { includeExamples: false },
                );
                if (
                  !isAsyncOperationCurrent(operation) ||
                  generation !== collectionSaveSyncGeneration ||
                  collectionSaveSyncRevisions.get(collectionId) !== revision ||
                  get().cloudConfig.activeScope?.id !== syncScope.id ||
                  get().cloudConfig.activeScope?.type !== syncScope.type
                ) {
                  return;
                }
                set((state) => ({
                  collections: state.collections.map((c) =>
                    c.id === collectionId ? { ...c, _syncStatus: 'synced' } : c
                  ),
                }));
              }
            } catch (err: any) {
              if (
                operation.controller.signal.aborted ||
                !isAsyncOperationCurrent(operation) ||
                generation !== collectionSaveSyncGeneration ||
                collectionSaveSyncRevisions.get(collectionId) !== revision
              ) {
                return;
              }
              console.error('Failed to sync item deletion to cloud:', err);
              set((state) => ({
                collections: state.collections.map((c) =>
                  c.id === collectionId ? { ...c, _syncStatus: 'pending' } : c
                ),
                syncStatus: 'error',
                syncError: err.message || 'Failed to sync item deletion to cloud',
              }));
            }
          });
        }
      },

      renameCollectionItem: (collectionId, itemId, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;

        const { workspaceMode, cloudConfig, collections } = get();
        if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
          set({ syncError: 'Wait for the collection move or duplicate to finish before renaming items.' });
          return;
        }
        const col = collections.find((c) => c.id === collectionId);
        if (col?._needsMoveReconciliation || col?.isPartial) {
          set({ syncError: 'Sync the collection before renaming items.' });
          return;
        }
        if (col) {
          if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn(`User lacks permission to rename item in collection "${col.name}"`);
            return;
          }
        }
        const shouldSync = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);

        if (shouldSync) {
          pendingReorderBaseSnapshots.delete(collectionId);
        }

        set((state) => {
          const updateItems = (items: CollectionItem[]): CollectionItem[] => {
            return items.map((item) => {
              if (item.id === itemId) {
                const updated: CollectionItem = {
                  ...item,
                  name: trimmed,
                };
                if (item.type === 'request' && item.request) {
                  updated.request = {
                    ...item.request,
                    name: trimmed,
                  };
                }
                return updated;
              }
              if (item.type === 'folder' && item.items) {
                return {
                  ...item,
                  items: updateItems(item.items),
                };
              }
              return item;
            });
          };

          const collections = state.collections.map((col) => {
            if (col.id !== collectionId) return col;
            return {
              ...col,
              items: updateItems(col.items),
              updatedAt: Date.now(),
              ...(shouldSync ? { _syncStatus: 'pending' as const } : {}),
            };
          });

          // Synchronize any open tabs with this item
          const tabs = state.tabs.map((tab) => {
            if (tab.id === itemId) {
              return {
                ...tab,
                name: trimmed,
              };
            }
            return tab;
          });

          return {
            collections,
            tabs,
          };
        });

        const updatedCols = get().collections;
        if (shouldSync && cloudConfig.activeScope) {
          const updatedCol = updatedCols.find((c) => c.id === collectionId);
          if (updatedCol) {
            const revision = (collectionSaveSyncRevisions.get(collectionId) ?? 0) + 1;
            collectionSaveSyncRevisions.set(collectionId, revision);
            queueSavedCollectionSync(
              cloneCollectionPreservingAttachments(updatedCol),
              cloudConfig.activeScope,
              cloudConfig,
              revision,
              get,
              set,
              'Failed to sync renamed item to cloud',
            );
          }
        }
      },

      saveRequestToCollection: (collectionId, folderId, request, sourceTabId) => {
        const { workspaceMode, cloudConfig, collections, tabs } = get();
        if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
          return { success: false, cloudStatus: 'not-applicable', error: 'Wait for the collection move or duplicate to finish before saving.' };
        }
        const collection = collections.find((candidate) => candidate.id === collectionId);
        if (!collection) {
          return { success: false, cloudStatus: 'not-applicable', error: 'The target collection no longer exists.' };
        }
        if (collection._needsMoveReconciliation) {
          return { success: false, cloudStatus: 'not-applicable', error: 'Sync the workspace to confirm the previous move before saving.' };
        }
        if (collection.isPartial) {
          return { success: false, cloudStatus: 'not-applicable', error: 'Wait for collection details to finish loading before saving.' };
        }
        if (!canModifyCollection(collection.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          return { success: false, cloudStatus: 'not-applicable', error: `Collection "${collection.name}" is read-only.` };
        }

        const findFolder = (items: CollectionItem[]): CollectionItem | undefined => {
          for (const item of items) {
            if (item.type !== 'folder') continue;
            if (item.id === folderId) return item;
            const nested = findFolder(item.items || []);
            if (nested) return nested;
          }
          return undefined;
        };
        const targetItems = folderId ? findFolder(collection.items || [])?.items : collection.items || [];
        if (!targetItems) {
          return { success: false, cloudStatus: 'not-applicable', error: 'The target folder no longer exists.' };
        }
        if (sourceTabId && !tabs.some((tab) => tab.id === sourceTabId)) {
          return { success: false, sourceTabId, cloudStatus: 'not-applicable', error: 'The source tab is no longer open.' };
        }

        const existingItem = targetItems.find(
          (item) => item.type === 'request' && (item.id === request.id || item.request?.id === request.id),
        );
        const savedRequestId = existingItem?.id ?? (request.id.trim() || generateId());
        const targetTabAlreadyOpen = sourceTabId && savedRequestId !== sourceTabId && tabs.some((tab) => tab.id === savedRequestId);
        if (targetTabAlreadyOpen) {
          return {
            success: false,
            sourceTabId,
            cloudStatus: 'not-applicable',
            error: 'The request being replaced is already open in another tab. Close it before replacing.',
          };
        }

        const shouldSync = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && cloudConfig.activeScope;
        if (shouldSync) {
          pendingReorderBaseSnapshots.delete(collectionId);
        }
        const cleanRequest: RequestTab = cloneRequestPreservingAttachments({ ...request, id: savedRequestId });
        delete cleanRequest.deletedFromCollection;

        set((state) => {
          const insertOrUpdateInList = (items: CollectionItem[]): CollectionItem[] => {
            const existingIndex = items.findIndex(
              (item) => item.type === 'request' && (item.id === savedRequestId || item.request?.id === savedRequestId),
            );
            if (existingIndex >= 0) {
              const updated = [...items];
              updated[existingIndex] = { ...updated[existingIndex], name: cleanRequest.name, request: cleanRequest };
              return updated;
            }
            return [...items, {
              id: savedRequestId,
              name: cleanRequest.name || 'Untitled Request',
              type: 'request',
              request: cleanRequest,
              examples: [],
              exampleSummaries: [],
              exampleCount: 0,
              examplesLoaded: true,
            }];
          };
          const updateFolderItems = (items: CollectionItem[]): CollectionItem[] => items.map((item) => {
            if (item.type !== 'folder') return item;
            if (item.id === folderId) return { ...item, items: insertOrUpdateInList(item.items || []) };
            return { ...item, items: updateFolderItems(item.items || []) };
          });

          const nextCollections = state.collections.map((candidate) => candidate.id === collectionId
            ? {
              ...candidate,
              items: folderId ? updateFolderItems(candidate.items || []) : insertOrUpdateInList(candidate.items || []),
              updatedAt: Date.now(),
              ...(shouldSync ? { _syncStatus: 'pending' as const } : {}),
            }
            : candidate,
          );

          if (!sourceTabId) return { collections: nextCollections };

          if (sourceTabId !== savedRequestId) {
            const sourceHistory = tabUndoHistory[sourceTabId];
            if (sourceHistory) {
              tabUndoHistory[savedRequestId] = sourceHistory;
              delete tabUndoHistory[sourceTabId];
            }
            // The typing timer closure deletes the key it was created for, so moving it to the
            // new ID would leave a stale entry that merges the next edit into the pre-save group.
            const sourceTimer = undoTypingTimers[sourceTabId];
            if (sourceTimer) {
              clearTimeout(sourceTimer);
              delete undoTypingTimers[sourceTabId];
            }
          }

          const nextTabResponses = { ...(state.tabResponses || {}) };
          if (sourceTabId !== savedRequestId && nextTabResponses[sourceTabId]) {
            nextTabResponses[savedRequestId] = nextTabResponses[sourceTabId];
            delete nextTabResponses[sourceTabId];
          }
          const nextActiveTabId = state.activeTabId === sourceTabId ? savedRequestId : state.activeTabId;
          const nextTabOrder = sourceTabId !== savedRequestId
            ? (state.tabOrder || []).map((tabId) => (tabId === sourceTabId ? savedRequestId : tabId))
            : state.tabOrder;
          return {
            collections: nextCollections,
            tabs: state.tabs.map((tab) => tab.id === sourceTabId
              ? { ...tab, id: savedRequestId, name: cleanRequest.name, updatedAt: Date.now() }
              : tab,
            ),
            activeTabId: nextActiveTabId,
            tabOrder: nextTabOrder,
            tabResponses: nextTabResponses,
            activeResponse: nextActiveTabId === state.activeTabId
              ? state.activeResponse
              : nextTabResponses[nextActiveTabId] || null,
            canUndoActiveRequest: (tabUndoHistory[nextActiveTabId]?.past.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[nextActiveTabId]?.future.length ?? 0) > 0,
          };
        });

        const syncScope = shouldSync ? cloudConfig.activeScope : undefined;
        if (syncScope) {
          const updatedCollection = get().collections.find((candidate) => candidate.id === collectionId);
          if (updatedCollection) {
            const revision = (collectionSaveSyncRevisions.get(collectionId) ?? 0) + 1;
            collectionSaveSyncRevisions.set(collectionId, revision);
            queueSavedCollectionSync(
              cloneCollectionPreservingAttachments(updatedCollection),
              syncScope,
              cloudConfig,
              revision,
              get,
              set,
            );
          }
        }

        return {
          success: true,
          ...(sourceTabId ? { sourceTabId } : {}),
          savedRequestId,
          cloudStatus: shouldSync ? 'pending' : 'not-applicable',
        };
      },

      saveActiveRequest: () => {
        const { tabs, activeTabId, collections, saveRequestToCollection, workspaceMode, cloudConfig } = get();
        const currentTab = tabs.find((t) => t.id === activeTabId);
        if (!currentTab) return { success: false, isDirectSaved: false };

        const saved = findSavedRequestInCollections(collections, currentTab.id);
        if (saved) {
          if (!canModifyCollection(saved.collection.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            return { success: false, isDirectSaved: false };
          }
          const result = saveRequestToCollection(saved.collection.id, saved.folderId, currentTab, currentTab.id);
          return { success: result.success, isDirectSaved: result.success };
        }

        return { success: false, isDirectSaved: false };
      },

      addCollection: async (collection, options?: { target?: ImportTargetBinding; isRetry?: boolean }) => {
        if (options?.target && !matchesImportTarget(get(), options.target, cloudSessionGeneration)) {
          throw new Error('Workspace changed before collection import could be applied.');
        }

        const { workspaceMode, cloudConfig } = get();
        if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role)) {
            console.warn('Insufficient permissions to add collections in project scope');
            throw new Error('Insufficient permissions to add collections in project scope (requires collection:write)');
          }
        }

        const isCloud = workspaceMode === 'cloud';
        const taggedCol: Collection = {
          ...collection,
          _origin: isCloud ? 'cloud' : 'offline',
          _syncStatus: isCloud ? 'pending' : 'synced',
        };
        set((state) => {
          const exists = state.collections.some((c) => c.id === taggedCol.id);
          const nextCollections = exists
            ? state.collections.map((c) => (c.id === taggedCol.id ? taggedCol : c))
            : [taggedCol, ...state.collections];
          const localId = state.activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
          const nextOfflineCache =
            state.workspaceMode === 'offline'
              ? {
                  ...(state.offlineScopeCache || {}),
                  [localId]: {
                    environments: state.environments,
                    activeEnvironmentId: state.activeEnvironmentId,
                    tabs: state.tabs,
                    activeTabId: state.activeTabId,
                    history: state.history,
                    ...(state.offlineScopeCache?.[localId] || {}),
                    collections: nextCollections,
                  },
                }
              : state.offlineScopeCache;
          return {
            collections: nextCollections,
            offlineScopeCache: nextOfflineCache,
          };
        });

        if (!isOfflineOnly && isCloud && isCloudSessionActive(cloudConfig) && cloudConfig.activeScope) {
          const expectedExamples = countCollectionSavedExamples(collection);
          if (expectedExamples > 0) {
            const supported = await ensureSavedExamplesCapability();
            if (!supported) {
              throw new Error('This cloud server does not support Saved Examples. Update the server or remove examples before uploading.');
            }
          }
          const operation = beginAsyncOperation();
          const targetScope = cloudConfig.activeScope;
          const capturedSessionGen = cloudSessionGeneration;
          let uploadSucceeded = false;
          const isSameTargetScope = () => {
            const live = get();
            return (
              !isStoreDisposed &&
              cloudSessionGeneration === capturedSessionGen &&
              live.workspaceMode === 'cloud' &&
              live.cloudConfig.activeScope?.id === targetScope.id &&
              live.cloudConfig.activeScope?.type === targetScope.type
            );
          };
          const markCollectionSyncedInTargetScope = (remoteVersion?: number) => {
            if (isStoreDisposed || cloudSessionGeneration !== capturedSessionGen) return;
            const applySynced = (c: Collection): Collection =>
              c.id === taggedCol.id
                ? {
                    ...c,
                    _syncStatus: 'synced',
                    ...(typeof remoteVersion === 'number' ? { version: remoteVersion } : {}),
                  }
                : c;
            if (isSameTargetScope()) {
              set((state) => ({
                collections: state.collections.map(applySynced),
              }));
              return;
            }
            const targetKey = getScopeCacheKey(targetScope);
            set((state) => {
              const cached = state.scopeCache?.[targetKey];
              if (!cached) return {};
              return {
                scopeCache: {
                  ...state.scopeCache,
                  [targetKey]: {
                    ...cached,
                    collections: (cached.collections || []).map(applySynced),
                  },
                },
              };
            });
          };
          try {
            set({ syncStatus: 'syncing', syncError: null });
            let alreadyOnServer = false;
            let matchedRemoteVersion: number | undefined = undefined;
            if (options?.isRetry) {
              const remoteCols = await fetchScopeCollectionsForRuntime(
                cloudConfig.apiUrl,
                cloudConfig.token,
                targetScope,
                cloudConfig.refreshToken,
                operation.controller.signal
              );
              if (isStoreDisposed || cloudSessionGeneration !== capturedSessionGen) return;
              const matchedRemote = Array.isArray(remoteCols)
                ? remoteCols.find((rc) => rc.id === taggedCol.id)
                : undefined;
              alreadyOnServer = Boolean(matchedRemote);
              if (matchedRemote) {
                if (expectedExamples > 0) {
                  try {
                    const detailRaw = await fetchCollectionByIdForRuntime(
                      cloudConfig.apiUrl,
                      cloudConfig.token,
                      taggedCol.id,
                      cloudConfig.refreshToken,
                      operation.controller.signal,
                    );
                    const detailCol = detailRaw ? buildCollectionFromDetails(detailRaw) : null;
                    const remoteExampleCount = countCollectionSavedExamples(detailCol);
                    alreadyOnServer = remoteExampleCount >= expectedExamples;
                  } catch {
                    alreadyOnServer = false;
                  }
                } else {
                  alreadyOnServer = true;
                }
                if (alreadyOnServer) {
                  matchedRemoteVersion =
                    typeof matchedRemote.version === 'number' ? matchedRemote.version : 1;
                }
              }
              if (!alreadyOnServer && (!isAsyncOperationCurrent(operation) || operation.controller.signal.aborted)) {
                if (isSameTargetScope()) {
                  throw new Error('Import operation was cancelled before completion.');
                }
                return;
              }
            }

            if (!alreadyOnServer) {
              const batchResult = await batchImportToScope(
                cloudConfig.apiUrl,
                cloudConfig.token,
                targetScope,
                [collection],
                cloudConfig.refreshToken,
                operation.controller.signal
              );
              if (
                expectedExamples > 0 &&
                (typeof batchResult?.imported_examples !== 'number' ||
                  batchResult.imported_examples < expectedExamples)
              ) {
                throw new Error(`Cloud server did not confirm saved examples during import of "${collection.name}".`);
              }
            }
            uploadSucceeded = true;
            if (isStoreDisposed || cloudSessionGeneration !== capturedSessionGen) return;
            markCollectionSyncedInTargetScope(matchedRemoteVersion);
            if (!isSameTargetScope() || !isAsyncOperationCurrent(operation)) return;
            await get().pullCloudDelta();
          } catch (err: any) {
            if (!uploadSucceeded && (operation.controller.signal.aborted || !isAsyncOperationCurrent(operation))) {
              if (!isStoreDisposed && isSameTargetScope()) {
                throw new Error('Import operation was cancelled before completion.');
              }
              return;
            }
            if (operation.controller.signal.aborted || !isAsyncOperationCurrent(operation) || isStoreDisposed || !isSameTargetScope()) return;
            set((state) => ({
              collections: uploadSucceeded
                ? state.collections
                : state.collections.map((c) =>
                    c.id === taggedCol.id ? { ...c, _syncStatus: 'pending' } : c
                  ),
              syncStatus: 'error',
              syncError: err.message || 'Failed to sync collection to cloud',
            }));
            throw err;
          } finally {
            completeAsyncOperation(operation);
          }
        } else {
          await flushStorePersistence();
        }
      },

      replaceCollection: async (existingId: string, newCollection: Collection, options?: { target?: ImportTargetBinding }) => {
        if (options?.target && !matchesImportTarget(get(), options.target, cloudSessionGeneration)) {
          throw new Error('Workspace changed before collection replacement could be applied.');
        }

        const state = get();
        if (movingCollections.has(existingId) || duplicatingCollections.has(existingId)) {
          throw new Error('Wait for the collection move or duplicate to finish before replacing.');
        }
        const existingCol = state.collections.find((c) => c.id === existingId);
        if (!existingCol) {
          throw new Error('Existing collection not found');
        }
        if (existingCol._needsMoveReconciliation) {
          throw new Error('Sync the workspace to confirm the previous move before replacing.');
        }

        if (!canModifyCollection(existingCol.minRole, state.cloudConfig.activeScope, state.workspaceMode, state.cloudConfig.user?.role)) {
          throw new Error(`Insufficient permissions to replace collection "${existingCol.name}"`);
        }

        const isCloud = state.workspaceMode === 'cloud';
        let resolvedExistingCol = existingCol;
        if (!isOfflineOnly && isCloud && isCloudSessionActive(state.cloudConfig) && state.cloudConfig.activeScope) {
          if (collectionHasSavedExamples(newCollection)) {
            const supported = await ensureSavedExamplesCapability();
            if (!supported) {
              throw new Error('This cloud server does not support Saved Examples. Update the server or remove examples before replacing.');
            }
          }
          if (resolvedExistingCol.isPartial) {
            const loaded = await get().loadCollectionDetails(existingId);
            if (!loaded.success || !loaded.collection) {
              throw new Error(loaded.error || 'Failed to load collection details before replacing.');
            }
            resolvedExistingCol = loaded.collection;
          }
        }

        const alignedItems = alignCollectionItemIds(resolvedExistingCol.items || [], newCollection.items || []);
        const baseVersion = typeof resolvedExistingCol.version === 'number' ? resolvedExistingCol.version : 1;

        const replacedCol: Collection = {
          ...newCollection,
          id: existingId,
          name: newCollection.name,
          minRole: newCollection.minRole || resolvedExistingCol.minRole,
          version: baseVersion,
          items: alignedItems,
          updatedAt: Date.now(),
          _origin: isCloud ? 'cloud' : 'offline',
          _syncStatus: isCloud ? 'pending' : 'synced',
        };

        set((s) => {
          const nextCollections = s.collections.map((c) => (c.id === existingId ? replacedCol : c));
          const localId = s.activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
          const nextOfflineCache =
            s.workspaceMode === 'offline'
              ? {
                  ...(s.offlineScopeCache || {}),
                  [localId]: {
                    environments: s.environments,
                    activeEnvironmentId: s.activeEnvironmentId,
                    tabs: s.tabs,
                    activeTabId: s.activeTabId,
                    history: s.history,
                    ...(s.offlineScopeCache?.[localId] || {}),
                    collections: nextCollections,
                  },
                }
              : s.offlineScopeCache;
          return {
            collections: nextCollections,
            offlineScopeCache: nextOfflineCache,
            ...pruneExampleTabsState(
              s,
              (sel) => sel.collectionId !== existingId || isSelectedExampleStillPresent(nextCollections, sel),
            ),
          };
        });

        const { workspaceMode, cloudConfig } = get();
        if (!isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && cloudConfig.activeScope) {
          const operation = beginAsyncOperation();
          const targetScope = cloudConfig.activeScope;
          const capturedSessionGen = cloudSessionGeneration;
          const replaceOperationId = crypto.randomUUID();
          let uploadSucceeded = false;
          const isSameTargetScope = () => {
            const live = get();
            return (
              !isStoreDisposed &&
              cloudSessionGeneration === capturedSessionGen &&
              live.workspaceMode === 'cloud' &&
              live.cloudConfig.activeScope?.id === targetScope.id &&
              live.cloudConfig.activeScope?.type === targetScope.type
            );
          };
          try {
            set({ syncStatus: 'syncing', syncError: null });

            if (!isAsyncOperationCurrent(operation) || operation.controller.signal.aborted) {
              if (!isStoreDisposed && isSameTargetScope()) {
                throw new Error('Import operation was cancelled before completion.');
              }
              return;
            }
            if (!isSameTargetScope()) return;
            const receipt = await replaceScopeCollection(
              cloudConfig.apiUrl,
              cloudConfig.token,
              existingId,
              replacedCol,
              baseVersion,
              replaceOperationId,
              cloudConfig.refreshToken,
              operation.controller.signal,
            );
            uploadSucceeded = true;
            if (isStoreDisposed || cloudSessionGeneration !== capturedSessionGen) return;
            const nextVersion = typeof receipt?.version === 'number' ? receipt.version : baseVersion + 1;
            if (isSameTargetScope()) {
              set((state) => ({
                collections: state.collections.map((c) =>
                  c.id === existingId ? { ...c, version: nextVersion, _syncStatus: 'synced' } : c
                ),
              }));
              if (isAsyncOperationCurrent(operation)) {
                await get().pullCloudDelta();
              }
            } else {
              const targetKey = getScopeCacheKey(targetScope);
              set((state) => {
                const cached = state.scopeCache?.[targetKey];
                if (!cached) return {};
                return {
                  scopeCache: {
                    ...state.scopeCache,
                    [targetKey]: {
                      ...cached,
                      collections: (cached.collections || []).map((c) =>
                        c.id === existingId ? { ...c, version: nextVersion, _syncStatus: 'synced' } : c
                      ),
                    },
                  },
                };
              });
              return;
            }
          } catch (err: any) {
            if (!uploadSucceeded && (operation.controller.signal.aborted || !isAsyncOperationCurrent(operation))) {
              if (!isStoreDisposed && isSameTargetScope()) {
                throw new Error('Import operation was cancelled before completion.');
              }
              return;
            }
            if (operation.controller.signal.aborted || !isAsyncOperationCurrent(operation) || isStoreDisposed || !isSameTargetScope()) return;
            set((state) => ({
              collections: uploadSucceeded
                ? state.collections
                : state.collections.map((c) =>
                    c.id === existingId ? { ...c, _syncStatus: 'pending' } : c
                  ),
              syncStatus: 'error',
              syncError: err.message || 'Failed to sync replaced collection',
            }));
            throw err;
          } finally {
            completeAsyncOperation(operation);
          }
        } else {
          await flushStorePersistence();
        }
      },

      importEnvironmentFromJson: (jsonStr) => {
        try {
          const { workspaceMode, cloudConfig } = get();
          if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
            if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role)) {
              return { success: false, error: 'Insufficient permission to import environments into this scope (requires env:write)' };
            }
          }

          const imported = importPostmanEnvironment(jsonStr);
          set((state) => ({
            environments: [...state.environments, imported],
            activeEnvironmentId: imported.id,
          }));

          if (workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && cloudConfig.activeScope) {
            const operation = beginAsyncOperation();
            createScopeEnvironment(
              cloudConfig.apiUrl,
              cloudConfig.token,
              cloudConfig.activeScope,
              {
                name: imported.name,
                variables: sanitizeVariablesForUpstream(imported.variables),
                min_role: imported.minRole || 'reader',
              },
              cloudConfig.refreshToken,
              operation.controller.signal
            ).then((created) => {
              if (!isAsyncOperationCurrent(operation)) return;
              if (created?.id) {
                set((state) => {
                  if (!isAsyncOperationCurrent(operation)) return {};
                  return {
                    environments: state.environments.map((e) =>
                      e.id === imported.id ? { ...e, id: created.id, version: created.version || 1 } : e
                    ),
                    activeEnvironmentId: state.activeEnvironmentId === imported.id ? created.id : state.activeEnvironmentId,
                  };
                });
              }
            }).catch((err) => {
              if (!isAsyncOperationCurrent(operation)) return;
              console.error('Failed to sync imported environment to cloud:', err);
            }).finally(() => {
              completeAsyncOperation(operation);
            });
          }

          return { success: true, environment: imported };
        } catch (err: unknown) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to parse Postman environment',
          };
        }
      },

      importAnyPostmanJson: async (jsonStr) => {
        try {
          const { workspaceMode, cloudConfig } = get();
          const detected = detectPostmanJsonType(jsonStr);
          if (detected === 'environment') {
            if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
              if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role)) {
                return { success: false, error: 'Insufficient permission to import environments into this scope (requires env:write)' };
              }
            }
            const res = get().importEnvironmentFromJson(jsonStr);
            if (res.success && res.environment) {
              return { success: true, type: 'environment', name: res.environment.name };
            }
            return { success: false, error: res.error };
          } else {
            if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
              if (!hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role)) {
                return { success: false, error: 'Insufficient permission to import collections into this scope (requires collection:write)' };
              }
            }
            const col = importPostmanCollection(jsonStr);
            await get().addCollection(col);
            return { success: true, type: 'collection', name: col.name };
          }
        } catch (err: unknown) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to import Postman file',
          };
        }
      },

      importCollectionFromJson: async (jsonStr) => {
        try {
          const { workspaceMode, cloudConfig } = get();
          if (detectPostmanJsonType(jsonStr) === 'environment') {
            const envRes = get().importEnvironmentFromJson(jsonStr);
            if (envRes.success) {
              return { success: true };
            }
            return { success: false, error: envRes.error };
          }

          if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
            if (!hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role)) {
              return { success: false, error: 'Insufficient permission to import collections into this scope (requires collection:write)' };
            }
          }

          const imported = importPostmanCollection(jsonStr);
          await get().addCollection(imported);
          return { success: true };
        } catch (err: unknown) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to parse Postman collection',
          };
        }
      },

      deleteCollection: async (id) => {
        const { workspaceMode, cloudConfig, collections } = get();
        if (movingCollections.has(id) || duplicatingCollections.has(id)) {
          return { success: false, error: 'A move or duplicate operation is already in progress for this collection.' };
        }
        const col = collections.find((c) => c.id === id);
        if (workspaceMode === 'cloud' && !get().isFeatureEnabled('collection.delete')) {
          void get().refreshFeaturePolicy(true);
          return { success: false, error: 'Collection deletion is disabled or feature policy is unavailable.' };
        }
        if (col) {
          if (!hasScopePermission(cloudConfig.activeScope, 'collection:delete', workspaceMode, cloudConfig.user?.role)) {
            console.warn(`User lacks permission to delete collection "${col.name}"`);
            return { success: false, error: 'You do not have permission to delete this collection.' };
          }
          if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn(`User lacks permission to delete collection "${col.name}"`);
            return { success: false, error: 'You do not have permission to delete this collection.' };
          }
        }

        if (!isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig)) {
          const operation = beginAsyncOperation();
          try {
            await deleteScopeCollection(
              cloudConfig.apiUrl,
              cloudConfig.token,
              id,
              cloudConfig.refreshToken,
              operation.controller.signal
            );
            if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled.' };
            set((state) => ({
              collections: state.collections.filter((c) => c.id !== id),
              ...pruneExampleTabsState(state, (sel) => sel.collectionId !== id),
              pendingExampleIntents: prunePendingExampleIntentsForTarget(state.pendingExampleIntents, id),
            }));
            return { success: true };
          } catch (err) {
            if (err instanceof CloudApiError && err.code === 'FEATURE_DISABLED') {
              void get().refreshFeaturePolicy(true);
            }
            if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled.' };
            console.error('Failed to delete collection from cloud:', err);
            return { success: false, error: err instanceof Error ? err.message : 'Failed to delete collection.' };
          } finally {
            completeAsyncOperation(operation);
          }
        }
        set((state) => ({
          collections: state.collections.filter((c) => c.id !== id),
          ...pruneExampleTabsState(state, (sel) => sel.collectionId !== id),
          pendingExampleIntents: prunePendingExampleIntentsForTarget(state.pendingExampleIntents, id),
        }));
        return { success: true };
      },

      updateCollectionPermission: async (collectionId, minRole) => {
        const { workspaceMode, cloudConfig, collections } = get();
        const col = collections.find((c) => c.id === collectionId);
        if (!col) return { success: false, error: 'Collection not found' };

        if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          const isProjectAdmin = hasScopePermission(cloudConfig.activeScope, '*', workspaceMode, cloudConfig.user?.role);
          const isProjectMaintainer = hasScopePermission(cloudConfig.activeScope, 'collection:delete', workspaceMode, cloudConfig.user?.role);
          if (!isProjectAdmin && !isProjectMaintainer) {
            return { success: false, error: 'You do not have permission to manage permissions for this collection.' };
          }
          const userRank = getUserScopeRank(workspaceMode, cloudConfig.activeScope, cloudConfig.token, cloudConfig.user);
          const roleRanks: Record<string, number> = { admin: 4, maintainer: 3, contributor: 2, reader: 1 };
          if ((roleRanks[minRole] || 1) > userRank) {
            return { success: false, error: 'You cannot set a minimum role higher than your own role.' };
          }
        }

        if (!isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && cloudConfig.activeScope?.type === 'project') {
          const operation = beginAsyncOperation();
          try {
            const updated = await updateScopeCollectionPermission(
              cloudConfig.apiUrl,
              cloudConfig.token,
              collectionId,
              minRole,
              col.version || 1,
              cloudConfig.refreshToken,
              operation.controller.signal
            );
            if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled.' };
            set((state) => ({
              collections: state.collections.map((c) =>
                c.id === collectionId
                  ? {
                      ...c,
                      minRole,
                      version: typeof updated?.version === 'number' ? updated.version : (c.version || 1) + 1,
                      updatedAt: Date.now(),
                    }
                  : c
              ),
            }));
            return { success: true };
          } catch (err: any) {
            if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled.' };
            console.error('Failed to update collection permission:', err);
            return { success: false, error: err.message || 'Failed to update collection permission.' };
          } finally {
            completeAsyncOperation(operation);
          }
        }

        set((state) => ({
          collections: state.collections.map((c) =>
            c.id === collectionId ? { ...c, minRole, updatedAt: Date.now() } : c
          ),
        }));
        return { success: true };
      },

      moveRequest: async (sourceCollectionId, requestId, targetCollectionId, targetFolderId) => {
        const { collections, workspaceMode, cloudConfig } = get();
        const sourceCol = collections.find((c) => c.id === sourceCollectionId);
        const targetCol = collections.find((c) => c.id === targetCollectionId);

        if (!sourceCol) {
          return { success: false, error: 'Source collection not found' };
        }
        if (!targetCol) {
          return { success: false, error: 'Target collection not found' };
        }
        if (sourceCol.isPartial) {
          return { success: false, error: 'Source collection is only partially loaded. Sync or reload details before moving items.' };
        }
        if (targetCol.isPartial) {
          return { success: false, error: 'Target collection is only partially loaded. Sync or reload details before moving items.' };
        }

        if (!canModifyCollection(sourceCol.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          return { success: false, error: 'Cannot move request: source collection is read-only' };
        }
        if (!canModifyCollection(targetCol.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          return { success: false, error: 'Cannot move request: target collection is read-only' };
        }

        const applyRequestMove = (cols: Collection[]): {
          foundItem: CollectionItem | null;
          targetFolderFound: boolean;
          nextCollections: Collection[];
        } => {
          const curSource = cols.find((c) => c.id === sourceCollectionId);
          const curTarget = cols.find((c) => c.id === targetCollectionId);
          if (!curSource || !curTarget) {
            return { foundItem: null, targetFolderFound: false, nextCollections: cols };
          }

          let itemToMove: CollectionItem | null = null;
          const removeItem = (items: CollectionItem[]): CollectionItem[] => {
            const result: CollectionItem[] = [];
            for (const it of items) {
              if (!itemToMove && it.type === 'request' && (it.id === requestId || it.request?.id === requestId)) {
                itemToMove = it;
                continue;
              }
              if (it.type === 'folder') {
                result.push({
                  ...it,
                  items: removeItem(it.items || []),
                });
                continue;
              }
              result.push(it);
            }
            return result;
          };

          const updatedSourceItems = removeItem(curSource.items || []);
          if (!itemToMove) {
            return { foundItem: null, targetFolderFound: false, nextCollections: cols };
          }

          let targetFolderFound = !targetFolderId;
          const insertItem = (items: CollectionItem[]): CollectionItem[] => {
            if (!targetFolderId) {
              return [...items, itemToMove!];
            }
            return items.map((it) => {
              if (it.type === 'folder') {
                if (it.id === targetFolderId) {
                  targetFolderFound = true;
                  return {
                    ...it,
                    items: [...(it.items || []), itemToMove!],
                  };
                }
                return {
                  ...it,
                  items: insertItem(it.items || []),
                };
              }
              return it;
            });
          };

          const updatedTargetItems = insertItem(
            sourceCollectionId === targetCollectionId ? updatedSourceItems : (curTarget.items || [])
          );
          if (!targetFolderFound) {
            return { foundItem: itemToMove, targetFolderFound: false, nextCollections: cols };
          }

          const now = Date.now();
          const nextCollections = cols.map((col) => {
            if (sourceCollectionId === targetCollectionId && col.id === sourceCollectionId) {
              return { ...col, items: updatedTargetItems, updatedAt: now };
            }
            if (col.id === sourceCollectionId) {
              return { ...col, items: updatedSourceItems, updatedAt: now };
            }
            if (col.id === targetCollectionId) {
              return { ...col, items: updatedTargetItems, updatedAt: now };
            }
            return col;
          });

          return { foundItem: itemToMove, targetFolderFound: true, nextCollections };
        };

        const findCurrentRequestFolderId = (items: CollectionItem[], parentId: string | null = null): string | null | undefined => {
          for (const it of items) {
            if (it.type === 'request' && (it.id === requestId || it.request?.id === requestId)) {
              return parentId;
            }
            if (it.type === 'folder' && it.items) {
              const found = findCurrentRequestFolderId(it.items, it.id);
              if (found !== undefined) return found;
            }
          }
          return undefined;
        };
        const currentFolderId = findCurrentRequestFolderId(sourceCol.items || []);
        if (
          currentFolderId !== undefined &&
          sourceCollectionId === targetCollectionId &&
          currentFolderId === (targetFolderId || null)
        ) {
          return { success: true };
        }

        const preview = applyRequestMove(collections);
        if (!preview.foundItem) {
          return { success: false, error: 'Request not found in source collection' };
        }
        if (!preview.targetFolderFound) {
          return { success: false, error: 'Target folder not found in target collection' };
        }

        return commitItemMove(preview.foundItem.id, sourceCollectionId, targetCollectionId, targetFolderId, () => {
          set((state) => {
            const committed = applyRequestMove(state.collections);
            if (!committed.foundItem || !committed.targetFolderFound) {
              return state;
            }
            return { collections: committed.nextCollections };
          });
        });
      },

      moveFolder: async (sourceCollectionId, folderId, targetCollectionId, targetFolderId) => {
        const { collections, workspaceMode, cloudConfig } = get();
        const sourceCol = collections.find((c) => c.id === sourceCollectionId);
        const targetCol = collections.find((c) => c.id === targetCollectionId);

        if (!sourceCol) {
          return { success: false, error: 'Source collection not found' };
        }
        if (!targetCol) {
          return { success: false, error: 'Target collection not found' };
        }
        if (sourceCol.isPartial) {
          return { success: false, error: 'Source collection is only partially loaded. Sync or reload details before moving items.' };
        }
        if (targetCol.isPartial) {
          return { success: false, error: 'Target collection is only partially loaded. Sync or reload details before moving items.' };
        }

        if (!canModifyCollection(sourceCol.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          return { success: false, error: 'Cannot move folder: source collection is read-only' };
        }
        if (!canModifyCollection(targetCol.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          return { success: false, error: 'Cannot move folder: target collection is read-only' };
        }

        // Circular check: a folder cannot be moved into itself
        if (targetFolderId && targetFolderId === folderId) {
          return { success: false, error: 'Cannot move folder into itself' };
        }

        const applyFolderMove = (cols: Collection[]): {
          folderToMove: CollectionItem | null;
          isCycle: boolean;
          targetFolderFound: boolean;
          nextCollections: Collection[];
        } => {
          const curSource = cols.find((c) => c.id === sourceCollectionId);
          const curTarget = cols.find((c) => c.id === targetCollectionId);
          if (!curSource || !curTarget) {
            return { folderToMove: null, isCycle: false, targetFolderFound: false, nextCollections: cols };
          }

          let folderToMove: CollectionItem | null = null;
          const removeFolder = (items: CollectionItem[]): CollectionItem[] => {
            const result: CollectionItem[] = [];
            for (const it of items) {
              if (!folderToMove && it.type === 'folder' && it.id === folderId) {
                folderToMove = it;
                continue;
              }
              if (it.type === 'folder') {
                result.push({
                  ...it,
                  items: removeFolder(it.items || []),
                });
                continue;
              }
              result.push(it);
            }
            return result;
          };

          const updatedSourceItems = removeFolder(curSource.items || []);
          if (!folderToMove) {
            return { folderToMove: null, isCycle: false, targetFolderFound: false, nextCollections: cols };
          }

          // Circular check: if target is in the same collection, cannot move folder into any of its own subfolders
          if (sourceCollectionId === targetCollectionId && targetFolderId) {
            if (isDescendantOf([folderToMove], folderId, targetFolderId)) {
              return { folderToMove, isCycle: true, targetFolderFound: false, nextCollections: cols };
            }
          }

          let targetFolderFound = !targetFolderId;
          const insertFolder = (items: CollectionItem[]): CollectionItem[] => {
            if (!targetFolderId) {
              return [...items, folderToMove!];
            }
            return items.map((it) => {
              if (it.type === 'folder') {
                if (it.id === targetFolderId) {
                  targetFolderFound = true;
                  return {
                    ...it,
                    items: [...(it.items || []), folderToMove!],
                  };
                }
                return {
                  ...it,
                  items: insertFolder(it.items || []),
                };
              }
              return it;
            });
          };

          const updatedTargetItems = insertFolder(
            sourceCollectionId === targetCollectionId ? updatedSourceItems : (curTarget.items || [])
          );
          if (targetFolderId && !targetFolderFound) {
            return { folderToMove, isCycle: false, targetFolderFound: false, nextCollections: cols };
          }

          const now = Date.now();
          const nextCollections = cols.map((col) => {
            if (sourceCollectionId === targetCollectionId && col.id === sourceCollectionId) {
              return { ...col, items: updatedTargetItems, updatedAt: now };
            }
            if (col.id === sourceCollectionId) {
              return { ...col, items: updatedSourceItems, updatedAt: now };
            }
            if (col.id === targetCollectionId) {
              return { ...col, items: updatedTargetItems, updatedAt: now };
            }
            return col;
          });

          return { folderToMove, isCycle: false, targetFolderFound: true, nextCollections };
        };

        const findCurrentParentFolderId = (items: CollectionItem[], parentId: string | null = null): string | null | undefined => {
          for (const it of items) {
            if (it.type === 'folder') {
              if (it.id === folderId) return parentId;
              if (it.items) {
                const found = findCurrentParentFolderId(it.items, it.id);
                if (found !== undefined) return found;
              }
            }
          }
          return undefined;
        };
        const currentParentId = findCurrentParentFolderId(sourceCol.items || []);
        if (
          currentParentId !== undefined &&
          sourceCollectionId === targetCollectionId &&
          currentParentId === (targetFolderId || null)
        ) {
          return { success: true };
        }

        const preview = applyFolderMove(collections);
        const folderToMove = preview.folderToMove;
        if (!folderToMove) {
          return { success: false, error: 'Folder not found in source collection' };
        }
        if (preview.isCycle) {
          return { success: false, error: 'Cannot move folder into one of its subfolders' };
        }
        if (targetFolderId && !preview.targetFolderFound) {
          return { success: false, error: 'Target folder not found in target collection' };
        }

        return commitItemMove((folderToMove as CollectionItem).id, sourceCollectionId, targetCollectionId, targetFolderId, () => {
          set((state) => {
            const committed = applyFolderMove(state.collections);
            if (!committed.folderToMove || committed.isCycle || (targetFolderId && !committed.targetFolderFound)) {
              return state;
            }
            return { collections: committed.nextCollections };
          });
        });
      },

      reorderItem: async (collectionId, activeId, targetId, position) => {
        const { collections, workspaceMode, cloudConfig } = get();
        if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
          return { success: false, error: 'A move or duplicate operation is already in progress for this collection.' };
        }
        const col = collections.find((c) => c.id === collectionId);
        if (!col) return { success: false, error: 'Collection not found' };
        if (col._needsMoveReconciliation || col.isPartial) {
          return { success: false, error: 'Sync the collection before reordering items.' };
        }

        if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          return { success: false, error: 'User lacks permission to reorder items in this collection' };
        }

        const previousItems = col.items;
        const previousSyncStatus = col._syncStatus;
        const result = reorderItemInTree(col.items, activeId, targetId, position);
        if (!result) return { success: false, error: 'Invalid reorder operation' };

        const { updatedItems, payload } = result;
        const shouldSync = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);

        if (shouldSync && !pendingReorderBaseSnapshots.has(collectionId)) {
          pendingReorderBaseSnapshots.set(collectionId, {
            items: previousItems,
            syncStatus: previousSyncStatus,
          });
        }

        set((state) => ({
          collections: state.collections.map((c) => {
            if (c.id !== collectionId) return c;
            return {
              ...c,
              items: updatedItems,
              updatedAt: Date.now(),
              ...(shouldSync ? { _syncStatus: 'pending' as const } : {}),
            };
          }),
        }));

        const token = cloudConfig.token;
        if (shouldSync && cloudConfig.activeScope) {
          const syncScope = cloudConfig.activeScope;
          const revision = (collectionSaveSyncRevisions.get(collectionId) ?? 0) + 1;
          collectionSaveSyncRevisions.set(collectionId, revision);
          void enqueueCollectionSyncTask(collectionId, syncScope, async (operation, generation) => {
            const send = async () => {
              const liveCloudConfig = get().cloudConfig;
              await reorderCollectionItems(
                liveCloudConfig.apiUrl || cloudConfig.apiUrl,
                liveCloudConfig.token || token,
                collectionId,
                payload,
                liveCloudConfig.refreshToken ?? cloudConfig.refreshToken,
                operation.controller.signal,
              );
            };
            try {
              try {
                await send();
              } catch {
                if (
                  operation.controller.signal.aborted ||
                  !isAsyncOperationCurrent(operation) ||
                  generation !== collectionSaveSyncGeneration
                ) {
                  return;
                }
                // Retry once after 250ms for transient race condition or network glitch
                await new Promise((r) => setTimeout(r, 250));
                if (
                  operation.controller.signal.aborted ||
                  !isAsyncOperationCurrent(operation) ||
                  generation !== collectionSaveSyncGeneration
                ) {
                  return;
                }
                await send();
              }
              if (
                !isAsyncOperationCurrent(operation) ||
                generation !== collectionSaveSyncGeneration ||
                collectionSaveSyncRevisions.get(collectionId) !== revision ||
                get().cloudConfig.activeScope?.id !== syncScope.id ||
                get().cloudConfig.activeScope?.type !== syncScope.type
              ) {
                return;
              }
              pendingReorderBaseSnapshots.delete(collectionId);
              set((state) => {
                const activeScopeKey = state.cloudConfig.activeScope ? getScopeCacheKey(state.cloudConfig.activeScope) : null;
                const updatedScopeCache = { ...(state.scopeCache || {}) };
                if (activeScopeKey && updatedScopeCache[activeScopeKey]) {
                  updatedScopeCache[activeScopeKey] = {
                    ...updatedScopeCache[activeScopeKey],
                    lastSyncedAt: 0,
                  };
                }
                return {
                  collections: state.collections.map((c) =>
                    c.id === collectionId
                      ? {
                          ...c,
                          version: typeof c.version === 'number' ? c.version + 1 : c.version,
                          _syncStatus: 'synced',
                        }
                      : c
                  ),
                  scopeCache: updatedScopeCache,
                  ...(state.syncStatus === 'error' ? { syncStatus: 'idle', syncError: null } : {}),
                };
              });
            } catch (retryErr: any) {
              if (
                operation.controller.signal.aborted ||
                !isAsyncOperationCurrent(operation) ||
                generation !== collectionSaveSyncGeneration ||
                collectionSaveSyncRevisions.get(collectionId) !== revision
              ) {
                return;
              }
              console.error('Failed to sync reordered items to cloud:', retryErr);
              const rejected = retryErr instanceof CloudApiError && [400, 403, 404, 409].includes(retryErr.status);
              const rollbackBase = rejected ? pendingReorderBaseSnapshots.get(collectionId) : undefined;
              if (rejected) {
                pendingReorderBaseSnapshots.delete(collectionId);
              }
              set((state) => ({
                collections: state.collections.map((c) => {
                  if (c.id !== collectionId) return c;
                  return rejected && rollbackBase
                    ? { ...c, items: rollbackBase.items, _syncStatus: rollbackBase.syncStatus ?? 'synced', updatedAt: Date.now() }
                    : { ...c, _syncStatus: 'pending' };
                }),
                syncStatus: 'error',
                syncError: retryErr.message || 'Failed to sync reordered items to cloud',
              }));
            }
          });
        }

        return { success: true };
      },

      moveCollection: async (collectionId, targetScope) => {
        const {
          workspaceMode,
          collections,
          cloudConfig,
          activeOfflineWorkspaceId,
        } = get();

        if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
          return { success: false, error: 'A move or duplicate operation is already in progress for this collection.' };
        }

        // 1. Target is an offline workspace
        if (targetScope.type === 'offline_workspace') {
          if (!allowsOfflineWorkspace) return { success: false, error: 'Offline workspaces are disabled for this product.' };
          const col = collections.find((c) => c.id === collectionId);
          if (!col) {
            return { success: false, error: 'Collection not found' };
          }
          if (col._needsMoveReconciliation) {
            return { success: false, error: 'Sync the workspace to confirm the previous move before moving this collection.' };
          }

          if (workspaceMode === 'cloud') {
            if (cloudConfig.activeScope?.type === 'project' &&
                (!hasScopePermission(cloudConfig.activeScope, 'collection:move', workspaceMode, cloudConfig.user?.role) ||
                  !canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role))) {
              return { success: false, error: 'Insufficient permission to move collection from this project' };
            }
            if (cloudConfig.activeScope?.type === 'project') {
              return { success: false, error: 'Collections in projects cannot be moved to personal workspaces.' };
            }
            return { success: false, error: 'Moving cloud collections to offline workspaces is unavailable.' };
          }

          if (workspaceMode === 'offline' && targetScope.id === activeOfflineWorkspaceId) {
            return { success: false, error: 'Cannot move to the current active workspace' };
          }
          if (!get().offlineWorkspaces?.some((w) => w.id === targetScope.id)) {
            return { success: false, error: 'Target offline workspace not found.' };
          }

          set((state) => {
            const latestCol = state.collections.find((c) => c.id === collectionId);
            if (!latestCol) return {};
            const remainingActive = state.collections.filter((c) => c.id !== collectionId);
            const updatedOfflineCache = { ...(state.offlineScopeCache || {}) };

            if (state.workspaceMode === 'offline' && state.activeOfflineWorkspaceId) {
              updatedOfflineCache[state.activeOfflineWorkspaceId] = {
                ...(updatedOfflineCache[state.activeOfflineWorkspaceId] || {}),
                collections: remainingActive,
                environments: state.environments,
                activeEnvironmentId: state.activeEnvironmentId,
                tabs: state.tabs,
                activeTabId: state.activeTabId,
                history: state.history,
              };
            }

            const targetEntry = updatedOfflineCache[targetScope.id] || {
              collections: [],
              environments: [],
              tabs: [createInitialTab()],
              history: [],
            };

            const existingTargetCols = (targetEntry.collections || []).filter((c) => c.id !== collectionId);
            updatedOfflineCache[targetScope.id] = {
              ...targetEntry,
              collections: [...existingTargetCols, { ...latestCol, _origin: 'offline' }],
            };

            return {
              collections: remainingActive,
              offlineScopeCache: updatedOfflineCache,
              ...pruneExampleTabsState(state, (sel) => sel.collectionId !== collectionId),
            };
          });

          await flushStorePersistence();
          return { success: true };
        }

        if (isOfflineOnly) {
          return { success: false, error: 'Offline edition cannot move collections to online scopes' };
        }

        if (workspaceMode === 'offline') {
          // Moving from offline to online scope
          const col = collections.find((c) => c.id === collectionId);
          if (!col) {
            return { success: false, error: 'Collection not found' };
          }
          if (!isCloudSessionActive(cloudConfig)) {
            return { success: false, error: 'Cloud authentication required to move collection to an online workspace' };
          }

          const sourceOfflineWorkspaceId = activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
          const capturedSessionGen = cloudSessionGeneration;
          const lock = Symbol('collection move offline-to-cloud');
          movingCollections.set(collectionId, lock);
          const operation = beginAsyncOperation();

          try {
            const policy = await get().refreshFeaturePolicy();
            if (
              !isAsyncOperationCurrent(operation) ||
              isStoreDisposed ||
              cloudSessionGeneration !== capturedSessionGen ||
              get().workspaceMode !== 'offline' ||
              (get().activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID) !== sourceOfflineWorkspaceId
            ) {
              return { success: false, error: 'Operation cancelled' };
            }
            if (!policy?.flags['collection.move']) {
              return { success: false, error: 'Collection move is disabled or feature policy is unavailable.' };
            }

            const latestCol = get().collections.find((c) => c.id === collectionId);
            if (!latestCol) {
              return { success: false, error: 'Collection not found' };
            }
            if (
              collectionHasSavedExamples(latestCol) &&
              policy?.capabilities?.saved_examples !== true
            ) {
              return {
                success: false,
                error: 'This cloud server does not support Saved Examples. Update the server before moving collections with examples.',
              };
            }

            set({ syncStatus: 'syncing', syncError: null });
            await batchImportToScope(
              cloudConfig.apiUrl,
              cloudConfig.token,
              targetScope,
              [latestCol],
              cloudConfig.refreshToken,
              operation.controller.signal
            );
            if (
              !isAsyncOperationCurrent(operation) ||
              isStoreDisposed ||
              cloudSessionGeneration !== capturedSessionGen
            ) {
              return { success: false, error: 'Operation cancelled' };
            }

            const targetKey = getScopeCacheKey(targetScope);
            set((state) => {
              const remainingActive = state.collections.filter((c) => c.id !== collectionId);
              const updatedOfflineCache = { ...(state.offlineScopeCache || {}) };
              if (updatedOfflineCache[sourceOfflineWorkspaceId]) {
                updatedOfflineCache[sourceOfflineWorkspaceId] = {
                  ...updatedOfflineCache[sourceOfflineWorkspaceId],
                  collections: (updatedOfflineCache[sourceOfflineWorkspaceId].collections || []).filter(
                    (c) => c.id !== collectionId
                  ),
                };
              }

              // Invalidate target scope cache freshness without inserting an unversioned _origin:'cloud'
              // stub (which would otherwise trigger a duplicate pending re-upload on scope switch)
              const updatedScopeCache = { ...(state.scopeCache || {}) };
              if (updatedScopeCache[targetKey]) {
                updatedScopeCache[targetKey] = {
                  ...updatedScopeCache[targetKey],
                  collections: (updatedScopeCache[targetKey].collections || []).filter(
                    (c) => c.id !== collectionId
                  ),
                  lastSyncedAt: 0,
                };
              }

              return {
                collections: remainingActive,
                offlineScopeCache: updatedOfflineCache,
                scopeCache: updatedScopeCache,
                syncStatus: 'idle',
              };
            });

            return { success: true };
          } catch (err: any) {
            if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled' };
            set({ syncStatus: 'error', syncError: err.message || 'Failed to move collection' });
            return { success: false, error: err.message || 'Failed to move collection' };
          } finally {
            completeAsyncOperation(operation);
            if (movingCollections.get(collectionId) === lock) movingCollections.delete(collectionId);
          }
        } else {
          // Moving from an online scope to another online scope
          const col = collections.find((c) => c.id === collectionId);
          if (!col) {
            return { success: false, error: 'Collection not found' };
          }
          if (col._needsMoveReconciliation) {
            return { success: false, error: 'Sync the workspace to confirm the previous move before moving this collection.' };
          }
          if (col._syncStatus === 'pending') {
            return { success: false, error: 'Sync pending changes in this collection before moving it.' };
          }
          if (!isCloudSessionActive(cloudConfig) || !cloudConfig.activeScope) {
            return { success: false, error: 'Not connected to cloud' };
          }
          if (activePullOperation && isAsyncOperationCurrent(activePullOperation)) {
            return { success: false, error: 'Wait for workspace sync to finish before moving collections.' };
          }
          if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
            if (!hasScopePermission(cloudConfig.activeScope, 'collection:move', workspaceMode, cloudConfig.user?.role) ||
                !canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
              return { success: false, error: 'Insufficient permission to move collection from this project' };
            }
          }

          const sourceScope = cloudConfig.activeScope;
          const lock = Symbol('collection move cloud-to-cloud');
          movingCollections.set(collectionId, lock);
          const operation = beginAsyncOperation();
          try {
            if (!get().isFeatureEnabled('collection.move')) {
              const policy = await get().refreshFeaturePolicy();
              if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled' };
              if (!policy?.flags['collection.move']) {
                return { success: false, error: 'Collection move is disabled or feature policy is unavailable.' };
              }
            }

            await collectionSaveSyncQueues.get(`${sourceScope.type}:${sourceScope.id}:${collectionId}`);
            if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled' };

            const latestCol = get().collections.find((c) => c.id === collectionId);
            if (!latestCol) {
              return { success: false, error: 'Collection not found' };
            }
            if (latestCol._syncStatus === 'pending') {
              return { success: false, error: 'Sync pending changes in this collection before moving it.' };
            }

            // Persist reconciliation flag before sending: after a lost reply, prevent local saves
            // from re-importing this collection into the source scope until cloud sync reconciles.
            set((state) => ({
              syncStatus: 'syncing',
              syncError: null,
              collections: state.collections.map((c) =>
                c.id === collectionId ? { ...c, _needsMoveReconciliation: true } : c
              ),
            }));
            await moveScopeCollection(
              cloudConfig.apiUrl,
              cloudConfig.token,
              collectionId,
              targetScope,
              cloudConfig.refreshToken,
              operation.controller.signal
            );
            if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled' };

            const currentScopeKey = getScopeCacheKey(sourceScope);
            const targetScopeKey = getScopeCacheKey(targetScope);
            set((state) => {
              const remainingCols = state.collections.filter((c) => c.id !== collectionId);
              const updatedScopeCache = { ...(state.scopeCache || {}) };

              if (updatedScopeCache[currentScopeKey]) {
                updatedScopeCache[currentScopeKey] = {
                  ...updatedScopeCache[currentScopeKey],
                  collections: (updatedScopeCache[currentScopeKey].collections || []).filter((c) => c.id !== collectionId),
                };
              }

              if (updatedScopeCache[targetScopeKey]) {
                const movedEntry: Collection = {
                  ...latestCol,
                  version: typeof latestCol.version === 'number' ? latestCol.version + 1 : 2,
                  _syncStatus: 'synced',
                  _needsMoveReconciliation: undefined,
                };
                updatedScopeCache[targetScopeKey] = {
                  ...updatedScopeCache[targetScopeKey],
                  collections: [
                    ...(updatedScopeCache[targetScopeKey].collections || []).filter((c) => c.id !== collectionId),
                    movedEntry,
                  ],
                  lastSyncedAt: 0,
                };
              }

              return {
                collections: remainingCols,
                scopeCache: updatedScopeCache,
                syncStatus: 'idle',
              };
            });

            return { success: true };
          } catch (err: any) {
            if (!isAsyncOperationCurrent(operation)) return { success: false, error: 'Operation cancelled' };
            if (err instanceof CloudApiError && err.code === 'FEATURE_DISABLED') {
              void get().refreshFeaturePolicy(true);
            }
            const rejected = err instanceof CloudApiError && [400, 403, 404, 409].includes(err.status);
            set((state) => ({
              syncStatus: 'error',
              syncError: err.message || 'Failed to move collection',
              collections: rejected
                ? state.collections.map((c) =>
                    c.id === collectionId ? { ...c, _needsMoveReconciliation: undefined } : c
                  )
                : state.collections,
            }));
            return { success: false, error: err.message || 'Failed to move collection' };
          } finally {
            completeAsyncOperation(operation);
            if (movingCollections.get(collectionId) === lock) movingCollections.delete(collectionId);
          }
        }
      },

      loadCollectionDetails: async (collectionId) => {
        if (isOfflineOnly) {
          return { success: false, error: 'Cloud collections are disabled for this product.' };
        }
        const { workspaceMode, cloudConfig } = get();
        if (workspaceMode !== 'cloud' || !isCloudSessionActive(cloudConfig) || !cloudConfig.activeScope) {
          return { success: false, error: 'Sign in to load cloud collection details.' };
        }
        const operation = beginAsyncOperation();
        try {
          const raw = await fetchCollectionByIdForRuntime(
            cloudConfig.apiUrl,
            cloudConfig.token,
            collectionId,
            cloudConfig.refreshToken,
            operation.controller.signal,
          );
          if (!isAsyncOperationCurrent(operation)) {
            return { success: false, error: 'Session or scope changed.' };
          }
          const currentOwnerKey = cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl);
          const built = buildCollectionFromDetails(raw);
          set((state) => {
            const exists = state.collections.some((c) => c.id === built.id);
            const nextCollections = exists
              ? state.collections.map((c) => {
                  if (c.id !== built.id) return c;
                  if (c._syncStatus === 'pending') return c;
                  const hydratedItems = preserveHydratedItemExamples(built.items || [], c.items || []);
                  return {
                    ...built,
                    items: hydratedItems,
                    ...(c._needsMoveReconciliation ? { _needsMoveReconciliation: true } : {}),
                  };
                })
              : [...state.collections, built];
            const overlaid = overlayPendingExampleIntentsOnCollections(
              nextCollections,
              state.pendingExampleIntents,
              currentOwnerKey,
              state.cloudConfig.activeScope,
            );
            return { collections: overlaid };
          });
          return { success: true, collection: built };
        } catch (err: unknown) {
          if (!isAsyncOperationCurrent(operation)) {
            return { success: false, error: 'Operation cancelled.' };
          }
          return { success: false, error: err instanceof Error ? err.message : 'Failed to load collection details.' };
        } finally {
          completeAsyncOperation(operation);
        }
      },

      selectSavedExample: (selection) => {
        if (!selection) {
          set({ selectedExample: null });
          return;
        }
        const tabId = makeExampleTabId(selection);
        set((state) => {
          const exists = (state.openExampleTabs || []).some((ex) => ex.id === tabId);
          const nextOpenExampleTabs = exists
            ? state.openExampleTabs
            : [...(state.openExampleTabs || []), { id: tabId, ...selection }];
          const currentOrder = syncVisualTabOrder(state.tabs, state.openExampleTabs, state.tabOrder);
          const nextTabOrder = exists ? currentOrder : [...currentOrder, tabId];
          return {
            openExampleTabs: nextOpenExampleTabs,
            tabOrder: nextTabOrder,
            selectedExample: selection,
            tabRevealRevision: state.tabRevealRevision + 1,
          };
        });
      },

      closeExampleTab: (tabId) => {
        set((state) => {
          const exists = (state.openExampleTabs || []).some((ex) => ex.id === tabId);
          if (!exists) return state;

          const ordered = buildOrderedVisualTabs(state.tabs, state.openExampleTabs, state.tabOrder);
          const closingIndex = ordered.findIndex((entry) => entry.kind === 'example' && entry.id === tabId);
          const nextOpenExampleTabs = (state.openExampleTabs || []).filter((ex) => ex.id !== tabId);
          const remainingOrdered = ordered.filter((entry) => entry.id !== tabId);
          const nextTabOrder = remainingOrdered.map((entry) => entry.id);

          const wasActive = Boolean(state.selectedExample && makeExampleTabId(state.selectedExample) === tabId);
          if (!wasActive) {
            return {
              openExampleTabs: nextOpenExampleTabs,
              tabOrder: nextTabOrder,
            };
          }

          const adj =
            remainingOrdered[closingIndex] ||
            remainingOrdered[closingIndex - 1] ||
            remainingOrdered[0];

          if (!adj) {
            return {
              openExampleTabs: nextOpenExampleTabs,
              tabOrder: nextTabOrder,
              selectedExample: null,
              activeTabId: '',
              activeResponse: null,
              canUndoActiveRequest: false,
              canRedoActiveRequest: false,
            };
          }

          if (adj.kind === 'example') {
            return {
              openExampleTabs: nextOpenExampleTabs,
              tabOrder: nextTabOrder,
              selectedExample: {
                collectionId: adj.exampleTab.collectionId,
                itemId: adj.exampleTab.itemId,
                exampleId: adj.exampleTab.exampleId,
              },
              tabRevealRevision: state.tabRevealRevision + 1,
            };
          }

          return {
            openExampleTabs: nextOpenExampleTabs,
            tabOrder: nextTabOrder,
            selectedExample: null,
            activeTabId: adj.id,
            activeResponse: state.tabResponses?.[adj.id] || null,
            tabRevealRevision: state.tabRevealRevision + 1,
            canUndoActiveRequest: (tabUndoHistory[adj.id]?.past?.length ?? 0) > 0,
            canRedoActiveRequest: (tabUndoHistory[adj.id]?.future?.length ?? 0) > 0,
          };
        });
      },

      saveResponseAsExample: async ({ collectionId, itemId, name, response, fallbackRequest }) => {
        const { workspaceMode, cloudConfig, collections } = get();
        if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
          return { success: false, error: 'Wait for the collection move or duplicate to finish first.' };
        }
        const col = collections.find((c) => c.id === collectionId);
        if (!col) {
          return { success: false, error: 'Target collection no longer exists.' };
        }
        if (col._needsMoveReconciliation) {
          return { success: false, error: 'Sync the workspace to confirm the previous move before saving examples.' };
        }
        if (col.isPartial) {
          return { success: false, error: 'Wait for collection details to finish loading before saving examples.' };
        }
        if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          return { success: false, error: `Collection "${col.name}" is read-only.`, code: 'FORBIDDEN' };
        }

        const targetItem = findCollectionItemById(col.items, itemId);
        if (!targetItem || targetItem.type !== 'request') {
          return { success: false, error: 'Target request item not found.' };
        }

        const eligibility = evaluateResponseExampleEligibility(response);
        if (!eligibility.eligible) {
          return { success: false, error: eligibility.reason };
        }

        const existingCount = getItemExampleCount(targetItem);
        if (existingCount >= MAX_SAVED_EXAMPLES_PER_ITEM) {
          return {
            success: false,
            error: `A request can have at most ${MAX_SAVED_EXAMPLES_PER_ITEM} saved examples.`,
            code: 'LIMIT_EXCEEDED',
          };
        }

        const sourceRequest = response.capturedRequest || fallbackRequest || targetItem.request;
        if (!sourceRequest) {
          return { success: false, error: 'Missing request snapshot for saved example.' };
        }
        const resolvedName = (name && name.trim())
          ? name.trim()
          : buildDefaultExampleName(response.status, response.statusText);
        const buildResult = buildSavedExampleFromResponse({
          id: generateId(),
          name: resolvedName,
          response,
          requestSnapshot: sourceRequest,
          buildUrlObj: buildPostmanUrl,
        });
        if (!buildResult.ok) {
          return { success: false, error: buildResult.error };
        }
        const builtExample = buildResult.example;

        if (Array.isArray(targetItem.examples) && targetItem.examplesLoaded !== false) {
          const totalBytes =
            targetItem.examples.reduce((sum, ex) => sum + getExampleUtf8ByteLength(JSON.stringify(ex)), 0) +
            getExampleUtf8ByteLength(JSON.stringify(builtExample));
          if (totalBytes > MAX_SAVED_EXAMPLES_TOTAL_BYTES_PER_ITEM) {
            return {
              success: false,
              error: 'Total saved examples size limit (2 MiB) exceeded for this request.',
              code: 'LIMIT_EXCEEDED',
            };
          }
        }

        const isCloud = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);
        if (isCloud) {
          const supported = await ensureSavedExamplesCapability();
          if (!supported) {
            return {
              success: false,
              error: 'This cloud server does not support Saved Examples. Update the server to save examples in cloud mode.',
            };
          }
        }

        const preMutationCollections = get().collections;
        const applyLocalAdd = (cols: Collection[]): Collection[] =>
          cols.map((c) => {
            if (c.id !== collectionId) return c;
            const res = updateCollectionItemById(c.items || [], itemId, (item) =>
              applyExampleMutationToItem(item, { op: 'add', example: builtExample }),
            );
            return res.found ? { ...c, items: res.items, updatedAt: Date.now() } : c;
          });

        const opId = generateId();
        const ownerKey = isCloud ? cloudCacheOwnerKey(cloudConfig, normalizeCloudApiUrl) : null;
        const intent: PendingExampleIntent | null = isCloud
          ? {
              operationId: opId,
              ownerKey,
              op: 'add',
              collectionId,
              itemId,
              exampleId: builtExample.id,
              baseVersion: typeof targetItem.version === 'number' ? targetItem.version : 1,
              example: builtExample,
              targetScope: cloudConfig.activeScope,
              createdAt: Date.now(),
              status: 'pending',
            }
          : null;

        set((state) => ({
          collections: applyLocalAdd(state.collections),
          ...(intent
            ? {
                pendingExampleIntents: {
                  ...(state.pendingExampleIntents || {}),
                  [opId]: intent,
                },
              }
            : {}),
        }));

        try {
          await flushStorePersistence();
        } catch (storageErr: unknown) {
          set((state) => ({
            collections: preMutationCollections,
            pendingExampleIntents: intent
              ? withoutPendingExampleIntent(state.pendingExampleIntents, opId)
              : state.pendingExampleIntents,
          }));
          const isQuota =
            storageErr instanceof Error &&
            (storageErr.name === 'QuotaExceededError' || /quota/i.test(storageErr.message));
          return {
            success: false,
            error: isQuota
              ? 'Browser storage quota exceeded while saving example. Free local storage space and try again.'
              : 'Failed to persist saved example.',
          };
        }

        if (!intent) {
          return { success: true, example: builtExample };
        }
        return await executeExampleIntent(intent, { preMutationCollections });
      },

      renameSavedExample: async ({ collectionId, itemId, exampleId, name }) => {
        const validation = validateSavedExampleName(name);
        if (!validation.valid) {
          return { success: false, error: validation.error };
        }
        const trimmedName = validation.name;
        const { workspaceMode, cloudConfig, collections } = get();
        if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
          return { success: false, error: 'Wait for the collection move or duplicate to finish first.' };
        }
        const col = collections.find((c) => c.id === collectionId);
        if (!col) return { success: false, error: 'Target collection not found.' };
        if (col._needsMoveReconciliation || col.isPartial) {
          return { success: false, error: 'Wait for collection sync to finish before renaming examples.' };
        }
        if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          return { success: false, error: `Collection "${col.name}" is read-only.`, code: 'FORBIDDEN' };
        }

        const targetItem = findCollectionItemById(col.items, itemId);
        if (!targetItem || targetItem.type !== 'request') {
          return { success: false, error: 'Target request item not found.' };
        }

        const existingTarget =
          targetItem.examples?.find((ex) => ex.id === exampleId) ||
          targetItem.exampleSummaries?.find((s) => s.id === exampleId);
        if (!existingTarget) {
          return { success: false, error: 'Saved example not found.' };
        }

        const isCloud = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);
        if (isCloud) {
          const supported = await ensureSavedExamplesCapability();
          if (!supported) {
            return { success: false, error: 'This cloud server does not support Saved Examples.' };
          }
        }

        const preMutationCollections = get().collections;
        const opId = generateId();
        const baseRevision = typeof existingTarget.revision === 'number' ? existingTarget.revision : 1;
        const nextRevision = baseRevision + 1;
        const ownerKey = isCloud ? cloudCacheOwnerKey(cloudConfig, normalizeCloudApiUrl) : null;
        const intent: PendingExampleIntent | null = isCloud
          ? {
              operationId: opId,
              ownerKey,
              op: 'rename',
              collectionId,
              itemId,
              exampleId,
              baseVersion: typeof targetItem.version === 'number' ? targetItem.version : 1,
              baseExampleRevision: baseRevision,
              name: trimmedName,
              targetScope: cloudConfig.activeScope,
              createdAt: Date.now(),
              status: 'pending',
            }
          : null;

        set((state) => ({
          collections: state.collections.map((c) => {
            if (c.id !== collectionId) return c;
            const res = updateCollectionItemById(c.items || [], itemId, (item) =>
              applyExampleMutationToItem(item, {
                op: 'rename',
                exampleId,
                name: trimmedName,
                nextExampleRevision: nextRevision,
              }),
            );
            return res.found ? { ...c, items: res.items, updatedAt: Date.now() } : c;
          }),
          ...(intent
            ? {
                pendingExampleIntents: {
                  ...(state.pendingExampleIntents || {}),
                  [opId]: intent,
                },
              }
            : {}),
        }));

        try {
          await flushStorePersistence();
        } catch (storageErr: unknown) {
          set((state) => ({
            collections: preMutationCollections,
            pendingExampleIntents: intent
              ? withoutPendingExampleIntent(state.pendingExampleIntents, opId)
              : state.pendingExampleIntents,
          }));
          const isQuota =
            storageErr instanceof Error &&
            (storageErr.name === 'QuotaExceededError' || /quota/i.test(storageErr.message));
          return {
            success: false,
            error: isQuota ? 'Browser storage quota exceeded.' : 'Failed to persist renamed example.',
          };
        }

        if (!intent) return { success: true };
        return await executeExampleIntent(intent, { preMutationCollections });
      },

      deleteSavedExample: async ({ collectionId, itemId, exampleId }) => {
        const { workspaceMode, cloudConfig, collections } = get();
        if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
          return { success: false, error: 'Wait for the collection move or duplicate to finish first.' };
        }
        const col = collections.find((c) => c.id === collectionId);
        if (!col) return { success: false, error: 'Target collection not found.' };
        if (col._needsMoveReconciliation || col.isPartial) {
          return { success: false, error: 'Wait for collection sync to finish before deleting examples.' };
        }
        if (!canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          return { success: false, error: `Collection "${col.name}" is read-only.`, code: 'FORBIDDEN' };
        }

        const targetItem = findCollectionItemById(col.items, itemId);
        if (!targetItem || targetItem.type !== 'request') {
          return { success: false, error: 'Target request item not found.' };
        }
        const existingTarget =
          targetItem.examples?.find((ex) => ex.id === exampleId) ||
          targetItem.exampleSummaries?.find((s) => s.id === exampleId);
        if (!existingTarget) {
          return { success: false, error: 'Saved example not found.' };
        }

        const isCloud = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);
        if (isCloud) {
          const supported = await ensureSavedExamplesCapability();
          if (!supported) {
            return { success: false, error: 'This cloud server does not support Saved Examples.' };
          }
        }

        const preMutationCollections = get().collections;
        const prevSelectedExample = get().selectedExample;
        const prevOpenExampleTabs = get().openExampleTabs;
        const prevTabOrder = get().tabOrder;
        const opId = generateId();
        const baseRevision = typeof existingTarget.revision === 'number' ? existingTarget.revision : 1;
        const ownerKey = isCloud ? cloudCacheOwnerKey(cloudConfig, normalizeCloudApiUrl) : null;
        const intent: PendingExampleIntent | null = isCloud
          ? {
              operationId: opId,
              ownerKey,
              op: 'delete',
              collectionId,
              itemId,
              exampleId,
              baseVersion: typeof targetItem.version === 'number' ? targetItem.version : 1,
              baseExampleRevision: baseRevision,
              targetScope: cloudConfig.activeScope,
              createdAt: Date.now(),
              status: 'pending',
            }
          : null;

        const targetExampleTabId = makeExampleTabId({ collectionId, itemId, exampleId });
        const deletedWasActive = Boolean(
          prevSelectedExample && makeExampleTabId(prevSelectedExample) === targetExampleTabId,
        );
        if (deletedWasActive) {
          get().closeExampleTab(targetExampleTabId);
        }

        set((state) => ({
          collections: state.collections.map((c) => {
            if (c.id !== collectionId) return c;
            const res = updateCollectionItemById(c.items || [], itemId, (item) =>
              applyExampleMutationToItem(item, { op: 'delete', exampleId }),
            );
            return res.found ? { ...c, items: res.items, updatedAt: Date.now() } : c;
          }),
          ...pruneExampleTabsState(
            state,
            (sel) =>
              !(
                sel.collectionId === collectionId &&
                sel.itemId === itemId &&
                sel.exampleId === exampleId
              ),
          ),
          ...(intent
            ? {
                pendingExampleIntents: {
                  ...(state.pendingExampleIntents || {}),
                  [opId]: intent,
                },
              }
            : {}),
        }));

        try {
          await flushStorePersistence();
        } catch (storageErr: unknown) {
          set((state) => ({
            collections: preMutationCollections,
            selectedExample: prevSelectedExample,
            openExampleTabs: prevOpenExampleTabs,
            tabOrder: prevTabOrder,
            pendingExampleIntents: intent
              ? withoutPendingExampleIntent(state.pendingExampleIntents, opId)
              : state.pendingExampleIntents,
          }));
          return {
            success: false,
            error: storageErr instanceof Error ? storageErr.message : 'Failed to persist example deletion.',
          };
        }

        if (!intent) return { success: true };
        return await executeExampleIntent(intent, { preMutationCollections });
      },

      loadItemExamples: async (collectionId, itemId) => {
        const { workspaceMode, cloudConfig, collections } = get();
        const col = collections.find((c) => c.id === collectionId);
        const existingItem = col ? findCollectionItemById(col.items, itemId) : undefined;
        if (isOfflineOnly || workspaceMode !== 'cloud') {
          return existingItem
            ? { success: true, item: existingItem }
            : { success: false, error: 'Item unavailable', notFound: true };
        }
        if (!isCloudSessionActive(cloudConfig) || !cloudConfig.activeScope) {
          return { success: false, error: 'Sign in to load item examples.' };
        }
        const operation = beginAsyncOperation();
        try {
          const rawItem = await fetchScopeItem(
            cloudConfig.apiUrl,
            cloudConfig.token,
            itemId,
            cloudConfig.refreshToken,
            operation.controller.signal,
          );
          if (!isAsyncOperationCurrent(operation) || isStoreDisposed) {
            return { success: false, error: 'Session or scope changed.' };
          }
          commitServerItemToStore(collectionId, itemId, rawItem, cloudConfig.activeScope);
          const ownerKey = cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl);
          set((state) => ({
            collections: overlayPendingExampleIntentsOnCollections(
              state.collections,
              state.pendingExampleIntents,
              ownerKey,
              state.cloudConfig.activeScope,
            ),
          }));
          const updatedCol = get().collections.find((c) => c.id === collectionId);
          const updatedItem = updatedCol ? findCollectionItemById(updatedCol.items, itemId) : undefined;
          return { success: true, item: updatedItem };
        } catch (err: unknown) {
          if (!isAsyncOperationCurrent(operation) || isStoreDisposed) {
            return { success: false, error: 'Operation cancelled.' };
          }
          if (err instanceof CloudApiError && err.status === 403) {
            return { success: false, forbidden: true, error: 'You do not have permission to view this item.' };
          }
          if (err instanceof CloudApiError && err.status === 404) {
            set((state) => ({
              ...pruneExampleTabsState(state, (sel) => sel.itemId !== itemId),
            }));
            return { success: false, notFound: true, error: 'Item unavailable or deleted.' };
          }
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to load saved examples.',
          };
        } finally {
          completeAsyncOperation(operation);
        }
      },

      hydrateCollectionExamples: async (collectionId, options?: { includeBody?: boolean }) => {
        const includeBody = options?.includeBody !== false;
        const { workspaceMode, cloudConfig, collections } = get();
        const col = collections.find((c) => c.id === collectionId);
        if (!col) {
          return { success: false, error: 'Collection not found.' };
        }
        if (isOfflineOnly || workspaceMode !== 'cloud') {
          return { success: true, collection: col };
        }
        if (!isCloudSessionActive(cloudConfig) || !cloudConfig.activeScope) {
          return { success: false, error: 'Sign in to load saved examples.' };
        }

        const hasTruncated = (items: CollectionItem[] = []): boolean =>
          items.some((it) =>
            it.type === 'folder'
              ? hasTruncated(it.items || [])
              : it.exampleSummariesTruncated === true || (includeBody && it.examplesLoaded === false && getItemExampleCount(it) > 0),
          );

        if (!col.isPartial && !hasTruncated(col.items || []) && !hasUnloadedCollectionExamples(col)) {
          return { success: true, collection: col };
        }

        const operation = beginAsyncOperation();
        try {
          if (col.isPartial) {
            const loaded = await get().loadCollectionDetails(collectionId);
            if (!loaded.success) {
              return { success: false, error: loaded.error || 'Failed to load collection details.' };
            }
          }

          for (let driftAttempt = 0; driftAttempt < 2; driftAttempt++) {
            let cursor: string | undefined = undefined;
            let expectedCollectionVersion: number | null = null;
            let versionDrifted = false;
            const pageUpdates = new Map<string, any>();

            while (true) {
              if (!isAsyncOperationCurrent(operation) || isStoreDisposed) {
                return { success: false, error: 'Session or scope changed.' };
              }
              const page = await fetchScopeCollectionExamples(
                cloudConfig.apiUrl,
                cloudConfig.token,
                collectionId,
                { cursor, limit: 100, includeBody },
                cloudConfig.refreshToken,
                operation.controller.signal,
              );
              if (expectedCollectionVersion === null) {
                expectedCollectionVersion = page.collection_version;
              } else if (page.collection_version !== expectedCollectionVersion) {
                versionDrifted = true;
                break;
              }
              for (const itemPage of page.items || []) {
                pageUpdates.set(itemPage.item_id, itemPage);
              }
              if (!page.has_more || !page.next_cursor) break;
              cursor = page.next_cursor;
            }

            if (versionDrifted) {
              if (driftAttempt === 0) {
                await get().loadCollectionDetails(collectionId);
                continue;
              }
              return { success: false, error: 'Collection changed on server while loading examples. Please retry.' };
            }

            const ownerKey = cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl);
            set((state) => {
              const applyUpdates = (items: CollectionItem[]): CollectionItem[] =>
                items.map((item) => {
                  if (item.type === 'folder') {
                    return { ...item, items: applyUpdates(item.items || []) };
                  }
                  const upd = pageUpdates.get(item.id);
                  return upd ? applyServerItemToLocalItem(item, upd) : item;
                });
              const updatedCols = state.collections.map((c) =>
                c.id === collectionId
                  ? {
                      ...c,
                      ...(typeof expectedCollectionVersion === 'number' ? { version: expectedCollectionVersion } : {}),
                      items: applyUpdates(c.items || []),
                    }
                  : c,
              );
              return {
                collections: overlayPendingExampleIntentsOnCollections(
                  updatedCols,
                  state.pendingExampleIntents,
                  ownerKey,
                  state.cloudConfig.activeScope,
                ),
              };
            });

            const hydrated = get().collections.find((c) => c.id === collectionId);
            return { success: true, collection: hydrated };
          }
          return { success: false, error: 'Failed to hydrate collection examples.' };
        } catch (err: unknown) {
          if (!isAsyncOperationCurrent(operation) || isStoreDisposed) {
            return { success: false, error: 'Operation cancelled.' };
          }
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to hydrate collection examples.',
          };
        } finally {
          completeAsyncOperation(operation);
        }
      },

      retryPendingExampleIntent: async (operationId) => {
        const intent = get().pendingExampleIntents?.[operationId];
        if (!intent) {
          return { success: false, error: 'Pending saved example intent not found.' };
        }
        return await executeExampleIntent(intent);
      },

      clearPendingExampleIntent: (operationId) => {
        if (inFlightExampleOperations.has(operationId)) return;
        set((state) => ({
          pendingExampleIntents: withoutPendingExampleIntent(state.pendingExampleIntents, operationId),
        }));
      },

      clearPendingDuplicateIntent: (operationId) => {
        if (inFlightDuplicateOperations.has(operationId) || get().activeDuplicateOperationIds?.[operationId]) {
          return;
        }
        set((state) => {
          if (!state.pendingDuplicateIntents?.[operationId]) return state;
          return { pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, operationId) };
        });
      },

      retryPendingDuplicateIntent: async (operationId) => {
        if (inFlightDuplicateOperations.has(operationId) || get().activeDuplicateOperationIds?.[operationId]) {
          return {
            success: false,
            operationId,
            reconcilePending: true,
            error: 'Duplicate operation is already in progress.',
          };
        }
        const intent = get().pendingDuplicateIntents?.[operationId];
        if (!intent) {
          return { success: false, error: 'Pending duplicate intent not found.' };
        }
        const currentOwner = cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl);
        if (intent.ownerKey !== null && intent.ownerKey !== currentOwner) {
          return { success: false, error: 'This pending duplicate belongs to a different cloud account.' };
        }
        if (intent.kind === 'item') {
          if (!intent.targetCollectionId) {
            return { success: false, error: 'Pending item duplicate intent is missing target collection.' };
          }
          return get().duplicateCollectionItem(
            intent.sourceCollectionId,
            intent.sourceItemId || '',
            intent.targetCollectionId,
            intent.targetParentId ?? null,
            { operationId: intent.operationId },
          );
        }
        if (!intent.targetScope) {
          return { success: false, error: 'Pending collection duplicate intent is missing target scope.' };
        }
        return get().duplicateCollection(intent.sourceCollectionId, intent.targetScope, {
          operationId: intent.operationId,
        });
      },

      duplicateCollection: async (collectionId, targetScope, actionOptions) => {
        const flushPersisted = async () => {
          await get().persistNativeCredentialState();
        };
        const findCollectionNodePath = (col: Collection): string[] => [col.id];
        const stateAtStart = get();
        const {
          workspaceMode,
          collections,
          cloudConfig,
          offlineWorkspaces,
          activeOfflineWorkspaceId,
          offlineScopeCache,
        } = stateAtStart;

        const existingIntent = actionOptions?.operationId
          ? stateAtStart.pendingDuplicateIntents?.[actionOptions.operationId]
          : undefined;
        const currentOwnerKey = isCloudSessionActive(cloudConfig)
          ? cloudCacheOwnerKey(cloudConfig, normalizeCloudApiUrl)
          : null;

        const resolveReceiptScopeKey = (
          receipt: { workspace_id?: string | null; project_id?: string | null },
          fallbackScopeKey: string,
        ): string => {
          if (receipt.workspace_id) return `workspace:${receipt.workspace_id}`;
          if (receipt.project_id) return `project:${receipt.project_id}`;
          return fallbackScopeKey;
        };

        const resolveReceiptTargetScope = (
          receipt: { workspace_id?: string | null; project_id?: string | null },
          fallbackScope: ActiveScope,
        ): ActiveScope => {
          if (receipt.workspace_id) {
            return fallbackScope.type === 'workspace' && fallbackScope.id === receipt.workspace_id
              ? fallbackScope
              : { id: receipt.workspace_id, name: fallbackScope.name, type: 'workspace' };
          }
          if (receipt.project_id) {
            return fallbackScope.type === 'project' && fallbackScope.id === receipt.project_id
              ? fallbackScope
              : { id: receipt.project_id, name: fallbackScope.name, type: 'project' };
          }
          return fallbackScope;
        };

        // Shared reconciliation for a committed/replayed collection duplicate receipt (import_duplicate or collection).
        const finalizeCommittedCollectionReceipt = async (
          opId: string,
          receipt: {
            collection_id: string;
            workspace_id?: string | null;
            project_id?: string | null;
            name: string;
            min_role: ProjectRole;
            version: number;
            status: string;
          },
          fallbackTargetScope: ActiveScope,
          capturedSessionGen: number,
          ownerKey: string,
          operationSignal: AbortSignal,
          checkActiveOp: () => boolean,
        ): Promise<DuplicateActionResult> => {
          const fallbackScopeKey = getScopeCacheKey(fallbackTargetScope);
          const authoritativeScopeKey = resolveReceiptScopeKey(receipt, fallbackScopeKey);
          const resolvedTargetScope = resolveReceiptTargetScope(receipt, fallbackTargetScope);

          const latestState = get();
          const latestActiveScopeKey =
            latestState.workspaceMode === 'cloud' && latestState.cloudConfig.activeScope
              ? getScopeCacheKey(latestState.cloudConfig.activeScope)
              : null;
          const matchesActiveScope =
            latestActiveScopeKey !== null && latestActiveScopeKey === authoritativeScopeKey;

          const clearAffectedScopeCaches = (
            baseCache: Record<string, any> | undefined,
            extraScopeKey?: string | null,
          ) => {
            const nextScopeCache = { ...(baseCache || {}) };
            delete nextScopeCache[authoritativeScopeKey];
            if (fallbackScopeKey !== authoritativeScopeKey) {
              delete nextScopeCache[fallbackScopeKey];
            }
            if (extraScopeKey && extraScopeKey !== authoritativeScopeKey && extraScopeKey !== fallbackScopeKey) {
              delete nextScopeCache[extraScopeKey];
            }
            return nextScopeCache;
          };

          if (receipt.status === 'committed_deleted') {
            set((state) => ({
              pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
              scopeCache: clearAffectedScopeCaches(state.scopeCache),
              syncStatus: 'idle',
              ...(matchesActiveScope
                ? { collections: state.collections.filter((c) => c.id !== receipt.collection_id) }
                : {}),
            }));
            return {
              success: true,
              operationId: opId,
              createdCollectionId: receipt.collection_id,
              targetScope: resolvedTargetScope,
              name: receipt.name,
              minRole: receipt.min_role,
              deletedOnServer: true,
            };
          }

          if (matchesActiveScope && checkActiveOp()) {
            let createdCol: Collection | undefined;
            let rawMatchesActive = true;
            let rawScopeKey: string | null = null;
            let detailsError: string | undefined;
            try {
              const raw = await fetchCollectionByIdForRuntime(
                cloudConfig.apiUrl,
                cloudConfig.token,
                receipt.collection_id,
                cloudConfig.refreshToken,
                operationSignal,
              );
              rawScopeKey = raw?.workspace_id
                ? `workspace:${raw.workspace_id}`
                : raw?.project_id
                  ? `project:${raw.project_id}`
                  : null;
              if (rawScopeKey && rawScopeKey !== latestActiveScopeKey) {
                rawMatchesActive = false;
              } else {
                createdCol = buildCollectionFromDetails(raw);
              }
            } catch (err: unknown) {
              detailsError = err instanceof Error ? err.message : 'Failed to load collection details.';
              createdCol = {
                id: receipt.collection_id,
                name: receipt.name,
                items: [],
                version: receipt.version,
                minRole: receipt.min_role,
                isPartial: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                _origin: 'cloud',
              };
            }
            if (
              !checkActiveOp() ||
              cloudSessionGeneration !== capturedSessionGen ||
              cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) !== ownerKey
            ) {
              if (
                !isStoreDisposed &&
                cloudSessionGeneration === capturedSessionGen &&
                cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === ownerKey
              ) {
                set((state) => ({
                  pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
                  scopeCache: clearAffectedScopeCaches(state.scopeCache, rawScopeKey),
                  syncStatus: 'idle',
                }));
              }
              return { success: false, operationId: opId, error: 'Session or scope changed.' };
            }
            const stateAfterFetch = get();
            const postFetchActiveScopeKey =
              stateAfterFetch.workspaceMode === 'cloud' && stateAfterFetch.cloudConfig.activeScope
                ? getScopeCacheKey(stateAfterFetch.cloudConfig.activeScope)
                : null;
            if (rawMatchesActive && createdCol && postFetchActiveScopeKey === authoritativeScopeKey) {
              set((state) => {
                const filtered = state.collections.filter((c) => c.id !== createdCol!.id);
                return {
                  pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
                  scopeCache: clearAffectedScopeCaches(state.scopeCache, rawScopeKey),
                  collections: [...filtered, createdCol!],
                  lastDuplicateReveal: {
                    pathIds: [createdCol!.id],
                    revision: (state.lastDuplicateReveal?.revision ?? 0) + 1,
                  },
                  syncStatus: 'idle',
                };
              });
              return {
                success: true,
                operationId: opId,
                createdCollectionId: receipt.collection_id,
                targetScope: resolvedTargetScope,
                name: createdCol.name,
                minRole: createdCol.minRole,
                ...(detailsError ? { detailsUnavailable: true, detailsError } : {}),
                revealPathIds: [createdCol.id],
              };
            }
          }

          set((state) => ({
            pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
            scopeCache: clearAffectedScopeCaches(state.scopeCache),
            syncStatus: 'idle',
          }));
          return {
            success: true,
            operationId: opId,
            createdCollectionId: receipt.collection_id,
            targetScope: resolvedTargetScope,
            name: receipt.name,
            minRole: receipt.min_role,
          };
        };

        // Replay path for persisted intents (even if source collection/item disappeared locally after submit).
        if (existingIntent && targetScope.type !== 'offline_workspace') {
          if (isOfflineOnly || !isCloudSessionActive(cloudConfig) || !currentOwnerKey || existingIntent.ownerKey !== currentOwnerKey) {
            return { success: false, error: 'Sign in with the owning cloud account to reconcile this duplicate.' };
          }
          if (existingIntent.kind === 'import_duplicate' && existingIntent.sanitizedPayload) {
            if (inFlightDuplicateOperations.has(existingIntent.operationId)) {
              return {
                success: false,
                operationId: existingIntent.operationId,
                reconcilePending: true,
                error: 'Duplicate operation is already in progress.',
              };
            }
            markDuplicateOperationInFlight(existingIntent.operationId);
            const operation = beginAsyncOperation();
            const capturedSessionGen = cloudSessionGeneration;
            try {
              set({ syncStatus: 'syncing', syncError: null });
              const receipt = await importDuplicateCollection(
                cloudConfig.apiUrl,
                cloudConfig.token,
                targetScope,
                existingIntent.sanitizedPayload,
                existingIntent.operationId,
                cloudConfig.refreshToken,
                operation.controller.signal,
              );
              const stillSameOwner =
                !isStoreDisposed &&
                cloudSessionGeneration === capturedSessionGen &&
                currentOwnerKey !== null &&
                cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
              if (!stillSameOwner) {
                return { success: false, error: 'Session changed', operationId: existingIntent.operationId };
              }
              return await finalizeCommittedCollectionReceipt(
                existingIntent.operationId,
                receipt,
                targetScope,
                capturedSessionGen,
                currentOwnerKey,
                operation.controller.signal,
                () => !isStoreDisposed && isAsyncOperationCurrent(operation),
              );
            } catch (err: unknown) {
              const rejected = err instanceof CloudApiError && [400, 403, 404, 409, 413, 415].includes(err.status);
              const errMsg = err instanceof Error ? err.message : 'Failed to upload duplicated collection';
              const stillSameOwner =
                !isStoreDisposed &&
                cloudSessionGeneration === capturedSessionGen &&
                currentOwnerKey !== null &&
                cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
              if (stillSameOwner) {
                set((state) => ({
                  pendingDuplicateIntents: rejected
                    ? withoutPendingDuplicateIntent(state.pendingDuplicateIntents, existingIntent.operationId)
                    : withReconcileRequiredIntent(
                        state.pendingDuplicateIntents,
                        existingIntent.operationId,
                        existingIntent,
                        errMsg,
                      ),
                  syncStatus: 'error',
                  syncError: errMsg,
                }));
              }
              return {
                success: false,
                operationId: existingIntent.operationId,
                reconcilePending: !rejected,
                error: errMsg,
              };
            } finally {
              completeAsyncOperation(operation);
              clearDuplicateOperationInFlight(existingIntent.operationId);
            }
          }

          if (existingIntent.kind === 'collection') {
            if (inFlightDuplicateOperations.has(existingIntent.operationId) || duplicatingCollections.has(collectionId)) {
              return { success: false, error: 'Another move or duplicate operation is in progress for this collection.' };
            }
            markDuplicateOperationInFlight(existingIntent.operationId);
            const lock = Symbol('collection duplicate replay');
            duplicatingCollections.set(collectionId, lock);
            const operation = beginAsyncOperation();
            const capturedSessionGen = cloudSessionGeneration;
            try {
              set({ syncStatus: 'syncing', syncError: null });
              const receipt = await duplicateScopeCollection(
                cloudConfig.apiUrl,
                cloudConfig.token,
                existingIntent.sourceCollectionId,
                targetScope,
                existingIntent.operationId,
                cloudConfig.refreshToken,
                operation.controller.signal,
              );
              const stillSameOwner =
                !isStoreDisposed &&
                cloudSessionGeneration === capturedSessionGen &&
                currentOwnerKey !== null &&
                cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
              if (!stillSameOwner || !isAsyncOperationCurrent(operation)) {
                return { success: false, error: 'Session or scope changed.', operationId: existingIntent.operationId };
              }
              return await finalizeCommittedCollectionReceipt(
                existingIntent.operationId,
                receipt,
                targetScope,
                capturedSessionGen,
                currentOwnerKey,
                operation.controller.signal,
                () => isAsyncOperationCurrent(operation),
              );
            } catch (err: unknown) {
              const rejected = err instanceof CloudApiError && [400, 403, 404, 409, 413].includes(err.status);
              const errMsg = err instanceof Error ? err.message : 'Failed to duplicate collection';
              const stillCurrent =
                isAsyncOperationCurrent(operation) &&
                cloudSessionGeneration === capturedSessionGen &&
                cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
              if (stillCurrent) {
                set((state) => ({
                  pendingDuplicateIntents: rejected
                    ? withoutPendingDuplicateIntent(state.pendingDuplicateIntents, existingIntent.operationId)
                    : withReconcileRequiredIntent(
                        state.pendingDuplicateIntents,
                        existingIntent.operationId,
                        existingIntent,
                        errMsg,
                      ),
                  syncStatus: 'error',
                  syncError: errMsg,
                }));
              }
              return {
                success: false,
                operationId: existingIntent.operationId,
                reconcilePending: !rejected,
                error: errMsg,
              };
            } finally {
              completeAsyncOperation(operation);
              clearDuplicateOperationInFlight(existingIntent.operationId);
              if (duplicatingCollections.get(collectionId) === lock) {
                duplicatingCollections.delete(collectionId);
              }
            }
          }
        }

        const sourceCol = collections.find((c) => c.id === collectionId);
        if (!sourceCol) {
          return { success: false, error: 'Source collection not found.' };
        }
        if (sourceCol._needsMoveReconciliation) {
          return { success: false, error: 'Sync the workspace to confirm the previous move before duplicating.' };
        }

        // 1. Target is an offline workspace
        if (targetScope.type === 'offline_workspace') {
          if (!allowsOfflineWorkspace) {
            return { success: false, error: 'Offline workspaces are disabled for this product.' };
          }
          if (workspaceMode === 'cloud') {
            return { success: false, error: 'Duplicating cloud collections to offline workspaces is not supported.' };
          }
          const targetExists = (offlineWorkspaces || []).some((w) => w.id === targetScope.id);
          if (!targetExists) {
            return { success: false, error: 'Target offline workspace no longer exists.' };
          }

          let cloned: Collection;
          try {
            cloned = duplicateCollectionTree(sourceCol, {
              sameContainer: targetScope.id === activeOfflineWorkspaceId,
              targetOrigin: 'offline',
            });
          } catch (err: unknown) {
            return { success: false, error: err instanceof Error ? err.message : 'Invalid collection for duplication.' };
          }

          const hadTargetCacheBefore = Boolean((get().offlineScopeCache || {})[targetScope.id]);
          const prevReveal = get().lastDuplicateReveal;
          const isSameOfflineWs = targetScope.id === activeOfflineWorkspaceId;
          let appliedRevealRevision: number | null = null;

          if (isSameOfflineWs) {
            set((state) => {
              appliedRevealRevision = (state.lastDuplicateReveal?.revision ?? 0) + 1;
              return {
                collections: [...state.collections, cloned],
                lastDuplicateReveal: {
                  pathIds: findCollectionNodePath(cloned),
                  revision: appliedRevealRevision,
                },
              };
            });
          } else {
            set((state) => {
              const prevCache = state.offlineScopeCache || {};
              const targetEntry = prevCache[targetScope.id] || {
                collections: [],
                environments: [],
                activeEnvironmentId: null,
                tabs: [createInitialTab()],
                history: [],
              };
              return {
                offlineScopeCache: {
                  ...prevCache,
                  [targetScope.id]: {
                    ...targetEntry,
                    collections: [...(targetEntry.collections || []), cloned],
                  },
                },
              };
            });
          }

          try {
            await flushPersisted();
          } catch {
            // Roll back only the newly created clone by ID from the target workspace's latest state.
            set((state) => {
              const isTargetActive =
                state.workspaceMode === 'offline' && state.activeOfflineWorkspaceId === targetScope.id;
              const prevCache = state.offlineScopeCache || {};
              let nextOfflineCache = prevCache;
              if (prevCache[targetScope.id]) {
                const filteredCachedCollections = (prevCache[targetScope.id].collections || []).filter(
                  (c) => c.id !== cloned.id,
                );
                if (
                  !isTargetActive &&
                  !hadTargetCacheBefore &&
                  filteredCachedCollections.length === 0 &&
                  (prevCache[targetScope.id].environments || []).length === 0 &&
                  (prevCache[targetScope.id].history || []).length === 0
                ) {
                  nextOfflineCache = { ...prevCache };
                  delete nextOfflineCache[targetScope.id];
                } else {
                  nextOfflineCache = {
                    ...prevCache,
                    [targetScope.id]: {
                      ...prevCache[targetScope.id],
                      collections: filteredCachedCollections,
                    },
                  };
                }
              }
              const nextReveal =
                appliedRevealRevision !== null && state.lastDuplicateReveal?.revision === appliedRevealRevision
                  ? prevReveal
                  : state.lastDuplicateReveal;
              return {
                ...(isTargetActive
                  ? { collections: state.collections.filter((c) => c.id !== cloned.id) }
                  : {}),
                offlineScopeCache: nextOfflineCache,
                lastDuplicateReveal: nextReveal,
              };
            });
            return { success: false, error: 'Failed to persist duplicated collection to local storage.' };
          }

          return {
            success: true,
            createdCollectionId: cloned.id,
            targetScope,
            name: cloned.name,
            minRole: cloned.minRole,
            ...(isSameOfflineWs ? { revealPathIds: [cloned.id] } : {}),
          };
        }

        // 2. Cloud targets require cloud policy and active session
        if (isOfflineOnly) {
          return { success: false, error: 'Offline edition cannot duplicate collections to cloud workspaces.' };
        }
        if (!isCloudSessionActive(cloudConfig) || !currentOwnerKey) {
          return { success: false, error: 'Cloud authentication required to duplicate to a cloud workspace.' };
        }

        // 2a. Offline -> Cloud upload duplicate
        if (workspaceMode === 'offline') {
          if (
            targetScope.type === 'project' &&
            !hasScopePermission(targetScope, 'collection:write', 'cloud', cloudConfig.user?.role)
          ) {
            return { success: false, error: 'Write permission in the target project is required.' };
          }
          if (collectionHasSavedExamples(sourceCol)) {
            const supported = await ensureSavedExamplesCapability(true);
            if (!supported) {
              return {
                success: false,
                error: 'This cloud server does not support Saved Examples. Update the server before uploading collections with examples.',
              };
            }
          }

          let sanitizedPayload: { name: string; description?: string; items: any[] };
          try {
            const sanitizedCol = duplicateCollectionTree(sourceCol, {
              sameContainer: false,
              targetOrigin: 'cloud',
              sanitizeForCloud: true,
            });
            sanitizedPayload = formatImportDuplicateCollectionPayload(sanitizedCol);
          } catch (err: unknown) {
            return { success: false, error: err instanceof Error ? err.message : 'Invalid collection for cloud upload.' };
          }

          const opId = actionOptions?.operationId || crypto.randomUUID();
          if (inFlightDuplicateOperations.has(opId)) {
            return {
              success: false,
              operationId: opId,
              reconcilePending: true,
              error: 'Duplicate operation is already in progress.',
            };
          }
          const intent: PendingDuplicateIntent = {
            operationId: opId,
            ownerKey: currentOwnerKey,
            kind: 'import_duplicate',
            sourceCollectionId: sourceCol.id,
            sourceName: sourceCol.name,
            targetScope,
            sanitizedPayload,
            createdAt: Date.now(),
            status: 'pending',
          };

          const operation = beginAsyncOperation();
          const capturedSessionGen = cloudSessionGeneration;
          markDuplicateOperationInFlight(opId);
          set((state) => ({
            pendingDuplicateIntents: { ...(state.pendingDuplicateIntents || {}), [opId]: intent },
          }));
          try {
            try {
              await flushPersisted();
            } catch {
              set((state) => ({
                pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
              }));
              return { success: false, error: 'Failed to persist duplicate intent before uploading.' };
            }

            const stillValidBeforeUpload =
              !isStoreDisposed &&
              isAsyncOperationCurrent(operation) &&
              cloudSessionGeneration === capturedSessionGen &&
              isCloudSessionActive(get().cloudConfig) &&
              cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
            if (!stillValidBeforeUpload) {
              set((state) => ({
                pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
              }));
              return { success: false, operationId: opId, error: 'Session or scope changed.' };
            }

            try {
              set({ syncStatus: 'syncing', syncError: null });
              const receipt = await importDuplicateCollection(
                cloudConfig.apiUrl,
                cloudConfig.token,
                targetScope,
                sanitizedPayload,
                opId,
                cloudConfig.refreshToken,
                operation.controller.signal,
              );
              const stillSameOwner =
                !isStoreDisposed &&
                cloudSessionGeneration === capturedSessionGen &&
                cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
              if (!stillSameOwner) {
                return { success: false, operationId: opId, error: 'Session changed' };
              }
              return await finalizeCommittedCollectionReceipt(
                opId,
                receipt,
                targetScope,
                capturedSessionGen,
                currentOwnerKey,
                operation.controller.signal,
                () => !isStoreDisposed && isAsyncOperationCurrent(operation),
              );
            } catch (err: unknown) {
              const rejected = err instanceof CloudApiError && [400, 401, 403, 404, 409, 413, 415].includes(err.status);
              const errMsg = err instanceof Error ? err.message : 'Failed to upload duplicated collection';
              const stillSameOwner =
                !isStoreDisposed &&
                cloudSessionGeneration === capturedSessionGen &&
                cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
              if (stillSameOwner) {
                set((state) => ({
                  pendingDuplicateIntents: rejected
                    ? withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId)
                    : withReconcileRequiredIntent(state.pendingDuplicateIntents, opId, intent, errMsg),
                  syncStatus: 'error',
                  syncError: errMsg,
                }));
              }
              return {
                success: false,
                operationId: opId,
                reconcilePending: !rejected,
                error: errMsg,
              };
            }
          } finally {
            completeAsyncOperation(operation);
            clearDuplicateOperationInFlight(opId);
          }
        }

        // 2b. Cloud -> Cloud duplicate
        const activeScope = cloudConfig.activeScope;
        if (!activeScope) {
          return { success: false, error: 'No active cloud workspace selected.' };
        }
        if (activeScope.type === 'project' && targetScope.type === 'workspace') {
          return { success: false, error: 'Collections in projects cannot be duplicated to personal workspaces.' };
        }
        if (!canModifyCollection(sourceCol.minRole, activeScope, 'cloud', cloudConfig.user?.role)) {
          return { success: false, error: 'Write access to the source collection is required.' };
        }
        if (
          targetScope.type === 'project' &&
          !hasScopePermission(targetScope, 'collection:write', 'cloud', cloudConfig.user?.role)
        ) {
          return { success: false, error: 'Write permission in the target project is required.' };
        }
        if (activePullOperation && isAsyncOperationCurrent(activePullOperation)) {
          return { success: false, error: 'Wait for workspace sync to finish before duplicating.' };
        }
        if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
          return { success: false, error: 'Another move or duplicate operation is in progress for this collection.' };
        }

        const opId = existingIntent?.operationId || actionOptions?.operationId || crypto.randomUUID();
        if (inFlightDuplicateOperations.has(opId)) {
          return {
            success: false,
            operationId: opId,
            reconcilePending: true,
            error: 'Duplicate operation is already in progress.',
          };
        }
        const lock = Symbol('collection duplicate');
        duplicatingCollections.set(collectionId, lock);
        const operation = beginAsyncOperation();
        const capturedSessionGen = cloudSessionGeneration;
        const sourceScopeKey = getScopeCacheKey(activeScope);
        const targetScopeKey = getScopeCacheKey(targetScope);
        const intent: PendingDuplicateIntent = existingIntent || {
          operationId: opId,
          ownerKey: currentOwnerKey,
          kind: 'collection',
          sourceCollectionId: collectionId,
          sourceName: sourceCol.name,
          targetScope,
          createdAt: Date.now(),
          status: 'pending',
        };

        markDuplicateOperationInFlight(opId);
        try {
          await collectionSaveSyncQueues.get(`${activeScope.type}:${activeScope.id}:${collectionId}`);
          if (!isAsyncOperationCurrent(operation)) {
            return { success: false, error: 'Operation cancelled.' };
          }
          const latestCol = get().collections.find((c) => c.id === collectionId);
          if (!latestCol) {
            return { success: false, error: 'Source collection not found.' };
          }
          if (latestCol._syncStatus === 'pending' || latestCol._needsMoveReconciliation) {
            return { success: false, error: 'Sync pending changes in this collection before duplicating.' };
          }

          set((state) => ({
            pendingDuplicateIntents: { ...(state.pendingDuplicateIntents || {}), [opId]: intent },
          }));
          try {
            await flushPersisted();
          } catch {
            set((state) => ({
              pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
            }));
            return { success: false, error: 'Failed to persist duplicate intent.' };
          }

          if (
            !isAsyncOperationCurrent(operation) ||
            cloudSessionGeneration !== capturedSessionGen ||
            cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) !== currentOwnerKey
          ) {
            set((state) => ({
              pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
            }));
            return { success: false, operationId: opId, error: 'Session or scope changed.' };
          }

          set({ syncStatus: 'syncing', syncError: null });
          const receipt = await duplicateScopeCollection(
            cloudConfig.apiUrl,
            cloudConfig.token,
            collectionId,
            targetScope,
            opId,
            cloudConfig.refreshToken,
            operation.controller.signal,
          );
          if (
            !isAsyncOperationCurrent(operation) ||
            cloudSessionGeneration !== capturedSessionGen ||
            cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) !== currentOwnerKey
          ) {
            return { success: false, operationId: opId, error: 'Session or scope changed.' };
          }

          return await finalizeCommittedCollectionReceipt(
            opId,
            receipt,
            targetScope,
            capturedSessionGen,
            currentOwnerKey,
            operation.controller.signal,
            () => isAsyncOperationCurrent(operation),
          );
        } catch (err: unknown) {
          const rejected = err instanceof CloudApiError && [400, 401, 403, 404, 409, 413].includes(err.status);
          const errMsg = err instanceof Error ? err.message : 'Failed to duplicate collection';
          const stillCurrent =
            isAsyncOperationCurrent(operation) &&
            cloudSessionGeneration === capturedSessionGen &&
            cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
          if (stillCurrent) {
            set((state) => ({
              pendingDuplicateIntents: rejected
                ? withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId)
                : withReconcileRequiredIntent(state.pendingDuplicateIntents, opId, intent, errMsg),
              syncStatus: 'error',
              syncError: errMsg,
            }));
          }
          return {
            success: false,
            operationId: opId,
            reconcilePending: !rejected,
            error: errMsg,
          };
        } finally {
          completeAsyncOperation(operation);
          clearDuplicateOperationInFlight(opId);
          if (duplicatingCollections.get(collectionId) === lock) {
            duplicatingCollections.delete(collectionId);
          }
        }
      },

      duplicateCollectionItem: async (sourceCollectionId, itemId, targetCollectionId, targetParentId, actionOptions) => {
        const flushPersisted = async () => {
          await get().persistNativeCredentialState();
        };
        const findSavedItemInTree = (items: CollectionItem[]): CollectionItem | null => {
          for (const it of items) {
            if (it.id === itemId || (it.type === 'request' && it.request?.id === itemId)) {
              return it;
            }
            if (it.type === 'folder' && Array.isArray(it.items)) {
              const found = findSavedItemInTree(it.items);
              if (found) return found;
            }
          }
          return null;
        };
        const findFolderRevealPath = (items: CollectionItem[], targetId: string): string[] | null => {
          for (const it of items) {
            if (it.id === targetId) return [it.id];
            if (it.type === 'folder' && Array.isArray(it.items)) {
              const sub = findFolderRevealPath(it.items, targetId);
              if (sub) return [it.id, ...sub];
            }
          }
          return null;
        };

        const stateAtStart = get();
        const { workspaceMode, collections, cloudConfig, activeOfflineWorkspaceId } = stateAtStart;
        const existingIntent = actionOptions?.operationId
          ? stateAtStart.pendingDuplicateIntents?.[actionOptions.operationId]
          : undefined;
        const currentOwnerKey = cloudCacheOwnerKey(cloudConfig, normalizeCloudApiUrl);

        // Shared reconciliation once duplicateScopeItem commits on the server.
        // Post-commit GET failures must never turn a committed server mutation into a failure.
        const finalizeCommittedItemReceipt = async (
          opId: string,
          receipt: {
            root_item_id: string;
            target_collection_id: string;
            target_parent_id?: string | null;
            target_collection_version: number;
            name: string;
            status: string;
          },
          capturedSessionGen: number,
          ownerKey: string,
          operationSignal: AbortSignal,
          checkActiveOp: () => boolean,
        ): Promise<DuplicateActionResult> => {
          if (receipt.status === 'committed_deleted') {
            set((state) => ({
              pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
              syncStatus: 'idle',
            }));
            return {
              success: true,
              operationId: opId,
              createdItemId: receipt.root_item_id,
              targetCollectionId: receipt.target_collection_id,
              targetParentId: receipt.target_parent_id ?? null,
              name: receipt.name,
              deletedOnServer: true,
            };
          }

          let refreshedTargetCol: Collection | null = null;
          let rawMatchesActiveScope = true;
          let rawScopeKey: string | null = null;
          let detailsError: string | undefined;
          try {
            const rawTargetCol = await fetchCollectionByIdForRuntime(
              cloudConfig.apiUrl,
              cloudConfig.token,
              receipt.target_collection_id,
              cloudConfig.refreshToken,
              operationSignal,
            );
            const activeScopeNow = get().cloudConfig.activeScope;
            const activeScopeKeyNow =
              get().workspaceMode === 'cloud' && activeScopeNow ? getScopeCacheKey(activeScopeNow) : null;
            rawScopeKey = rawTargetCol?.workspace_id
              ? `workspace:${rawTargetCol.workspace_id}`
              : rawTargetCol?.project_id
                ? `project:${rawTargetCol.project_id}`
                : null;
            if (rawScopeKey && (!activeScopeKeyNow || rawScopeKey !== activeScopeKeyNow)) {
              rawMatchesActiveScope = false;
            } else {
              refreshedTargetCol = buildCollectionFromDetails(rawTargetCol);
            }
          } catch (err: unknown) {
            refreshedTargetCol = null;
            detailsError = err instanceof Error ? err.message : 'Failed to load target collection details.';
          }

          if (
            !checkActiveOp() ||
            cloudSessionGeneration !== capturedSessionGen ||
            cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) !== ownerKey
          ) {
            if (
              !isStoreDisposed &&
              cloudSessionGeneration === capturedSessionGen &&
              cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === ownerKey
            ) {
              set((state) => {
                const nextScopeCache = { ...(state.scopeCache || {}) };
                for (const [k, entry] of Object.entries(nextScopeCache)) {
                  if (k === rawScopeKey || entry?.collections?.some((c) => c.id === receipt.target_collection_id)) {
                    delete nextScopeCache[k];
                  }
                }
                return {
                  pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
                  scopeCache: nextScopeCache,
                  syncStatus: 'idle',
                };
              });
            }
            return { success: false, operationId: opId, error: 'Session or scope changed.' };
          }

          if (refreshedTargetCol && rawMatchesActiveScope) {
            const revealFromReq = findRequestAncestorIds([refreshedTargetCol], receipt.root_item_id);
            const revealIds = revealFromReq.length > 0
              ? revealFromReq
              : [
                  refreshedTargetCol.id,
                  ...(findFolderRevealPath(refreshedTargetCol.items || [], receipt.root_item_id) || []),
                ];

            set((state) => {
              const exists = state.collections.some((c) => c.id === refreshedTargetCol!.id);
              const nextCollections = exists
                ? state.collections.map((c) => (c.id === refreshedTargetCol!.id ? refreshedTargetCol! : c))
                : state.collections;
              return {
                pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
                collections: nextCollections,
                lastDuplicateReveal: {
                  pathIds: revealIds,
                  revision: (state.lastDuplicateReveal?.revision ?? 0) + 1,
                },
                syncStatus: 'idle',
              };
            });

            return {
              success: true,
              operationId: opId,
              createdItemId: receipt.root_item_id,
              targetCollectionId: receipt.target_collection_id,
              targetParentId: receipt.target_parent_id ?? null,
              name: receipt.name,
              revealPathIds: revealIds,
            };
          }

          // Server commit succeeded, but post-commit GET failed or collection belongs to an inactive scope.
          set((state) => {
            const nextScopeCache =
              !rawMatchesActiveScope && rawScopeKey && state.scopeCache?.[rawScopeKey]
                ? (() => {
                    const copy = { ...(state.scopeCache || {}) };
                    delete copy[rawScopeKey!];
                    return copy;
                  })()
                : state.scopeCache;
            return {
              pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
              scopeCache: nextScopeCache,
              collections:
                rawMatchesActiveScope && state.workspaceMode === 'cloud'
                  ? state.collections.map((c) =>
                      c.id === receipt.target_collection_id
                        ? {
                            ...c,
                            version: receipt.target_collection_version ?? c.version,
                            isPartial: true,
                            updatedAt: Date.now(),
                          }
                        : c,
                    )
                  : state.collections,
              syncStatus: 'idle',
            };
          });

          return {
            success: true,
            operationId: opId,
            createdItemId: receipt.root_item_id,
            targetCollectionId: receipt.target_collection_id,
            targetParentId: receipt.target_parent_id ?? null,
            name: receipt.name,
            ...(detailsError ? { detailsUnavailable: true, detailsError } : {}),
          };
        };

        // Replay path for persisted item duplicate intents even if source item/collection changed locally.
        if (existingIntent && existingIntent.kind === 'item') {
          if (isOfflineOnly || !isCloudSessionActive(cloudConfig) || !currentOwnerKey) {
            return { success: false, error: 'Sign in before duplicating cloud items.' };
          }
          if (existingIntent.ownerKey !== currentOwnerKey) {
            return { success: false, error: 'This pending duplicate belongs to a different cloud account.' };
          }
          if (activePullOperation && isAsyncOperationCurrent(activePullOperation)) {
            return { success: false, error: 'Wait for workspace sync to finish before duplicating items.' };
          }
          const replaySourceColId = existingIntent.sourceCollectionId;
          const replayTargetColId = existingIntent.targetCollectionId || targetCollectionId;
          const replayIds = [...new Set([replaySourceColId, replayTargetColId])];
          if (inFlightDuplicateOperations.has(existingIntent.operationId) || replayIds.some((id) => movingCollections.has(id) || duplicatingCollections.has(id))) {
            return { success: false, error: 'A move or duplicate operation is already in progress for this collection.' };
          }
          markDuplicateOperationInFlight(existingIntent.operationId);
          const lock = Symbol('item duplicate replay');
          replayIds.forEach((id) => duplicatingCollections.set(id, lock));
          const operation = beginAsyncOperation();
          const capturedSessionGen = cloudSessionGeneration;
          try {
            set({ syncStatus: 'syncing', syncError: null });
            const receipt = await duplicateScopeItem(
              cloudConfig.apiUrl,
              cloudConfig.token,
              existingIntent.sourceItemId || itemId,
              replaySourceColId,
              replayTargetColId,
              existingIntent.targetParentId ?? targetParentId,
              existingIntent.operationId,
              cloudConfig.refreshToken,
              operation.controller.signal,
            );
            if (
              !isAsyncOperationCurrent(operation) ||
              cloudSessionGeneration !== capturedSessionGen ||
              cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) !== currentOwnerKey
            ) {
              return { success: false, operationId: existingIntent.operationId, error: 'Session or scope changed.' };
            }
            return await finalizeCommittedItemReceipt(
              existingIntent.operationId,
              receipt,
              capturedSessionGen,
              currentOwnerKey,
              operation.controller.signal,
              () => isAsyncOperationCurrent(operation),
            );
          } catch (err: unknown) {
            const rejected = err instanceof CloudApiError && [400, 403, 404, 409, 413].includes(err.status);
            const errMsg = err instanceof Error ? err.message : 'Failed to duplicate item';
            const stillCurrent =
              isAsyncOperationCurrent(operation) &&
              cloudSessionGeneration === capturedSessionGen &&
              cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
            if (stillCurrent) {
              set((state) => ({
                pendingDuplicateIntents: rejected
                  ? withoutPendingDuplicateIntent(state.pendingDuplicateIntents, existingIntent.operationId)
                  : withReconcileRequiredIntent(
                      state.pendingDuplicateIntents,
                      existingIntent.operationId,
                      existingIntent,
                      errMsg,
                    ),
                syncStatus: 'error',
                syncError: errMsg,
              }));
            }
            return {
              success: false,
              operationId: existingIntent.operationId,
              reconcilePending: !rejected,
              error: errMsg,
            };
          } finally {
            completeAsyncOperation(operation);
            clearDuplicateOperationInFlight(existingIntent.operationId);
            replayIds.forEach((id) => {
              if (duplicatingCollections.get(id) === lock) duplicatingCollections.delete(id);
            });
          }
        }

        const sourceCol = collections.find((c) => c.id === sourceCollectionId);
        const targetCol = collections.find((c) => c.id === targetCollectionId);
        if (!sourceCol) return { success: false, error: 'Source collection not found.' };
        if (!targetCol) return { success: false, error: 'Target collection not found.' };
        if (sourceCol._needsMoveReconciliation || targetCol._needsMoveReconciliation) {
          return { success: false, error: 'Sync the workspace to confirm the previous move before duplicating.' };
        }
        if (sourceCol.isPartial || targetCol.isPartial) {
          return { success: false, error: 'Load collection details before duplicating.' };
        }
        if (!canModifyCollection(sourceCol.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          return { success: false, error: 'Write access to the source collection is required.' };
        }
        if (!canModifyCollection(targetCol.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          return { success: false, error: 'Write access to the target collection is required.' };
        }

        const savedItem = findSavedItemInTree(sourceCol.items || []);
        if (!savedItem) {
          return { success: false, error: 'Item not found in source collection.' };
        }

        const targetParentDepth = getTargetFolderDepth(targetCol.items || [], targetParentId);
        if (targetParentDepth === null) {
          return { success: false, error: 'Target folder not found in target collection.' };
        }

        // 1. Offline item duplicate
        if (workspaceMode !== 'cloud') {
          let clonedItem: CollectionItem;
          try {
            clonedItem = duplicateItemSubtree(savedItem, {
              sameCollection: sourceCollectionId === targetCollectionId,
              targetParentDepth,
            });
          } catch (err: unknown) {
            return { success: false, error: err instanceof Error ? err.message : 'Invalid item for duplication.' };
          }

          const nextTargetItems = insertItemIntoCollectionTree(targetCol.items || [], clonedItem, targetParentId);
          if (!nextTargetItems) {
            return { success: false, error: 'Target folder not found in target collection.' };
          }

          const capturedOfflineWsId = activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
          const prevReveal = get().lastDuplicateReveal;
          let appliedRevealRevision: number | null = null;
          const revealIds = [
            targetCollectionId,
            ...(targetParentId ? (findFolderRevealPath(nextTargetItems, targetParentId) || [targetParentId]) : []),
            ...(clonedItem.type === 'folder' ? [clonedItem.id] : []),
          ];

          set((state) => {
            appliedRevealRevision = (state.lastDuplicateReveal?.revision ?? 0) + 1;
            return {
              collections: state.collections.map((c) =>
                c.id === targetCollectionId
                  ? { ...c, items: nextTargetItems, updatedAt: Date.now() }
                  : c,
              ),
              lastDuplicateReveal: {
                pathIds: revealIds,
                revision: appliedRevealRevision,
              },
            };
          });

          try {
            await flushPersisted();
          } catch {
            set((state) => {
              const isTargetActive =
                state.workspaceMode === 'offline' &&
                (state.activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID) === capturedOfflineWsId;
              const stripClonedItem = (cols: Collection[]) =>
                cols.map((c) => {
                  if (c.id !== targetCollectionId) return c;
                  const { items, removed } = removeItemFromCollectionTree(c.items || [], clonedItem.id);
                  return removed ? { ...c, items } : c;
                });
              const prevCache = state.offlineScopeCache || {};
              const cachedTarget = prevCache[capturedOfflineWsId];
              const nextOfflineCache = cachedTarget
                ? {
                    ...prevCache,
                    [capturedOfflineWsId]: {
                      ...cachedTarget,
                      collections: stripClonedItem(cachedTarget.collections || []),
                    },
                  }
                : prevCache;
              const nextReveal =
                appliedRevealRevision !== null && state.lastDuplicateReveal?.revision === appliedRevealRevision
                  ? prevReveal
                  : state.lastDuplicateReveal;
              return {
                ...(isTargetActive ? { collections: stripClonedItem(state.collections) } : {}),
                offlineScopeCache: nextOfflineCache,
                lastDuplicateReveal: nextReveal,
              };
            });
            return { success: false, error: 'Failed to persist duplicated item to local storage.' };
          }

          return {
            success: true,
            createdItemId: clonedItem.id,
            targetCollectionId,
            targetParentId,
            name: clonedItem.name,
            revealPathIds: revealIds,
          };
        }

        // 2. Cloud item duplicate (run client validation first so invalid names/depth fail fast without network)
        try {
          duplicateItemSubtree(savedItem, {
            sameCollection: sourceCollectionId === targetCollectionId,
            targetParentDepth,
          });
        } catch (err: unknown) {
          return { success: false, error: err instanceof Error ? err.message : 'Invalid item for duplication.' };
        }

        const scope = cloudConfig.activeScope;
        if (isOfflineOnly || !isCloudSessionActive(cloudConfig) || !scope || !currentOwnerKey) {
          return { success: false, error: 'Sign in before duplicating cloud items.' };
        }
        if (activePullOperation && isAsyncOperationCurrent(activePullOperation)) {
          return { success: false, error: 'Wait for workspace sync to finish before duplicating items.' };
        }

        const ids = [...new Set([sourceCollectionId, targetCollectionId])];
        if (ids.some((id) => movingCollections.has(id) || duplicatingCollections.has(id))) {
          return { success: false, error: 'A move or duplicate operation is already in progress for this collection.' };
        }

        const opId = actionOptions?.operationId || crypto.randomUUID();
        if (inFlightDuplicateOperations.has(opId)) {
          return {
            success: false,
            operationId: opId,
            reconcilePending: true,
            error: 'Duplicate operation is already in progress.',
          };
        }

        const lock = Symbol('item duplicate');
        ids.forEach((id) => duplicatingCollections.set(id, lock));
        const operation = beginAsyncOperation();
        const capturedSessionGen = cloudSessionGeneration;
        const intent: PendingDuplicateIntent = {
          operationId: opId,
          ownerKey: currentOwnerKey,
          kind: 'item',
          sourceCollectionId,
          sourceItemId: savedItem.id,
          sourceName: savedItem.name,
          sourceItemType: savedItem.type,
          targetCollectionId,
          targetCollectionName: targetCol.name,
          targetParentId,
          createdAt: Date.now(),
          status: 'pending',
        };

        markDuplicateOperationInFlight(opId);
        try {
          await Promise.all(ids.map((id) => collectionSaveSyncQueues.get(`${scope.type}:${scope.id}:${id}`)));
          if (!isAsyncOperationCurrent(operation)) {
            return { success: false, error: 'Operation cancelled.' };
          }
          if (get().collections.some((col) => ids.includes(col.id) && (col._syncStatus === 'pending' || col._needsMoveReconciliation))) {
            return { success: false, error: 'Sync pending changes in both collections before duplicating.' };
          }

          set((state) => ({
            pendingDuplicateIntents: { ...(state.pendingDuplicateIntents || {}), [opId]: intent },
          }));
          try {
            await flushPersisted();
          } catch {
            set((state) => ({
              pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
            }));
            return { success: false, error: 'Failed to persist duplicate intent.' };
          }

          if (
            !isAsyncOperationCurrent(operation) ||
            cloudSessionGeneration !== capturedSessionGen ||
            cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) !== currentOwnerKey
          ) {
            set((state) => ({
              pendingDuplicateIntents: withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId),
            }));
            return { success: false, operationId: opId, error: 'Session or scope changed.' };
          }

          const receipt = await duplicateScopeItem(
            cloudConfig.apiUrl,
            cloudConfig.token,
            savedItem.id,
            sourceCollectionId,
            targetCollectionId,
            targetParentId,
            opId,
            cloudConfig.refreshToken,
            operation.controller.signal,
          );
          if (
            !isAsyncOperationCurrent(operation) ||
            cloudSessionGeneration !== capturedSessionGen ||
            cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) !== currentOwnerKey
          ) {
            return { success: false, operationId: opId, error: 'Session or scope changed.' };
          }

          return await finalizeCommittedItemReceipt(
            opId,
            receipt,
            capturedSessionGen,
            currentOwnerKey,
            operation.controller.signal,
            () => isAsyncOperationCurrent(operation),
          );
        } catch (err: unknown) {
          const rejected = err instanceof CloudApiError && [400, 401, 403, 404, 409, 413].includes(err.status);
          const errMsg = err instanceof Error ? err.message : 'Failed to duplicate item';
          const stillCurrent =
            isAsyncOperationCurrent(operation) &&
            cloudSessionGeneration === capturedSessionGen &&
            cloudCacheOwnerKey(get().cloudConfig, normalizeCloudApiUrl) === currentOwnerKey;
          if (stillCurrent) {
            set((state) => ({
              pendingDuplicateIntents: rejected
                ? withoutPendingDuplicateIntent(state.pendingDuplicateIntents, opId)
                : withReconcileRequiredIntent(state.pendingDuplicateIntents, opId, intent, errMsg),
              syncStatus: 'error',
              syncError: errMsg,
            }));
          }
          return {
            success: false,
            operationId: opId,
            reconcilePending: !rejected,
            error: errMsg,
          };
        } finally {
          completeAsyncOperation(operation);
          clearDuplicateOperationInFlight(opId);
          ids.forEach((id) => {
            if (duplicatingCollections.get(id) === lock) duplicatingCollections.delete(id);
          });
        }
      },

      openRequestInTab: (request, initialResponse) => {
        set((state) => {
          const targetId = request.id;
          const existingTab = targetId
            ? state.tabs.find((t) => t.id === targetId)
            : undefined;

          if (existingTab) {
            const restoredResponse = state.tabResponses?.[existingTab.id] || initialResponse || null;
            const nextTabResponses = initialResponse && !state.tabResponses?.[existingTab.id]
              ? { ...(state.tabResponses || {}), [existingTab.id]: initialResponse }
              : state.tabResponses;
            return {
              activeTabId: existingTab.id,
              activeResponse: restoredResponse,
              selectedExample: null,
              tabResponses: nextTabResponses,
              tabRevealRevision: state.tabRevealRevision + 1,
              canUndoActiveRequest: (tabUndoHistory[existingTab.id]?.past?.length ?? 0) > 0,
              canRedoActiveRequest: (tabUndoHistory[existingTab.id]?.future?.length ?? 0) > 0,
            };
          }

          const newTab: ApiRequest = {
            ...cloneRequestPreservingAttachments(request),
            id: targetId || generateId(),
          };

          const nextTabResponses = initialResponse
            ? { ...(state.tabResponses || {}), [newTab.id]: initialResponse }
            : state.tabResponses;

          return {
            tabs: [...state.tabs, newTab],
            activeTabId: newTab.id,
            activeResponse: initialResponse || null,
            selectedExample: null,
            tabOrder: [...syncVisualTabOrder(state.tabs, state.openExampleTabs, state.tabOrder), newTab.id],
            tabResponses: nextTabResponses,
            tabRevealRevision: state.tabRevealRevision + 1,
            canUndoActiveRequest: false,
            canRedoActiveRequest: false,
          };
        });
      },

      clearHistory: () => {
        set((s) => {
          const activeScopeKey = s.workspaceMode === 'cloud' && s.cloudConfig.activeScope
            ? getScopeCacheKey(s.cloudConfig.activeScope)
            : null;
          const otherCloudHistories = Object.entries(s.scopeCache || {})
            .filter(([key]) => key !== activeScopeKey)
            .map(([, entry]) => entry.history);
          const otherOfflineHistories = Object.entries(s.offlineScopeCache || {})
            .filter(([key]) => !(s.workspaceMode === 'offline' && key === s.activeOfflineWorkspaceId))
            .map(([, entry]) => entry.history);
          revokeUnreferencedResponses(
            s.history.map((entry) => entry.response),
            [s.activeResponse, ...Object.values(s.tabResponses || {})],
            [...otherCloudHistories, ...otherOfflineHistories]
          );
          if (s.workspaceMode === 'offline') {
            return { history: [] };
          }
          const activeScope = s.cloudConfig.activeScope;
          let updatedScopeCache = s.scopeCache;
          if (activeScope) {
            const scopeKey = getScopeCacheKey(activeScope);
            const entry = (s.scopeCache || {})[scopeKey];
            if (entry) {
              updatedScopeCache = {
                ...(s.scopeCache || {}),
                [scopeKey]: {
                  ...entry,
                  history: [],
                },
              };
            }
          }
          return {
            history: [],
            scopeCache: updatedScopeCache,
          };
        });
      },

      deleteHistoryItem: (id) => {
        set((state) => {
          const deleted = state.history.find((item) => item.id === id);
          const newHistory = state.history.filter((h) => h.id !== id);
          const activeScopeKey = state.workspaceMode === 'cloud' && state.cloudConfig.activeScope
            ? getScopeCacheKey(state.cloudConfig.activeScope)
            : null;
          const otherCloudHistories = Object.entries(state.scopeCache || {})
            .filter(([key]) => key !== activeScopeKey)
            .map(([, entry]) => entry.history);
          const otherOfflineHistories = Object.entries(state.offlineScopeCache || {})
            .filter(([key]) => !(state.workspaceMode === 'offline' && key === state.activeOfflineWorkspaceId))
            .map(([, entry]) => entry.history);
          revokeUnreferencedResponses(
            [deleted?.response],
            [state.activeResponse, ...Object.values(state.tabResponses || {})],
            [newHistory, ...otherCloudHistories, ...otherOfflineHistories]
          );
          if (state.workspaceMode === 'offline') {
            return {
              history: newHistory,
            };
          }
          const activeScope = state.cloudConfig.activeScope;
          let updatedScopeCache = state.scopeCache;
          if (activeScope) {
            const scopeKey = getScopeCacheKey(activeScope);
            const entry = (state.scopeCache || {})[scopeKey];
            if (entry) {
              updatedScopeCache = {
                ...(state.scopeCache || {}),
                [scopeKey]: {
                  ...entry,
                  history: newHistory,
                },
              };
            }
          }
          return {
            history: newHistory,
            scopeCache: updatedScopeCache,
          };
        });
      },
    };
  },
  {
      name: 'air-rest-storage',
      storage: createJSONStorage(() => ({
        getItem: (name) => customStorage.getItem(name),
        setItem: async (name, value) => {
          if (initialHydrationPending) {
            return;
          }
          try {
            await customStorage.setItem(name, value);
          } catch {
            // Background Zustand writes swallow unhandled rejections; explicit operations await persistNativeCredentialState().
          }
        },
        removeItem: (name) => customStorage.removeItem(name),
      })),
      partialize: (state) => {
        const providerSession = state.cloudConfig.sessionKind === 'provider';
        const nativeScope = getNativeCredentialScope(state.cloudConfig);
        const preserveLegacyCredentials = state.nativeCredentialState?.phase === 'legacy-pending' &&
          sameNativeCredentialScope(state.nativeCredentialState.scope, nativeScope);
        const hideProviderView = providerSession && state.workspaceMode === 'cloud';
        const providerOwner = cloudCacheOwnerKey(state.cloudConfig, normalizeCloudApiUrl);
        const archives = providerSession
          ? archiveCloudCache(
            state.cloudCacheArchives,
            state.cloudCacheOwner === providerOwner ? providerOwner : null,
            captureCloudCache({
              config: state.cloudConfig,
              workspaceMode: state.workspaceMode,
              scopeCache: state.scopeCache || {},
              scopesCache: state.scopesCache,
              resources: state,
              lastSyncedAt: state.lastSyncedAt,
            }),
          )
          : state.cloudCacheArchives;
        const persistedTabs = state.tabs.map(serializeRequestAttachments);
        const persistedCollections = state.collections.map(serializeCollectionAttachments);
        const persistedHistory = serializeHistoryAttachments(state.history);
        const { offlineScopeCache, scopeCache } = preparePersistedWorkspaceCaches({
          workspaceMode: state.workspaceMode,
          activeOfflineWorkspaceId: state.activeOfflineWorkspaceId,
          activeCloudScope: state.cloudConfig.activeScope,
          lastSyncedAt: state.lastSyncedAt,
          resources: {
            collections: state.collections,
            environments: state.environments,
            activeEnvironmentId: state.activeEnvironmentId,
            tabs: state.tabs,
            activeTabId: state.activeTabId,
            history: state.history,
          },
          offlineScopeCache: state.offlineScopeCache || {},
          scopeCache: state.scopeCache || {},
          serializeRequest: serializeRequestAttachments,
          serializeCollection: serializeCollectionAttachments,
          serializeHistory: serializeHistoryAttachments,
        });
        return {
          tabs: hideProviderView ? [] : persistedTabs,
          activeTabId: hideProviderView ? '' : state.activeTabId,
          collections: hideProviderView ? [] : persistedCollections,
          history: hideProviderView ? [] : persistedHistory,
          environments: hideProviderView ? [] : state.environments,
          activeEnvironmentId: hideProviderView ? null : state.activeEnvironmentId,
          offlineWorkspaces: state.offlineWorkspaces,
          activeOfflineWorkspaceId: state.activeOfflineWorkspaceId,
          offlineScopeCache,
          scopeCache: providerSession ? {} : scopeCache,
          cloudCacheOwner: providerSession ? null : state.cloudCacheOwner,
          cloudCacheArchives: serializeCloudCacheArchives(archives, {
            serializeRequest: serializeRequestAttachments,
            serializeCollection: serializeCollectionAttachments,
            serializeHistory: serializeHistoryAttachments,
          }),
          scopesCache: providerSession ? undefined : state.scopesCache,
          workspaceMode: isOfflineOnly ? 'offline' : !allowsOfflineWorkspace ? 'cloud' : state.workspaceMode,
          hasConfiguredMode: isOfflineOnly || !allowsOfflineWorkspace ? true : state.hasConfiguredMode,
          cloudConfig: providerSession
            ? { apiUrl: state.cloudConfig.apiUrl, hubUrl: state.cloudConfig.hubUrl }
            : persistCloudCredentials || preserveLegacyCredentials
              ? state.cloudConfig
              : {
                ...state.cloudConfig,
                token: undefined,
                refreshToken: undefined,
                tokenExpiresAt: undefined,
              },
          nativeCredentialState: state.nativeCredentialState,
          nativeCredentialCleanupPending: state.nativeCredentialCleanupPending ? true : undefined,
          pendingExampleIntents: state.pendingExampleIntents || {},
          pendingDuplicateIntents: state.pendingDuplicateIntents || {},
          theme: state.theme ?? 'system',
        };
      },
      onRehydrateStorage: () => {
        if (!hasCompletedInitialHydration) {
          initialHydrationPending = true;
        }
        return (state) => {
        hasCompletedInitialHydration = true;
        initialHydrationPending = false;
        if (!state) return;

        if (!state.theme) {
          state.theme = 'system';
        }
        applyTheme(state.theme);

        state.tabs = (state.tabs || []).map(normalizePersistedRequestAttachments);
        state.collections = ensureUniqueCollectionItemIds((state.collections || []).map(normalizeCollectionAttachments));
        state.history = normalizeHistoryAttachments(state.history || []);
        const cacheNormalizers = {
          normalizeRequest: normalizePersistedRequestAttachments,
          normalizeCollections: (collections: Collection[]) => ensureUniqueCollectionItemIds(
            collections.map(normalizeCollectionAttachments),
          ),
          normalizeHistory: normalizeHistoryAttachments,
        };
        state.offlineScopeCache = normalizePersistedWorkspaceScopeCache(state.offlineScopeCache, cacheNormalizers);
        state.scopeCache = normalizePersistedWorkspaceScopeCache(state.scopeCache, cacheNormalizers);
        state.cloudCacheArchives = normalizeCloudCacheArchives(state.cloudCacheArchives, cacheNormalizers);

        const legacyScope = credentialStorage ? getNativeCredentialScope(state.cloudConfig) : null;
        if (credentialStorage && state.nativeCredentialState?.phase === 'cleanup-pending') {
          state.nativeCredentialCleanupPending = true;
        }
        if (credentialStorage && !state.nativeCredentialState && legacyScope) {
          state.nativeCredentialState = {
            version: 1,
            scope: legacyScope,
            phase: state.cloudConfig.token
              ? 'legacy-pending'
              : state.nativeCredentialCleanupPending
                ? 'cleanup-pending'
                : 'ready',
          };
        } else if (
          credentialStorage &&
          state.nativeCredentialCleanupPending &&
          state.nativeCredentialState?.phase === 'ready'
        ) {
          state.nativeCredentialState = {
            ...state.nativeCredentialState,
            phase: 'cleanup-pending',
          };
        }

        // Older or externally written storage may contain a provider-session
        // marker. Treat it as unverified and retain its data only as an archive.
        if (state.cloudConfig?.sessionKind === 'provider') {
          const owner = cloudCacheOwnerKey(state.cloudConfig, normalizeCloudApiUrl);
          state.cloudCacheArchives = archiveCloudCache(
            state.cloudCacheArchives,
            state.cloudCacheOwner === owner ? owner : null,
            captureCloudCache({
              config: state.cloudConfig,
              workspaceMode: state.workspaceMode,
              scopeCache: state.scopeCache || {},
              scopesCache: state.scopesCache,
              resources: state,
              lastSyncedAt: state.lastSyncedAt,
            }),
          );
          if (state.workspaceMode === 'cloud') {
            Object.assign(state, restoreWorkspaceResources(undefined, createInitialTab), { lastSyncedAt: null });
          }
          state.cloudConfig = { apiUrl: state.cloudConfig.apiUrl, hubUrl: state.cloudConfig.hubUrl };
          state.cloudCacheOwner = null;
          state.scopeCache = {};
          state.scopesCache = undefined;
        } else {
          const nativeScope = getNativeCredentialScope(state.cloudConfig);
          const nativeIdentityIsCurrent = credentialStorage &&
            sameNativeCredentialScope(state.nativeCredentialState?.scope, nativeScope);
          const owner = (isCloudSessionActive(state.cloudConfig) || nativeIdentityIsCurrent)
            ? cloudCacheOwnerKey(state.cloudConfig, normalizeCloudApiUrl) : null;
          const hasUnownedData = Object.keys(state.scopeCache || {}).length > 0 || Boolean(state.scopesCache) ||
            (state.workspaceMode === 'cloud' && Boolean(state.cloudConfig.activeScope?.id ||
              state.collections.length || state.environments.length || state.history.length));
          if (hasUnownedData && (!owner || state.cloudCacheOwner !== owner)) {
            state.cloudCacheArchives = archiveCloudCache(
              state.cloudCacheArchives,
              null,
              captureCloudCache({
                config: state.cloudConfig,
                workspaceMode: state.workspaceMode,
                scopeCache: state.scopeCache || {},
                scopesCache: state.scopesCache,
                resources: state,
                lastSyncedAt: state.lastSyncedAt,
              }),
            );
            if (state.workspaceMode === 'cloud') {
              Object.assign(state, restoreWorkspaceResources(undefined, createInitialTab), { lastSyncedAt: null });
            }
            state.cloudConfig = { apiUrl: state.cloudConfig.apiUrl, hubUrl: state.cloudConfig.hubUrl };
            state.cloudCacheOwner = null;
            state.scopeCache = {};
            state.scopesCache = undefined;
          }
        }

        const hasRecoverableCloudIdentity = Boolean(
          isCloudSessionActive(state.cloudConfig) ||
            (credentialStorage &&
              sameNativeCredentialScope(
                state.nativeCredentialState?.scope,
                getNativeCredentialScope(state.cloudConfig)
              ))
        );

        if (
          state.workspaceMode === 'cloud' &&
          (isOfflineOnly || (allowsOfflineWorkspace && !hasRecoverableCloudIdentity))
        ) {
          const localId = state.activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
          const local = restoreWorkspaceResources(state.offlineScopeCache?.[localId], createInitialTab);
          Object.assign(state, local, {
            workspaceMode: 'offline',
            ...(isOfflineOnly ? { hasConfiguredMode: true } : {}),
            lastSyncedAt: null,
          });
        }

        // A cloud-only product must never reopen the active offline workspace.
        // Preserve the offline cache for other product profiles while clearing its live view.
        if (!allowsOfflineWorkspace && state.workspaceMode === 'offline') {
          const blank = restoreWorkspaceResources(undefined, createInitialTab);
          Object.assign(state, blank, { workspaceMode: 'cloud', hasConfiguredMode: true, lastSyncedAt: null });
        }

        if (state.cloudConfig?.apiUrl) {
          state.cloudConfig.apiUrl = normalizeCloudApiUrl(state.cloudConfig.apiUrl);
        }

        const persistedOfflineId = state.activeOfflineWorkspaceId;

        // 1. Ensure offlineWorkspaces has at least the default workspace
        if (!state.offlineWorkspaces || state.offlineWorkspaces.length === 0) {
          state.offlineWorkspaces = [defaultOfflineWorkspace];
          state.activeOfflineWorkspaceId = DEFAULT_OFFLINE_WORKSPACE_ID;
        }

        // 2. Ensure activeOfflineWorkspaceId is valid
        if (
          !state.activeOfflineWorkspaceId ||
          !state.offlineWorkspaces.some((w) => w.id === state.activeOfflineWorkspaceId)
        ) {
          state.activeOfflineWorkspaceId = state.offlineWorkspaces[0].id;
        }

        // 3. Ensure offlineScopeCache exists
        if (!state.offlineScopeCache) {
          state.offlineScopeCache = {};
        }

        const activeLocalId = state.activeOfflineWorkspaceId;
        if (
          persistedOfflineId &&
          persistedOfflineId !== activeLocalId &&
          state.offlineScopeCache[persistedOfflineId]
        ) {
          const existingTarget = state.offlineScopeCache[activeLocalId];
          const targetIsEmpty =
            !existingTarget ||
            (((existingTarget.collections || []).length === 0) &&
              ((existingTarget.environments || []).length === 0));
          if (targetIsEmpty) {
            state.offlineScopeCache[activeLocalId] = state.offlineScopeCache[persistedOfflineId];
          }
        }

        if (!state.offlineScopeCache[activeLocalId]) {
          state.offlineScopeCache[activeLocalId] = {
            collections: state.workspaceMode === 'offline' ? state.collections : [],
            environments: state.workspaceMode === 'offline' ? state.environments : [],
            activeEnvironmentId: state.workspaceMode === 'offline' ? state.activeEnvironmentId : null,
            tabs: (state.workspaceMode === 'offline' && state.tabs && state.tabs.length > 0)
              ? state.tabs
              : [createInitialTab()],
            activeTabId: state.workspaceMode === 'offline' ? state.activeTabId : undefined,
            history: state.workspaceMode === 'offline' ? state.history : [],
          };
        }

        // 4. If currently in offline mode, ensure state aligns with the active offline workspace
        if (state.workspaceMode === 'offline') {
          const currentEntry = state.offlineScopeCache[activeLocalId];
          if (currentEntry) {
            if (
              (currentEntry.collections || []).length === 0 &&
              persistedOfflineId !== activeLocalId &&
              (state.collections || []).length > 0
            ) {
              currentEntry.collections = state.collections;
            }
            if (
              (currentEntry.environments || []).length === 0 &&
              persistedOfflineId !== activeLocalId &&
              (state.environments || []).length > 0
            ) {
              currentEntry.environments = state.environments;
              currentEntry.activeEnvironmentId = state.activeEnvironmentId || null;
            }
            state.collections = currentEntry.collections || [];
            state.environments = currentEntry.environments || [];
            state.activeEnvironmentId = currentEntry.activeEnvironmentId || null;
            if (currentEntry.tabs && currentEntry.tabs.length > 0) {
              state.tabs = currentEntry.tabs;
              state.activeTabId = currentEntry.activeTabId && state.tabs.some((t) => t.id === currentEntry.activeTabId)
                ? currentEntry.activeTabId
                : state.tabs[0].id;
            }
            state.history = currentEntry.history || [];
          }
        }

        // 5. Ensure valid tab state and activeTabId alignment
        if (!state.tabs || !Array.isArray(state.tabs)) {
          state.tabs = [];
          state.activeTabId = '';
        } else if (state.tabs.length > 0 && (!state.activeTabId || !state.tabs.some((t) => t.id === state.activeTabId))) {
          state.activeTabId = state.tabs[0].id;
        } else if (state.tabs.length === 0) {
          state.activeTabId = '';
        }
        state.openExampleTabs = [];
        state.selectedExample = null;
        state.tabOrder = state.tabs.map((t) => t.id);
        };
      },
    }
  )
);

  const originalSetState = store.setState;
  Object.defineProperty(store, 'productPolicy', { value: productPolicy, enumerable: false });
  store.setState = ((fnOrState: any, replace?: any) => {
    if (isStoreDisposed) return;
    return originalSetState(fnOrState, replace);
  }) as typeof store.setState;

  (store as ApiStore).dispose = () => {
    const snapshot = store.getState();
    const { blobUrls, rawBodyIds } = collectProtectedResponseHandles(
      [snapshot.activeResponse, ...Object.values(snapshot.tabResponses || {})],
      [
        snapshot.history,
        ...Object.values(snapshot.scopeCache || {}).map((e) => e.history),
        ...Object.values(snapshot.offlineScopeCache || {}).map((e) => e.history),
      ]
    );
    revokeBlobUrls(blobUrls);
    safeReleaseRawBodies(rawBodyIds);

    isStoreDisposed = true;
    for (const key of Object.keys(undoTypingTimers)) {
      clearTimeout(undoTypingTimers[key]);
      delete undoTypingTimers[key];
    }
    for (const key of Object.keys(tabUndoHistory)) {
      delete tabUndoHistory[key];
    }
    invalidateAsyncOperations({ session: true });
  };

  async function flushStorePersistence() {
    const options = store.persist?.getOptions?.();
    if (!options?.name) return;
    const partialize = options.partialize;
    const persistedState = partialize ? partialize(store.getState()) : store.getState();
    const serialized = JSON.stringify({ state: persistedState, version: options.version ?? 0 });
    await customStorage.setItem(options.name, serialized);
  }

  return store as ApiStore;
}

let _activeRuntimeStore: ApiStore | null = null;
let _defaultApiStoreInstance: ApiStore | null = null;

export function setActiveRuntimeStore(store: ApiStore | null): void {
  _activeRuntimeStore = store;
}

export function getActiveRuntimeStore(): ApiStore | null {
  return _activeRuntimeStore;
}

export function getDefaultApiStore(): ApiStore {
  if (!_defaultApiStoreInstance) {
    _defaultApiStoreInstance = createApiStore();
  }
  return _defaultApiStoreInstance;
}

function resolveCurrentStore(contextStore?: ApiStore | null): ApiStore {
  return contextStore || _activeRuntimeStore || _defaultApiStoreInstance || getDefaultApiStore();
}

export const defaultApiStore: ApiStore = new Proxy({} as ApiStore, {
  get(_target, prop, receiver) {
    const store = resolveCurrentStore();
    const val = Reflect.get(store, prop, receiver);
    if (typeof val === 'function') {
      return val.bind(store);
    }
    return val;
  },
  apply(_target, thisArg, argArray) {
    const store = resolveCurrentStore();
    return Reflect.apply(store as any, thisArg, argArray);
  },
});

export const useApiStore = ((...args: [any?, any?]) => {
  const contextStore = useContext(StoreContext);
  const store = resolveCurrentStore(contextStore);
  return (store as any)(...args);
}) as ApiStore;

const storeMethods = ['getState', 'setState', 'subscribe', 'destroy'] as const;
for (const method of storeMethods) {
  (useApiStore as any)[method] = (...args: any[]) => {
    const store = resolveCurrentStore();
    return (store as any)[method](...args);
  };
}
(useApiStore as any).dispose = () => {
  const store = resolveCurrentStore();
  return store.dispose?.();
};
Object.defineProperty(useApiStore, 'persist', {
  get: () => resolveCurrentStore().persist,
  configurable: true,
});
