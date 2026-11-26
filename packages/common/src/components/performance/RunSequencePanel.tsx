import React, { useState } from 'react';
import { ArrowDown, ArrowUp, CheckSquare, FileCode2, GripVertical, KeyRound, Plus, RefreshCw, RotateCcw, Square, Trash2 } from 'lucide-react';
import type {
  Collection,
  PerformanceDurationUnit,
  PerformanceExecutionMode,
  PerformanceRequestDescriptor,
  PerformanceSetupRefreshConfig,
  RunnerMode,
} from '../../types/api';
import { reorderRunnerItems } from '../../lib/perfLaunch';
import { flattenCollectionRequests } from '../../lib/requestDiff';
import { MethodBadge } from '../MethodBadge';

interface RunSequencePanelProps {
  runnerMode?: RunnerMode;
  items: PerformanceRequestDescriptor[];
  initialItems: PerformanceRequestDescriptor[];
  executionMode: PerformanceExecutionMode;
  setupItemIds: string[];
  setupRefresh?: PerformanceSetupRefreshConfig;
  runInLoopScripts: boolean;
  platformId: 'extension' | 'desktop' | 'android' | 'web';
  sourceCollection?: Collection | null;
  onChangeItems: (next: PerformanceRequestDescriptor[]) => void;
  onChangeExecutionMode: (mode: PerformanceExecutionMode) => void;
  onChangeSetupItemIds: (ids: string[]) => void;
  onChangeSetupRefresh: (next: PerformanceSetupRefreshConfig) => void;
  onChangeRunInLoopScripts: (enabled: boolean) => void;
}

