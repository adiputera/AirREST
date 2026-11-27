import type {
  Collection,
  CollectionItem,
  FunctionalRunReport,
  PerformanceRunReport,
} from '../types/api';
import { makePerformanceTabId } from './examples';
import { parseImportedPerformanceReport } from './perfComparison';

export const AIRREST_REPORT_BUNDLE_FORMAT = 'airrest-report-v1' as const;
export const AIRREST_REPORT_FILE_EXTENSION = '.airrest-report.json' as const;

export type ReportKind = 'performance' | 'functional';

export interface AirRESTReportSourceMeta {
  sourceType: 'collection' | 'folder' | 'request';
  sourceId: string;
  sourceCollectionId?: string;
  sourceCollectionName?: string;
  sourceName: string;
}

export type AirRESTReportBundle =
  | {
      format: typeof AIRREST_REPORT_BUNDLE_FORMAT;
      version: 1;
      reportKind: 'performance';
      exportedAt: string;
      generator: 'AirREST';
      sanitized: true;
      sourceMeta: AirRESTReportSourceMeta;
      report: PerformanceRunReport;
    }
  | {
      format: typeof AIRREST_REPORT_BUNDLE_FORMAT;
      version: 1;
      reportKind: 'functional';
      exportedAt: string;
      generator: 'AirREST';
      sanitized: true;
      sourceMeta: AirRESTReportSourceMeta;
      report: FunctionalRunReport;
    };

const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'id_token',
  'idtoken',
  'api_key',
  'apikey',
  'x-api-key',
  'key',
  'secret',
  'client_secret',
  'clientsecret',
  'password',
  'passwd',
  'pwd',
  'auth',
  'authorization',
  'sig',
  'signature',
  'session',
  'session_id',
  'sessionid',
  'jwt',
  'bearer',
]);

