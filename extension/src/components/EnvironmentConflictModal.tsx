'use client';

import React, { useEffect } from 'react';
import {
  AlertTriangle,
  X,
  Copy,
  RefreshCw,
  Loader2,
  Globe,
} from 'lucide-react';
import { Environment } from '@/types/api';
import {
  EnvironmentDiffSummary,
  generateCopyEnvironmentName,
} from '@/lib/requestDiff';
import { useApiStore } from '@/store/useApiStore';

export interface EnvironmentConflictModalProps {
  isOpen: boolean;
  onClose: () => void;
  existingEnv: Environment;
  incomingEnv: Environment;
  diff: EnvironmentDiffSummary;
  onImportAsCopy: () => void;
  onReplace: () => void;
  isResolving?: boolean;
}

export const EnvironmentConflictModal: React.FC<EnvironmentConflictModalProps> = ({
  isOpen,
  onClose,
  existingEnv,
  incomingEnv,
  diff,
  onImportAsCopy,
  onReplace,
  isResolving = false,
}) => {
  const environments = useApiStore((state) => state.environments);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isResolving) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isResolving, onClose]);

  if (!isOpen) return null;

  const existingNames = environments.map((e) => e.name);
  const copyCandidateName = generateCopyEnvironmentName(incomingEnv.name, existingNames);
  const totalChanges = diff.added.length + diff.modified.length + diff.removed.length;

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget && !isResolving) {
          onClose();
        }
      }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
    >
      <div className="w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-850 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-100">Environment Already Exists</h2>
              <p className="text-xs text-zinc-400">
                An environment named <span className="font-semibold text-zinc-200">"{existingEnv.name}"</span> already exists in your workspace.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isResolving}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors disabled:opacity-40"
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
                ({totalChanges} {totalChanges === 1 ? 'change' : 'changes'} detected)
              </span>
            </span>

            <div className="flex items-center gap-1.5 text-[11px]">
              {diff.added.length > 0 && (
                <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-400 border border-emerald-500/20">
                  +{diff.added.length} Added
                </span>
              )}
              {diff.modified.length > 0 && (
                <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-400 border border-amber-500/20">
                  ~{diff.modified.length} Modified
                </span>
              )}
              {diff.removed.length > 0 && (
                <span className="inline-flex items-center rounded-full bg-rose-500/10 px-2 py-0.5 font-medium text-rose-400 border border-rose-500/20">
                  -{diff.removed.length} Removed
                </span>
              )}
              {diff.unchangedCount > 0 && (
                <span className="inline-flex items-center rounded-full bg-zinc-850 px-2 py-0.5 font-medium text-zinc-400 border border-zinc-750">
                  {diff.unchangedCount} Same
                </span>
              )}
            </div>
          </div>

          {/* Changed Variables List */}
          <div className="max-h-56 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 space-y-1.5">
            {totalChanges === 0 ? (
              <div className="py-6 text-center text-xs text-zinc-400">
                All {diff.totalIncoming} variables are identical between existing and incoming environment.
              </div>
            ) : (
              <>
                {diff.added.map((item, idx) => (
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

                {diff.modified.map((item, idx) => (
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

                {diff.removed.map((item, idx) => (
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

        {/* Action Explanation Cards */}
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="flex items-center gap-1.5 font-semibold text-zinc-200">
              <Copy className="h-3.5 w-3.5 text-sky-400" />
              <span>Import as Copy</span>
            </div>
            <p className="mt-1 text-zinc-400 text-[11px] leading-relaxed">
              Imports as a new environment named{' '}
              <span className="font-semibold text-sky-300">"{copyCandidateName}"</span>. Existing environment is kept intact.
            </p>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="flex items-center gap-1.5 font-semibold text-zinc-200">
              <RefreshCw className="h-3.5 w-3.5 text-amber-400" />
              <span>Replace Environment</span>
            </div>
            <p className="mt-1 text-zinc-400 text-[11px] leading-relaxed">
              Replaces <span className="font-semibold text-amber-300">"{existingEnv.name}"</span> in-place. Variable values will be updated and synced.
            </p>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="mt-6 flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2.5">
          <button
            type="button"
            disabled={isResolving}
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isResolving}
            onClick={onImportAsCopy}
            className="flex items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-850 hover:bg-zinc-800 px-4 py-2 text-xs font-semibold text-zinc-100 shadow transition active:scale-95 disabled:opacity-50"
          >
            {isResolving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Copy className="h-3.5 w-3.5 text-sky-400" />
            )}
            <span>Import as Copy</span>
          </button>
          <button
            type="button"
            disabled={isResolving}
            onClick={onReplace}
            className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-rose-600 hover:from-amber-400 hover:to-rose-500 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-amber-500/20 transition active:scale-95 disabled:opacity-50"
          >
            {isResolving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            <span>Replace</span>
          </button>
        </div>
      </div>
    </div>
  );
};
