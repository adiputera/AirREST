import React, { useState, useEffect } from 'react';
import { Header } from '@/components/Header';
import { Sidebar } from '@/components/Sidebar';
import { TabBar } from '@/components/TabBar';
import { RequestEditor } from '@/components/RequestEditor';
import { ResponseViewer } from '@/components/ResponseViewer';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useApiStore } from '@/store/useApiStore';

export const App: React.FC = () => {
  const [hasHydrated, setHasHydrated] = useState(() => useApiStore.persist.hasHydrated());
  const isSwitchingWorkspace = useApiStore((state) => state.isSwitchingWorkspace);

  useEffect(() => {
    if (useApiStore.persist.hasHydrated()) {
      setHasHydrated(true);
      return;
    }
    const unsub = useApiStore.persist.onFinishHydration(() => {
      setHasHydrated(true);
    });
    return () => unsub();
  }, []);

  if (!hasHydrated) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-zinc-950 text-zinc-400">
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
          <span className="text-sm font-medium">Loading AirREST...</span>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary fallbackTitle="AirREST Workspace Error">
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100 select-none relative">
        {/* Top Application Header */}
        <ErrorBoundary fallbackTitle="Header Error">
          <Header />
        </ErrorBoundary>

        {/* Main Workspace Body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left Sidebar (Collections & History) */}
          <ErrorBoundary fallbackTitle="Sidebar Error">
            <Sidebar />
          </ErrorBoundary>

          {/* Right Studio Panel (Tabs, Request, Response) */}
          <main className="flex flex-1 flex-col overflow-hidden bg-zinc-950">
            <ErrorBoundary fallbackTitle="Studio Panel Error">
              <TabBar />
              <div className="flex flex-1 flex-col overflow-y-auto">
                <RequestEditor />
                <ResponseViewer />
              </div>
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
      </div>
    </ErrorBoundary>
  );
};

export default App;
