import React, { useEffect, useState, useRef } from 'react';
import { check, type Update, type DownloadEvent } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getCurrentWindow } from '@tauri-apps/api/window';

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'dismissed'
  | 'error';

export type DesktopPlatform = 'macos' | 'windows' | 'linux';

/**
 * Detects the host desktop OS from a user-agent string.
 */
export function detectDesktopPlatform(userAgent: string): DesktopPlatform {
  const ua = userAgent.toLowerCase();
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('macintosh') || ua.includes('mac os')) return 'macos';
  return 'linux';
}

export interface UpdaterControllerDeps {
  platform: DesktopPlatform;
  checkUpdate: () => Promise<Update | null>;
  relaunchApp: () => Promise<void>;
  onStateChange: (state: UpdateState) => void;
  onVersionChange: (version: string) => void;
  onProgressChange: (percent: number) => void;
}

/**
 * Core OS-aware update lifecycle controller.
 * - macOS: Downloads in background, then immediately stages to disk (`install()`) silently.
 * - Windows & Linux: Downloads in background (`download()`) without interrupting the user;
 *   applies installation either when user clicks "Restart Now" or when window closes.
 */
export function createUpdaterController(deps: UpdaterControllerDeps) {
  let currentUpdate: Update | null = null;
  let isReady = false;
  let isInstalledOnDisk = false;
  let isInstalling = false;
  let isDisposed = false;

  const trackProgress = () => {
    let downloaded = 0;
    let contentLength = 0;
    return (event: DownloadEvent) => {
      if (isDisposed) return;
      if (event.event === 'Started') {
        contentLength = event.data.contentLength ?? 0;
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        if (contentLength > 0) {
          deps.onProgressChange(Math.min(100, Math.round((downloaded / contentLength) * 100)));
        }
      }
    };
  };

  return {
    async start(): Promise<boolean> {
      if (isDisposed) return false;
      try {
        deps.onStateChange('checking');
        const update = await deps.checkUpdate();
        if (isDisposed) {
          if (update) await update.close().catch(() => {});
          return false;
        }
        if (!update?.available) {
          deps.onStateChange('idle');
          return false;
        }

        currentUpdate = update;
        deps.onVersionChange(update.version);
        deps.onStateChange('downloading');

        await update.download(trackProgress());
        if (isDisposed) {
          await update.close().catch(() => {});
          return false;
        }

        if (deps.platform === 'macos') {
          // On macOS, atomic bundle replacement in /Applications is silent and non-disruptive.
          try {
            await update.install();
            isInstalledOnDisk = true;
          } catch (err) {
            console.warn('macOS background staging deferred until explicit restart:', err);
          }
        }

        if (isDisposed) return false;
        isReady = true;
        deps.onStateChange('ready');
        return true;
      } catch (err) {
        console.warn('Tauri auto-updater check error:', err);
        if (!isDisposed) deps.onStateChange('idle');
        return false;
      }
    },

    async applyAndRestart(): Promise<void> {
      if (!isReady || isInstalling || !currentUpdate) return;
      isInstalling = true;
      isReady = false;
      deps.onStateChange('installing');

      try {
        if (deps.platform === 'windows') {
          // On Windows, install({ restartAfterInstall: true }) launches passive installer & restarts
          await currentUpdate.install({ restartAfterInstall: true });
        } else if (deps.platform === 'macos') {
          if (!isInstalledOnDisk) {
            await currentUpdate.install();
            isInstalledOnDisk = true;
          }
          await deps.relaunchApp();
        } else {
          // On Linux (.AppImage / .deb / .rpm), install then relaunch
          await currentUpdate.install();
          isInstalledOnDisk = true;
          await deps.relaunchApp();
        }
      } catch (err) {
        isInstalling = false;
        isReady = true;
        console.error('Failed to apply update / restart:', err);
        deps.onStateChange('error');
      }
    },

    async applyOnWindowClose(): Promise<void> {
      if (!isReady || isInstalling || !currentUpdate || isInstalledOnDisk) return;
      isInstalling = true;
      isReady = false;

      try {
        if (deps.platform === 'windows') {
          // Install on close WITHOUT relaunching the app after the user explicitly closed it
          await currentUpdate.install({ restartAfterInstall: false });
        } else {
          await currentUpdate.install();
          isInstalledOnDisk = true;
        }
      } catch (err) {
        console.error('Install on window close failed:', err);
      }
    },

    needsCloseHook(): boolean {
      return isReady && !isInstalledOnDisk;
    },

    async dispose(): Promise<void> {
      isDisposed = true;
      if (currentUpdate && !isInstalledOnDisk && !isInstalling) {
        const toClose = currentUpdate;
        currentUpdate = null;
        await toClose.close().catch(() => {});
      }
    },
  };
}

