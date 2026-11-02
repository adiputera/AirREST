import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function loadModule(relativePath, mockModules = {}, extraGlobals = {}) {
  const filePath = new URL(relativePath, import.meta.url);
  const source = fs.readFileSync(filePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(
    compiled,
    {
      exports,
      require: (id) => {
        if (mockModules[id]) return mockModules[id];
        if (id.startsWith('@/lib/') || id.startsWith('./') || id.startsWith('../')) {
          return mockModules[id] || {};
        }
        return require(id);
      },
      URL,
      TextEncoder,
      TextDecoder,
      console,
      Date,
      Math,
      Map,
      Set,
      Array,
      Object,
      String,
      Number,
      Boolean,
      JSON,
      RegExp,
      isNaN,
      ...extraGlobals,
    },
    { filename: filePath.pathname }
  );
  return exports;
}

// ---------------------------------------------------------------------------
// Mock DOMParser for Node.js test environment
// ---------------------------------------------------------------------------
class MockElement {
  constructor(tagName, attrs = {}, text = '') {
    this.tagName = tagName;
    this.attributes = Object.entries(attrs).map(([name, value]) => ({ name, value }));
    this.children = [];
    this.textContent = text;
  }
}

class MockDOMDocument {
  constructor(rootElement = null, parseError = null) {
    this.documentElement = rootElement;
    this._parseError = parseError;
  }

  querySelector(selector) {
    if (selector === 'parsererror') {
      return this._parseError ? { textContent: this._parseError } : null;
    }
    return null;
  }
}

class SimpleXmlParser {
  parseFromString(xmlString, mimeType) {
    const trimmed = xmlString.trim();
    if (!trimmed) {
      return new MockDOMDocument(null, 'Empty XML document');
    }

    if (trimmed.includes('<parsererror') || !trimmed.startsWith('<')) {
      return new MockDOMDocument(null, 'Syntax error: invalid XML format');
    }

    // Strip XML declaration
    const cleanXml = trimmed.replace(/<\?xml[^>]*\?>/gi, '').trim();

    // Check for root opening and closing tag
    const rootMatch = cleanXml.match(/^<([a-zA-Z0-9_\-:]+)((?:\s+[^>]+)*)>/);
    if (!rootMatch) {
      return new MockDOMDocument(null, 'No root element found');
    }

    const rootTag = rootMatch[1];
    const rawAttrs = rootMatch[2] || '';

    // Parse attributes
    const attrs = {};
    const attrRegex = /([a-zA-Z0-9_\-:]+)=["']([^"']*)["']/g;
    let m;
    while ((m = attrRegex.exec(rawAttrs)) !== null) {
      attrs[m[1]] = m[2];
    }

    const root = new MockElement(rootTag, attrs);

    // Extract inside of root
    const closeTag = `</${rootTag}>`;
    const lastClose = cleanXml.lastIndexOf(closeTag);
    if (lastClose === -1 && !cleanXml.endsWith('/>')) {
      return new MockDOMDocument(null, `Unclosed root tag: ${rootTag}`);
    }

    const inside = cleanXml.endsWith('/>')
      ? ''
      : cleanXml.substring(rootMatch[0].length, lastClose).trim();

    // Parse child elements
    const childRegex = /<([a-zA-Z0-9_\-:]+)((?:\s+[^>]+)*)>(.*?)<\/\1>|<([a-zA-Z0-9_\-:]+)((?:\s+[^>]+)*)\/>/gs;
    let cm;
    let foundChildren = false;

    while ((cm = childRegex.exec(inside)) !== null) {
      foundChildren = true;
      const tag = cm[1] || cm[4];
      const cAttrsStr = cm[2] || cm[5] || '';
      const text = cm[3] ? cm[3].trim() : '';

      const cAttrs = {};
      while ((m = attrRegex.exec(cAttrsStr)) !== null) {
        cAttrs[m[1]] = m[2];
      }

      const childElem = new MockElement(tag, cAttrs, text);
      root.children.push(childElem);
    }

    if (!foundChildren) {
      root.textContent = inside.replace(/<[^>]+>/g, '').trim();
    }

    return new MockDOMDocument(root);
  }
}

// ---------------------------------------------------------------------------
// TEST SUITE: Payload Compiler & Reverse Parser
// ---------------------------------------------------------------------------

test('payloadCompiler: treeToJson compiles primitive types correctly', () => {
  const compiler = loadModule('../packages/common/src/lib/payloadCompiler.ts');

  const config = {
    rootType: 'object',
    nodes: [
      { id: '1', key: 'name', type: 'string', value: 'Alice', enabled: true },
      { id: '2', key: 'age', type: 'number', value: '28', enabled: true },
      { id: '3', key: 'active', type: 'boolean', value: 'true', enabled: true },
      { id: '4', key: 'balance', type: 'number', value: '125.75', enabled: true },
      { id: '5', key: 'metadata', type: 'null', value: '', enabled: true },
      { id: '6', key: 'disabledField', type: 'string', value: 'secret', enabled: false },
    ],
  };

  const jsonStr = compiler.treeToJson(config);
  const parsed = JSON.parse(jsonStr);

  assert.equal(parsed.name, 'Alice');
  assert.equal(parsed.age, 28);
  assert.equal(parsed.active, true);
  assert.equal(parsed.balance, 125.75);
  assert.equal(parsed.metadata, null);
  assert.equal(parsed.disabledField, undefined);
});

test('payloadCompiler: treeToJson handles template variables and zero without coercion bugs', () => {
  const compiler = loadModule('../packages/common/src/lib/payloadCompiler.ts');

  const config = {
    rootType: 'object',
    nodes: [
      { id: '1', key: 'userId', type: 'number', value: '{{userId}}', enabled: true },
      { id: '2', key: 'zeroCount', type: 'number', value: '0', enabled: true },
      { id: '3', key: 'negativeInt', type: 'number', value: '-42', enabled: true },
    ],
  };

  const jsonStr = compiler.treeToJson(config);
  const parsed = JSON.parse(jsonStr);

  assert.equal(parsed.userId, '{{userId}}'); // Did NOT coerce to NaN
  assert.equal(parsed.zeroCount, 0);          // Zero preserved
  assert.equal(parsed.negativeInt, -42);
});

test('payloadCompiler: treeToJson compiles Root List and nested object lists', () => {
  const compiler = loadModule('../packages/common/src/lib/payloadCompiler.ts');

  const config = {
    rootType: 'list',
    nodes: [
      {
        id: '1',
        key: '',
        type: 'object',
        enabled: true,
        children: [
          { id: '1a', key: 'id', type: 'number', value: '1', enabled: true },
          { id: '1b', key: 'title', type: 'string', value: 'Item 1', enabled: true },
        ],
      },
      {
        id: '2',
        key: '',
        type: 'object',
        enabled: true,
        children: [
          { id: '2a', key: 'id', type: 'number', value: '2', enabled: true },
          { id: '2b', key: 'title', type: 'string', value: 'Item 2', enabled: true },
        ],
      },
    ],
  };

  const jsonStr = compiler.treeToJson(config);
  const parsed = JSON.parse(jsonStr);

  assert(Array.isArray(parsed));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, 1);
  assert.equal(parsed[0].title, 'Item 1');
  assert.equal(parsed[1].id, 2);
  assert.equal(parsed[1].title, 'Item 2');
});

