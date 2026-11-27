import {
  ApiRequest,
  Collection,
  CollectionItem,
  HttpMethod,
  KeyValuePair,
  Environment,
  EnvironmentVariable,
  AuthConfig,
  BinaryFileData,
  BodyType,
  RawType,
  FormDataItem,
  SavedExample,
  SavedExampleHeader,
} from '../types/api';
import {
  evaluateExamplePayloadEligibility,
  getExampleUtf8ByteLength,
  hasUnloadedCollectionExamples,
  MAX_SAVED_EXAMPLES_PER_ITEM,
  MAX_SAVED_EXAMPLES_TOTAL_BYTES_PER_ITEM,
  MAX_SAVED_EXAMPLE_BYTES,
  resolveHttpReasonPhrase,
  sanitizeJsonValue,
  stripInternalExampleFieldsForPostman,
  validateSavedExampleName,
} from './examples';
import { parseQueryParamsFromUrl, parsePathVariablesFromUrl } from './urlParams';

export type PostmanDescription = string | { content?: string; type?: string };

export interface PostmanHeader {
  key?: string;
  value?: string;
  disabled?: boolean;
  description?: PostmanDescription;
}

export interface PostmanQueryParam {
  key?: string;
  value?: string;
  disabled?: boolean;
  description?: PostmanDescription;
}

export interface PostmanVariable {
  key?: string;
  value?: string;
  disabled?: boolean;
  description?: PostmanDescription;
}

export interface PostmanUrlObject {
  raw?: string;
  protocol?: string;
  host?: string[] | string;
  port?: string;
  path?: string[] | string;
  query?: PostmanQueryParam[];
  variable?: PostmanVariable[];
}

interface PostmanRequestBody {
  mode?: 'raw' | 'urlencoded' | 'formdata' | 'file' | 'graphql';
  raw?: string;
  graphql?: {
    query?: string;
    variables?: string;
  };
  file?: {
    src?: string;
    content?: string;
  };
  urlencoded?: Array<{
    key?: string;
    value?: string;
    type?: string;
    disabled?: boolean;
    description?: PostmanDescription;
  }>;
  formdata?: Array<{
    key?: string;
    value?: string;
    type?: 'text' | 'file';
    src?: string | string[];
    disabled?: boolean;
    description?: PostmanDescription;
  }>;
  options?: {
    raw?: {
      language?: string;
    };
  };
}

export interface PostmanAuthAttribute {
  key?: string;
  value?: unknown;
  type?: string;
}

export interface PostmanAuth {
  type?: string;
  bearer?: PostmanAuthAttribute[] | Record<string, unknown> | string;
  oauth2?: PostmanAuthAttribute[] | Record<string, unknown>;
  basic?: PostmanAuthAttribute[] | Record<string, unknown>;
  apikey?: PostmanAuthAttribute[] | Record<string, unknown>;
  token?: string;
  bearerToken?: string;
  username?: string;
  password?: string;
  key?: string;
  value?: string;
  [key: string]: unknown;
}

interface PostmanRequestObject {
  method?: string;
  header?: PostmanHeader[];
  url?: string | PostmanUrlObject;
  body?: PostmanRequestBody;
  description?: string;
  auth?: PostmanAuth;
}

interface PostmanEvent {
  listen: 'prerequest' | 'test' | string;
  script?: {
    type?: string;
    exec?: string[] | string;
  };
}

interface PostmanRawItem {
  id?: string;
  name?: string;
  item?: PostmanRawItem[]; // Folder
  request?: PostmanRequestObject | string;
  event?: PostmanEvent[];
  auth?: PostmanAuth;
  response?: unknown;
}

export interface PostmanExampleImportSummary {
  imported: number;
  skipped: number;
  skippedReasons: string[];
}

interface PostmanCollectionSchema {
  info?: {
    _postman_id?: string;
    name?: string;
    description?: PostmanDescription;
    schema?: string;
  };
  item?: PostmanRawItem[];
  auth?: PostmanAuth;
}

