'use client';

import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { useBackHandler } from '../lib/backNavigation';
import {
  Folder,
  FolderOpen,
  Clock,
  Trash2,
  ChevronRight,
  ChevronDown,
  Search,
  Plus,
  FileCode,
  FolderPlus,
  Layers,
  ArrowUpRight,
  Download,
  FolderInput,
  Upload,
  ChevronsUpDown,
  ChevronsDownUp,
  MoreVertical,
  Pencil,
  Check,
  X,
  Lock,
  Shield,
  AlertTriangle,
} from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { CollectionItem, ApiRequest, Collection } from '../types/api';
import { MethodBadge } from './MethodBadge';
import { exportPostmanCollection } from '../lib/postman';
import { ConfirmModal } from './ConfirmModal';
import { MoveCollectionModal } from './MoveCollectionModal';
import { CollectionPermissionModal } from './CollectionPermissionModal';
import { MoveRequestModal } from './MoveRequestModal';
import { ImportModal } from './ImportModal';
import { isDescendantOf } from '../lib/treeHelper';
import { canModifyCollection, hasScopePermission } from '../lib/jwt';
import { getDefaultPlatformAdapter } from '../lib/fetcher';
import { ScopeSwitcher } from './ScopeSwitcher';
import { UserMenu } from './UserMenu';
import { MobileThemeSegmentedControl } from './ThemeToggle';
import { ModeSelectorModal } from './ModeSelectorModal';
import { CloudAuthModal } from './CloudAuthModal';
import { isOfflineOnly } from '../lib/edition';

function filterCollectionItems(items: CollectionItem[], query: string): CollectionItem[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return items || [];

  return (items || [])
    .map((item) => {
      if (!item) return null;
      const itemName = String(item.name || '').toLowerCase();
      if (item.type === 'folder') {
        const matchingChildren = item.items ? filterCollectionItems(item.items, query) : [];
        const folderMatches = tokens.every((token) => itemName.includes(token));
        if (matchingChildren.length > 0 || folderMatches) {
          return {
            ...item,
            items: matchingChildren.length > 0 ? matchingChildren : item.items,
          };
        }
        return null;
      }
      if (item.type === 'request') {
        const fullText = `${item.name || ''} ${item.request?.method || ''} ${item.request?.url || ''}`.toLowerCase();
        const matches = tokens.every((token) => fullText.includes(token));
        return matches ? item : null;
      }
      return null;
    })
    .filter((item): item is CollectionItem => item !== null);
}

export interface DraggedItemState {
  id: string;
  type: 'folder' | 'request';
  collectionId: string;
  name: string;
}

function getAllFolderIds(item: CollectionItem): string[] {
  const ids: string[] = [];
  if (item.type === 'folder') {
    ids.push(item.id);
    if (item.items) {
      for (const child of item.items) {
        ids.push(...getAllFolderIds(child));
      }
    }
  }
  return ids;
}

function getAllFolderIdsInCollection(collection: Collection): string[] {
  const ids: string[] = [];
  for (const item of (collection.items || [])) {
    ids.push(...getAllFolderIds(item));
  }
  return ids;
}

export function calculateOpenUpward(element: HTMLElement | null, menuHeight = 150): boolean {
  if (!element || typeof window === 'undefined' || !element.getBoundingClientRect) return false;
  const rect = element.getBoundingClientRect();

  let containerBottom = window.innerHeight || 800;
  let containerTop = 0;

  let parent = element.parentElement;
  while (parent) {
    if (typeof window.getComputedStyle === 'function') {
      const style = window.getComputedStyle(parent);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        if (parent.getBoundingClientRect) {
          const parentRect = parent.getBoundingClientRect();
          containerBottom = Math.min(containerBottom, parentRect.bottom);
          containerTop = Math.max(containerTop, parentRect.top);
        }
        break;
      }
    }
    parent = parent.parentElement;
  }

  const marginBuffer = 8;
  const spaceBelow = containerBottom - rect.bottom - marginBuffer;
  const spaceAbove = rect.top - containerTop - marginBuffer;

  return spaceBelow < menuHeight && spaceAbove > spaceBelow;
}

interface FolderItemProps {
  item: CollectionItem;
  collectionId: string;
  level?: number;
  openFolders: Record<string, boolean>;
  onToggleFolder: (folderId: string, item: CollectionItem) => void;
  onOpenFolder: (folderId: string) => void;
  onExpandAllInFolder: (item: CollectionItem) => void;
  onCollapseAllInFolder: (item: CollectionItem) => void;
  isSearching: boolean;
  onSelectRequest: (req: ApiRequest) => void;
  onRequestDelete: (item: CollectionItem) => void;
  onRequestMove: (item: CollectionItem, collectionId: string) => void;
  draggedItem: DraggedItemState | null;
  setDraggedItem: (item: DraggedItemState | null) => void;
  onReorderItem: (
    collectionId: string,
    activeId: string,
    targetId: string,
    position: 'before' | 'after' | 'inside'
  ) => void;
  canEdit?: boolean;
}

