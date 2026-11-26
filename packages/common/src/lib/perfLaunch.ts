import type {
  ApiRequest,
  Collection,
  CollectionItem,
  FunctionalRunnerConfig,
  OpenPerformanceTab,
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
