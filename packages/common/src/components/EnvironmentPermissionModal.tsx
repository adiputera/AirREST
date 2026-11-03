'use client';

import React, { useState, useEffect } from 'react';
import { Shield, X, Check } from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { ProjectRole } from '../types/api';
import { getUserScopeRank } from '../lib/jwt';
import { useBackHandler } from '../lib/backNavigation';

interface EnvironmentPermissionModalProps {
  isOpen: boolean;
  onClose: () => void;
  environmentName: string;
  currentRole?: ProjectRole;
  onSave: (role: ProjectRole) => void;
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

export const EnvironmentPermissionModal: React.FC<EnvironmentPermissionModalProps> = ({
  isOpen,
  onClose,
  environmentName,
  currentRole = 'reader',
  onSave,
}) => {
  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);

  const [selectedRole, setSelectedRole] = useState<ProjectRole>(currentRole);

  useBackHandler(isOpen, onClose, 25);

  useEffect(() => {
    if (isOpen) {
      setSelectedRole(currentRole || 'reader');
    }
  }, [isOpen, currentRole]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const userRank = getUserScopeRank(
    workspaceMode,
    cloudConfig.activeScope,
    cloudConfig.token,
    cloudConfig.user
  );

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(selectedRole);
    onClose();
  };

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150 select-none"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-line-strong bg-card p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-3 border-b border-line">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-sky-400" />
            <h3 className="text-sm font-bold text-tx-primary">Environment Permission</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-tx-muted hover:bg-hover hover:text-tx-primary transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-xs text-tx-muted my-4 leading-relaxed">
          Configure the minimum project role required to view and sync{' '}
          <strong className="text-tx-secondary">"{environmentName}"</strong>.
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
                    if (!isOptionDisabled) setSelectedRole(opt.role);
                  }}
                  className={`flex items-start gap-3 p-3 rounded-xl border transition ${
                    isOptionDisabled
                      ? 'opacity-40 cursor-not-allowed border-line/60 bg-element/20'
                      : isSelected
                      ? 'border-sky-500/60 bg-sky-500/10 cursor-pointer shadow-sm'
                      : 'border-line bg-element/40 hover:border-line-strong cursor-pointer'
                  }`}
                  title={isOptionDisabled ? `Higher role required to assign ${opt.role}` : undefined}
                >
                  <input
                    type="radio"
                    name="env_min_role"
                    value={opt.role}
                    checked={isSelected}
                    disabled={isOptionDisabled}
                    onChange={() => setSelectedRole(opt.role)}
                    className="mt-0.5 text-sky-500 focus:ring-0 focus:ring-offset-0 bg-card border-line cursor-pointer"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-tx-secondary">{opt.title}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${opt.badgeClass}`}>
                        {opt.role}
                      </span>
                    </div>
                    <p className="text-[11px] text-tx-muted mt-0.5 leading-snug">{opt.desc}</p>
                  </div>
                </label>
              );
            })}
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-line">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl px-4 py-2 text-xs font-semibold text-tx-muted hover:bg-hover hover:text-tx-primary transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-sky-500/20 hover:from-sky-400 hover:to-blue-500 active:scale-95 transition"
            >
              <Check className="h-3.5 w-3.5" />
              <span>Save Permission</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

