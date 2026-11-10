import type { ActiveScope, RequestTab, Collection, Environment, HistoryItem, SyncStatus } from '../types/api';
import { findSavedRequestInCollections } from '../lib/requestDiff';
import { getScopeCacheKey } from './scopeCache';
import { snapshotWorkspaceResources, type WorkspaceScopeSnapshot } from './scopeSnapshot';

export interface CloudDeltaStateInput {
  scope: ActiveScope;
  scopeCache: Record<string, WorkspaceScopeSnapshot>;
  collections: Collection[];
  currentCollections: Collection[];
  pulledEnvironments: Environment[];
  currentEnvironments: Environment[];
  activeEnvironmentId: string | null;
  tabs: RequestTab[];
  activeTabId: string;
  history: HistoryItem[];
  partialCollectionCount: number;
  syncedAt: number;
}

export interface CloudDeltaState {
  collections: Collection[];
  tabs: RequestTab[];
  environments: Environment[];
  activeEnvironmentId: string | null;
  scopeCache: Record<string, WorkspaceScopeSnapshot>;
  syncStatus: Extract<SyncStatus, 'synced' | 'error'>;
  syncError: string | null;
  lastSyncedAt: number;
}

export function preserveEnvironmentCurrentValues(
  pulledEnvironments: Environment[],
  currentEnvironments: Environment[],
): Environment[] {
  return pulledEnvironments.map((environment) => {
    const localEnvironment = currentEnvironments.find((candidate) => candidate.id === environment.id);
    if (!localEnvironment) return environment;
    return {
      ...environment,
      variables: environment.variables.map((variable) => {
        const localVariable = localEnvironment.variables.find(
          (candidate) => candidate.id === variable.id || candidate.key === variable.key,
        );
        return {
          ...variable,
          currentValue: localVariable?.currentValue !== undefined ? localVariable.currentValue : variable.initialValue,
        };
      }),
    };
  });
}

/** Builds the cache and UI state from data already fetched by a cloud sync. */
export function prepareCloudDeltaState(input: CloudDeltaStateInput): CloudDeltaState {
  const tabs = input.tabs.map((tab) => {
    if (findSavedRequestInCollections(input.collections, tab.id)) {
      if (!tab.deletedFromCollection) return tab;
      const restoredTab = { ...tab };
      delete restoredTab.deletedFromCollection;
      return restoredTab;
    }
    const previous = findSavedRequestInCollections(input.currentCollections, tab.id);
    if (!previous || input.collections.some((collection) => collection.id === previous.collection.id && collection.isPartial)) {
      return tab;
    }
    return { ...tab, deletedFromCollection: previous.collection.name };
  });
  const environments = preserveEnvironmentCurrentValues(input.pulledEnvironments, input.currentEnvironments);
  const activeEnvironmentId = environments.some((environment) => environment.id === input.activeEnvironmentId)
    ? input.activeEnvironmentId
    : (environments[0]?.id || null);
  const scopeKey = getScopeCacheKey(input.scope);
  const scopeCache = {
    ...input.scopeCache,
    [scopeKey]: {
      ...input.scopeCache[scopeKey],
      ...snapshotWorkspaceResources({
        collections: input.collections,
        environments,
        activeEnvironmentId,
        tabs,
        activeTabId: input.activeTabId,
        history: input.history,
      }, input.syncedAt),
    },
  };
  const hasPartialCollections = input.partialCollectionCount > 0;
  return {
    collections: input.collections,
    tabs,
    environments,
    activeEnvironmentId,
    scopeCache,
    syncStatus: hasPartialCollections ? 'error' : 'synced',
    syncError: hasPartialCollections
      ? `${input.partialCollectionCount} collection detail${input.partialCollectionCount === 1 ? '' : 's'} could not be loaded. Click sync to retry.`
      : null,
    lastSyncedAt: input.syncedAt,
  };
}
