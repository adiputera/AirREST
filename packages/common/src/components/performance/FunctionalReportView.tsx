import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Database,
  Download,
  FileCode2,
  FlaskConical,
  History,
  Info,
  Play,
  RotateCcw,
  Search,
  Settings,
  Share2,
  Square,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import type {
  Collection,
  FunctionalRunReport,
  FunctionalStepResult,
  FunctionalStepStatus,
} from '../../types/api';
import { getFunctionalCapturedExchange } from '../../lib/functionalSessionStore';
import { MethodBadge } from '../MethodBadge';
import { SessionOnlyReportBanner } from './SessionOnlyReportBanner';

interface FunctionalReportViewProps {
  report: FunctionalRunReport;
  recentReports: FunctionalRunReport[];
  isAnotherRunActive: boolean;
  isSessionOnlyImported?: boolean;
  sessionOnlyReason?: string;
  availableCollections?: Collection[];
  onStopRun: () => void;
  onRunAgain: () => void;
  onRerunFailed: (payload: {
    failedItemIds: string[];
    sourceReportId: string;
    onlyIterations?: number[];
  }) => void;
  onBackToSetup: () => void;
  onSelectHistoryReport: (report: FunctionalRunReport) => void;
  onDeleteHistoryReport: (reportId: string) => void;
  onExportHtml: (report: FunctionalRunReport) => void;
  onExportJson: (report: FunctionalRunReport) => void;
  onExportJunitXml: (report: FunctionalRunReport) => void;
  onShareReport?: (report: FunctionalRunReport) => void;
  onImportReportFile?: () => void;
  onAttachToCollection?: (collection: Collection) => void;
}

type StepFilter = 'all' | FunctionalStepStatus;
type InspectorTab = 'tests' | 'response' | 'request' | 'data';

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function tryPrettyBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return raw;
  }
}

