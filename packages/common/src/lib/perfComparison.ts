import type {
  PerformanceEndpointBreakdown,
  PerformanceErrorSample,
  PerformanceMetricSnapshot,
  PerformanceRunReport,
  PerformanceTimeBucket,
} from '../types/api';
import { sanitizeJsonValue } from './examples';
import { computePeakRpsMetrics } from './perfMetrics';

const MAX_TIME_SERIES_SECONDS = 7200;
const MAX_IMPORTED_ENDPOINTS = 1000;
const MAX_IMPORTED_ERROR_SAMPLES = 50;
const MAX_CLOCK_SKEW_MS = 86_400_000;

function toFiniteNonNegative(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeHttpMethod(value: unknown): PerformanceEndpointBreakdown['method'] {
  if (typeof value === 'string') {
    const upper = value.toUpperCase();
    if (
      upper === 'GET' ||
      upper === 'POST' ||
      upper === 'PUT' ||
      upper === 'PATCH' ||
      upper === 'DELETE' ||
      upper === 'HEAD' ||
      upper === 'OPTIONS'
    ) {
      return upper;
    }
  }
  return 'GET';
}

function clampBucketSecond(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Math.min(MAX_TIME_SERIES_SECONDS, Math.max(0, Math.trunc(fallback)));
  }
  return Math.min(MAX_TIME_SERIES_SECONDS, Math.max(0, Math.trunc(value)));
}

export type DeltaDirection = 'improved' | 'regressed' | 'neutral';

export interface MetricDelta {
  current: number;
  baseline: number;
  absDelta: number;
  pctDelta: number | null;
  direction: DeltaDirection;
}

export interface AlignedTimeSeriesComparisonPoint {
  second: number;
  currentBucket?: PerformanceTimeBucket;
  baselineBucket?: PerformanceTimeBucket;
}

export interface EndpointComparisonRow {
  key: string;
  matchStatus: 'matched' | 'new' | 'removed';
  current?: PerformanceEndpointBreakdown;
  baseline?: PerformanceEndpointBreakdown;
  currentMaxRps: number;
  baselineMaxRps: number;
  deltas?: {
    totalRequests: MetricDelta;
    requestsPerSec: MetricDelta;
    maxRequestsPerSec: MetricDelta;
    errorRatePct: MetricDelta;
    avgMs: MetricDelta;
    p90Ms: MetricDelta;
    p95Ms: MetricDelta;
    p99Ms: MetricDelta;
  };
}

export interface PerformanceComparisonSummary {
  kpis: {
    totalRequests: MetricDelta;
    requestsPerSec: MetricDelta;
    maxRequestsPerSec: MetricDelta;
    avgMs: MetricDelta;
    p90Ms: MetricDelta;
    p95Ms: MetricDelta;
    p99Ms: MetricDelta;
    errorRatePct: MetricDelta;
  };
  alignedSeconds: AlignedTimeSeriesComparisonPoint[];
  endpoints: EndpointComparisonRow[];
}

export function computeMetricDelta(
  current: number,
  baseline: number,
  polarity: 'higher-better' | 'lower-better' | 'neutral'
): MetricDelta {
  const absDelta = current - baseline;
  const pctDelta =
    baseline !== 0 ? Number((((current - baseline) / Math.abs(baseline)) * 100).toFixed(1)) : null;

  let direction: DeltaDirection = 'neutral';
  if (Math.abs(absDelta) > 1e-6 && polarity !== 'neutral') {
    if (polarity === 'higher-better') {
      direction = absDelta > 0 ? 'improved' : 'regressed';
    } else {
      direction = absDelta < 0 ? 'improved' : 'regressed';
    }
  }

  return {
    current,
    baseline,
    absDelta,
    pctDelta,
    direction,
  };
}

export function formatDeltaCompact(delta: MetricDelta, decimals = 0, unit = ''): string {
  const sign = delta.absDelta > 0 ? '+' : '';
  const numStr = decimals > 0 ? delta.absDelta.toFixed(decimals) : Math.round(delta.absDelta).toLocaleString();
  const unitSuffix = unit ? ` ${unit}` : '';
  const pctStr =
    delta.pctDelta !== null
      ? ` (${delta.pctDelta > 0 ? '+' : ''}${delta.pctDelta.toFixed(1)}%)`
      : '';
  return `${sign}${numStr}${unitSuffix}${pctStr}`;
}

