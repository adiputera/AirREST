'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Copy,
  Folder,
  FolderPlus,
  X,
  Loader2,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { CollectionItem } from '../types/api';
import { findSavedFolderInCollections, findSavedRequestInCollections } from '../lib/requestDiff';
import {
  duplicateItemSubtree,
  getTargetFolderDepth,
  resolveDuplicateName,
  validateDuplicateName,
} from '../lib/duplicate';
import { MethodBadge } from './MethodBadge';
import { canModifyCollection, hasScopePermission } from '../lib/jwt';
import { useBackHandler } from '../lib/backNavigation';

interface DuplicateItemModalProps {
  isOpen: boolean;
  onClose: () => void;
  item: CollectionItem | null;
  sourceCollectionId: string;
  returnFocusTo?: HTMLElement | null;
}

export const DuplicateItemModal: React.FC<DuplicateItemModalProps> = ({
  isOpen,
  onClose,
  item,
  sourceCollectionId,
  returnFocusTo,
}) => {
  const collections = useApiStore((state) => state.collections);
  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);
  const duplicateCollectionItem = useApiStore((state) => state.duplicateCollectionItem);
  const loadCollectionDetails = useApiStore((state) => state.loadCollectionDetails);
  const createCollectionAsync = useApiStore((state) => state.createCollectionAsync);

  const [selectedCollectionId, setSelectedCollectionId] = useState<string>(sourceCollectionId);
  const [selectedFolderId, setSelectedFolderId] = useState<string>('');
  const [isCreatingCollection, setIsCreatingCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingFolders, setIsLoadingFolders] = useState(false);
  const [folderLoadError, setFolderLoadError] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reconcilePending, setReconcilePending] = useState(false);
  const [folderReloadNonce, setFolderReloadNonce] = useState(0);

  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const pendingOpIdRef = useRef<string | null>(null);

  const handleClose = useCallback(() => {
    if (isSubmitting) return;
    pendingOpIdRef.current = null;
    setReconcilePending(false);
    setErrorMsg(null);
    onClose();
  }, [isSubmitting, onClose]);

  useBackHandler(isOpen && Boolean(item), handleClose, 20);

  useEffect(() => {
    if (isOpen && item) {
      previousFocusRef.current = returnFocusTo || (document.activeElement as HTMLElement | null);
      setTimeout(() => {
        dialogRef.current?.focus();
      }, 0);
      return;
    }
    if (!isOpen && previousFocusRef.current) {
      previousFocusRef.current.focus?.();
      previousFocusRef.current = null;
    }
  }, [isOpen, item, returnFocusTo]);

  useEffect(() => {
    if (!isOpen || !item) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, item, isSubmitting, handleClose]);

  const sourceCollection = useMemo(
    () => collections.find((c) => c.id === sourceCollectionId),
    [collections, sourceCollectionId],
  );

  const currentParentFolderId = useMemo(() => {
    if (!item) return null;
    if (item.type === 'folder') {
      return findSavedFolderInCollections(collections, item.id)?.parentFolderId || null;
    }
    return findSavedRequestInCollections(collections, item.id || item.request?.id || '')?.folderId || null;
  }, [collections, item]);

  // Reset form when modal opens or scope changes
  useEffect(() => {
    if (!isOpen || !item) {
      pendingOpIdRef.current = null;
      setReconcilePending(false);
      setErrorMsg(null);
      setFolderLoadError(null);
      return;
    }
    setSelectedCollectionId(sourceCollectionId);
    setSelectedFolderId(currentParentFolderId || '');
    setIsCreatingCollection(false);
    setNewCollectionName('');
    setErrorMsg(null);
    setFolderLoadError(null);
    setIsSubmitting(false);
    pendingOpIdRef.current = null;
    setReconcilePending(false);
  }, [isOpen, item?.id, sourceCollectionId, workspaceMode, cloudConfig.activeScope?.type, cloudConfig.activeScope?.id]);

  const targetCollection = useMemo(
    () => collections.find((c) => c.id === selectedCollectionId),
    [collections, selectedCollectionId],
  );

  // Lazy-fetch details when target collection in active workspace is isPartial
  useEffect(() => {
    if (!isOpen || !item || isCreatingCollection || !targetCollection || !targetCollection.isPartial) {
      setIsLoadingFolders(false);
      return;
    }
    let active = true;
    setIsLoadingFolders(true);
    setFolderLoadError(null);
    void loadCollectionDetails(targetCollection.id).then((res) => {
      if (!active) return;
      setIsLoadingFolders(false);
      if (!res.success) {
        setFolderLoadError(res.error || 'Failed to load target collection folders.');
      }
    });
    return () => {
      active = false;
    };
  }, [isOpen, item?.id, isCreatingCollection, targetCollection?.id, targetCollection?.isPartial, folderReloadNonce, loadCollectionDetails]);

  const canCreateInScope = hasScopePermission(
    cloudConfig.activeScope,
    'collection:write',
    workspaceMode,
    cloudConfig.user?.role,
  );
  const canEditSource = canModifyCollection(
    sourceCollection?.minRole,
    cloudConfig.activeScope,
    workspaceMode,
    cloudConfig.user?.role,
  );
  const canEditTarget = isCreatingCollection
    ? canCreateInScope
    : canModifyCollection(
        targetCollection?.minRole,
        cloudConfig.activeScope,
        workspaceMode,
        cloudConfig.user?.role,
      );

  const availableFolders = useMemo(() => {
    if (!targetCollection || targetCollection.isPartial) return [];
    const list: { id: string; name: string }[] = [];
    const extract = (items: CollectionItem[], prefix = '') => {
      for (const it of items) {
        if (it.type === 'folder') {
          const full = prefix ? `${prefix} / ${it.name}` : it.name;
          list.push({ id: it.id, name: full });
          if (it.items && it.items.length > 0) {
            extract(it.items, full);
          }
        }
      }
    };
    extract(targetCollection.items || []);
    return list;
  }, [targetCollection]);

  const validationPreview = useMemo(() => {
    if (!item) {
      return { name: '', error: null as string | null, requiresNewCollectionName: false };
    }

    if (isCreatingCollection) {
      const trimmedColName = newCollectionName.trim();
      let previewName = item.name;
      const label = item.type === 'folder' ? 'Folder name' : 'Request name';
      try {
        previewName = resolveDuplicateName(item.name, false, label);
      } catch (err: any) {
        return { name: item.name, error: err?.message || 'Invalid name.', requiresNewCollectionName: false };
      }

      if (!trimmedColName) {
        return {
          name: previewName,
          error: newCollectionName.length > 0 ? 'Collection name is required.' : null,
          requiresNewCollectionName: true,
        };
      }

      try {
        validateDuplicateName(trimmedColName, 'Collection name');
        duplicateItemSubtree(item, { sameCollection: false, targetParentDepth: 0 });
        return { name: previewName, error: null as string | null, requiresNewCollectionName: false };
      } catch (err: any) {
        return {
          name: previewName,
          error: err?.message || 'Invalid new collection or item configuration.',
          requiresNewCollectionName: false,
        };
      }
    }

    if (!targetCollection || targetCollection.isPartial) {
      return { name: item?.name || '', error: null as string | null, requiresNewCollectionName: false };
    }
    const sameCollection = selectedCollectionId === sourceCollectionId;
    const label = item.type === 'folder' ? 'Folder name' : 'Request name';
    let previewName = item.name;
    try {
      previewName = resolveDuplicateName(item.name, sameCollection, label);
    } catch (err: any) {
      return { name: item.name, error: err?.message || 'Invalid name.', requiresNewCollectionName: false };
    }

    const parentDepth = getTargetFolderDepth(targetCollection.items || [], selectedFolderId || null);
    if (parentDepth === null) {
      return { name: previewName, error: 'Selected target folder no longer exists.', requiresNewCollectionName: false };
    }
    try {
      duplicateItemSubtree(item, { sameCollection, targetParentDepth: parentDepth });
      return { name: previewName, error: null as string | null, requiresNewCollectionName: false };
    } catch (err: any) {
      return { name: previewName, error: err?.message || 'Cannot duplicate item to this destination.', requiresNewCollectionName: false };
    }
  }, [
    item,
    isCreatingCollection,
    newCollectionName,
    targetCollection,
    selectedCollectionId,
    sourceCollectionId,
    selectedFolderId,
  ]);

  if (!isOpen || !item) return null;

  const isFolder = item.type === 'folder';
  const childCount = item.items?.length || 0;

  const handleConfirmDuplicate = async () => {
    if (!canEditSource) {
      setErrorMsg('Cannot duplicate: source collection is read-only for your role.');
      return;
    }
    if (!canEditTarget) {
      setErrorMsg('Cannot duplicate: target collection is read-only for your role.');
      return;
    }
    if (isSubmitting || validationPreview.error) {
      return;
    }
    if (!isCreatingCollection && (!targetCollection || targetCollection.isPartial || isLoadingFolders)) {
      return;
    }
    if (isCreatingCollection && !newCollectionName.trim()) {
      setErrorMsg('Collection name is required.');
      return;
    }

    const opId = pendingOpIdRef.current || crypto.randomUUID();
    pendingOpIdRef.current = opId;
    setIsSubmitting(true);
    setErrorMsg(null);

    let effectiveTargetCollectionId = selectedCollectionId;
    let effectiveTargetFolderId: string | null = selectedFolderId ? selectedFolderId : null;

    if (isCreatingCollection) {
      if (!createCollectionAsync) {
        setIsSubmitting(false);
        setErrorMsg('Creating collections is unavailable.');
        return;
      }
      const created = await createCollectionAsync(newCollectionName.trim());
      if (!created.success || !created.collectionId) {
        setIsSubmitting(false);
        setErrorMsg(created.error || 'Failed to create new collection.');
        return;
      }
      effectiveTargetCollectionId = created.collectionId;
      effectiveTargetFolderId = null;
      // Lock onto the created collection so any retry reuses it instead of creating another empty collection
      setIsCreatingCollection(false);
      setSelectedCollectionId(created.collectionId);
      setSelectedFolderId('');
      setNewCollectionName('');
    }

    const res = await duplicateCollectionItem(
      sourceCollectionId,
      item.id,
      effectiveTargetCollectionId,
      effectiveTargetFolderId,
      { operationId: opId },
    );

    setIsSubmitting(false);
    if (res.success) {
      pendingOpIdRef.current = null;
      setReconcilePending(false);
      onClose();
      return;
    }

    if (res.reconcilePending) {
      setReconcilePending(true);
      setErrorMsg(res.error || 'Duplicate status uncertain. Click Retry to safely reconcile.');
    } else {
      pendingOpIdRef.current = null;
      setReconcilePending(false);
      setErrorMsg(res.error || 'Failed to duplicate item.');
    }
  };

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) handleClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="duplicate-item-title"
        tabIndex={-1}
        className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-line-strong bg-card p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-150 focus:outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line pb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-500 dark:text-sky-400 border border-sky-500/20">
              <Copy className="h-5 w-5" />
            </div>
            <div>
              <h2 id="duplicate-item-title" className="text-base font-semibold text-tx-primary">
                {isFolder ? 'Duplicate Folder' : 'Duplicate Request'}
              </h2>
              <p className="text-xs text-tx-muted">
                {isFolder
                  ? 'Copy folder and its contents to a collection or folder'
                  : 'Copy saved request to a collection or folder'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={isSubmitting}
            aria-label="Close modal"
            className="rounded-lg p-1.5 text-tx-muted hover:bg-hover hover:text-tx-primary transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Item Info + Result Preview */}
        <div className="mt-4 rounded-xl border border-line bg-element/50 p-3 space-y-2">
          <div className="flex items-center gap-2">
            {isFolder ? (
              <Folder className="h-4 w-4 text-amber-500 dark:text-amber-400 shrink-0" />
            ) : (
              item.request && <MethodBadge method={item.request.method} size="sm" />
            )}
            <span className="text-xs font-semibold text-tx-primary truncate flex-1" title={item.name}>
              {item.name}
            </span>
            {isFolder && (
              <span className="text-[10px] text-tx-muted font-mono bg-element px-1.5 py-0.5 rounded border border-line">
                {childCount} {childCount === 1 ? 'item' : 'items'}
              </span>
            )}
          </div>
          <div className="text-[11px] text-tx-muted truncate">
            Result Name: <span className="font-semibold text-tx-primary">{validationPreview.name}</span>
          </div>
        </div>

        {/* Form Body */}
        <div className="mt-4 space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor={isCreatingCollection ? 'duplicate-new-collection-name' : 'duplicate-target-collection'}
                className="block text-xs font-semibold text-tx-secondary"
              >
                Target Collection
              </label>
              {canCreateInScope && (
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => {
                    pendingOpIdRef.current = null;
                    setReconcilePending(false);
                    setErrorMsg(null);
                    setFolderLoadError(null);
                    setIsCreatingCollection((prev) => {
                      const next = !prev;
                      if (next) setSelectedFolderId('');
                      return next;
                    });
                  }}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-500 hover:text-sky-400 disabled:opacity-50"
                >
                  <FolderPlus className="h-3 w-3" />
                  <span>{isCreatingCollection ? 'Select Existing' : 'New Collection'}</span>
                </button>
              )}
            </div>
            {isCreatingCollection ? (
              <input
                id="duplicate-new-collection-name"
                type="text"
                value={newCollectionName}
                onChange={(e) => {
                  pendingOpIdRef.current = null;
                  setReconcilePending(false);
                  setErrorMsg(null);
                  setNewCollectionName(e.target.value);
                }}
                placeholder="Enter new collection name..."
                disabled={isSubmitting}
                className="w-full rounded-xl border border-line bg-card p-2.5 text-xs text-tx-primary focus:border-sky-500 focus:outline-none"
              />
            ) : (
              <select
                id="duplicate-target-collection"
                value={selectedCollectionId}
                onChange={(e) => {
                  pendingOpIdRef.current = null;
                  setReconcilePending(false);
                  setErrorMsg(null);
                  setSelectedCollectionId(e.target.value);
                  setSelectedFolderId('');
                }}
                disabled={isSubmitting}
                className="w-full rounded-xl border border-line bg-card p-2.5 text-xs text-tx-primary focus:border-sky-500 focus:outline-none cursor-pointer"
              >
                {collections.map((col) => {
                  const isTargetEditable = canModifyCollection(
                    col.minRole,
                    cloudConfig.activeScope,
                    workspaceMode,
                    cloudConfig.user?.role,
                  );
                  return (
                    <option key={col.id} value={col.id} disabled={!isTargetEditable}>
                      {col.name} {col.id === sourceCollectionId ? '(Current Collection)' : ''} {!isTargetEditable ? '(Read-only)' : ''}
                    </option>
                  );
                })}
              </select>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="duplicate-target-folder" className="block text-xs font-semibold text-tx-secondary">
                Target Folder
              </label>
              {!isCreatingCollection && folderLoadError && (
                <button
                  type="button"
                  onClick={() => setFolderReloadNonce((n) => n + 1)}
                  disabled={isLoadingFolders || isSubmitting}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-500 hover:text-sky-400"
                >
                  <RefreshCw className="h-3 w-3" />
                  <span>Retry</span>
                </button>
              )}
            </div>

            {isCreatingCollection ? (
              <div className="rounded-xl border border-line bg-card/60 p-2.5 text-xs text-tx-muted">
                (Root of New Collection)
              </div>
            ) : isLoadingFolders ? (
              <div className="flex items-center gap-2 rounded-xl border border-line bg-card p-2.5 text-xs text-tx-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500" />
                <span>Loading folders...</span>
              </div>
            ) : (
              <select
                id="duplicate-target-folder"
                value={selectedFolderId}
                onChange={(e) => {
                  pendingOpIdRef.current = null;
                  setReconcilePending(false);
                  setErrorMsg(null);
                  setSelectedFolderId(e.target.value);
                }}
                disabled={isSubmitting || Boolean(targetCollection?.isPartial)}
                className="w-full rounded-xl border border-line bg-card p-2.5 text-xs text-tx-primary focus:border-sky-500 focus:outline-none cursor-pointer"
              >
                <option value="">(Root of Collection / No Folder)</option>
                {availableFolders.map((folder) => {
                  const isCurrent =
                    selectedCollectionId === sourceCollectionId && folder.id === currentParentFolderId;
                  return (
                    <option key={folder.id} value={folder.id}>
                      {folder.name} {isCurrent ? '(Current Parent)' : ''}
                    </option>
                  );
                })}
              </select>
            )}
          </div>

          {folderLoadError && (
            <div className="flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-500 dark:text-rose-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{folderLoadError}</span>
            </div>
          )}

          {(!canEditSource || !canEditTarget) && (
            <div className="flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-500 dark:text-rose-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>Write permission on both source and target collections is required.</span>
            </div>
          )}

          {validationPreview.error && (
            <div className="flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-500 dark:text-rose-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{validationPreview.error}</span>
            </div>
          )}

          {errorMsg && (
            <div className="flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-500 dark:text-rose-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2.5 border-t border-line pt-4">
          <button
            type="button"
            onClick={handleClose}
            disabled={isSubmitting}
            className="rounded-xl border border-line px-4 py-2 text-xs font-medium text-tx-muted hover:bg-hover hover:text-tx-primary transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirmDuplicate}
            disabled={
              isSubmitting ||
              (!isCreatingCollection && (isLoadingFolders || Boolean(targetCollection?.isPartial))) ||
              (isCreatingCollection && Boolean(validationPreview.requiresNewCollectionName)) ||
              !canEditSource ||
              !canEditTarget ||
              Boolean(validationPreview.error)
            }
            className="flex items-center gap-1.5 rounded-xl bg-sky-500 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-sky-500/20 hover:bg-sky-400 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Duplicating...</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span>{reconcilePending ? 'Retry Duplicate' : isFolder ? 'Duplicate Folder' : 'Duplicate Request'}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