export const DesktopUpdateBanner: React.FC = () => {
  const [state, setState] = useState<UpdateState>('idle');
  const [version, setVersion] = useState<string>('');
  const [progress, setProgress] = useState<number>(0);
  const controllerRef = useRef<ReturnType<typeof createUpdaterController> | null>(null);

  useEffect(() => {
    const platform = detectDesktopPlatform(
      typeof navigator !== 'undefined' ? navigator.userAgent : '',
    );

    let isMounted = true;
    let unlistenClose: (() => void) | undefined;

    const controller = createUpdaterController({
      platform,
      checkUpdate: () => check(),
      relaunchApp: () => relaunch(),
      onStateChange: (next) => {
        if (isMounted) setState(next);
      },
      onVersionChange: (v) => {
        if (isMounted) setVersion(v);
      },
      onProgressChange: (p) => {
        if (isMounted) setProgress(p);
      },
    });
    controllerRef.current = controller;

    const timer = setTimeout(async () => {
      if (!isMounted) return;
      const hasReadyUpdate = await controller.start();
      if (!isMounted || !hasReadyUpdate) return;

      // On Windows & Linux (or if macOS background stage was deferred), hook window close
      if (controller.needsCloseHook()) {
        try {
          const currentWin = getCurrentWindow();
          unlistenClose = await currentWin.onCloseRequested(async () => {
            await controller.applyOnWindowClose();
          });
        } catch (err) {
          console.warn('Window close hook unavailable:', err);
        }
      }
    }, 3500);

    return () => {
      isMounted = false;
      clearTimeout(timer);
      if (unlistenClose) unlistenClose();
      void controller.dispose();
    };
  }, []);

  const handleRestart = async () => {
    await controllerRef.current?.applyAndRestart();
  };

  const handleDismiss = () => {
    setState('dismissed');
  };

  if (state !== 'downloading' && state !== 'ready' && state !== 'installing') {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-xl border border-sky-500/30 bg-slate-900/95 p-4 text-slate-100 shadow-2xl backdrop-blur-md transition-all animate-in fade-in slide-in-from-bottom-3 duration-300">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400">
          <svg className="h-4 w-4 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-sky-400">
              AirREST Update
            </h4>
            <span className="text-[10px] font-mono text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded">
              v{version}
            </span>
          </div>

          {state === 'downloading' && (
            <div className="mt-1.5">
              <p className="text-xs text-slate-300">
                Downloading update in the background... {progress > 0 ? `(${progress}%)` : ''}
              </p>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full bg-sky-500 transition-all duration-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {state === 'ready' && (
            <div className="mt-1.5">
              <p className="text-xs text-slate-300">
                Update is ready to install. Restart now or continue working.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleRestart}
                  className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-sky-500 active:scale-95 transition-all"
                >
                  Restart Now
                </button>
                <button
                  type="button"
                  onClick={handleDismiss}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700 active:scale-95 transition-all"
                >
                  Later
                </button>
              </div>
            </div>
          )}

          {state === 'installing' && (
            <p className="mt-1.5 text-xs text-sky-300">
              Installing update and restarting application...
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
export default DesktopUpdateBanner;
