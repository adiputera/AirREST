import { PayloadNode, PayloadBuilderConfig, DateConfig } from '../types/payloadBuilder';
import { generateNodeId, createInitialPayloadConfig } from './payloadCompiler';
import { tokenizeJsonLike, JsonLikeToken } from './formatters';

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/i;
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Recursively infers a PayloadNode from a parsed JavaScript value
 */
export function inferJsonValueNode(key: string, val: unknown): PayloadNode {
  const id = generateNodeId();

  if (val === null || val === undefined) {
    return {
      id,
      key,
      type: 'null',
      value: '',
      enabled: true,
    };
  }

  if (typeof val === 'boolean') {
    return {
      id,
      key,
      type: 'boolean',
      value: val ? 'true' : 'false',
      enabled: true,
    };
  }

  if (typeof val === 'number') {
    return {
      id,
      key,
      type: 'number',
      value: String(val),
      enabled: true,
    };
  }

  if (typeof val === 'string') {
    // Check if it's an unwrapped template placeholder
    if (val.startsWith('__AIRREST_TMPL_{{') && val.endsWith('}}__')) {
      const tmpl = val.slice('__AIRREST_TMPL_'.length, -'__'.length);
      return {
        id,
        key,
        type: 'string',
        value: tmpl,
        enabled: true,
      };
    }

    // Check if it's an ISO 8601 Date
    if (ISO_DATE_REGEX.test(val)) {
      const parsed = new Date(val);
      if (!isNaN(parsed.getTime())) {
        const dateConfig: DateConfig = {
          mode: 'static',
          format: 'iso-8601',
          value: val,
        };
        return {
          id,
          key,
          type: 'date',
          value: val,
          dateConfig,
          enabled: true,
        };
      }
    }

    // Check if it's Date-only (YYYY-MM-DD)
    if (DATE_ONLY_REGEX.test(val)) {
      const parsed = new Date(val);
      if (!isNaN(parsed.getTime())) {
        const dateConfig: DateConfig = {
          mode: 'static',
          format: 'date-only',
          value: val,
        };
        return {
          id,
          key,
          type: 'date',
          value: val,
          dateConfig,
          enabled: true,
        };
      }
    }

    return {
      id,
      key,
      type: 'string',
      value: val,
      enabled: true,
    };
  }

  if (Array.isArray(val)) {
    const children = val.map((item) => inferJsonValueNode('', item));
    return {
      id,
      key,
      type: 'list',
      children,
      enabled: true,
    };
  }

  if (typeof val === 'object') {
    const children = Object.entries(val as Record<string, unknown>).map(([childKey, childVal]) =>
      inferJsonValueNode(childKey, childVal)
    );
    return {
      id,
      key,
      type: 'object',
      children,
      enabled: true,
    };
  }

  return {
    id,
    key,
    type: 'string',
    value: String(val),
    enabled: true,
  };
}

