'use client';

import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { Plus, X, Layers, ArrowRight, Trash2, Copy, MoreVertical, AlertTriangle, Bookmark } from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { MethodBadge } from './MethodBadge';
import { isRequestModified, findSavedRequestInCollections, flattenCollectionRequests } from '../lib/requestDiff';
import { useBackHandler } from '../lib/backNavigation';
import { hasScopePermission, canModifyCollection } from '../lib/jwt';
import { usePlatformAdapter } from '../context';
import { SaveToCollectionModal } from './SaveToCollectionModal';
import { ApiRequest } from '../types/api';
import {
  getCompactTabOverflowLabel,
  getTabOverflowCounts,
  getTabRevealScrollLeft,
  isTabFullyVisible,
  type TabOverflowCounts,
} from './tabBarOverflow';
import {
  buildTabClosePlan,
  collectRemainingTabIdsToDiscard,
  resolveNextDirtyTab,
  type TabCloseScope,
} from './tabBarClosePlan';
import {
  getCloseTabShortcutLabel,
  hasOpenBlockingModal,
  isApplePlatform,
  isCloseActiveTabShortcut,
} from './tabBarShortcuts';

interface ContextMenuPosition {
  x: number;
  y: number;
  tabId?: string;
}

export const TabBar: React.FC = () => {
  const tabs = useApiStore((state) => state.tabs);
  const collections = useApiStore((state) => state.collections);
  const activeTabId = useApiStore((state) => state.activeTabId);
  const selectedExample = useApiStore((state) => state.selectedExample);
  const selectSavedExample = useApiStore((state) => state.selectSavedExample);
  const tabRevealRevision = useApiStore((state) => state.tabRevealRevision);
  const setActiveTabId = useApiStore((state) => state.setActiveTabId);
  const createTab = useApiStore((state) => state.createTab);
  const closeTab = useApiStore((state) => state.closeTab);
  const closeOtherTabs = useApiStore((state) => state.closeOtherTabs);
  const closeAllTabs = useApiStore((state) => state.closeAllTabs);
  const closeTabsToRight = useApiStore((state) => state.closeTabsToRight);
  const duplicateTab = useApiStore((state) => state.duplicateTab);
  const saveRequestToCollection = useApiStore((state) => state.saveRequestToCollection);
  const isSwitchingWorkspace = useApiStore((state) => state.isSwitchingWorkspace);
  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);
  const runtimeAdapter = usePlatformAdapter();
  const isDesktopRuntime = runtimeAdapter?.platformId === 'desktop';
  const isMacPlatform = isApplePlatform();
  const closeTabShortcutLabel = getCloseTabShortcutLabel({
    isDesktop: isDesktopRuntime,
    isMac: isMacPlatform,
  });

  const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(null);
  const [unsavedConfirmTab, setUnsavedConfirmTab] = useState<ApiRequest | null>(null);
  const [closeBatchTotal, setCloseBatchTotal] = useState(0);
  const [closeBatchRemainingCount, setCloseBatchRemainingCount] = useState(0);
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [targetSaveTab, setTargetSaveTab] = useState<ApiRequest | null>(null);
  const [tabOverflow, setTabOverflow] = useState<TabOverflowCounts>({ left: 0, right: 0 });
  const pendingCloseTabIdsRef = useRef<string[]>([]);
  const saveModalCompletedRef = useRef(false);

  const clearPendingCloseQueue = useCallback(() => {
    pendingCloseTabIdsRef.current = [];
    setCloseBatchTotal(0);
    setCloseBatchRemainingCount(0);
  }, []);

  const handleCancelClose = useCallback(() => {
    clearPendingCloseQueue();
    setUnsavedConfirmTab(null);
  }, [clearPendingCloseQueue]);

  useBackHandler(Boolean(contextMenu), () => setContextMenu(null), 15);
  useBackHandler(Boolean(unsavedConfirmTab), handleCancelClose, 30);

  const menuRef = useRef<HTMLDivElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const tabViewportRef = useRef<HTMLDivElement>(null);
  const tabTrackRef = useRef<HTMLDivElement>(null);
  const tabElementRefs = useRef(new Map<string, HTMLDivElement>());
  const tabIdsRef = useRef<string[]>([]);
  const overflowFrameRef = useRef<number | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const activeTabIdRef = useRef(activeTabId);
  const activeTabWasVisibleRef = useRef(true);
  const tabOverflowRef = useRef<TabOverflowCounts>(tabOverflow);
  const pendingRevealRef = useRef(false);
  const revealPassCountRef = useRef(0);
  const visibleTabs = (tabs || []).filter(Boolean);
  const hasTabs = visibleTabs.length > 0;
  tabIdsRef.current = visibleTabs.map((tab) => tab.id);
  activeTabIdRef.current = activeTabId;
  tabOverflowRef.current = tabOverflow;
  const tabIds = visibleTabs.map((tab) => tab.id).join('|');

  const captureActiveTabVisibility = useCallback(() => {
    const viewport = tabViewportRef.current;
    const activeTab = tabElementRefs.current.get(activeTabIdRef.current);
    if (!viewport || !activeTab) return;

    const viewportBounds = viewport.getBoundingClientRect();
    const tabBounds = activeTab.getBoundingClientRect();
    activeTabWasVisibleRef.current = isTabFullyVisible(
      { left: viewportBounds.left, right: viewportBounds.right },
      { left: tabBounds.left, right: tabBounds.right },
    );
  }, []);

  const measureTabOverflow = useCallback((): boolean => {
    const viewport = tabViewportRef.current;
    if (!viewport) return false;

    const viewportBounds = viewport.getBoundingClientRect();
    const tabBounds = tabIdsRef.current
      .map((tabId) => tabElementRefs.current.get(tabId)?.getBoundingClientRect())
      .filter((bounds): bounds is DOMRect => Boolean(bounds))
      .map(({ left, right }) => ({ left, right }));
    const nextOverflow = getTabOverflowCounts(
      { left: viewportBounds.left, right: viewportBounds.right },
      tabBounds,
    );

    const current = tabOverflowRef.current;
    const changed = current.left !== nextOverflow.left || current.right !== nextOverflow.right;
    if (changed) {
      setTabOverflow(nextOverflow);
    }
    captureActiveTabVisibility();
    return changed;
  }, [captureActiveTabVisibility]);

  const scheduleTabOverflowMeasure = useCallback(() => {
    if (overflowFrameRef.current !== null) return;
    overflowFrameRef.current = window.requestAnimationFrame(() => {
      overflowFrameRef.current = null;
      measureTabOverflow();
    });
  }, [measureTabOverflow]);

  const revealActiveTab = useCallback(() => {
    const viewport = tabViewportRef.current;
    const activeTab = tabElementRefs.current.get(activeTabIdRef.current);
    if (!viewport || !activeTab) return;

    const viewportBounds = viewport.getBoundingClientRect();
    const tabBounds = activeTab.getBoundingClientRect();
    const nextScrollLeft = getTabRevealScrollLeft(
      { left: viewportBounds.left, right: viewportBounds.right },
      { left: tabBounds.left, right: tabBounds.right },
      viewport.scrollLeft,
    );

    if (nextScrollLeft !== viewport.scrollLeft) {
      viewport.scrollTo({ left: nextScrollLeft, behavior: 'auto' });
    }
    activeTabWasVisibleRef.current = true;
  }, []);

  const scheduleActiveTabRevealOnResize = useCallback(() => {
    if (resizeFrameRef.current !== null) return;
    const shouldRevealActiveTab = activeTabWasVisibleRef.current || pendingRevealRef.current;
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      if (shouldRevealActiveTab) {
        pendingRevealRef.current = true;
        revealPassCountRef.current = 0;
        revealActiveTab();
      }
      const changed = measureTabOverflow();
      if (!changed) {
        pendingRevealRef.current = false;
      }
    });
  }, [measureTabOverflow, revealActiveTab]);

  const handleTabViewportScroll = useCallback(() => {
    captureActiveTabVisibility();
    scheduleTabOverflowMeasure();
    if (contextMenu) setContextMenu(null);
  }, [captureActiveTabVisibility, contextMenu, scheduleTabOverflowMeasure]);

  const handleTabWheel = useCallback((event: WheelEvent) => {
    const viewport = tabViewportRef.current;
    if (!viewport || event.ctrlKey || event.metaKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || event.deltaY === 0) return;

    const multiplier = event.deltaMode === 1
      ? 16
      : event.deltaMode === 2
        ? viewport.clientWidth
        : 1;
    const scrollDelta = event.deltaY * multiplier;
    const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;
    const canScroll = scrollDelta < 0
      ? viewport.scrollLeft > 0
      : viewport.scrollLeft < maxScrollLeft - 1;
    if (!canScroll) return;

    pendingRevealRef.current = false;
    event.preventDefault();
    viewport.scrollBy({ left: scrollDelta, behavior: 'auto' });
  }, []);

  useEffect(() => {
    const bar = tabBarRef.current;
    const viewport = tabViewportRef.current;
    const track = tabTrackRef.current;
    if (!bar || !viewport || !track || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const shouldRevealOnResize = entries.some(
        (entry) => entry.target === bar || entry.target === track,
      );
      if (shouldRevealOnResize) {
        scheduleActiveTabRevealOnResize();
      } else {
        scheduleTabOverflowMeasure();
      }
    });
    observer.observe(bar);
    observer.observe(track);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [scheduleActiveTabRevealOnResize, scheduleTabOverflowMeasure]);

  useEffect(() => {
    const viewport = tabViewportRef.current;
    if (!viewport) return;

    viewport.addEventListener('wheel', handleTabWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleTabWheel);
  }, [handleTabWheel]);

  useEffect(() => () => {
    if (overflowFrameRef.current !== null) {
      window.cancelAnimationFrame(overflowFrameRef.current);
      overflowFrameRef.current = null;
    }
    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    pendingRevealRef.current = true;
    revealPassCountRef.current = 0;
    revealActiveTab();
    const changed = measureTabOverflow();
    if (!changed) {
      pendingRevealRef.current = false;
    }
  }, [activeTabId, tabRevealRevision, tabIds, revealActiveTab, measureTabOverflow]);

  useLayoutEffect(() => {
    if (!pendingRevealRef.current) return;
    if (revealPassCountRef.current >= 6) {
      pendingRevealRef.current = false;
      return;
    }
    revealPassCountRef.current += 1;
    revealActiveTab();
    const changed = measureTabOverflow();
    if (!changed) {
      pendingRevealRef.current = false;
    }
  }, [tabOverflow.left, tabOverflow.right, revealActiveTab, measureTabOverflow]);

  // Close context menu on click outside or Escape key
  useEffect(() => {
    if (!contextMenu) return;

    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
      }
    };

    const handleWindowBlur = () => setContextMenu(null);

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('resize', handleWindowBlur);

    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('resize', handleWindowBlur);
    };
  }, [contextMenu]);

  // Close unsaved confirm modal on Escape key and move focus into the modal
  const unsavedCancelButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!unsavedConfirmTab) return;

    unsavedCancelButtonRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleCancelClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [unsavedConfirmTab, handleCancelClose]);

  const handleTabContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const menuWidth = 200;
    const menuHeight = 220;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 10);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 10);
    setContextMenu({ x, y, tabId });
  };

  const handleBarContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const menuWidth = 200;
    const menuHeight = 110;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 10);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 10);
    setContextMenu({ x, y });
  };

  const advanceCloseQueue = useCallback(() => {
    const storeState = useApiStore.getState();
    const latestTabs = (storeState.tabs || []).filter(Boolean);
    const latestCollections = storeState.collections || [];
    const { nextTab, remainingTabIds, cleanTabIdsToClose } = resolveNextDirtyTab(
      pendingCloseTabIdsRef.current,
      latestTabs,
      (tab) => isRequestModified(tab, latestCollections),
    );

    for (const cleanId of cleanTabIdsToClose) {
      closeTab(cleanId);
    }

    if (nextTab) {
      pendingCloseTabIdsRef.current = remainingTabIds;
      setCloseBatchRemainingCount(remainingTabIds.length);
      setActiveTabId(nextTab.id);
      setUnsavedConfirmTab(nextTab);
    } else {
      clearPendingCloseQueue();
      setUnsavedConfirmTab(null);
    }
  }, [clearPendingCloseQueue, closeTab, setActiveTabId]);

  const handleRequestCloseScope = (scope: TabCloseScope) => {
    const plan = buildTabClosePlan(
      visibleTabs,
      scope,
      (tab) => isRequestModified(tab, collections),
    );
    if (plan.targetTabs.length === 0) return;

    if (plan.dirtyTabs.length === 0) {
      clearPendingCloseQueue();
      if (scope.type === 'all') {
        closeAllTabs();
      } else if (scope.type === 'others') {
        closeOtherTabs(scope.keepTabId);
      } else if (scope.type === 'right') {
        closeTabsToRight(scope.pivotTabId);
      } else {
        closeTab(scope.tabId);
      }
      return;
    }

    for (const cleanId of plan.cleanTabIds) {
      closeTab(cleanId);
    }

    // Blur any focused editor/input before opening the confirmation modal so floating
    // portals (such as autocomplete listboxes) close cleanly and input cannot leak behind the modal.
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    const [firstDirtyTab, ...remainingDirtyTabs] = plan.dirtyTabs;
    const remainingIds = remainingDirtyTabs.map((tab) => tab.id);
    pendingCloseTabIdsRef.current = remainingIds;
    setCloseBatchTotal(plan.dirtyTabs.length > 1 ? plan.dirtyTabs.length : 0);
    setCloseBatchRemainingCount(remainingIds.length);
    setActiveTabId(firstDirtyTab.id);
    setUnsavedConfirmTab(firstDirtyTab);
  };

  const handleRequestCloseTab = (tabId: string) => {
    handleRequestCloseScope({ type: 'single', tabId });
  };

  const handleRequestCloseTabRef = useRef(handleRequestCloseTab);
  handleRequestCloseTabRef.current = handleRequestCloseTab;

  const shortcutBlockedRef = useRef(false);
  shortcutBlockedRef.current = Boolean(isSwitchingWorkspace || unsavedConfirmTab || isSaveModalOpen);
  const selectedExampleRef = useRef(selectedExample);
  selectedExampleRef.current = selectedExample;
  const lastNativeCloseAtRef = useRef(0);

  // Close the active example viewer or request tab with Alt+W (all platforms) or Ctrl+W / Cmd+W (desktop)
  useEffect(() => {
    const triggerCloseActiveTab = () => {
      if (shortcutBlockedRef.current || hasOpenBlockingModal()) return false;

      if (selectedExampleRef.current) {
        selectSavedExample(null);
        return true;
      }

      const currentActiveId = activeTabIdRef.current;
      if (!currentActiveId || !tabIdsRef.current.includes(currentActiveId)) return false;

      if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      setContextMenu(null);
      handleRequestCloseTabRef.current(currentActiveId);
      return true;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const hasMacNativeMenuOwner =
        isDesktopRuntime &&
        isMacPlatform &&
        Boolean(
          (window as Window & { __AIRREST_MAC_NATIVE_CLOSE_TAB_MENU__?: boolean })
            .__AIRREST_MAC_NATIVE_CLOSE_TAB_MENU__
        );
      if (hasMacNativeMenuOwner && e.metaKey && !e.altKey) {
        return;
      }

      if (
        !isCloseActiveTabShortcut(e, {
          isDesktop: isDesktopRuntime,
          isMac: isMacPlatform,
        })
      ) {
        return;
      }

      // On native desktop, Ctrl+W / Cmd+W must always be consumed even when blocked by a modal
      // or when 0 tabs are open so the underlying WebView never handles a default window shortcut.
      if (isDesktopRuntime && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        triggerCloseActiveTab();
        return;
      }

      if (!triggerCloseActiveTab()) return;

      e.preventDefault();
      e.stopPropagation();
    };

    const handleCloseActiveTabEvent = () => {
      const now = Date.now();
      if (now - lastNativeCloseAtRef.current < 180) {
        return;
      }
      if (triggerCloseActiveTab()) {
        lastNativeCloseAtRef.current = now;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('airrest:close-active-tab', handleCloseActiveTabEvent);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('airrest:close-active-tab', handleCloseActiveTabEvent);
    };
  }, [isDesktopRuntime, isMacPlatform]);

  const handleTabAuxClick = (e: React.MouseEvent, tabId: string) => {
    // Middle click closes tab
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      handleRequestCloseTab(tabId);
    }
  };

  const handleConfirmDiscard = () => {
    if (!unsavedConfirmTab) return;
    const id = unsavedConfirmTab.id;
    setUnsavedConfirmTab(null);
    closeTab(id);
    advanceCloseQueue();
  };

  const handleConfirmDiscardAll = () => {
    if (!unsavedConfirmTab) return;
    const latestTabs = (useApiStore.getState().tabs || []).filter(Boolean);
    const idsToClose = collectRemainingTabIdsToDiscard(
      unsavedConfirmTab.id,
      pendingCloseTabIdsRef.current,
      latestTabs,
    );
    clearPendingCloseQueue();
    setUnsavedConfirmTab(null);
    for (const id of idsToClose) {
      closeTab(id);
    }
  };

  const handleConfirmSave = () => {
    if (!unsavedConfirmTab) return;
    const tabToSave = unsavedConfirmTab;

    const savedInfo = findSavedRequestInCollections(collections, tabToSave.id);
    const canWriteScope = hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role);
    const isCollectionReadOnly = savedInfo ? !canModifyCollection(savedInfo.collection.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role) : false;

    if (savedInfo && canWriteScope && !isCollectionReadOnly) {
      const currentMethod = (tabToSave.method || 'GET').toUpperCase();
      const currentName = (tabToSave.name || 'Untitled Request').trim().toLowerCase();
      const existingReqs = flattenCollectionRequests(savedInfo.collection.items || []);
      const hasCollisionWithAnother = existingReqs.some(
        (r) =>
          r.id !== tabToSave.id &&
          r.request?.id !== tabToSave.id &&
          (r.method || 'GET').toUpperCase() === currentMethod &&
          r.name.trim().toLowerCase() === currentName
      );

      if (!hasCollisionWithAnother) {
        const result = saveRequestToCollection(savedInfo.collection.id, savedInfo.folderId, tabToSave, tabToSave.id);
        if (!result.success) return;
        setUnsavedConfirmTab(null);
        closeTab(result.savedRequestId || tabToSave.id);
        advanceCloseQueue();
        return;
      }
    }

    // Opens SaveToCollectionModal for choosing collection / resolving collision / save-as
    saveModalCompletedRef.current = false;
    setTargetSaveTab(tabToSave);
    setUnsavedConfirmTab(null);
    setIsSaveModalOpen(true);
  };

  const activeContextTabIndex = contextMenu?.tabId
    ? visibleTabs.findIndex((t) => t.id === contextMenu.tabId)
    : -1;
  const isOnlyTab = visibleTabs.length <= 1;
  const isLastTab = activeContextTabIndex === visibleTabs.length - 1;

  const scrollTabsByPage = (direction: -1 | 1) => {
    const viewport = tabViewportRef.current;
    if (!viewport) return;
    pendingRevealRef.current = false;
    viewport.scrollBy({
      left: viewport.clientWidth * 0.75 * direction,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  };

  return (
    <>
      <div ref={tabBarRef} onContextMenu={handleBarContextMenu} className="flex h-8 shrink-0 w-full items-center gap-1 border-b border-line bg-surface px-2">
        {hasTabs && tabOverflow.left > 0 && (
          <button
            type="button"
            onClick={() => scrollTabsByPage(-1)}
            className="w-7 shrink-0 rounded px-0 py-1 text-center text-[10px] font-medium text-tx-muted hover:bg-hover hover:text-tx-primary sm:w-auto sm:px-1.5"
            aria-label={`Show ${tabOverflow.left} more request tab${tabOverflow.left === 1 ? '' : 's'} to the left`}
            title={`${tabOverflow.left} more tab${tabOverflow.left === 1 ? '' : 's'} to the left`}
          >
            <>
              <span className="sm:hidden">‹ {getCompactTabOverflowLabel(tabOverflow.left)}</span>
              <span className="hidden sm:inline">‹ … {tabOverflow.left} more</span>
            </>
          </button>
        )}

        <div
          ref={tabViewportRef}
          onScroll={handleTabViewportScroll}
          tabIndex={hasTabs ? 0 : undefined}
          aria-label="Open request tabs"
          className={hasTabs ? 'min-w-0 overflow-x-auto scrollbar-none' : 'hidden'}
        >
          <div ref={tabTrackRef} className="flex w-max items-center gap-1.5">
          {visibleTabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const displayName = tab.name || tab.url || 'Untitled Request';
            const isDirty = isRequestModified(tab, collections);
            const saved = findSavedRequestInCollections(collections, tab.id);
            const isDeleted = Boolean(tab.deletedFromCollection && !saved);
            const tabTitle = isDeleted
              ? `${displayName} — Deleted from ${tab.deletedFromCollection}. Save to a collection to keep this request.`
              : saved
              ? `${displayName} (${saved.collection.name})`
              : displayName;

            return (
              <div
                key={tab.id}
                ref={(element) => {
                  if (element) tabElementRefs.current.set(tab.id, element);
                  else tabElementRefs.current.delete(tab.id);
                }}
                onClick={() => setActiveTabId(tab.id)}
                onContextMenu={(e) => handleTabContextMenu(e, tab.id)}
                onAuxClick={(e) => handleTabAuxClick(e, tab.id)}
                className={`group flex shrink-0 items-center gap-1.5 max-w-[205px] cursor-pointer rounded-t-md border-t-2 px-2.5 py-1 text-xs font-medium transition-all select-none ${isActive
                    ? 'border-sky-500 bg-card text-tx-primary shadow-xs'
                    : 'border-transparent bg-element/50 text-tx-muted hover:bg-hover hover:text-tx-primary'
                  }`}
              >
                <MethodBadge method={tab.method} size="sm" />
                <span className="truncate max-w-[105px]" title={tabTitle}>
                  {displayName}
                </span>

                {isDeleted && (
                  <span
                    className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-300"
                    title={tabTitle}
                  >
                    Deleted
                  </span>
                )}

                {isDirty && (
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0 shadow-sm shadow-amber-400/50"
                    title="Unsaved changes"
                  />
                )}

                <button
                  type="button"
                  aria-label={`Actions for ${displayName}`}
                  className="rounded p-1 text-tx-muted hover:bg-hover md:hidden"
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setContextMenu({
                      x: Math.max(10, Math.min(rect.left, window.innerWidth - 210)),
                      y: Math.max(10, Math.min(rect.bottom, window.innerHeight - 230)),
                      tabId: tab.id,
                    });
                  }}
                ><MoreVertical className="h-4 w-4" /></button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRequestCloseTab(tab.id);
                  }}
                  className="ml-auto rounded p-0.5 text-tx-muted opacity-60 hover:bg-hover hover:text-tx-primary group-hover:opacity-100 transition"
                  title={isActive ? `Close tab (${closeTabShortcutLabel})` : 'Close tab'}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}

          </div>
        </div>

        {hasTabs && tabOverflow.right > 0 && (
          <button
            type="button"
            onClick={() => scrollTabsByPage(1)}
            className="w-7 shrink-0 rounded px-0 py-1 text-center text-[10px] font-medium text-tx-muted hover:bg-hover hover:text-tx-primary sm:w-auto sm:px-1.5"
            aria-label={`Show ${tabOverflow.right} more request tab${tabOverflow.right === 1 ? '' : 's'} to the right`}
            title={`${tabOverflow.right} more tab${tabOverflow.right === 1 ? '' : 's'} to the right`}
          >
            <>
              <span className="sm:hidden">{getCompactTabOverflowLabel(tabOverflow.right)} ›</span>
              <span className="hidden sm:inline">… {tabOverflow.right} more ›</span>
            </>
          </button>
        )}

        <button
          type="button"
          onClick={() => createTab()}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-tx-muted hover:bg-hover hover:text-tx-primary transition"
          title="Create New Request Tab"
          aria-label="Create New Request Tab"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Right-click Context Menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          style={{ top: contextMenu.y, left: contextMenu.x }}
          className="fixed z-50 min-w-[190px] rounded-xl border border-line bg-surface/95 p-1 shadow-2xl backdrop-blur-xl ring-1 ring-black/5 dark:ring-white/10 select-none animate-in fade-in zoom-in-95 duration-100"
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.tabId ? (
            <>
              <button
                type="button"
                onClick={() => {
                  const id = contextMenu.tabId!;
                  setContextMenu(null);
                  handleRequestCloseTab(id);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition text-left cursor-pointer"
              >
                <X className="h-3.5 w-3.5 text-tx-muted" />
                <span>Close Tab</span>
              </button>

              <button
                type="button"
                disabled={isOnlyTab}
                onClick={() => {
                  const id = contextMenu.tabId!;
                  setContextMenu(null);
                  handleRequestCloseScope({ type: 'others', keepTabId: id });
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition disabled:opacity-35 disabled:cursor-not-allowed text-left"
              >
                <Layers className="h-3.5 w-3.5 text-tx-muted" />
                <span>Close Other Tabs</span>
              </button>

              <button
                type="button"
                disabled={isLastTab}
                onClick={() => {
                  const id = contextMenu.tabId!;
                  setContextMenu(null);
                  handleRequestCloseScope({ type: 'right', pivotTabId: id });
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition disabled:opacity-35 disabled:cursor-not-allowed text-left"
              >
                <ArrowRight className="h-3.5 w-3.5 text-tx-muted" />
                <span>Close Tabs to the Right</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  handleRequestCloseScope({ type: 'all' });
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 hover:text-rose-700 dark:hover:text-rose-300 transition text-left"
              >
                <Trash2 className="h-3.5 w-3.5 text-rose-500 dark:text-rose-400/80" />
                <span>Close All Tabs</span>
              </button>

              <div className="h-px bg-line my-1 mx-1" />

              <button
                type="button"
                onClick={() => {
                  duplicateTab(contextMenu.tabId!);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition text-left"
              >
                <Copy className="h-3.5 w-3.5 text-tx-muted" />
                <span>Duplicate Tab</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  createTab();
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition text-left"
              >
                <Plus className="h-3.5 w-3.5 text-tx-muted" />
                <span>New Request Tab</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  createTab();
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition text-left"
              >
                <Plus className="h-3.5 w-3.5 text-tx-muted" />
                <span>New Request Tab</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  handleRequestCloseScope({ type: 'all' });
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 hover:text-rose-700 dark:hover:text-rose-300 transition text-left"
              >
                <Trash2 className="h-3.5 w-3.5 text-rose-500 dark:text-rose-400/80" />
                <span>Close All Tabs</span>
              </button>
            </>
          )}
        </div>
      )}

      {/* Unsaved Changes Confirmation Modal */}
      {unsavedConfirmTab && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCancelClose();
          }}
          data-modal="true"
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150 select-none"
        >
          <div
            key={unsavedConfirmTab.id}
            className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-2xl animate-in zoom-in-95 duration-150"
          >
            <div className="flex items-start gap-3.5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-500 dark:text-amber-400">
                <AlertTriangle className="h-5 w-5" />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <h3 className="text-base font-bold text-tx-primary">Unsaved Changes</h3>
                    {closeBatchTotal > 1 && (
                      <span className="inline-flex items-center rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                        {Math.min(closeBatchTotal, Math.max(1, closeBatchTotal - closeBatchRemainingCount))} of {closeBatchTotal}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={handleCancelClose}
                    className="rounded-lg p-1 text-tx-muted hover:bg-hover hover:text-tx-primary transition"
                    title="Cancel"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-2 text-xs leading-relaxed text-tx-muted">
                  Do you want to save the changes made to{' '}
                  <span className="font-semibold text-tx-primary font-mono">
                    "{unsavedConfirmTab.name || unsavedConfirmTab.url || 'Untitled Request'}"
                  </span>
                  ?
                  <p className="mt-1 text-[11px] text-tx-muted">
                    Your changes will be lost if you close this tab without saving.
                  </p>
                </div>

                {/* Tab Method & Target Preview */}
                <div className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-card/60 px-3 py-2">
                  <MethodBadge method={unsavedConfirmTab.method} size="sm" />
                  <span className="font-mono text-xs text-tx-primary truncate">
                    {unsavedConfirmTab.url || 'No URL specified'}
                  </span>
                </div>
              </div>
            </div>

            {/* Action Buttons: Cancel, Discard All (for multi-tab batch), Close Tab, Save */}
            <div className="mt-6 flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-line">
              <button
                ref={unsavedCancelButtonRef}
                type="button"
                onClick={handleCancelClose}
                className="rounded-xl border border-line bg-card px-3.5 py-2 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition cursor-pointer"
              >
                Cancel
              </button>

              {closeBatchRemainingCount > 0 && (
                <button
                  type="button"
                  onClick={handleConfirmDiscardAll}
                  className="rounded-xl border border-rose-500/40 bg-rose-500/15 px-3.5 py-2 text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-500/25 transition cursor-pointer"
                  title={`Close all ${closeBatchRemainingCount + 1} remaining unsaved tabs without saving`}
                >
                  Discard All ({closeBatchRemainingCount + 1})
                </button>
              )}

              <button
                type="button"
                onClick={handleConfirmDiscard}
                className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2 text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 transition cursor-pointer"
                title="Close tab without saving"
              >
                Close Tab
              </button>

              <button
                type="button"
                onClick={handleConfirmSave}
                className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-sky-500/20 hover:from-sky-400 hover:to-blue-500 active:scale-95 transition cursor-pointer"
                title="Save changes and close tab"
              >
                <Bookmark className="h-3.5 w-3.5" />
                <span>Save</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save to Collection Modal when saving from Tab close */}
      {targetSaveTab && (
        <SaveToCollectionModal
          isOpen={isSaveModalOpen}
          onClose={() => {
            setIsSaveModalOpen(false);
            setTargetSaveTab(null);
            if (saveModalCompletedRef.current) {
              saveModalCompletedRef.current = false;
            } else {
              clearPendingCloseQueue();
            }
          }}
          onSaved={(result) => {
            if (targetSaveTab) {
              saveModalCompletedRef.current = true;
              closeTab(result.savedRequestId || targetSaveTab.id);
              setTargetSaveTab(null);
              advanceCloseQueue();
            }
          }}
          request={targetSaveTab}
        />
      )}
    </>
  );
};
