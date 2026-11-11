import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('CodeEditor component contract and CodeMirror 6 extensions', () => {
  const codeEditorPath = path.resolve(__dirname, '../packages/common/src/components/editor/CodeEditor.tsx');
  assert.ok(fs.existsSync(codeEditorPath), `File exists: ${codeEditorPath}`);
  const content = fs.readFileSync(codeEditorPath, 'utf-8');

  // 1. Must import CodeMirror 6 core extensions
  assert.ok(content.includes("lineNumbers"), 'CodeEditor imports lineNumbers');
  assert.ok(content.includes("foldGutter"), 'CodeEditor imports foldGutter');
  assert.ok(content.includes("foldAll"), 'CodeEditor imports foldAll');
  assert.ok(content.includes("unfoldAll"), 'CodeEditor imports unfoldAll');
  assert.ok(content.includes("json"), 'CodeEditor imports json language');
  assert.ok(content.includes("xml"), 'CodeEditor imports xml language');

  // 2. Must expose imperative handle with foldAll and unfoldAll
  assert.ok(content.includes("export interface CodeEditorHandle"), 'CodeEditor defines CodeEditorHandle');
  assert.ok(content.includes("foldAll: () =>"), 'CodeEditorHandle has foldAll');
  assert.ok(content.includes("unfoldAll: () =>"), 'CodeEditorHandle has unfoldAll');

  // 3. Must use fold marker with minus (-) and plus (+) characters
  assert.ok(content.includes("span.textContent = open ? '−' : '+'"), 'CodeEditor uses minus and plus fold markers');

  // 4. Must define darkHighlightStyle with high-contrast yellow strings (#facc15)
  assert.ok(content.includes("darkHighlightStyle"), 'CodeEditor defines darkHighlightStyle');
  assert.ok(content.includes("#facc15"), 'CodeEditor uses yellow (#facc15) for high-contrast dark strings');
});

test('PayloadBuilder integrates CodeEditor with line numbers and folding', () => {
  const builderPath = path.resolve(__dirname, '../packages/common/src/components/payload/PayloadBuilder.tsx');
  assert.ok(fs.existsSync(builderPath), `File exists: ${builderPath}`);
  const content = fs.readFileSync(builderPath, 'utf-8');

  // 1. Must import CodeEditor and CodeEditorHandle
  assert.ok(content.includes("import { CodeEditor, CodeEditorHandle } from '../editor/CodeEditor'"), 'PayloadBuilder imports CodeEditor');

  // 2. Must render CodeEditor in renderRawView
  assert.ok(content.includes("<CodeEditor"), 'PayloadBuilder renders CodeEditor');
  assert.ok(content.includes("language={format}"), 'PayloadBuilder passes language format to CodeEditor');
  assert.ok(content.includes('historyMode="external"'), 'PayloadBuilder delegates body undo history to the request store');
  assert.ok(content.includes('onUndo={onUndo}'), 'PayloadBuilder forwards undo to CodeEditor');
  assert.ok(content.includes('onRedo={onRedo}'), 'PayloadBuilder forwards redo to CodeEditor');

  // 3. Must render Collapse All and Expand All toolbar buttons
  assert.ok(content.includes("Collapse All"), 'PayloadBuilder has Collapse All button');
  assert.ok(content.includes("Expand All"), 'PayloadBuilder has Expand All button');
  assert.ok(content.includes("foldAll()"), 'PayloadBuilder calls foldAll');
  assert.ok(content.includes("unfoldAll()"), 'PayloadBuilder calls unfoldAll');
});

test('CodeEditor supports JSON comments and external undo ownership', () => {
  const codeEditorPath = path.resolve(__dirname, '../packages/common/src/components/editor/CodeEditor.tsx');
  const content = fs.readFileSync(codeEditorPath, 'utf-8');

  assert.ok(content.includes('jsonLanguage.data.of'), 'CodeEditor adds JSON language data');
  assert.ok(content.includes("line: '//'"), 'CodeEditor declares line comment syntax');
  assert.ok(content.includes("open: '/*', close: '*/'"), 'CodeEditor declares block comment syntax');
  assert.ok(content.includes("historyMode?: 'editor' | 'external'"), 'CodeEditor exposes explicit history ownership');
  assert.ok(content.includes('externalValueSync'), 'CodeEditor marks external value synchronization');
  assert.ok(content.includes('stopPropagation: true'), 'External undo shortcut does not reach global handlers');
  assert.ok(content.includes('toggleComment(view)'), 'JSON comments use CodeMirror command support');
  assert.ok(content.includes('isDiscreteChangeRef'), 'Comment toggles are stored as discrete request history entries');
});

test('ResponseViewer integrates CodeEditor for body response inspection with folding', () => {
  const viewerPath = path.resolve(__dirname, '../packages/common/src/components/ResponseViewer.tsx');
  assert.ok(fs.existsSync(viewerPath), `File exists: ${viewerPath}`);
  const content = fs.readFileSync(viewerPath, 'utf-8');

  // 1. Must import CodeEditor and CodeEditorHandle
  assert.ok(content.includes("import { CodeEditor, CodeEditorHandle } from './editor/CodeEditor'"), 'ResponseViewer imports CodeEditor');

  // 2. Must render CodeEditor for response body
  assert.ok(content.includes("<CodeEditor"), 'ResponseViewer renders CodeEditor');
  assert.ok(content.includes("readOnly={true}"), 'ResponseViewer renders CodeEditor as readOnly');

  // 3. Must render Collapse All and Expand All buttons
  assert.ok(content.includes("Collapse All"), 'ResponseViewer has Collapse All button');
  assert.ok(content.includes("Expand All"), 'ResponseViewer has Expand All button');
  assert.ok(content.includes("responseEditorRef.current?.foldAll()"), 'ResponseViewer triggers foldAll on editor ref');
  assert.ok(content.includes("responseEditorRef.current?.unfoldAll()"), 'ResponseViewer triggers unfoldAll on editor ref');
});
