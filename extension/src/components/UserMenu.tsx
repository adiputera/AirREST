'use client';

import React, { useState, useRef, useEffect } from 'react';
import { User, LogIn, KeyRound, LogOut, ChevronDown, Pencil } from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import { isOfflineOnly } from '@/lib/edition';
import { EditProfileModal } from './EditProfileModal';
import { ChangePasswordModal } from './ChangePasswordModal';
import { ConfirmModal } from './ConfirmModal';
import { CloudAuthModal } from './CloudAuthModal';

interface UserMenuProps {
  onOpenLogin?: () => void;
}

export const UserMenu: React.FC<UserMenuProps> = ({ onOpenLogin }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isInternalLoginOpen, setIsInternalLoginOpen] = useState(false);
  const [isEditProfileOpen, setIsEditProfileOpen] = useState(false);
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false);
  const [isSignOutConfirmOpen, setIsSignOutConfirmOpen] = useState(false);
  const [avatarError, setAvatarError] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);

  const cloudConfig = useApiStore((state) => state.cloudConfig);
  const logoutCloud = useApiStore((state) => state.logoutCloud);

  const user = cloudConfig.user;
  const token = cloudConfig.token;
  useEffect(() => {
    const requireSignIn = () => {
      setIsChangePasswordOpen(false);
      setIsInternalLoginOpen(true);
    };
    window.addEventListener('airrest:auth-required', requireSignIn);
    return () => window.removeEventListener('airrest:auth-required', requireSignIn);
  }, []);

  // Close dropdown on outside click or escape
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  // Only render if not offline-only edition
  if (isOfflineOnly) {
    return null;
  }

  // If not logged in, render the user button configured for login
  if (!token) {
    return (
      <>
        <button
          onClick={() => {
            if (onOpenLogin) {
              onOpenLogin();
            } else {
              setIsInternalLoginOpen(true);
            }
          }}
          aria-label="Sign In"
          title="Sign in to your Account"
          className="group flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900/90 p-1 pr-2.5 hover:border-sky-500/40 hover:bg-zinc-850 transition shadow-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
        >
          {/* Guest / Disconnected Avatar Graphic */}
          <div className="relative flex h-7 w-7 items-center justify-center rounded-full overflow-hidden border border-zinc-700/80 bg-zinc-800/80 text-zinc-400 group-hover:border-sky-500/40 group-hover:bg-sky-500/10 group-hover:text-sky-300 transition shadow-inner">
            <User className="h-3.5 w-3.5" />
            {/* Offline / Unauthenticated dot indicator */}
            <span className="absolute bottom-0 right-0 h-2 w-2 rounded-full bg-zinc-500 ring-2 ring-zinc-950" />
          </div>

          <span className="hidden lg:inline text-xs font-medium text-zinc-300 group-hover:text-white transition">
            Sign In
          </span>
        </button>

        {!onOpenLogin && (
          <CloudAuthModal
            isOpen={isInternalLoginOpen}
            onClose={() => setIsInternalLoginOpen(false)}
          />
        )}
      </>
    );
  }

  const displayName = user?.name || user?.email?.split('@')[0] || 'User';
  const roleName = user?.role || 'member';

  // Get user initials for avatar fallback
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .map((n) => n[0] || '')
    .join('')
    .substring(0, 2)
    .toUpperCase() || 'U';

  const getRoleBadgeStyle = (role?: string | null) => {
    switch (String(role || 'member').toLowerCase()) {
      case 'superadmin':
        return 'border-purple-500/30 bg-purple-500/10 text-purple-400';
      case 'admin':
        return 'border-sky-500/30 bg-sky-500/10 text-sky-400';
      default:
        return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400';
    }
  };

  return (
    <>
      <div className="relative" ref={menuRef}>
        {/* User Avatar Button (Top Right) */}
        <button
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
          aria-label="User Profile Menu"
          className="group flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900/90 p-1 pr-2 hover:border-zinc-700 hover:bg-zinc-800/80 transition shadow-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
        >
          {/* Dummy Avatar Graphic or Real Avatar */}
          <div className="relative flex h-7 w-7 items-center justify-center rounded-full overflow-hidden border border-zinc-700/80 bg-gradient-to-tr from-sky-500/20 via-zinc-800 to-indigo-500/20 text-sky-300 font-semibold text-[11px] shadow-inner">
            {user?.avatar_url && !avatarError ? (
              <img
                src={user.avatar_url}
                alt={displayName}
                onError={() => setAvatarError(true)}
                className="h-full w-full object-cover"
              />
            ) : (
              /* Dummy user SVG illustration */
              <svg
                className="h-5 w-5 text-sky-300/80 group-hover:text-sky-200 transition"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 4c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm0 14c-2.03 0-4.43-.82-6.14-2.88C7.55 15.8 9.68 15 12 15s4.45.8 6.14 2.12C16.43 19.18 14.03 20 12 20z" />
              </svg>
            )}
            {/* Online Status Indicator */}
            <span className="absolute bottom-0 right-0 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-zinc-950" />
          </div>

          <span className="hidden lg:inline-block max-w-[85px] xl:max-w-[120px] truncate text-xs font-medium text-zinc-300 group-hover:text-zinc-100 transition">
            {displayName}
          </span>
          <ChevronDown
            className={`h-3 w-3 text-zinc-400 group-hover:text-zinc-200 transition-transform duration-150 ${
              isOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        {/* Dropdown Menu */}
        {isOpen && (
          <div className="absolute right-0 top-full mt-2 w-64 rounded-2xl border border-zinc-800 bg-zinc-950/95 backdrop-blur-xl p-2 shadow-2xl shadow-black/90 z-50 animate-in fade-in zoom-in-95 duration-100">
            {/* Profile Info Header */}
            <div className="flex items-center gap-3 p-2.5 rounded-xl bg-zinc-900/60 border border-zinc-800/60 mb-1.5">
              <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl overflow-hidden border border-zinc-700/80 bg-gradient-to-tr from-sky-500/20 via-zinc-800 to-indigo-500/20 text-sky-300 font-bold text-xs shadow-inner">
                {user?.avatar_url && !avatarError ? (
                  <img
                    src={user.avatar_url}
                    alt={displayName}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <svg className="h-7 w-7 text-sky-400" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 4c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm0 14c-2.03 0-4.43-.82-6.14-2.88C7.55 15.8 9.68 15 12 15s4.45.8 6.14 2.12C16.43 19.18 14.03 20 12 20z" />
                  </svg>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-semibold text-zinc-100">
                    {displayName}
                  </span>
                </div>
                <div className="truncate text-[11px] text-zinc-400">{user?.email}</div>
                <div className="mt-1">
                  <span
                    className={`inline-block rounded-full border px-2 py-0.2 text-[9px] font-semibold uppercase tracking-wider ${getRoleBadgeStyle(
                      roleName
                    )}`}
                  >
                    {roleName}
                  </span>
                </div>
              </div>
            </div>

            {/* Menu Items */}
            <div className="space-y-0.5">
              {/* Edit Profile */}
              <button
                onClick={() => {
                  setIsOpen(false);
                  setIsEditProfileOpen(true);
                }}
                className="w-full flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800/80 hover:text-white transition group text-left"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-sky-500/20 bg-sky-500/10 text-sky-400 group-hover:bg-sky-500/20 transition">
                  <Pencil className="h-3.5 w-3.5" />
                </div>
                <div className="flex-1">
                  <div className="font-medium text-zinc-200 group-hover:text-white">
                    Edit Profile
                  </div>
                  <div className="text-[10px] text-zinc-500">Update display name</div>
                </div>
              </button>

              {/* Change Password */}
              <button
                onClick={() => {
                  setIsOpen(false);
                  setIsChangePasswordOpen(true);
                }}
                className="w-full flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800/80 hover:text-white transition group text-left"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-sky-500/20 bg-sky-500/10 text-sky-400 group-hover:bg-sky-500/20 transition">
                  <KeyRound className="h-3.5 w-3.5" />
                </div>
                <div className="flex-1">
                  <div className="font-medium text-zinc-200 group-hover:text-white">
                    Change Password
                  </div>
                  <div className="text-[10px] text-zinc-500">Update account credentials</div>
                </div>
              </button>

              {/* Sign Out (Clear All Data) */}
              <button
                onClick={() => {
                  setIsOpen(false);
                  setIsSignOutConfirmOpen(true);
                }}
                className="w-full flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs text-rose-400 hover:bg-rose-500/10 transition group text-left"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-rose-500/20 bg-rose-500/10 text-rose-400 group-hover:bg-rose-500/20 transition">
                  <LogOut className="h-3.5 w-3.5" />
                </div>
                <div className="flex-1">
                  <div className="font-medium text-rose-300 group-hover:text-rose-200">
                    Sign Out
                  </div>
                  <div className="text-[10px] text-rose-400/70">Clear all session data</div>
                </div>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Edit Profile Modal */}
      <EditProfileModal
        isOpen={isEditProfileOpen}
        onClose={() => setIsEditProfileOpen(false)}
      />

      {/* Change Password Modal */}
      <ChangePasswordModal
        isOpen={isChangePasswordOpen}
        onClose={() => setIsChangePasswordOpen(false)}
      />

      {/* Sign Out Confirmation Modal */}
      <ConfirmModal
        isOpen={isSignOutConfirmOpen}
        onClose={() => setIsSignOutConfirmOpen(false)}
        onConfirm={() => {
          setIsSignOutConfirmOpen(false);
          logoutCloud();
        }}
        title="Sign Out & Clear Session Data"
        message="Are you sure you want to sign out? This will disconnect your account and clear all active cloud session data from this browser."
        confirmText="Sign Out & Clear"
        variant="danger"
      />
    </>
  );
};
