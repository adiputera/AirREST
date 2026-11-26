import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Flame, History, Play } from 'lucide-react';
import type {
  FunctionalRunReport,
  OpenPerformanceTab,
  PerformanceRunReport,
  RunnerMode,
} from '../../types/api';
import { usePlatformAdapter } from '../../context';
import { useStoreContext } from '../../store/storeContext';
import { useApiStore } from '../../store/useApiStore';
import { getActivePerformanceRun, startPerformanceTest, stopActivePerformanceRun } from '../../lib/perfRunner';
import {
  getActiveFunctionalRun,
  startFunctionalRun,
  stopActiveFunctionalRun,
} from '../../lib/functionalRunner';
import {
  buildPerfScopeKey,
  deleteFunctionalReport,
  deletePerfReport,
  listFunctionalReports,
  listPerfReports,
  saveFunctionalReport,
  savePerfReport,
} from '../../lib/perfStorage';
import { createDefaultFunctionalRunnerConfig } from '../../lib/perfLaunch';
import {
  clearPerformanceTabDataRows,
  getPerformanceTabDataRows,
  setPerformanceTabDataRows,
} from '../../lib/perfDataFile';
import { parseImportedPerformanceReport } from '../../lib/perfComparison';
import {
  exportFunctionalReportHtml,
  exportFunctionalReportJson,
  exportFunctionalReportJunitXml,
} from '../../lib/functionalReportExporter';
import {
  exportPerformanceEndpointsCsv,
  exportPerformanceReportHtml,
  exportPerformanceReportJson,
  exportPerformanceTimeSeriesCsv,
} from '../../lib/perfReportExporter';
import { getPlatformPerformanceLimits } from '../../lib/loadProfileMath';
import { RunSequencePanel } from './RunSequencePanel';
import { LoadProfileEditor } from './LoadProfileEditor';
import { FunctionalConfigPanel } from './FunctionalConfigPanel';
import { DataFilePanel } from './DataFilePanel';
import { ThresholdRulesEditor } from './ThresholdRulesEditor';
import { PerformanceReportView } from './PerformanceReportView';
import { FunctionalReportView } from './FunctionalReportView';