const NUMBER_LITERAL_REGEX = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function decodeSingleQuotedLiteral(raw: string): string {
  const inner = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && i + 1 < inner.length) {
      const next = inner[++i];
      switch (next) {
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case '\\':
        case "'":
        case '"':
        case '/':
          out += next;
          break;
        default:
          out += next;
          break;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

function parseKeyToken(token: JsonLikeToken): { key?: string; isQuoted: boolean; error?: string } {
  if (token.kind !== 'atom') {
    return { isQuoted: false, error: 'Expected an object property name' };
  }
  if (token.text.startsWith('"')) {
    try {
      const parsed = JSON.parse(token.text);
      if (typeof parsed === 'string') {
        return { key: parsed, isQuoted: true };
      }
    } catch {
      return { isQuoted: true, error: `Invalid property name ${token.text}` };
    }
  }
  if (token.text.startsWith("'") && token.text.endsWith("'")) {
    return { key: decodeSingleQuotedLiteral(token.text), isQuoted: true };
  }
  if (/^[a-zA-Z0-9_$-]+$/.test(token.text)) {
    return { key: token.text, isQuoted: false };
  }
  return { isQuoted: false, error: `Invalid property name "${token.text}"` };
}

function parseAtomTokenToNode(key: string, token: JsonLikeToken): { node?: PayloadNode; error?: string } {
  const text = token.text;

  if (text.startsWith('"')) {
    try {
      const str = JSON.parse(text);
      return { node: inferJsonValueNode(key, str) };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : `Invalid string literal ${text}` };
    }
  }

  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return { node: inferJsonValueNode(key, decodeSingleQuotedLiteral(text)) };
  }

  if (text.startsWith('{{') && text.endsWith('}}')) {
    return {
      node: {
        id: generateNodeId(),
        key,
        type: 'string',
        value: text,
        enabled: true,
      },
    };
  }

  if (text === 'true' || text === 'True') {
    return {
      node: {
        id: generateNodeId(),
        key,
        type: 'boolean',
        value: 'true',
        enabled: true,
      },
    };
  }

  if (text === 'false' || text === 'False') {
    return {
      node: {
        id: generateNodeId(),
        key,
        type: 'boolean',
        value: 'false',
        enabled: true,
      },
    };
  }

  if (text === 'null' || text === 'None') {
    return {
      node: {
        id: generateNodeId(),
        key,
        type: 'null',
        value: '',
        enabled: true,
      },
    };
  }

  if (NUMBER_LITERAL_REGEX.test(text)) {
    return {
      node: {
        id: generateNodeId(),
        key,
        type: 'number',
        value: text,
        enabled: true,
      },
    };
  }

  return { error: `Unexpected value "${text}"` };
}

function stripOuterCommentDelimiters(fragment: string): string {
  let trimmed = fragment.trim();
  if (trimmed.startsWith(',')) {
    trimmed = trimmed.slice(1).trim();
  }
  if (trimmed.endsWith(',')) {
    trimmed = trimmed.slice(0, -1).trim();
  }
  return trimmed;
}

function tryParseCommentFragment(
  rawFragment: string,
  context: 'object' | 'array'
): PayloadNode[] | null {
  const candidate = stripOuterCommentDelimiters(rawFragment);
  if (!candidate) return null;

  if (context === 'object') {
    // Require a quoted property key so prose comments like `// Status: 200` are never parsed as fields
    const firstChar = candidate[0];
    if (firstChar !== '"' && firstChar !== "'") {
      return null;
    }
  }

  const tokenized = tokenizeJsonLike(candidate);
  if (tokenized.error || tokenized.tokens.length === 0) {
    return null;
  }

  const parsed = parseJsoncSequence(tokenized.tokens, context, context === 'object');
  if (!parsed || parsed.nodes.length === 0) {
    return null;
  }

  return parsed.nodes.map((n) => ({ ...n, enabled: false }));
}

