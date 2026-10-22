'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Plus, X, Layers, ArrowRight, Trash2, Copy } from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import { MethodBadge } from './MethodBadge';
import { isRequestModified } from '@/lib/requestDiff';

interface ContextMenuPosition {
  x: number;
  y: number;
  tabId?: string;
}

export const TabBar: React.FC = () => {
  const tabs = useApiStore((state) => state.tabs);
  const collections = useApiStore((state) => state.collections);
  const activeTabId = useApiStore((state) => state.activeTabId);
  const setActiveTabId = useApiStore((state) => state.setActiveTabId);
  const createTab = useApiStore((state) => state.createTab);
  const closeTab = useApiStore((state) => state.closeTab);
  const closeOtherTabs = useApiStore((state) => state.closeOtherTabs);
  const closeAllTabs = useApiStore((state) => state.closeAllTabs);
  const closeTabsToRight = useApiStore((state) => state.closeTabsToRight);
  const duplicateTab = useApiStore((state) => state.duplicateTab);

  const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close context menu on click outside or Escape key
  useEffect(() => {
    if (!contextMenu) return;

    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
      }
    };

    const handleWindowBlur = () => setContextMenu(null);

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('resize', handleWindowBlur);

    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('resize', handleWindowBlur);
    };
  }, [contextMenu]);

  const handleTabContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const menuWidth = 200;
    const menuHeight = 220;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 10);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 10);
    setContextMenu({ x, y, tabId });
  };

  const handleBarContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const menuWidth = 200;
    const menuHeight = 110;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 10);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 10);
    setContextMenu({ x, y });
  };

  const handleTabAuxClick = (e: React.MouseEvent, tabId: string) => {
    // Middle click closes tab
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      closeTab(tabId);
    }
  };

  const activeContextTabIndex = contextMenu?.tabId
    ? tabs.findIndex((t) => t.id === contextMenu.tabId)
    : -1;
  const isOnlyTab = tabs.length <= 1;
  const isLastTab = activeContextTabIndex === tabs.length - 1;

  return (
    <>
      <div
        onContextMenu={handleBarContextMenu}
        className="flex h-10 w-full items-center border-b border-zinc-800 bg-zinc-950 px-2 overflow-x-auto scrollbar-none"
      >
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {tabs.filter(Boolean).map((tab) => {
            const isActive = tab.id === activeTabId;
            const displayName = tab.name || tab.url || 'Untitled Request';
            const isDirty = isRequestModified(tab, collections);

            return (
              <div
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                onContextMenu={(e) => handleTabContextMenu(e, tab.id)}
                onAuxClick={(e) => handleTabAuxClick(e, tab.id)}
                className={`group flex items-center gap-2 max-w-[205px] cursor-pointer rounded-t-lg border-t-2 px-3 py-1.5 text-xs font-medium transition-all select-none ${
                  isActive
                    ? 'border-sky-500 bg-zinc-900 text-zinc-100 shadow-sm'
                    : 'border-transparent bg-zinc-950/40 text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                }`}
              >
                <MethodBadge method={tab.method} size="sm" />
                <span className="truncate max-w-[105px]" title={displayName}>
                  {displayName}
                </span>

                {isDirty && (
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0 shadow-sm shadow-amber-400/50"
                    title="Unsaved changes"
                  />
                )}

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  className="ml-auto rounded p-0.5 text-zinc-500 opacity-60 hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100 transition"
                  title="Close tab"
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

      {/* Right-click Context Menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          style={{ top: contextMenu.y, left: contextMenu.x }}
          className="fixed z-50 min-w-[190px] rounded-xl border border-zinc-800 bg-zinc-950/95 p-1 shadow-2xl backdrop-blur-xl ring-1 ring-white/10 select-none animate-in fade-in zoom-in-95 duration-100"
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.tabId ? (
            <>
              <button
                onClick={() => {
                  closeTab(contextMenu.tabId!);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800/80 hover:text-zinc-100 transition text-left"
              >
                <X className="h-3.5 w-3.5 text-zinc-400" />
                <span>Close Tab</span>
              </button>

              <button
                disabled={isOnlyTab}
                onClick={() => {
                  closeOtherTabs(contextMenu.tabId!);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800/80 hover:text-zinc-100 transition disabled:opacity-35 disabled:cursor-not-allowed text-left"
              >
                <Layers className="h-3.5 w-3.5 text-zinc-400" />
                <span>Close Other Tabs</span>
              </button>

              <button
                disabled={isLastTab}
                onClick={() => {
                  closeTabsToRight(contextMenu.tabId!);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800/80 hover:text-zinc-100 transition disabled:opacity-35 disabled:cursor-not-allowed text-left"
              >
                <ArrowRight className="h-3.5 w-3.5 text-zinc-400" />
                <span>Close Tabs to the Right</span>
              </button>

              <button
                onClick={() => {
                  closeAllTabs();
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-rose-400/90 hover:bg-rose-500/10 hover:text-rose-300 transition text-left"
              >
                <Trash2 className="h-3.5 w-3.5 text-rose-400/80" />
                <span>Close All Tabs</span>
              </button>

              <div className="h-px bg-zinc-850 my-1 mx-1" />

              <button
                onClick={() => {
                  duplicateTab(contextMenu.tabId!);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800/80 hover:text-zinc-100 transition text-left"
              >
                <Copy className="h-3.5 w-3.5 text-zinc-400" />
                <span>Duplicate Tab</span>
              </button>

              <button
                onClick={() => {
                  createTab();
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800/80 hover:text-zinc-100 transition text-left"
              >
                <Plus className="h-3.5 w-3.5 text-zinc-400" />
                <span>New Request Tab</span>
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  createTab();
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800/80 hover:text-zinc-100 transition text-left"
              >
                <Plus className="h-3.5 w-3.5 text-zinc-400" />
                <span>New Request Tab</span>
              </button>

              <button
                onClick={() => {
                  closeAllTabs();
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-rose-400/90 hover:bg-rose-500/10 hover:text-rose-300 transition text-left"
              >
                <Trash2 className="h-3.5 w-3.5 text-rose-400/80" />
                <span>Close All Tabs</span>
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
};

