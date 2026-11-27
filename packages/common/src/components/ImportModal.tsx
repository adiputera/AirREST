'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Upload,
  X,
  FileJson,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Terminal,
  Globe,
  Loader2,
  Copy,
  RefreshCw,
  SkipForward,
  Plus,
  ArrowLeft,
  FolderGit2,
  Flame,
  Play,
} from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { useStoreContext } from '../store/storeContext';
import { parseCurlCommand } from '../lib/curl';
import {
  importPostmanCollectionWithSummary,
  importPostmanEnvironment,
  detectPostmanJsonType,
} from '../lib/postman';
import {
  ImportBatchItem,
  ImportBatchItemOutcome,
  ImportBatchStats,
  ImportTargetBinding,
  captureImportTarget,
  getImportTargetKey,
  isImportTargetMatching,
  parseImportBatchFiles,
  recomputeBatchConflicts,
  toggleImportBatchItem,
  toggleAllImportBatchItems,
  getImportBatchSelectionSummary,
  formatBatchImportSummary,
  isJsonCandidateFile,
  readBrowserFiles,
  MAX_IMPORT_FILE_BYTES,
  getImportUtf8ByteLength,
} from '../lib/importBatch';
import {
  compareCollections,
  generateCopyCollectionName,
  cloneCollectionWithNewIds,
  CollectionDiffSummary,
  compareEnvironments,
  generateCopyEnvironmentName,
  cloneEnvironmentWithNewIds,
  EnvironmentDiffSummary,
} from '../lib/requestDiff';
import { Collection, Environment, HttpMethod } from '../types/api';
import { OpenedFileResult } from '../types/platform';
import { MethodBadge } from './MethodBadge';
import { handleCodeEditorKeyDown } from '../lib/editorHelper';
import { canModifyCollection, canModifyEnvironment, hasScopePermission } from '../lib/jwt';
import { usePlatformAdapter } from '../context';
import { useBackHandler } from '../lib/backNavigation';
import {
  queueInitialRequestEditorSection,
  resolveInitialCurlSection,
} from './requestEditorSectionState';
import { isStrictAirrestReportJson } from '../lib/reportShare';
import { ReportImportResolveModal } from './performance/ReportImportResolveModal';
import { useReportImporter } from './performance/useReportImporter';

interface ImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialFiles?: OpenedFileResult[] | null;
}

