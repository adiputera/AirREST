import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('App exports and implements clampRequestPaneHeight correctly', () => {
  const appContent = fs.readFileSync(
    new URL('../packages/common/src/App.tsx', import.meta.url),
    'utf8'
  );

  assert.match(appContent, /export const DEFAULT_REQUEST_PANE_HEIGHT = 320;/);
  assert.match(appContent, /export const MIN_REQUEST_PANE_HEIGHT = 150;/);
  assert.match(appContent, /export const MIN_RESPONSE_PANE_HEIGHT = 140;/);
  assert.match(appContent, /export function clampRequestPaneHeight\(/);

  const clampRequestPaneHeight = (height, containerHeight = 600) => {
    const maxAllowed = Math.max(150, containerHeight - 140);
    return Math.max(150, Math.min(maxAllowed, Math.round(height)));
  };

  // Clamps below minimum
  assert.equal(clampRequestPaneHeight(100, 600), 150);
  assert.equal(clampRequestPaneHeight(0, 600), 150);

  // Clamps above maximum allowed (600 - 140 = 460)
  assert.equal(clampRequestPaneHeight(550, 600), 460);

  // Normal value within boundaries
  assert.equal(clampRequestPaneHeight(320, 600), 320);
  assert.equal(clampRequestPaneHeight(250, 600), 250);
});

test('App has global studio split-pane resizer across Request and Response panels', () => {
  const appContent = fs.readFileSync(
    new URL('../packages/common/src/App.tsx', import.meta.url),
    'utf8'
  );

  // LocalStorage persistence key
  assert.match(appContent, /'airrest:request_pane_height'/);

  // Separator ARIA attributes and role
  assert.match(appContent, /role="separator"/);
  assert.match(appContent, /aria-orientation="horizontal"/);
  assert.match(appContent, /aria-label="Resize request and response panels"/);

  // Mouse and touch resize handlers
  assert.match(appContent, /handleStartSplitResize/);
  assert.match(appContent, /handleTouchStartSplitResize/);

  // Double-click reset to balanced ratio
  assert.match(appContent, /onDoubleClick=\{handleResetSplit\}/);

  // Keyboard navigation
  assert.match(appContent, /e\.key === 'ArrowUp'/);
  assert.match(appContent, /e\.key === 'ArrowDown'/);

  // Studio split container structure: Request pane, separator, Response pane
  assert.match(appContent, /ref=\{studioContainerRef\}/);
  assert.match(appContent, /<RequestEditor\s+(?:onCollapseChange=\{setIsRequestCollapsed\}\s*)?\/>/);
  assert.match(appContent, /<ResponseViewer \/>/);
  assert.match(appContent, /\{requestPaneHeight\}px/);

  // Dynamic collapse handling: Upper pane height shrinks to auto and resizer hides when collapsed
  assert.match(appContent, /isRequestCollapsed\s*\?\s*'auto'\s*:\s*`\$\{requestPaneHeight\}px`/);
  assert.match(appContent, /isDesktop && !isRequestCollapsed/);
});

test('RequestEditor and PayloadBuilder expand vertically to eliminate dead space during pane resize', () => {
  const requestEditorContent = fs.readFileSync(
    new URL('../packages/common/src/components/RequestEditor.tsx', import.meta.url),
    'utf8'
  );
  const payloadBuilderContent = fs.readFileSync(
    new URL('../packages/common/src/components/payload/PayloadBuilder.tsx', import.meta.url),
    'utf8'
  );

  // RequestEditor root and subtabs expand to fill parent requestPaneHeight
  assert.match(requestEditorContent, /flex-1 min-h-full border-b border-line bg-surface/);
  assert.match(requestEditorContent, /Subtab Panels[\s\S]*?flex-1 min-h-0 flex flex-col/);

  // Pre-request script textarea expands with flex-1
  assert.match(requestEditorContent, /activeTab === 'prerequest'[\s\S]*?className="w-full flex-1 min-h-\[140px\]/);

  // Post-response / tests script textarea expands with flex-1
  assert.match(requestEditorContent, /activeTab === 'tests'[\s\S]*?className="w-full flex-1 min-h-\[140px\]/);

  // Raw body and GraphQL editors expand with flex-1
  assert.match(requestEditorContent, /currentTab\.bodyType !== 'none'[\s\S]*?className="w-full flex-1 min-h-\[140px\]/);
  assert.match(requestEditorContent, /GraphQL Query & Variables Dual Editor[\s\S]*?flex-1 min-h-0 flex flex-col/);

  // PayloadBuilder raw CodeEditor fills 100% height without dead space
  assert.match(payloadBuilderContent, /flex-1 min-h-0 flex flex-col space-y-3/);
  assert.match(payloadBuilderContent, /<CodeEditor[\s\S]*?height="100%"[\s\S]*?minHeight=\{140\}[\s\S]*?className="flex-1 min-h-0"/);
});


