import React, { useState, useEffect, useRef } from 'react';
import { GripHorizontal, Terminal, CheckCircle2, FileJson } from 'lucide-react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { RequestEditor } from './components/RequestEditor';
import { ResponseViewer } from './components/ResponseViewer';
import { SavedExampleViewer } from './components/SavedExampleViewer';
import { EmptyStudioView } from './components/EmptyStudioView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ImportModal } from './components/ImportModal';
import { useApiStore } from './store/useApiStore';
import { isCloudSessionActive } from './workspace/cloudSession';
import { useStoreContext } from './store/storeContext';
import { onStorageCommit } from './lib/storage';
import { useBackHandler } from './lib/backNavigation';
import { applyTheme, subscribeToSystemTheme } from './lib/theme';
import { tryParseCurlCommand } from './lib/curl';
import { OpenedFileResult } from './types/platform';
import {
  evaluateWindowFileDrop,
  isEditableTarget,
  isJsonCandidateFile,
  isStrictPostmanImportJson,
  readBrowserFiles,
} from './lib/importBatch';
import {
  queueInitialRequestEditorSection,
  resolveInitialCurlSection,
} from './components/requestEditorSectionState';
import { hasOpenBlockingModal } from './components/tabBarShortcuts';

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
  const selectedExample = activeStore((state) => state.selectedExample);
  const createTab = activeStore((state) => state.createTab);
  const workspaceMode = activeStore((state) => state.workspaceMode);
  const cloudToken = activeStore((state) => state.cloudConfig.token);
  const cloudSessionActive = activeStore((state) => isCloudSessionActive(state.cloudConfig));
  const activeScope = activeStore((state) => state.cloudConfig.activeScope);
  const pullCloudDelta = activeStore((state) => state.pullCloudDelta);
  const refreshFeaturePolicy = activeStore((state) => state.refreshFeaturePolicy);
  const theme = activeStore((state) => state.theme || 'system');
  const hasInitialPulledRef = useRef(false);
  const [curlPasteNotice, setCurlPasteNotice] = useState<{ method: string; url: string } | null>(null);
  const curlPasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [globalImportFiles, setGlobalImportFiles] = useState<OpenedFileResult[] | null>(null);
  const [isWindowFileDragActive, setIsWindowFileDragActive] = useState(false);
  const windowDragDepthRef = useRef(0);
  useEffect(() => {
    if (!selectedExample) return;
    const blockExampleShortcut = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'enter' || key === 's') {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', blockExampleShortcut, true);
    return () => window.removeEventListener('keydown', blockExampleShortcut, true);
  }, [selectedExample]);
  useBackHandler(sidebarOpen, () => setSidebarOpen(false), 10);

  useEffect(() => {
    let isDisposed = false;
    const showCurlToast = (method: string, url: string) => {
      if (curlPasteTimerRef.current) {
        clearTimeout(curlPasteTimerRef.current);
      }
      setCurlPasteNotice({ method, url });
      curlPasteTimerRef.current = setTimeout(() => {
        setCurlPasteNotice(null);
        curlPasteTimerRef.current = null;
      }, 2600);
    };

    const handleCurlPastedEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ method?: string; url?: string }>).detail;
      if (detail?.url) {
        showCurlToast(detail.method || 'GET', detail.url);
      }
    };

    const handleGlobalPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || !hasHydrated || isSwitchingWorkspace) return;

      // Do not intercept paste when a modal dialog (e.g. ImportModal, EnvironmentModal, Auth) is open
      if (hasOpenBlockingModal()) {
        return;
      }

      // 1. Pasted .json file(s) from OS file explorer
      const pastedJsonFiles = Array.from(event.clipboardData?.files || []).filter(isJsonCandidateFile);
      if (pastedJsonFiles.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        void readBrowserFiles(pastedJsonFiles).then((opened) => {
          if (isDisposed || hasOpenBlockingModal() || activeStore.getState().isSwitchingWorkspace) return;
          if (opened.length > 0) {
            setGlobalImportFiles(opened);
          }
        });
        return;
      }

      const pastedText = event.clipboardData?.getData('text/plain') || '';
      const isEditing =
        isEditableTarget(event.target) ||
        isEditableTarget(typeof document !== 'undefined' ? document.activeElement : null);

      // 2. Pasted cURL command (only outside editable fields/multiline editors; URL bar has its own handler)
      if (!isEditing) {
        const parsedCurl = tryParseCurlCommand(pastedText);
        if (parsedCurl) {
          event.preventDefault();
          event.stopPropagation();

          const targetSection = resolveInitialCurlSection(parsedCurl);
          createTab(parsedCurl);
          const newTabId = activeStore.getState().activeTabId;
          if (newTabId) {
            queueInitialRequestEditorSection(newTabId, targetSection);
          }
          try {
            localStorage.setItem('airrest:request_config_collapsed', 'false');
          } catch {
            // ignore
          }
          window.dispatchEvent(
            new CustomEvent('airrest:curl-pasted', {
              detail: {
                tabId: newTabId,
                section: targetSection,
                method: parsedCurl.method || 'GET',
                url: parsedCurl.url || '',
              },
            })
          );
          return;
        }
      }

      // 3. Pasted Postman Collection or Environment JSON text (only outside editable inputs/editors)
      if (!isEditing && isStrictPostmanImportJson(pastedText)) {
        event.preventDefault();
        event.stopPropagation();
        setGlobalImportFiles([{ filename: 'pasted.json', content: pastedText }]);
      }
    };

    window.addEventListener('airrest:curl-pasted', handleCurlPastedEvent);
    window.addEventListener('paste', handleGlobalPaste, true);
    return () => {
      isDisposed = true;
      window.removeEventListener('airrest:curl-pasted', handleCurlPastedEvent);
      window.removeEventListener('paste', handleGlobalPaste, true);
    };
  }, [hasHydrated, isSwitchingWorkspace, createTab, activeStore]);

  useEffect(() => {
    let isDisposed = false;
    const hasDraggedFiles = (dt: DataTransfer | null | undefined): boolean => {
      if (!dt) return false;
      if (dt.types && Array.from(dt.types).includes('Files')) return true;
      return Boolean(dt.files && dt.files.length > 0);
    };

    const resetDragState = () => {
      windowDragDepthRef.current = 0;
      setIsWindowFileDragActive(false);
    };

    const handleDragEnter = (event: DragEvent) => {
      if (!hasHydrated || isSwitchingWorkspace || hasOpenBlockingModal()) return;
      if (!hasDraggedFiles(event.dataTransfer)) return;
      windowDragDepthRef.current += 1;
      setIsWindowFileDragActive(true);
    };

    const handleDragOver = (event: DragEvent) => {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      if (!event.defaultPrevented) {
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect =
            !hasHydrated || isSwitchingWorkspace || hasOpenBlockingModal() ? 'none' : 'copy';
        }
      }
    };

    const handleDragLeave = (event: DragEvent) => {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      windowDragDepthRef.current = Math.max(0, windowDragDepthRef.current - 1);
      if (windowDragDepthRef.current === 0) {
        setIsWindowFileDragActive(false);
      }
    };

    const handleDropCapture = () => {
      resetDragState();
    };

    const handleWindowDrop = (event: DragEvent) => {
      resetDragState();
      const decision = evaluateWindowFileDrop(event, {
        hasHydrated,
        isSwitchingWorkspace: Boolean(isSwitchingWorkspace),
        hasBlockingModal: hasOpenBlockingModal(),
      });
      if (!decision.shouldProcess) {
        return;
      }

      void readBrowserFiles(decision.files, { requireJsonExtension: true }).then((opened) => {
        if (isDisposed || hasOpenBlockingModal() || activeStore.getState().isSwitchingWorkspace) return;
        if (opened.length > 0) {
          setGlobalImportFiles(opened);
        }
      });
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDropCapture, true);
    window.addEventListener('drop', handleWindowDrop);
    window.addEventListener('dragend', resetDragState);
    window.addEventListener('blur', resetDragState);
    return () => {
      isDisposed = true;
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDropCapture, true);
      window.removeEventListener('drop', handleWindowDrop);
      window.removeEventListener('dragend', resetDragState);
      window.removeEventListener('blur', resetDragState);
    };
  }, [hasHydrated, isSwitchingWorkspace, activeStore]);

  useEffect(() => {
    return () => {
      if (curlPasteTimerRef.current) {
        clearTimeout(curlPasteTimerRef.current);
      }
    };
  }, []);

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
    if (!hasHydrated || workspaceMode !== 'cloud' || !cloudSessionActive || !activeScope) return;
    if (hasInitialPulledRef.current) return;
    hasInitialPulledRef.current = true;
    void pullCloudDelta();
  }, [hasHydrated, workspaceMode, cloudToken, cloudSessionActive, activeScope, pullCloudDelta]);

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
    if (workspaceMode !== 'cloud' || !cloudSessionActive) return;

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
  }, [workspaceMode, cloudToken, cloudSessionActive, refreshFeaturePolicy]);

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
              {selectedExample ? (
                <SavedExampleViewer />
              ) : tabs && tabs.length > 0 ? (
                <div
                  ref={studioContainerRef}
                  className="relative flex flex-1 flex-col overflow-hidden"
                >
                  {/* Top Pane: Request (URL Bar, Params, Headers, Auth, Body, Scripts) */}
                  <div
                    className={`flex flex-col min-h-0 ${isDesktop ? 'shrink-0' : 'flex-1'} ${isDesktop && !isRequestCollapsed ? 'overflow-y-auto' : ''}`}
                    style={{
                      height: isDesktop
                        ? isRequestCollapsed
                          ? 'auto'
                          : `${requestPaneHeight}px`
                        : undefined,
                    }}
                  >
                    <RequestEditor
                      onCollapseChange={setIsRequestCollapsed}
                      mobileScrollContent={!isDesktop ? <ResponseViewer /> : undefined}
                    />
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

                  {/* Bottom Pane: Response (Desktop only; mobile renders inside RequestEditor's scroll region below URL bar) */}
                  {isDesktop && (
                    <div className="flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden">
                      <ResponseViewer />
                    </div>
                  )}
                </div>
              ) : (
                <EmptyStudioView onCreateTab={() => createTab()} />
              )}
            </ErrorBoundary>
          </main>
        </div>

        {/* Workspace Switching Loading Overlay */}
        {isSwitchingWorkspace && (
          <div data-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-[2px] animate-in fade-in duration-150">
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
        {curlPasteNotice && !isSwitchingWorkspace && (
          <div
            role="status"
            aria-live="polite"
            className="fixed bottom-4 right-4 z-50 flex max-w-md items-center gap-2.5 rounded-xl border border-emerald-500/30 bg-card/95 px-3.5 py-2.5 text-xs text-tx-primary shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-150"
          >
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-500 dark:text-emerald-400 border border-emerald-500/25">
              <Terminal className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 font-semibold text-tx-primary">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400 shrink-0" />
                <span>Opened cURL as New Request</span>
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-tx-muted">
                <span className="font-bold text-sky-500 dark:text-sky-400">{curlPasteNotice.method}</span>{' '}
                <span>{curlPasteNotice.url}</span>
              </div>
            </div>
          </div>
        )}
        {isWindowFileDragActive && !isSwitchingWorkspace && (
          <div
            aria-hidden="true"
            data-non-blocking-overlay="true"
            className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[2px] p-6 animate-in fade-in duration-150"
          >
            <div className="flex max-w-md flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-sky-400/80 bg-surface/95 px-8 py-7 text-center shadow-2xl">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-sky-500/30 bg-sky-500/15 text-sky-500 dark:text-sky-400">
                <FileJson className="h-6 w-6" />
              </div>
              <div>
                <p className="text-sm font-semibold text-tx-primary">
                  Drop Postman .json files to import
                </p>
                <p className="mt-1 text-xs text-tx-muted">
                  Collections and Environments will open in a checklist preview
                </p>
              </div>
            </div>
          </div>
        )}
        <ImportModal
          isOpen={Boolean(globalImportFiles)}
          initialFiles={globalImportFiles}
          onClose={() => setGlobalImportFiles(null)}
        />
      </div>
    </ErrorBoundary>
  );
};

export default App;
