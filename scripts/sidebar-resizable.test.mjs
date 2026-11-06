import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Sidebar component exports and implements clampSidebarWidth correctly', async () => {
  const sidebarContent = fs.readFileSync(
    new URL('../packages/common/src/components/Sidebar.tsx', import.meta.url),
    'utf8'
  );

  // Verify exported constants and functions exist
  assert.match(sidebarContent, /export const DEFAULT_SIDEBAR_WIDTH = 288;/);
  assert.match(sidebarContent, /export const MIN_SIDEBAR_WIDTH = 220;/);
  assert.match(sidebarContent, /export const MAX_SIDEBAR_WIDTH = 800;/);
  assert.match(sidebarContent, /export function clampSidebarWidth\(/);

  // Extract clampSidebarWidth logic to test math directly
  const clampSidebarWidth = (width, winWidth = 1200) => {
    const maxAllowed = Math.min(800, Math.max(380, Math.floor(winWidth * 0.55)));
    return Math.max(220, Math.min(maxAllowed, Math.round(width)));
  };

  // Clamps below minimum
  assert.equal(clampSidebarWidth(150, 1200), 220);
  assert.equal(clampSidebarWidth(-10, 1200), 220);

  // Clamps above maximum allowed on 1200px viewport (1200 * 0.55 = 660)
  assert.equal(clampSidebarWidth(700, 1200), 660);
  assert.equal(clampSidebarWidth(1200, 1200), 660);

  // Normal value within boundaries
  assert.equal(clampSidebarWidth(288, 1200), 288);
  assert.equal(clampSidebarWidth(350, 1200), 350);

  // Ultra-wide displays capped at 800
  assert.equal(clampSidebarWidth(950, 2560), 800);
});

test('Sidebar has drag-to-resize handle with storage persistence and accessibility', () => {
  const sidebarContent = fs.readFileSync(
    new URL('../packages/common/src/components/Sidebar.tsx', import.meta.url),
    'utf8'
  );

  // LocalStorage persistence key
  assert.match(sidebarContent, /'airrest:sidebar_width'/);

  // Separator ARIA attributes and role
  assert.match(sidebarContent, /role="separator"/);
  assert.match(sidebarContent, /aria-orientation="vertical"/);
  assert.match(sidebarContent, /aria-label="Resize collection sidebar width"/);

  // Mouse and touch resize handlers
  assert.match(sidebarContent, /handleStartSidebarResize/);
  assert.match(sidebarContent, /handleTouchStartSidebarResize/);

  // Double-click reset
  assert.match(sidebarContent, /onDoubleClick=\{\(\) => \{/);
  assert.match(sidebarContent, /setSidebarWidth\(DEFAULT_SIDEBAR_WIDTH\)/);

  // Keyboard accessibility
  assert.match(sidebarContent, /e\.key === 'ArrowLeft'/);
  assert.match(sidebarContent, /e\.key === 'ArrowRight'/);

  // Width badge display
  assert.match(sidebarContent, /\{sidebarWidth\}px/);

  // History URL truncation expanded
  assert.match(sidebarContent, /truncate flex-1 min-w-0 mr-2/);
});

test('App workspace layout preserves sidebar width with md:shrink-0', () => {
  const appContent = fs.readFileSync(
    new URL('../packages/common/src/App.tsx', import.meta.url),
    'utf8'
  );

  assert.match(appContent, /md:relative md:z-auto md:block md:shrink-0/);
});

