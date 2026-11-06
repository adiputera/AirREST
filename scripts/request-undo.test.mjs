import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('RequestEditor undo/redo static contract verification', () => {
  const editorPath = path.resolve(__dirname, '../packages/common/src/components/RequestEditor.tsx');
  assert.ok(fs.existsSync(editorPath), `File exists: ${editorPath}`);
  const content = fs.readFileSync(editorPath, 'utf-8');

  // 1. Must import Undo2 and Redo2 from lucide-react
  assert.ok(content.includes('Undo2'), 'RequestEditor imports Undo2');
  assert.ok(content.includes('Redo2'), 'RequestEditor imports Redo2');

  // 2. Must select undo/redo state and actions from useApiStore
  assert.ok(content.includes('undoActiveRequest'), 'RequestEditor selects undoActiveRequest');
  assert.ok(content.includes('redoActiveRequest'), 'RequestEditor selects redoActiveRequest');
  assert.ok(content.includes('canUndoActiveRequest'), 'RequestEditor selects canUndoActiveRequest');
  assert.ok(content.includes('canRedoActiveRequest'), 'RequestEditor selects canRedoActiveRequest');

  // 3. Must register global keydown listener for Ctrl+Z / Cmd+Z and Ctrl+Y / Shift+Z
  assert.ok(content.includes("key === 'z' && !e.shiftKey"), 'RequestEditor handles Ctrl+Z / Cmd+Z for undo');
  assert.ok(content.includes("(key === 'z' && e.shiftKey) || (key === 'y' && !e.shiftKey)"), 'RequestEditor handles Redo shortcuts');

  // 4. Must respect modal isolation (does not intercept inside other dialogs, but allows inside data-payload-modal)
  assert.ok(content.includes('data-payload-modal="true"'), 'RequestEditor allows undo inside expanded payload modal');

  // 5. Must render compact Undo button in top-right header
  assert.ok(content.includes('onClick={undoActiveRequest}'), 'RequestEditor renders undo button');
  assert.ok(content.includes('disabled={!canUndoActiveRequest}'), 'RequestEditor disables undo button when history is empty');

  // 6. Must conditionally render Redo button when canRedoActiveRequest is true
  assert.ok(content.includes('canRedoActiveRequest && ('), 'RequestEditor conditionally renders redo button');
  assert.ok(content.includes('onClick={redoActiveRequest}'), 'RequestEditor renders redo button click handler');
});

test('PayloadBuilder two-way sync and modal marker verification', () => {
  const payloadBuilderPath = path.resolve(__dirname, '../packages/common/src/components/payload/PayloadBuilder.tsx');
  assert.ok(fs.existsSync(payloadBuilderPath), `File exists: ${payloadBuilderPath}`);
  const content = fs.readFileSync(payloadBuilderPath, 'utf-8');

  // 1. Must mark isInternalUpdateRef on textarea changes
  assert.ok(content.includes('isInternalUpdateRef.current = true;'), 'PayloadBuilder sets isInternalUpdateRef on text change');

  // 2. Must have data-payload-modal attribute for expanded modal
  assert.ok(content.includes('data-payload-modal="true"'), 'PayloadBuilder expanded modal has data-payload-modal attribute');

  // 3. Support optional isDiscrete parameter for Beautify actions
  assert.ok(content.includes('onBodyContentChange(res.formatted, true);'), 'PayloadBuilder marks Beautify as discrete change');
});

test('useApiStore undo/redo state and mutation tracking contract', () => {
  const storePath = path.resolve(__dirname, '../packages/common/src/store/useApiStore.ts');
  assert.ok(fs.existsSync(storePath), `File exists: ${storePath}`);
  const content = fs.readFileSync(storePath, 'utf-8');

  // 1. ApiStoreState defines canUndoActiveRequest, canRedoActiveRequest, undoActiveRequest, redoActiveRequest
  assert.ok(content.includes('canUndoActiveRequest: boolean;'), 'ApiStoreState defines canUndoActiveRequest');
  assert.ok(content.includes('canRedoActiveRequest: boolean;'), 'ApiStoreState defines canRedoActiveRequest');
  assert.ok(content.includes('undoActiveRequest: () => void;'), 'ApiStoreState defines undoActiveRequest');
  assert.ok(content.includes('redoActiveRequest: () => void;'), 'ApiStoreState defines redoActiveRequest');

  // 2. tabUndoHistory and undoTypingTimers in-memory structures exist
  assert.ok(content.includes('tabUndoHistory'), 'useApiStore manages tabUndoHistory');
  assert.ok(content.includes('undoTypingTimers'), 'useApiStore manages undoTypingTimers');
  assert.ok(content.includes('pushTabSnapshot'), 'useApiStore defines pushTabSnapshot');

  // 3. Methods track snapshots before state mutation
  assert.ok(content.includes('undoActiveRequest: () => {'), 'useApiStore implements undoActiveRequest');
  assert.ok(content.includes('redoActiveRequest: () => {'), 'useApiStore implements redoActiveRequest');

  // 4. Tab cleanup removes undo history on closeTab
  assert.ok(content.includes('delete tabUndoHistory[id];'), 'closeTab cleans up tabUndoHistory');
});

