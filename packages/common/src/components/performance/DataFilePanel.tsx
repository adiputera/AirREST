import React, { useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Database, FileSpreadsheet, Trash2, Upload } from 'lucide-react';
import type { PerformanceDataFileMeta, PerformanceDataFileReadMode, RunnerMode } from '../../types/api';
import { getDataFileLimits, parsePerformanceDataFile } from '../../lib/perfDataFile';

interface DataFilePanelProps {
  runnerMode?: RunnerMode;
  platformId: 'desktop' | 'extension' | 'android' | 'web';
  dataFile?: PerformanceDataFileMeta;
  hasRowsInMemory: boolean;
  onSelectNativeFile?: () => Promise<{ filename: string; content: string } | null>;
  onChangeDataFile: (meta: PerformanceDataFileMeta, rows: Array<Record<string, string>>) => void;
  onChangeReadMode: (readMode: PerformanceDataFileReadMode) => void;
  onClearDataFile: () => void;
}

const READ_MODE_OPTIONS: Array<{ value: PerformanceDataFileReadMode; label: string; desc: string }> = [
  { value: 'sequential', label: 'Sequential', desc: 'Round-robin across VU iterations' },
  { value: 'random', label: 'Random', desc: 'Random row per VU iteration' },
  { value: 'per_vu', label: 'Per-VU Partition', desc: 'Each VU iterates over a unique slice' },
];

export const DataFilePanel: React.FC<DataFilePanelProps> = ({
  runnerMode = 'performance',
  platformId,
  dataFile,
  hasRowsInMemory,
  onSelectNativeFile,
  onChangeDataFile,
  onChangeReadMode,
  onClearDataFile,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewExpanded, setPreviewExpanded] = useState(false);

  const limits = getDataFileLimits(platformId);
  const maxMb = Math.round(limits.maxBytes / (1024 * 1024));

  const processLoadedFile = (filename: string, content: string) => {
    setError(null);
    try {
      const readMode = dataFile?.readMode || 'sequential';
      const parsed = parsePerformanceDataFile(filename, content, platformId, readMode);
      onChangeDataFile(parsed.meta, parsed.rows);
      setPreviewExpanded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleBrowseClick = async () => {
    setError(null);
    if (onSelectNativeFile) {
      try {
        const picked = await onSelectNativeFile();
        if (picked) {
          processLoadedFile(picked.filename, picked.content);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    fileInputRef.current?.click();
  };

  const handleInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const content = await file.text();
      processLoadedFile(file.name, content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="rounded-xl border border-line bg-card p-3.5 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-sky-500" />
          <span className="text-xs font-semibold text-tx-primary">Data File (CSV / JSON)</span>
          <span className="rounded bg-element px-1.5 py-0.5 text-[10px] text-tx-muted">
            Max {limits.maxRows.toLocaleString()} rows / {maxMb} MB
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {dataFile && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                onClearDataFile();
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-element px-2 text-[11px] font-medium text-tx-muted hover:text-rose-500 transition"
              title="Remove dataset"
            >
              <Trash2 className="h-3 w-3" />
              <span>Clear</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleBrowseClick()}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-element px-2.5 text-[11px] font-semibold text-tx-primary hover:bg-hover transition"
          >
            <Upload className="h-3 w-3 text-sky-500" />
            <span>{dataFile ? 'Replace File' : 'Select File'}</span>
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.json,text/csv,application/json"
        className="hidden"
        onChange={(e) => void handleInputChange(e)}
      />

      <p className="text-[11px] text-tx-muted">
        Bind 1 row per VU iteration using <code className="rounded bg-element px-1 font-mono text-[10px]">{'{{column}}'}</code> placeholders or <code className="rounded bg-element px-1 font-mono text-[10px]">pm.iterationData.get(...)</code>.
      </p>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-600 dark:text-rose-300">
          {error}
        </div>
      )}

      {dataFile && (
        <div className="space-y-2.5 rounded-lg border border-line bg-element/40 p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <FileSpreadsheet className="h-4 w-4 shrink-0 text-emerald-500" />
              <span className="truncate font-semibold text-tx-primary">{dataFile.filename}</span>
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-600 dark:text-emerald-300">
                {dataFile.rowCount.toLocaleString()} rows • {dataFile.columns.length} cols
              </span>
            </div>

            <button
              type="button"
              onClick={() => setPreviewExpanded((prev) => !prev)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-500 hover:text-sky-400"
            >
              {previewExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              <span>{previewExpanded ? 'Hide preview' : 'Preview rows'}</span>
            </button>
          </div>

          {!hasRowsInMemory && (
            <div className="rounded border border-amber-500/35 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
              Dataset rows cleared from session memory. Re-select the file before starting a run.
            </div>
          )}

          {/* Read Mode Selector */}
          {runnerMode === 'performance' ? (
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
            {READ_MODE_OPTIONS.map((opt) => {
              const active = dataFile.readMode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChangeReadMode(opt.value)}
                  className={`rounded-md border px-2 py-1.5 text-left transition ${
                    active
                      ? 'border-sky-500 bg-sky-500/10 text-tx-primary'
                      : 'border-line bg-card text-tx-muted hover:bg-hover hover:text-tx-primary'
                  }`}
                >
                  <div className="text-[11px] font-semibold">{opt.label}</div>
                  <div className="text-[10px] opacity-80">{opt.desc}</div>
                </button>
              );
            })}
          </div>
          ) : (
            <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1.5 text-[11px] text-emerald-700 dark:text-emerald-300">
              Sequential iteration binding: Iteration 1..N reads Row 1..N (wraps around if Iterations exceeds {dataFile.rowCount} rows).
            </div>
          )}

          {/* Column chips */}
          <div className="flex flex-wrap gap-1">
            {dataFile.columns.slice(0, 12).map((col) => (
              <span
                key={col}
                className="rounded border border-line bg-card px-1.5 py-0.5 font-mono text-[10px] text-tx-secondary"
              >
                {`{{${col}}}`}
              </span>
            ))}
            {dataFile.columns.length > 12 && (
              <span className="px-1 text-[10px] text-tx-muted">+{dataFile.columns.length - 12} more</span>
            )}
          </div>

          {/* Preview Table */}
          {previewExpanded && dataFile.previewRows.length > 0 && (
            <div className="overflow-x-auto rounded border border-line bg-card">
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <tr className="border-b border-line bg-element/60 text-tx-muted">
                    <th className="px-2 py-1 text-left font-mono">#</th>
                    {dataFile.columns.slice(0, 8).map((col) => (
                      <th key={col} className="px-2 py-1 text-left font-mono font-semibold">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dataFile.previewRows.map((row, idx) => (
                    <tr key={idx} className="border-b border-line/50 last:border-b-0">
                      <td className="px-2 py-1 font-mono text-tx-faint">{idx + 1}</td>
                      {dataFile.columns.slice(0, 8).map((col) => (
                        <td key={col} className="max-w-[140px] truncate px-2 py-1 font-mono text-tx-secondary">
                          {row[col] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
