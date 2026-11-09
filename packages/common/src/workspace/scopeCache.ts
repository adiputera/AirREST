import type { ActiveScope, Collection } from '../types/api';

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
  entry: (Pick<CachedScopeTabs<unknown>, 'lastSyncedAt'> & {
    collections?: Array<Pick<Collection, '_syncStatus' | '_origin' | 'version'>>;
  }) | undefined,
  ttlMs: number,
  now = Date.now(),
): boolean {
  const hasPending = entry?.collections?.some((collection) => collection._syncStatus === 'pending' ||
    (collection._origin === 'cloud' && typeof collection.version !== 'number'));
  return Boolean(entry?.lastSyncedAt && now - entry.lastSyncedAt < ttlMs && !hasPending);
}
