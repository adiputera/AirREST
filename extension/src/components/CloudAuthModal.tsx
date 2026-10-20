'use client';

import React, { useState } from 'react';
import { Cloud, Lock, Mail, Server, AlertCircle, Loader2, CheckCircle2, X, Eye, EyeOff } from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import {
  loginUser,
  fetchUserWorkspaces,
  fetchUserTeams,
  fetchTeamProjects,
} from '@/lib/cloudApi';
import { ActiveScope, CloudUser } from '@/types/api';
import { getRoleFromJwt } from '@/lib/jwt';

interface CloudAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CloudAuthModal: React.FC<CloudAuthModalProps> = ({ isOpen, onClose }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showServerConfig, setShowServerConfig] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [importPrompt, setImportPrompt] = useState(false);

  const cloudConfig = useApiStore((state) => state.cloudConfig);
  const setCloudConfig = useApiStore((state) => state.setCloudConfig);
  const setWorkspaceMode = useApiStore((state) => state.setWorkspaceMode);
  const setActiveScope = useApiStore((state) => state.setActiveScope);
  const pullCloudDelta = useApiStore((state) => state.pullCloudDelta);
  const importLocalToCloud = useApiStore((state) => state.importLocalToCloud);
  const collections = useApiStore((state) => state.collections);
  const offlineScopeCache = useApiStore((state) => state.offlineScopeCache);
  const activeOfflineWorkspaceId = useApiStore((state) => state.activeOfflineWorkspaceId);

  const localCols = offlineScopeCache?.[activeOfflineWorkspaceId || 'local-default']?.collections || collections;
  const localCount = localCols.length;

  const [apiUrl, setApiUrl] = useState(cloudConfig.apiUrl || 'http://localhost:8080');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg(null);

    try {
      const cleanUrl = apiUrl.trim().replace(/\/+$/, '') || 'http://localhost:8080';
      const authResult = await loginUser(cleanUrl, email, password);
      const { user, token, refresh_token, expires_at } = authResult;

      // 1. Fetch workspaces and teams to establish initial active scope
      let initialScope: ActiveScope = {
        type: 'workspace',
        id: '',
        name: 'Personal Workspace',
        role: 'owner',
      };

      try {
        const workspaces = await fetchUserWorkspaces(cleanUrl, token, refresh_token);
        if (workspaces.length > 0) {
          const defaultWs = workspaces.find((w) => w.is_default) || workspaces[0];
          initialScope = {
            type: 'workspace',
            id: defaultWs.id,
            name: defaultWs.name,
            role: 'owner',
          };
        } else {
          // Check teams
          const teams = await fetchUserTeams(cleanUrl, token, refresh_token);
          if (teams.length > 0) {
            const projects = await fetchTeamProjects(cleanUrl, teams[0].id, token, refresh_token);
            if (projects.length > 0) {
              initialScope = {
                type: 'project',
                id: projects[0].id,
                name: projects[0].name,
                teamId: teams[0].id,
                teamName: teams[0].name,
                role: projects[0].user_role || (user.role === 'superadmin' ? 'admin' : 'contributor'),
              };
            }
          }
        }
      } catch (wsErr) {
        console.warn('Could not auto-fetch scopes upon login:', wsErr);
      }

      const currentStore = useApiStore.getState();
      const activeWsId = currentStore.activeOfflineWorkspaceId || 'local-default';
      const localEntry = currentStore.offlineScopeCache?.[activeWsId];
      const localCols = localEntry?.collections || (currentStore.workspaceMode === 'offline' ? currentStore.collections : []);
      const localCount = localCols.length;

      // 2. Commit auth to store with role derived from JWT token
      const jwtRole = getRoleFromJwt(token);
      const effectiveUser: CloudUser = {
        ...user,
        role: jwtRole || user.role,
      };

      setCloudConfig({
        apiUrl: cleanUrl,
        token,
        refreshToken: refresh_token,
        tokenExpiresAt: expires_at,
        user: effectiveUser,
        activeScope: initialScope,
      });

      setWorkspaceMode('cloud');

      // 3. Trigger initial delta pull
      if (initialScope.id) {
        await setActiveScope(initialScope);
      } else {
        await pullCloudDelta();
      }

      // 4. Check if local collections exist to prompt for one-click migration
      if (localCount > 0) {
        setImportPrompt(true);
      } else {
        onClose();
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Authentication failed. Please verify credentials.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleImportDecision = async (shouldImport: boolean) => {
    if (shouldImport) {
      setIsLoading(true);
      await importLocalToCloud();
      setIsLoading(false);
    }
    setImportPrompt(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-150">
      <div className="relative w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl shadow-black/90">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>

        {importPrompt ? (
          /* Post-Login Import Prompt */
          <div className="text-center py-2 animate-in fade-in duration-200">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-500/10 text-sky-400 border border-sky-500/20 mb-3">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <h3 className="text-base font-bold text-zinc-100">Successfully Signed In!</h3>
            <p className="text-xs text-zinc-400 mt-2 leading-relaxed">
              We detected <strong className="text-sky-400">{localCount} collection(s)</strong> in your local offline workspace.
              Would you like to import them into your active cloud workspace?
            </p>

            <div className="mt-6 flex flex-col gap-2">
              <button
                disabled={isLoading}
                onClick={() => handleImportDecision(true)}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-sky-600 py-2.5 text-xs font-semibold text-white hover:bg-sky-500 transition shadow-md shadow-sky-600/20 disabled:opacity-50"
              >
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Yes, Import Local Collections to Cloud'}
              </button>
              <button
                disabled={isLoading}
                onClick={() => handleImportDecision(false)}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition disabled:opacity-50"
              >
                Start with a Clean Cloud Workspace
              </button>
            </div>
          </div>
        ) : (
          /* Main Auth Form */
          <>
            <div className="flex items-center gap-3 mb-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-sky-600 to-indigo-600 text-white shadow-md shadow-sky-500/20">
                <Cloud className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-zinc-100">Connect to AirREST Cloud</h3>
                <p className="text-xs text-zinc-400">Collaborate with teams &amp; sync collections</p>
              </div>
            </div>

            {/* Error Banner */}
            {errorMsg && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300 animate-in fade-in duration-150">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-zinc-300 mb-1">Email Address</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
                  <input
                    type="email"
                    required
                    placeholder="user@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900/90 pl-9 pr-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-zinc-300 mb-1">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    placeholder="Minimum 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900/90 pl-9 pr-10 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-2.5 text-zinc-500 hover:text-zinc-300 transition"
                    title={showPassword ? 'Hide password' : 'Show password'}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* Server URL Accordion */}
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowServerConfig(!showServerConfig)}
                  className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400 hover:text-sky-400 transition"
                >
                  <Server className="h-3 w-3" />
                  <span>{showServerConfig ? 'Hide Server Configuration' : 'Server Settings (Custom URL)'}</span>
                </button>

                {showServerConfig && (
                  <div className="mt-2 rounded-lg border border-zinc-800/80 bg-zinc-900/50 p-2.5 animate-in fade-in duration-150">
                    <label className="block text-[10px] uppercase font-semibold text-zinc-400 mb-1">
                      API Server Endpoint
                    </label>
                    <input
                      type="url"
                      placeholder="http://localhost:8080"
                      value={apiUrl}
                      onChange={(e) => setApiUrl(e.target.value)}
                      className="w-full rounded border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 focus:border-sky-500 focus:outline-none font-mono"
                    />
                    <p className="text-[10px] text-zinc-500 mt-1">
                      Defaults to local Go server. Point to your Vercel or cloud endpoint in production.
                    </p>
                  </div>
                )}
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-sky-600 to-indigo-600 py-2.5 text-xs font-semibold text-white shadow-md shadow-sky-500/20 hover:from-sky-500 hover:to-indigo-500 transition disabled:opacity-50 mt-4"
              >
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Sign In & Synchronize'}
              </button>

              <p className="mt-4 text-center text-[11px] text-zinc-500">
                New accounts are provisioned exclusively by your system administrator in AirREST Hub.
              </p>
            </form>
          </>
        )}
      </div>
    </div>
  );
};
