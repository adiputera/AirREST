'use client';

import React from 'react';
import { Header } from '@/components/Header';
import { Sidebar } from '@/components/Sidebar';
import { TabBar } from '@/components/TabBar';
import { RequestEditor } from '@/components/RequestEditor';
import { ResponseViewer } from '@/components/ResponseViewer';

const emptySubscribe = () => () => {};

function useMounted() {
  return React.useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

export default function Home() {
  const mounted = useMounted();

  if (!mounted) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-zinc-950 text-zinc-400 font-mono text-xs">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-sky-500 border-t-transparent" />
          <span>Initializing API Studio...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100 select-none">
      {/* Top Application Header */}
      <Header />

      {/* Main Workspace Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar (Collections & History) */}
        <Sidebar />

        {/* Right Studio Panel (Tabs, Request, Response) */}
        <main className="flex flex-1 flex-col overflow-hidden bg-zinc-950">
          <TabBar />
          <div className="flex flex-1 flex-col overflow-y-auto">
            <RequestEditor />
            <ResponseViewer />
          </div>
        </main>
      </div>
    </div>
  );
}
