import {
  AuthConfig,
  SavedExampleHeader,
} from '../types/api';
import {
  encodeBasicCredentials,
  normalizeHeaderName,
} from './authHeaders';
import {
  classifyExampleMime,
  isValidXmlDocument,
  parseContentTypeHeader,
} from './examples';
import {
  beautifyJson,
  compileEffectiveJsonPayload,
} from './formatters';

export interface SnapshotDisplayHeader extends SavedExampleHeader {
  autoSource?: 'body' | 'auth';
}

export interface SnapshotBodyRow {
  key: string;
  value: string;
  type: 'text' | 'file';
  disabled?: boolean;
}

export interface ResolvedSnapshotBody {
  mode: string;
  language: 'json' | 'xml' | 'text';
  formatLabel: string;
  rawContent: string;
  prettyContent: string;
  isJson: boolean;
  isStructuredTable: boolean;
  rows: SnapshotBodyRow[];
}

function hasTemplatePlaceholder(value: string): boolean {
  return /\{\{[^{}]+\}\}/.test(value);
}

function resolveSnapshotAuthHeader(auth?: AuthConfig | null): { key: string; normalizedKey: string; value: string } | null {
  if (!auth || auth.type === 'none') return null;

  if (auth.type === 'bearer') {
    const rawToken = String(auth.bearerToken ?? '').trim();
    if (!rawToken) return null;
    return {
      key: 'Authorization',
      normalizedKey: 'authorization',
      value: `Bearer ${rawToken}`,
    };
  }

  if (auth.type === 'basic') {
    const rawUser = String(auth.basicUsername ?? '');
    const rawPass = String(auth.basicPassword ?? '');
    if (rawUser === '' && rawPass === '') return null;
    const value = hasTemplatePlaceholder(rawUser) || hasTemplatePlaceholder(rawPass)
      ? `Basic ${rawUser}:${rawPass}`
      : `Basic ${encodeBasicCredentials(rawUser, rawPass)}`;
    return {
      key: 'Authorization',
      normalizedKey: 'authorization',
      value,
    };
  }

  if (auth.type === 'apikey') {
    if (auth.apiKeyIn === 'query') return null;
    const rawKey = String(auth.apiKeyKey ?? '').trim();
    const rawValue = String(auth.apiKeyValue ?? '').trim();
    if (!rawKey || !rawValue) return null;
    return {
      key: rawKey,
      normalizedKey: normalizeHeaderName(rawKey),
      value: rawValue,
    };
  }

  return null;
}

function parsePostmanSnapshotAuth(rawAuth: unknown): AuthConfig | null {
  if (!rawAuth || typeof rawAuth !== 'object') return null;
  const authObj = rawAuth as Record<string, unknown>;
  const type = String(authObj.type || '').toLowerCase();
  const findAttr = (list: unknown, key: string): string => {
    if (!Array.isArray(list)) return '';
    const entry = list.find(
      (item) => item && typeof item === 'object' && String((item as Record<string, unknown>).key || '').toLowerCase() === key,
    );
    return entry && typeof (entry as Record<string, unknown>).value === 'string'
      ? String((entry as Record<string, unknown>).value)
      : '';
  };

  if (type === 'bearer') {
    return { type: 'bearer', bearerToken: findAttr(authObj.bearer, 'token') };
  }
  if (type === 'basic') {
    return {
      type: 'basic',
      basicUsername: findAttr(authObj.basic, 'username'),
      basicPassword: findAttr(authObj.basic, 'password'),
    };
  }
  if (type === 'apikey') {
    const apiKeyIn = findAttr(authObj.apikey, 'in') === 'query' ? 'query' : 'header';
    return {
      type: 'apikey',
      apiKeyKey: findAttr(authObj.apikey, 'key'),
      apiKeyValue: findAttr(authObj.apikey, 'value'),
      apiKeyIn,
    };
  }
  return null;
}

