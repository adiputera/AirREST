import {
  ActiveScope,
  ApiRequest,
  ApiResponse,
  Collection,
  CollectionItem,
  PendingExampleIntent,
  SavedExample,
  SavedExampleHeader,
  SavedExampleSummary,
} from '../types/api';

export const MAX_SAVED_EXAMPLE_NAME_RUNES = 150;
export const MAX_SAVED_EXAMPLE_BYTES = 512 * 1024; // 512 KiB
export const MAX_SAVED_EXAMPLES_PER_ITEM = 50;
export const MAX_SAVED_EXAMPLES_TOTAL_BYTES_PER_ITEM = 2 * 1024 * 1024; // 2 MiB

export type SavedExampleLanguage = 'json' | 'xml' | 'html';

export type ExampleEligibilityResult =
  | {
      eligible: true;
      previewLanguage: SavedExampleLanguage;
      contentType: string;
    }
  | {
      eligible: false;
      reason: string;
    };

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const HTTP_REASON_PHRASES: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Content',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  510: 'Not Extended',
  511: 'Network Authentication Required',
};

/**
 * Resolves a standard HTTP reason phrase when HTTP/2+ leaves statusText empty
 * or when fetcher mapped an empty non-2xx/non-200 statusText to generic "OK"/"Error".
 */
export function resolveHttpReasonPhrase(status: number, rawStatusText?: string | null): string {
  const trimmed = typeof rawStatusText === 'string' ? rawStatusText.trim() : '';
  const standard = HTTP_REASON_PHRASES[status];
  if (!trimmed) {
    return standard || (status >= 200 && status < 300 ? 'OK' : 'Error');
  }
  if (standard && ((trimmed === 'OK' && status !== 200) || (trimmed === 'Error' && status >= 300))) {
    return standard;
  }
  return trimmed;
}

export function buildDefaultExampleName(status: number, statusText?: string | null): string {
  const phrase = resolveHttpReasonPhrase(status, statusText);
  return `${status} ${phrase}`.trim();
}

export function getExampleUtf8ByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).byteLength;
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.byteLength(value, 'utf8');
  }
  return unescape(encodeURIComponent(value)).length;
}

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function validateSavedExampleName(name: string): { valid: true; name: string } | { valid: false; error: string } {
  const raw = String(name ?? '');
  if (hasLoneSurrogate(raw) || raw.includes('\u0000')) {
    return { valid: false, error: 'Example name contains invalid characters.' };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, error: 'Example name is required.' };
  }
  const runeCount = [...trimmed].length;
  if (runeCount > MAX_SAVED_EXAMPLE_NAME_RUNES) {
    return {
      valid: false,
      error: `Example name exceeds ${MAX_SAVED_EXAMPLE_NAME_RUNES} characters (${runeCount}/${MAX_SAVED_EXAMPLE_NAME_RUNES}).`,
    };
  }
  return { valid: true, name: trimmed };
}

/**
 * Recursively clones plain JSON data while stripping prototype-pollution keys
 * and rejecting NUL bytes inside string values if requested.
 */
export function sanitizeJsonValue<T>(value: T, depth = 0): T {
  if (depth > 64 || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    out[k] = sanitizeJsonValue(v, depth + 1);
  }
  return out as T;
}

function splitOutsideQuotes(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inQuotes) {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function unquoteParam(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return trimmed;
}

export interface ParsedContentTypeEntry {
  mime: string;
  charset?: string;
}

export function parseContentTypeHeader(rawHeader: string | undefined | null): ParsedContentTypeEntry[] {
  if (!rawHeader || typeof rawHeader !== 'string') return [];
  const rawEntries = splitOutsideQuotes(rawHeader, ',');
  const entries: ParsedContentTypeEntry[] = [];
  for (const rawEntry of rawEntries) {
    const trimmedEntry = rawEntry.trim();
    if (!trimmedEntry) continue;
    const segments = splitOutsideQuotes(trimmedEntry, ';');
    const mime = (segments[0] || '').trim().toLowerCase();
    if (!mime) continue;
    let charset: string | undefined;
    for (let i = 1; i < segments.length; i++) {
      const eqIdx = segments[i].indexOf('=');
      if (eqIdx <= 0) continue;
      const paramKey = segments[i].slice(0, eqIdx).trim().toLowerCase();
      if (paramKey === 'charset') {
        const paramVal = unquoteParam(segments[i].slice(eqIdx + 1)).trim().toLowerCase();
        if (paramVal) charset = paramVal;
      }
    }
    entries.push({ mime, charset });
  }
  return entries;
}

/**
 * Extracts a consistent charset from a Content-Type header, defaulting to utf-8.
 * Returns null if multiple entries declare conflicting charsets.
 */
export function resolveContentTypeCharset(rawHeader: string | undefined | null): { charset: string; conflict: boolean } {
  const entries = parseContentTypeHeader(rawHeader);
  let resolved: string | undefined;
  for (const entry of entries) {
    if (!entry.charset) continue;
    if (!resolved) {
      resolved = entry.charset;
    } else if (resolved !== entry.charset) {
      return { charset: resolved, conflict: true };
    }
  }
  return { charset: resolved || 'utf-8', conflict: false };
}

export function classifyExampleMime(mime: string): { language: SavedExampleLanguage; strictXhtml: boolean } | null {
  const m = (mime || '').trim().toLowerCase();
  if (!m) return null;
  // Strictly allow only application/* or text/* media types.
  if (!m.startsWith('application/') && !m.startsWith('text/')) {
    return null;
  }
  if (m === 'application/xhtml+xml') {
    return { language: 'html', strictXhtml: true };
  }
  if (m === 'text/html') {
    return { language: 'html', strictXhtml: false };
  }
  if (m === 'application/json' || m === 'text/json' || (m.startsWith('application/') && m.endsWith('+json'))) {
    return { language: 'json', strictXhtml: false };
  }
  if (m === 'application/xml' || m === 'text/xml' || m.endsWith('+xml')) {
    return { language: 'xml', strictXhtml: false };
  }
  return null;
}

function hasDisallowedBinaryControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0xfffd) return true;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function stripLeadingBom(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

function isWhitespaceChar(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isXmlNameStartChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    ch === '_' ||
    ch === ':' ||
    code >= 0xc0
  );
}

function isXmlNameChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    isXmlNameStartChar(ch) ||
    (code >= 48 && code <= 57) ||
    ch === '-' ||
    ch === '.'
  );
}

/**
 * Pure JS/TS XML 1.0 well-formedness validator that works identically across
 * Browser, WebView, Service Worker, and Node without DOMParser dependency.
 */
export function isValidXmlDocument(raw: string): boolean {
  if (typeof raw !== 'string' || raw.includes('\u0000') || hasLoneSurrogate(raw)) {
    return false;
  }
  const src = stripLeadingBom(raw);
  if (hasDisallowedBinaryControlChars(src)) {
    return false;
  }
  const len = src.length;
  let i = 0;
  let rootSeen = false;
  let rootClosed = false;
  const stack: string[] = [];

  const skipWs = () => {
    while (i < len && isWhitespaceChar(src[i])) i++;
  };

  const readName = (): string | null => {
    if (i >= len || !isXmlNameStartChar(src[i])) return null;
    const start = i;
    i++;
    while (i < len && isXmlNameChar(src[i])) i++;
    return src.slice(start, i);
  };

  const validateEntityOrAmp = (): boolean => {
    // src[i] === '&'
    i++;
    const semi = src.indexOf(';', i);
    if (semi <= i || semi - i > 64) return false;
    const ref = src.slice(i, semi);
    i = semi + 1;
    if (ref.startsWith('#x')) {
      return /^[0-9a-fA-F]+$/.test(ref.slice(2));
    }
    if (ref.startsWith('#')) {
      return /^[0-9]+$/.test(ref.slice(1));
    }
    return isXmlNameStartChar(ref[0]) && [...ref.slice(1)].every(isXmlNameChar);
  };

  while (i < len) {
    if (src[i] === '<') {
      if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i + 4);
        if (end < 0) return false;
        // XML comments cannot contain '--' inside body
        if (src.slice(i + 4, end).includes('--')) return false;
        i = end + 3;
        continue;
      }
      if (src.startsWith('<?', i)) {
        const end = src.indexOf('?>', i + 2);
        if (end < 0) return false;
        const targetEnd = i + 2;
        let p = targetEnd;
        while (p < end && !isWhitespaceChar(src[p])) p++;
        const target = src.slice(targetEnd, p);
        if (!target || !isXmlNameStartChar(target[0])) return false;
        if (target.toLowerCase() === 'xml' && (rootSeen || i > 0)) {
          // XML declaration only allowed at very start (after optional BOM)
          if (i > 0) return false;
        }
        i = end + 2;
        continue;
      }
      if (src.startsWith('<![CDATA[', i)) {
        if (stack.length === 0) return false;
        const end = src.indexOf(']]>', i + 9);
        if (end < 0) return false;
        i = end + 3;
        continue;
      }
      if (src.startsWith('<!DOCTYPE', i)) {
        if (rootSeen) return false;
        i += 9;
        let bracketDepth = 0;
        let quote: string | null = null;
        while (i < len) {
          const ch = src[i];
          if (quote) {
            if (ch === quote) quote = null;
          } else if (ch === '"' || ch === "'") {
            quote = ch;
          } else if (ch === '[') {
            bracketDepth++;
          } else if (ch === ']') {
            bracketDepth = Math.max(0, bracketDepth - 1);
          } else if (ch === '>' && bracketDepth === 0) {
            i++;
            break;
          }
          i++;
        }
        if (quote !== null || bracketDepth !== 0) return false;
        continue;
      }
      if (src.startsWith('</', i)) {
        i += 2;
        const name = readName();
        if (!name) return false;
        skipWs();
        if (i >= len || src[i] !== '>') return false;
        i++;
        const top = stack.pop();
        if (top !== name) return false;
        if (stack.length === 0) rootClosed = true;
        continue;
      }

      // Opening or self-closing element tag
      if (rootClosed) return false;
      if (stack.length === 0) rootSeen = true;
      i++;
      const tagName = readName();
      if (!tagName) return false;

      const attrNames = new Set<string>();
      let selfClosing = false;
      let closedTag = false;
      while (i < len) {
        const hadWs = i < len && isWhitespaceChar(src[i]);
        skipWs();
        if (i >= len) return false;
        if (src.startsWith('/>', i)) {
          i += 2;
          selfClosing = true;
          closedTag = true;
          break;
        }
        if (src[i] === '>') {
          i++;
          closedTag = true;
          break;
        }
        if (!hadWs) return false;
        const attrName = readName();
        if (!attrName || attrNames.has(attrName)) return false;
        attrNames.add(attrName);
        skipWs();
        if (i >= len || src[i] !== '=') return false;
        i++;
        skipWs();
        if (i >= len || (src[i] !== '"' && src[i] !== "'")) return false;
        const quote = src[i++];
        while (i < len && src[i] !== quote) {
          if (src[i] === '<') return false;
          if (src[i] === '&') {
            if (!validateEntityOrAmp()) return false;
          } else {
            i++;
          }
        }
        if (i >= len || src[i] !== quote) return false;
        i++;
      }
      if (!closedTag) return false;
      if (selfClosing) {
        if (stack.length === 0) rootClosed = true;
      } else {
        stack.push(tagName);
      }
      continue;
    }

    // Character data outside tags
    if (stack.length === 0) {
      if (!isWhitespaceChar(src[i])) return false;
      i++;
      continue;
    }

    if (src[i] === '&') {
      if (!validateEntityOrAmp()) return false;
      continue;
    }
    if (src.startsWith(']]>', i)) {
      return false;
    }
    i++;
  }

  return rootSeen && rootClosed && stack.length === 0;
}