function normalizePostmanDescription(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const content = (raw as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return undefined;
}

export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function generateId(): string {
  return generateUUID();
}

function parseHeaders(headers?: PostmanHeader[]): KeyValuePair[] {
  if (!Array.isArray(headers)) return [];
  return headers.map((h) => {
    const desc = normalizePostmanDescription(h?.description);
    return {
      id: generateId(),
      key: String(h?.key ?? ''),
      value: String(h?.value ?? ''),
      enabled: !h?.disabled,
      ...(desc !== undefined ? { description: desc } : {}),
    };
  });
}

function parseQueryParams(url?: string | PostmanUrlObject, rawUrl?: string): KeyValuePair[] {
  if (url && typeof url === 'object' && Array.isArray(url.query)) {
    const fromQuery: KeyValuePair[] = url.query
      .filter((q) => String(q?.key ?? '').trim() !== '' || String(q?.value ?? '').trim() !== '')
      .map((q) => {
        const desc = normalizePostmanDescription(q?.description);
        return {
          id: generateId(),
          key: String(q?.key ?? ''),
          value: String(q?.value ?? ''),
          enabled: !q?.disabled,
          ...(desc !== undefined ? { description: desc } : {}),
        };
      });
    if (fromQuery.length > 0) {
      if (!fromQuery.some((p) => p.key === '' && p.value === '')) {
        fromQuery.push({ id: generateId(), key: '', value: '', enabled: true });
      }
      return fromQuery;
    }
  }

  const targetUrl = typeof url === 'string' ? url : (url?.raw || rawUrl || '');
  if (targetUrl) {
    return parseQueryParamsFromUrl(targetUrl);
  }

  return [{ id: generateId(), key: '', value: '', enabled: true }];
}

function parsePathVariables(url?: string | PostmanUrlObject, rawUrl?: string): KeyValuePair[] {
  const targetUrl = typeof url === 'string' ? url : (url?.raw || rawUrl || '');
  const extractedFromUrl = parsePathVariablesFromUrl(targetUrl);

  if (url && typeof url === 'object' && Array.isArray(url.variable)) {
    const fromVariables: KeyValuePair[] = url.variable
      .filter((v) => String(v?.key ?? '').trim() !== '')
      .map((v) => ({
        id: generateId(),
        key: String(v?.key ?? '').trim(),
        value: String(v?.value ?? ''),
        enabled: !v?.disabled,
        description: normalizePostmanDescription(v?.description),
      }));

    if (fromVariables.length > 0) {
      return parsePathVariablesFromUrl(targetUrl, fromVariables);
    }
  }

  return extractedFromUrl;
}

function extractRawUrl(url?: string | PostmanUrlObject): string {
  if (!url) return '';
  if (typeof url === 'string') return url;
  if (url.raw) return url.raw;

  let built = '';
  if (url.protocol) built += `${url.protocol}://`;
  if (url.host) built += Array.isArray(url.host) ? url.host.join('.') : url.host;
  if (url.port) built += `:${url.port}`;
  if (url.path) {
    const pathStr = Array.isArray(url.path) ? url.path.join('/') : url.path;
    if (pathStr) {
      built += (built.endsWith('/') || pathStr.startsWith('/') ? '' : '/') + pathStr;
    }
  }
  if (Array.isArray(url.query) && url.query.length > 0) {
    const qParams = url.query
      .filter((q) => !q.disabled && (String(q.key ?? '').trim() !== '' || String(q.value ?? '').trim() !== ''))
      .map((q) => (q.value ? `${q.key}=${q.value}` : (q.key || '')))
      .filter(Boolean)
      .join('&');
    if (qParams) {
      built += `?${qParams}`;
    }
  }
  return built;
}

/**
 * Parses a Postman auth definition into an AuthConfig.
 * Supports Postman v2.0 & v2.1 formats for bearer, oauth2, basic, and apikey.
 */
export function parsePostmanAuth(rawAuth: PostmanAuth | Record<string, unknown> | null | undefined): AuthConfig | null {
  if (!rawAuth || typeof rawAuth !== 'object') return null;

  const authType = String(rawAuth.type || '').toLowerCase();

  // 1. Bearer Token
  if (authType === 'bearer') {
    let token = '';
    if (Array.isArray(rawAuth.bearer)) {
      const tokenItem = (rawAuth.bearer as PostmanAuthAttribute[]).find((item) => {
        if (!item || !item.key) return false;
        const k = String(item.key).toLowerCase();
        return (
          k === 'token' ||
          k === 'bearertoken' ||
          k === 'accesstoken' ||
          k === 'jwt' ||
          k === 'value'
        );
      });
      token = tokenItem ? String(tokenItem.value ?? '') : '';
      if (!token && rawAuth.bearer[0]?.value) {
        token = String(rawAuth.bearer[0].value ?? '');
      }
    } else if (rawAuth.bearer && typeof rawAuth.bearer === 'object') {
      const bObj = rawAuth.bearer as Record<string, unknown>;
      token = String(
        bObj.token ||
        bObj.bearerToken ||
        bObj.accessToken ||
        bObj.value ||
        ''
      );
    } else if (typeof rawAuth.bearer === 'string') {
      token = rawAuth.bearer;
    }

    if (!token && typeof rawAuth.token === 'string') token = rawAuth.token;
    if (!token && typeof rawAuth.bearerToken === 'string') token = rawAuth.bearerToken;

    return {
      type: 'bearer',
      bearerToken: token,
    };
  }

  // 2. OAuth 2.0 (seamlessly maps to Bearer token)
  if (authType === 'oauth2') {
    let token = '';
    if (Array.isArray(rawAuth.oauth2)) {
      const tokenItem = (rawAuth.oauth2 as PostmanAuthAttribute[]).find((item) => {
        if (!item || !item.key) return false;
        const k = String(item.key).toLowerCase();
        return k === 'accesstoken' || k === 'token' || k === 'value';
      });
      token = tokenItem ? String(tokenItem.value ?? '') : '';
      if (!token && rawAuth.oauth2[0]?.value) {
        token = String(rawAuth.oauth2[0].value ?? '');
      }
    } else if (rawAuth.oauth2 && typeof rawAuth.oauth2 === 'object') {
      const oObj = rawAuth.oauth2 as Record<string, unknown>;
      token = String(
        oObj.accessToken ||
        oObj.token ||
        oObj.value ||
        ''
      );
    }

    if (!token && typeof rawAuth.accessToken === 'string') token = rawAuth.accessToken;
    if (!token && typeof rawAuth.token === 'string') token = rawAuth.token;

    return {
      type: 'bearer',
      bearerToken: token,
    };
  }

  // 3. Basic Auth
  if (authType === 'basic') {
    let username = '';
    let password = '';
    if (Array.isArray(rawAuth.basic)) {
      const basicList = rawAuth.basic as PostmanAuthAttribute[];
      const uItem = basicList.find((item) => {
        if (!item || !item.key) return false;
        const k = String(item.key).toLowerCase();
        return k === 'username' || k === 'user';
      });
      const pItem = basicList.find((item) => {
        if (!item || !item.key) return false;
        const k = String(item.key).toLowerCase();
        return k === 'password' || k === 'pass';
      });
      username = uItem ? String(uItem.value ?? '') : '';
      password = pItem ? String(pItem.value ?? '') : '';
    } else if (rawAuth.basic && typeof rawAuth.basic === 'object') {
      const bObj = rawAuth.basic as Record<string, unknown>;
      username = String(bObj.username ?? bObj.user ?? '');
      password = String(bObj.password ?? bObj.pass ?? '');
    }

    if (!username && typeof rawAuth.username === 'string') username = rawAuth.username;
    if (!password && typeof rawAuth.password === 'string') password = rawAuth.password;

    return {
      type: 'basic',
      basicUsername: username,
      basicPassword: password,
    };
  }

  // 4. API Key
  if (authType === 'apikey') {
    let key = '';
    let val = '';
    let inWhere: 'header' | 'query' = 'header';

    if (Array.isArray(rawAuth.apikey)) {
      const apiKeyList = rawAuth.apikey as PostmanAuthAttribute[];
      const kItem = apiKeyList.find((item) => item && String(item.key).toLowerCase() === 'key');
      const vItem = apiKeyList.find((item) => item && String(item.key).toLowerCase() === 'value');
      const inItem = apiKeyList.find((item) => item && String(item.key).toLowerCase() === 'in');

      key = kItem ? String(kItem.value ?? '') : '';
      val = vItem ? String(vItem.value ?? '') : '';
      if (inItem && String(inItem.value).toLowerCase() === 'query') {
        inWhere = 'query';
      }
    } else if (rawAuth.apikey && typeof rawAuth.apikey === 'object') {
      const aObj = rawAuth.apikey as Record<string, unknown>;
      key = String(aObj.key ?? '');
      val = String(aObj.value ?? '');
      if (String(aObj.in).toLowerCase() === 'query') {
        inWhere = 'query';
      }
    }

    if (!key && typeof rawAuth.key === 'string') key = rawAuth.key;
    if (!val && typeof rawAuth.value === 'string') val = rawAuth.value;

    return {
      type: 'apikey',
      apiKeyKey: key,
      apiKeyValue: val,
      apiKeyIn: inWhere,
    };
  }

  // 5. Explicitly No Auth
  if (authType === 'noauth' || authType === 'none') {
    return { type: 'none' };
  }

  return null;
}

/**
 * Extracts authorization from Authorization header if present.
 */
export function extractAuthFromHeaders(headers: KeyValuePair[]): AuthConfig | null {
  const authHeader = headers.find((h) => String(h?.key ?? '').trim().toLowerCase() === 'authorization');
  if (!authHeader || !authHeader.value) return null;

  const val = String(authHeader.value).trim();
  if (/^bearer\s+/i.test(val)) {
    return {
      type: 'bearer',
      bearerToken: val.replace(/^bearer\s+/i, '').trim(),
    };
  }

  if (/^basic\s+/i.test(val)) {
    const b64 = val.replace(/^basic\s+/i, '').trim();
    try {
      const decoded = atob(b64);
      const colonIdx = decoded.indexOf(':');
      if (colonIdx >= 0) {
        return {
          type: 'basic',
          basicUsername: decoded.substring(0, colonIdx),
          basicPassword: decoded.substring(colonIdx + 1),
        };
      }
    } catch {
      // Ignore if non-standard or templated
    }
  }

  return null;
}

const KNOWN_POSTMAN_RESPONSE_KEYS = new Set([
  'id',
  'revision',
  'name',
  'originalRequest',
  'status',
  'code',
  'header',
  'cookie',
  'body',
  '_postman_previewlanguage',
]);

function recordSkippedExample(
  summary: PostmanExampleImportSummary | undefined,
  reason: string,
  count = 1,
): void {
  if (!summary || count <= 0) return;
  summary.skipped += count;
  if (reason && !summary.skippedReasons.includes(reason) && summary.skippedReasons.length < 10) {
    summary.skippedReasons.push(reason);
  }
}

function parsePostmanResponseHeaders(rawHeader: unknown): SavedExampleHeader[] {
  if (Array.isArray(rawHeader)) {
    const out: SavedExampleHeader[] = [];
    for (const h of rawHeader) {
      if (!h || typeof h !== 'object' || Array.isArray(h)) continue;
      const obj = h as Record<string, unknown>;
      out.push({
        key: String(obj.key ?? ''),
        value: String(obj.value ?? ''),
        ...(obj.disabled === true ? { disabled: true } : {}),
        ...(typeof obj.description === 'string' && obj.description ? { description: obj.description } : {}),
      });
    }
    return out;
  }
  if (typeof rawHeader === 'string' && rawHeader.trim()) {
    const out: SavedExampleHeader[] = [];
    for (const line of rawHeader.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        out.push({
          key: line.slice(0, idx).trim(),
          value: line.slice(idx + 1).trim(),
        });
      }
    }
    return out;
  }
  return [];
}

