import type {
  ActiveScope,
  Collection,
  CollectionItem,
  OpenPerformanceTab,
  PendingExampleIntent,
  SavedExample,
  SavedExampleSummary,
} from '../../types/api';
import { CloudApiError, normalizeCloudApiUrl } from '../../lib/cloudApi';
import {
  applyExampleMutationToItem,
  applyServerItemToLocalItem,
  buildDefaultExampleName,
  buildOrderedVisualTabs,
  buildSavedExampleFromResponse,
  clearFunctionalSessionHook,
  clearPerformanceDataRowsHook,
  evaluateResponseExampleEligibility,
  findCollectionItemById,
  getActivePerformanceRun,
  getExampleUtf8ByteLength,
  getItemExampleCount,
  hasUnloadedCollectionExamples,
  makeExampleTabId,
  makePerformanceTabId,
  MAX_SAVED_EXAMPLES_PER_ITEM,
  MAX_SAVED_EXAMPLES_TOTAL_BYTES_PER_ITEM,
  overlayPendingExampleIntentsOnCollections,
  stopActivePerformanceRun,
  stopFunctionalRunHook,
  syncVisualTabOrder,
  updateCollectionItemById,
  validateSavedExampleName,
} from '../../lib/examples';
import { canModifyCollection } from '../../lib/jwt';
import { buildPostmanUrl } from '../../lib/postman';
import { isCloudSessionActive } from '../../workspace/cloudSession';
import { cloudCacheOwnerKey } from '../../workspace/cloudCacheArchive';
import { getScopeCacheKey } from '../../workspace/scopeCache';
import type { ApiStoreState, SavedExampleActionResult, SelectedSavedExample } from '../storeTypes';
import {
  FEATURE_POLICY_TTL_MS,
  generateId,
  withoutPendingExampleIntent,
} from '../storeHelpers';
import type { StoreSliceContext } from '../sliceContext';

export type ExamplesAndPerformanceSlice = Pick<
  ApiStoreState,
  | 'selectSavedExample'
  | 'closeExampleTab'
  | 'openPerformanceTestTab'
  | 'selectPerformanceTab'
  | 'updatePerformanceTab'
  | 'closePerformanceTab'
  | 'setPerformanceReport'
  | 'setFunctionalReport'
  | 'removePerformanceReport'
  | 'removeFunctionalReport'
  | 'saveResponseAsExample'
  | 'renameSavedExample'
  | 'deleteSavedExample'
  | 'loadItemExamples'
  | 'hydrateCollectionExamples'
  | 'retryPendingExampleIntent'
  | 'clearPendingExampleIntent'
>;

