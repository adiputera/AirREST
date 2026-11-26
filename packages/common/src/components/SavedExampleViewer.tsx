'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Check,
  Code2,
  Copy,
  ExternalLink,
  FileText,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { useStoreContext } from '../store/storeContext';
import { HttpMethod, SavedExample } from '../types/api';
import {
  findCollectionItemById,
  getDisplayExampleSummaries,
  getExampleUtf8ByteLength,
  makeExampleTabId,
  MAX_SAVED_EXAMPLE_NAME_RUNES,
  validateSavedExampleName,
} from '../lib/examples';
import {
  resolveSnapshotBody,
  resolveSnapshotDisplayHeaders,
} from '../lib/exampleSnapshot';
import { canModifyCollection } from '../lib/jwt';
import { useBackHandler } from '../lib/backNavigation';
import { CodeEditor, CodeEditorHandle } from './editor/CodeEditor';
import { MethodBadge } from './MethodBadge';
import { ConfirmModal } from './ConfirmModal';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getStatusBadgeClass(code: number): string {
  if (code >= 200 && code < 300) {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
  }
  if (code >= 300 && code < 400) {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400';
  }
  if (code >= 400 && code < 500) {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400';
  }
  return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400';
}

function extractSnapshotUrl(rawUrl: unknown): string {
  if (typeof rawUrl === 'string') return rawUrl;
  if (rawUrl && typeof rawUrl === 'object' && typeof (rawUrl as Record<string, unknown>).raw === 'string') {
    return (rawUrl as Record<string, unknown>).raw as string;
  }
  return '';
}

