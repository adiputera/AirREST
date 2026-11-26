import type { LoadProfileConfig, LoadProfileType, StaircaseStep } from '../types/api';

export const MIN_STAIRCASE_STEP_SECONDS = 5;
export const MAX_STAIRCASE_STEPS = 12;

export interface PlatformPerformanceLimits {
  maxVUs: number;
  warnThreshold: number;
  strongWarnThreshold: number;
  http1ConnectionLimit?: number;
  supportsIgnoreSslErrors: boolean;
  isBoundedJsOnly: boolean;
}

export function getPlatformPerformanceLimits(
  platformId: 'extension' | 'desktop' | 'android' | 'web' | undefined
): PlatformPerformanceLimits {
  switch (platformId) {
    case 'desktop':
      return {
        maxVUs: 10000,
        warnThreshold: 500,
        strongWarnThreshold: 2000,
        supportsIgnoreSslErrors: true,
        isBoundedJsOnly: false,
      };
    case 'android':
      return {
        maxVUs: 15,
        warnThreshold: 10,
        strongWarnThreshold: 15,
        supportsIgnoreSslErrors: true,
        isBoundedJsOnly: true,
      };
    case 'extension':
      return {
        maxVUs: 30,
        warnThreshold: 15,
        strongWarnThreshold: 25,
        http1ConnectionLimit: 6,
        supportsIgnoreSslErrors: false,
        isBoundedJsOnly: true,
      };
    case 'web':
    default:
      return {
        maxVUs: 20,
        warnThreshold: 10,
        strongWarnThreshold: 20,
        http1ConnectionLimit: 6,
        supportsIgnoreSslErrors: false,
        isBoundedJsOnly: true,
      };
  }
}

export const DEFAULT_LOAD_PROFILE_HANDLES: Record<LoadProfileType, number[]> = {
  fixed: [],
  ramp_up: [0.3],
  spike: [0.45, 0.5, 0.7833],
  peak: [0.25, 0.35, 0.7, 0.82],
  staircase: [0.25, 0.5, 0.75],
};

export function getDurationSeconds(config: Pick<LoadProfileConfig, 'durationValue' | 'durationUnit'>): number {
  const raw = Number.isFinite(config.durationValue) ? config.durationValue : 1;
  const clamped = Math.max(1, Math.round(raw));
  if (config.durationUnit === 'minutes') {
    return Math.min(3600, clamped * 60);
  }
  return Math.min(3600, Math.max(5, clamped));
}

export function getMaxStaircaseSteps(durationSec: number): number {
  const safeDur = Math.max(MIN_STAIRCASE_STEP_SECONDS, Math.round(durationSec || MIN_STAIRCASE_STEP_SECONDS));
  return Math.max(1, Math.min(MAX_STAIRCASE_STEPS, Math.floor(safeDur / MIN_STAIRCASE_STEP_SECONDS)));
}

export function createDefaultStaircaseSteps(
  peakVu: number,
  baseVu: number,
  durationSec = 60,
  requestedCount = 4
): StaircaseStep[] {
  const peak = Math.max(1, Math.round(peakVu || 1));
  const base = Math.max(0, Math.min(peak - 1, Math.round(baseVu || 0)));
  const maxSteps = getMaxStaircaseSteps(durationSec);
  const count = Math.max(1, Math.min(maxSteps, Math.round(requestedCount || 4)));

  if (count === 1) {
    return [{ endNorm: 1, virtualUsers: peak }];
  }
  if (count === 2) {
    const s1 = Math.min(peak, Math.max(base + 1, Math.round(base + (peak - base) * 0.5)));
    return [
      { endNorm: 0.5, virtualUsers: s1 },
      { endNorm: 1, virtualUsers: peak },
    ];
  }

  const out: StaircaseStep[] = [];
  const rampSteps = count - 1;
  for (let i = 0; i < count; i++) {
    const endNorm = i === count - 1 ? 1 : Number(((i + 1) / count).toFixed(4));
    let vu: number;
    if (i === count - 1) {
      vu = base;
    } else {
      const ratio = (i + 1) / rampSteps;
      vu = Math.min(peak, Math.max(1, Math.round(base + (peak - base) * ratio)));
    }
    out.push({ endNorm, virtualUsers: vu });
  }
  return out;
}