function extractCommentedNodes(
  commentTokens: JsonLikeToken[],
  context: 'object' | 'array'
): PayloadNode[] {
  const nodes: PayloadNode[] = [];
  let i = 0;

  while (i < commentTokens.length) {
    const token = commentTokens[i];
    if (token.kind === 'block-comment') {
      const inner = token.text.slice(2, -2);
      const extracted = tryParseCommentFragment(inner, context);
      if (extracted) {
        nodes.push(...extracted);
      }
      i++;
      continue;
    }

    // Collect consecutive line-comment tokens
    const runStart = i;
    while (i < commentTokens.length && commentTokens[i].kind === 'line-comment') {
      i++;
    }
    const lineTokens = commentTokens.slice(runStart, i);
    const lines = lineTokens.map((t) => t.text.slice(2).replace(/^ /, ''));

    let lineIdx = 0;
    while (lineIdx < lines.length) {
      const firstLine = lines[lineIdx].trim();
      if (!firstLine) {
        lineIdx++;
        continue;
      }

      if (context === 'object') {
        const cleanStart = firstLine.startsWith(',') ? firstLine.slice(1).trim() : firstLine;
        if (!cleanStart.startsWith('"') && !cleanStart.startsWith("'")) {
          lineIdx++;
          continue;
        }
      } else if (!lineTokens[lineIdx].newlineBefore) {
        const cleanStart = firstLine.startsWith(',') ? firstLine.slice(1).trim() : firstLine;
        const firstCh = cleanStart[0];
        if (firstCh !== '"' && firstCh !== "'" && firstCh !== '{' && firstCh !== '[') {
          lineIdx++;
          continue;
        }
      }

      let matched = false;
      for (let endIdx = lineIdx; endIdx < lines.length; endIdx++) {
        const joined = lines.slice(lineIdx, endIdx + 1).join('\n');
        const extracted = tryParseCommentFragment(joined, context);
        if (extracted) {
          nodes.push(...extracted);
          lineIdx = endIdx + 1;
          matched = true;
          break;
        }
      }

      if (!matched) {
        lineIdx++;
      }
    }
  }

  return nodes;
}

function createJsoncContainerParsers(
  tokens: JsonLikeToken[],
  options: { requireQuotedKeys?: boolean } = {}
) {
  let index = 0;

  const getIndex = () => index;

  const skipComments = () => {
    while (
      index < tokens.length &&
      (tokens[index].kind === 'line-comment' || tokens[index].kind === 'block-comment')
    ) {
      index++;
    }
  };

  const collectComments = (context: 'object' | 'array'): PayloadNode[] => {
    const comments: JsonLikeToken[] = [];
    while (
      index < tokens.length &&
      (tokens[index].kind === 'line-comment' || tokens[index].kind === 'block-comment')
    ) {
      comments.push(tokens[index++]);
    }
    if (comments.length === 0) return [];
    return extractCommentedNodes(comments, context);
  };

  const parseValue = (key: string): { node?: PayloadNode; error?: string } => {
    skipComments();
    const token = tokens[index];
    if (!token) return { error: 'Expected a value' };

    if (token.kind === 'atom') {
      index++;
      return parseAtomTokenToNode(key, token);
    }
    if (token.kind === 'open-object') {
      return parseObject(key);
    }
    if (token.kind === 'open-array') {
      return parseArray(key);
    }
    return { error: `Expected a value, found "${token.text}"` };
  };

  const parseProperty = (): { node?: PayloadNode; error?: string } => {
    const keyToken = tokens[index];
    if (!keyToken) return { error: 'Expected an object property name' };
    const parsedKey = parseKeyToken(keyToken);
    if (parsedKey.error || parsedKey.key === undefined) {
      return { error: parsedKey.error || 'Expected an object property name' };
    }
    if (options.requireQuotedKeys && !parsedKey.isQuoted) {
      return { error: 'Expected a quoted object property name' };
    }
    index++;

    skipComments();
    if (tokens[index]?.kind !== 'colon') {
      return { error: 'Expected ":" after an object property name' };
    }
    index++;

    return parseValue(parsedKey.key);
  };

  const parseObject = (key: string): { node?: PayloadNode; error?: string } => {
    index++; // consume '{'
    const children: PayloadNode[] = [];
    children.push(...collectComments('object'));

    if (tokens[index]?.kind === 'close-object') {
      index++;
      return {
        node: {
          id: generateNodeId(),
          key,
          type: 'object',
          children,
          enabled: true,
        },
      };
    }

    while (index < tokens.length) {
      children.push(...collectComments('object'));
      if (tokens[index]?.kind === 'close-object') {
        index++;
        return {
          node: {
            id: generateNodeId(),
            key,
            type: 'object',
            children,
            enabled: true,
          },
        };
      }

      const propResult = parseProperty();
      if (propResult.error || !propResult.node) {
        return { error: propResult.error || 'Expected an object property' };
      }
      children.push(propResult.node);

      children.push(...collectComments('object'));

      const separator = tokens[index];
      if (separator?.kind === 'close-object') {
        index++;
        return {
          node: {
            id: generateNodeId(),
            key,
            type: 'object',
            children,
            enabled: true,
          },
        };
      }
      if (separator?.kind !== 'comma') {
        return { error: 'Expected "," or "}" after an object property' };
      }
      index++;
    }

    return { error: 'Unterminated object' };
  };

  const parseArray = (key: string): { node?: PayloadNode; error?: string } => {
    index++; // consume '['
    const children: PayloadNode[] = [];
    children.push(...collectComments('array'));

    if (tokens[index]?.kind === 'close-array') {
      index++;
      return {
        node: {
          id: generateNodeId(),
          key,
          type: 'list',
          children,
          enabled: true,
        },
      };
    }

    while (index < tokens.length) {
      children.push(...collectComments('array'));
      if (tokens[index]?.kind === 'close-array') {
        index++;
        return {
          node: {
            id: generateNodeId(),
            key,
            type: 'list',
            children,
            enabled: true,
          },
        };
      }

      const itemResult = parseValue('');
      if (itemResult.error || !itemResult.node) {
        return { error: itemResult.error || 'Expected an array value' };
      }
      children.push(itemResult.node);

      children.push(...collectComments('array'));

      const separator = tokens[index];
      if (separator?.kind === 'close-array') {
        index++;
        return {
          node: {
            id: generateNodeId(),
            key,
            type: 'list',
            children,
            enabled: true,
          },
        };
      }
      if (separator?.kind !== 'comma') {
        return { error: 'Expected "," or "]" after an array value' };
      }
      index++;
    }

    return { error: 'Unterminated array' };
  };

  return {
    getIndex,
    skipComments,
    collectComments,
    parseValue,
    parseProperty,
    parseObject,
    parseArray,
  };
}