export const ImportModal: React.FC<ImportModalProps> = ({ isOpen, onClose, initialFiles }) => {
  const runtimeAdapter = usePlatformAdapter();
  const contextStore = useStoreContext();
  const activeStore = contextStore || useApiStore;
  const reportImporter = useReportImporter();
  const [activeImportTab, setActiveImportTab] = useState<'postman' | 'curl'>('postman');
  const [jsonText, setJsonText] = useState('');
  const [curlText, setCurlText] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const collections = activeStore((state) => state.collections);
  const addCollection = activeStore((state) => state.addCollection);
  const replaceCollection = activeStore((state) => state.replaceCollection);
  const environments = activeStore((state) => state.environments);
  const addEnvironment = activeStore((state) => state.addEnvironment);
  const replaceEnvironment = activeStore((state) => state.replaceEnvironment);
  const createTab = activeStore((state) => state.createTab);
  const workspaceMode = activeStore((state) => state.workspaceMode);
  const cloudConfig = activeStore((state) => state.cloudConfig);

  const [conflict, setConflict] = useState<
    | {
        type: 'collection';
        existingCol: Collection;
        incomingCol: Collection;
        diff: CollectionDiffSummary;
        batchItemId?: string;
      }
    | {
        type: 'environment';
        existingEnv: Environment;
        incomingEnv: Environment;
        diff: EnvironmentDiffSummary;
        batchItemId?: string;
      }
    | null
  >(null);
  const [isResolvingConflict, setIsResolvingConflict] = useState(false);
  const [batchItems, setBatchItems] = useState<ImportBatchItem[] | null>(null);
  const [batchQueue, setBatchQueue] = useState<ImportBatchItem[]>([]);
  const [batchStats, setBatchStats] = useState<ImportBatchStats | null>(null);
  const [isBatchConflict, setIsBatchConflict] = useState(false);
  const [openedFromInitialFiles, setOpenedFromInitialFiles] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const masterCheckboxRef = useRef<HTMLInputElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const batchImportedIdsRef = useRef<Set<string>>(new Set());
  const isMountedRef = useRef(true);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const importRunIdRef = useRef(0);
  const modalOpenGenRef = useRef(0);
  const activeTargetRef = useRef<ImportTargetBinding | null>(null);
  const retryCopyDraftRef = useRef<{
    targetKey: string;
    batchItemId?: string;
    id: string;
    name: string;
  } | null>(null);
  const isImportingRef = useRef(isImporting);
  isImportingRef.current = isImporting;
  const isResolvingConflictRef = useRef(isResolvingConflict);
  isResolvingConflictRef.current = isResolvingConflict;

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const invalidateActiveRun = useCallback(() => {
    importRunIdRef.current += 1;
    activeTargetRef.current = null;
    clearCloseTimer();
  }, [clearCloseTimer]);

  const isRunCurrent = useCallback(
    (runId: number, target: ImportTargetBinding | null): boolean => {
      if (!target || !isMountedRef.current || !isOpenRef.current) return false;
      if (importRunIdRef.current !== runId) return false;
      return isImportTargetMatching(activeStore.getState(), target);
    },
    [activeStore]
  );

  const resetModalState = useCallback(() => {
    modalOpenGenRef.current += 1;
    invalidateActiveRun();
    batchImportedIdsRef.current.clear();
    retryCopyDraftRef.current = null;
    setConflict(null);
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsImporting(false);
    setIsResolvingConflict(false);
    setBatchItems(null);
    setBatchQueue([]);
    setBatchStats(null);
    setIsBatchConflict(false);
    setOpenedFromInitialFiles(false);
  }, [invalidateActiveRun]);

  const handleModalClose = useCallback(() => {
    resetModalState();
    onClose();
  }, [resetModalState, onClose]);

  const openFilesIntoReview = useCallback(
    (files: OpenedFileResult[], mode: 'replace' | 'append') => {
      if (files.length === 0 || !isMountedRef.current || !isOpenRef.current) return;
      if (isImportingRef.current || isResolvingConflictRef.current) return;
      const liveState = activeStore.getState();
      const canWriteCollection = hasScopePermission(
        liveState.cloudConfig.activeScope,
        'collection:write',
        liveState.workspaceMode,
        liveState.cloudConfig.user?.role
      );
      const canWriteEnvironment = hasScopePermission(
        liveState.cloudConfig.activeScope,
        'env:write',
        liveState.workspaceMode,
        liveState.cloudConfig.user?.role
      );

      setBatchItems((prev) => {
        const existingBatch = mode === 'append' && prev ? prev : [];
        const parsed = parseImportBatchFiles(files, {
          existingCollections: liveState.collections,
          existingEnvironments: liveState.environments,
          canWriteCollection,
          canWriteEnvironment,
          existingBatchItems: existingBatch,
        });
        const combined = mode === 'append' ? [...existingBatch, ...parsed] : parsed;
        const targetKey = getImportTargetKey(captureImportTarget(liveState));
        return recomputeBatchConflicts(combined, liveState.collections, liveState.environments, targetKey);
      });
      setActiveImportTab('postman');
      setErrorMsg(null);
      setSuccessMsg(null);
    },
    [activeStore]
  );

  useEffect(() => {
    if (!isOpen) {
      resetModalState();
      return;
    }
    if (initialFiles && initialFiles.length > 0) {
      setOpenedFromInitialFiles(true);
      openFilesIntoReview(initialFiles, 'replace');
    }
  }, [isOpen, initialFiles, openFilesIntoReview, resetModalState]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      invalidateActiveRun();
    };
  }, [invalidateActiveRun]);

  const activeOfflineWorkspaceId = activeStore((state) => state.activeOfflineWorkspaceId);
  useEffect(() => {
    if (!isOpen) return;
    if (activeTargetRef.current && !isImportTargetMatching(activeStore.getState(), activeTargetRef.current)) {
      invalidateActiveRun();
      setIsImporting(false);
      setIsResolvingConflict(false);
      setConflict(null);
      setBatchQueue([]);
      setBatchStats(null);
      setIsBatchConflict(false);
      setErrorMsg('Workspace or session changed. Remaining import items were stopped.');
    }
  }, [
    isOpen,
    workspaceMode,
    activeOfflineWorkspaceId,
    cloudConfig.activeScope?.id,
    cloudConfig.activeScope?.type,
    cloudConfig.user?.id,
    cloudConfig.apiUrl,
    activeStore,
    invalidateActiveRun,
  ]);

  useEffect(() => {
    if (!isOpen || !batchItems || isImporting || isResolvingConflict) return;
    const liveState = activeStore.getState();
    const targetKey = getImportTargetKey(captureImportTarget(liveState));
    const canWriteCollection = hasScopePermission(
      liveState.cloudConfig.activeScope,
      'collection:write',
      liveState.workspaceMode,
      liveState.cloudConfig.user?.role
    );
    const canWriteEnvironment = hasScopePermission(
      liveState.cloudConfig.activeScope,
      'env:write',
      liveState.workspaceMode,
      liveState.cloudConfig.user?.role
    );
    setBatchItems((prev) => {
      if (!prev) return prev;
      const next = recomputeBatchConflicts(prev, collections, environments, targetKey, {
        canWriteCollection,
        canWriteEnvironment,
      });
      const changed = next.some((item, idx) => item !== prev[idx]);
      return changed ? next : prev;
    });
  }, [
    isOpen,
    batchItems,
    isImporting,
    isResolvingConflict,
    collections,
    environments,
    workspaceMode,
    activeOfflineWorkspaceId,
    cloudConfig.activeScope,
    cloudConfig.user?.role,
    activeStore,
  ]);

  useEffect(() => {
    if (!masterCheckboxRef.current || !batchItems) return;
    const summary = getImportBatchSelectionSummary(batchItems);
    masterCheckboxRef.current.indeterminate =
      summary.selected > 0 && summary.selected < summary.selectable;
  }, [batchItems]);

  useEffect(() => {
    if (!isOpen || conflict || activeImportTab !== 'postman') return;

    const handleModalFilePaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return;
      const pastedFiles = Array.from(event.clipboardData?.files || []).filter(isJsonCandidateFile);
      if (pastedFiles.length === 0) return;

      event.preventDefault();
      event.stopPropagation();
      if (isImportingRef.current || isResolvingConflictRef.current) return;
      const openGen = modalOpenGenRef.current;
      void readBrowserFiles(pastedFiles).then((opened) => {
        if (
          !isMountedRef.current ||
          !isOpenRef.current ||
          modalOpenGenRef.current !== openGen ||
          isImportingRef.current ||
          isResolvingConflictRef.current
        ) {
          return;
        }
        if (opened.length > 0) {
          openFilesIntoReview(opened, batchItems ? 'append' : 'replace');
        }
      });
    };

    window.addEventListener('paste', handleModalFilePaste, true);
    return () => {
      window.removeEventListener('paste', handleModalFilePaste, true);
    };
  }, [isOpen, conflict, activeImportTab, batchItems, openFilesIntoReview]);

  useBackHandler(isOpen, () => {
    if (isImporting || isResolvingConflict) return;
    if (conflict) {
      invalidateActiveRun();
      retryCopyDraftRef.current = null;
      setConflict(null);
      setBatchQueue([]);
      setBatchStats(null);
      setIsBatchConflict(false);
      setErrorMsg(null);
      return;
    }
    if (batchItems !== null) {
      if (openedFromInitialFiles) {
        handleModalClose();
      } else {
        setBatchItems(null);
        setErrorMsg(null);
        setSuccessMsg(null);
      }
      return;
    }
    handleModalClose();
  }, 20);

  if (!isOpen) return null;

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0 || isImportingRef.current || isResolvingConflictRef.current) return;
    setErrorMsg(null);
    setSuccessMsg(null);

    const openGen = modalOpenGenRef.current;
    const opened = await readBrowserFiles(files, { requireJsonExtension: false });
    if (
      !isMountedRef.current ||
      !isOpenRef.current ||
      modalOpenGenRef.current !== openGen ||
      isImportingRef.current ||
      isResolvingConflictRef.current
    ) {
      return;
    }
    openFilesIntoReview(opened, batchItems ? 'append' : 'replace');
  };

  const handleFileDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isImportingRef.current || isResolvingConflictRef.current) return;
    setErrorMsg(null);
    setSuccessMsg(null);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;

    const openGen = modalOpenGenRef.current;
    const opened = await readBrowserFiles(files, { requireJsonExtension: true });
    if (
      !isMountedRef.current ||
      !isOpenRef.current ||
      modalOpenGenRef.current !== openGen ||
      isImportingRef.current ||
      isResolvingConflictRef.current
    ) {
      return;
    }
    openFilesIntoReview(opened, batchItems ? 'append' : 'replace');
  };

  const handleChooseFileClick = async (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (isImportingRef.current || isResolvingConflictRef.current) return;
    const adapter = runtimeAdapter;
    const openGen = modalOpenGenRef.current;
    if (adapter?.capabilities?.supportsNativeFileSystem && adapter?.openFiles) {
      try {
        setErrorMsg(null);
        setSuccessMsg(null);
        const results = await adapter.openFiles({
          filters: [{ name: 'Postman JSON Files', extensions: ['json'] }],
        });
        if (
          !isMountedRef.current ||
          !isOpenRef.current ||
          modalOpenGenRef.current !== openGen ||
          isImportingRef.current ||
          isResolvingConflictRef.current
        ) {
          return;
        }
        if (results && results.length > 0) {
          openFilesIntoReview(results, batchItems ? 'append' : 'replace');
        }
      } catch (err) {
        if (!isMountedRef.current || !isOpenRef.current || modalOpenGenRef.current !== openGen) return;
        setErrorMsg(err instanceof Error ? err.message : 'Failed to open files via system dialog.');
      }
      return;
    }
    if (adapter?.capabilities?.supportsNativeFileSystem && adapter?.openFile) {
      try {
        setErrorMsg(null);
        setSuccessMsg(null);
        const result = await adapter.openFile({
          filters: [{ name: 'Postman JSON Files', extensions: ['json'] }],
        });
        if (
          !isMountedRef.current ||
          !isOpenRef.current ||
          modalOpenGenRef.current !== openGen ||
          isImportingRef.current ||
          isResolvingConflictRef.current
        ) {
          return;
        }
        if (result && typeof result.content === 'string') {
          openFilesIntoReview([result], batchItems ? 'append' : 'replace');
        }
      } catch (err) {
        if (!isMountedRef.current || !isOpenRef.current || modalOpenGenRef.current !== openGen) return;
        setErrorMsg(err instanceof Error ? err.message : 'Failed to open file via system dialog.');
      }
      return;
    }

    // Web / Extension fallback: trigger standard HTML file input
    fileInputRef.current?.click();
  };

  const markBatchItemOutcome = (
    itemId: string,
    outcome: ImportBatchItemOutcome,
    extra?: { error?: string; retryCollectionId?: string; retryEnvironmentId?: string; retryTargetKey?: string }
  ) => {
    setBatchItems((prev) => {
      if (!prev) return prev;
      const liveState = activeStore.getState();
      const targetKey = getImportTargetKey(captureImportTarget(liveState));
      const updated = prev.map((item) => {
        if (item.id !== itemId) return item;
        if (outcome === 'imported' || outcome === 'skipped') {
          return {
            ...item,
            outcome,
            checked: false,
            disabled: true,
            hasConflict: false,
            error: undefined,
            retryCollectionId: undefined,
            retryEnvironmentId: undefined,
            retryTargetKey: undefined,
          };
        }
        return {
          ...item,
          outcome: 'failed' as const,
          checked: true,
          disabled: false,
          error: extra?.error,
          retryCollectionId: extra?.retryCollectionId,
          retryEnvironmentId: extra?.retryEnvironmentId,
          retryTargetKey: extra?.retryTargetKey,
        };
      });
      return recomputeBatchConflicts(updated, liveState.collections, liveState.environments, targetKey);
    });
  };

  const finishBatchRun = (
    stats: ImportBatchStats,
    runId: number,
    target: ImportTargetBinding
  ) => {
    if (!isRunCurrent(runId, target)) return;
    setBatchQueue([]);
    setBatchStats(null);
    setIsBatchConflict(false);
    setIsImporting(false);
    activeTargetRef.current = null;

    const summary = formatBatchImportSummary(stats);
    if (stats.failed.length > 0) {
      const failDetails = stats.failed.map((f) => `${f.name}: ${f.error}`).join(' | ');
      setErrorMsg(`${summary} ${failDetails}`);
      if (
        stats.collectionsImported > 0 ||
        stats.environmentsImported > 0 ||
        (stats.reportsImported ?? 0) > 0
      ) {
        setSuccessMsg(summary);
      }
      return;
    }

    setSuccessMsg(summary);
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      if (!isRunCurrent(runId, target)) return;
      handleModalClose();
    }, 900);
  };

  const processBatchQueue = async (
    queue: ImportBatchItem[],
    initialStats: ImportBatchStats,
    runId: number,
    target: ImportTargetBinding
  ) => {
    const currentStats: ImportBatchStats = {
      collectionsImported: initialStats.collectionsImported,
      environmentsImported: initialStats.environmentsImported,
      reportsImported: initialStats.reportsImported ?? 0,
      skipped: initialStats.skipped,
      failed: [...initialStats.failed],
    };
    const targetKey = getImportTargetKey(target);

    for (let i = 0; i < queue.length; i++) {
      if (!isRunCurrent(runId, target)) return;
      const item = queue[i];
      if (item.outcome === 'imported' || item.outcome === 'skipped') {
        continue;
      }
      const remaining = queue.slice(i + 1);
      const liveState = activeStore.getState();

      if (item.type === 'environment' && item.parsedEnvironment) {
        if (
          !hasScopePermission(
            liveState.cloudConfig.activeScope,
            'env:write',
            liveState.workspaceMode,
            liveState.cloudConfig.user?.role
          )
        ) {
          const permErr =
            'Insufficient permission to import environments into this scope (requires env:write).';
          markBatchItemOutcome(item.id, 'failed', { error: permErr, retryTargetKey: targetKey });
          currentStats.failed.push({
            name: item.name,
            error: permErr,
          });
          continue;
        }

        const incomingEnv = cloneEnvironmentWithNewIds(
          item.parsedEnvironment,
          item.parsedEnvironment.name
        );
        const isExplicitEnvRetry = Boolean(
          item.outcome === 'failed' &&
            item.retryEnvironmentId &&
            item.retryTargetKey === targetKey &&
            liveState.environments.some(
              (e) => e.id === item.retryEnvironmentId && e._syncStatus === 'pending'
            )
        );
        if (isExplicitEnvRetry && item.retryEnvironmentId) {
          incomingEnv.id = item.retryEnvironmentId;
        }

        const existingEnv = liveState.environments.find(
          (e) =>
            String(e.name ?? '').trim().toLowerCase() ===
              String(incomingEnv.name ?? '').trim().toLowerCase() &&
            !(isExplicitEnvRetry && e.id === item.retryEnvironmentId)
        );

        if (existingEnv) {
          const diff = compareEnvironments(existingEnv, incomingEnv);
          if (!isRunCurrent(runId, target)) return;
          setBatchQueue(remaining);
          setBatchStats(currentStats);
          setIsBatchConflict(true);
          setConflict({
            type: 'environment',
            existingEnv,
            incomingEnv,
            diff,
            batchItemId: item.id,
          });
          return;
        }

        try {
          await addEnvironment(incomingEnv, { target, isRetry: isExplicitEnvRetry });
          if (!isRunCurrent(runId, target)) return;
          markBatchItemOutcome(item.id, 'imported');
          currentStats.environmentsImported += 1;
        } catch (err: unknown) {
          if (!isRunCurrent(runId, target)) return;
          const errMsg = err instanceof Error ? err.message : 'Failed to import environment.';
          const postState = activeStore.getState();
          const hasLocalEnvDraft = postState.environments.some(
            (e) => e.id === incomingEnv.id && e._syncStatus === 'pending'
          );
          markBatchItemOutcome(item.id, 'failed', {
            error: errMsg,
            retryEnvironmentId: hasLocalEnvDraft ? incomingEnv.id : undefined,
            retryTargetKey: hasLocalEnvDraft ? targetKey : undefined,
          });
          currentStats.failed.push({
            name: item.name,
            error: errMsg,
          });
        }
      } else if (item.type === 'collection' && item.parsedCollection) {
        if (
          !hasScopePermission(
            liveState.cloudConfig.activeScope,
            'collection:write',
            liveState.workspaceMode,
            liveState.cloudConfig.user?.role
          )
        ) {
          const permErr =
            'Insufficient permission to import collections into this scope (requires collection:write).';
          markBatchItemOutcome(item.id, 'failed', { error: permErr, retryTargetKey: targetKey });
          currentStats.failed.push({
            name: item.name,
            error: permErr,
          });
          continue;
        }

        const incomingCol = cloneCollectionWithNewIds(
          item.parsedCollection,
          item.parsedCollection.name
        );
        const isExplicitColRetry = Boolean(
          item.outcome === 'failed' &&
            item.retryCollectionId &&
            item.retryTargetKey === targetKey &&
            liveState.collections.some(
              (c) => c.id === item.retryCollectionId && c._syncStatus === 'pending'
            )
        );
        if (isExplicitColRetry && item.retryCollectionId) {
          incomingCol.id = item.retryCollectionId;
        }

        const existingCol = liveState.collections.find(
          (c) =>
            String(c.name ?? '').trim().toLowerCase() ===
              String(incomingCol.name ?? '').trim().toLowerCase() &&
            !(isExplicitColRetry && c.id === item.retryCollectionId)
        );

        if (existingCol) {
          const diff = compareCollections(existingCol, incomingCol);
          if (!isRunCurrent(runId, target)) return;
          setBatchQueue(remaining);
          setBatchStats(currentStats);
          setIsBatchConflict(true);
          setConflict({
            type: 'collection',
            existingCol,
            incomingCol,
            diff,
            batchItemId: item.id,
          });
          return;
        }

        try {
          await addCollection(incomingCol, { target, isRetry: isExplicitColRetry });
          if (!isRunCurrent(runId, target)) return;
          batchImportedIdsRef.current.add(incomingCol.id);
          markBatchItemOutcome(item.id, 'imported');
          currentStats.collectionsImported += 1;
        } catch (err: unknown) {
          if (!isRunCurrent(runId, target)) return;
          const errMsg = err instanceof Error ? err.message : 'Failed to import collection.';
          const postState = activeStore.getState();
          const hasPendingDraft = postState.collections.some(
            (c) => c.id === incomingCol.id && c._syncStatus === 'pending'
          );
          markBatchItemOutcome(item.id, 'failed', {
            error: errMsg,
            retryCollectionId: hasPendingDraft ? incomingCol.id : undefined,
            retryTargetKey: hasPendingDraft ? targetKey : undefined,
          });
          currentStats.failed.push({
            name: item.name,
            error: errMsg,
          });
        }
      } else if (
        (item.type === 'performance_report' || item.type === 'functional_report') &&
        item.rawReportContent
      ) {
        try {
          const outcome = await reportImporter.importReportContent(item.rawReportContent, {
            filename: item.filename,
          });
          if (!isRunCurrent(runId, target)) return;
          if (outcome.cancelled) {
            markBatchItemOutcome(item.id, 'skipped');
            currentStats.skipped += 1;
          } else if (!outcome.ok) {
            const errMsg = outcome.error || 'Failed to import report.';
            markBatchItemOutcome(item.id, 'failed', { error: errMsg, retryTargetKey: targetKey });
            currentStats.failed.push({
              name: item.name,
              error: errMsg,
            });
          } else {
            markBatchItemOutcome(item.id, 'imported');
            currentStats.reportsImported = (currentStats.reportsImported ?? 0) + 1;
          }
        } catch (err: unknown) {
          if (!isRunCurrent(runId, target)) return;
          const errMsg = err instanceof Error ? err.message : 'Failed to import report.';
          markBatchItemOutcome(item.id, 'failed', { error: errMsg, retryTargetKey: targetKey });
          currentStats.failed.push({
            name: item.name,
            error: errMsg,
          });
        }
      }
    }

    finishBatchRun(currentStats, runId, target);
  };

  const handleImportBatch = async () => {
    if (!batchItems) return;
    setErrorMsg(null);
    setSuccessMsg(null);

    const selectedItems = batchItems.filter(
      (item) =>
        item.checked &&
        !item.disabled &&
        item.type !== 'invalid' &&
        item.outcome !== 'imported' &&
        item.outcome !== 'skipped'
    );
    if (selectedItems.length === 0) {
      setErrorMsg('Please select at least one valid file to import.');
      return;
    }

    // Always process collections and environments before reports so attached report matching works inside mixed batches
    const orderedItems = [...selectedItems].sort((a, b) => {
      const aRank = a.type === 'performance_report' || a.type === 'functional_report' ? 1 : 0;
      const bRank = b.type === 'performance_report' || b.type === 'functional_report' ? 1 : 0;
      return aRank - bRank;
    });

    const runId = ++importRunIdRef.current;
    const target = captureImportTarget(activeStore.getState());
    activeTargetRef.current = target;

    setIsImporting(true);
    batchImportedIdsRef.current = new Set();
    try {
      await processBatchQueue(
        orderedItems,
        {
          collectionsImported: 0,
          environmentsImported: 0,
          reportsImported: 0,
          skipped: 0,
          failed: [],
        },
        runId,
        target
      );
    } finally {
      if (importRunIdRef.current === runId && isMountedRef.current && isOpenRef.current) {
        setIsImporting(false);
      }
    }
  };

  const handleImportPostman = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!jsonText.trim()) {
      setErrorMsg('Please paste JSON content or select a file first.');
      return;
    }
    if (getImportUtf8ByteLength(jsonText) > MAX_IMPORT_FILE_BYTES) {
      setErrorMsg('Pasted content exceeds maximum allowed limit of 16 MB.');
      return;
    }

    const runId = ++importRunIdRef.current;
    const target = captureImportTarget(activeStore.getState());
    activeTargetRef.current = target;

    setIsImporting(true);
    batchImportedIdsRef.current = new Set();
    try {
      const liveState = activeStore.getState();
      const detected = detectPostmanJsonType(jsonText);

      if (detected === 'unknown') {
        if (isStrictAirrestReportJson(jsonText)) {
          const reportRes = await reportImporter.importReportContent(jsonText, {
            filename: 'pasted.airrest-report.json',
          });
          if (!isRunCurrent(runId, target)) return;
          if (reportRes.cancelled) return;
          if (!reportRes.ok) {
            setErrorMsg(reportRes.error || 'Failed to import AirREST report JSON.');
            return;
          }
          setSuccessMsg(reportRes.message || 'AirREST report imported!');
          clearCloseTimer();
          closeTimerRef.current = setTimeout(() => {
            if (!isRunCurrent(runId, target)) return;
            setJsonText('');
            handleModalClose();
          }, 900);
          return;
        }
        invalidateActiveRun();
        setErrorMsg('Unrecognized JSON format. Expected a Postman Collection, Environment, or AirREST Report JSON.');
        return;
      }

      if (detected === 'environment') {
        if (
          !hasScopePermission(
            liveState.cloudConfig.activeScope,
            'env:write',
            liveState.workspaceMode,
            liveState.cloudConfig.user?.role
          )
        ) {
          setErrorMsg('Insufficient permission to import environments into this scope (requires env:write).');
          return;
        }

        const incomingEnv = importPostmanEnvironment(jsonText);
        const existingEnv = liveState.environments.find(
          (e) =>
            String(e.name ?? '').trim().toLowerCase() ===
            String(incomingEnv.name ?? '').trim().toLowerCase()
        );

        if (existingEnv) {
          const diff = compareEnvironments(existingEnv, incomingEnv);
          setConflict({
            type: 'environment',
            existingEnv,
            incomingEnv,
            diff,
          });
          return;
        }

        await addEnvironment(incomingEnv, { target });
        if (!isRunCurrent(runId, target)) return;
        setSuccessMsg(`Postman Environment "${incomingEnv.name}" imported and activated!`);
        clearCloseTimer();
        closeTimerRef.current = setTimeout(() => {
          if (!isRunCurrent(runId, target)) return;
          setJsonText('');
          handleModalClose();
        }, 900);
      } else {
        if (
          !hasScopePermission(
            liveState.cloudConfig.activeScope,
            'collection:write',
            liveState.workspaceMode,
            liveState.cloudConfig.user?.role
          )
        ) {
          setErrorMsg('Insufficient permission to import collections into this scope (requires collection:write).');
          return;
        }

        const { collection: incomingCol, exampleImportSummary } = importPostmanCollectionWithSummary(jsonText);
        const existingCol = liveState.collections.find(
          (c) =>
            String(c.name ?? '').trim().toLowerCase() ===
            String(incomingCol.name ?? '').trim().toLowerCase()
        );

        if (existingCol) {
          const diff = compareCollections(existingCol, incomingCol);
          setConflict({
            type: 'collection',
            existingCol,
            incomingCol,
            diff,
          });
          return;
        }

        await addCollection(incomingCol, { target });
        if (!isRunCurrent(runId, target)) return;
        const skippedNote = exampleImportSummary.skipped > 0
          ? ` (${exampleImportSummary.skipped} invalid/unsupported response example${exampleImportSummary.skipped === 1 ? '' : 's'} skipped${exampleImportSummary.skippedReasons.length > 0 ? `: ${exampleImportSummary.skippedReasons[0]}` : ''})`
          : '';
        setSuccessMsg(`Postman Collection "${incomingCol.name}" imported and synced!${skippedNote}`);
        clearCloseTimer();
        closeTimerRef.current = setTimeout(() => {
          if (!isRunCurrent(runId, target)) return;
          setJsonText('');
          handleModalClose();
        }, 900);
      }
    } catch (err: unknown) {
      if (!isRunCurrent(runId, target)) return;
      setErrorMsg(err instanceof Error ? err.message : 'Failed to parse Postman file.');
    } finally {
      if (importRunIdRef.current === runId && isMountedRef.current && isOpenRef.current) {
        setIsImporting(false);
      }
    }
  };

  const handleBackFromConflict = () => {
    invalidateActiveRun();
    retryCopyDraftRef.current = null;
    setConflict(null);
    setErrorMsg(null);
    if (isBatchConflict) {
      setBatchQueue([]);
      setBatchStats(null);
      setIsBatchConflict(false);
      setIsImporting(false);
    }
  };

  const advanceBatchAfterConflict = async (
    outcome: 'collection' | 'environment' | 'skipped',
    runId: number,
    target: ImportTargetBinding
  ) => {
    if (!isRunCurrent(runId, target)) return;
    const baseStats = batchStats || {
      collectionsImported: 0,
      environmentsImported: 0,
      skipped: 0,
      failed: [],
    };
    const nextStats: ImportBatchStats = {
      collectionsImported:
        baseStats.collectionsImported + (outcome === 'collection' ? 1 : 0),
      environmentsImported:
        baseStats.environmentsImported + (outcome === 'environment' ? 1 : 0),
      reportsImported: baseStats.reportsImported ?? 0,
      skipped: baseStats.skipped + (outcome === 'skipped' ? 1 : 0),
      failed: [...baseStats.failed],
    };
    const remaining = batchQueue;
    setConflict(null);
    if (remaining.length > 0) {
      await processBatchQueue(remaining, nextStats, runId, target);
    } else {
      finishBatchRun(nextStats, runId, target);
    }
  };

  const handleSkipConflict = async () => {
    if (!conflict || !isBatchConflict) return;
    retryCopyDraftRef.current = null;
    const runId = importRunIdRef.current;
    const target = activeTargetRef.current;
    if (!isRunCurrent(runId, target) || !target) return;
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsResolvingConflict(true);
    try {
      if (conflict.batchItemId) {
        markBatchItemOutcome(conflict.batchItemId, 'skipped');
      }
      await advanceBatchAfterConflict('skipped', runId, target);
    } finally {
      if (importRunIdRef.current === runId && isMountedRef.current && isOpenRef.current) {
        setIsResolvingConflict(false);
      }
    }
  };

  const handleImportAsCopy = async () => {
    if (!conflict) return;
    const runId = isBatchConflict ? importRunIdRef.current : ++importRunIdRef.current;
    const target = isBatchConflict
      ? activeTargetRef.current
      : captureImportTarget(activeStore.getState());
    if (!isBatchConflict) {
      activeTargetRef.current = target;
    }
    if (!isRunCurrent(runId, target) || !target) return;

    setIsResolvingConflict(true);
    setErrorMsg(null);
    try {
      const liveState = activeStore.getState();
      const targetKey = getImportTargetKey(target);
      const importedType: 'collection' | 'environment' = conflict.type;
      if (conflict.type === 'collection') {
        if (!hasScopePermission(liveState.cloudConfig.activeScope, 'collection:write', liveState.workspaceMode, liveState.cloudConfig.user?.role)) {
          setErrorMsg('Insufficient permission to create collection copies in this scope (requires collection:write).');
          return;
        }

        const existingCopyDraft =
          retryCopyDraftRef.current &&
          retryCopyDraftRef.current.targetKey === targetKey &&
          retryCopyDraftRef.current.batchItemId === conflict.batchItemId &&
          liveState.collections.some(
            (c) => c.id === retryCopyDraftRef.current?.id && c._syncStatus === 'pending'
          )
            ? retryCopyDraftRef.current
            : null;

        const copyName = existingCopyDraft
          ? existingCopyDraft.name
          : generateCopyCollectionName(conflict.incomingCol.name, liveState.collections.map((c) => c.name));
        const copyCol = cloneCollectionWithNewIds(conflict.incomingCol, copyName);
        if (existingCopyDraft) {
          copyCol.id = existingCopyDraft.id;
        }
        retryCopyDraftRef.current = {
          targetKey,
          batchItemId: conflict.batchItemId,
          id: copyCol.id,
          name: copyName,
        };

        await addCollection(copyCol, { target, isRetry: Boolean(existingCopyDraft) });
        if (!isRunCurrent(runId, target)) return;
        retryCopyDraftRef.current = null;
        batchImportedIdsRef.current.add(copyCol.id);
        if (!isBatchConflict) {
          setSuccessMsg(`Postman Collection "${copyName}" imported as copy!`);
        }
      } else {
        if (!hasScopePermission(liveState.cloudConfig.activeScope, 'env:write', liveState.workspaceMode, liveState.cloudConfig.user?.role)) {
          setErrorMsg('Insufficient permission to create environment copies in this scope (requires env:write).');
          return;
        }

        const existingCopyDraft =
          retryCopyDraftRef.current &&
          retryCopyDraftRef.current.targetKey === targetKey &&
          retryCopyDraftRef.current.batchItemId === conflict.batchItemId &&
          liveState.environments.some(
            (e) => e.id === retryCopyDraftRef.current?.id && e._syncStatus === 'pending'
          )
            ? retryCopyDraftRef.current
            : null;

        const copyName = existingCopyDraft
          ? existingCopyDraft.name
          : generateCopyEnvironmentName(conflict.incomingEnv.name, liveState.environments.map((e) => e.name));
        const copyEnv = cloneEnvironmentWithNewIds(conflict.incomingEnv, copyName);
        if (existingCopyDraft) {
          copyEnv.id = existingCopyDraft.id;
        }
        retryCopyDraftRef.current = {
          targetKey,
          batchItemId: conflict.batchItemId,
          id: copyEnv.id,
          name: copyName,
        };

        await addEnvironment(copyEnv, { target, isRetry: Boolean(existingCopyDraft) });
        if (!isRunCurrent(runId, target)) return;
        retryCopyDraftRef.current = null;
        if (!isBatchConflict) {
          setSuccessMsg(`Postman Environment "${copyName}" imported as copy!`);
        }
      }

      if (isBatchConflict) {
        if (conflict.batchItemId) {
          markBatchItemOutcome(conflict.batchItemId, 'imported');
        }
        await advanceBatchAfterConflict(importedType, runId, target);
        return;
      }

      clearCloseTimer();
      closeTimerRef.current = setTimeout(() => {
        if (!isRunCurrent(runId, target)) return;
        setJsonText('');
        handleModalClose();
      }, 900);
    } catch (err: unknown) {
      if (!isRunCurrent(runId, target)) return;
      setErrorMsg(
        err instanceof Error
          ? err.message
          : `Failed to import ${conflict.type} as copy.`
      );
    } finally {
      if (importRunIdRef.current === runId && isMountedRef.current && isOpenRef.current) {
        setIsResolvingConflict(false);
      }
    }
  };

  const handleReplace = async () => {
    if (!conflict) return;
    retryCopyDraftRef.current = null;
    const runId = isBatchConflict ? importRunIdRef.current : ++importRunIdRef.current;
    const target = isBatchConflict
      ? activeTargetRef.current
      : captureImportTarget(activeStore.getState());
    if (!isBatchConflict) {
      activeTargetRef.current = target;
    }
    if (!isRunCurrent(runId, target) || !target) return;

    setIsResolvingConflict(true);
    setErrorMsg(null);
    try {
      const liveState = activeStore.getState();
      const importedType: 'collection' | 'environment' = conflict.type;
      if (conflict.type === 'collection') {
        if (!canModifyCollection(conflict.existingCol.minRole, liveState.cloudConfig.activeScope, liveState.workspaceMode, liveState.cloudConfig.user?.role)) {
          setErrorMsg(`Cannot replace collection: read-only for your role or lacking write permissions.`);
          return;
        }

        await replaceCollection(conflict.existingCol.id, conflict.incomingCol, { target });
        if (!isRunCurrent(runId, target)) return;
        batchImportedIdsRef.current.add(conflict.existingCol.id);
        if (!isBatchConflict) {
          setSuccessMsg(`Collection "${conflict.existingCol.name}" replaced successfully!`);
        }
      } else {
        if (!hasScopePermission(liveState.cloudConfig.activeScope, 'env:write', liveState.workspaceMode, liveState.cloudConfig.user?.role) ||
            !canModifyEnvironment(conflict.existingEnv.minRole, liveState.cloudConfig.activeScope, liveState.workspaceMode, liveState.cloudConfig.user?.role)) {
          setErrorMsg('Cannot replace environment: read-only for your role or lacking write permissions.');
          return;
        }

        await replaceEnvironment(conflict.existingEnv.id, conflict.incomingEnv, { target });
        if (!isRunCurrent(runId, target)) return;
        if (!isBatchConflict) {
          setSuccessMsg(`Environment "${conflict.existingEnv.name}" replaced successfully!`);
        }
      }

      if (isBatchConflict) {
        if (conflict.batchItemId) {
          markBatchItemOutcome(conflict.batchItemId, 'imported');
        }
        await advanceBatchAfterConflict(importedType, runId, target);
        return;
      }

      clearCloseTimer();
      closeTimerRef.current = setTimeout(() => {
        if (!isRunCurrent(runId, target)) return;
        setJsonText('');
        handleModalClose();
      }, 900);
    } catch (err: unknown) {
      if (!isRunCurrent(runId, target)) return;
      if (conflict?.type === 'environment' && activeStore.getState().environmentOccConflict) {
        // Yield cleanly to the dedicated EnvironmentOccModal instead of stacking modals
        handleModalClose();
        return;
      }
      setErrorMsg(
        err instanceof Error
          ? err.message
          : `Failed to replace ${conflict.type}.`
      );
    } finally {
      if (importRunIdRef.current === runId && isMountedRef.current && isOpenRef.current) {
        setIsResolvingConflict(false);
      }
    }
  };

  const handleImportCurl = () => {
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!curlText.trim()) {
      setErrorMsg('Please paste a cURL command first.');
      return;
    }

    try {
      const parsedReq = parseCurlCommand(curlText);
      if (!parsedReq.url) {
        setErrorMsg('Could not detect a valid URL in the cURL command.');
        return;
      }

      const targetSection = resolveInitialCurlSection(parsedReq);
      createTab(parsedReq);
      const newTabId = activeStore.getState().activeTabId;
      if (newTabId) {
        queueInitialRequestEditorSection(newTabId, targetSection);
      }
      const runId = ++importRunIdRef.current;
      const target = captureImportTarget(activeStore.getState());
      activeTargetRef.current = target;

      setSuccessMsg('cURL request imported into a new tab!');
      clearCloseTimer();
      closeTimerRef.current = setTimeout(() => {
        if (!isRunCurrent(runId, target)) return;
        setCurlText('');
        handleModalClose();
      }, 700);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to parse cURL command.');
    }
  };

  const batchSummary = batchItems ? getImportBatchSelectionSummary(batchItems) : null;

  return (
    <div
      data-modal="true"
      role="dialog"
      aria-modal="true"
      onDragOver={(e) => {
        if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (!conflict && activeImportTab === 'postman' && !isImporting && !isResolvingConflict) {
          void handleFileDrop(e);
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
    >
      <div className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-surface p-4 shadow-2xl md:p-6">
        {/* Hidden File Input placed outside clickable triggers to prevent recursive bubbling */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".json,application/json"
          onChange={handleFileUpload}
          onClick={(e) => e.stopPropagation()}
          className="hidden"
        />

        {conflict ? (
          conflict.type === 'environment' ? (
            /* Environment Conflict Resolution View */
            <div>
              {/* Header */}
              <div className="flex items-center justify-between border-b border-line pb-4">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500 dark:text-amber-400 border border-amber-500/20">
                    <AlertTriangle className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-base font-semibold text-tx-primary">Environment Already Exists</h2>
                      {isBatchConflict && (
                        <span className="inline-flex items-center rounded-full border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-300">
                          Batch Import • {batchQueue.length} remaining
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-tx-muted">
                      An environment named <span className="font-semibold text-zinc-200">"{conflict.existingEnv.name}"</span> already exists in your workspace.
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleModalClose}
                  className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Variable Differences Breakdown */}
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-zinc-200 flex items-center gap-2">
                    <Globe className="h-3.5 w-3.5 text-sky-400" />
                    <span>Variable Differences</span>
                    <span className="text-[11px] font-normal text-zinc-500">
                      ({conflict.diff.added.length + conflict.diff.modified.length + conflict.diff.removed.length} changes detected)
                    </span>
                  </span>

                  <div className="flex items-center gap-1.5 text-[11px]">
                    {conflict.diff.added.length > 0 && (
                      <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-400 border border-emerald-500/20">
                        +{conflict.diff.added.length} Added
                      </span>
                    )}
                    {conflict.diff.modified.length > 0 && (
                      <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-400 border border-amber-500/20">
                        ~{conflict.diff.modified.length} Modified
                      </span>
                    )}
                    {conflict.diff.removed.length > 0 && (
                      <span className="inline-flex items-center rounded-full bg-rose-500/10 px-2 py-0.5 font-medium text-rose-400 border border-rose-500/20">
                        -{conflict.diff.removed.length} Removed
                      </span>
                    )}
                    {conflict.diff.unchangedCount > 0 && (
                      <span className="inline-flex items-center rounded-full bg-zinc-850 px-2 py-0.5 font-medium text-zinc-400 border border-zinc-750">
                        {conflict.diff.unchangedCount} Same
                      </span>
                    )}
                  </div>
                </div>

                {/* Changed Variables List */}
                <div className="max-h-56 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 space-y-1.5">
                  {conflict.diff.added.length === 0 &&
                  conflict.diff.modified.length === 0 &&
                  conflict.diff.removed.length === 0 ? (
                    <div className="py-6 text-center text-xs text-zinc-400">
                      All {conflict.diff.totalIncoming} variables are identical between existing and incoming environment.
                    </div>
                  ) : (
                    <>
                      {conflict.diff.added.map((item, idx) => (
                        <div
                          key={`added-${item.key}-${idx}`}
                          className="flex items-center justify-between rounded-lg bg-zinc-950/70 px-3 py-2 border border-zinc-850/80 hover:border-emerald-500/30 transition"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              + Added
                            </span>
                            <span className="text-xs font-mono font-medium text-sky-400 truncate">
                              {item.key}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-xs font-mono ml-3 shrink-0 max-w-[280px]">
                            <span className="text-emerald-400 truncate">
                              {item.newValue || <em className="text-zinc-600 text-[11px] not-italic">empty</em>}
                            </span>
                            {item.newEnabled === false && (
                              <span className="text-[10px] text-zinc-500 italic">(disabled)</span>
                            )}
                          </div>
                        </div>
                      ))}

                      {conflict.diff.modified.map((item, idx) => (
                        <div
                          key={`mod-${item.key}-${idx}`}
                          className="flex items-center justify-between rounded-lg bg-zinc-950/70 px-3 py-2 border border-zinc-850/80 hover:border-amber-500/30 transition"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                              ~ Modified
                            </span>
                            <span className="text-xs font-mono font-medium text-sky-400 truncate">
                              {item.key}
                            </span>
                          </div>
                          <div className="flex flex-col items-end text-xs font-mono ml-3 shrink-0 max-w-[320px]">
                            {item.oldValue !== item.newValue ? (
                              <div className="flex items-center gap-1.5 truncate max-w-full">
                                <span className="text-rose-400 line-through opacity-70 truncate max-w-[130px]">
                                  {item.oldValue || '""'}
                                </span>
                                <span className="text-zinc-500">→</span>
                                <span className="text-amber-300 font-medium truncate max-w-[130px]">
                                  {item.newValue || '""'}
                                </span>
                              </div>
                            ) : (
                              <span className="text-zinc-400 truncate max-w-[200px]">{item.newValue}</span>
                            )}
                            {item.oldEnabled !== item.newEnabled && (
                              <span className="text-[10px] text-zinc-500 mt-0.5">
                                {item.oldEnabled ? 'enabled' : 'disabled'} → {item.newEnabled ? 'enabled' : 'disabled'}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}

                      {conflict.diff.removed.map((item, idx) => (
                        <div
                          key={`rem-${item.key}-${idx}`}
                          className="flex items-center justify-between rounded-lg bg-zinc-950/70 px-3 py-2 border border-zinc-850/80 hover:border-rose-500/30 transition"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20">
                              - Removed
                            </span>
                            <span className="text-xs font-mono font-medium text-zinc-400 line-through truncate">
                              {item.key}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-xs font-mono ml-3 shrink-0 max-w-[280px]">
                            <span className="text-rose-400/80 truncate">
                              {item.oldValue || <em className="text-zinc-600 text-[11px] not-italic">empty</em>}
                            </span>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>

              {/* Explanation Options */}
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                  <div className="flex items-center gap-1.5 font-semibold text-zinc-200">
                    <Copy className="h-3.5 w-3.5 text-sky-400" />
                    <span>Import as Copy</span>
                  </div>
                  <p className="mt-1 text-zinc-400 text-[11px] leading-relaxed">
                    Imports as a new environment named{' '}
                    <span className="font-semibold text-sky-300">
                      "{generateCopyEnvironmentName(conflict.incomingEnv.name, environments.map((e) => e.name))}"
                    </span>
                    . Existing environment is kept intact.
                  </p>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                  <div className="flex items-center gap-1.5 font-semibold text-zinc-200">
                    <RefreshCw className="h-3.5 w-3.5 text-amber-400" />
                    <span>Replace Environment</span>
                  </div>
                  <p className="mt-1 text-zinc-400 text-[11px] leading-relaxed">
                    Replaces <span className="font-semibold text-amber-300">"{conflict.existingEnv.name}"</span> in-place. Variable values will be updated and synced.
                  </p>
                </div>
              </div>

              {/* Alerts */}
              {errorMsg && (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              {successMsg && (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>{successMsg}</span>
                </div>
              )}

              {/* Conflict Footer Actions */}
              <div className="mt-6 flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2.5">
                <button
                  type="button"
                  disabled={isResolvingConflict}
                  onClick={handleBackFromConflict}
                  className="rounded-xl px-4 py-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition disabled:opacity-50"
                >
                  Back
                </button>
                {isBatchConflict && (
                  <button
                    type="button"
                    disabled={isResolvingConflict}
                    onClick={handleSkipConflict}
                    className="flex items-center justify-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 px-4 py-2 text-xs font-semibold text-zinc-300 shadow transition active:scale-95 disabled:opacity-50"
                  >
                    <SkipForward className="h-3.5 w-3.5 text-zinc-400" />
                    <span>Skip</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={isResolvingConflict}
                  onClick={handleImportAsCopy}
                  className="flex items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-850 hover:bg-zinc-800 px-4 py-2 text-xs font-semibold text-zinc-100 shadow transition active:scale-95 disabled:opacity-50"
                >
                  {isResolvingConflict ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 text-sky-400" />
                  )}
                  <span>Import as Copy</span>
                </button>
                <button
                  type="button"
                  disabled={isResolvingConflict}
                  onClick={handleReplace}
                  className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-rose-600 hover:from-amber-400 hover:to-rose-500 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-amber-500/20 transition active:scale-95 disabled:opacity-50"
                >
                  {isResolvingConflict ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  <span>Replace</span>
                </button>
              </div>
            </div>
          ) : (
            /* Collection Conflict Resolution View (Postman style) */
            <div>
              {/* Header */}
              <div className="flex items-center justify-between border-b border-zinc-850 pb-4">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    <AlertTriangle className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-base font-semibold text-zinc-100">Collection Already Exists</h2>
                      {isBatchConflict && (
                        <span className="inline-flex items-center rounded-full border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-300">
                          Batch Import • {batchQueue.length} remaining
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-zinc-400">
                      A collection named <span className="font-semibold text-zinc-200">"{conflict.existingCol.name}"</span> already exists in your workspace.
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleModalClose}
                  className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Request Differences Breakdown */}
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-zinc-200 flex items-center gap-2">
                    <span>Request Differences</span>
                    <span className="text-[11px] font-normal text-zinc-500">
                      ({conflict.diff.added.length + conflict.diff.modified.length + conflict.diff.removed.length} changes detected)
                    </span>
                  </span>

                  <div className="flex items-center gap-1.5 text-[11px]">
                    {conflict.diff.added.length > 0 && (
                      <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-400 border border-emerald-500/20">
                        +{conflict.diff.added.length} Added
                      </span>
                    )}
                    {conflict.diff.modified.length > 0 && (
                      <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-400 border border-amber-500/20">
                        ~{conflict.diff.modified.length} Modified
                      </span>
                    )}
                    {conflict.diff.removed.length > 0 && (
                      <span className="inline-flex items-center rounded-full bg-rose-500/10 px-2 py-0.5 font-medium text-rose-400 border border-rose-500/20">
                        -{conflict.diff.removed.length} Removed
                      </span>
                    )}
                    {conflict.diff.unchangedCount > 0 && (
                      <span className="inline-flex items-center rounded-full bg-zinc-850 px-2 py-0.5 font-medium text-zinc-400 border border-zinc-750">
                        {conflict.diff.unchangedCount} Same
                      </span>
                    )}
                  </div>
                </div>

                {/* Changed Requests List */}
                <div className="max-h-56 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 space-y-1.5">
                  {conflict.diff.added.length === 0 &&
                  conflict.diff.modified.length === 0 &&
                  conflict.diff.removed.length === 0 ? (
                    <div className="py-6 text-center text-xs text-zinc-400">
                      All {conflict.diff.totalIncoming} requests are identical between existing and incoming collection.
                    </div>
                  ) : (
                    <>
                      {conflict.diff.added.map((item, idx) => (
                        <div
                          key={`added-${item.name}-${idx}`}
                          className="flex items-center justify-between rounded-lg bg-zinc-950/70 px-3 py-2 border border-zinc-850/80 hover:border-emerald-500/30 transition"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              + Added
                            </span>
                            <MethodBadge method={item.method as HttpMethod} />
                            <div className="min-w-0">
                              <div className="text-xs font-medium text-zinc-200 truncate">
                                {item.name}
                              </div>
                              {item.path !== item.name && (
                                <div className="text-[11px] text-zinc-500 truncate">
                                  {item.path}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="text-[11px] font-mono text-zinc-500 max-w-[200px] truncate ml-3 shrink-0">
                            {item.url}
                          </div>
                        </div>
                      ))}

                      {conflict.diff.modified.map((item, idx) => (
                        <div
                          key={`mod-${item.name}-${idx}`}
                          className="flex items-center justify-between rounded-lg bg-zinc-950/70 px-3 py-2 border border-zinc-850/80 hover:border-amber-500/30 transition"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                              ~ Modified
                            </span>
                            <MethodBadge method={item.method as HttpMethod} />
                            <div className="min-w-0">
                              <div className="text-xs font-medium text-zinc-200 truncate">
                                {item.name}
                              </div>
                              {item.path !== item.name && (
                                <div className="text-[11px] text-zinc-500 truncate">
                                  {item.path}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="text-[11px] font-mono text-zinc-500 max-w-[200px] truncate ml-3 shrink-0">
                            {item.url}
                          </div>
                        </div>
                      ))}

                      {conflict.diff.removed.map((item, idx) => (
                        <div
                          key={`rem-${item.name}-${idx}`}
                          className="flex items-center justify-between rounded-lg bg-zinc-950/70 px-3 py-2 border border-zinc-850/80 hover:border-rose-500/30 transition"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20">
                              - Removed
                            </span>
                            <MethodBadge method={item.method as HttpMethod} />
                            <div className="min-w-0">
                              <div className="text-xs font-medium text-zinc-200 truncate">
                                {item.name}
                              </div>
                              {item.path !== item.name && (
                                <div className="text-[11px] text-zinc-500 truncate">
                                  {item.path}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="text-[11px] font-mono text-zinc-500 max-w-[200px] truncate ml-3 shrink-0">
                            {item.url}
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>

              {/* Explanation Options */}
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                  <div className="flex items-center gap-1.5 font-semibold text-zinc-200">
                    <Copy className="h-3.5 w-3.5 text-sky-400" />
                    <span>Import as Copy</span>
                  </div>
                  <p className="mt-1 text-zinc-400 text-[11px] leading-relaxed">
                    Imports as a new collection named{' '}
                    <span className="font-semibold text-sky-300">
                      "{generateCopyCollectionName(conflict.incomingCol.name, collections.map((c) => c.name))}"
                    </span>
                    . Existing collection is kept intact.
                  </p>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                  <div className="flex items-center gap-1.5 font-semibold text-zinc-200">
                    <RefreshCw className="h-3.5 w-3.5 text-amber-400" />
                    <span>Replace Collection</span>
                  </div>
                  <p className="mt-1 text-zinc-400 text-[11px] leading-relaxed">
                    Replaces <span className="font-semibold text-amber-300">"{conflict.existingCol.name}"</span> in-place. IDs will be aligned and synced.
                  </p>
                </div>
              </div>

              {/* Alerts */}
              {errorMsg && (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              {successMsg && (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>{successMsg}</span>
                </div>
              )}

              {/* Conflict Footer Actions */}
              <div className="mt-6 flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2.5">
                <button
                  type="button"
                  disabled={isResolvingConflict}
                  onClick={handleBackFromConflict}
                  className="rounded-xl px-4 py-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition disabled:opacity-50"
                >
                  Back
                </button>
                {isBatchConflict && (
                  <button
                    type="button"
                    disabled={isResolvingConflict}
                    onClick={handleSkipConflict}
                    className="flex items-center justify-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 px-4 py-2 text-xs font-semibold text-zinc-300 shadow transition active:scale-95 disabled:opacity-50"
                  >
                    <SkipForward className="h-3.5 w-3.5 text-zinc-400" />
                    <span>Skip</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={isResolvingConflict}
                  onClick={handleImportAsCopy}
                  className="flex items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-850 hover:bg-zinc-800 px-4 py-2 text-xs font-semibold text-zinc-100 shadow transition active:scale-95 disabled:opacity-50"
                >
                  {isResolvingConflict ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 text-sky-400" />
                  )}
                  <span>Import as Copy</span>
                </button>
                <button
                  type="button"
                  disabled={isResolvingConflict}
                  onClick={handleReplace}
                  className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-rose-600 hover:from-amber-400 hover:to-rose-500 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-amber-500/20 transition active:scale-95 disabled:opacity-50"
                >
                  {isResolvingConflict ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  <span>Replace</span>
                </button>
              </div>
            </div>
          )
        ) : batchItems !== null && batchSummary !== null ? (
          /* Batch File Checklist Preview View */
          <div
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onDragEnter={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={handleFileDrop}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-line pb-4">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-500 dark:text-sky-400 border border-sky-500/20">
                  <FileJson className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-tx-primary">Review Files to Import</h2>
                  <p className="text-xs text-tx-muted">
                    Choose which Collections, Environments, and AirREST Reports to import
                  </p>
                </div>
              </div>
              <button
                onClick={handleModalClose}
                className="rounded-lg p-1.5 text-tx-muted hover:bg-hover hover:text-tx-primary transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Selection Toolbar */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-tx-primary select-none">
                <input
                  ref={masterCheckboxRef}
                  type="checkbox"
                  checked={batchSummary.selectable > 0 && batchSummary.selected === batchSummary.selectable}
                  disabled={batchSummary.selectable === 0 || isImporting}
                  onChange={(e) =>
                    setBatchItems((prev) => {
                      if (!prev) return prev;
                      const liveState = activeStore.getState();
                      const targetKey = getImportTargetKey(captureImportTarget(liveState));
                      return recomputeBatchConflicts(
                        toggleAllImportBatchItems(prev, e.target.checked),
                        liveState.collections,
                        liveState.environments,
                        targetKey
                      );
                    })
                  }
                  className="h-4 w-4 rounded border-line-strong bg-card text-sky-500 focus:ring-sky-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                />
                <span>Select All</span>
                <span className="rounded-full bg-element border border-line px-2 py-0.5 text-[11px] font-normal text-tx-muted">
                  {batchSummary.selected} of {batchSummary.total} selected
                </span>
              </label>

              <button
                type="button"
                disabled={isImporting}
                onClick={handleChooseFileClick}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
                <span>Add Files</span>
              </button>
            </div>

            {/* File Checklist */}
            <div className="mt-3 max-h-72 overflow-y-auto rounded-xl border border-line bg-card/60 p-2 space-y-1.5">
              {batchItems.map((item) => {
                const isCollection = item.type === 'collection';
                const isEnvironment = item.type === 'environment';
                const isPerfReport = item.type === 'performance_report';
                const isFuncReport = item.type === 'functional_report';
                return (
                  <label
                    key={item.id}
                    className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 transition ${
                      item.disabled
                        ? 'border-line/70 bg-element/40 opacity-65 cursor-not-allowed'
                        : item.checked
                          ? 'border-sky-500/35 bg-sky-500/5 hover:bg-sky-500/10 cursor-pointer'
                          : 'border-line bg-surface/80 hover:bg-hover cursor-pointer'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={item.checked}
                      disabled={item.disabled || isImporting}
                      onChange={() =>
                        setBatchItems((prev) => {
                          if (!prev) return prev;
                          const liveState = activeStore.getState();
                          const targetKey = getImportTargetKey(captureImportTarget(liveState));
                          return recomputeBatchConflicts(
                            toggleImportBatchItem(prev, item.id),
                            liveState.collections,
                            liveState.environments,
                            targetKey
                          );
                        })
                      }
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-line-strong bg-card text-sky-500 focus:ring-sky-500 cursor-pointer disabled:cursor-not-allowed"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold text-tx-primary truncate max-w-[260px]">
                          {item.name}
                        </span>
                        {isCollection && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-300">
                            <FolderGit2 className="h-3 w-3" />
                            <span>Collection</span>
                          </span>
                        )}
                        {isEnvironment && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-300">
                            <Globe className="h-3 w-3" />
                            <span>Environment</span>
                          </span>
                        )}
                        {isPerfReport && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-300">
                            <Flame className="h-3 w-3" />
                            <span>Perf Report</span>
                          </span>
                        )}
                        {isFuncReport && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-teal-500/25 bg-teal-500/10 px-2 py-0.5 text-[10px] font-semibold text-teal-600 dark:text-teal-300">
                            <Play className="h-3 w-3" />
                            <span>Func Report</span>
                          </span>
                        )}
                        {item.type === 'invalid' && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/25 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-300">
                            <AlertCircle className="h-3 w-3" />
                            <span>Invalid</span>
                          </span>
                        )}
                        {item.outcome === 'imported' && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-300">
                            <CheckCircle2 className="h-3 w-3" />
                            <span>Imported</span>
                          </span>
                        )}
                        {item.outcome === 'skipped' && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-zinc-500/30 bg-zinc-500/10 px-2 py-0.5 text-[10px] font-semibold text-zinc-400">
                            <SkipForward className="h-3 w-3" />
                            <span>Skipped</span>
                          </span>
                        )}
                        {item.hasConflict && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-300">
                            <AlertTriangle className="h-3 w-3" />
                            <span>Already exists</span>
                          </span>
                        )}
                      </div>

                      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-tx-muted">
                        {item.itemCountLabel && <span>{item.itemCountLabel}</span>}
                        {typeof item.skippedExamplesCount === 'number' && item.skippedExamplesCount > 0 && (
                          <span
                            className="text-amber-600 dark:text-amber-400"
                            title={item.skippedExamplesReasons?.join('; ')}
                          >
                            {item.skippedExamplesCount} invalid example{item.skippedExamplesCount === 1 ? '' : 's'} skipped
                          </span>
                        )}
                        {item.filename !== item.name && (
                          <span className="truncate font-mono text-[10px] text-tx-faint">
                            {item.filename}
                          </span>
                        )}
                      </div>

                      {item.error && (
                        <div className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">
                          {item.error}
                        </div>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>

            {batchSummary.selectedConflicts > 0 && (
              <p className="mt-2.5 text-[11px] text-amber-600 dark:text-amber-400">
                Items marked "Already exists" will prompt you to Skip, Import as Copy, or Replace during import.
              </p>
            )}

            {/* Alerts */}
            {errorMsg && (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-600 dark:text-rose-300">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            {successMsg && (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-600 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>{successMsg}</span>
              </div>
            )}

            {/* Footer Actions */}
            <div className="mt-6 flex items-center justify-between gap-2.5">
              <button
                type="button"
                disabled={isImporting}
                onClick={() => {
                  if (openedFromInitialFiles) {
                    handleModalClose();
                  } else {
                    setBatchItems(null);
                    setErrorMsg(null);
                    setSuccessMsg(null);
                  }
                }}
                className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-medium text-tx-muted hover:bg-hover hover:text-tx-primary transition disabled:opacity-50"
              >
                {!openedFromInitialFiles && <ArrowLeft className="h-3.5 w-3.5" />}
                <span>{openedFromInitialFiles ? 'Cancel' : 'Back'}</span>
              </button>

              <button
                type="button"
                onClick={handleImportBatch}
                disabled={isImporting || batchSummary.selected === 0}
                className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 px-5 py-2 text-xs font-semibold text-white shadow-lg shadow-sky-500/20 hover:from-sky-400 hover:to-blue-500 active:scale-95 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isImporting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Importing & Syncing...</span>
                  </>
                ) : (
                  <>
                    <Upload className="h-3.5 w-3.5" />
                    <span>Import Selected ({batchSummary.selected})</span>
                  </>
                )}
              </button>
            </div>
          </div>
        ) : (
          /* Normal Import View */
          <div>
            {/* Header */}
            <div className="flex items-center justify-between border-b border-line pb-4">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-500 dark:text-sky-400 border border-sky-500/20">
                  <Upload className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-tx-primary">Import Files, Reports &amp; Requests</h2>
                  <p className="text-xs text-tx-muted">Import Postman Collections, Environments, AirREST Reports, or cURL commands</p>
                </div>
              </div>
              <button
                onClick={handleModalClose}
                className="rounded-lg p-1.5 text-tx-muted hover:bg-hover hover:text-tx-primary transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Tab Selection */}
            <div className="mt-4 flex border-b border-line gap-4 text-xs font-medium text-tx-muted">
              <button
                onClick={() => {
                  setActiveImportTab('postman');
                  setErrorMsg(null);
                  setSuccessMsg(null);
                }}
                className={`flex items-center gap-2 pb-2.5 transition border-b-2 ${
                  activeImportTab === 'postman'
                    ? 'border-sky-500 text-tx-primary font-semibold'
                    : 'border-transparent hover:text-tx-secondary'
                }`}
              >
                <FileJson className="h-4 w-4 text-sky-500 dark:text-sky-400" />
                <span>Collection, Environment, or Report (.json)</span>
              </button>

              <button
                onClick={() => {
                  setActiveImportTab('curl');
                  setErrorMsg(null);
                  setSuccessMsg(null);
                }}
                className={`flex items-center gap-2 pb-2.5 transition border-b-2 ${
                  activeImportTab === 'curl'
                    ? 'border-sky-500 text-tx-primary font-semibold'
                    : 'border-transparent hover:text-tx-secondary'
                }`}
              >
                <Terminal className="h-4 w-4 text-amber-500 dark:text-amber-400" />
                <span>cURL Command</span>
              </button>
            </div>

            {/* Tab 1: Postman Collection or Environment */}
            {activeImportTab === 'postman' && (
              <div className="mt-4 space-y-4">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={handleChooseFileClick}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleChooseFileClick();
                    }
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onDragEnter={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onDrop={handleFileDrop}
                  className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line bg-card/60 p-4 text-center transition hover:border-sky-500/50 hover:bg-hover focus:outline-none focus:ring-1 focus:ring-sky-500"
                >
                  <div className="flex items-center gap-2">
                      <FileJson className="h-5 w-5 text-sky-500 dark:text-sky-400" />
                    <span className="text-xs font-medium text-tx-secondary">
                      Choose or drag Collection, Environment, or .airrest-report.json files
                    </span>
                  </div>
                  <span className="text-[11px] text-tx-faint">
                    Supports selecting multiple files at once or pasting .json files
                  </span>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-tx-secondary">
                    Or paste Collection, Environment, or AirREST Report JSON directly:
                  </label>
                  <textarea
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                    onKeyDown={(e) =>
                      handleCodeEditorKeyDown(e, {
                        onChange: (val) => setJsonText(val),
                      })
                    }
                    placeholder='Paste Postman Collection JSON, Environment JSON, or AirREST Report (.airrest-report.json). Auto-detected!'
                    className="h-44 w-full rounded-xl border border-line bg-card p-3 font-mono text-xs text-tx-primary placeholder-tx-faint focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 transition resize-none"
                  />
                </div>
              </div>
            )}

            {/* Tab 2: cURL Command */}
            {activeImportTab === 'curl' && (
              <div className="mt-4 space-y-4">
                <label className="block text-xs font-medium text-tx-secondary">
                  Paste raw cURL command from terminal, DevTools, or documentation:
                </label>

                <textarea
                  value={curlText}
                  onChange={(e) => setCurlText(e.target.value)}
                  onKeyDown={(e) =>
                    handleCodeEditorKeyDown(e, {
                      onChange: (val) => setCurlText(val),
                    })
                  }
                  placeholder={`curl -X POST "https://api.example.com/v1/resource" \\\n  -H "Authorization: Bearer token" \\\n  -d '{"name": "value"}'`}
                  className="h-52 w-full rounded-xl border border-line bg-card p-3 font-mono text-xs text-tx-primary placeholder-tx-faint focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 transition resize-none"
                />
              </div>
            )}

            {/* Alerts */}
            {errorMsg && (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-600 dark:text-rose-300">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            {successMsg && (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-600 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>{successMsg}</span>
              </div>
            )}

            {/* Action buttons */}
            <div className="mt-6 flex justify-end gap-2.5">
              <button
                onClick={handleModalClose}
                className="rounded-xl px-4 py-2 text-xs font-medium text-tx-muted hover:bg-hover hover:text-tx-primary transition"
              >
                Cancel
              </button>
              {activeImportTab === 'postman' ? (
                <button
                  onClick={handleImportPostman}
                  disabled={isImporting}
                  className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 px-5 py-2 text-xs font-semibold text-white shadow-lg shadow-sky-500/20 hover:from-sky-400 hover:to-blue-500 active:scale-95 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isImporting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Importing & Syncing...
                    </>
                  ) : (
                    <>
                      <Upload className="h-3.5 w-3.5" />
                      Import JSON File
                    </>
                  )}
                </button>
              ) : (
                <button
                  onClick={handleImportCurl}
                  className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-600 px-5 py-2 text-xs font-semibold text-white shadow-lg shadow-amber-500/20 hover:from-amber-400 hover:to-orange-500 active:scale-95 transition"
                >
                  <Terminal className="h-3.5 w-3.5" />
                  Import to Tab
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      <ReportImportResolveModal
        prompt={reportImporter.resolvePrompt}
        onResolve={reportImporter.handleResolveChoice}
      />
    </div>
  );
};
