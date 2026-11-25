import { ApiRequest, ApiResponse, NetworkErrorCategory } from '../types/api';
import { PlatformAdapter, TestRequestOptions } from '../types/platform';
import { resolveBodyContentTypeHeader, resolveEffectiveAuthHeader, resolveManualHeaders } from './authHeaders';
import { createTrackedBlobUrl, createTrackedRawBody } from './blobManager';
import { compileEffectiveJsonPayload } from './formatters';
import { substitutePathVariables } from './urlParams';

const STANDARD_HTTP_REASON_PHRASES: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints',
  200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information',
  204: 'No Content', 205: 'Reset Content', 206: 'Partial Content', 207: 'Multi-Status',
  208: 'Already Reported', 226: 'IM Used',
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
  304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable',
  407: 'Proxy Authentication Required', 408: 'Request Timeout', 409: 'Conflict',
  410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large',
  414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable',
  417: 'Expectation Failed', 418: "I'm a teapot", 421: 'Misdirected Request',
  422: 'Unprocessable Content', 423: 'Locked', 424: 'Failed Dependency', 425: 'Too Early',
  426: 'Upgrade Required', 428: 'Precondition Required', 429: 'Too Many Requests',
  431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout', 505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates', 507: 'Insufficient Storage', 508: 'Loop Detected',
  510: 'Not Extended', 511: 'Network Authentication Required',
};

