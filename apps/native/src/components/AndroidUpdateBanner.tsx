import React, { useEffect, useRef, useState } from 'react';
import {
  CHECK_INTERVAL_MS,
  DISMISSED_VERSION_KEY,
  RELEASE_CACHE_KEY,
  isNewerVersion,
  nativeAndroidUpdater,
  parseRelease,
  readCachedRelease,
  updateError,
  type GitHubRelease,
} from '../androidUpdater';

export function AndroidUpdateBanner({
  repo,
  currentVersion = typeof __AIRREST_VERSION__ !== 'undefined' ? __AIRREST_VERSION__ : '0.0.0',
}: {
  repo: string;
  currentVersion?: string;
}) {
  const [release, setRelease] = useState<GitHubRelease | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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
          signal: abort.signal,
          headers: { Accept: 'application/vnd.github+json' },
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
    return () => {
      mounted = false;
      abort.abort();
      clearTimeout(timeout);
    };
  }, [repo, currentVersion]);

  if (!release || dismissed) return null;

  async function runAction(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      if (mountedRef.current) {
        setMessage(updateError(error));
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  }

  function downloadInBrowser() {
    if (!release) return;
    void runAction(async () => {
      const result = await nativeAndroidUpdater.download(release);
      if (!mountedRef.current) return;
      setMessage(
        result.target === 'apk'
          ? 'Opened the APK download in your browser. Once finished, open the file from Downloads to install.'
          : 'Opened the release page in your browser because no direct APK matched this device.',
      );
    });
  }

  function openReleasePage() {
    if (!release) return;
    void runAction(async () => {
      await nativeAndroidUpdater.browse(release);
      if (!mountedRef.current) return;
      setMessage('Opened the release page in your browser.');
    });
  }

  function dismiss() {
    if (release) localStorage.setItem(DISMISSED_VERSION_KEY, release.tag_name);
    setDismissed(true);
  }

  const buttonClass = 'rounded bg-cyan-600 px-2.5 py-1 font-medium text-white hover:bg-cyan-500 disabled:opacity-50';
  return (
    <aside
      role="status"
      aria-live="polite"
      className="sticky top-0 z-50 border-b border-cyan-800/40 bg-gradient-to-r from-cyan-950 via-slate-900 to-indigo-950 px-3 py-2 text-xs text-slate-100 shadow-md"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="font-semibold text-cyan-300">AirREST {release.tag_name}</span>
          <span className="ml-2">Update available</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={buttonClass} disabled={busy} onClick={downloadInBrowser}>
            {busy ? 'Opening…' : 'Download APK'}
          </button>
          <button type="button" disabled={busy} onClick={openReleasePage} className="px-2 py-1 underline disabled:opacity-50">
            Release page
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={dismiss}
            aria-label="Close update notification"
            className="px-2 py-1 disabled:opacity-50"
          >
            ✕
          </button>
        </div>
      </div>
      {message && <p className="mt-1 break-words text-amber-200">{message}</p>}
    </aside>
  );
}