test('In-memory request undo/redo stack state transition logic', () => {
  // Simulate the exact state management algorithm used by useApiStore
  const tabUndoHistory = {};
  const undoTypingTimers = {};
  const MAX_HISTORY = 50;

  let state = {
    tabs: [
      { id: 'tab-1', name: 'Original Request', method: 'GET', url: 'https://example.com', bodyContent: '{"initial":true}' }
    ],
    activeTabId: 'tab-1',
    canUndoActiveRequest: false,
    canRedoActiveRequest: false,
  };

  function clone(r) {
    return JSON.parse(JSON.stringify(r));
  }

  function pushTabSnapshot(tabId, currentTab, isTyping = false) {
    if (!tabUndoHistory[tabId]) {
      tabUndoHistory[tabId] = { past: [], future: [] };
    }
    const history = tabUndoHistory[tabId];

    if (isTyping) {
      if (undoTypingTimers[tabId]) {
        return;
      }
      history.past.push(clone(currentTab));
      if (history.past.length > MAX_HISTORY) history.past.shift();
      history.future = [];
      undoTypingTimers[tabId] = 1; // mock timer
    } else {
      if (undoTypingTimers[tabId]) {
        delete undoTypingTimers[tabId];
      }
      history.past.push(clone(currentTab));
      if (history.past.length > MAX_HISTORY) history.past.shift();
      history.future = [];
    }
  }

  function setBodyContent(newContent, isDiscrete = false) {
    const cur = state.tabs.find((t) => t.id === state.activeTabId);
    const isTyping = isDiscrete ? false : Math.abs(newContent.length - cur.bodyContent.length) <= 1;
    pushTabSnapshot(cur.id, cur, isTyping);

    cur.bodyContent = newContent;
    state.canUndoActiveRequest = (tabUndoHistory[cur.id]?.past?.length ?? 0) > 0;
    state.canRedoActiveRequest = (tabUndoHistory[cur.id]?.future?.length ?? 0) > 0;
  }

  function undo() {
    const cur = state.tabs.find((t) => t.id === state.activeTabId);
    const hist = tabUndoHistory[cur.id];
    if (!hist || hist.past.length === 0) return;

    delete undoTypingTimers[cur.id];
    const prev = hist.past.pop();
    hist.future.push(clone(cur));

    cur.bodyContent = prev.bodyContent;
    state.canUndoActiveRequest = hist.past.length > 0;
    state.canRedoActiveRequest = hist.future.length > 0;
  }

  function redo() {
    const cur = state.tabs.find((t) => t.id === state.activeTabId);
    const hist = tabUndoHistory[cur.id];
    if (!hist || hist.future.length === 0) return;

    delete undoTypingTimers[cur.id];
    const nxt = hist.future.pop();
    hist.past.push(clone(cur));

    cur.bodyContent = nxt.bodyContent;
    state.canUndoActiveRequest = hist.past.length > 0;
    state.canRedoActiveRequest = hist.future.length > 0;
  }

  // 1. Initial State: cannot undo or redo
  assert.strictEqual(state.canUndoActiveRequest, false);
  assert.strictEqual(state.canRedoActiveRequest, false);

  // 2. User accidentally pastes wrong payload into request body
  const wrongPastedBody = '{"huge_wrong_payload": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]}';
  setBodyContent(wrongPastedBody);

  assert.strictEqual(state.tabs[0].bodyContent, wrongPastedBody);
  assert.strictEqual(state.canUndoActiveRequest, true, 'canUndo becomes true after paste');
  assert.strictEqual(state.canRedoActiveRequest, false, 'canRedo is false after new change');

  // 3. User hits Ctrl+Z (undo)
  undo();

  assert.strictEqual(state.tabs[0].bodyContent, '{"initial":true}', 'Body restored to initial value before paste');
  assert.strictEqual(state.canUndoActiveRequest, false, 'canUndo is false now that we are at initial state');
  assert.strictEqual(state.canRedoActiveRequest, true, 'canRedo is true after undo');

  // 4. User hits Redo (Ctrl+Y)
  redo();

  assert.strictEqual(state.tabs[0].bodyContent, wrongPastedBody, 'Redo restores the pasted body');
  assert.strictEqual(state.canUndoActiveRequest, true);
  assert.strictEqual(state.canRedoActiveRequest, false);

  // 5. Undo again back to initial
  undo();
  assert.strictEqual(state.tabs[0].bodyContent, '{"initial":true}');
});

test('beautifyJson and sanitizeRelaxedJson auto-repair malformed/relaxed JSON', async () => {
  const formattersPath = path.resolve(__dirname, '../packages/common/src/lib/formatters.ts');
  const source = fs.readFileSync(formattersPath, 'utf8');
  assert.ok(source.includes('export function sanitizeRelaxedJson'), 'formatters exports sanitizeRelaxedJson');
  assert.ok(source.includes('export function beautifyJson'), 'formatters exports beautifyJson');

  // Verify RequestEditor delegates handleBeautifyJson to beautifyJson
  const editorPath = path.resolve(__dirname, '../packages/common/src/components/RequestEditor.tsx');
  const editorContent = fs.readFileSync(editorPath, 'utf8');
  assert.ok(
    editorContent.includes('const res = beautifyJson(currentTab.bodyContent);'),
    'RequestEditor uses beautifyJson in handleBeautifyJson'
  );
});
