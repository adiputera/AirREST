import { KeyValuePair } from '@/types/api';

function generateId(): string {
  return Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
}

/**
 * Parses query parameters from a URL string and synchronizes them with existing params,
 * preserving existing row IDs, enabled flags, and descriptions.
 */
export function parseQueryParamsFromUrl(
  url?: string | null,
  existingParams: KeyValuePair[] = []
): KeyValuePair[] {
  const safeUrl = typeof url === 'string' ? url : '';
  const qIndex = safeUrl.indexOf('?');
  const disabledParams = (existingParams || []).filter((p) => !p.enabled);

  if (qIndex === -1) {
    if (disabledParams.length > 0) {
      return [...disabledParams, { id: generateId(), key: '', value: '', enabled: true }];
    }
    return [{ id: generateId(), key: '', value: '', enabled: true }];
  }

  const queryString = safeUrl.substring(qIndex + 1);
  if (!queryString.trim()) {
    if (disabledParams.length > 0) {
      return [...disabledParams, { id: generateId(), key: '', value: '', enabled: true }];
    }
    return [{ id: generateId(), key: '', value: '', enabled: true }];
  }

  const pairs = queryString.split('&');
  const parsedEntries: { key: string; value: string }[] = [];

  for (const pair of pairs) {
    if (!pair) continue;
    const eqIdx = pair.indexOf('=');
    const key = eqIdx >= 0 ? pair.substring(0, eqIdx) : pair;
    const value = eqIdx >= 0 ? pair.substring(eqIdx + 1) : '';
    parsedEntries.push({ key, value });
  }

  const usedIds = new Set<string>();
  const synced: KeyValuePair[] = [];

  for (let i = 0; i < parsedEntries.length; i++) {
    const entry = parsedEntries[i];

    // Priority 1: Match by exact key among existing enabled params
    const keyMatch = existingParams.find(
      (p) => p.enabled && p.key === entry.key && !usedIds.has(p.id)
    );

    if (keyMatch) {
      usedIds.add(keyMatch.id);
      synced.push({
        id: keyMatch.id,
        key: entry.key,
        value: entry.value,
        enabled: true,
        description: keyMatch.description,
      });
    } else {
      // Priority 2: Match by position if existing param is enabled
      const posMatch = existingParams[i];
      if (posMatch && posMatch.enabled && !usedIds.has(posMatch.id)) {
        usedIds.add(posMatch.id);
        synced.push({
          id: posMatch.id,
          key: entry.key,
          value: entry.value,
          enabled: true,
          description: posMatch.description,
        });
      } else {
        // Priority 3: Create new row
        synced.push({
          id: generateId(),
          key: entry.key,
          value: entry.value,
          enabled: true,
        });
      }
    }
  }

  // Keep any disabled params from existing list
  for (const disabled of disabledParams) {
    if (!usedIds.has(disabled.id)) {
      synced.push(disabled);
    }
  }

  // Ensure an empty trailing row for quick user entry if needed
  if (!synced.some((p) => p.key === '' && p.value === '')) {
    synced.push({ id: generateId(), key: '', value: '', enabled: true });
  }

  return synced;
}

/**
 * Reconstructs the URL string by taking the base URL (before '?')
 * and appending active enabled query parameters.
 */
export function buildUrlWithParams(
  currentUrl?: string | null,
  params: KeyValuePair[] = []
): string {
  const safeUrl = typeof currentUrl === 'string' ? currentUrl : '';
  const qIndex = safeUrl.indexOf('?');
  const baseUrl = qIndex >= 0 ? safeUrl.substring(0, qIndex) : safeUrl;

  const activeParams = (params || []).filter(
    (p) => p && p.enabled && String(p.key ?? '').trim() !== ''
  );

  if (activeParams.length === 0) {
    return baseUrl;
  }

  const queryString = activeParams
    .map((p) => (p.value !== '' ? `${p.key}=${p.value}` : p.key))
    .join('&');

  return `${baseUrl}?${queryString}`;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extracts path string (excluding domain, port, query string, and hash) from a URL.
 */
export function extractPathFromUrl(url?: string | null): string {
  if (!url) return '';
  let str = url.trim();
  const qIdx = str.search(/[?#]/);
  if (qIdx !== -1) {
    str = str.substring(0, qIdx);
  }
  const protoIdx = str.indexOf('://');
  if (protoIdx !== -1) {
    const slashAfterHost = str.indexOf('/', protoIdx + 3);
    if (slashAfterHost === -1) return '';
    return str.substring(slashAfterHost);
  }
  const firstSlash = str.indexOf('/');
  if (firstSlash !== -1) {
    return str.substring(firstSlash);
  }
  return '';
}

/**
 * Parses path variable names from a URL string (e.g. /rules/:id -> ['id']),
 * synchronizing them with existing path variables to preserve values and descriptions.
 */
export function parsePathVariablesFromUrl(
  url?: string | null,
  existingVars: KeyValuePair[] = []
): KeyValuePair[] {
  const path = extractPathFromUrl(url);
  if (!path) {
    return [];
  }

  const regex = /(?:^|\/):([a-zA-Z0-9_]+)(?=\/|$)/g;
  const matchedKeys: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(path)) !== null) {
    const key = match[1];
    if (key && !matchedKeys.includes(key)) {
      matchedKeys.push(key);
    }
  }

  if (matchedKeys.length === 0) {
    return [];
  }

  const existingMap = new Map<string, KeyValuePair>();
  for (const v of existingVars || []) {
    if (v && v.key && !existingMap.has(v.key)) {
      existingMap.set(v.key, v);
    }
  }

  return matchedKeys.map((key) => {
    const existing = existingMap.get(key);
    if (existing) {
      return {
        id: existing.id || generateId(),
        key,
        value: existing.value ?? '',
        enabled: existing.enabled !== false,
        description: existing.description,
      };
    }
    return {
      id: generateId(),
      key,
      value: '',
      enabled: true,
    };
  });
}

/**
 * Replaces :variable tokens in the URL path with their assigned values.
 */
export function substitutePathVariables(
  url?: string | null,
  pathVariables: KeyValuePair[] = []
): string {
  if (!url) return '';
  let result = url;

  const activeVars = (pathVariables || []).filter(
    (v) => v && v.enabled !== false && String(v.key ?? '').trim() !== ''
  );

  for (const pv of activeVars) {
    const key = String(pv.key).trim();
    const val = pv.value !== undefined ? String(pv.value) : '';
    const regex = new RegExp(`(^|/):${escapeRegex(key)}(?=/|\\?|#|$)`, 'g');
    result = result.replace(regex, `$1${val}`);
  }

  return result;
}

