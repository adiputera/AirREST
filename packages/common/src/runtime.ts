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
  registerTokenRefreshCallback,
  registerAuthEvictedCallback,
} from './lib/cloudApi';
import { setScriptExecutor, getScriptExecutor } from './lib/scriptRunner';
import { setDefaultPlatformAdapter, getDefaultPlatformAdapter } from './lib/fetcher';

export interface AirrestRuntimeConfig {
  adapter: PlatformAdapter;
  edition?: 'offline' | 'full';
  assets?: Record<string, string>;
  store?: ApiStore;
  storage?: StateStorage;
}

export interface AirrestRuntime {
  adapter: PlatformAdapter;
  edition: 'offline' | 'full';
  assets: Record<string, string>;
  store: ApiStore;
  dispose: () => void;
}

export function createAirrestRuntime(config: AirrestRuntimeConfig): AirrestRuntime {
  const { adapter, edition = 'full', assets = {} } = config;

  // Each runtime creates its own isolated store instance unless explicitly injected
  const store = config.store || createApiStore({ storage: config.storage, adapter: config.adapter });
  setActiveRuntimeStore(store);

  // Wire adapter services into common libraries
  setDefaultPlatformAdapter(adapter);
  if (edition !== 'offline' && adapter.cloudTransport) {
    setCloudTransport(adapter.cloudTransport);
  }
  if (adapter.scriptExecutor) {
    setScriptExecutor(adapter.scriptExecutor);
  }

  // Register scoped token refresh and auth eviction listeners for this runtime store
  let unregTokenRefresh: (() => void) | null = null;
  let unregAuthEvicted: (() => void) | null = null;

  if (edition !== 'offline') {
    unregTokenRefresh = registerTokenRefreshCallback((newTokens) => {
      if (store.getState().cloudConfig.refreshToken !== newTokens.previousRefreshToken) return;
      store.getState().setCloudConfig({
        token: newTokens.token,
        refreshToken: newTokens.refreshToken,
        tokenExpiresAt: newTokens.expiresAt,
      });
    });

    unregAuthEvicted = registerAuthEvictedCallback((reason, failedToken) => {
      const state = store.getState();
      if (state.cloudConfig.token && (!failedToken || state.cloudConfig.token === failedToken)) {
        state.logoutCloud();
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('airrest:auth-required'));
        setTimeout(() => {
          store.setState({ syncError: reason });
        }, 300);
      }
    });
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
    edition,
    assets,
    store,
    dispose,
  };
}
