'use client';

import React from 'react';
import { Plus, X } from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import { MethodBadge } from './MethodBadge';

export const TabBar: React.FC = () => {
  const tabs = useApiStore((state) => state.tabs);
  const activeTabId = useApiStore((state) => state.activeTabId);
  const setActiveTabId = useApiStore((state) => state.setActiveTabId);
  const createTab = useApiStore((state) => state.createTab);
  const closeTab = useApiStore((state) => state.closeTab);

  return (
    <div className="flex h-10 w-full items-center border-b border-zinc-800 bg-zinc-950 px-2 overflow-x-auto scrollbar-none">
      <div className="flex items-center gap-1.5 flex-1 min-w-0">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const displayName = tab.name || tab.url || 'Untitled Request';

          return (
            <div
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              className={`group flex items-center gap-2 max-w-[200px] cursor-pointer rounded-t-lg border-t-2 px-3 py-1.5 text-xs font-medium transition-all select-none ${
                isActive
                  ? 'border-sky-500 bg-zinc-900 text-zinc-100 shadow-sm'
                  : 'border-transparent bg-zinc-950/40 text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
              }`}
            >
              <MethodBadge method={tab.method} size="sm" />
              <span className="truncate max-w-[110px]" title={displayName}>
                {displayName}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="ml-auto rounded p-0.5 text-zinc-500 opacity-60 hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100 transition"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}

        <button
          onClick={() => createTab()}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 transition"
          title="Create New Request Tab"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};
