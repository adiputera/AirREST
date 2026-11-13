import { ApiRequest, AuthConfig, KeyValuePair } from '../types/api';

export interface EffectiveAuthHeader {
  key: string;
  normalizedKey: string;
  value: string;
  authType: 'bearer' | 'basic' | 'apikey';
  basicCredentials?: {
    username: string;
    password: string;
  };
}

export interface AuthHeaderPreview {
  id: string;
  key: string;
  normalizedKey: string;
  displayKey: string;
  value: string;
  valueType: 'text' | 'password';
  authType: 'bearer' | 'basic' | 'apikey';
}

export interface BodyContentTypeHeader {
  key: 'Content-Type';
  normalizedKey: 'content-type';
  value: string;
  isManagedByRuntime: boolean;
}

export interface BodyContentTypePreview {
  id: string;
  key: 'Content-Type';
  normalizedKey: 'content-type';
  value: string;
  valueType: 'text';
  isManagedByRuntime: boolean;
  isOverridden: boolean;
  overriddenBy?: 'auth' | 'manual';
}

export interface ResolvedManualHeader {
  id: string;
  key: string;
  value: string;
}

export interface EditorHeadersAnalysis {
  authPreview: AuthHeaderPreview | null;
  bodyContentTypePreview: BodyContentTypePreview | null;
  warningsById: Record<string, string>;
  overriddenIds: Set<string>;
  effectiveCount: number;
}

export type BodyContentTypeSource = Pick<ApiRequest, 'method' | 'bodyType' | 'rawType' | 'bodyBinaryFile'>;

export type VariableResolver = (input: string) => string;

/**
 * Normalizes an HTTP header name for case-insensitive comparison.
 */
export function normalizeHeaderName(name: string): string {
  return String(name ?? '').trim().toLowerCase();
}

/**
 * Resolves {{variable}} placeholders using a static variable map only,
 * leaving dynamic built-in tokens (e.g. {{$guid}}, {{$randomInt}}) and
 * unresolved placeholders untouched for safe UI preview rendering.
 */
export function interpolateStaticVariables(
  input: string,
  variables: Record<string, string> = {}
): string {
  if (!input) return input;
  return input.replace(/\{\{([^{}]+)\}\}/g, (match, varName) => {
    const trimmed = varName.trim();
    if (Object.prototype.hasOwnProperty.call(variables, trimmed) && variables[trimmed] !== undefined) {
      return variables[trimmed];
    }
    return match;
  });
}

/**
 * Encodes Basic Auth credentials using UTF-8 compatible Base64.
 */
export function encodeBasicCredentials(username: string, password: string): string {
  const raw = `${username}:${password}`;
  try {
    return btoa(unescape(encodeURIComponent(raw)));
  } catch {
    return btoa(raw);
  }
}

/**
 * Formats the warning message shown when an active manual header is overridden by Auth.
 */
export function formatOverriddenHeaderWarning(authHeaderName: string): string {
  const normalized = normalizeHeaderName(authHeaderName);
  const displayHeaderName = normalized === 'authorization'
    ? 'Authorization'
    : String(authHeaderName ?? '').trim();
  return `This is a duplicate header and will be overridden by the ${displayHeaderName} header set in Auth tab`;
}

/**
 * Formats the warning message shown when an active manual Content-Type header
 * is automatically overridden on multipart/form-data requests.
 */
export function formatFormDataContentTypeWarning(): string {
  return 'This is a duplicate header and will be overridden by the Content-Type header managed automatically for form-data in Body tab';
}

/**
 * Resolves the Content-Type header implied by the active request method and Body configuration.
 * Returns null for GET/HEAD requests or bodyType "none".
 */
