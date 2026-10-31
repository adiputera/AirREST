'use client';

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { User, Mail, Lock, AlertCircle, Loader2, X } from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { updateUserProfile } from '../lib/cloudApi';
import { useBackHandler } from '../lib/backNavigation';

interface EditProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const EditProfileModal: React.FC<EditProfileModalProps> = ({ isOpen, onClose }) => {
  const cloudConfig = useApiStore((state) => state.cloudConfig);
  const setCloudConfig = useApiStore((state) => state.setCloudConfig);
  const user = cloudConfig.user;

  const [name, setName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useBackHandler(isOpen, () => { if (!isLoading) onClose(); }, 20);

  // Sync state when modal opens
  useEffect(() => {
    if (isOpen) {
      setName(user?.name || '');
      setErrorMsg(null);
      setIsLoading(false);
    }
  }, [isOpen, user]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isLoading) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isLoading, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMsg('Display name is required.');
      return;
    }

    if (!cloudConfig.token) {
      setErrorMsg('Authentication token missing. Please sign in again.');
      return;
    }

    setIsLoading(true);

    try {
      const updatedUser = await updateUserProfile(
        cloudConfig.apiUrl || 'http://localhost:8080',
        trimmedName,
        cloudConfig.token,
        cloudConfig.refreshToken
      );

      setCloudConfig({
        user: updatedUser,
      });

      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to update profile.');
    } finally {
      setIsLoading(false);
    }
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget && !isLoading) {
          onClose();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-150"
    >
      <div className="relative w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl shadow-black/90">
        {/* Close Button */}
        <button
          onClick={onClose}
          disabled={isLoading}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition disabled:opacity-50"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 bg-sky-500/10 text-sky-400">
            <User className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-zinc-100">Edit Profile</h3>
            <p className="text-xs text-zinc-400">Update your account display name.</p>
          </div>
        </div>

        {/* Error Alert */}
        {errorMsg && (
          <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300 animate-in fade-in">
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
            <div className="flex-1">{errorMsg}</div>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Email (Read-Only) */}
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">
              Email Address
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500">
                <Mail className="h-4 w-4" />
              </div>
              <input
                type="email"
                value={user?.email || ''}
                disabled
                className="w-full rounded-xl border border-zinc-800/80 bg-zinc-900/40 pl-9 pr-10 py-2.5 text-xs text-zinc-400 cursor-not-allowed select-none"
              />
              <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-zinc-600">
                <Lock className="h-3.5 w-3.5" />
              </div>
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">
              Email address cannot be changed.
            </p>
          </div>

          {/* Display Name */}
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">
              Display Name
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500">
                <User className="h-4 w-4" />
              </div>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter display name"
                disabled={isLoading}
                maxLength={100}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-900/90 pl-9 pr-3 py-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 transition disabled:opacity-50"
                required
                autoFocus
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-zinc-800/80">
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading}
              className="rounded-xl border border-zinc-800 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-900 hover:text-white transition disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading || !name.trim()}
              className="flex items-center gap-1.5 rounded-xl bg-sky-600 px-4 py-2 text-xs font-medium text-white hover:bg-sky-500 transition shadow-lg shadow-sky-600/20 disabled:opacity-50"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Saving...</span>
                </>
              ) : (
                <span>Save Changes</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
};