function parsePostmanItemExamples(
  rawResponses: unknown,
  summary?: PostmanExampleImportSummary,
): SavedExample[] {
  if (rawResponses === undefined || rawResponses === null) {
    return [];
  }
  if (!Array.isArray(rawResponses)) {
    recordSkippedExample(summary, 'Invalid example list format (expected an array).');
    return [];
  }

  const examples: SavedExample[] = [];
  let totalBytes = 0;

  for (const rawEntry of rawResponses) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      recordSkippedExample(summary, 'Malformed saved example entry.');
      continue;
    }
    const rawObj = rawEntry as Record<string, unknown>;
    const code = typeof rawObj.code === 'number' ? rawObj.code : Number(rawObj.code);
    const headers = parsePostmanResponseHeaders(rawObj.header);
    const body = rawObj.body;

    const eligibility = evaluateExamplePayloadEligibility({
      code,
      body,
      headers,
    });
    if (!eligibility.eligible) {
      recordSkippedExample(summary, eligibility.reason);
      continue;
    }

    if (examples.length >= MAX_SAVED_EXAMPLES_PER_ITEM) {
      recordSkippedExample(summary, `Exceeded maximum of ${MAX_SAVED_EXAMPLES_PER_ITEM} saved examples per request.`);
      continue;
    }

    const status =
      typeof rawObj.status === 'string' && rawObj.status.trim()
        ? rawObj.status
        : resolveHttpReasonPhrase(code);

    const rawName = typeof rawObj.name === 'string' ? rawObj.name : '';
    const candidateName = rawName.trim() ? rawName : `${code} ${status}`.trim();
    const nameCheck = validateSavedExampleName(candidateName);
    if (!nameCheck.valid) {
      recordSkippedExample(summary, nameCheck.error);
      continue;
    }

    const cookie = Array.isArray(rawObj.cookie)
      ? rawObj.cookie
          .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === 'object' && !Array.isArray(c)))
          .map((c) => sanitizeJsonValue({ ...c }))
      : [];

    const extraFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawObj)) {
      if (KNOWN_POSTMAN_RESPONSE_KEYS.has(k) || k === '__proto__' || k === 'constructor' || k === 'prototype') {
        continue;
      }
      if (v !== undefined) {
        extraFields[k] = sanitizeJsonValue(v);
      }
    }

    let originalRequest: Record<string, unknown> | undefined;
    if (rawObj.originalRequest && typeof rawObj.originalRequest === 'object' && !Array.isArray(rawObj.originalRequest)) {
      originalRequest = sanitizeJsonValue(rawObj.originalRequest as Record<string, unknown>);
    }

    const savedExample: SavedExample = {
      ...extraFields,
      id: generateId(),
      revision: 1,
      name: nameCheck.name,
      ...(originalRequest ? { originalRequest } : {}),
      status,
      code,
      header: headers,
      cookie,
      body: body as string,
      ...('_postman_previewlanguage' in rawObj
        ? {
            _postman_previewlanguage:
              rawObj._postman_previewlanguage === null
                ? null
                : typeof rawObj._postman_previewlanguage === 'string'
                ? rawObj._postman_previewlanguage
                : undefined,
          }
        : {}),
    };

    const serializedBytes = getExampleUtf8ByteLength(JSON.stringify(savedExample));
    if (serializedBytes > MAX_SAVED_EXAMPLE_BYTES) {
      recordSkippedExample(summary, `Example exceeded the ${MAX_SAVED_EXAMPLE_BYTES / 1024} KiB size limit.`);
      continue;
    }
    if (totalBytes + serializedBytes > MAX_SAVED_EXAMPLES_TOTAL_BYTES_PER_ITEM) {
      recordSkippedExample(summary, 'Exceeded total saved examples size limit for a single request.');
      continue;
    }

    totalBytes += serializedBytes;
    examples.push(savedExample);
    if (summary) summary.imported += 1;
  }

  return examples;
}

