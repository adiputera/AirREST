'use client';

import React, { useState } from 'react';
import {
  Folder,
  FolderOpen,
  Clock,
  Trash2,
  ChevronRight,
  ChevronDown,
  Search,
  FolderPlus,
  Layers,
  ArrowUpRight,
  Download,
} from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import { CollectionItem, ApiRequest, Collection } from '@/types/api';
import { MethodBadge } from './MethodBadge';
import { exportPostmanCollection } from '@/lib/postman';
import { ConfirmModal } from './ConfirmModal';

function filterCollectionItems(items: CollectionItem[], query: string): CollectionItem[] {
  return items
    .map((item) => {
      if (item.type === 'folder') {
        const matchingChildren = item.items ? filterCollectionItems(item.items, query) : [];
        if (matchingChildren.length > 0 || item.name.toLowerCase().includes(query)) {
          return {
            ...item,
            items: matchingChildren.length > 0 ? matchingChildren : item.items,
          };
        }
        return null;
      }
      if (item.type === 'request') {
        const matches =
          item.name.toLowerCase().includes(query) ||
          (item.request &&
            (item.request.url.toLowerCase().includes(query) ||
              item.request.method.toLowerCase().includes(query)));
        return matches ? item : null;
      }
      return null;
    })
    .filter((item): item is CollectionItem => item !== null);
}

interface FolderItemProps {
  item: CollectionItem;
  level?: number;
  onSelectRequest: (req: ApiRequest) => void;
}

