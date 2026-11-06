import React, { createContext, useContext } from 'react';
import { AirrestRuntime } from './runtime';
import { StoreContext } from './store/storeContext';
import { defaultProductPolicy } from './lib/edition';
import type { ProductPolicy } from './productPolicy';
import { passwordAuthProvider } from './auth/passwordAuthProvider';
import type { AuthProvider } from './auth/types';

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
