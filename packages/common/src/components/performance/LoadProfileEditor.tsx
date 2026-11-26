import React, { useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Info, RotateCcw, Settings2 } from 'lucide-react';
import type {
  LoadProfileConfig,
  LoadProfileType,
  PerformanceDurationUnit,
  PerformanceNetworkOptions,
} from '../../types/api';
import {
  clampNormalizedHandles,
  clampPerformanceTimeoutMs,
  computeDefaultPerformanceTimeoutMs,
  createDefaultStaircaseSteps,
  DEFAULT_LOAD_PROFILE_HANDLES,
  describeLoadProfile,
  formatDurationShort,
  getDurationSeconds,
  getLoadProfilePoints,
  getMaxStaircaseSteps,
  getPlatformPerformanceLimits,
  MIN_PERFORMANCE_TIMEOUT_MS,
  MIN_STAIRCASE_STEP_SECONDS,
  normalizeStaircaseSteps,
  resizeStaircaseSteps,
} from '../../lib/loadProfileMath';

interface LoadProfileEditorProps {
  loadProfile: LoadProfileConfig;
  network: PerformanceNetworkOptions;
  platformId: 'extension' | 'desktop' | 'android' | 'web';
  onChangeLoadProfile: (next: LoadProfileConfig) => void;
  onChangeNetwork: (next: PerformanceNetworkOptions) => void;
}

const PROFILE_OPTIONS: Array<{ value: LoadProfileType; label: string }> = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'ramp_up', label: 'Ramp up' },
  { value: 'spike', label: 'Spike' },
  { value: 'peak', label: 'Peak' },
  { value: 'staircase', label: 'Staircase (Stepping)' },
];

const SVG_W = 680;
const SVG_H = 190;
const PAD = { left: 52, right: 20, top: 28, bottom: 26 };
const PLOT_H = SVG_H - PAD.top - PAD.bottom;

type DragTarget =
  | { kind: 'handle'; idx: number }
  | { kind: 'stair_x'; idx: number }
  | { kind: 'stair_y'; idx: number };