function resolveContentTypeCharset(rawHeader: string | undefined | null): { charset: string; conflict: boolean } {
  if (!rawHeader || typeof rawHeader !== 'string') return { charset: 'utf-8', conflict: false };
  let resolved: string | undefined;
  let current = '';
  let inQuotes = false;
  let escaped = false;
  const entries: string[] = [];
  for (let i = 0; i < rawHeader.length; i++) {
    const ch = rawHeader[i];
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
    if (ch === ',' && !inQuotes) {
      entries.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  entries.push(current);

  for (const entry of entries) {
    const match = entry.match(/;\s*charset\s*=\s*(?:"([^"]*)"|([^;,\s]*))/i);
    const cs = (match?.[1] ?? match?.[2] ?? '').trim().toLowerCase();
    if (!cs) continue;
    if (!resolved) resolved = cs;
    else if (resolved !== cs) return { charset: resolved, conflict: true };
  }
  return { charset: resolved || 'utf-8', conflict: false };
}

export const RESPONSE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024; // 10 MiB
export const MAX_OUTBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MiB
export const REQUEST_TIMEOUT_MS = 300_000; // 300 seconds (5 minutes)

export class ResponseTooLargeError extends Error {
  constructor() {
    super(`Response exceeded the ${RESPONSE_SIZE_LIMIT_BYTES / (1024 * 1024)} MiB limit.`);
    this.name = 'ResponseTooLargeError';
  }
}

export async function readResponseBody(
  response: Response,
  controller: AbortController,
  options?: { method?: string }
): Promise<Uint8Array> {
  const isBodyless =
    options?.method?.toUpperCase() === 'HEAD' ||
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304;
  if (isBodyless) {
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // ignore cancellation failure on bodyless response
      }
    }
    return new Uint8Array();
  }

  const declaredSize = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(declaredSize) && declaredSize > RESPONSE_SIZE_LIMIT_BYTES) {
    controller.abort();
    throw new ResponseTooLargeError();
  }

  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > RESPONSE_SIZE_LIMIT_BYTES) {
        controller.abort();
        try {
          await reader.cancel();
        } catch {
          // ignore secondary cancellation failure
        }
        throw new ResponseTooLargeError();
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Replaces {{variable}} placeholders with values from variables map
 * and dynamic Postman-style variables: {{$guid}}, {{$timestamp}}, {{$isoTimestamp}}, {{$randomInt}}
 */
export function interpolateVariables(input: string, variables: Record<string, string> = {}): string {
  if (!input) return input;

  return input.replace(/\{\{([^{}]+)\}\}/g, (match, varName) => {
    const trimmed = varName.trim();

    // Built-in dynamic variables
    if (trimmed === '$guid') {
      return typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }
    if (trimmed === '$timestamp') {
      return Math.floor(Date.now() / 1000).toString();
    }
    if (trimmed === '$isoTimestamp') {
      return new Date().toISOString();
    }
    if (trimmed === '$randomInt') {
      return (Math.floor(Math.random() * 1000) + 1).toString();
    }

    // Custom environment or script variables
    if (variables[trimmed] !== undefined) {
      return variables[trimmed];
    }

    return match; // Keep unchanged if not found
  });
}

/**
 * Builds query parameters, attaches auth headers, interpolates variables,
 * and constructs the final request payload.
 */
export function prepareRequest(
  request: ApiRequest,
  variables: Record<string, string> = {}
): {
  finalUrl: string;
  finalHeaders: Record<string, string>;
  finalBody?: BodyInit;
} {
  let rawUrl = interpolateVariables((request?.url || '').trim(), variables);

  // Substitute path variables if present
  if (request.pathVariables && request.pathVariables.length > 0) {
    const interpolatedPathVars = request.pathVariables.map((pv) => ({
      ...pv,
      value: interpolateVariables(String(pv.value ?? ''), variables),
    }));
    rawUrl = substitutePathVariables(rawUrl, interpolatedPathVars);
  }

  // If no scheme provided, default to http:// for localhost/private network IPs or https:// for others
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(rawUrl)) {
    const isLocalOrIp = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i.test(rawUrl);
    rawUrl = isLocalOrIp ? `http://${rawUrl}` : `https://${rawUrl}`;
  }

  // Append query params
  try {
    const parsedUrl = new URL(rawUrl);
    const clearedKeys = new Set<string>();
    for (const p of request.params || []) {
      if (!p) continue;
      const paramKey = interpolateVariables(String(p.key || '').trim(), variables);
      if (!paramKey) continue;
      if (!clearedKeys.has(paramKey)) {
        clearedKeys.add(paramKey);
        parsedUrl.searchParams.delete(paramKey);
      }
      if (p.enabled) {
        const paramVal = interpolateVariables(String(p.value ?? ''), variables);
        parsedUrl.searchParams.append(paramKey, paramVal);
      }
    }
    rawUrl = parsedUrl.toString();
  } catch {
    // Retain URL as is if parsing fails
  }

  // Construct headers and enforce Auth + managed Body Content-Type precedence (case-insensitive)
  const resolveVar = (input: string) => interpolateVariables(input, variables);
  const effectiveAuth = resolveEffectiveAuthHeader(request.auth, resolveVar);
  const bodyContentType = resolveBodyContentTypeHeader(request);
  const resolvedManualHeaders = resolveManualHeaders(
    request.headers || [],
    [
      effectiveAuth?.normalizedKey ?? null,
      bodyContentType?.isManagedByRuntime ? 'content-type' : null,
    ],
    resolveVar
  );

  const headers: Record<string, string> = {};
  for (const h of resolvedManualHeaders) {
    if (h.key.trim().toLowerCase() === 'cookie') {
      const existingCookieKey = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie');
      if (existingCookieKey) {
        headers[existingCookieKey] = headers[existingCookieKey]
          ? `${headers[existingCookieKey]}; ${h.value}`
          : h.value;
        continue;
      }
    }
    headers[h.key] = h.value;
  }

  if (effectiveAuth) {
    headers[effectiveAuth.key] = effectiveAuth.value;
  }

  // Add API Key to query params if configured
  if (
    request.auth?.type === 'apikey' &&
    request.auth?.apiKeyIn === 'query' &&
    request.auth?.apiKeyKey?.trim() &&
    request.auth?.apiKeyValue?.trim()
  ) {
    const key = interpolateVariables(request.auth.apiKeyKey.trim(), variables).trim();
    const val = interpolateVariables(request.auth.apiKeyValue.trim(), variables);
    if (key) {
      try {
        const parsedUrl = new URL(rawUrl);
        parsedUrl.searchParams.set(key, val);
        rawUrl = parsedUrl.toString();
      } catch {
        // ignore URL parse errors
      }
    }
  }

  let bodyPayload: BodyInit | undefined = undefined;
  const hasContentTypeHeader = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.bodyType === 'json' || (request.bodyType === 'raw' && request.rawType === 'json')) {
      if (!hasContentTypeHeader) {
        headers['Content-Type'] = 'application/json';
      }
      bodyPayload = compileEffectiveJsonPayload(interpolateVariables(request.bodyContent || '', variables));
    } else if (request.bodyType === 'graphql') {
      if (!hasContentTypeHeader) {
        headers['Content-Type'] = 'application/json';
      }
      const rawQuery = interpolateVariables(request.graphqlQuery || request.bodyContent || '', variables);
      const rawVars = compileEffectiveJsonPayload(interpolateVariables(request.graphqlVariables || '', variables)).trim();
      let parsedVars: unknown = undefined;
      if (rawVars) {
        try {
          parsedVars = JSON.parse(rawVars);
        } catch {
          // If not standard JSON, retain rawVars or empty
        }
      }
      const gqlBody: { query: string; variables?: unknown } = {
        query: rawQuery,
      };
      if (parsedVars !== undefined) {
        gqlBody.variables = parsedVars;
      }
      bodyPayload = JSON.stringify(gqlBody);
    } else if (request.bodyType === 'xml' || (request.bodyType === 'raw' && request.rawType === 'xml')) {
      if (!hasContentTypeHeader) {
        headers['Content-Type'] = 'application/xml';
      }
      bodyPayload = interpolateVariables(request.bodyContent || '', variables);
    } else if (request.bodyType === 'raw' && request.rawType === 'html') {
      if (!hasContentTypeHeader) {
        headers['Content-Type'] = 'text/html';
      }
      bodyPayload = interpolateVariables(request.bodyContent || '', variables);
    } else if (request.bodyType === 'raw') {
      if (!hasContentTypeHeader) {
        headers['Content-Type'] = 'text/plain';
      }
      bodyPayload = interpolateVariables(request.bodyContent || '', variables);
    } else if (request.bodyType === 'x-www-form-urlencoded') {
      if (!hasContentTypeHeader) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      const activeItems = (request.bodyUrlEncoded || []).filter(
        (item) => item.enabled && String(item?.key ?? '').trim() !== ''
      );
      if (activeItems.length > 0) {
        const formParams = new URLSearchParams();
        for (const item of activeItems) {
          const k = interpolateVariables(String(item.key).trim(), variables);
          const v = interpolateVariables(String(item.value ?? ''), variables);
          formParams.append(k, v);
        }
        bodyPayload = formParams.toString();
      } else {
        bodyPayload = interpolateVariables(request.bodyContent || '', variables);
      }
    } else if (request.bodyType === 'form-data') {
      const formData = new FormData();
      const activeFormItems = (request.bodyFormData || []).filter(
        (item) => item.enabled && String(item?.key ?? '').trim() !== ''
      );

      for (const item of activeFormItems) {
        const itemKey = interpolateVariables(String(item.key).trim(), variables);
        if (item.type === 'file') {
          if (!(item.file instanceof Blob)) {
            throw new Error(`Attachment for “${item.key || item.fileName || 'unnamed field'}” must be selected again.`);
          }
          if (item.file.size > MAX_OUTBOUND_ATTACHMENT_BYTES) {
            throw new Error(
              `Attachment “${item.fileName || item.key}” exceeds the 25 MB payload limit (size: ${(item.file.size / (1024 * 1024)).toFixed(1)} MB).`
            );
          }
          formData.append(itemKey, item.file, item.file.name || item.fileName || 'file.bin');
        } else {
          formData.append(itemKey, interpolateVariables(String(item.value ?? ''), variables));
        }
      }

      bodyPayload = formData;
      for (const existingKey of Object.keys(headers)) {
        if (existingKey.toLowerCase() === 'content-type') {
          delete headers[existingKey];
        }
      }
    } else if (request.bodyType === 'binary') {
      if (!(request.bodyBinaryFile?.file instanceof Blob)) {
        throw new Error(`Binary attachment “${request.bodyBinaryFile?.name || 'unnamed file'}” must be selected again.`);
      }
      if (request.bodyBinaryFile.file.size > MAX_OUTBOUND_ATTACHMENT_BYTES) {
        throw new Error(
          `Binary attachment “${request.bodyBinaryFile.name}” exceeds the 25 MB payload limit.`
        );
      }
      bodyPayload = request.bodyBinaryFile.file;
      if (!hasContentTypeHeader) {
        headers['Content-Type'] = request.bodyBinaryFile.type || 'application/octet-stream';
      }
    }
  }

  return {
    finalUrl: rawUrl,
    finalHeaders: headers,
    finalBody: bodyPayload,
  };
}

