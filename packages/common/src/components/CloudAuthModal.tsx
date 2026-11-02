'use client';

import React, { useState, useEffect } from 'react';
import { useBackHandler } from '../lib/backNavigation';
import { Lock, Mail, Server, AlertCircle, Loader2, CheckCircle2, X, Eye, EyeOff } from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { useStoreContext } from '../store/storeContext';
import {
  loginUser,
  fetchUserWorkspaces,
  fetchUserTeams,
  fetchTeamProjects,
  normalizeCloudApiUrl,
} from '../lib/cloudApi';
import { ActiveScope, CloudUser } from '../types/api';
import { getRoleFromJwt } from '../lib/jwt';

interface CloudAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CloudAuthModal: React.FC<CloudAuthModalProps> = ({ isOpen, onClose }) => {
  const contextStore = useStoreContext();
  const activeStore = contextStore || useApiStore;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showServerConfig, setShowServerConfig] = useState(true);

  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [importPrompt, setImportPrompt] = useState(false);

  const cloudConfig = activeStore((state) => state.cloudConfig);
  const setCloudConfig = activeStore((state) => state.setCloudConfig);
  const setWorkspaceMode = activeStore((state) => state.setWorkspaceMode);
  const setActiveScope = activeStore((state) => state.setActiveScope);
  const pullCloudDelta = activeStore((state) => state.pullCloudDelta);
  const importLocalToCloud = activeStore((state) => state.importLocalToCloud);
  const collections = activeStore((state) => state.collections);
  const offlineScopeCache = activeStore((state) => state.offlineScopeCache);
  const activeOfflineWorkspaceId = activeStore((state) => state.activeOfflineWorkspaceId);

  const localCols = offlineScopeCache?.[activeOfflineWorkspaceId || 'local-default']?.collections || collections;
  const localCount = localCols.length;

  const [apiUrl, setApiUrl] = useState(normalizeCloudApiUrl(cloudConfig.apiUrl) || 'http://localhost:8080');

  const handleClose = () => {
    setPassword('');
    setShowPassword(false);
    setErrorMsg(null);
    setImportPrompt(false);
    onClose();
  };
  useBackHandler(isOpen, () => { if (!isLoading) handleClose(); }, 20);

  useEffect(() => {
    if (isOpen) {
      setShowServerConfig(true);
      setErrorMsg(null);
      setPassword('');
      setShowPassword(false);
      setImportPrompt(false);
      if (cloudConfig?.apiUrl) {
        setApiUrl(normalizeCloudApiUrl(cloudConfig.apiUrl) || 'http://localhost:8080');
      }
    }
  }, [isOpen, cloudConfig?.apiUrl]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg(null);

    try {
      const cleanUrl = normalizeCloudApiUrl(apiUrl);
      const authResult = await loginUser(cleanUrl, email, password);
      const { user, token, refresh_token, expires_at } = authResult;

      // 1. Fetch workspaces and teams to establish initial active scope
      let initialScope: ActiveScope = {
        type: 'workspace',
        id: '',
        name: 'Default Workspace',
        role: 'owner',
      };

      try {
        const workspaces = await fetchUserWorkspaces(cleanUrl, token, refresh_token);
        if (Array.isArray(workspaces) && workspaces.length > 0) {
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
          if (Array.isArray(teams) && teams.length > 0) {
            const projects = await fetchTeamProjects(cleanUrl, teams[0].id, token, refresh_token);
            if (Array.isArray(projects) && projects.length > 0) {
              initialScope = {
                type: 'project',
                id: projects[0].id,
                name: projects[0].name,
                teamId: teams[0].id,
                teamName: teams[0].name,
                role: projects[0].user_role || (user.role === 'superadmin' ? 'admin' : 'contributor'),
                permissions: projects[0].permissions,
              };
            }
          }
        }
      } catch (wsErr) {
        console.warn('Could not auto-fetch scopes upon login:', wsErr);
      }

      const currentStore = activeStore.getState();
      const activeWsId = currentStore.activeOfflineWorkspaceId || 'local-default';
      const localEntry = currentStore.offlineScopeCache?.[activeWsId];
      const localCols = localEntry?.collections || (currentStore.workspaceMode === 'offline' ? currentStore.collections : []);
      const localCount = localCols.length;

      // 2. Commit auth to store prioritizing verified server user role before jwt fallback
      const jwtRole = getRoleFromJwt(token);
      const effectiveUser: CloudUser = {
        ...user,
        role: user.role || jwtRole || 'reader',
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
      setPassword('');
      setShowPassword(false);
      if (localCount > 0) {
        setImportPrompt(true);
      } else {
        handleClose();
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
    handleClose();
  };

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget && !isLoading) {
          handleClose();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-150"
    >
      <div className="relative max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-2xl border border-line-strong bg-card p-4 shadow-2xl shadow-black/90 md:p-6">
        {/* Close Button */}
        <button
          onClick={handleClose}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-tx-muted hover:bg-hover hover:text-tx-primary transition"
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
            <h3 className="text-base font-bold text-tx-primary">Successfully Signed In!</h3>
            <p className="text-xs text-tx-muted mt-2 leading-relaxed">
              We detected <strong className="text-sky-400">{localCount} collection(s)</strong> in your local offline workspace.
              Would you like to import them into your active workspace?
            </p>

            <div className="mt-6 flex flex-col gap-2">
              <button
                disabled={isLoading}
                onClick={() => handleImportDecision(true)}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-sky-600 py-2.5 text-xs font-semibold text-white hover:bg-sky-500 transition shadow-md shadow-sky-600/20 disabled:opacity-50"
              >
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Yes, Import Local Collections'}
              </button>
              <button
                disabled={isLoading}
                onClick={() => handleImportDecision(false)}
                className="w-full rounded-lg border border-line bg-element py-2.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition disabled:opacity-50"
              >
                Start with a Clean Workspace
              </button>
            </div>
          </div>
        ) : (
          /* Main Auth Form */
          <>
            <div className="flex items-center gap-3 mb-5">
              <img
                src="/icons/logo-square.png"
                alt="AirREST"
                className="h-10 w-10 rounded-xl object-cover shadow-md shadow-sky-500/20"
              />
              <div>
                <h3 className="text-base font-bold text-tx-primary">Connect to Self-Hosted AirREST</h3>
                <p className="text-xs text-tx-muted">Collaborate with teams &amp; sync collections</p>
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
                <label className="block text-[11px] font-semibold text-tx-secondary mb-1">Email Address</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-2.5 h-4 w-4 text-tx-muted" />
                  <input
                    type="email"
                    required
                    placeholder="user@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-lg border border-line bg-element pl-9 pr-3 py-2 text-xs text-tx-primary placeholder-tx-faint focus:border-sky-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-tx-secondary mb-1">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-2.5 h-4 w-4 text-tx-muted" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    placeholder="Minimum 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-line bg-element pl-9 pr-10 py-2 text-xs text-tx-primary placeholder-tx-faint focus:border-sky-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-2.5 text-tx-muted hover:text-tx-primary transition"
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
                  className="flex items-center gap-1.5 text-[11px] font-medium text-tx-muted hover:text-sky-400 transition"
                >
                  <Server className="h-3 w-3" />
                  <span>{showServerConfig ? 'Hide Server Configuration' : 'Server Settings (Custom URL)'}</span>
                </button>

                {showServerConfig && (
                  <div className="mt-2 rounded-lg border border-line bg-element/50 p-2.5 animate-in fade-in duration-150">
                    <label className="block text-[10px] uppercase font-semibold text-tx-muted mb-1">
                      API Server Endpoint
                    </label>
                    <input
                      type="url"
                      placeholder="http://localhost:8080"
                      value={apiUrl}
                      onChange={(e) => setApiUrl(e.target.value)}
                      className="w-full rounded border border-line bg-card px-2.5 py-1.5 text-xs text-tx-primary focus:border-sky-500 focus:outline-none font-mono"
                    />
                    <p className="text-[10px] text-tx-faint mt-1">
                      Input your self-hosted AirREST backend URL.
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

              <p className="mt-4 text-center text-[11px] text-tx-faint">
                New accounts are provisioned exclusively by your system administrator in AirREST Hub.
              </p>
            </form>
          </>
        )}
      </div>
    </div>
  );
};