function makeUniqueReportId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `rep_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeName(raw: string | undefined | null): string {
  return String(raw || '').trim().toLowerCase();
}

/**
 * Redacts embedded authority credentials (user:pass@host) and sensitive query parameter values
 * while keeping non-sensitive params and {{template}} placeholders intact.
 */
export function sanitizeUrlSecrets(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;

  const hashIdx = rawUrl.indexOf('#');
  const hashPart = hashIdx >= 0 ? rawUrl.slice(hashIdx) : '';
  const withoutHash = hashIdx >= 0 ? rawUrl.slice(0, hashIdx) : rawUrl;

  const qIdx = withoutHash.indexOf('?');
  const basePartRaw = qIdx >= 0 ? withoutHash.slice(0, qIdx) : withoutHash;
  const queryPartRaw = qIdx >= 0 ? withoutHash.slice(qIdx + 1) : '';

  // Redact user:pass@ in URL authority if present
  const basePart = basePartRaw.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@\s]+@)/, '$1[REDACTED]@');

  if (!queryPartRaw) {
    return basePart + hashPart;
  }

  const redactedPairs = queryPartRaw.split('&').map((pair) => {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 0) return pair;
    const rawKey = pair.slice(0, eqIdx);
    const rawVal = pair.slice(eqIdx + 1);
    let decodedKey = rawKey;
    try {
      decodedKey = decodeURIComponent(rawKey);
    } catch {
      // keep rawKey
    }
    const normalizedKey = decodedKey.trim().toLowerCase();
    // Keep Postman/AirREST variable templates unredacted even for sensitive parameter names
    if (/^(?:\{\{[^}]+\}\}|%7B%7B[^%]+%7D%7D)$/i.test(rawVal.trim())) {
      return pair;
    }
    if (SENSITIVE_QUERY_KEYS.has(normalizedKey)) {
      return `${rawKey}=[REDACTED]`;
    }
    return pair;
  });

  return `${basePart}?${redactedPairs.join('&')}${hashPart}`;
}

function redactInlineBearerSecrets(text: string | undefined): string | undefined {
  if (!text) return text;
  return text.replace(/(\bBearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]');
}

export function buildSourceMetaFromContext(
  report: Pick<
    PerformanceRunReport | FunctionalRunReport,
    'sourceType' | 'sourceId' | 'title' | 'sourceCollectionId' | 'sourceCollectionName' | 'sourceName'
  >,
  collections: Collection[]
): AirRESTReportSourceMeta {
  let sourceCollectionId = report.sourceCollectionId;
  let sourceCollectionName = report.sourceCollectionName;
  let sourceName = report.sourceName || report.title.replace(/\s+—\s+(Performance|Runner)$/i, '').trim() || report.title;

  for (const col of collections || []) {
    if (report.sourceType === 'collection' && col.id === report.sourceId) {
      sourceCollectionId = col.id;
      sourceCollectionName = col.name;
      sourceName = col.name;
      break;
    }
    const found = findNestedItemById(col.items || [], report.sourceId, col.id);
    if (found) {
      sourceCollectionId = col.id;
      sourceCollectionName = col.name;
      sourceName = found.item.name;
      break;
    }
  }

  return {
    sourceType: report.sourceType,
    sourceId: report.sourceId,
    ...(sourceCollectionId ? { sourceCollectionId } : {}),
    ...(sourceCollectionName ? { sourceCollectionName } : {}),
    sourceName,
  };
}

export function sanitizePerformanceReportForShare(
  report: PerformanceRunReport,
  sourceMeta: AirRESTReportSourceMeta
): PerformanceRunReport {
  return {
    ...report,
    sourceType: sourceMeta.sourceType,
    sourceId: sourceMeta.sourceId,
    ...(sourceMeta.sourceCollectionId ? { sourceCollectionId: sourceMeta.sourceCollectionId } : {}),
    ...(sourceMeta.sourceCollectionName ? { sourceCollectionName: sourceMeta.sourceCollectionName } : {}),
    sourceName: sourceMeta.sourceName,
    setupResults: (report.setupResults || []).map((s) => ({
      ...s,
      url: sanitizeUrlSecrets(s.url),
    })),
    errorSamples: (report.errorSamples || []).map((sample) => ({
      ...sample,
      url: sanitizeUrlSecrets(sample.url),
      ...(sample.responseSnippet ? { responseSnippet: redactInlineBearerSecrets(sample.responseSnippet) } : {}),
    })),
    warnings: (report.warnings || []).map((w) => redactInlineBearerSecrets(w) || w),
  };
}

export function sanitizeFunctionalReportForShare(
  report: FunctionalRunReport,
  sourceMeta: AirRESTReportSourceMeta
): FunctionalRunReport {
  return {
    ...report,
    sourceType: sourceMeta.sourceType,
    sourceId: sourceMeta.sourceId,
    ...(sourceMeta.sourceCollectionId ? { sourceCollectionId: sourceMeta.sourceCollectionId } : {}),
    ...(sourceMeta.sourceCollectionName ? { sourceCollectionName: sourceMeta.sourceCollectionName } : {}),
    sourceName: sourceMeta.sourceName,
    steps: (report.steps || []).map((step) => ({
      ...step,
      url: sanitizeUrlSecrets(step.url),
      hasCapturedExchange: false,
      ...(step.errorMessage ? { errorMessage: redactInlineBearerSecrets(step.errorMessage) } : {}),
    })),
  };
}

export function exportShareablePerformanceReport(
  report: PerformanceRunReport,
  sourceMeta: AirRESTReportSourceMeta
): string {
  const sanitizedReport = sanitizePerformanceReportForShare(report, sourceMeta);
  const bundle: AirRESTReportBundle = {
    format: AIRREST_REPORT_BUNDLE_FORMAT,
    version: 1,
    reportKind: 'performance',
    exportedAt: new Date().toISOString(),
    generator: 'AirREST',
    sanitized: true,
    sourceMeta,
    report: sanitizedReport,
  };
  return JSON.stringify(bundle, null, 2);
}

export function exportShareableFunctionalReport(
  report: FunctionalRunReport,
  sourceMeta: AirRESTReportSourceMeta
): string {
  const sanitizedReport = sanitizeFunctionalReportForShare(report, sourceMeta);
  const bundle: AirRESTReportBundle = {
    format: AIRREST_REPORT_BUNDLE_FORMAT,
    version: 1,
    reportKind: 'functional',
    exportedAt: new Date().toISOString(),
    generator: 'AirREST',
    sanitized: true,
    sourceMeta,
    report: sanitizedReport,
  };
  return JSON.stringify(bundle, null, 2);
}

function isLikelyPostmanDocument(parsed: Record<string, unknown>): boolean {
  if (parsed._postman_variable_scope === 'environment') return true;
  if (
    parsed.environment &&
    typeof parsed.environment === 'object' &&
    !Array.isArray(parsed.environment) &&
    Array.isArray((parsed.environment as Record<string, unknown>).values)
  ) {
    return true;
  }
  const info = parsed.info;
  if (info && typeof info === 'object' && !Array.isArray(info)) {
    const infoObj = info as Record<string, unknown>;
    if (
      (typeof infoObj.schema === 'string' && infoObj.schema.toLowerCase().includes('collection')) ||
      typeof infoObj._postman_id === 'string' ||
      (typeof infoObj.name === 'string' && Array.isArray(parsed.item))
    ) {
      return true;
    }
  }
  if (Array.isArray(parsed.item)) return true;
  if (Array.isArray(parsed.values) && (typeof parsed.name === 'string' || typeof parsed.id === 'string')) {
    return true;
  }
  return false;
}

function isValidFunctionalReportShape(candidate: Record<string, unknown>): boolean {
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.startedAt === 'number' &&
    typeof candidate.plannedIterations === 'number' &&
    Array.isArray(candidate.steps) &&
    Boolean(candidate.config && typeof candidate.config === 'object')
  );
}

function normalizeSourceMetaFromParsed(
  report: Pick<
    PerformanceRunReport | FunctionalRunReport,
    'sourceType' | 'sourceId' | 'title' | 'sourceCollectionId' | 'sourceCollectionName' | 'sourceName'
  >,
  rawMeta?: unknown
): AirRESTReportSourceMeta {
  const m =
    rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta)
      ? (rawMeta as Record<string, unknown>)
      : {};
  const validType =
    m.sourceType === 'collection' || m.sourceType === 'folder' || m.sourceType === 'request'
      ? m.sourceType
      : report.sourceType === 'folder' || report.sourceType === 'request'
        ? report.sourceType
        : 'collection';
  const sourceId = typeof m.sourceId === 'string' && m.sourceId ? m.sourceId : report.sourceId || '';
  const sourceCollectionId =
    typeof m.sourceCollectionId === 'string' && m.sourceCollectionId
      ? m.sourceCollectionId
      : report.sourceCollectionId;
  const sourceCollectionName =
    typeof m.sourceCollectionName === 'string' && m.sourceCollectionName
      ? m.sourceCollectionName
      : report.sourceCollectionName;
  const fallbackName = report.title.replace(/\s+—\s+(Performance|Runner)$/i, '').trim() || report.title;
  const sourceName =
    typeof m.sourceName === 'string' && m.sourceName
      ? m.sourceName
      : report.sourceName || fallbackName;

  return {
    sourceType: validType,
    sourceId,
    ...(sourceCollectionId ? { sourceCollectionId } : {}),
    ...(sourceCollectionName ? { sourceCollectionName } : {}),
    sourceName,
  };
}

export interface ParsedShareableReportResult {
  kind?: ReportKind;
  perfReport?: PerformanceRunReport;
  funcReport?: FunctionalRunReport;
  sourceMeta?: AirRESTReportSourceMeta;
  error?: string;
}

export function parseShareableReportJson(content: string): ParsedShareableReportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      error: `Invalid JSON report file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'Report file must contain a JSON object.' };
  }

  const root = parsed as Record<string, unknown>;

  if (root.format !== AIRREST_REPORT_BUNDLE_FORMAT && isLikelyPostmanDocument(root)) {
    return {
      error: 'Selected file is a Postman Collection or Environment, not an AirREST Report.',
    };
  }

  // Case 1: Standardized AirRESTReportBundle v1
  if (root.format === AIRREST_REPORT_BUNDLE_FORMAT) {
    const inner = root.report;
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
      return { error: 'AirREST report bundle is missing its "report" payload.' };
    }
    const innerObj = inner as Record<string, unknown>;
    if (root.reportKind === 'functional') {
      if (!isValidFunctionalReportShape(innerObj)) {
        return { error: 'Functional report bundle is missing required fields.' };
      }
      const funcReport = innerObj as unknown as FunctionalRunReport;
      const sourceMeta = normalizeSourceMetaFromParsed(funcReport, root.sourceMeta);
      return { kind: 'functional', funcReport, sourceMeta };
    }
    if (root.reportKind === 'performance') {
      const perfCheck = parseImportedPerformanceReport(JSON.stringify(innerObj));
      if (!perfCheck.report) {
        return { error: perfCheck.error || 'Performance report bundle is invalid.' };
      }
      const sourceMeta = normalizeSourceMetaFromParsed(perfCheck.report, root.sourceMeta);
      return { kind: 'performance', perfReport: perfCheck.report, sourceMeta };
    }
    return { error: `Unsupported AirREST report kind "${String(root.reportKind)}".` };
  }

  // Case 2: Backwards-compatible raw/envelope Performance or Functional report JSON
  const candidate = (
    root.report && typeof root.report === 'object' && !Array.isArray(root.report) ? root.report : root
  ) as Record<string, unknown>;

  if (isValidFunctionalReportShape(candidate)) {
    const funcReport = candidate as unknown as FunctionalRunReport;
    const sourceMeta = normalizeSourceMetaFromParsed(funcReport);
    return { kind: 'functional', funcReport, sourceMeta };
  }

  const perfRes = parseImportedPerformanceReport(content);
  if (perfRes.report) {
    const sourceMeta = normalizeSourceMetaFromParsed(perfRes.report);
    return { kind: 'performance', perfReport: perfRes.report, sourceMeta };
  }

  return {
    error: 'Unrecognized JSON structure. Expected an AirREST .airrest-report.json or exported report JSON.',
  };
}

