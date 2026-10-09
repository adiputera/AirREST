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
} from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import { exportPostmanEnvironment } from '@/lib/postman';

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
  const importEnvironmentFromJson = useApiStore((state) => state.importEnvironmentFromJson);

  const [selectedEnvId, setSelectedEnvId] = useState<string>(
    activeEnvironmentId || (environments[0]?.id ?? '')
  );
  const [newEnvName, setNewEnvName] = useState('');
  const [isAddingEnv, setIsAddingEnv] = useState(false);
  const [isPasteModalOpen, setIsPasteModalOpen] = useState(false);
  const [pastedJson, setPastedJson] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const currentEnv =
    environments.find((e) => e.id === selectedEnvId) || environments[0];

  const handleCreateEnv = () => {
    if (!newEnvName.trim()) return;
    const newId = createEnvironment(newEnvName);
    setSelectedEnvId(newId);
    setNewEnvName('');
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
      a.download = `${currentEnv.name.toLowerCase().replace(/\s+/g, '-')}.postman_environment.json`;
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
    reader.onload = (event) => {
      const content = event.target?.result as string;
      const res = importEnvironmentFromJson(content);
      if (res.success && res.environment) {
        setSelectedEnvId(res.environment.id);
        setSuccessMsg(
          `Environment "${res.environment.name}" imported with ${res.environment.variables.length} variables!`
        );
        setTimeout(() => setSuccessMsg(null), 3000);
      } else {
        setErrorMsg(res.error || 'Failed to import environment file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handlePasteImport = () => {
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!pastedJson.trim()) {
      setErrorMsg('Please paste Postman environment JSON first.');
      return;
    }

    const res = importEnvironmentFromJson(pastedJson);
    if (res.success && res.environment) {
      setSelectedEnvId(res.environment.id);
      setIsPasteModalOpen(false);
      setPastedJson('');
      setSuccessMsg(
        `Environment "${res.environment.name}" imported with ${res.environment.variables.length} variables!`
      );
      setTimeout(() => setSuccessMsg(null), 3000);
    } else {
      setErrorMsg(res.error || 'Invalid Postman environment format.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="flex h-[580px] w-full max-w-4xl overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
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
              <button
                onClick={() => fileInputRef.current?.click()}
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
            </div>
          </div>

          {isAddingEnv && (
            <div className="mt-3 flex gap-1">
              <input
                type="text"
                value={newEnvName}
                onChange={(e) => setNewEnvName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateEnv()}
                placeholder="Environment name..."
                autoFocus
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
              />
              <button
                onClick={handleCreateEnv}
                className="rounded-lg bg-sky-500 px-2 text-xs font-bold text-white hover:bg-sky-400"
              >
                ✓
              </button>
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
                  className={`group flex items-center justify-between rounded-xl px-3 py-2 text-xs cursor-pointer transition ${
                    isSelected
                      ? 'bg-zinc-800/90 text-white font-semibold'
                      : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Layers className="h-3.5 w-3.5 shrink-0 text-zinc-500 group-hover:text-sky-400" />
                    <span className="truncate">{env.name}</span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {isActive && (
                      <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-bold bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
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
          <div className="pt-3 border-t border-zinc-850 flex items-center justify-between text-[11px] text-zinc-400">
            <button
              onClick={() => fileInputRef.current?.click()}
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
        </div>

        {/* Right Side: Variable Table & Edit */}
        <div className="flex flex-1 flex-col overflow-hidden bg-zinc-950 p-6">
          <div className="flex items-center justify-between border-b border-zinc-850 pb-4">
            {currentEnv ? (
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={currentEnv.name}
                  onChange={(e) => updateEnvironment(currentEnv.id, { name: e.target.value })}
                  className="bg-transparent font-bold text-sm text-zinc-100 focus:outline-none focus:border-b focus:border-sky-500 px-1 py-0.5 rounded"
                />
                <button
                  onClick={() =>
                    setActiveEnvironmentId(
                      activeEnvironmentId === currentEnv.id ? null : currentEnv.id
                    )
                  }
                  className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                    activeEnvironmentId === currentEnv.id
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white'
                  }`}
                >
                  {activeEnvironmentId === currentEnv.id ? 'Active Environment' : 'Set as Active'}
                </button>
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

              {currentEnv && environments.length > 1 && (
                <button
                  onClick={() => deleteEnvironment(currentEnv.id)}
                  className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-900 hover:text-rose-400 transition"
                  title="Delete Environment"
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
              <p className="text-[11px] text-zinc-500 mb-2">
                Reference variables in requests with double curly braces (e.g.,{' '}
                <code className="text-sky-400">{'{{baseUrl}}'}</code> or{' '}
                <code className="text-sky-400">{'{{token}}'}</code>).
              </p>

              <div className="flex-1 overflow-y-auto rounded-xl border border-zinc-850 bg-zinc-900/30">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-zinc-800 bg-zinc-900/70 text-zinc-400">
                    <tr>
                      <th className="w-10 px-3 py-2 text-center">Use</th>
                      <th className="px-3 py-2 font-medium">Variable Name</th>
                      <th className="px-3 py-2 font-medium">Value</th>
                      <th className="w-10 px-3 py-2 text-center"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-850">
                    {currentEnv.variables.map((v) => (
                      <tr key={v.id} className="group hover:bg-zinc-900/50 transition">
                        <td className="px-3 py-1.5 text-center">
                          <input
                            type="checkbox"
                            checked={v.enabled}
                            onChange={(e) =>
                              updateEnvironmentVariable(currentEnv.id, v.id, {
                                enabled: e.target.checked,
                              })
                            }
                            className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 text-sky-500 accent-sky-500 cursor-pointer"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="text"
                            value={v.key}
                            onChange={(e) =>
                              updateEnvironmentVariable(currentEnv.id, v.id, {
                                key: e.target.value,
                              })
                            }
                            placeholder="e.g. baseUrl"
                            className="w-full rounded bg-transparent px-2 py-1 font-mono text-xs text-sky-400 placeholder-zinc-600 focus:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-sky-500/50"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="text"
                            value={v.value}
                            onChange={(e) =>
                              updateEnvironmentVariable(currentEnv.id, v.id, {
                                value: e.target.value,
                              })
                            }
                            placeholder="e.g. https://api.example.com"
                            className="w-full rounded bg-transparent px-2 py-1 font-mono text-xs text-zinc-200 placeholder-zinc-600 focus:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-sky-500/50"
                          />
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <button
                            onClick={() => removeEnvironmentVariable(currentEnv.id, v.id)}
                            className="rounded p-1 text-zinc-600 opacity-60 hover:bg-zinc-800 hover:text-rose-400 group-hover:opacity-100 transition"
                            title="Delete variable"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex justify-between items-center">
                <button
                  type="button"
                  onClick={() => addEnvironmentVariable(currentEnv.id)}
                  className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition"
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
    </div>
  );
};
