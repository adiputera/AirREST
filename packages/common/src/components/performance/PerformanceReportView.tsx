import React, { useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Download,
  FileCode2,
  FileSpreadsheet,
  GitCompareArrows,
  History,
  KeyRound,
  Play,
  Settings,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import type {
  Collection,
  PerformanceLatencyMetric,
  PerformanceRunReport,
  PerformanceTimeBucket,
} from '../../types/api';
import { computePeakRpsMetrics } from '../../lib/perfMetrics';
import {
  computePerformanceComparison,
  formatDeltaCompact,
  type MetricDelta,
} from '../../lib/perfComparison';
import { formatThresholdRuleExpression } from '../../lib/perfThresholds';
import { MethodBadge } from '../MethodBadge';
import { SessionOnlyReportBanner } from './SessionOnlyReportBanner';

interface PerformanceReportViewProps {
  report: PerformanceRunReport;
  recentReports: PerformanceRunReport[];
  isAnotherRunActive: boolean;
  isSessionOnlyImported?: boolean;
  sessionOnlyReason?: string;
  availableCollections?: Collection[];
  onStopRun: () => void;
  onRunAgain: () => void;
  onBackToSetup: () => void;
  onSelectHistoryReport: (report: PerformanceRunReport) => void;
  onDeleteHistoryReport: (reportId: string) => void;
  onLoadBaselineJson?: () => Promise<{ report?: PerformanceRunReport; error?: string } | null>;
  onExportHtml: (report: PerformanceRunReport, baseline?: PerformanceRunReport | null) => void;
  onExportJson: (report: PerformanceRunReport) => void;
  onExportEndpointsCsv: (report: PerformanceRunReport) => void;
  onExportTimeSeriesCsv: (report: PerformanceRunReport) => void;
  onShareReport?: (report: PerformanceRunReport) => void;
  onImportReportFile?: () => void;
  onAttachToCollection?: (collection: Collection) => void;
}

const CHART_W = 960;
const CHART_H = 260;
const CHART_PAD = { left: 48, right: 112, top: 20, bottom: 28 };
const PLOT_W = CHART_W - CHART_PAD.left - CHART_PAD.right;
const PLOT_H = CHART_H - CHART_PAD.top - CHART_PAD.bottom;

const LATENCY_OPTIONS: Array<{ value: PerformanceLatencyMetric; label: string }> = [
  { value: 'avg', label: 'Avg. response' },
  { value: 'p90', label: 'P90 response' },
  { value: 'p95', label: 'P95 response' },
  { value: 'p99', label: 'P99 response' },
  { value: 'max', label: 'Max response' },
  { value: 'min', label: 'Min response' },
];

function readBucketLatency(
  src: { avgMs: number; p90Ms: number; p95Ms: number; p99Ms: number; minMs: number; maxMs: number } | undefined,
  metric: PerformanceLatencyMetric
): number {
  if (!src) return 0;
  switch (metric) {
    case 'p90':
      return src.p90Ms;
    case 'p95':
      return src.p95Ms;
    case 'p99':
      return src.p99Ms;
    case 'min':
      return src.minMs;
    case 'max':
      return src.maxMs;
    case 'avg':
    default:
      return src.avgMs;
  }
}

function formatTimeLabel(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

function deltaToneClass(delta: MetricDelta): string {
  if (delta.direction === 'improved') return 'text-emerald-500';
  if (delta.direction === 'regressed') return 'text-rose-500';
  return 'text-tx-faint';
}

export const PerformanceReportView: React.FC<PerformanceReportViewProps> = ({
  report,
  recentReports,
  isAnotherRunActive,
  isSessionOnlyImported = false,
  sessionOnlyReason,
  availableCollections = [],
  onStopRun,
  onRunAgain,
  onBackToSetup,
  onSelectHistoryReport,
  onDeleteHistoryReport,
  onLoadBaselineJson,
  onExportHtml,
  onExportJson,
  onExportEndpointsCsv,
  onExportTimeSeriesCsv,
  onShareReport,
  onImportReportFile,
  onAttachToCollection,
}) => {
  const [activeTab, setActiveTab] = useState<'summary' | 'errors'>('summary');
  const [requestFilterId, setRequestFilterId] = useState<string>('all');
  const [latencyMetric, setLatencyMetric] = useState<PerformanceLatencyMetric>('avg');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [compareMenuOpen, setCompareMenuOpen] = useState(false);
  const [compareShowAllWorkspace, setCompareShowAllWorkspace] = useState(false);
  const [baselineReport, setBaselineReport] = useState<PerformanceRunReport | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);

  const isRunning = report.status === 'running';
  const activeBaseline = !isRunning && baselineReport && baselineReport.id !== report.id ? baselineReport : null;

  const peakMetrics = useMemo(() => computePeakRpsMetrics(report), [report]);
  const peakTimeLabel =
    peakMetrics.overallPeakTimestampMs !== null
      ? formatTimeLabel(peakMetrics.overallPeakTimestampMs)
      : '';

  const comparison = useMemo(
    () => (activeBaseline ? computePerformanceComparison(report, activeBaseline) : null),
    [report, activeBaseline]
  );

  const compareCandidates = useMemo(() => {
    return recentReports.filter((r) => {
      if (r.id === report.id) return false;
      if (compareShowAllWorkspace) return true;
      return r.sourceId === report.sourceId;
    });
  }, [recentReports, report.id, report.sourceId, compareShowAllWorkspace]);

  const engineLabel =
    report.engineMode === 'rust_native'
      ? 'Native Rust Engine'
      : report.engineMode === 'hybrid_pool'
        ? 'Hybrid JS Pool'
        : 'Bounded JS Engine';

  const chartPoints = useMemo(() => {
    if (comparison) {
      return comparison.alignedSeconds.map(({ second, currentBucket, baselineBucket }) => {
        const curSrc = currentBucket
          ? requestFilterId !== 'all'
            ? currentBucket.byRequest?.[requestFilterId]
            : currentBucket
          : undefined;
        const baseSrc = baselineBucket
          ? requestFilterId !== 'all'
            ? baselineBucket.byRequest?.[requestFilterId]
            : baselineBucket
          : undefined;
        return {
          second,
          hasCur: Boolean(currentBucket),
          hasBase: Boolean(baselineBucket),
          timeLabel: currentBucket ? formatTimeLabel(currentBucket.timestampMs) : `+${second}s`,
          elapsedLabel: `${second}s`,
          rps: curSrc?.requestsPerSec ?? 0,
          latencyMs: readBucketLatency(curSrc, latencyMetric),
          errorRatePct: curSrc?.errorRatePct ?? 0,
          virtualUsers: currentBucket?.virtualUsers ?? 0,
          baseRps: baseSrc?.requestsPerSec ?? 0,
          baseLatencyMs: readBucketLatency(baseSrc, latencyMetric),
          baseErrorRatePct: baseSrc?.errorRatePct ?? 0,
        };
      });
    }

    const series: PerformanceTimeBucket[] = report.timeSeries || [];
    return series.map((bucket) => {
      const src =
        requestFilterId !== 'all'
          ? bucket.byRequest?.[requestFilterId]
          : bucket;
      return {
        second: bucket.second,
        hasCur: true,
        hasBase: false,
        timeLabel: formatTimeLabel(bucket.timestampMs),
        elapsedLabel: `${bucket.second}s`,
        rps: src?.requestsPerSec ?? 0,
        latencyMs: readBucketLatency(src, latencyMetric),
        errorRatePct: src?.errorRatePct ?? 0,
        virtualUsers: bucket.virtualUsers ?? 0,
        baseRps: 0,
        baseLatencyMs: 0,
        baseErrorRatePct: 0,
      };
    });
  }, [report.timeSeries, comparison, requestFilterId, latencyMetric]);

  const maxRps = Math.max(10, ...chartPoints.map((p) => Math.max(p.rps, p.hasBase ? p.baseRps : 0)));
  const maxLat = Math.max(10, ...chartPoints.map((p) => Math.max(p.latencyMs, p.hasBase ? p.baseLatencyMs : 0)));
  const maxVu = Math.max(1, report.configSnapshot.loadProfile.virtualUsers || 1, ...chartPoints.map((p) => p.virtualUsers));

  const xOf = (idx: number) => {
    if (chartPoints.length <= 1) return CHART_PAD.left + PLOT_W / 2;
    return CHART_PAD.left + (idx / (chartPoints.length - 1)) * PLOT_W;
  };
  const yErr = (val: number) =>
    CHART_PAD.top + PLOT_H - (Math.min(100, Math.max(0, val)) / 100) * PLOT_H;
  const yLat = (val: number) =>
    CHART_PAD.top + PLOT_H - (Math.min(maxLat, Math.max(0, val)) / maxLat) * PLOT_H;
  const yRps = (val: number) =>
    CHART_PAD.top + PLOT_H - (Math.min(maxRps, Math.max(0, val)) / maxRps) * PLOT_H;
  const yVu = (val: number) =>
    CHART_PAD.top + PLOT_H - (Math.min(maxVu, Math.max(0, val)) / maxVu) * PLOT_H;

  const polyline = (
    yFn: (pt: (typeof chartPoints)[number]) => number,
    predicate: (pt: (typeof chartPoints)[number]) => boolean = (p) => p.hasCur
  ) =>
    chartPoints
      .map((pt, idx) => ({ pt, idx }))
      .filter(({ pt }) => predicate(pt))
      .map(({ pt, idx }) => `${xOf(idx).toFixed(1)},${yFn(pt).toFixed(1)}`)
      .join(' ');

  const hoveredPoint =
    hoverIndex !== null && hoverIndex >= 0 && hoverIndex < chartPoints.length
      ? chartPoints[hoverIndex]
      : null;

  const xTickIndices = useMemo(() => {
    if (chartPoints.length === 0) return [];
    const maxTicks = 7;
    if (chartPoints.length <= maxTicks) return chartPoints.map((_, i) => i);
    const step = (chartPoints.length - 1) / (maxTicks - 1);
    const out: number[] = [];
    for (let i = 0; i < maxTicks; i++) {
      out.push(Math.round(i * step));
    }
    return out;
  }, [chartPoints.length]);

  const statusBadgeClass = report.autoAborted
    ? 'border-rose-500/35 bg-rose-500/15 text-rose-600 dark:text-rose-300'
    : report.status === 'running'
      ? 'border-sky-500/30 bg-sky-500/15 text-sky-600 dark:text-sky-300'
      : report.status === 'completed'
        ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
        : report.status === 'stopped'
          ? 'border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-300'
          : 'border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-300';

  const statusText = report.autoAborted ? 'Stopped (Auto-aborted)' : report.status;
  const activeLatencyLabel = LATENCY_OPTIONS.find((o) => o.value === latencyMetric)?.label || 'Avg. response';

  const kpiItems: Array<{
    label: string;
    value: string;
    tone: string;
    subcaption?: string;
    delta?: MetricDelta;
    deltaDecimals?: number;
    deltaUnit?: string;
  }> = [
    {
      label: 'Total requests sent',
      value: report.summary.totalRequests.toLocaleString(),
      tone: 'text-tx-primary',
      delta: comparison?.kpis.totalRequests,
      deltaDecimals: 0,
    },
    {
      label: 'Requests/second',
      value: report.summary.requestsPerSec.toFixed(2),
      tone: 'text-amber-500',
      delta: comparison?.kpis.requestsPerSec,
      deltaDecimals: 2,
    },
    {
      label: 'Max Req/s',
      value: peakMetrics.overallMaxRps.toLocaleString(),
      tone: 'text-amber-500',
      subcaption: peakTimeLabel ? `at ${peakTimeLabel}` : undefined,
      delta: comparison?.kpis.maxRequestsPerSec,
      deltaDecimals: 0,
    },
    {
      label: 'Avg. response time',
      value: `${report.summary.avgMs} ms`,
      tone: 'text-sky-500',
      delta: comparison?.kpis.avgMs,
      deltaDecimals: 0,
      deltaUnit: 'ms',
    },
    {
      label: 'P90',
      value: `${report.summary.p90Ms} ms`,
      tone: 'text-tx-primary',
      delta: comparison?.kpis.p90Ms,
      deltaDecimals: 0,
      deltaUnit: 'ms',
    },
    {
      label: 'P95',
      value: `${report.summary.p95Ms} ms`,
      tone: 'text-tx-primary',
      delta: comparison?.kpis.p95Ms,
      deltaDecimals: 0,
      deltaUnit: 'ms',
    },
    {
      label: 'P99',
      value: `${report.summary.p99Ms} ms`,
      tone: 'text-tx-primary',
      delta: comparison?.kpis.p99Ms,
      deltaDecimals: 0,
      deltaUnit: 'ms',
    },
    {
      label: 'Error rate',
      value: `${report.summary.errorRatePct.toFixed(2)} %`,
      tone:
        report.summary.errorRatePct > 0
          ? 'text-rose-500'
          : (report.summary.warningCount ?? 0) > 0
            ? 'text-amber-500'
            : 'text-emerald-500',
      subcaption:
        (report.summary.warningCount ?? 0) > 0
          ? `${(report.summary.warningCount ?? 0).toLocaleString()} redirect warn`
          : undefined,
      delta: comparison?.kpis.errorRatePct,
      deltaDecimals: 2,
      deltaUnit: '%',
    },
  ];

  const handleLoadJsonBaselineClick = async () => {
    setCompareMenuOpen(false);
    setCompareError(null);
    if (!onLoadBaselineJson) return;
    const res = await onLoadBaselineJson();
    if (!res) return;
    if (res.error) {
      setCompareError(res.error);
      return;
    }
    if (res.report) {
      if (res.report.id === report.id) {
        setCompareError('Selected JSON file matches the currently open report.');
        return;
      }
      setBaselineReport(res.report);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-app p-4 space-y-4">
      {/* Top Report Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-bold text-tx-primary">{report.title}</h2>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${statusBadgeClass}`}>
              {isRunning && <span className="h-1.5 w-1.5 rounded-full bg-sky-400 animate-ping" />}
              <span className="capitalize">{statusText}</span>
            </span>
            {report.slaResult && (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${
                  report.slaResult.status === 'passed'
                    ? 'border-emerald-500/35 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
                    : 'border-rose-500/35 bg-rose-500/15 text-rose-600 dark:text-rose-300'
                }`}
              >
                {report.slaResult.status === 'passed' ? (
                  <ShieldCheck className="h-3.5 w-3.5" />
                ) : (
                  <ShieldAlert className="h-3.5 w-3.5" />
                )}
                <span>SLA {report.slaResult.status.toUpperCase()}</span>
              </span>
            )}
            <span className="rounded-md border border-line bg-card px-2 py-0.5 text-[11px] font-medium text-tx-muted">
              {engineLabel}
            </span>
            {report.imported && (
              <span
                className="rounded-md border border-violet-500/35 bg-violet-500/10 px-2 py-0.5 text-[11px] font-semibold text-violet-600 dark:text-violet-300"
                title={
                  report.importedFilename
                    ? `Imported from ${report.importedFilename}`
                    : 'Imported report'
                }
              >
                Imported
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-tx-muted">
            <span>{report.configSnapshot.loadProfile.virtualUsers.toLocaleString()} VUs</span>
            <span>•</span>
            <span className="capitalize">{report.configSnapshot.loadProfile.profile.replace('_', ' ')}</span>
            <span>•</span>
            <span>{(report.durationMs / 1000).toFixed(1)}s elapsed</span>
            <span>•</span>
            <span>{new Date(report.startedAt).toLocaleString()}</span>
            {report.configSnapshot.dataFile && (
              <>
                <span>•</span>
                <span className="font-mono text-[11px] text-sky-500">
                  Data: {report.configSnapshot.dataFile.filename} ({report.configSnapshot.dataFile.rowCount.toLocaleString()} rows)
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isRunning ? (
            <button
              type="button"
              onClick={onStopRun}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-rose-600 px-3 text-xs font-semibold text-white hover:bg-rose-500 transition shadow-sm"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
              <span>Stop Test</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={isAnotherRunActive || isSessionOnlyImported}
                onClick={onRunAgain}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-gradient-to-r from-sky-500 to-blue-600 px-3 text-xs font-semibold text-white hover:from-sky-400 hover:to-blue-500 disabled:opacity-45 disabled:cursor-not-allowed transition shadow-sm"
                title={
                  isSessionOnlyImported
                    ? 'Attach this report to a collection to enable running again'
                    : isAnotherRunActive
                      ? 'Another performance test is currently running'
                      : 'Re-run with the same configuration'
                }
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                <span>Run Again</span>
              </button>

              <button
                type="button"
                disabled={isSessionOnlyImported}
                onClick={onBackToSetup}
                title={
                  isSessionOnlyImported
                    ? 'Attach this report to a collection to edit test configuration'
                    : undefined
                }
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-card px-3 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary disabled:opacity-45 disabled:cursor-not-allowed transition"
              >
                <Settings className="h-3.5 w-3.5" />
                <span>Configure</span>
              </button>

              {/* Compare Dropdown */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setCompareMenuOpen((prev) => !prev);
                    setHistoryMenuOpen(false);
                    setExportMenuOpen(false);
                  }}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition ${
                    activeBaseline
                      ? 'border-sky-500/40 bg-sky-500/15 text-sky-600 dark:text-sky-300'
                      : 'border-line bg-card text-tx-secondary hover:bg-hover hover:text-tx-primary'
                  }`}
                >
                  <GitCompareArrows className="h-3.5 w-3.5" />
                  <span>{activeBaseline ? 'Comparing' : 'Compare'}</span>
                  <ChevronDown className="h-3 w-3 opacity-70" />
                </button>

                {compareMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setCompareMenuOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 w-80 rounded-xl border border-line bg-surface p-2 shadow-2xl space-y-2">
                      <div className="flex items-center justify-between gap-2 px-1">
                        <span className="text-xs font-semibold text-tx-primary">Select Baseline Run</span>
                        {activeBaseline && (
                          <button
                            type="button"
                            onClick={() => {
                              setBaselineReport(null);
                              setCompareMenuOpen(false);
                            }}
                            className="text-[11px] font-medium text-rose-500 hover:underline"
                          >
                            Clear compare
                          </button>
                        )}
                      </div>

                      {onLoadBaselineJson && (
                        <button
                          type="button"
                          onClick={() => void handleLoadJsonBaselineClick()}
                          className="flex w-full items-center gap-2 rounded-lg border border-dashed border-line bg-element/40 px-2.5 py-2 text-xs font-medium text-sky-600 dark:text-sky-300 hover:bg-hover transition"
                        >
                          <Upload className="h-3.5 w-3.5" />
                          <span>Load JSON Baseline File...</span>
                        </button>
                      )}

                      <label className="flex items-center gap-1.5 px-1 text-[11px] text-tx-muted cursor-pointer">
                        <input
                          type="checkbox"
                          checked={compareShowAllWorkspace}
                          onChange={(e) => setCompareShowAllWorkspace(e.target.checked)}
                          className="h-3.5 w-3.5 accent-sky-500"
                        />
                        <span>Show all workspace runs</span>
                      </label>

                      <div className="max-h-56 overflow-y-auto space-y-1">
                        {compareCandidates.length === 0 ? (
                          <div className="px-2 py-3 text-center text-[11px] text-tx-muted">
                            No other runs match this filter.
                          </div>
                        ) : (
                          compareCandidates.map((cand) => (
                            <button
                              key={cand.id}
                              type="button"
                              onClick={() => {
                                setCompareError(null);
                                setBaselineReport(cand);
                                setCompareMenuOpen(false);
                              }}
                              className={`w-full rounded-lg px-2.5 py-2 text-left text-xs transition ${
                                activeBaseline?.id === cand.id
                                  ? 'bg-sky-500/15 text-tx-primary'
                                  : 'hover:bg-hover text-tx-secondary'
                              }`}
                            >
                              <div className="truncate font-semibold">{cand.title}</div>
                              <div className="text-[10px] text-tx-muted">
                                {new Date(cand.startedAt).toLocaleString()} • {cand.configSnapshot.loadProfile.virtualUsers} VUs • {cand.summary.requestsPerSec.toFixed(1)}/s
                              </div>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Runs History */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setHistoryMenuOpen((prev) => !prev);
                    setCompareMenuOpen(false);
                    setExportMenuOpen(false);
                  }}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
                >
                  <History className="h-3.5 w-3.5" />
                  <span>Runs ({recentReports.length})</span>
                  <ChevronDown className="h-3 w-3 opacity-70" />
                </button>

                {historyMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setHistoryMenuOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 w-76 max-h-80 overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-2xl">
                      {onImportReportFile && (
                        <button
                          type="button"
                          onClick={() => {
                            setHistoryMenuOpen(false);
                            onImportReportFile();
                          }}
                          className="mb-1.5 flex w-full items-center gap-2 rounded-lg border border-dashed border-sky-500/35 bg-sky-500/5 px-2.5 py-2 text-left text-xs font-medium text-sky-600 dark:text-sky-300 hover:bg-sky-500/15 transition"
                        >
                          <Upload className="h-3.5 w-3.5 shrink-0" />
                          <span>Import Report (.airrest-report.json)...</span>
                        </button>
                      )}
                      {recentReports.length === 0 ? (
                        <div className="px-3 py-4 text-center text-xs text-tx-muted">No saved runs in this workspace yet.</div>
                      ) : (
                        recentReports.map((item) => (
                          <div
                            key={item.id}
                            className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs transition ${
                              item.id === report.id ? 'bg-sky-500/15 text-tx-primary' : 'hover:bg-hover text-tx-secondary'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                setHistoryMenuOpen(false);
                                onSelectHistoryReport(item);
                              }}
                              className="min-w-0 flex-1 text-left"
                            >
                              <div className="flex items-center gap-1.5 font-semibold">
                                <span className="truncate">{item.title}</span>
                                {item.imported && (
                                  <span className="shrink-0 rounded border border-violet-500/30 bg-violet-500/10 px-1 py-px text-[9px] font-semibold text-violet-600 dark:text-violet-300">
                                    Imported
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-tx-muted">
                                {new Date(item.startedAt).toLocaleString()} • {item.summary.totalRequests} reqs • {item.summary.errorRatePct.toFixed(1)}% err
                              </div>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDeleteHistoryReport(item.id);
                              }}
                              className="rounded p-1 text-tx-muted hover:bg-rose-500/15 hover:text-rose-500"
                              title="Delete saved run"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* Unified Export Dropdown */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setExportMenuOpen((prev) => !prev);
                    setCompareMenuOpen(false);
                    setHistoryMenuOpen(false);
                  }}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
                >
                  <Download className="h-3.5 w-3.5 text-sky-500" />
                  <span>Export</span>
                  <ChevronDown className="h-3 w-3 opacity-70" />
                </button>

                {exportMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setExportMenuOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 w-64 rounded-xl border border-line bg-surface p-1.5 shadow-2xl space-y-0.5 text-xs">
                      {onShareReport && (
                        <button
                          type="button"
                          onClick={() => {
                            setExportMenuOpen(false);
                            onShareReport(report);
                          }}
                          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left font-medium text-sky-600 dark:text-sky-300 hover:bg-sky-500/10"
                        >
                          <Share2 className="h-3.5 w-3.5 shrink-0" />
                          <span>Share (.airrest-report.json)</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setExportMenuOpen(false);
                          onExportHtml(report, activeBaseline);
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-tx-secondary hover:bg-hover hover:text-tx-primary"
                      >
                        <FileCode2 className="h-3.5 w-3.5 text-sky-500" />
                        <span>HTML Report{activeBaseline ? ' (+ Compare)' : ''}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setExportMenuOpen(false);
                          onExportJson(report);
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-tx-secondary hover:bg-hover hover:text-tx-primary"
                      >
                        <Download className="h-3.5 w-3.5 text-emerald-500" />
                        <span>JSON Report Data</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setExportMenuOpen(false);
                          onExportEndpointsCsv(report);
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-tx-secondary hover:bg-hover hover:text-tx-primary"
                      >
                        <FileSpreadsheet className="h-3.5 w-3.5 text-amber-500" />
                        <span>CSV — Endpoint Summary</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setExportMenuOpen(false);
                          onExportTimeSeriesCsv(report);
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-tx-secondary hover:bg-hover hover:text-tx-primary"
                      >
                        <FileSpreadsheet className="h-3.5 w-3.5 text-violet-500" />
                        <span>CSV — Time-Series (1s)</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Compare Error Banner */}
      {compareError && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-rose-500/35 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-600 dark:text-rose-300">
          <span>{compareError}</span>
          <button type="button" onClick={() => setCompareError(null)} className="rounded p-0.5 hover:bg-rose-500/20">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {isSessionOnlyImported && (
        <SessionOnlyReportBanner
          reason={sessionOnlyReason}
          availableCollections={availableCollections}
          onAttachToCollection={onAttachToCollection}
        />
      )}

      {/* Auto-Abort Banner */}
      {report.autoAborted && (
        <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/35 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-700 dark:text-rose-300">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-semibold">Test Auto-Aborted Due to SLA Breach</div>
            {report.slaResult?.autoAbortedReason && <div className="mt-0.5">{report.slaResult.autoAbortedReason}</div>}
          </div>
        </div>
      )}

      {/* Failure & Warning Banners */}
      {report.status === 'failed' && report.failureReason && (
        <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/35 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-700 dark:text-rose-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-semibold">Performance Run Failed</div>
            <div className="mt-0.5">{report.failureReason}</div>
          </div>
        </div>
      )}

      {report.warnings && report.warnings.length > 0 && (
        <div className="space-y-1">
          {report.warnings.map((w, idx) => (
            <div
              key={idx}
              className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* Pre-run Setup Result Strip */}
      {report.setupResults && report.setupResults.length > 0 && (
        <div className="rounded-xl border border-line bg-card p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-tx-primary">
            <div className="flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5 text-amber-500" />
              <span>Pre-run Setup Steps (Executed 1x before load)</span>
            </div>
            {report.setupRefreshStats && report.setupRefreshStats.attempts > 0 && (
              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-600 dark:text-amber-300">
                Live refreshed {report.setupRefreshStats.successes}×
                {report.setupRefreshStats.failures > 0 ? ` (${report.setupRefreshStats.failures} failed)` : ''}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {report.setupResults.map((step, idx) => (
              <div
                key={idx}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-1 text-xs ${
                  step.success
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
                }`}
              >
                {step.success ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
                <MethodBadge method={step.method} size="sm" />
                <span className="font-medium">{step.name}</span>
                <span className="font-mono text-[11px] opacity-85">
                  {step.status > 0 ? `HTTP ${step.status}` : 'Error'} • {step.timeMs} ms
                </span>
                {step.updatedVariables.length > 0 && (
                  <span className="rounded bg-black/15 px-1.5 py-0.5 font-mono text-[10px]">
                    vars: {step.updatedVariables.join(', ')}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Report Sub-tabs: Summary / Errors */}
      <div className="flex items-center gap-4 border-b border-line text-xs font-semibold">
        <button
          type="button"
          onClick={() => setActiveTab('summary')}
          className={`border-b-2 pb-2 transition ${
            activeTab === 'summary'
              ? 'border-sky-500 text-tx-primary'
              : 'border-transparent text-tx-muted hover:text-tx-primary'
          }`}
        >
          Summary
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('errors')}
          className={`flex items-center gap-1.5 border-b-2 pb-2 transition ${
            activeTab === 'errors'
              ? 'border-rose-500 text-tx-primary'
              : 'border-transparent text-tx-muted hover:text-tx-primary'
          }`}
        >
          <span>Errors</span>
          <span
            className={`rounded-full px-1.5 py-0.2 font-mono text-[10px] ${
              report.summary.errorCount > 0
                ? 'bg-rose-500/20 text-rose-600 dark:text-rose-300'
                : 'bg-element text-tx-muted'
            }`}
          >
            {report.summary.errorCount}
          </span>
        </button>
      </div>

      {activeTab === 'summary' ? (
        <div className="space-y-4">
          {/* Active Baseline Compare Banner */}
          {activeBaseline && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-500/30 bg-sky-500/10 px-3.5 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2 text-tx-primary">
                <GitCompareArrows className="h-4 w-4 text-sky-500" />
                <span>
                  Comparing with baseline: <strong>{activeBaseline.title}</strong>
                </span>
                <span className="text-tx-muted">
                  ({new Date(activeBaseline.startedAt).toLocaleString()} • {activeBaseline.configSnapshot.loadProfile.virtualUsers} VUs)
                </span>
              </div>
              <button
                type="button"
                onClick={() => setBaselineReport(null)}
                className="inline-flex items-center gap-1 rounded-md border border-line bg-card px-2 py-1 text-[11px] font-medium text-tx-secondary hover:bg-hover"
              >
                <X className="h-3 w-3" />
                <span>Clear</span>
              </button>
            </div>
          )}

          {/* SLA Threshold Results Card */}
          {report.slaResult && (
            <div className="rounded-xl border border-line bg-card p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-tx-primary">
                  {report.slaResult.status === 'passed' ? (
                    <ShieldCheck className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <ShieldAlert className="h-4 w-4 text-rose-500" />
                  )}
                  <span>
                    SLA Thresholds ({report.slaResult.passedCount}/{report.slaResult.totalCount} Passed
                    {(report.slaResult.inconclusiveCount ?? 0) > 0
                      ? `, ${report.slaResult.inconclusiveCount} Not Evaluated`
                      : ''}
                    )
                  </span>
                </div>
                <span
                  className={`font-mono text-[11px] font-bold ${
                    report.slaResult.status === 'passed' ? 'text-emerald-500' : 'text-rose-500'
                  }`}
                >
                  {report.slaResult.status.toUpperCase()}
                </span>
              </div>

              <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
                {report.slaResult.results.map((r) => (
                  <div
                    key={r.ruleId}
                    className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
                      r.notEvaluated
                        ? 'border-amber-500/30 bg-amber-500/10 text-tx-primary'
                        : r.passed
                          ? 'border-emerald-500/25 bg-emerald-500/5 text-tx-primary'
                          : 'border-rose-500/30 bg-rose-500/10 text-tx-primary'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {r.notEvaluated ? (
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                      ) : r.passed ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
                      )}
                      <div className="min-w-0">
                        <div className="truncate font-medium">{r.targetLabel}</div>
                        <div className="font-mono text-[10px] text-tx-muted">
                          {formatThresholdRuleExpression(r)}
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0 text-right font-mono text-[11px]">
                      {r.notEvaluated ? (
                        <>
                          <div className="font-semibold text-amber-600 dark:text-amber-300">Not evaluated</div>
                          <div className="text-[10px] text-tx-muted">0 samples</div>
                        </>
                      ) : (
                        <>
                          <div className={r.passed ? 'font-semibold text-emerald-500' : 'font-bold text-rose-500'}>
                            actual: {r.actual}
                          </div>
                          {r.triggeredAbort && (
                            <div className="text-[10px] font-semibold text-rose-500">Auto-aborted</div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Summary KPI Strip */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-8">
            {kpiItems.map((kpi) => (
              <div key={kpi.label} className="rounded-xl border border-line bg-card px-3 py-2.5">
                <div className="text-[11px] text-tx-muted">{kpi.label}</div>
                <div className={`mt-1 font-mono text-lg font-bold tabular-nums ${kpi.tone}`}>{kpi.value}</div>
                {kpi.delta ? (
                  <div className={`mt-0.5 font-mono text-[10px] font-semibold ${deltaToneClass(kpi.delta)}`}>
                    {formatDeltaCompact(kpi.delta, kpi.deltaDecimals ?? 0, kpi.deltaUnit ?? '')}
                  </div>
                ) : (
                  kpi.subcaption && <div className="mt-0.5 font-mono text-[10px] text-tx-faint">{kpi.subcaption}</div>
                )}
              </div>
            ))}
          </div>

          {/* Multi-Axis Time-Series Chart */}
          <div className="rounded-xl border border-line bg-card p-3.5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-tx-primary">
                <Activity className="h-4 w-4 text-sky-500" />
                <span>Throughput, Latency &amp; Error Rate</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={requestFilterId}
                  onChange={(e) => setRequestFilterId(e.target.value)}
                  className="h-8 rounded-lg border border-line bg-element px-2.5 text-xs text-tx-primary focus:border-sky-500 focus:outline-none"
                >
                  <option value="all">Filter by requests (All)</option>
                  {report.endpoints.map((ep) => (
                    <option key={ep.requestId} value={ep.requestId}>
                      {ep.method} {ep.name}
                    </option>
                  ))}
                </select>

                <select
                  value={latencyMetric}
                  onChange={(e) => setLatencyMetric(e.target.value as PerformanceLatencyMetric)}
                  className="h-8 rounded-lg border border-line bg-element px-2.5 text-xs text-tx-primary focus:border-sky-500 focus:outline-none"
                >
                  {LATENCY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="relative">
              {chartPoints.length === 0 ? (
                <div className="flex h-[240px] items-center justify-center text-xs text-tx-muted">
                  {isRunning ? 'Collecting first second of traffic metrics...' : 'No time-series data recorded.'}
                </div>
              ) : (
                <svg
                  viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                  className="h-[250px] w-full select-none overflow-visible"
                  onMouseLeave={() => setHoverIndex(null)}
                  onMouseMove={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    if (rect.width <= 0 || chartPoints.length === 0) return;
                    const svgX = ((e.clientX - rect.left) / rect.width) * CHART_W;
                    const norm = Math.max(0, Math.min(1, (svgX - CHART_PAD.left) / PLOT_W));
                    const idx =
                      chartPoints.length === 1 ? 0 : Math.round(norm * (chartPoints.length - 1));
                    setHoverIndex(idx);
                  }}
                >
                  {/* Grid & Multi-Axis Labels */}
                  {[0, 0.25, 0.5, 0.75, 1].map((f) => {
                    const y = CHART_PAD.top + PLOT_H * (1 - f);
                    return (
                      <g key={f}>
                        <line
                          x1={CHART_PAD.left}
                          y1={y}
                          x2={CHART_W - CHART_PAD.right}
                          y2={y}
                          stroke="currentColor"
                          className="text-line"
                          strokeDasharray="2 4"
                        />
                        <text x={CHART_PAD.left - 8} y={y + 3} textAnchor="end" fontSize="10" className="fill-rose-500 font-mono">
                          {Math.round(f * 100)}%
                        </text>
                        <text x={CHART_W - CHART_PAD.right + 8} y={y + 3} textAnchor="start" fontSize="10" className="fill-sky-500 font-mono">
                          {Math.round(f * maxLat)} ms
                        </text>
                        <text x={CHART_W - CHART_PAD.right + 64} y={y + 3} textAnchor="start" fontSize="10" className="fill-amber-500 font-mono">
                          {Math.round(f * maxRps)}/s
                        </text>
                      </g>
                    );
                  })}

                  {/* X-axis timestamps or elapsed seconds */}
                  {xTickIndices.map((idx) => (
                    <text
                      key={idx}
                      x={xOf(idx)}
                      y={CHART_PAD.top + PLOT_H + 18}
                      textAnchor="middle"
                      fontSize="10"
                      className="fill-tx-muted font-mono"
                    >
                      {activeBaseline ? chartPoints[idx]?.elapsedLabel : chartPoints[idx]?.timeLabel}
                    </text>
                  ))}

                  {/* Baseline Overlay Curves (dashed) */}
                  {activeBaseline && (
                    <>
                      <polyline
                        points={polyline((p) => yLat(p.baseLatencyMs), (p) => p.hasBase)}
                        fill="none"
                        stroke="#0ea5e9"
                        strokeWidth="1.5"
                        strokeDasharray="5 4"
                        opacity="0.5"
                      />
                      <polyline
                        points={polyline((p) => yRps(p.baseRps), (p) => p.hasBase)}
                        fill="none"
                        stroke="#f59e0b"
                        strokeWidth="1.5"
                        strokeDasharray="5 4"
                        opacity="0.5"
                      />
                    </>
                  )}

                  {/* Current Curves */}
                  <polyline
                    points={polyline((p) => yVu(p.virtualUsers))}
                    fill="none"
                    stroke="currentColor"
                    className="text-tx-faint"
                    strokeWidth="1.5"
                    opacity="0.55"
                  />
                  <polyline
                    points={polyline((p) => yErr(p.errorRatePct))}
                    fill="none"
                    stroke="#f43f5e"
                    strokeWidth="2"
                  />
                  <polyline
                    points={polyline((p) => yLat(p.latencyMs))}
                    fill="none"
                    stroke="#0ea5e9"
                    strokeWidth="2"
                  />
                  <polyline
                    points={polyline((p) => yRps(p.rps))}
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth="2"
                  />

                  {/* Hover Crosshair & Dots */}
                  {hoveredPoint && hoverIndex !== null && (
                    <g>
                      <line
                        x1={xOf(hoverIndex)}
                        y1={CHART_PAD.top}
                        x2={xOf(hoverIndex)}
                        y2={CHART_PAD.top + PLOT_H}
                        stroke="currentColor"
                        className="text-tx-muted"
                        strokeDasharray="3 3"
                      />
                      {hoveredPoint.hasCur && (
                        <>
                          <circle cx={xOf(hoverIndex)} cy={yRps(hoveredPoint.rps)} r="4" fill="#f59e0b" />
                          <circle cx={xOf(hoverIndex)} cy={yLat(hoveredPoint.latencyMs)} r="4" fill="#0ea5e9" />
                          <circle cx={xOf(hoverIndex)} cy={yErr(hoveredPoint.errorRatePct)} r="4" fill="#f43f5e" />
                        </>
                      )}
                    </g>
                  )}
                </svg>
              )}

              {hoveredPoint && (
                <div className="pointer-events-none mt-1 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-element/80 px-3 py-1.5 font-mono text-[11px] text-tx-primary">
                  <span className="font-semibold">
                    {hoveredPoint.timeLabel} ({hoveredPoint.elapsedLabel})
                  </span>
                  <span>VUs: {hoveredPoint.virtualUsers}</span>
                  <span className="text-amber-500">
                    Req/s: {hoveredPoint.rps}
                    {activeBaseline && hoveredPoint.hasBase ? ` (base ${hoveredPoint.baseRps})` : ''}
                  </span>
                  <span className="text-sky-500">
                    {activeLatencyLabel}: {hoveredPoint.latencyMs} ms
                    {activeBaseline && hoveredPoint.hasBase ? ` (base ${hoveredPoint.baseLatencyMs} ms)` : ''}
                  </span>
                  <span className="text-rose-500">
                    Error: {hoveredPoint.errorRatePct.toFixed(2)}%
                    {activeBaseline && hoveredPoint.hasBase ? ` (base ${hoveredPoint.baseErrorRatePct.toFixed(2)}%)` : ''}
                  </span>
                </div>
              )}
            </div>

            <div className="mt-2.5 flex flex-wrap items-center justify-end gap-4 text-[11px] text-tx-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-0.5 w-3 bg-amber-500" />
                <span>Requests/second</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-0.5 w-3 bg-sky-500" />
                <span>{activeLatencyLabel}</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-0.5 w-3 bg-rose-500" />
                <span>Error rate</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-0.5 w-3 bg-tx-faint" />
                <span>Virtual users</span>
              </span>
              {activeBaseline && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 border-t-2 border-dashed border-tx-muted" />
                  <span>Baseline (dashed)</span>
                </span>
              )}
            </div>
          </div>

          {/* Endpoint Breakdown Table */}
          <div className="rounded-xl border border-line bg-card overflow-hidden">
            <div className="border-b border-line px-4 py-2.5 text-xs font-semibold text-tx-primary">
              Performance details for total duration
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-line bg-element/50 text-tx-muted">
                    <th className="px-3 py-2 text-left font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">Request</th>
                    <th className="px-3 py-2 text-right font-medium">Total requests</th>
                    <th className="px-3 py-2 text-right font-medium">Requests/s</th>
                    <th className="px-3 py-2 text-right font-medium">Max Req/s</th>
                    <th className="px-3 py-2 text-right font-medium">Error %</th>
                    <th className="px-3 py-2 text-right font-medium">Resp. time (Avg. ms)</th>
                    <th className="px-3 py-2 text-right font-medium">Min (ms)</th>
                    <th className="px-3 py-2 text-right font-medium">Max (ms)</th>
                    <th className="px-3 py-2 text-right font-medium">90th (ms)</th>
                    <th className="px-3 py-2 text-right font-medium">95th (ms)</th>
                    <th className="px-3 py-2 text-right font-medium">99th (ms)</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison ? (
                    comparison.endpoints.map((row, idx) => {
                      const ep = row.current || row.baseline!;
                      const isRemoved = row.matchStatus === 'removed';
                      const errBgOpacity =
                        !isRemoved && ep.errorRatePct > 0 ? Math.min(0.45, 0.14 + ep.errorRatePct / 150) : 0;
                      const maxRpsVal = isRemoved ? row.baselineMaxRps : row.currentMaxRps;
                      return (
                        <tr
                          key={row.key}
                          className={`border-b border-line/60 ${isRemoved ? 'opacity-55' : 'hover:bg-hover/40'}`}
                        >
                          <td className="px-3 py-2.5 font-mono text-tx-faint">{idx + 1}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              <MethodBadge method={ep.method} size="sm" />
                              <span className="font-medium text-tx-primary" title={ep.path}>
                                {ep.name}
                              </span>
                              {row.matchStatus === 'new' && (
                                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-500">
                                  New
                                </span>
                              )}
                              {row.matchStatus === 'removed' && (
                                <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-rose-500">
                                  Removed
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-tx-primary">
                            <div>{ep.totalRequests.toLocaleString()}</div>
                            {row.deltas && (
                              <div className="text-[10px] text-tx-faint">
                                {formatDeltaCompact(row.deltas.totalRequests, 0)}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-tx-primary">
                            <div>{ep.requestsPerSec.toFixed(2)}</div>
                            {row.deltas && (
                              <div className={`text-[10px] ${deltaToneClass(row.deltas.requestsPerSec)}`}>
                                {formatDeltaCompact(row.deltas.requestsPerSec, 2)}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-amber-500">
                            <div>{maxRpsVal.toLocaleString()}</div>
                            {row.deltas && (
                              <div className={`text-[10px] font-normal ${deltaToneClass(row.deltas.maxRequestsPerSec)}`}>
                                {formatDeltaCompact(row.deltas.maxRequestsPerSec, 0)}
                              </div>
                            )}
                          </td>
                          <td
                            className={`px-3 py-2 text-right font-mono tabular-nums ${
                              !isRemoved && ep.errorRatePct > 0 ? 'font-bold text-rose-600 dark:text-rose-200' : 'text-tx-secondary'
                            }`}
                            style={
                              errBgOpacity > 0
                                ? { backgroundColor: `rgba(244, 63, 94, ${errBgOpacity.toFixed(2)})` }
                                : undefined
                            }
                          >
                            <div>{ep.errorRatePct.toFixed(2)}</div>
                            {row.deltas && (
                              <div className={`text-[10px] font-normal ${deltaToneClass(row.deltas.errorRatePct)}`}>
                                {formatDeltaCompact(row.deltas.errorRatePct, 2, '%')}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-tx-primary">
                            <div>{ep.avgMs}</div>
                            {row.deltas && (
                              <div className={`text-[10px] ${deltaToneClass(row.deltas.avgMs)}`}>
                                {formatDeltaCompact(row.deltas.avgMs, 0, 'ms')}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-tx-secondary">{ep.minMs}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-tx-secondary">{ep.maxMs}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-tx-primary">
                            <div>{ep.p90Ms}</div>
                            {row.deltas && (
                              <div className={`text-[10px] ${deltaToneClass(row.deltas.p90Ms)}`}>
                                {formatDeltaCompact(row.deltas.p90Ms, 0, 'ms')}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-tx-primary">
                            <div>{ep.p95Ms}</div>
                            {row.deltas && (
                              <div className={`text-[10px] ${deltaToneClass(row.deltas.p95Ms)}`}>
                                {formatDeltaCompact(row.deltas.p95Ms, 0, 'ms')}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-tx-primary">
                            <div>{ep.p99Ms}</div>
                            {row.deltas && (
                              <div className={`text-[10px] ${deltaToneClass(row.deltas.p99Ms)}`}>
                                {formatDeltaCompact(row.deltas.p99Ms, 0, 'ms')}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    report.endpoints.map((ep, idx) => {
                      const errBgOpacity = ep.errorRatePct > 0 ? Math.min(0.45, 0.14 + ep.errorRatePct / 150) : 0;
                      const epMaxRps = peakMetrics.byRequestMaxRps[ep.requestId] ?? ep.maxRequestsPerSec ?? 0;
                      return (
                        <tr key={ep.requestId} className="border-b border-line/60 hover:bg-hover/40">
                          <td className="px-3 py-2.5 font-mono text-tx-faint">{idx + 1}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              <MethodBadge method={ep.method} size="sm" />
                              <span className="font-medium text-tx-primary" title={ep.path}>
                                {ep.name}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums text-tx-primary">
                            {ep.totalRequests.toLocaleString()}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums text-tx-primary">
                            {ep.requestsPerSec.toFixed(2)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono font-semibold tabular-nums text-amber-500">
                            {epMaxRps.toLocaleString()}
                          </td>
                          <td
                            className={`px-3 py-2.5 text-right font-mono tabular-nums ${
                              ep.errorRatePct > 0 ? 'font-bold text-rose-600 dark:text-rose-200' : 'text-tx-secondary'
                            }`}
                            style={
                              errBgOpacity > 0
                                ? { backgroundColor: `rgba(244, 63, 94, ${errBgOpacity.toFixed(2)})` }
                                : undefined
                            }
                          >
                            {ep.errorRatePct.toFixed(2)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums text-tx-primary">{ep.avgMs}</td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums text-tx-secondary">{ep.minMs}</td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums text-tx-secondary">{ep.maxMs}</td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums text-tx-primary">{ep.p90Ms}</td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums text-tx-primary">{ep.p95Ms}</td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums text-tx-primary">{ep.p99Ms}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        /* Errors Tab */
        <div className="space-y-4">
          {report.errorGroups.length === 0 ? (
            <div className="rounded-xl border border-line bg-card p-8 text-center text-xs text-tx-muted">
              No errors recorded during this run.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {report.errorGroups.map((grp) => (
                  <div
                    key={grp.key}
                    className="rounded-xl border border-rose-500/25 bg-rose-500/5 px-3.5 py-2.5 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-rose-600 dark:text-rose-300">{grp.label}</span>
                      <span className="rounded-full bg-rose-500/20 px-2 py-0.5 font-mono text-[11px] font-bold text-rose-600 dark:text-rose-300">
                        {grp.count.toLocaleString()}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-tx-muted">Category: {grp.category}</div>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-line bg-card p-3.5 space-y-2.5">
                <div className="text-xs font-semibold text-tx-primary">
                  Captured Error Samples (showing up to {report.errorSamples.length})
                </div>
                {report.errorSamples.map((sample) => (
                  <div
                    key={sample.id}
                    className="rounded-lg border border-line bg-element/40 p-3 text-xs space-y-1.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <MethodBadge method={sample.method} size="sm" />
                        <span className="font-semibold text-tx-primary">{sample.requestName}</span>
                        <span className="truncate font-mono text-[11px] text-tx-muted">{sample.url}</span>
                      </div>
                      <span className="font-mono text-[11px] text-rose-500">
                        {sample.status > 0 ? `HTTP ${sample.status}` : sample.statusText} • {sample.timeMs} ms
                      </span>
                    </div>
                    <div className="text-[11px] text-rose-600 dark:text-rose-300">{sample.message}</div>
                    {sample.responseSnippet && (
                      <pre className="max-h-36 overflow-auto rounded border border-line bg-app p-2 font-mono text-[11px] text-tx-secondary whitespace-pre-wrap break-all">
                        {sample.responseSnippet}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
