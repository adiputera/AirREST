import type {
  ApiRequest,
  Collection,
  CollectionItem,
  FunctionalRunnerConfig,
  OpenPerformanceTab,
  PerformanceDataFileMeta,
  PerformanceRequestDescriptor,
  RunnerMode,
} from '../types/api';
import {
  computeDefaultPerformanceTimeoutMs,
  createDefaultLoadProfileConfig,
  getDurationSeconds,
  getPlatformPerformanceLimits,
} from './loadProfileMath';
import { flattenCollectionRequests } from './requestDiff';

export function createDefaultFunctionalRunnerConfig(): FunctionalRunnerConfig {
  return {
    iterations: 1,
    delayMs: 0,
    persistResponses: true,
    keepVariableValues: false,
    failOnHttpError: false,
    stopOnError: 'never',
    requestTimeoutMs: 60_000,
    followRedirects: true,
    ignoreSslErrors: false,
  };
}

export function reorderRunnerItems(
  items: PerformanceRequestDescriptor[],
  activeId: string,
  targetId: string,
  position: 'before' | 'after'
): PerformanceRequestDescriptor[] {
  if (!activeId || !targetId || activeId === targetId) return items;
  const fromIdx = items.findIndex((it) => it.id === activeId);
  const toIdx = items.findIndex((it) => it.id === targetId);
  if (fromIdx < 0 || toIdx < 0) return items;

  const next = [...items];
  const [moved] = next.splice(fromIdx, 1);
  const adjustedTargetIdx = next.findIndex((it) => it.id === targetId);
  if (adjustedTargetIdx < 0) return items;
  const insertAt = position === 'after' ? adjustedTargetIdx + 1 : adjustedTargetIdx;
  next.splice(insertAt, 0, moved);
  return next;
}

export function buildPerformanceItemsFromCollection(items: CollectionItem[]): PerformanceRequestDescriptor[] {
  return flattenCollectionRequests(items).map((entry) => ({
    id: entry.id,
    itemId: entry.id,
    name: entry.name,
    method: entry.request.method,
    path: entry.path,
    request: entry.request,
    selected: true,
  }));
}

export function buildCollectionPerformanceLaunchConfig(
  collection: Collection,
  platformId?: 'extension' | 'desktop' | 'android' | 'web',
  runnerMode: RunnerMode = 'performance'
): Omit<OpenPerformanceTab, 'id' | 'createdAt' | 'viewMode'> {
  const limits = getPlatformPerformanceLimits(platformId);
  const loadProfile = createDefaultLoadProfileConfig(limits.maxVUs);
  const defaultTimeoutMs = computeDefaultPerformanceTimeoutMs(getDurationSeconds(loadProfile));
  return {
    title: runnerMode === 'functional' ? `${collection.name} — Runner` : `${collection.name} — Performance`,
    runnerMode,
    sourceType: 'collection',
    sourceId: collection.id,
    collectionId: collection.id,
    items: buildPerformanceItemsFromCollection(collection.items || []),
    executionMode: 'sequential',
    setupItemIds: [],
    runInLoopScripts: false,
    loadProfile,
    network: {
      requestTimeoutMs: defaultTimeoutMs,
      requestTimeoutAuto: true,
      followRedirects: true,
      ignoreSslErrors: false,
    },
    functionalConfig: createDefaultFunctionalRunnerConfig(),
  };
}

export function buildFolderPerformanceLaunchConfig(
  collectionId: string,
  folder: CollectionItem,
  platformId?: 'extension' | 'desktop' | 'android' | 'web',
  runnerMode: RunnerMode = 'performance'
): Omit<OpenPerformanceTab, 'id' | 'createdAt' | 'viewMode'> {
  const limits = getPlatformPerformanceLimits(platformId);
  const loadProfile = createDefaultLoadProfileConfig(limits.maxVUs);
  const defaultTimeoutMs = computeDefaultPerformanceTimeoutMs(getDurationSeconds(loadProfile));
  return {
    title: runnerMode === 'functional' ? `${folder.name} — Runner` : `${folder.name} — Performance`,
    runnerMode,
    sourceType: 'folder',
    sourceId: folder.id,
    collectionId,
    items: buildPerformanceItemsFromCollection(folder.items || []),
    executionMode: 'sequential',
    setupItemIds: [],
    runInLoopScripts: false,
    loadProfile,
    network: {
      requestTimeoutMs: defaultTimeoutMs,
      requestTimeoutAuto: true,
      followRedirects: true,
      ignoreSslErrors: false,
    },
    functionalConfig: createDefaultFunctionalRunnerConfig(),
  };
}

