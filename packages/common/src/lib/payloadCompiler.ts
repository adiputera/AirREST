import { PayloadNode, PayloadBuilderConfig, DateConfig } from '../types/payloadBuilder';

/**
 * Generates a unique node ID
 */
export function generateNodeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'pn_' + Math.random().toString(36).substring(2, 11);
}

/**
 * Escapes XML entity special characters
 */
export function escapeXml(str: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Sanitizes tag names to be valid XML element names
 */
export function sanitizeXmlTagName(tag?: string, defaultTag = 'item'): string {
  const trimmed = (tag || '').trim();
  if (!trimmed) return defaultTag;
  const sanitized = trimmed.replace(/[^a-zA-Z0-9_\-:]/g, '_');
  if (/^[0-9\-]/.test(sanitized)) {
    return `_${sanitized}`;
  }
  return sanitized || defaultTag;
}

/**
 * Formats date values according to DateConfig
 */
export function formatDateValue(dateConfig?: DateConfig, rawValue?: string): string {
  const now = new Date();
  
  if (dateConfig?.mode === 'dynamic_now') {
    const format = dateConfig.format || 'iso-8601';
    switch (format) {
      case 'date-only':
        return now.toISOString().split('T')[0];
      case 'datetime':
        return now.toISOString().replace('T', ' ').substring(0, 19);
      case 'unix-timestamp':
        return String(Math.floor(now.getTime() / 1000));
      case 'unix-ms':
        return String(now.getTime());
      case 'iso-8601':
      default:
        return now.toISOString();
    }
  }

  // Static mode
  const val = (rawValue ?? dateConfig?.value ?? '').trim();
  if (!val) {
    return now.toISOString();
  }

  // If already matches desired pattern or is a template variable, keep it
  if (val.includes('{{') && val.includes('}}')) {
    return val;
  }

  const format = dateConfig?.format || 'iso-8601';
  const parsedDate = new Date(val);
  const isValidDate = !isNaN(parsedDate.getTime());

  if (!isValidDate) {
    return val; // Fallback to raw string if cannot be parsed
  }

  switch (format) {
    case 'date-only':
      return parsedDate.toISOString().split('T')[0];
    case 'datetime':
      return parsedDate.toISOString().replace('T', ' ').substring(0, 19);
    case 'unix-timestamp':
      return String(Math.floor(parsedDate.getTime() / 1000));
    case 'unix-ms':
      return String(parsedDate.getTime());
    case 'iso-8601':
    default:
      return parsedDate.toISOString();
  }
}

/**
 * Recursively compiles a PayloadNode to a JavaScript object/value for JSON serialization
 */
export function compileNodeToJsonValue(node: PayloadNode): unknown {
  switch (node.type) {
    case 'string':
      return node.value ?? '';
    
    case 'number': {
      const valStr = (node.value ?? '').trim();
      if (valStr.includes('{{') && valStr.includes('}}')) {
        return valStr; // Preserve template variables without coercing to NaN
      }
      if (valStr === '') return 0;
      const num = Number(valStr);
      return isNaN(num) ? valStr : num;
    }

    case 'boolean':
      return node.value === 'true' || node.value === (true as unknown);

    case 'null':
      return null;

    case 'date':
      return formatDateValue(node.dateConfig, node.value);

    case 'object': {
      const result: Record<string, unknown> = {};
      const activeChildren = (node.children || []).filter((child) => child && child.enabled !== false);
      for (const child of activeChildren) {
        const key = child.key ? child.key.trim() : 'key';
        result[key] = compileNodeToJsonValue(child);
      }
      return result;
    }

    case 'list': {
      const activeChildren = (node.children || []).filter((child) => child && child.enabled !== false);
      return activeChildren.map((child) => compileNodeToJsonValue(child));
    }

    default:
      return node.value ?? '';
  }
}

/**
 * Compiles a PayloadBuilderConfig to formatted JSON string
 */
export function treeToJson(config: PayloadBuilderConfig): string {
  const activeNodes = (config.nodes || []).filter((node) => node && node.enabled !== false);

  if (config.rootType === 'list') {
    const listResult = activeNodes.map((node) => compileNodeToJsonValue(node));
    return JSON.stringify(listResult, null, 2);
  }

  // Root is Object
  const objResult: Record<string, unknown> = {};
  for (const node of activeNodes) {
    const key = node.key ? node.key.trim() : 'key';
    objResult[key] = compileNodeToJsonValue(node);
  }
  return JSON.stringify(objResult, null, 2);
}

/**
 * Helper to render an XML node with proper indentation
 */
function renderXmlNode(node: PayloadNode, tagName: string, indentLevel: number): string {
  const pad = '  '.repeat(indentLevel);
  const safeTag = sanitizeXmlTagName(tagName, 'item');

  if (node.type === 'object') {
    const activeChildren = (node.children || []).filter((c) => c && c.enabled !== false);
    const attrNodes = activeChildren.filter((c) => c.xmlAttribute);
    const elemNodes = activeChildren.filter((c) => !c.xmlAttribute);

    let attrStr = '';
    for (const attr of attrNodes) {
      const attrKey = sanitizeXmlTagName(attr.key, 'attr');
      const attrVal = escapeXml(String(compileNodeToJsonValue(attr) ?? ''));
      attrStr += ` ${attrKey}="${attrVal}"`;
    }

    if (elemNodes.length === 0) {
      return `${pad}<${safeTag}${attrStr} />`;
    }

    const childLines = elemNodes.map((child) =>
      renderXmlNode(child, child.key || 'item', indentLevel + 1)
    );
    return `${pad}<${safeTag}${attrStr}>\n${childLines.join('\n')}\n${pad}</${safeTag}>`;
  }

  if (node.type === 'list') {
    const activeChildren = (node.children || []).filter((c) => c && c.enabled !== false);
    if (activeChildren.length === 0) {
      return `${pad}<${safeTag} />`;
    }
    const childLines = activeChildren.map((child) =>
      renderXmlNode(child, child.key || 'item', indentLevel + 1)
    );
    return `${pad}<${safeTag}>\n${childLines.join('\n')}\n${pad}</${safeTag}>`;
  }

  // Primitive node (string, number, boolean, date, null)
  const val = compileNodeToJsonValue(node);
  const textVal = val === null ? '' : escapeXml(String(val));
  return `${pad}<${safeTag}>${textVal}</${safeTag}>`;
}

/**
 * Compiles a PayloadBuilderConfig to formatted XML string
 */
export function treeToXml(config: PayloadBuilderConfig): string {
  const activeNodes = (config.nodes || []).filter((node) => node && node.enabled !== false);

  if (config.rootType === 'list') {
    const containerTag = sanitizeXmlTagName(config.xmlContainerTag, 'items');
    const itemTag = sanitizeXmlTagName(config.xmlItemTag, 'item');

    if (activeNodes.length === 0) {
      return `<?xml version="1.0" encoding="UTF-8"?>\n<${containerTag} />`;
    }

    const itemsXml = activeNodes.map((node) =>
      renderXmlNode(node, node.key || itemTag, 1)
    );
    return `<?xml version="1.0" encoding="UTF-8"?>\n<${containerTag}>\n${itemsXml.join('\n')}\n</${containerTag}>`;
  }

  // Root is Object
  const rootTag = sanitizeXmlTagName(config.rootKey, 'request');
  const attrNodes = activeNodes.filter((c) => c.xmlAttribute);
  const elemNodes = activeNodes.filter((c) => !c.xmlAttribute);

  let attrStr = '';
  for (const attr of attrNodes) {
    const attrKey = sanitizeXmlTagName(attr.key, 'attr');
    const attrVal = escapeXml(String(compileNodeToJsonValue(attr) ?? ''));
    attrStr += ` ${attrKey}="${attrVal}"`;
  }

  if (elemNodes.length === 0) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<${rootTag}${attrStr} />`;
  }

  const elementsXml = elemNodes.map((node) =>
    renderXmlNode(node, node.key || 'item', 1)
  );

  return `<?xml version="1.0" encoding="UTF-8"?>\n<${rootTag}${attrStr}>\n${elementsXml.join('\n')}\n</${rootTag}>`;
}

/**
 * Creates a default blank PayloadNode
 */
export function createDefaultPayloadNode(partial?: Partial<PayloadNode>): PayloadNode {
  return {
    id: generateNodeId(),
    key: 'field',
    type: 'string',
    value: '',
    enabled: true,
    ...partial,
  };
}

/**
 * Creates an initial default PayloadBuilderConfig
 */
export function createInitialPayloadConfig(rootType: 'object' | 'list' = 'object'): PayloadBuilderConfig {
  if (rootType === 'list') {
    return {
      rootType: 'list',
      xmlContainerTag: 'items',
      xmlItemTag: 'item',
      nodes: [
        createDefaultPayloadNode({ key: '', type: 'string', value: 'example' }),
      ],
    };
  }

  return {
    rootType: 'object',
    rootKey: 'request',
    nodes: [
      createDefaultPayloadNode({ key: 'title', type: 'string', value: 'foo' }),
      createDefaultPayloadNode({ key: 'count', type: 'number', value: '1' }),
      createDefaultPayloadNode({ key: 'active', type: 'boolean', value: 'true' }),
    ],
  };
}
