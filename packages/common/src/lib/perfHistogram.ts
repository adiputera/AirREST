/**
 * Deterministic fixed-memory log-linear bucket histogram for latency metrics.
 * Matches the Rust `perf_histogram.rs` bucket layout 1:1 so Desktop and JS engines
 * produce identical percentile semantics with constant memory (~5.5 KiB per instance).
 */

const TIER1_MAX = 100; // [0, 100) ms, step 1 ms -> 100 buckets (0..99)
const TIER2_MAX = 1000; // [100, 1000) ms, step 5 ms -> 180 buckets (100..279)
const TIER3_MAX = 10000; // [1000, 10000) ms, step 25 ms -> 360 buckets (280..639)
const TIER4_MAX = 60000; // [10000, 60000) ms, step 100 ms -> 500 buckets (640..1139)
const TIER5_MAX = 300000; // [60000, 300000] ms, step 1000 ms -> 241 buckets (1140..1380)

export const PERF_HISTOGRAM_BUCKETS = 100 + 180 + 360 + 500 + 241; // 1381

export function latencyToBucketIndex(ms: number): number {
  const clamped = Number.isFinite(ms) ? Math.max(0, Math.min(TIER5_MAX, Math.round(ms))) : 0;
  if (clamped < TIER1_MAX) {
    return clamped;
  }
  if (clamped < TIER2_MAX) {
    return 100 + Math.floor((clamped - TIER1_MAX) / 5);
  }
  if (clamped < TIER3_MAX) {
    return 280 + Math.floor((clamped - TIER2_MAX) / 25);
  }
  if (clamped < TIER4_MAX) {
    return 640 + Math.floor((clamped - TIER3_MAX) / 100);
  }
  return Math.min(PERF_HISTOGRAM_BUCKETS - 1, 1140 + Math.floor((clamped - TIER4_MAX) / 1000));
}

export function bucketIndexToUpperBoundMs(index: number): number {
  if (index < 100) {
    return index;
  }
  if (index < 280) {
    return TIER1_MAX + (index - 100) * 5 + 4;
  }
  if (index < 640) {
    return TIER2_MAX + (index - 280) * 25 + 24;
  }
  if (index < 1140) {
    return TIER3_MAX + (index - 640) * 100 + 99;
  }
  return Math.min(TIER5_MAX, TIER4_MAX + (index - 1140) * 1000 + 999);
}

export interface HistogramSummary {
  count: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export class PerfHistogram {
  private buckets: Uint32Array;
  private count = 0;
  private sumMs = 0;
  private minMs = Number.POSITIVE_INFINITY;
  private maxMs = 0;

  constructor() {
    this.buckets = new Uint32Array(PERF_HISTOGRAM_BUCKETS);
  }

  record(ms: number): void {
    const safeMs = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
    const idx = latencyToBucketIndex(safeMs);
    this.buckets[idx] += 1;
    this.count += 1;
    this.sumMs += safeMs;
    if (safeMs < this.minMs) this.minMs = safeMs;
    if (safeMs > this.maxMs) this.maxMs = safeMs;
  }

  merge(other: PerfHistogram): void {
    if (other.count === 0) return;
    for (let i = 0; i < PERF_HISTOGRAM_BUCKETS; i++) {
      const val = other.buckets[i];
      if (val > 0) this.buckets[i] += val;
    }
    this.count += other.count;
    this.sumMs += other.sumMs;
    if (other.minMs < this.minMs) this.minMs = other.minMs;
    if (other.maxMs > this.maxMs) this.maxMs = other.maxMs;
  }

  reset(): void {
    this.buckets.fill(0);
    this.count = 0;
    this.sumMs = 0;
    this.minMs = Number.POSITIVE_INFINITY;
    this.maxMs = 0;
  }

  quantile(q: number): number {
    if (this.count === 0) return 0;
    const clampedQ = Math.max(0, Math.min(1, q));
    const targetRank = Math.max(1, Math.ceil(clampedQ * this.count));
    let cumulative = 0;
    for (let i = 0; i < PERF_HISTOGRAM_BUCKETS; i++) {
      const c = this.buckets[i];
      if (c === 0) continue;
      cumulative += c;
      if (cumulative >= targetRank) {
        const bound = bucketIndexToUpperBoundMs(i);
        return Math.max(this.minMs, Math.min(this.maxMs, bound));
      }
    }
    return this.maxMs;
  }

  getSummary(): HistogramSummary {
    if (this.count === 0) {
      return {
        count: 0,
        avgMs: 0,
        minMs: 0,
        maxMs: 0,
        p90Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
      };
    }
    return {
      count: this.count,
      avgMs: Math.round(this.sumMs / this.count),
      minMs: this.minMs,
      maxMs: this.maxMs,
      p90Ms: this.quantile(0.9),
      p95Ms: this.quantile(0.95),
      p99Ms: this.quantile(0.99),
    };
  }
}
