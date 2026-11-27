import type {
  ApiResponse,
  CloudConfig,
  CloudProject,
  Collection,
  FeatureFlags,
  FeaturePolicy,
  FeaturePolicyStatus,
  HistoryItem,
  OfflineWorkspace,
} from '../../types/api';
import { appStorage, setItemInAllPersistenceCopies } from '../../lib/storage';
import { normalizeCloudApiUrl } from '../../lib/cloudApi';
import { buildCollectionFromDetails, buildEnvironmentsFromDelta } from '../../lib/cloudSyncTransformer';
import {
  clearFunctionalSessionHook,
  clearPerformanceDataRowsHook,
  collectionHasSavedExamples,
  countCollectionSavedExamples,
  overlayPendingExampleIntentsOnCollections,
  stopActivePerformanceRun,
  stopFunctionalRunHook,
  triggerCloudPerfCleanup,
  triggerOfflinePerfCleanup,
} from '../../lib/examples';
import { archiveCloudCache, captureCloudCache, cloudCacheOwnerKey, getArchivedScope, readCloudCache } from '../../workspace/cloudCacheArchive';
import { importCloudCacheRecoveryBackup } from '../../workspace/cloudCacheRecovery';
import { prepareCloudDeltaState } from '../../workspace/cloudDeltaState';
import { prepareCloudScopeTransition, isActiveCloudScope } from '../../workspace/cloudScopeTransition';
import { isCloudSessionActive, prepareCloudSessionUpdate } from '../../workspace/cloudSession';
import { retainPendingCloudCollections } from '../../workspace/cloudSyncCollections';
import { synchronizeCloudWorkspace } from '../../workspace/cloudWorkspaceSync';
import { normalizeCloudCacheArchives, serializeCloudCacheArchives } from '../../workspace/persistence';
import { getScopeCacheKey } from '../../workspace/scopeCache';
import { createEmptyWorkspaceSnapshot, restoreWorkspaceResources } from '../../workspace/scopeSnapshot';
import { prepareWorkspaceModeTransition } from '../../workspace/workspaceModeTransition';
import {
  DEFAULT_OFFLINE_WORKSPACE_ID,
  defaultOfflineWorkspace,
  SCOPES_LIST_CACHE_TTL_MS,
  SCOPE_CACHE_TTL_MS,
  type ApiStoreState,
} from '../storeTypes';
import {
  cloneCollectionPreservingAttachments,
  cloneRequestPreservingAttachments,
  createInitialTab,
  ensureUniqueCollectionItemIds,
  FEATURE_POLICY_TTL_MS,
  generateId,
  getNativeCredentialScope,
  normalizeCollectionAttachments,
  normalizeHistoryAttachments,
  normalizePersistedRequestAttachments,
  sameNativeCredentialScope,
  sanitizeVariablesForUpstream,
  serializeCollectionAttachments,
  serializeHistoryAttachments,
  serializeRequestAttachments,
} from '../storeHelpers';
import type { StoreSliceContext } from '../sliceContext';

export type CloudAuthWorkspaceSlice = Pick<
  ApiStoreState,
  | 'setWorkspaceMode'
  | 'setHasConfiguredMode'
  | 'setCloudConfig'
  | 'setCloudSession'
  | 'clearCloudCredentials'
  | 'setNativeCredentialState'
  | 'persistStoreState'
  | 'persistNativeCredentialState'
  | 'completePendingCredentialCleanup'
  | 'recoverNativeCredentials'
  | 'signOutCloud'
  | 'evictCloudSession'
  | 'getCloudSessionGeneration'
  | 'getCloudCacheRecoveryCount'
  | 'getCloudCacheRecoveryBackup'
  | 'importCloudCacheRecoveryBackup'
  | 'recoverCloudCachesToOfflineWorkspaces'
  | 'refreshFeaturePolicy'
  | 'isFeatureEnabled'
  | 'setActiveScope'
  | 'logoutCloud'
  | 'setSyncStatus'
  | 'pullCloudDelta'
  | 'importLocalToCloud'
  | 'createCloudWorkspace'
  | 'renameCloudWorkspace'
  | 'deleteCloudWorkspace'
  | 'fetchScopes'
  | 'fetchProjectsForTeam'
  | 'createOfflineWorkspace'
  | 'switchOfflineWorkspace'
  | 'renameOfflineWorkspace'
  | 'deleteOfflineWorkspace'
  | 'duplicateOfflineWorkspace'
>;

