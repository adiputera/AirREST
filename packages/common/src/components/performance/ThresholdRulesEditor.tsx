import React from 'react';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type {
  PerformanceRequestDescriptor,
  PerformanceThresholdConfig,
  PerformanceThresholdMetric,
  PerformanceThresholdOperator,
  PerformanceThresholdRule,
} from '../../types/api';
import {
  createDefaultThresholdConfig,
  DEFAULT_ABORT_CONSECUTIVE_BREACHES,
  DEFAULT_ABORT_GRACE_PERIOD_SEC,
  THRESHOLD_METRIC_META,
  THRESHOLD_OPERATOR_SYMBOLS,
} from '../../lib/perfThresholds';

interface ThresholdRulesEditorProps {
  thresholds?: PerformanceThresholdConfig;
  loopEndpoints: PerformanceRequestDescriptor[];
  onChange: (next: PerformanceThresholdConfig) => void;
}

const METRIC_OPTIONS: PerformanceThresholdMetric[] = [
  'avgMs',
  'p90Ms',
  'p95Ms',
  'p99Ms',
  'errorRatePct',
  'requestsPerSec',
  'maxRequestsPerSec',
];

const OPERATOR_OPTIONS: PerformanceThresholdOperator[] = ['lt', 'lte', 'gt', 'gte'];

