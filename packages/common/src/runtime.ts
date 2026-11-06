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
  type ProductEdition,
  type ProductPolicy,
} from './productPolicy';
import { passwordAuthProvider } from './auth/passwordAuthProvider';
import type { AuthProvider } from './auth/types';

export interface AirrestRuntimeConfig {
  adapter: PlatformAdapter;
  /** @deprecated Prefer productPolicy so every runtime dependency shares one policy. */
  edition?: ProductEdition;
  productPolicy?: ProductPolicy;
  authProvider?: AuthProvider;
  cloudClient?: CloudClient;
  assets?: Record<string, string>;
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
  const productPolicy = config.productPolicy ?? createProductPolicy(edition);
  const authProvider = config.authProvider ?? passwordAuthProvider;
  const cloudClient = config.cloudClient ?? createCloudClient({
    transport: productPolicy.workspace.cloud ? adapter.cloudTransport : null,
    useDefaultTransport: productPolicy.workspace.cloud && !adapter.cloudTransport,
  });

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
      if (state.cloudConfig.token && (!failedToken || state.cloudConfig.token === failedToken)) {
        state.logoutCloud();
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('airrest:auth-required'));
        setTimeout(() => {
          store.setState({ syncError: reason });
        }, 300);
      }
    };

    // Keep the legacy callbacks during the transition because mutation paths still
    // use the backwards-compatible module-level client.
    unregTokenRefresh = registerTokenRefreshCallback(updateSessionTokens);
    unregAuthEvicted = registerAuthEvictedCallback(evictSession);
    unregCloudClientTokenRefresh = cloudClient.registerTokenRefreshCallback(updateSessionTokens);
    unregCloudClientAuthEvicted = cloudClient.registerAuthEvictedCallback(evictSession);
  }

  let isDisposed = false;

  const dispose = () => {
    if (isDisposed) return;
    isDisposed = true;

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