export function convertPostmanItem(
  item: PostmanRawItem,
  inheritedAuth?: AuthConfig,
  depth: number = 0,
  exampleImportSummary?: PostmanExampleImportSummary,
  seenIds: Set<string> = new Set(),
): CollectionItem {
  const allocateItemId = (candidate?: string): string => {
    const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
    if (trimmed && !seenIds.has(trimmed)) {
      seenIds.add(trimmed);
      return trimmed;
    }
    let nextId = generateId();
    while (seenIds.has(nextId)) {
      nextId = generateId();
    }
    seenIds.add(nextId);
    return nextId;
  };
  const resolvedId = allocateItemId(item.id);

  if (depth >= 32) {
    return {
      id: resolvedId,
      name: item.name || 'Unnamed Folder (depth exceeded)',
      type: 'folder',
      items: [],
    };
  }

  const isFolder = Array.isArray(item.item);

  // Folder auth overrides or falls back to inherited collection/parent auth
  const folderAuth = parsePostmanAuth(item.auth) || inheritedAuth || { type: 'none' };

  if (isFolder) {
    if (Array.isArray(item.response) && item.response.length > 0) {
      recordSkippedExample(exampleImportSummary, 'Folders cannot contain saved examples.', item.response.length);
    } else if (item.response !== undefined && item.response !== null && !Array.isArray(item.response)) {
      recordSkippedExample(exampleImportSummary, 'Folders cannot contain saved examples.');
    }
    return {
      id: resolvedId,
      name: item.name || 'Unnamed Folder',
      type: 'folder',
      items: (item.item || []).map((child) => convertPostmanItem(child, folderAuth, depth + 1, exampleImportSummary, seenIds)),
    };
  }

  // It's a request
  const rawReq: PostmanRequestObject =
    typeof item.request === 'string'
      ? { method: 'GET', url: item.request }
      : (typeof item.request === 'object' && item.request !== null ? item.request : {});
  const method = (rawReq.method || 'GET').toUpperCase() as HttpMethod;
  const validMethods: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const safeMethod: HttpMethod = validMethods.includes(method) ? method : 'GET';

  const rawUrl = extractRawUrl(rawReq.url);
  const params = parseQueryParams(rawReq.url);
  const pathVariables = parsePathVariables(rawReq.url, rawUrl);
  const headers = parseHeaders(rawReq.header);

  let bodyType: BodyType = 'none';
  let rawType: RawType = 'text';
  let bodyContent = '';
  let graphqlQuery = '';
  let graphqlVariables = '';
  let bodyBinaryFile: BinaryFileData | undefined = undefined;
  let bodyFormData: FormDataItem[] = [];
  let bodyUrlEncoded: KeyValuePair[] = [];

  if (rawReq.body) {
    if (rawReq.body.mode === 'graphql') {
      bodyType = 'graphql';
      graphqlQuery = rawReq.body.graphql?.query || '';
      graphqlVariables = rawReq.body.graphql?.variables || '';
      bodyContent = graphqlQuery;
    } else if (rawReq.body.mode === 'raw') {
      const rawLang = rawReq.body.options?.raw?.language?.toLowerCase();
      const rawStr = rawReq.body.raw || '';
      const trimmed = rawStr.trim();

      if (rawLang === 'xml' || (trimmed.startsWith('<') && trimmed.endsWith('>'))) {
        bodyType = 'xml';
        rawType = 'xml';
      } else if (rawLang === 'json' || trimmed.startsWith('{') || trimmed.startsWith('[')) {
        bodyType = 'json';
        rawType = 'json';
      } else if (rawLang === 'html') {
        bodyType = 'raw';
        rawType = 'html';
      } else {
        bodyType = 'raw';
        rawType = 'text';
      }
      bodyContent = rawStr;
    } else if (rawReq.body.mode === 'urlencoded') {
      bodyType = 'x-www-form-urlencoded';
      const urlencodedList = Array.isArray(rawReq.body.urlencoded) ? rawReq.body.urlencoded : [];
      if (urlencodedList.length > 0) {
        bodyUrlEncoded = urlencodedList.map((item) => {
          const desc = normalizePostmanDescription(item?.description);
          return {
            id: generateId(),
            key: String(item?.key ?? ''),
            value: String(item?.value ?? ''),
            enabled: item?.disabled !== true,
            ...(desc !== undefined ? { description: desc } : {}),
          };
        });
        const urlParams = new URLSearchParams();
        for (const item of bodyUrlEncoded) {
          if (item.enabled && String(item.key ?? '').trim()) {
            urlParams.append(String(item.key).trim(), String(item.value ?? ''));
          }
        }
        bodyContent = urlParams.toString();
      } else if (rawReq.body.raw) {
        bodyContent = rawReq.body.raw;
        try {
          const params = new URLSearchParams(rawReq.body.raw);
          params.forEach((value, key) => {
            bodyUrlEncoded.push({
              id: generateId(),
              key,
              value,
              enabled: true,
            });
          });
        } catch {
          // ignore
        }
      }
      if (bodyUrlEncoded.length === 0) {
        bodyUrlEncoded = [{ id: generateId(), key: '', value: '', enabled: true }];
      }
    } else if (rawReq.body.mode === 'formdata') {
      bodyType = 'form-data';
      const formdataList = Array.isArray(rawReq.body.formdata) ? rawReq.body.formdata : [];
      if (formdataList.length > 0) {
        bodyFormData = formdataList.map((item) => {
          const isFile = item?.type === 'file';
          const rawSrc = Array.isArray(item?.src) ? (item.src[0] ?? '') : (item?.src ?? '');
          const nonEmptyValue = item?.value !== undefined && String(item.value).trim() !== '' ? String(item.value) : '';
          const resolvedValue = isFile ? String(rawSrc || nonEmptyValue) : String(item?.value ?? item?.src ?? '');
          return {
            id: generateId(),
            key: String(item?.key ?? ''),
            type: isFile ? 'file' : 'text',
            value: resolvedValue,
            ...(isFile && resolvedValue ? { fileName: resolvedValue } : {}),
            enabled: item?.disabled !== true,
          };
        });
      }
      if (bodyFormData.length === 0) {
        bodyFormData = [{ id: generateId(), key: '', type: 'text', value: '', enabled: true }];
      }
    } else if (rawReq.body.mode === 'file') {
      bodyType = 'binary';
      const fileSrc =
        typeof rawReq.body.file === 'object' && rawReq.body.file?.src
          ? rawReq.body.file.src
          : typeof rawReq.body.file === 'string'
          ? rawReq.body.file
          : '';
      const fileName = fileSrc
        ? fileSrc.split('/').pop()?.split('\\').pop() || fileSrc
        : 'upload.bin';
      bodyBinaryFile = {
        name: fileName,
        size: 0,
        type: 'application/octet-stream',
      };
    }
  }

  // Check headers for Content-Type fallback if raw mode without language options
  if (bodyType === 'raw' && rawType === 'text') {
    const ctHeader = headers.find((h) => h.key.trim().toLowerCase() === 'content-type');
    if (ctHeader && ctHeader.value) {
      const ctVal = ctHeader.value.toLowerCase();
      if (ctVal.includes('application/xml') || ctVal.includes('text/xml')) {
        bodyType = 'xml';
        rawType = 'xml';
      } else if (ctVal.includes('application/json')) {
        bodyType = 'json';
        rawType = 'json';
      } else if (ctVal.includes('text/html')) {
        bodyType = 'raw';
        rawType = 'html';
      } else if (ctVal.includes('application/x-www-form-urlencoded')) {
        bodyType = 'x-www-form-urlencoded';
        if (bodyContent && bodyUrlEncoded.length === 0) {
          try {
            const params = new URLSearchParams(bodyContent);
            params.forEach((value, key) => {
              bodyUrlEncoded.push({
                id: generateId(),
                key,
                value,
                enabled: true,
              });
            });
          } catch {
            // ignore
          }
        }
        if (bodyUrlEncoded.length === 0) {
          bodyUrlEncoded = [{ id: generateId(), key: '', value: '', enabled: true }];
        }
      }
    }
  }

  let preRequestScript = '';
  let postResponseScript = '';
  const events = Array.isArray(item.event) ? item.event : [];
  for (const ev of events) {
    const exec = Array.isArray(ev.script?.exec)
      ? ev.script.exec.join('\n')
      : typeof ev.script?.exec === 'string'
      ? ev.script.exec
      : '';
    if (ev.listen === 'prerequest') {
      preRequestScript = exec;
    } else if (ev.listen === 'test') {
      postResponseScript = exec;
    }
  }

  // Resolve authorization with priority:
  // 1. Explicit request-level auth (rawReq.auth or item.auth)
  // 2. Request Authorization header
  // 3. Inherited folder/collection auth
  // 4. Default { type: 'none' }
  let auth: AuthConfig = { type: 'none' };
  let finalHeaders = headers;

  const explicitAuth = parsePostmanAuth(rawReq.auth) || parsePostmanAuth(item.auth);

  if (explicitAuth && explicitAuth.type !== 'none') {
    auth = explicitAuth;
  } else if (explicitAuth && explicitAuth.type === 'none') {
    // Explicitly set to noauth at request level
    auth = { type: 'none' };
  } else {
    // Check if request headers has an explicit Authorization header
    const fromHeader = extractAuthFromHeaders(headers);
    if (fromHeader) {
      auth = fromHeader;
      // Strip redundant Authorization header to keep request headers clean
      finalHeaders = headers.filter((h) => h.key.trim().toLowerCase() !== 'authorization');
    } else if (inheritedAuth && inheritedAuth.type !== 'none') {
      auth = inheritedAuth;
    }
  }

  const apiRequest: ApiRequest = {
    id: resolvedId,
    name: item.name || 'Untitled Request',
    method: safeMethod,
    url: rawUrl,
    params,
    pathVariables,
    headers: finalHeaders,
    auth,
    bodyType,
    rawType,
    bodyContent,
    graphqlQuery,
    graphqlVariables,
    bodyFormData,
    bodyBinaryFile,
    bodyUrlEncoded: bodyUrlEncoded.length > 0 ? bodyUrlEncoded : [{ id: generateId(), key: '', value: '', enabled: true }],
    preRequestScript,
    postResponseScript,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const examples = parsePostmanItemExamples(item.response, exampleImportSummary);

  return {
    id: resolvedId,
    name: item.name || 'Untitled Request',
    type: 'request',
    request: apiRequest,
    examples,
    examplesLoaded: true,
    exampleCount: examples.length,
  };
}

/**
 * Imports a Postman v2.0 or v2.1 collection JSON string into a Collection object
 * along with a summary of imported and skipped saved examples.
 */
export function importPostmanCollectionWithSummary(jsonString: string): {
  collection: Collection;
  exampleImportSummary: PostmanExampleImportSummary;
} {
  const parsed = JSON.parse(jsonString) as PostmanCollectionSchema;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid JSON format: root is not an object.');
  }

  const name = parsed.info?.name || 'Imported Postman Collection';
  const description = normalizePostmanDescription(parsed.info?.description) || '';
  const rawItems = Array.isArray(parsed.item) ? parsed.item : [];

  // Parse collection-level authorization
  const collectionAuth = parsePostmanAuth(parsed.auth) || { type: 'none' };
  const exampleImportSummary: PostmanExampleImportSummary = {
    imported: 0,
    skipped: 0,
    skippedReasons: [],
  };

  const seenIds = new Set<string>();
  const items: CollectionItem[] = rawItems.map((item) =>
    convertPostmanItem(item, collectionAuth, 0, exampleImportSummary, seenIds),
  );

  return {
    collection: {
      id: generateId(),
      name,
      description,
      items,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    exampleImportSummary,
  };
}

/**
 * Imports a Postman v2.0 or v2.1 collection JSON string into a Collection object.
 */
export function importPostmanCollection(jsonString: string): Collection {
  return importPostmanCollectionWithSummary(jsonString).collection;
}

function itemToPostmanJson(item: CollectionItem): PostmanRawItem {
  if (item.type === 'folder') {
    return {
      name: item.name,
      item: (item.items || []).map(itemToPostmanJson),
    };
  }

  const req = item.request;
  if (!req) {
    return { name: item.name };
  }

  const headers: PostmanHeader[] = (req.headers || [])
    .filter((h) => h && (String(h.key ?? '').trim() !== '' || String(h.value ?? '').trim() !== ''))
    .map((h) => ({
      key: String(h?.key ?? ''),
      value: String(h?.value ?? ''),
      ...(h.enabled === false ? { disabled: true } : {}),
      ...(h.description ? { description: h.description } : {}),
    }));

  let body: PostmanRequestBody | undefined = undefined;
  if (req.bodyType === 'json' || (req.bodyType === 'raw' && req.rawType === 'json')) {
    body = {
      mode: 'raw',
      raw: req.bodyContent,
      options: {
        raw: {
          language: 'json',
        },
      },
    };
  } else if (req.bodyType === 'xml' || (req.bodyType === 'raw' && req.rawType === 'xml')) {
    body = {
      mode: 'raw',
      raw: req.bodyContent,
      options: {
        raw: {
          language: 'xml',
        },
      },
    };
  } else if (req.bodyType === 'raw' && req.rawType === 'html') {
    body = {
      mode: 'raw',
      raw: req.bodyContent,
      options: {
        raw: {
          language: 'html',
        },
      },
    };
  } else if (req.bodyType === 'raw' && req.rawType === 'text') {
    body = {
      mode: 'raw',
      raw: req.bodyContent,
      options: {
        raw: {
          language: 'text',
        },
      },
    };
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
        .filter((item) => item && (String(item.key ?? '').trim() !== '' || String(item.value ?? '').trim() !== ''))
        .map((item) => ({
          key: String(item?.key ?? ''),
          value: String(item?.value ?? ''),
          type: 'text',
          ...(item.enabled === false ? { disabled: true } : {}),
          ...(item.description ? { description: item.description } : {}),
        })),
    };
  } else if (req.bodyType === 'form-data') {
    body = {
      mode: 'formdata',
      formdata: (req.bodyFormData || [])
        .filter((item) =>
          item &&
          (String(item.key ?? '').trim() !== '' ||
            (item.value && String(item.value).trim() !== '') ||
            Boolean(item.file) ||
            (item.fileName && String(item.fileName).trim() !== ''))
        )
        .map((item) => {
          const resolvedFileName = item.file?.name || item.fileName || (item.type === 'file' ? String(item?.value ?? '') : undefined);
          return {
            key: String(item?.key ?? ''),
            value: String(item?.value ?? ''),
            type: item.type,
            src: resolvedFileName,
            ...(item.enabled === false ? { disabled: true } : {}),
          };
        }),
    };
  } else if (req.bodyType === 'raw') {
    body = {
      mode: 'raw',
      raw: req.bodyContent,
    };
  } else if (req.bodyType === 'binary') {
    body = {
      mode: 'file',
      file: {
        src: req.bodyBinaryFile?.name || '',
      },
    };
  }

  const event: PostmanEvent[] = [];
  if (req.preRequestScript && req.preRequestScript.trim()) {
    event.push({
      listen: 'prerequest',
      script: {
        type: 'text/javascript',
        exec: req.preRequestScript.split('\n'),
      },
    });
  }
  if (req.postResponseScript && req.postResponseScript.trim()) {
    event.push({
      listen: 'test',
      script: {
        type: 'text/javascript',
        exec: req.postResponseScript.split('\n'),
      },
    });
  }

  // Export authorization
  let auth: PostmanAuth | undefined = undefined;
  if (req.auth?.type === 'bearer' && req.auth.bearerToken) {
    auth = {
      type: 'bearer',
      bearer: [
        {
          key: 'token',
          value: req.auth.bearerToken,
          type: 'string',
        },
      ],
    };
  } else if (req.auth?.type === 'basic') {
    auth = {
      type: 'basic',
      basic: [
        {
          key: 'username',
          value: req.auth.basicUsername || '',
          type: 'string',
        },
        {
          key: 'password',
          value: req.auth.basicPassword || '',
          type: 'string',
        },
      ],
    };
  } else if (req.auth?.type === 'apikey') {
    auth = {
      type: 'apikey',
      apikey: [
        {
          key: 'key',
          value: req.auth.apiKeyKey || '',
          type: 'string',
        },
        {
          key: 'value',
          value: req.auth.apiKeyValue || '',
          type: 'string',
        },
        {
          key: 'in',
          value: req.auth.apiKeyIn || 'header',
          type: 'string',
        },
      ],
    };
  }

  if (item.examplesLoaded === false && (item.exampleCount ?? 0) > 0) {
    throw new Error(`Cannot export collection: saved examples for "${item.name}" are not fully loaded.`);
  }

  const postmanUrl = buildPostmanUrl(req.url, req.params, req.pathVariables);
  const exportedExamples = (item.examples || []).map(stripInternalExampleFieldsForPostman);

  return {
    name: req.name || item.name,
    request: {
      method: req.method,
      header: headers,
      url: postmanUrl,
      body,
      auth,
    },
    response: exportedExamples,
    event: event.length > 0 ? event : undefined,
  };
}

