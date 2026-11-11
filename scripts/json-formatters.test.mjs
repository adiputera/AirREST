import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadFormatters() {
  const source = fs.readFileSync(new URL('../packages/common/src/lib/formatters.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, JSON, RegExp }, { filename: 'formatters.ts' });
  return exports;
}

const { beautifyJson } = loadFormatters();

test('beautifyJson preserves JSONC comments, templates, values, and string contents', () => {
  const input = `{
// leading comment
url: 'https://example.com/a//b',
amount: 900719925474099312345,
/* block comment */ template: {{access_token}},
quotedTemplate: "{{access_token}}", // trailing comment
}`;

  const result = beautifyJson(input);
  assert.equal(result.error, undefined);
  assert.match(result.formatted, /\/\/ leading comment/);
  assert.match(result.formatted, /\/\* block comment \*\//);
  assert.match(result.formatted, /\/\/ trailing comment/);
  assert.match(result.formatted, /'https:\/\/example\.com\/a\/\/b'/);
  assert.match(result.formatted, /900719925474099312345/);
  assert.match(result.formatted, /\{\{access_token\}\}/);
  assert.match(result.formatted, /"\{\{access_token\}\}"/);
  assert.equal(beautifyJson(result.formatted).formatted, result.formatted, 'Formatting is idempotent');
});

test('beautifyJson supports relaxed object syntax without normalizing values', () => {
  const result = beautifyJson("{ key: 'value', list: [1,], }");

  assert.equal(result.error, undefined);
  assert.match(result.formatted, /key: 'value'/);
  assert.match(result.formatted, /list: \[\n\s+1,\n\s*\]/);
});

test('beautifyJson leaves unsupported input untouched when it cannot be safely formatted', () => {
  const malformed = '  { "key": }  ';
  const result = beautifyJson(malformed);

  assert.equal(result.formatted, malformed);
  assert.match(result.error, /Expected a value/);

  const unterminatedComment = '{ /* missing';
  const commentResult = beautifyJson(unterminatedComment);
  assert.equal(commentResult.formatted, unterminatedComment);
  assert.equal(commentResult.error, 'Unterminated block comment');
});


test('beautifyJson keeps trailing line comments on the property they describe', () => {
  const result = beautifyJson('{"a": 1, // about a\n"b": 2}');

  assert.equal(result.error, undefined);
  assert.equal(result.formatted, '{\n  "a": 1, // about a\n  "b": 2\n}');
  assert.equal(beautifyJson(result.formatted).formatted, result.formatted, 'Formatting is idempotent');
});

test('beautifyJson keeps indentation balanced for containers that only hold comments', () => {
  const result = beautifyJson('{"a": { /* c */ }, "b": [ // d\n], "c": {"d": 1}}');

  assert.equal(result.error, undefined);
  assert.equal(
    result.formatted,
    '{\n  "a": { /* c */\n  },\n  "b": [ // d\n  ],\n  "c": {\n    "d": 1\n  }\n}',
  );
  assert.equal(beautifyJson(result.formatted).formatted, result.formatted, 'Formatting is idempotent');
});
