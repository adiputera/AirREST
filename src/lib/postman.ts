import {
  ApiRequest,
  Collection,
  CollectionItem,
  HttpMethod,
  KeyValuePair,
  Environment,
  EnvironmentVariable,
  AuthConfig,
} from '@/types/api';

interface PostmanHeader {
  key?: string;
  value?: string;
  disabled?: boolean;
  description?: string;
}

interface PostmanQueryParam {
  key?: string;
  value?: string;
  disabled?: boolean;
}

interface PostmanUrlObject {
  raw?: string;
  protocol?: string;
  host?: string[] | string;
  path?: string[] | string;
  query?: PostmanQueryParam[];
}

interface PostmanRequestBody {
  mode?: 'raw' | 'urlencoded' | 'formdata' | 'file';
  raw?: string;
  options?: {
    raw?: {
      language?: string;
    };
  };
}

export interface PostmanAuthAttribute {
  key?: string;
  value?: any;
  type?: string;
}

export interface PostmanAuth {
  type?: string;
  bearer?: PostmanAuthAttribute[] | Record<string, any> | string;
  basic?: PostmanAuthAttribute[] | Record<string, any>;
  apikey?: PostmanAuthAttribute[] | Record<string, any>;
  [key: string]: any;
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
}

interface PostmanCollectionSchema {
  info?: {
    _postman_id?: string;
    name?: string;
    description?: string;
    schema?: string;
  };
  item?: PostmanRawItem[];
  auth?: PostmanAuth;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
}

function parseHeaders(headers?: PostmanHeader[]): KeyValuePair[] {
  if (!Array.isArray(headers)) return [];
  return headers.map((h) => ({
    id: generateId(),
    key: h.key || '',
    value: h.value || '',
    enabled: !h.disabled,
    description: h.description,
  }));
}

function parseQueryParams(url?: string | PostmanUrlObject): KeyValuePair[] {
  if (!url || typeof url === 'string') return [];
  if (Array.isArray(url.query)) {
    return url.query.map((q) => ({
      id: generateId(),
      key: q.key || '',
      value: q.value || '',
      enabled: !q.disabled,
    }));
  }
  return [];
}

function extractRawUrl(url?: string | PostmanUrlObject): string {
  if (!url) return '';
  if (typeof url === 'string') return url;
  if (url.raw) return url.raw;

  let built = '';
  if (url.protocol) built += `${url.protocol}://`;
  if (url.host) built += Array.isArray(url.host) ? url.host.join('.') : url.host;
  if (url.path) built += '/' + (Array.isArray(url.path) ? url.path.join('/') : url.path);
  return built;
}

/**
 * Parses a Postman auth definition into an AuthConfig.
 * Supports Postman v2.0 & v2.1 formats for bearer, oauth2, basic, and apikey.
 */