export function isValidJsonExampleBody(raw: string): boolean {
  if (typeof raw !== 'string' || raw.includes('\u0000') || hasLoneSurrogate(raw)) {
    return false;
  }
  const withoutBom = stripLeadingBom(raw);
  if (!withoutBom.trim()) {
    return false;
  }
  try {
    JSON.parse(withoutBom);
    return true;
  } catch {
    return false;
  }
}

export function isValidHtmlExampleBody(raw: string, strictXhtml = false): boolean {
  if (typeof raw !== 'string' || raw.includes('\u0000') || hasLoneSurrogate(raw)) {
    return false;
  }
  const withoutBom = stripLeadingBom(raw);
  if (!withoutBom.trim() || hasDisallowedBinaryControlChars(withoutBom)) {
    return false;
  }
  if (strictXhtml) {
    return isValidXmlDocument(raw);
  }
  // Must contain at least one HTML tag, doctype, or comment so raw binary/non-HTML noise is rejected.
  return /<(?:!doctype\s+html\b|!--[\s\S]*?--|[a-zA-Z][a-zA-Z0-9:-]*(?:\s[^<>]*)?\/?)>/i.test(withoutBom);
}

export function validateExampleContentByLanguage(
  body: string,
  language: SavedExampleLanguage,
  strictXhtml = false,
): boolean {
  if (language === 'json') return isValidJsonExampleBody(body);
  if (language === 'xml') return isValidXmlDocument(body);
  return isValidHtmlExampleBody(body, strictXhtml);
}

