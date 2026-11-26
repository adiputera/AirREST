import type {
  PerformanceEndpointBreakdown,
  PerformanceRunReport,
  PerformanceTimeBucket,
} from '../types/api';
import { computePeakRpsMetrics } from './perfMetrics';

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
  let maxSec = 0;

  (current.timeSeries || []).forEach((b, idx) => {
    const sec = typeof b.second === 'number' && b.second >= 0 ? b.second : idx;
    curBySec.set(sec, b);
    if (sec > maxSec) maxSec = sec;
  });

  (baseline.timeSeries || []).forEach((b, idx) => {
    const sec = typeof b.second === 'number' && b.second >= 0 ? b.second : idx;
    baseBySec.set(sec, b);
    if (sec > maxSec) maxSec = sec;
  });

  const alignedSeconds: AlignedTimeSeriesComparisonPoint[] = [];
  if (curBySec.size > 0 || baseBySec.size > 0) {
    for (let s = 0; s <= maxSec; s++) {
      const cb = curBySec.get(s);
      const bb = baseBySec.get(s);
      if (cb || bb) {
        alignedSeconds.push({ second: s, currentBucket: cb, baselineBucket: bb });
      }
    }
  }

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

    const curMaxRps = curPeak.byRequestMaxRps[curEp.requestId] ?? curEp.maxRequestsPerSec ?? 0;

    if (baseEp) {
      usedBaselineIds.add(baseEp.requestId);
      const baseMaxRps = basePeak.byRequestMaxRps[baseEp.requestId] ?? baseEp.maxRequestsPerSec ?? 0;
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
    const baseMaxRps = basePeak.byRequestMaxRps[baseEp.requestId] ?? baseEp.maxRequestsPerSec ?? 0;
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

/**
 * Parses and validates an exported JSON baseline report (supports both `{ report: ... }` envelope and bare report objects).
 */
export function parseImportedPerformanceReport(content: string): {
  report?: PerformanceRunReport;
  error?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
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
    typeof candidate.title !== 'string' ||
    typeof candidate.startedAt !== 'number' ||
    !candidate.summary ||
    typeof candidate.summary !== 'object' ||
    !Array.isArray(candidate.timeSeries) ||
    !Array.isArray(candidate.endpoints)
  ) {
    return {
      error: 'Selected JSON is missing required PerformanceRunReport fields (id, title, startedAt, summary, timeSeries, endpoints).',
    };
  }

  const normalized = candidate as unknown as PerformanceRunReport;
  if (!normalized.configSnapshot || !normalized.configSnapshot.loadProfile) {
    return { error: 'Selected JSON report is missing load profile configuration metadata.' };
  }

  return { report: normalized };
}
