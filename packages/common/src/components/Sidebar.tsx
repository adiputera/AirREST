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
  GripVertical,
  Copy,
  BookOpen,
  Flame,
  Play,
} from 'lucide-react';
import { useApiStore, type SelectedSavedExample } from '../store/useApiStore';
import { CollectionItem, ApiRequest, Collection, RunnerMode } from '../types/api';
import { MethodBadge } from './MethodBadge';
import { exportPostmanCollection } from '../lib/postman';
import {
  getDisplayExampleSummaries,
  getItemExampleCount,
  hasUnloadedCollectionExamples,
  MAX_SAVED_EXAMPLE_NAME_RUNES,
  validateSavedExampleName,
} from '../lib/examples';
import { ConfirmModal } from './ConfirmModal';
import { MoveCollectionModal } from './MoveCollectionModal';
import { CollectionPermissionModal } from './CollectionPermissionModal';
import { MoveRequestModal } from './MoveRequestModal';
import { MoveFolderModal } from './MoveFolderModal';
import { DuplicateCollectionModal } from './DuplicateCollectionModal';
import { DuplicateItemModal } from './DuplicateItemModal';
import { PendingDuplicateRecovery } from './PendingDuplicateRecovery';
import { ImportModal } from './ImportModal';
import { findRequestAncestorIds, isDescendantOf } from '../lib/treeHelper';
import {
  buildCollectionPerformanceLaunchConfig,
  buildFolderPerformanceLaunchConfig,
} from '../lib/perfLaunch';
import { canModifyCollection, hasScopePermission } from '../lib/jwt';

import { ScopeSwitcher } from './ScopeSwitcher';
import { UserMenu } from './UserMenu';
import { MobileThemeSegmentedControl } from './ThemeToggle';
import { ModeSelectorModal } from './ModeSelectorModal';
import { CloudAuthModal } from './CloudAuthModal';
import { usePlatformAdapter, useProductPolicy } from '../context';

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
        const exampleNames = getDisplayExampleSummaries(item).map((ex) => ex.name || '').join(' ');
        const fullText = `${item.name || ''} ${item.request?.method || ''} ${item.request?.url || ''} ${exampleNames}`.toLowerCase();
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

export const DEFAULT_SIDEBAR_WIDTH = 288;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 800;

