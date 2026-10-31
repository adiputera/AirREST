import React, { useState } from 'react';
import { Cloud, Server, LogOut, User as UserIcon, Menu } from 'lucide-react';
import { useHubStore } from '../store/useHubStore';
import { DEFAULT_API_URL } from '../lib/api';

export interface NavbarProps {
  onOpenSidebar?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ onOpenSidebar }) => {
  const user = useHubStore((state) => state.user);
  const apiUrl = useHubStore((state) => state.apiUrl);
  const setApiUrl = useHubStore((state) => state.setApiUrl);
  const logout = useHubStore((state) => state.logout);

  const [isServerModalOpen, setIsServerModalOpen] = useState(false);
  const [tempUrl, setTempUrl] = useState(apiUrl);

  const handleSaveUrl = (e: React.FormEvent) => {
    e.preventDefault();
    setApiUrl(tempUrl.trim().replace(/\/+$/, '') || DEFAULT_API_URL);
    setIsServerModalOpen(false);
  };

  return (
    <>
      <header className="relative z-30 flex h-14 sm:h-16 w-full items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-3 sm:px-6 backdrop-blur-md">
        {/* Brand */}
        <div className="flex items-center gap-2 sm:gap-3">
          {onOpenSidebar && (
            <button
              type="button"
              onClick={onOpenSidebar}
              aria-label="Open navigation menu"
              className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 lg:hidden transition"
            >
              <Menu className="h-5 w-5" />
            </button>
          )}

          <div className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-sky-600 to-indigo-600 text-white shadow-lg shadow-sky-500/20 shrink-0">
            <Cloud className="h-4 w-4 sm:h-5 sm:w-5" />
          </div>
          <div>
            <div className="flex items-center gap-1.5 sm:gap-2">
              <span className="text-sm sm:text-base font-bold tracking-tight text-zinc-100">AirREST Hub</span>
              <span className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-[9px] sm:text-[10px] font-semibold text-indigo-400">
                Management
              </span>
            </div>
            <p className="text-[11px] text-zinc-400 hidden sm:block">Team Collaboration &amp; Project Access Control</p>
          </div>
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-2 sm:gap-3">

          {/* Server Endpoint Indicator */}
          <button
            onClick={() => {
              setTempUrl(apiUrl);
              setIsServerModalOpen(true);
            }}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/90 px-2 sm:px-2.5 py-1.5 text-xs text-zinc-300 hover:border-zinc-700 hover:text-white transition"
            title="Configure Server Endpoint"
            aria-label="Configure Server Endpoint"
          >
            <Server className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
            <span className="hidden sm:inline font-mono text-[11px] max-w-[120px] md:max-w-[150px] truncate">{apiUrl}</span>
          </button>

          {/* User Info */}
          {user && (
            <div className="flex items-center gap-1.5 sm:gap-2 border-l border-zinc-800 pl-2 sm:pl-3">
              <div className="flex h-7 w-7 sm:h-8 sm:w-8 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 font-bold text-xs border border-zinc-700/60 shrink-0">
                {user.name ? user.name[0].toUpperCase() : <UserIcon className="h-4 w-4" />}
              </div>
              <div className="hidden lg:block text-left">
                <div className="text-xs font-semibold text-zinc-200 flex items-center gap-1">
                  <span>{user.name}</span>
                  {user.role === 'superadmin' && (
                    <span className="rounded bg-amber-500/10 px-1 py-0.2 text-[9px] font-bold text-amber-400 border border-amber-500/20">
                      Superadmin
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-zinc-400 truncate max-w-[150px]">{user.email}</div>
              </div>

              {/* Logout Button */}
              <button
                onClick={logout}
                className="rounded-lg p-1.5 sm:p-2 text-zinc-400 hover:bg-zinc-800 hover:text-rose-400 transition"
                title="Sign Out"
                aria-label="Sign Out"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Server Configuration Modal */}
      {isServerModalOpen && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsServerModalOpen(false);
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
        >
          <div className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 sm:p-6 shadow-2xl">
            <h3 className="text-base font-bold text-zinc-100 mb-1">Server Configuration</h3>
            <p className="text-xs text-zinc-400 mb-4">
              Specify the API server endpoint that Hub connects to. Changing servers signs you out.
            </p>

            <form onSubmit={handleSaveUrl} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1.5">API Base URL</label>
                <input
                  type="url"
                  required
                  value={tempUrl}
                  onChange={(e) => setTempUrl(e.target.value)}
                  placeholder={DEFAULT_API_URL}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 font-mono focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsServerModalOpen(false)}
                  className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-white transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 transition shadow-md"
                >
                  Save URL
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};