/**
 * Strictly checks raw pasted text for global Ctrl+V / Cmd+V support without false positives on normal API payloads.
 */
export function isStrictAirrestReportJson(rawText: string): boolean {
  if (typeof rawText !== 'string') return false;
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    if (parsed.format === AIRREST_REPORT_BUNDLE_FORMAT) {
      return parseShareableReportJson(trimmed).kind !== undefined;
    }
    return false;
  } catch {
    return false;
  }
}

interface MatchedItemLocation {
  collection: Collection;
  item: CollectionItem;
}

function findNestedItemById(
  items: CollectionItem[],
  targetId: string,
  collectionId: string
): { item: CollectionItem; collectionId: string } | null {
  for (const item of items) {
    if (item.id === targetId || item.request?.id === targetId) {
      return { item, collectionId };
    }
    if (item.type === 'folder' && item.items?.length) {
      const nested = findNestedItemById(item.items, targetId, collectionId);
      if (nested) return nested;
    }
  }
  return null;
}

function findNestedItemByName(
  items: CollectionItem[],
  targetNameNormalized: string,
  expectedType: 'folder' | 'request'
): CollectionItem | null {
  for (const item of items) {
    const matchesType =
      expectedType === 'folder' ? item.type === 'folder' : item.type === 'request';
    if (matchesType && normalizeName(item.name) === targetNameNormalized) {
      return item;
    }
    if (item.type === 'folder' && item.items?.length) {
      const nested = findNestedItemByName(item.items, targetNameNormalized, expectedType);
      if (nested) return nested;
    }
  }
  return null;
}