export function buildSingleRequestPerformanceLaunchConfig(
  request: ApiRequest,
  collectionId?: string,
  platformId?: 'extension' | 'desktop' | 'android' | 'web',
  runnerMode: RunnerMode = 'performance'
): Omit<OpenPerformanceTab, 'id' | 'createdAt' | 'viewMode'> {
  const limits = getPlatformPerformanceLimits(platformId);
  const loadProfile = createDefaultLoadProfileConfig(limits.maxVUs);
  const defaultTimeoutMs = computeDefaultPerformanceTimeoutMs(getDurationSeconds(loadProfile));
  const label = request.name?.trim() || request.url?.trim() || 'Untitled Request';
  return {
    title: runnerMode === 'functional' ? `${label} — Runner` : `${label} — Performance`,
    runnerMode,
    sourceType: 'request',
    sourceId: request.id,
    collectionId,
    items: [
      {
        id: request.id,
        itemId: request.id,
        name: label,
        method: request.method,
        path: request.url || label,
        request: { ...request },
        selected: true,
      },
    ],
    executionMode: 'sequential',
    setupItemIds: [],
    runInLoopScripts: false,
    loadProfile,
    network: {
      requestTimeoutMs: defaultTimeoutMs,
      requestTimeoutAuto: true,
      followRedirects: true,
      ignoreSslErrors: false,
    },
    functionalConfig: createDefaultFunctionalRunnerConfig(),
  };
}

function findFolderInTree(items: CollectionItem[], folderId: string): CollectionItem | null {
  for (const item of items || []) {
    if (item.type === 'folder' && item.id === folderId) return item;
    if (item.items?.length) {
      const found = findFolderInTree(item.items, folderId);
      if (found) return found;
    }
  }
  return null;
}

function findRequestItemInTree(
  items: CollectionItem[],
  targetId: string
): { item: CollectionItem; path: string } | null {
  const flat = flattenCollectionRequests(items || []);
  const match = flat.find((e) => e.id === targetId || e.request.id === targetId);
  if (!match) return null;
  return {
    item: {
      id: match.id,
      name: match.name,
      type: 'request',
      request: match.request,
    },
    path: match.path,
  };
}

export interface SyncRunnerTabItemsResult {
  items: PerformanceRequestDescriptor[];
  setupItemIds: string[];
  changed: boolean;
  syncedCount: number;
  addedCount: number;
  removedNames: string[];
}

/**
 * Re-syncs runner tab items against live collections / open request drafts before execution
 * while preserving custom row ordering, checkbox selections, and Pre-run Setup assignments.
 */
export function syncRunnerTabItemsFromSource(
  tab: Pick<OpenPerformanceTab, 'sourceType' | 'sourceId' | 'collectionId' | 'items' | 'setupItemIds'>,
  collections: Collection[],
  openRequestDrafts?: ApiRequest[]
): SyncRunnerTabItemsResult {
  const existingItems = tab.items || [];
  const existingSetupIds = tab.setupItemIds || [];

  if (tab.sourceType === 'imported') {
    return {
      items: existingItems,
      setupItemIds: existingSetupIds,
      changed: false,
      syncedCount: 0,
      addedCount: 0,
      removedNames: [],
    };
  }

  let liveItems: PerformanceRequestDescriptor[] | null = null;

  if (tab.sourceType === 'collection') {
    const col = collections.find((c) => c.id === (tab.collectionId || tab.sourceId));
    if (col && !col.isPartial) {
      liveItems = buildPerformanceItemsFromCollection(col.items || []);
    }
  } else if (tab.sourceType === 'folder') {
    const col = tab.collectionId
      ? collections.find((c) => c.id === tab.collectionId)
      : collections.find((c) => !c.isPartial && Boolean(findFolderInTree(c.items || [], tab.sourceId)));
    if (col && !col.isPartial) {
      const folder = findFolderInTree(col.items || [], tab.sourceId);
      if (folder) {
        liveItems = buildPerformanceItemsFromCollection(folder.items || []);
      } else {
        liveItems = [];
      }
    }
  } else if (tab.sourceType === 'request') {
    const draftMatch = (openRequestDrafts || []).find((r) => r.id === tab.sourceId);
    if (draftMatch) {
      const label = draftMatch.name?.trim() || draftMatch.url?.trim() || 'Untitled Request';
      liveItems = [
        {
          id: draftMatch.id,
          itemId: draftMatch.id,
          name: label,
          method: draftMatch.method,
          path: draftMatch.url || label,
          request: { ...draftMatch },
          selected: true,
        },
      ];
    } else {
      const col = tab.collectionId
        ? collections.find((c) => c.id === tab.collectionId)
        : undefined;
      const searchCols = col ? [col] : collections;
      for (const c of searchCols) {
        if (c.isPartial) continue;
        const found = findRequestItemInTree(c.items || [], tab.sourceId);
        if (found?.item.request) {
          liveItems = [
            {
              id: found.item.id,
              itemId: found.item.id,
              name: found.item.name,
              method: found.item.request.method,
              path: found.path,
              request: { ...found.item.request },
              selected: true,
            },
          ];
          break;
        }
      }
    }
  }

  if (!liveItems) {
    return {
      items: existingItems,
      setupItemIds: existingSetupIds,
      changed: false,
      syncedCount: 0,
      addedCount: 0,
      removedNames: [],
    };
  }

  const liveById = new Map<string, PerformanceRequestDescriptor>();
  for (const li of liveItems) {
    liveById.set(li.id, li);
  }

  const syncedItems: PerformanceRequestDescriptor[] = [];
  const seenIds = new Set<string>();
  const removedNames: string[] = [];
  let syncedCount = 0;

  for (const prev of existingItems) {
    const fresh = liveById.get(prev.id) || liveById.get(prev.itemId);
    if (!fresh) {
      removedNames.push(prev.name);
      continue;
    }
    seenIds.add(fresh.id);
    syncedCount += 1;
    syncedItems.push({
      ...fresh,
      selected: prev.selected,
    });
  }

  let addedCount = 0;
  for (const fresh of liveItems) {
    if (!seenIds.has(fresh.id)) {
      addedCount += 1;
      syncedItems.push({
        ...fresh,
        selected: existingItems.length === 0,
      });
    }
  }

  const validIdSet = new Set(syncedItems.map((it) => it.id));
  const nextSetupIds = existingSetupIds.filter((id) => validIdSet.has(id));
  const setupChanged = nextSetupIds.length !== existingSetupIds.length;
  const changed = removedNames.length > 0 || addedCount > 0 || setupChanged || syncedCount > 0;

  return {
    items: syncedItems,
    setupItemIds: nextSetupIds,
    changed,
    syncedCount,
    addedCount,
    removedNames,
  };
}

