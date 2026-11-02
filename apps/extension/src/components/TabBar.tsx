'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Plus, X, Layers, ArrowRight, Trash2, Copy, MoreVertical, AlertTriangle, Bookmark } from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import { MethodBadge } from './MethodBadge';
import { isRequestModified, findSavedRequestInCollections, flattenCollectionRequests } from '@/lib/requestDiff';
import { useBackHandler } from '@airrest/common';
import { hasScopePermission, canModifyCollection } from '@/lib/jwt';
import { SaveToCollectionModal } from './SaveToCollectionModal';
import { ApiRequest } from '@/types/api';

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
  const saveRequestToCollection = useApiStore((state) => state.saveRequestToCollection);
  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);

  const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(null);
  const [unsavedConfirmTab, setUnsavedConfirmTab] = useState<ApiRequest | null>(null);
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [targetSaveTab, setTargetSaveTab] = useState<ApiRequest | null>(null);

  useBackHandler(Boolean(contextMenu), () => setContextMenu(null), 15);
  useBackHandler(Boolean(unsavedConfirmTab), () => setUnsavedConfirmTab(null), 30);

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

  // Close unsaved confirm modal on Escape key
  useEffect(() => {
    if (!unsavedConfirmTab) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setUnsavedConfirmTab(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [unsavedConfirmTab]);

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

  const handleRequestCloseTab = (tabId: string) => {
    const targetTab = (tabs || []).find((t) => t.id === tabId);
    if (!targetTab) return;

    const isDirty = isRequestModified(targetTab, collections);
    if (isDirty) {
      setUnsavedConfirmTab(targetTab);
    } else {
      closeTab(tabId);
    }
  };

  const handleTabAuxClick = (e: React.MouseEvent, tabId: string) => {
    // Middle click closes tab
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      handleRequestCloseTab(tabId);
    }
  };

  const handleConfirmDiscard = () => {
    if (!unsavedConfirmTab) return;
    const id = unsavedConfirmTab.id;
    setUnsavedConfirmTab(null);
    closeTab(id);
  };

  const handleCancelClose = () => {
    setUnsavedConfirmTab(null);
  };

  const handleConfirmSave = () => {
    if (!unsavedConfirmTab) return;
    const tabToSave = unsavedConfirmTab;

    const savedInfo = findSavedRequestInCollections(collections, tabToSave.id);
    const canWriteScope = hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role);
    const isCollectionReadOnly = savedInfo ? !canModifyCollection(savedInfo.collection.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role) : false;

    if (savedInfo && canWriteScope && !isCollectionReadOnly) {
      const currentMethod = (tabToSave.method || 'GET').toUpperCase();
      const currentName = (tabToSave.name || 'Untitled Request').trim().toLowerCase();
      const existingReqs = flattenCollectionRequests(savedInfo.collection.items || []);
      const hasCollisionWithAnother = existingReqs.some(
        (r) =>
          r.id !== tabToSave.id &&
          r.request?.id !== tabToSave.id &&
          (r.method || 'GET').toUpperCase() === currentMethod &&
          r.name.trim().toLowerCase() === currentName
      );

      if (!hasCollisionWithAnother) {
        saveRequestToCollection(savedInfo.collection.id, savedInfo.folderId, tabToSave);
        setUnsavedConfirmTab(null);
        closeTab(tabToSave.id);
        return;
      }
    }

    // Opens SaveToCollectionModal for choosing collection / resolving collision / save-as
    setTargetSaveTab(tabToSave);
    setUnsavedConfirmTab(null);
    setIsSaveModalOpen(true);
  };

  const safeTabs = tabs || [];
  const activeContextTabIndex = contextMenu?.tabId
    ? safeTabs.findIndex((t) => t.id === contextMenu.tabId)
    : -1;
  const isOnlyTab = safeTabs.length <= 1;
  const isLastTab = activeContextTabIndex === safeTabs.length - 1;

  return (
    <>
      <div
        onContextMenu={handleBarContextMenu}
        className="flex h-8 w-full items-center border-b border-line bg-surface px-2 overflow-x-auto scrollbar-none"
      >
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {safeTabs.filter(Boolean).map((tab) => {
            const isActive = tab.id === activeTabId;
            const displayName = tab.name || tab.url || 'Untitled Request';
            const isDirty = isRequestModified(tab, collections);
            const saved = findSavedRequestInCollections(collections, tab.id);
            const tabTitle = saved
              ? `${displayName} (${saved.collection.name})`
              : displayName;

            return (
              <div
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                onContextMenu={(e) => handleTabContextMenu(e, tab.id)}
                onAuxClick={(e) => handleTabAuxClick(e, tab.id)}
                className={`group flex items-center gap-1.5 max-w-[205px] cursor-pointer rounded-t-md border-t-2 px-2.5 py-1 text-xs font-medium transition-all select-none ${isActive
                    ? 'border-sky-500 bg-card text-tx-primary shadow-xs'
                    : 'border-transparent bg-element/50 text-tx-muted hover:bg-hover hover:text-tx-primary'
                  }`}
              >
                <MethodBadge method={tab.method} size="sm" />
                <span className="truncate max-w-[105px]" title={tabTitle}>
                  {displayName}
                </span>

                {isDirty && (
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0 shadow-sm shadow-amber-400/50"
                    title="Unsaved changes"
                  />
                )}

                <button
                  type="button"
                  aria-label={`Actions for ${displayName}`}
                  className="rounded p-1 text-tx-muted hover:bg-hover md:hidden"
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setContextMenu({
                      x: Math.max(10, Math.min(rect.left, window.innerWidth - 210)),
                      y: Math.max(10, Math.min(rect.bottom, window.innerHeight - 230)),
                      tabId: tab.id,
                    });
                  }}
                ><MoreVertical className="h-4 w-4" /></button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRequestCloseTab(tab.id);
                  }}
                  className="ml-auto rounded p-0.5 text-tx-muted opacity-60 hover:bg-hover hover:text-tx-primary group-hover:opacity-100 transition"
                  title="Close tab"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}

          <button
            onClick={() => createTab()}
            className="flex h-6 w-6 items-center justify-center rounded-md text-tx-muted hover:bg-hover hover:text-tx-primary transition"
            title="Create New Request Tab"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Right-click Context Menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          style={{ top: contextMenu.y, left: contextMenu.x }}
          className="fixed z-50 min-w-[190px] rounded-xl border border-line bg-surface/95 p-1 shadow-2xl backdrop-blur-xl ring-1 ring-black/5 dark:ring-white/10 select-none animate-in fade-in zoom-in-95 duration-100"
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.tabId ? (
            <>
              <button
                type="button"
                onClick={() => {
                  const id = contextMenu.tabId!;
                  setContextMenu(null);
                  handleRequestCloseTab(id);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition text-left cursor-pointer"
              >
                <X className="h-3.5 w-3.5 text-tx-muted" />
                <span>Close Tab</span>
              </button>

              <button
                type="button"
                disabled={isOnlyTab}
                onClick={() => {
                  closeOtherTabs(contextMenu.tabId!);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition disabled:opacity-35 disabled:cursor-not-allowed text-left"
              >
                <Layers className="h-3.5 w-3.5 text-tx-muted" />
                <span>Close Other Tabs</span>
              </button>

              <button
                type="button"
                disabled={isLastTab}
                onClick={() => {
                  closeTabsToRight(contextMenu.tabId!);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition disabled:opacity-35 disabled:cursor-not-allowed text-left"
              >
                <ArrowRight className="h-3.5 w-3.5 text-tx-muted" />
                <span>Close Tabs to the Right</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  closeAllTabs();
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 hover:text-rose-700 dark:hover:text-rose-300 transition text-left"
              >
                <Trash2 className="h-3.5 w-3.5 text-rose-500 dark:text-rose-400/80" />
                <span>Close All Tabs</span>
              </button>

              <div className="h-px bg-line my-1 mx-1" />

              <button
                type="button"
                onClick={() => {
                  duplicateTab(contextMenu.tabId!);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition text-left"
              >
                <Copy className="h-3.5 w-3.5 text-tx-muted" />
                <span>Duplicate Tab</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  createTab();
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition text-left"
              >
                <Plus className="h-3.5 w-3.5 text-tx-muted" />
                <span>New Request Tab</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  createTab();
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition text-left"
              >
                <Plus className="h-3.5 w-3.5 text-tx-muted" />
                <span>New Request Tab</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  closeAllTabs();
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 hover:text-rose-700 dark:hover:text-rose-300 transition text-left"
              >
                <Trash2 className="h-3.5 w-3.5 text-rose-500 dark:text-rose-400/80" />
                <span>Close All Tabs</span>
              </button>
            </>
          )}
        </div>
      )}

      {/* Unsaved Changes Confirmation Modal */}
      {unsavedConfirmTab && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCancelClose();
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150 select-none"
        >
          <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-start gap-3.5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-500 dark:text-amber-400">
                <AlertTriangle className="h-5 w-5" />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-bold text-tx-primary">Unsaved Changes</h3>
                  <button
                    type="button"
                    onClick={handleCancelClose}
                    className="rounded-lg p-1 text-tx-muted hover:bg-hover hover:text-tx-primary transition"
                    title="Cancel"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-2 text-xs leading-relaxed text-tx-muted">
                  Do you want to save the changes made to{' '}
                  <span className="font-semibold text-tx-primary font-mono">
                    "{unsavedConfirmTab.name || unsavedConfirmTab.url || 'Untitled Request'}"
                  </span>
                  ?
                  <p className="mt-1 text-[11px] text-tx-muted">
                    Your changes will be lost if you close this tab without saving.
                  </p>
                </div>

                {/* Tab Method & Target Preview */}
                <div className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-card/60 px-3 py-2">
                  <MethodBadge method={unsavedConfirmTab.method} size="sm" />
                  <span className="font-mono text-xs text-tx-primary truncate">
                    {unsavedConfirmTab.url || 'No URL specified'}
                  </span>
                </div>
              </div>
            </div>

            {/* 3 Action Buttons: Cancel, Close Tab, Save */}
            <div className="mt-6 flex flex-wrap items-center justify-end gap-2.5 pt-2 border-t border-line">
              <button
                type="button"
                onClick={handleCancelClose}
                className="rounded-xl border border-line bg-card px-3.5 py-2 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition cursor-pointer"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={handleConfirmDiscard}
                className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2 text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 transition cursor-pointer"
                title="Close tab without saving"
              >
                Close Tab
              </button>

              <button
                type="button"
                onClick={handleConfirmSave}
                className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-sky-500/20 hover:from-sky-400 hover:to-blue-500 active:scale-95 transition cursor-pointer"
                title="Save changes and close tab"
              >
                <Bookmark className="h-3.5 w-3.5" />
                <span>Save</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save to Collection Modal when saving from Tab close */}
      {targetSaveTab && (
        <SaveToCollectionModal
          isOpen={isSaveModalOpen}
          onClose={() => {
            setIsSaveModalOpen(false);
            setTargetSaveTab(null);
          }}
          onSaved={() => {
            if (targetSaveTab) {
              closeTab(targetSaveTab.id);
              setTargetSaveTab(null);
            }
          }}
          request={targetSaveTab}
        />
      )}
    </>
  );
};
