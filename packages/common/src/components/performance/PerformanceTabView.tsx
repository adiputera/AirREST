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
import {
  createDefaultFunctionalRunnerConfig,
  syncRunnerTabItemsFromSource,
  validateRunnerPreflight,
} from '../../lib/perfLaunch';
import { getFunctionalRunVariablesSnapshot } from '../../lib/functionalSessionStore';
import {
  clearPerformanceTabDataRows,
  getPerformanceTabDataRows,
  setPerformanceTabDataRows,
} from '../../lib/perfDataFile';
import { parseImportedPerformanceReport } from '../../lib/perfComparison';
import { captureImportTarget, isImportTargetMatching, MAX_IMPORT_FILE_BYTES } from '../../lib/importBatch';
import {
  AIRREST_REPORT_FILE_EXTENSION,
  buildSourceMetaFromContext,
  exportShareableFunctionalReport,
  exportShareablePerformanceReport,
} from '../../lib/reportShare';
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
import { ReportImportResolveModal } from './ReportImportResolveModal';
import { useReportImporter } from './useReportImporter';

export const PerformanceTabView: React.FC = () => {
  const contextStore = useStoreContext();
  const activeStore = contextStore || useApiStore;
  const adapter = usePlatformAdapter();
  const reportImporter = useReportImporter();

  const selectedPerformanceTabId = activeStore((s) => s.selectedPerformanceTabId);
  const openPerformanceTabs = activeStore((s) => s.openPerformanceTabs);
  const openTabs = activeStore((s) => s.tabs);
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
  const removePerformanceReport = activeStore((s) => s.removePerformanceReport);
  const removeFunctionalReport = activeStore((s) => s.removeFunctionalReport);
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
        cloudApiUrl: cloudConfig?.apiUrl,
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
  }, [scopeKey, tab?.viewingReportId, tab?.viewingFunctionalReportId]);

  const refreshSavedReports = () => {
    void listPerfReports(scopeKey).then(setRecentReports);
    void listFunctionalReports(scopeKey).then(setRecentFunctionalReports);
  };

  const tabRecentReports = useMemo(() => {
    if (!tab || tab.isSessionOnlyImported || tab.sourceType === 'imported') return [];
    return recentReports.filter((r) => r.sourceId === tab.sourceId);
  }, [recentReports, tab]);

  const tabRecentFunctionalReports = useMemo(() => {
    if (!tab || tab.isSessionOnlyImported || tab.sourceType === 'imported') return [];
    return recentFunctionalReports.filter((r) => r.sourceId === tab.sourceId);
  }, [recentFunctionalReports, tab]);

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
    if (tab.isSessionOnlyImported || tab.sourceType === 'imported') return;
    setStartError(null);

    const synced = syncRunnerTabItemsFromSource(tab, collections, openTabs);
    const effectiveItems = synced.items;
    const effectiveSetupIds = synced.setupItemIds;
    if (synced.changed) {
      updatePerformanceTab(tab.id, {
        items: effectiveItems,
        setupItemIds: effectiveSetupIds,
      });
    }

    const preflight = validateRunnerPreflight({
      items: effectiveItems,
      executionMode: tab.executionMode,
      setupItemIds: effectiveSetupIds,
      dataFile: tab.dataFile,
      dataRows: dataRowsInMemory,
    });
    if (!preflight.ok) {
      setStartError(preflight.error || 'Pre-flight check failed.');
      return;
    }

    const initialVariables = resolveActiveEnvVariables();
    const targetBinding = captureImportTarget(activeStore.getState());
    const capturedScopeKey = scopeKey;
    const capturedTabId = tab.id;
    const isRunStillBound = () => isImportTargetMatching(activeStore.getState(), targetBinding);
    const hasOpenRunnerTab = () =>
      (activeStore.getState().openPerformanceTabs || []).some((p) => p.id === capturedTabId);

    const res = await startPerformanceTest({
      tabId: capturedTabId,
      title: tab.title,
      sourceType: tab.sourceType,
      sourceId: tab.sourceId,
      items: effectiveItems,
      executionMode: tab.executionMode,
      setupItemIds: effectiveSetupIds,
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
        if (!isRunStillBound()) return;
        setPerformanceReport(liveReport);
      },
      onFinish: (finalReport) => {
        if (!isRunStillBound()) return;
        if (hasOpenRunnerTab()) {
          setPerformanceReport(finalReport);
          updatePerformanceTab(capturedTabId, {
            viewMode: 'report',
            activeRunId: null,
            viewingReportId: finalReport.id,
          });
        }
        void savePerfReport(capturedScopeKey, finalReport).then(() => {
          if (!isRunStillBound()) return;
          void listPerfReports(capturedScopeKey).then((list) => {
            if (isRunStillBound()) {
              setRecentReports(list);
            }
          });
        });
      },
    });

    if (!res.started || !res.runId) {
      setStartError(res.error || 'Could not start performance test.');
      return;
    }

    if (isRunStillBound() && hasOpenRunnerTab()) {
      updatePerformanceTab(capturedTabId, {
        viewMode: 'running',
        activeRunId: res.runId,
        viewingReportId: res.runId,
      });
    }
  };

  const handleStartFunctional = async (
    onlyItemIds?: string[],
    options?: { sourceReportId?: string; onlyIterations?: number[] }
  ) => {
    if (tab.isSessionOnlyImported || tab.sourceType === 'imported') return;
    setStartError(null);

    const synced = syncRunnerTabItemsFromSource(tab, collections, openTabs);
    const effectiveItems = synced.items;
    const effectiveSetupIds = synced.setupItemIds;
    if (synced.changed) {
      updatePerformanceTab(tab.id, {
        items: effectiveItems,
        setupItemIds: effectiveSetupIds,
      });
    }

    const preflight = validateRunnerPreflight({
      items: effectiveItems,
      onlyItemIds,
      dataFile: tab.dataFile,
      dataRows: dataRowsInMemory,
    });
    if (!preflight.ok) {
      setStartError(preflight.error || 'Pre-flight check failed.');
      return;
    }

    const baseEnvVariables = resolveActiveEnvVariables();
    const chainedSnapshot =
      onlyItemIds && options?.sourceReportId
        ? getFunctionalRunVariablesSnapshot(options.sourceReportId)
        : undefined;
    const initialVariables = chainedSnapshot
      ? { ...baseEnvVariables, ...chainedSnapshot.env }
      : baseEnvVariables;
    const targetBinding = captureImportTarget(activeStore.getState());
    const capturedScopeKey = scopeKey;
    const capturedEnvId = activeEnvironmentId;
    const capturedTabId = tab.id;
    const isRunStillBound = () => isImportTargetMatching(activeStore.getState(), targetBinding);
    const hasOpenRunnerTab = () =>
      (activeStore.getState().openPerformanceTabs || []).some((p) => p.id === capturedTabId);

    const res = await startFunctionalRun({
      tabId: capturedTabId,
      title: tab.title,
      sourceType: tab.sourceType,
      sourceId: tab.sourceId,
      items: effectiveItems,
      onlyItemIds,
      onlyIterations: options?.onlyIterations,
      config: functionalConfig,
      dataFileMeta: tab.dataFile,
      dataRows: dataRowsInMemory,
      initialVariables,
      initialLocalVariables: chainedSnapshot?.vars,
      adapter: adapter || undefined,
      onCommitEnvironmentUpdates: (updates, unsetKeys) => {
        if (!capturedEnvId || !isRunStillBound()) return [];
        return applyEnvironmentVariableUpdates(updates, unsetKeys, capturedEnvId);
      },
      onUpdate: (liveReport) => {
        if (!isRunStillBound()) return;
        setFunctionalReport(liveReport);
      },
      onFinish: (finalReport) => {
        if (!isRunStillBound()) return;
        if (hasOpenRunnerTab()) {
          setFunctionalReport(finalReport);
          updatePerformanceTab(capturedTabId, {
            viewMode: 'report',
            activeFunctionalRunId: null,
            viewingFunctionalReportId: finalReport.id,
          });
        }
        void saveFunctionalReport(capturedScopeKey, finalReport).then(() => {
          if (!isRunStillBound()) return;
          void listFunctionalReports(capturedScopeKey).then((list) => {
            if (isRunStillBound()) {
              setRecentFunctionalReports(list);
            }
          });
        });
      },
    });

    if (!res.started || !res.runId) {
      setStartError(res.error || 'Could not start functional collection run.');
      return;
    }

    if (isRunStillBound() && hasOpenRunnerTab()) {
      updatePerformanceTab(capturedTabId, {
        runnerMode: 'functional',
        viewMode: 'running',
        activeFunctionalRunId: res.runId,
        viewingFunctionalReportId: res.runId,
      });
    }
  };

  const safeReportDateTag = (startedAt: number): string => {
    const safeMs = typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt >= 0 ? startedAt : 0;
    try {
      return new Date(safeMs).toISOString().slice(0, 10);
    } catch {
      return new Date(0).toISOString().slice(0, 10);
    }
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
    const dateTag = safeReportDateTag(report.startedAt);
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

  const downloadShareBundle = async (
    report: PerformanceRunReport | FunctionalRunReport,
    kind: 'performance' | 'functional'
  ) => {
    const slug = (report.title || `${kind}-report`).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const dateTag = safeReportDateTag(report.startedAt);
    const filename = `${slug}-${dateTag}${AIRREST_REPORT_FILE_EXTENSION}`;
    const sourceMeta = buildSourceMetaFromContext(report, collections);
    const content =
      kind === 'functional'
        ? exportShareableFunctionalReport(report as FunctionalRunReport, sourceMeta)
        : exportShareablePerformanceReport(report as PerformanceRunReport, sourceMeta);

    if (adapter?.saveFile) {
      await adapter.saveFile(filename, content, {
        filters: [{ name: 'AirREST Report Bundle', extensions: ['json'] }],
        mimeType: 'application/json',
      });
      return;
    }
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleImportReportFromRunner = async () => {
    setStartError(null);
    const picked = await reportImporter.pickReportFileContent();
    if (!picked) return;
    if (picked.error) {
      setStartError(picked.error);
      return;
    }
    const res = await reportImporter.importReportContent(picked.content, {
      filename: picked.filename,
      onAttachedSaved: refreshSavedReports,
    });
    if (!res.ok && !res.cancelled && res.error) {
      setStartError(res.error);
    }
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
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      resolver({ error: 'Selected baseline report file exceeds maximum allowed limit of 16 MB.' });
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
      <>
        <FunctionalReportView
          report={viewingFunctionalReport}
          recentReports={tabRecentFunctionalReports}
          isAnotherRunActive={isAnotherRunActive}
          isSessionOnlyImported={Boolean(tab.isSessionOnlyImported)}
          sessionOnlyReason={tab.sessionOnlyReason}
          availableCollections={collections}
          onStopRun={() => void stopActiveFunctionalRun()}
          onRunAgain={() => void handleStartFunctional()}
          onRerunFailed={(payload) =>
            void handleStartFunctional(payload.failedItemIds, {
              sourceReportId: payload.sourceReportId,
              onlyIterations: payload.onlyIterations,
            })
          }
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
              isSessionOnlyImported: false,
              sessionOnlyReason: '',
            });
          }}
          onDeleteHistoryReport={(reportId) => {
            removeFunctionalReport?.(reportId);
            void deleteFunctionalReport(reportId, scopeKey).then(() => {
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
          onShareReport={(r) => void downloadShareBundle(r, 'functional')}
          onImportReportFile={() => void handleImportReportFromRunner()}
          onAttachToCollection={(col) =>
            void reportImporter.attachSessionReportToCollection({
              kind: 'functional',
              funcReport: viewingFunctionalReport,
              collection: col,
              currentTabId: tab.id,
              onAttachedSaved: refreshSavedReports,
            })
          }
        />
        <ReportImportResolveModal
          prompt={reportImporter.resolvePrompt}
          onResolve={reportImporter.handleResolveChoice}
        />
      </>
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
          recentReports={tabRecentReports}
          isAnotherRunActive={isAnotherRunActive}
          isSessionOnlyImported={Boolean(tab.isSessionOnlyImported)}
          sessionOnlyReason={tab.sessionOnlyReason}
          availableCollections={collections}
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
              isSessionOnlyImported: false,
              sessionOnlyReason: '',
            });
          }}
          onDeleteHistoryReport={(reportId) => {
            removePerformanceReport?.(reportId);
            void deletePerfReport(reportId, scopeKey).then(() => {
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
          onShareReport={(r) => void downloadShareBundle(r, 'performance')}
          onImportReportFile={() => void handleImportReportFromRunner()}
          onAttachToCollection={(col) =>
            void reportImporter.attachSessionReportToCollection({
              kind: 'performance',
              perfReport: viewingReport,
              collection: col,
              currentTabId: tab.id,
              onAttachedSaved: refreshSavedReports,
            })
          }
        />
        <ReportImportResolveModal
          prompt={reportImporter.resolvePrompt}
          onResolve={reportImporter.handleResolveChoice}
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
            tabRecentFunctionalReports.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const latest = tabRecentFunctionalReports[0];
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
                <span>Last Report ({tabRecentFunctionalReports.length})</span>
              </button>
            )
          ) : (
            tabRecentReports.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const latest = tabRecentReports[0];
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
                <span>Last Report ({tabRecentReports.length})</span>
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
      <ReportImportResolveModal
        prompt={reportImporter.resolvePrompt}
        onResolve={reportImporter.handleResolveChoice}
      />
    </div>
  );
};