export function findPartialCollectionCandidate(
  sourceMeta: AirRESTReportSourceMeta,
  collections: Collection[]
): Collection | null {
  if (sourceMeta.sourceType === 'collection') return null;

  if (sourceMeta.sourceCollectionId) {
    const byColId = collections.find((c) => c.id === sourceMeta.sourceCollectionId);
    if (byColId) return byColId.isPartial ? byColId : null;
  }

  const colNameNorm = normalizeName(sourceMeta.sourceCollectionName);
  if (colNameNorm) {
    const byColName = collections.find((c) => normalizeName(c.name) === colNameNorm);
    if (byColName?.isPartial) return byColName;
  }

  return null;
}

export type ReportSourceResolution =
  | {
      tier: 'exact_id';
      targetType: 'collection' | 'folder' | 'request';
      targetId: string;
      targetCollection: Collection;
      targetItem?: CollectionItem;
      displayLabel: string;
    }
  | {
      tier: 'name_match';
      targetType: 'collection' | 'folder' | 'request';
      targetId: string;
      targetCollection: Collection;
      targetItem?: CollectionItem;
      displayLabel: string;
    }
  | {
      tier: 'unmatched';
      reason: string;
    };

export function resolveReportSourceTarget(
  sourceMeta: AirRESTReportSourceMeta,
  collections: Collection[]
): ReportSourceResolution {
  // Tier 1: Exact sourceId match
  if (sourceMeta.sourceId) {
    for (const col of collections || []) {
      if (sourceMeta.sourceType === 'collection' && col.id === sourceMeta.sourceId) {
        return {
          tier: 'exact_id',
          targetType: 'collection',
          targetId: col.id,
          targetCollection: col,
          displayLabel: col.name,
        };
      }
      const nested = findNestedItemById(col.items || [], sourceMeta.sourceId, col.id);
      if (nested) {
        return {
          tier: 'exact_id',
          targetType: nested.item.type === 'folder' ? 'folder' : 'request',
          targetId: nested.item.id,
          targetCollection: col,
          targetItem: nested.item,
          displayLabel: `${col.name} / ${nested.item.name}`,
        };
      }
    }
  }

  // Tier 2: Name match fallback when IDs differ (e.g., Postman Import as Copy or offline clones)
  const sourceNameNorm = normalizeName(sourceMeta.sourceName);
  const colNameNorm = normalizeName(sourceMeta.sourceCollectionName);

  if (sourceMeta.sourceType === 'collection') {
    const targetNameNorm = colNameNorm || sourceNameNorm;
    if (targetNameNorm) {
      const colMatch = (collections || []).find((c) => normalizeName(c.name) === targetNameNorm);
      if (colMatch) {
        return {
          tier: 'name_match',
          targetType: 'collection',
          targetId: colMatch.id,
          targetCollection: colMatch,
          displayLabel: colMatch.name,
        };
      }
    }
  } else if (sourceNameNorm) {
    const expectedType = sourceMeta.sourceType === 'folder' ? 'folder' : 'request';
    const candidateCols = colNameNorm
      ? (collections || []).filter((c) => normalizeName(c.name) === colNameNorm)
      : collections || [];

    const matches: MatchedItemLocation[] = [];
    for (const col of candidateCols) {
      const matched = findNestedItemByName(col.items || [], sourceNameNorm, expectedType);
      if (matched) matches.push({ collection: col, item: matched });
    }
    if (matches.length === 1 || (matches.length > 1 && colNameNorm)) {
      const chosen = matches[0];
      return {
        tier: 'name_match',
        targetType: expectedType,
        targetId: chosen.item.id,
        targetCollection: chosen.collection,
        targetItem: chosen.item,
        displayLabel: `${chosen.collection.name} / ${chosen.item.name}`,
      };
    }
  }

  // Tier 3: Unmatched -> session-only read-only
  const label = sourceMeta.sourceCollectionName
    ? `"${sourceMeta.sourceCollectionName}" (${sourceMeta.sourceName})`
    : `"${sourceMeta.sourceName || sourceMeta.sourceId}"`;
  return {
    tier: 'unmatched',
    reason: `Target ${sourceMeta.sourceType} ${label} was not found in the active workspace.`,
  };
}