export function parsePostmanAuth(rawAuth: any): AuthConfig | null {
  if (!rawAuth || typeof rawAuth !== 'object') return null;

  const authType = String(rawAuth.type || '').toLowerCase();

  // 1. Bearer Token
  if (authType === 'bearer') {
    let token = '';
    if (Array.isArray(rawAuth.bearer)) {
      const tokenItem = rawAuth.bearer.find((item: any) => {
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
      token = String(
        rawAuth.bearer.token ||
        rawAuth.bearer.bearerToken ||
        rawAuth.bearer.accessToken ||
        rawAuth.bearer.value ||
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
      const tokenItem = rawAuth.oauth2.find((item: any) => {
        if (!item || !item.key) return false;
        const k = String(item.key).toLowerCase();
        return k === 'accesstoken' || k === 'token' || k === 'value';
      });
      token = tokenItem ? String(tokenItem.value ?? '') : '';
      if (!token && rawAuth.oauth2[0]?.value) {
        token = String(rawAuth.oauth2[0].value ?? '');
      }
    } else if (rawAuth.oauth2 && typeof rawAuth.oauth2 === 'object') {
      token = String(
        rawAuth.oauth2.accessToken ||
        rawAuth.oauth2.token ||
        rawAuth.oauth2.value ||
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
      const uItem = rawAuth.basic.find((item: any) => {
        if (!item || !item.key) return false;
        const k = String(item.key).toLowerCase();
        return k === 'username' || k === 'user';
      });
      const pItem = rawAuth.basic.find((item: any) => {
        if (!item || !item.key) return false;
        const k = String(item.key).toLowerCase();
        return k === 'password' || k === 'pass';
      });
      username = uItem ? String(uItem.value ?? '') : '';
      password = pItem ? String(pItem.value ?? '') : '';
    } else if (rawAuth.basic && typeof rawAuth.basic === 'object') {
      username = String(rawAuth.basic.username ?? rawAuth.basic.user ?? '');
      password = String(rawAuth.basic.password ?? rawAuth.basic.pass ?? '');
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
      const kItem = rawAuth.apikey.find((item: any) => item && String(item.key).toLowerCase() === 'key');
      const vItem = rawAuth.apikey.find((item: any) => item && String(item.key).toLowerCase() === 'value');
      const inItem = rawAuth.apikey.find((item: any) => item && String(item.key).toLowerCase() === 'in');

      key = kItem ? String(kItem.value ?? '') : '';
      val = vItem ? String(vItem.value ?? '') : '';
      if (inItem && String(inItem.value).toLowerCase() === 'query') {
        inWhere = 'query';
      }
    } else if (rawAuth.apikey && typeof rawAuth.apikey === 'object') {
      key = String(rawAuth.apikey.key ?? '');
      val = String(rawAuth.apikey.value ?? '');
      if (String(rawAuth.apikey.in).toLowerCase() === 'query') {
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
  const authHeader = headers.find((h) => h.key.trim().toLowerCase() === 'authorization');
  if (!authHeader || !authHeader.value) return null;

  const val = authHeader.value.trim();
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

function convertPostmanItem(item: PostmanRawItem, inheritedAuth?: AuthConfig): CollectionItem {
  const isFolder = Array.isArray(item.item);

  // Folder auth overrides or falls back to inherited collection/parent auth
  const folderAuth = parsePostmanAuth(item.auth) || inheritedAuth || { type: 'none' };

  if (isFolder) {
    return {
      id: item.id || generateId(),
      name: item.name || 'Unnamed Folder',
      type: 'folder',
      items: (item.item || []).map((child) => convertPostmanItem(child, folderAuth)),
    };
  }

  // It's a request
  const rawReq = typeof item.request === 'object' && item.request !== null ? item.request : {};
  const method = (rawReq.method || 'GET').toUpperCase() as HttpMethod;
  const validMethods: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const safeMethod: HttpMethod = validMethods.includes(method) ? method : 'GET';

  const rawUrl = extractRawUrl(rawReq.url);
  const params = parseQueryParams(rawReq.url);
  const headers = parseHeaders(rawReq.header);

  let bodyType: 'none' | 'json' | 'raw' | 'x-www-form-urlencoded' = 'none';
  let bodyContent = '';

  if (rawReq.body) {
    if (rawReq.body.mode === 'raw') {
      bodyType = rawReq.body.options?.raw?.language === 'json' || rawReq.body.raw?.trim().startsWith('{') || rawReq.body.raw?.trim().startsWith('[')
        ? 'json'
        : 'raw';
      bodyContent = rawReq.body.raw || '';
    } else if (rawReq.body.mode === 'urlencoded') {
      bodyType = 'x-www-form-urlencoded';
      bodyContent = rawReq.body.raw || '';
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
    id: generateId(),
    name: item.name || 'Untitled Request',
    method: safeMethod,
    url: rawUrl,
    params,
    headers: finalHeaders,
    auth,
    bodyType,
    bodyContent,
    preRequestScript,
    postResponseScript,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  return {
    id: item.id || generateId(),
    name: item.name || 'Untitled Request',
    type: 'request',
    request: apiRequest,
  };
}

/**
 * Imports a Postman v2.0 or v2.1 collection JSON string into a Collection object.
 */
export function importPostmanCollection(jsonString: string): Collection {
  const parsed = JSON.parse(jsonString) as PostmanCollectionSchema;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid JSON format: root is not an object.');
  }

  const name = parsed.info?.name || 'Imported Postman Collection';
  const description = parsed.info?.description || '';
  const rawItems = Array.isArray(parsed.item) ? parsed.item : [];

  // Parse collection-level authorization
  const collectionAuth = parsePostmanAuth(parsed.auth) || { type: 'none' };

  const items: CollectionItem[] = rawItems.map((item) => convertPostmanItem(item, collectionAuth));

  return {
    id: generateId(),
    name,
    description,
    items,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
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

  const headers: PostmanHeader[] = req.headers.map((h) => ({
    key: h.key,
    value: h.value,
    disabled: !h.enabled,
  }));

  const queryParams: PostmanQueryParam[] = req.params.map((p) => ({
    key: p.key,
    value: p.value,
    disabled: !p.enabled,
  }));

  let body: PostmanRequestBody | undefined = undefined;
  if (req.bodyType === 'json') {
    body = {
      mode: 'raw',
      raw: req.bodyContent,
      options: {
        raw: {
          language: 'json',
        },
      },
    };
  } else if (req.bodyType === 'raw' || req.bodyType === 'x-www-form-urlencoded') {
    body = {
      mode: 'raw',
      raw: req.bodyContent,
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
  if (req.auth.type === 'bearer' && req.auth.bearerToken) {
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
  } else if (req.auth.type === 'basic') {
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
  } else if (req.auth.type === 'apikey') {
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

  return {
    name: req.name || item.name,
    request: {
      method: req.method,
      header: headers,
      url: {
        raw: req.url,
        query: queryParams.length > 0 ? queryParams : undefined,
      },
      body,
      auth,
    },
    event: event.length > 0 ? event : undefined,
  };
}

/**
 * Exports an internal Collection object to standard Postman Collection v2.1.0 format.
 */
export function exportPostmanCollection(collection: Collection): string {
  const postmanFormat: PostmanCollectionSchema = {
    info: {
      _postman_id: collection.id,
      name: collection.name,
      description: collection.description || '',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: collection.items.map(itemToPostmanJson),
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
    if (Array.isArray(parsed.items) || Array.isArray(parsed.item)) return 'collection';

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

  let rawValues: any[] = [];
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
    .map((v) => ({
      id: generateId(),
      key: String(v.key ?? '').trim(),
      value: String(v.value ?? ''),
      enabled: v.enabled !== false,
    }))
    .filter((v) => v.key !== '');

  if (variables.length === 0) {
    variables.push({ id: generateId(), key: '', value: '', enabled: true });
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
    values: env.variables
      .filter((v) => v.key.trim())
      .map((v) => ({
        key: v.key,
        value: v.value,
        type: 'default',
        enabled: v.enabled,
      })),
    _postman_variable_scope: 'environment',
    _postman_exported_at: new Date().toISOString(),
    _postman_exported_using: 'API Tester/1.1.0',
  };

  return JSON.stringify(postmanFormat, null, 2);
}
