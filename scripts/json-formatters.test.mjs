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

const { beautifyJson, compileEffectiveJsonPayload, stripJsonComments, findJsonCommentRanges } = loadFormatters();

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

test('beautifyJson keeps standalone commented fields on their own line when preceding line has no comma', () => {
  const input = '{\n  "field_1": "a"\n  // "field_2": "b"\n}';
  const result = beautifyJson(input);

  assert.equal(result.error, undefined);
  assert.equal(result.formatted, input);
});

test('compileEffectiveJsonPayload strips line/block comments and trailing commas while preserving strings', () => {
  const topComment = '{\n  //"field_1": "sadsadsa",\n  "field_2": "sadadsa",\n  "field_3": "sadasdsa"\n}';
  const compiledTop = compileEffectiveJsonPayload(topComment);
  assert.deepEqual(JSON.parse(compiledTop), { field_2: 'sadadsa', field_3: 'sadasdsa' });
  assert.ok(!compiledTop.includes('field_1'));

  const lastFieldComment = '{\n  "field_1": "keep",\n  // "field_2": "drop"\n}';
  const compiledLast = compileEffectiveJsonPayload(lastFieldComment);
  assert.deepEqual(JSON.parse(compiledLast), { field_1: 'keep' });

  const blockAndInline = `{
    "url": "https://httpbin.org/post?a=1//b", // inline note
    "winPath": "C:\\\\",
    "commaInString": "hello, }",
    /* "commented": {
      "nested": true
    }, */
    "arr": [
      1,
      // 2,
    ]
  }`;
  const compiledComplex = compileEffectiveJsonPayload(blockAndInline);
  assert.deepEqual(JSON.parse(compiledComplex), {
    url: 'https://httpbin.org/post?a=1//b',
    winPath: 'C:\\',
    commaInString: 'hello, }',
    arr: [1],
  });

  // Escaped backslash before quote must not break comment stripping
  const escapedStr = stripJsonComments('{"path": "C:\\\\"} // trailing');
  assert.equal(escapedStr.trim(), '{"path": "C:\\\\"}');
});

test('findJsonCommentRanges locates line and block comments while ignoring comment-like URLs inside strings', () => {
  const input = '{\n  //"field_1": "sadsadsa",\n  "url": "https://httpbin.org/post//test",\n  /* block\n     comment */\n  "field_2": "ok" // end\n}';
  const ranges = findJsonCommentRanges(input);
  const extracted = Array.from(ranges, (r) => input.slice(r.from, r.to));

  assert.deepEqual(extracted, [
    '//"field_1": "sadsadsa",',
    '/* block\n     comment */',
    '// end',
  ]);

  const unterminated = '{\n  /* open comment';
  const unterminatedRanges = findJsonCommentRanges(unterminated);
  assert.deepEqual(
    Array.from(unterminatedRanges, (r) => unterminated.slice(r.from, r.to)),
    ['/* open comment']
  );
});
