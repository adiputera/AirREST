import type {
  Collection,
  CollectionItem,
  FunctionalRunReport,
  FunctionalStepResult,
  PerformanceRunReport,
} from '../types/api';
import { makePerformanceTabId, sanitizeJsonValue } from './examples';
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
  'pass',
  'code',
  'oauth_code',
  'auth_code',
  'access_code',
  'cookie',
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

function isSensitiveParamKey(normalizedKey: string): boolean {
  if (SENSITIVE_QUERY_KEYS.has(normalizedKey)) return true;
  return /(?:^|[_-])(token|secret|password|passwd|pwd|cookie|oauth[_-]?code|auth[_-]?code|access[_-]?code|api[_-]?key|auth|signature|sig|session|jwt|bearer|credential|private[_-]?key)(?:$|[_-])/i.test(
    normalizedKey
  ) || /[_-]pass$/i.test(normalizedKey);
}

function redactQueryStringParams(queryPartRaw: string): string {
  if (!queryPartRaw) return queryPartRaw;
  return queryPartRaw
    .split('&')
    .map((pair) => {
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
      if (isSensitiveParamKey(normalizedKey)) {
        return `${rawKey}=[REDACTED]`;
      }
      return pair;
    })
    .join('&');
}

/**
 * Redacts embedded authority credentials (user:pass@host) and sensitive query/fragment parameter values
 * while keeping non-sensitive params and {{template}} placeholders intact.
 */
export function sanitizeUrlSecrets(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  const trimmed = rawUrl.trim();

  const hashIdx = trimmed.indexOf('#');
  const hashRaw = hashIdx >= 0 ? trimmed.slice(hashIdx) : '';
  const withoutHash = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;

  const qIdx = withoutHash.indexOf('?');
  const basePartRaw = qIdx >= 0 ? withoutHash.slice(0, qIdx) : withoutHash;
  const queryPartRaw = qIdx >= 0 ? withoutHash.slice(qIdx + 1) : '';

  // Redact user:pass@ up to the last '@' inside the URL authority (before path/query/fragment)
  const basePart = basePartRaw.replace(
    /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]+)(?=[/?#]|$)/,
    (_full, scheme: string, authority: string) => {
      const atIdx = authority.lastIndexOf('@');
      if (atIdx < 0) return `${scheme}${authority}`;
      return `${scheme}[REDACTED]@${authority.slice(atIdx + 1)}`;
    }
  );

  let sanitizedHash = hashRaw;
  if (hashRaw.length > 1 && hashRaw.includes('=')) {
    const hashBody = hashRaw.slice(1);
    const hashQIdx = hashBody.indexOf('?');
    if (hashQIdx >= 0) {
      sanitizedHash = `#${hashBody.slice(0, hashQIdx + 1)}${redactQueryStringParams(hashBody.slice(hashQIdx + 1))}`;
    } else {
      sanitizedHash = `#${redactQueryStringParams(hashBody)}`;
    }
  }

  if (!queryPartRaw) {
    return basePart + sanitizedHash;
  }

  return `${basePart}?${redactQueryStringParams(queryPartRaw)}${sanitizedHash}`;
}