/**
 * Computes full KPI, time-series (aligned by elapsed second), and endpoint breakdown comparison
 * between a current run and a baseline run.
 */
export function computePerformanceComparison(
  current: PerformanceRunReport,
  baseline: PerformanceRunReport
): PerformanceComparisonSummary {
  const curPeak = computePeakRpsMetrics(current);
  const basePeak = computePeakRpsMetrics(baseline);

  const kpis = {
    totalRequests: computeMetricDelta(current.summary.totalRequests, baseline.summary.totalRequests, 'neutral'),
    requestsPerSec: computeMetricDelta(current.summary.requestsPerSec, baseline.summary.requestsPerSec, 'higher-better'),
    maxRequestsPerSec: computeMetricDelta(curPeak.overallMaxRps, basePeak.overallMaxRps, 'higher-better'),
    avgMs: computeMetricDelta(current.summary.avgMs, baseline.summary.avgMs, 'lower-better'),
    p90Ms: computeMetricDelta(current.summary.p90Ms, baseline.summary.p90Ms, 'lower-better'),
    p95Ms: computeMetricDelta(current.summary.p95Ms, baseline.summary.p95Ms, 'lower-better'),
    p99Ms: computeMetricDelta(current.summary.p99Ms, baseline.summary.p99Ms, 'lower-better'),
    errorRatePct: computeMetricDelta(current.summary.errorRatePct, baseline.summary.errorRatePct, 'lower-better'),
  };

  // Align time-series by relative elapsed second (`bucket.second`, or normalized index fallback)
  const curBySec = new Map<number, PerformanceTimeBucket>();
  const baseBySec = new Map<number, PerformanceTimeBucket>();

  (current.timeSeries || []).forEach((b, idx) => {
    const sec = clampBucketSecond(b?.second, idx);
    curBySec.set(sec, b);
  });

  (baseline.timeSeries || []).forEach((b, idx) => {
    const sec = clampBucketSecond(b?.second, idx);
    baseBySec.set(sec, b);
  });

  const sortedSeconds = Array.from(new Set<number>([...curBySec.keys(), ...baseBySec.keys()])).sort(
    (a, b) => a - b
  );
  const alignedSeconds: AlignedTimeSeriesComparisonPoint[] = sortedSeconds.map((s) => ({
    second: s,
    currentBucket: curBySec.get(s),
    baselineBucket: baseBySec.get(s),
  }));

  // Match endpoints by exact `requestId`, then fallback to `METHOD:normalized_name`
  const usedBaselineIds = new Set<string>();
  const baselineById = new Map<string, PerformanceEndpointBreakdown>();
  const baselineBySig = new Map<string, PerformanceEndpointBreakdown>();

  for (const ep of baseline.endpoints || []) {
    baselineById.set(ep.requestId, ep);
    const sig = `${ep.method.toUpperCase()}:${ep.name.trim().toLowerCase()}`;
    if (!baselineBySig.has(sig)) baselineBySig.set(sig, ep);
  }

  const endpoints: EndpointComparisonRow[] = [];

  for (const curEp of current.endpoints || []) {
    let baseEp = baselineById.get(curEp.requestId);
    if (baseEp && usedBaselineIds.has(baseEp.requestId)) {
      baseEp = undefined;
    }
    if (!baseEp) {
      const sig = `${curEp.method.toUpperCase()}:${curEp.name.trim().toLowerCase()}`;
      const cand = baselineBySig.get(sig);
      if (cand && !usedBaselineIds.has(cand.requestId)) {
        baseEp = cand;
      }
    }

    const curMaxRps =
      (Object.prototype.hasOwnProperty.call(curPeak.byRequestMaxRps, curEp.requestId)
        ? curPeak.byRequestMaxRps[curEp.requestId]
        : undefined) ??
      curEp.maxRequestsPerSec ??
      0;

    if (baseEp) {
      usedBaselineIds.add(baseEp.requestId);
      const baseMaxRps =
        (Object.prototype.hasOwnProperty.call(basePeak.byRequestMaxRps, baseEp.requestId)
          ? basePeak.byRequestMaxRps[baseEp.requestId]
          : undefined) ??
        baseEp.maxRequestsPerSec ??
        0;
      endpoints.push({
        key: curEp.requestId,
        matchStatus: 'matched',
        current: curEp,
        baseline: baseEp,
        currentMaxRps: curMaxRps,
        baselineMaxRps: baseMaxRps,
        deltas: {
          totalRequests: computeMetricDelta(curEp.totalRequests, baseEp.totalRequests, 'neutral'),
          requestsPerSec: computeMetricDelta(curEp.requestsPerSec, baseEp.requestsPerSec, 'higher-better'),
          maxRequestsPerSec: computeMetricDelta(curMaxRps, baseMaxRps, 'higher-better'),
          errorRatePct: computeMetricDelta(curEp.errorRatePct, baseEp.errorRatePct, 'lower-better'),
          avgMs: computeMetricDelta(curEp.avgMs, baseEp.avgMs, 'lower-better'),
          p90Ms: computeMetricDelta(curEp.p90Ms, baseEp.p90Ms, 'lower-better'),
          p95Ms: computeMetricDelta(curEp.p95Ms, baseEp.p95Ms, 'lower-better'),
          p99Ms: computeMetricDelta(curEp.p99Ms, baseEp.p99Ms, 'lower-better'),
        },
      });
    } else {
      endpoints.push({
        key: curEp.requestId,
        matchStatus: 'new',
        current: curEp,
        currentMaxRps: curMaxRps,
        baselineMaxRps: 0,
      });
    }
  }

  for (const baseEp of baseline.endpoints || []) {
    if (usedBaselineIds.has(baseEp.requestId)) continue;
    const baseMaxRps =
      (Object.prototype.hasOwnProperty.call(basePeak.byRequestMaxRps, baseEp.requestId)
        ? basePeak.byRequestMaxRps[baseEp.requestId]
        : undefined) ??
      baseEp.maxRequestsPerSec ??
      0;
    endpoints.push({
      key: `removed:${baseEp.requestId}`,
      matchStatus: 'removed',
      baseline: baseEp,
      currentMaxRps: 0,
      baselineMaxRps: baseMaxRps,
    });
  }

  return {
    kpis,
    alignedSeconds,
    endpoints,
  };
}

