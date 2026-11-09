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

export interface AirrestRuntimeConfig {
  adapter: PlatformAdapter;
  /** @deprecated Prefer productPolicy so every runtime dependency shares one policy. */
  edition?: ProductEdition;
  productPolicy?: ProductPolicy;
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
  dispose: () => void;
}

export function createAirrestRuntime(config: AirrestRuntimeConfig): AirrestRuntime {
  const { adapter, edition = 'full', assets = {} } = config;
  const productPolicy = config.productPolicy !== undefined ? validateProductPolicy(config.productPolicy) : createProductPolicy(edition);
  if (config.edition !== undefined && config.productPolicy !== undefined && config.edition !== productPolicy.edition) {
    throw new Error('The edition and product policy must match.');
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

  // Each runtime creates its own isolated store instance unless explicitly injected
  const store = config.store || createApiStore({
    storage: config.storage,
    adapter: config.adapter,
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

  if (productPolicy.workspace.cloud) {
    const updateSessionTokens = (newTokens: {
      token: string;
      refreshToken: string;
      expiresAt?: string;
      previousRefreshToken?: string;
    }) => {
      if (store.getState().cloudConfig.refreshToken !== newTokens.previousRefreshToken) return;
      store.getState().setCloudConfig({
        token: newTokens.token,
        refreshToken: newTokens.refreshToken,
        tokenExpiresAt: newTokens.expiresAt,
      });
    };

    const evictSession = (reason: string, failedToken?: string) => {
      const state = store.getState();
      const providerFailure = !failedToken && state.cloudConfig.sessionKind === 'provider' && isCloudSessionActive(state.cloudConfig);
      if (providerFailure || (state.cloudConfig.token && (!failedToken || state.cloudConfig.token === failedToken))) {
        state.logoutCloud();
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
    dispose,
  };
}
