'use client';

import React, { useState, useRef } from 'react';
import {
  Plus,
  Trash2,
  X,
  Globe,
  Check,
  Layers,
  Upload,
  Download,
  AlertCircle,
  CheckCircle2,
  FileCode,
  Shield,
  Lock,
  RotateCcw,
  UploadCloud,
} from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import { exportPostmanEnvironment, importPostmanEnvironment } from '@/lib/postman';
import {
  compareEnvironments,
  generateCopyEnvironmentName,
  cloneEnvironmentWithNewIds,
  EnvironmentDiffSummary,
} from '@/lib/requestDiff';
import { Environment } from '@/types/api';
import { hasScopePermission, canModifyEnvironment } from '@/lib/jwt';
import { ConfirmModal } from './ConfirmModal';
import { EnvironmentConflictModal } from './EnvironmentConflictModal';
import { EnvironmentPermissionModal } from './EnvironmentPermissionModal';
import { handleCodeEditorKeyDown } from '@/lib/editorHelper';
import { getDefaultPlatformAdapter } from '@airrest/common';

interface EnvironmentModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const EnvironmentModal: React.FC<EnvironmentModalProps> = ({ isOpen, onClose }) => {
  const environments = useApiStore((state) => state.environments);
  const activeEnvironmentId = useApiStore((state) => state.activeEnvironmentId);
  const setActiveEnvironmentId = useApiStore((state) => state.setActiveEnvironmentId);
  const createEnvironment = useApiStore((state) => state.createEnvironment);
  const deleteEnvironment = useApiStore((state) => state.deleteEnvironment);
  const updateEnvironment = useApiStore((state) => state.updateEnvironment);
  const addEnvironmentVariable = useApiStore((state) => state.addEnvironmentVariable);
  const updateEnvironmentVariable = useApiStore((state) => state.updateEnvironmentVariable);
  const removeEnvironmentVariable = useApiStore((state) => state.removeEnvironmentVariable);
  const resetEnvironmentCurrentValues = useApiStore((state) => state.resetEnvironmentCurrentValues);
  const persistEnvironmentCurrentValues = useApiStore((state) => state.persistEnvironmentCurrentValues);
  const addEnvironment = useApiStore((state) => state.addEnvironment);
  const replaceEnvironment = useApiStore((state) => state.replaceEnvironment);
  const importEnvironmentFromJson = useApiStore((state) => state.importEnvironmentFromJson);
  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);

  const activeScope = cloudConfig?.activeScope;
  const isProjectScope = activeScope?.type === 'project';

  // Dynamic capability permissions
  const canWriteEnv = hasScopePermission(activeScope, 'env:write', workspaceMode, cloudConfig?.user?.role);
  const canDeleteEnv = hasScopePermission(activeScope, 'env:delete', workspaceMode, cloudConfig?.user?.role);
  const isProjectAdmin = hasScopePermission(activeScope, '*', workspaceMode, cloudConfig?.user?.role);
  const isCreateDisabled = isProjectScope && !canWriteEnv;

  const [selectedEnvId, setSelectedEnvId] = useState<string>(
    activeEnvironmentId || (environments[0]?.id ?? '')
  );
  const [newEnvName, setNewEnvName] = useState('');
  const [newEnvMinRole, setNewEnvMinRole] = useState<'reader' | 'contributor' | 'maintainer' | 'admin'>('reader');
  const [isAddingEnv, setIsAddingEnv] = useState(false);
  const [isPasteModalOpen, setIsPasteModalOpen] = useState(false);
  const [pastedJson, setPastedJson] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [conflict, setConflict] = useState<{
    existingEnv: Environment;
    incomingEnv: Environment;
    diff: EnvironmentDiffSummary;
  } | null>(null);
  const [isResolvingConflict, setIsResolvingConflict] = useState(false);
  const [isPermModalOpen, setIsPermModalOpen] = useState(false);
  const [isNewEnvPermModalOpen, setIsNewEnvPermModalOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const currentEnv =
    (environments || []).find((e) => e.id === selectedEnvId) || (environments || [])[0];
  const isEnvReadOnly = currentEnv
    ? !canModifyEnvironment(currentEnv.minRole, activeScope, workspaceMode, cloudConfig?.user?.role)
    : false;

  const handleCreateEnv = () => {
    if (!newEnvName.trim()) return;
    const newId = createEnvironment(newEnvName, isProjectScope ? newEnvMinRole : 'reader');
    setSelectedEnvId(newId);
    setNewEnvName('');
    setNewEnvMinRole('reader');
    setIsAddingEnv(false);
  };

  const handleExportEnv = () => {
    if (!currentEnv) return;
    try {
      const jsonStr = exportPostmanEnvironment(currentEnv);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${String(currentEnv.name || 'environment').toLowerCase().replace(/\s+/g, '-')}.postman_environment.json`;
      a.click();
      URL.revokeObjectURL(url);
      setSuccessMsg(`Exported "${currentEnv.name}" as Postman environment JSON.`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to export environment.');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    setErrorMsg(null);
    setSuccessMsg(null);
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = event.target?.result as string;
      try {
        const incoming = importPostmanEnvironment(content);
        const existing = (environments || []).find(
          (env) => String(env?.name || '').trim().toLowerCase() === String(incoming?.name || '').trim().toLowerCase()
        );

        if (existing) {
          const diff = compareEnvironments(existing, incoming);
          setConflict({
            existingEnv: existing,
            incomingEnv: incoming,
            diff,
          });
          return;
        }

        const newId = await addEnvironment(incoming);
        setSelectedEnvId(newId);
        setSuccessMsg(
          `Environment "${incoming.name}" imported with ${incoming.variables?.length || 0} variables!`
        );
        setTimeout(() => setSuccessMsg(null), 3000);
      } catch (err: unknown) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to import environment file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleImportFileClick = async () => {
    const adapter = getDefaultPlatformAdapter();
    if (adapter?.capabilities?.supportsNativeFileSystem && adapter?.openFile) {
      try {
        setErrorMsg(null);
        setSuccessMsg(null);
        const result = await adapter.openFile({
          filters: [{ name: 'Postman Environment JSON', extensions: ['json'] }],
        });
        if (result && typeof result.content === 'string') {
          const incoming = importPostmanEnvironment(result.content);
          const existing = (environments || []).find(
            (env) => String(env?.name || '').trim().toLowerCase() === String(incoming?.name || '').trim().toLowerCase()
          );

          if (existing) {
            const diff = compareEnvironments(existing, incoming);
            setConflict({
              existingEnv: existing,
              incomingEnv: incoming,
              diff,
            });
            return;
          }

          const newId = await addEnvironment(incoming);
          setSelectedEnvId(newId);
          setSuccessMsg(
            `Environment "${incoming.name}" imported with ${incoming.variables?.length || 0} variables!`
          );
          setTimeout(() => setSuccessMsg(null), 3000);
        }
      } catch (err: unknown) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to import environment file.');
      }
      return;
    }
    fileInputRef.current?.click();
  };

  const handlePasteImport = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!pastedJson.trim()) {
      setErrorMsg('Please paste Postman environment JSON first.');
      return;
    }

    try {
      const incoming = importPostmanEnvironment(pastedJson);
      const existing = (environments || []).find(
        (env) => String(env?.name || '').trim().toLowerCase() === String(incoming?.name || '').trim().toLowerCase()
      );

      if (existing) {
        const diff = compareEnvironments(existing, incoming);
        setIsPasteModalOpen(false);
        setPastedJson('');
        setConflict({
          existingEnv: existing,
          incomingEnv: incoming,
          diff,
        });
        return;
      }

      const newId = await addEnvironment(incoming);
      setSelectedEnvId(newId);
      setIsPasteModalOpen(false);
      setPastedJson('');
      setSuccessMsg(
        `Environment "${incoming.name}" imported with ${incoming.variables.length} variables!`
      );
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Invalid Postman environment format.');
    }
  };

  const handleConflictAsCopy = async () => {
    if (!conflict) return;
    setIsResolvingConflict(true);
    setErrorMsg(null);
    try {
      const existingNames = environments.map((e) => e.name);
      const copyName = generateCopyEnvironmentName(conflict.incomingEnv.name, existingNames);
      const copyEnv = cloneEnvironmentWithNewIds(conflict.incomingEnv, copyName);

      const newId = await addEnvironment(copyEnv);
      setSelectedEnvId(newId);
      setSuccessMsg(`Environment "${copyName}" imported as copy!`);
      setTimeout(() => setSuccessMsg(null), 3000);
      setConflict(null);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to import environment as copy.');
    } finally {
      setIsResolvingConflict(false);
    }
  };

  const handleConflictReplace = async () => {
    if (!conflict) return;
    setIsResolvingConflict(true);
    setErrorMsg(null);
    try {
      await replaceEnvironment(conflict.existingEnv.id, conflict.incomingEnv);
      setSelectedEnvId(conflict.existingEnv.id);
      setSuccessMsg(`Environment "${conflict.existingEnv.name}" replaced successfully!`);
      setTimeout(() => setSuccessMsg(null), 3000);
      setConflict(null);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to replace environment.');
    } finally {
      setIsResolvingConflict(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="flex h-[580px] w-full max-w-5xl overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        {/* Hidden File Picker for Import */}
        <input
          type="file"
          ref={fileInputRef}
          accept=".json,application/json"
          onChange={handleFileUpload}
          className="hidden"
        />

        {/* Left Side: Environment List */}
        <div className="flex w-64 flex-col border-r border-zinc-850 bg-zinc-900/40 p-4">
          <div className="flex items-center justify-between pb-3 border-b border-zinc-850">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-sky-400" />
              <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-300">
                Environments
              </h2>
            </div>
            <div className="flex items-center gap-1">
              {!isCreateDisabled && (
                <>
                  <button
                    onClick={handleImportFileClick}
                    className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-sky-300 transition"
                    title="Import Postman Environment (.json)"
                  >
                    <Upload className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => setIsAddingEnv(true)}
                    className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white transition"
                    title="Create Environment"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </>
              )}
            </div>
          </div>

          {isAddingEnv && (
            <div className="mt-3 flex flex-col gap-2 rounded-xl border border-zinc-700 bg-zinc-900/90 p-2.5">
              <input
                type="text"
                value={newEnvName}
                onChange={(e) => setNewEnvName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateEnv()}
                placeholder="Environment name..."
                autoFocus
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
              />
              {isProjectScope && (
                <div className="flex items-center gap-1.5 text-[10px] text-zinc-400">
                  <Shield className="h-3 w-3 text-zinc-400 shrink-0" />
                  <button
                    type="button"
                    onClick={() => setIsNewEnvPermModalOpen(true)}
                    className="flex items-center justify-between w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300 hover:border-zinc-700 transition"
                  >
                    <span>
                      Access:{' '}
                      {newEnvMinRole === 'admin'
                        ? '🔴 Admin Only'
                        : newEnvMinRole === 'maintainer'
                          ? '🔵 Maintainer+'
                          : newEnvMinRole === 'contributor'
                            ? '🟡 Contributor+'
                            : '🟢 All Members (Reader+)'}
                    </span>
                    <span className="text-[10px] text-sky-400 font-semibold">Change</span>
                  </button>
                </div>
              )}
              <div className="flex justify-end gap-1.5 pt-1">
                <button
                  onClick={() => setIsAddingEnv(false)}
                  className="rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateEnv}
                  className="rounded bg-sky-500 px-2.5 py-0.5 text-[11px] font-bold text-white hover:bg-sky-400"
                >
                  Create
                </button>
              </div>
            </div>
          )}

          <div className="mt-3 flex-1 overflow-y-auto space-y-1">
            {environments.map((env) => {
              const isSelected = env.id === currentEnv?.id;
              const isActive = env.id === activeEnvironmentId;

              return (
                <div
                  key={env.id}
                  onClick={() => setSelectedEnvId(env.id)}
                  className={`group flex items-center justify-between rounded-xl px-3 py-2 text-xs cursor-pointer transition ${isSelected
                      ? 'bg-zinc-800/90 text-white font-semibold'
                      : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                    }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Layers className="h-3.5 w-3.5 shrink-0 text-zinc-500 group-hover:text-sky-400" />
                    <span className="truncate">{env.name}</span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {env.minRole === 'admin' && (
                      <span className="flex items-center gap-0.5 text-[9px] text-rose-400 bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/30 font-medium shrink-0" title="Admin only access">
                        <Shield className="h-2.5 w-2.5" />
                        Admin
                      </span>
                    )}
                    {env.minRole === 'maintainer' && (
                      <span className="flex items-center gap-0.5 text-[9px] text-sky-400 bg-sky-500/10 px-1.5 py-0.5 rounded border border-sky-500/30 font-medium shrink-0" title="Maintainer and Admin access">
                        <Shield className="h-2.5 w-2.5" />
                        Maintainer
                      </span>
                    )}
                    {env.minRole === 'contributor' && (
                      <span className="flex items-center gap-0.5 text-[9px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/30 font-medium shrink-0" title="Contributor, Maintainer, and Admin access">
                        <Shield className="h-2.5 w-2.5" />
                        Contrib+
                      </span>
                    )}
                    {isActive && (
                      <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-bold bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 shrink-0">
                        <Check className="h-2.5 w-2.5" />
                        Active
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Quick Import Link on Left Footer */}
          {!isCreateDisabled && (
            <div className="pt-3 border-t border-zinc-850 flex items-center justify-between text-[11px] text-zinc-400">
              <button
                onClick={handleImportFileClick}
                className="flex items-center gap-1.5 text-sky-400 hover:text-sky-300 transition"
              >
                <Upload className="h-3 w-3" />
                <span>Import File</span>
              </button>
              <button
                onClick={() => setIsPasteModalOpen(true)}
                className="flex items-center gap-1 text-zinc-400 hover:text-zinc-200 transition"
              >
                <FileCode className="h-3 w-3" />
                <span>Paste JSON</span>
              </button>
            </div>
          )}
        </div>

        {/* Right Side: Variable Table & Edit */}
        <div className="flex flex-1 flex-col overflow-hidden bg-zinc-950 p-6">
          <div className="flex items-center justify-between border-b border-zinc-850 pb-4">
            {currentEnv ? (
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="text"
                  value={currentEnv.name}
                  disabled={isEnvReadOnly}
                  onChange={(e) => updateEnvironment(currentEnv.id, { name: e.target.value })}
                  className="bg-transparent font-bold text-sm text-zinc-100 focus:outline-none focus:border-b focus:border-sky-500 px-1 py-0.5 rounded disabled:opacity-80"
                />
                <button
                  onClick={() =>
                    setActiveEnvironmentId(
                      activeEnvironmentId === currentEnv.id ? null : currentEnv.id
                    )
                  }
                  className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${activeEnvironmentId === currentEnv.id
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white'
                    }`}
                >
                  {activeEnvironmentId === currentEnv.id ? 'Active Environment' : 'Set as Active'}
                </button>

                {isProjectScope && (
                  <button
                    type="button"
                    disabled={isEnvReadOnly || !canWriteEnv}
                    onClick={() => setIsPermModalOpen(true)}
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/80 px-2.5 py-1 text-xs hover:border-zinc-700 hover:bg-zinc-850 transition disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                    title={
                      !canWriteEnv
                        ? 'Contributor, Maintainer, or Admin access required to change access restrictions'
                        : isEnvReadOnly
                          ? 'Higher permission required to edit this restricted environment'
                          : 'Change minimum required role'
                    }
                  >
                    <Shield
                      className={`h-3.5 w-3.5 shrink-0 ${currentEnv.minRole === 'admin'
                          ? 'text-rose-400'
                          : currentEnv.minRole === 'maintainer'
                            ? 'text-sky-400'
                            : currentEnv.minRole === 'contributor'
                              ? 'text-amber-400'
                              : 'text-emerald-400'
                        }`}
                    />
                    <span className="text-zinc-400 text-[11px]">Access:</span>
                    <span className="font-semibold text-zinc-200">
                      {currentEnv.minRole === 'admin'
                        ? '🔴 Admin Only'
                        : currentEnv.minRole === 'maintainer'
                          ? '🔵 Maintainer+'
                          : currentEnv.minRole === 'contributor'
                            ? '🟡 Contributor+'
                            : '🟢 All Members (Reader+)'}
                    </span>
                  </button>
                )}

                {isEnvReadOnly && (
                  <span className="flex items-center gap-1 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">
                    <Lock className="h-3 w-3" />
                    Read Only
                  </span>
                )}
              </div>
            ) : (
              <div className="text-xs text-zinc-400">Select an environment</div>
            )}

            <div className="flex items-center gap-2">
              {currentEnv && (
                <button
                  onClick={handleExportEnv}
                  className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition"
                  title="Export as Postman Environment (.json)"
                >
                  <Download className="h-3.5 w-3.5 text-zinc-400" />
                  <span>Export</span>
                </button>
              )}

              {currentEnv && (environments || []).length > 1 && (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={isEnvReadOnly || !canDeleteEnv}
                  className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-900 hover:text-rose-400 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  title={!canDeleteEnv ? 'Insufficient permission to delete environment' : isEnvReadOnly ? 'Higher permission required to delete this restricted environment' : 'Delete Environment'}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
              <button
                onClick={onClose}
                className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-white transition"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Feedback alerts */}
          {errorMsg && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-300">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Paste JSON Modal overlay */}
          {isPasteModalOpen ? (
            <div className="flex flex-1 flex-col space-y-3 mt-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-300">
                  Paste Postman Environment JSON:
                </span>
                <button
                  onClick={() => setIsPasteModalOpen(false)}
                  className="text-xs text-zinc-500 hover:text-zinc-300"
                >
                  Cancel
                </button>
              </div>
              <textarea
                value={pastedJson}
                onChange={(e) => setPastedJson(e.target.value)}
                onKeyDown={(e) =>
                  handleCodeEditorKeyDown(e, {
                    onChange: (val) => setPastedJson(val),
                  })
                }
                placeholder='{\n  "name": "My Environment",\n  "values": [\n    { "key": "baseUrl", "value": "https://api.example.com" }\n  ]\n}'
                className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900/90 p-3 font-mono text-xs text-zinc-100 placeholder-zinc-500 focus:border-sky-500 focus:outline-none resize-none"
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setIsPasteModalOpen(false)}
                  className="rounded-xl px-4 py-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  Cancel
                </button>
                <button
                  onClick={handlePasteImport}
                  className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-sky-500/20 hover:from-sky-400 hover:to-blue-500 active:scale-95 transition"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Import Environment
                </button>
              </div>
            </div>
          ) : currentEnv ? (
            <div className="flex flex-1 flex-col overflow-hidden mt-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] text-zinc-400">
                  <span className="text-sky-300 font-semibold">Initial Value</span> syncs to cloud. <span className="text-amber-300 font-semibold">Current Value</span> is local to this session (used in requests &amp; scripts, never pushed upstream).
                </p>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      resetEnvironmentCurrentValues(currentEnv.id);
                      setSuccessMsg('Reset all current values to initial values');
                      setTimeout(() => setSuccessMsg(null), 2500);
                    }}
                    className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/80 px-2 py-1 text-[11px] font-medium text-zinc-400 hover:bg-zinc-850 hover:text-white transition"
                    title="Reset all current values in this environment to their initial values"
                  >
                    <RotateCcw className="h-3 w-3 text-sky-400" />
                    <span>Reset All</span>
                  </button>
                  <button
                    type="button"
                    disabled={isEnvReadOnly}
                    onClick={() => {
                      persistEnvironmentCurrentValues(currentEnv.id);
                      setSuccessMsg('Persisted all current values to initial values and synced to cloud');
                      setTimeout(() => setSuccessMsg(null), 2500);
                    }}
                    className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/80 px-2 py-1 text-[11px] font-medium text-zinc-400 hover:bg-zinc-850 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition"
                    title={isEnvReadOnly ? 'Read only in cloud scope' : 'Copy all current values to initial values and sync to cloud'}
                  >
                    <UploadCloud className="h-3 w-3 text-emerald-400" />
                    <span>Persist All</span>
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto rounded-xl border border-zinc-850 bg-zinc-900/30">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-zinc-800 bg-zinc-900/70 text-zinc-400">
                    <tr>
                      <th className="w-10 px-3 py-2 text-center">Use</th>
                      <th className="w-40 px-3 py-2 font-medium">Variable Name</th>
                      <th className="px-3 py-2 font-medium">
                        <div className="flex items-center gap-1.5">
                          <span>Initial Value</span>
                          <span className="rounded bg-sky-500/10 px-1 py-0.5 text-[9px] font-normal text-sky-400 border border-sky-500/20">Synced to Cloud</span>
                        </div>
                      </th>
                      <th className="px-3 py-2 font-medium">
                        <div className="flex items-center gap-1.5">
                          <span>Current Value</span>
                          <span className="rounded bg-amber-500/10 px-1 py-0.5 text-[9px] font-normal text-amber-300 border border-amber-500/20">Local Session</span>
                        </div>
                      </th>
                      <th className="w-20 px-2 py-2 text-center font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-850">
                    {currentEnv.variables.map((v) => {
                      const initialVal = v.initialValue ?? v.value ?? '';
                      const currentVal = v.currentValue !== undefined ? v.currentValue : initialVal;
                      return (
                        <tr key={v.id} className="group hover:bg-zinc-900/50 transition">
                          <td className="px-3 py-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={v.enabled}
                              disabled={isEnvReadOnly}
                              onChange={(e) =>
                                updateEnvironmentVariable(currentEnv.id, v.id, {
                                  enabled: e.target.checked,
                                })
                              }
                              className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 text-sky-500 accent-sky-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="text"
                              value={v.key}
                              disabled={isEnvReadOnly}
                              onChange={(e) =>
                                updateEnvironmentVariable(currentEnv.id, v.id, {
                                  key: e.target.value,
                                })
                              }
                              placeholder="e.g. baseUrl"
                              className="w-full rounded bg-transparent px-2 py-1 font-mono text-xs text-sky-400 placeholder-zinc-600 focus:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-sky-500/50 disabled:opacity-60 disabled:cursor-not-allowed"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="text"
                              value={initialVal}
                              disabled={isEnvReadOnly}
                              onChange={(e) => {
                                const nextInit = e.target.value;
                                const shouldSyncCurrent = currentVal === '' || currentVal === initialVal;
                                updateEnvironmentVariable(currentEnv.id, v.id, {
                                  initialValue: nextInit,
                                  value: nextInit,
                                  ...(shouldSyncCurrent ? { currentValue: nextInit } : {}),
                                });
                              }}
                              placeholder="e.g. https://api.example.com"
                              className="w-full rounded bg-transparent px-2 py-1 font-mono text-xs text-zinc-200 placeholder-zinc-600 focus:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-sky-500/50 disabled:opacity-60 disabled:cursor-not-allowed"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="text"
                              value={currentVal}
                              onChange={(e) =>
                                updateEnvironmentVariable(currentEnv.id, v.id, {
                                  currentValue: e.target.value,
                                })
                              }
                              placeholder="Local value..."
                              className="w-full rounded bg-transparent px-2 py-1 font-mono text-xs text-amber-300 placeholder-zinc-600 focus:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                            />
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <div className="flex items-center justify-center gap-1">
                              <button
                                type="button"
                                onClick={() =>
                                  updateEnvironmentVariable(currentEnv.id, v.id, {
                                    currentValue: initialVal,
                                  })
                                }
                                className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-sky-300 transition"
                                title="Reset Current Value to Initial Value"
                              >
                                <RotateCcw className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                disabled={isEnvReadOnly}
                                onClick={() =>
                                  updateEnvironmentVariable(currentEnv.id, v.id, {
                                    initialValue: currentVal,
                                    value: currentVal,
                                  })
                                }
                                className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400 disabled:opacity-20 disabled:cursor-not-allowed transition"
                                title={isEnvReadOnly ? 'Read only in cloud scope' : 'Persist Current Value to Initial Value (syncs to cloud)'}
                              >
                                <UploadCloud className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => removeEnvironmentVariable(currentEnv.id, v.id)}
                                disabled={isEnvReadOnly}
                                className="rounded p-1 text-zinc-600 opacity-60 hover:bg-zinc-800 hover:text-rose-400 group-hover:opacity-100 disabled:opacity-20 disabled:cursor-not-allowed transition"
                                title={isEnvReadOnly ? 'Read only' : 'Delete variable'}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex justify-between items-center">
                <button
                  type="button"
                  disabled={isEnvReadOnly}
                  onClick={() => addEnvironmentVariable(currentEnv.id)}
                  className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  title={isEnvReadOnly ? 'Read only' : 'Add Variable'}
                >
                  <Plus className="h-3.5 w-3.5 text-sky-400" />
                  <span>Add Variable</span>
                </button>

                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-xl bg-zinc-800 px-4 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 transition"
                >
                  Done
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <ConfirmModal
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={() => {
          if (currentEnv) {
            const nextEnv = environments.find((e) => e.id !== currentEnv.id);
            if (nextEnv) {
              setSelectedEnvId(nextEnv.id);
            }
            deleteEnvironment(currentEnv.id);
            setShowDeleteConfirm(false);
          }
        }}
        title="Delete Environment"
        message={
          <span>
            Are you sure you want to delete environment{' '}
            <strong className="text-zinc-200">"{currentEnv?.name}"</strong>? All variables defined in this environment will be permanently removed.
          </span>
        }
        confirmText="Delete Environment"
        variant="danger"
      />

      {conflict && (
        <EnvironmentConflictModal
          isOpen={Boolean(conflict)}
          onClose={() => setConflict(null)}
          existingEnv={conflict.existingEnv}
          incomingEnv={conflict.incomingEnv}
          diff={conflict.diff}
          onImportAsCopy={handleConflictAsCopy}
          onReplace={handleConflictReplace}
          isResolving={isResolvingConflict}
        />
      )}

      {currentEnv && (
        <EnvironmentPermissionModal
          isOpen={isPermModalOpen}
          onClose={() => setIsPermModalOpen(false)}
          environmentName={currentEnv.name}
          currentRole={currentEnv.minRole || 'reader'}
          onSave={(role) => {
            updateEnvironment(currentEnv.id, { minRole: role });
          }}
        />
      )}

      <EnvironmentPermissionModal
        isOpen={isNewEnvPermModalOpen}
        onClose={() => setIsNewEnvPermModalOpen(false)}
        environmentName={newEnvName.trim() || 'New Environment'}
        currentRole={newEnvMinRole}
        onSave={(role) => {
          setNewEnvMinRole(role);
        }}
      />
    </div>
  );
};