export function clampSidebarWidth(
  width: number,
  winWidth = typeof window !== 'undefined' ? window.innerWidth : 1200
): number {
  const maxAllowed = Math.min(MAX_SIDEBAR_WIDTH, Math.max(380, Math.floor(winWidth * 0.55)));
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxAllowed, Math.round(width)));
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
  searchQuery?: string;
  expandedExampleItems?: Record<string, boolean>;
  onToggleExampleItem?: (collectionId: string, item: CollectionItem) => void;
  selectedExample?: SelectedSavedExample | null;
  onSelectExample?: (selection: SelectedSavedExample) => void;
  onRenameExample?: (collectionId: string, itemId: string, exampleId: string, name: string) => Promise<void> | void;
  onDeleteExample?: (collectionId: string, itemId: string, exampleId: string, name: string) => void;
  onSelectRequest: (req: ApiRequest) => void;
  onRequestDelete: (item: CollectionItem) => void;
  onRequestMove: (item: CollectionItem, collectionId: string) => void;
  onRequestMoveFolder?: (item: CollectionItem, collectionId: string) => void;
  onRequestDuplicateItem?: (item: CollectionItem, collectionId: string, trigger?: HTMLElement | null) => void;
  onRunPerformanceFolder?: (folder: CollectionItem, collectionId: string, runnerMode?: RunnerMode) => void;
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
  searchQuery = '',
  expandedExampleItems = {},
  onToggleExampleItem,
  selectedExample,
  onSelectExample,
  onRenameExample,
  onDeleteExample,
  onSelectRequest,
  onRequestDelete,
  onRequestMove,
  onRequestMoveFolder,
  onRequestDuplicateItem,
  onRunPerformanceFolder,
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
  const [editingExampleId, setEditingExampleId] = useState<string | null>(null);
  const [editingExampleName, setEditingExampleName] = useState('');

  const handleConfirmRenameExample = async (exampleId: string, originalName: string) => {
    const validation = validateSavedExampleName(editingExampleName);
    if (validation.valid && validation.name !== originalName && onRenameExample) {
      await onRenameExample(collectionId, item.id, exampleId, validation.name);
    }
    setEditingExampleId(null);
  };

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
    if (!draggedItem) {
      if (dropPosition !== null) setDropPosition(null);
      if (isForbidden) setIsForbidden(false);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (!canEdit) return;

    const currentPos = dropPosition;
    const forbidden = isForbidden;
    setDropPosition(null);
    setIsForbidden(false);

    if (forbidden || !currentPos) {
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
                            onClick={(e) => {
                              e.stopPropagation();
                              setIsMenuOpen(false);
                              onRequestMoveFolder?.(item, collectionId);
                            }}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-amber-500 transition"
                          >
                            <FolderInput className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" />
                            <span>Move Folder</span>
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setIsMenuOpen(false);
                              onRequestDuplicateItem?.(item, collectionId, buttonRef.current);
                            }}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-sky-500 transition"
                          >
                            <Copy className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
                            <span>Duplicate Folder</span>
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
                          onRunPerformanceFolder?.(item, collectionId, 'functional');
                        }}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-emerald-500 transition"
                      >
                        <Play className="h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400" />
                        <span>Run Folder</span>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsMenuOpen(false);
                          onRunPerformanceFolder?.(item, collectionId, 'performance');
                        }}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-amber-500 transition"
                      >
                        <Flame className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" />
                        <span>Performance Test</span>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsMenuOpen(false);
                          onExpandAllInFolder(item);
                        }}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
                      >
                        <ChevronsUpDown className="h-3.5 w-3.5 text-tx-muted" />
                        <span>Expand All</span>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsMenuOpen(false);
                          onCollapseAllInFolder(item);
                        }}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
                      >
                        <ChevronsDownUp className="h-3.5 w-3.5 text-tx-muted" />
                        <span>Collapse All</span>
                      </button>
                      {canEdit && (
                        <>
                          <div className="my-1 border-t border-line" />
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setIsMenuOpen(false);
                              onRequestDelete(item);
                            }}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-rose-500 dark:text-rose-400 hover:bg-rose-500/10 transition"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-rose-500 dark:text-rose-400" />
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
            className="flex items-center gap-1.5 py-1 px-2 border-l border-line ml-3.5 mt-0.5"
            style={{ paddingLeft: `${Math.max((level + 1) * 12, 8)}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <Folder className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400 shrink-0" />
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
              className="w-full rounded bg-card border border-sky-500/50 px-2 py-0.5 text-xs text-tx-primary placeholder-tx-faint focus:outline-none"
            />
            <button
              type="button"
              onClick={handleConfirmCreateSubfolder}
              className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400 hover:bg-sky-500/30"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => setIsCreatingSubfolder(false)}
              className="rounded px-1 py-0.5 text-[10px] text-tx-muted hover:text-tx-primary"
            >
              ✕
            </button>
          </div>
        )}

        {isOpen && (!item.items || item.items.length === 0) && !isCreatingSubfolder && (
          <div
            onDragOver={(e) => {
              if (!draggedItem) return;
              if (draggedItem.collectionId !== collectionId) {
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
              if (!draggedItem) return;
              e.preventDefault();
              e.stopPropagation();
              if (draggedItem.collectionId !== collectionId || draggedItem.id === item.id) return;
              if (draggedItem.type === 'folder' && isDescendantOf(collectionItems, draggedItem.id, item.id)) return;
              onReorderItem(collectionId, draggedItem.id, item.id, 'inside');
              setDraggedItem(null);
            }}
            className="ml-3.5 mt-0.5 border-l border-line pl-3 py-1 text-[10px] text-tx-faint hover:text-sky-500 hover:bg-sky-500/10 rounded transition select-none"
          >
            Empty folder (drop here)
          </div>
        )}

        {isOpen && item.items && item.items.length > 0 && (
          <div className="border-l border-line ml-3.5 mt-0.5">
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
                searchQuery={searchQuery}
                expandedExampleItems={expandedExampleItems}
                onToggleExampleItem={onToggleExampleItem}
                selectedExample={selectedExample}
                onSelectExample={onSelectExample}
                onRenameExample={onRenameExample}
                onDeleteExample={onDeleteExample}
                onSelectRequest={onSelectRequest}
                onRequestDelete={onRequestDelete}
                onRequestMove={onRequestMove}
                onRequestMoveFolder={onRequestMoveFolder}
                onRequestDuplicateItem={onRequestDuplicateItem}
                onRunPerformanceFolder={onRunPerformanceFolder}
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
        className="flex items-center gap-1.5 py-1 px-2 rounded-md bg-card border border-sky-500/40 text-xs font-medium my-0.5"
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
    );
  }

  const exampleCount = getItemExampleCount(item);
  const displaySummaries = getDisplayExampleSummaries(item);
  const searchTokens = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hasMatchingExample =
    isSearching &&
    searchTokens.length > 0 &&
    displaySummaries.some((ex) => {
      const exText = `${ex.name || ''} ${ex.code} ${ex.status || ''}`.toLowerCase();
      return searchTokens.every((tok) => exText.includes(tok));
    });
  const isExamplesExpanded = exampleCount > 0 && (hasMatchingExample || !!expandedExampleItems[item.id]);

  return (
    <div className="select-none">
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
      className={`group relative flex items-center gap-1.5 py-1.5 px-2 rounded-md transition text-xs ${
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
      {exampleCount > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExampleItem?.(collectionId, item);
          }}
          className="rounded p-0.5 text-tx-faint hover:bg-hover hover:text-tx-primary transition shrink-0"
          aria-label={isExamplesExpanded ? 'Collapse saved examples' : 'Expand saved examples'}
          title={`${exampleCount} saved example${exampleCount === 1 ? '' : 's'}`}
        >
          {isExamplesExpanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
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
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsMenuOpen(false);
                    onRequestDuplicateItem?.(item, collectionId, buttonRef.current);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-sky-500 transition"
                >
                  <Copy className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
                  <span>Duplicate Request</span>
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
    {isExamplesExpanded && (
      <div
        className="border-l border-line ml-4 mt-0.5 space-y-0.5"
        draggable={false}
        onDragStart={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {displaySummaries.length === 0 ? (
          <div className="px-2 py-1 text-[10px] text-tx-muted italic" style={{ paddingLeft: `${Math.max((level + 1) * 12, 12)}px` }}>
            Loading saved examples...
          </div>
        ) : (
          displaySummaries.map((ex) => {
            const isSelected =
              selectedExample?.collectionId === collectionId &&
              selectedExample?.itemId === item.id &&
              selectedExample?.exampleId === ex.id;
            if (editingExampleId === ex.id) {
              return (
                <div
                  key={ex.id}
                  draggable={false}
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-1 py-1 px-2 rounded bg-card border border-sky-500/40 text-[11px]"
                  style={{ paddingLeft: `${Math.max((level + 1) * 12, 10)}px` }}
                >
                  <BookOpen className="h-3 w-3 shrink-0 text-sky-500" />
                  <input
                    type="text"
                    autoFocus
                    maxLength={MAX_SAVED_EXAMPLE_NAME_RUNES}
                    value={editingExampleName}
                    onChange={(e) => setEditingExampleName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleConfirmRenameExample(ex.id, ex.name);
                      else if (e.key === 'Escape') setEditingExampleId(null);
                    }}
                    className="flex-1 min-w-0 rounded bg-element px-1.5 py-0.5 text-[11px] text-tx-primary focus:outline-none focus:ring-1 focus:ring-sky-400"
                  />
                  <button
                    type="button"
                    onClick={() => void handleConfirmRenameExample(ex.id, ex.name)}
                    className="p-0.5 text-emerald-500"
                    title="Save name"
                  >
                    <Check className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingExampleId(null)}
                    className="p-0.5 text-tx-muted hover:text-tx-primary"
                    title="Cancel"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            }
            return (
              <div
                key={ex.id}
                draggable={false}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectExample?.({
                    collectionId,
                    itemId: item.id,
                    exampleId: ex.id,
                  });
                }}
                className={`group/ex flex items-center gap-1.5 py-1 px-2 rounded-md text-[11px] cursor-pointer transition ${
                  isSelected
                    ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300 font-medium'
                    : 'text-tx-muted hover:bg-hover hover:text-tx-primary'
                }`}
                style={{ paddingLeft: `${Math.max((level + 1) * 12, 10)}px` }}
                title={`${ex.code} ${ex.status} — ${ex.name}`}
              >
                <BookOpen className="h-3 w-3 shrink-0 text-sky-500/80" />
                <span className="font-mono text-[10px] text-tx-faint shrink-0">{ex.code}</span>
                <span
                  className="truncate flex-1"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (!canEdit) return;
                    setEditingExampleId(ex.id);
                    setEditingExampleName(ex.name);
                  }}
                >
                  {ex.name}
                </span>
                {canEdit && (
                  <div className="hidden group-hover/ex:flex max-md:flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingExampleId(ex.id);
                        setEditingExampleName(ex.name);
                      }}
                      className="rounded p-0.5 text-tx-muted hover:text-sky-500"
                      title="Rename example"
                    >
                      <Pencil className="h-2.5 w-2.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteExample?.(collectionId, item.id, ex.id, ex.name);
                      }}
                      className="rounded p-0.5 text-tx-muted hover:text-rose-500"
                      title="Delete example"
                    >
                      <Trash2 className="h-2.5 w-2.5" />
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    )}
    </div>
  );
};