export function evaluateExamplePayloadEligibility(input: {
  code?: number | null;
  body?: unknown;
  contentTypeHeader?: string | null;
  headers?: SavedExampleHeader[] | Record<string, string> | null;
  isBinary?: boolean;
  isImage?: boolean;
  hasDecodingError?: boolean;
  failureKind?: unknown;
  scriptErrorStage?: unknown;
}): ExampleEligibilityResult {
  const code = typeof input.code === 'number' ? input.code : Number(input.code);
  if (!Number.isInteger(code) || code < 100 || code > 599) {
    return { eligible: false, reason: 'Example requires a valid HTTP status code (100-599).' };
  }
  if (input.failureKind) {
    return { eligible: false, reason: 'Failed or incomplete transport responses cannot be saved as examples.' };
  }
  if (input.scriptErrorStage === 'pre-request') {
    return { eligible: false, reason: 'Responses aborted by pre-request script failures cannot be saved as examples.' };
  }
  if (input.isImage || input.isBinary) {
    return { eligible: false, reason: 'Binary and image responses cannot be saved as examples.' };
  }
  if (input.hasDecodingError) {
    return { eligible: false, reason: 'Response bytes could not be decoded cleanly under the declared charset.' };
  }
  if (typeof input.body !== 'string') {
    return { eligible: false, reason: 'Example response body must be text.' };
  }
  if (input.body.includes('\u0000')) {
    return { eligible: false, reason: 'Response body contains NUL bytes and cannot be saved.' };
  }
  if (stripLeadingBom(input.body).trim().length === 0) {
    return { eligible: false, reason: 'Empty or whitespace-only responses cannot be saved as examples.' };
  }
  if (getExampleUtf8ByteLength(input.body) > MAX_SAVED_EXAMPLE_BYTES) {
    return { eligible: false, reason: `Example exceeds the ${MAX_SAVED_EXAMPLE_BYTES / 1024} KiB size limit.` };
  }

  let headerValue = typeof input.contentTypeHeader === 'string' ? input.contentTypeHeader : '';
  if (!headerValue && input.headers) {
    if (Array.isArray(input.headers)) {
      const matchedValues = input.headers
        .filter((h) => h && !h.disabled && String(h.key || '').trim().toLowerCase() === 'content-type')
        .map((h) => String(h.value || '').trim())
        .filter(Boolean);
      headerValue = matchedValues.join(', ');
    } else if (typeof input.headers === 'object') {
      for (const [k, v] of Object.entries(input.headers)) {
        if (k.trim().toLowerCase() === 'content-type' && typeof v === 'string' && v.trim()) {
          headerValue = headerValue ? `${headerValue}, ${v.trim()}` : v.trim();
        }
      }
    }
  }

  const parsedEntries = parseContentTypeHeader(headerValue);
  if (parsedEntries.length === 0) {
    return { eligible: false, reason: 'Missing or unrecognized Content-Type header.' };
  }

  let resolvedLanguage: SavedExampleLanguage | null = null;
  let strictXhtml = false;
  let resolvedCharset: string | undefined;
  for (const entry of parsedEntries) {
    const classified = classifyExampleMime(entry.mime);
    if (!classified) {
      return { eligible: false, reason: `Unsupported Content-Type "${entry.mime}" for saved examples.` };
    }
    if (resolvedLanguage === null) {
      resolvedLanguage = classified.language;
    } else if (resolvedLanguage !== classified.language) {
      return { eligible: false, reason: 'Conflicting Content-Type header values.' };
    }
    if (classified.strictXhtml) {
      strictXhtml = true;
    }
    if (entry.charset) {
      if (!resolvedCharset) {
        resolvedCharset = entry.charset;
      } else if (resolvedCharset !== entry.charset) {
        return { eligible: false, reason: 'Conflicting Content-Type charset parameters.' };
      }
    }
  }

  if (!resolvedLanguage) {
    return { eligible: false, reason: 'Unsupported Content-Type header.' };
  }

  if (!validateExampleContentByLanguage(input.body, resolvedLanguage, strictXhtml)) {
    return {
      eligible: false,
      reason: `Response body is not valid ${strictXhtml ? 'XHTML' : resolvedLanguage.toUpperCase()} content.`,
    };
  }

  return {
    eligible: true,
    previewLanguage: resolvedLanguage,
    contentType: parsedEntries[0].mime,
  };
}

export function evaluateResponseExampleEligibility(response: ApiResponse | null | undefined): ExampleEligibilityResult {
  if (!response) {
    return { eligible: false, reason: 'No response available.' };
  }
  return evaluateExamplePayloadEligibility({
    code: response.status,
    body: response.data,
    contentTypeHeader: response.rawContentType || response.contentType,
    headers: response.headers,
    isBinary: response.isBinary,
    isImage: response.isImage,
    hasDecodingError: response.hasDecodingError,
    failureKind: response.failureKind,
    scriptErrorStage: response.scriptErrorStage,
  });
}

function defaultGenerateExampleId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Converts an AirREST ApiRequest into a Postman-compatible originalRequest snapshot,
 * keeping {{variable}} placeholders unresolved and sanitizing live File/Blob handles.
 */
