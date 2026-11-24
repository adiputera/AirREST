import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
