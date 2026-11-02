import { PayloadNode, PayloadBuilderConfig, DateConfig } from '../types/payloadBuilder';
import { generateNodeId, createInitialPayloadConfig } from './payloadCompiler';

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

/**
 * Reverse parses raw JSON string into a structured PayloadBuilderConfig
 */
export function jsonToTree(rawJson?: string | null): { config?: PayloadBuilderConfig; error?: string } {
  const trimmed = typeof rawJson === 'string' ? rawJson.trim() : '';
  if (!trimmed) {
    return { config: createInitialPayloadConfig('object') };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err: unknown) {
    return {
      error: err instanceof Error ? err.message : 'Invalid JSON format',
    };
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
