import React, { useState, useEffect } from 'react';
import { ShieldAlert, Plus, Search, Loader2, UserCheck, X, Eye, EyeOff, KeyRound, AlertCircle, Trash2, AlertTriangle } from 'lucide-react';
import { useHubStore } from '../store/useHubStore';
import { apiListAllUsers, apiProvisionUser, apiResetUserPassword, apiDeleteUser } from '../lib/api';
import { User } from '../types';

export const SuperadminView: React.FC = () => {
  const apiUrl = useHubStore((state) => state.apiUrl);
  const token = useHubStore((state) => state.token);
  const refreshToken = useHubStore((state) => state.refreshToken);
  const currentUser = useHubStore((state) => state.user);

  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [search, setSearch] = useState('');

  // Provision Modal
  const [isProvisionOpen, setIsProvisionOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<'user' | 'superadmin'>('user');
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Reset Password Modal
  const [resetUser, setResetUser] = useState<User | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [resetSuccessMsg, setResetSuccessMsg] = useState<string | null>(null);

  // Delete User Modal
  const [userToDelete, setUserToDelete] = useState<User | null>(null);
  const [isDeletingUser, setIsDeletingUser] = useState(false);
  const [deleteErrorMsg, setDeleteErrorMsg] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadUsers = async () => {
    if (!token) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const data = await apiListAllUsers(apiUrl, token, refreshToken || undefined);
      setUsers(data);
    } catch (err: any) {
      setLoadError(err.message || 'Failed to list users');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, [apiUrl, token]);

  const handleProvision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setIsProvisioning(true);
    setErrorMsg(null);
    try {
      await apiProvisionUser(
        apiUrl,
        token,
        newEmail,
        newPassword,
        newName,
        newRole,
        refreshToken || undefined
      );
      setIsProvisionOpen(false);
      setNewEmail('');
      setNewPassword('');
      setNewName('');
      loadUsers();
    } catch (err: any) {
      setErrorMsg(err.message || 'Provisioning failed');
    } finally {
      setIsProvisioning(false);
    }
  };

  const handleOpenResetPassword = (u: User) => {
    setResetUser(u);
    setResetPassword('');
    setShowResetPassword(false);
    setErrorMsg(null);
    setResetSuccessMsg(null);
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !resetUser) return;
    setIsResetting(true);
    setErrorMsg(null);
    setResetSuccessMsg(null);
    try {
      await apiResetUserPassword(apiUrl, token, resetUser.id, resetPassword, refreshToken || undefined);
      if (resetUser.id === currentUser?.id) {
        useHubStore.getState().logout();
        return;
      }
      setResetSuccessMsg(`Password for ${resetUser.email} has been updated. All of their sessions are signed out.`);
      setTimeout(() => {
        setResetUser(null);
        setResetSuccessMsg(null);
      }, 1500);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to reset password');
    } finally {
      setIsResetting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!token || !userToDelete) return;
    setIsDeletingUser(true);
    setDeleteErrorMsg(null);
    try {
      await apiDeleteUser(apiUrl, token, userToDelete.id, refreshToken || undefined);
      setUserToDelete(null);
      loadUsers();
    } catch (err: any) {
      setDeleteErrorMsg(err.message || 'Failed to delete user');
    } finally {
      setIsDeletingUser(false);
    }
  };

  const filtered = users.filter(
    (u) =>
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      u.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex-1 overflow-y-auto p-8 bg-zinc-950">
      <div className="max-w-5xl mx-auto space-y-6 animate-in fade-in duration-150">
        {/* Banner */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20 shrink-0">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-zinc-100">Superadmin System Console</h1>
              <p className="text-xs text-zinc-400 mt-0.5">
                System-wide user administration, account provisioning, and global role management.
              </p>
            </div>
          </div>

          <button
            onClick={() => setIsProvisionOpen(true)}
            className="flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2 text-xs font-semibold text-zinc-950 hover:bg-amber-400 transition shadow-md shadow-amber-500/20 shrink-0"
          >
            <Plus className="h-4 w-4" />
            <span>Provision New User</span>
          </button>
        </div>

        {/* Directory Controls */}
        <div className="flex items-center justify-between gap-4">
          <div className="relative w-72">
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-zinc-500" />
            <input
              type="text"
              placeholder="Search user directory..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900/90 pl-9 pr-3 py-2 text-xs text-zinc-200 placeholder-zinc-500 focus:border-amber-500 focus:outline-none"
            />
          </div>

          <div className="text-xs text-zinc-400">
            Total Registered Users: <strong className="text-zinc-200">{users.length}</strong>
          </div>
        </div>

        {/* Users Table */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden shadow-sm">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-zinc-800 bg-zinc-950/80 text-zinc-400 uppercase text-[10px] font-semibold">
              <tr>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Email Address</th>
                <th className="px-4 py-3">System Role</th>
                <th className="px-4 py-3">User ID</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60 text-zinc-200">
              {isLoading ? (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-zinc-500">
                    <Loader2 className="h-4 w-4 animate-spin inline mr-2 text-amber-400" />
                    Loading registered users...
                  </td>
                </tr>
              ) : loadError ? (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-rose-400">
                    <div className="flex items-center justify-center gap-2">
                      <AlertCircle className="h-4 w-4 text-rose-400" />
                      <span>{loadError}</span>
                    </div>
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-zinc-500">
                    No matching users found.
                  </td>
                </tr>
              ) : (
                filtered.map((u) => (
                  <tr key={u.id} className="hover:bg-zinc-800/30 transition">
                    <td className="px-4 py-3 font-medium flex items-center gap-2">
                      <div className="h-7 w-7 rounded-full bg-zinc-800 flex items-center justify-center font-bold text-[11px] text-zinc-300 border border-zinc-700/50">
                        {u.name ? u.name[0].toUpperCase() : 'U'}
                      </div>
                      <span>{u.name}</span>
                    </td>
                    <td className="px-4 py-3 text-zinc-400">{u.email}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                          u.role === 'superadmin'
                            ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                            : 'bg-zinc-800 text-zinc-300'
                        }`}
                      >
                        {u.role}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-zinc-500 font-mono text-[11px]">{u.id}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleOpenResetPassword(u)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-white hover:border-amber-500/40 transition"
                          title="Change / Reset Password"
                        >
                          <KeyRound className="h-3.5 w-3.5 text-amber-400" />
                          <span>Change Password</span>
                        </button>

                        {u.id === currentUser?.id ? (
                          <button
                            disabled
                            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800/40 bg-zinc-900/30 px-2.5 py-1 text-xs font-semibold text-zinc-600 cursor-not-allowed"
                            title="You cannot delete your own account"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>Delete</span>
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              setUserToDelete(u);
                              setDeleteErrorMsg(null);
                            }}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs font-semibold text-rose-400 hover:bg-rose-500/10 hover:border-rose-500/40 hover:text-rose-300 transition"
                            title="Permanently remove user"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>Delete</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Provision User Modal */}
      {isProvisionOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <UserCheck className="h-5 w-5 text-amber-400" />
                <span>Provision User Account</span>
              </h3>
              <button
                onClick={() => setIsProvisionOpen(false)}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {errorMsg && (
              <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
                {errorMsg}
              </div>
            )}

            <form onSubmit={handleProvision} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Display Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. System Engineer"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Email Address</label>
                <input
                  type="email"
                  required
                  placeholder="user@example.com"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Password</label>
                <div className="relative">
                  <input
                    type={showNewPassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    placeholder="Minimum 8 characters"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900 pl-3 pr-10 py-2 text-xs text-zinc-100 focus:border-amber-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    className="absolute right-3 top-2.5 text-zinc-500 hover:text-zinc-300 transition"
                    title={showNewPassword ? 'Hide password' : 'Show password'}
                    aria-label={showNewPassword ? 'Hide password' : 'Show password'}
                  >
                    {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">System Role</label>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as any)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-amber-500 focus:outline-none"
                >
                  <option value="user">User (Standard account)</option>
                  <option value="superadmin">Superadmin (Full platform control)</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsProvisionOpen(false)}
                  className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isProvisioning}
                  className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400 transition shadow-md disabled:opacity-50"
                >
                  {isProvisioning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Provision Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Reset Password Modal */}
      {resetUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <KeyRound className="h-5 w-5 text-amber-400" />
                <span>Change User Password</span>
              </h3>
              <button
                onClick={() => setResetUser(null)}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Target user details */}
            <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-xs">
              <div className="text-zinc-400">Target User:</div>
              <div className="font-semibold text-zinc-200 text-sm mt-0.5">{resetUser.name}</div>
              <div className="text-zinc-400 text-[11px]">{resetUser.email}</div>
            </div>

            {errorMsg && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                <span>{errorMsg}</span>
              </div>
            )}

            {resetSuccessMsg && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-300">
                <UserCheck className="h-4 w-4 shrink-0 text-emerald-400" />
                <span>{resetSuccessMsg}</span>
              </div>
            )}

            <form onSubmit={handleResetPassword} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  New Password
                </label>
                <div className="relative">
                  <input
                    type={showResetPassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    placeholder="Minimum 8 characters"
                    value={resetPassword}
                    onChange={(e) => setResetPassword(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900 pl-3 pr-10 py-2 text-xs text-zinc-100 focus:border-amber-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowResetPassword(!showResetPassword)}
                    className="absolute right-3 top-2.5 text-zinc-500 hover:text-zinc-300 transition"
                    title={showResetPassword ? 'Hide password' : 'Show password'}
                    aria-label={showResetPassword ? 'Hide password' : 'Show password'}
                  >
                    {showResetPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="text-[10px] text-zinc-500 mt-1">
                  Directly updates the user&apos;s password hash in the database.
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setResetUser(null)}
                  className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isResetting || resetPassword.length < 8}
                  className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400 transition shadow-md shadow-amber-500/20 disabled:opacity-50"
                >
                  {isResetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Update Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete User Confirmation Modal */}
      {userToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/20">
                  <AlertTriangle className="h-4 w-4" />
                </div>
                <span>Delete User Account</span>
              </h3>
              <button
                onClick={() => setUserToDelete(null)}
                disabled={isDeletingUser}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {deleteErrorMsg && (
              <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
                {deleteErrorMsg}
              </div>
            )}

            <p className="text-xs text-zinc-300 leading-relaxed mb-4">
              Are you sure you want to permanently delete user{' '}
              <strong className="text-white font-semibold">{userToDelete.name}</strong> ({userToDelete.email})?
            </p>

            <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-3 text-[11px] text-zinc-400 space-y-1.5 mb-5">
              <div className="font-semibold text-rose-300 flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5" />
                <span>This action is permanent and irreversible:</span>
              </div>
              <ul className="list-disc pl-4 space-y-0.5 text-zinc-400">
                <li>All private workspaces and collections owned by this user will be removed.</li>
                <li>Active sessions in the AirREST Extension and Hub will be immediately revoked.</li>
                <li>Shared teams and projects created by this user will be preserved and reassigned to you.</li>
              </ul>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={isDeletingUser}
                onClick={() => setUserToDelete(null)}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDeletingUser}
                onClick={handleConfirmDelete}
                className="flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 transition shadow-md shadow-rose-600/20 disabled:opacity-50"
              >
                {isDeletingUser ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Deleting...</span>
                  </>
                ) : (
                  <>
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Delete User</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