export function resolveBodyContentTypeHeader(
  bodySource?: BodyContentTypeSource | null
): BodyContentTypeHeader | null {
  if (!bodySource) return null;
  const method = String(bodySource.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return null;

  const { bodyType, rawType, bodyBinaryFile } = bodySource;
  if (bodyType === 'json' || (bodyType === 'raw' && rawType === 'json')) {
    return { key: 'Content-Type', normalizedKey: 'content-type', value: 'application/json', isManagedByRuntime: false };
  }
  if (bodyType === 'graphql') {
    return { key: 'Content-Type', normalizedKey: 'content-type', value: 'application/json', isManagedByRuntime: false };
  }
  if (bodyType === 'xml' || (bodyType === 'raw' && rawType === 'xml')) {
    return { key: 'Content-Type', normalizedKey: 'content-type', value: 'application/xml', isManagedByRuntime: false };
  }
  if (bodyType === 'raw' && rawType === 'html') {
    return { key: 'Content-Type', normalizedKey: 'content-type', value: 'text/html', isManagedByRuntime: false };
  }
  if (bodyType === 'raw') {
    return { key: 'Content-Type', normalizedKey: 'content-type', value: 'text/plain', isManagedByRuntime: false };
  }
  if (bodyType === 'x-www-form-urlencoded') {
    return { key: 'Content-Type', normalizedKey: 'content-type', value: 'application/x-www-form-urlencoded', isManagedByRuntime: false };
  }
  if (bodyType === 'form-data') {
    return { key: 'Content-Type', normalizedKey: 'content-type', value: 'multipart/form-data', isManagedByRuntime: true };
  }
  if (bodyType === 'binary') {
    return {
      key: 'Content-Type',
      normalizedKey: 'content-type',
      value: bodyBinaryFile?.type || 'application/octet-stream',
      isManagedByRuntime: false,
    };
  }
  return null;
}

/**
 * Resolves the effective header generated by the request's Auth configuration
 * for request dispatch and cURL export. Returns null when Auth does not emit a header.
 */
export function resolveEffectiveAuthHeader(
  auth?: AuthConfig | null,
  resolveVariable: VariableResolver = (s) => s
): EffectiveAuthHeader | null {
  if (!auth || auth.type === 'none') {
    return null;
  }

  if (auth.type === 'bearer') {
    const rawToken = String(auth.bearerToken ?? '').trim();
    if (!rawToken) return null;
    const token = resolveVariable(rawToken);
    return {
      key: 'Authorization',
      normalizedKey: 'authorization',
      value: `Bearer ${token}`,
      authType: 'bearer',
    };
  }

  if (auth.type === 'basic') {
    const rawUser = String(auth.basicUsername ?? '');
    const rawPass = String(auth.basicPassword ?? '');
    if (rawUser === '' && rawPass === '') return null;
    const username = resolveVariable(rawUser);
    const password = resolveVariable(rawPass);
    const credentials = encodeBasicCredentials(username, password);
    return {
      key: 'Authorization',
      normalizedKey: 'authorization',
      value: `Basic ${credentials}`,
      authType: 'basic',
      basicCredentials: { username, password },
    };
  }

  if (auth.type === 'apikey') {
    if (auth.apiKeyIn === 'query') return null;
    const rawKey = String(auth.apiKeyKey ?? '').trim();
    const rawValue = String(auth.apiKeyValue ?? '').trim();
    if (!rawKey || !rawValue) return null;
    const resolvedKey = resolveVariable(rawKey).trim();
    if (!resolvedKey) return null;
    const resolvedValue = resolveVariable(rawValue);
    return {
      key: resolvedKey,
      normalizedKey: normalizeHeaderName(resolvedKey),
      value: resolvedValue,
      authType: 'apikey',
    };
  }

  return null;
}

/**
 * Derives a readonly preview row descriptor for the Headers table from Auth config
 * without mutating the request's stored headers or executing dynamic variables.
 */
export function deriveAuthHeaderPreview(
  auth?: AuthConfig | null,
  resolveVariable: VariableResolver = (s) => s
): AuthHeaderPreview | null {
  if (!auth || auth.type === 'none') {
    return null;
  }

  if (auth.type === 'bearer') {
    const rawToken = String(auth.bearerToken ?? '').trim();
    if (!rawToken) return null;
    return {
      id: '__auth_derived_header__',
      key: 'Authorization',
      normalizedKey: 'authorization',
      displayKey: 'Authorization',
      value: `Bearer ${rawToken}`,
      valueType: 'password',
      authType: 'bearer',
    };
  }

  if (auth.type === 'basic') {
    const rawUser = String(auth.basicUsername ?? '');
    const rawPass = String(auth.basicPassword ?? '');
    if (rawUser === '' && rawPass === '') return null;
    const username = resolveVariable(rawUser);
    const password = resolveVariable(rawPass);
    return {
      id: '__auth_derived_header__',
      key: 'Authorization',
      normalizedKey: 'authorization',
      displayKey: 'Authorization',
      value: `Basic ${encodeBasicCredentials(username, password)}`,
      valueType: 'password',
      authType: 'basic',
    };
  }

  if (auth.type === 'apikey') {
    if (auth.apiKeyIn === 'query') return null;
    const rawKey = String(auth.apiKeyKey ?? '').trim();
    const rawValue = String(auth.apiKeyValue ?? '').trim();
    if (!rawKey || !rawValue) return null;
    const resolvedKey = resolveVariable(rawKey).trim();
    if (!resolvedKey) return null;
    const normalizedKey = normalizeHeaderName(resolvedKey);
    return {
      id: '__auth_derived_header__',
      key: rawKey,
      normalizedKey,
      displayKey: normalizedKey === 'authorization' ? 'Authorization' : resolvedKey,
      value: rawValue,
      valueType: 'password',
      authType: 'apikey',
    };
  }

  return null;
}

/**
 * Resolves active manual headers once per dispatch/export and excludes any row
 * whose resolved header name collides case-insensitively with excluded header names
 * (such as an active Auth header or runtime-managed form-data Content-Type).
 */
export function resolveManualHeaders(
  headers: KeyValuePair[] = [],
  excludedNormalizedKeys: string | Iterable<string | null | undefined> | null,
  resolveVariable: VariableResolver = (s) => s
): ResolvedManualHeader[] {
  const excludedSet = new Set<string>();
  if (typeof excludedNormalizedKeys === 'string') {
    const normalized = normalizeHeaderName(excludedNormalizedKeys);
    if (normalized) excludedSet.add(normalized);
  } else if (excludedNormalizedKeys) {
    for (const key of excludedNormalizedKeys) {
      if (typeof key === 'string') {
        const normalized = normalizeHeaderName(key);
        if (normalized) excludedSet.add(normalized);
      }
    }
  }

  const result: ResolvedManualHeader[] = [];
  for (const h of Array.isArray(headers) ? headers : []) {
    if (!h || !h.enabled) continue;
    const rawKey = String(h.key ?? '').trim();
    if (!rawKey) continue;

    const resolvedKey = resolveVariable(rawKey).trim();
    if (!resolvedKey) continue;

    if (excludedSet.has(normalizeHeaderName(resolvedKey))) {
      continue;
    }

    const resolvedValue = resolveVariable(String(h.value ?? ''));
    result.push({
      id: h.id,
      key: resolvedKey,
      value: resolvedValue,
    });
  }
  return result;
}

/**
 * Analyzes Auth, Body Content-Type, and manual headers for RequestEditor UI presentation:
 * produces optional readonly Auth and Body Content-Type rows, duplicate override warnings per manual row ID,
 * and the effective configured header count.
 */
export function analyzeHeadersForEditor(
  headers: KeyValuePair[] = [],
  auth?: AuthConfig | null,
  resolveVariable: VariableResolver = (s) => s,
  bodySource?: BodyContentTypeSource | null
): EditorHeadersAnalysis {
  const authPreview = deriveAuthHeaderPreview(auth, resolveVariable);
  const bodyHeaderSpec = resolveBodyContentTypeHeader(bodySource);
  const warningsById: Record<string, string> = {};
  const overriddenIds = new Set<string>();
  let nonOverriddenManualCount = 0;
  let hasActiveManualContentType = false;

  for (const h of Array.isArray(headers) ? headers : []) {
    if (!h || !h.enabled) continue;
    const rawKey = String(h.key ?? '').trim();
    if (!rawKey) continue;

    const resolvedKey = resolveVariable(rawKey).trim();
    if (!resolvedKey) continue;

    const normalizedKey = normalizeHeaderName(resolvedKey);
    if (authPreview && normalizedKey === authPreview.normalizedKey) {
      overriddenIds.add(h.id);
      warningsById[h.id] = formatOverriddenHeaderWarning(authPreview.displayKey);
    } else if (bodyHeaderSpec?.isManagedByRuntime && normalizedKey === 'content-type') {
      overriddenIds.add(h.id);
      warningsById[h.id] = formatFormDataContentTypeWarning();
    } else {
      nonOverriddenManualCount++;
      if (normalizedKey === 'content-type') {
        hasActiveManualContentType = true;
      }
    }
  }

  let bodyContentTypePreview: BodyContentTypePreview | null = null;
  if (bodyHeaderSpec) {
    const authOwnsContentType = authPreview?.normalizedKey === 'content-type';
    const isOverridden = !bodyHeaderSpec.isManagedByRuntime && (authOwnsContentType || hasActiveManualContentType);
    bodyContentTypePreview = {
      id: '__body_content_type_header__',
      key: bodyHeaderSpec.key,
      normalizedKey: bodyHeaderSpec.normalizedKey,
      value: bodyHeaderSpec.value,
      valueType: 'text',
      isManagedByRuntime: bodyHeaderSpec.isManagedByRuntime,
      isOverridden,
      ...(isOverridden ? { overriddenBy: authOwnsContentType ? 'auth' : 'manual' } : {}),
    };
  }

  const runtimeOverridesAuthContentType = Boolean(
    bodyHeaderSpec?.isManagedByRuntime && authPreview?.normalizedKey === 'content-type'
  );
  const bodyContributesHeader = Boolean(
    bodyContentTypePreview && !bodyContentTypePreview.isOverridden && !runtimeOverridesAuthContentType
  );

  return {
    authPreview,
    bodyContentTypePreview,
    warningsById,
    overriddenIds,
    effectiveCount: nonOverriddenManualCount + (authPreview ? 1 : 0) + (bodyContributesHeader ? 1 : 0),
  };
}
