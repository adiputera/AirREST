import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

function loadTsModule(relPath) {
  const absPath = path.resolve(__dirname, relPath);
  const source = fs.readFileSync(absPath, 'utf-8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`;
  return import(dataUrl);
}

test('Header Name Autocomplete: typing "Au" ranks Authorization first and returns common HTTP headers', async () => {
  const { getHeaderSuggestions, COMMON_HTTP_HEADERS } = await loadTsModule(
    '../packages/common/src/lib/autocomplete.ts'
  );

  assert.ok(COMMON_HTTP_HEADERS.length >= 30, 'Catalog contains comprehensive common HTTP headers');

  // 1. Typing "Au" -> Authorization is #1
  const auResults = getHeaderSuggestions('Au');
  assert.ok(auResults.length > 0, 'Returns matches for "Au"');
  assert.equal(auResults[0].label, 'Authorization');
  assert.equal(auResults[0].matchTier, 1);

  // Case-insensitive "au"
  const lowerAuResults = getHeaderSuggestions('au');
  assert.equal(lowerAuResults[0].label, 'Authorization');

  // 2. Typing "Ac" -> Accept, Accept-Language, Accept-Encoding, Accept-Charset
  const acResults = getHeaderSuggestions('Ac');
  assert.equal(acResults[0].label, 'Accept');
  assert.ok(acResults.some((item) => item.label === 'Accept-Encoding'));
  assert.ok(acResults.some((item) => item.label === 'Accept-Language'));

  // 3. Segment boundary prefix match: typing "Key" -> X-API-Key, Idempotency-Key
  const keyResults = getHeaderSuggestions('Key');
  assert.ok(keyResults.some((item) => item.label === 'X-API-Key'));
  assert.ok(keyResults.some((item) => item.label === 'Idempotency-Key'));
  const xApiKey = keyResults.find((item) => item.label === 'X-API-Key');
  assert.equal(xApiKey.matchTier, 2);

  // 4. Empty query returns top priority common headers (Authorization, Content-Type, Accept, etc.)
  const topHeaders = getHeaderSuggestions('', { limit: 5 });
  assert.equal(topHeaders.length, 5);
  assert.equal(topHeaders[0].label, 'Authorization');
  assert.equal(topHeaders[1].label, 'Content-Type');
  assert.equal(topHeaders[2].label, 'Accept');
});

test('Variable Autocomplete: typing "{{" returns active environment variables, inactive fallback, and dynamic variables', async () => {
  const { getVariableSuggestions } = await loadTsModule(
    '../packages/common/src/lib/autocomplete.ts'
  );

  const environments = [
    {
      id: 'env-prod',
      name: 'Production',
      createdAt: 1,
      updatedAt: 1,
      variables: [
        {
          id: 'v1',
          key: 'baseUrl',
          initialValue: 'https://api.example.com',
          currentValue: 'https://staging.example.com',
          enabled: true,
        },
        {
          id: 'v2',
          key: 'authToken',
          initialValue: 'secret_initial',
          currentValue: '',
          enabled: true,
        },
        {
          id: 'v3',
          key: 'disabledSecret',
          initialValue: 'should_not_appear',
          currentValue: 'should_not_appear',
          enabled: false,
        },
      ],
    },
    {
      id: 'env-dev',
      name: 'Development',
      createdAt: 1,
      updatedAt: 1,
      variables: [
        {
          id: 'v4',
          key: 'devOnlyFlag',
          initialValue: 'true',
          currentValue: 'true',
          enabled: true,
        },
      ],
    },
  ];

  // 1. Immediate trigger on "{{" (empty query)
  const allVars = getVariableSuggestions('', environments, 'env-prod');
  const varNames = allVars.map((v) => v.varName);

  // Active environment variables come first
  assert.equal(allVars[0].varName, 'authToken');
  assert.equal(allVars[0].isActiveEnv, true);
  assert.equal(allVars[0].resolvedValue, 'secret_initial');

  assert.equal(allVars[1].varName, 'baseUrl');
  assert.equal(allVars[1].isActiveEnv, true);
  assert.equal(allVars[1].resolvedValue, 'https://staging.example.com');

  // Disabled variables must be excluded
  assert.ok(!varNames.includes('disabledSecret'), 'Disabled variables are excluded');

  // Fallback variable from another workspace environment is included below active env
  const devFlag = allVars.find((v) => v.varName === 'devOnlyFlag');
  assert.ok(devFlag, 'Includes fallback variable from other workspace environment');
  assert.equal(devFlag.isActiveEnv, false);

  // Built-in dynamic variables are included
  assert.ok(varNames.includes('$guid'));
  assert.ok(varNames.includes('$timestamp'));
  assert.ok(varNames.includes('$isoTimestamp'));
  assert.ok(varNames.includes('$randomInt'));

  // 2. Filtering by prefix query (e.g. "{{ba" -> baseUrl)
  const baVars = getVariableSuggestions('ba', environments, 'env-prod');
  assert.equal(baVars.length, 1);
  assert.equal(baVars[0].varName, 'baseUrl');

  // 3. Filtering built-in dynamic variables with or without '$' (e.g. "{{gu" or "{{$gu" -> $guid)
  const guidWithoutDollar = getVariableSuggestions('gu', environments, 'env-prod');
  assert.ok(guidWithoutDollar.some((v) => v.varName === '$guid'));
  const guidWithDollar = getVariableSuggestions('$gu', environments, 'env-prod');
  assert.ok(guidWithDollar.some((v) => v.varName === '$guid'));
});

test('detectInputAutocompleteContext & applyAutocompleteSuggestion handle cursor triggers and smart "}}" closing', async () => {
  const { detectInputAutocompleteContext, applyAutocompleteSuggestion } = await loadTsModule(
    '../packages/common/src/lib/autocomplete.ts'
  );

  // 1. Typing "Au" in header-name mode
  const headerCtx = detectInputAutocompleteContext('Au', 2, 'header-name');
  assert.ok(headerCtx);
  assert.equal(headerCtx.kind, 'header');
  assert.equal(headerCtx.query, 'Au');

  const appliedHeader = applyAutocompleteSuggestion('Au', headerCtx, 'Authorization');
  assert.equal(appliedHeader.nextText, 'Authorization');
  assert.equal(appliedHeader.nextCursorPos, 'Authorization'.length);

  // 2. Typing "{{" in header-name mode automatically switches to variable autocomplete
  const headerVarCtx = detectInputAutocompleteContext('{{custom', 8, 'header-name');
  assert.ok(headerVarCtx);
  assert.equal(headerVarCtx.kind, 'variable');
  assert.equal(headerVarCtx.query, 'custom');

  // 3. Typing "{{" at the end of a URL
  const urlText = 'https://{{baseUrl}}/api/v1/{{';
  const urlCtx = detectInputAutocompleteContext(urlText, urlText.length, 'variable-only');
  assert.ok(urlCtx);
  assert.equal(urlCtx.kind, 'variable');
  assert.equal(urlCtx.query, '');
  assert.equal(urlCtx.replaceFrom, urlText.lastIndexOf('{{'));

  const appliedUrl = applyAutocompleteSuggestion(urlText, urlCtx, '{{userId}}');
  assert.equal(appliedUrl.nextText, 'https://{{baseUrl}}/api/v1/{{userId}}');
  assert.equal(appliedUrl.nextCursorPos, 'https://{{baseUrl}}/api/v1/{{userId}}'.length);

  // 4. Typing inside an auto-closed brace pair "{{to}}" (cursor after "to", before "}}") does not duplicate "}}"
  const autoPairedText = 'Bearer {{to}}';
  const cursorAfterTo = 'Bearer {{to'.length;
  const pairedCtx = detectInputAutocompleteContext(autoPairedText, cursorAfterTo, 'variable-only');
  assert.ok(pairedCtx);
  assert.equal(pairedCtx.kind, 'variable');
  assert.equal(pairedCtx.query, 'to');

  const appliedPaired = applyAutocompleteSuggestion(autoPairedText, pairedCtx, '{{token}}');
  assert.equal(appliedPaired.nextText, 'Bearer {{token}}');
  assert.equal(appliedPaired.nextCursorPos, 'Bearer {{token}}'.length);

  // 5. Cursor outside a closed variable token returns null
  const closedText = 'https://{{baseUrl}}/users';
  const outsideCtx = detectInputAutocompleteContext(closedText, closedText.length, 'variable-only');
  assert.equal(outsideCtx, null);

  // 6. Multiline JSON in CodeEditor / VariableTextarea: detects "{{" on active line
  const jsonDoc = '{\n  "url": "{{ba",\n  "count": 1\n}';
  const jsonCursor = jsonDoc.indexOf('{{ba') + 4;
  const jsonCtx = detectInputAutocompleteContext(jsonDoc, jsonCursor, 'variable-only');
  assert.ok(jsonCtx);
  assert.equal(jsonCtx.kind, 'variable');
  assert.equal(jsonCtx.query, 'ba');

  const appliedJson = applyAutocompleteSuggestion(jsonDoc, jsonCtx, 'baseUrl');
  assert.equal(appliedJson.nextText, '{\n  "url": "{{baseUrl}}",\n  "count": 1\n}');
});

test('UI Components integrate Header & Variable Autocomplete across RequestEditor, KeyValueEditor, PayloadNodeRow, and CodeEditor', () => {
  const requestEditorContent = fs.readFileSync(
    path.resolve(__dirname, '../packages/common/src/components/RequestEditor.tsx'),
    'utf-8'
  );
  const kvEditorContent = fs.readFileSync(
    path.resolve(__dirname, '../packages/common/src/components/KeyValueEditor.tsx'),
    'utf-8'
  );
  const variableInputContent = fs.readFileSync(
    path.resolve(__dirname, '../packages/common/src/components/VariableInput.tsx'),
    'utf-8'
  );
  const codeEditorContent = fs.readFileSync(
    path.resolve(__dirname, '../packages/common/src/components/editor/CodeEditor.tsx'),
    'utf-8'
  );
  const payloadRowContent = fs.readFileSync(
    path.resolve(__dirname, '../packages/common/src/components/payload/PayloadNodeRow.tsx'),
    'utf-8'
  );

  // RequestEditor passes keyAutocompleteMode="header-name" to Headers KeyValueEditor
  assert.ok(
    requestEditorContent.includes('keyAutocompleteMode="header-name"'),
    'Headers KeyValueEditor uses header-name autocomplete mode'
  );
  // RequestEditor uses VariableTextarea for multiline body / GraphQL / bulk edit
  assert.ok(
    requestEditorContent.includes('<VariableTextarea'),
    'RequestEditor uses VariableTextarea for multiline variable autocomplete'
  );
  // KeyValueEditor forwards keyAutocompleteMode to VariableInput
  assert.ok(
    kvEditorContent.includes('autocompleteMode={keyAutocompleteMode}'),
    'KeyValueEditor forwards keyAutocompleteMode to VariableInput'
  );
  // VariableInput renders AutocompletePortal
  assert.ok(
    variableInputContent.includes('<AutocompletePortal'),
    'VariableInput renders AutocompletePortal'
  );
  // CodeEditor renders AutocompletePortal and handles {{ variable triggers
  assert.ok(
    codeEditorContent.includes('<AutocompletePortal'),
    'CodeEditor renders AutocompletePortal for {{ variables'
  );
  // PayloadNodeRow uses VariableInput for builder keys and values
  assert.ok(
    payloadRowContent.includes('<VariableInput'),
    'PayloadNodeRow uses VariableInput for Visual Payload Builder fields'
  );
});

test('F06: mid-token variable completion replaces the full token without duplicating suffix or eating surrounding JSON braces', async () => {
  const { detectInputAutocompleteContext, applyAutocompleteSuggestion } = await loadTsModule(
    '../packages/common/src/lib/autocomplete.ts'
  );

  // 1. Mid-token in URL: {{ba|seUrl}}/health
  const urlInput = '{{baseUrl}}/health';
  const urlCtx = detectInputAutocompleteContext(urlInput, '{{ba'.length, 'variable-only');
  assert.ok(urlCtx);
  assert.equal(urlCtx.query, 'ba');
  assert.equal(urlCtx.replaceFrom, 0);
  assert.equal(urlCtx.replaceTo, '{{baseUrl}}'.length);
  const urlResult = applyAutocompleteSuggestion(urlInput, urlCtx, 'baseUrl');
  assert.equal(urlResult.nextText, '{{baseUrl}}/health');
  assert.equal(urlResult.nextCursorPos, '{{baseUrl}}'.length);
  assert.equal(urlResult.insertedText, '{{baseUrl}}');

  // 2. Surrounding JSON object brace: {"v":{{id|}}}
  const jsonWrap = '{"v":{{id}}}';
  const jsonWrapCtx = detectInputAutocompleteContext(jsonWrap, '{"v":{{id'.length, 'variable-only');
  assert.ok(jsonWrapCtx);
  const jsonWrapResult = applyAutocompleteSuggestion(jsonWrap, jsonWrapCtx, 'id');
  assert.equal(jsonWrapResult.nextText, '{"v":{{id}}}');
  assert.equal(jsonWrapResult.nextCursorPos, '{"v":{{id}}'.length);

  // 3. Unclosed variable inside JSON object: {"v":{{id|} must not consume outer JSON brace
  const jsonSingleClose = '{"v":{{id}';
  const jsonSingleCtx = detectInputAutocompleteContext(jsonSingleClose, '{"v":{{id'.length, 'variable-only');
  assert.ok(jsonSingleCtx);
  const jsonSingleResult = applyAutocompleteSuggestion(jsonSingleClose, jsonSingleCtx, 'id');
  assert.equal(jsonSingleResult.nextText, '{"v":{{id}}}');

  // 4. Second token on same line: {{first}} / {{sec|ond}}
  const twoTokens = '{{first}} / {{second}}';
  const secondCtx = detectInputAutocompleteContext(twoTokens, '{{first}} / {{sec'.length, 'variable-only');
  assert.ok(secondCtx);
  const secondResult = applyAutocompleteSuggestion(twoTokens, secondCtx, 'second');
  assert.equal(secondResult.nextText, '{{first}} / {{second}}');
  assert.equal(secondResult.nextCursorPos, '{{first}} / {{second}}'.length);

  // 5. CodeEditor dispatches exact replaceFrom..replaceTo range with insertedText
  const codeEditorContent = fs.readFileSync(
    path.resolve(__dirname, '../packages/common/src/components/editor/CodeEditor.tsx'),
    'utf-8'
  );
  assert.match(codeEditorContent, /from:\s*replaceFrom,\s*to:\s*replaceTo,\s*insert:\s*insertedText/);

  // 6. Real CodeMirror 6 EditorState + history() + single-step undo integration
  const { EditorState } = await import('@codemirror/state');
  const { history, undo } = await import('@codemirror/commands');

  const runCmCase = (doc, cursorOffset, suggestion, expectedAfter) => {
    let state = EditorState.create({
      doc,
      selection: { anchor: cursorOffset },
      extensions: [history()],
    });
    const ctx = detectInputAutocompleteContext(state.doc.toString(), cursorOffset, 'variable-only');
    assert.ok(ctx, `Expected context for "${doc}" at ${cursorOffset}`);
    const applied = applyAutocompleteSuggestion(state.doc.toString(), ctx, suggestion);
    state = state.update({
      changes: {
        from: applied.replaceFrom,
        to: applied.replaceTo,
        insert: applied.insertedText,
      },
      selection: { anchor: applied.nextCursorPos },
    }).state;

    assert.equal(state.doc.toString(), expectedAfter);
    assert.equal(state.selection.main.head, applied.nextCursorPos);

    // Single undo must restore exact original document
    let undoneState = state;
    const didUndo = undo({
      state: undoneState,
      dispatch(tr) {
        undoneState = undoneState.update(tr).state;
      },
    });
    assert.equal(didUndo, true);
    assert.equal(undoneState.doc.toString(), doc);
  };

  runCmCase('{{baseUrl}}/health', '{{ba'.length, 'baseUrl', '{{baseUrl}}/health');
  runCmCase('{"v":{{id}}}', '{"v":{{id'.length, 'id', '{"v":{{id}}}');
  runCmCase('{"a": "{{first}}",\n  "b": "{{sec}}"\n}', '{"a": "{{first}}",\n  "b": "{{sec'.length, 'second', '{"a": "{{first}}",\n  "b": "{{second}}"\n}');
  runCmCase('{{first}} / {{second}}', '{{first}} / {{sec'.length, 'second', '{{first}} / {{second}}');
});

test('F07: password-masked VariableInput + AutocompletePortal hides active and inactive variable values until Show is toggled', () => {
  const RealReact = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');

  const ACTIVE_SECRET = 'live-secret-token-999';
  const INACTIVE_SECRET = 'staging-secret-token-888';

  const autocompleteSrc = fs.readFileSync(
    path.resolve(__dirname, '../packages/common/src/lib/autocomplete.ts'),
    'utf-8'
  );
  const portalSrc = fs.readFileSync(
    path.resolve(__dirname, '../packages/common/src/components/AutocompletePortal.tsx'),
    'utf-8'
  );
  const varInputSrc = fs.readFileSync(
    path.resolve(__dirname, '../packages/common/src/components/VariableInput.tsx'),
    'utf-8'
  );

  const compileCjs = (src, filename) =>
    ts.transpileModule(src, {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    }).outputText;

  const states = [];
  const memos = [];
  const refs = [];
  const callbacks = [];
  let sIdx = 0;
  let mIdx = 0;
  let rIdx = 0;
  let cIdx = 0;

  const fakeReact = {
    ...RealReact,
    useId: () => 'test-id',
    useState(init) {
      const idx = sIdx++;
      if (!(idx in states)) {
        states[idx] = typeof init === 'function' ? init() : init;
      }
      const setState = (val) => {
        states[idx] = typeof val === 'function' ? val(states[idx]) : val;
      };
      return [states[idx], setState];
    },
    useMemo(fn) {
      const idx = mIdx++;
      memos[idx] = fn();
      return memos[idx];
    },
    useRef(init) {
      const idx = rIdx++;
      if (!(idx in refs)) refs[idx] = { current: init };
      return refs[idx];
    },
    useCallback(fn) {
      const idx = cIdx++;
      callbacks[idx] = fn;
      return fn;
    },
    useEffect() { },
    useLayoutEffect() { },
  };

  const mockStoreState = {
    environments: [
      {
        id: 'env-active',
        name: 'Production',
        variables: [{ id: 'v1', key: 'prodToken', initialValue: ACTIVE_SECRET, currentValue: ACTIVE_SECRET, enabled: true }],
      },
      {
        id: 'env-inactive',
        name: 'Staging',
        variables: [{ id: 'v2', key: 'stageToken', initialValue: INACTIVE_SECRET, currentValue: INACTIVE_SECRET, enabled: true }],
      },
    ],
    activeEnvironmentId: 'env-active',
  };

  const loadCjs = (code, mocks) => {
    const mod = { exports: {} };
    const fn = new Function('require', 'module', 'exports', 'window', 'document', code);
    fn(
      (id) => {
        if (id in mocks) return mocks[id];
        return require(id);
      },
      mod,
      mod.exports,
      { innerWidth: 1024, innerHeight: 768, addEventListener() { }, removeEventListener() { } },
      { body: {} }
    );
    return mod.exports;
  };

  const acMod = loadCjs(compileCjs(autocompleteSrc, 'autocomplete.ts'), {});
  let capturedPortalElement = null;
  const portalMod = loadCjs(compileCjs(portalSrc, 'AutocompletePortal.tsx'), {
    react: RealReact,
    'react-dom': {
      createPortal: (el) => {
        capturedPortalElement = el;
        return el;
      },
    },
    'lucide-react': new Proxy({}, { get: (_t, prop) => (p) => RealReact.createElement('svg', { 'data-icon': String(prop), ...p }) }),
    '../lib/autocomplete': acMod,
  });

  const varInputMod = loadCjs(compileCjs(varInputSrc, 'VariableInput.tsx'), {
    react: fakeReact,
    'react-dom': { createPortal: (el) => el },
    'lucide-react': new Proxy({}, { get: (_t, prop) => (p) => RealReact.createElement('svg', { 'data-icon': String(prop), ...p }) }),
    '../store/useApiStore': {
      useApiStore: (selector) => selector(mockStoreState),
    },
    '../lib/autocomplete': acMod,
    './AutocompletePortal': portalMod,
  });

  const renderTree = () => {
    sIdx = 0; mIdx = 0; rIdx = 0; cIdx = 0;
    return varInputMod.VariableInput({
      type: 'password',
      value: '{{',
      onChange: () => { },
    });
  };

  const findElements = (node, pred, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      node.forEach((child) => findElements(child, pred, out));
      return out;
    }
    if (pred(node)) out.push(node);
    if (node.props?.children) findElements(node.props.children, pred, out);
    return out;
  };

  const renderPortalMarkup = (props) =>
    renderToStaticMarkup(
      RealReact.createElement(portalMod.AutocompletePortal, {
        ...props,
        anchorRect: props.anchorRect || { left: 10, top: 20, bottom: 40, width: 240 },
      })
    );

  // First render: trigger onChange with '{{' to open autocomplete while masked
  let tree = renderTree();
  const inputEl = findElements(tree, (n) => n.type === 'input')[0];
  inputEl.props.onChange({ target: { value: '{{', selectionStart: 2 } });

  tree = renderTree();
  const portalCompMasked = findElements(tree, (n) => n.type === portalMod.AutocompletePortal)[0];
  assert.equal(portalCompMasked.props.isOpen, true);
  assert.equal(portalCompMasked.props.maskValues, true);

  capturedPortalElement = null;
  const maskedMarkup = renderPortalMarkup(portalCompMasked.props);
  assert.ok(!maskedMarkup.includes(ACTIVE_SECRET), 'Active variable secret must be absent when password field is masked');
  assert.ok(!maskedMarkup.includes(INACTIVE_SECRET), 'Inactive variable secret must be absent when password field is masked');
  assert.ok(maskedMarkup.includes('prodToken'), 'Variable name remains selectable when masked');
  assert.ok(maskedMarkup.includes('stageToken'), 'Inactive variable name remains selectable when masked');
  assert.ok(maskedMarkup.includes('••••••••'), 'Masked placeholder is shown');

  // Toggle Show -> values appear
  const toggleBtn = findElements(tree, (n) => n.type === 'button' && n.props['aria-label'] === 'Show value')[0];
  assert.ok(toggleBtn);
  toggleBtn.props.onClick();

  tree = renderTree();
  const portalCompShown = findElements(tree, (n) => n.type === portalMod.AutocompletePortal)[0];
  assert.equal(portalCompShown.props.isOpen, true);
  assert.equal(portalCompShown.props.maskValues, false);
  const shownMarkup = renderPortalMarkup(portalCompShown.props);
  assert.ok(shownMarkup.includes(ACTIVE_SECRET), 'Active variable value is shown after Show toggle');
  assert.ok(shownMarkup.includes(INACTIVE_SECRET), 'Inactive variable value is shown after Show toggle');

  // Toggle Hide -> values disappear again
  const hideBtn = findElements(tree, (n) => n.type === 'button' && n.props['aria-label'] === 'Hide value')[0];
  assert.ok(hideBtn);
  hideBtn.props.onClick();

  tree = renderTree();
  const portalCompReMasked = findElements(tree, (n) => n.type === portalMod.AutocompletePortal)[0];
  const reMaskedMarkup = renderPortalMarkup(portalCompReMasked.props);
  assert.ok(!reMaskedMarkup.includes(ACTIVE_SECRET), 'Active secret removed after Hide');
  assert.ok(!reMaskedMarkup.includes(INACTIVE_SECRET), 'Inactive secret removed after Hide');
});