function parseJsoncSequence(
  tokens: JsonLikeToken[],
  context: 'object' | 'array',
  requireQuotedKeys: boolean
): { nodes: PayloadNode[] } | null {
  const parser = createJsoncContainerParsers(tokens, { requireQuotedKeys });
  const nodes: PayloadNode[] = [];

  while (parser.getIndex() < tokens.length) {
    nodes.push(...parser.collectComments(context));
    if (parser.getIndex() >= tokens.length) break;

    const itemResult = context === 'object' ? parser.parseProperty() : parser.parseValue('');
    if (itemResult.error || !itemResult.node) return null;
    nodes.push(itemResult.node);

    nodes.push(...parser.collectComments(context));
    if (parser.getIndex() >= tokens.length) break;

    const nextIdx = parser.getIndex();
    if (tokens[nextIdx]?.kind !== 'comma') return null;
    // Advance past comma by consuming via slice-safe index check:
    // parseJsoncSequence validates comma between items in fragments
    tokens = tokens.slice(nextIdx + 1);
    return concatSequenceRemainder(nodes, tokens, context, requireQuotedKeys);
  }

  return { nodes };
}

function concatSequenceRemainder(
  headNodes: PayloadNode[],
  remainingTokens: JsonLikeToken[],
  context: 'object' | 'array',
  requireQuotedKeys: boolean
): { nodes: PayloadNode[] } | null {
  if (remainingTokens.length === 0) return { nodes: headNodes };
  const rest = parseJsoncSequence(remainingTokens, context, requireQuotedKeys);
  if (!rest) return null;
  return { nodes: [...headNodes, ...rest.nodes] };
}