test('payloadCompiler: treeToXml compiles Object Root and escapes special XML characters', () => {
  const compiler = loadModule('../packages/common/src/lib/payloadCompiler.ts');

  const config = {
    rootType: 'object',
    rootKey: 'request',
    nodes: [
      { id: '1', key: 'title', type: 'string', value: 'Rock & Roll <Live>', enabled: true },
      { id: '2', key: 'amount', type: 'number', value: '100', enabled: true },
      { id: '3', key: 'status', type: 'string', value: 'active', enabled: true, xmlAttribute: true },
    ],
  };

  const xmlStr = compiler.treeToXml(config);

  assert(xmlStr.includes('<?xml version="1.0" encoding="UTF-8"?>'));
  assert(xmlStr.includes('<request status="active">'));
  assert(xmlStr.includes('<title>Rock &amp; Roll &lt;Live&gt;</title>'));
  assert(xmlStr.includes('<amount>100</amount>'));
  assert(xmlStr.endsWith('</request>'));
});

test('payloadCompiler: treeToXml compiles Root List with container wrapper', () => {
  const compiler = loadModule('../packages/common/src/lib/payloadCompiler.ts');

  const config = {
    rootType: 'list',
    xmlContainerTag: 'users',
    xmlItemTag: 'user',
    nodes: [
      {
        id: '1',
        key: '',
        type: 'object',
        enabled: true,
        children: [
          { id: '1a', key: 'name', type: 'string', value: 'Alice', enabled: true },
        ],
      },
      {
        id: '2',
        key: '',
        type: 'object',
        enabled: true,
        children: [
          { id: '2a', key: 'name', type: 'string', value: 'Bob', enabled: true },
        ],
      },
    ],
  };

  const xmlStr = compiler.treeToXml(config);

  assert(xmlStr.includes('<users>'));
  assert(xmlStr.includes('<user>'));
  assert(xmlStr.includes('<name>Alice</name>'));
  assert(xmlStr.includes('<name>Bob</name>'));
  assert(xmlStr.endsWith('</users>'));
});