function normalizeImportedEndpoint(raw: unknown, index: number): PerformanceEndpointBreakdown {
  const ep = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name =
    typeof ep.name === 'string' && ep.name
      ? ep.name
      : typeof ep.requestName === 'string' && ep.requestName
        ? ep.requestName
        : `Request ${index + 1}`;
  return {
    requestId: typeof ep.requestId === 'string' && ep.requestId ? ep.requestId : `ep_${index}`,
    name,
    method: normalizeHttpMethod(ep.method),
    path: typeof ep.path === 'string' ? ep.path : '',
    totalRequests: toFiniteNonNegative(ep.totalRequests),
    errorCount: toFiniteNonNegative(ep.errorCount),
    ...(typeof ep.warningCount === 'number' && Number.isFinite(ep.warningCount) && ep.warningCount >= 0
      ? { warningCount: ep.warningCount }
      : {}),
    errorRatePct: toFiniteNonNegative(ep.errorRatePct),
    requestsPerSec: toFiniteNonNegative(ep.requestsPerSec),
    maxRequestsPerSec: toFiniteNonNegative(ep.maxRequestsPerSec),
    avgMs: toFiniteNonNegative(ep.avgMs),
    minMs: toFiniteNonNegative(ep.minMs),
    maxMs: toFiniteNonNegative(ep.maxMs),
    p90Ms: toFiniteNonNegative(ep.p90Ms),
    p95Ms: toFiniteNonNegative(ep.p95Ms),
    p99Ms: toFiniteNonNegative(ep.p99Ms),
    bytesReceived: toFiniteNonNegative(ep.bytesReceived),
  };
}

