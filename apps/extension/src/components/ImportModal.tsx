'use client';

import React, { useState, useRef } from 'react';
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
} from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import { parseCurlCommand } from '@/lib/curl';
import {
  importPostmanCollection,
  importPostmanEnvironment,
  detectPostmanJsonType,
} from '@/lib/postman';
import {
  compareCollections,
  generateCopyCollectionName,
  cloneCollectionWithNewIds,
  CollectionDiffSummary,
  compareEnvironments,
  generateCopyEnvironmentName,
  cloneEnvironmentWithNewIds,
  EnvironmentDiffSummary,
} from '@/lib/requestDiff';
import { Collection, Environment, HttpMethod } from '@/types/api';
import { MethodBadge } from './MethodBadge';
import { handleCodeEditorKeyDown } from '@/lib/editorHelper';
import { canModifyCollection, canModifyEnvironment, hasScopePermission } from '@/lib/jwt';
import { getDefaultPlatformAdapter } from '@airrest/common';

interface ImportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ImportModal: React.FC<ImportModalProps> = ({ isOpen, onClose }) => {
  const [activeImportTab, setActiveImportTab] = useState<'postman' | 'curl'>('postman');
  const [jsonText, setJsonText] = useState('');
  const [curlText, setCurlText] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const collections = useApiStore((state) => state.collections);
  const addCollection = useApiStore((state) => state.addCollection);
  const replaceCollection = useApiStore((state) => state.replaceCollection);
  const environments = useApiStore((state) => state.environments);
  const addEnvironment = useApiStore((state) => state.addEnvironment);
  const replaceEnvironment = useApiStore((state) => state.replaceEnvironment);
  const createTab = useApiStore((state) => state.createTab);
  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);

  const [conflict, setConflict] = useState<
    | {
        type: 'collection';
        existingCol: Collection;
        incomingCol: Collection;
        diff: CollectionDiffSummary;
      }
    | {
        type: 'environment';
        existingEnv: Environment;
        incomingEnv: Environment;
        diff: EnvironmentDiffSummary;
      }
    | null
  >(null);
  const [isResolvingConflict, setIsResolvingConflict] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    setErrorMsg(null);
    setSuccessMsg(null);
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      setJsonText(content);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setErrorMsg(null);
    setSuccessMsg(null);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      setJsonText(content);
    };
    reader.readAsText(file);
  };

  const handleChooseFileClick = async (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const adapter = getDefaultPlatformAdapter();
    if (adapter?.capabilities?.supportsNativeFileSystem && adapter?.openFile) {
      try {
        setErrorMsg(null);
        setSuccessMsg(null);
        const result = await adapter.openFile({
          filters: [{ name: 'Postman JSON Files', extensions: ['json'] }],
        });
        if (result && typeof result.content === 'string') {
          setJsonText(result.content);
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to open file via system dialog.');
      }
      return;
    }

    // Web / Extension fallback: trigger standard HTML file input
    fileInputRef.current?.click();
  };

  const handleImportPostman = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!jsonText.trim()) {
      setErrorMsg('Please paste JSON content or select a file first.');
      return;
    }

    setIsImporting(true);
    try {
      const detected = detectPostmanJsonType(jsonText);

      if (detected === 'environment') {
        if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role)) {
          setErrorMsg('Insufficient permission to import environments into this scope (requires env:write).');
          return;
        }

        const incomingEnv = importPostmanEnvironment(jsonText);
        const existingEnv = environments.find(
          (e) => e.name.trim().toLowerCase() === incomingEnv.name.trim().toLowerCase()
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

        await addEnvironment(incomingEnv);
        setSuccessMsg(`Postman Environment "${incomingEnv.name}" imported and activated!`);
        setTimeout(() => {
          onClose();
          setJsonText('');
          setSuccessMsg(null);
        }, 900);
      } else {
        if (!hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role)) {
          setErrorMsg('Insufficient permission to import collections into this scope (requires collection:write).');
          return;
        }

        const incomingCol = importPostmanCollection(jsonText);
        const existingCol = collections.find(
          (c) => c.name.trim().toLowerCase() === incomingCol.name.trim().toLowerCase()
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

        await addCollection(incomingCol);
        setSuccessMsg(`Postman Collection "${incomingCol.name}" imported and synced!`);
        setTimeout(() => {
          onClose();
          setJsonText('');
          setSuccessMsg(null);
        }, 900);
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to parse Postman file.');
    } finally {
      setIsImporting(false);
    }
  };

  const handleImportAsCopy = async () => {
    if (!conflict) return;
    setIsResolvingConflict(true);
    setErrorMsg(null);
    try {
      if (conflict.type === 'collection') {
        if (!hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role)) {
          setErrorMsg('Insufficient permission to create collection copies in this scope (requires collection:write).');
          return;
        }

        const existingNames = collections.map((c) => c.name);
        const copyName = generateCopyCollectionName(conflict.incomingCol.name, existingNames);
        const copyCol = cloneCollectionWithNewIds(conflict.incomingCol, copyName);

        await addCollection(copyCol);
        setSuccessMsg(`Postman Collection "${copyName}" imported as copy!`);
      } else {
        if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role)) {
          setErrorMsg('Insufficient permission to create environment copies in this scope (requires env:write).');
          return;
        }

        const existingNames = environments.map((e) => e.name);
        const copyName = generateCopyEnvironmentName(conflict.incomingEnv.name, existingNames);
        const copyEnv = cloneEnvironmentWithNewIds(conflict.incomingEnv, copyName);

        await addEnvironment(copyEnv);
        setSuccessMsg(`Postman Environment "${copyName}" imported as copy!`);
      }
      setTimeout(() => {
        setConflict(null);
        onClose();
        setJsonText('');
        setSuccessMsg(null);
      }, 900);
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : `Failed to import ${conflict.type} as copy.`
      );
    } finally {
      setIsResolvingConflict(false);
    }
  };

  const handleReplace = async () => {
    if (!conflict) return;
    setIsResolvingConflict(true);
    setErrorMsg(null);
    try {
      if (conflict.type === 'collection') {
        if (!canModifyCollection(conflict.existingCol.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          setErrorMsg(`Cannot replace collection: read-only for your role or lacking write permissions.`);
          return;
        }

        await replaceCollection(conflict.existingCol.id, conflict.incomingCol);
        setSuccessMsg(`Collection "${conflict.existingCol.name}" replaced successfully!`);
      } else {
        if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
            !canModifyEnvironment(conflict.existingEnv.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          setErrorMsg('Cannot replace environment: read-only for your role or lacking write permissions.');
          return;
        }

        await replaceEnvironment(conflict.existingEnv.id, conflict.incomingEnv);
        setSuccessMsg(`Environment "${conflict.existingEnv.name}" replaced successfully!`);
      }
      setTimeout(() => {
        setConflict(null);
        onClose();
        setJsonText('');
        setSuccessMsg(null);
      }, 900);
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : `Failed to replace ${conflict.type}.`
      );
    } finally {
      setIsResolvingConflict(false);
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

      createTab(parsedReq);
      setSuccessMsg('cURL request imported into a new tab!');
      setTimeout(() => {
        onClose();
        setCurlText('');
        setSuccessMsg(null);
      }, 700);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to parse cURL command.');
    }
  };



  const handleModalClose = () => {
    setConflict(null);
    setErrorMsg(null);
    setSuccessMsg(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
        {conflict ? (
          conflict.type === 'environment' ? (
            /* Environment Conflict Resolution View */
            <div>
              {/* Header */}
              <div className="flex items-center justify-between border-b border-zinc-850 pb-4">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    <AlertTriangle className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-zinc-100">Environment Already Exists</h2>
                    <p className="text-xs text-zinc-400">
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
                  onClick={() => setConflict(null)}
                  className="rounded-xl px-4 py-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition disabled:opacity-50"
                >
                  Back
                </button>
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
                    <h2 className="text-base font-semibold text-zinc-100">Collection Already Exists</h2>
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
                  onClick={() => setConflict(null)}
                  className="rounded-xl px-4 py-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition disabled:opacity-50"
                >
                  Back
                </button>
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
        ) : (
          /* Normal Import View */
          <div>
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-850 pb-4">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
                  <Upload className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-zinc-100">Import Requests & Environments</h2>
                  <p className="text-xs text-zinc-400">Import Postman Collections, Environments, or raw cURL commands</p>
                </div>
              </div>
              <button
                onClick={handleModalClose}
                className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Tab Selection */}
            <div className="mt-4 flex border-b border-zinc-850 gap-4 text-xs font-medium text-zinc-400">
              <button
                onClick={() => {
                  setActiveImportTab('postman');
                  setErrorMsg(null);
                  setSuccessMsg(null);
                }}
                className={`flex items-center gap-2 pb-2.5 transition border-b-2 ${
                  activeImportTab === 'postman'
                    ? 'border-sky-500 text-zinc-100 font-semibold'
                    : 'border-transparent hover:text-zinc-200'
                }`}
              >
                <FileJson className="h-4 w-4 text-sky-400" />
                <span>Postman Collection or Environment (.json)</span>
              </button>

              <button
                onClick={() => {
                  setActiveImportTab('curl');
                  setErrorMsg(null);
                  setSuccessMsg(null);
                }}
                className={`flex items-center gap-2 pb-2.5 transition border-b-2 ${
                  activeImportTab === 'curl'
                    ? 'border-sky-500 text-zinc-100 font-semibold'
                    : 'border-transparent hover:text-zinc-200'
                }`}
              >
                <Terminal className="h-4 w-4 text-amber-400" />
                <span>cURL Command</span>
              </button>
            </div>

            {/* Tab 1: Postman Collection or Environment */}
            {activeImportTab === 'postman' && (
              <div className="mt-4 space-y-4">
                {/* Hidden File Input placed outside clickable trigger to prevent recursive bubbling */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  onChange={handleFileUpload}
                  onClick={(e) => e.stopPropagation()}
                  className="hidden"
                />

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
                  className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-700 bg-zinc-900/60 p-4 text-center transition hover:border-sky-500/50 hover:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-sky-500"
                >
                  <FileJson className="h-5 w-5 text-sky-400" />
                  <span className="text-xs font-medium text-zinc-300">
                    Choose or drag a Postman Collection or Environment .json file
                  </span>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-zinc-300">
                    Or paste Postman Collection or Environment JSON directly:
                  </label>
                  <textarea
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                    onKeyDown={(e) =>
                      handleCodeEditorKeyDown(e, {
                        onChange: (val) => setJsonText(val),
                      })
                    }
                    placeholder='Paste Postman Collection JSON (with "info", "item") OR Postman Environment JSON (with "name", "values"). Auto-detected automatically!'
                    className="h-44 w-full rounded-xl border border-zinc-800 bg-zinc-900/90 p-3 font-mono text-xs text-zinc-200 placeholder-zinc-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 transition resize-none"
                  />
                </div>
              </div>
            )}

            {/* Tab 2: cURL Command */}
            {activeImportTab === 'curl' && (
              <div className="mt-4 space-y-4">
                <label className="block text-xs font-medium text-zinc-300">
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
                  className="h-52 w-full rounded-xl border border-zinc-800 bg-zinc-900/90 p-3 font-mono text-xs text-zinc-200 placeholder-zinc-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 transition resize-none"
                />
              </div>
            )}

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

            {/* Action buttons */}
            <div className="mt-6 flex justify-end gap-2.5">
              <button
                onClick={handleModalClose}
                className="rounded-xl px-4 py-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition"
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
                      Import Postman File
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
    </div>
  );
};
