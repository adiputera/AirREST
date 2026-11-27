import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Collection,
  CollectionItem,
  FunctionalRunReport,
  OpenPerformanceTab,
  PerformanceRunReport,
  RunnerMode,
} from '../../types/api';
import { usePlatformAdapter } from '../../context';
import { useStoreContext } from '../../store/storeContext';
import { useApiStore } from '../../store/useApiStore';
import { makePerformanceTabId } from '../../lib/examples';
import {
  captureImportTarget,
  type ImportTargetBinding,
  isImportTargetMatching,
  MAX_IMPORT_FILE_BYTES,
} from '../../lib/importBatch';
import {
  computeDefaultPerformanceTimeoutMs,
  createDefaultLoadProfileConfig,
  getDurationSeconds,
  getPlatformPerformanceLimits,
} from '../../lib/loadProfileMath';
import {
  buildCollectionPerformanceLaunchConfig,
  buildFolderPerformanceLaunchConfig,
  buildSingleRequestPerformanceLaunchConfig,
  createDefaultFunctionalRunnerConfig,
} from '../../lib/perfLaunch';
import {
  buildPerfScopeKey,
  getFunctionalReportById,
  getPerfReportById,
  hasFunctionalReportInScope,
  hasPerfReportInScope,
  saveFunctionalReport,
  savePerfReport,
} from '../../lib/perfStorage';
import {
  bindImportedFunctionalReport,
  bindImportedPerformanceReport,
  findPartialCollectionCandidate,
  parseShareableReportJson,
  resolveReportSourceTarget,
} from '../../lib/reportShare';
import type { ReportResolveChoice, ReportResolvePrompt } from './ReportImportResolveModal';

export interface ImportReportOutcome {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  mode?: 'attached' | 'session_only' | 'opened_existing';
  kind?: 'performance' | 'functional';
  tabId?: string;
  reportId?: string;
  message?: string;
}

interface AttachedTargetInfo {
  targetType: 'collection' | 'folder' | 'request';
  targetId: string;
  targetCollection: Collection;
  targetItem?: CollectionItem;
  displayLabel: string;
}

function buildLaunchConfigForTarget(
  target: AttachedTargetInfo,
  runnerMode: RunnerMode,
  platformId: 'extension' | 'desktop' | 'android' | 'web'
): Omit<OpenPerformanceTab, 'id' | 'createdAt' | 'viewMode'> {
  if (target.targetType === 'folder' && target.targetItem) {
    return buildFolderPerformanceLaunchConfig(
      target.targetCollection.id,
      target.targetItem,
      platformId,
      runnerMode
    );
  }
  if (target.targetType === 'request' && target.targetItem?.request) {
    return buildSingleRequestPerformanceLaunchConfig(
      target.targetItem.request,
      target.targetCollection.id,
      platformId,
      runnerMode
    );
  }
  return buildCollectionPerformanceLaunchConfig(target.targetCollection, platformId, runnerMode);
}

function buildSessionOnlyLaunchConfig(
  kind: 'performance' | 'functional',
  report: PerformanceRunReport | FunctionalRunReport,
  platformId: 'extension' | 'desktop' | 'android' | 'web',
  sessionReason: string
): Omit<OpenPerformanceTab, 'id' | 'createdAt'> & { id: string } {
  const runnerMode: RunnerMode = kind === 'functional' ? 'functional' : 'performance';
  const limits = getPlatformPerformanceLimits(platformId);
  const loadProfile =
    kind === 'performance'
      ? (report as PerformanceRunReport).configSnapshot?.loadProfile ||
        createDefaultLoadProfileConfig(limits.maxVUs)
      : createDefaultLoadProfileConfig(limits.maxVUs);
  const defaultTimeoutMs = computeDefaultPerformanceTimeoutMs(getDurationSeconds(loadProfile));
  const sourceId = `session-${kind}-${report.id}`;

  return {
    id: makePerformanceTabId('imported', sourceId),
    title: report.title,
    runnerMode,
    sourceType: 'imported',
    sourceId,
    items: [],
    executionMode: 'sequential',
    setupItemIds: [],
    runInLoopScripts: false,
    loadProfile,
    network: {
      requestTimeoutMs: defaultTimeoutMs,
      requestTimeoutAuto: true,
      followRedirects: true,
      ignoreSslErrors: false,
    },
    functionalConfig:
      kind === 'functional'
        ? (report as FunctionalRunReport).config || createDefaultFunctionalRunnerConfig()
        : createDefaultFunctionalRunnerConfig(),
    viewMode: 'report',
    ...(kind === 'performance'
      ? { viewingReportId: report.id }
      : { viewingFunctionalReportId: report.id }),
    isSessionOnlyImported: true,
    sessionOnlyReason: sessionReason,
  };
}