export function buildOriginalRequestSnapshot(
  req: ApiRequest,
  buildUrlObj: (rawUrl: string, params: ApiRequest['params'], pathVariables?: ApiRequest['pathVariables']) => unknown,
): Record<string, unknown> {
  const headers = (req.headers || [])
    .filter((h) => h && (String(h.key ?? '').trim() !== '' || String(h.value ?? '').trim() !== ''))
    .map((h) => ({
      key: String(h.key ?? ''),
      value: String(h.value ?? ''),
      ...(h.enabled === false ? { disabled: true } : {}),
      ...(h.description ? { description: h.description } : {}),
    }));

  let body: Record<string, unknown> | undefined;
  if (req.bodyType === 'json' || (req.bodyType === 'raw' && req.rawType === 'json')) {
    body = { mode: 'raw', raw: req.bodyContent || '', options: { raw: { language: 'json' } } };
  } else if (req.bodyType === 'xml' || (req.bodyType === 'raw' && req.rawType === 'xml')) {
    body = { mode: 'raw', raw: req.bodyContent || '', options: { raw: { language: 'xml' } } };
  } else if (req.bodyType === 'raw' && req.rawType === 'html') {
    body = { mode: 'raw', raw: req.bodyContent || '', options: { raw: { language: 'html' } } };
  } else if (req.bodyType === 'raw') {
    body = { mode: 'raw', raw: req.bodyContent || '', options: { raw: { language: 'text' } } };
  } else if (req.bodyType === 'graphql') {
    body = {
      mode: 'graphql',
      graphql: {
        query: req.graphqlQuery || req.bodyContent || '',
        variables: req.graphqlVariables || '',
      },
    };
  } else if (req.bodyType === 'x-www-form-urlencoded') {
    body = {
      mode: 'urlencoded',
      urlencoded: (req.bodyUrlEncoded || [])
        .filter((row) => row && (String(row.key ?? '').trim() !== '' || String(row.value ?? '').trim() !== ''))
        .map((row) => ({
          key: String(row.key ?? ''),
          value: String(row.value ?? ''),
          type: 'text',
          ...(row.enabled === false ? { disabled: true } : {}),
          ...(row.description ? { description: row.description } : {}),
        })),
    };
  } else if (req.bodyType === 'form-data') {
    body = {
      mode: 'formdata',
      formdata: (req.bodyFormData || [])
        .filter((row) => row && (String(row.key ?? '').trim() !== '' || String(row.value ?? '').trim() !== '' || row.fileName))
        .map((row) => ({
          key: String(row.key ?? ''),
          type: row.type === 'file' ? 'file' : 'text',
          ...(row.type === 'file'
            ? { src: row.fileName || row.file?.name || String(row.value ?? '') }
            : { value: String(row.value ?? '') }),
          ...(row.enabled === false ? { disabled: true } : {}),
        })),
    };
  } else if (req.bodyType === 'binary') {
    body = {
      mode: 'file',
      file: {
        src: req.bodyBinaryFile?.name || req.bodyBinaryFile?.file?.name || '',
      },
    };
  }

  let auth: Record<string, unknown> | undefined;
  if (req.auth?.type === 'bearer') {
    auth = { type: 'bearer', bearer: [{ key: 'token', value: req.auth.bearerToken || '', type: 'string' }] };
  } else if (req.auth?.type === 'basic') {
    auth = {
      type: 'basic',
      basic: [
        { key: 'username', value: req.auth.basicUsername || '', type: 'string' },
        { key: 'password', value: req.auth.basicPassword || '', type: 'string' },
      ],
    };
  } else if (req.auth?.type === 'apikey') {
    auth = {
      type: 'apikey',
      apikey: [
        { key: 'key', value: req.auth.apiKeyKey || '', type: 'string' },
        { key: 'value', value: req.auth.apiKeyValue || '', type: 'string' },
        { key: 'in', value: req.auth.apiKeyIn || 'header', type: 'string' },
      ],
    };
  }

  return sanitizeJsonValue({
    method: req.method,
    header: headers,
    url: buildUrlObj(req.url, req.params, req.pathVariables),
    ...(body ? { body } : {}),
    ...(auth ? { auth } : {}),
  });
}

export function buildSavedExampleFromResponse(input: {
  id?: string;
  name: string;
  response: ApiResponse;
  requestSnapshot: ApiRequest;
  buildUrlObj: (rawUrl: string, params: ApiRequest['params'], pathVariables?: ApiRequest['pathVariables']) => unknown;
}): { ok: true; example: SavedExample } | { ok: false; error: string } {
  const nameValidation = validateSavedExampleName(input.name);
  if (!nameValidation.valid) {
    return { ok: false, error: nameValidation.error };
  }

  const eligibility = evaluateResponseExampleEligibility(input.response);
  if (!eligibility.eligible) {
    return { ok: false, error: eligibility.reason };
  }

  const headerList: SavedExampleHeader[] = Object.entries(input.response.headers || {}).map(([key, value]) => ({
    key: String(key),
    value: String(value ?? ''),
  }));

  const example: SavedExample = {
    id: input.id || defaultGenerateExampleId(),
    revision: 1,
    name: nameValidation.name,
    originalRequest: buildOriginalRequestSnapshot(input.requestSnapshot, input.buildUrlObj),
    status: resolveHttpReasonPhrase(input.response.status, input.response.statusText),
    code: input.response.status,
    header: headerList,
    cookie: [],
    body: input.response.data,
    _postman_previewlanguage: eligibility.previewLanguage,
  };

  if (getExampleUtf8ByteLength(JSON.stringify(example)) > MAX_SAVED_EXAMPLE_BYTES) {
    return {
      ok: false,
      error: `Saved example payload exceeds the ${MAX_SAVED_EXAMPLE_BYTES / 1024} KiB limit.`,
    };
  }

  return { ok: true, example };
}

