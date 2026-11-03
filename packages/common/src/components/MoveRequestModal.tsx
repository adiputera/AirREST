'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  FolderInput,
  Folder,
  X,
  Loader2,
  AlertCircle,
  ArrowRight,
} from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { CollectionItem } from '../types/api';
import { findSavedRequestInCollections } from '../lib/requestDiff';
import { MethodBadge } from './MethodBadge';
import { canModifyCollection } from '../lib/jwt';
import { useBackHandler } from '../lib/backNavigation';

interface MoveRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  item: CollectionItem | null;
  sourceCollectionId: string;
}

export const MoveRequestModal: React.FC<MoveRequestModalProps> = ({
  isOpen,
  onClose,
  item,
  sourceCollectionId,
}) => {
  const collections = useApiStore((state) => state.collections);
  const moveRequest = useApiStore((state) => state.moveRequest);
  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);

  const [selectedCollectionId, setSelectedCollectionId] = useState<string>(sourceCollectionId);
  const [selectedFolderId, setSelectedFolderId] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  useBackHandler(isOpen && Boolean(item), () => { if (!isSubmitting) onClose(); }, 20);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Retrieve current source collection & folder information
  const sourceCollection = useMemo(
    () => collections.find((c) => c.id === sourceCollectionId),
    [collections, sourceCollectionId]
  );

  const savedInfo = useMemo(() => {
    if (!item) return null;
    return findSavedRequestInCollections(collections, item.id || item.request?.id || '');
  }, [collections, item]);

  const currentFolderId = savedInfo?.folderId || null;

  // Extract human-readable path of the current folder
  const currentFolderName = useMemo(() => {
    if (!sourceCollection || !currentFolderId) return 'Root of Collection';
    let found = '';
    const findFolder = (items: CollectionItem[], prefix = '') => {
      for (const it of items) {
        if (it.type === 'folder') {
          const full = prefix ? `${prefix} / ${it.name}` : it.name;
          if (it.id === currentFolderId) {
            found = full;
            return;
          }
          if (it.items) findFolder(it.items, full);
        }
      }
    };
    findFolder(sourceCollection.items || []);
    return found || 'Folder';
  }, [sourceCollection, currentFolderId]);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen && item) {
      setSelectedCollectionId(sourceCollectionId);
      const info = findSavedRequestInCollections(collections, item.id || item.request?.id || '');
      setSelectedFolderId(info?.folderId || '');
      setErrorMsg(null);
      setIsSubmitting(false);
    }
  }, [isOpen, item?.id, sourceCollectionId]);

  // Extract all nested folders from the currently selected target collection
  const targetCollection = useMemo(
    () => collections.find((c) => c.id === selectedCollectionId),
    [collections, selectedCollectionId]
  );

  const canEditSource = canModifyCollection(sourceCollection?.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role);
  const canEditTarget = canModifyCollection(targetCollection?.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role);

  const availableFolders = useMemo(() => {
    if (!targetCollection) return [];
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

  if (!isOpen || !item) return null;

  const isSameLocation =
    selectedCollectionId === sourceCollectionId &&
    (selectedFolderId || '') === (currentFolderId || '');

  const handleMove = async () => {
    if (!canEditSource) {
      setErrorMsg('Cannot move request: source collection is read-only for your role.');
      return;
    }
    if (!canEditTarget) {
      setErrorMsg('Cannot move request: target collection is read-only for your role.');
      return;
    }
    if (isSameLocation || isSubmitting) return;
    setIsSubmitting(true);
    setErrorMsg(null);

    const res = await moveRequest(
      sourceCollectionId,
      item.id,
      selectedCollectionId,
      selectedFolderId ? selectedFolderId : null
    );

    if (res && !res.success) {
      setErrorMsg(res.error || 'Failed to move request');
      setIsSubmitting(false);
      return;
    }

    // Close modal immediately on success
    setIsSubmitting(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border border-line-strong bg-card p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line pb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
              <FolderInput className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-tx-primary">Move Request</h2>
              <p className="text-xs text-tx-muted">Move request to another folder or collection</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg p-1.5 text-tx-muted hover:bg-hover hover:text-tx-primary transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Current Request Info */}
        <div className="mt-4 rounded-xl border border-line bg-element/50 p-3 space-y-2">
          <div className="flex items-center gap-2">
            {item.request && <MethodBadge method={item.request.method} size="sm" />}
            <span className="text-xs font-semibold text-tx-primary truncate flex-1" title={item.name}>
              {item.name}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-tx-muted truncate">
            <Folder className="h-3 w-3 text-amber-400/80 shrink-0" />
            <span className="text-tx-muted">Current:</span>
            <span className="text-tx-secondary truncate font-mono">
              {sourceCollection?.name || 'Collection'} / {currentFolderName}
            </span>
          </div>
        </div>

        {/* Form Body */}
        <div className="mt-4 space-y-4">
          {/* Target Collection */}
          <div>
            <label className="block text-xs font-semibold text-tx-secondary mb-1.5">
              Target Collection
            </label>
            <select
              value={selectedCollectionId}
              onChange={(e) => {
                setSelectedCollectionId(e.target.value);
                setSelectedFolderId('');
              }}
              disabled={isSubmitting}
              className="w-full rounded-xl border border-line bg-card p-2.5 text-xs text-tx-primary focus:border-sky-500 focus:outline-none cursor-pointer"
            >
              {collections.map((col) => {
                const isTargetEditable = canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role);
                return (
                  <option key={col.id} value={col.id} disabled={!isTargetEditable}>
                    {col.name} {col.id === sourceCollectionId ? '(Current Collection)' : ''} {!isTargetEditable ? '(Read-only)' : ''}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Target Folder */}
          <div>
            <label className="block text-xs font-semibold text-tx-secondary mb-1.5">
              Target Folder
            </label>
            <select
              value={selectedFolderId}
              onChange={(e) => setSelectedFolderId(e.target.value)}
              disabled={isSubmitting}
              className="w-full rounded-xl border border-line bg-card p-2.5 text-xs text-tx-primary focus:border-sky-500 focus:outline-none cursor-pointer"
            >
              <option value="">(Root Collection / No Folder)</option>
              {availableFolders.map((folder) => {
                const isCurrent =
                  selectedCollectionId === sourceCollectionId && folder.id === currentFolderId;
                return (
                  <option key={folder.id} value={folder.id}>
                    {folder.name} {isCurrent ? '(Current Folder)' : ''}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Read-Only Notice */}
          {!canEditSource && (
            <div className="flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-300 animate-in fade-in">
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
              <span>Source collection is read-only for your role. Requests cannot be moved out of it.</span>
            </div>
          )}

          {/* Error Message */}
          {errorMsg && (
            <div className="flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-300 animate-in fade-in">
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="mt-6 flex items-center justify-end gap-2.5 border-t border-line pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-xl border border-line px-4 py-2 text-xs font-medium text-tx-muted hover:bg-hover hover:text-tx-primary transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleMove}
            disabled={isSubmitting || isSameLocation || !canEditSource || !canEditTarget}
            className="flex items-center gap-1.5 rounded-xl bg-sky-500 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-sky-500/20 hover:bg-sky-400 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Moving...</span>
              </>
            ) : isSameLocation ? (
              <span>Already in this location</span>
            ) : (
              <>
                <FolderInput className="h-3.5 w-3.5" />
                <span>Move Request</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
