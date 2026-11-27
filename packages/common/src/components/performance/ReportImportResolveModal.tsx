import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Copy, Eye, FolderOpen, RefreshCw, X } from 'lucide-react';
import { useBackHandler } from '../../lib/backNavigation';

export type ReportResolveChoice =
  | 'attach'
  | 'session'
  | 'open_existing'
  | 'save_copy'
  | 'replace'
  | 'cancel';

export type ReportResolvePrompt =
  | {
      type: 'name_match';
      kind: 'performance' | 'functional';
      reportTitle: string;
      targetType: 'collection' | 'folder' | 'request';
      collectionName: string;
      displayLabel: string;
      filename?: string;
    }
  | {
      type: 'duplicate_id';
      kind: 'performance' | 'functional';
      reportTitle: string;
      displayLabel: string;
      existingStartedAt?: number;
      incomingStartedAt?: number;
      filename?: string;
    };

interface ReportImportResolveModalProps {
  prompt: ReportResolvePrompt | null;
  onResolve: (choice: ReportResolveChoice) => void;
}

export const ReportImportResolveModal: React.FC<ReportImportResolveModalProps> = ({
  prompt,
  onResolve,
}) => {
  useBackHandler(Boolean(prompt), () => onResolve('cancel'), 45);

  useEffect(() => {
    if (!prompt) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onResolve('cancel');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [prompt, onResolve]);

  if (!prompt || typeof document === 'undefined') return null;

  return createPortal(
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onResolve('cancel');
        }
      }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
      data-modal="true"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-line bg-surface p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-line pb-3.5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-500 dark:text-amber-400">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-tx-primary">
                {prompt.type === 'name_match'
                  ? 'Matching Collection Found by Name'
                  : 'Report Already Exists in History'}
              </h3>
              <p className="mt-0.5 text-xs text-tx-muted">
                {prompt.kind === 'functional' ? 'Functional' : 'Performance'} report:{' '}
                <span className="font-medium text-tx-secondary">{prompt.reportTitle}</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onResolve('cancel')}
            className="rounded-lg p-1 text-tx-muted hover:bg-hover hover:text-tx-primary transition"
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {prompt.type === 'name_match' ? (
          <div className="mt-4 space-y-3 text-xs text-tx-secondary">
            <p className="leading-relaxed">
              The original {prompt.targetType} ID inside{' '}
              {prompt.filename ? <code className="font-mono text-tx-primary">{prompt.filename}</code> : 'this report'}{' '}
              was not found, but your active workspace has a matching target by name:
            </p>
            <div className="rounded-xl border border-line bg-card px-3.5 py-2.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-tx-muted">
                Matched {prompt.targetType}
              </div>
              <div className="mt-0.5 font-semibold text-tx-primary">{prompt.displayLabel}</div>
            </div>
            <p className="text-[11px] text-tx-muted leading-relaxed">
              Choose whether to attach and save this report to the matched {prompt.targetType}&apos;s run history, or open
              it read-only for this session without saving.
            </p>

            <div className="pt-2 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2">
              <button
                type="button"
                onClick={() => onResolve('cancel')}
                className="rounded-xl px-3.5 py-2 text-xs font-medium text-tx-muted hover:bg-hover hover:text-tx-primary transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => onResolve('session')}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3.5 py-2 text-xs font-semibold text-amber-600 dark:text-amber-300 hover:bg-amber-500/20 transition"
              >
                <Eye className="h-3.5 w-3.5" />
                <span>Open Session-Only</span>
              </button>
              <button
                type="button"
                onClick={() => onResolve('attach')}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-sky-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-sky-500 transition shadow-sm"
              >
                <Check className="h-3.5 w-3.5" />
                <span>Attach &amp; Save to History</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-3 text-xs text-tx-secondary">
            <p className="leading-relaxed">
              A saved report with the same ID already exists in this workspace under{' '}
              <span className="font-semibold text-tx-primary">{prompt.displayLabel}</span>.
            </p>
            {(prompt.existingStartedAt || prompt.incomingStartedAt) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-xl border border-line bg-card p-3 text-[11px]">
                <div>
                  <span className="text-tx-muted">Existing run:</span>
                  <div className="mt-0.5 font-medium text-tx-primary">
                    {prompt.existingStartedAt ? new Date(prompt.existingStartedAt).toLocaleString() : 'Saved'}
                  </div>
                </div>
                <div>
                  <span className="text-tx-muted">Incoming file:</span>
                  <div className="mt-0.5 font-medium text-tx-primary">
                    {prompt.incomingStartedAt ? new Date(prompt.incomingStartedAt).toLocaleString() : 'Imported'}
                  </div>
                </div>
              </div>
            )}

            <div className="pt-2 flex flex-col-reverse sm:flex-row sm:flex-wrap sm:items-center sm:justify-end gap-2">
              <button
                type="button"
                onClick={() => onResolve('cancel')}
                className="rounded-xl px-3.5 py-2 text-xs font-medium text-tx-muted hover:bg-hover hover:text-tx-primary transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => onResolve('open_existing')}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-line bg-card px-3.5 py-2 text-xs font-semibold text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
              >
                <FolderOpen className="h-3.5 w-3.5 text-sky-500" />
                <span>Open Existing</span>
              </button>
              <button
                type="button"
                onClick={() => onResolve('save_copy')}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-sky-500/35 bg-sky-500/10 px-3.5 py-2 text-xs font-semibold text-sky-600 dark:text-sky-300 hover:bg-sky-500/20 transition"
              >
                <Copy className="h-3.5 w-3.5" />
                <span>Save as Copy</span>
              </button>
              <button
                type="button"
                onClick={() => onResolve('replace')}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-amber-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-amber-500 transition shadow-sm"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Replace</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