/**
 * Builds a standard Postman v2.1 URL object from a raw URL string and query parameters.
 * Accurately extracts protocol, host, port, path, and non-empty query parameters.
 */
export function buildPostmanUrl(
  rawUrl: string,
  params: KeyValuePair[] = [],
  pathVariables: KeyValuePair[] = []
): PostmanUrlObject {
  const trimmedUrl = (rawUrl || '').trim();

  // 1. Filter out completely empty placeholder rows from params
  const validParams: PostmanQueryParam[] = (params || [])
    .filter((p) => p && (String(p.key ?? '').trim() !== '' || String(p.value ?? '').trim() !== ''))
    .map((p) => ({
      key: String(p?.key ?? ''),
      value: String(p?.value ?? ''),
      ...(p.enabled === false ? { disabled: true } : {}),
      ...(p.description ? { description: p.description } : {}),
    }));

  if (!trimmedUrl) {
    return {
      raw: '',
      ...(validParams.length > 0 ? { query: validParams } : {}),
    };
  }

  // 2. Separate query and hash from the base url
  let baseWithoutQueryOrHash = trimmedUrl;
  const hashIdx = baseWithoutQueryOrHash.indexOf('#');
  if (hashIdx >= 0) {
    baseWithoutQueryOrHash = baseWithoutQueryOrHash.substring(0, hashIdx);
  }
  const queryIdx = baseWithoutQueryOrHash.indexOf('?');
  if (queryIdx >= 0) {
    baseWithoutQueryOrHash = baseWithoutQueryOrHash.substring(0, queryIdx);
  }

  // Fallback: If no validParams passed but rawUrl has query params, extract them
  if (validParams.length === 0 && queryIdx >= 0) {
    const qStr = trimmedUrl.substring(queryIdx + 1).split('#')[0];
    if (qStr.trim()) {
      const searchParams = new URLSearchParams(qStr);
      searchParams.forEach((val, key) => {
        if (key.trim() !== '' || val.trim() !== '') {
          validParams.push({
            key,
            value: val,
          });
        }
      });
    }
  }

  // 3. Extract protocol (e.g., https://, http://, ws://, etc.)
  let protocol: string | undefined;
  let rest = baseWithoutQueryOrHash;

  const protoMatch = rest.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):\/\//);
  if (protoMatch) {
    protocol = protoMatch[1].toLowerCase();
    rest = rest.substring(protoMatch[0].length);
  }

  // 4. Separate host (+ port) and path
  let hostStr = '';
  let pathStr = '';

  if (rest.startsWith('/')) {
    pathStr = rest.substring(1);
  } else {
    const firstSlash = rest.indexOf('/');
    if (firstSlash >= 0) {
      hostStr = rest.substring(0, firstSlash);
      pathStr = rest.substring(firstSlash + 1);
    } else {
      hostStr = rest;
    }
  }

  // Remove credentials if any (e.g. user:pass@host)
  const atIdx = hostStr.lastIndexOf('@');
  if (atIdx >= 0) {
    hostStr = hostStr.substring(atIdx + 1);
  }

  // 5. Extract port (e.g., :9002 or :{{port}})
  let port: string | undefined;
  const portMatch = hostStr.match(/:(\d+|{{[^}]+}})$/);
  if (portMatch) {
    port = portMatch[1];
    hostStr = hostStr.substring(0, hostStr.length - portMatch[0].length);
  }

  // 6. Split host into segments (Postman standard)
  let host: string[] | undefined;
  if (hostStr) {
    if (/^{{[^}]+}}$/.test(hostStr)) {
      host = [hostStr];
    } else {
      host = hostStr.split('.').filter(Boolean);
      if (host.length === 0) {
        host = [hostStr];
      }
    }
  }

  // 7. Split path into segments
  let path: string[] | undefined;
  if (pathStr) {
    path = pathStr.split('/').filter(Boolean);
  }

  const urlObj: PostmanUrlObject = {
    raw: trimmedUrl,
  };

  if (protocol) {
    urlObj.protocol = protocol;
  }
  if (host && host.length > 0) {
    urlObj.host = host;
  }
  if (port) {
    urlObj.port = port;
  }
  if (path && path.length > 0) {
    urlObj.path = path;
  }
  if (validParams.length > 0) {
    urlObj.query = validParams;
  }

  const validVariables: PostmanVariable[] = (pathVariables || [])
    .filter((v) => v && String(v.key ?? '').trim() !== '')
    .map((v) => ({
      key: String(v.key).trim(),
      value: String(v.value ?? ''),
      ...(v.enabled === false ? { disabled: true } : {}),
      ...(v.description ? { description: v.description } : {}),
    }));

  if (validVariables.length > 0) {
    urlObj.variable = validVariables;
  }

  return urlObj;
}

