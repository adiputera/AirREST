'use client';

import React, { useState, useEffect } from 'react';
import { Bookmark, X, Check, AlertCircle, AlertTriangle, Copy, RefreshCw } from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { ApiRequest, CollectionItem, HttpMethod } from '../types/api';
import {
  findSavedRequestInCollections,
  flattenCollectionRequests,
  generateCopyRequestName,
  FlattenedCollectionRequest,
} from '../lib/requestDiff';
import { canModifyCollection, hasScopePermission } from '../lib/jwt';
import { MethodBadge } from './MethodBadge';
import { useBackHandler } from '../lib/backNavigation';

interface SaveToCollectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  request: ApiRequest;
  isSaveAs?: boolean;
}

interface RequestConflictState {
  existingRequest: FlattenedCollectionRequest;
  targetCollectionId: string;
  targetFolderId: string | null;
  targetRequest: ApiRequest;
  suggestedCopyName: string;
}

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export const SaveToCollectionModal: React.FC<SaveToCollectionModalProps> = ({
  isOpen,
  onClose,
  request,
  isSaveAs = false,
}) => {
  const collections = useApiStore((state) => state.collections);
  const createCollection = useApiStore((state) => state.createCollection);
  const saveRequestToCollection = useApiStore((state) => state.saveRequestToCollection);
  const updateActiveRequest = useApiStore((state) => state.updateActiveRequest);
  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);

  const savedInfo = findSavedRequestInCollections(collections, request.id);

  const canWriteScope = hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role);

  const writableCollections = collections.filter((c) =>
    canModifyCollection(c.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)
  );

  const isSavedCollectionWritable = savedInfo
    ? canModifyCollection(savedInfo.collection.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)
    : false;

  const defaultCollectionId =
    (savedInfo && isSavedCollectionWritable)
      ? savedInfo.collection.id
      : (writableCollections[0]?.id || collections[0]?.id || '');

  const [requestName, setRequestName] = useState(request.name || 'Untitled Request');
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>(defaultCollectionId);
  const [selectedFolderId, setSelectedFolderId] = useState<string>(savedInfo?.folderId || '');
  const [isCreatingCollection, setIsCreatingCollection] = useState(
    canWriteScope && writableCollections.length === 0
  );
  const [newCollectionName, setNewCollectionName] = useState('');
  const [isSaved, setIsSaved] = useState(false);
  const [savedActionText, setSavedActionText] = useState('Saved!');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [conflict, setConflict] = useState<RequestConflictState | null>(null);
  useBackHandler(isOpen, () => {
    if (conflict) setConflict(null);
    else onClose();
  }, 20);

  useEffect(() => {
    if (isOpen) {
      setRequestName(request.name || 'Untitled Request');
      setSelectedCollectionId(defaultCollectionId);
      setSelectedFolderId(savedInfo?.folderId || '');
      setIsCreatingCollection(canWriteScope && writableCollections.length === 0);
      setNewCollectionName('');
      setErrorMsg(null);
      setIsSaved(false);
      setSavedActionText('Saved!');
      setConflict(null);
    }
  }, [isOpen, request.id, request.name, defaultCollectionId, canWriteScope, writableCollections.length, savedInfo?.folderId]);

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
    extractFolders(currentCollection.items || []);
  }

  const handleSave = () => {
    setErrorMsg(null);

    if (!canWriteScope) {
      setErrorMsg('Insufficient permission to save or create collections in this scope (requires collection:write).');
      return;
    }

    let targetCollectionId = selectedCollectionId;

    if (isCreatingCollection) {
      if (!hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role)) {
        setErrorMsg('Insufficient permission to create collection in this scope (requires collection:write).');
        return;
      }
      const trimmedName = newCollectionName.trim() || 'New Collection';
      targetCollectionId = createCollection(trimmedName);
    } else {
      if (currentCollection && !canModifyCollection(currentCollection.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
        setErrorMsg(`Cannot save request: collection "${currentCollection.name}" is read-only for your role.`);
        return;
      }
    }

    if (!targetCollectionId) {
      setErrorMsg('Failed to select or create a valid target collection.');
      return;
    }

    const finalName = requestName.trim() || 'Untitled Request';
    const targetFolder = selectedFolderId ? selectedFolderId : null;
    const incomingMethod = (request.method || 'GET').toUpperCase();

    // Check duplicate HTTP method + name collision in the target collection
    const targetCol = isCreatingCollection
      ? null
      : collections.find((c) => c.id === targetCollectionId);

    if (targetCol) {
      const existingRequests = flattenCollectionRequests(targetCol.items || []);
      const conflicting = existingRequests.find((r) => {
        if (!isSaveAs && (r.id === request.id || r.request?.id === request.id)) {
          return false; // not a conflict with self during direct edit
        }
        return (
          r.name.trim().toLowerCase() === finalName.toLowerCase() &&
          (r.method || 'GET').toUpperCase() === incomingMethod
        );
      });

      if (conflicting) {
        const allExistingNames = existingRequests.map((r) => r.name);
        const suggestedCopyName = generateCopyRequestName(finalName, allExistingNames);
        setConflict({
          existingRequest: conflicting,
          targetCollectionId,
          targetFolderId: targetFolder,
          targetRequest: request,
          suggestedCopyName,
        });
        return;
      }
    }

    // Save As creates a new copy with a fresh unique ID, preserving the original request in its source collection
    const isTargetDifferentCollection = Boolean(savedInfo && savedInfo.collection.id !== targetCollectionId);
    const shouldCreateCopy = isSaveAs || !savedInfo || !isSavedCollectionWritable || isTargetDifferentCollection;
    const newId = generateUUID();

    const targetRequest: ApiRequest = shouldCreateCopy
      ? {
          ...request,
          id: newId,
          name: finalName,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      : {
          ...request,
          name: finalName,
          updatedAt: Date.now(),
        };

    saveRequestToCollection(
      targetCollectionId,
      targetFolder,
      targetRequest
    );
    updateActiveRequest({ id: targetRequest.id, name: finalName });

    setIsSaved(true);
    setSavedActionText('Saved!');
    setTimeout(() => {
      setIsSaved(false);
      onClose();
    }, 600);
  };

  const handleResolveCopy = () => {
    if (!conflict) return;
    const newId = generateUUID();
    const targetRequest: ApiRequest = {
      ...conflict.targetRequest,
      id: newId,
      name: conflict.suggestedCopyName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    saveRequestToCollection(
      conflict.targetCollectionId,
      conflict.targetFolderId,
      targetRequest
    );
    updateActiveRequest({ id: newId, name: conflict.suggestedCopyName });

    setIsSaved(true);
    setSavedActionText('Saved copy!');
    setTimeout(() => {
      setIsSaved(false);
      setConflict(null);
      onClose();
    }, 600);
  };

  const handleResolveReplace = () => {
    if (!conflict) return;

    const targetRequest: ApiRequest = {
      ...conflict.targetRequest,
      id: conflict.existingRequest.id,
      name: conflict.existingRequest.name,
      updatedAt: Date.now(),
    };

    const savedExisting = findSavedRequestInCollections(collections, conflict.existingRequest.id);
    const resolvedFolderId = savedExisting ? savedExisting.folderId : conflict.targetFolderId;

    saveRequestToCollection(
      conflict.targetCollectionId,
      resolvedFolderId,
      targetRequest
    );
    updateActiveRequest({ id: conflict.existingRequest.id, name: conflict.existingRequest.name });

    setIsSaved(true);
    setSavedActionText('Replaced!');
    setTimeout(() => {
      setIsSaved(false);
      setConflict(null);
      onClose();
    }, 600);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-850 pb-4">
          <div className="flex items-center gap-2.5">
            <div className={`flex h-9 w-9 items-center justify-center rounded-lg border ${
              conflict
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                : 'bg-sky-500/10 text-sky-400 border-sky-500/20'
            }`}>
              {conflict ? <AlertTriangle className="h-5 w-5" /> : <Bookmark className="h-5 w-5" />}
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-100">
                {conflict
                  ? 'Request Conflict'
                  : isSaveAs
                  ? 'Save Request As'
                  : 'Save Request'}
              </h2>
              <p className="text-xs text-zinc-400">
                {conflict
                  ? 'A duplicate request was detected in this collection'
                  : isSaveAs
                  ? 'Save a copy of this request to a collection'
                  : 'Save to a collection for organized testing'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Conflict Resolution View */}
        {conflict ? (
          <div className="mt-4 space-y-4">
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-300">
              <div className="flex items-center gap-2 font-semibold text-amber-200">
                <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                <span>Request already exists</span>
              </div>
              <p className="mt-1 text-[11px] text-amber-300/90 leading-relaxed">
                A request with the same HTTP method and name already exists in this collection.
                Do you want to replace it or save it as a copy?
              </p>
            </div>

            {/* Existing request card */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-3">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-zinc-400 mb-1.5">
                Existing Request
              </div>
              <div className="flex items-center gap-2.5">
                <MethodBadge method={conflict.existingRequest.method as HttpMethod} />
                <span className="font-mono text-xs font-medium text-zinc-200 truncate">
                  {conflict.existingRequest.name}
                </span>
              </div>
              {conflict.existingRequest.path && (
                <div className="mt-1.5 text-[11px] text-zinc-500 truncate">
                  Location: {conflict.existingRequest.path}
                </div>
              )}
            </div>

            {/* Options explanation */}
            <div className="space-y-2 text-xs">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 flex items-start gap-2.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400 shrink-0 mt-0.5">
                  <Copy className="h-3.5 w-3.5" />
                </div>
                <div>
                  <div className="font-semibold text-zinc-200">Save Copy</div>
                  <div className="text-[11px] text-zinc-400 mt-0.5">
                    Save as a new request named <span className="font-mono text-sky-300">"{conflict.suggestedCopyName}"</span>.
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 flex items-start gap-2.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400 shrink-0 mt-0.5">
                  <RefreshCw className="h-3.5 w-3.5" />
                </div>
                <div>
                  <div className="font-semibold text-zinc-200">Replace</div>
                  <div className="text-[11px] text-zinc-400 mt-0.5">
                    Overwrite the existing request in-place with current settings.
                  </div>
                </div>
              </div>
            </div>

            {/* Conflict Footer Actions */}
            <div className="mt-6 flex items-center justify-between pt-2 border-t border-zinc-850">
              <button
                type="button"
                onClick={() => setConflict(null)}
                className="rounded-xl px-3.5 py-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition"
              >
                Back
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleResolveCopy}
                  disabled={isSaved}
                  className="flex items-center gap-1.5 rounded-xl border border-sky-500/40 bg-sky-500/10 px-3.5 py-2 text-xs font-semibold text-sky-300 hover:bg-sky-500/20 active:scale-95 transition disabled:opacity-50"
                >
                  {isSaved && savedActionText === 'Saved copy!' ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-sky-400" />
                      <span>Saved!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>Save Copy</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleResolveReplace}
                  disabled={isSaved}
                  className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-600 to-rose-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-amber-600/20 hover:from-amber-500 hover:to-rose-500 active:scale-95 transition disabled:opacity-50"
                >
                  {isSaved && savedActionText === 'Replaced!' ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-white" />
                      <span>Replaced!</span>
                    </>
                  ) : (
                    <>
                      <RefreshCw className="h-3.5 w-3.5" />
                      <span>Replace</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* Normal Form Body */
          <>
            <div className="mt-4 space-y-4">
              {!canWriteScope && (
                <div className="flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-400">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>Project scope is read-only for your role (reader). Saving is disabled.</span>
                </div>
              )}

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
                  {canWriteScope && collections.length > 0 && (
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
                    disabled={!canWriteScope}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900/90 p-2.5 text-xs text-zinc-200 focus:border-sky-500 focus:outline-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {collections.map((col) => {
                      const isWritable = canModifyCollection(col.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role);
                      return (
                        <option key={col.id} value={col.id} disabled={!isWritable} className="bg-zinc-900 text-zinc-200">
                          {col.name} {isWritable ? `(${(col.items || []).length} items)` : '(Read-only)'}
                        </option>
                      );
                    })}
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

              {errorMsg && (
                <div className="flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-400">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="mt-6 flex justify-end gap-2.5">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl px-4 py-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!canWriteScope || (isCreatingCollection && !newCollectionName.trim()) || (!isCreatingCollection && !selectedCollectionId)}
                className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 px-5 py-2 text-xs font-semibold text-white shadow-lg shadow-sky-500/20 hover:from-sky-400 hover:to-blue-500 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                {isSaved ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-white" />
                    <span>Saved!</span>
                  </>
                ) : (
                  <>
                    <Bookmark className="h-3.5 w-3.5" />
                    <span>{isSaveAs ? 'Save Copy' : 'Save to Collection'}</span>
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