const FolderItem: React.FC<FolderItemProps> = ({
  item,
  collectionId,
  level = 0,
  openFolders,
  onToggleFolder,
  onOpenFolder,
  onExpandAllInFolder,
  onCollapseAllInFolder,
  isSearching,
  onSelectRequest,
  onRequestDelete,
  onRequestMove,
  draggedItem,
  setDraggedItem,
  onReorderItem,
  canEdit = true,
}) => {
  const isOpen = isSearching ? true : !!openFolders[item.id];
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  useBackHandler(isMenuOpen, () => setIsMenuOpen(false), 15);
  const [openUpward, setOpenUpward] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [isCreatingSubfolder, setIsCreatingSubfolder] = useState(false);
  const [subfolderName, setSubfolderName] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editingName, setEditingName] = useState(item.name);

  useLayoutEffect(() => {
    if (isMenuOpen && buttonRef.current && menuRef.current) {
      const actualHeight = menuRef.current.offsetHeight;
      const upward = calculateOpenUpward(buttonRef.current, actualHeight);
      if (upward !== openUpward) {
        setOpenUpward(upward);
      }
    }
  }, [isMenuOpen, openUpward]);

  const [dropPosition, setDropPosition] = useState<'before' | 'after' | 'inside' | null>(null);
  const [isForbidden, setIsForbidden] = useState(false);

  const collections = useApiStore((state) => state.collections);
  const currentCol = collections.find((c) => c.id === collectionId);
  const collectionItems = currentCol?.items || [];

  const createFolder = useApiStore((state) => state.createFolder);
  const createRequestInCollection = useApiStore((state) => state.createRequestInCollection);
  const renameCollectionItem = useApiStore((state) => state.renameCollectionItem);

  useEffect(() => {
    if (!isEditing) {
      setEditingName(item.name);
    }
  }, [item.name, isEditing]);

  const handleConfirmRename = () => {
    const trimmed = editingName.trim();
    if (trimmed && trimmed !== item.name) {
      renameCollectionItem(collectionId, item.id, trimmed);
    } else {
      setEditingName(item.name);
    }
    setIsEditing(false);
  };

  const isBeingDragged = draggedItem?.id === item.id;

  const handleDragStart = (e: React.DragEvent) => {
    if (!canEdit) return;
    e.stopPropagation();
    setDraggedItem({
      id: item.id,
      type: item.type,
      collectionId,
      name: item.name,
    });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.id);
  };

  const handleDragEnd = () => {
    setDraggedItem(null);
    setDropPosition(null);
    setIsForbidden(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!canEdit || !draggedItem) return;
    e.stopPropagation();

    // 1. Cross-collection move via drag-and-drop is forbidden: pointer not allowed!
    if (draggedItem.collectionId !== collectionId) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
      if (!isForbidden) setIsForbidden(true);
      if (dropPosition !== null) setDropPosition(null);
      return;
    }

    // 2. Self drop is forbidden
    if (draggedItem.id === item.id) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
      if (!isForbidden) setIsForbidden(true);
      if (dropPosition !== null) setDropPosition(null);
      return;
    }

    // 3. Circular folder dependency is forbidden (cannot drop parent into child/descendant)
    if (
      draggedItem.type === 'folder' &&
      isDescendantOf(collectionItems, draggedItem.id, item.id)
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
      if (!isForbidden) setIsForbidden(true);
      if (dropPosition !== null) setDropPosition(null);
      return;
    }

    // Valid drop target!
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (isForbidden) setIsForbidden(false);

    const rect = e.currentTarget.getBoundingClientRect();
    const offsetY = e.clientY - rect.top;
    const height = rect.height;

    let pos: 'before' | 'after' | 'inside';
    if (item.type === 'folder') {
      if (offsetY < height * 0.28) {
        pos = 'before';
      } else if (offsetY > height * 0.72) {
        pos = 'after';
      } else {
        pos = 'inside';
      }
    } else {
      if (offsetY < height * 0.5) {
        pos = 'before';
      } else {
        pos = 'after';
      }
    }

    if (dropPosition !== pos) {
      setDropPosition(pos);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropPosition(null);
      setIsForbidden(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canEdit) return;

    const currentPos = dropPosition;
    const forbidden = isForbidden;
    setDropPosition(null);
    setIsForbidden(false);

    if (!draggedItem || forbidden || !currentPos) {
      return;
    }

    if (draggedItem.collectionId !== collectionId || draggedItem.id === item.id) {
      return;
    }

    if (currentPos === 'inside') {
      onOpenFolder(item.id);
    }

    onReorderItem(collectionId, draggedItem.id, item.id, currentPos);
    setDraggedItem(null);
  };

  const handleCreateRequest = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsMenuOpen(false);
    onOpenFolder(item.id);
    createRequestInCollection(collectionId, item.id, 'New Request');
  };

  const handleStartCreateSubfolder = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsMenuOpen(false);
    onOpenFolder(item.id);
    setIsCreatingSubfolder(true);
    setSubfolderName('');
  };

  const handleConfirmCreateSubfolder = () => {
    const trimmed = subfolderName.trim() || 'New Folder';
    createFolder(collectionId, item.id, trimmed);
    setIsCreatingSubfolder(false);
    setSubfolderName('');
  };

  if (item.type === 'folder') {
    return (
      <div className="select-none">
        {isEditing ? (
          <div
            className="flex items-center gap-1.5 py-1 px-2 rounded-md bg-card border border-sky-500/40 text-xs font-medium my-0.5"
            style={{ paddingLeft: `${Math.max(level * 12, 8)}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            {isOpen ? (
              <FolderOpen className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400 shrink-0" />
            ) : (
              <Folder className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400 shrink-0" />
            )}
            <input
              type="text"
              autoFocus
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirmRename();
                else if (e.key === 'Escape') {
                  setEditingName(item.name);
                  setIsEditing(false);
                }
              }}
              className="flex-1 min-w-0 rounded bg-element px-1.5 py-0.5 text-xs text-tx-primary focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
            <button
              type="button"
              onClick={handleConfirmRename}
              className="p-1 text-emerald-500 dark:text-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-300 transition"
              title="Save name"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingName(item.name);
                setIsEditing(false);
              }}
              className="p-1 text-tx-muted hover:text-tx-primary transition"
              title="Cancel"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div
            draggable={canEdit && !isCreatingSubfolder}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => onToggleFolder(item.id, item)}
            className={`group relative flex items-center gap-1.5 py-1 px-2 rounded-md transition text-xs font-medium ${
              isForbidden
                ? 'cursor-not-allowed bg-rose-500/10 text-rose-500 dark:text-rose-300'
                : isBeingDragged
                ? 'opacity-40 bg-element cursor-grabbing'
                : dropPosition === 'inside'
                ? 'bg-sky-500/20 ring-1 ring-sky-400/60 text-tx-primary cursor-pointer'
                : 'hover:bg-hover text-tx-secondary hover:text-tx-primary cursor-pointer'
            }`}
            style={{ paddingLeft: `${Math.max(level * 12, 8)}px` }}
          >
            {dropPosition === 'before' && !isForbidden && (
              <div className="absolute top-0 left-0 right-0 h-0.5 bg-sky-400 z-30 shadow-[0_0_8px_rgba(56,189,248,0.9)] pointer-events-none flex items-center">
                <div className="w-1.5 h-1.5 rounded-full bg-sky-400 -ml-0.5" />
              </div>
            )}
            {dropPosition === 'after' && !isForbidden && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-sky-400 z-30 shadow-[0_0_8px_rgba(56,189,248,0.9)] pointer-events-none flex items-center">
                <div className="w-1.5 h-1.5 rounded-full bg-sky-400 -ml-0.5" />
              </div>
            )}
            {isOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-tx-muted shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-tx-muted shrink-0" />
            )}
            {isOpen ? (
              <FolderOpen className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400 shrink-0" />
            ) : (
              <Folder className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400 shrink-0" />
            )}
            <span
              className="truncate flex-1 text-tx-primary"
              title={canEdit ? `${item.name} (Double-click to rename)` : item.name}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (!canEdit) return;
                setIsEditing(true);
                setEditingName(item.name);
              }}
            >
              {item.name}
            </span>
            <span className="text-[10px] text-tx-muted font-mono mr-1">
              {item.items?.length || 0}
            </span>

            <div
              className={`items-center gap-0.5 shrink-0 transition ${
                isMenuOpen ? 'flex' : 'hidden max-md:flex group-hover:flex group-focus-within:flex'
              }`}
            >
              {/* Folder Options 3-Dots Button */}
              <div className="relative">
                <button
                  ref={buttonRef}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isMenuOpen) {
                      setOpenUpward(calculateOpenUpward(buttonRef.current, 200));
                    }
                    setIsMenuOpen(!isMenuOpen);
                  }}
                  className="rounded p-0.5 text-tx-muted hover:text-sky-500 hover:bg-hover transition"
                  title="Folder options"
                >
                  <MoreVertical className="h-3.5 w-3.5" />
                </button>

                {isMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsMenuOpen(false);
                      }}
                    />
                    <div
                      ref={menuRef}
                      onClick={(e) => e.stopPropagation()}
                      className={`absolute right-0 ${
                        openUpward ? 'bottom-full mb-1 origin-bottom-right' : 'top-full mt-1 origin-top-right'
                      } z-50 w-44 rounded-lg border border-line bg-card p-1 shadow-xl animate-in fade-in zoom-in-95 duration-100`}
                    >
                      {canEdit && (
                        <>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setIsMenuOpen(false);
                              setIsEditing(true);
                              setEditingName(item.name);
                            }}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-sky-500 transition"
                          >
                            <Pencil className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
                            <span>Rename Folder</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleCreateRequest}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-sky-500 transition"
                          >
                            <FileCode className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
                            <span>New Request</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleStartCreateSubfolder}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-amber-500 transition"
                          >
                            <FolderPlus className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" />
                            <span>New Subfolder</span>
                          </button>
                          <div className="my-1 border-t border-line" />
                        </>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsMenuOpen(false);
                          onExpandAllInFolder(item);
                        }}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition"
                      >
                        <ChevronsUpDown className="h-3.5 w-3.5 text-zinc-400" />
                        <span>Expand All</span>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsMenuOpen(false);
                          onCollapseAllInFolder(item);
                        }}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition"
                      >
                        <ChevronsDownUp className="h-3.5 w-3.5 text-zinc-400" />
                        <span>Collapse All</span>
                      </button>
                      {canEdit && (
                        <>
                          <div className="my-1 border-t border-zinc-800/80" />
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setIsMenuOpen(false);
                              onRequestDelete(item);
                            }}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-rose-400 hover:bg-rose-500/10 transition"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-rose-400" />
                            <span>Delete Folder</span>
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Inline Subfolder creation */}
        {isOpen && isCreatingSubfolder && (
          <div
            className="flex items-center gap-1.5 py-1 px-2 border-l border-zinc-800/60 ml-3.5 mt-0.5"
            style={{ paddingLeft: `${Math.max((level + 1) * 12, 8)}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <Folder className="h-3.5 w-3.5 text-amber-400 shrink-0" />
            <input
              type="text"
              autoFocus
              value={subfolderName}
              onChange={(e) => setSubfolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirmCreateSubfolder();
                else if (e.key === 'Escape') setIsCreatingSubfolder(false);
              }}
              placeholder="Folder name (Enter)"
              className="w-full rounded bg-zinc-900 border border-sky-500/50 px-2 py-0.5 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={handleConfirmCreateSubfolder}
              className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-medium text-sky-400 hover:bg-sky-500/30"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => setIsCreatingSubfolder(false)}
              className="rounded px-1 py-0.5 text-[10px] text-zinc-400 hover:text-white"
            >
              ✕
            </button>
          </div>
        )}

        {isOpen && (!item.items || item.items.length === 0) && !isCreatingSubfolder && (
          <div
            onDragOver={(e) => {
              if (!draggedItem || draggedItem.collectionId !== collectionId) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'none';
                return;
              }
              if (
                draggedItem.id === item.id ||
                (draggedItem.type === 'folder' && isDescendantOf(collectionItems, draggedItem.id, item.id))
              ) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'none';
                return;
              }
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!draggedItem || draggedItem.collectionId !== collectionId || draggedItem.id === item.id) return;
              if (draggedItem.type === 'folder' && isDescendantOf(collectionItems, draggedItem.id, item.id)) return;
              onReorderItem(collectionId, draggedItem.id, item.id, 'inside');
              setDraggedItem(null);
            }}
            className="ml-3.5 mt-0.5 border-l border-zinc-800/60 pl-3 py-1 text-[10px] text-zinc-600 hover:text-sky-400 hover:bg-sky-500/10 rounded transition select-none"
          >
            Empty folder (drop here)
          </div>
        )}

        {isOpen && item.items && item.items.length > 0 && (
          <div className="border-l border-zinc-800/60 ml-3.5 mt-0.5">
            {item.items.map((child) => (
              <FolderItem
                key={child.id}
                item={child}
                collectionId={collectionId}
                level={level + 1}
                openFolders={openFolders}
                onToggleFolder={onToggleFolder}
                onOpenFolder={onOpenFolder}
                onExpandAllInFolder={onExpandAllInFolder}
                onCollapseAllInFolder={onCollapseAllInFolder}
                isSearching={isSearching}
                onSelectRequest={onSelectRequest}
                onRequestDelete={onRequestDelete}
                onRequestMove={onRequestMove}
                draggedItem={draggedItem}
                setDraggedItem={setDraggedItem}
                onReorderItem={onReorderItem}
                canEdit={canEdit}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Request item
  if (!item.request) return null;

  if (isEditing) {
    return (
      <div
        className="flex items-center gap-1.5 py-1 px-2 rounded-md bg-zinc-900 border border-sky-500/40 text-xs font-medium my-0.5"
        style={{ paddingLeft: `${Math.max(level * 12, 8)}px` }}
        onClick={(e) => e.stopPropagation()}
      >
        <MethodBadge method={item.request.method} size="sm" />
        <input
          type="text"
          autoFocus
          value={editingName}
          onChange={(e) => setEditingName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleConfirmRename();
            else if (e.key === 'Escape') {
              setEditingName(item.name);
              setIsEditing(false);
            }
          }}
          className="flex-1 min-w-0 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-100 focus:outline-none focus:ring-1 focus:ring-sky-400"
        />
        <button
          type="button"
          onClick={handleConfirmRename}
          className="p-1 text-emerald-400 hover:text-emerald-300 transition"
          title="Save name"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            setEditingName(item.name);
            setIsEditing(false);
          }}
          className="p-1 text-zinc-400 hover:text-zinc-200 transition"
          title="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      draggable={canEdit}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => {
        const resolvedId = item.request?.id || item.id;
        onSelectRequest({
          ...item.request!,
          id: resolvedId,
          name: item.name || item.request?.name || 'Untitled Request',
        });
      }}
      className={`group relative flex items-center gap-2 py-1.5 px-2 rounded-md transition text-xs ${
        isForbidden
          ? 'cursor-not-allowed bg-rose-500/10 text-rose-500 dark:text-rose-300'
          : isBeingDragged
          ? 'opacity-40 bg-element cursor-grabbing'
          : 'hover:bg-hover text-tx-secondary hover:text-tx-primary cursor-pointer'
      }`}
      style={{ paddingLeft: `${Math.max(level * 12, 8)}px` }}
    >
      {dropPosition === 'before' && !isForbidden && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-sky-400 z-30 shadow-[0_0_8px_rgba(56,189,248,0.9)] pointer-events-none flex items-center">
          <div className="w-1.5 h-1.5 rounded-full bg-sky-400 -ml-0.5" />
        </div>
      )}
      {dropPosition === 'after' && !isForbidden && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-sky-400 z-30 shadow-[0_0_8px_rgba(56,189,248,0.9)] pointer-events-none flex items-center">
          <div className="w-1.5 h-1.5 rounded-full bg-sky-400 -ml-0.5" />
        </div>
      )}
      <MethodBadge method={item.request.method} size="sm" />
      <span
        className="truncate flex-1 group-hover:text-tx-primary"
        title={canEdit ? `${item.name} (Double-click to rename)` : item.name}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (!canEdit) return;
          setIsEditing(true);
          setEditingName(item.name);
        }}
      >
        {item.name}
      </span>
      {canEdit && (
        <div
          className={`items-center gap-0.5 transition shrink-0 ${
            isMenuOpen ? 'flex' : 'hidden max-md:flex group-hover:flex group-focus-within:flex'
          }`}
        >
        <div className="relative">
          <button
            ref={buttonRef}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (!isMenuOpen) {
                setOpenUpward(calculateOpenUpward(buttonRef.current, 140));
              }
              setIsMenuOpen(!isMenuOpen);
            }}
            className="rounded p-0.5 text-tx-muted hover:text-sky-500 hover:bg-hover transition"
            title="Request options"
          >
            <MoreVertical className="h-3 w-3" />
          </button>

          {isMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsMenuOpen(false);
                }}
              />
              <div
                ref={menuRef}
                onClick={(e) => e.stopPropagation()}
                className={`absolute right-0 ${
                  openUpward ? 'bottom-full mb-1 origin-bottom-right' : 'top-full mt-1 origin-top-right'
                } z-50 w-40 rounded-lg border border-line bg-card p-1 shadow-xl animate-in fade-in zoom-in-95 duration-100`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsMenuOpen(false);
                    setIsEditing(true);
                    setEditingName(item.name);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-sky-500 transition"
                >
                  <Pencil className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
                  <span>Rename Request</span>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsMenuOpen(false);
                    onRequestMove(item, collectionId);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-amber-500 transition"
                >
                  <FolderInput className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" />
                  <span>Move Request</span>
                </button>
                <div className="my-1 border-t border-line" />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsMenuOpen(false);
                    onRequestDelete(item);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-rose-500 hover:bg-rose-500/10 transition"
                >
                  <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                  <span>Delete Request</span>
                </button>
              </div>
            </>
          )}
        </div>
        <ArrowUpRight className="h-3 w-3 text-tx-faint group-hover:text-tx-muted transition" />
      </div>
      )}
    </div>
  );
};