/**
 * Exports an internal Collection object to standard Postman Collection v2.1.0 format.
 */
export function exportPostmanCollection(collection: Collection): string {
  if (hasUnloadedCollectionExamples(collection)) {
    throw new Error('Cannot export collection before all saved examples are loaded from cloud.');
  }
  const postmanFormat: PostmanCollectionSchema = {
    info: {
      _postman_id: collection.id,
      name: collection.name,
      description: collection.description || '',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: (collection.items || []).map(itemToPostmanJson),
  };

  return JSON.stringify(postmanFormat, null, 2);
}

export interface PostmanEnvironmentValue {
  key: string;
  value: string;
  type?: string;
  enabled?: boolean;
}

export interface PostmanEnvironmentSchema {
  id?: string;
  name?: string;
  values?: PostmanEnvironmentValue[];
  _postman_variable_scope?: string;
  _postman_exported_at?: string;
  _postman_exported_using?: string;
}

/**
 * Detects whether a parsed JSON object represents a Postman Collection or Environment.
 */
export function detectPostmanJsonType(jsonString: string): 'collection' | 'environment' | 'unknown' {
  try {
    const parsed = JSON.parse(jsonString);
    if (!parsed || typeof parsed !== 'object') return 'unknown';

    if (
      parsed._postman_variable_scope === 'environment' ||
      (Array.isArray(parsed.values) && (parsed.name || parsed._postman_exported_at || parsed.id)) ||
      (parsed.environment && Array.isArray(parsed.environment.values))
    ) {
      return 'environment';
    }

    if (
      parsed.info?.schema?.includes('collection') ||
      Array.isArray(parsed.item) ||
      parsed.info?._postman_id
    ) {
      return 'collection';
    }

    // Secondary heuristics
    if (Array.isArray(parsed.values)) return 'environment';

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Imports a Postman Environment JSON string into an Environment object.
 */
export function importPostmanEnvironment(jsonString: string): Environment {
  const parsed = JSON.parse(jsonString);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid JSON format: root is not an object.');
  }

  const rawEnv = parsed.environment && typeof parsed.environment === 'object' ? parsed.environment : parsed;
  const name = typeof rawEnv.name === 'string' && rawEnv.name.trim() ? rawEnv.name.trim() : 'Imported Environment';

  interface PostmanRawEnvItem {
    key?: unknown;
    value?: unknown;
    enabled?: unknown;
  }
  let rawValues: PostmanRawEnvItem[] = [];
  if (Array.isArray(rawEnv.values)) {
    rawValues = rawEnv.values;
  } else if (Array.isArray(rawEnv.variable)) {
    rawValues = rawEnv.variable;
  } else if (Array.isArray(parsed.values)) {
    rawValues = parsed.values;
  } else {
    // Flat key-value dictionary support
    const ignoreKeys = ['id', 'name', '_postman_variable_scope', '_postman_exported_at', '_postman_exported_using'];
    rawValues = Object.entries(rawEnv)
      .filter(([k, v]) => !ignoreKeys.includes(k) && typeof v !== 'object')
      .map(([k, v]) => ({ key: k, value: String(v), enabled: true }));
  }

  const variables: EnvironmentVariable[] = rawValues
    .map((v: any) => {
      const initialVal = String(v.initialValue ?? v.initial_value ?? v.value ?? '');
      const currentVal = String(v.currentValue ?? v.current_value ?? v.value ?? initialVal);
      return {
        id: generateId(),
        key: String(v.key ?? '').trim(),
        value: initialVal,
        initialValue: initialVal,
        currentValue: currentVal,
        enabled: v.enabled !== false,
      };
    })
    .filter((v) => v.key !== '');

  if (variables.length === 0) {
    variables.push({ id: generateId(), key: '', value: '', initialValue: '', currentValue: '', enabled: true });
  }

  return {
    id: generateId(),
    name,
    variables,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Exports an Environment object to standard Postman Environment format.
 */
export function exportPostmanEnvironment(env: Environment): string {
  const postmanFormat: PostmanEnvironmentSchema = {
    id: env.id,
    name: env.name,
    values: (env.variables || [])
      .filter((v) => v && v.key?.trim())
      .map((v) => ({
        key: v.key,
        value: v.initialValue ?? v.value ?? '',
        type: 'default',
        enabled: v.enabled,
      })),
    _postman_variable_scope: 'environment',
    _postman_exported_at: new Date().toISOString(),
    _postman_exported_using: 'AirREST/1.6.0',
  };

  return JSON.stringify(postmanFormat, null, 2);
}