function inferContentTypeFromSnapshotBody(rawMethod: unknown, rawBody: unknown): { value: string; isManagedByRuntime: boolean } | null {
  const method = String(rawMethod || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return null;
  if (!rawBody || typeof rawBody !== 'object') return null;

  const bodyObj = rawBody as Record<string, unknown>;
  const mode = String(bodyObj.mode || 'none').toLowerCase();
  if (mode === 'graphql') return { value: 'application/json', isManagedByRuntime: false };
  if (mode === 'urlencoded') return { value: 'application/x-www-form-urlencoded', isManagedByRuntime: false };
  if (mode === 'formdata') return { value: 'multipart/form-data', isManagedByRuntime: true };
  if (mode === 'file') return { value: 'application/octet-stream', isManagedByRuntime: false };
  if (mode === 'raw') {
    const options = bodyObj.options && typeof bodyObj.options === 'object' ? (bodyObj.options as Record<string, unknown>) : undefined;
    const rawOpts = options?.raw && typeof options.raw === 'object' ? (options.raw as Record<string, unknown>) : undefined;
    const lang = String(rawOpts?.language || '').toLowerCase();
    if (lang === 'json') return { value: 'application/json', isManagedByRuntime: false };
    if (lang === 'xml') return { value: 'application/xml', isManagedByRuntime: false };
    if (lang === 'html') return { value: 'text/html', isManagedByRuntime: false };
    if (lang === 'text') return { value: 'text/plain', isManagedByRuntime: false };

    const rawText = typeof bodyObj.raw === 'string' ? bodyObj.raw : '';
    const trimmed = rawText.trim();
    if (!trimmed) return null;
    const effectiveJson = compileEffectiveJsonPayload(rawText).trim();
    if ((effectiveJson.startsWith('{') || effectiveJson.startsWith('[')) && !beautifyJson(effectiveJson).error) {
      return { value: 'application/json', isManagedByRuntime: false };
    }
    if (trimmed.startsWith('<') && isValidXmlDocument(trimmed)) {
      return { value: 'application/xml', isManagedByRuntime: false };
    }
    return { value: 'text/plain', isManagedByRuntime: false };
  }
  return null;
}

/**
 * Resolves effective snapshot headers for display in SavedExampleViewer,
 * backfilling auto-added Content-Type and Auth headers for legacy or imported snapshots.
 */
export function resolveSnapshotDisplayHeaders(origReq: Record<string, unknown> | null | undefined): SnapshotDisplayHeader[] {
  if (!origReq || typeof origReq !== 'object') return [];

  const rawHeaders: SavedExampleHeader[] = Array.isArray(origReq.header)
    ? origReq.header.filter((h): h is SavedExampleHeader => Boolean(h && typeof h === 'object'))
    : [];

  const authHeader = resolveSnapshotAuthHeader(parsePostmanSnapshotAuth(origReq.auth));
  const bodyContentType = inferContentTypeFromSnapshotBody(origReq.method, origReq.body);

  const activeNormalizedKeys = new Set<string>();
  const result: SnapshotDisplayHeader[] = [];

  for (const h of rawHeaders) {
    const key = String(h.key ?? '');
    const value = String(h.value ?? '');
    if (!key.trim() && !value.trim()) continue;
    const normalizedKey = normalizeHeaderName(key);
    const isDisabled = Boolean(h.disabled);

    if (!isDisabled && normalizedKey) {
      if (authHeader && normalizedKey === authHeader.normalizedKey) {
        continue;
      }
      if (bodyContentType?.isManagedByRuntime && normalizedKey === 'content-type') {
        continue;
      }
      activeNormalizedKeys.add(normalizedKey);
    }

    result.push({
      key,
      value,
      ...(isDisabled ? { disabled: true } : {}),
      ...(h.description ? { description: String(h.description) } : {}),
    });
  }

  if (authHeader && !activeNormalizedKeys.has(authHeader.normalizedKey)) {
    activeNormalizedKeys.add(authHeader.normalizedKey);
    result.push({
      key: authHeader.key,
      value: authHeader.value,
      autoSource: 'auth',
    });
  }

  if (bodyContentType && !activeNormalizedKeys.has('content-type')) {
    result.push({
      key: 'Content-Type',
      value: bodyContentType.value,
      autoSource: 'body',
    });
  }

  return result;
}

function detectLanguageFromContentType(headers: readonly SnapshotDisplayHeader[]): 'json' | 'xml' | 'text' | null {
  for (const h of headers) {
    if (h.disabled || normalizeHeaderName(h.key) !== 'content-type') continue;
    const entries = parseContentTypeHeader(h.value);
    for (const entry of entries) {
      const classified = classifyExampleMime(entry.mime);
      if (classified?.language === 'json') return 'json';
      if (classified?.language === 'xml') return 'xml';
      if (classified?.language === 'html') return 'text';
    }
  }
  return null;
}

/**
 * Resolves snapshot body content, language highlighting, comment-free JSON payload,
 * and Pretty/Raw variants for SavedExampleViewer.
 */
export function resolveSnapshotBody(
  rawBody: unknown,
  displayHeaders: readonly SnapshotDisplayHeader[] = [],
): ResolvedSnapshotBody {
  if (!rawBody || typeof rawBody !== 'object') {
    return {
      mode: 'none',
      language: 'text',
      formatLabel: '',
      rawContent: '',
      prettyContent: '',
      isJson: false,
      isStructuredTable: false,
      rows: [],
    };
  }

  const bodyObj = rawBody as Record<string, unknown>;
  const mode = String(bodyObj.mode || 'none').toLowerCase();

  if (mode === 'raw') {
    const rawStr = typeof bodyObj.raw === 'string' ? bodyObj.raw : '';
    const options = bodyObj.options && typeof bodyObj.options === 'object' ? (bodyObj.options as Record<string, unknown>) : undefined;
    const rawOpts = options?.raw && typeof options.raw === 'object' ? (options.raw as Record<string, unknown>) : undefined;
    const declaredLang = String(rawOpts?.language || '').toLowerCase();
    const headerLang = detectLanguageFromContentType(displayHeaders);

    let language: 'json' | 'xml' | 'text' = 'text';
    if (declaredLang === 'json') {
      language = 'json';
    } else if (declaredLang === 'xml') {
      language = 'xml';
    } else if (declaredLang === 'html' || declaredLang === 'text') {
      language = 'text';
    } else if (headerLang) {
      language = headerLang;
    } else {
      const effectiveCandidate = compileEffectiveJsonPayload(rawStr).trim();
      if ((effectiveCandidate.startsWith('{') || effectiveCandidate.startsWith('[')) && !beautifyJson(effectiveCandidate).error) {
        language = 'json';
      } else if (rawStr.trim().startsWith('<') && isValidXmlDocument(rawStr.trim())) {
        language = 'xml';
      }
    }

    if (language === 'json') {
      const effectiveRaw = compileEffectiveJsonPayload(rawStr);
      const beautified = beautifyJson(effectiveRaw);
      let prettyContent = beautified.error ? effectiveRaw : beautified.formatted;
      if (beautified.error && effectiveRaw.trim()) {
        try {
          prettyContent = JSON.stringify(JSON.parse(effectiveRaw.replace(/^\uFEFF/, '')), null, 2);
        } catch {
          prettyContent = effectiveRaw;
        }
      }
      return {
        mode,
        language: 'json',
        formatLabel: 'JSON',
        rawContent: effectiveRaw,
        prettyContent,
        isJson: true,
        isStructuredTable: false,
        rows: [],
      };
    }

    const formatLabel = language === 'xml' ? 'XML' : (declaredLang === 'html' ? 'HTML' : 'TEXT');
    return {
      mode,
      language,
      formatLabel,
      rawContent: rawStr,
      prettyContent: rawStr,
      isJson: false,
      isStructuredTable: false,
      rows: [],
    };
  }

  if (mode === 'graphql' && bodyObj.graphql && typeof bodyObj.graphql === 'object') {
    const gql = bodyObj.graphql as Record<string, unknown>;
    const query = typeof gql.query === 'string' ? gql.query : '';
    const rawVars = typeof gql.variables === 'string' ? gql.variables : '';
    const vars = compileEffectiveJsonPayload(rawVars).trim();
    const content = vars ? `${query}\n\n# Variables\n${vars}` : query;
    return {
      mode,
      language: 'text',
      formatLabel: 'GRAPHQL',
      rawContent: content,
      prettyContent: content,
      isJson: false,
      isStructuredTable: false,
      rows: [],
    };
  }

  if (mode === 'urlencoded' && Array.isArray(bodyObj.urlencoded)) {
    const rows: SnapshotBodyRow[] = bodyObj.urlencoded
      .filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object'))
      .filter((r) => String(r.key ?? '').trim() !== '' || String(r.value ?? '').trim() !== '')
      .map((r) => ({
        key: String(r.key ?? ''),
        value: String(r.value ?? ''),
        type: 'text',
        ...(r.disabled ? { disabled: true } : {}),
      }));
    const rawContent = rows
      .filter((r) => !r.disabled)
      .map((r) => `${r.key}=${r.value}`)
      .join('\n');
    return {
      mode,
      language: 'text',
      formatLabel: 'X-WWW-FORM-URLENCODED',
      rawContent,
      prettyContent: rawContent,
      isJson: false,
      isStructuredTable: true,
      rows,
    };
  }

  if (mode === 'formdata' && Array.isArray(bodyObj.formdata)) {
    const rows: SnapshotBodyRow[] = bodyObj.formdata
      .filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object'))
      .filter((r) => String(r.key ?? '').trim() !== '' || String(r.value ?? '').trim() !== '' || Boolean(r.src))
      .map((r) => ({
        key: String(r.key ?? ''),
        value: r.type === 'file' ? String(r.src || '(unselected file)') : String(r.value ?? ''),
        type: r.type === 'file' ? 'file' : 'text',
        ...(r.disabled ? { disabled: true } : {}),
      }));
    const rawContent = rows
      .filter((r) => !r.disabled)
      .map((r) => (r.type === 'file' ? `${r.key}: [file: ${r.value}]` : `${r.key}: ${r.value}`))
      .join('\n');
    return {
      mode,
      language: 'text',
      formatLabel: 'FORM-DATA',
      rawContent,
      prettyContent: rawContent,
      isJson: false,
      isStructuredTable: true,
      rows,
    };
  }

  if (mode === 'file') {
    const fileObj = bodyObj.file && typeof bodyObj.file === 'object' ? (bodyObj.file as Record<string, unknown>) : undefined;
    const src = typeof fileObj?.src === 'string' ? fileObj.src : '';
    const content = src ? `[binary file: ${src}]` : '[binary file]';
    return {
      mode,
      language: 'text',
      formatLabel: 'BINARY',
      rawContent: content,
      prettyContent: content,
      isJson: false,
      isStructuredTable: false,
      rows: [],
    };
  }

  return {
    mode: 'none',
    language: 'text',
    formatLabel: '',
    rawContent: '',
    prettyContent: '',
    isJson: false,
    isStructuredTable: false,
    rows: [],
  };
}
