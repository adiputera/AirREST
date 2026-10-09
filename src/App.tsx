import React from 'react';
import { Header } from '@/components/Header';
import { Sidebar } from '@/components/Sidebar';
import { TabBar } from '@/components/TabBar';
import { RequestEditor } from '@/components/RequestEditor';
import { ResponseViewer } from '@/components/ResponseViewer';

export const App: React.FC = () => {
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
};

export default App;
