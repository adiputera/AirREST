import React, { useState, useEffect, useRef } from 'react';
import { GripHorizontal } from 'lucide-react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { RequestEditor } from './components/RequestEditor';
import { ResponseViewer } from './components/ResponseViewer';
import { EmptyStudioView } from './components/EmptyStudioView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useApiStore } from './store/useApiStore';
import { useStoreContext } from './store/storeContext';
import { onStorageCommit } from './lib/storage';
import { useBackHandler } from './lib/backNavigation';
import { applyTheme, subscribeToSystemTheme } from './lib/theme';

export const DEFAULT_REQUEST_PANE_HEIGHT = 320;
export const MIN_REQUEST_PANE_HEIGHT = 150;
export const MIN_RESPONSE_PANE_HEIGHT = 140;

export function clampRequestPaneHeight(
  height: number,
  containerHeight = typeof window !== 'undefined' ? window.innerHeight - 130 : 600
): number {
  const maxAllowed = Math.max(MIN_REQUEST_PANE_HEIGHT, containerHeight - MIN_RESPONSE_PANE_HEIGHT);
  return Math.max(MIN_REQUEST_PANE_HEIGHT, Math.min(maxAllowed, Math.round(height)));
}

export const App: React.FC = () => {
  const contextStore = useStoreContext();
  const activeStore = contextStore || useApiStore;
  const [hasHydrated, setHasHydrated] = useState(() => activeStore.persist.hasHydrated());
  const [storageUpdateAvailable, setStorageUpdateAvailable] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const storageUpdateAvailableState = storageUpdateAvailable;
  const isSwitchingWorkspace = activeStore((state) => state.isSwitchingWorkspace);
  const tabs = activeStore((state) => state.tabs);
  const activeTabId = activeStore((state) => state.activeTabId);
  const createTab = activeStore((state) => state.createTab);
  const workspaceMode = activeStore((state) => state.workspaceMode);
  const cloudToken = activeStore((state) => state.cloudConfig.token);
  const activeScope = activeStore((state) => state.cloudConfig.activeScope);
  const pullCloudDelta = activeStore((state) => state.pullCloudDelta);
  const refreshFeaturePolicy = activeStore((state) => state.refreshFeaturePolicy);
  const theme = activeStore((state) => state.theme || 'system');
  const hasInitialPulledRef = useRef(false);
  useBackHandler(sidebarOpen, () => setSidebarOpen(false), 10);

  // Studio Desktop Request vs Response Split-Pane Resizer
  const [isDesktop, setIsDesktop] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 768 : true
  );
  const studioContainerRef = useRef<HTMLDivElement>(null);
  const [requestPaneHeight, setRequestPaneHeight] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('airrest:request_pane_height');
      if (saved) {
        const val = parseInt(saved, 10);
        if (!isNaN(val) && val >= MIN_REQUEST_PANE_HEIGHT && val <= 1600) return val;
      }
    } catch {
      // ignore
    }
    return DEFAULT_REQUEST_PANE_HEIGHT;
  });

  const [isRequestCollapsed, setIsRequestCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('airrest:request_config_collapsed') === 'true';
    } catch {
      // ignore
      return false;
    }
  });

  const [isResizingSplit, setIsResizingSplit] = useState(false);
  const isResizingSplitRef = useRef(false);
  const startSplitYRef = useRef(0);
  const startSplitHeightRef = useRef(DEFAULT_REQUEST_PANE_HEIGHT);
  const latestSplitHeightRef = useRef(requestPaneHeight);
  latestSplitHeightRef.current = requestPaneHeight;

  useEffect(() => {
    const handleResize = () => {
      const desktop = window.innerWidth >= 768;
      setIsDesktop(desktop);
      if (desktop) {
        const containerH = studioContainerRef.current?.clientHeight || (window.innerHeight - 130);
        setRequestPaneHeight((curr) => clampRequestPaneHeight(curr, containerH));
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    return () => {
      document.body.style.removeProperty('user-select');
      document.body.style.removeProperty('cursor');
    };
  }, []);

  const handleStartSplitResize = (clientY: number) => {
    isResizingSplitRef.current = true;
    startSplitYRef.current = clientY;
    startSplitHeightRef.current = latestSplitHeightRef.current;
    setIsResizingSplit(true);

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizingSplitRef.current) return;
      const deltaY = e.clientY - startSplitYRef.current;
      const containerH = studioContainerRef.current?.clientHeight || (window.innerHeight - 130);
      const newHeight = clampRequestPaneHeight(startSplitHeightRef.current + deltaY, containerH);
      latestSplitHeightRef.current = newHeight;
      setRequestPaneHeight(newHeight);
    };

    const onMouseUp = () => {
      if (!isResizingSplitRef.current) return;
      isResizingSplitRef.current = false;
      setIsResizingSplit(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.removeProperty('user-select');
      document.body.style.removeProperty('cursor');
      try {
        localStorage.setItem('airrest:request_pane_height', String(latestSplitHeightRef.current));
      } catch {
        // ignore
      }
    };

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleTouchStartSplitResize = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    isResizingSplitRef.current = true;
    startSplitYRef.current = touch.clientY;
    startSplitHeightRef.current = latestSplitHeightRef.current;
    setIsResizingSplit(true);

    const onTouchMove = (ev: TouchEvent) => {
      if (!isResizingSplitRef.current) return;
      const moveTouch = ev.touches[0];
      if (!moveTouch) return;
      const deltaY = moveTouch.clientY - startSplitYRef.current;
      const containerH = studioContainerRef.current?.clientHeight || (window.innerHeight - 130);
      const newHeight = clampRequestPaneHeight(startSplitHeightRef.current + deltaY, containerH);
      latestSplitHeightRef.current = newHeight;
      setRequestPaneHeight(newHeight);
    };

    const onTouchEnd = () => {
      if (!isResizingSplitRef.current) return;
      isResizingSplitRef.current = false;
      setIsResizingSplit(false);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      document.body.style.removeProperty('user-select');
      document.body.style.removeProperty('cursor');
      try {
        localStorage.setItem('airrest:request_pane_height', String(latestSplitHeightRef.current));
      } catch {
        // ignore
      }
    };

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd);
  };

  const handleResetSplit = () => {
    const containerH = studioContainerRef.current?.clientHeight || (window.innerHeight - 130);
    const defaultH = Math.max(
      MIN_REQUEST_PANE_HEIGHT,
      Math.min(containerH - MIN_RESPONSE_PANE_HEIGHT, Math.floor(containerH * 0.45))
    );
    setRequestPaneHeight(defaultH);
    try {
      localStorage.setItem('airrest:request_pane_height', String(defaultH));
    } catch {
      // ignore
    }
  };

  const handleSplitKeyDown = (e: React.KeyboardEvent) => {
    const containerH = studioContainerRef.current?.clientHeight || (window.innerHeight - 130);
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setRequestPaneHeight((curr) => {
        const next = clampRequestPaneHeight(curr - 16, containerH);
        try {
          localStorage.setItem('airrest:request_pane_height', String(next));
        } catch {
          // ignore
        }
        return next;
      });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setRequestPaneHeight((curr) => {
        const next = clampRequestPaneHeight(curr + 16, containerH);
        try {
          localStorage.setItem('airrest:request_pane_height', String(next));
        } catch {
          // ignore
        }
        return next;
      });
    } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Home') {
      e.preventDefault();
      handleResetSplit();
    }
  };

  // Initial background delta sync on app startup when opened with an active cloud session
  useEffect(() => {
    if (!hasHydrated || workspaceMode !== 'cloud' || !cloudToken || !activeScope) return;
    if (hasInitialPulledRef.current) return;
    hasInitialPulledRef.current = true;
    void pullCloudDelta();
  }, [hasHydrated, workspaceMode, cloudToken, activeScope, pullCloudDelta]);

  useEffect(() => {
    applyTheme(theme);
    if (theme === 'system') {
      return subscribeToSystemTheme(() => {
        applyTheme('system');
      });
    }
  }, [theme]);

  useEffect(() => setSidebarOpen(false), [activeTabId]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setSidebarOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [sidebarOpen]);

  useEffect(() => {
    if (activeStore.persist.hasHydrated()) {
      setHasHydrated(true);
      return;
    }
    const unsub = activeStore.persist.onFinishHydration(() => {
      setHasHydrated(true);
    });
    return () => unsub();
  }, [activeStore]);

  useEffect(() => onStorageCommit((notice) => {
    if (notice.key === 'air-rest-storage') setStorageUpdateAvailable(true);
  }), []);

  useEffect(() => {
    if (workspaceMode !== 'cloud' || !cloudToken) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => {
        void refreshFeaturePolicy(true).finally(() => {
          if (!disposed) schedule();
        });
      }, 30 * 60 * 1000);
    };
    const refreshIfNeeded = () => {
      void refreshFeaturePolicy(false);
    };

    refreshIfNeeded();
    schedule();
    window.addEventListener('focus', refreshIfNeeded);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('focus', refreshIfNeeded);
    };
  }, [workspaceMode, cloudToken, refreshFeaturePolicy]);

  if (!hasHydrated) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-app text-tx-muted">
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
          <span className="text-sm font-medium">Loading AirREST...</span>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary fallbackTitle="AirREST Workspace Error">
      <div className="relative flex h-[100dvh] w-screen flex-col overflow-hidden bg-app text-tx-primary select-none">
        {/* Top Application Header */}
        <ErrorBoundary fallbackTitle="Header Error">
          <Header onOpenSidebar={() => setSidebarOpen(true)} />
        </ErrorBoundary>

        {/* Main Workspace Body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left Sidebar (Collections & History) */}
          {sidebarOpen && (
            <button type="button" aria-label="Close collections panel" className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={() => setSidebarOpen(false)} />
          )}
          <div className={`${sidebarOpen ? 'fixed inset-y-0 left-0 z-40 flex flex-col bg-surface' : 'hidden'} md:relative md:z-auto md:block md:shrink-0`}>
            <div className="min-h-0 flex-1 md:h-full">
              <ErrorBoundary fallbackTitle="Sidebar Error">
                <Sidebar onClose={() => setSidebarOpen(false)} />
              </ErrorBoundary>
            </div>
          </div>

          {/* Right Studio Panel (Tabs, Request, Response) */}
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app">
            <ErrorBoundary fallbackTitle="Studio Panel Error">
              <TabBar />
              {tabs && tabs.length > 0 ? (
                <div
                  ref={studioContainerRef}
                  className={`relative flex flex-1 flex-col ${isDesktop ? 'overflow-hidden' : 'overflow-y-auto'}`}
                >
                  {/* Top Pane: Request (URL Bar, Params, Headers, Auth, Body, Scripts) */}
                  <div
                    className={`flex flex-col shrink-0 min-h-0 ${isDesktop && !isRequestCollapsed ? 'overflow-y-auto' : ''}`}
                    style={{
                      height: isDesktop
                        ? isRequestCollapsed
                          ? 'auto'
                          : `${requestPaneHeight}px`
                        : undefined,
                    }}
                  >
                    <RequestEditor onCollapseChange={setIsRequestCollapsed} />
                  </div>

                  {/* Global Studio Split-Pane Resizer (Desktop only, visible when request pane is expanded) */}
                  {isDesktop && !isRequestCollapsed && (
                    <div
                      role="separator"
                      tabIndex={0}
                      aria-orientation="horizontal"
                      aria-valuenow={requestPaneHeight}
                      aria-valuemin={MIN_REQUEST_PANE_HEIGHT}
                      aria-label="Resize request and response panels"
                      title="Drag up/down to resize request & response (Double-click to reset)"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleStartSplitResize(e.clientY);
                      }}
                      onTouchStart={handleTouchStartSplitResize}
                      onDoubleClick={handleResetSplit}
                      onKeyDown={handleSplitKeyDown}
                      className={`relative z-20 flex h-2 shrink-0 cursor-row-resize items-center justify-center select-none group transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500 ${
                        isResizingSplit ? 'bg-sky-500/20' : 'hover:bg-sky-500/10'
                      }`}
                    >
                      <div
                        className={`w-full h-[2px] transition-colors duration-150 ${
                          isResizingSplit ? 'bg-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.5)]' : 'bg-line group-hover:bg-sky-400'
                        }`}
                      />
                      <div
                        className={`pointer-events-none absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 rounded-full border border-line bg-card/95 px-2.5 py-0.5 text-[10px] font-mono text-tx-secondary shadow-md backdrop-blur transition-opacity duration-150 ${
                          isResizingSplit ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                        }`}
                      >
                        <GripHorizontal className="h-3 w-3 text-sky-400" />
                        <span>{requestPaneHeight}px</span>
                      </div>
                    </div>
                  )}

                  {/* Bottom Pane: Response (Status, Headers, Body) */}
                  <div className={`flex flex-1 min-h-0 flex-col ${isDesktop ? 'overflow-hidden' : ''}`}>
                    <ResponseViewer />
                  </div>
                </div>
              ) : (
                <EmptyStudioView onCreateTab={() => createTab()} />
              )}
            </ErrorBoundary>
          </main>
        </div>

        {/* Workspace Switching Loading Overlay */}
        {isSwitchingWorkspace && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-[2px] animate-in fade-in duration-150">
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-white" />
              <span className="text-xs font-medium text-zinc-300">Loading workspace...</span>
            </div>
          </div>
        )}
        {storageUpdateAvailable && !isSwitchingWorkspace && (
          <div className="fixed bottom-4 right-4 z-50 flex max-w-sm items-center gap-3 rounded-xl border border-sky-500/30 bg-zinc-900 p-3 text-xs text-zinc-200 shadow-xl">
            <span>Shared storage changed in another window.</span>
            <button
              type="button"
              onClick={async () => {
                await activeStore.persist.rehydrate();
                setStorageUpdateAvailable(false);
              }}
              className="shrink-0 rounded-md bg-sky-500 px-2.5 py-1 font-semibold text-zinc-950 hover:bg-sky-400"
            >
              Reload
            </button>
          </div>
        )}
      </div>
    </ErrorBoundary>
  );
};

export default App;
