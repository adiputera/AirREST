import type { PerformanceRunReport, PerformanceTimeBucket } from '../types/api';

export interface PeakRpsMetrics {
  overallMaxRps: number;
  overallPeakTimestampMs: number | null;
  byRequestMaxRps: Record<string, number>;
}

/**
 * Computes overall peak 1-second RPS (with its timestamp) and per-endpoint peak 1-second RPS
 * from time-series buckets, falling back to any precomputed fields on the report.
 */
export function computePeakRpsMetrics(
  report: Pick<PerformanceRunReport, 'summary' | 'timeSeries' | 'endpoints'>
): PeakRpsMetrics {
  let overallMaxRps = report.summary?.maxRequestsPerSec ?? 0;
  let overallPeakTimestampMs: number | null = null;
  const byRequestMaxRps: Record<string, number> = Object.create(null);

  for (const ep of report.endpoints || []) {
    if (typeof ep.maxRequestsPerSec === 'number' && ep.maxRequestsPerSec > 0) {
      byRequestMaxRps[ep.requestId] = ep.maxRequestsPerSec;
    }
  }

  const series: PerformanceTimeBucket[] = report.timeSeries || [];
  for (const bucket of series) {
    if (bucket.requestsPerSec > overallMaxRps) {
      overallMaxRps = bucket.requestsPerSec;
      overallPeakTimestampMs = bucket.timestampMs;
    } else if (
      bucket.requestsPerSec > 0 &&
      bucket.requestsPerSec === overallMaxRps &&
      overallPeakTimestampMs === null
    ) {
      overallPeakTimestampMs = bucket.timestampMs;
    }

    if (bucket.byRequest) {
      for (const [reqId, reqMetrics] of Object.entries(bucket.byRequest)) {
        const prev = Object.prototype.hasOwnProperty.call(byRequestMaxRps, reqId)
          ? byRequestMaxRps[reqId]
          : 0;
        if (reqMetrics.requestsPerSec > prev) {
          byRequestMaxRps[reqId] = reqMetrics.requestsPerSec;
        }
      }
    }
  }

  return {
    overallMaxRps,
    overallPeakTimestampMs,
    byRequestMaxRps,
  };
}