export function normalizeStaircaseSteps(
  rawSteps: readonly StaircaseStep[] | undefined,
  peakVu: number,
  baseVu: number,
  durationSec: number
): StaircaseStep[] {
  const peak = Math.max(1, Math.round(peakVu || 1));
  const maxSteps = getMaxStaircaseSteps(durationSec);
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return createDefaultStaircaseSteps(peak, baseVu, durationSec);
  }

  const targetCount = Math.max(1, Math.min(maxSteps, rawSteps.length));
  const minGap = Math.min(1, MIN_STAIRCASE_STEP_SECONDS / Math.max(MIN_STAIRCASE_STEP_SECONDS, durationSec));
  const sliced = rawSteps.slice(0, targetCount).map((step, idx) => ({
    endNorm: Number.isFinite(step?.endNorm) ? step.endNorm : (idx + 1) / targetCount,
    virtualUsers: Math.max(0, Math.min(peak, Math.round(step?.virtualUsers ?? peak))),
  }));

  if (sliced.length === 1) {
    return [{ endNorm: 1, virtualUsers: sliced[0].virtualUsers }];
  }

  for (let i = 0; i < sliced.length - 1; i++) {
    const minBound = (i === 0 ? 0 : sliced[i - 1].endNorm) + minGap;
    const maxBound = Math.max(minBound, 1 - (sliced.length - 1 - i) * minGap);
    sliced[i].endNorm = Math.min(maxBound, Math.max(minBound, sliced[i].endNorm));
  }
  sliced[sliced.length - 1].endNorm = 1;
  return sliced;
}

export function resizeStaircaseSteps(
  currentSteps: readonly StaircaseStep[] | undefined,
  nextCount: number,
  peakVu: number,
  baseVu: number,
  durationSec: number
): StaircaseStep[] {
  const peak = Math.max(1, Math.round(peakVu || 1));
  const base = Math.max(0, Math.min(peak - 1, Math.round(baseVu || 0)));
  const maxSteps = getMaxStaircaseSteps(durationSec);
  const count = Math.max(1, Math.min(maxSteps, Math.round(nextCount || 1)));

  if (!currentSteps || currentSteps.length === 0) {
    return createDefaultStaircaseSteps(peak, base, durationSec, count);
  }

  const defaults = createDefaultStaircaseSteps(peak, base, durationSec, count);
  const merged = defaults.map((def, idx) => {
    const prev = currentSteps[idx];
    return {
      endNorm: def.endNorm,
      virtualUsers: prev ? Math.max(0, Math.min(peak, Math.round(prev.virtualUsers))) : def.virtualUsers,
    };
  });
  return normalizeStaircaseSteps(merged, peak, base, durationSec);
}

export function createDefaultLoadProfileConfig(maxVUs = 10000): LoadProfileConfig {
  const defaultVus = Math.min(20, maxVUs);
  const defaultBase = Math.min(2, Math.max(0, defaultVus - 1));
  return {
    profile: 'fixed',
    virtualUsers: defaultVus,
    baseLoad: defaultBase,
    durationValue: 1,
    durationUnit: 'minutes',
    handles: {
      fixed: [...DEFAULT_LOAD_PROFILE_HANDLES.fixed],
      ramp_up: [...DEFAULT_LOAD_PROFILE_HANDLES.ramp_up],
      spike: [...DEFAULT_LOAD_PROFILE_HANDLES.spike],
      peak: [...DEFAULT_LOAD_PROFILE_HANDLES.peak],
      staircase: [...DEFAULT_LOAD_PROFILE_HANDLES.staircase],
    },
    staircaseSteps: createDefaultStaircaseSteps(defaultVus, defaultBase, 60, 4),
    thinkTimeMs: 0,
  };
}

