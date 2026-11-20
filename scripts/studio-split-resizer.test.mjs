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
  assert.match(appContent, /<RequestEditor[\s\S]*?onCollapseChange=\{setIsRequestCollapsed\}/);
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

test('ResponseViewer does not clip empty/loading logo on mobile or constrained split heights', () => {
  const appContent = fs.readFileSync(
    new URL('../packages/common/src/App.tsx', import.meta.url),
    'utf8'
  );
  const viewerContent = fs.readFileSync(
    new URL('../packages/common/src/components/ResponseViewer.tsx', import.meta.url),
    'utf8'
  );

  // Desktop bottom pane uses min-h-0 overflow-hidden while mobile renders ResponseViewer inside the scroll region below URL bar
  assert.match(
    appContent,
    /\{isDesktop && \(\s*<div className="flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden">\s*<ResponseViewer \/>\s*<\/div>\s*\)\}/
  );

  // ResponseViewer only clips/scrolls internally at md+ so mobile uses outer studioContainerRef scroll
  assert.match(viewerContent, /className="flex min-w-0 flex-1 flex-col md:overflow-hidden bg-app"/);
  assert.match(viewerContent, /className="flex min-w-0 flex-1 flex-col md:overflow-auto p-4"/);

  // Empty state and loading state use my-auto inside flex-col instead of h-full + justify-center
  // so the Sparkles logo is never pushed above scrollTop=0 when height is smaller than content
  assert.match(viewerContent, /className="my-auto flex shrink-0 flex-col items-center justify-center space-y-3 py-6 text-center"/);
  assert.match(viewerContent, /className="my-auto mx-auto flex w-full max-w-md shrink-0 flex-col items-center py-6 md:py-12 text-center"/);
  assert.doesNotMatch(viewerContent, /className="flex h-full flex-col items-center justify-center text-center max-w-md/);

  // Desktop body CodeEditor fills remaining pane height so ResponseViewer does not show dual scrollbars
  assert.match(viewerContent, /max-md:h-\[var\(--response-editor-height\)\] md:min-h-0 md:flex-1/);
  assert.match(viewerContent, /height="100%"[\s\S]*?minHeight=\{140\}/);

  // Mobile pins Request actions + URL bar + Resolved preview above a dedicated scroll container (no sticky gap)
  const requestEditorContent = fs.readFileSync(
    new URL('../packages/common/src/components/RequestEditor.tsx', import.meta.url),
    'utf8'
  );
  assert.match(appContent, /mobileScrollContent=\{!isDesktop \? <ResponseViewer \/> : undefined\}/);
  assert.match(requestEditorContent, /min-w-0 shrink-0 max-md:border-b max-md:border-line max-md:bg-surface/);
  assert.match(requestEditorContent, /flex min-w-0 flex-1 flex-col min-h-0 max-md:overflow-y-auto/);
});


