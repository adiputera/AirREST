'use client';

import React, { useState } from 'react';
import { Bookmark, X, Check } from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import { ApiRequest, CollectionItem } from '@/types/api';
import { findSavedRequestInCollections } from '@/lib/requestDiff';

interface SaveToCollectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  request: ApiRequest;
}

export const SaveToCollectionModal: React.FC<SaveToCollectionModalProps> = ({
  isOpen,
  onClose,
  request,
}) => {
  const collections = useApiStore((state) => state.collections);
  const createCollection = useApiStore((state) => state.createCollection);
  const saveRequestToCollection = useApiStore((state) => state.saveRequestToCollection);
  const moveRequest = useApiStore((state) => state.moveRequest);
  const updateActiveRequest = useApiStore((state) => state.updateActiveRequest);

  const savedInfo = findSavedRequestInCollections(collections, request.id);

  const [requestName, setRequestName] = useState(request.name || 'Untitled Request');
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>(
    savedInfo?.collection.id || collections[0]?.id || ''
  );
  const [selectedFolderId, setSelectedFolderId] = useState<string>(savedInfo?.folderId || '');
  const [isCreatingCollection, setIsCreatingCollection] = useState(collections.length === 0);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [isSaved, setIsSaved] = useState(false);

  if (!isOpen) return null;

  // Extract all folders from the selected collection
  const currentCollection = collections.find((c) => c.id === selectedCollectionId);
  const folders: { id: string; name: string }[] = [];

  const extractFolders = (items: CollectionItem[], prefix = '') => {
    for (const item of items) {
      if (item.type === 'folder') {
        const full = prefix ? `${prefix} / ${item.name}` : item.name;
        folders.push({ id: item.id, name: full });
        if (item.items) {
          extractFolders(item.items, full);
        }
      }
    }
  };

  if (currentCollection) {
    extractFolders(currentCollection.items);
  }

  const handleSave = () => {
    let targetCollectionId = selectedCollectionId;

    if (isCreatingCollection) {
      const trimmedName = newCollectionName.trim() || 'New Collection';
      targetCollectionId = createCollection(trimmedName);
    }

    if (!targetCollectionId) return;

    const finalName = requestName.trim() || 'Untitled Request';
    const targetFolder = selectedFolderId ? selectedFolderId : null;

    const isRelocating =
      savedInfo &&
      (savedInfo.collection.id !== targetCollectionId ||
        (savedInfo.folderId || null) !== targetFolder);

    if (isRelocating) {
      moveRequest(
        savedInfo.collection.id,
        request.id,
        targetCollectionId,
        targetFolder
      );
    }

    saveRequestToCollection(
      targetCollectionId,
      targetFolder,
      {
        ...request,
        name: finalName,
      }
    );
    updateActiveRequest({ name: finalName });

    setIsSaved(true);
    setTimeout(() => {
      setIsSaved(false);
      onClose();
    }, 600);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-850 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
              <Bookmark className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-100">Save Request</h2>
              <p className="text-xs text-zinc-400">Save to a collection for organized testing</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form Body */}
        <div className="mt-4 space-y-4">
          {/* Request Name */}
          <div>
            <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
              Request Name
            </label>
            <input
              type="text"
              value={requestName}
              onChange={(e) => setRequestName(e.target.value)}
              placeholder="e.g. Authenticate User, Get Todo List"
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900/90 p-2.5 font-mono text-xs text-zinc-100 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
            />
          </div>

          {/* Collection Picker / Create new */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold text-zinc-300">
                Collection
              </label>
              {collections.length > 0 && (
                <button
                  type="button"
                  onClick={() => setIsCreatingCollection(!isCreatingCollection)}
                  className="text-[11px] text-sky-400 hover:text-sky-300 transition flex items-center gap-1"
                >
                  {isCreatingCollection ? 'Select Existing' : '+ New Collection'}
                </button>
              )}
            </div>

            {isCreatingCollection ? (
              <div className="relative">
                <input
                  type="text"
                  value={newCollectionName}
                  onChange={(e) => setNewCollectionName(e.target.value)}
                  placeholder="Enter new collection name..."
                  autoFocus
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-900/90 p-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
                />
              </div>
            ) : (
              <select
                value={selectedCollectionId}
                onChange={(e) => {
                  setSelectedCollectionId(e.target.value);
                  setSelectedFolderId('');
                }}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-900/90 p-2.5 text-xs text-zinc-200 focus:border-sky-500 focus:outline-none cursor-pointer"
              >
                {collections.map((col) => (
                  <option key={col.id} value={col.id} className="bg-zinc-900 text-zinc-200">
                    {col.name} ({col.items.length} items)
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Folder Selection (if existing collection selected and has folders) */}
          {!isCreatingCollection && folders.length > 0 && (
            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
                Target Folder (Optional)
              </label>
              <select
                value={selectedFolderId}
                onChange={(e) => setSelectedFolderId(e.target.value)}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-900/90 p-2.5 text-xs text-zinc-200 focus:border-sky-500 focus:outline-none cursor-pointer"
              >
                <option value="">Root (No folder)</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id} className="bg-zinc-900 text-zinc-200">
                    📁 {f.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 flex justify-end gap-2.5">
          <button
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isCreatingCollection && !newCollectionName.trim()}
            className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 px-5 py-2 text-xs font-semibold text-white shadow-lg shadow-sky-500/20 hover:from-sky-400 hover:to-blue-500 active:scale-95 disabled:opacity-50 transition"
          >
            {isSaved ? (
              <>
                <Check className="h-3.5 w-3.5 text-white" />
                <span>Saved!</span>
              </>
            ) : (
              <>
                <Bookmark className="h-3.5 w-3.5" />
                <span>Save to Collection</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
