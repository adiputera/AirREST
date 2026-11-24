import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadRequestEditorSectionState() {
  const source = fs.readFileSync(
    new URL('../packages/common/src/components/requestEditorSectionState.ts', import.meta.url),
    'utf8'
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports });
  return exports;
}

test('should retain the selected editor section for each open request', () => {
  const { getRequestEditorSection, setRequestEditorSection } = loadRequestEditorSectionState();

  const requestASection = getRequestEditorSection({}, 'request-a');
  const sectionsAfterA = setRequestEditorSection({}, 'request-a', requestASection);
  const sectionsAfterB = setRequestEditorSection(sectionsAfterA, 'request-b', 'body');

  assert.equal(getRequestEditorSection(sectionsAfterB, 'request-a'), 'params');
  assert.equal(getRequestEditorSection(sectionsAfterB, 'request-b'), 'body');
});

test('should default new requests and remove closed request sections', () => {
  const { getRequestEditorSection, pruneRequestEditorSections, setRequestEditorSection } = loadRequestEditorSectionState();

  const sections = setRequestEditorSection(
    setRequestEditorSection({}, 'request-a', 'headers'),
    'request-b',
    'tests'
  );
  const remainingSections = pruneRequestEditorSections(sections, ['request-a']);

  assert.equal(getRequestEditorSection(remainingSections, 'request-a'), 'headers');
  assert.equal(getRequestEditorSection(remainingSections, 'request-b'), 'params');
  assert.equal(getRequestEditorSection(remainingSections, 'request-new'), 'params');
});

test('should move a request section when saving assigns a new request ID', () => {
  const { getRequestEditorSection, migrateRequestEditorSection, setRequestEditorSection } = loadRequestEditorSectionState();
  const beforeSave = setRequestEditorSection({}, 'draft-request', 'body');
  const afterSave = migrateRequestEditorSection(beforeSave, 'draft-request', 'saved-request');

  assert.equal(getRequestEditorSection(afterSave, 'draft-request'), 'params');
  assert.equal(getRequestEditorSection(afterSave, 'saved-request'), 'body');
});

test('should connect the editor tabs to request-scoped section state', () => {
  const source = fs.readFileSync(
    new URL('../packages/common/src/components/RequestEditor.tsx', import.meta.url),
    'utf8'
  );

  assert.match(source, /getRequestEditorSection\(sectionsByRequestId, activeTabId\)/);
  assert.match(source, /setRequestEditorSection\(sections, activeTabId, tab\)/);
  assert.match(source, /pruneRequestEditorSections\(sections, tabs\.map\(\(tab\) => tab\.id\)\)/);
  assert.match(source, /migrateRequestEditorSection/);
});

test('should resolve and queue the most relevant initial section for imported cURL requests', () => {
  const {
    getRequestEditorSection,
    pruneRequestEditorSections,
    queueInitialRequestEditorSection,
    resolveInitialCurlSection,
    setRequestEditorSection,
  } = loadRequestEditorSectionState();

  assert.equal(resolveInitialCurlSection({ method: 'POST', bodyType: 'json', bodyContent: '{"a":1}' }), 'body');
  assert.equal(
    resolveInitialCurlSection({
      method: 'GET',
      bodyType: 'none',
      params: [{ id: 'p1', key: 'page', value: '1', enabled: true }],
    }),
    'params'
  );
  assert.equal(
    resolveInitialCurlSection({
      method: 'GET',
      bodyType: 'none',
      params: [{ id: 'p0', key: '', value: '', enabled: true }],
      headers: [{ id: 'h1', key: 'X-Trace', value: '1', enabled: true }],
    }),
    'headers'
  );
  assert.equal(
    resolveInitialCurlSection({
      method: 'GET',
      bodyType: 'none',
      params: [{ id: 'p0', key: '', value: '', enabled: true }],
      headers: [{ id: 'h0', key: '', value: '', enabled: true }],
      auth: { type: 'bearer', bearerToken: 'tok' },
    }),
    'auth'
  );

  queueInitialRequestEditorSection('curl-tab-1', 'body');
  assert.equal(getRequestEditorSection({}, 'curl-tab-1'), 'body');

  const updated = setRequestEditorSection({}, 'curl-tab-1', 'headers');
  assert.equal(getRequestEditorSection(updated, 'curl-tab-1'), 'headers');

  queueInitialRequestEditorSection('curl-tab-2', 'auth');
  pruneRequestEditorSections({}, []);
  assert.equal(getRequestEditorSection({}, 'curl-tab-2'), 'params');
});