export function detectMediaType(
  buffer: Uint8Array,
  declaredContentType: string
): { isBinary: boolean; isImage: boolean; mimeType: string } {
  const declared = (declaredContentType || '').split(';')[0].trim().toLowerCase();

  if (declared.startsWith('image/')) {
    return { isBinary: true, isImage: true, mimeType: declared };
  }

  const isKnownText =
    declared.startsWith('text/') ||
    declared.includes('json') ||
    // Office Open XML documents are ZIP packages, not XML text.
    declared === 'application/xml' ||
    declared.endsWith('+xml') ||
    declared.includes('javascript') ||
    declared.includes('ecmascript') ||
    declared.includes('x-www-form-urlencoded') ||
    declared.includes('graphql');

  if (isKnownText) {
    return { isBinary: false, isImage: false, mimeType: declared };
  }

  const isKnownBinary =
    declared === 'application/octet-stream' ||
    declared === 'application/pdf' ||
    declared === 'application/wasm' ||
    declared === 'application/msword' ||
    declared === 'application/vnd.ms-powerpoint' ||
    declared === 'application/vnd.ms-excel' ||
    declared.startsWith('application/vnd.ms-excel.') ||
    declared.startsWith('application/vnd.ms-powerpoint.') ||
    declared.startsWith('application/vnd.ms-word.') ||
    declared.startsWith('application/vnd.openxmlformats-officedocument.') ||
    declared === 'application/x-7z-compressed' ||
    declared === 'application/vnd.rar' ||
    declared === 'application/x-rar-compressed' ||
    declared.includes('zip') ||
    declared.includes('tar') ||
    declared.includes('gzip') ||
    declared.startsWith('audio/') ||
    declared.startsWith('video/');

  // Magic-byte image sniffing runs only when Content-Type is absent or generic octet-stream,
  // preventing text/plain or text/csv payloads starting with "BM" or "GIF8" from turning into images.
  if ((!declared || declared === 'application/octet-stream') && buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return { isBinary: true, isImage: true, mimeType: 'image/png' };
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { isBinary: true, isImage: true, mimeType: 'image/jpeg' };
    }
    if (
      buffer.length >= 6 &&
      buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38 &&
      (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61
    ) {
      return { isBinary: true, isImage: true, mimeType: 'image/gif' };
    }
    if (
      buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
    ) {
      return { isBinary: true, isImage: true, mimeType: 'image/webp' };
    }
    // 2-byte "BM" only qualifies when undeclared and the BMP header reserved bytes (6..9) are zero.
    if (
      !declared &&
      buffer.length >= 14 &&
      buffer[0] === 0x42 && buffer[1] === 0x4d &&
      buffer[6] === 0x00 && buffer[7] === 0x00 && buffer[8] === 0x00 && buffer[9] === 0x00
    ) {
      return { isBinary: true, isImage: true, mimeType: 'image/bmp' };
    }
  }

  if (isKnownBinary) {
    return { isBinary: true, isImage: false, mimeType: declared || 'application/octet-stream' };
  }

  const sampleLength = Math.min(buffer.length, 1024);
  let hasNullByte = false;
  for (let i = 0; i < sampleLength; i++) {
    if (buffer[i] === 0) {
      hasNullByte = true;
      break;
    }
  }

  if (hasNullByte) {
    return { isBinary: true, isImage: false, mimeType: declared || 'application/octet-stream' };
  }

  return { isBinary: false, isImage: false, mimeType: declared };
}

