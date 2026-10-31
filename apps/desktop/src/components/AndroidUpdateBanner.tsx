import React, { useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

export interface GitHubRelease {
  tag_name: string;
  name?: string;
  html_url: string;
  body?: string;
  assets?: GitHubAsset[];
}

export function isNewerVersion(remote: string, current: string): boolean {
  const clean = (v: string) => v.replace(/^(desktop-|android-)?v?/, '').split('-')[0];
  const rParts = clean(remote).split('.').map((n) => parseInt(n, 10) || 0);
  const cParts = clean(current).split('.').map((n) => parseInt(n, 10) || 0);

  for (let i = 0; i < 3; i++) {
    const r = rParts[i] ?? 0;
    const c = cParts[i] ?? 0;
    if (r > c) return true;
    if (r < c) return false;
  }
  return false;
}

export function pickAndroidApkUrl(assets: GitHubAsset[] = [], fallbackHtmlUrl: string): string {
  // Prefer ARM64 APK (phones/tablets), then universal APK, then any APK
  const arm64 = assets.find(
    (a) => a.name.endsWith('.apk') && (a.name.includes('arm64') || a.name.includes('aarch64')),
  );
  if (arm64) return arm64.browser_download_url;

  const universal = assets.find((a) => a.name.endsWith('.apk') && a.name.includes('universal'));
  if (universal) return universal.browser_download_url;

  const anyApk = assets.find((a) => a.name.endsWith('.apk'));
  if (anyApk) return anyApk.browser_download_url;

  return fallbackHtmlUrl;
}

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const LAST_CHECK_KEY = 'airrest_android_last_update_check';
export const DISMISSED_VERSION_KEY = 'airrest_android_dismissed_version';

export function AndroidUpdateBanner({
  repo = 'adiputera/AirREST',
  currentVersion = typeof __AIRREST_VERSION__ !== 'undefined' ? __AIRREST_VERSION__ : '1.2.0',
}: {
  repo?: string;
  currentVersion?: string;
}) {
  const [updateAvailable, setUpdateAvailable] = useState<GitHubRelease | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let isMounted = true;

    async function checkForUpdates() {
      try {
        const lastCheck = localStorage.getItem(LAST_CHECK_KEY);
        const dismissedVer = localStorage.getItem(DISMISSED_VERSION_KEY);
        const now = Date.now();

        // Avoid repeated checks within the cooldown window
        if (lastCheck && now - parseInt(lastCheck, 10) < CHECK_INTERVAL_MS) {
          return;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
          signal: controller.signal,
          headers: {
            Accept: 'application/vnd.github.v3+json',
          },
        });
        clearTimeout(timeoutId);

        if (!response.ok) return;

        const release = (await response.json()) as GitHubRelease;
        localStorage.setItem(LAST_CHECK_KEY, String(now));

        if (!isMounted) return;

        if (release.tag_name && isNewerVersion(release.tag_name, currentVersion)) {
          if (dismissedVer !== release.tag_name) {
            setUpdateAvailable(release);
          }
        }
      } catch {
        // Silently ignore network failures or offline mode
      }
    }

    void checkForUpdates();

    return () => {
      isMounted = false;
    };
  }, [repo, currentVersion]);

  if (!updateAvailable || dismissed) return null;

  const newVer = updateAvailable.tag_name;
  const downloadUrl = pickAndroidApkUrl(updateAvailable.assets, updateAvailable.html_url);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await openUrl(downloadUrl);
    } catch {
      window.open(downloadUrl, '_blank');
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
    if (newVer) {
      localStorage.setItem(DISMISSED_VERSION_KEY, newVer);
    }
  };

  return (
    <aside
      role="status"
      aria-live="polite"
      className="sticky top-0 z-50 flex items-center justify-between gap-3 bg-gradient-to-r from-cyan-950 via-slate-900 to-indigo-950 px-3 py-2 text-xs text-slate-100 shadow-md border-b border-cyan-800/40"
    >
      <div className="flex items-center gap-2 overflow-hidden truncate">
        <span className="flex h-2 w-2 rounded-full bg-cyan-400 animate-pulse shrink-0" />
        <span className="font-semibold text-cyan-300">AirREST {newVer}</span>
        <span className="truncate text-slate-300">tersedia</span>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading}
          className="rounded bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-700 px-2.5 py-1 text-xs font-medium text-white shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-cyan-400 cursor-pointer"
        >
          {downloading ? 'Membuka...' : 'Unduh APK'}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Tutup notifikasi pembaruan"
          className="p-1 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </aside>
  );
}