export interface SidebarProps {
  onClose?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ onClose }) => {
  const sidebarTab = useApiStore((state) => state.sidebarTab);
  const setSidebarTab = useApiStore((state) => state.setSidebarTab);
  const collections = useApiStore((state) => state.collections);
  const history = useApiStore((state) => state.history);
  const deleteCollection = useApiStore((state) => state.deleteCollection);
  const renameCollection = useApiStore((state) => state.renameCollection);
  const createCollection = useApiStore((state) => state.createCollection);
  const createFolder = useApiStore((state) => state.createFolder);
  const createRequestInCollection = useApiStore((state) => state.createRequestInCollection);
  const deleteCollectionItem = useApiStore((state) => state.deleteCollectionItem);
  const clearHistory = useApiStore((state) => state.clearHistory);
  const openRequestInTab = useApiStore((state) => state.openRequestInTab);
  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);
  const featurePolicy = useApiStore((state) => state.featurePolicy);
  const featurePolicyStatus = useApiStore((state) => state.featurePolicyStatus);
  const refreshFeaturePolicy = useApiStore((state) => state.refreshFeaturePolicy);
  const pullCloudDelta = useApiStore((state) => state.pullCloudDelta);
  const syncStatus = useApiStore((state) => state.syncStatus);

  const canWriteScope = hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role);
  const canMoveScope = hasScopePermission(cloudConfig.activeScope, 'collection:move', workspaceMode, cloudConfig.user?.role);
  const canDeleteScope = hasScopePermission(cloudConfig.activeScope, 'collection:delete', workspaceMode, cloudConfig.user?.role);
  const isCloudPolicyReady = workspaceMode !== 'cloud' || featurePolicyStatus === 'ready';
  const isMoveEnabled = workspaceMode !== 'cloud' || (isCloudPolicyReady && featurePolicy?.flags['collection.move'] === true);
  const isDeleteEnabled = workspaceMode !== 'cloud' || (isCloudPolicyReady && featurePolicy?.flags['collection.delete'] === true);
  const isExportEnabled = workspaceMode !== 'cloud' || (isCloudPolicyReady && featurePolicy?.flags['collection.export'] === true);
  const isProjectReadOnly = workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project' && !canWriteScope;
  const isProjectScope = workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project';
  const isProjectAdmin = hasScopePermission(cloudConfig.activeScope, '*', workspaceMode, cloudConfig.user?.role);
  const isProjectMaintainer = hasScopePermission(cloudConfig.activeScope, 'collection:delete', workspaceMode, cloudConfig.user?.role);
  const canManageCollectionPermission = isProjectScope && (isProjectAdmin || isProjectMaintainer);

  const [searchQuery, setSearchQuery] = useState('');
  const [isCreatingCol, setIsCreatingCol] = useState(false);
  const [newColTitle, setNewColTitle] = useState('');
  const [editingColId, setEditingColId] = useState<string | null>(null);
  const [editingColName, setEditingColName] = useState('');
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isModeSelectorOpen, setIsModeSelectorOpen] = useState(false);
  const [isCloudAuthOpen, setIsCloudAuthOpen] = useState(false);
  const [collectionToDelete, setCollectionToDelete] = useState<Collection | null>(null);
  const [collectionToMove, setCollectionToMove] = useState<Collection | null>(null);
  const [collectionForPermission, setCollectionForPermission] = useState<Collection | null>(null);
  const [collectionActionError, setCollectionActionError] = useState<string | null>(null);
  const [isDeletingCollection, setIsDeletingCollection] = useState(false);
  const [showClearHistoryConfirm, setShowClearHistoryConfirm] = useState(false);
  const [collapsedCollections, setCollapsedCollections] = useState<Record<string, boolean>>({});
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});

  const handleConfirmRenameCol = (colId: string) => {
    const trimmed = editingColName.trim();
    if (trimmed) {
      renameCollection(colId, trimmed);
    }
    setEditingColId(null);
  };

  const [activeAddMenuColId, setActiveAddMenuColId] = useState<string | null>(null);
  useBackHandler(Boolean(activeAddMenuColId), () => setActiveAddMenuColId(null), 15);
  const [colMenuOpenUpward, setColMenuOpenUpward] = useState(false);
  const colButtonRef = useRef<HTMLButtonElement>(null);
  const colMenuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (activeAddMenuColId && colButtonRef.current && colMenuRef.current) {
      const actualHeight = colMenuRef.current.offsetHeight;
      const upward = calculateOpenUpward(colButtonRef.current, actualHeight);
      if (upward !== colMenuOpenUpward) {
        setColMenuOpenUpward(upward);
      }
    }
  }, [activeAddMenuColId, colMenuOpenUpward]);
  const [creatingFolderInCol, setCreatingFolderInCol] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [requestToMove, setRequestToMove] = useState<{
    item: CollectionItem;
    collectionId: string;
  } | null>(null);
  const [draggedItem, setDraggedItem] = useState<DraggedItemState | null>(null);
  const reorderItem = useApiStore((state) => state.reorderItem);
  const [itemToDelete, setItemToDelete] = useState<{
    collectionId: string;
    itemId: string;
    name: string;
    type: 'folder' | 'request';
  } | null>(null);

  const trimmedQuery = searchQuery.trim().toLowerCase();

  const handleToggleFolder = (folderId: string, currentItem: CollectionItem) => {
    const isCurrentlyOpen = !!openFolders[folderId];
    if (isCurrentlyOpen) {
      // Collapsing: collapse this folder and reset descendant folders
      const descendantIds = getAllFolderIds(currentItem);
      setOpenFolders((prev) => {
        const next = { ...prev };
        for (const id of descendantIds) {
          delete next[id];
        }
        return next;
      });
    } else {
      // Expanding: 1 level only (subfolders remain collapsed by default)
      setOpenFolders((prev) => ({
        ...prev,
        [folderId]: true,
      }));
    }
  };

  const handleOpenFolder = (folderId: string) => {
    setOpenFolders((prev) => ({
      ...prev,
      [folderId]: true,
    }));
  };

  const handleExpandAllInFolder = (item: CollectionItem) => {
    const ids = getAllFolderIds(item);
    setOpenFolders((prev) => {
      const next = { ...prev };
      for (const id of ids) {
        next[id] = true;
      }
      return next;
    });
  };

  const handleCollapseAllInFolder = (item: CollectionItem) => {
    const subfolderIds = (item.items || []).flatMap((child) => getAllFolderIds(child));
    setOpenFolders((prev) => {
      const next = { ...prev };
      if (subfolderIds.length > 0) {
        // Keep this folder open at level 1, but collapse all nested subfolders
        next[item.id] = true;
        for (const id of subfolderIds) {
          delete next[id];
        }
      } else {
        // No subfolders, collapse this folder itself
        delete next[item.id];
      }
      return next;
    });
  };

  const toggleCollectionCollapse = (col: Collection) => {
    const isCurrentlyCollapsed = !trimmedQuery && !!collapsedCollections[col.id];
    if (!isCurrentlyCollapsed) {
      // Currently open -> collapsing!
      // Reset all folders in this collection so next time it expands 1 level only
      const folderIds = getAllFolderIdsInCollection(col);
      setOpenFolders((prev) => {
        const next = { ...prev };
        for (const id of folderIds) {
          delete next[id];
        }
        return next;
      });
      setCollapsedCollections((prev) => ({
        ...prev,
        [col.id]: true,
      }));
    } else {
      // Expanding! Default is 1 level only (folders inside remain collapsed)
      setCollapsedCollections((prev) => ({
        ...prev,
        [col.id]: false,
      }));
    }
  };

  const handleExpandAllInCollection = (col: Collection) => {
    const folderIds = getAllFolderIdsInCollection(col);
    setOpenFolders((prev) => {
      const next = { ...prev };
      for (const id of folderIds) {
        next[id] = true;
      }
      return next;
    });
    setCollapsedCollections((prev) => ({
      ...prev,
      [col.id]: false,
    }));
  };

  const handleCollapseAllInCollection = (col: Collection) => {
    const folderIds = getAllFolderIdsInCollection(col);
    setOpenFolders((prev) => {
      const next = { ...prev };
      for (const id of folderIds) {
        delete next[id];
      }
      return next;
    });
    // Ensure collection stays open at 1 level
    setCollapsedCollections((prev) => ({
      ...prev,
      [col.id]: false,
    }));
  };

  const queryTokens = trimmedQuery.split(/\s+/).filter(Boolean);

  const filteredCollections = !trimmedQuery
    ? (collections || [])
    : (collections || [])
        .map((col) => {
          if (!col) return null;
          const colText = `${col.name || ''} ${col.description || ''}`.toLowerCase();
          const nameMatches = queryTokens.length > 0 && queryTokens.every((token) => colText.includes(token));
          const matchedItems = filterCollectionItems(col.items || [], trimmedQuery);
          if (nameMatches || matchedItems.length > 0) {
            return {
              ...col,
              items: matchedItems.length > 0 ? matchedItems : col.items,
            };
          }
          return null;
        })
        .filter((col): col is Collection => col !== null);

  const filteredHistory = !trimmedQuery
    ? (history || [])
    : (history || []).filter((h) => {
        if (!h || !h.request) return false;
        const fullText = `${h.request.name || ''} ${h.request.method || ''} ${h.request.url || ''}`.toLowerCase();
        return queryTokens.every((token) => fullText.includes(token));
      });

  const handleExportCollection = async (e: React.MouseEvent, col: Collection) => {
    e.stopPropagation();
    try {
      if (workspaceMode === 'cloud') {
        const policy = await refreshFeaturePolicy(true);
        if (!policy?.flags['collection.export']) {
          setCollectionActionError('Collection export is disabled or feature policy is unavailable.');
          return;
        }
      }
      const json = exportPostmanCollection(col);
      const filename = `${col.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-postman-v2.1.json`;
      const adapter = getDefaultPlatformAdapter();

      if (adapter?.saveFile) {
        await adapter.saveFile(filename, json, {
          filters: [{ name: 'Postman Collection', extensions: ['json'] }],
          mimeType: 'application/json',
        });
        return;
      }

      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export collection', err);
    }
  };

  return (
    <aside className="flex h-full w-80 max-w-[85vw] md:w-72 flex-col border-r border-line bg-surface select-none">
      {/* Workspace Switcher, Sync & Account Section (Mobile only) */}
      <div className="md:hidden border-b border-line p-2 pt-[max(env(safe-area-inset-top),10px)] bg-surface/90">
        <div className="flex items-center gap-1.5 w-full">
          {/* Workspace Switcher */}
          <div className="flex-1 min-w-0">
            <ScopeSwitcher
              onOpenModeSelector={() => setIsModeSelectorOpen(true)}
              onOpenCloudAuth={() => setIsCloudAuthOpen(true)}
            />
          </div>

          {/* User Account Menu */}
          <div className="shrink-0">
            <UserMenu onOpenLogin={() => setIsCloudAuthOpen(true)} />
          </div>

          {/* Close Sidebar Drawer Button */}
          {onClose && (
            <button
              type="button"
              aria-label="Close collections panel"
              onClick={onClose}
              className="rounded-lg p-1.5 text-tx-muted hover:text-tx-primary hover:bg-hover transition shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Mobile Theme Segmented Control Row */}
      <MobileThemeSegmentedControl />

      {/* Switcher Tabs */}
      <div className="flex border-b border-line p-2 gap-1.5">
        <button
          onClick={() => setSidebarTab('collections')}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold transition ${
            sidebarTab === 'collections'
              ? 'bg-card text-tx-primary shadow-xs'
              : 'text-tx-muted hover:bg-hover hover:text-tx-primary'
          }`}
        >
          <Layers className="h-3.5 w-3.5" />
          <span>Collections</span>
          <span className="rounded-full bg-element px-1.5 text-[10px] text-tx-secondary">
            {collections.length}
          </span>
        </button>

        <button
          onClick={() => setSidebarTab('history')}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold transition ${
            sidebarTab === 'history'
              ? 'bg-card text-tx-primary shadow-xs'
              : 'text-tx-muted hover:bg-hover hover:text-tx-primary'
          }`}
        >
          <Clock className="h-3.5 w-3.5" />
          <span>History</span>
          <span className="rounded-full bg-element px-1.5 text-[10px] text-tx-secondary">
            {history.length}
          </span>
        </button>
      </div>

      {/* Search Input and Add Collection Bar */}
      <div className="p-2 border-b border-zinc-850 space-y-1.5">
        <div className="relative flex items-center">
          <Search className="absolute left-2.5 h-3.5 w-3.5 text-zinc-500 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && searchQuery) {
                setSearchQuery('');
              }
            }}
            placeholder={
              sidebarTab === 'collections' ? 'Search collections or requests...' : 'Filter history...'
            }
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/90 py-1.5 pl-8 pr-7 text-xs text-zinc-200 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 text-zinc-500 hover:text-zinc-300 transition p-0.5 rounded"
              title="Clear search"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {sidebarTab === 'collections' && (
          <div className="space-y-1.5">
            {isProjectReadOnly ? (
              <div className="flex items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/50 py-1.5 px-2 text-[11px] text-zinc-500 select-none">
                <Lock className="h-3 w-3 text-zinc-500 shrink-0" />
                <span>Project Scope (Read-only)</span>
              </div>
            ) : (
              <>
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
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-zinc-800 py-1 text-[11px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 transition"
                  >
                    <FolderPlus className="h-3 w-3 text-sky-400" />
                    <span>New Collection</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setIsImportOpen(true)}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-zinc-800 py-1 text-[11px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 transition"
                  title="Import Postman Collection or Environment"
                >
                  <Upload className="h-3 w-3 text-emerald-400" />
                  <span>Import</span>
                </button>
              </>
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
                  Create a new collection or import your Postman collection or environment to organize your API requests.
                </p>
                <button
                  type="button"
                  onClick={() => setIsImportOpen(true)}
                  className="mt-3 flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[11px] font-medium text-emerald-400 hover:bg-zinc-800 hover:border-emerald-500/30 transition shadow-sm"
                >
                  <Upload className="h-3 w-3" />
                  <span>Import</span>
                </button>
              </div>
            ) : filteredCollections.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                <Search className="h-6 w-6 text-zinc-600" />
                <h4 className="mt-2 text-xs font-semibold text-zinc-300">No Matching Results</h4>
                <p className="mt-1 text-[11px] text-zinc-500">
                  No collection or request matched &ldquo;{searchQuery}&rdquo;.
                </p>
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="mt-2 text-[11px] text-sky-400 hover:text-sky-300 underline"
                  >
                    Clear search
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {filteredCollections.map((col) => {
                  const isCollapsed = !trimmedQuery && !!collapsedCollections[col.id];
                  const canEditCol = !col.isPartial && canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role);

                  return (
                    <div key={col.id} className="rounded-lg border border-zinc-850 bg-zinc-900/40 p-1.5 transition">
                      {editingColId === col.id ? (
                        <div
                          className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-zinc-850/90 border border-sky-500/40 my-0.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Folder className="h-4 w-4 text-amber-400 shrink-0" />
                          <input
                            type="text"
                            autoFocus
                            value={editingColName}
                            onChange={(e) => setEditingColName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleConfirmRenameCol(col.id);
                              else if (e.key === 'Escape') setEditingColId(null);
                            }}
                            className="flex-1 min-w-0 rounded bg-zinc-900 border border-sky-500/50 px-1.5 py-0.5 text-xs text-zinc-100 focus:outline-none focus:ring-1 focus:ring-sky-400"
                          />
                          <button
                            type="button"
                            onClick={() => handleConfirmRenameCol(col.id)}
                            className="p-1 text-emerald-400 hover:text-emerald-300 transition"
                            title="Save name"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingColId(null)}
                            className="p-1 text-zinc-400 hover:text-zinc-200 transition"
                            title="Cancel"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div
                          onClick={() => toggleCollectionCollapse(col)}
                          className="flex items-center justify-between px-2 py-1 rounded-md hover:bg-zinc-850/60 cursor-pointer transition select-none group"
                        >
                          <div className="flex items-center gap-1.5 min-w-0 flex-1 mr-1">
                            <div className="text-zinc-500 group-hover:text-zinc-300 transition shrink-0">
                              {isCollapsed ? (
                                <ChevronRight className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5" />
                              )}
                            </div>
                            {isCollapsed ? (
                              <Folder className="h-4 w-4 text-amber-400 shrink-0" />
                            ) : (
                              <FolderOpen className="h-4 w-4 text-amber-400 shrink-0" />
                            )}
                            <span
                              className="text-xs font-bold text-zinc-200 group-hover:text-white truncate"
                              title={canEditCol ? `${col.name} (Double-click to rename)` : col.name}
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                if (!canEditCol) return;
                                setEditingColId(col.id);
                                setEditingColName(col.name);
                              }}
                            >
                              {col.name}
                            </span>
                            {!canEditCol && (
                              <span title="Read-only collection">
                                <Lock className="h-3 w-3 text-zinc-500 shrink-0" />
                              </span>
                            )}
                            {col.isPartial && (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void pullCloudDelta();
                                }}
                                disabled={syncStatus === 'syncing'}
                                className="inline-flex shrink-0 items-center text-amber-400 hover:text-amber-300 disabled:cursor-wait disabled:opacity-60"
                                title="Details incomplete. Click to retry sync."
                                aria-label={`Retry loading details for ${col.name}`}
                              >
                                <AlertTriangle className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <span className="text-[10px] text-zinc-500 shrink-0 font-mono">
                              {(col.items || []).length}
                            </span>
                          </div>
                          <div
                            className={`items-center gap-0.5 shrink-0 ml-1 ${
                              activeAddMenuColId === col.id
                                ? 'flex'
                                : 'hidden max-md:flex group-hover:flex group-focus-within:flex'
                            }`}
                          >
                            {/* Collection Options 3-Dots Button */}
                            <div className="relative">
                              <button
                                ref={activeAddMenuColId === col.id ? colButtonRef : undefined}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (activeAddMenuColId === col.id) {
                                    setActiveAddMenuColId(null);
                                  } else {
                                    setColMenuOpenUpward(calculateOpenUpward(e.currentTarget, 220));
                                    setActiveAddMenuColId(col.id);
                                  }
                                }}
                                className="rounded p-1 text-zinc-500 hover:text-sky-400 hover:bg-zinc-800 transition"
                                title="Collection options"
                              >
                                <MoreVertical className="h-3.5 w-3.5" />
                              </button>

                              {activeAddMenuColId === col.id && (
                                <>
                                  <div
                                    className="fixed inset-0 z-40"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setActiveAddMenuColId(null);
                                    }}
                                  />
                                  <div
                                    ref={colMenuRef}
                                    onClick={(e) => e.stopPropagation()}
                                    className={`absolute right-0 ${
                                      colMenuOpenUpward ? 'bottom-full mb-1 origin-bottom-right' : 'top-full mt-1 origin-top-right'
                                    } z-50 w-48 rounded-lg border border-zinc-800 bg-zinc-950 p-1 shadow-xl animate-in fade-in zoom-in-95 duration-100`}
                                  >
                                    {canEditCol && (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setActiveAddMenuColId(null);
                                            setEditingColId(col.id);
                                            setEditingColName(col.name);
                                          }}
                                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-sky-400 transition"
                                        >
                                          <Pencil className="h-3.5 w-3.5 text-sky-400" />
                                          <span>Rename Collection</span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setActiveAddMenuColId(null);
                                            setCollapsedCollections((prev) => ({ ...prev, [col.id]: false }));
                                            createRequestInCollection(col.id, null, 'New Request');
                                          }}
                                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-sky-400 transition"
                                        >
                                          <FileCode className="h-3.5 w-3.5 text-sky-400" />
                                          <span>New Request</span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setActiveAddMenuColId(null);
                                            setCollapsedCollections((prev) => ({ ...prev, [col.id]: false }));
                                            setCreatingFolderInCol(col.id);
                                            setNewFolderName('');
                                          }}
                                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-amber-400 transition"
                                        >
                                          <FolderPlus className="h-3.5 w-3.5 text-amber-400" />
                                          <span>New Folder</span>
                                        </button>
                                        {canMoveScope && (
                                          <button
                                            type="button"
                                            disabled={!isMoveEnabled}
                                            onClick={() => {
                                              if (!isMoveEnabled) return;
                                              setActiveAddMenuColId(null);
                                              setCollectionToMove(col);
                                            }}
                                            title={!isMoveEnabled ? 'Move Collection is disabled by Hub policy' : undefined}
                                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-amber-400 transition disabled:cursor-not-allowed disabled:opacity-45"
                                          >
                                            <FolderInput className="h-3.5 w-3.5 text-amber-400" />
                                            <span>Move Collection</span>
                                          </button>
                                        )}
                                        {canManageCollectionPermission && (
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setActiveAddMenuColId(null);
                                              setCollectionForPermission(col);
                                            }}
                                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-sky-400 transition"
                                          >
                                            <Shield className="h-3.5 w-3.5 text-sky-400" />
                                            <span>Permission</span>
                                          </button>
                                        )}
                                      </>
                                    )}
                                    <button
                                      type="button"
                                      disabled={!isExportEnabled}
                                      onClick={(e) => {
                                        if (!isExportEnabled) return;
                                        setActiveAddMenuColId(null);
                                        handleExportCollection(e, col);
                                      }}
                                      title={!isExportEnabled ? 'Export Collection is disabled by Hub policy' : undefined}
                                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-sky-400 transition disabled:cursor-not-allowed disabled:opacity-45"
                                    >
                                      <Download className="h-3.5 w-3.5 text-sky-400" />
                                      <span>Export Collection</span>
                                    </button>
                                    <div className="my-1 border-t border-zinc-800/80" />
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setActiveAddMenuColId(null);
                                        handleExpandAllInCollection(col);
                                      }}
                                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition"
                                    >
                                      <ChevronsUpDown className="h-3.5 w-3.5 text-zinc-400" />
                                      <span>Expand All</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setActiveAddMenuColId(null);
                                        handleCollapseAllInCollection(col);
                                      }}
                                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition"
                                    >
                                      <ChevronsDownUp className="h-3.5 w-3.5 text-zinc-400" />
                                      <span>Collapse All</span>
                                    </button>
                                    {canEditCol && canDeleteScope && (
                                      <>
                                        <div className="my-1 border-t border-zinc-800/80" />
                                        <button
                                          type="button"
                                          disabled={!isDeleteEnabled}
                                          onClick={() => {
                                            if (!isDeleteEnabled) return;
                                            setActiveAddMenuColId(null);
                                            setCollectionActionError(null);
                                            setCollectionToDelete(col);
                                          }}
                                          title={!isDeleteEnabled ? 'Delete Collection is disabled by Hub policy' : undefined}
                                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-rose-400 hover:bg-rose-500/10 transition disabled:cursor-not-allowed disabled:opacity-45"
                                        >
                                          <Trash2 className="h-3.5 w-3.5 text-rose-400" />
                                          <span>Delete Collection</span>
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      )}

                      {!isCollapsed && (
                        <div className="mt-1 space-y-0.5 border-t border-zinc-850/50 pt-1">
                          {/* Inline folder creation */}
                          {creatingFolderInCol === col.id && (
                            <div
                              className="flex items-center gap-1.5 py-1 px-2 border-l border-zinc-800/60 ml-3.5 mb-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Folder className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                              <input
                                type="text"
                                autoFocus
                                value={newFolderName}
                                onChange={(e) => setNewFolderName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    const trimmed = newFolderName.trim() || 'New Folder';
                                    createFolder(col.id, null, trimmed);
                                    setCreatingFolderInCol(null);
                                    setNewFolderName('');
                                  } else if (e.key === 'Escape') {
                                    setCreatingFolderInCol(null);
                                  }
                                }}
                                placeholder="Folder name (Enter)"
                                className="w-full rounded bg-zinc-900 border border-sky-500/50 px-2 py-0.5 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  const trimmed = newFolderName.trim() || 'New Folder';
                                  createFolder(col.id, null, trimmed);
                                  setCreatingFolderInCol(null);
                                  setNewFolderName('');
                                }}
                                className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-medium text-sky-400 hover:bg-sky-500/30"
                              >
                                Add
                              </button>
                              <button
                                type="button"
                                onClick={() => setCreatingFolderInCol(null)}
                                className="rounded px-1 py-0.5 text-[10px] text-zinc-400 hover:text-white"
                              >
                                ✕
                              </button>
                            </div>
                          )}

                          {(col.items || []).length === 0 && creatingFolderInCol !== col.id ? (
                            <div className="px-2 py-1 text-[11px] text-zinc-500 italic">Empty collection</div>
                          ) : (
                            (col.items || []).map((item) => (
                              <FolderItem
                                key={item.id}
                                item={item}
                                collectionId={col.id}
                                openFolders={openFolders}
                                onToggleFolder={handleToggleFolder}
                                onOpenFolder={handleOpenFolder}
                                onExpandAllInFolder={handleExpandAllInFolder}
                                onCollapseAllInFolder={handleCollapseAllInFolder}
                                isSearching={!!trimmedQuery}
                                onSelectRequest={openRequestInTab}
                                onRequestDelete={(targetItem) =>
                                  setItemToDelete({
                                    collectionId: col.id,
                                    itemId: targetItem.id,
                                    name: targetItem.name,
                                    type: targetItem.type,
                                  })
                                }
                                onRequestMove={(targetItem, colId) =>
                                  setRequestToMove({
                                    item: targetItem,
                                    collectionId: colId,
                                  })
                                }
                                draggedItem={draggedItem}
                                setDraggedItem={setDraggedItem}
                                onReorderItem={reorderItem}
                                canEdit={canEditCol}
                              />
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
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
                <h3 className="mt-3 text-xs font-semibold text-zinc-300">
                  {history.length === 0 ? 'No History' : 'No Matching History'}
                </h3>
                <p className="mt-1 text-[11px] text-zinc-500">
                  {history.length === 0
                    ? 'Requests sent will automatically appear here.'
                    : `No history item matched "${searchQuery}".`}
                </p>
                {history.length > 0 && searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="mt-2 text-[11px] text-sky-400 hover:text-sky-300 underline"
                  >
                    Clear search
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-1">
                {filteredHistory.map((item) => {
                  const status = item.response?.status;
                  const isOk = status && status >= 200 && status < 300;

                  return (
                    <div
                      key={item.id}
                      onClick={() => openRequestInTab(item.request, item.response)}
                      className="group flex flex-col gap-1 rounded-lg border border-line bg-card/60 p-2 hover:bg-hover hover:border-line-strong cursor-pointer transition"
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <MethodBadge method={item.request.method} size="sm" />
                          <span className="text-xs font-medium text-tx-primary truncate">
                            {item.request.name || item.request.url}
                          </span>
                        </div>
                        {status !== undefined && (
                          <span
                            className={`text-[10px] font-mono font-bold px-1 rounded ${
                              isOk
                                ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'
                                : 'text-rose-600 dark:text-rose-400 bg-rose-500/10'
                            }`}
                          >
                            {status || 'ERR'}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center justify-between text-[10px] text-tx-muted font-mono">
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
        onClose={() => {
          if (!isDeletingCollection) setCollectionToDelete(null);
        }}
        onConfirm={() => {
          if (!collectionToDelete) return;
          setIsDeletingCollection(true);
          void deleteCollection(collectionToDelete.id).then((result) => {
            if (result.success) {
              setCollectionToDelete(null);
              setCollectionActionError(null);
            } else {
              setCollectionActionError(result.error || 'Failed to delete collection.');
            }
          }).finally(() => {
            setIsDeletingCollection(false);
          });
        }}
        title="Delete Collection"
        message={
          <span>
            Are you sure you want to delete collection{' '}
            <strong className="text-zinc-200">"{collectionToDelete?.name}"</strong>? This will permanently remove the collection and all its requests.
            {collectionActionError && <span className="mt-2 block text-rose-300">{collectionActionError}</span>}
          </span>
        }
        confirmText="Delete Collection"
        variant="danger"
        isLoading={isDeletingCollection}
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

      <ConfirmModal
        isOpen={!!itemToDelete}
        onClose={() => setItemToDelete(null)}
        onConfirm={() => {
          if (itemToDelete) {
            deleteCollectionItem(itemToDelete.collectionId, itemToDelete.itemId);
            setItemToDelete(null);
          }
        }}
        title={itemToDelete?.type === 'folder' ? 'Delete Folder' : 'Remove Request'}
        message={
          <span>
            Are you sure you want to {itemToDelete?.type === 'folder' ? 'delete folder' : 'remove request'}{' '}
            <strong className="text-zinc-200">"{itemToDelete?.name}"</strong>
            {itemToDelete?.type === 'folder' ? ' and all its contents?' : ' from this collection?'}
          </span>
        }
        confirmText={itemToDelete?.type === 'folder' ? 'Delete Folder' : 'Remove Request'}
        variant="danger"
      />

      <MoveCollectionModal
        isOpen={!!collectionToMove}
        onClose={() => setCollectionToMove(null)}
        collection={collectionToMove}
      />

      <CollectionPermissionModal
        isOpen={!!collectionForPermission}
        onClose={() => setCollectionForPermission(null)}
        collection={collectionForPermission}
      />

      <MoveRequestModal
        isOpen={!!requestToMove}
        onClose={() => setRequestToMove(null)}
        item={requestToMove?.item || null}
        sourceCollectionId={requestToMove?.collectionId || ''}
      />

      <ImportModal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
      />

      {!isOfflineOnly && (
        <>
          <ModeSelectorModal
            isOpen={isModeSelectorOpen}
            onClose={() => setIsModeSelectorOpen(false)}
            onSelectCloud={() => setIsCloudAuthOpen(true)}
          />
          <CloudAuthModal
            isOpen={isCloudAuthOpen}
            onClose={() => setIsCloudAuthOpen(false)}
          />
        </>
      )}
    </aside>
  );
};