test('payloadReverseParser: jsonToTree infers types, date formats, and arrays accurately', () => {
  const parser = loadModule('../packages/common/src/lib/payloadReverseParser.ts');

  const rawJson = JSON.stringify({
    title: 'Hello World',
    views: 4200,
    published: true,
    created_at: '2026-11-02T05:12:00.000Z',
    date_only: '2026-11-02',
    tags: ['rest', 'api'],
    author: {
      name: 'John Doe',
      verified: true,
    },
    nullable: null,
  });

  const { config, error } = parser.jsonToTree(rawJson);

  assert.equal(error, undefined);
  assert.equal(config.rootType, 'object');

  const nodeMap = new Map(config.nodes.map((n) => [n.key, n]));

  assert.equal(nodeMap.get('title').type, 'string');
  assert.equal(nodeMap.get('title').value, 'Hello World');

  assert.equal(nodeMap.get('views').type, 'number');
  assert.equal(nodeMap.get('views').value, '4200');

  assert.equal(nodeMap.get('published').type, 'boolean');
  assert.equal(nodeMap.get('published').value, 'true');

  assert.equal(nodeMap.get('created_at').type, 'date');
  assert.equal(nodeMap.get('created_at').dateConfig.format, 'iso-8601');

  assert.equal(nodeMap.get('date_only').type, 'date');
  assert.equal(nodeMap.get('date_only').dateConfig.format, 'date-only');

  assert.equal(nodeMap.get('tags').type, 'list');
  assert.equal(nodeMap.get('tags').children.length, 2);
  assert.equal(nodeMap.get('tags').children[0].type, 'string');
  assert.equal(nodeMap.get('tags').children[0].value, 'rest');

  assert.equal(nodeMap.get('author').type, 'object');
  assert.equal(nodeMap.get('author').children.length, 2);

  assert.equal(nodeMap.get('nullable').type, 'null');
});

test('payloadReverseParser: jsonToTree handles malformed JSON with graceful error message', () => {
  const parser = loadModule('../packages/common/src/lib/payloadReverseParser.ts');

  const malformed = '{ "key": invalid_value, }';
  const { config, error } = parser.jsonToTree(malformed);

  assert.equal(config, undefined);
  assert(typeof error === 'string' && error.length > 0);
});

test('payloadReverseParser: xmlToTree detects root tag, attributes, and repeated tags as list', () => {
  const parser = loadModule(
    '../packages/common/src/lib/payloadReverseParser.ts',
    {},
    { DOMParser: SimpleXmlParser }
  );

  const rawXml = `<?xml version="1.0" encoding="UTF-8"?>
<request id="101" version="2.0">
  <title>AirREST Studio</title>
  <count>50</count>
  <active>true</active>
  <item>First</item>
  <item>Second</item>
</request>`;

  const { config, error } = parser.xmlToTree(rawXml);

  assert.equal(error, undefined);
  assert.equal(config.rootType, 'object');
  assert.equal(config.rootKey, 'request');

  const nodeMap = new Map(config.nodes.map((n) => [n.key, n]));

  // Attributes
  assert.equal(nodeMap.get('id').xmlAttribute, true);
  assert.equal(nodeMap.get('id').value, '101');
  assert.equal(nodeMap.get('version').xmlAttribute, true);
  assert.equal(nodeMap.get('version').value, '2.0');

  // Child elements
  assert.equal(nodeMap.get('title').type, 'string');
  assert.equal(nodeMap.get('title').value, 'AirREST Studio');

  assert.equal(nodeMap.get('count').type, 'number');
  assert.equal(nodeMap.get('count').value, '50');

  assert.equal(nodeMap.get('active').type, 'boolean');
  assert.equal(nodeMap.get('active').value, 'true');

  // Repeated <item> tags grouped as list
  assert.equal(nodeMap.get('item').type, 'list');
  assert.equal(nodeMap.get('item').children.length, 2);
  assert.equal(nodeMap.get('item').children[0].value, 'First');
  assert.equal(nodeMap.get('item').children[1].value, 'Second');
});