export const LoadProfileEditor: React.FC<LoadProfileEditorProps> = ({
  loadProfile,
  network,
  platformId,
  onChangeLoadProfile,
  onChangeNetwork,
}) => {
  const limits = getPlatformPerformanceLimits(platformId);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const durationSec = getDurationSeconds(loadProfile);
  const peakVu = Math.max(1, Math.min(limits.maxVUs, Math.round(loadProfile.virtualUsers || 1)));
  const baseVu = Math.max(0, Math.min(peakVu - 1, Math.round(loadProfile.baseLoad || 0)));
  const isStaircase = loadProfile.profile === 'staircase';
  const maxStaircaseSteps = getMaxStaircaseSteps(durationSec);
  const staircaseSteps = isStaircase
    ? normalizeStaircaseSteps(loadProfile.staircaseSteps, peakVu, baseVu, durationSec)
    : [];
  const svgWidth = isStaircase
    ? Math.max(SVG_W, staircaseSteps.length * 110 + PAD.left + PAD.right)
    : SVG_W;
  const plotW = svgWidth - PAD.left - PAD.right;

  const normalizedHandles = isStaircase
    ? []
    : clampNormalizedHandles(
        loadProfile.profile,
        loadProfile.handles?.[loadProfile.profile],
        durationSec
      );
  const points = getLoadProfilePoints({
    ...loadProfile,
    virtualUsers: peakVu,
    baseLoad: baseVu,
    handles: {
      ...loadProfile.handles,
      [loadProfile.profile]: normalizedHandles,
    },
    staircaseSteps: isStaircase ? staircaseSteps : loadProfile.staircaseSteps,
  });

  const xOf = (norm: number) => PAD.left + norm * plotW;
  const yOf = (vu: number) => {
    const ratio = peakVu > 0 ? Math.min(1, Math.max(0, vu / peakVu)) : 0;
    return PAD.top + PLOT_H - ratio * (PLOT_H - 8);
  };
  const baseY = PAD.top + PLOT_H;

  const polylinePoints = points.map((p) => `${xOf(p.normX).toFixed(1)},${yOf(p.vu).toFixed(1)}`).join(' ');
  const areaPath =
    `M ${xOf(0).toFixed(1)} ${baseY} ` +
    points.map((p) => `L ${xOf(p.normX).toFixed(1)} ${yOf(p.vu).toFixed(1)}`).join(' ') +
    ` L ${xOf(1).toFixed(1)} ${baseY} Z`;

  const clientXToNorm = (clientX: number): number => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const svgX = ((clientX - rect.left) / rect.width) * svgWidth;
    return (svgX - PAD.left) / plotW;
  };

  const clientYToVu = (clientY: number): number => {
    const svg = svgRef.current;
    if (!svg) return peakVu;
    const rect = svg.getBoundingClientRect();
    if (rect.height <= 0) return peakVu;
    const svgY = ((clientY - rect.top) / rect.height) * SVG_H;
    const ratio = Math.max(0, Math.min(1, (PAD.top + PLOT_H - svgY) / (PLOT_H - 8)));
    return Math.max(0, Math.min(peakVu, Math.round(ratio * peakVu)));
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragTarget) return;

    if (dragTarget.kind === 'handle') {
      const arr = [...normalizedHandles];
      if (dragTarget.idx < 0 || dragTarget.idx >= arr.length) return;
      const raw = clientXToNorm(e.clientX);
      const snapSec = durationSec <= 60 ? 1 : 5;
      const stepNorm = Math.max(0.005, snapSec / durationSec);
      const snapped = Math.round(raw / stepNorm) * stepNorm;
      arr[dragTarget.idx] = snapped;
      const clamped = clampNormalizedHandles(loadProfile.profile, arr, durationSec);
      onChangeLoadProfile({
        ...loadProfile,
        handles: {
          ...loadProfile.handles,
          [loadProfile.profile]: clamped,
        },
      });
      return;
    }

    if (dragTarget.kind === 'stair_x') {
      const idx = dragTarget.idx;
      if (idx < 0 || idx >= staircaseSteps.length - 1) return;
      const minGap = Math.min(1, MIN_STAIRCASE_STEP_SECONDS / Math.max(MIN_STAIRCASE_STEP_SECONDS, durationSec));
      const minBound = (idx === 0 ? 0 : staircaseSteps[idx - 1].endNorm) + minGap;
      const maxBound = staircaseSteps[idx + 1].endNorm - minGap;
      const raw = clientXToNorm(e.clientX);
      const snapSec = durationSec <= 60 ? 1 : 5;
      const stepNorm = Math.max(0.005, snapSec / durationSec);
      const snapped = Math.round(raw / stepNorm) * stepNorm;
      const nextEnd = Math.min(maxBound, Math.max(minBound, snapped));
      const nextSteps = staircaseSteps.map((s, i) => (i === idx ? { ...s, endNorm: nextEnd } : s));
      onChangeLoadProfile({
        ...loadProfile,
        staircaseSteps: normalizeStaircaseSteps(nextSteps, peakVu, baseVu, durationSec),
      });
      return;
    }

    if (dragTarget.kind === 'stair_y') {
      const idx = dragTarget.idx;
      if (idx < 0 || idx >= staircaseSteps.length) return;
      const nextVu = clientYToVu(e.clientY);
      const nextSteps = staircaseSteps.map((s, i) => (i === idx ? { ...s, virtualUsers: nextVu } : s));
      onChangeLoadProfile({
        ...loadProfile,
        staircaseSteps: normalizeStaircaseSteps(nextSteps, peakVu, baseVu, durationSec),
      });
    }
  };

  const updateProfileType = (profile: LoadProfileType) => {
    const existing = loadProfile.handles?.[profile];
    const defaults = DEFAULT_LOAD_PROFILE_HANDLES[profile];
    onChangeLoadProfile({
      ...loadProfile,
      profile,
      handles: {
        ...loadProfile.handles,
        [profile]: existing && existing.length === defaults.length ? existing : [...defaults],
      },
      staircaseSteps:
        profile === 'staircase'
          ? normalizeStaircaseSteps(loadProfile.staircaseSteps, peakVu, baseVu, durationSec)
          : loadProfile.staircaseSteps,
    });
  };

  const updateVirtualUsers = (raw: number) => {
    const nextVu = Math.max(1, Math.min(limits.maxVUs, Math.round(raw || 1)));
    const nextBase = Math.max(0, Math.min(nextVu - 1, baseVu));
    onChangeLoadProfile({
      ...loadProfile,
      virtualUsers: nextVu,
      baseLoad: nextBase,
      staircaseSteps: loadProfile.staircaseSteps
        ? normalizeStaircaseSteps(loadProfile.staircaseSteps, nextVu, nextBase, durationSec)
        : undefined,
    });
  };

  const updateDuration = (val: number, unit: PerformanceDurationUnit) => {
    const maxVal = unit === 'minutes' ? 60 : 3600;
    const minVal = unit === 'minutes' ? 1 : 5;
    const nextVal = Math.max(minVal, Math.min(maxVal, Math.round(val || minVal)));
    const nextDurSec = getDurationSeconds({ durationValue: nextVal, durationUnit: unit });
    onChangeLoadProfile({
      ...loadProfile,
      durationValue: nextVal,
      durationUnit: unit,
      staircaseSteps: loadProfile.staircaseSteps
        ? normalizeStaircaseSteps(loadProfile.staircaseSteps, peakVu, baseVu, nextDurSec)
        : undefined,
    });
    const nextTimeoutMs =
      network.requestTimeoutAuto !== false
        ? computeDefaultPerformanceTimeoutMs(nextDurSec)
        : clampPerformanceTimeoutMs(network.requestTimeoutMs, nextDurSec);
    if (nextTimeoutMs !== network.requestTimeoutMs) {
      onChangeNetwork({
        ...network,
        requestTimeoutMs: nextTimeoutMs,
      });
    }
  };

  const updateStaircaseStepCount = (rawCount: number) => {
    const nextSteps = resizeStaircaseSteps(staircaseSteps, rawCount, peakVu, baseVu, durationSec);
    onChangeLoadProfile({
      ...loadProfile,
      staircaseSteps: nextSteps,
    });
  };

  const resetHandles = () => {
    onChangeLoadProfile({
      ...loadProfile,
      handles: {
        ...loadProfile.handles,
        [loadProfile.profile]: [...DEFAULT_LOAD_PROFILE_HANDLES[loadProfile.profile]],
      },
      staircaseSteps: isStaircase
        ? createDefaultStaircaseSteps(peakVu, baseVu, durationSec, staircaseSteps.length || 4)
        : loadProfile.staircaseSteps,
    });
  };

  const showStrongResourceWarning = platformId === 'desktop' && peakVu > limits.strongWarnThreshold;
  const showModerateResourceWarning =
    platformId === 'desktop' && peakVu > limits.warnThreshold && peakVu <= limits.strongWarnThreshold;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-tx-primary">Set up your performance test</h3>
        <p className="mt-0.5 text-xs text-tx-muted">
          Simulate concurrent traffic from your machine and observe real-time latency, throughput, and errors.
        </p>
      </div>

      {/* Platform / Resource Guardrail Banners */}
      {limits.isBoundedJsOnly && (
        <div className="flex items-start gap-2.5 rounded-lg border border-sky-500/25 bg-sky-500/10 px-3 py-2 text-xs text-sky-700 dark:text-sky-300">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <span className="font-semibold">
              {platformId === 'extension'
                ? `Browser Extension Guardrail (Max ${limits.maxVUs} VUs)`
                : platformId === 'android'
                  ? `Android Smoke Mode (Max ${limits.maxVUs} VUs)`
                  : `Web Guardrail (Max ${limits.maxVUs} VUs)`}
              :
            </span>{' '}
            {platformId === 'extension'
              ? `Chromium caps HTTP/1.1 to ${limits.http1ConnectionLimit || 6} concurrent sockets per host. For true high-load testing up to 10,000 VUs, use AirREST Desktop.`
              : 'Mobile/Web runtimes cap virtual users for stability. Use AirREST Desktop for up to 10,000 VUs.'}
          </div>
        </div>
      )}

      {showStrongResourceWarning && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <span className="font-semibold">High Resource Usage ({peakVu.toLocaleString()} VUs):</span>{' '}
            Higher virtual users will consume significant CPU, memory, and OS sockets. Ensure your machine and target host can sustain this concurrency.
          </div>
        </div>
      )}

      {showModerateResourceWarning && (
        <div className="flex items-start gap-2.5 rounded-lg border border-sky-500/25 bg-sky-500/10 px-3 py-2 text-xs text-tx-secondary">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" />
          <div>
            Running <span className="font-mono font-semibold">{peakVu.toLocaleString()} VUs</span> via AirREST Desktop Native Rust Engine. Higher VUs consume more system resources.
          </div>
        </div>
      )}

      {/* Primary Controls Row */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-tx-muted">Load profile</label>
          <select
            value={loadProfile.profile}
            onChange={(e) => updateProfileType(e.target.value as LoadProfileType)}
            className="h-9 w-full rounded-lg border border-line-strong bg-card px-2.5 text-xs font-medium text-tx-primary focus:border-sky-500 focus:outline-none"
          >
            {PROFILE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 flex items-center justify-between text-xs font-medium text-tx-muted">
            <span>Virtual users</span>
            <span className="font-mono text-[10px] text-tx-faint">max {limits.maxVUs.toLocaleString()}</span>
          </label>
          <input
            type="number"
            min={1}
            max={limits.maxVUs}
            value={peakVu}
            onChange={(e) => updateVirtualUsers(Number(e.target.value))}
            className="h-9 w-full rounded-lg border border-line-strong bg-card px-2.5 font-mono text-xs text-tx-primary focus:border-sky-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-tx-muted">Test duration</label>
          <div className="flex h-9 overflow-hidden rounded-lg border border-line-strong bg-card focus-within:border-sky-500">
            <input
              type="number"
              min={loadProfile.durationUnit === 'minutes' ? 1 : 5}
              max={loadProfile.durationUnit === 'minutes' ? 60 : 3600}
              value={loadProfile.durationValue}
              onChange={(e) => updateDuration(Number(e.target.value), loadProfile.durationUnit)}
              className="min-w-0 flex-1 bg-transparent px-2.5 font-mono text-xs text-tx-primary focus:outline-none"
            />
            <select
              value={loadProfile.durationUnit}
              onChange={(e) => {
                const nextUnit = e.target.value as PerformanceDurationUnit;
                const converted =
                  nextUnit === 'minutes'
                    ? Math.max(1, Math.round(durationSec / 60))
                    : Math.min(3600, Math.max(5, durationSec));
                updateDuration(converted, nextUnit);
              }}
              className="border-l border-line bg-element px-2 text-xs text-tx-secondary focus:outline-none"
            >
              <option value="seconds">secs</option>
              <option value="minutes">mins</option>
            </select>
          </div>
        </div>
      </div>

      {/* Interactive Draggable Traffic Graph Card */}
      <div className="rounded-xl border border-line bg-card p-3.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs text-tx-muted">
            <span className="inline-block h-2 w-2 rounded-full bg-sky-500" />
            <span>
              {isStaircase
                ? 'Drag plateaus vertically for VUs & dashed dividers horizontally for timing (min 5s/step)'
                : normalizedHandles.length > 0
                  ? 'Drag the blue phase markers to adjust traffic transitions'
                  : 'Constant load across the full test duration'}
            </span>
          </div>
          {(normalizedHandles.length > 0 || isStaircase) && (
            <button
              type="button"
              onClick={resetHandles}
              className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-tx-muted hover:bg-hover hover:text-tx-primary transition"
              title="Reset phase handles to default"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Reset curve</span>
            </button>
          )}
        </div>

        <div className={isStaircase ? 'overflow-x-auto pb-1' : ''}>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${svgWidth} ${SVG_H}`}
            style={isStaircase && svgWidth > SVG_W ? { width: `${svgWidth}px`, minWidth: '100%' } : undefined}
            className={`h-[190px] select-none overflow-visible ${isStaircase && svgWidth > SVG_W ? '' : 'w-full'}`}
            onPointerMove={handlePointerMove}
            onPointerUp={() => setDragTarget(null)}
            onPointerCancel={() => setDragTarget(null)}
          >
            <defs>
              <linearGradient id="airrestPerfCurveFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.32" />
                <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.04" />
              </linearGradient>
            </defs>

            {/* Axes */}
            <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={baseY} stroke="currentColor" className="text-line-strong" strokeWidth="1" />
            <line x1={PAD.left} y1={baseY} x2={svgWidth - PAD.right} y2={baseY} stroke="currentColor" className="text-line-strong" strokeWidth="1" />
            <line
              x1={PAD.left}
              y1={yOf(peakVu)}
              x2={svgWidth - PAD.right}
              y2={yOf(peakVu)}
              stroke="currentColor"
              className="text-line"
              strokeWidth="1"
              strokeDasharray="3 4"
            />

            {/* Y-axis labels */}
            <text
              x={PAD.left - 8}
              y={yOf(peakVu) + 4}
              textAnchor="end"
              fontSize="11"
              fill="currentColor"
              className="fill-tx-muted font-mono"
            >
              {peakVu} VUs
            </text>
            {loadProfile.profile !== 'fixed' && baseVu > 0 && (
              <text
                x={PAD.left - 8}
                y={yOf(baseVu) + 3}
                textAnchor="end"
                fontSize="10"
                fill="currentColor"
                className="fill-tx-faint font-mono"
              >
                {baseVu}
              </text>
            )}

            {/* X-axis start/end labels */}
            <text x={PAD.left} y={baseY + 16} textAnchor="start" fontSize="11" className="fill-tx-muted font-mono">
              0
            </text>
            <text x={svgWidth - PAD.right} y={baseY + 16} textAnchor="end" fontSize="11" className="fill-tx-muted font-mono">
              {formatDurationShort(durationSec)}
            </text>

            {/* Fill & Curve */}
            <path d={areaPath} fill="url(#airrestPerfCurveFill)" />
            <polyline
              points={polylinePoints}
              fill="none"
              stroke="#0ea5e9"
              strokeWidth="2.2"
              strokeLinejoin="round"
            />

            {/* 2D Staircase Draggable Plateaus (Vertical VUs) + Boundary Dividers (Horizontal Duration) */}
            {isStaircase &&
              staircaseSteps.map((step, idx) => {
                const startNorm = idx === 0 ? 0 : staircaseSteps[idx - 1].endNorm;
                const x1 = xOf(startNorm);
                const x2 = xOf(step.endNorm);
                const midX = (x1 + x2) / 2;
                const stepY = yOf(step.virtualUsers);
                const isDraggingY = dragTarget?.kind === 'stair_y' && dragTarget.idx === idx;
                const pillY = Math.max(PAD.top + 8, stepY - 12);
                const pillWidth = Math.min(Math.max(40, x2 - x1 - 8), 70);

                return (
                  <g
                    key={`stair-y-${idx}`}
                    style={{ cursor: 'ns-resize', touchAction: 'none' }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      setDragTarget({ kind: 'stair_y', idx });
                      svgRef.current?.setPointerCapture?.(e.pointerId);
                    }}
                  >
                    <rect
                      x={x1 + 3}
                      y={PAD.top - 4}
                      width={Math.max(8, x2 - x1 - 6)}
                      height={PLOT_H + 10}
                      fill="transparent"
                    />
                    <line
                      x1={x1}
                      y1={stepY}
                      x2={x2}
                      y2={stepY}
                      stroke={isDraggingY ? '#38bdf8' : '#0ea5e9'}
                      strokeWidth={isDraggingY ? '3.5' : '2.6'}
                      strokeLinecap="round"
                    />
                    {x2 - x1 >= 34 && (
                      <g transform={`translate(${midX}, ${pillY})`}>
                        <rect
                          x={-pillWidth / 2}
                          y={-9}
                          width={pillWidth}
                          height={16}
                          rx={4}
                          fill={isDraggingY ? '#0284c7' : '#0f172a'}
                          stroke={isDraggingY ? '#38bdf8' : '#334155'}
                          strokeWidth="1"
                          opacity="0.92"
                        />
                        <text
                          x="0"
                          y="2"
                          textAnchor="middle"
                          fontSize="9.5"
                          fill="#f8fafc"
                          className="font-mono font-semibold"
                        >
                          {step.virtualUsers} VU
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}

            {isStaircase &&
              staircaseSteps.slice(0, -1).map((step, idx) => {
                const hx = xOf(step.endNorm);
                const timeLabel = formatDurationShort(step.endNorm * durationSec);
                const isDraggingX = dragTarget?.kind === 'stair_x' && dragTarget.idx === idx;
                return (
                  <g
                    key={`stair-x-${idx}`}
                    style={{ cursor: 'ew-resize', touchAction: 'none' }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      setDragTarget({ kind: 'stair_x', idx });
                      svgRef.current?.setPointerCapture?.(e.pointerId);
                    }}
                  >
                    <line
                      x1={hx}
                      y1={PAD.top - 4}
                      x2={hx}
                      y2={baseY}
                      stroke={isDraggingX ? '#38bdf8' : 'currentColor'}
                      className={isDraggingX ? '' : 'text-tx-muted'}
                      strokeWidth={isDraggingX ? '1.6' : '1.1'}
                      strokeDasharray="3 3"
                      opacity="0.85"
                    />
                    <rect x={hx - 9} y={0} width={18} height={PLOT_H + 28} fill="transparent" />
                    <g transform={`translate(${hx}, ${PAD.top - 11})`}>
                      <path
                        d="M -8 -8 H 8 V 3 L 0 10 L -8 3 Z"
                        fill={isDraggingX ? '#38bdf8' : '#0284c7'}
                      />
                      <line x1="-3.5" y1="-3.5" x2="3.5" y2="-3.5" stroke="#ffffff" strokeWidth="1.2" />
                      <line x1="-3.5" y1="-0.5" x2="3.5" y2="-0.5" stroke="#ffffff" strokeWidth="1.2" />
                    </g>
                    <text
                      x={hx}
                      y={baseY + 15}
                      textAnchor="middle"
                      fontSize="10"
                      className="fill-tx-secondary font-mono"
                    >
                      {timeLabel}
                    </text>
                  </g>
                );
              })}

            {/* Draggable Phase Handles (for ramp_up / spike / peak) */}
            {!isStaircase &&
              normalizedHandles.map((norm, idx) => {
                const hx = xOf(norm);
                const timeLabel = formatDurationShort(norm * durationSec);
                const isDragging = dragTarget?.kind === 'handle' && dragTarget.idx === idx;
                return (
                  <g
                    key={idx}
                    style={{ cursor: 'ew-resize', touchAction: 'none' }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      setDragTarget({ kind: 'handle', idx });
                      svgRef.current?.setPointerCapture?.(e.pointerId);
                    }}
                  >
                    <line
                      x1={hx}
                      y1={PAD.top - 4}
                      x2={hx}
                      y2={baseY}
                      stroke={isDragging ? '#38bdf8' : 'currentColor'}
                      className={isDragging ? '' : 'text-tx-muted'}
                      strokeWidth={isDragging ? '1.5' : '1.1'}
                      strokeDasharray="3 3"
                      opacity="0.8"
                    />
                    <rect x={hx - 14} y={0} width={28} height={PLOT_H + 28} fill="transparent" />
                    <g transform={`translate(${hx}, ${PAD.top - 11})`}>
                      <path
                        d="M -9 -9 H 9 V 4 L 0 11 L -9 4 Z"
                        fill={isDragging ? '#38bdf8' : '#0284c7'}
                      />
                      <line x1="-4" y1="-4" x2="4" y2="-4" stroke="#ffffff" strokeWidth="1.3" />
                      <line x1="-4" y1="-1" x2="4" y2="-1" stroke="#ffffff" strokeWidth="1.3" />
                      <line x1="-4" y1="2" x2="4" y2="2" stroke="#ffffff" strokeWidth="1.3" />
                    </g>
                    <text
                      x={hx}
                      y={baseY + 15}
                      textAnchor="middle"
                      fontSize="10.5"
                      className="fill-tx-secondary font-mono"
                    >
                      {timeLabel}
                    </text>
                  </g>
                );
              })}
          </svg>
        </div>

        <p className="mt-2 border-t border-line pt-2.5 text-xs leading-relaxed text-tx-muted">
          {describeLoadProfile({ ...loadProfile, virtualUsers: peakVu, baseLoad: baseVu })}
        </p>

        {/* Base Load, Staircase Steps & Think Time Row */}
        <div className="mt-3 flex flex-wrap items-end gap-4 border-t border-line pt-3">
          {isStaircase && (
            <div className="w-48">
              <label className="mb-1 flex items-center justify-between text-xs font-medium text-tx-muted">
                <span>Steps</span>
                <span className="font-mono text-[10px] text-tx-faint">
                  min {MIN_STAIRCASE_STEP_SECONDS}s/step • max {maxStaircaseSteps}
                </span>
              </label>
              <input
                type="number"
                min={1}
                max={maxStaircaseSteps}
                value={staircaseSteps.length}
                onChange={(e) => updateStaircaseStepCount(Number(e.target.value))}
                className="h-8 w-full rounded-lg border border-line-strong bg-element px-2.5 font-mono text-xs text-tx-primary focus:border-sky-500 focus:outline-none"
              />
            </div>
          )}

          {loadProfile.profile !== 'fixed' && (
            <div className="w-36">
              <label className="mb-1 block text-xs font-medium text-tx-muted">Base load (VUs)</label>
              <input
                type="number"
                min={0}
                max={Math.max(0, peakVu - 1)}
                value={baseVu}
                onChange={(e) =>
                  onChangeLoadProfile({
                    ...loadProfile,
                    baseLoad: Math.max(0, Math.min(peakVu - 1, Math.round(Number(e.target.value) || 0))),
                  })
                }
                className="h-8 w-full rounded-lg border border-line-strong bg-element px-2.5 font-mono text-xs text-tx-primary focus:border-sky-500 focus:outline-none"
              />
            </div>
          )}

          <div className="w-44">
            <label className="mb-1 block text-xs font-medium text-tx-muted">Think time / delay (ms)</label>
            <input
              type="number"
              min={0}
              max={60000}
              step={50}
              value={loadProfile.thinkTimeMs}
              onChange={(e) =>
                onChangeLoadProfile({
                  ...loadProfile,
                  thinkTimeMs: Math.max(0, Math.min(60000, Math.round(Number(e.target.value) || 0))),
                })
              }
              className="h-8 w-full rounded-lg border border-line-strong bg-element px-2.5 font-mono text-xs text-tx-primary focus:border-sky-500 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Advanced Network Settings Accordion */}
      <div className="rounded-xl border border-line bg-card">
        <button
          type="button"
          onClick={() => setAdvancedOpen((prev) => !prev)}
          className="flex w-full items-center justify-between px-3.5 py-2.5 text-xs font-semibold text-tx-secondary hover:bg-hover transition rounded-xl"
        >
          <span className="flex items-center gap-2">
            <Settings2 className="h-3.5 w-3.5 text-tx-muted" />
            <span>Advanced Network Settings</span>
          </span>
          {advancedOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-tx-muted" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-tx-muted" />
          )}
        </button>

        {advancedOpen && (() => {
          const maxTimeoutForDuration = Math.max(
            MIN_PERFORMANCE_TIMEOUT_MS,
            Math.min(300_000, durationSec * 1000)
          );
          const autoTimeoutMs = computeDefaultPerformanceTimeoutMs(durationSec);
          const displayTimeoutMs = clampPerformanceTimeoutMs(network.requestTimeoutMs, durationSec);
          return (
          <div className="space-y-3 border-t border-line px-3.5 py-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-medium text-tx-primary">Request timeout (ms)</div>
                <div className="text-[11px] text-tx-muted">
                  Auto default: {autoTimeoutMs.toLocaleString()} ms (min 1 min &amp; test duration; max{' '}
                  {maxTimeoutForDuration.toLocaleString()} ms).
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {network.requestTimeoutAuto === false && (
                  <button
                    type="button"
                    onClick={() =>
                      onChangeNetwork({
                        ...network,
                        requestTimeoutAuto: true,
                        requestTimeoutMs: autoTimeoutMs,
                      })
                    }
                    className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[10px] font-semibold text-sky-600 dark:text-sky-300 hover:bg-sky-500/20"
                    title="Reset timeout to follow min(60s, test duration)"
                  >
                    Auto
                  </button>
                )}
                <input
                  type="number"
                  min={MIN_PERFORMANCE_TIMEOUT_MS}
                  max={maxTimeoutForDuration}
                  step={500}
                  value={displayTimeoutMs}
                  onChange={(e) =>
                    onChangeNetwork({
                      ...network,
                      requestTimeoutAuto: false,
                      requestTimeoutMs: clampPerformanceTimeoutMs(Number(e.target.value), durationSec),
                    })
                  }
                  className="h-8 w-28 rounded-lg border border-line-strong bg-element px-2.5 font-mono text-xs text-tx-primary focus:border-sky-500 focus:outline-none"
                />
              </div>
            </div>

            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <div>
                <div className="font-medium text-tx-primary">Follow HTTP redirects</div>
                <div className="text-[11px] text-tx-muted">Automatically follow 3xx redirect responses.</div>
              </div>
              <input
                type="checkbox"
                checked={network.followRedirects}
                onChange={(e) => onChangeNetwork({ ...network, followRedirects: e.target.checked })}
                className="h-4 w-4 accent-sky-500"
              />
            </label>

            <label
              className={`flex items-center justify-between gap-3 ${
                limits.supportsIgnoreSslErrors ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'
              }`}
            >
              <div>
                <div className="font-medium text-tx-primary">Ignore SSL certificate errors</div>
                <div className="text-[11px] text-tx-muted">
                  {limits.supportsIgnoreSslErrors
                    ? 'Allow self-signed / staging certificates during local load tests.'
                    : 'Only supported on AirREST Desktop & Android.'}
                </div>
              </div>
              <input
                type="checkbox"
                disabled={!limits.supportsIgnoreSslErrors}
                checked={limits.supportsIgnoreSslErrors && network.ignoreSslErrors}
                onChange={(e) => onChangeNetwork({ ...network, ignoreSslErrors: e.target.checked })}
                className="h-4 w-4 accent-sky-500"
              />
            </label>
          </div>
          );
        })()}
      </div>
    </div>
  );
};
