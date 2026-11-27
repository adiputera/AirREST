import type {
  ApiRequest,
  ApiResponse,
  HistoryItem,
  KeyValuePair,
  OpenExampleTab,
  OpenPerformanceTab,
  RequestTab,
} from '../../types/api';
import type { ScriptRequest } from '../../types/platform';
import { revokeBlobUrl } from '../../lib/blobManager';
import {
  buildOrderedVisualTabs,
  clearFunctionalSessionHook,
  clearPerformanceDataRowsHook,
  getActiveFunctionalRunState,
  getActivePerformanceRun,
  isExampleTabId,
  isPerformanceTabId,
  makeExampleTabId,
  stopActivePerformanceRun,
  stopFunctionalRunHook,
  syncVisualTabOrder,
} from '../../lib/examples';
import { executeApiRequest } from '../../lib/fetcher';
import { executePostResponseScript, executePreRequestScript } from '../../lib/scriptRunner';
import {
  buildUrlWithParams,
  parsePathVariablesFromUrl,
  parseQueryParamsFromUrl,
} from '../../lib/urlParams';
import { getScopeCacheKey } from '../../workspace/scopeCache';
import type { ApiStoreState } from '../storeTypes';
import {
  cloneRequestPreservingAttachments,
  generateId,
  MAX_UNDO_HISTORY,
} from '../storeHelpers';
import type { StoreSliceContext } from '../sliceContext';

export type RequestTabsSlice = Pick<
  ApiStoreState,
  | 'setSidebarTab'
  | 'setActiveTabId'
  | 'createTab'
  | 'closeTab'
  | 'closeOtherTabs'
  | 'closeAllTabs'
  | 'closeTabsToRight'
  | 'duplicateTab'
  | 'updateActiveRequest'
  | 'updateParam'
  | 'addParam'
  | 'removeParam'
  | 'updatePathVariable'
  | 'updateHeader'
  | 'addHeader'
  | 'removeHeader'
  | 'updateAuth'
  | 'setBodyType'
  | 'setRawType'
  | 'setBodyContent'
  | 'setGraphqlQuery'
  | 'setGraphqlVariables'
  | 'setPreRequestScript'
  | 'setPostResponseScript'
  | 'updateFormDataItem'
  | 'addFormDataItem'
  | 'removeFormDataItem'
  | 'setBodyBinaryFile'
  | 'updateUrlEncodedItem'
  | 'addUrlEncodedItem'
  | 'removeUrlEncodedItem'
  | 'setUrlEncodedItems'
  | 'undoActiveRequest'
  | 'redoActiveRequest'
  | 'sendRequest'
  | 'cancelActiveRequest'
  | 'openRequestInTab'
  | 'clearHistory'
  | 'deleteHistoryItem'
>;

