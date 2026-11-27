import React, { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Settings2 } from 'lucide-react';
import type {
  FunctionalRunnerConfig,
  FunctionalStopOnErrorMode,
  PerformanceDataFileMeta,
} from '../../types/api';
import { getPlatformPerformanceLimits } from '../../lib/loadProfileMath';

interface FunctionalConfigPanelProps {
  config: FunctionalRunnerConfig;
  selectedRequestCount: number;
  dataFile?: PerformanceDataFileMeta;
  activeEnvironmentName?: string | null;
  platformId: 'desktop' | 'extension' | 'android' | 'web';
  onChange: (next: FunctionalRunnerConfig) => void;
}

const STOP_ON_ERROR_OPTIONS: Array<{
  value: FunctionalStopOnErrorMode;
  label: string;
  desc: string;
}> = [
  { value: 'never', label: 'Never', desc: 'Continue remaining iterations and requests on failures' },
  { value: 'request_or_script_error', label: 'On request or script error', desc: 'Halt on network timeout or uncaught script exception' },
  { value: 'failed_test', label: 'On any failed test', desc: 'Halt immediately on any pm.test() assertion failure or error' },
];

export const FunctionalConfigPanel: React.FC<FunctionalConfigPanelProps> = ({
  config,
  selectedRequestCount,
  dataFile,
  activeEnvironmentName,
  platformId,
  onChange,
}) => {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const limits = getPlatformPerformanceLimits(platformId);
  const plannedSteps = Math.max(1, config.iterations || 1) * Math.max(0, selectedRequestCount);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-tx-primary">Set up functional collection run</h3>
        <p className="mt-0.5 text-xs text-tx-muted">
          Execute checked requests strictly in sequence with Pre-request &amp; Post-response scripts and{' '}
          <code className="rounded bg-element px-1 font-mono text-[11px]">pm.test()</code> assertions.
        </p>
      </div>

      {/* Iterations & Delay */}
      <div className="grid grid-cols-1 gap-3 rounded-xl border border-line bg-card p-3.5 sm:grid-cols-2">
        <div>
          <label className="mb-1 flex items-center justify-between text-xs font-medium text-tx-muted">
            <span>Iterations</span>
            {dataFile && (
              <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-600 dark:text-emerald-300">
                Dataset: {dataFile.rowCount} rows
              </span>
            )}
          </label>
          <input
            type="number"
            min={1}
            max={10000}
            value={config.iterations}
            onChange={(e) =>
              onChange({
                ...config,
                iterations: Math.max(1, Math.min(10_000, Math.round(Number(e.target.value) || 1))),
              })
            }
            className="h-9 w-full rounded-lg border border-line-strong bg-element px-2.5 font-mono text-xs text-tx-primary focus:border-emerald-500 focus:outline-none"
          />
          {dataFile && config.iterations > dataFile.rowCount && (
            <p className="mt-1 text-[10px] text-tx-muted">
              Rows wrap around sequentially after iteration {dataFile.rowCount}.
            </p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-tx-muted">Delay between requests (ms)</label>
          <input
            type="number"
            min={0}
            max={60000}
            step={50}
            value={config.delayMs}
            onChange={(e) =>
              onChange({
                ...config,
                delayMs: Math.max(0, Math.min(60_000, Math.round(Number(e.target.value) || 0))),
              })
            }
            className="h-9 w-full rounded-lg border border-line-strong bg-element px-2.5 font-mono text-xs text-tx-primary focus:border-emerald-500 focus:outline-none"
          />
          <p className="mt-1 text-[10px] text-tx-muted">Optional pause between sequential steps (abortable on Stop).</p>
        </div>
      </div>

      {/* Options: Persist Responses & Keep Variable Values */}
      <div className="space-y-3 rounded-xl border border-line bg-card p-3.5 text-xs">
        <label className="flex items-start justify-between gap-3 cursor-pointer">
          <div>
            <div className="font-semibold text-tx-primary">Persist responses for a session</div>
            <div className="mt-0.5 text-[11px] text-tx-muted">
              Keep resolved request &amp; response headers/bodies in session memory to inspect step details (max 500
              steps, 128 KiB/body, 16 MiB total; never saved to disk).
            </div>
          </div>
          <input
            type="checkbox"
            checked={config.persistResponses}
            onChange={(e) => onChange({ ...config, persistResponses: e.target.checked })}
            className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-500"
          />
        </label>

        {config.persistResponses && plannedSteps > 200 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Planned run executes <b>{plannedSteps.toLocaleString()}</b> steps. Capturing stops automatically after 500
              steps or 16 MiB while test results continue recording.
            </span>
          </div>
        )}

        <div className="border-t border-line pt-3">
          <label className="flex items-start justify-between gap-3 cursor-pointer">
            <div>
              <div className="font-semibold text-tx-primary">Keep variable values</div>
              <div className="mt-0.5 text-[11px] text-tx-muted">
                {activeEnvironmentName
                  ? `Persist pm.environment.set() / unset() mutations back to "${activeEnvironmentName}" currentValue when run finishes (skipped if manually stopped).`
                  : 'Persist pm.environment.set() updates to active environment (select an active environment first).'}
              </div>
            </div>
            <input
              type="checkbox"
              checked={config.keepVariableValues}
              onChange={(e) => onChange({ ...config, keepVariableValues: e.target.checked })}
              className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-500"
            />
          </label>
        </div>

        <div className="border-t border-line pt-3">
          <label className="flex items-start justify-between gap-3 cursor-pointer">
            <div>
              <div className="font-semibold text-tx-primary">Fail on HTTP 4xx/5xx</div>
              <div className="mt-0.5 text-[11px] text-tx-muted">
                Treat HTTP 4xx/5xx responses as failed steps even when no <code className="rounded bg-element px-1 font-mono text-[10px]">pm.test()</code> assertions fail (default off, matching Postman behavior).
              </div>
            </div>
            <input
              type="checkbox"
              checked={Boolean(config.failOnHttpError)}
              onChange={(e) => onChange({ ...config, failOnHttpError: e.target.checked })}
              className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-500"
            />
          </label>
        </div>

        <div className="border-t border-line pt-3">
          <div className="mb-1.5 font-semibold text-tx-primary">Stop run on error</div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
            {STOP_ON_ERROR_OPTIONS.map((opt) => {
              const active = config.stopOnError === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChange({ ...config, stopOnError: opt.value })}
                  className={`rounded-lg border px-2.5 py-2 text-left transition ${
                    active
                      ? 'border-emerald-500 bg-emerald-500/10 text-tx-primary'
                      : 'border-line bg-element/40 text-tx-muted hover:bg-hover hover:text-tx-primary'
                  }`}
                >
                  <div className="text-[11px] font-semibold">{opt.label}</div>
                  <div className="mt-0.5 text-[10px] opacity-80">{opt.desc}</div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Advanced Network Settings */}
      <div className="rounded-xl border border-line bg-card">
        <button
          type="button"
          onClick={() => setAdvancedOpen((prev) => !prev)}
          className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-medium text-tx-secondary hover:bg-hover rounded-xl transition"
        >
          <span className="flex items-center gap-2">
            <Settings2 className="h-3.5 w-3.5 text-tx-muted" />
            <span>Advanced Network Settings</span>
          </span>
          {advancedOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-tx-muted" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-tx-muted" />
          )}
        </button>

        {advancedOpen && (
          <div className="space-y-3 border-t border-line px-3.5 py-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-medium text-tx-primary">Request timeout (ms)</div>
                <div className="text-[11px] text-tx-muted">Maximum wait per sequential HTTP request (default 60,000 ms).</div>
              </div>
              <input
                type="number"
                min={500}
                max={300000}
                step={500}
                value={config.requestTimeoutMs}
                onChange={(e) =>
                  onChange({
                    ...config,
                    requestTimeoutMs: Math.max(500, Math.min(300_000, Math.round(Number(e.target.value) || 60_000))),
                  })
                }
                className="h-8 w-28 rounded-lg border border-line-strong bg-element px-2.5 font-mono text-xs text-tx-primary focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <div>
                <div className="font-medium text-tx-primary">Follow HTTP redirects</div>
                <div className="text-[11px] text-tx-muted">Automatically follow 3xx redirect responses.</div>
              </div>
              <input
                type="checkbox"
                checked={config.followRedirects}
                onChange={(e) => onChange({ ...config, followRedirects: e.target.checked })}
                className="h-4 w-4 accent-emerald-500"
              />
            </label>

            <label
              className={`flex items-center justify-between gap-3 ${
                limits.supportsIgnoreSslErrors ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'
              }`}
            >
              <div>
                <div className="font-medium text-tx-primary">Ignore SSL certificate errors</div>
                <div className="text-[11px] text-tx-muted">
                  {limits.supportsIgnoreSslErrors
                    ? 'Allow self-signed / staging certificates.'
                    : 'Only supported on AirREST Desktop & Android.'}
                </div>
              </div>
              <input
                type="checkbox"
                disabled={!limits.supportsIgnoreSslErrors}
                checked={limits.supportsIgnoreSslErrors && config.ignoreSslErrors}
                onChange={(e) => onChange({ ...config, ignoreSslErrors: e.target.checked })}
                className="h-4 w-4 accent-emerald-500"
              />
            </label>
          </div>
        )}
      </div>
    </div>
  );
};
