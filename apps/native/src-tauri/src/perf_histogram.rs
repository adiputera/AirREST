//! Fixed-memory log-linear bucket histogram matching `packages/common/src/lib/perfHistogram.ts`.

const TIER1_MAX: u64 = 100; // [0, 100) ms, step 1 ms -> 100 buckets (0..99)
const TIER2_MAX: u64 = 1000; // [100, 1000) ms, step 5 ms -> 180 buckets (100..279)
const TIER3_MAX: u64 = 10000; // [1000, 10000) ms, step 25 ms -> 360 buckets (280..639)
const TIER4_MAX: u64 = 60000; // [10000, 60000) ms, step 100 ms -> 500 buckets (640..1139)
const TIER5_MAX: u64 = 300_000; // [60000, 300000] ms, step 1000 ms -> 241 buckets (1140..1380)

pub const PERF_HISTOGRAM_BUCKETS: usize = 100 + 180 + 360 + 500 + 241; // 1381

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct HistogramSummary {
    pub count: u64,
    pub avg_ms: u64,
    pub min_ms: u64,
    pub max_ms: u64,
    pub p90_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
}

#[inline]
pub fn latency_to_bucket_index(ms: u64) -> usize {
    let clamped = ms.min(TIER5_MAX);
    if clamped < TIER1_MAX {
        clamped as usize
    } else if clamped < TIER2_MAX {
        100 + ((clamped - TIER1_MAX) / 5) as usize
    } else if clamped < TIER3_MAX {
        280 + ((clamped - TIER2_MAX) / 25) as usize
    } else if clamped < TIER4_MAX {
        640 + ((clamped - TIER3_MAX) / 100) as usize
    } else {
        (1140 + ((clamped - TIER4_MAX) / 1000) as usize).min(PERF_HISTOGRAM_BUCKETS - 1)
    }
}

#[inline]
pub fn bucket_index_to_upper_bound_ms(index: usize) -> u64 {
    if index < 100 {
        index as u64
    } else if index < 280 {
        TIER1_MAX + ((index - 100) as u64) * 5 + 4
    } else if index < 640 {
        TIER2_MAX + ((index - 280) as u64) * 25 + 24
    } else if index < 1140 {
        TIER3_MAX + ((index - 640) as u64) * 100 + 99
    } else {
        (TIER4_MAX + ((index - 1140) as u64) * 1000 + 999).min(TIER5_MAX)
    }
}

#[derive(Clone)]
pub struct PerfHistogram {
    buckets: Vec<u32>,
    count: u64,
    sum_ms: u128,
    min_ms: u64,
    max_ms: u64,
}

impl PerfHistogram {
    pub fn new() -> Self {
        Self {
            buckets: vec![0; PERF_HISTOGRAM_BUCKETS],
            count: 0,
            sum_ms: 0,
            min_ms: u64::MAX,
            max_ms: 0,
        }
    }

    pub fn record(&mut self, ms: u64) {
        let idx = latency_to_bucket_index(ms);
        self.buckets[idx] = self.buckets[idx].saturating_add(1);
        self.count += 1;
        self.sum_ms += ms as u128;
        if ms < self.min_ms {
            self.min_ms = ms;
        }
        if ms > self.max_ms {
            self.max_ms = ms;
        }
    }

    pub fn quantile(&self, q: f64) -> u64 {
        if self.count == 0 {
            return 0;
        }
        let clamped_q = q.clamp(0.0, 1.0);
        let target_rank = ((clamped_q * self.count as f64).ceil() as u64).max(1);
        let mut cumulative: u64 = 0;
        for (i, &c) in self.buckets.iter().enumerate() {
            if c == 0 {
                continue;
            }
            cumulative += c as u64;
            if cumulative >= target_rank {
                let bound = bucket_index_to_upper_bound_ms(i);
                return bound.max(self.min_ms).min(self.max_ms);
            }
        }
        self.max_ms
    }

    pub fn summary(&self) -> HistogramSummary {
        if self.count == 0 {
            return HistogramSummary {
                count: 0,
                avg_ms: 0,
                min_ms: 0,
                max_ms: 0,
                p90_ms: 0,
                p95_ms: 0,
                p99_ms: 0,
            };
        }
        HistogramSummary {
            count: self.count,
            avg_ms: ((self.sum_ms as f64) / (self.count as f64)).round() as u64,
            min_ms: self.min_ms,
            max_ms: self.max_ms,
            p90_ms: self.quantile(0.90),
            p95_ms: self.quantile(0.95),
            p99_ms: self.quantile(0.99),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_percentiles_accurately() {
        let mut hist = PerfHistogram::new();
        for ms in 1..=100 {
            hist.record(ms);
        }
        let s = hist.summary();
        assert_eq!(s.count, 100);
        assert_eq!(s.min_ms, 1);
        assert_eq!(s.max_ms, 100);
        assert_eq!(s.avg_ms, 51);
        assert_eq!(s.p90_ms, 90);
        assert_eq!(s.p95_ms, 95);
        assert_eq!(s.p99_ms, 99);
    }

    #[test]
    fn handles_high_latency_tiers_and_bounds() {
        let mut hist = PerfHistogram::new();
        hist.record(150);
        hist.record(2_500);
        hist.record(45_000);
        hist.record(250_000);
        let s = hist.summary();
        assert_eq!(s.count, 4);
        assert_eq!(s.min_ms, 150);
        assert_eq!(s.max_ms, 250_000);
        assert!(s.p99_ms >= 250_000 && s.p99_ms <= 250_000);
    }
}
