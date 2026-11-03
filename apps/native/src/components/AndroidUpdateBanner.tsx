import React, { useEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  CHECK_INTERVAL_MS, DISMISSED_VERSION_KEY, IDLE_UPDATE, RELEASE_CACHE_KEY,
  createAndroidUpdateController, isNewerVersion, nativeAndroidUpdater, parseRelease,
  readCachedRelease, updateError,
  type AndroidUpdateStatus, type GitHubRelease,
} from '../androidUpdater';

export function AndroidUpdateBanner({
  repo = 'adiputera/AirREST',
  currentVersion = typeof __AIRREST_VERSION__ !== 'undefined' ? __AIRREST_VERSION__ : '0.0.0',
}: { repo?: string; currentVersion?: string }) {
  const [release, setRelease] = useState<GitHubRelease | null>(null);
  const [status, setStatus] = useState<AndroidUpdateStatus>(IDLE_UPDATE);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const updater = useRef<ReturnType<typeof createAndroidUpdateController> | null>(null);

  useEffect(() => {
    const controller = createAndroidUpdateController(nativeAndroidUpdater, setStatus, setMessage, setBusy);
    updater.current = controller;
    const refresh = () => { if (!document.hidden) void controller.refresh(); };
    refresh();
    const timer = setInterval(refresh, 2000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      controller.dispose();
      updater.current = null;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 6000);
    const showRelease = (candidate: GitHubRelease) => {
      if (!mounted) return;
      setRelease(isNewerVersion(candidate.tag_name, currentVersion) ? candidate : null);
      setDismissed(localStorage.getItem(DISMISSED_VERSION_KEY) === candidate.tag_name);
    };
    async function check() {
      try {
        const cached = readCachedRelease(localStorage.getItem(RELEASE_CACHE_KEY), repo);
        if (cached) {
          showRelease(cached.release);
          const age = Date.now() - cached.checkedAt;
          if (age >= 0 && age < CHECK_INTERVAL_MS) return;
        }
        const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
          signal: abort.signal, headers: { Accept: 'application/vnd.github+json' },
        });
        if (!response.ok) return; // Offline/rate-limited checks leave the cached update available.
        const candidate = parseRelease(await response.json());
        if (!mounted || !candidate) return;
        showRelease(candidate);
        localStorage.setItem(RELEASE_CACHE_KEY, JSON.stringify({ repo, checkedAt: Date.now(), release: candidate }));
      } catch (error) {
        if (mounted && !abort.signal.aborted) {
          // Keep the cached release visible; a failed background check must not disrupt the app.
          setMessage(`Could not check for a newer release. ${updateError(error)}`);
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    void check();
    return () => { mounted = false; abort.abort(); clearTimeout(timeout); };
  }, [repo, currentVersion]);

  // An in-progress or downloaded APK survives dismissal, offline startup, and app restart.
  const hasDownload = status.state !== 'idle';
  if (!hasDownload && (!release || dismissed)) return null;
  const transferring = ['pending', 'downloading', 'paused', 'verifying'].includes(status.state);
  const ready = status.state === 'ready';
  const version = hasDownload ? status.version : release?.tag_name;
  const description = status.state === 'pending' ? 'Waiting for download…'
    : status.state === 'downloading' ? `Downloading APK${status.progress == null ? '…' : ` (${status.progress}%)`}`
    : status.state === 'verifying' ? 'Checking APK…'
    : ready ? 'APK verified and ready to install'
    : status.state === 'failed' ? 'Update needs attention'
    : status.state === 'paused' ? 'Download paused'
    : 'Update available';

  async function manualDownload() {
    if (!release) return;
    try { await openUrl(release.html_url); }
    catch (error) { setMessage(`Could not open the release page. ${updateError(error)}`); }
  }

  function dismiss() {
    if (release) localStorage.setItem(DISMISSED_VERSION_KEY, release.tag_name);
    setDismissed(true);
  }

  const buttonClass = 'rounded bg-cyan-600 px-2.5 py-1 font-medium text-white hover:bg-cyan-500 disabled:opacity-50';
  return (
    <aside role="status" aria-live="polite"
      className="sticky top-0 z-50 border-b border-cyan-800/40 bg-gradient-to-r from-cyan-950 via-slate-900 to-indigo-950 px-3 py-2 text-xs text-slate-100 shadow-md">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="font-semibold text-cyan-300">AirREST {version}</span>
          <span className="ml-2">{description}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ready ? (
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void updater.current?.install()}>
              {busy ? 'Opening…' : 'Install APK'}
            </button>
          ) : !transferring && release ? (
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void updater.current?.start(release)}>
              {busy ? 'Starting…' : status.state === 'failed' ? 'Retry download' : 'Download APK'}
            </button>
          ) : null}
          {hasDownload && (
            <button type="button" disabled={busy} onClick={() => void updater.current?.cancel()} className="px-2 py-1 disabled:opacity-50">
              {ready ? 'Discard APK' : 'Cancel'}
            </button>
          )}
          {release && !transferring && <button type="button" disabled={busy} onClick={() => void manualDownload()} className="px-2 py-1 underline">Manual download</button>}
          {!hasDownload && <button type="button" disabled={busy} onClick={dismiss} aria-label="Close update notification" className="px-2 py-1">✕</button>}
        </div>
      </div>
      {(status.message || message) && <p className="mt-1 break-words text-amber-200">{message || status.message}</p>}
    </aside>
  );
}
