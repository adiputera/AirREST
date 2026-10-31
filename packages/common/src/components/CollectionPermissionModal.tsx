'use client';

import React, { useState, useEffect } from 'react';
import { Shield, X, Loader2, Check } from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { Collection, ProjectRole } from '../types/api';
import { getUserScopeRank } from '../lib/jwt';
import { useBackHandler } from '../lib/backNavigation';

interface CollectionPermissionModalProps {
  isOpen: boolean;
  onClose: () => void;
  collection: Collection | null;
}

const ROLE_OPTIONS: Array<{
  role: ProjectRole;
  title: string;
  desc: string;
  badgeClass: string;
}> = [
  {
    role: 'reader',
    title: '🟢 All Members (Reader+)',
    desc: 'Accessible to all members assigned to this project.',
    badgeClass: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
  },
  {
    role: 'contributor',
    title: '🟡 Contributor+',
    desc: 'Restricted to Contributors, Maintainers, and Admins.',
    badgeClass: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
  },
  {
    role: 'maintainer',
    title: '🔵 Maintainer+',
    desc: 'Restricted to Maintainers and Admins.',
    badgeClass: 'bg-sky-500/10 text-sky-400 border border-sky-500/20',
  },
  {
    role: 'admin',
    title: '🔴 Admin Only',
    desc: 'Restricted strictly to Project Admins and Superadmins.',
    badgeClass: 'bg-rose-500/10 text-rose-400 border border-rose-500/20',
  },
];

export const CollectionPermissionModal: React.FC<CollectionPermissionModalProps> = ({
  isOpen,
  onClose,
  collection,
}) => {
  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);
  const updateCollectionPermission = useApiStore((state) => state.updateCollectionPermission);

  const [selectedRole, setSelectedRole] = useState<ProjectRole>('reader');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useBackHandler(isOpen && Boolean(collection), () => {
    if (!isSubmitting) onClose();
  }, 20);

  useEffect(() => {
    if (isOpen && collection) {
      setSelectedRole(collection.minRole || 'reader');
      setErrorMsg(null);
    }
  }, [isOpen, collection]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSubmitting, onClose]);

  if (!isOpen || !collection) return null;

  const userRank = getUserScopeRank(
    workspaceMode,
    cloudConfig.activeScope,
    cloudConfig.token,
    cloudConfig.user
  );

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedRole === (collection.minRole || 'reader')) {
      onClose();
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await updateCollectionPermission(collection.id, selectedRole);
      if (!res.success) {
        setErrorMsg(res.error || 'Failed to update collection permission.');
      } else {
        onClose();
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'An unexpected error occurred.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) {
          onClose();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150 select-none"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-3 border-b border-zinc-850">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-sky-400" />
            <h3 className="text-sm font-bold text-zinc-100">Collection Permission</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white transition disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-xs text-zinc-400 my-4 leading-relaxed">
          Configure the minimum project role required to view and sync{' '}
          <strong className="text-zinc-200">"{collection.name}"</strong>.
        </p>

        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-2">
            {ROLE_OPTIONS.map((opt) => {
              const roleRanks: Record<string, number> = { admin: 4, maintainer: 3, contributor: 2, reader: 1 };
              const isOptionDisabled = (roleRanks[opt.role] || 1) > userRank;
              const isSelected = selectedRole === opt.role;

              return (
                <label
                  key={opt.role}
                  onClick={() => {
                    if (!isOptionDisabled && !isSubmitting) setSelectedRole(opt.role);
                  }}
                  className={`flex items-start gap-3 p-3 rounded-xl border transition ${
                    isOptionDisabled
                      ? 'opacity-40 cursor-not-allowed border-zinc-800/60 bg-zinc-900/20'
                      : isSelected
                      ? 'border-sky-500/60 bg-sky-500/10 cursor-pointer shadow-sm'
                      : 'border-zinc-800/80 bg-zinc-900/40 hover:border-zinc-700/80 cursor-pointer'
                  }`}
                  title={isOptionDisabled ? `Higher role required to assign ${opt.role}` : undefined}
                >
                  <input
                    type="radio"
                    name="collection_min_role"
                    value={opt.role}
                    checked={isSelected}
                    disabled={isOptionDisabled || isSubmitting}
                    onChange={() => setSelectedRole(opt.role)}
                    className="mt-0.5 text-sky-500 focus:ring-0 focus:ring-offset-0 bg-zinc-900 border-zinc-700 cursor-pointer"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-zinc-200">{opt.title}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${opt.badgeClass}`}>
                        {opt.role}
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-0.5 leading-snug">{opt.desc}</p>
                  </div>
                </label>
              );
            })}
          </div>

          {errorMsg && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
              {errorMsg}
            </div>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-zinc-850">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-xl px-4 py-2 text-xs font-semibold text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-sky-500/20 hover:from-sky-400 hover:to-blue-500 active:scale-95 transition disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Saving...</span>
                </>
              ) : (
                <>
                  <Check className="h-3.5 w-3.5" />
                  <span>Save Permission</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

