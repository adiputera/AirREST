export type TabCloseScope =
  | { type: 'single'; tabId: string }
  | { type: 'others'; keepTabId: string }
  | { type: 'right'; pivotTabId: string }
  | { type: 'all' };

export interface TabClosePlan<T extends { id: string }> {
  targetTabs: T[];
  cleanTabIds: string[];
  dirtyTabs: T[];
}

export interface NextDirtyTabResolution<T extends { id: string }> {
  nextTab: T | null;
  remainingTabIds: string[];
  cleanTabIdsToClose: string[];
}

/**
 * Resolves the ordered list of tabs targeted by a close action.
 *
 * @param tabs Currently open tabs in display order.
 * @param scope Close operation scope.
 * @returns Ordered tabs targeted for closing.
 */
export function getTargetTabsForClose<T extends { id: string }>(
  tabs: readonly T[],
  scope: TabCloseScope,
): T[] {
  if (scope.type === 'all') {
    return [...tabs];
  }
  if (scope.type === 'single') {
    return tabs.filter((tab) => tab.id === scope.tabId);
  }
  if (scope.type === 'others') {
    if (!tabs.some((tab) => tab.id === scope.keepTabId)) {
      return [];
    }
    return tabs.filter((tab) => tab.id !== scope.keepTabId);
  }
  const pivotIndex = tabs.findIndex((tab) => tab.id === scope.pivotTabId);
  if (pivotIndex === -1) {
    return [];
  }
  return tabs.slice(pivotIndex + 1);
}

/**
 * Partitions targeted tabs into clean tab IDs that can close immediately and dirty tabs requiring confirmation.
 *
 * @param tabs Currently open tabs in display order.
 * @param scope Close operation scope.
 * @param isDirty Predicate returning whether a tab has unsaved changes.
 * @returns Partitioned close plan preserving tab display order.
 */
export function buildTabClosePlan<T extends { id: string }>(
  tabs: readonly T[],
  scope: TabCloseScope,
  isDirty: (tab: T) => boolean,
): TabClosePlan<T> {
  const targetTabs = getTargetTabsForClose(tabs, scope);
  const cleanTabIds: string[] = [];
  const dirtyTabs: T[] = [];

  for (const tab of targetTabs) {
    if (isDirty(tab)) {
      dirtyTabs.push(tab);
    } else {
      cleanTabIds.push(tab.id);
    }
  }

  return { targetTabs, cleanTabIds, dirtyTabs };
}

/**
 * Advances through queued tab IDs using live tab state, skipping missing tabs and closing newly-clean ones.
 *
 * @param pendingTabIds Remaining queued tab IDs awaiting confirmation.
 * @param tabs Live list of open tabs.
 * @param isDirty Predicate returning whether a tab currently has unsaved changes.
 * @returns The next dirty tab to confirm, remaining queued IDs, and any clean tabs to close along the way.
 */
export function resolveNextDirtyTab<T extends { id: string }>(
  pendingTabIds: readonly string[],
  tabs: readonly T[],
  isDirty: (tab: T) => boolean,
): NextDirtyTabResolution<T> {
  const cleanTabIdsToClose: string[] = [];

  for (let index = 0; index < pendingTabIds.length; index += 1) {
    const tabId = pendingTabIds[index];
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (!tab) {
      continue;
    }
    if (!isDirty(tab)) {
      cleanTabIdsToClose.push(tab.id);
      continue;
    }
    return {
      nextTab: tab,
      remainingTabIds: pendingTabIds.slice(index + 1),
      cleanTabIdsToClose,
    };
  }

  return {
    nextTab: null,
    remainingTabIds: [],
    cleanTabIdsToClose,
  };
}

/**
 * Collects unique, existing tab IDs remaining in the current unsaved-close batch for Discard All.
 *
 * @param currentTabId Tab ID currently shown in the confirmation modal.
 * @param pendingTabIds Remaining queued tab IDs awaiting confirmation.
 * @param tabs Live list of open tabs.
 * @returns Ordered list of existing tab IDs to close without saving.
 */
export function collectRemainingTabIdsToDiscard<T extends { id: string }>(
  currentTabId: string,
  pendingTabIds: readonly string[],
  tabs: readonly T[],
): string[] {
  const openIds = new Set(tabs.map((tab) => tab.id));
  const seen = new Set<string>();
  const result: string[] = [];

  for (const id of [currentTabId, ...pendingTabIds]) {
    if (!id || seen.has(id) || !openIds.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }

  return result;
}