export const SavedExampleViewer: React.FC = () => {
  const contextStore = useStoreContext();
  const activeStore = contextStore || useApiStore;
  const selectedExample = activeStore((state) => state.selectedExample);
  const collections = activeStore((state) => state.collections);
  const pendingExampleIntents = activeStore((state) => state.pendingExampleIntents);
  const workspaceMode = activeStore((state) => state.workspaceMode);
  const cloudConfig = activeStore((state) => state.cloudConfig);
  const selectSavedExample = activeStore((state) => state.selectSavedExample);
  const closeExampleTab = activeStore((state) => state.closeExampleTab);
  const openRequestInTab = activeStore((state) => state.openRequestInTab);
  const loadItemExamples = activeStore((state) => state.loadItemExamples);
  const renameSavedExample = activeStore((state) => state.renameSavedExample);
  const deleteSavedExample = activeStore((state) => state.deleteSavedExample);

  const [activeSubTab, setActiveSubTab] = useState<'response' | 'request'>('response');
  const [responseSection, setResponseSection] = useState<'body' | 'headers'>('body');
  const [requestSection, setRequestSection] = useState<'body' | 'headers'>('body');
  const [viewMode, setViewMode] = useState<'pretty' | 'raw'>('pretty');
  const [requestViewMode, setRequestViewMode] = useState<'pretty' | 'raw'>('pretty');
  const [copiedTarget, setCopiedTarget] = useState<'body' | 'url' | null>(null);
  const [isLoadingItem, setIsLoadingItem] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const editorRef = useRef<CodeEditorHandle>(null);
  const requestEditorRef = useRef<CodeEditorHandle>(null);
  const attemptedLoadRef = useRef<string | null>(null);
  const lastExampleKeyRef = useRef<string | null>(null);

  const activeExampleTabId = selectedExample ? makeExampleTabId(selectedExample) : null;
  const handleCloseViewer = () => {
    if (activeExampleTabId) {
      closeExampleTab(activeExampleTabId);
    } else {
      selectSavedExample(null);
    }
  };

  useBackHandler(Boolean(selectedExample), handleCloseViewer, 20);

  const collection = useMemo(
    () => (selectedExample ? collections.find((c) => c.id === selectedExample.collectionId) : undefined),
    [collections, selectedExample],
  );
  const item = useMemo(
    () => (collection && selectedExample ? findCollectionItemById(collection.items, selectedExample.itemId) : undefined),
    [collection, selectedExample],
  );

  const fullExample: SavedExample | undefined = useMemo(() => {
    if (!selectedExample || !item) return undefined;
    const fromItem = item.examples?.find((ex) => ex.id === selectedExample.exampleId);
    if (fromItem) return fromItem;
    const fromIntent = Object.values(pendingExampleIntents || {}).find(
      (intent) =>
        intent.op === 'add' &&
        intent.itemId === selectedExample.itemId &&
        intent.exampleId === selectedExample.exampleId &&
        intent.example,
    );
    return fromIntent?.example;
  }, [item, pendingExampleIntents, selectedExample]);

  const summary = useMemo(() => {
    if (!selectedExample || !item) return undefined;
    return getDisplayExampleSummaries(item).find((s) => s.id === selectedExample.exampleId);
  }, [item, selectedExample]);

  const previewLang = fullExample?._postman_previewlanguage || summary?._postman_previewlanguage;
  const rawBody = fullExample?.body ?? '';
  const isJson = previewLang === 'json';

  const prettyBody = useMemo(() => {
    if (!isJson || !rawBody) return rawBody;
    try {
      return JSON.stringify(JSON.parse(rawBody.replace(/^\uFEFF/, '')), null, 2);
    } catch {
      return rawBody;
    }
  }, [isJson, rawBody]);

  const origReq = (fullExample?.originalRequest || null) as Record<string, unknown> | null;
  const snapshotHeaders = useMemo(() => resolveSnapshotDisplayHeaders(origReq), [origReq]);
  const snapshotBody = useMemo(
    () => resolveSnapshotBody(origReq?.body, snapshotHeaders),
    [origReq?.body, snapshotHeaders],
  );
  const hasSnapshotBodyContent =
    snapshotBody.mode !== 'none' &&
    (snapshotBody.isStructuredTable ? snapshotBody.rows.length > 0 : snapshotBody.rawContent.trim().length > 0);

  useEffect(() => {
    if (!selectedExample) return;
    const key = `${selectedExample.collectionId}:${selectedExample.itemId}:${selectedExample.exampleId}`;
    setLoadError(null);
    setActionError(null);
    setIsRenaming(false);

    const readyKey = fullExample ? `${key}:loaded` : `${key}:pending`;
    if (lastExampleKeyRef.current !== readyKey) {
      lastExampleKeyRef.current = readyKey;
      if (fullExample) {
        setRequestSection(hasSnapshotBodyContent ? 'body' : 'headers');
      }
    }

    if (!collection || !item) {
      return;
    }

    if (fullExample || item.examplesLoaded !== false) {
      return;
    }
    if (attemptedLoadRef.current === key) {
      return;
    }
    attemptedLoadRef.current = key;
    setIsLoadingItem(true);
    void loadItemExamples(selectedExample.collectionId, selectedExample.itemId).then((res) => {
      setIsLoadingItem(false);
      if (!res.success) {
        setLoadError(res.error || 'Item unavailable.');
      }
    });
  }, [collection, fullExample, hasSnapshotBodyContent, item, loadItemExamples, selectedExample]);

  if (!selectedExample) return null;

  if (!collection || !item || item.type !== 'request') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center bg-app">
        <AlertCircle className="h-8 w-8 text-tx-faint mb-3" />
        <p className="text-sm font-medium text-tx-primary">Saved example unavailable</p>
        <p className="mt-1 text-xs text-tx-muted">
          This saved example or its parent request could not be found in the current workspace.
        </p>
        <button
          type="button"
          onClick={handleCloseViewer}
          className="mt-4 rounded-lg border border-line bg-card px-3 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
        >
          Close Viewer
        </button>
      </div>
    );
  }

  const canEdit = canModifyCollection(
    collection.minRole,
    cloudConfig.activeScope,
    workspaceMode,
    cloudConfig.user?.role,
  );

  const codeNumber = fullExample?.code ?? summary?.code ?? 200;
  const statusText = fullExample?.status ?? summary?.status ?? '';
  const exampleName = fullExample?.name ?? summary?.name ?? 'Saved Example';

  // HTML must ALWAYS be rendered strictly as read-only source code/text (never rendered/executed in DOM).
  const editorLanguage: 'json' | 'xml' | 'text' =
    previewLang === 'json' ? 'json' : previewLang === 'xml' ? 'xml' : 'text';
  const displayedBody = isJson && viewMode === 'pretty' ? prettyBody : rawBody;
  const bodySizeBytes = fullExample
    ? getExampleUtf8ByteLength(fullExample.body || '')
    : (summary?.body_size_bytes ?? 0);

  const origMethod = String(origReq?.method || item.request?.method || 'GET');
  const origUrl = extractSnapshotUrl(origReq?.url) || item.request?.url || '';
  const displayedSnapshotBody = snapshotBody.isJson && requestViewMode === 'pretty'
    ? snapshotBody.prettyContent
    : snapshotBody.rawContent;
  const requestBodySizeBytes = getExampleUtf8ByteLength(snapshotBody.rawContent || '');

  const showCopyBodyButton = Boolean(
    fullExample &&
    ((activeSubTab === 'response' && responseSection === 'body') ||
      (activeSubTab === 'request' && requestSection === 'body' && hasSnapshotBodyContent)),
  );

  const handleCopyText = (text: string, target: 'body' | 'url') => {
    navigator.clipboard.writeText(text);
    setCopiedTarget(target);
    setTimeout(() => setCopiedTarget((prev) => (prev === target ? null : prev)), 1800);
  };

  const handleCommitRename = async () => {
    const check = validateSavedExampleName(renameDraft);
    if (!check.valid) {
      setActionError(check.error);
      return;
    }
    setActionError(null);
    const res = await renameSavedExample({
      collectionId: collection.id,
      itemId: item.id,
      exampleId: selectedExample.exampleId,
      name: check.name,
    });
    if (!res.success) {
      setActionError(res.error || 'Failed to rename saved example.');
      return;
    }
    setIsRenaming(false);
  };

  const handleConfirmDelete = async () => {
    setActionError(null);
    const res = await deleteSavedExample({
      collectionId: collection.id,
      itemId: item.id,
      exampleId: selectedExample.exampleId,
    });
    if (!res.success) {
      setActionError(res.error || 'Failed to delete saved example.');
    }
    setIsDeleteConfirmOpen(false);
  };

  return (
    <div
      data-testid="saved-example-viewer"
      className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface/60 px-4 py-2.5 shrink-0">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <MethodBadge method={origMethod as HttpMethod} size="sm" />
          <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-300">
            <BookOpen className="h-3 w-3" />
            <span>Example (Read-Only)</span>
          </span>
          {isRenaming ? (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                autoFocus
                maxLength={MAX_SAVED_EXAMPLE_NAME_RUNES}
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCommitRename();
                  if (e.key === 'Escape') {
                    setIsRenaming(false);
                    setActionError(null);
                  }
                }}
                className="w-56 rounded border border-sky-500/40 bg-card px-2 py-0.5 text-xs text-tx-primary focus:outline-none focus:ring-1 focus:ring-sky-400"
              />
              <button
                type="button"
                onClick={() => void handleCommitRename()}
                className="rounded p-1 text-emerald-500 hover:bg-hover transition"
                title="Confirm rename"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsRenaming(false);
                  setActionError(null);
                }}
                className="rounded p-1 text-tx-muted hover:bg-hover hover:text-tx-primary transition"
                title="Cancel rename"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <h2 className="truncate text-sm font-semibold text-tx-primary" title={exampleName}>
              {exampleName}
            </h2>
          )}
          <span className="truncate text-xs text-tx-faint">
            • {collection.name} / {item.name}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {item.request && (
            <button
              type="button"
              onClick={() => openRequestInTab(item.request!)}
              className="flex items-center gap-1 rounded-lg border border-line bg-card px-2 py-1 text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
              title="Open parent request in its tab"
            >
              <ExternalLink className="h-3 w-3 text-tx-muted" />
              <span className="hidden sm:inline">Open Request</span>
            </button>
          )}
          {canEdit && !isRenaming && (
            <>
              <button
                type="button"
                onClick={() => {
                  setRenameDraft(exampleName);
                  setActionError(null);
                  setIsRenaming(true);
                }}
                className="flex items-center gap-1 rounded-lg border border-line bg-card px-2 py-1 text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
                title="Rename saved example"
              >
                <Pencil className="h-3 w-3 text-tx-muted" />
                <span className="hidden sm:inline">Rename</span>
              </button>
              <button
                type="button"
                onClick={() => setIsDeleteConfirmOpen(true)}
                className="flex items-center gap-1 rounded-lg border border-line bg-card px-2 py-1 text-xs text-rose-500 hover:bg-rose-500/10 transition"
                title="Delete saved example"
              >
                <Trash2 className="h-3 w-3" />
                <span className="hidden sm:inline">Delete</span>
              </button>
            </>
          )}
          <button
            type="button"
            onClick={handleCloseViewer}
            className="flex items-center gap-1 rounded-lg border border-line bg-card px-2.5 py-1 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
            title="Close example tab (Ctrl/Alt+W)"
          >
            <X className="h-3.5 w-3.5" />
            <span>Close</span>
          </button>
        </div>
      </div>

      {/* Metadata & Subtabs */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2 text-xs shrink-0">
        {activeSubTab === 'response' ? (
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono font-bold ${getStatusBadgeClass(codeNumber)}`}>
              {codeNumber} {statusText}
            </span>
            {previewLang && (
              <span className="rounded bg-element border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase text-tx-muted">
                {previewLang}
              </span>
            )}
            <span className="font-mono text-tx-muted">{formatBytes(bodySizeBytes)}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 min-w-0">
            <MethodBadge method={origMethod as HttpMethod} size="sm" />
            {snapshotBody.formatLabel && (
              <span className="rounded bg-element border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase text-tx-muted">
                {snapshotBody.formatLabel}
              </span>
            )}
            <span className="font-mono text-tx-muted">{formatBytes(requestBodySizeBytes)}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-line bg-element p-0.5">
            <button
              type="button"
              onClick={() => setActiveSubTab('response')}
              className={`flex items-center gap-1 rounded px-2.5 py-0.5 transition ${activeSubTab === 'response'
                ? 'bg-card text-sky-600 dark:text-sky-400 font-semibold shadow-sm'
                : 'text-tx-muted hover:text-tx-primary'
                }`}
            >
              <Code2 className="h-3 w-3" />
              <span>Example Response</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveSubTab('request')}
              className={`flex items-center gap-1 rounded px-2.5 py-0.5 transition ${activeSubTab === 'request'
                ? 'bg-card text-sky-600 dark:text-sky-400 font-semibold shadow-sm'
                : 'text-tx-muted hover:text-tx-primary'
                }`}
            >
              <Send className="h-3 w-3" />
              <span>Request Snapshot</span>
            </button>
          </div>
          {showCopyBodyButton && (
            <button
              type="button"
              onClick={() =>
                handleCopyText(
                  activeSubTab === 'response' ? displayedBody : displayedSnapshotBody,
                  'body',
                )
              }
              className="flex items-center gap-1 rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
            >
              {copiedTarget === 'body' ? (
                <>
                  <Check className="h-3 w-3 text-emerald-500" />
                  <span className="text-emerald-600 dark:text-emerald-400">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3 text-tx-muted" />
                  <span>Copy</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="mx-4 mt-3 flex items-center justify-between rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300 shrink-0">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} className="hover:text-tx-primary">
            ✕
          </button>
        </div>
      )}

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 sm:p-4">
        {isLoadingItem ? (
          <div className="flex flex-1 items-center justify-center text-xs text-tx-muted gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-sky-500" />
            <span>Loading saved example body...</span>
          </div>
        ) : loadError ? (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-600 dark:text-rose-300">
            <p className="font-semibold">Unable to load saved example</p>
            <p className="mt-1">{loadError}</p>
          </div>
        ) : !fullExample ? (
          <div className="rounded-xl border border-line bg-card p-4 text-xs text-tx-muted">
            Full saved example payload is not loaded yet.
          </div>
        ) : activeSubTab === 'response' ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2 text-xs shrink-0">
              <div className="flex gap-4">
                <button
                  type="button"
                  onClick={() => setResponseSection('body')}
                  className={`flex items-center gap-1.5 pb-1 border-b-2 transition ${responseSection === 'body'
                    ? 'border-sky-500 text-tx-primary font-semibold'
                    : 'border-transparent text-tx-muted hover:text-tx-secondary'
                    }`}
                >
                  <Code2 className="h-3.5 w-3.5" />
                  <span>Body</span>
                </button>
                <button
                  type="button"
                  onClick={() => setResponseSection('headers')}
                  className={`flex items-center gap-1.5 pb-1 border-b-2 transition ${responseSection === 'headers'
                    ? 'border-sky-500 text-tx-primary font-semibold'
                    : 'border-transparent text-tx-muted hover:text-tx-secondary'
                    }`}
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span>Headers ({fullExample.header?.length || 0})</span>
                </button>
              </div>

              {responseSection === 'body' && (
                <div className="flex items-center gap-1.5">
                  {isJson && (
                    <div className="flex rounded-lg border border-line bg-element p-0.5">
                      <button
                        type="button"
                        onClick={() => setViewMode('pretty')}
                        className={`rounded px-2 py-0.5 ${viewMode === 'pretty' ? 'bg-card text-sky-500 font-semibold' : 'text-tx-muted'}`}
                      >
                        Pretty
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewMode('raw')}
                        className={`rounded px-2 py-0.5 ${viewMode === 'raw' ? 'bg-card text-sky-500 font-semibold' : 'text-tx-muted'}`}
                      >
                        Raw
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => editorRef.current?.foldAll()}
                    className="flex items-center gap-1 rounded-md border border-line bg-card px-2 py-0.5 text-tx-muted hover:text-tx-primary hover:bg-hover transition"
                  >
                    <Minimize2 className="h-3 w-3" />
                    <span>Collapse</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => editorRef.current?.unfoldAll()}
                    className="flex items-center gap-1 rounded-md border border-line bg-card px-2 py-0.5 text-tx-muted hover:text-tx-primary hover:bg-hover transition"
                  >
                    <Maximize2 className="h-3 w-3" />
                    <span>Expand</span>
                  </button>
                </div>
              )}
            </div>

            {responseSection === 'body' ? (
              <div className="min-h-[260px] flex-1 overflow-hidden rounded-lg border border-line bg-card">
                <CodeEditor
                  ref={editorRef}
                  value={displayedBody}
                  onChange={() => { }}
                  language={editorLanguage}
                  readOnly
                  height="100%"
                />
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-card">
                {(fullExample.header || []).length === 0 ? (
                  <p className="p-4 text-xs text-tx-muted italic">No headers recorded.</p>
                ) : (
                  <table className="w-full text-left text-xs font-mono">
                    <thead className="sticky top-0 border-b border-line bg-element text-tx-muted">
                      <tr>
                        <th className="px-3 py-2 font-semibold">Header</th>
                        <th className="px-3 py-2 font-semibold">Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {(fullExample.header || []).map((h, i) => (
                        <tr key={`${h.key}-${i}`} className="hover:bg-hover/40 transition">
                          <td className="px-3 py-2 text-sky-600 dark:text-sky-400 font-medium break-all w-1/3">{h.key}</td>
                          <td className="px-3 py-2 text-tx-secondary break-all">{h.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {/* Compact Captured Request Target */}
            <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-card px-3 py-2 text-xs shrink-0">
              <div className="flex min-w-0 flex-1 items-center gap-2 font-mono">
                <MethodBadge method={origMethod as HttpMethod} size="sm" />
                <span className="min-w-0 break-all text-tx-primary">{origUrl || '(no URL recorded)'}</span>
              </div>
              {origUrl && (
                <button
                  type="button"
                  onClick={() => handleCopyText(origUrl, 'url')}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] text-tx-muted hover:text-tx-primary hover:bg-hover transition"
                  title="Copy captured request URL"
                >
                  {copiedTarget === 'url' ? (
                    <>
                      <Check className="h-3 w-3 text-emerald-500" />
                      <span className="text-emerald-600 dark:text-emerald-400">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      <span className="hidden sm:inline">Copy URL</span>
                    </>
                  )}
                </button>
              )}
            </div>

            {/* Request Subtab Toolbar (Identical to Response) */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2 text-xs shrink-0">
              <div className="flex gap-4">
                <button
                  type="button"
                  onClick={() => setRequestSection('body')}
                  className={`flex items-center gap-1.5 pb-1 border-b-2 transition ${requestSection === 'body'
                    ? 'border-sky-500 text-tx-primary font-semibold'
                    : 'border-transparent text-tx-muted hover:text-tx-secondary'
                    }`}
                >
                  <Code2 className="h-3.5 w-3.5" />
                  <span>Body</span>
                </button>
                <button
                  type="button"
                  onClick={() => setRequestSection('headers')}
                  className={`flex items-center gap-1.5 pb-1 border-b-2 transition ${requestSection === 'headers'
                    ? 'border-sky-500 text-tx-primary font-semibold'
                    : 'border-transparent text-tx-muted hover:text-tx-secondary'
                    }`}
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span>Headers ({snapshotHeaders.length})</span>
                </button>
              </div>

              {requestSection === 'body' && hasSnapshotBodyContent && !snapshotBody.isStructuredTable && (
                <div className="flex items-center gap-1.5">
                  {snapshotBody.isJson && (
                    <div className="flex rounded-lg border border-line bg-element p-0.5">
                      <button
                        type="button"
                        onClick={() => setRequestViewMode('pretty')}
                        className={`rounded px-2 py-0.5 ${requestViewMode === 'pretty' ? 'bg-card text-sky-500 font-semibold' : 'text-tx-muted'}`}
                      >
                        Pretty
                      </button>
                      <button
                        type="button"
                        onClick={() => setRequestViewMode('raw')}
                        className={`rounded px-2 py-0.5 ${requestViewMode === 'raw' ? 'bg-card text-sky-500 font-semibold' : 'text-tx-muted'}`}
                      >
                        Raw
                      </button>
                    </div>
                  )}
                  {(snapshotBody.language === 'json' || snapshotBody.language === 'xml') && (
                    <>
                      <button
                        type="button"
                        onClick={() => requestEditorRef.current?.foldAll()}
                        className="flex items-center gap-1 rounded-md border border-line bg-card px-2 py-0.5 text-tx-muted hover:text-tx-primary hover:bg-hover transition"
                      >
                        <Minimize2 className="h-3 w-3" />
                        <span>Collapse</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => requestEditorRef.current?.unfoldAll()}
                        className="flex items-center gap-1 rounded-md border border-line bg-card px-2 py-0.5 text-tx-muted hover:text-tx-primary hover:bg-hover transition"
                      >
                        <Maximize2 className="h-3 w-3" />
                        <span>Expand</span>
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            {requestSection === 'body' ? (
              !hasSnapshotBodyContent ? (
                <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-line bg-card/40 p-6 text-xs text-tx-muted italic">
                  No request body was captured for this example.
                </div>
              ) : snapshotBody.isStructuredTable ? (
                <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-card">
                  <table className="w-full text-left text-xs font-mono">
                    <thead className="sticky top-0 border-b border-line bg-element text-tx-muted">
                      <tr>
                        <th className="px-3 py-2 font-semibold">Key</th>
                        <th className="px-3 py-2 font-semibold">Value</th>
                        <th className="px-3 py-2 font-semibold w-24">Type</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {snapshotBody.rows.map((row, i) => (
                        <tr key={`${row.key}-${i}`} className={`hover:bg-hover/40 transition ${row.disabled ? 'opacity-50' : ''}`}>
                          <td className="px-3 py-2 text-sky-600 dark:text-sky-400 font-medium break-all w-1/3">
                            <span>{row.key}</span>
                            {row.disabled && (
                              <span className="ml-1.5 rounded bg-element px-1 py-0.5 text-[10px] text-tx-muted">
                                Disabled
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-tx-secondary break-all">{row.value}</td>
                          <td className="px-3 py-2 text-tx-muted uppercase text-[10px]">{row.type}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="min-h-[260px] flex-1 overflow-hidden rounded-lg border border-line bg-card">
                  <CodeEditor
                    ref={requestEditorRef}
                    value={displayedSnapshotBody}
                    onChange={() => { }}
                    language={snapshotBody.language}
                    readOnly
                    height="100%"
                  />
                </div>
              )
            ) : (
              <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-card">
                {snapshotHeaders.length === 0 ? (
                  <p className="p-4 text-xs text-tx-muted italic">No snapshot headers recorded.</p>
                ) : (
                  <table className="w-full text-left text-xs font-mono">
                    <thead className="sticky top-0 border-b border-line bg-element text-tx-muted">
                      <tr>
                        <th className="px-3 py-2 font-semibold">Header</th>
                        <th className="px-3 py-2 font-semibold">Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {snapshotHeaders.map((h, i) => (
                        <tr key={`${h.key}-${i}`} className={`hover:bg-hover/40 transition ${h.disabled ? 'opacity-50' : ''}`}>
                          <td className="px-3 py-2 text-sky-600 dark:text-sky-400 font-medium break-all w-1/3">
                            <span>{h.key}</span>
                            {h.autoSource && (
                              <span
                                className="ml-1.5 inline-flex items-center rounded border border-sky-500/25 bg-sky-500/10 px-1 py-0 text-[10px] font-sans font-medium text-sky-600 dark:text-sky-300"
                                title={h.autoSource === 'body' ? 'Auto-added from request body type' : 'Auto-added from request auth'}
                              >
                                Auto
                              </span>
                            )}
                            {h.disabled && (
                              <span className="ml-1.5 rounded bg-element px-1 py-0 text-[10px] font-sans text-tx-muted">
                                Disabled
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-tx-secondary break-all">{h.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmModal
        isOpen={isDeleteConfirmOpen}
        onClose={() => setIsDeleteConfirmOpen(false)}
        onConfirm={handleConfirmDelete}
        title="Delete Saved Example"
        message={`Are you sure you want to delete saved example "${exampleName}"?`}
        confirmText="Delete"
      />
    </div>
  );
};