export function cloneSavedExample(example: SavedExample, regenerateId = false): SavedExample {
  const cloned = sanitizeJsonValue({ ...example });
  return {
    ...cloned,
    id: regenerateId ? defaultGenerateExampleId() : String(cloned.id || defaultGenerateExampleId()),
    revision: regenerateId ? 1 : (typeof cloned.revision === 'number' && cloned.revision >= 1 ? Math.floor(cloned.revision) : 1),
    name: String(cloned.name ?? ''),
    status: String(cloned.status ?? ''),
    code: typeof cloned.code === 'number' ? cloned.code : Number(cloned.code) || 200,
    header: Array.isArray(cloned.header)
      ? cloned.header.map((h) => ({
          key: String(h?.key ?? ''),
          value: String(h?.value ?? ''),
          ...(h?.disabled ? { disabled: true } : {}),
          ...(h?.description ? { description: String(h.description) } : {}),
        }))
      : [],
    cookie: Array.isArray(cloned.cookie) ? cloned.cookie.map((c) => sanitizeJsonValue({ ...c })) : [],
    body: String(cloned.body ?? ''),
  };
}

export function cloneSavedExamplesList(examples?: SavedExample[], regenerateIds = false): SavedExample[] | undefined {
  if (!Array.isArray(examples)) return undefined;
  return examples.map((ex) => cloneSavedExample(ex, regenerateIds));
}

export function cloneSavedExampleSummaries(summaries?: SavedExampleSummary[]): SavedExampleSummary[] | undefined {
  if (!Array.isArray(summaries)) return undefined;
  return summaries.map((s) => ({
    id: String(s.id),
    revision: typeof s.revision === 'number' && s.revision >= 1 ? Math.floor(s.revision) : 1,
    name: String(s.name ?? ''),
    code: typeof s.code === 'number' ? s.code : Number(s.code) || 200,
    status: String(s.status ?? ''),
    ...('_postman_previewlanguage' in s ? { _postman_previewlanguage: s._postman_previewlanguage ?? null } : {}),
    body_size_bytes: typeof s.body_size_bytes === 'number' ? s.body_size_bytes : 0,
  }));
}

export function buildExampleSummariesFromExamples(examples: SavedExample[] = []): SavedExampleSummary[] {
  return examples.map((ex) => ({
    id: ex.id,
    revision: typeof ex.revision === 'number' && ex.revision >= 1 ? Math.floor(ex.revision) : 1,
    name: ex.name,
    code: ex.code,
    status: ex.status,
    ...('_postman_previewlanguage' in ex ? { _postman_previewlanguage: ex._postman_previewlanguage ?? null } : {}),
    body_size_bytes: getExampleUtf8ByteLength(ex.body || ''),
  }));
}

export function getDisplayExampleSummaries(item: CollectionItem | null | undefined): SavedExampleSummary[] {
  if (!item || item.type !== 'request') return [];
  if (Array.isArray(item.examples) && (item.examplesLoaded !== false || !Array.isArray(item.exampleSummaries))) {
    return buildExampleSummariesFromExamples(item.examples);
  }
  if (Array.isArray(item.exampleSummaries)) {
    return item.exampleSummaries;
  }
  return [];
}

export function getItemExampleCount(item: CollectionItem | null | undefined): number {
  if (!item || item.type !== 'request') return 0;
  if (Array.isArray(item.examples) && item.examplesLoaded !== false) {
    return item.examples.length;
  }
  if (typeof item.exampleCount === 'number' && item.exampleCount >= 0) {
    return item.exampleCount;
  }
  if (Array.isArray(item.exampleSummaries)) {
    return item.exampleSummaries.length;
  }
  return Array.isArray(item.examples) ? item.examples.length : 0;
}

export function collectionHasSavedExamples(collection: Collection | null | undefined): boolean {
  if (!collection) return false;
  const walk = (items: CollectionItem[] = []): boolean => {
    for (const item of items) {
      if (!item) continue;
      if (item.type === 'request' && getItemExampleCount(item) > 0) return true;
      if (item.type === 'folder' && Array.isArray(item.items) && walk(item.items)) return true;
    }
    return false;
  };
  return walk(collection.items || []);
}

export function hasUnloadedCollectionExamples(collection: Collection | null | undefined): boolean {
  if (!collection) return false;
  const walk = (items: CollectionItem[] = []): boolean => {
    for (const item of items) {
      if (!item) continue;
      if (item.type === 'request' && item.examplesLoaded === false && getItemExampleCount(item) > 0) {
        return true;
      }
      if (item.type === 'folder' && Array.isArray(item.items) && walk(item.items)) {
        return true;
      }
    }
    return false;
  };
  return walk(collection.items || []);
}