export const FunctionalReportView: React.FC<FunctionalReportViewProps> = ({
  report,
  recentReports,
  isAnotherRunActive,
  isSessionOnlyImported = false,
  sessionOnlyReason,
  availableCollections = [],
  onStopRun,
  onRunAgain,
  onRerunFailed,
  onBackToSetup,
  onSelectHistoryReport,
  onDeleteHistoryReport,
  onExportHtml,
  onExportJson,
  onExportJunitXml,
  onShareReport,
  onImportReportFile,
  onAttachToCollection,
}) => {
  const [statusFilter, setStatusFilter] = useState<StepFilter>('all');
  const [iterFilter, setIterFilter] = useState<number | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('tests');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const isRunning = report.status === 'running';
  const hasFailures =
    report.requestsFailed > 0 || report.requestsErrored > 0 || report.testsFailed > 0;

  const iterationNumbers = useMemo(() => {
    const set = new Set<number>();
    for (const s of report.steps) set.add(s.iteration);
    return Array.from(set).sort((a, b) => a - b);
  }, [report.steps]);

  const filteredSteps = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return report.steps.filter((s) => {
      if (statusFilter !== 'all' && s.status !== statusFilter) return false;
      if (iterFilter !== 'all' && s.iteration !== iterFilter) return false;
      if (q) {
        const hay = `${s.name} ${s.url} ${s.method} ${s.testResults.map((t) => t.name).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [report.steps, statusFilter, iterFilter, searchQuery]);

  const groupedByIteration = useMemo(() => {
    const map = new Map<number, FunctionalStepResult[]>();
    for (const step of filteredSteps) {
      const list = map.get(step.iteration) || [];
      list.push(step);
      map.set(step.iteration, list);
    }
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  }, [filteredSteps]);

  const selectedStep = useMemo(
    () => report.steps.find((s) => s.id === selectedStepId) || null,
    [report.steps, selectedStepId]
  );

  const capturedExchange = selectedStep?.hasCapturedExchange
    ? getFunctionalCapturedExchange(report.id, selectedStep.id)
    : undefined;

  const statusBadge = (() => {
    if (isRunning) {
      return {
        label: 'Running',
        cls: 'border-emerald-500/35 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
      };
    }
    if (report.status === 'stopped') {
      return {
        label: 'Stopped',
        cls: 'border-amber-500/35 bg-amber-500/15 text-amber-700 dark:text-amber-300',
      };
    }
    if (hasFailures || report.status === 'failed') {
      return {
        label: 'Failed',
        cls: 'border-rose-500/35 bg-rose-500/15 text-rose-600 dark:text-rose-300',
      };
    }
    if ((report.requestsWarned ?? 0) > 0) {
      return {
        label: 'Passed (Warnings)',
        cls: 'border-amber-500/35 bg-amber-500/15 text-amber-700 dark:text-amber-300',
      };
    }
    return {
      label: 'All Passed',
      cls: 'border-emerald-500/35 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
    };
  })();

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app">
      {/* Header Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-line bg-surface px-4 py-2.5 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-500 border border-emerald-500/25">
            <FlaskConical className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-sm font-bold text-tx-primary">{report.title}</h2>
              <span className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase ${statusBadge.cls}`}>
                {statusBadge.label}
              </span>
              <span className="rounded bg-element px-1.5 py-0.5 font-mono text-[10px] text-tx-muted">
                Functional
              </span>
              {report.imported && (
                <span
                  className="rounded-md border border-violet-500/35 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-violet-600 dark:text-violet-300"
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
            <p className="text-[11px] text-tx-muted">
              {report.completedIterations}/{report.plannedIterations} iterations •{' '}
              {(report.durationMs / 1000).toFixed(2)}s • {new Date(report.startedAt).toLocaleString()}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {isRunning ? (
            <button
              type="button"
              onClick={onStopRun}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-rose-600 px-3 text-xs font-semibold text-white hover:bg-rose-500 transition"
            >
              <Square className="h-3 w-3 fill-current" />
              <span>Stop Run</span>
            </button>
          ) : (
            <>
              {report.failedItemIds.length > 0 && (
                <button
                  type="button"
                  disabled={isAnotherRunActive || isSessionOnlyImported}
                  onClick={() =>
                    onRerunFailed({
                      failedItemIds: report.failedItemIds,
                      sourceReportId: report.id,
                      onlyIterations:
                        report.dataFile && report.failedIterations && report.failedIterations.length > 0
                          ? report.failedIterations
                          : undefined,
                    })
                  }
                  title={
                    isSessionOnlyImported
                      ? 'Attach this report to a collection to enable re-running requests'
                      : undefined
                  }
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 text-xs font-semibold text-rose-600 dark:text-rose-300 hover:bg-rose-500/20 disabled:opacity-45 disabled:cursor-not-allowed transition"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Re-run Failed ({report.failedItemIds.length})</span>
                </button>
              )}

              <button
                type="button"
                disabled={isAnotherRunActive || isSessionOnlyImported}
                onClick={onRunAgain}
                title={
                  isSessionOnlyImported
                    ? 'Attach this report to a collection to enable running again'
                    : undefined
                }
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-600 px-3 text-xs font-semibold text-white shadow-sm hover:from-emerald-400 hover:to-teal-500 disabled:opacity-45 disabled:cursor-not-allowed transition"
              >
                <Play className="h-3 w-3 fill-current" />
                <span>Run Again</span>
              </button>

              <button
                type="button"
                disabled={isSessionOnlyImported}
                onClick={onBackToSetup}
                title={
                  isSessionOnlyImported
                    ? 'Attach this report to a collection to edit runner configuration'
                    : undefined
                }
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary disabled:opacity-45 disabled:cursor-not-allowed transition"
              >
                <Settings className="h-3.5 w-3.5" />
                <span>Configure</span>
              </button>
            </>
          )}

          {/* History Dropdown */}
          {!isRunning && (recentReports.length > 0 || Boolean(onImportReportFile)) && (
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setHistoryOpen((prev) => !prev);
                  setExportOpen(false);
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
              >
                <History className="h-3.5 w-3.5 text-sky-500" />
                <span>Runs ({recentReports.length})</span>
                <ChevronDown className="h-3 w-3 opacity-70" />
              </button>
              {historyOpen && (
                <div className="absolute right-0 z-30 mt-1.5 w-76 rounded-xl border border-line bg-surface p-1.5 shadow-2xl">
                  {onImportReportFile && (
                    <button
                      type="button"
                      onClick={() => {
                        setHistoryOpen(false);
                        onImportReportFile();
                      }}
                      className="mb-1.5 flex w-full items-center gap-2 rounded-lg border border-dashed border-sky-500/35 bg-sky-500/5 px-2.5 py-2 text-left text-xs font-medium text-sky-600 dark:text-sky-300 hover:bg-sky-500/15 transition"
                    >
                      <Upload className="h-3.5 w-3.5 shrink-0" />
                      <span>Import Report (.airrest-report.json)...</span>
                    </button>
                  )}
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-tx-muted">
                    Saved Functional Runs
                  </div>
                  <div className="max-h-64 space-y-1 overflow-y-auto">
                    {recentReports.length === 0 ? (
                      <div className="px-2.5 py-3 text-center text-[11px] text-tx-muted">
                        No saved runs in this workspace yet.
                      </div>
                    ) : (
                      recentReports.map((r) => {
                        const active = r.id === report.id;
                        const ok = r.requestsFailed === 0 && r.requestsErrored === 0 && r.testsFailed === 0;
                        return (
                          <div
                            key={r.id}
                            className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs transition ${
                              active ? 'bg-emerald-500/15 text-tx-primary' : 'hover:bg-hover text-tx-secondary'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                onSelectHistoryReport(r);
                                setHistoryOpen(false);
                              }}
                              className="min-w-0 flex-1 text-left"
                            >
                              <div className="flex items-center gap-1.5 truncate font-medium">
                                <span
                                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${ok ? 'bg-emerald-500' : 'bg-rose-500'}`}
                                />
                                <span className="truncate">{r.title}</span>
                                {r.imported && (
                                  <span className="shrink-0 rounded border border-violet-500/30 bg-violet-500/10 px-1 py-px text-[9px] font-semibold text-violet-600 dark:text-violet-300">
                                    Imported
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-tx-muted">
                                {r.testsPassed}/{r.totalTests} tests • {new Date(r.startedAt).toLocaleTimeString()}
                              </div>
                            </button>
                            <button
                              type="button"
                              onClick={() => onDeleteHistoryReport(r.id)}
                              className="rounded p-1 text-tx-muted hover:bg-hover hover:text-rose-500"
                              title="Delete saved run"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Unified Export Dropdown */}
          {!isRunning && (
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setExportOpen((prev) => !prev);
                  setHistoryOpen(false);
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
              >
                <Download className="h-3.5 w-3.5 text-emerald-500" />
                <span>Export</span>
                <ChevronDown className="h-3 w-3 opacity-70" />
              </button>
              {exportOpen && (
                <div className="absolute right-0 z-30 mt-1.5 w-60 rounded-xl border border-line bg-surface p-1 shadow-2xl">
                  {onShareReport && (
                    <button
                      type="button"
                      onClick={() => {
                        onShareReport(report);
                        setExportOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-sky-600 dark:text-sky-300 hover:bg-sky-500/10"
                    >
                      <Share2 className="h-3.5 w-3.5 shrink-0" />
                      <span>Share (.airrest-report.json)</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      onExportHtml(report);
                      setExportOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary"
                  >
                    <FileCode2 className="h-3.5 w-3.5 text-sky-500" />
                    <span>HTML Report</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onExportJson(report);
                      setExportOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary"
                  >
                    <Database className="h-3.5 w-3.5 text-amber-500" />
                    <span>JSON Results</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onExportJunitXml(report);
                      setExportOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary"
                  >
                    <FlaskConical className="h-3.5 w-3.5 text-emerald-500" />
                    <span>JUnit XML</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {isSessionOnlyImported && (
        <div className="px-4 pt-3 shrink-0">
          <SessionOnlyReportBanner
            reason={sessionOnlyReason}
            availableCollections={availableCollections}
            onAttachToCollection={onAttachToCollection}
          />
        </div>
      )}

      {/* Banners & KPI Strip */}
      <div className="space-y-3 border-b border-line bg-surface/60 px-4 py-3 shrink-0">
        {report.stopReason && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{report.stopReason}</span>
          </div>
        )}

        {report.stepsTruncated && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>
              Showing {report.steps.length.toLocaleString()} prioritized steps out of{' '}
              {(report.totalStepsRecorded ?? report.totalRequestsExecuted).toLocaleString()} total steps (all failed, errored, and warning steps kept first; summary totals reflect all steps).
            </span>
          </div>
        )}

        {report.captureBudgetExhausted && (
          <div className="flex items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-[11px] text-sky-700 dark:text-sky-300">
            <Info className="h-3.5 w-3.5 shrink-0" />
            <span>
              Session body capture cap (500 steps / 16 MiB) was reached. Later steps kept test results without storing full response bodies.
            </span>
          </div>
        )}

        {report.updatedEnvVars && report.updatedEnvVars.length > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>
              Updated Environment Variables:{' '}
              <span className="font-mono font-semibold">
                {report.updatedEnvVars.map((k) => `{{${k}}}`).join(', ')}
              </span>
            </span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          <div className="rounded-xl border border-line bg-card px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-tx-muted">Iterations</div>
            <div className="mt-0.5 font-mono text-base font-bold text-tx-primary">
              {report.completedIterations}/{report.plannedIterations}
            </div>
          </div>
          <div className="rounded-xl border border-line bg-card px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-tx-muted">Executed</div>
            <div className="mt-0.5 font-mono text-base font-bold text-tx-primary">
              {report.totalRequestsExecuted}
              {report.requestsSkipped > 0 && (
                <span className="ml-1 text-[11px] font-normal text-tx-muted">
                  ({report.requestsSkipped} skip)
                </span>
              )}
            </div>
          </div>
          <div className="rounded-xl border border-line bg-card px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-tx-muted">Tests Passed</div>
            <div className="mt-0.5 font-mono text-base font-bold text-emerald-500">
              {report.testsPassed}
            </div>
          </div>
          <div className="rounded-xl border border-line bg-card px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-tx-muted">Tests Failed</div>
            <div
              className={`mt-0.5 font-mono text-base font-bold ${
                report.testsFailed > 0 ? 'text-rose-500' : 'text-tx-primary'
              }`}
            >
              {report.testsFailed}
            </div>
          </div>
          <div className="rounded-xl border border-line bg-card px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-tx-muted">Req Errors</div>
            <div
              className={`mt-0.5 font-mono text-base font-bold ${
                report.requestsErrored > 0 ? 'text-rose-500' : 'text-tx-primary'
              }`}
            >
              {report.requestsErrored}
            </div>
          </div>
          <div className="rounded-xl border border-line bg-card px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-tx-muted">Avg Latency</div>
            <div className="mt-0.5 font-mono text-base font-bold text-sky-500">
              {report.avgResponseTimeMs} ms
            </div>
          </div>
        </div>

        {/* Filter Row */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex flex-wrap items-center gap-1 text-xs">
            {(
              [
                { id: 'all', label: `All (${report.steps.length})` },
                { id: 'passed', label: `Passed (${report.requestsPassed})` },
                ...((report.requestsWarned ?? 0) > 0
                  ? [{ id: 'warning' as StepFilter, label: `Warning (${report.requestsWarned ?? 0})` }]
                  : []),
                { id: 'failed', label: `Failed (${report.requestsFailed})` },
                { id: 'error', label: `Error (${report.requestsErrored})` },
                { id: 'skipped', label: `Skipped (${report.requestsSkipped})` },
              ] as Array<{ id: StepFilter; label: string }>
            ).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setStatusFilter(f.id)}
                className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition ${
                  statusFilter === f.id
                    ? 'border-emerald-500 bg-emerald-500/15 text-tx-primary font-semibold'
                    : 'border-line bg-card text-tx-muted hover:bg-hover hover:text-tx-primary'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {iterationNumbers.length > 1 && (
              <select
                value={iterFilter === 'all' ? 'all' : String(iterFilter)}
                onChange={(e) =>
                  setIterFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))
                }
                className="h-7 rounded-lg border border-line bg-card px-2 text-xs text-tx-secondary focus:border-emerald-500 focus:outline-none"
              >
                <option value="all">All Iterations ({iterationNumbers.length})</option>
                {iterationNumbers.map((n) => (
                  <option key={n} value={n}>
                    Iteration {n}
                  </option>
                ))}
              </select>
            )}

            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-tx-faint" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter requests or tests..."
                className="h-7 w-48 rounded-lg border border-line bg-card pl-7 pr-2 text-xs text-tx-primary focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Main Split: Steps List + Optional Detail Inspector */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-y-auto p-4 space-y-4">
          {groupedByIteration.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line p-8 text-center text-xs text-tx-muted">
              {isRunning ? 'Starting functional run...' : 'No steps match the active filter.'}
            </div>
          ) : (
            groupedByIteration.map(([iterNum, iterSteps]) => (
              <div key={iterNum} className="overflow-hidden rounded-xl border border-line bg-surface">
                <div className="flex items-center justify-between border-b border-line bg-element/60 px-3.5 py-2 text-xs">
                  <span className="font-semibold text-tx-primary">Iteration {iterNum}</span>
                  <span className="font-mono text-[11px] text-tx-muted">
                    {iterSteps.length} step{iterSteps.length === 1 ? '' : 's'}
                    {iterSteps[0]?.dataRowIndex !== undefined
                      ? ` • Row #${iterSteps[0].dataRowIndex + 1}`
                      : ''}
                  </span>
                </div>

                <div className="divide-y divide-line">
                  {iterSteps.map((step) => {
                    const isSelected = step.id === selectedStepId;
                    const stepErr = step.scriptError || step.errorMessage;
                    return (
                      <div
                        key={step.id}
                        onClick={() => setSelectedStepId(isSelected ? null : step.id)}
                        className={`cursor-pointer px-3.5 py-2.5 transition ${
                          isSelected ? 'bg-emerald-500/10' : 'hover:bg-hover/60'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            {step.status === 'passed' ? (
                              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                            ) : step.status === 'warning' ? (
                              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                            ) : step.status === 'skipped' ? (
                              <Info className="h-4 w-4 shrink-0 text-tx-muted" />
                            ) : (
                              <XCircle className="h-4 w-4 shrink-0 text-rose-500" />
                            )}
                            <MethodBadge method={step.method} size="sm" />
                            <span className="truncate text-xs font-semibold text-tx-primary">
                              {step.name}
                            </span>
                            <span className="hidden truncate font-mono text-[11px] text-tx-muted sm:inline">
                              {step.url}
                            </span>
                          </div>

                          <div className="flex items-center gap-2 shrink-0 text-[11px] font-mono">
                            {step.testResults.length > 0 && (
                              <span
                                className={`rounded px-1.5 py-0.5 font-semibold ${
                                  step.testsFailed === 0
                                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                    : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                                }`}
                              >
                                {step.testsPassed}/{step.testsPassed + step.testsFailed} tests
                              </span>
                            )}
                            {step.httpStatus > 0 && (
                              <span
                                className={`rounded px-1.5 py-0.5 ${
                                  step.status === 'warning' || (step.httpStatus >= 300 && step.httpStatus < 400)
                                    ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
                                    : step.httpStatus >= 200 && step.httpStatus < 300
                                      ? 'bg-sky-500/10 text-sky-600 dark:text-sky-300'
                                      : 'bg-rose-500/15 font-semibold text-rose-600 dark:text-rose-300'
                                }`}
                              >
                                {step.httpStatus} {step.statusText}
                              </span>
                            )}
                            <span className="text-tx-muted">{step.timeMs} ms</span>
                            {step.sizeBytes > 0 && (
                              <span className="hidden text-tx-faint md:inline">
                                {formatBytes(step.sizeBytes)}
                              </span>
                            )}
                          </div>
                        </div>

                        {stepErr && (
                          <div className="mt-1.5 ml-6 rounded border border-rose-500/25 bg-rose-500/10 px-2.5 py-1 font-mono text-[11px] text-rose-600 dark:text-rose-300">
                            {stepErr}
                          </div>
                        )}

                        {!stepErr && step.warningMessage && (
                          <div className="mt-1.5 ml-6 rounded border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 font-mono text-[11px] text-amber-700 dark:text-amber-300">
                            {step.warningMessage}
                          </div>
                        )}

                        {step.testResults.length > 0 && (
                          <div className="mt-2 ml-6 space-y-1">
                            {step.testResults.map((t, tIdx) => (
                              <div key={`${step.id}-t-${tIdx}`} className="flex items-start gap-1.5 text-[11px]">
                                <span
                                  className={`mt-0.5 shrink-0 rounded px-1 font-mono text-[9px] font-bold ${
                                    t.passed
                                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                      : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                                  }`}
                                >
                                  {t.passed ? 'PASS' : 'FAIL'}
                                </span>
                                <div className="min-w-0">
                                  <span className="text-tx-secondary">{t.name}</span>
                                  {!t.passed && t.error && (
                                    <span className="ml-2 font-mono text-[10px] text-rose-500">
                                      — {t.error}
                                    </span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Step Detail Inspector Drawer */}
        {selectedStep && (
          <div className="flex w-full max-w-md flex-col border-l border-line bg-surface shrink-0">
            <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <MethodBadge method={selectedStep.method} size="sm" />
                  <span className="truncate text-xs font-bold text-tx-primary">
                    {selectedStep.name}
                  </span>
                </div>
                <div className="truncate font-mono text-[10px] text-tx-muted">
                  Iteration {selectedStep.iteration} • {selectedStep.url}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedStepId(null)}
                className="rounded p-1 text-tx-muted hover:bg-hover hover:text-tx-primary"
                title="Close step inspector"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex gap-3 border-b border-line px-3.5 text-xs">
              {(
                [
                  { id: 'tests', label: `Tests (${selectedStep.testResults.length})` },
                  { id: 'response', label: 'Response' },
                  { id: 'request', label: 'Request' },
                  ...(selectedStep.dataRowIndex !== undefined
                    ? [{ id: 'data' as InspectorTab, label: 'Data Row' }]
                    : []),
                ] as Array<{ id: InspectorTab; label: string }>
              ).map((tabItem) => (
                <button
                  key={tabItem.id}
                  type="button"
                  onClick={() => setInspectorTab(tabItem.id)}
                  className={`border-b-2 py-2 font-medium transition ${
                    inspectorTab === tabItem.id
                      ? 'border-emerald-500 text-tx-primary font-semibold'
                      : 'border-transparent text-tx-muted hover:text-tx-secondary'
                  }`}
                >
                  {tabItem.label}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3.5 text-xs space-y-3">
              {inspectorTab === 'tests' && (
                <>
                  {(selectedStep.scriptError || selectedStep.errorMessage) && (
                    <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 font-mono text-[11px] text-rose-600 dark:text-rose-300">
                      {selectedStep.scriptError || selectedStep.errorMessage}
                    </div>
                  )}
                  {selectedStep.testResults.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-line p-5 text-center text-tx-muted">
                      No <code className="font-mono">pm.test()</code> assertions ran on this step.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {selectedStep.testResults.map((t, idx) => (
                        <div
                          key={idx}
                          className={`rounded-lg border p-2.5 ${
                            t.passed
                              ? 'border-emerald-500/25 bg-emerald-500/5'
                              : 'border-rose-500/30 bg-rose-500/5'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-tx-primary">{t.name}</span>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                t.passed
                                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                  : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                              }`}
                            >
                              {t.passed ? 'PASS' : 'FAIL'}
                            </span>
                          </div>
                          {!t.passed && t.error && (
                            <div className="mt-1 font-mono text-[11px] text-rose-600 dark:text-rose-300">
                              {t.error}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {inspectorTab === 'response' && (
                <>
                  {!capturedExchange ? (
                    <div className="rounded-lg border border-dashed border-line p-5 text-center text-tx-muted">
                      {selectedStep.captureSkippedReason === 'disabled'
                        ? 'Response capture was disabled for this run.'
                        : selectedStep.captureSkippedReason === 'step_limit' ||
                            selectedStep.captureSkippedReason === 'memory_budget'
                          ? 'Response body was not captured because the session safety cap (500 steps / 16 MiB) was reached.'
                          : 'Response details are only available during the active session (not persisted to IndexedDB across reloads).'}
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between rounded-lg border border-line bg-card px-2.5 py-1.5 font-mono text-[11px]">
                        <span>
                          Status: <b>{selectedStep.httpStatus} {selectedStep.statusText}</b>
                        </span>
                        <span className="text-tx-muted">
                          {selectedStep.timeMs} ms • {formatBytes(selectedStep.sizeBytes)}
                        </span>
                      </div>
                      <div>
                        <div className="mb-1 text-[11px] font-semibold text-tx-muted">Response Headers</div>
                        <div className="overflow-x-auto rounded-lg border border-line bg-card">
                          <table className="w-full text-left font-mono text-[11px]">
                            <tbody className="divide-y divide-line">
                              {Object.entries(capturedExchange.responseHeaders).map(([k, v]) => (
                                <tr key={k}>
                                  <td className="px-2 py-1 text-sky-500">{k}</td>
                                  <td className="px-2 py-1 text-tx-secondary break-all">{v}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                      <div>
                        <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-tx-muted">
                          <span>Response Body</span>
                          {capturedExchange.responseBodyTruncated && (
                            <span className="text-amber-500">Truncated (128 KiB limit)</span>
                          )}
                        </div>
                        <pre className="max-h-96 overflow-auto rounded-lg border border-line bg-card p-2.5 font-mono text-[11px] text-tx-primary whitespace-pre-wrap break-all">
                          {tryPrettyBody(capturedExchange.responseBody) || '(empty body)'}
                        </pre>
                      </div>
                    </>
                  )}
                </>
              )}

              {inspectorTab === 'request' && (
                <>
                  {!capturedExchange ? (
                    <div className="rounded-lg border border-dashed border-line p-5 text-center text-tx-muted">
                      Resolved request details were not retained in session memory for this step.
                    </div>
                  ) : (
                    <>
                      <div className="rounded-lg border border-line bg-card p-2.5 font-mono text-[11px] break-all">
                        <b>{capturedExchange.requestMethod}</b> {capturedExchange.requestUrl}
                      </div>
                      <div>
                        <div className="mb-1 text-[11px] font-semibold text-tx-muted">Request Headers</div>
                        <div className="overflow-x-auto rounded-lg border border-line bg-card">
                          <table className="w-full text-left font-mono text-[11px]">
                            <tbody className="divide-y divide-line">
                              {Object.entries(capturedExchange.requestHeaders).map(([k, v]) => (
                                <tr key={k}>
                                  <td className="px-2 py-1 text-sky-500">{k}</td>
                                  <td className="px-2 py-1 text-tx-secondary break-all">{v}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                      {capturedExchange.requestBody !== undefined && (
                        <div>
                          <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-tx-muted">
                            <span>Request Body</span>
                            {capturedExchange.requestBodyTruncated && (
                              <span className="text-amber-500">Truncated (128 KiB limit)</span>
                            )}
                          </div>
                          <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-card p-2.5 font-mono text-[11px] text-tx-primary whitespace-pre-wrap break-all">
                            {tryPrettyBody(capturedExchange.requestBody)}
                          </pre>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}

              {inspectorTab === 'data' && (
                <>
                  {capturedExchange?.dataRow ? (
                    <div className="overflow-x-auto rounded-lg border border-line bg-card">
                      <table className="w-full text-left font-mono text-[11px]">
                        <thead className="border-b border-line bg-element/60 text-tx-muted">
                          <tr>
                            <th className="px-2.5 py-1.5">Column</th>
                            <th className="px-2.5 py-1.5">Value (Row #{(selectedStep.dataRowIndex ?? 0) + 1})</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {Object.entries(capturedExchange.dataRow).map(([k, v]) => (
                            <tr key={k}>
                              <td className="px-2.5 py-1.5 text-emerald-500">{k}</td>
                              <td className="px-2.5 py-1.5 text-tx-secondary break-all">{v}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-line p-5 text-center text-tx-muted">
                      Row #{(selectedStep.dataRowIndex ?? 0) + 1} snapshot is only retained in session memory.
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
