import {
  createApiStore,
  ApiStore,
  setActiveRuntimeStore,
  getActiveRuntimeStore,
} from './store/useApiStore';
import type { StateStorage } from 'zustand/middleware';
import { PlatformAdapter } from './types/platform';
import {
  setCloudTransport,
  getCloudTransport,
  createCloudClient,
  registerTokenRefreshCallback,
  registerAuthEvictedCallback,
} from './lib/cloudApi';
import type { CloudClient } from './lib/cloudApi';
import { setScriptExecutor, getScriptExecutor } from './lib/scriptRunner';
import { setDefaultPlatformAdapter, getDefaultPlatformAdapter } from './lib/fetcher';
import {
  createProductPolicy,
  validateProductPolicy,
  type ProductEdition,
  type ProductPolicy,
} from './productPolicy';
import { createPasswordAuthProvider } from './auth/passwordAuthProvider';
import type { AuthProvider } from './auth/types';
import { isCloudSessionActive } from './workspace/cloudSession';
import { validateApplicationDistributionConfig, type ApplicationDistributionConfig } from './distributionConfig';

function getNativeCredentialScope(config: { apiUrl?: string; user?: { id?: string } }) {
  const apiUrl = config.apiUrl?.trim();
  const userId = config.user?.id?.trim();
  return apiUrl && userId ? { apiUrl, userId } : null;
}

function sameNativeCredentialScope(
  left: { apiUrl: string; userId: string } | null | undefined,
  right: { apiUrl: string; userId: string } | null | undefined,
): boolean {
  return Boolean(left && right && left.apiUrl === right.apiUrl && left.userId === right.userId);
}

export interface AirrestRuntimeConfig {
  adapter: PlatformAdapter;
  /** @deprecated Prefer productPolicy so every runtime dependency shares one policy. */
  edition?: ProductEdition;
  productPolicy?: ProductPolicy;
  /** Validated product, backend, auth, and update-source configuration for this app composition. */
  distributionConfig?: ApplicationDistributionConfig;
  authProvider?: AuthProvider;
  cloudClient?: CloudClient;
  /** Opt in only when an injected legacy store makes requests through module-level cloud APIs. */
  legacyCloudCallbacks?: boolean;
  assets?: Record<string, string>;
  /** Stores created by createApiStore are checked; legacy unbranded stores are trusted. */
  store?: ApiStore;
  storage?: StateStorage;
}

export interface AirrestRuntime {
  adapter: PlatformAdapter;
  edition: ProductEdition;
  productPolicy: ProductPolicy;
  authProvider: AuthProvider;
  cloudClient: CloudClient;
  assets: Record<string, string>;
  store: ApiStore;
  credentialReady: Promise<void>;
  dispose: () => void;
}