function parseJsoncDocument(raw: string): { config?: PayloadBuilderConfig; error?: string } {
  const tokenized = tokenizeJsonLike(raw);
  if (tokenized.error) {
    return { error: tokenized.error };
  }

  const tokens = tokenized.tokens;
  const parser = createJsoncContainerParsers(tokens);

  parser.skipComments();
  const rootIndex = parser.getIndex();
  if (rootIndex >= tokens.length) {
    return { config: createInitialPayloadConfig('object') };
  }

  const rootToken = tokens[rootIndex];
  if (rootToken.kind === 'open-object') {
    const res = parser.parseObject('request');
    if (res.error || !res.node) return { error: res.error || 'Invalid JSON format' };
    parser.skipComments();
    const endIndex = parser.getIndex();
    if (endIndex < tokens.length) return { error: `Unexpected token "${tokens[endIndex].text}"` };
    return {
      config: {
        rootType: 'object',
        rootKey: 'request',
        nodes: res.node.children || [],
      },
    };
  }

  if (rootToken.kind === 'open-array') {
    const res = parser.parseArray('');
    if (res.error || !res.node) return { error: res.error || 'Invalid JSON format' };
    parser.skipComments();
    const endIndex = parser.getIndex();
    if (endIndex < tokens.length) return { error: `Unexpected token "${tokens[endIndex].text}"` };
    return {
      config: {
        rootType: 'list',
        xmlContainerTag: 'items',
        xmlItemTag: 'item',
        nodes: res.node.children || [],
      },
    };
  }

  const singleRes = parser.parseValue('value');
  if (singleRes.error || !singleRes.node) return { error: singleRes.error || 'Invalid JSON format' };
  parser.skipComments();
  const endIndex = parser.getIndex();
  if (endIndex < tokens.length) return { error: `Unexpected token "${tokens[endIndex].text}"` };
  return {
    config: {
      rootType: 'object',
      rootKey: 'request',
      nodes: [singleRes.node],
    },
  };
}

/**
 * Reverse parses raw JSON/JSONC string into a structured PayloadBuilderConfig,
 * preserving commented-out fields/items as disabled nodes (`enabled: false`).
 */
export function jsonToTree(rawJson?: string | null): { config?: PayloadBuilderConfig; error?: string } {
  const trimmed = typeof rawJson === 'string' ? rawJson.trim() : '';
  if (!trimmed) {
    return { config: createInitialPayloadConfig('object') };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return parseJsoncDocument(trimmed);
  }

  if (Array.isArray(parsed)) {
    const nodes = parsed.map((item) => inferJsonValueNode('', item));
    return {
      config: {
        rootType: 'list',
        xmlContainerTag: 'items',
        xmlItemTag: 'item',
        nodes,
      },
    };
  }

  if (parsed !== null && typeof parsed === 'object') {
    const nodes = Object.entries(parsed as Record<string, unknown>).map(([key, val]) =>
      inferJsonValueNode(key, val)
    );
    return {
      config: {
        rootType: 'object',
        rootKey: 'request',
        nodes,
      },
    };
  }

  // Primitive root (fallback)
  const singleNode = inferJsonValueNode('value', parsed);
  return {
    config: {
      rootType: 'object',
      rootKey: 'request',
      nodes: [singleNode],
    },
  };
}

/**
 * Infers an XML Element DOM node to PayloadNode
 */
