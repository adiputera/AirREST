import type {
  PerformanceRunReport,
  PerformanceSlaSummary,
  PerformanceThresholdConfig,
  PerformanceThresholdEvaluation,
  PerformanceThresholdMetric,
  PerformanceThresholdOperator,
  PerformanceThresholdRule,
} from '../types/api';
import { computePeakRpsMetrics } from './perfMetrics';

export const DEFAULT_ABORT_GRACE_PERIOD_SEC = 10;
export const DEFAULT_ABORT_CONSECUTIVE_BREACHES = 3;

export const THRESHOLD_METRIC_META: Record<
  PerformanceThresholdMetric,
  { label: string; unit: string; defaultOperator: PerformanceThresholdOperator; defaultValue: number }
> = {
  avgMs: { label: 'Avg. response time', unit: 'ms', defaultOperator: 'lt', defaultValue: 500 },
  p90Ms: { label: 'P90 response time', unit: 'ms', defaultOperator: 'lt', defaultValue: 800 },
  p95Ms: { label: 'P95 response time', unit: 'ms', defaultOperator: 'lt', defaultValue: 1000 },
  p99Ms: { label: 'P99 response time', unit: 'ms', defaultOperator: 'lt', defaultValue: 1500 },
  errorRatePct: { label: 'Error rate', unit: '%', defaultOperator: 'lt', defaultValue: 1 },
  requestsPerSec: { label: 'Requests/second', unit: 'req/s', defaultOperator: 'gte', defaultValue: 50 },
  maxRequestsPerSec: { label: 'Max Req/s', unit: 'req/s', defaultOperator: 'gte', defaultValue: 50 },
};

export const THRESHOLD_OPERATOR_SYMBOLS: Record<PerformanceThresholdOperator, string> = {
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

export function createDefaultThresholdConfig(): PerformanceThresholdConfig {
  return {
    rules: [],
    abortGracePeriodSec: DEFAULT_ABORT_GRACE_PERIOD_SEC,
    abortConsecutiveBreaches: DEFAULT_ABORT_CONSECUTIVE_BREACHES,
  };
}

export function isSampleDependentMetric(metric: PerformanceThresholdMetric): boolean {
  return metric !== 'requestsPerSec' && metric !== 'maxRequestsPerSec';
}

export function compareMetricValue(
  actual: number,
  operator: PerformanceThresholdOperator,
  expected: number
): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  switch (operator) {
    case 'lt':
      return actual < expected;
    case 'lte':
      return actual <= expected;
    case 'gt':
      return actual > expected;
    case 'gte':
      return actual >= expected;
  }
}

export function extractThresholdMetricValue(
  report: Pick<PerformanceRunReport, 'summary' | 'timeSeries' | 'endpoints'>,
  targetRequestId: string,
  metric: PerformanceThresholdMetric
): { value: number; targetLabel: string; sampleCount: number } | null {
  if (targetRequestId === 'overall') {
    const sampleCount = report.summary.totalRequests ?? 0;
    if (metric === 'maxRequestsPerSec') {
      const peak = computePeakRpsMetrics(report);
      return { value: peak.overallMaxRps, targetLabel: 'All requests (Overall)', sampleCount };
    }
    return {
      value: report.summary[metric] ?? 0,
      targetLabel: 'All requests (Overall)',
      sampleCount,
    };
  }

  const ep = report.endpoints.find((e) => e.requestId === targetRequestId);
  if (!ep) return null;
  const sampleCount = ep.totalRequests ?? 0;

  if (metric === 'maxRequestsPerSec') {
    const peak = computePeakRpsMetrics(report);
    const val = peak.byRequestMaxRps[ep.requestId] ?? ep.maxRequestsPerSec ?? 0;
    return { value: val, targetLabel: `${ep.method} ${ep.name}`, sampleCount };
  }

  return {
    value: ep[metric] ?? 0,
    targetLabel: `${ep.method} ${ep.name}`,
    sampleCount,
  };
}

export function formatThresholdRuleExpression(
  rule: Pick<PerformanceThresholdEvaluation | PerformanceThresholdRule, 'metric' | 'operator'> & {
    expected?: number;
    value?: number;
  }
): string {
  const meta = THRESHOLD_METRIC_META[rule.metric];
  const op = THRESHOLD_OPERATOR_SYMBOLS[rule.operator];
  const num = 'expected' in rule && rule.expected !== undefined ? rule.expected : (rule.value ?? 0);
  const unit = meta?.unit ? ` ${meta.unit}` : '';
  return `${meta?.label || rule.metric} ${op} ${num}${unit}`;
}

export interface AutoAbortMetadata {
  ruleId: string;
  reason: string;
}