export function createAirrestRuntime(config: AirrestRuntimeConfig): AirrestRuntime {
  const { adapter, assets = {} } = config;
  const edition = config.edition ?? 'full';
  const distributionConfig = config.distributionConfig === undefined
    ? undefined
    : validateApplicationDistributionConfig(config.distributionConfig);
  const productPolicy = config.productPolicy !== undefined
    ? validateProductPolicy(config.productPolicy)
    : distributionConfig?.workspace.policy ?? createProductPolicy(edition);
  if (config.edition !== undefined && productPolicy.edition !== config.edition) {
    throw new Error('The edition and product policy must match.');
  }
  if (distributionConfig !== undefined && distributionConfig.workspace.policy !== productPolicy) {
    throw new Error('The distribution configuration and product policy must match.');
  }
  if (config.store?.productPolicy !== undefined && validateProductPolicy(config.store.productPolicy) !== productPolicy) {
    throw new Error('The injected store uses a different product policy than this runtime.');
  }
  if (!productPolicy.workspace.cloud && config.cloudClient) {
    throw new Error('A cloud client cannot be injected into an offline-only runtime.');
  }
  const cloudClient = config.cloudClient ?? createCloudClient({
    enabled: productPolicy.workspace.cloud,
    transport: productPolicy.workspace.cloud ? adapter.cloudTransport : null,
    authorizeRequest: config.authProvider?.authorizeRequest?.bind(config.authProvider),
    passwordRefresh: !config.authProvider || config.authProvider.id === 'password',
  });
  const authProvider = config.authProvider ?? createPasswordAuthProvider(cloudClient.loginUser);
  if (distributionConfig !== undefined && distributionConfig.auth.providerId !== authProvider.id) {
    throw new Error('The distribution configuration and auth provider must match.');
  }

  // Each runtime creates its own isolated store instance unless explicitly injected
  const store = config.store || createApiStore({
    storage: config.storage,
    adapter: config.adapter,
    credentialStorage: adapter.credentialStorage,
    productPolicy,
    cloudClient,
  });
  setActiveRuntimeStore(store);

  // Wire adapter services into common libraries
  setDefaultPlatformAdapter(adapter);
  if (productPolicy.workspace.cloud && adapter.cloudTransport) {
    setCloudTransport(adapter.cloudTransport);
  }
  if (adapter.scriptExecutor) {
    setScriptExecutor(adapter.scriptExecutor);
  }

  // Register scoped token refresh and auth eviction listeners for this runtime store
  let unregTokenRefresh: (() => void) | null = null;
  let unregAuthEvicted: (() => void) | null = null;
  let unregCloudClientTokenRefresh: (() => void) | null = null;
  let unregCloudClientAuthEvicted: (() => void) | null = null;
  let unregCredentialHydration: (() => void) | null = null;
  let isDisposed = false;
  let evictionTimer: ReturnType<typeof setTimeout> | undefined;
  let observedSessionGeneration = store.getState().getCloudSessionGeneration?.();
  const updateProviderSession = (state: ReturnType<ApiStore['getState']>) => {
    cloudClient.setProviderSessionActive?.(
      state.cloudConfig.sessionKind === 'provider' && isCloudSessionActive(state.cloudConfig),
    );
  };
  updateProviderSession(store.getState());
  const unregSessionObserver = store.subscribe?.((state) => {
    const nextGeneration = state.getCloudSessionGeneration?.();
    if (nextGeneration !== observedSessionGeneration) {
      observedSessionGeneration = nextGeneration;
      cloudClient.invalidateSession?.();
    }
    updateProviderSession(state);
  });

  const restoreNativeCredentials = async () => {
    const credentialStorage = adapter.credentialStorage;
    if (!credentialStorage || isDisposed || !productPolicy.workspace.cloud) return;
    if (store.getState().recoverNativeCredentials) {
      await store.getState().recoverNativeCredentials({ isCancelled: () => isDisposed });
      return;
    }
    const current = store.getState().cloudConfig;
    const scope = getNativeCredentialScope(current);
    if (!scope || current.sessionKind === 'provider') return;
    const initialGeneration = store.getState().getCloudSessionGeneration();
    const isCurrentRestore = () =>
      !isDisposed &&
      store.getState().getCloudSessionGeneration() === initialGeneration &&
      sameNativeCredentialScope(getNativeCredentialScope(store.getState().cloudConfig), scope);
    const vaulted = await credentialStorage.read(scope);
    if (!isCurrentRestore() || !vaulted) return;
    store.getState().setCloudConfig({
      token: vaulted.accessToken,
      refreshToken: vaulted.refreshToken,
      tokenExpiresAt: vaulted.expiresAt,
    });
  };

  const credentialReady = new Promise<void>((resolve) => {
    const completeRestore = () => {
      void restoreNativeCredentials()
        .catch((error: unknown) => {
          if (!isDisposed) {
            store.setState({ syncError: 'Protected credential storage is unavailable. Please sign in again.' });
          }
          console.warn('Could not restore protected credentials:', error);
        })
        .finally(resolve);
    };
    if (!adapter.credentialStorage || !productPolicy.workspace.cloud) {
      resolve();
    } else if (store.persist.hasHydrated()) {
      completeRestore();
    } else {
      unregCredentialHydration = store.persist.onFinishHydration(completeRestore);
    }
  });

  if (productPolicy.workspace.cloud) {
    const pendingTokenRotations = new Set<{
      generation: number;
      token: string;
      previousToken?: string;
      scope: { apiUrl: string; userId: string } | null;
    }>();

    const updateSessionTokens = (newTokens: {
      token: string;
      refreshToken: string;
      expiresAt?: string;
      previousRefreshToken?: string;
    }) => {
      const state = store.getState();
      if (state.cloudConfig.refreshToken !== newTokens.previousRefreshToken) return;
      const generation = state.getCloudSessionGeneration();
      const scope = getNativeCredentialScope(state.cloudConfig);
      const pending = {
        generation,
        token: newTokens.token,
        previousToken: state.cloudConfig.token,
        scope,
      };
      pendingTokenRotations.add(pending);
      const update = {
        token: newTokens.token,
        refreshToken: newTokens.refreshToken,
        tokenExpiresAt: newTokens.expiresAt,
      };
      const save = state.setCloudSession
        ? state.setCloudSession(update)
        : Promise.resolve(state.setCloudConfig(update));
      void save
        .catch((error: unknown) => {
          if (!isDisposed && store.getState().getCloudSessionGeneration() === generation) {
            store.setState({ syncError: 'Could not save the refreshed session securely. Please sign in again.' });
          }
          console.warn('Could not save refreshed credentials:', error);
        })
        .finally(() => {
          pendingTokenRotations.delete(pending);
        });
    };

    const evictSession = (reason: string, failedToken?: string) => {
      const state = store.getState();
      const generation = state.getCloudSessionGeneration();
      for (const entry of pendingTokenRotations) {
        if (entry.generation !== generation) {
          pendingTokenRotations.delete(entry);
        }
      }
      const matchedPending = failedToken
        ? [...pendingTokenRotations].find((entry) => entry.generation === generation && entry.token === failedToken)
        : undefined;
      const supersededByPending = failedToken
        ? [...pendingTokenRotations].find(
            (entry) => entry.generation === generation && entry.previousToken === failedToken && entry.token !== failedToken
          )
        : undefined;
      if (supersededByPending) {
        return;
      }
      const providerFailure = !failedToken && state.cloudConfig.sessionKind === 'provider' && isCloudSessionActive(state.cloudConfig);
      const matchesActiveToken = Boolean(state.cloudConfig.token && (!failedToken || state.cloudConfig.token === failedToken));
      if (providerFailure || matchesActiveToken || Boolean(matchedPending)) {
        const scope = getNativeCredentialScope(state.cloudConfig) || matchedPending?.scope || null;
        for (const entry of pendingTokenRotations) {
          if (entry.generation === generation) {
            pendingTokenRotations.delete(entry);
          }
        }
        if (state.evictCloudSession) {
          state.evictCloudSession(scope || undefined);
        } else {
          if (state.clearCloudCredentials) {
            void state.clearCloudCredentials(scope || undefined).catch((error: unknown) => {
              console.warn('Could not remove expired credentials:', error);
            });
          }
          state.logoutCloud();
        }
        const loggedOutConfig = store.getState().cloudConfig;
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('airrest:auth-required', { detail: { store } }));
        }
        if (evictionTimer !== undefined) clearTimeout(evictionTimer);
        evictionTimer = setTimeout(() => {
          evictionTimer = undefined;
          if (!isDisposed && store.getState().cloudConfig === loggedOutConfig) {
            store.setState({ syncError: reason });
          }
        }, 300);
      }
    };

    // Runtime-owned stores use the scoped client. A legacy injected store can
    // explicitly opt into the old global callback bridge when migrating.
    if (config.legacyCloudCallbacks) {
      unregTokenRefresh = registerTokenRefreshCallback((tokens) => {
        if (getActiveRuntimeStore() === store) updateSessionTokens(tokens);
      });
      unregAuthEvicted = registerAuthEvictedCallback((reason, failedToken) => {
        if (getActiveRuntimeStore() === store) evictSession(reason, failedToken);
      });
    }
    unregCloudClientTokenRefresh = cloudClient.registerTokenRefreshCallback(updateSessionTokens);
    unregCloudClientAuthEvicted = cloudClient.registerAuthEvictedCallback(evictSession);
  }

  const dispose = () => {
    if (isDisposed) return;
    isDisposed = true;
    unregSessionObserver?.();
    unregCredentialHydration?.();
    unregCredentialHydration = null;
    if (evictionTimer !== undefined) {
      clearTimeout(evictionTimer);
      evictionTimer = undefined;
    }

    if (getActiveRuntimeStore() === store) {
      setActiveRuntimeStore(null);
    }

    // Only clear global references if they belong to this adapter instance
    if (getDefaultPlatformAdapter() === adapter) {
      setDefaultPlatformAdapter(null);
    }
    if (getCloudTransport() === adapter.cloudTransport) {
      setCloudTransport(null);
    }
    if (getScriptExecutor() === adapter.scriptExecutor) {
      setScriptExecutor(null);
    }

    if (unregTokenRefresh) {
      unregTokenRefresh();
      unregTokenRefresh = null;
    }
    if (unregAuthEvicted) {
      unregAuthEvicted();
      unregAuthEvicted = null;
    }
    if (unregCloudClientTokenRefresh) {
      unregCloudClientTokenRefresh();
      unregCloudClientTokenRefresh = null;
    }
    if (unregCloudClientAuthEvicted) {
      unregCloudClientAuthEvicted();
      unregCloudClientAuthEvicted = null;
    }
    cloudClient.dispose();

    try {
      if (typeof (store as any).dispose === 'function') {
        (store as any).dispose();
      }
    } catch {
      // ignore idempotent disposal errors
    }

    try {
      adapter.dispose();
    } catch {
      // ignore idempotent disposal errors
    }
  };

  return {
    adapter,
    edition: productPolicy.edition,
    productPolicy,
    authProvider,
    cloudClient,
    assets,
    store,
    credentialReady,
    dispose,
  };
}