export function redactInlineSecrets(text: string | undefined): string | undefined {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]')
    .replace(
      /("(?:access_token|refresh_token|id_token|client_secret|api_key|apikey|password|secret|authorization|x-api-key)"\s*:\s*")([^"]*)(")/gi,
      '$1[REDACTED]$3'
    )
    .replace(
      /(https?:\/\/[^\s"'`<>]+)/gi,
      (matchedUrl) => sanitizeUrlSecrets(matchedUrl)
    );
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
  let sourceName =
    report.sourceName || report.title.replace(/\s+—\s+(Performance|Runner)$/i, '').trim() || report.title;

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

export function fallbackReportSourceMeta(
  report: Pick<
    PerformanceRunReport | FunctionalRunReport,
    'sourceType' | 'sourceId' | 'title' | 'sourceCollectionId' | 'sourceCollectionName' | 'sourceName'
  >
): AirRESTReportSourceMeta {
  const sourceType =
    report.sourceType === 'folder' || report.sourceType === 'request' ? report.sourceType : 'collection';
  const fallbackName = report.title.replace(/\s+—\s+(Performance|Runner)$/i, '').trim() || report.title;
  return {
    sourceType,
    sourceId: report.sourceId || '',
    ...(report.sourceCollectionId ? { sourceCollectionId: report.sourceCollectionId } : {}),
    ...(report.sourceCollectionName ? { sourceCollectionName: report.sourceCollectionName } : {}),
    sourceName: report.sourceName || fallbackName,
  };
}

export function sanitizePerformanceReportForShare(
  report: PerformanceRunReport,
  sourceMeta: AirRESTReportSourceMeta = fallbackReportSourceMeta(report)
): PerformanceRunReport {
  return {
    ...report,
    title: redactInlineSecrets(report.title) || report.title,
    sourceType: sourceMeta.sourceType,
    sourceId: sourceMeta.sourceId,
    ...(sourceMeta.sourceCollectionId ? { sourceCollectionId: sourceMeta.sourceCollectionId } : {}),
    ...(sourceMeta.sourceCollectionName ? { sourceCollectionName: sourceMeta.sourceCollectionName } : {}),
    sourceName: redactInlineSecrets(sourceMeta.sourceName) || sourceMeta.sourceName,
    ...(report.failureReason ? { failureReason: redactInlineSecrets(report.failureReason) } : {}),
    endpoints: (report.endpoints || []).map((ep) => ({
      ...ep,
      path: sanitizeUrlSecrets(ep.path),
    })),
    setupResults: (report.setupResults || []).map((s) => ({
      ...s,
      url: sanitizeUrlSecrets(s.url),
      ...(s.error ? { error: redactInlineSecrets(s.error) } : {}),
    })),
    errorSamples: (report.errorSamples || []).map((sample) => ({
      ...sample,
      url: sanitizeUrlSecrets(sample.url),
      message: redactInlineSecrets(sample.message) || sample.message,
      ...(sample.responseSnippet ? { responseSnippet: redactInlineSecrets(sample.responseSnippet) } : {}),
    })),
    warnings: (report.warnings || []).map((w) => redactInlineSecrets(w) || w),
  };
}

export function sanitizeFunctionalReportForShare(
  report: FunctionalRunReport,
  sourceMeta: AirRESTReportSourceMeta = fallbackReportSourceMeta(report)
): FunctionalRunReport {
  return {
    ...report,
    title: redactInlineSecrets(report.title) || report.title,
    sourceType: sourceMeta.sourceType,
    sourceId: sourceMeta.sourceId,
    ...(sourceMeta.sourceCollectionId ? { sourceCollectionId: sourceMeta.sourceCollectionId } : {}),
    ...(sourceMeta.sourceCollectionName ? { sourceCollectionName: sourceMeta.sourceCollectionName } : {}),
    sourceName: redactInlineSecrets(sourceMeta.sourceName) || sourceMeta.sourceName,
    steps: (report.steps || []).map((step) => ({
      ...step,
      url: sanitizeUrlSecrets(step.url),
      hasCapturedExchange: false,
      ...(step.errorMessage ? { errorMessage: redactInlineSecrets(step.errorMessage) } : {}),
      ...(step.warningMessage ? { warningMessage: redactInlineSecrets(step.warningMessage) } : {}),
      ...(step.scriptError ? { scriptError: redactInlineSecrets(step.scriptError) } : {}),
      testResults: (step.testResults || []).map((t) => ({
        ...t,
        ...(t.error ? { error: redactInlineSecrets(t.error) } : {}),
      })),
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

const MAX_FUNCTIONAL_IMPORT_STEPS = 5000;
const MAX_FUNCTIONAL_IMPORT_TESTS = 200;
const MAX_REPORT_CLOCK_SKEW_MS = 86_400_000;

function toFiniteNonNeg(val: unknown, fallback = 0): number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0 ? val : fallback;
}

function normalizeImportedFunctionalReport(raw: Record<string, unknown>): FunctionalRunReport {
  const maxTs = Date.now() + MAX_REPORT_CLOCK_SKEW_MS;
  const startedAt = Math.min(Math.max(0, toFiniteNonNeg(raw.startedAt)), maxTs);
  const finishedAt =
    typeof raw.finishedAt === 'number' && Number.isFinite(raw.finishedAt)
      ? Math.min(Math.max(startedAt, raw.finishedAt), maxTs)
      : undefined;
  const rawSteps = Array.isArray(raw.steps) ? raw.steps.slice(0, MAX_FUNCTIONAL_IMPORT_STEPS) : [];
  const steps: FunctionalStepResult[] = rawSteps.map((s, idx) => {
    const step = (s && typeof s === 'object' && !Array.isArray(s) ? s : {}) as Record<string, unknown>;
    const rawTests = Array.isArray(step.testResults) ? step.testResults.slice(0, MAX_FUNCTIONAL_IMPORT_TESTS) : [];
    const status =
      step.status === 'passed' ||
        step.status === 'warning' ||
        step.status === 'failed' ||
        step.status === 'error' ||
        step.status === 'skipped'
        ? step.status
        : 'failed';
    const method = typeof step.method === 'string' && step.method ? step.method.toUpperCase() : 'GET';
    return {
      id: typeof step.id === 'string' && step.id ? step.id : `step_${idx}`,
      iteration: Math.max(1, Math.trunc(toFiniteNonNeg(step.iteration, 1))),
      stepIndex: Math.trunc(toFiniteNonNeg(step.stepIndex, idx)),
      itemId: typeof step.itemId === 'string' ? step.itemId : '',
      name: typeof step.name === 'string' ? step.name : `Step ${idx + 1}`,
      method: method as FunctionalStepResult['method'],
      url: typeof step.url === 'string' ? sanitizeUrlSecrets(step.url) : '',
      status,
      httpStatus: Math.trunc(toFiniteNonNeg(step.httpStatus)),
      statusText: typeof step.statusText === 'string' ? step.statusText : '',
      timeMs: toFiniteNonNeg(step.timeMs),
      sizeBytes: toFiniteNonNeg(step.sizeBytes),
      testResults: rawTests.map((t, tIdx) => {
        const test = (t && typeof t === 'object' && !Array.isArray(t) ? t : {}) as Record<string, unknown>;
        return {
          name: typeof test.name === 'string' ? test.name : `Test ${tIdx + 1}`,
          passed: Boolean(test.passed),
          ...(typeof test.error === 'string' ? { error: redactInlineSecrets(test.error) } : {}),
          ...(typeof test.durationMs === 'number' && Number.isFinite(test.durationMs)
            ? { durationMs: Math.max(0, test.durationMs) }
            : {}),
        };
      }),
      testsPassed: Math.trunc(toFiniteNonNeg(step.testsPassed)),
      testsFailed: Math.trunc(toFiniteNonNeg(step.testsFailed)),
      ...(typeof step.errorMessage === 'string' ? { errorMessage: redactInlineSecrets(step.errorMessage) } : {}),
      ...(typeof step.warningMessage === 'string' ? { warningMessage: redactInlineSecrets(step.warningMessage) } : {}),
      ...(typeof step.scriptError === 'string' ? { scriptError: redactInlineSecrets(step.scriptError) } : {}),
      hasCapturedExchange: false,
      timestamp: Math.min(Math.max(0, toFiniteNonNeg(step.timestamp, startedAt)), maxTs),
    };
  });

  const failedItemIds = Array.isArray(raw.failedItemIds)
    ? raw.failedItemIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_FUNCTIONAL_IMPORT_STEPS)
    : [];
  const failedIterations = Array.isArray(raw.failedIterations)
    ? raw.failedIterations
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 1)
        .map((n) => Math.trunc(n))
        .slice(0, MAX_FUNCTIONAL_IMPORT_STEPS)
    : undefined;

  const base = raw as unknown as FunctionalRunReport;
  return {
    ...base,
    startedAt,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    durationMs: toFiniteNonNeg(raw.durationMs),
    plannedIterations: Math.max(1, Math.trunc(toFiniteNonNeg(raw.plannedIterations, 1))),
    completedIterations: Math.trunc(toFiniteNonNeg(raw.completedIterations)),
    totalRequestsExecuted: Math.trunc(toFiniteNonNeg(raw.totalRequestsExecuted)),
    requestsPassed: Math.trunc(toFiniteNonNeg(raw.requestsPassed)),
    requestsFailed: Math.trunc(toFiniteNonNeg(raw.requestsFailed)),
    requestsErrored: Math.trunc(toFiniteNonNeg(raw.requestsErrored)),
    requestsSkipped: Math.trunc(toFiniteNonNeg(raw.requestsSkipped)),
    totalTests: Math.trunc(toFiniteNonNeg(raw.totalTests)),
    testsPassed: Math.trunc(toFiniteNonNeg(raw.testsPassed)),
    testsFailed: Math.trunc(toFiniteNonNeg(raw.testsFailed)),
    avgResponseTimeMs: toFiniteNonNeg(raw.avgResponseTimeMs),
    steps,
    failedItemIds,
    ...(failedIterations !== undefined ? { failedIterations } : {}),
  };
}

function isValidFunctionalReportShape(candidate: Record<string, unknown>): boolean {
  return (
    typeof candidate.id === 'string' &&
    Boolean(candidate.id.trim()) &&
    typeof candidate.title === 'string' &&
    typeof candidate.startedAt === 'number' &&
    Number.isFinite(candidate.startedAt) &&
    typeof candidate.plannedIterations === 'number' &&
    Number.isFinite(candidate.plannedIterations) &&
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

const MAX_SHAREABLE_REPORT_BYTES = 16 * 1024 * 1024; // 16 MiB

function measureUtf8Bytes(text: string): number {
  if (typeof TextEncoder === 'function') {
    return new TextEncoder().encode(text).byteLength;
  }
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

export function parseShareableReportJson(content: string): ParsedShareableReportResult {
  if (typeof content !== 'string') {
    return { error: 'Report content must be text.' };
  }
  const utf8Bytes = measureUtf8Bytes(content);
  if (utf8Bytes > MAX_SHAREABLE_REPORT_BYTES) {
    return {
      error: 'Report file exceeds maximum allowed limit of 16 MB.',
    };
  }
  let parsed: unknown;
  try {
    parsed = sanitizeJsonValue(JSON.parse(content));
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
      const funcReport = normalizeImportedFunctionalReport(innerObj);
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
    const funcReport = normalizeImportedFunctionalReport(candidate);
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
      tabId: makePerformanceTabId(target.targetType, target.targetId),
      imported: true,
      importedAt: Date.now(),
      ...(options?.filename ? { importedFilename: options.filename } : {}),
      steps: (report.steps || []).map((s) => ({ ...s, hasCapturedExchange: false })),
    };
  }
  return {
    ...report,
    id: nextId,
    tabId: makePerformanceTabId('imported', nextId),
    imported: true,
    importedAt: Date.now(),
    ...(options?.filename ? { importedFilename: options.filename } : {}),
    steps: (report.steps || []).map((s) => ({ ...s, hasCapturedExchange: false })),
  };
}
