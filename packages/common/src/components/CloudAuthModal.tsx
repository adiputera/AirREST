'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useBackHandler } from '../lib/backNavigation';
import { Lock, Mail, Server, AlertCircle, Loader2, CheckCircle2, X, Eye, EyeOff } from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { useStoreContext } from '../store/storeContext';
import {
  fetchUserWorkspaces,
  fetchUserTeams,
  fetchTeamProjects,
  normalizeCloudApiUrl,
} from '../lib/cloudApi';
import { ActiveScope, CloudUser } from '../types/api';
import { getRoleFromJwt } from '../lib/jwt';
import { useAuthProvider, useCloudClient, usePlatformAdapter, useProductPolicy } from '../context';
import { isCloudSessionActive } from '../workspace/cloudSession';

interface CloudAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CloudAuthModal: React.FC<CloudAuthModalProps> = ({ isOpen, onClose }) => {
  const authProvider = useAuthProvider();
  const productPolicy = useProductPolicy();
  const platformAdapter = usePlatformAdapter();
  const cloudClient = useCloudClient();
  const loginOperation = useRef<AbortController | null>(null);
  const loginSession = useRef<{ generation: number; userId: string; apiUrl: string } | null>(null);
  const requiresPasswordCredentials = authProvider.capabilities.passwordCredentials;
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
  const recoverableCount = activeStore((state) => (state.cloudCacheArchives?.unclaimed?.length || 0) +
    (state.cloudCacheArchives?.unsupportedVersions?.length || 0));
  const setCloudConfig = activeStore((state) => state.setCloudConfig);
  const setWorkspaceMode = activeStore((state) => state.setWorkspaceMode);
  const setActiveScope = activeStore((state) => state.setActiveScope);
  const pullCloudDelta = activeStore((state) => state.pullCloudDelta);
  const importLocalToCloud = activeStore((state) => state.importLocalToCloud);
  const collections = activeStore((state) => state.collections);
  const offlineScopeCache = activeStore((state) => state.offlineScopeCache);
  const activeOfflineWorkspaceId = activeStore((state) => state.activeOfflineWorkspaceId);

  const localCols = offlineScopeCache?.[activeOfflineWorkspaceId || 'local-default']?.collections || collections;
  const localCount = productPolicy.workspace.offline === false ? 0 : localCols.length;

  const [apiUrl, setApiUrl] = useState(normalizeCloudApiUrl(cloudConfig.apiUrl) || 'http://localhost:8080');