const FolderItem: React.FC<FolderItemProps> = ({ item, level = 0, onSelectRequest }) => {
  const [isOpen, setIsOpen] = useState(true);

  if (item.type === 'folder') {
    return (
      <div className="select-none">
        <div
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-1.5 py-1 px-2 rounded-md hover:bg-zinc-900/80 text-zinc-300 hover:text-white cursor-pointer text-xs font-medium transition"
          style={{ paddingLeft: `${Math.max(level * 12, 8)}px` }}
        >
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
          )}
          {isOpen ? (
            <FolderOpen className="h-3.5 w-3.5 text-sky-400 shrink-0" />
          ) : (
            <Folder className="h-3.5 w-3.5 text-sky-400 shrink-0" />
          )}
          <span className="truncate">{item.name}</span>
          <span className="ml-auto text-[10px] text-zinc-500">
            {item.items?.length || 0}
          </span>
        </div>

        {isOpen && item.items && item.items.length > 0 && (
          <div className="border-l border-zinc-800/60 ml-3.5 mt-0.5">
            {item.items.map((child) => (
              <FolderItem
                key={child.id}
                item={child}
                level={level + 1}
                onSelectRequest={onSelectRequest}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Request item
  if (!item.request) return null;

  return (
    <div
      onClick={() => onSelectRequest(item.request!)}
      className="group flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-zinc-900 text-zinc-300 hover:text-white cursor-pointer text-xs transition"
      style={{ paddingLeft: `${Math.max(level * 12, 8)}px` }}
    >
      <MethodBadge method={item.request.method} size="sm" />
      <span className="truncate flex-1 group-hover:text-zinc-100" title={item.name}>
        {item.name}
      </span>
      <ArrowUpRight className="h-3 w-3 text-zinc-600 opacity-0 group-hover:opacity-100 transition shrink-0" />
    </div>
  );
};

export const Sidebar: React.FC = () => {
  const sidebarTab = useApiStore((state) => state.sidebarTab);
  const setSidebarTab = useApiStore((state) => state.setSidebarTab);
  const collections = useApiStore((state) => state.collections);
  const history = useApiStore((state) => state.history);
  const deleteCollection = useApiStore((state) => state.deleteCollection);
  const createCollection = useApiStore((state) => state.createCollection);
  const clearHistory = useApiStore((state) => state.clearHistory);
  const openRequestInTab = useApiStore((state) => state.openRequestInTab);

  const [searchQuery, setSearchQuery] = useState('');
  const [isCreatingCol, setIsCreatingCol] = useState(false);
  const [newColTitle, setNewColTitle] = useState('');
  const [collectionToDelete, setCollectionToDelete] = useState<Collection | null>(null);
  const [showClearHistoryConfirm, setShowClearHistoryConfirm] = useState(false);

  const trimmedQuery = searchQuery.trim().toLowerCase();

  const filteredCollections = !trimmedQuery
    ? collections
    : collections
        .map((col) => {
          const nameMatches = col.name.toLowerCase().includes(trimmedQuery);
          const matchedItems = filterCollectionItems(col.items, trimmedQuery);
          if (nameMatches || matchedItems.length > 0) {
            return {
              ...col,
              items: nameMatches ? col.items : matchedItems,
            };
          }
          return null;
        })
        .filter((col): col is Collection => col !== null);

  const filteredHistory = history.filter(
    (h) =>
      h.request.url.toLowerCase().includes(trimmedQuery) ||
      h.request.name.toLowerCase().includes(trimmedQuery) ||
      h.request.method.toLowerCase().includes(trimmedQuery)
  );

  const handleExportCollection = (e: React.MouseEvent, col: Collection) => {
    e.stopPropagation();
    try {
      const json = exportPostmanCollection(col);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${col.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-postman-v2.1.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export collection', err);
    }
  };

  return (
    <aside className="flex h-full w-72 flex-col border-r border-zinc-800 bg-zinc-950/70 select-none">
      {/* Switcher Tabs */}
      <div className="flex border-b border-zinc-800 p-2 gap-1.5">
        <button
          onClick={() => setSidebarTab('collections')}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold transition ${
            sidebarTab === 'collections'
              ? 'bg-zinc-800/90 text-white shadow-sm'
              : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
          }`}
        >
          <Layers className="h-3.5 w-3.5" />
          <span>Collections</span>
          <span className="rounded-full bg-zinc-700/60 px-1.5 text-[10px] text-zinc-300">
            {collections.length}
          </span>
        </button>

        <button
          onClick={() => setSidebarTab('history')}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold transition ${
            sidebarTab === 'history'
              ? 'bg-zinc-800/90 text-white shadow-sm'
              : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
          }`}
        >
          <Clock className="h-3.5 w-3.5" />
          <span>History</span>
          <span className="rounded-full bg-zinc-700/60 px-1.5 text-[10px] text-zinc-300">
            {history.length}
          </span>
        </button>
      </div>

      {/* Search Input and Add Collection Bar */}
      <div className="p-2 border-b border-zinc-850 space-y-1.5">
        <div className="relative flex items-center">
          <Search className="absolute left-2.5 h-3.5 w-3.5 text-zinc-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={
              sidebarTab === 'collections' ? 'Filter collections...' : 'Filter history...'
            }
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/90 py-1.5 pl-8 pr-3 text-xs text-zinc-200 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
          />
        </div>

        {sidebarTab === 'collections' && (
          <div>
            {isCreatingCol ? (
              <div className="flex items-center gap-1.5 pt-0.5">
                <input
                  type="text"
                  value={newColTitle}
                  onChange={(e) => setNewColTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newColTitle.trim()) {
                      createCollection(newColTitle.trim());
                      setNewColTitle('');
                      setIsCreatingCol(false);
                    } else if (e.key === 'Escape') {
                      setIsCreatingCol(false);
                    }
                  }}
                  placeholder="Collection name (Enter)"
                  autoFocus
                  className="flex-1 rounded-md border border-sky-500/50 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (newColTitle.trim()) {
                      createCollection(newColTitle.trim());
                      setNewColTitle('');
                    }
                    setIsCreatingCol(false);
                  }}
                  className="rounded-md bg-sky-500/20 px-2 py-1 text-[11px] font-medium text-sky-400 hover:bg-sky-500/30"
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => setIsCreatingCol(false)}
                  className="rounded-md px-1.5 py-1 text-[11px] text-zinc-400 hover:text-white"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIsCreatingCol(true)}
                className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-zinc-800 py-1 text-[11px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 transition"
              >
                <FolderPlus className="h-3 w-3 text-sky-400" />
                <span>New Collection</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {sidebarTab === 'collections' ? (
          <div>
            {collections.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-900 text-zinc-400 border border-zinc-800">
                  <FolderPlus className="h-5 w-5" />
                </div>
                <h3 className="mt-3 text-xs font-semibold text-zinc-300">No Collections Yet</h3>
                <p className="mt-1 text-[11px] text-zinc-500 leading-relaxed">
                  Import your Postman v2.1 collection using the header button to organize your API requests.
                </p>
              </div>
            ) : filteredCollections.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                <Search className="h-6 w-6 text-zinc-600" />
                <h4 className="mt-2 text-xs font-semibold text-zinc-300">No Matching Collections</h4>
                <p className="mt-1 text-[11px] text-zinc-500">
                  No collection or request matched &ldquo;{searchQuery}&rdquo;.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {filteredCollections.map((col) => (
                  <div key={col.id} className="rounded-lg border border-zinc-850 bg-zinc-900/40 p-1.5">
                    <div className="flex items-center justify-between px-2 py-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Folder className="h-4 w-4 text-amber-400 shrink-0" />
                        <span className="text-xs font-bold text-zinc-200 truncate" title={col.name}>
                          {col.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0 ml-1">
                        <button
                          onClick={(e) => handleExportCollection(e, col)}
                          className="rounded p-1 text-zinc-500 hover:text-sky-400 hover:bg-zinc-800 transition"
                          title="Export collection as Postman v2.1 JSON"
                        >
                          <Download className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setCollectionToDelete(col)}
                          className="rounded p-1 text-zinc-500 hover:text-rose-400 hover:bg-zinc-800 transition"
                          title="Delete collection"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    <div className="mt-1 space-y-0.5">
                      {col.items.map((item) => (
                        <FolderItem
                          key={item.id}
                          item={item}
                          onSelectRequest={openRequestInTab}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div>
            {history.length > 0 && (
              <div className="flex justify-end pb-1">
                <button
                  onClick={() => setShowClearHistoryConfirm(true)}
                  className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-rose-400 transition"
                >
                  <Trash2 className="h-3 w-3" />
                  Clear all
                </button>
              </div>
            )}

            {filteredHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                <Clock className="h-8 w-8 text-zinc-600" />
                <h3 className="mt-3 text-xs font-semibold text-zinc-300">No History</h3>
                <p className="mt-1 text-[11px] text-zinc-500">
                  Requests sent will automatically appear here.
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                {filteredHistory.map((item) => {
                  const status = item.response?.status;
                  const isOk = status && status >= 200 && status < 300;

                  return (
                    <div
                      key={item.id}
                      onClick={() => openRequestInTab(item.request)}
                      className="group flex flex-col gap-1 rounded-lg border border-zinc-850/80 bg-zinc-900/40 p-2 hover:bg-zinc-850 hover:border-zinc-700 cursor-pointer transition"
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <MethodBadge method={item.request.method} size="sm" />
                          <span className="text-xs font-medium text-zinc-300 truncate">
                            {item.request.name || item.request.url}
                          </span>
                        </div>
                        {status !== undefined && (
                          <span
                            className={`text-[10px] font-mono font-bold px-1 rounded ${
                              isOk ? 'text-emerald-400 bg-emerald-500/10' : 'text-rose-400 bg-rose-500/10'
                            }`}
                          >
                            {status || 'ERR'}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center justify-between text-[10px] text-zinc-500 font-mono">
                        <span className="truncate max-w-[150px]">{item.request.url}</span>
                        <span>{item.response?.timeMs ? `${item.response.timeMs}ms` : ''}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmModal
        isOpen={!!collectionToDelete}
        onClose={() => setCollectionToDelete(null)}
        onConfirm={() => {
          if (collectionToDelete) {
            deleteCollection(collectionToDelete.id);
            setCollectionToDelete(null);
          }
        }}
        title="Delete Collection"
        message={
          <span>
            Are you sure you want to delete collection{' '}
            <strong className="text-zinc-200">"{collectionToDelete?.name}"</strong>? This will permanently remove the collection and all its requests.
          </span>
        }
        confirmText="Delete Collection"
        variant="danger"
      />

      <ConfirmModal
        isOpen={showClearHistoryConfirm}
        onClose={() => setShowClearHistoryConfirm(false)}
        onConfirm={() => {
          clearHistory();
          setShowClearHistoryConfirm(false);
        }}
        title="Clear Request History"
        message="Are you sure you want to clear your entire request history? This action cannot be undone."
        confirmText="Clear All History"
        variant="danger"
      />
    </aside>
  );
};