test('A1 & A2: nested JSON/brace-aware replacement and external value sync (Undo/Tab-Switch) clearing acContext', async () => {
  const { detectInputAutocompleteContext, applyAutocompleteSuggestion } = await loadTsModule(
    '../packages/common/src/lib/autocomplete.ts'
  );

  // A2: nested JSON braces, spaces on line, strings with braces, and unclosed mid-token
  const cases = [
    ['{"outer":{"v":{{id}}', '{"outer":{"v":{{id'.length, '{{userId}}', '{"outer":{"v":{{userId}}}}'],
    ['{"outer":{"v":{{id}}}}', '{"outer":{"v":{{id'.length, '{{userId}}', '{"outer":{"v":{{userId}}}}'],
    ['Hello {{na world}}', 'Hello {{na'.length, '{{name}}', 'Hello {{name}} world}}'],
    ['{"a":"x}","v":{{id}', '{"a":"x}","v":{{id'.length, '{{id}}', '{"a":"x}","v":{{id}}}'],
    ['{{baseUrl/health', '{{ba'.length, '{{baseUrl}}', '{{baseUrl}}/health'],
    ['{"a":"{{x}"}', '{"a":"{{x'.length, '{{x}}', '{"a":"{{x}}"}'],
    ['{"v":{{id}}}', '{"v":{{id'.length, '{{userId}}', '{"v":{{userId}}}'],
    ['{"v":{{id}}', '{"v":{{id'.length, '{{userId}}', '{"v":{{userId}}}'],
  ];
  for (const [text, cursor, suggestion, expected] of cases) {
    const ctx = detectInputAutocompleteContext(text, cursor, 'variable-only');
    assert.ok(ctx, `Expected autocomplete context for ${text}`);
    const applied = applyAutocompleteSuggestion(text, ctx, suggestion);
    assert.equal(applied.nextText, expected, `Unexpected output for ${text}`);
  }

  // A1: VariableInput & VariableTextarea clear stale acContext when value changes externally (Undo / Tab Switch)
  const RealReact = require('react');
  const autocompleteSrc = fs.readFileSync(path.resolve(__dirname, '../packages/common/src/lib/autocomplete.ts'), 'utf-8');
  const portalSrc = fs.readFileSync(path.resolve(__dirname, '../packages/common/src/components/AutocompletePortal.tsx'), 'utf-8');
  const varInputSrc = fs.readFileSync(path.resolve(__dirname, '../packages/common/src/components/VariableInput.tsx'), 'utf-8');
  const varTextareaSrc = fs.readFileSync(path.resolve(__dirname, '../packages/common/src/components/VariableTextarea.tsx'), 'utf-8');
  const codeEditorSrc = fs.readFileSync(path.resolve(__dirname, '../packages/common/src/components/editor/CodeEditor.tsx'), 'utf-8');

  assert.match(codeEditorSrc, /if \(currentDoc !== value\)[\s\S]*setAcContext\(null\)/, 'CodeEditor clears acContext on external value sync');

  const compileCjs = (src, filename) =>
    ts.transpileModule(src, {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
    }).outputText;

  const makeHookRunner = (componentSrc, filename, extraMocks = {}) => {
    const states = [];
    const memos = [];
    const refs = [];
    const callbacks = [];
    const effects = [];
    let sIdx = 0; let mIdx = 0; let rIdx = 0; let cIdx = 0; let eIdx = 0;
    const depsChanged = (a, b) => !a || !b || a.length !== b.length || b.some((x, i) => !Object.is(x, a[i]));
    const fakeReact = {
      ...RealReact,
      useId: () => 'test-a1',
      useState(init) {
        const i = sIdx++;
        if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
        return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v; }];
      },
      useMemo(fn, deps) {
        const i = mIdx++;
        if (!memos[i] || depsChanged(memos[i].deps, deps)) memos[i] = { val: fn(), deps };
        return memos[i].val;
      },
      useRef(init) {
        const i = rIdx++;
        if (!(i in refs)) refs[i] = { current: init };
        return refs[i];
      },
      useCallback(fn, deps) {
        const i = cIdx++;
        if (!callbacks[i] || depsChanged(callbacks[i].deps, deps)) callbacks[i] = { fn, deps };
        return callbacks[i].fn;
      },
      useEffect(fn, deps) {
        const i = eIdx++;
        const changed = !effects[i] || depsChanged(effects[i].deps, deps);
        effects[i] = { fn, deps, cleanup: effects[i]?.cleanup, pending: changed };
      },
      useLayoutEffect() { },
    };
    const acMod = (() => {
      const m = { exports: {} };
      new Function('require', 'module', 'exports', compileCjs(autocompleteSrc, 'autocomplete.ts'))(require, m, m.exports);
      return m.exports;
    })();
    const portalMod = (() => {
      const m = { exports: {} };
      new Function('require', 'module', 'exports', compileCjs(portalSrc, 'AutocompletePortal.tsx'))((id) => {
        if (id === 'react') return RealReact;
        if (id === 'react-dom') return { createPortal: (el) => el };
        if (id === 'lucide-react') return new Proxy({}, { get: () => () => null });
        if (id === '../lib/autocomplete') return acMod;
        return require(id);
      }, m, m.exports);
      return m.exports;
    })();
    const mockStoreState = {
      environments: [{ id: 'e1', name: 'Dev', variables: [{ id: 'v1', key: 'baseUrl', initialValue: 'https://api.test', currentValue: 'https://api.test', enabled: true }] }],
      activeEnvironmentId: 'e1',
    };
    const compMod = (() => {
      const m = { exports: {} };
      new Function('require', 'module', 'exports', 'window', 'document', compileCjs(componentSrc, filename))(
        (id) => {
          if (id === 'react') return fakeReact;
          if (id === 'react-dom') return { createPortal: (el) => el };
          if (id === 'lucide-react') return new Proxy({}, { get: () => () => null });
          if (id === '../store/useApiStore') return { useApiStore: (sel) => sel(mockStoreState) };
          if (id === '../lib/autocomplete') return acMod;
          if (id === './AutocompletePortal') return portalMod;
          return extraMocks[id] ?? require(id);
        },
        m,
        m.exports,
        { innerWidth: 1024, innerHeight: 768, addEventListener() { }, removeEventListener() { } },
        { body: {} }
      );
      return m.exports;
    })();

    const render = (props) => {
      sIdx = 0; mIdx = 0; rIdx = 0; cIdx = 0; eIdx = 0;
      const Comp = compMod.VariableInput || compMod.VariableTextarea;
      const tree = Comp(props);
      for (const eff of effects) {
        if (eff?.pending) {
          eff.pending = false;
          if (typeof eff.cleanup === 'function') eff.cleanup();
          eff.cleanup = eff.fn();
        }
      }
      return { tree, portalMod };
    };
    const find = (node, pred, out = []) => {
      if (!node || typeof node !== 'object') return out;
      if (Array.isArray(node)) { node.forEach((c) => find(c, pred, out)); return out; }
      if (pred(node)) out.push(node);
      if (node.props?.children) find(node.props.children, pred, out);
      return out;
    };
    return { render, find };
  };

  // VariableInput external value change closes open autocomplete
  {
    const runner = makeHookRunner(varInputSrc, 'VariableInput.tsx');
    let currentValue = 'https://{{ba';
    const onChange = (next) => { currentValue = next; };
    let { tree, portalMod } = runner.render({ value: currentValue, onChange });
    const input = runner.find(tree, (n) => n.type === 'input')[0];
    input.props.onChange({ target: { value: 'https://{{ba', selectionStart: 12 } });
    ({ tree } = runner.render({ value: currentValue, onChange }));
    assert.equal(runner.find(tree, (n) => n.type === portalMod.AutocompletePortal)[0].props.isOpen, true);

    // Simulate external Ctrl+Z / tab switch without blur
    currentValue = 'https://api.example.com';
    ({ tree } = runner.render({ value: currentValue, onChange }));
    ({ tree } = runner.render({ value: currentValue, onChange }));
    const portalAfterExternal = runner.find(tree, (n) => n.type === portalMod.AutocompletePortal)[0];
    assert.equal(portalAfterExternal.props.isOpen, false, 'VariableInput must close stale autocomplete after external value change');
  }

  // VariableTextarea external value change closes open autocomplete
  {
    const runner = makeHookRunner(varTextareaSrc, 'VariableTextarea.tsx');
    let currentValue = 'https://{{ba';
    const onValueChange = (next) => { currentValue = next; };
    let { tree, portalMod } = runner.render({ value: currentValue, onValueChange });
    const textarea = runner.find(tree, (n) => n.type === 'textarea')[0];
    textarea.props.onChange({ defaultPrevented: false, target: { value: 'https://{{ba', selectionStart: 12 } });
    ({ tree } = runner.render({ value: currentValue, onValueChange }));
    assert.equal(runner.find(tree, (n) => n.type === portalMod.AutocompletePortal)[0].props.isOpen, true);

    currentValue = 'https://api.example.com';
    ({ tree } = runner.render({ value: currentValue, onValueChange }));
    ({ tree } = runner.render({ value: currentValue, onValueChange }));
    const portalAfterExternal = runner.find(tree, (n) => n.type === portalMod.AutocompletePortal)[0];
    assert.equal(portalAfterExternal.props.isOpen, false, 'VariableTextarea must close stale autocomplete after external value change');
  }
});