export function evaluatePerformanceThresholds(
  report: Pick<PerformanceRunReport, 'summary' | 'timeSeries' | 'endpoints'>,
  config: PerformanceThresholdConfig | undefined,
  autoAbortMeta?: AutoAbortMetadata
): PerformanceSlaSummary | undefined {
  const enabledRules = (config?.rules || []).filter((r) => r.enabled);
  if (enabledRules.length === 0) return undefined;

  const results: PerformanceThresholdEvaluation[] = enabledRules.map((rule) => {
    const extracted = extractThresholdMetricValue(report, rule.targetRequestId, rule.metric);
    const targetLabel =
      extracted?.targetLabel ?? (rule.targetRequestId === 'overall' ? 'All requests (Overall)' : rule.targetRequestId);
    const triggeredAbort = Boolean(autoAbortMeta && autoAbortMeta.ruleId === rule.id);
    const missingSamples =
      !extracted || (isSampleDependentMetric(rule.metric) && extracted.sampleCount === 0);

    if (!triggeredAbort && missingSamples) {
      return {
        ruleId: rule.id,
        targetRequestId: rule.targetRequestId,
        targetLabel,
        metric: rule.metric,
        operator: rule.operator,
        expected: rule.value,
        actual: 0,
        passed: false,
        notEvaluated: true,
        notEvaluatedReason: !extracted
          ? 'Target endpoint was not part of this run'
          : 'No completed requests (0 samples)',
        abortOnFail: Boolean(rule.abortOnFail),
        triggeredAbort: false,
      };
    }

    const actual = extracted?.value ?? 0;
    const passed = triggeredAbort ? false : compareMetricValue(actual, rule.operator, rule.value);

    return {
      ruleId: rule.id,
      targetRequestId: rule.targetRequestId,
      targetLabel,
      metric: rule.metric,
      operator: rule.operator,
      expected: rule.value,
      actual: Number.isFinite(actual) ? Number(actual.toFixed(2)) : 0,
      passed,
      abortOnFail: Boolean(rule.abortOnFail),
      triggeredAbort,
    };
  });

  const passedCount = results.filter((r) => r.passed).length;
  const inconclusiveCount = results.filter((r) => r.notEvaluated).length;
  const failedCount = results.filter((r) => !r.passed && !r.notEvaluated).length;
  const totalRunRequests = report.summary.totalRequests ?? 0;

  const overallFailed =
    Boolean(autoAbortMeta) ||
    failedCount > 0 ||
    totalRunRequests === 0 ||
    (passedCount === 0 && inconclusiveCount > 0);

  return {
    status: overallFailed ? 'failed' : 'passed',
    passedCount,
    failedCount,
    ...(inconclusiveCount > 0 ? { inconclusiveCount } : {}),
    totalCount: results.length,
    autoAborted: Boolean(autoAbortMeta),
    autoAbortedReason: autoAbortMeta?.reason,
    results,
  };
}

export interface AutoStopTickDecision {
  shouldAbort: boolean;
  ruleId?: string;
  reason?: string;
}

/**
 * Tracks consecutive 1 Hz SLA breaches on rules marked `abortOnFail`, ignoring warm-up ticks
 * and skipping sample-dependent rules (latency / error rate) when target sample count is 0.
 */
export function createAutoStopTracker(config?: PerformanceThresholdConfig): {
  evaluateTick: (
    liveReport: Pick<PerformanceRunReport, 'summary' | 'timeSeries' | 'endpoints'>,
    elapsedSec: number
  ) => AutoStopTickDecision;
} {
  const abortRules = (config?.rules || []).filter((r) => r.enabled && r.abortOnFail);
  const graceSec = Math.max(0, Math.floor(config?.abortGracePeriodSec ?? DEFAULT_ABORT_GRACE_PERIOD_SEC));
  const consecutiveRequired = Math.max(
    1,
    Math.floor(config?.abortConsecutiveBreaches ?? DEFAULT_ABORT_CONSECUTIVE_BREACHES)
  );
  const streaks = new Map<string, number>();

  return {
    evaluateTick(liveReport, elapsedSec) {
      if (abortRules.length === 0) {
        return { shouldAbort: false };
      }

      if (elapsedSec < graceSec) {
        streaks.clear();
        return { shouldAbort: false };
      }

      for (const rule of abortRules) {
        const extracted = extractThresholdMetricValue(liveReport, rule.targetRequestId, rule.metric);
        if (!extracted || (isSampleDependentMetric(rule.metric) && extracted.sampleCount === 0)) {
          streaks.set(rule.id, 0);
          continue;
        }
        const passed = compareMetricValue(extracted.value, rule.operator, rule.value);
        if (passed) {
          streaks.set(rule.id, 0);
          continue;
        }

        const nextStreak = (streaks.get(rule.id) ?? 0) + 1;
        streaks.set(rule.id, nextStreak);

        if (nextStreak >= consecutiveRequired) {
          const expr = formatThresholdRuleExpression(rule);
          return {
            shouldAbort: true,
            ruleId: rule.id,
            reason: `Auto-aborted after ${consecutiveRequired}s sustained breach on "${extracted.targetLabel}": ${expr} (actual ${Number(extracted.value.toFixed(2))}).`,
          };
        }
      }

      return { shouldAbort: false };
    },
  };
}