function parseXmlElement(element: Element): PayloadNode {
  const id = generateNodeId();
  const key = element.tagName;
  const children: PayloadNode[] = [];

  // Parse XML Attributes
  if (element.attributes && element.attributes.length > 0) {
    for (let i = 0; i < element.attributes.length; i++) {
      const attr = element.attributes[i];
      if (attr && !attr.name.startsWith('xmlns')) {
        children.push({
          id: generateNodeId(),
          key: attr.name,
          type: 'string',
          value: attr.value,
          enabled: true,
          xmlAttribute: true,
        });
      }
    }
  }

  // Group child elements
  const childElements = Array.from(element.children);

  if (childElements.length === 0) {
    const textContent = (element.textContent || '').trim();

    // Check if it's a leaf node with attributes
    if (children.length > 0) {
      if (textContent) {
        children.push({
          id: generateNodeId(),
          key: 'value',
          type: 'string',
          value: textContent,
          enabled: true,
        });
      }
      return {
        id,
        key,
        type: 'object',
        children,
        enabled: true,
      };
    }

    // Pure leaf node (no attributes, text only)
    if (textContent.toLowerCase() === 'true' || textContent.toLowerCase() === 'false') {
      return {
        id,
        key,
        type: 'boolean',
        value: textContent.toLowerCase(),
        enabled: true,
      };
    }

    if (/^-?\d+(\.\d+)?$/.test(textContent) && !textContent.startsWith('00')) {
      return {
        id,
        key,
        type: 'number',
        value: textContent,
        enabled: true,
      };
    }

    if (ISO_DATE_REGEX.test(textContent) || DATE_ONLY_REGEX.test(textContent)) {
      return {
        id,
        key,
        type: 'date',
        value: textContent,
        dateConfig: {
          mode: 'static',
          format: ISO_DATE_REGEX.test(textContent) ? 'iso-8601' : 'date-only',
          value: textContent,
        },
        enabled: true,
      };
    }

    return {
      id,
      key,
      type: 'string',
      value: textContent,
      enabled: true,
    };
  }

  // Check for repeated sibling tags to group into list
  const tagCounts = new Map<string, Element[]>();
  for (const child of childElements) {
    const tag = child.tagName;
    if (!tagCounts.has(tag)) {
      tagCounts.set(tag, []);
    }
    tagCounts.get(tag)!.push(child);
  }

  for (const [tag, elements] of tagCounts.entries()) {
    if (elements.length > 1) {
      // Group into list node
      const listChildren = elements.map((elem) => {
        const itemNode = parseXmlElement(elem);
        itemNode.key = ''; // list item key is empty
        return itemNode;
      });
      children.push({
        id: generateNodeId(),
        key: tag,
        type: 'list',
        children: listChildren,
        enabled: true,
      });
    } else {
      children.push(parseXmlElement(elements[0]));
    }
  }

  return {
    id,
    key,
    type: 'object',
    children,
    enabled: true,
  };
}

/**
 * Reverse parses raw XML string into a structured PayloadBuilderConfig
 */
export function xmlToTree(rawXml?: string | null): { config?: PayloadBuilderConfig; error?: string } {
  const trimmed = typeof rawXml === 'string' ? rawXml.trim() : '';
  if (!trimmed) {
    return { config: createInitialPayloadConfig('object') };
  }

  if (typeof DOMParser === 'undefined') {
    return { error: 'DOMParser is not available in current environment' };
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(trimmed, 'application/xml');
  const parseError = doc.querySelector('parsererror');

  if (parseError) {
    const errorMsg = parseError.textContent?.split('\n')[0] || 'Invalid XML syntax';
    return { error: errorMsg };
  }

  const rootElement = doc.documentElement;
  if (!rootElement) {
    return { error: 'XML document does not contain a root element' };
  }

  const rootTag = rootElement.tagName;
  const childElements = Array.from(rootElement.children);

  // Check if root is a List wrapper (e.g. <items><item>...</item><item>...</item></items>)
  const isListWrapper =
    childElements.length > 1 &&
    childElements.every((el) => el.tagName === childElements[0].tagName);

  if (isListWrapper) {
    const itemTag = childElements[0].tagName;
    const nodes = childElements.map((el) => {
      const node = parseXmlElement(el);
      node.key = '';
      return node;
    });

    return {
      config: {
        rootType: 'list',
        xmlContainerTag: rootTag,
        xmlItemTag: itemTag,
        nodes,
      },
    };
  }

  // Root is Object
  const rootNode = parseXmlElement(rootElement);
  const nodes = rootNode.children || [];

  return {
    config: {
      rootType: 'object',
      rootKey: rootTag,
      nodes,
    },
  };
}