export function bindImportedPerformanceReport(
  report: PerformanceRunReport,
  target:
    | {
        mode: 'attached';
        targetType: 'collection' | 'folder' | 'request';
        targetId: string;
        targetCollection: Collection;
        targetName: string;
      }
    | { mode: 'session_only' },
  options?: { filename?: string; forceNewId?: boolean }
): PerformanceRunReport {
  const nextId = options?.forceNewId ? makeUniqueReportId() : report.id;
  if (target.mode === 'attached') {
    return {
      ...report,
      id: nextId,
      sourceType: target.targetType,
      sourceId: target.targetId,
      sourceCollectionId: target.targetCollection.id,
      sourceCollectionName: target.targetCollection.name,
      sourceName: target.targetName,
      tabId: makePerformanceTabId(target.targetType, target.targetId),
      imported: true,
      importedAt: Date.now(),
      ...(options?.filename ? { importedFilename: options.filename } : {}),
    };
  }
  return {
    ...report,
    id: nextId,
    tabId: makePerformanceTabId('imported', nextId),
    imported: true,
    importedAt: Date.now(),
    ...(options?.filename ? { importedFilename: options.filename } : {}),
  };
}

export function bindImportedFunctionalReport(
  report: FunctionalRunReport,
  target:
    | {
        mode: 'attached';
        targetType: 'collection' | 'folder' | 'request';
        targetId: string;
        targetCollection: Collection;
        targetName: string;
      }
    | { mode: 'session_only' },
  options?: { filename?: string; forceNewId?: boolean }
): FunctionalRunReport {
  const nextId = options?.forceNewId ? makeUniqueReportId() : report.id;
  if (target.mode === 'attached') {
    return {
      ...report,
      id: nextId,
      sourceType: target.targetType,
      sourceId: target.targetId,
      sourceCollectionId: target.targetCollection.id,
      sourceCollectionName: target.targetCollection.name,
      sourceName: target.targetName,
      imported: true,
      importedAt: Date.now(),
      ...(options?.filename ? { importedFilename: options.filename } : {}),
      steps: (report.steps || []).map((s) => ({ ...s, hasCapturedExchange: false })),
    };
  }
  return {
    ...report,
    id: nextId,
    imported: true,
    importedAt: Date.now(),
    ...(options?.filename ? { importedFilename: options.filename } : {}),
    steps: (report.steps || []).map((s) => ({ ...s, hasCapturedExchange: false })),
  };
}