export const PerformanceTabView: React.FC = () => {
  const contextStore = useStoreContext();
  const activeStore = contextStore || useApiStore;
  const adapter = usePlatformAdapter();

  const selectedPerformanceTabId = activeStore((s) => s.selectedPerformanceTabId);
  const openPerformanceTabs = activeStore((s) => s.openPerformanceTabs);
  const performanceReports = activeStore((s) => s.performanceReports);
  const functionalReports = activeStore((s) => s.functionalReports);
  const collections = activeStore((s) => s.collections);
  const environments = activeStore((s) => s.environments);
  const activeEnvironmentId = activeStore((s) => s.activeEnvironmentId);
  const workspaceMode = activeStore((s) => s.workspaceMode);
  const activeOfflineWorkspaceId = activeStore((s) => s.activeOfflineWorkspaceId);
  const cloudConfig = activeStore((s) => s.cloudConfig);
  const updatePerformanceTab = activeStore((s) => s.updatePerformanceTab);
  const setPerformanceReport = activeStore((s) => s.setPerformanceReport);
  const setFunctionalReport = activeStore((s) => s.setFunctionalReport);
  const applyEnvironmentVariableUpdates = activeStore((s) => s.applyEnvironmentVariableUpdates);

  const tab: OpenPerformanceTab | undefined = useMemo(
    () => (openPerformanceTabs || []).find((p) => p.id === selectedPerformanceTabId),
    [openPerformanceTabs, selectedPerformanceTabId]
  );

  const platformId = adapter?.platformId || 'web';
  const limits = getPlatformPerformanceLimits(platformId);

  const scopeKey = useMemo(
    () =>
      buildPerfScopeKey({
        workspaceMode,
        activeOfflineWorkspaceId,
        cloudUserId: cloudConfig?.user?.id,
        activeScopeType: cloudConfig?.activeScope?.type,
        activeScopeId: cloudConfig?.activeScope?.id,
      }),
    [workspaceMode, activeOfflineWorkspaceId, cloudConfig]
  );

  const [recentReports, setRecentReports] = useState<PerformanceRunReport[]>([]);
  const [recentFunctionalReports, setRecentFunctionalReports] = useState<FunctionalRunReport[]>([]);
  const [startError, setStartError] = useState<string | null>(null);
  const [initialItemsCache, setInitialItemsCache] = useState<Record<string, OpenPerformanceTab['items']>>({});
  const baselineFileInputRef = useRef<HTMLInputElement | null>(null);
  const baselineResolverRef = useRef<((res: { report?: PerformanceRunReport; error?: string } | null) => void) | null>(null);

  useEffect(() => {
    if (!tab) return;
    setInitialItemsCache((prev) => (prev[tab.id] ? prev : { ...prev, [tab.id]: tab.items }));
  }, [tab]);

  useEffect(() => {
    let cancelled = false;
    void listPerfReports(scopeKey).then((list) => {
      if (!cancelled) setRecentReports(list);
    });
    void listFunctionalReports(scopeKey).then((list) => {
      if (!cancelled) setRecentFunctionalReports(list);
    });
    return () => {
      cancelled = true;
    };
  }, [scopeKey]);

  if (!tab) return null;

  const runnerMode: RunnerMode = tab.runnerMode || 'performance';
  const isFunctionalMode = runnerMode === 'functional';
  const functionalConfig = tab.functionalConfig || createDefaultFunctionalRunnerConfig();

  const activePerfRun = getActivePerformanceRun();
  const activeFuncRun = getActiveFunctionalRun();
  const isAnotherRunActive = Boolean(
    (activePerfRun && activePerfRun.tabId !== tab.id) ||
      (activeFuncRun && activeFuncRun.tabId !== tab.id)
  );
  const isThisTabRunning = Boolean(
    (activePerfRun && activePerfRun.tabId === tab.id) ||
      (activeFuncRun && activeFuncRun.tabId === tab.id)
  );

  const viewingReport = tab.viewingReportId
    ? performanceReports?.[tab.viewingReportId] ||
      recentReports.find((r) => r.id === tab.viewingReportId) ||
      null
    : null;

  const viewingFunctionalReport = tab.viewingFunctionalReportId
    ? functionalReports?.[tab.viewingFunctionalReportId] ||
      recentFunctionalReports.find((r) => r.id === tab.viewingFunctionalReportId) ||
      null
    : null;

  const activeEnvironment = environments.find((e) => e.id === activeEnvironmentId) || null;

  const sourceCollection = tab.collectionId
    ? collections.find((c) => c.id === tab.collectionId) || null
    : null;

  const setupSet = new Set(tab.setupItemIds);
  const loopEndpoints = (tab.items || []).filter(
    (it) => it.selected && !(tab.executionMode === 'pre_run_setup' && setupSet.has(it.id))
  );

  const dataRowsInMemory = getPerformanceTabDataRows(tab.id);

  const resolveActiveEnvVariables = (): Record<string, string> => {
    const activeEnv = environments.find((e) => e.id === activeEnvironmentId);
    const out: Record<string, string> = {};
    for (const v of activeEnv?.variables || []) {
      if (!v || !v.enabled || !v.key?.trim()) continue;
      out[v.key.trim()] = v.currentValue ?? v.value ?? v.initialValue ?? '';
    }
    return out;
  };

  const handleStartRun = async () => {
    setStartError(null);
    const initialVariables = resolveActiveEnvVariables();
    const res = await startPerformanceTest({
      tabId: tab.id,
      title: tab.title,
      sourceType: tab.sourceType,
      sourceId: tab.sourceId,
      items: tab.items,
      executionMode: tab.executionMode,
      setupItemIds: tab.setupItemIds,
      setupRefresh: tab.setupRefresh,
      runInLoopScripts: tab.runInLoopScripts,
      loadProfile: tab.loadProfile,
      network: tab.network,
      dataFileMeta: tab.dataFile,
      dataRows: dataRowsInMemory,
      thresholds: tab.thresholds,
      initialVariables,
      adapter: adapter || undefined,
      onUpdate: (liveReport) => {
        setPerformanceReport(liveReport);
      },
      onFinish: (finalReport) => {
        setPerformanceReport(finalReport);
        updatePerformanceTab(tab.id, {
          viewMode: 'report',
          activeRunId: null,
          viewingReportId: finalReport.id,
        });
        void savePerfReport(scopeKey, finalReport).then(() => {
          void listPerfReports(scopeKey).then(setRecentReports);
        });
      },
    });

    if (!res.started || !res.runId) {
      setStartError(res.error || 'Could not start performance test.');
      return;
    }

    updatePerformanceTab(tab.id, {
      viewMode: 'running',
      activeRunId: res.runId,
      viewingReportId: res.runId,
    });
  };

  const handleStartFunctional = async (onlyItemIds?: string[]) => {
    setStartError(null);
    const initialVariables = resolveActiveEnvVariables();
    const res = await startFunctionalRun({
      tabId: tab.id,
      title: tab.title,
      sourceType: tab.sourceType,
      sourceId: tab.sourceId,
      items: tab.items,
      onlyItemIds,
      config: functionalConfig,
      dataFileMeta: tab.dataFile,
      dataRows: dataRowsInMemory,
      initialVariables,
      adapter: adapter || undefined,
      onCommitEnvironmentUpdates: applyEnvironmentVariableUpdates,
      onUpdate: (liveReport) => {
        setFunctionalReport(liveReport);
      },
      onFinish: (finalReport) => {
        setFunctionalReport(finalReport);
        updatePerformanceTab(tab.id, {
          viewMode: 'report',
          activeFunctionalRunId: null,
          viewingFunctionalReportId: finalReport.id,
        });
        void saveFunctionalReport(scopeKey, finalReport).then(() => {
          void listFunctionalReports(scopeKey).then(setRecentFunctionalReports);
        });
      },
    });

    if (!res.started || !res.runId) {
      setStartError(res.error || 'Could not start functional collection run.');
      return;
    }

    updatePerformanceTab(tab.id, {
      runnerMode: 'functional',
      viewMode: 'running',
      activeFunctionalRunId: res.runId,
      viewingFunctionalReportId: res.runId,
    });
  };

  const downloadExportArtifact = async (
    report: Pick<PerformanceRunReport, 'title' | 'startedAt'>,
    ext: 'html' | 'json' | 'csv' | 'xml',
    suffix: string,
    content: string,
    filterName: string,
    mimeType: string
  ) => {
    const slug = (report.title || 'performance-report').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const dateTag = new Date(report.startedAt).toISOString().slice(0, 10);
    const filename = `${slug}-${suffix ? `${suffix}-` : ''}${dateTag}.${ext}`;
    if (adapter?.saveFile) {
      await adapter.saveFile(filename, content, {
        filters: [{ name: filterName, extensions: [ext] }],
        mimeType,
      });
      return;
    }
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleLoadBaselineJson = async (): Promise<{
    report?: PerformanceRunReport;
    error?: string;
  } | null> => {
    if (adapter?.capabilities?.supportsNativeFileSystem && adapter.openFile) {
      try {
        const picked = await adapter.openFile({
          filters: [{ name: 'AirREST Performance JSON', extensions: ['json'] }],
        });
        if (!picked) return null;
        return parseImportedPerformanceReport(picked.content);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    return new Promise((resolve) => {
      baselineResolverRef.current = resolve;
      baselineFileInputRef.current?.click();
    });
  };

  const handleBaselineInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const resolver = baselineResolverRef.current;
    baselineResolverRef.current = null;
    if (!resolver) return;
    if (!file) {
      resolver(null);
      return;
    }
    try {
      const content = await file.text();
      resolver(parseImportedPerformanceReport(content));
    } catch (err) {
      resolver({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  if ((tab.viewMode === 'running' || tab.viewMode === 'report') && isFunctionalMode && viewingFunctionalReport) {
    return (
      <FunctionalReportView
        report={viewingFunctionalReport}
        recentReports={recentFunctionalReports}
        isAnotherRunActive={isAnotherRunActive}
        onStopRun={() => void stopActiveFunctionalRun()}
        onRunAgain={() => void handleStartFunctional()}
        onRerunFailed={(failedIds) => void handleStartFunctional(failedIds)}
        onBackToSetup={() =>
          updatePerformanceTab(tab.id, {
            viewMode: 'setup',
          })
        }
        onSelectHistoryReport={(selected) => {
          setFunctionalReport(selected);
          updatePerformanceTab(tab.id, {
            viewMode: 'report',
            viewingFunctionalReportId: selected.id,
          });
        }}
        onDeleteHistoryReport={(reportId) => {
          void deleteFunctionalReport(reportId).then(() => {
            void listFunctionalReports(scopeKey).then(setRecentFunctionalReports);
          });
        }}
        onExportHtml={(r) =>
          void downloadExportArtifact(
            r,
            'html',
            'functional',
            exportFunctionalReportHtml(r),
            'HTML Report',
            'text/html'
          )
        }
        onExportJson={(r) =>
          void downloadExportArtifact(
            r,
            'json',
            'functional',
            exportFunctionalReportJson(r),
            'JSON Report',
            'application/json'
          )
        }
        onExportJunitXml={(r) =>
          void downloadExportArtifact(
            r,
            'xml',
            'junit',
            exportFunctionalReportJunitXml(r),
            'JUnit XML Report',
            'application/xml'
          )
        }
      />
    );
  }

  if ((tab.viewMode === 'running' || tab.viewMode === 'report') && !isFunctionalMode && viewingReport) {
    return (
      <>
        <input
          ref={baselineFileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => void handleBaselineInputChange(e)}
        />
        <PerformanceReportView
          report={viewingReport}
          recentReports={recentReports}
          isAnotherRunActive={isAnotherRunActive}
          onStopRun={() => void stopActivePerformanceRun()}
          onRunAgain={() => void handleStartRun()}
          onBackToSetup={() =>
            updatePerformanceTab(tab.id, {
              viewMode: 'setup',
            })
          }
          onSelectHistoryReport={(selected) => {
            setPerformanceReport(selected);
            updatePerformanceTab(tab.id, {
              viewMode: 'report',
              viewingReportId: selected.id,
            });
          }}
          onDeleteHistoryReport={(reportId) => {
            void deletePerfReport(reportId).then(() => {
              void listPerfReports(scopeKey).then(setRecentReports);
            });
          }}
          onLoadBaselineJson={handleLoadBaselineJson}
          onExportHtml={(r, baseline) =>
            void downloadExportArtifact(
              r,
              'html',
              baseline ? 'compare' : '',
              exportPerformanceReportHtml(r, baseline),
              'HTML Report',
              'text/html'
            )
          }
          onExportJson={(r) =>
            void downloadExportArtifact(
              r,
              'json',
              '',
              exportPerformanceReportJson(r),
              'JSON Report',
              'application/json'
            )
          }
          onExportEndpointsCsv={(r) =>
            void downloadExportArtifact(
              r,
              'csv',
              'endpoints',
              exportPerformanceEndpointsCsv(r),
              'CSV Summary',
              'text/csv'
            )
          }
          onExportTimeSeriesCsv={(r) =>
            void downloadExportArtifact(
              r,
              'csv',
              'timeseries',
              exportPerformanceTimeSeriesCsv(r),
              'CSV Time-Series',
              'text/csv'
            )
          }
        />
      </>
    );
  }

  const handleSwitchRunnerMode = (nextMode: RunnerMode) => {
    if (isThisTabRunning || nextMode === runnerMode) return;
    setStartError(null);
    const shouldSyncIterations =
      nextMode === 'functional' &&
      tab.dataFile &&
      tab.dataFile.rowCount > 0 &&
      functionalConfig.iterations === 1;
    updatePerformanceTab(tab.id, {
      runnerMode: nextMode,
      ...(shouldSyncIterations
        ? {
            functionalConfig: {
              ...functionalConfig,
              iterations: tab.dataFile!.rowCount,
            },
          }
        : {}),
    });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app">
      {/* Setup Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2.5 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${
              isFunctionalMode
                ? 'bg-emerald-500/15 text-emerald-500 border-emerald-500/25'
                : 'bg-amber-500/15 text-amber-500 border-amber-500/25'
            }`}
          >
            {isFunctionalMode ? <Play className="h-3.5 w-3.5 fill-current" /> : <Flame className="h-4 w-4" />}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-sm font-bold text-tx-primary">{tab.title}</h2>
              <div className="flex rounded-lg border border-line bg-element p-0.5 text-[11px]">
                <button
                  type="button"
                  disabled={isThisTabRunning}
                  onClick={() => handleSwitchRunnerMode('functional')}
                  className={`rounded-md px-2 py-0.5 font-semibold transition ${
                    isFunctionalMode
                      ? 'bg-emerald-500 text-white shadow-xs'
                      : 'text-tx-muted hover:text-tx-primary'
                  }`}
                >
                  Functional
                </button>
                <button
                  type="button"
                  disabled={isThisTabRunning}
                  onClick={() => handleSwitchRunnerMode('performance')}
                  className={`rounded-md px-2 py-0.5 font-semibold transition ${
                    !isFunctionalMode
                      ? 'bg-amber-500 text-white shadow-xs'
                      : 'text-tx-muted hover:text-tx-primary'
                  }`}
                >
                  Performance
                </button>
              </div>
            </div>
            <p className="text-[11px] text-tx-muted">
              {isFunctionalMode
                ? 'Sequential Collection Runner • Scripts & pm.test() Assertions'
                : platformId === 'desktop'
                  ? 'Desktop Native Rust Engine • Up to 10,000 VUs'
                  : `Bounded JS Engine • Max ${limits.maxVUs} VUs`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isFunctionalMode ? (
            recentFunctionalReports.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const latest = recentFunctionalReports[0];
                  if (!latest) return;
                  setFunctionalReport(latest);
                  updatePerformanceTab(tab.id, {
                    viewMode: 'report',
                    viewingFunctionalReportId: latest.id,
                  });
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-card px-3 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
              >
                <History className="h-3.5 w-3.5 text-emerald-500" />
                <span>Last Report ({recentFunctionalReports.length})</span>
              </button>
            )
          ) : (
            recentReports.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const latest = recentReports[0];
                  if (!latest) return;
                  setPerformanceReport(latest);
                  updatePerformanceTab(tab.id, {
                    viewMode: 'report',
                    viewingReportId: latest.id,
                  });
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-card px-3 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
              >
                <History className="h-3.5 w-3.5 text-sky-500" />
                <span>Last Report ({recentReports.length})</span>
              </button>
            )
          )}

          <button
            type="button"
            disabled={isAnotherRunActive}
            onClick={() => void (isFunctionalMode ? handleStartFunctional() : handleStartRun())}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-4 text-xs font-semibold text-white shadow-md disabled:opacity-45 disabled:cursor-not-allowed transition ${
              isFunctionalMode
                ? 'bg-gradient-to-r from-emerald-500 to-teal-600 shadow-emerald-500/20 hover:from-emerald-400 hover:to-teal-500'
                : 'bg-gradient-to-r from-amber-500 to-orange-600 shadow-amber-500/20 hover:from-amber-400 hover:to-orange-500'
            }`}
            title={
              isAnotherRunActive
                ? 'Another runner execution is currently active'
                : isFunctionalMode
                  ? 'Start Functional Collection Run'
                  : 'Start Performance Test'
            }
          >
            <Play className="h-3.5 w-3.5 fill-current" />
            <span>{isFunctionalMode ? 'Run Collection' : 'Run'}</span>
          </button>
        </div>
      </div>

      {startError && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300 shrink-0">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{startError}</span>
        </div>
      )}

      {isAnotherRunActive && (
        <div className="mx-4 mt-3 flex items-center justify-between gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 shrink-0">
          <span>Another runner execution is currently active. Stop it before starting a new run.</span>
          <button
            type="button"
            onClick={() => {
              void stopActivePerformanceRun();
              void stopActiveFunctionalRun();
            }}
            className="rounded-md bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-rose-500"
          >
            Stop Active Run
          </button>
        </div>
      )}

      {/* Split Pane: Sequence Left, Mode Config + Data File Right */}
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-12 lg:overflow-hidden">
        <div className="border-b border-line p-4 lg:col-span-5 lg:border-r lg:border-b-0 lg:overflow-hidden">
          <RunSequencePanel
            runnerMode={runnerMode}
            items={tab.items}
            initialItems={initialItemsCache[tab.id] || tab.items}
            executionMode={tab.executionMode}
            setupItemIds={tab.setupItemIds}
            setupRefresh={tab.setupRefresh}
            runInLoopScripts={tab.runInLoopScripts}
            platformId={platformId}
            sourceCollection={sourceCollection}
            onChangeItems={(items) => updatePerformanceTab(tab.id, { items })}
            onChangeExecutionMode={(executionMode) => updatePerformanceTab(tab.id, { executionMode })}
            onChangeSetupItemIds={(setupItemIds) => updatePerformanceTab(tab.id, { setupItemIds })}
            onChangeSetupRefresh={(setupRefresh) => updatePerformanceTab(tab.id, { setupRefresh })}
            onChangeRunInLoopScripts={(runInLoopScripts) => updatePerformanceTab(tab.id, { runInLoopScripts })}
          />
        </div>

        <div className="space-y-4 p-4 lg:col-span-7 lg:overflow-y-auto">
          {isFunctionalMode ? (
            <FunctionalConfigPanel
              config={functionalConfig}
              selectedRequestCount={(tab.items || []).filter((it) => it.selected).length}
              dataFile={tab.dataFile}
              activeEnvironmentName={activeEnvironment?.name || null}
              platformId={platformId}
              onChange={(nextCfg) => updatePerformanceTab(tab.id, { functionalConfig: nextCfg })}
            />
          ) : (
            <LoadProfileEditor
              loadProfile={tab.loadProfile}
              network={tab.network}
              platformId={platformId}
              onChangeLoadProfile={(loadProfile) => updatePerformanceTab(tab.id, { loadProfile })}
              onChangeNetwork={(network) => updatePerformanceTab(tab.id, { network })}
            />
          )}

          <DataFilePanel
            runnerMode={runnerMode}
            platformId={platformId}
            dataFile={tab.dataFile}
            hasRowsInMemory={Boolean(dataRowsInMemory && dataRowsInMemory.length > 0)}
            onSelectNativeFile={
              adapter?.capabilities?.supportsNativeFileSystem && adapter.openFile
                ? () =>
                    adapter.openFile({
                      filters: [{ name: 'CSV or JSON Data File', extensions: ['csv', 'json'] }],
                    })
                : undefined
            }
            onChangeDataFile={(meta, rows) => {
              setPerformanceTabDataRows(tab.id, rows);
              updatePerformanceTab(tab.id, {
                dataFile: meta,
                ...(isFunctionalMode && rows.length > 0
                  ? {
                      functionalConfig: {
                        ...functionalConfig,
                        iterations: rows.length,
                      },
                    }
                  : {}),
              });
            }}
            onChangeReadMode={(readMode) => {
              if (!tab.dataFile) return;
              updatePerformanceTab(tab.id, {
                dataFile: { ...tab.dataFile, readMode },
              });
            }}
            onClearDataFile={() => {
              clearPerformanceTabDataRows(tab.id);
              updatePerformanceTab(tab.id, { dataFile: undefined });
            }}
          />

          {!isFunctionalMode && (
            <ThresholdRulesEditor
              thresholds={tab.thresholds}
              loopEndpoints={loopEndpoints}
              onChange={(thresholds) => updatePerformanceTab(tab.id, { thresholds })}
            />
          )}
        </div>
      </div>
    </div>
  );
};