test('A3-A6: CodeEditor/PayloadBuilder Escape, Tab/Shift+Tab/Ctrl+Enter, last-win + null safety, and selection/touch guards', async () => {
  const { getVariableSuggestions } = await loadTsModule('../packages/common/src/lib/autocomplete.ts');
  const codeEditorSrc = fs.readFileSync(path.resolve(__dirname, '../packages/common/src/components/editor/CodeEditor.tsx'), 'utf-8');
  const payloadBuilderSrc = fs.readFileSync(path.resolve(__dirname, '../packages/common/src/components/payload/PayloadBuilder.tsx'), 'utf-8');
  const portalSrc = fs.readFileSync(path.resolve(__dirname, '../packages/common/src/components/AutocompletePortal.tsx'), 'utf-8');
  const varInputSrc = fs.readFileSync(path.resolve(__dirname, '../packages/common/src/components/VariableInput.tsx'), 'utf-8');
  const varTextareaSrc = fs.readFileSync(path.resolve(__dirname, '../packages/common/src/components/VariableTextarea.tsx'), 'utf-8');

  // A3: CodeEditor keymap sets stopPropagation: true and PayloadBuilder respects defaultPrevented
  assert.match(codeEditorSrc, /key: 'Escape',\s*stopPropagation: true/);
  assert.match(payloadBuilderSrc, /const handleKeyDown = \(e: KeyboardEvent\) => \{\s*if \(e\.defaultPrevented\) return;/);

  // A5: Duplicate active env variables use last-win; currentValue: null falls back to initialValue; non-string coerced safely
  const envs = [
    {
      id: 'env-a5',
      name: 'Active',
      variables: [
        { id: '1', key: 'host', initialValue: 'old.init', currentValue: 'old.cur', enabled: true },
        { id: '2', key: 'host', initialValue: 'new.init', currentValue: 'new.cur', enabled: true },
        { id: '3', key: 'nulled', initialValue: 'fallback.init', currentValue: null, enabled: true },
        { id: '4', key: 'numeric', initialValue: 12345, currentValue: undefined, enabled: true },
      ],
    },
  ];
  const hostMatches = getVariableSuggestions('host', envs, 'env-a5');
  assert.equal(hostMatches.length, 1);
  assert.equal(hostMatches[0].resolvedValue, 'new.cur', 'Duplicate variables must use last-win to match runtime');
  const nullMatches = getVariableSuggestions('nulled', envs, 'env-a5');
  assert.equal(nullMatches[0].resolvedValue, 'fallback.init', 'currentValue: null must fall back to initialValue');
  const numMatches = getVariableSuggestions('numeric', envs, 'env-a5');
  assert.equal(numMatches[0].resolvedValue, '12345', 'Non-string values must be coerced cleanly');

  // A6 static contracts: listbox tabIndex=-1, touchMoved guard, PageUp/PageDown, no CSS.escape
  assert.match(portalSrc, /role="listbox"[\s\S]*tabIndex=\{-1\}/);
  assert.match(portalSrc, /touchMovedRef/);
  assert.doesNotMatch(varInputSrc, /CSS\.escape/);
  assert.doesNotMatch(varTextareaSrc, /CSS\.escape/);
  assert.match(varTextareaSrc, /e\.key === 'PageUp' \|\|[\s\S]*e\.key === 'PageDown'/);

  // A4 & A6 behavior harness for VariableInput & VariableTextarea
  const RealReact = require('react');
  const compileCjs = (src, filename) =>
    ts.transpileModule(src, {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
    }).outputText;

  const makeRunner = (componentSrc, filename) => {
    const states = [];
    const memos = [];
    const refs = [];
    const callbacks = [];
    const effects = [];
    let sIdx = 0; let mIdx = 0; let rIdx = 0; let cIdx = 0; let eIdx = 0;
    const depsChanged = (a, b) => !a || !b || a.length !== b.length || b.some((x, i) => !Object.is(x, a[i]));
    const fakeReact = {
      ...RealReact,
      useId: () => 'test-a4-a6',
      useState(init) {
        const i = sIdx++;
        if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
        return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v; }];
      },
      useMemo(fn, deps) {
        const i = mIdx++;
        if (!memos[i] || depsChanged(memos[i].deps, deps)) memos[i] = { val: fn(), deps };
        return memos[i].val;
      },
      useRef(init) {
        const i = rIdx++;
        if (!(i in refs)) refs[i] = { current: init };
        return refs[i];
      },
      useCallback(fn, deps) {
        const i = cIdx++;
        if (!callbacks[i] || depsChanged(callbacks[i].deps, deps)) callbacks[i] = { fn, deps };
        return callbacks[i].fn;
      },
      useEffect(fn, deps) {
        const i = eIdx++;
        if (!effects[i] || depsChanged(effects[i].deps, deps)) effects[i] = { ...effects[i], fn, deps, pending: true };
      },
      useLayoutEffect(fn, deps) {
        const i = eIdx++;
        if (!effects[i] || depsChanged(effects[i].deps, deps)) effects[i] = { ...effects[i], fn, deps, pending: true };
      },
    };
    const fakeRect = { left: 10, top: 20, bottom: 44, right: 300, width: 290, height: 24 };
    refs.push = Array.prototype.push;
    const storeState = { environments: envs, activeEnvironmentId: 'env-a5' };
    const portalMod = {};
    new Function('exports', 'require', 'module', compileCjs(portalSrc, 'AutocompletePortal.tsx'))(portalMod, (spec) => {
      if (spec === 'react') return fakeReact;
      if (spec === 'react-dom') return { createPortal: (node) => node };
      if (spec === 'lucide-react') return new Proxy({}, { get: () => () => null });
      throw new Error(`Unexpected dep ${spec}`);
    }, { exports: portalMod });

    const autocompleteMod = {};
    const autocompleteSrc = fs.readFileSync(path.resolve(__dirname, '../packages/common/src/lib/autocomplete.ts'), 'utf-8');
    new Function('exports', 'require', 'module', compileCjs(autocompleteSrc, 'autocomplete.ts'))(autocompleteMod, () => ({}), { exports: autocompleteMod });

    const compMod = {};
    new Function('exports', 'require', 'module', compileCjs(componentSrc, filename))(compMod, (spec) => {
      if (spec === 'react') return fakeReact;
      if (spec === 'react-dom') return { createPortal: (node) => node };
      if (spec === 'lucide-react') return new Proxy({}, { get: () => () => null });
      if (spec.includes('useApiStore')) return { useApiStore: (sel) => sel(storeState) };
      if (spec.includes('fetcher')) return { tokenizeVariables: (v) => [{ text: v, isVariable: false }] };
      if (spec.includes('autocomplete')) return autocompleteMod;
      if (spec.includes('AutocompletePortal')) return portalMod;
      throw new Error(`Unexpected dep ${spec}`);
    }, { exports: compMod });

    const render = (props) => {
      sIdx = 0; mIdx = 0; rIdx = 0; cIdx = 0; eIdx = 0;
      const Comp = compMod.VariableInput || compMod.VariableTextarea;
      const tree = Comp(props);
      // Bind DOM-like getBoundingClientRect onto input/textarea/wrapper refs after first render
      refs.forEach((r) => {
        if (r.current === null) {
          r.current = { getBoundingClientRect: () => fakeRect, scrollLeft: 0, scrollTop: 0, value: props.value || '', selectionStart: 0 };
        }
      });
      for (const eff of effects) {
        if (eff?.pending) {
          eff.pending = false;
          if (typeof eff.cleanup === 'function') eff.cleanup();
          eff.cleanup = eff.fn();
        }
      }
      return { tree, portalMod };
    };
    const find = (node, pred, out = []) => {
      if (!node || typeof node !== 'object') return out;
      if (Array.isArray(node)) { node.forEach((c) => find(c, pred, out)); return out; }
      if (pred(node)) out.push(node);
      if (node.props?.children) find(node.props.children, pred, out);
      return out;
    };
    return { render, find };
  };

  // Header mode: typing custom "Token" + Tab (un-navigated) keeps "Token" without preventDefault
  const origWin = globalThis.window;
  globalThis.window = { innerWidth: 1024, innerHeight: 768, addEventListener() { }, removeEventListener() { } };
  try {
    const runner = makeRunner(varInputSrc, 'VariableInput.tsx');
    let headerVal = 'Token';
    const onChange = (next) => { headerVal = next; };
    let { tree, portalMod } = runner.render({ value: '', onChange, autocompleteMode: 'header-name' });
    runner.find(tree, (n) => n.type === 'input')[0].props.onChange({ target: { value: 'Token', selectionStart: 5, selectionEnd: 5 } });
    ({ tree } = runner.render({ value: headerVal, onChange, autocompleteMode: 'header-name' }));
    assert.equal(runner.find(tree, (n) => n.type === portalMod.AutocompletePortal)[0].props.isOpen, true);

    let tabPrevented = false;
    runner.find(tree, (n) => n.type === 'input')[0].props.onKeyDown({
      key: 'Tab', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
      preventDefault: () => { tabPrevented = true; }, stopPropagation: () => { },
    });
    assert.equal(tabPrevented, false, 'Un-navigated Tab in header-name mode must allow focus move');
    assert.equal(headerVal, 'Token', 'Custom header name must not be overwritten');

    // Selecting non-empty range suppresses autocomplete (A6)
    runner.find(tree, (n) => n.type === 'input')[0].props.onClick({
      currentTarget: { value: '{{ho', selectionStart: 1, selectionEnd: 4 },
    });
    ({ tree } = runner.render({ value: '{{ho', onChange, autocompleteMode: 'variable-only' }));
    assert.equal(runner.find(tree, (n) => n.type === portalMod.AutocompletePortal)[0].props.isOpen, false);

    // Variable mode: Shift+Tab & Ctrl+Enter do not trigger completion (A4)
    runner.find(tree, (n) => n.type === 'input')[0].props.onChange({ target: { value: '{{ho', selectionStart: 4, selectionEnd: 4 } });
    ({ tree } = runner.render({ value: '{{ho', onChange, autocompleteMode: 'variable-only' }));
    assert.equal(runner.find(tree, (n) => n.type === portalMod.AutocompletePortal)[0].props.isOpen, true);
    let ctrlEnterPrevented = false;
    runner.find(tree, (n) => n.type === 'input')[0].props.onKeyDown({
      key: 'Enter', shiftKey: false, ctrlKey: true, metaKey: false, altKey: false,
      preventDefault: () => { ctrlEnterPrevented = true; }, stopPropagation: () => { },
    });
    assert.equal(ctrlEnterPrevented, false, 'Ctrl+Enter must not be swallowed by autocomplete');

    // A7 (P3): autocompleteMode === 'none' blocks Ctrl+Space and keeps portal closed
    ({ tree } = runner.render({ value: '{{ho', onChange, autocompleteMode: 'none' }));
    assert.equal(runner.find(tree, (n) => n.type === portalMod.AutocompletePortal)[0].props.isOpen, false);

    // A-R4 & A-R5: IME composition (isComposing / keyCode 229) and onSelect non-empty selection
    ({ tree } = runner.render({ value: '{{ho', onChange, autocompleteMode: 'variable-only' }));
    runner.find(tree, (n) => n.type === 'input')[0].props.onChange({ target: { value: '{{ho', selectionStart: 4, selectionEnd: 4 } });
    ({ tree } = runner.render({ value: '{{ho', onChange, autocompleteMode: 'variable-only' }));
    assert.equal(runner.find(tree, (n) => n.type === portalMod.AutocompletePortal)[0].props.isOpen, true);

    let imeEnterPrevented = false;
    runner.find(tree, (n) => n.type === 'input')[0].props.onKeyDown({
      key: 'Enter',
      keyCode: 229,
      nativeEvent: { isComposing: true },
      preventDefault: () => { imeEnterPrevented = true; },
      stopPropagation: () => { },
    });
    assert.equal(imeEnterPrevented, false, 'IME composing Enter must not be intercepted by autocomplete');

    // Ctrl+A / drag selection triggers onSelect with non-empty range -> dismisses popup
    runner.find(tree, (n) => n.type === 'input')[0].props.onSelect({
      currentTarget: { value: '{{ho', selectionStart: 0, selectionEnd: 4 },
    });
    ({ tree } = runner.render({ value: '{{ho', onChange, autocompleteMode: 'variable-only' }));
    assert.equal(runner.find(tree, (n) => n.type === portalMod.AutocompletePortal)[0].props.isOpen, false, 'Non-empty onSelect must close autocomplete');

    // A-R2: AutocompletePortal onBlur dismisses when focus leaves the listbox
    let dismissed = false;
    const origDoc = globalThis.document;
    globalThis.document = {};
    try {
      const portalTree = portalMod.AutocompletePortal({
        isOpen: true,
        items: hostMatches,
        activeIndex: 0,
        onSelectIndex: () => { },
        onHighlightIndex: () => { },
        onDismiss: () => { dismissed = true; },
        anchorRect: { left: 10, top: 20, bottom: 44, width: 200 },
        query: 'ho',
        kind: 'variable',
      });
      assert.ok(portalTree);
      portalTree.props.onBlur({ relatedTarget: null });
      assert.equal(dismissed, true, 'AutocompletePortal blur outside listbox must call onDismiss');

      // A-R8: AutocompletePortal clamps maxWidth to viewportWidth - left - 8
      globalThis.window.innerWidth = 800;
      const clampedTree = portalMod.AutocompletePortal({
        isOpen: true,
        items: hostMatches,
        activeIndex: 0,
        onSelectIndex: () => { },
        onHighlightIndex: () => { },
        anchorRect: { left: 500, top: 20, bottom: 44, width: 120 },
        query: 'ho',
        kind: 'variable',
      });
      assert.ok(clampedTree);
      assert.equal(clampedTree.props.style.left, '500px');
      assert.equal(clampedTree.props.style.maxWidth, '292px');
    } finally {
      globalThis.document = origDoc;
    }
  } finally {
    globalThis.window = origWin;
  }

  // A7 (P3) & A-R1/A-R3: CodeEditor ARIA combobox, blur relatedTarget guard, and null anchorRect guard
  const codeEditorAriaSrc = fs.readFileSync(path.resolve(__dirname, '../packages/common/src/components/editor/CodeEditor.tsx'), 'utf-8');
  assert.match(codeEditorAriaSrc, /ariaCompartmentRef/);
  assert.match(codeEditorAriaSrc, /EditorView\.contentAttributes\.of/);
  assert.match(codeEditorAriaSrc, /role:\s*'combobox'/);
  assert.match(codeEditorAriaSrc, /'aria-autocomplete':\s*'list'/);
  assert.match(codeEditorAriaSrc, /acContext && acAnchorRect && acSuggestions\.length > 0/);
  assert.match(codeEditorAriaSrc, /listboxEl\?\.contains\(related\)/);
  assert.match(codeEditorAriaSrc, /if \(!rect\) \{\s*setAcContext\(null\);\s*setAcAnchorRect\(null\);/);
  assert.equal(varInputSrc.includes('CSS.escape'), false, 'VariableInput must not depend on CSS.escape');
  assert.match(varInputSrc, /autocompleteMode\s*!==\s*'none'/);

  // A-R6..A-R9: padded brace replacement, VariableTextarea/CodeEditor Ctrl+Space + Ctrl+Enter, viewport-clamped portal width, dynamic var precedence
  const {
    detectInputAutocompleteContext: detectPaddedCtx,
    applyAutocompleteSuggestion: applyPaddedSuggestion,
    getVariableSuggestions: getVarSuggestionsR9,
  } = await loadTsModule(
    '../packages/common/src/lib/autocomplete.ts',
  );
  // A-R6: padded `{{ ba|seUrl }}` replaces closing ` }}` cleanly without leaving dangling braces
  const paddedText = 'https://example.com/{{ ba }}';
  const paddedCtx = detectPaddedCtx(paddedText, 'https://example.com/{{ ba'.length, 'variable-only');
  assert.ok(paddedCtx);
  assert.equal(paddedCtx.kind, 'variable');
  assert.equal(paddedCtx.replaceTo, paddedText.length);
  const paddedApplied = applyPaddedSuggestion(paddedText, paddedCtx, 'baseUrl');
  assert.equal(paddedApplied.nextText, 'https://example.com/{{baseUrl}}');

  // A-R9: user env defining $guid does not shadow built-in dynamic $guid
  const shadowedVars = getVarSuggestionsR9(
    '',
    [
      {
        id: 'env-1',
        name: 'Custom',
        createdAt: 1,
        updatedAt: 1,
        variables: [
          { id: 'v-guid', key: '$guid', initialValue: 'custom', currentValue: 'custom', enabled: true },
          { id: 'v-host', key: 'host', initialValue: 'a.test', currentValue: 'a.test', enabled: true },
        ],
      },
    ],
    'env-1',
  );
  const guidItems = shadowedVars.filter((item) => item.varName === '$guid');
  assert.equal(guidItems.length, 1);
  assert.equal(guidItems[0].isBuiltin, true);

  // A-R7: VariableTextarea supports Ctrl+Space manual trigger and CodeEditor dismisses popup on Ctrl+Enter / Mod-Enter without consuming send
  const varTextareaSrcR7 = fs.readFileSync(
    path.resolve(__dirname, '../packages/common/src/components/VariableTextarea.tsx'),
    'utf-8',
  );
  assert.match(varTextareaSrcR7, /e\.ctrlKey && !e\.altKey && !e\.metaKey && e\.key === ' '/);
  assert.match(codeEditorAriaSrc, /key:\s*'Mod-Enter'/);
  assert.match(codeEditorAriaSrc, /key:\s*'Ctrl-Enter'/);
});