export interface SidebarProps {
  onClose?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ onClose }) => {
  const runtimeAdapter = usePlatformAdapter();
  const productPolicy = useProductPolicy();
  const isOfflineOnly = !productPolicy.workspace.cloud;
  const sidebarTab = useApiStore((state) => state.sidebarTab);
  const setSidebarTab = useApiStore((state) => state.setSidebarTab);
  const collections = useApiStore((state) => state.collections);
  const history = useApiStore((state) => state.history);
  const activeTabId = useApiStore((state) => state.activeTabId);
  const activeOfflineWorkspaceId = useApiStore((state) => state.activeOfflineWorkspaceId);
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
  const loadCollectionDetails = useApiStore((state) => state.loadCollectionDetails);
  const selectedExample = useApiStore((state) => state.selectedExample);
  const selectSavedExample = useApiStore((state) => state.selectSavedExample);
  const loadItemExamples = useApiStore((state) => state.loadItemExamples);
  const hydrateCollectionExamples = useApiStore((state) => state.hydrateCollectionExamples);
  const renameSavedExample = useApiStore((state) => state.renameSavedExample);
  const deleteSavedExample = useApiStore((state) => state.deleteSavedExample);
  const openPerformanceTestTab = useApiStore((state) => state.openPerformanceTestTab);
  const syncStatus = useApiStore((state) => state.syncStatus);
  const lastDuplicateReveal = useApiStore((state) => state.lastDuplicateReveal);

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
  const [collectionToDuplicate, setCollectionToDuplicate] = useState<{
    collection: Collection;
    trigger?: HTMLElement | null;
  } | null>(null);
  const [collectionForPermission, setCollectionForPermission] = useState<Collection | null>(null);
  const [collectionActionError, setCollectionActionError] = useState<string | null>(null);
  const [isDeletingCollection, setIsDeletingCollection] = useState(false);
  const [showClearHistoryConfirm, setShowClearHistoryConfirm] = useState(false);
  const [collapsedCollections, setCollapsedCollections] = useState<Record<string, boolean>>({});
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [expandedExampleItems, setExpandedExampleItems] = useState<Record<string, boolean>>({});
  const [exampleToDelete, setExampleToDelete] = useState<{
    collectionId: string;
    itemId: string;
    exampleId: string;
    name: string;
  } | null>(null);
  const lastRevealedPath = useRef<string | null>(null);
  const lastRevealedDuplicateRevision = useRef<number>(0);
  const workspaceKey = JSON.stringify(workspaceMode === 'offline'
    ? [workspaceMode, activeOfflineWorkspaceId]
    : [workspaceMode, cloudConfig.apiUrl, cloudConfig.user?.id,
      cloudConfig.activeScope?.type, cloudConfig.activeScope?.id]);

  useEffect(() => {
    setCollectionToMove(null);
    setRequestToMove(null);
    setFolderToMove(null);
    setExpandedExampleItems({});
    setExampleToDelete(null);
  }, [workspaceKey]);

  useEffect(() => {
    if (!selectedExample?.itemId) return;
    setExpandedExampleItems((prev) =>
      prev[selectedExample.itemId] ? prev : { ...prev, [selectedExample.itemId]: true },
    );
  }, [selectedExample?.itemId]);

  useEffect(() => {
    const [collectionId, ...folderIds] = findRequestAncestorIds(collections, activeTabId);
    const pathKey = JSON.stringify([workspaceKey, activeTabId, collectionId, folderIds]);
    // Edits and background sync must preserve manual expansion when the path is unchanged.
    if (lastRevealedPath.current === pathKey) return;
    lastRevealedPath.current = pathKey;
    setCollapsedCollections(collectionId ? { [collectionId]: false } : {});
    setOpenFolders(Object.fromEntries(folderIds.map((id) => [id, true])));
  }, [collections, activeTabId, workspaceKey]);

  useEffect(() => {
    if (!lastDuplicateReveal || lastDuplicateReveal.pathIds.length === 0) return;
    if (lastRevealedDuplicateRevision.current === lastDuplicateReveal.revision) return;
    lastRevealedDuplicateRevision.current = lastDuplicateReveal.revision;
    const [collectionId, ...folderIds] = lastDuplicateReveal.pathIds;
    if (collectionId) {
      setCollapsedCollections((prev) => ({ ...prev, [collectionId]: false }));
    }
    if (folderIds.length > 0) {
      setOpenFolders((prev) => ({
        ...prev,
        ...Object.fromEntries(folderIds.map((id) => [id, true])),
      }));
    }
  }, [lastDuplicateReveal]);

  // Desktop Sidebar drag-to-resize (persisted in localStorage)
  const [isDesktop, setIsDesktop] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 768 : true
  );
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('airrest:sidebar_width');
      if (saved) {
        const val = parseInt(saved, 10);
        if (!isNaN(val)) return clampSidebarWidth(val);
      }
    } catch {
      // ignore
    }
    return DEFAULT_SIDEBAR_WIDTH;
  });

  const [isResizing, setIsResizing] = useState(false);
  const isResizingSidebarRef = useRef(false);
  const startSidebarXRef = useRef(0);
  const startSidebarWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const latestSidebarWidthRef = useRef(sidebarWidth);
  latestSidebarWidthRef.current = sidebarWidth;

  useEffect(() => {
    const handleResize = () => {
      const desktop = window.innerWidth >= 768;
      setIsDesktop(desktop);
      if (desktop) {
        setSidebarWidth((curr) => clampSidebarWidth(curr, window.innerWidth));
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

  const handleStartSidebarResize = (clientX: number) => {
    isResizingSidebarRef.current = true;
    startSidebarXRef.current = clientX;
    startSidebarWidthRef.current = latestSidebarWidthRef.current;
    setIsResizing(true);

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizingSidebarRef.current) return;
      const deltaX = e.clientX - startSidebarXRef.current;
      const newWidth = clampSidebarWidth(startSidebarWidthRef.current + deltaX, window.innerWidth);
      latestSidebarWidthRef.current = newWidth;
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      if (!isResizingSidebarRef.current) return;
      isResizingSidebarRef.current = false;
      setIsResizing(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.removeProperty('user-select');
      document.body.style.removeProperty('cursor');
      try {
        localStorage.setItem('airrest:sidebar_width', String(latestSidebarWidthRef.current));
      } catch {
        // ignore
      }
    };

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleTouchStartSidebarResize = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    isResizingSidebarRef.current = true;
    startSidebarXRef.current = touch.clientX;
    startSidebarWidthRef.current = latestSidebarWidthRef.current;
    setIsResizing(true);

    const onTouchMove = (ev: TouchEvent) => {
      if (!isResizingSidebarRef.current) return;
      const moveTouch = ev.touches[0];
      if (!moveTouch) return;
      const deltaX = moveTouch.clientX - startSidebarXRef.current;
      const newWidth = clampSidebarWidth(startSidebarWidthRef.current + deltaX, window.innerWidth);
      latestSidebarWidthRef.current = newWidth;
      setSidebarWidth(newWidth);
    };

    const onTouchEnd = () => {
      if (!isResizingSidebarRef.current) return;
      isResizingSidebarRef.current = false;
      setIsResizing(false);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      document.body.style.removeProperty('user-select');
      document.body.style.removeProperty('cursor');
      try {
        localStorage.setItem('airrest:sidebar_width', String(latestSidebarWidthRef.current));
      } catch {
        // ignore
      }
    };

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd);
  };

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
  const [folderToMove, setFolderToMove] = useState<{
    item: CollectionItem;
    collectionId: string;
  } | null>(null);
  const [itemToDuplicate, setItemToDuplicate] = useState<{
    item: CollectionItem;
    collectionId: string;
    trigger?: HTMLElement | null;
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

  const handleToggleExampleItem = (colId: string, item: CollectionItem) => {
    const isCurrentlyOpen = !!expandedExampleItems[item.id];
    setExpandedExampleItems((prev) => ({
      ...prev,
      [item.id]: !isCurrentlyOpen,
    }));
    if (
      !isCurrentlyOpen &&
      workspaceMode === 'cloud' &&
      (item.exampleSummariesTruncated || (item.examplesLoaded === false && getDisplayExampleSummaries(item).length === 0))
    ) {
      void loadItemExamples(colId, item.id);
    }
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
    const isCurrentlyCollapsed = !trimmedQuery && collapsedCollections[col.id] !== false;
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

  const resolveUnprunedCollection = (colId: string, fallback: Collection): Collection =>
    (collections || []).find((c) => c.id === colId) || fallback;

  const findUnprunedCollectionItem = (
    items: CollectionItem[],
    itemId: string
  ): CollectionItem | null => {
    for (const it of items) {
      if (it.id === itemId) return it;
      if (it.type === 'folder' && it.items) {
        const found = findUnprunedCollectionItem(it.items, itemId);
        if (found) return found;
      }
    }
    return null;
  };

  const resolveUnprunedItem = (
    colId: string,
    fallback: CollectionItem
  ): CollectionItem => {
    const fullCol = (collections || []).find((c) => c.id === colId);
    if (!fullCol) return fallback;
    return findUnprunedCollectionItem(fullCol.items || [], fallback.id) || fallback;
  };

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
      let exportTarget = resolveUnprunedCollection(col.id, col);
      if (exportTarget.isPartial) {
        if (workspaceMode === 'cloud') {
          const detailResult = await loadCollectionDetails(exportTarget.id);
          if (!detailResult.success || !detailResult.collection) {
            setCollectionActionError(
              detailResult.error || 'Cannot export collection: failed to load full collection details.'
            );
            return;
          }
          exportTarget = detailResult.collection;
        } else {
          setCollectionActionError('Cannot export a partially loaded collection.');
          return;
        }
      }
      if (workspaceMode === 'cloud' && hasUnloadedCollectionExamples(exportTarget)) {
        const hydrated = await hydrateCollectionExamples(exportTarget.id, { includeBody: true });
        if (!hydrated.success || !hydrated.collection) {
          setCollectionActionError(
            hydrated.error || 'Cannot export collection: failed to load saved examples.'
          );
          return;
        }
        exportTarget = hydrated.collection;
      }
      const json = exportPostmanCollection(exportTarget);
      const filename = `${exportTarget.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-postman-v2.1.json`;
      const adapter = runtimeAdapter;

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
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.error('Failed to export collection', err);
      setCollectionActionError(
        err instanceof Error ? err.message : 'Failed to export collection.'
      );
    }
  };

  const handleRunPerformanceCollection = async (
    e: React.MouseEvent,
    col: Collection,
    runnerMode: RunnerMode = 'performance'
  ) => {
    e.stopPropagation();
    try {
      let targetCol = resolveUnprunedCollection(col.id, col);
      if (targetCol.isPartial && workspaceMode === 'cloud') {
        const detailResult = await loadCollectionDetails(targetCol.id);
        if (!detailResult.success || !detailResult.collection) {
          setCollectionActionError(
            detailResult.error || 'Failed to load collection details for Collection Runner.'
          );
          return;
        }
        targetCol = detailResult.collection;
      }
      const config = buildCollectionPerformanceLaunchConfig(targetCol, runtimeAdapter?.platformId, runnerMode);
      if (config.items.length === 0) {
        setCollectionActionError('This collection has no requests to test.');
        return;
      }
      openPerformanceTestTab(config);
      onClose?.();
    } catch (err) {
      setCollectionActionError(
        err instanceof Error ? err.message : 'Failed to open collection runner.'
      );
    }
  };

  const handleRunPerformanceFolder = async (
    folder: CollectionItem,
    collectionId: string,
    runnerMode: RunnerMode = 'performance'
  ) => {
    try {
      let fullCol = (collections || []).find((c) => c.id === collectionId);
      if (fullCol?.isPartial && workspaceMode === 'cloud') {
        const detailResult = await loadCollectionDetails(fullCol.id);
        if (detailResult.success && detailResult.collection) {
          fullCol = detailResult.collection;
        }
      }
      const targetFolder = fullCol
        ? findUnprunedCollectionItem(fullCol.items || [], folder.id) || folder
        : folder;
      const config = buildFolderPerformanceLaunchConfig(
        collectionId,
        targetFolder,
        runtimeAdapter?.platformId,
        runnerMode
      );
      if (config.items.length === 0) {
        setCollectionActionError('This folder has no requests to test.');
        return;
      }
      openPerformanceTestTab(config);
      onClose?.();
    } catch (err) {
      setCollectionActionError(
        err instanceof Error ? err.message : 'Failed to open folder runner.'
      );
    }
  };

  return (
    <aside
      className={`relative flex h-full ${
        isDesktop ? 'shrink-0' : 'w-80 max-w-[85vw]'
      } flex-col border-r border-line bg-surface select-none`}
      style={{
        width: isDesktop ? `${sidebarWidth}px` : undefined,
      }}
    >
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
      <div className="p-2 border-b border-line space-y-1.5">
        <div className="relative flex items-center">
          <Search className="absolute left-2.5 h-3.5 w-3.5 text-tx-muted pointer-events-none" />
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
            className="w-full rounded-lg border border-line bg-card/90 py-1.5 pl-8 pr-7 text-xs text-tx-primary placeholder-tx-faint focus:border-sky-500 focus:outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 text-tx-muted hover:text-tx-primary transition p-0.5 rounded"
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
              <div className="flex items-center justify-center gap-1.5 rounded-lg border border-line bg-card/50 py-1.5 px-2 text-[11px] text-tx-muted select-none">
                <Lock className="h-3 w-3 text-tx-muted shrink-0" />
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
                      className="flex-1 rounded-md border border-sky-500/50 bg-card px-2 py-1 text-xs text-tx-primary placeholder-tx-faint focus:outline-none"
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
                      className="rounded-md bg-sky-500/20 px-2 py-1 text-[11px] font-medium text-sky-600 dark:text-sky-400 hover:bg-sky-500/30"
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsCreatingCol(false)}
                      className="rounded-md px-1.5 py-1 text-[11px] text-tx-muted hover:text-tx-primary"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setIsCreatingCol(true)}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line py-1 text-[11px] text-tx-muted hover:border-line-strong hover:text-tx-primary transition"
                  >
                    <FolderPlus className="h-3 w-3 text-sky-500 dark:text-sky-400" />
                    <span>New Collection</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setIsImportOpen(true)}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line py-1 text-[11px] text-tx-muted hover:border-line-strong hover:text-tx-primary transition"
                  title="Import Postman Collection or Environment"
                >
                  <Upload className="h-3 w-3 text-emerald-500 dark:text-emerald-400" />
                  <span>Import</span>
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Pending Duplicate Recovery Banner */}
      <PendingDuplicateRecovery />

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {sidebarTab === 'collections' ? (
          <div>
            {collections.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-card text-tx-muted border border-line">
                  <FolderPlus className="h-5 w-5" />
                </div>
                <h3 className="mt-3 text-xs font-semibold text-tx-secondary">No Collections Yet</h3>
                <p className="mt-1 text-[11px] text-tx-muted leading-relaxed">
                  Create a new collection or import your Postman collection or environment to organize your API requests.
                </p>
                <button
                  type="button"
                  onClick={() => setIsImportOpen(true)}
                  className="mt-3 flex items-center gap-1.5 rounded-lg border border-line-strong bg-card px-3 py-1.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 hover:bg-hover hover:border-emerald-500/30 transition shadow-xs"
                >
                  <Upload className="h-3 w-3" />
                  <span>Import</span>
                </button>
              </div>
            ) : filteredCollections.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                <Search className="h-6 w-6 text-tx-faint" />
                <h4 className="mt-2 text-xs font-semibold text-tx-secondary">No Matching Results</h4>
                <p className="mt-1 text-[11px] text-tx-muted">
                  No collection or request matched &ldquo;{searchQuery}&rdquo;.
                </p>
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="mt-2 text-[11px] text-sky-500 dark:text-sky-400 hover:underline"
                  >
                    Clear search
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {filteredCollections.map((col) => {
                  const isCollapsed = !trimmedQuery && collapsedCollections[col.id] !== false;
                  const canEditCol = !col.isPartial && canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role);

                  return (
                    <div key={col.id} className="rounded-lg border border-line bg-card/40 p-1.5 transition">
                      {editingColId === col.id ? (
                        <div
                          className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-card border border-sky-500/40 my-0.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Folder className="h-4 w-4 text-amber-500 dark:text-amber-400 shrink-0" />
                          <input
                            type="text"
                            autoFocus
                            value={editingColName}
                            onChange={(e) => setEditingColName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleConfirmRenameCol(col.id);
                              else if (e.key === 'Escape') setEditingColId(null);
                            }}
                            className="flex-1 min-w-0 rounded bg-card border border-sky-500/50 px-1.5 py-0.5 text-xs text-tx-primary focus:outline-none focus:ring-1 focus:ring-sky-400"
                          />
                          <button
                            type="button"
                            onClick={() => handleConfirmRenameCol(col.id)}
                            className="p-1 text-emerald-500 dark:text-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-300 transition"
                            title="Save name"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingColId(null)}
                            className="p-1 text-tx-muted hover:text-tx-primary transition"
                            title="Cancel"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div
                          onClick={() => toggleCollectionCollapse(col)}
                          className="flex items-center justify-between px-2 py-1 rounded-md hover:bg-hover cursor-pointer transition select-none group"
                        >
                          <div className="flex items-center gap-1.5 min-w-0 flex-1 mr-1">
                            <div className="text-tx-muted group-hover:text-tx-secondary transition shrink-0">
                              {isCollapsed ? (
                                <ChevronRight className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5" />
                              )}
                            </div>
                            {isCollapsed ? (
                              <Folder className="h-4 w-4 text-amber-500 dark:text-amber-400 shrink-0" />
                            ) : (
                              <FolderOpen className="h-4 w-4 text-amber-500 dark:text-amber-400 shrink-0" />
                            )}
                            <span
                              className="text-xs font-bold text-tx-primary truncate"
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
                                <Lock className="h-3 w-3 text-tx-muted shrink-0" />
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
                                className="inline-flex shrink-0 items-center text-amber-500 dark:text-amber-400 hover:text-amber-600 dark:hover:text-amber-300 disabled:cursor-wait disabled:opacity-60"
                                title="Details incomplete. Click to retry sync."
                                aria-label={`Retry loading details for ${col.name}`}
                              >
                                <AlertTriangle className="h-3.5 w-3.5" />
                              </button>
                            )}
                            {col._syncStatus === 'pending' && !col.isPartial && (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void pullCloudDelta();
                                }}
                                disabled={syncStatus === 'syncing'}
                                className="inline-flex shrink-0 items-center text-amber-500 dark:text-amber-400 hover:text-amber-600 dark:hover:text-amber-300 disabled:cursor-wait disabled:opacity-60"
                                title="Sync pending: this collection is not yet uploaded to the cloud. Click to retry sync."
                                aria-label={`Retry uploading ${col.name}`}
                              >
                                <Upload className="h-3.5 w-3.5 animate-pulse" />
                              </button>
                            )}
                            <span className="text-[10px] text-tx-muted shrink-0 font-mono">
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
                                className="rounded p-1 text-tx-muted hover:text-sky-500 dark:hover:text-sky-400 hover:bg-hover transition"
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
                                    } z-50 w-48 rounded-lg border border-line bg-surface p-1 shadow-xl animate-in fade-in zoom-in-95 duration-100`}
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
                                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-sky-500 dark:hover:text-sky-400 transition"
                                        >
                                          <Pencil className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
                                          <span>Rename Collection</span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setActiveAddMenuColId(null);
                                            setCollapsedCollections((prev) => ({ ...prev, [col.id]: false }));
                                            createRequestInCollection(col.id, null, 'New Request');
                                          }}
                                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-sky-500 dark:hover:text-sky-400 transition"
                                        >
                                          <FileCode className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
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
                                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-amber-500 dark:hover:text-amber-400 transition"
                                        >
                                          <FolderPlus className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" />
                                          <span>New Folder</span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            const trigger = colButtonRef.current;
                                            setActiveAddMenuColId(null);
                                            setCollectionToDuplicate({
                                              collection: resolveUnprunedCollection(col.id, col),
                                              trigger,
                                            });
                                          }}
                                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-sky-500 dark:hover:text-sky-400 transition"
                                        >
                                          <Copy className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
                                          <span>Duplicate Collection</span>
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
                                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-amber-500 dark:hover:text-amber-400 transition disabled:cursor-not-allowed disabled:opacity-45"
                                          >
                                            <FolderInput className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" />
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
                                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-sky-500 dark:hover:text-sky-400 transition"
                                          >
                                            <Shield className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
                                            <span>Permission</span>
                                          </button>
                                        )}
                                      </>
                                    )}
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        setActiveAddMenuColId(null);
                                        void handleRunPerformanceCollection(e, col, 'functional');
                                      }}
                                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-emerald-500 dark:hover:text-emerald-400 transition"
                                    >
                                      <Play className="h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400" />
                                      <span>Run Collection</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        setActiveAddMenuColId(null);
                                        void handleRunPerformanceCollection(e, col, 'performance');
                                      }}
                                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-amber-500 dark:hover:text-amber-400 transition"
                                    >
                                      <Flame className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" />
                                      <span>Performance Test</span>
                                    </button>
                                    <button
                                      type="button"
                                      disabled={!isExportEnabled}
                                      onClick={(e) => {
                                        if (!isExportEnabled) return;
                                        setActiveAddMenuColId(null);
                                        handleExportCollection(e, col);
                                      }}
                                      title={!isExportEnabled ? 'Export Collection is disabled by Hub policy' : undefined}
                                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-sky-500 dark:hover:text-sky-400 transition disabled:cursor-not-allowed disabled:opacity-45"
                                    >
                                      <Download className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
                                      <span>Export Collection</span>
                                    </button>
                                    <div className="my-1 border-t border-line" />
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setActiveAddMenuColId(null);
                                        handleExpandAllInCollection(col);
                                      }}
                                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
                                    >
                                      <ChevronsUpDown className="h-3.5 w-3.5 text-tx-muted" />
                                      <span>Expand All</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setActiveAddMenuColId(null);
                                        handleCollapseAllInCollection(col);
                                      }}
                                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
                                    >
                                      <ChevronsDownUp className="h-3.5 w-3.5 text-tx-muted" />
                                      <span>Collapse All</span>
                                    </button>
                                    {canEditCol && canDeleteScope && (
                                      <>
                                        <div className="my-1 border-t border-line" />
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
                                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-rose-500 dark:text-rose-400 hover:bg-rose-500/10 transition disabled:cursor-not-allowed disabled:opacity-45"
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
                        <div className="mt-1 space-y-0.5 border-t border-line pt-1">
                          {/* Inline folder creation */}
                          {creatingFolderInCol === col.id && (
                            <div
                              className="flex items-center gap-1.5 py-1 px-2 border-l border-line ml-3.5 mb-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Folder className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400 shrink-0" />
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
                                className="w-full rounded bg-card border border-sky-500/50 px-2 py-0.5 text-xs text-tx-primary placeholder-tx-faint focus:outline-none"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  const trimmed = newFolderName.trim() || 'New Folder';
                                  createFolder(col.id, null, trimmed);
                                  setCreatingFolderInCol(null);
                                  setNewFolderName('');
                                }}
                                className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400 hover:bg-sky-500/30"
                              >
                                Add
                              </button>
                              <button
                                type="button"
                                onClick={() => setCreatingFolderInCol(null)}
                                className="rounded px-1 py-0.5 text-[10px] text-tx-muted hover:text-tx-primary"
                              >
                                ✕
                              </button>
                            </div>
                          )}

                          {(col.items || []).length === 0 && creatingFolderInCol !== col.id ? (
                            <div className="px-2 py-1 text-[11px] text-tx-muted italic">Empty collection</div>
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
                                searchQuery={searchQuery}
                                expandedExampleItems={expandedExampleItems}
                                onToggleExampleItem={handleToggleExampleItem}
                                selectedExample={selectedExample}
                                onSelectExample={(selection) => {
                                  selectSavedExample(selection);
                                  onClose?.();
                                }}
                                onRenameExample={async (colId, itemId, exampleId, nextName) => {
                                  const res = await renameSavedExample({ collectionId: colId, itemId, exampleId, name: nextName });
                                  if (!res.success && !res.reconcilePending && res.error) {
                                    setCollectionActionError(res.error);
                                  }
                                }}
                                onDeleteExample={(colId, itemId, exampleId, name) =>
                                  setExampleToDelete({ collectionId: colId, itemId, exampleId, name })
                                }
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
                                    item: resolveUnprunedItem(colId, targetItem),
                                    collectionId: colId,
                                  })
                                }
                                onRequestMoveFolder={(targetItem, colId) =>
                                  setFolderToMove({
                                    item: resolveUnprunedItem(colId, targetItem),
                                    collectionId: colId,
                                  })
                                }
                                onRequestDuplicateItem={(targetItem, colId, trigger) =>
                                  setItemToDuplicate({
                                    item: resolveUnprunedItem(colId, targetItem),
                                    collectionId: colId,
                                    trigger,
                                  })
                                }
                                onRunPerformanceFolder={(targetFolder, colId, mode) => {
                                  void handleRunPerformanceFolder(targetFolder, colId, mode);
                                }}
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
                  className="flex items-center gap-1 text-[11px] text-tx-muted hover:text-rose-500 dark:hover:text-rose-400 transition"
                >
                  <Trash2 className="h-3 w-3" />
                  Clear all
                </button>
              </div>
            )}

            {filteredHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                <Clock className="h-8 w-8 text-tx-faint" />
                <h3 className="mt-3 text-xs font-semibold text-tx-secondary">
                  {history.length === 0 ? 'No History' : 'No Matching History'}
                </h3>
                <p className="mt-1 text-[11px] text-tx-muted">
                  {history.length === 0
                    ? 'Requests sent will automatically appear here.'
                    : `No history item matched "${searchQuery}".`}
                </p>
                {history.length > 0 && searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="mt-2 text-[11px] text-sky-500 dark:text-sky-400 hover:underline"
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
                        <span className="truncate flex-1 min-w-0 mr-2">{item.request.url}</span>
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
            <strong className="text-tx-primary">"{collectionToDelete?.name}"</strong>? This will permanently remove the collection and all its requests.
            {collectionActionError && <span className="mt-2 block text-rose-500 dark:text-rose-300">{collectionActionError}</span>}
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
            <strong className="text-tx-primary">"{itemToDelete?.name}"</strong>
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

      <MoveFolderModal
        isOpen={!!folderToMove}
        onClose={() => setFolderToMove(null)}
        item={folderToMove?.item || null}
        sourceCollectionId={folderToMove?.collectionId || ''}
      />

      <DuplicateCollectionModal
        isOpen={!!collectionToDuplicate}
        onClose={() => setCollectionToDuplicate(null)}
        collection={collectionToDuplicate?.collection || null}
        returnFocusTo={collectionToDuplicate?.trigger}
      />

      <DuplicateItemModal
        isOpen={!!itemToDuplicate}
        onClose={() => setItemToDuplicate(null)}
        item={itemToDuplicate?.item || null}
        sourceCollectionId={itemToDuplicate?.collectionId || ''}
        returnFocusTo={itemToDuplicate?.trigger}
      />

      <ImportModal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
      />

      <ConfirmModal
        isOpen={!!exampleToDelete}
        onClose={() => setExampleToDelete(null)}
        onConfirm={async () => {
          if (!exampleToDelete) return;
          const target = exampleToDelete;
          setExampleToDelete(null);
          const res = await deleteSavedExample({
            collectionId: target.collectionId,
            itemId: target.itemId,
            exampleId: target.exampleId,
          });
          if (!res.success && !res.reconcilePending && res.error) {
            setCollectionActionError(res.error);
          }
        }}
        title="Delete Saved Example"
        message={
          exampleToDelete
            ? `Are you sure you want to delete saved example "${exampleToDelete.name}"?`
            : ''
        }
        confirmText="Delete"
      />

      {!isOfflineOnly && (
        <>
          {productPolicy.workspace.offline !== false && (
            <ModeSelectorModal
              isOpen={isModeSelectorOpen}
              onClose={() => setIsModeSelectorOpen(false)}
              onSelectCloud={() => setIsCloudAuthOpen(true)}
            />
          )}
          <CloudAuthModal
            isOpen={isCloudAuthOpen}
            onClose={() => setIsCloudAuthOpen(false)}
          />
        </>
      )}

      {/* Drag-to-resize handle (Desktop only) */}
      {isDesktop && (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-valuenow={sidebarWidth}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-label="Resize collection sidebar width"
          title="Drag left/right to resize sidebar (Double-click to reset)"
          onMouseDown={(e) => {
            e.preventDefault();
            handleStartSidebarResize(e.clientX);
          }}
          onTouchStart={(e) => {
            handleTouchStartSidebarResize(e);
          }}
          onDoubleClick={() => {
            setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
            try {
              localStorage.setItem('airrest:sidebar_width', String(DEFAULT_SIDEBAR_WIDTH));
            } catch {
              // ignore
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              setSidebarWidth((curr) => {
                const next = clampSidebarWidth(curr - 16);
                try {
                  localStorage.setItem('airrest:sidebar_width', String(next));
                } catch {
                  // ignore
                }
                return next;
              });
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              setSidebarWidth((curr) => {
                const next = clampSidebarWidth(curr + 16);
                try {
                  localStorage.setItem('airrest:sidebar_width', String(next));
                } catch {
                  // ignore
                }
                return next;
              });
            } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Home') {
              e.preventDefault();
              setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
              try {
                localStorage.setItem('airrest:sidebar_width', String(DEFAULT_SIDEBAR_WIDTH));
              } catch {
                // ignore
              }
            }
          }}
          className="absolute top-0 -right-1.5 bottom-0 w-3 cursor-col-resize z-20 group select-none flex items-center justify-center focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500"
        >
          <div
            className={`h-full w-[2px] transition-colors duration-150 ${
              isResizing ? 'bg-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.5)]' : 'bg-transparent group-hover:bg-sky-400/70'
            }`}
          />
          {/* Tooltip badge while hovering or resizing */}
          <div
            className={`pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 z-40 items-center gap-1.5 rounded-md border border-line bg-card/95 px-2 py-1 text-[10px] font-mono text-tx-secondary shadow-lg backdrop-blur whitespace-nowrap transition-opacity duration-150 ${
              isResizing ? 'flex opacity-100' : 'hidden group-hover:flex'
            }`}
          >
            <GripVertical className="h-3 w-3 text-sky-400" />
            <span>{sidebarWidth}px</span>
          </div>
        </div>
      )}
    </aside>
  );
};