export function categorizeNetworkError(code?: string | null): NetworkErrorCategory {
  if (!code) return 'other';
  const c = code.toUpperCase();
  if (c.includes('CERT') || c.includes('AUTHORITY') || c.includes('SSL')) return 'ssl';
  if (c.includes('CONNECTION_REFUSED')) return 'connection_refused';
  if (c.includes('NAME_NOT_RESOLVED') || c.includes('DNS')) return 'dns';
  if (c.includes('TIMED_OUT') || c.includes('TIMEOUT')) return 'timeout';
  return 'other';
}

export const localRecentErrors = new Map<string, { error: string; timestamp: number }>();

export function recordLocalRecentError(url: string, error: string): void {
  const now = Date.now();
  // Purge entries older than 30s
  for (const [key, val] of localRecentErrors.entries()) {
    if (now - val.timestamp > 30000) {
      localRecentErrors.delete(key);
    }
  }
  // Enforce max capacity of 100 entries (evict oldest)
  while (localRecentErrors.size >= 100) {
    const oldestKey = localRecentErrors.keys().next().value;
    if (oldestKey !== undefined) {
      localRecentErrors.delete(oldestKey);
    } else {
      break;
    }
  }
  localRecentErrors.set(url, { error, timestamp: now });
}

const chromeObj = typeof globalThis !== 'undefined' ? (globalThis as any).chrome : undefined;

if (chromeObj?.webRequest?.onErrorOccurred) {
  try {
    chromeObj.webRequest.onErrorOccurred.addListener(
      (details: any) => {
        recordLocalRecentError(details.url, details.error);
      },
      { urls: ['<all_urls>'] }
    );
  } catch {
    // webRequest listener may fail if unsupported in this window context
  }
}