export interface RunnerPreflightValidationParams {
  items: PerformanceRequestDescriptor[];
  executionMode?: 'sequential' | 'pre_run_setup';
  setupItemIds?: string[];
  onlyItemIds?: string[];
  dataFile?: PerformanceDataFileMeta;
  dataRows?: Array<Record<string, string>>;
}

export interface RunnerPreflightValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Fail-fast pre-flight check before executing a Performance or Functional run.
 * Blocks silent runs when a Data File's RAM rows or a binary/form-data Blob handle was lost across reload.
 */
export function validateRunnerPreflight(
  params: RunnerPreflightValidationParams
): RunnerPreflightValidationResult {
  if (params.dataFile && (!params.dataRows || params.dataRows.length === 0)) {
    return {
      ok: false,
      error: `Data file "${params.dataFile.filename}" is not loaded in session memory (cleared on reload). Re-select the file or click Clear to continue.`,
    };
  }

  const onlySet = params.onlyItemIds ? new Set(params.onlyItemIds) : null;
  const setupSet = new Set(params.executionMode === 'pre_run_setup' ? params.setupItemIds || [] : []);

  const activeItems = (params.items || []).filter((it) => {
    if (setupSet.has(it.id)) return true;
    if (!it.selected) return false;
    if (onlySet && !onlySet.has(it.id) && !onlySet.has(it.itemId)) return false;
    return true;
  });

  const isBlobLike = (val: unknown): boolean => {
    if (!val || typeof val !== 'object') return false;
    if (typeof Blob !== 'undefined' && val instanceof Blob) return true;
    return typeof (val as { arrayBuffer?: unknown }).arrayBuffer === 'function';
  };

  for (const item of activeItems) {
    const req = item.request;
    if (!req || req.method === 'GET' || req.method === 'HEAD') continue;

    if (req.bodyType === 'binary' && req.bodyBinaryFile?.name && !isBlobLike(req.bodyBinaryFile.file)) {
      return {
        ok: false,
        error: `Request "${item.name}" is missing binary file "${req.bodyBinaryFile.name}" (file handles are cleared after reload). Re-attach the file before running.`,
      };
    }

    if (req.bodyType === 'form-data' && Array.isArray(req.bodyFormData)) {
      for (const field of req.bodyFormData) {
        if (!field.enabled || field.type !== 'file') continue;
        if (field.fileName && !isBlobLike(field.file)) {
          return {
            ok: false,
            error: `Request "${item.name}" is missing form-data attachment "${field.fileName}" (field "${field.key || 'file'}"). Re-attach the file before running.`,
          };
        }
      }
    }
  }

  return { ok: true };
}