function makeRuleId(): string {
  return `sla_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export const ThresholdRulesEditor: React.FC<ThresholdRulesEditorProps> = ({
  thresholds,
  loopEndpoints,
  onChange,
}) => {
  const cfg = thresholds || createDefaultThresholdConfig();
  const hasAbortRule = cfg.rules.some((r) => r.enabled && r.abortOnFail);

  const addRule = (
    preset?: Partial<Pick<PerformanceThresholdRule, 'metric' | 'operator' | 'value' | 'abortOnFail'>>
  ) => {
    const metric: PerformanceThresholdMetric = preset?.metric || 'p95Ms';
    const meta = THRESHOLD_METRIC_META[metric];
    const nextRule: PerformanceThresholdRule = {
      id: makeRuleId(),
      enabled: true,
      targetRequestId: 'overall',
      metric,
      operator: preset?.operator || meta.defaultOperator,
      value: preset?.value ?? meta.defaultValue,
      abortOnFail: preset?.abortOnFail ?? false,
    };
    onChange({
      ...cfg,
      rules: [...cfg.rules, nextRule],
    });
  };

  const updateRule = (ruleId: string, patch: Partial<PerformanceThresholdRule>) => {
    onChange({
      ...cfg,
      rules: cfg.rules.map((r) => (r.id === ruleId ? { ...r, ...patch } : r)),
    });
  };

  const removeRule = (ruleId: string) => {
    onChange({
      ...cfg,
      rules: cfg.rules.filter((r) => r.id !== ruleId),
    });
  };

  return (
    <div className="rounded-xl border border-line bg-card p-3.5 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-500" />
          <span className="text-xs font-semibold text-tx-primary">Pass test if (SLA Thresholds)</span>
          {cfg.rules.length > 0 && (
            <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-300">
              {cfg.rules.filter((r) => r.enabled).length} active
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() => addRule()}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-element px-2.5 text-[11px] font-semibold text-tx-primary hover:bg-hover transition"
        >
          <Plus className="h-3 w-3 text-emerald-500" />
          <span>Add rule</span>
        </button>
      </div>

      {cfg.rules.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-line bg-element/30 px-3 py-2 text-[11px] text-tx-muted">
          <span>No SLA rules configured. Add thresholds to mark runs PASSED or FAILED automatically.</span>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => addRule({ metric: 'p95Ms', operator: 'lt', value: 500 })}
              className="rounded border border-line bg-card px-2 py-0.5 text-[10px] font-medium text-tx-secondary hover:bg-hover"
            >
              + P95 &lt; 500 ms
            </button>
            <button
              type="button"
              onClick={() => addRule({ metric: 'errorRatePct', operator: 'lt', value: 1 })}
              className="rounded border border-line bg-card px-2 py-0.5 text-[10px] font-medium text-tx-secondary hover:bg-hover"
            >
              + Error &lt; 1%
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {cfg.rules.map((rule) => {
            const unit = THRESHOLD_METRIC_META[rule.metric]?.unit || '';
            return (
              <div
                key={rule.id}
                className={`flex flex-wrap items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs ${
                  rule.enabled ? 'border-line bg-element/40' : 'border-line/50 bg-element/15 opacity-60'
                }`}
              >
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })}
                  className="h-3.5 w-3.5 accent-emerald-500"
                  title="Enable / disable rule"
                />

                <select
                  value={rule.targetRequestId}
                  onChange={(e) => updateRule(rule.id, { targetRequestId: e.target.value })}
                  className="h-7 max-w-[160px] rounded border border-line bg-card px-1.5 text-[11px] text-tx-primary focus:border-sky-500 focus:outline-none"
                >
                  <option value="overall">All requests (Overall)</option>
                  {loopEndpoints.map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      {ep.method} {ep.name}
                    </option>
                  ))}
                </select>

                <select
                  value={rule.metric}
                  onChange={(e) => {
                    const nextMetric = e.target.value as PerformanceThresholdMetric;
                    const meta = THRESHOLD_METRIC_META[nextMetric];
                    updateRule(rule.id, {
                      metric: nextMetric,
                      operator: meta.defaultOperator,
                    });
                  }}
                  className="h-7 rounded border border-line bg-card px-1.5 text-[11px] text-tx-primary focus:border-sky-500 focus:outline-none"
                >
                  {METRIC_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {THRESHOLD_METRIC_META[m].label}
                    </option>
                  ))}
                </select>

                <select
                  value={rule.operator}
                  onChange={(e) =>
                    updateRule(rule.id, { operator: e.target.value as PerformanceThresholdOperator })
                  }
                  className="h-7 w-14 rounded border border-line bg-card px-1.5 font-mono text-[11px] text-tx-primary focus:border-sky-500 focus:outline-none"
                >
                  {OPERATOR_OPTIONS.map((op) => (
                    <option key={op} value={op}>
                      {THRESHOLD_OPERATOR_SYMBOLS[op]}
                    </option>
                  ))}
                </select>

                <div className="flex items-center">
                  <input
                    type="number"
                    min={0}
                    step={rule.metric === 'errorRatePct' ? 0.1 : 1}
                    value={rule.value}
                    onChange={(e) =>
                      updateRule(rule.id, { value: Math.max(0, Number(e.target.value) || 0) })
                    }
                    className="h-7 w-20 rounded-l border border-line bg-card px-2 font-mono text-[11px] text-tx-primary focus:border-sky-500 focus:outline-none"
                  />
                  <span className="inline-flex h-7 items-center rounded-r border border-l-0 border-line bg-element px-1.5 font-mono text-[10px] text-tx-muted">
                    {unit}
                  </span>
                </div>

                <label
                  className="ml-auto inline-flex items-center gap-1 rounded border border-line bg-card px-2 py-1 text-[10px] font-medium text-tx-secondary cursor-pointer"
                  title="Stop the run early if this rule fails continuously"
                >
                  <input
                    type="checkbox"
                    checked={Boolean(rule.abortOnFail)}
                    onChange={(e) => updateRule(rule.id, { abortOnFail: e.target.checked })}
                    className="h-3 w-3 accent-rose-500"
                  />
                  <span>Auto-stop</span>
                </label>

                <button
                  type="button"
                  onClick={() => removeRule(rule.id)}
                  className="rounded p-1 text-tx-muted hover:bg-hover hover:text-rose-500 transition"
                  title="Delete rule"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}

          {hasAbortRule && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-rose-500/25 bg-rose-500/5 px-3 py-2 text-[11px] text-tx-secondary">
              <span className="font-semibold text-rose-600 dark:text-rose-300">Auto-stop guard:</span>
              <label className="inline-flex items-center gap-1.5">
                <span>Warm-up grace</span>
                <input
                  type="number"
                  min={0}
                  max={300}
                  value={cfg.abortGracePeriodSec ?? DEFAULT_ABORT_GRACE_PERIOD_SEC}
                  onChange={(e) =>
                    onChange({
                      ...cfg,
                      abortGracePeriodSec: Math.max(0, Math.min(300, Math.round(Number(e.target.value) || 0))),
                    })
                  }
                  className="h-6 w-14 rounded border border-line bg-card px-1.5 font-mono text-[11px] text-tx-primary"
                />
                <span>s</span>
              </label>
              <label className="inline-flex items-center gap-1.5">
                <span>Sustained breach</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={cfg.abortConsecutiveBreaches ?? DEFAULT_ABORT_CONSECUTIVE_BREACHES}
                  onChange={(e) =>
                    onChange({
                      ...cfg,
                      abortConsecutiveBreaches: Math.max(1, Math.min(60, Math.round(Number(e.target.value) || 1))),
                    })
                  }
                  className="h-6 w-12 rounded border border-line bg-card px-1.5 font-mono text-[11px] text-tx-primary"
                />
                <span>ticks</span>
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