export async function getChromiumNetworkError(url: string): Promise<string | null> {
  const findInMap = (targetUrl: string): string | null => {
    const exact = localRecentErrors.get(targetUrl);
    if (exact && Date.now() - exact.timestamp < 10000) return exact.error;

    const alt = targetUrl.endsWith('/') ? targetUrl.slice(0, -1) : targetUrl + '/';
    const altMatch = localRecentErrors.get(alt);
    if (altMatch && Date.now() - altMatch.timestamp < 10000) return altMatch.error;

    for (const [key, val] of localRecentErrors.entries()) {
      if (Date.now() - val.timestamp < 4000 && (key === targetUrl || key.startsWith(targetUrl) || targetUrl.startsWith(key))) {
        return val.error;
      }
    }
    return null;
  };

  const local = findInMap(url);
  if (local) return local;

  if (chromeObj?.runtime?.sendMessage) {
    try {
      const res = await new Promise<{ error: string | null }>((resolve) => {
        chromeObj.runtime.sendMessage({ type: 'GET_RECENT_NETWORK_ERROR', url }, (response: any) => {
          if (chromeObj.runtime?.lastError || !response) {
            resolve({ error: null });
          } else {
            resolve(response);
          }
        });
      });
      if (res?.error) return res.error;
    } catch {
      // ignore
    }
  }

  return null;
}

let defaultPlatformAdapter: PlatformAdapter | null = null;

export function setDefaultPlatformAdapter(adapter: PlatformAdapter | null): void {
  defaultPlatformAdapter = adapter;
}

export function getDefaultPlatformAdapter(): PlatformAdapter | null {
  return defaultPlatformAdapter;
}