export const RunSequencePanel: React.FC<RunSequencePanelProps> = ({
  runnerMode = 'performance',
  items,
  initialItems,
  executionMode,
  setupItemIds,
  setupRefresh,
  runInLoopScripts,
  platformId,
  sourceCollection,
  onChangeItems,
  onChangeExecutionMode,
  onChangeSetupItemIds,
  onChangeSetupRefresh,
  onChangeRunInLoopScripts,
}) => {
  const [extraSetupPickerId, setExtraSetupPickerId] = useState('');
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(null);
  const isFunctional = runnerMode === 'functional';
  const setupSet = new Set(setupItemIds);

  const setupItems = !isFunctional && executionMode === 'pre_run_setup' ? items.filter((it) => setupSet.has(it.id)) : [];
  const loopItems = !isFunctional && executionMode === 'pre_run_setup' ? items.filter((it) => !setupSet.has(it.id)) : items;
  const selectedLoopCount = loopItems.filter((it) => it.selected).length;

  const hasLoopScripts = loopItems.some(
    (it) => it.selected && Boolean(it.request.preRequestScript?.trim() || it.request.postResponseScript?.trim())
  );

  const availableCollectionAdditions = sourceCollection
    ? flattenCollectionRequests(sourceCollection.items || []).filter(
        (req) => !items.some((existing) => existing.id === req.id || existing.itemId === req.id)
      )
    : [];

  const toggleSelect = (id: string) => {
    onChangeItems(items.map((it) => (it.id === id ? { ...it, selected: !it.selected } : it)));
  };

  const toggleAll = (selected: boolean) => {
    onChangeItems(
      items.map((it) => (executionMode === 'pre_run_setup' && setupSet.has(it.id) ? it : { ...it, selected }))
    );
  };

  const moveItem = (id: string, direction: -1 | 1) => {
    const idx = items.findIndex((it) => it.id === id);
    const targetIdx = idx + direction;
    if (idx < 0 || targetIdx < 0 || targetIdx >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(idx, 1);
    next.splice(targetIdx, 0, moved);
    onChangeItems(next);
  };

  const toggleSetupRole = (id: string) => {
    if (setupSet.has(id)) {
      onChangeSetupItemIds(setupItemIds.filter((x) => x !== id));
    } else {
      onChangeSetupItemIds([...setupItemIds, id]);
    }
  };

  const handleAddCollectionSetupRequest = (colReqId: string) => {
    if (!colReqId) return;
    const found = availableCollectionAdditions.find((r) => r.id === colReqId);
    if (!found) return;
    const newItem: PerformanceRequestDescriptor = {
      id: found.id,
      itemId: found.id,
      name: found.name,
      method: found.request.method,
      path: found.path,
      request: found.request,
      selected: false,
    };
    onChangeItems([newItem, ...items]);
    onChangeSetupItemIds([...setupItemIds, newItem.id]);
    setExtraSetupPickerId('');
  };

  return (
    <div className="flex h-full flex-col">
      {/* Execution Mode Toggle (Performance mode only) */}
      {!isFunctional && (
      <div className="border-b border-line pb-3">
        <div className="mb-1.5 text-xs font-semibold text-tx-primary">Execution &amp; Auth Mode</div>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => onChangeExecutionMode('sequential')}
            className={`rounded-lg border px-2.5 py-2 text-left transition ${
              executionMode === 'sequential'
                ? 'border-sky-500 bg-sky-500/10 text-tx-primary'
                : 'border-line bg-card text-tx-muted hover:bg-hover hover:text-tx-primary'
            }`}
          >
            <div className="text-xs font-semibold">Sequential (Per VU)</div>
            <div className="mt-0.5 text-[11px] opacity-80">
              Every VU runs all checked requests in order on each loop.
            </div>
          </button>

          <button
            type="button"
            onClick={() => onChangeExecutionMode('pre_run_setup')}
            className={`rounded-lg border px-2.5 py-2 text-left transition ${
              executionMode === 'pre_run_setup'
                ? 'border-amber-500 bg-amber-500/10 text-tx-primary'
                : 'border-line bg-card text-tx-muted hover:bg-hover hover:text-tx-primary'
            }`}
          >
            <div className="flex items-center gap-1.5 text-xs font-semibold">
              <KeyRound className="h-3.5 w-3.5 text-amber-500" />
              <span>Pre-run Setup (1x)</span>
            </div>
            <div className="mt-0.5 text-[11px] opacity-80">
              Run selected setup/token request(s) once before load starts.
            </div>
          </button>
        </div>
      </div>
      )}

      {/* Pre-run Setup Section */}
      {!isFunctional && executionMode === 'pre_run_setup' && (
        <div className="border-b border-line py-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-amber-600 dark:text-amber-400">
              Pre-run Setup Requests ({setupItems.length})
            </div>
            <span className="text-[10px] text-tx-muted">Excluded from load metrics • Fail-fast</span>
          </div>

          {setupItems.length === 0 ? (
            <div className="rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              Mark one or more requests below as <span className="font-semibold">Setup 1x</span> (e.g. POST get token), or add one from your collection.
            </div>
          ) : (
            <div className="space-y-1">
              {setupItems.map((item, idx) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs"
                >
                  <span className="font-mono text-[10px] text-amber-600 dark:text-amber-400">{idx + 1}.</span>
                  <MethodBadge method={item.method} size="sm" />
                  <span className="min-w-0 flex-1 truncate font-medium text-tx-primary" title={item.path}>
                    {item.name}
                  </span>
                  <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-amber-700 dark:text-amber-300">
                    SETUP 1x
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleSetupRole(item.id)}
                    className="rounded p-1 text-tx-muted hover:bg-hover hover:text-rose-500 transition"
                    title="Remove from Pre-run Setup"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {availableCollectionAdditions.length > 0 && (
            <div className="mt-2 flex items-center gap-1.5">
              <select
                value={extraSetupPickerId}
                onChange={(e) => setExtraSetupPickerId(e.target.value)}
                className="h-7 min-w-0 flex-1 rounded-md border border-line bg-element px-2 text-xs text-tx-secondary focus:border-sky-500 focus:outline-none"
              >
                <option value="">+ Pull setup/token request from collection...</option>
                {availableCollectionAdditions.map((req) => (
                  <option key={req.id} value={req.id}>
                    [{req.method}] {req.path}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!extraSetupPickerId}
                onClick={() => handleAddCollectionSetupRequest(extraSetupPickerId)}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-card px-2 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary disabled:opacity-40"
              >
                <Plus className="h-3 w-3" />
                <span>Add</span>
              </button>
            </div>
          )}

          {/* Periodic & Reactive 401 Setup Refresh */}
          {(() => {
            const refreshCfg: PerformanceSetupRefreshConfig = setupRefresh || {
              enabled: false,
              intervalValue: 5,
              intervalUnit: 'minutes',
              refreshOn401: false,
              cooldownSec: 15,
            };
            return (
              <div className="mt-2.5 space-y-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-[11px]">
                <div className="flex items-center gap-1.5 font-semibold text-amber-700 dark:text-amber-300">
                  <RefreshCw className="h-3 w-3" />
                  <span>Live Token / Setup Refresh</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-tx-secondary">
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={refreshCfg.enabled}
                      onChange={(e) => onChangeSetupRefresh({ ...refreshCfg, enabled: e.target.checked })}
                      className="h-3.5 w-3.5 accent-amber-500"
                    />
                    <span>Every</span>
                  </label>
                  <input
                    type="number"
                    min={refreshCfg.intervalUnit === 'seconds' ? 10 : 1}
                    max={1440}
                    disabled={!refreshCfg.enabled}
                    value={refreshCfg.intervalValue}
                    onChange={(e) => {
                      const minVal = refreshCfg.intervalUnit === 'seconds' ? 10 : 1;
                      onChangeSetupRefresh({
                        ...refreshCfg,
                        intervalValue: Math.max(minVal, Math.round(Number(e.target.value) || minVal)),
                      });
                    }}
                    className="h-6 w-14 rounded border border-line bg-card px-1.5 font-mono text-[11px] text-tx-primary disabled:opacity-50"
                  />
                  <select
                    disabled={!refreshCfg.enabled}
                    value={refreshCfg.intervalUnit}
                    onChange={(e) => {
                      const nextUnit = e.target.value as PerformanceDurationUnit;
                      const nextVal =
                        nextUnit === 'seconds'
                          ? Math.max(10, refreshCfg.intervalValue * 60)
                          : Math.max(1, Math.round(refreshCfg.intervalValue / 60));
                      onChangeSetupRefresh({
                        ...refreshCfg,
                        intervalUnit: nextUnit,
                        intervalValue: nextVal,
                      });
                    }}
                    className="h-6 rounded border border-line bg-card px-1.5 text-[11px] text-tx-primary disabled:opacity-50"
                  >
                    <option value="minutes">mins</option>
                    <option value="seconds">secs</option>
                  </select>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-tx-secondary">
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={refreshCfg.refreshOn401}
                      onChange={(e) => onChangeSetupRefresh({ ...refreshCfg, refreshOn401: e.target.checked })}
                      className="h-3.5 w-3.5 accent-amber-500"
                    />
                    <span>Also refresh on HTTP 401</span>
                  </label>
                  {refreshCfg.refreshOn401 && (
                    <label className="inline-flex items-center gap-1 text-[10px] text-tx-muted">
                      <span>Cooldown</span>
                      <input
                        type="number"
                        min={15}
                        max={300}
                        value={refreshCfg.cooldownSec}
                        onChange={(e) =>
                          onChangeSetupRefresh({
                            ...refreshCfg,
                            cooldownSec: Math.max(15, Math.min(300, Math.round(Number(e.target.value) || 15))),
                          })
                        }
                        className="h-5 w-12 rounded border border-line bg-card px-1 font-mono text-[10px] text-tx-primary"
                      />
                      <span>s</span>
                    </label>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Run Sequence Header */}
      <div className={`flex items-center justify-between gap-2 pb-2 ${isFunctional ? '' : 'pt-3'}`}>
        <div className="text-xs font-semibold text-tx-primary">
          Run Sequence ({selectedLoopCount}/{loopItems.length})
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <button
            type="button"
            onClick={() => toggleAll(false)}
            className="text-tx-muted hover:text-tx-primary transition"
          >
            Deselect All
          </button>
          <span className="text-line-strong">•</span>
          <button
            type="button"
            onClick={() => toggleAll(true)}
            className="text-tx-muted hover:text-tx-primary transition"
          >
            Select All
          </button>
          <span className="text-line-strong">•</span>
          <button
            type="button"
            onClick={() => {
              onChangeItems(initialItems.map((it) => ({ ...it })));
              onChangeSetupItemIds([]);
            }}
            className="inline-flex items-center gap-1 text-tx-muted hover:text-tx-primary transition"
          >
            <RotateCcw className="h-3 w-3" />
            <span>Reset</span>
          </button>
        </div>
      </div>

      {/* Loop Requests List */}
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {loopItems.map((item, idx) => {
          const hasScripts = Boolean(
            item.request.preRequestScript?.trim() || item.request.postResponseScript?.trim()
          );
          const isBeingDragged = draggedId === item.id;
          const dropPos = dropTarget?.id === item.id ? dropTarget.position : null;
          return (
            <div
              key={item.id}
              draggable
              onDragStart={(e) => {
                setDraggedId(item.id);
                e.dataTransfer.effectAllowed = 'move';
                try {
                  e.dataTransfer.setData('application/x-airrest-runner-item', item.id);
                } catch {
                  // WebView fallback relies on local state
                }
              }}
              onDragEnd={() => {
                setDraggedId(null);
                setDropTarget(null);
              }}
              onDragOver={(e) => {
                if (!draggedId || draggedId === item.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const rect = e.currentTarget.getBoundingClientRect();
                const position: 'before' | 'after' =
                  e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                if (dropTarget?.id !== item.id || dropTarget.position !== position) {
                  setDropTarget({ id: item.id, position });
                }
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null) && dropTarget?.id === item.id) {
                  setDropTarget(null);
                }
              }}
              onDrop={(e) => {
                if (!draggedId || draggedId === item.id) return;
                e.preventDefault();
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const position: 'before' | 'after' =
                  dropTarget?.id === item.id
                    ? dropTarget.position
                    : e.clientY < rect.top + rect.height / 2
                      ? 'before'
                      : 'after';
                const reordered = reorderRunnerItems(items, draggedId, item.id, position);
                if (reordered !== items) {
                  onChangeItems(reordered);
                }
                setDraggedId(null);
                setDropTarget(null);
              }}
              className={`group relative flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition select-none ${
                isBeingDragged
                  ? 'border-sky-500/50 bg-element opacity-40 cursor-grabbing'
                  : item.selected
                    ? 'border-line bg-card text-tx-primary cursor-grab active:cursor-grabbing'
                    : 'border-transparent bg-element/40 text-tx-muted opacity-75 cursor-grab active:cursor-grabbing'
              }`}
              title="Drag to reorder execution sequence"
            >
              {dropPos === 'before' && (
                <div className="pointer-events-none absolute top-0 left-0 right-0 z-20 flex items-center h-0.5 bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.9)]">
                  <div className="-ml-0.5 h-1.5 w-1.5 rounded-full bg-sky-400" />
                </div>
              )}
              {dropPos === 'after' && (
                <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-20 flex items-center h-0.5 bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.9)]">
                  <div className="-ml-0.5 h-1.5 w-1.5 rounded-full bg-sky-400" />
                </div>
              )}
              <GripVertical className="h-3.5 w-3.5 shrink-0 text-tx-faint opacity-60 group-hover:opacity-100" />
              <span className="w-4 shrink-0 font-mono text-[10px] text-tx-faint">{idx + 1}</span>
              <button
                type="button"
                onClick={() => toggleSelect(item.id)}
                className="shrink-0 text-sky-500 hover:text-sky-400"
                title={item.selected ? 'Exclude from run' : 'Include in run'}
              >
                {item.selected ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5 text-tx-faint" />}
              </button>
              <MethodBadge method={item.method} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium" title={item.path}>
                  {item.name}
                </div>
                {item.path && item.path !== item.name && (
                  <div className="truncate text-[10px] text-tx-faint">{item.path}</div>
                )}
              </div>
              {hasScripts && (
                <span
                  className="inline-flex items-center gap-0.5 rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-300"
                  title="Contains Pre-request / Post-response script"
                >
                  <FileCode2 className="h-2.5 w-2.5" />
                  <span>JS</span>
                </span>
              )}
              {!isFunctional && executionMode === 'pre_run_setup' && (
                <button
                  type="button"
                  onClick={() => toggleSetupRole(item.id)}
                  className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-300 hover:bg-amber-500/20 transition"
                  title="Mark this request as Pre-run Setup (1x)"
                >
                  Set Setup 1x
                </button>
              )}
              <div className="flex shrink-0 items-center gap-0.5 opacity-60 group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => moveItem(item.id, -1)}
                  className="rounded p-0.5 text-tx-muted hover:bg-hover hover:text-tx-primary"
                  title="Move up"
                >
                  <ArrowUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => moveItem(item.id, 1)}
                  className="rounded p-0.5 text-tx-muted hover:bg-hover hover:text-tx-primary"
                  title="Move down"
                >
                  <ArrowDown className="h-3 w-3" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* In-Loop Scripts Toggle (Performance mode only; Functional always runs scripts) */}
      {!isFunctional && hasLoopScripts && (
        <div className="mt-3 rounded-lg border border-violet-500/25 bg-violet-500/5 p-2.5 text-xs">
          <label className="flex items-start justify-between gap-2 cursor-pointer">
            <div>
              <div className="font-semibold text-tx-primary">Run in-loop Pre/Post scripts</div>
              <div className="mt-0.5 text-[11px] text-tx-muted">
                {runInLoopScripts
                  ? platformId === 'desktop'
                    ? 'Active: Desktop uses Reusable JS Worker Pool (slower than Pure Rust fast-path).'
                    : 'Active: Scripts run per iteration inside the bounded JS sandbox.'
                  : 'Disabled: Pure HTTP fast-path (highest throughput, skips in-loop JS scripts).'}
              </div>
            </div>
            <input
              type="checkbox"
              checked={runInLoopScripts}
              onChange={(e) => onChangeRunInLoopScripts(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-violet-500"
            />
          </label>
        </div>
      )}
    </div>
  );
};