  const handleClose = () => {
    if (productPolicy.workspace.offline === false && !isCloudSessionActive(activeStore.getState().cloudConfig)) return;
    loginOperation.current?.abort();
    loginOperation.current = null;
    loginSession.current = null;
    setIsLoading(false);
    setPassword('');
    setShowPassword(false);
    setErrorMsg(null);
    setImportPrompt(false);
    onClose();
  };
  const downloadPreservedData = async () => {
    try {
      const content = activeStore.getState().getCloudCacheRecoveryBackup();
      if (platformAdapter?.saveFile) {
        await platformAdapter.saveFile('airrest-cloud-cache-recovery.json', content, {
          filters: [{ name: 'JSON', extensions: ['json'] }], mimeType: 'application/json',
        });
      } else {
        const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'airrest-cloud-cache-recovery.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch {
      setErrorMsg('Could not save the recovery file. Please try again.');
    }
  };
  useBackHandler(isOpen, () => { if (!isLoading) handleClose(); }, 20);

  useEffect(() => {
    if (!isOpen) {
      loginOperation.current?.abort();
      loginOperation.current = null;
      loginSession.current = null;
      setIsLoading(false);
    }
    return () => {
      loginOperation.current?.abort();
      loginOperation.current = null;
      loginSession.current = null;
    };
  }, [isOpen]);

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
    if (loginOperation.current) return;
    const operation = new AbortController();
    loginOperation.current = operation;
    loginSession.current = null;
    const startingConfig = activeStore.getState().cloudConfig;
    const isCurrent = () => {
      if (loginOperation.current !== operation || operation.signal.aborted) return false;
      const session = loginSession.current;
      if (!session) return true;
      const state = activeStore.getState();
      return state.getCloudSessionGeneration() === session.generation &&
        state.cloudConfig.user?.id === session.userId && state.cloudConfig.apiUrl === session.apiUrl;
    };
    setIsLoading(true);
    setErrorMsg(null);

    try {
      const cleanUrl = normalizeCloudApiUrl(apiUrl);
      const authResult = await authProvider.signIn({
        apiUrl: cleanUrl,
        email: requiresPasswordCredentials ? email : undefined,
        password: requiresPasswordCredentials ? password : undefined,
        signal: operation.signal,
      });
      if (!isCurrent()) return;
      const { user, accessToken: token, refreshToken: refresh_token, expiresAt: expires_at } = authResult;
      if (typeof user?.id !== 'string' || !user.id.trim() ||
        (token !== undefined && (typeof token !== 'string' || !token.trim()))) {
        throw new Error('The authentication provider returned an unsupported or invalid session.');
      }
      const providerSession = !token;
      if (providerSession && (!authProvider.authorizeRequest || !cloudClient)) {
        throw new Error('This authentication provider cannot authorize a tokenless session.');
      }
      let verifiedUser = user;
      const verifyProviderIdentity = async () => {
        if (!providerSession || !cloudClient) return;
        const verified = await cloudClient.getCurrentUser(cleanUrl, undefined, undefined, operation.signal);
        if (!isCurrent()) return;
        if (!verified || verified.id !== user.id) {
          throw new Error('The provider session identity could not be verified.');
        }
        verifiedUser = verified;
      };
      await verifyProviderIdentity();
      if (!isCurrent()) return;

      // 1. Fetch workspaces and teams to establish initial active scope
      let initialScope: ActiveScope = {
        type: 'workspace',
        id: '',
        name: 'Default Workspace',
        role: 'owner',
      };

      try {
        const workspaces = await (cloudClient?.fetchUserWorkspaces ?? fetchUserWorkspaces)(cleanUrl, token, refresh_token, operation.signal);
        if (!isCurrent()) return;
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
          const teams = await (cloudClient?.fetchUserTeams ?? fetchUserTeams)(cleanUrl, token, refresh_token, operation.signal);
          if (!isCurrent()) return;
          if (Array.isArray(teams) && teams.length > 0) {
            const projects = await (cloudClient?.fetchTeamProjects ?? fetchTeamProjects)(cleanUrl, teams[0].id, token, refresh_token, operation.signal);
            if (!isCurrent()) return;
            if (Array.isArray(projects) && projects.length > 0) {
              initialScope = {
                type: 'project',
                id: projects[0].id,
                name: projects[0].name,
                teamId: teams[0].id,
                teamName: teams[0].name,
                role: projects[0].user_role || (verifiedUser.role === 'superadmin' ? 'admin' : 'contributor'),
                permissions: projects[0].permissions,
              };
            }
          }
        }
      } catch (wsErr) {
        if (!isCurrent()) return;
        console.warn('Could not auto-fetch scopes upon login:', wsErr);
      }

      // Cookies can change while scope discovery is in flight. Confirm the
      // identity again before restoring an owner-specific cache.
      await verifyProviderIdentity();
      if (!isCurrent()) return;

      const currentStore = activeStore.getState();
      if (!isCurrent() || currentStore.cloudConfig !== startingConfig) return;
      const activeWsId = currentStore.activeOfflineWorkspaceId || 'local-default';
      const localEntry = currentStore.offlineScopeCache?.[activeWsId];
      const localCols = localEntry?.collections || (currentStore.workspaceMode === 'offline' ? currentStore.collections : []);
      const localCount = productPolicy.workspace.offline === false ? 0 : localCols.length;

      // 2. Commit auth to store prioritizing verified server user role before jwt fallback
      const jwtRole = getRoleFromJwt(token);
      const effectiveUser: CloudUser = {
        ...verifiedUser,
        role: verifiedUser.role || jwtRole || 'reader',
      };

      setCloudConfig({
        apiUrl: cleanUrl,
        sessionKind: providerSession ? 'provider' : undefined,
        token,
        refreshToken: refresh_token,
        tokenExpiresAt: expires_at,
        user: effectiveUser,
        activeScope: initialScope,
      });

      const generation = activeStore.getState().getCloudSessionGeneration();
      loginSession.current = { generation, userId: effectiveUser.id, apiUrl: cleanUrl };
      const isCurrentSession = () => {
        const state = activeStore.getState();
        return isCurrent() && state.getCloudSessionGeneration() === generation &&
          state.cloudConfig.user?.id === effectiveUser.id && state.cloudConfig.apiUrl === cleanUrl;
      };

      setWorkspaceMode('cloud');

      // 3. Trigger initial delta pull
      if (initialScope.id) {
        await setActiveScope(initialScope);
      } else {
        await pullCloudDelta();
      }
      if (!isCurrentSession()) return;

      // 4. Check if local collections exist to prompt for one-click migration
      setPassword('');
      setShowPassword(false);
      if (localCount > 0) {
        setImportPrompt(true);
      } else {
        handleClose();
      }
    } catch (err: any) {
      if (isCurrent()) setErrorMsg(err.message || 'Authentication failed. Please verify credentials.');
    } finally {
      if (loginOperation.current === operation) {
        loginOperation.current = null;
        setIsLoading(false);
      }
    }
  };

  const handleImportDecision = async (shouldImport: boolean) => {
    const session = loginSession.current;
    const state = activeStore.getState();
    if (!session || state.getCloudSessionGeneration() !== session.generation ||
      state.cloudConfig.user?.id !== session.userId || state.cloudConfig.apiUrl !== session.apiUrl) {
      handleClose();
      return;
    }
    if (shouldImport) {
      setIsLoading(true);
      await importLocalToCloud();
      setIsLoading(false);
      const current = activeStore.getState();
      if (loginSession.current !== session || current.getCloudSessionGeneration() !== session.generation ||
        current.cloudConfig.user?.id !== session.userId || current.cloudConfig.apiUrl !== session.apiUrl) return;
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
        {(productPolicy.workspace.offline !== false || isCloudSessionActive(cloudConfig)) && <button
          onClick={handleClose}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-tx-muted hover:bg-hover hover:text-tx-primary transition"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>}

        {productPolicy.workspace.offline === false && !isCloudSessionActive(cloudConfig) && recoverableCount > 0 && (
          <button type="button" onClick={() => void downloadPreservedData()}
            className="mb-3 rounded-lg border border-amber-500/40 px-2 py-1 text-xs text-amber-600 dark:text-amber-300"
            title="Download preserved data, which may include sensitive values and unsupported archives">
            Download preserved data
          </button>
        )}

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
              {requiresPasswordCredentials && (
                <>
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
                </>
              )}

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
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : requiresPasswordCredentials ? 'Sign In & Synchronize' : 'Continue'}
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
