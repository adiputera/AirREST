import React, { createContext, useContext } from 'react';
import { AirrestRuntime } from './runtime';
import { StoreContext } from './store/storeContext';
import { defaultProductPolicy } from './lib/edition';
import type { ProductPolicy } from './productPolicy';
import { passwordAuthProvider } from './auth/passwordAuthProvider';
import type { AuthProvider } from './auth/types';
import type { CloudClient } from './lib/cloudApi';
import { getDefaultPlatformAdapter } from './lib/fetcher';
import type { PlatformAdapter } from './types/platform';

const AirrestContext = createContext<AirrestRuntime | null>(null);

export interface AirrestProviderProps {
  runtime: AirrestRuntime;
  children: React.ReactNode;
}

export const AirrestProvider: React.FC<AirrestProviderProps> = ({ runtime, children }) => {
  return (
    <AirrestContext.Provider value={runtime}>
      <StoreContext.Provider value={runtime.store}>
        {children}
      </StoreContext.Provider>
    </AirrestContext.Provider>
  );
};

export function useAirrestRuntime(): AirrestRuntime {
  const ctx = useContext(AirrestContext);
  if (!ctx) {
    throw new Error('useAirrestRuntime must be used within an AirrestProvider');
  }
  return ctx;
}

export function useProductPolicy(): ProductPolicy {
  return useContext(AirrestContext)?.productPolicy ?? defaultProductPolicy;
}

export function useAuthProvider(): AuthProvider {
  return useContext(AirrestContext)?.authProvider ?? passwordAuthProvider;
}

/** Returns null for legacy consumers that do not use a runtime provider. */
export function useCloudClient(): CloudClient | null {
  return useContext(AirrestContext)?.cloudClient ?? null;
}

/** Resolve the platform belonging to this tree, retaining the legacy fallback. */
export function usePlatformAdapter(): PlatformAdapter | null {
  return useContext(AirrestContext)?.adapter ?? getDefaultPlatformAdapter();
}