export function stripInternalExampleFieldsForPostman(example: SavedExample): Record<string, unknown> {
  const sanitized = sanitizeJsonValue({ ...example }) as Record<string, unknown>;
  delete sanitized.id;
  delete sanitized.revision;
  return sanitized;
}

export function countCollectionSavedExamples(collection: Collection | null | undefined): number {
  if (!collection) return 0;
  const sumItems = (items: CollectionItem[] = []): number => {
    let total = 0;
    for (const item of items) {
      if (!item) continue;
      if (item.type === 'request') {
        total += getItemExampleCount(item);
      } else if (item.type === 'folder' && Array.isArray(item.items)) {
        total += sumItems(item.items);
      }
    }
    return total;
  };
  return sumItems(collection.items || []);
}

export function collectRequestItemsMap(items: CollectionItem[] = [], out = new Map<string, CollectionItem>()): Map<string, CollectionItem> {
  for (const item of items) {
    if (!item) continue;
    if (item.type === 'request') {
      out.set(item.id, item);
    } else if (item.type === 'folder' && Array.isArray(item.items)) {
      collectRequestItemsMap(item.items, out);
    }
  }
  return out;
}

export function preserveHydratedItemExamples(
  pulledItems: CollectionItem[],
  existingItems: CollectionItem[],
): CollectionItem[] {
  const existingMap = collectRequestItemsMap(existingItems);
  const walk = (items: CollectionItem[]): CollectionItem[] =>
    (items || []).map((item) => {
      if (item.type === 'folder') {
        return {
          ...item,
          items: item.items ? walk(item.items) : [],
        };
      }
      if (item.type === 'request' && item.examplesLoaded === false) {
        const existing = existingMap.get(item.id);
        if (
          existing &&
          existing.type === 'request' &&
          existing.examplesLoaded === true &&
          Array.isArray(existing.examples) &&
          typeof item.version === 'number' &&
          typeof existing.version === 'number' &&
          item.version === existing.version
        ) {
          const clonedExamples = cloneSavedExamplesList(existing.examples, false) ?? [];
          return {
            ...item,
            examples: clonedExamples,
            exampleSummaries: existing.exampleSummaries
              ? (cloneSavedExampleSummaries(existing.exampleSummaries) ?? buildExampleSummariesFromExamples(clonedExamples))
              : buildExampleSummariesFromExamples(clonedExamples),
            exampleCount: existing.exampleCount ?? clonedExamples.length,
            exampleSummariesTruncated: false,
            examplesLoaded: true,
          };
        }
      }
      return item;
    });
  return walk(pulledItems);
}

export function updateCollectionItemById(
  items: CollectionItem[],
  targetItemId: string,
  updater: (item: CollectionItem) => CollectionItem,
): { items: CollectionItem[]; found: boolean } {
  let found = false;
  const walk = (list: CollectionItem[]): CollectionItem[] =>
    (list || []).map((item) => {
      if (item.id === targetItemId) {
        found = true;
        return updater(item);
      }
      if (item.type === 'folder' && Array.isArray(item.items)) {
        const nextChildren = walk(item.items);
        if (nextChildren !== item.items) {
          return { ...item, items: nextChildren };
        }
      }
      return item;
    });
  const nextItems = walk(items);
  return { items: found ? nextItems : items, found };
}

export function findCollectionItemById(
  items: CollectionItem[] | undefined,
  targetItemId: string,
): CollectionItem | undefined {
  for (const item of items || []) {
    if (!item) continue;
    if (item.id === targetItemId) return item;
    if (item.type === 'folder' && Array.isArray(item.items)) {
      const nested = findCollectionItemById(item.items, targetItemId);
      if (nested) return nested;
    }
  }
  return undefined;
}

