import type { ActiveScope } from '../types/api';

export interface CachedScopeTabs<TTab> {
  tabs?: TTab[];
  activeTabId?: string;
  lastSyncedAt?: number | null;
}

export function getScopeCacheKey(scope?: ActiveScope | null): string {
  if (!scope?.id) return 'default';
  return `${scope.type}:${scope.id}`;
}

export function resolveCachedScopeTabs<TTab extends { id: string }>(
  entry: CachedScopeTabs<TTab> | undefined,
  createInitialTab: () => TTab,
): { tabs: TTab[]; activeTabId: string } {
  const tabs = entry?.tabs && entry.tabs.length > 0 ? entry.tabs : [createInitialTab()];
  const activeTabId = entry?.activeTabId && tabs.some((tab) => tab.id === entry.activeTabId)
    ? entry.activeTabId
    : tabs[0].id;
  return { tabs, activeTabId };
}

export function isScopeCacheFresh(
  entry: Pick<CachedScopeTabs<unknown>, 'lastSyncedAt'> | undefined,
  ttlMs: number,
  now = Date.now(),
): boolean {
  return Boolean(entry?.lastSyncedAt && now - entry.lastSyncedAt < ttlMs);
}
