export interface HorizontalBounds {
  left: number;
  right: number;
}

export interface TabOverflowCounts {
  left: number;
  right: number;
}

const CLIP_TOLERANCE_PX = 1;

export function getCompactTabOverflowLabel(count: number): string {
  return `${count}+`;
}

export function getTabOverflowCounts(
  viewport: HorizontalBounds,
  tabs: readonly HorizontalBounds[],
): TabOverflowCounts {
  return tabs.reduce<TabOverflowCounts>(
    (counts, tab) => ({
      left: counts.left + (tab.left < viewport.left - CLIP_TOLERANCE_PX ? 1 : 0),
      right: counts.right + (tab.right > viewport.right + CLIP_TOLERANCE_PX ? 1 : 0),
    }),
    { left: 0, right: 0 },
  );
}

export function isTabFullyVisible(
  viewport: HorizontalBounds,
  tab: HorizontalBounds,
): boolean {
  return tab.left >= viewport.left - CLIP_TOLERANCE_PX && tab.right <= viewport.right + CLIP_TOLERANCE_PX;
}

export function getTabRevealScrollLeft(
  viewport: HorizontalBounds,
  tab: HorizontalBounds,
  currentScrollLeft: number,
): number {
  const viewportWidth = viewport.right - viewport.left;
  const tabWidth = tab.right - tab.left;
  if (tabWidth > viewportWidth) {
    return currentScrollLeft + tab.left - viewport.left;
  }
  if (tab.left < viewport.left) return currentScrollLeft + tab.left - viewport.left;
  if (tab.right > viewport.right) return currentScrollLeft + tab.right - viewport.right;
  return currentScrollLeft;
}