export function clampNormalizedHandles(
  profile: LoadProfileType,
  rawHandles: readonly number[] | undefined,
  durationSec: number
): number[] {
  const defaults = DEFAULT_LOAD_PROFILE_HANDLES[profile] || [];
  if (defaults.length === 0) return [];
  const source = Array.isArray(rawHandles) && rawHandles.length === defaults.length ? rawHandles : defaults;
  const minGap = Math.max(0.02, Math.min(0.08, 1 / Math.max(1, durationSec)));
  const out = [...source];

  for (let i = 0; i < out.length; i++) {
    const minBound = i === 0 ? minGap : out[i - 1] + minGap;
    const maxBound = 1 - (out.length - i) * minGap;
    const val = Number.isFinite(out[i]) ? out[i] : defaults[i];
    out[i] = Math.min(maxBound, Math.max(minBound, val));
  }
  return out;
}

export interface LoadCurvePoint {
  normX: number;
  vu: number;
}

export function getLoadProfilePoints(config: LoadProfileConfig): LoadCurvePoint[] {
  const peak = Math.max(1, Math.round(config.virtualUsers || 1));
  const base = Math.max(0, Math.min(peak - 1, Math.round(config.baseLoad || 0)));
  const durationSec = getDurationSeconds(config);
  const h = clampNormalizedHandles(config.profile, config.handles?.[config.profile], durationSec);

  switch (config.profile) {
    case 'fixed':
      return [
        { normX: 0, vu: peak },
        { normX: 1, vu: peak },
      ];
    case 'ramp_up':
      return [
        { normX: 0, vu: base },
        { normX: h[0], vu: peak },
        { normX: 1, vu: peak },
      ];
    case 'spike':
      return [
        { normX: 0, vu: base },
        { normX: h[0], vu: base },
        { normX: h[1], vu: peak },
        { normX: h[2], vu: base },
        { normX: 1, vu: base },
      ];
    case 'peak':
      return [
        { normX: 0, vu: base },
        { normX: h[0], vu: base },
        { normX: h[1], vu: peak },
        { normX: h[2], vu: peak },
        { normX: h[3], vu: base },
        { normX: 1, vu: base },
      ];
    case 'staircase': {
      const steps = normalizeStaircaseSteps(config.staircaseSteps, peak, base, durationSec);
      const pts: LoadCurvePoint[] = [];
      let prevEnd = 0;
      for (const step of steps) {
        pts.push({ normX: prevEnd, vu: step.virtualUsers });
        pts.push({ normX: step.endNorm, vu: step.virtualUsers });
        prevEnd = step.endNorm;
      }
      return pts;
    }
  }
}

/**
 * Evaluates target virtual users at `elapsedSec` in [0, durationSec].
 */
export function getTargetVusAtTime(config: LoadProfileConfig, elapsedSec: number): number {
  const durationSec = getDurationSeconds(config);
  const clampedElapsed = Math.max(0, Math.min(durationSec, elapsedSec));
  const norm = durationSec > 0 ? clampedElapsed / durationSec : 0;

  if (config.profile === 'staircase') {
    const peak = Math.max(1, Math.round(config.virtualUsers || 1));
    const base = Math.max(0, Math.min(peak - 1, Math.round(config.baseLoad || 0)));
    const steps = normalizeStaircaseSteps(config.staircaseSteps, peak, base, durationSec);
    for (const step of steps) {
      if (norm <= step.endNorm + 1e-9) {
        return Math.max(0, Math.round(step.virtualUsers));
      }
    }
    return Math.max(0, Math.round(steps[steps.length - 1]?.virtualUsers ?? peak));
  }

  const pts = getLoadProfilePoints(config);
  if (pts.length === 0) return Math.max(1, Math.round(config.virtualUsers || 1));
  if (norm <= pts[0].normX) return Math.max(0, Math.round(pts[0].vu));

  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const curr = pts[i];
    if (norm <= curr.normX) {
      const span = curr.normX - prev.normX;
      if (span <= 1e-9) {
        continue;
      }
      const t = (norm - prev.normX) / span;
      return Math.max(0, Math.round(prev.vu + (curr.vu - prev.vu) * t));
    }
  }

  return Math.max(0, Math.round(pts[pts.length - 1].vu));
}

export const DEFAULT_MAX_PERFORMANCE_TIMEOUT_MS = 60_000;
export const HARD_MAX_PERFORMANCE_TIMEOUT_MS = 300_000;
export const MIN_PERFORMANCE_TIMEOUT_MS = 500;

