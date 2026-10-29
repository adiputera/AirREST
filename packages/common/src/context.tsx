import React, { createContext, useContext } from 'react';
import { AirrestRuntime } from './runtime';
import { StoreContext } from './store/storeContext';

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