export function createExamplesAndPerformanceSlice(ctx: StoreSliceContext): ExamplesAndPerformanceSlice {
  const { set, get, isOfflineOnly, cloudClient, refs, collections, helpers } = ctx;
  const {
    patchScopeItemExamples,
    fetchScopeItem,
    fetchScopeCollectionExamples,
  } = cloudClient;
  const {
    movingCollections,
    duplicatingCollections,
    inFlightExampleOperations,
    tabUndoHistory,
  } = collections;
  const {
    beginAsyncOperation,
    completeAsyncOperation,
    isAsyncOperationCurrent,
    flushStorePersistence,
  } = helpers;

  const isSelectedExampleStillPresent = (
    cols: Collection[],
    selection: SelectedSavedExample | null | undefined,
  ): boolean => {
    if (!selection) return false;
    const col = cols.find((c) => c.id === selection.collectionId);
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
    state: Pick<ApiStoreState, 'openExampleTabs' | 'openPerformanceTabs' | 'selectedExample' | 'tabOrder' | 'tabs'>,
    shouldKeep: (selection: SelectedSavedExample) => boolean,
  ): Pick<ApiStoreState, 'openExampleTabs' | 'selectedExample' | 'tabOrder'> => {
    const nextExampleTabs = (state.openExampleTabs || []).filter((ex) => shouldKeep(ex));
    const nextSelected = state.selectedExample && shouldKeep(state.selectedExample)
      ? state.selectedExample
      : null;
    return {
      openExampleTabs: nextExampleTabs,
      selectedExample: nextSelected,
      tabOrder: syncVisualTabOrder(state.tabs, nextExampleTabs, state.tabOrder, state.openPerformanceTabs),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    const capturedSessionGen = refs.cloudSessionGeneration;
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
          refs.isStoreDisposed ||
          refs.cloudSessionGeneration !== capturedSessionGen ||
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
            refs.isStoreDisposed ||
            refs.cloudSessionGeneration !== capturedSessionGen ||
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
          if (signal?.aborted || refs.isStoreDisposed || refs.cloudSessionGeneration !== capturedSessionGen) {
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
              if (refs.isStoreDisposed || refs.cloudSessionGeneration !== capturedSessionGen) {
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
                set((state) => {
                  const isSameScope =
                    !intent.targetScope ||
                    (state.workspaceMode === 'cloud' &&
                      state.cloudConfig.activeScope?.id === intent.targetScope.id &&
                      state.cloudConfig.activeScope?.type === intent.targetScope.type);
                  const preCol = opts?.preMutationCollections?.find((c) => c.id === intent.collectionId);
                  const preItem = preCol ? findCollectionItemById(preCol.items, intent.itemId) : undefined;
                  const revertedCollections =
                    isSameScope && preItem
                      ? state.collections.map((c) => {
                        if (c.id !== intent.collectionId) return c;
                        const res = updateCollectionItemById(c.items || [], intent.itemId, (cur) => ({
                          ...cur,
                          ...(preItem.examples ? { examples: preItem.examples } : { examples: undefined }),
                          ...(preItem.exampleSummaries ? { exampleSummaries: preItem.exampleSummaries } : { exampleSummaries: undefined }),
                          exampleCount: preItem.exampleCount,
                          examplesLoaded: preItem.examplesLoaded,
                          exampleSummariesTruncated: preItem.exampleSummariesTruncated,
                        }));
                        return res.found ? { ...c, items: res.items } : c;
                      })
                      : state.collections;
                  return {
                    pendingExampleIntents: withoutPendingExampleIntent(state.pendingExampleIntents, intent.operationId),
                    collections: revertedCollections,
                    ...(fetchErr.status === 404
                      ? pruneExampleTabsState(state, (sel) => sel.itemId !== intent.itemId)
                      : {}),
                  };
                });
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
            set((state) => {
              const isSameScope =
                !intent.targetScope ||
                (state.workspaceMode === 'cloud' &&
                  state.cloudConfig.activeScope?.id === intent.targetScope.id &&
                  state.cloudConfig.activeScope?.type === intent.targetScope.type);
              const preCol = opts?.preMutationCollections?.find((c) => c.id === intent.collectionId);
              const preItem = preCol ? findCollectionItemById(preCol.items, intent.itemId) : undefined;
              const revertedCollections =
                isSameScope && preItem
                  ? state.collections.map((c) => {
                    if (c.id !== intent.collectionId) return c;
                    const res = updateCollectionItemById(c.items || [], intent.itemId, (cur) => ({
                      ...cur,
                      ...(preItem.examples ? { examples: preItem.examples } : { examples: undefined }),
                      ...(preItem.exampleSummaries ? { exampleSummaries: preItem.exampleSummaries } : { exampleSummaries: undefined }),
                      exampleCount: preItem.exampleCount,
                      examplesLoaded: preItem.examplesLoaded,
                      exampleSummariesTruncated: preItem.exampleSummariesTruncated,
                    }));
                    return res.found ? { ...c, items: res.items } : c;
                  })
                  : state.collections;
              return {
                pendingExampleIntents: withoutPendingExampleIntent(state.pendingExampleIntents, intent.operationId),
                collections: revertedCollections,
                ...(err.status === 404
                  ? pruneExampleTabsState(state, (sel) => sel.itemId !== intent.itemId)
                  : {}),
              };
            });
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
        if (!ownerKey || intent.ownerKey !== ownerKey) return false;
        if (intent.targetScope) {
          return intent.targetScope.id === targetScope.id && intent.targetScope.type === targetScope.type;
        }
        return true;
      })
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const intent of pendingList) {
      if (signal.aborted || refs.isStoreDisposed) break;
      await executeExampleIntent(intent, { apiUrl, token, refreshToken, signal });
    }
  };

  helpers.isSelectedExampleStillPresent = isSelectedExampleStillPresent;
  helpers.pruneExampleTabsState = pruneExampleTabsState;
  helpers.ensureSavedExamplesCapability = ensureSavedExamplesCapability;
  helpers.commitServerItemToStore = commitServerItemToStore;
  helpers.executeExampleIntent = executeExampleIntent;
  helpers.replayPendingExampleIntentsForScope = replayPendingExampleIntentsForScope;

  return {
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
        const currentOrder = syncVisualTabOrder(state.tabs, state.openExampleTabs, state.tabOrder, state.openPerformanceTabs);
        const nextTabOrder = exists ? currentOrder : [...currentOrder, tabId];
        return {
          openExampleTabs: nextOpenExampleTabs,
          tabOrder: nextTabOrder,
          selectedExample: selection,
          selectedPerformanceTabId: null,
          tabRevealRevision: state.tabRevealRevision + 1,
        };
      });
    },

    closeExampleTab: (tabId) => {
      set((state) => {
        const exists = (state.openExampleTabs || []).some((ex) => ex.id === tabId);
        if (!exists) return state;

        const ordered = buildOrderedVisualTabs(state.tabs, state.openExampleTabs, state.tabOrder, state.openPerformanceTabs);
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
            selectedPerformanceTabId: null,
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
            selectedPerformanceTabId: null,
            tabRevealRevision: state.tabRevealRevision + 1,
          };
        }

        if (adj.kind === 'performance') {
          return {
            openExampleTabs: nextOpenExampleTabs,
            tabOrder: nextTabOrder,
            selectedExample: null,
            selectedPerformanceTabId: adj.id,
            tabRevealRevision: state.tabRevealRevision + 1,
          };
        }

        return {
          openExampleTabs: nextOpenExampleTabs,
          tabOrder: nextTabOrder,
          selectedExample: null,
          selectedPerformanceTabId: null,
          activeTabId: adj.id,
          activeResponse: state.tabResponses?.[adj.id] || null,
          tabRevealRevision: state.tabRevealRevision + 1,
          canUndoActiveRequest: (tabUndoHistory[adj.id]?.past?.length ?? 0) > 0,
          canRedoActiveRequest: (tabUndoHistory[adj.id]?.future?.length ?? 0) > 0,
        };
      });
    },

    openPerformanceTestTab: (config) => {
      const tabId = config.id || makePerformanceTabId(config.sourceType, config.sourceId);
      set((state) => {
        const existing = (state.openPerformanceTabs || []).find((p) => p.id === tabId);
        if (existing && existing.viewMode === 'running') {
          return {
            selectedExample: null,
            selectedPerformanceTabId: tabId,
            tabRevealRevision: state.tabRevealRevision + 1,
          };
        }
        const nextRunnerMode = config.runnerMode || existing?.runnerMode || 'performance';
        const nextTab: OpenPerformanceTab = existing
          ? {
            ...existing,
            title: config.title,
            runnerMode: nextRunnerMode,
            items: config.items,
            collectionId: config.collectionId ?? existing.collectionId,
            functionalConfig: existing.functionalConfig || config.functionalConfig,
            ...(config.viewingReportId !== undefined ? { viewingReportId: config.viewingReportId } : {}),
            ...(config.viewingFunctionalReportId !== undefined
              ? { viewingFunctionalReportId: config.viewingFunctionalReportId }
              : {}),
            ...(config.isSessionOnlyImported !== undefined
              ? { isSessionOnlyImported: config.isSessionOnlyImported }
              : {}),
            ...(config.sessionOnlyReason !== undefined
              ? { sessionOnlyReason: config.sessionOnlyReason }
              : {}),
            viewMode:
              existing.viewMode === 'running'
                ? 'running'
                : config.viewMode
                  ? config.viewMode
                  : config.runnerMode && config.runnerMode !== existing.runnerMode
                    ? 'setup'
                    : existing.viewMode,
          }
          : {
            ...config,
            runnerMode: nextRunnerMode,
            id: tabId,
            viewMode: config.viewMode || 'setup',
            createdAt: Date.now(),
          };
        const nextPerfTabs = existing
          ? (state.openPerformanceTabs || []).map((p) => (p.id === tabId ? nextTab : p))
          : [...(state.openPerformanceTabs || []), nextTab];
        const currentOrder = syncVisualTabOrder(state.tabs, state.openExampleTabs, state.tabOrder, state.openPerformanceTabs);
        const nextTabOrder = existing ? currentOrder : [...currentOrder, tabId];
        return {
          openPerformanceTabs: nextPerfTabs,
          tabOrder: nextTabOrder,
          selectedExample: null,
          selectedPerformanceTabId: tabId,
          tabRevealRevision: state.tabRevealRevision + 1,
        };
      });
      return tabId;
    },

    selectPerformanceTab: (tabId) => {
      if (!tabId) {
        set({ selectedPerformanceTabId: null });
        return;
      }
      set((state) => ({
        selectedPerformanceTabId: tabId,
        selectedExample: null,
        tabRevealRevision: state.tabRevealRevision + 1,
      }));
    },

    updatePerformanceTab: (tabId, updater) => {
      set((state) => ({
        openPerformanceTabs: (state.openPerformanceTabs || []).map((tab) => {
          if (tab.id !== tabId) return tab;
          return typeof updater === 'function' ? updater(tab) : { ...tab, ...updater };
        }),
      }));
    },

    closePerformanceTab: (tabId) => {
      const activePerf = getActivePerformanceRun?.();
      if (activePerf && activePerf.tabId === tabId) {
        void stopActivePerformanceRun?.();
      }
      clearPerformanceDataRowsHook?.(tabId);
      clearFunctionalSessionHook?.(tabId);
      void stopFunctionalRunHook?.(tabId);
      set((state) => {
        const closingTab = (state.openPerformanceTabs || []).find((p) => p.id === tabId);
        if (!closingTab) return state;

        let nextPerformanceReports = state.performanceReports;
        let nextFunctionalReports = state.functionalReports;
        const remainingTabsAfterClose = (state.openPerformanceTabs || []).filter((p) => p.id !== tabId);
        if (
          closingTab.viewingReportId &&
          state.performanceReports?.[closingTab.viewingReportId] &&
          !remainingTabsAfterClose.some((p) => p.viewingReportId === closingTab.viewingReportId)
        ) {
          const restPerf = { ...nextPerformanceReports };
          delete restPerf[closingTab.viewingReportId];
          nextPerformanceReports = restPerf;
        }
        if (
          closingTab.viewingFunctionalReportId &&
          state.functionalReports?.[closingTab.viewingFunctionalReportId] &&
          !remainingTabsAfterClose.some((p) => p.viewingFunctionalReportId === closingTab.viewingFunctionalReportId)
        ) {
          const restFunc = { ...nextFunctionalReports };
          delete restFunc[closingTab.viewingFunctionalReportId];
          nextFunctionalReports = restFunc;
        }

        const ordered = buildOrderedVisualTabs(state.tabs, state.openExampleTabs, state.tabOrder, state.openPerformanceTabs);
        const closingIndex = ordered.findIndex((entry) => entry.kind === 'performance' && entry.id === tabId);
        const nextPerfTabs = (state.openPerformanceTabs || []).filter((p) => p.id !== tabId);
        const remainingOrdered = ordered.filter((entry) => entry.id !== tabId);
        const nextTabOrder = remainingOrdered.map((entry) => entry.id);

        const wasActive = state.selectedPerformanceTabId === tabId;
        if (!wasActive) {
          return {
            openPerformanceTabs: nextPerfTabs,
            tabOrder: nextTabOrder,
            performanceReports: nextPerformanceReports,
            functionalReports: nextFunctionalReports,
          };
        }

        const adj =
          remainingOrdered[closingIndex] ||
          remainingOrdered[closingIndex - 1] ||
          remainingOrdered[0];

        if (!adj) {
          return {
            openPerformanceTabs: nextPerfTabs,
            tabOrder: nextTabOrder,
            performanceReports: nextPerformanceReports,
            functionalReports: nextFunctionalReports,
            selectedExample: null,
            selectedPerformanceTabId: null,
            activeTabId: '',
            activeResponse: null,
            canUndoActiveRequest: false,
            canRedoActiveRequest: false,
          };
        }

        if (adj.kind === 'example') {
          return {
            openPerformanceTabs: nextPerfTabs,
            tabOrder: nextTabOrder,
            performanceReports: nextPerformanceReports,
            functionalReports: nextFunctionalReports,
            selectedExample: {
              collectionId: adj.exampleTab.collectionId,
              itemId: adj.exampleTab.itemId,
              exampleId: adj.exampleTab.exampleId,
            },
            selectedPerformanceTabId: null,
            tabRevealRevision: state.tabRevealRevision + 1,
          };
        }

        if (adj.kind === 'performance') {
          return {
            openPerformanceTabs: nextPerfTabs,
            tabOrder: nextTabOrder,
            performanceReports: nextPerformanceReports,
            functionalReports: nextFunctionalReports,
            selectedExample: null,
            selectedPerformanceTabId: adj.id,
            tabRevealRevision: state.tabRevealRevision + 1,
          };
        }

        return {
          openPerformanceTabs: nextPerfTabs,
          tabOrder: nextTabOrder,
          performanceReports: nextPerformanceReports,
          functionalReports: nextFunctionalReports,
          selectedExample: null,
          selectedPerformanceTabId: null,
          activeTabId: adj.id,
          activeResponse: state.tabResponses?.[adj.id] || null,
          tabRevealRevision: state.tabRevealRevision + 1,
          canUndoActiveRequest: (tabUndoHistory[adj.id]?.past?.length ?? 0) > 0,
          canRedoActiveRequest: (tabUndoHistory[adj.id]?.future?.length ?? 0) > 0,
        };
      });
    },

    setPerformanceReport: (report) => {
      set((state) => ({
        performanceReports: {
          ...(state.performanceReports || {}),
          [report.id]: report,
        },
      }));
    },

    setFunctionalReport: (report) => {
      set((state) => ({
        functionalReports: {
          ...(state.functionalReports || {}),
          [report.id]: report,
        },
      }));
    },

    removePerformanceReport: (reportId) => {
      set((state) => {
        if (!state.performanceReports?.[reportId]) return state;
        const next = { ...state.performanceReports };
        delete next[reportId];
        return { performanceReports: next };
      });
    },

    removeFunctionalReport: (reportId) => {
      set((state) => {
        if (!state.functionalReports?.[reportId]) return state;
        const next = { ...state.functionalReports };
        delete next[reportId];
        return { functionalReports: next };
      });
    },

    saveResponseAsExample: async ({ collectionId, itemId, name, response, fallbackRequest }) => {
      const { workspaceMode, cloudConfig, collections: storeCols } = get();
      if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
        return { success: false, error: 'Wait for the collection move or duplicate to finish first.' };
      }
      const col = storeCols.find((c) => c.id === collectionId);
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

      const initialIsCloud = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);
      if (initialIsCloud) {
        const supported = await ensureSavedExamplesCapability();
        if (!supported) {
          return {
            success: false,
            error: 'This cloud server does not support Saved Examples. Update the server to save examples in cloud mode.',
          };
        }
      }

      const liveAfterCap = get();
      const liveCol = liveAfterCap.collections.find((c) => c.id === collectionId);
      if (!liveCol || !findCollectionItemById(liveCol.items, itemId)) {
        return { success: false, error: 'Target collection or request no longer exists.' };
      }
      const isCloud = !isOfflineOnly && liveAfterCap.workspaceMode === 'cloud' && isCloudSessionActive(liveAfterCap.cloudConfig) && Boolean(liveAfterCap.cloudConfig.activeScope);
      const preMutationCollections = liveAfterCap.collections;
      const applyLocalAdd = (cols: Collection[]): Collection[] =>
        cols.map((c) => {
          if (c.id !== collectionId) return c;
          const res = updateCollectionItemById(c.items || [], itemId, (item) =>
            applyExampleMutationToItem(item, { op: 'add', example: builtExample }),
          );
          return res.found ? { ...c, items: res.items, updatedAt: Date.now() } : c;
        });

      const liveItemAfterCap = findCollectionItemById(liveCol.items, itemId)!;
      const opId = generateId();
      const ownerKey = isCloud ? cloudCacheOwnerKey(liveAfterCap.cloudConfig, normalizeCloudApiUrl) : null;
      const intent: PendingExampleIntent | null = isCloud
        ? {
          operationId: opId,
          ownerKey,
          op: 'add',
          collectionId,
          itemId,
          exampleId: builtExample.id,
          baseVersion: typeof liveItemAfterCap.version === 'number' ? liveItemAfterCap.version : 1,
          example: builtExample,
          targetScope: liveAfterCap.cloudConfig.activeScope,
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
      const { workspaceMode, cloudConfig, collections: storeCols } = get();
      if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
        return { success: false, error: 'Wait for the collection move or duplicate to finish first.' };
      }
      const col = storeCols.find((c) => c.id === collectionId);
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

      const initialIsCloud = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);
      if (initialIsCloud) {
        const supported = await ensureSavedExamplesCapability();
        if (!supported) {
          return { success: false, error: 'This cloud server does not support Saved Examples.' };
        }
      }

      const liveAfterCap = get();
      const liveCol = liveAfterCap.collections.find((c) => c.id === collectionId);
      const liveItem = liveCol ? findCollectionItemById(liveCol.items, itemId) : undefined;
      const liveTarget = liveItem?.examples?.find((ex) => ex.id === exampleId) || liveItem?.exampleSummaries?.find((s) => s.id === exampleId);
      if (!liveCol || !liveItem || !liveTarget) {
        return { success: false, error: 'Saved example or request no longer exists.' };
      }
      const isCloud = !isOfflineOnly && liveAfterCap.workspaceMode === 'cloud' && isCloudSessionActive(liveAfterCap.cloudConfig) && Boolean(liveAfterCap.cloudConfig.activeScope);
      const preMutationCollections = liveAfterCap.collections;
      const opId = generateId();
      const baseRevision = typeof liveTarget.revision === 'number' ? liveTarget.revision : 1;
      const nextRevision = baseRevision + 1;
      const ownerKey = isCloud ? cloudCacheOwnerKey(liveAfterCap.cloudConfig, normalizeCloudApiUrl) : null;
      const intent: PendingExampleIntent | null = isCloud
        ? {
          operationId: opId,
          ownerKey,
          op: 'rename',
          collectionId,
          itemId,
          exampleId,
          baseVersion: typeof liveItem.version === 'number' ? liveItem.version : 1,
          baseExampleRevision: baseRevision,
          name: trimmedName,
          targetScope: liveAfterCap.cloudConfig.activeScope,
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
      const { workspaceMode, cloudConfig, collections: storeCols } = get();
      if (movingCollections.has(collectionId) || duplicatingCollections.has(collectionId)) {
        return { success: false, error: 'Wait for the collection move or duplicate to finish first.' };
      }
      const col = storeCols.find((c) => c.id === collectionId);
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

      const initialIsCloud = !isOfflineOnly && workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);
      if (initialIsCloud) {
        const supported = await ensureSavedExamplesCapability();
        if (!supported) {
          return { success: false, error: 'This cloud server does not support Saved Examples.' };
        }
      }

      const liveAfterCap = get();
      const liveCol = liveAfterCap.collections.find((c) => c.id === collectionId);
      const liveItem = liveCol ? findCollectionItemById(liveCol.items, itemId) : undefined;
      const liveTarget = liveItem?.examples?.find((ex) => ex.id === exampleId) || liveItem?.exampleSummaries?.find((s) => s.id === exampleId);
      if (!liveCol || !liveItem || !liveTarget) {
        return { success: false, error: 'Saved example or request no longer exists.' };
      }
      const isCloud = !isOfflineOnly && liveAfterCap.workspaceMode === 'cloud' && isCloudSessionActive(liveAfterCap.cloudConfig) && Boolean(liveAfterCap.cloudConfig.activeScope);
      const preMutationCollections = liveAfterCap.collections;
      const prevSelectedExample = liveAfterCap.selectedExample;
      const prevOpenExampleTabs = liveAfterCap.openExampleTabs;
      const prevTabOrder = liveAfterCap.tabOrder;
      const opId = generateId();
      const baseRevision = typeof liveTarget.revision === 'number' ? liveTarget.revision : 1;
      const ownerKey = isCloud ? cloudCacheOwnerKey(liveAfterCap.cloudConfig, normalizeCloudApiUrl) : null;
      const intent: PendingExampleIntent | null = isCloud
        ? {
          operationId: opId,
          ownerKey,
          op: 'delete',
          collectionId,
          itemId,
          exampleId,
          baseVersion: typeof liveItem.version === 'number' ? liveItem.version : 1,
          baseExampleRevision: baseRevision,
          targetScope: liveAfterCap.cloudConfig.activeScope,
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
      const { workspaceMode, cloudConfig, collections: storeCols } = get();
      const col = storeCols.find((c) => c.id === collectionId);
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
        if (!isAsyncOperationCurrent(operation) || refs.isStoreDisposed) {
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
        if (!isAsyncOperationCurrent(operation) || refs.isStoreDisposed) {
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
      const { workspaceMode, cloudConfig, collections: storeCols } = get();
      const col = storeCols.find((c) => c.id === collectionId);
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pageUpdates = new Map<string, any>();

          while (true) {
            if (!isAsyncOperationCurrent(operation) || refs.isStoreDisposed) {
              return { success: false, error: 'Session or scope changed.' };
            }
            const liveCloudPage = get().cloudConfig;
            const page = await fetchScopeCollectionExamples(
              liveCloudPage.apiUrl,
              liveCloudPage.token,
              collectionId,
              { cursor, limit: 100, includeBody },
              liveCloudPage.refreshToken,
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
        if (!isAsyncOperationCurrent(operation) || refs.isStoreDisposed) {
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
  };
}