export async function executeApiRequest(
  request: ApiRequest,
  variables: Record<string, string> = {},
  signal?: AbortSignal,
  adapter?: PlatformAdapter,
  options?: TestRequestOptions
): Promise<ApiResponse> {
  const resolvedAdapter = adapter || defaultPlatformAdapter || undefined;
  const startTime = performance.now();
  let finalUrl = request?.url || '';
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const { finalUrl: preparedUrl, finalHeaders, finalBody } = prepareRequest(request, variables);
    finalUrl = preparedUrl;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(finalUrl);
    } catch {
      return {
        status: 0,
        statusText: 'Invalid URL',
        timeMs: Math.round(performance.now() - startTime),
        sizeBytes: 0,
        headers: {},
        data: `The URL "${finalUrl}" is invalid.`,
        isError: true,
        failureKind: 'transport',
        requestUrl: finalUrl,
        timestamp: Date.now(),
      };
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return {
        status: 0,
        statusText: 'Host Permission Required',
        timeMs: Math.round(performance.now() - startTime),
        sizeBytes: 0,
        headers: {},
        data: `Protocol "${parsedUrl.protocol}" is not supported. Only http: and https: are allowed.`,
        isError: true,
        failureKind: 'host_permission',
        requestUrl: finalUrl,
        timestamp: Date.now(),
      };
    }

    const hasPerm = resolvedAdapter
      ? await resolvedAdapter.hasHostPermission(finalUrl)
      : (chromeObj?.permissions?.contains)
        ? await chromeObj.permissions.contains({ origins: [`${parsedUrl.origin}/*`] }).catch(() => null)
        : null;

    if (hasPerm === false) {
      return {
        status: 0,
        statusText: 'Host Permission Required',
        timeMs: Math.round(performance.now() - startTime),
        sizeBytes: 0,
        headers: {},
        data: `Access to ${parsedUrl.origin} has not been granted.`,
        isError: true,
        failureKind: 'host_permission',
        requestUrl: finalUrl,
        timestamp: Date.now(),
      };
    }

    const transportInit = {
      method: request.method,
      headers: finalHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? finalBody : undefined,
      signal: controller.signal,
    };

    const response = resolvedAdapter
      ? await resolvedAdapter.transport.fetch(finalUrl, transportInit, options)
      : await fetch(finalUrl, {
          ...transportInit,
          redirect: options?.followRedirects === false ? 'manual' : 'follow',
          cache: 'no-store',
        });

    const timeMs = Math.round(performance.now() - startTime);

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((val, key) => {
      responseHeaders[key] = val;
    });

    const rawContentType = response.headers.get('content-type') || '';
    const uint8 = await readResponseBody(response, controller, { method: request.method });
    const sizeBytes = uint8.byteLength;

    const { isBinary, isImage, mimeType } = detectMediaType(uint8, rawContentType);
    const rawBodyId = typeof createTrackedRawBody === 'function' ? createTrackedRawBody(uint8) : undefined;

    let textData = '';
    let blobUrl: string | undefined = undefined;
    let hasDecodingError = false;

    if (isImage) {
      const blob = new Blob([uint8 as unknown as BlobPart], { type: mimeType });
      blobUrl = createTrackedBlobUrl(blob);
    }

    if (isBinary) {
      if (mimeType === 'image/svg+xml') {
        const decoder = new TextDecoder('utf-8', { fatal: false });
        textData = decoder.decode(uint8);
      } else {
        textData = isImage ? `[Binary Image: ${mimeType}]` : `[Binary File: ${mimeType}]`;
      }
    } else {
      const { charset, conflict } = resolveContentTypeCharset(rawContentType);
      if (conflict) {
        hasDecodingError = true;
      } else {
        try {
          const strictDecoder = new TextDecoder(charset, { fatal: true });
          textData = strictDecoder.decode(uint8);
        } catch {
          hasDecodingError = true;
        }
      }
      if (hasDecodingError) {
        const fallbackDecoder = new TextDecoder('utf-8', { fatal: false });
        textData = fallbackDecoder.decode(uint8);
      }
    }

    return {
      status: response.status,
      statusText: response.statusText || STANDARD_HTTP_REASON_PHRASES[response.status] || (response.ok ? 'OK' : 'Error'),
      timeMs,
      sizeBytes,
      headers: responseHeaders,
      data: textData,
      isError: !response.ok,
      timestamp: Date.now(),
      contentType: mimeType || undefined,
      ...(rawContentType ? { rawContentType } : {}),
      ...(hasDecodingError ? { hasDecodingError: true } : {}),
      isBinary,
      isImage,
      blobUrl,
      rawBodyId,
      requestUrl: finalUrl,
    };
  } catch (err: unknown) {
    const timeMs = Math.round(performance.now() - startTime);
    const errorMsg = err instanceof Error ? err.message : String(err);

    if (err instanceof ResponseTooLargeError) {
      return {
        status: 0,
        statusText: 'Response Too Large',
        timeMs,
        sizeBytes: 0,
        headers: {},
        data: errorMsg,
        isError: true,
        errorDetail: errorMsg,
        failureKind: 'response_too_large',
        requestUrl: finalUrl,
        timestamp: Date.now(),
      };
    }

    if (controller.signal.aborted) {
      const failureKind = timedOut ? 'timeout' : 'cancelled';
      return {
        status: 0,
        statusText: timedOut ? 'Request Timed Out' : 'Request Cancelled',
        timeMs,
        sizeBytes: 0,
        headers: {},
        data: timedOut
          ? `Request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`
          : 'Request was cancelled before a complete response was received.',
        isError: true,
        errorDetail: errorMsg,
        failureKind,
        requestUrl: finalUrl,
        timestamp: Date.now(),
      };
    }

    if (resolvedAdapter) {
      const classified = await resolvedAdapter.transport.classifyError(err, finalUrl);
      return {
        status: 0,
        statusText: `Network Error (${classified.category})`,
        timeMs,
        sizeBytes: 0,
        headers: {},
        data: `Failed to connect to ${finalUrl}\nError: ${classified.detail}`,
        isError: true,
        errorDetail: classified.detail,
        requestUrl: finalUrl,
        netErrorCode: classified.code,
        netErrorCategory: classified.category,
        failureKind: 'transport',
        timestamp: Date.now(),
      };
    }

    let netErrorCode = await getChromiumNetworkError(finalUrl);
    if (!netErrorCode) {
      await new Promise((r) => setTimeout(r, 60));
      netErrorCode = await getChromiumNetworkError(finalUrl);
    }

    const netErrorCategory = categorizeNetworkError(netErrorCode);
    const statusText = netErrorCode
      ? `Network Error (${netErrorCode.replace(/^net::/, '')})`
      : 'Network / Connection Error';

    return {
      status: 0,
      statusText,
      timeMs,
      sizeBytes: 0,
      headers: {},
      data: `Failed to connect to ${finalUrl}\nError: ${netErrorCode || errorMsg}`,
      isError: true,
      errorDetail: netErrorCode ? `${netErrorCode} (${errorMsg})` : errorMsg,
      requestUrl: finalUrl,
      netErrorCode: netErrorCode || undefined,
      netErrorCategory,
      failureKind: 'transport',
      timestamp: Date.now(),
    };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}