export function createRequestTabsSlice(ctx: StoreSliceContext): RequestTabsSlice {
  const { set, get, boundAdapter, refs, collections, helpers } = ctx;
  const { tabUndoHistory, undoTypingTimers } = collections;
  const {
    pushTabSnapshot,
    beginAsyncOperation,
    completeAsyncOperation,
    isAsyncOperationCurrent,
    safeReleaseRawBody,
    safeEvictRawBodiesToBudget,
    ensureResponseImageBlobUrl,
    revokeUnreferencedResponses,
  } = helpers;

  return {
    setSidebarTab: (sidebarTab) => set({ sidebarTab }),

    setActiveTabId: (activeTabId) => {
      set((state) => ({
        activeTabId,
        activeResponse: state.tabResponses?.[activeTabId] || null,
        selectedExample: null,
        selectedPerformanceTabId: null,
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
        selectedPerformanceTabId: null,
        tabOrder: [...syncVisualTabOrder(state.tabs, state.openExampleTabs, state.tabOrder, state.openPerformanceTabs), newReq.id],
        tabRevealRevision: state.tabRevealRevision + 1,
        canUndoActiveRequest: false,
        canRedoActiveRequest: false,
      }));
    },

    closeTab: (id) => {
      if (isPerformanceTabId(id)) {
        get().closePerformanceTab(id);
        return;
      }
      let aborted = false;
      if (refs.activeRequestOperation && refs.activeRequestTabId === id) {
        refs.activeRequestOperation.controller.abort();
        refs.activeRequestOperation = null;
        refs.activeRequestTabId = null;
        aborted = true;
      }

      delete tabUndoHistory[id];
      if (undoTypingTimers[id]) {
        clearTimeout(undoTypingTimers[id]);
        delete undoTypingTimers[id];
      }

      set((state) => {
        const shouldResetLoading = aborted || (state.isLoading && state.activeTabId === id && !refs.activeRequestOperation);
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

        const ordered = buildOrderedVisualTabs(state.tabs, state.openExampleTabs, state.tabOrder, state.openPerformanceTabs);
        const closingVisualIndex = ordered.findIndex((entry) => entry.kind === 'request' && entry.id === id);
        const remainingOrdered = ordered.filter((entry) => entry.id !== id);
        const nextTabOrder = remainingOrdered.map((entry) => entry.id);
        const filteredTabs = state.tabs.filter((t) => t.id !== id);

        const wasRequestTabActive = !state.selectedExample && !state.selectedPerformanceTabId && state.activeTabId === id;
        let newActiveId = state.activeTabId;
        let nextSelectedExample = state.selectedExample;
        let nextSelectedPerfId = state.selectedPerformanceTabId;
        let nextRevealRevision = state.tabRevealRevision;

        if (wasRequestTabActive) {
          const adj =
            remainingOrdered[closingVisualIndex] ||
            remainingOrdered[closingVisualIndex - 1] ||
            remainingOrdered[0];
          if (!adj) {
            newActiveId = '';
            nextSelectedExample = null;
            nextSelectedPerfId = null;
          } else if (adj.kind === 'example') {
            nextSelectedExample = {
              collectionId: adj.exampleTab.collectionId,
              itemId: adj.exampleTab.itemId,
              exampleId: adj.exampleTab.exampleId,
            };
            nextSelectedPerfId = null;
            newActiveId = filteredTabs[0]?.id || '';
            nextRevealRevision += 1;
          } else if (adj.kind === 'performance') {
            nextSelectedPerfId = adj.id;
            nextSelectedExample = null;
            newActiveId = filteredTabs[0]?.id || '';
            nextRevealRevision += 1;
          } else {
            newActiveId = adj.id;
            nextSelectedExample = null;
            nextSelectedPerfId = null;
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
          selectedPerformanceTabId: nextSelectedPerfId,
          tabOrder: nextTabOrder,
          tabRevealRevision: nextRevealRevision,
          canUndoActiveRequest: newActiveId ? (tabUndoHistory[newActiveId]?.past?.length ?? 0) > 0 : false,
          canRedoActiveRequest: newActiveId ? (tabUndoHistory[newActiveId]?.future?.length ?? 0) > 0 : false,
          ...(shouldResetLoading ? { isLoading: false } : {}),
        };
      });
    },

    closeOtherTabs: (id) => {
      if (isPerformanceTabId(id)) {
        const currentPerf = (get().openPerformanceTabs || []).find((p) => p.id === id);
        if (!currentPerf) return;
        const activePerf = getActivePerformanceRun?.();
        if (activePerf && activePerf.tabId !== id) {
          void stopActivePerformanceRun?.();
        }
        const activeFunc = getActiveFunctionalRunState?.();
        if (activeFunc && activeFunc.tabId !== id) {
          void stopFunctionalRunHook?.(activeFunc.tabId);
        }
        const closingPerfTabs = (get().openPerformanceTabs || []).filter((p) => p.id !== id);
        for (const p of closingPerfTabs) {
          clearPerformanceDataRowsHook?.(p.id);
          clearFunctionalSessionHook?.(p.id);
        }
        if (refs.activeRequestOperation) {
          refs.activeRequestOperation.controller.abort();
          refs.activeRequestOperation = null;
          refs.activeRequestTabId = null;
        }
        for (const key of Object.keys(tabUndoHistory)) delete tabUndoHistory[key];
        for (const key of Object.keys(undoTypingTimers)) {
          clearTimeout(undoTypingTimers[key]);
          delete undoTypingTimers[key];
        }
        set((state) => {
          let nextPerformanceReports = state.performanceReports;
          let nextFunctionalReports = state.functionalReports;
          for (const p of state.openPerformanceTabs || []) {
            if (p.id === id) continue;
            if (p.viewingReportId && nextPerformanceReports?.[p.viewingReportId]) {
              const restPerf = { ...nextPerformanceReports };
              delete restPerf[p.viewingReportId];
              nextPerformanceReports = restPerf;
            }
            if (p.viewingFunctionalReportId && nextFunctionalReports?.[p.viewingFunctionalReportId]) {
              const restFunc = { ...nextFunctionalReports };
              delete restFunc[p.viewingFunctionalReportId];
              nextFunctionalReports = restFunc;
            }
          }
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
            openPerformanceTabs: [currentPerf],
            tabOrder: [currentPerf.id],
            selectedExample: null,
            selectedPerformanceTabId: currentPerf.id,
            performanceReports: nextPerformanceReports,
            functionalReports: nextFunctionalReports,
            tabRevealRevision: state.tabRevealRevision + 1,
            isLoading: false,
            canUndoActiveRequest: false,
            canRedoActiveRequest: false,
          };
        });
        return;
      }

      if (isExampleTabId(id)) {
        const currentExample = (get().openExampleTabs || []).find((ex) => ex.id === id);
        if (!currentExample) return;
        void stopActivePerformanceRun?.();
        clearPerformanceDataRowsHook?.();
        clearFunctionalSessionHook?.();
        void stopFunctionalRunHook?.();

        if (refs.activeRequestOperation) {
          refs.activeRequestOperation.controller.abort();
          refs.activeRequestOperation = null;
          refs.activeRequestTabId = null;
        }
        for (const key of Object.keys(tabUndoHistory)) {
          delete tabUndoHistory[key];
        }
        for (const key of Object.keys(undoTypingTimers)) {
          clearTimeout(undoTypingTimers[key]);
          delete undoTypingTimers[key];
        }

        set((state) => {
          let nextPerformanceReports = state.performanceReports;
          let nextFunctionalReports = state.functionalReports;
          for (const p of state.openPerformanceTabs || []) {
            if (p.viewingReportId && nextPerformanceReports?.[p.viewingReportId]) {
              const restPerf = { ...nextPerformanceReports };
              delete restPerf[p.viewingReportId];
              nextPerformanceReports = restPerf;
            }
            if (p.viewingFunctionalReportId && nextFunctionalReports?.[p.viewingFunctionalReportId]) {
              const restFunc = { ...nextFunctionalReports };
              delete restFunc[p.viewingFunctionalReportId];
              nextFunctionalReports = restFunc;
            }
          }
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
            openPerformanceTabs: [],
            tabOrder: [currentExample.id],
            selectedExample: {
              collectionId: currentExample.collectionId,
              itemId: currentExample.itemId,
              exampleId: currentExample.exampleId,
            },
            selectedPerformanceTabId: null,
            performanceReports: nextPerformanceReports,
            functionalReports: nextFunctionalReports,
            tabRevealRevision: state.tabRevealRevision + 1,
            isLoading: false,
            canUndoActiveRequest: false,
            canRedoActiveRequest: false,
          };
        });
        return;
      }

      void stopActivePerformanceRun?.();
      clearPerformanceDataRowsHook?.();
      clearFunctionalSessionHook?.();
      void stopFunctionalRunHook?.();
      let aborted = false;
      if (refs.activeRequestOperation && refs.activeRequestTabId && refs.activeRequestTabId !== id) {
        refs.activeRequestOperation.controller.abort();
        refs.activeRequestOperation = null;
        refs.activeRequestTabId = null;
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

        const shouldResetLoading = aborted || (state.isLoading && !refs.activeRequestOperation);

        let nextPerformanceReports = state.performanceReports;
        let nextFunctionalReports = state.functionalReports;
        for (const p of state.openPerformanceTabs || []) {
          if (p.viewingReportId && nextPerformanceReports?.[p.viewingReportId]) {
            const restPerf = { ...nextPerformanceReports };
            delete restPerf[p.viewingReportId];
            nextPerformanceReports = restPerf;
          }
          if (p.viewingFunctionalReportId && nextFunctionalReports?.[p.viewingFunctionalReportId]) {
            const restFunc = { ...nextFunctionalReports };
            delete restFunc[p.viewingFunctionalReportId];
            nextFunctionalReports = restFunc;
          }
        }

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
          openPerformanceTabs: [],
          tabOrder: [id],
          selectedExample: null,
          selectedPerformanceTabId: null,
          performanceReports: nextPerformanceReports,
          functionalReports: nextFunctionalReports,
          tabRevealRevision: state.tabRevealRevision + 1,
          canUndoActiveRequest: (tabUndoHistory[id]?.past?.length ?? 0) > 0,
          canRedoActiveRequest: (tabUndoHistory[id]?.future?.length ?? 0) > 0,
          ...(shouldResetLoading ? { isLoading: false } : {}),
        };
      });
    },

    closeAllTabs: () => {
      void stopActivePerformanceRun?.();
      clearPerformanceDataRowsHook?.();
      clearFunctionalSessionHook?.();
      void stopFunctionalRunHook?.();
      if (refs.activeRequestOperation) {
        refs.activeRequestOperation.controller.abort();
        refs.activeRequestOperation = null;
        refs.activeRequestTabId = null;
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
          openPerformanceTabs: [],
          tabOrder: [],
          selectedExample: null,
          selectedPerformanceTabId: null,
          performanceReports: {},
          functionalReports: {},
          isLoading: false,
          canUndoActiveRequest: false,
          canRedoActiveRequest: false,
        };
      });
    },

    closeTabsToRight: (id) => {
      set((state) => {
        const ordered = buildOrderedVisualTabs(state.tabs, state.openExampleTabs, state.tabOrder, state.openPerformanceTabs);
        const pivotIndex = ordered.findIndex((entry) => entry.id === id);
        if (pivotIndex === -1) return state;

        const keptEntries = ordered.slice(0, pivotIndex + 1);
        const remainingTabs = keptEntries
          .filter((entry): entry is { kind: 'request'; id: string; tab: RequestTab } => entry.kind === 'request')
          .map((entry) => entry.tab);
        const remainingExampleTabs = keptEntries
          .filter((entry): entry is { kind: 'example'; id: string; exampleTab: OpenExampleTab } => entry.kind === 'example')
          .map((entry) => entry.exampleTab);
        const remainingPerformanceTabs = keptEntries
          .filter((entry): entry is { kind: 'performance'; id: string; performanceTab: OpenPerformanceTab } => entry.kind === 'performance')
          .map((entry) => entry.performanceTab);
        const remainingOrder = keptEntries.map((entry) => entry.id);
        const remainingRequestIds = new Set(remainingTabs.map((t) => t.id));
        const remainingPerfIds = new Set(remainingPerformanceTabs.map((p) => p.id));

        const activePerf = getActivePerformanceRun?.();
        if (activePerf && !remainingPerfIds.has(activePerf.tabId)) {
          void stopActivePerformanceRun?.();
        }
        const activeFunc = getActiveFunctionalRunState?.();
        if (activeFunc && !remainingPerfIds.has(activeFunc.tabId)) {
          void stopFunctionalRunHook?.(activeFunc.tabId);
        }
        const closedPerfTabs = (state.openPerformanceTabs || []).filter((p) => !remainingPerfIds.has(p.id));
        let nextPerformanceReports = state.performanceReports;
        let nextFunctionalReports = state.functionalReports;
        const stillOpenPerfIds = new Set(remainingPerformanceTabs.map((p) => p.viewingReportId).filter(Boolean));
        const stillOpenFuncIds = new Set(remainingPerformanceTabs.map((p) => p.viewingFunctionalReportId).filter(Boolean));
        for (const p of closedPerfTabs) {
          clearPerformanceDataRowsHook?.(p.id);
          clearFunctionalSessionHook?.(p.id);
          if (p.viewingReportId && !stillOpenPerfIds.has(p.viewingReportId) && nextPerformanceReports?.[p.viewingReportId]) {
            const restPerf = { ...nextPerformanceReports };
            delete restPerf[p.viewingReportId];
            nextPerformanceReports = restPerf;
          }
          if (p.viewingFunctionalReportId && !stillOpenFuncIds.has(p.viewingFunctionalReportId) && nextFunctionalReports?.[p.viewingFunctionalReportId]) {
            const restFunc = { ...nextFunctionalReports };
            delete restFunc[p.viewingFunctionalReportId];
            nextFunctionalReports = restFunc;
          }
        }

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
        if (refs.activeRequestOperation && refs.activeRequestTabId && !remainingRequestIds.has(refs.activeRequestTabId)) {
          refs.activeRequestOperation.controller.abort();
          refs.activeRequestOperation = null;
          refs.activeRequestTabId = null;
          shouldResetLoading = true;
        }

        const currentVisualId = state.selectedPerformanceTabId
          ? state.selectedPerformanceTabId
          : state.selectedExample
            ? makeExampleTabId(state.selectedExample)
            : state.activeTabId;
        const wasCurrentVisualClosed = !keptEntries.some((entry) => entry.id === currentVisualId);
        const pivotEntry = keptEntries[pivotIndex];

        let nextActiveId = remainingRequestIds.has(state.activeTabId)
          ? state.activeTabId
          : (remainingTabs[0]?.id || '');
        let nextSelectedExample = state.selectedExample;
        let nextSelectedPerfId = state.selectedPerformanceTabId;
        let nextRevealRevision = state.tabRevealRevision;

        if (wasCurrentVisualClosed) {
          nextRevealRevision += 1;
          if (pivotEntry.kind === 'example') {
            nextSelectedExample = {
              collectionId: pivotEntry.exampleTab.collectionId,
              itemId: pivotEntry.exampleTab.itemId,
              exampleId: pivotEntry.exampleTab.exampleId,
            };
            nextSelectedPerfId = null;
          } else if (pivotEntry.kind === 'performance') {
            nextSelectedPerfId = pivotEntry.id;
            nextSelectedExample = null;
          } else {
            nextSelectedExample = null;
            nextSelectedPerfId = null;
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
          openPerformanceTabs: remainingPerformanceTabs,
          tabOrder: remainingOrder,
          performanceReports: nextPerformanceReports,
          functionalReports: nextFunctionalReports,
          selectedExample: nextSelectedExample,
          selectedPerformanceTabId: nextSelectedPerfId,
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
        const currentOrder = syncVisualTabOrder(state.tabs, state.openExampleTabs, state.tabOrder, state.openPerformanceTabs);
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
          selectedPerformanceTabId: null,
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
      refs.activeRequestOperation = operation;
      refs.activeRequestTabId = activeReq.id;
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

      let pendingResponseCleanup: { blobUrl?: string; rawBodyId?: string } | null = null;
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

          set((s) => {
            const isCurrentTab = s.activeTabId === activeReq.id;
            const tabStillExists = s.tabs.some((t) => t.id === activeReq.id);
            return {
              ...(isCurrentTab ? { activeResponse: scriptFailureResponse } : {}),
              tabResponses: tabStillExists
                ? { ...(s.tabResponses || {}), [activeReq.id]: scriptFailureResponse }
                : (s.tabResponses || {}),
              isLoading: false,
            };
          });
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
        pendingResponseCleanup = { blobUrl: response.blobUrl, rawBodyId: response.rawBodyId };
        if (!isAsyncOperationCurrent(operation)) {
          revokeBlobUrl(response.blobUrl);
          safeReleaseRawBody(response.rawBodyId);
          pendingResponseCleanup = null;
          return;
        }

        // 4. Execute Post-response script (tests, token extraction)
        let scriptError: string | undefined;
        let scriptErrorStage: ApiResponse['scriptErrorStage'];
        let postScriptTestResults: ApiResponse['testResults'];
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
            pendingResponseCleanup = null;
            return;
          }

          if (postScriptResult.testResults && postScriptResult.testResults.length > 0) {
            postScriptTestResults = postScriptResult.testResults;
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
          testResults: postScriptTestResults,
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

          pendingResponseCleanup = null;
          const nextActiveResponse = isCurrentTab ? finalResponse : s.activeResponse;
          const protectedResponses = [
            nextActiveResponse,
            ...Object.values(updatedTabResponses),
          ];
          revokeUnreferencedResponses(
            evictedHistory.map((entry) => entry.response),
            protectedResponses,
            [newHistory],
            [
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
        if (pendingResponseCleanup) {
          revokeBlobUrl(pendingResponseCleanup.blobUrl);
          safeReleaseRawBody(pendingResponseCleanup.rawBodyId);
          pendingResponseCleanup = null;
        }
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
        if (refs.activeRequestOperation === operation) {
          refs.activeRequestOperation = null;
          refs.activeRequestTabId = null;
        }
        completeAsyncOperation(operation);
      }
    },

    cancelActiveRequest: () => {
      const operation = refs.activeRequestOperation;
      if (!operation || operation.controller.signal.aborted) return;
      const targetTabId = refs.activeRequestTabId || get().activeTabId;
      operation.controller.abort();
      refs.activeRequestOperation = null;
      refs.activeRequestTabId = null;
      set((state) => {
        const isCurrentTab = state.activeTabId === targetTabId;
        const targetTabExists = state.tabs.some((tab) => tab.id === targetTabId);
        const prevTabResponse = state.tabResponses?.[targetTabId];
        const remainingTabResponses = Object.entries(state.tabResponses || {})
          .filter(([tabId]) => tabId !== targetTabId)
          .map(([, res]) => res);
        revokeUnreferencedResponses(
          [prevTabResponse, isCurrentTab ? state.activeResponse : undefined],
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
          requestUrl: state.tabs.find((tab) => tab.id === targetTabId)?.url,
          timestamp: Date.now(),
        };
        return {
          isLoading: false,
          ...(isCurrentTab ? { activeResponse: cancelledResponse } : {}),
          tabResponses: targetTabExists
            ? { ...(state.tabResponses || {}), [targetTabId]: cancelledResponse }
            : (state.tabResponses || {}),
        };
      });
    },

    openRequestInTab: (request, initialResponse) => {
      set((state) => {
        const resolvedInitialResponse = ensureResponseImageBlobUrl(initialResponse) ?? undefined;
        const targetId = request.id;
        const existingTab = targetId
          ? state.tabs.find((t) => t.id === targetId)
          : undefined;

        if (existingTab) {
          const cachedResponse = state.tabResponses?.[existingTab.id];
          const restoredResponse = ensureResponseImageBlobUrl(cachedResponse) || resolvedInitialResponse || null;
          const nextTabResponses = restoredResponse && restoredResponse !== cachedResponse
            ? { ...(state.tabResponses || {}), [existingTab.id]: restoredResponse }
            : state.tabResponses;
          return {
            activeTabId: existingTab.id,
            activeResponse: restoredResponse,
            selectedExample: null,
            selectedPerformanceTabId: null,
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

        const nextTabResponses = resolvedInitialResponse
          ? { ...(state.tabResponses || {}), [newTab.id]: resolvedInitialResponse }
          : state.tabResponses;

        return {
          tabs: [...state.tabs, newTab],
          activeTabId: newTab.id,
          activeResponse: resolvedInitialResponse || null,
          selectedExample: null,
          selectedPerformanceTabId: null,
          tabOrder: [...syncVisualTabOrder(state.tabs, state.openExampleTabs, state.tabOrder, state.openPerformanceTabs), newTab.id],
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
}
