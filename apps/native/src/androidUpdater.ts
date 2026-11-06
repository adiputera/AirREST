import { invoke } from '@tauri-apps/api/core';

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
  digest?: string | null;
}
export interface GitHubRelease {
  tag_name: string;
  html_url: string;
  assets: GitHubAsset[];
}
export interface AndroidUpdateStatus {
  state: 'idle' | 'pending' | 'downloading' | 'paused' | 'verifying' | 'ready' | 'failed';
  version: string | null;
  progress: number | null;
  message: string | null;
  canInstall: boolean;
}
export const IDLE_UPDATE: AndroidUpdateStatus = {
  state: 'idle', version: null, progress: null, message: null, canInstall: false,
};
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const RELEASE_CACHE_KEY = 'airrest_android_release_cache';
export const DISMISSED_VERSION_KEY = 'airrest_android_dismissed_version';

export function isNewerVersion(remote: string, current: string): boolean {
  const parse = (value: string) => {
    const match = /^(?:(?:desktop-|android-)?v)?(\d+)\.(\d+)\.(\d+)$/.exec(value);
    return match ? match.slice(1).map(Number) : null;
  };
  const r = parse(remote);
  const c = parse(current);
  if (!r || !c) return false;
  for (let i = 0; i < 3; i++) {
    if (r[i] !== c[i]) return r[i] > c[i];
  }
  return false;
}

export function parseRelease(value: unknown): GitHubRelease | null {
  if (!value || typeof value !== 'object') return null;
  const release = value as Record<string, unknown>;
  if (typeof release.tag_name !== 'string' || typeof release.html_url !== 'string' ||
      !release.html_url.startsWith('https://github.com/') || !Array.isArray(release.assets)) return null;
  const assets: GitHubAsset[] = [];
  for (const item of release.assets) {
    if (!item || typeof item !== 'object') continue;
    const asset = item as Record<string, unknown>;
    if (typeof asset.name !== 'string' || !asset.name.endsWith('.apk') ||
        typeof asset.browser_download_url !== 'string' || !asset.browser_download_url.startsWith('https://github.com/') ||
        typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size <= 0 ||
        (asset.digest != null && (typeof asset.digest !== 'string' || !/^sha256:[a-f\d]{64}$/i.test(asset.digest)))) continue;
    assets.push({ name: asset.name, browser_download_url: asset.browser_download_url, size: asset.size,
      digest: asset.digest as string | null | undefined });
  }
  return assets.length ? { tag_name: release.tag_name, html_url: release.html_url, assets } : null;
}

export function readCachedRelease(raw: string | null, repo: string): { checkedAt: number; release: GitHubRelease } | null {
  try {
    const cached: unknown = JSON.parse(raw || 'null');
    if (!cached || typeof cached !== 'object') return null;
    const data = cached as Record<string, unknown>;
    const release = parseRelease(data.release);
    return data.repo === repo && typeof data.checkedAt === 'number' && Number.isFinite(data.checkedAt) && release
      ? { checkedAt: data.checkedAt, release } : null;
  } catch {
    return null; // Old or damaged cache must not prevent a fresh release check.
  }
}

export function updateError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'Could not complete the update action. Please retry.';
}

export const nativeAndroidUpdater = {
  status: () => invoke<AndroidUpdateStatus>('plugin:android-update|status'),
  start: (release: GitHubRelease) => invoke<AndroidUpdateStatus>('plugin:android-update|start', {
    version: release.tag_name, assets: release.assets,
  }),
  cancel: () => invoke<AndroidUpdateStatus>('plugin:android-update|cancel'),
  install: () => invoke<{ action: 'permissionRequired' | 'installerOpened' }>('plugin:android-update|install'),
};

/** Prevent stale polls from overwriting a newer start/cancel result. */
export function createAndroidUpdateController(
  port: typeof nativeAndroidUpdater,
  onStatus: (status: AndroidUpdateStatus) => void,
  onMessage: (message: string | null) => void,
  onBusy: (busy: boolean) => void,
) {
  let generation = 0;
  let disposed = false;
  let busy = false;
  let polling = false;
  let pollFailed = false;
  const action = async (run: () => Promise<void>) => {
    if (disposed || busy) return;
    busy = true;
    generation++;
    pollFailed = false;
    onBusy(true);
    onMessage(null);
    try {
      await run();
    } catch (error) {
      if (!disposed) onMessage(updateError(error));
    } finally {
      busy = false;
      if (!disposed) onBusy(false);
    }
  };
  return {
    async refresh() {
      if (disposed || busy || polling) return;
      polling = true;
      const ticket = generation;
      try {
        const status = await port.status();
        if (!disposed && ticket === generation) {
          onStatus(status);
          if (pollFailed) onMessage(null);
          pollFailed = false;
        }
      } catch (error) {
        if (!disposed && ticket === generation) {
          pollFailed = true;
          onMessage(updateError(error));
        }
      } finally {
        polling = false;
      }
    },
    start: (release: GitHubRelease) => action(async () => {
      const status = await port.start(release);
      if (!disposed) onStatus(status);
    }),
    cancel: () => action(async () => {
      const status = await port.cancel();
      if (!disposed) onStatus(status);
    }),
    install: () => action(async () => {
      const result = await port.install();
      if (!disposed) onMessage(result.action === 'permissionRequired'
        ? 'Allow AirREST to install apps, then return and tap Install APK.'
        : 'Complete the update in Android’s installer. If cancelled, tap Install APK to try again.');
    }),
    dispose() { disposed = true; generation++; },
  };
}