function normalizeImportedBucket(raw: unknown, index: number): PerformanceTimeBucket {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const byRequestRaw = b.byRequest && typeof b.byRequest === 'object' && !Array.isArray(b.byRequest)
    ? (b.byRequest as Record<string, unknown>)
    : undefined;
  let byRequest: PerformanceTimeBucket['byRequest'];
  if (byRequestRaw) {
    const cleanByRequest: NonNullable<PerformanceTimeBucket['byRequest']> = Object.create(null);
    for (const [k, v] of Object.entries(byRequestRaw)) {
      if (!v || typeof v !== 'object') continue;
      const m = v as Record<string, unknown>;
      cleanByRequest[k] = {
        totalRequests: toFiniteNonNegative(m.totalRequests),
        errorCount: toFiniteNonNegative(m.errorCount),
        errorRatePct: toFiniteNonNegative(m.errorRatePct),
        requestsPerSec: toFiniteNonNegative(m.requestsPerSec),
        avgMs: toFiniteNonNegative(m.avgMs),
        minMs: toFiniteNonNegative(m.minMs),
        maxMs: toFiniteNonNegative(m.maxMs),
        p90Ms: toFiniteNonNegative(m.p90Ms),
        p95Ms: toFiniteNonNegative(m.p95Ms),
        p99Ms: toFiniteNonNegative(m.p99Ms),
      };
    }
    byRequest = cleanByRequest;
  }

  return {
    second: clampBucketSecond(b.second, index),
    timestampMs: toFiniteNonNegative(b.timestampMs),
    virtualUsers: toFiniteNonNegative(b.virtualUsers),
    totalRequests: toFiniteNonNegative(b.totalRequests),
    errorCount: toFiniteNonNegative(b.errorCount),
    errorRatePct: toFiniteNonNegative(b.errorRatePct),
    requestsPerSec: toFiniteNonNegative(b.requestsPerSec),
    avgMs: toFiniteNonNegative(b.avgMs),
    minMs: toFiniteNonNegative(b.minMs),
    maxMs: toFiniteNonNegative(b.maxMs),
    p90Ms: toFiniteNonNegative(b.p90Ms),
    p95Ms: toFiniteNonNegative(b.p95Ms),
    p99Ms: toFiniteNonNegative(b.p99Ms),
    byRequest,
  };
}

function normalizeImportedErrorSample(raw: unknown, index: number): PerformanceErrorSample {
  const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    id: typeof e.id === 'string' && e.id ? e.id : `err_${index}`,
    timestampMs: toFiniteNonNegative(e.timestampMs),
    requestId: typeof e.requestId === 'string' ? e.requestId : '',
    requestName: typeof e.requestName === 'string' ? e.requestName : '',
    method: normalizeHttpMethod(e.method),
    url: typeof e.url === 'string' ? e.url : '',
    status: typeof e.status === 'number' && Number.isFinite(e.status) && e.status >= 0 ? e.status : 0,
    statusText: typeof e.statusText === 'string' ? e.statusText : '',
    category: typeof e.category === 'string' ? e.category : 'error',
    message: typeof e.message === 'string' ? e.message : 'Unknown error',
    ...(typeof e.responseSnippet === 'string' ? { responseSnippet: e.responseSnippet } : {}),
    timeMs: toFiniteNonNegative(e.timeMs),
  };
}

/**
 * Parses and validates an exported JSON baseline report (supports both `{ report: ... }` envelope and bare report objects).
 */