export function applyExampleMutationToItem(
  item: CollectionItem,
  mutation: {
    op: 'add' | 'rename' | 'delete';
    example?: SavedExample;
    exampleId?: string;
    name?: string;
    nextVersion?: number;
    nextExampleRevision?: number;
  },
): CollectionItem {
  if (item.type !== 'request') return item;
  const hasFullExamples = Array.isArray(item.examples) && item.examplesLoaded !== false;
  let nextExamples = hasFullExamples ? cloneSavedExamplesList(item.examples!, false) : undefined;
  let nextSummaries: SavedExampleSummary[] = Array.isArray(item.exampleSummaries)
    ? (cloneSavedExampleSummaries(item.exampleSummaries) ?? [])
    : nextExamples
      ? buildExampleSummariesFromExamples(nextExamples)
      : [];
  let nextCount = getItemExampleCount(item);

  if (mutation.op === 'add' && mutation.example) {
    const added = cloneSavedExample(mutation.example, false);
    const addedSummary = buildExampleSummariesFromExamples([added])[0];
    if (nextExamples) {
      if (!nextExamples.some((ex) => ex.id === added.id)) {
        nextExamples.push(added);
      }
      nextSummaries = buildExampleSummariesFromExamples(nextExamples);
      nextCount = nextExamples.length;
    } else if (!nextSummaries.some((s) => s.id === added.id)) {
      nextSummaries.push(addedSummary);
      nextCount += 1;
    }
  } else if (mutation.op === 'rename' && mutation.exampleId && typeof mutation.name === 'string') {
    const trimmed = mutation.name.trim();
    if (nextExamples) {
      nextExamples = nextExamples.map((ex) =>
        ex.id === mutation.exampleId
          ? {
              ...ex,
              name: trimmed,
              revision: mutation.nextExampleRevision ?? ((ex.revision || 1) + 1),
            }
          : ex,
      );
      nextSummaries = buildExampleSummariesFromExamples(nextExamples);
    } else {
      nextSummaries = nextSummaries.map((s) =>
        s.id === mutation.exampleId
          ? {
              ...s,
              name: trimmed,
              revision: mutation.nextExampleRevision ?? ((s.revision || 1) + 1),
            }
          : s,
      );
    }
  } else if (mutation.op === 'delete' && mutation.exampleId) {
    if (nextExamples) {
      const before = nextExamples.length;
      nextExamples = nextExamples.filter((ex) => ex.id !== mutation.exampleId);
      if (nextExamples.length !== before) {
        nextSummaries = buildExampleSummariesFromExamples(nextExamples);
        nextCount = nextExamples.length;
      }
    } else {
      const hadSummary = nextSummaries.some((s) => s.id === mutation.exampleId);
      nextSummaries = nextSummaries.filter((s) => s.id !== mutation.exampleId);
      if (hadSummary && nextCount > 0) {
        nextCount -= 1;
      }
    }
  }

  return {
    ...item,
    ...(typeof mutation.nextVersion === 'number' ? { version: mutation.nextVersion } : {}),
    ...(nextExamples ? { examples: nextExamples } : {}),
    exampleSummaries: nextSummaries,
    exampleCount: nextCount,
    examplesLoaded: hasFullExamples,
  };
}

export function applyServerItemToLocalItem(
  existing: CollectionItem,
  serverItem: any,
): CollectionItem {
  const examples = Array.isArray(serverItem?.examples)
    ? cloneSavedExamplesList(serverItem.examples, false)
    : existing.examples;
  const exampleSummaries = Array.isArray(serverItem?.example_summaries)
    ? cloneSavedExampleSummaries(serverItem.example_summaries)
    : Array.isArray(examples)
      ? buildExampleSummariesFromExamples(examples)
      : existing.exampleSummaries;
  const examplesLoaded =
    typeof serverItem?.examples_loaded === 'boolean'
      ? serverItem.examples_loaded
      : Array.isArray(serverItem?.examples)
        ? true
        : existing.examplesLoaded;
  const exampleCount =
    typeof serverItem?.example_count === 'number'
      ? serverItem.example_count
      : Array.isArray(examples) && examplesLoaded !== false
        ? examples.length
        : Array.isArray(exampleSummaries)
          ? exampleSummaries.length
          : getItemExampleCount(existing);
  return {
    ...existing,
    ...(typeof serverItem?.version === 'number' ? { version: serverItem.version } : {}),
    ...(examples ? { examples } : {}),
    ...(exampleSummaries ? { exampleSummaries } : {}),
    exampleCount,
    exampleSummariesTruncated: serverItem?.example_summaries_truncated === true,
    examplesLoaded,
  };
}

export function overlayPendingExampleIntentsOnCollections(
  collections: Collection[],
  intents: Record<string, PendingExampleIntent> | undefined,
  ownerKey: string | null,
  activeScope?: ActiveScope,
): Collection[] {
  if (!intents) return collections;
  const relevant = Object.values(intents)
    .filter((intent) => {
      if (!intent) return false;
      if (intent.ownerKey !== null && ownerKey !== null && intent.ownerKey !== ownerKey) return false;
      if (activeScope && intent.targetScope) {
        if (intent.targetScope.id !== activeScope.id || intent.targetScope.type !== activeScope.type) {
          return false;
        }
      }
      return true;
    })
    .sort((a, b) => a.createdAt - b.createdAt);

  if (relevant.length === 0) return collections;

  let nextCollections = collections;
  for (const intent of relevant) {
    nextCollections = nextCollections.map((col) => {
      if (col.id !== intent.collectionId) return col;
      const updated = updateCollectionItemById(col.items || [], intent.itemId, (item) =>
        applyExampleMutationToItem(item, {
          op: intent.op,
          example: intent.example,
          exampleId: intent.exampleId,
          name: intent.name,
        }),
      );
      return updated.found ? { ...col, items: updated.items } : col;
    });
  }
  return nextCollections;
}