export function computeDefaultPerformanceTimeoutMs(durationSec: number): number {
  const safeDurationMs = Math.max(MIN_PERFORMANCE_TIMEOUT_MS, Math.round(durationSec) * 1000);
  return Math.min(DEFAULT_MAX_PERFORMANCE_TIMEOUT_MS, safeDurationMs);
}

export function clampPerformanceTimeoutMs(timeoutMs: number, durationSec: number): number {
  const maxAllowed = Math.max(
    MIN_PERFORMANCE_TIMEOUT_MS,
    Math.min(HARD_MAX_PERFORMANCE_TIMEOUT_MS, Math.round(durationSec) * 1000)
  );
  const fallback = computeDefaultPerformanceTimeoutMs(durationSec);
  const numeric = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs) : fallback;
  return Math.max(MIN_PERFORMANCE_TIMEOUT_MS, Math.min(maxAllowed, numeric));
}

export function formatDurationCompact(totalSeconds: number): string {
  const sec = Math.max(0, Math.round(totalSeconds));
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  if (mins === 0) return `${rem} second${rem === 1 ? '' : 's'}`;
  if (rem === 0) return `${mins} minute${mins === 1 ? '' : 's'}`;
  return `${mins}:${String(rem).padStart(2, '0')} minutes`;
}

export function formatDurationShort(totalSeconds: number): string {
  const sec = Math.max(0, Math.round(totalSeconds));
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  if (mins === 0) return `${rem}s`;
  if (rem === 0) return `${mins}m`;
  return `${mins}:${String(rem).padStart(2, '0')}`;
}

export function describeLoadProfile(config: LoadProfileConfig): string {
  const peak = Math.max(1, Math.round(config.virtualUsers || 1));
  const base = Math.max(0, Math.min(peak - 1, Math.round(config.baseLoad || 0)));
  const totalSec = getDurationSeconds(config);
  const h = clampNormalizedHandles(config.profile, config.handles?.[config.profile], totalSec);
  const thinkNote =
    config.thinkTimeMs > 0 ? ` with ${config.thinkTimeMs} ms think time between iterations.` : '.';

  switch (config.profile) {
    case 'fixed':
      return `${peak} virtual users run for ${formatDurationCompact(totalSec)}, each executing all selected requests sequentially${thinkNote}`;
    case 'ramp_up': {
      const rampSec = h[0] * totalSec;
      const holdSec = totalSec - rampSec;
      return `Starts at ${base} virtual users and ramps up to ${peak} over ${formatDurationCompact(rampSec)}, then maintains ${peak} for ${formatDurationCompact(holdSec)}${thinkNote}`;
    }
    case 'spike': {
      const d1 = h[0] * totalSec;
      const d2 = (h[1] - h[0]) * totalSec;
      const d3 = (h[2] - h[1]) * totalSec;
      const d4 = (1 - h[2]) * totalSec;
      return `${base} virtual users run for ${formatDurationCompact(d1)}, spikes to ${peak} over ${formatDurationCompact(d2)}, drops to ${base} over ${formatDurationCompact(d3)}, and maintains ${base} for ${formatDurationCompact(d4)}${thinkNote}`;
    }
    case 'peak': {
      const d1 = h[0] * totalSec;
      const d2 = (h[1] - h[0]) * totalSec;
      const d3 = (h[2] - h[1]) * totalSec;
      const d4 = (h[3] - h[2]) * totalSec;
      const d5 = (1 - h[3]) * totalSec;
      return `${base} virtual users run for ${formatDurationCompact(d1)}, ramp to ${peak} over ${formatDurationCompact(d2)}, hold peak ${peak} for ${formatDurationCompact(d3)}, ramp down to ${base} over ${formatDurationCompact(d4)}, and maintain ${base} for ${formatDurationCompact(d5)}${thinkNote}`;
    }
    case 'staircase': {
      const steps = normalizeStaircaseSteps(config.staircaseSteps, peak, base, totalSec);
      let prevEnd = 0;
      const parts = steps.map((step, idx) => {
        const durSec = Math.round((step.endNorm - prevEnd) * totalSec);
        prevEnd = step.endNorm;
        return `Step ${idx + 1}: ${step.virtualUsers} VUs (${formatDurationShort(durSec)})`;
      });
      return `${parts.join(' → ')}${thinkNote}`;
    }
  }
}