export function parseImportedPerformanceReport(content: string): {
  report?: PerformanceRunReport;
  error?: string;
} {
  let parsed: unknown;
  try {
    parsed = sanitizeJsonValue(JSON.parse(content));
  } catch (err) {
    return { error: `Invalid JSON report file: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'Baseline JSON must be an exported AirREST performance report object.' };
  }

  const root = parsed as Record<string, unknown>;
  const candidate = (
    root.report && typeof root.report === 'object' && !Array.isArray(root.report) ? root.report : root
  ) as Record<string, unknown>;

  if (
    typeof candidate.id !== 'string' ||
    !candidate.id.trim() ||
    typeof candidate.title !== 'string' ||
    typeof candidate.startedAt !== 'number' ||
    !Number.isFinite(candidate.startedAt) ||
    !candidate.summary ||
    typeof candidate.summary !== 'object' ||
    !Array.isArray(candidate.timeSeries) ||
    !Array.isArray(candidate.endpoints)
  ) {
    return {
      error: 'Selected JSON is missing required PerformanceRunReport fields (id, title, startedAt, summary, timeSeries, endpoints).',
    };
  }

  const rawReport = candidate as unknown as PerformanceRunReport;
  if (!rawReport.configSnapshot || !rawReport.configSnapshot.loadProfile) {
    return { error: 'Selected JSON report is missing load profile configuration metadata.' };
  }

  const maxStartedAt = Date.now() + MAX_CLOCK_SKEW_MS;
  const startedAt = Math.min(Math.max(0, candidate.startedAt), maxStartedAt);
  const rawFinishedAt = typeof candidate.finishedAt === 'number' && Number.isFinite(candidate.finishedAt)
    ? Math.min(Math.max(startedAt, candidate.finishedAt), maxStartedAt)
    : startedAt + toFiniteNonNegative(candidate.durationMs);

  const rawSummary = (candidate.summary || {}) as Record<string, unknown>;
  const summary: PerformanceMetricSnapshot = {
    totalRequests: toFiniteNonNegative(rawSummary.totalRequests),
    errorCount: toFiniteNonNegative(rawSummary.errorCount),
    ...(typeof rawSummary.warningCount === 'number' && Number.isFinite(rawSummary.warningCount) && rawSummary.warningCount >= 0
      ? { warningCount: rawSummary.warningCount }
      : {}),
    errorRatePct: toFiniteNonNegative(rawSummary.errorRatePct),
    requestsPerSec: toFiniteNonNegative(rawSummary.requestsPerSec),
    maxRequestsPerSec: toFiniteNonNegative(rawSummary.maxRequestsPerSec),
    avgMs: toFiniteNonNegative(rawSummary.avgMs),
    minMs: toFiniteNonNegative(rawSummary.minMs),
    maxMs: toFiniteNonNegative(rawSummary.maxMs),
    p90Ms: toFiniteNonNegative(rawSummary.p90Ms),
    p95Ms: toFiniteNonNegative(rawSummary.p95Ms),
    p99Ms: toFiniteNonNegative(rawSummary.p99Ms),
    bytesReceived: toFiniteNonNegative(rawSummary.bytesReceived),
  };
  const rawLoadProfile = rawReport.configSnapshot.loadProfile;

  const normalized: PerformanceRunReport = {
    ...rawReport,
    startedAt,
    finishedAt: rawFinishedAt,
    durationMs: toFiniteNonNegative(candidate.durationMs),
    summary,
    timeSeries: (candidate.timeSeries as unknown[])
      .slice(0, MAX_TIME_SERIES_SECONDS)
      .map((b, idx) => normalizeImportedBucket(b, idx)),
    endpoints: (candidate.endpoints as unknown[])
      .slice(0, MAX_IMPORTED_ENDPOINTS)
      .map((ep, idx) => normalizeImportedEndpoint(ep, idx)),
    errorGroups: Array.isArray(candidate.errorGroups) ? rawReport.errorGroups.slice(0, MAX_IMPORTED_ENDPOINTS) : [],
    errorSamples: Array.isArray(candidate.errorSamples)
      ? candidate.errorSamples.slice(0, MAX_IMPORTED_ERROR_SAMPLES).map((e, idx) => normalizeImportedErrorSample(e, idx))
      : [],
    warnings: Array.isArray(candidate.warnings)
      ? candidate.warnings.filter((w): w is string => typeof w === 'string').slice(0, 200)
      : [],
    configSnapshot: {
      ...rawReport.configSnapshot,
      loadProfile: {
        ...rawLoadProfile,
        virtualUsers: Math.min(10_000, Math.max(1, toFiniteNonNegative(rawLoadProfile.virtualUsers, 1))),
        durationValue: Math.min(86_400, Math.max(0, toFiniteNonNegative(rawLoadProfile.durationValue))),
      },
    },
  };

  return { report: normalized };
}