export function useReportImporter() {
  const contextStore = useStoreContext();
  const activeStore = contextStore || useApiStore;
  const adapter = usePlatformAdapter();
  const platformId = adapter?.platformId || 'web';

  const workspaceMode = activeStore((s) => s.workspaceMode);
  const activeOfflineWorkspaceId = activeStore((s) => s.activeOfflineWorkspaceId);
  const cloudScopeType = activeStore((s) => s.cloudConfig?.activeScope?.type);
  const cloudScopeId = activeStore((s) => s.cloudConfig?.activeScope?.id);
  const cloudUserId = activeStore((s) => s.cloudConfig?.user?.id);
  const cloudApiUrl = activeStore((s) => s.cloudConfig?.apiUrl);

  const [resolvePrompt, setResolvePrompt] = useState<ReportResolvePrompt | null>(null);
  const promptResolverRef = useRef<((choice: ReportResolveChoice) => void) | null>(null);

  const cancelPendingPrompt = useCallback(() => {
    setResolvePrompt(null);
    if (promptResolverRef.current) {
      const resolver = promptResolverRef.current;
      promptResolverRef.current = null;
      resolver('cancel');
    }
  }, []);

  useEffect(() => {
    cancelPendingPrompt();
  }, [
    workspaceMode,
    activeOfflineWorkspaceId,
    cloudScopeType,
    cloudScopeId,
    cloudUserId,
    cloudApiUrl,
    cancelPendingPrompt,
  ]);

  useEffect(() => {
    return () => {
      if (promptResolverRef.current) {
        promptResolverRef.current('cancel');
        promptResolverRef.current = null;
      }
    };
  }, []);

  const requestResolveChoice = useCallback((prompt: ReportResolvePrompt): Promise<ReportResolveChoice> => {
    if (promptResolverRef.current) {
      promptResolverRef.current('cancel');
      promptResolverRef.current = null;
    }
    return new Promise((resolve) => {
      promptResolverRef.current = resolve;
      setResolvePrompt(prompt);
    });
  }, []);

  const handleResolveChoice = useCallback((choice: ReportResolveChoice) => {
    setResolvePrompt(null);
    const resolver = promptResolverRef.current;
    promptResolverRef.current = null;
    if (resolver) {
      resolver(choice);
    }
  }, []);

  const getCurrentScopeKey = useCallback(() => {
    const s = activeStore.getState();
    return buildPerfScopeKey({
      workspaceMode: s.workspaceMode,
      activeOfflineWorkspaceId: s.activeOfflineWorkspaceId,
      cloudApiUrl: s.cloudConfig?.apiUrl,
      cloudUserId: s.cloudConfig?.user?.id,
      activeScopeType: s.cloudConfig?.activeScope?.type,
      activeScopeId: s.cloudConfig?.activeScope?.id,
    });
  }, [activeStore]);

  const persistAndOpenAttached = useCallback(
    async (params: {
      kind: 'performance' | 'functional';
      perfReport?: PerformanceRunReport;
      funcReport?: FunctionalRunReport;
      target: AttachedTargetInfo;
      targetBinding?: ImportTargetBinding;
      filename?: string;
      closeSessionTabId?: string;
      onAttachedSaved?: () => void;
    }): Promise<ImportReportOutcome> => {
      const { kind, perfReport, funcReport, target, filename, closeSessionTabId, onAttachedSaved } = params;
      const binding = params.targetBinding ?? captureImportTarget(activeStore.getState());
      if (!isImportTargetMatching(activeStore.getState(), binding)) {
        return { ok: false, cancelled: true };
      }

      const incomingReportId = kind === 'performance' ? perfReport!.id : funcReport!.id;
      const incomingTitle = kind === 'performance' ? perfReport!.title : funcReport!.title;
      const incomingStartedAt = kind === 'performance' ? perfReport!.startedAt : funcReport!.startedAt;
      const scopeKey = getCurrentScopeKey();

      const duplicateExists =
        kind === 'performance'
          ? await hasPerfReportInScope(scopeKey, incomingReportId)
          : await hasFunctionalReportInScope(scopeKey, incomingReportId);
      if (!isImportTargetMatching(activeStore.getState(), binding)) {
        return { ok: false, cancelled: true };
      }

      let forceNewId = false;
      if (duplicateExists) {
        const existingSaved =
          kind === 'performance'
            ? await getPerfReportById(incomingReportId, scopeKey)
            : await getFunctionalReportById(incomingReportId, scopeKey);
        if (!isImportTargetMatching(activeStore.getState(), binding)) {
          return { ok: false, cancelled: true };
        }

        const dupChoice = await requestResolveChoice({
          type: 'duplicate_id',
          kind,
          reportTitle: incomingTitle,
          displayLabel: target.displayLabel,
          existingStartedAt: existingSaved?.startedAt,
          incomingStartedAt,
          filename,
        });
        if (!isImportTargetMatching(activeStore.getState(), binding)) {
          return { ok: false, cancelled: true };
        }

        if (dupChoice === 'cancel') {
          return { ok: false, cancelled: true };
        }

        if (dupChoice === 'open_existing' && existingSaved) {
          const state = activeStore.getState();
          const runnerMode: RunnerMode = kind === 'functional' ? 'functional' : 'performance';
          if (kind === 'performance') {
            state.setPerformanceReport(existingSaved as PerformanceRunReport);
          } else {
            state.setFunctionalReport(existingSaved as FunctionalRunReport);
          }
          const launchBase = buildLaunchConfigForTarget(target, runnerMode, platformId);
          const tabId = makePerformanceTabId(launchBase.sourceType, launchBase.sourceId);
          state.openPerformanceTestTab({
            ...launchBase,
            id: tabId,
            viewMode: 'report',
            ...(kind === 'performance'
              ? { viewingReportId: existingSaved.id }
              : { viewingFunctionalReportId: existingSaved.id }),
            isSessionOnlyImported: false,
            sessionOnlyReason: '',
          });
          if (closeSessionTabId && closeSessionTabId !== tabId) {
            state.closePerformanceTab(closeSessionTabId);
          }
          return {
            ok: true,
            mode: 'opened_existing',
            kind,
            tabId,
            reportId: existingSaved.id,
            message: `Opened existing saved report "${existingSaved.title}".`,
          };
        }

        if (dupChoice === 'save_copy') {
          forceNewId = true;
        }
      }

      if (!isImportTargetMatching(activeStore.getState(), binding)) {
        return { ok: false, cancelled: true };
      }

      const targetName = target.targetItem?.name || target.targetCollection.name;
      const runnerMode: RunnerMode = kind === 'functional' ? 'functional' : 'performance';
      let savedId = incomingReportId;

      if (kind === 'performance' && perfReport) {
        const bound = bindImportedPerformanceReport(
          perfReport,
          {
            mode: 'attached',
            targetType: target.targetType,
            targetId: target.targetId,
            targetCollection: target.targetCollection,
            targetName,
          },
          { filename, forceNewId }
        );
        savedId = bound.id;
        await savePerfReport(scopeKey, bound);
        if (!isImportTargetMatching(activeStore.getState(), binding)) {
          return { ok: false, cancelled: true };
        }
        activeStore.getState().setPerformanceReport(bound);
      } else if (kind === 'functional' && funcReport) {
        const bound = bindImportedFunctionalReport(
          funcReport,
          {
            mode: 'attached',
            targetType: target.targetType,
            targetId: target.targetId,
            targetCollection: target.targetCollection,
            targetName,
          },
          { filename, forceNewId }
        );
        savedId = bound.id;
        await saveFunctionalReport(scopeKey, bound);
        if (!isImportTargetMatching(activeStore.getState(), binding)) {
          return { ok: false, cancelled: true };
        }
        activeStore.getState().setFunctionalReport(bound);
      }

      if (!isImportTargetMatching(activeStore.getState(), binding)) {
        return { ok: false, cancelled: true };
      }

      const state = activeStore.getState();
      const launchBase = buildLaunchConfigForTarget(target, runnerMode, platformId);
      const tabId = makePerformanceTabId(launchBase.sourceType, launchBase.sourceId);
      state.openPerformanceTestTab({
        ...launchBase,
        id: tabId,
        viewMode: 'report',
        ...(kind === 'performance'
          ? { viewingReportId: savedId }
          : { viewingFunctionalReportId: savedId }),
        isSessionOnlyImported: false,
        sessionOnlyReason: '',
      });

      if (closeSessionTabId && closeSessionTabId !== tabId) {
        state.closePerformanceTab(closeSessionTabId);
      }

      onAttachedSaved?.();
      return {
        ok: true,
        mode: 'attached',
        kind,
        tabId,
        reportId: savedId,
        message: `Attached "${incomingTitle}" to "${target.displayLabel}" and saved to run history.`,
      };
    },
    [activeStore, getCurrentScopeKey, platformId, requestResolveChoice]
  );

  const importReportContent = useCallback(
    async (
      content: string,
      options?: {
        filename?: string;
        onAttachedSaved?: () => void;
      }
    ): Promise<ImportReportOutcome> => {
      const targetBinding = captureImportTarget(activeStore.getState());
      const parsed = parseShareableReportJson(content);
      if (parsed.error || !parsed.kind || !parsed.sourceMeta) {
        return {
          ok: false,
          error: parsed.error || 'Unrecognized AirREST report JSON.',
        };
      }

      let liveState = activeStore.getState();
      const partialCol = findPartialCollectionCandidate(parsed.sourceMeta, liveState.collections || []);
      if (
        partialCol &&
        liveState.workspaceMode === 'cloud' &&
        typeof liveState.loadCollectionDetails === 'function'
      ) {
        try {
          await liveState.loadCollectionDetails(partialCol.id);
        } catch {
          // Best-effort hydration; fall back cleanly to lower match tiers if unavailable
        }
        if (!isImportTargetMatching(activeStore.getState(), targetBinding)) {
          return { ok: false, cancelled: true };
        }
        liveState = activeStore.getState();
      }

      let resolution = resolveReportSourceTarget(parsed.sourceMeta, liveState.collections || []);

      if (resolution.tier === 'name_match') {
        const reportTitle =
          parsed.perfReport?.title || parsed.funcReport?.title || 'Imported Report';
        const choice = await requestResolveChoice({
          type: 'name_match',
          kind: parsed.kind,
          reportTitle,
          targetType: resolution.targetType,
          collectionName: resolution.targetCollection.name,
          displayLabel: resolution.displayLabel,
          filename: options?.filename,
        });
        if (!isImportTargetMatching(activeStore.getState(), targetBinding)) {
          return { ok: false, cancelled: true };
        }
        if (choice === 'cancel') {
          return { ok: false, cancelled: true };
        }
        if (choice === 'session') {
          resolution = {
            tier: 'unmatched',
            reason: `Opened in session-only preview instead of attaching to "${resolution.displayLabel}".`,
          };
        }
      }

      if (resolution.tier === 'exact_id' || resolution.tier === 'name_match') {
        return persistAndOpenAttached({
          kind: parsed.kind,
          perfReport: parsed.perfReport,
          funcReport: parsed.funcReport,
          target: {
            targetType: resolution.targetType,
            targetId: resolution.targetId,
            targetCollection: resolution.targetCollection,
            targetItem: resolution.targetItem,
            displayLabel: resolution.displayLabel,
          },
          targetBinding,
          filename: options?.filename,
          onAttachedSaved: options?.onAttachedSaved,
        });
      }

      if (!isImportTargetMatching(activeStore.getState(), targetBinding)) {
        return { ok: false, cancelled: true };
      }

      // Tier 3: Unmatched -> in-memory Session-Only Read-Only (never saved to IndexedDB)
      const state = activeStore.getState();
      const boundReport =
        parsed.kind === 'performance' && parsed.perfReport
          ? bindImportedPerformanceReport(parsed.perfReport, { mode: 'session_only' }, {
              filename: options?.filename,
              forceNewId: true,
            })
          : bindImportedFunctionalReport(parsed.funcReport!, { mode: 'session_only' }, {
              filename: options?.filename,
              forceNewId: true,
            });

      if (parsed.kind === 'performance') {
        state.setPerformanceReport(boundReport as PerformanceRunReport);
      } else {
        state.setFunctionalReport(boundReport as FunctionalRunReport);
      }

      const sessionTabConfig = buildSessionOnlyLaunchConfig(
        parsed.kind,
        boundReport,
        platformId,
        resolution.reason
      );
      state.openPerformanceTestTab(sessionTabConfig);

      return {
        ok: true,
        mode: 'session_only',
        kind: parsed.kind,
        tabId: sessionTabConfig.id,
        reportId: boundReport.id,
        message: `Opened "${boundReport.title}" in temporary session-only view (not saved).`,
      };
    },
    [activeStore, persistAndOpenAttached, platformId, requestResolveChoice]
  );

  const attachSessionReportToCollection = useCallback(
    async (params: {
      kind: 'performance' | 'functional';
      perfReport?: PerformanceRunReport;
      funcReport?: FunctionalRunReport;
      collection: Collection;
      currentTabId: string;
      onAttachedSaved?: () => void;
    }): Promise<ImportReportOutcome> => {
      const targetBinding = captureImportTarget(activeStore.getState());
      let targetCollection = params.collection;
      const liveBefore = activeStore.getState();
      if (
        targetCollection.isPartial &&
        liveBefore.workspaceMode === 'cloud' &&
        typeof liveBefore.loadCollectionDetails === 'function'
      ) {
        try {
          await liveBefore.loadCollectionDetails(targetCollection.id);
        } catch {
          // Proceed with live collection state if best-effort detail hydration fails.
        }
        if (!isImportTargetMatching(activeStore.getState(), targetBinding)) {
          return { ok: false, cancelled: true };
        }
        targetCollection =
          (activeStore.getState().collections || []).find((c) => c.id === params.collection.id) ||
          targetCollection;
      }
      return persistAndOpenAttached({
        kind: params.kind,
        perfReport: params.perfReport,
        funcReport: params.funcReport,
        target: {
          targetType: 'collection',
          targetId: targetCollection.id,
          targetCollection,
          displayLabel: targetCollection.name,
        },
        targetBinding,
        filename: params.perfReport?.importedFilename || params.funcReport?.importedFilename,
        closeSessionTabId: params.currentTabId,
        onAttachedSaved: params.onAttachedSaved,
      });
    },
    [activeStore, persistAndOpenAttached]
  );

  const pickReportFileContent = useCallback(async (): Promise<{
    filename: string;
    content: string;
    error?: string;
  } | null> => {
    if (adapter?.capabilities?.supportsNativeFileSystem && adapter.openFile) {
      const picked = await adapter.openFile({
        filters: [{ name: 'AirREST Report JSON', extensions: ['json'] }],
      });
      if (!picked) return null;
      if (new TextEncoder().encode(picked.content).byteLength > MAX_IMPORT_FILE_BYTES) {
        return {
          filename: picked.filename,
          content: '',
          error: 'Selected report file exceeds maximum allowed limit of 16 MB.',
        };
      }
      return { filename: picked.filename, content: picked.content };
    }

    if (typeof document === 'undefined') return null;

    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,.airrest-report.json,application/json';
      let settled = false;
      const finish = (val: { filename: string; content: string; error?: string } | null) => {
        if (settled) return;
        settled = true;
        input.remove?.();
        resolve(val);
      };
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          finish(null);
          return;
        }
        if (file.size > MAX_IMPORT_FILE_BYTES) {
          finish({
            filename: file.name || 'report.airrest-report.json',
            content: '',
            error: 'Selected report file exceeds maximum allowed limit of 16 MB.',
          });
          return;
        }
        try {
          const content = await file.text();
          finish({ filename: file.name || 'report.airrest-report.json', content });
        } catch {
          finish(null);
        }
      };
      input.oncancel = () => finish(null);
      input.click();
    });
  }, [adapter]);

  return {
    resolvePrompt,
    handleResolveChoice,
    cancelPendingPrompt,
    importReportContent,
    attachSessionReportToCollection,
    pickReportFileContent,
  };
}