export function createCloudAuthWorkspaceSlice(ctx: StoreSliceContext): CloudAuthWorkspaceSlice {
  const {
    set,
    get,
    customStorage,
    credentialStorage,
    persistCloudCredentials: _persistCloudCredentials,
    isOfflineOnly,
    allowsOfflineWorkspace,
    cloudClient,
    refs,
    collections,
    helpers,
  } = ctx;

  const {
    fetchFeaturePolicy: fetchFeaturePolicyForRuntime,
    fetchUserWorkspaces: fetchUserWorkspacesForRuntime,
    fetchUserTeams: fetchUserTeamsForRuntime,
    fetchTeamProjects: fetchTeamProjectsForRuntime,
    fetchScopeCollections: fetchScopeCollectionsForRuntime,
    fetchCollectionById: fetchCollectionByIdForRuntime,
    fetchScopeEnvironments: fetchScopeEnvironmentsForRuntime,
    batchImportToScope,
    createScopeEnvironment,
    updateScopeEnvironment,
    createCloudWorkspace,
    updateCloudWorkspace,
    deleteCloudWorkspace,
  } = cloudClient;

  const {
    envIdAliasMap,
    movingCollections,
    duplicatingCollections,
    tabUndoHistory,
    undoTypingTimers,
    sessionOperations,
  } = collections;

  const {
    beginAsyncOperation,
    completeAsyncOperation,
    isAsyncOperationCurrent,
    invalidateAsyncOperations,
    safeSetTimeout,
    stripBackgroundCacheBlobUrls,
    revokeUnreferencedResponses,
    revokeUnreferencedTabBlobs,
    getPersistOptions,
    flushStorePersistence,
  } = helpers;

  let activeFeaturePolicyPromise: Promise<FeaturePolicy | null> | null = null;
  let activeFeaturePolicyKey: string | null = null;
  let nativeCredentialOperation = 0;
  let nativeCredentialQueue: Promise<void> = Promise.resolve();
  let cleanupInFlight: Promise<boolean> | null = null;
  let signOutInFlight: Promise<{ success: boolean; error?: string }> | null = null;

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

  return {
    setWorkspaceMode: (workspaceMode) => {
      if ((workspaceMode === 'offline' && !allowsOfflineWorkspace) || (workspaceMode === 'cloud' && isOfflineOnly)) return;
      const currentMode = get().workspaceMode;
      if (currentMode === workspaceMode) {
        if (!get().hasConfiguredMode) set({ hasConfiguredMode: true });
        return;
      }

      invalidateAsyncOperations();
      void stopActivePerformanceRun?.();
      clearPerformanceDataRowsHook?.();
      clearFunctionalSessionHook?.();
      void stopFunctionalRunHook?.();
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
        const nextScopeCache = stripBackgroundCacheBlobUrls(transition.scopeCache);
        revokeUnreferencedTabBlobs(
          get().tabResponses,
          get().activeResponse,
          [transition.targetResources.history],
          [
            ...Object.values(nextScopeCache).map((entry) => entry.history),
            ...Object.values(get().offlineScopeCache || {}).map((e) => e.history),
          ],
          get().history
        );

        set({
          workspaceMode: 'offline',
          hasConfiguredMode: true,
          scopeCache: nextScopeCache,
          collections: transition.targetResources.collections,
          environments: transition.targetResources.environments,
          activeEnvironmentId: transition.targetResources.activeEnvironmentId,
          tabs: transition.targetResources.tabs,
          activeTabId: transition.targetResources.activeTabId,
          openExampleTabs: [],
          openPerformanceTabs: [],
          tabOrder: transition.targetResources.tabs.map((t) => t.id),
          selectedExample: null,
          selectedPerformanceTabId: null,
          performanceReports: {},
          functionalReports: {},
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
        const nextOfflineScopeCache = stripBackgroundCacheBlobUrls(transition.offlineScopeCache);
        revokeUnreferencedTabBlobs(
          get().tabResponses,
          get().activeResponse,
          [transition.targetResources.history],
          [
            ...Object.values(nextOfflineScopeCache).map((entry) => entry.history),
            ...Object.values(transition.scopeCache).map((entry) => entry.history),
          ],
          get().history
        );

        set({
          workspaceMode: isOfflineOnly ? 'offline' : 'cloud',
          hasConfiguredMode: true,
          offlineScopeCache: nextOfflineScopeCache,
          collections: transition.targetResources.collections,
          environments: transition.targetResources.environments,
          activeEnvironmentId: transition.targetResources.activeEnvironmentId,
          tabs: transition.targetResources.tabs,
          activeTabId: transition.targetResources.activeTabId,
          openExampleTabs: [],
          openPerformanceTabs: [],
          tabOrder: transition.targetResources.tabs.map((t) => t.id),
          selectedExample: null,
          selectedPerformanceTabId: null,
          performanceReports: {},
          functionalReports: {},
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
          void stopActivePerformanceRun?.();
          clearPerformanceDataRowsHook?.();
          clearFunctionalSessionHook?.();
          void stopFunctionalRunHook?.();
          triggerCloudPerfCleanup?.(before.cloudConfig.user?.id, before.cloudConfig.apiUrl);
          const targetSnapshot = getArchivedScope(target, nextConfig.activeScope);
          const resources = restoreWorkspaceResources(targetSnapshot, createInitialTab);
          cacheTransition = {
            ...cacheTransition,
            ...resources,
            activeResponse: null,
            tabResponses: {},
            openExampleTabs: [],
            selectedExample: null,
            openPerformanceTabs: [],
            selectedPerformanceTabId: null,
            performanceReports: {},
            functionalReports: {},
            tabOrder: [],
            environmentOccConflict: null,
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
          if (operation !== nativeCredentialOperation || refs.isStoreDisposed) return;
          await credentialStorage.write(scope, record);
          if (operation !== nativeCredentialOperation || refs.isStoreDisposed) return;
          const confirmed = await credentialStorage.read(scope);
          if (!nativeCredentialRecordMatches(record, confirmed)) {
            throw new Error('Protected credential storage did not confirm the saved session.');
          }
          if (operation !== nativeCredentialOperation || refs.isStoreDisposed) return;
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

    persistStoreState: async () => {
      await flushStorePersistence();
    },

    persistNativeCredentialState: async () => {
      const options = getPersistOptions();
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
      if (!credentialStorage || refs.isStoreDisposed) return false;
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
        if (refs.isStoreDisposed) return false;
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
      const isCancelled = () => refs.isStoreDisposed || Boolean(options?.isCancelled?.());
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

      const initialGeneration = refs.cloudSessionGeneration;
      const initialNativeState = get().nativeCredentialState;
      const operation = ++nativeCredentialOperation;
      const hasCurrentScope = () =>
        !isCancelled() &&
        sameNativeCredentialScope(getNativeCredentialScope(get().cloudConfig), scope) &&
        sameNativeCredentialScope(get().nativeCredentialState?.scope, scope);
      const isCurrentRestore = () =>
        operation === nativeCredentialOperation &&
        refs.cloudSessionGeneration === initialGeneration &&
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
        if (refs.isStoreDisposed || get().getCloudSessionGeneration() !== generation || get().cloudConfig !== config) {
          return { success: false };
        }
        if (credentialScope && config.sessionKind !== 'provider') {
          try {
            await get().clearCloudCredentials(credentialScope);
          } catch (error) {
            console.warn('Sign-out could not clear protected credentials:', error);
            const message = 'Sign-out could not clear protected credentials. Please try again.';
            if (!refs.isStoreDisposed && get().getCloudSessionGeneration() === generation) {
              set({ syncStatus: 'error', syncError: message });
            }
            return { success: false, error: message };
          }
        }
        if (refs.isStoreDisposed || get().getCloudSessionGeneration() !== generation || get().cloudConfig !== config) {
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

    getCloudSessionGeneration: () => refs.cloudSessionGeneration,

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
      set({
        cloudCacheArchives: normalizeCloudCacheArchives(imported.archives, {
          normalizeRequest: normalizePersistedRequestAttachments,
          normalizeCollections: (cols: Collection[]) => ensureUniqueCollectionItemIds(
            cols.map(normalizeCollectionAttachments),
          ),
          normalizeHistory: normalizeHistoryAttachments,
        })
      });
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

      const requestKey = `${refs.cloudSessionGeneration}:${cloudConfig.apiUrl}`;
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

    isFeatureEnabled: (feature: keyof FeatureFlags) => {
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
        collections: storeCols,
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
          collections: storeCols,
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
      void stopActivePerformanceRun?.();
      clearPerformanceDataRowsHook?.();
      clearFunctionalSessionHook?.();
      void stopFunctionalRunHook?.();

      const activeTargetScopeKey = getScopeCacheKey(scope);
      const nextScopeCache = stripBackgroundCacheBlobUrls(transition.scopeCache, activeTargetScopeKey);
      const nextOfflineScopeCache = stripBackgroundCacheBlobUrls(transition.offlineScopeCache);

      revokeUnreferencedTabBlobs(
        get().tabResponses,
        get().activeResponse,
        [transition.targetCache?.history],
        [
          ...Object.values(nextScopeCache).map((entry) => entry.history),
          ...Object.values(nextOfflineScopeCache).map((entry) => entry.history),
        ],
        get().history
      );

      set((state) => ({
        workspaceMode: 'cloud',
        cloudConfig: {
          ...state.cloudConfig,
          activeScope: scope,
        },
        scopeCache: nextScopeCache,
        ...(workspaceMode === 'offline' ? { offlineScopeCache: nextOfflineScopeCache } : {}),
        collections: transition.targetResources.collections,
        environments: transition.targetResources.environments,
        activeEnvironmentId: transition.targetResources.activeEnvironmentId,
        tabs: transition.targetResources.tabs,
        activeTabId: transition.targetResources.activeTabId,
        openExampleTabs: [],
        openPerformanceTabs: [],
        tabOrder: transition.targetResources.tabs.map((t) => t.id),
        activeResponse: null,
        tabResponses: {},
        selectedExample: null,
        selectedPerformanceTabId: null,
        performanceReports: {},
        functionalReports: {},
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
      void stopActivePerformanceRun?.();
      clearPerformanceDataRowsHook?.();
      clearFunctionalSessionHook?.();
      void stopFunctionalRunHook?.();
      triggerCloudPerfCleanup?.(get().cloudConfig.user?.id, get().cloudConfig.apiUrl);
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
      revokeUnreferencedResponses(
        candidateResponses,
        [],
        [localEntry.history],
        Object.values(offlineScopeCache || {}).map((entry) => entry.history)
      );

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
        openPerformanceTabs: [],
        tabOrder: restoredResources.tabs.map((t) => t.id),
        activeResponse: null,
        tabResponses: {},
        selectedExample: null,
        selectedPerformanceTabId: null,
        performanceReports: {},
        functionalReports: {},
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
      refs.activePullOperation?.controller.abort();
      const operation = beginAsyncOperation();
      refs.activePullOperation = operation;
      const requestedScope = cloudConfig.activeScope;
      set({ syncStatus: 'syncing', syncError: null });
      try {
        const liveAuth = () => get().cloudConfig;
        const syncResult = await synchronizeCloudWorkspace({
          currentCollections: get().collections || [],
          currentEnvironments: get().environments || [],
          replayPendingExampleIntents: () => {
            const cfg = liveAuth();
            return helpers.replayPendingExampleIntentsForScope(
              requestedScope,
              cfg.apiUrl,
              cfg.token,
              cfg.refreshToken,
              operation.controller.signal,
            );
          },
          uploadPendingCollection: async (collection) => {
            const cfg = liveAuth();
            await batchImportToScope(
              cfg.apiUrl,
              cfg.token,
              requestedScope,
              [collection],
              cfg.refreshToken,
              operation.controller.signal,
            );
          },
          uploadPendingEnvironment: async (env) => {
            const cfg = liveAuth();
            if (env._pendingCreate) {
              const created = await createScopeEnvironment(
                cfg.apiUrl,
                cfg.token,
                requestedScope,
                {
                  name: env.name,
                  variables: sanitizeVariablesForUpstream(env.variables),
                  min_role: env.minRole || 'reader',
                },
                cfg.refreshToken,
                operation.controller.signal,
              );
              if (!isAsyncOperationCurrent(operation)) return;
              if (created?.id) {
                envIdAliasMap.set(env.id, created.id);
                set((s) => {
                  if (!isAsyncOperationCurrent(operation)) return {};
                  return {
                    environments: s.environments.map((candidate) =>
                      candidate.id === env.id
                        ? {
                            ...candidate,
                            id: created.id,
                            version: created.version || 1,
                            _syncStatus: 'synced',
                            _pendingCreate: undefined,
                          }
                        : candidate
                    ),
                    activeEnvironmentId: s.activeEnvironmentId === env.id ? created.id : s.activeEnvironmentId,
                  };
                });
              }
              return;
            }
            const targetEnvId = helpers.resolveCanonicalEnvId(env.id);
            const updated = await updateScopeEnvironment(
              cfg.apiUrl,
              cfg.token,
              targetEnvId,
              {
                name: env.name,
                variables: sanitizeVariablesForUpstream(env.variables),
                min_role: env.minRole,
                base_version: env.version || 1,
              },
              cfg.refreshToken,
              operation.controller.signal,
            );
            if (updated && typeof updated.version === 'number' && isAsyncOperationCurrent(operation)) {
              set((s) => ({
                environments: s.environments.map((candidate) =>
                  candidate.id === targetEnvId ? { ...candidate, version: updated.version, _syncStatus: 'synced' } : candidate
                ),
              }));
            }
          },
          fetchCollectionMetadata: () => {
            const cfg = liveAuth();
            return fetchScopeCollectionsForRuntime(
              cfg.apiUrl,
              cfg.token,
              requestedScope,
              cfg.refreshToken,
              operation.controller.signal,
            );
          },
          fetchCollectionDetail: (collectionId) => {
            const cfg = liveAuth();
            return fetchCollectionByIdForRuntime(
              cfg.apiUrl,
              cfg.token,
              collectionId,
              cfg.refreshToken,
              operation.controller.signal,
            );
          },
          fetchEnvironments: () => {
            const cfg = liveAuth();
            return fetchScopeEnvironmentsForRuntime(
              cfg.apiUrl,
              cfg.token,
              requestedScope,
              cfg.refreshToken,
              operation.controller.signal,
            );
          },
          buildCollection: buildCollectionFromDetails,
          buildEnvironments: buildEnvironmentsFromDelta,
          isCurrent: () => isAsyncOperationCurrent(operation),
          isAborted: () => operation.controller.signal.aborted,
          onPendingCollectionUploaded: (collection) => set((state) => ({
            collections: state.collections.map((candidate) =>
              candidate.id === collection.id ? { ...candidate, _syncStatus: 'synced' } : candidate,
            ),
          })),
          onPendingEnvironmentUploaded: (env) => set((state) => {
            const canonicalId = helpers.resolveCanonicalEnvId(env.id);
            return {
              environments: state.environments.map((candidate) =>
                candidate.id === env.id || candidate.id === canonicalId
                  ? { ...candidate, _syncStatus: 'synced', _pendingCreate: undefined }
                  : candidate
              ),
            };
          }),
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
        set((latestState) => {
          if (!isAsyncOperationCurrent(operation)) return {};
          const currentOwnerKey = cloudCacheOwnerKey(latestState.cloudConfig, normalizeCloudApiUrl);
          // Re-merge any collections created or edited locally after pullCloudDelta started.
          const pulledIds = new Set(syncResult.collections.map((c) => c.id));
          const latestById = new Map((latestState.collections || []).map((c) => [c.id, c]));
          const mergedCollections = syncResult.collections.map((pulledCol) => {
            const localLatest = latestById.get(pulledCol.id);
            if (localLatest && (localLatest._syncStatus === 'pending' || localLatest._needsMoveReconciliation)) {
              return localLatest;
            }
            return pulledCol;
          });
          const concurrentPendingCollections = retainPendingCloudCollections(latestState.collections || [], pulledIds);
          const overlaidCollections = overlayPendingExampleIntentsOnCollections(
            [...mergedCollections, ...concurrentPendingCollections],
            latestState.pendingExampleIntents,
            currentOwnerKey,
            requestedScope,
          );
          const deltaState = prepareCloudDeltaState({
            scope: requestedScope,
            scopeCache: latestState.scopeCache || {},
            collections: overlaidCollections,
            currentCollections: latestState.collections || [],
            pulledEnvironments: syncResult.environments,
            currentEnvironments: latestState.environments || [],
            activeEnvironmentId: latestState.activeEnvironmentId,
            tabs: latestState.tabs,
            activeTabId: latestState.activeTabId,
            history: latestState.history,
            partialCollectionCount: syncResult.partialCollectionCount,
            syncedAt: Date.now(),
          });
          return {
            ...deltaState,
            ...helpers.pruneExampleTabsState(latestState, (sel) => helpers.isSelectedExampleStillPresent(deltaState.collections, sel)),
          };
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
        if (refs.activePullOperation === operation) refs.activePullOperation = null;
      }
    },

    importLocalToCloud: async () => {
      if (isOfflineOnly) return { success: false, message: 'Cloud workspaces are disabled for this product.' };
      if (!allowsOfflineWorkspace) return { success: false, message: 'Offline workspaces are disabled for this product.' };
      const { cloudConfig, offlineScopeCache, activeOfflineWorkspaceId, collections: storeCols } = get();
      const activeLocalId = activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
      const localEntry = (offlineScopeCache || {})[activeLocalId];
      const colsToImport = (localEntry?.collections && localEntry.collections.length > 0)
        ? localEntry.collections
        : storeCols;

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
          const supported = await helpers.ensureSavedExamplesCapability();
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
          const liveCloud = get().cloudConfig;
          const batchResult = await batchImportToScope(
            liveCloud.apiUrl,
            liveCloud.token,
            cloudConfig.activeScope,
            [col],
            liveCloud.refreshToken,
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      const requestSessionGeneration = refs.cloudSessionGeneration;
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
        set({
          scopesCache: {
            workspaces: [...(scopesCache?.workspaces || []), newWs],
            teams: scopesCache?.teams || [],
            teamProjects: scopesCache?.teamProjects || {},
            teamsWithProjects: scopesCache?.teamsWithProjects || [],
            lastFetchedAt: scopesCache?.lastFetchedAt || 0,
          }
        });

        await get().setActiveScope({
          type: 'workspace',
          id: newWs.id,
          name: newWs.name,
          role: 'owner',
        });

        if (refs.isStoreDisposed || refs.cloudSessionGeneration !== requestSessionGeneration) return { success: false, error: 'Session changed' };

        return { success: true, workspace: newWs };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      const requestSessionGeneration = refs.cloudSessionGeneration;
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
            if (refs.isStoreDisposed || refs.cloudSessionGeneration !== requestSessionGeneration) return { success: false, error: 'Session changed' };
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
              syncError: `Access to "${currentScope.name}" was revoked. Switched to ${defaultWs ? defaultWs.name : allowsOfflineWorkspace ? 'Offline Workspace' : 'sign-in'
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
            syncError: `Access to "${currentScope.name}" was revoked. Switched to ${defaultWs ? defaultWs.name : allowsOfflineWorkspace ? 'Offline Workspace' : 'sign-in'
              }.`,
          });
        }

        return projects;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
              syncError: `Removed from team. Switched to ${defaultWs ? defaultWs.name : allowsOfflineWorkspace ? 'Offline Workspace' : 'sign-in'
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
        collections: storeCols,
        environments,
        activeEnvironmentId,
        tabs,
        activeTabId,
        history,
      } = get();

      const updatedOfflineCache = { ...(offlineScopeCache || {}) };
      if (workspaceMode === 'offline' && activeOfflineWorkspaceId) {
        updatedOfflineCache[activeOfflineWorkspaceId] = {
          collections: storeCols,
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
        collections: storeCols,
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
      void stopActivePerformanceRun?.();
      clearPerformanceDataRowsHook?.();
      clearFunctionalSessionHook?.();
      void stopFunctionalRunHook?.();
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
            collections: storeCols,
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
            collections: storeCols,
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

      const strippedOfflineCache = stripBackgroundCacheBlobUrls(updatedOfflineCache, workspaceId);
      const strippedScopeCache = stripBackgroundCacheBlobUrls(updatedScopeCache);

      revokeUnreferencedTabBlobs(
        get().tabResponses,
        get().activeResponse,
        [targetEntry.history],
        [
          ...Object.values(strippedOfflineCache).map((e) => e.history),
          ...Object.values(strippedScopeCache).map((e) => e.history),
        ],
        get().history
      );

      set({
        workspaceMode: 'offline',
        hasConfiguredMode: true,
        activeOfflineWorkspaceId: workspaceId,
        offlineScopeCache: strippedOfflineCache,
        scopeCache: strippedScopeCache,
        collections: targetEntry.collections || [],
        environments: targetEntry.environments || [],
        activeEnvironmentId: targetEntry.activeEnvironmentId || null,
        tabs: restoredTabs,
        activeTabId: restoredActiveTabId,
        openExampleTabs: [],
        openPerformanceTabs: [],
        tabOrder: restoredTabs.map((t) => t.id),
        activeResponse: null,
        tabResponses: {},
        selectedExample: null,
        selectedPerformanceTabId: null,
        performanceReports: {},
        functionalReports: {},
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

      void triggerOfflinePerfCleanup?.(id);
      return { success: true };
    },

    duplicateOfflineWorkspace: (id, newName) => {
      if (!allowsOfflineWorkspace) return '';
      const {
        offlineWorkspaces,
        activeOfflineWorkspaceId,
        offlineScopeCache,
        workspaceMode,
        collections: storeCols,
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
          collections: storeCols,
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
  };
}
