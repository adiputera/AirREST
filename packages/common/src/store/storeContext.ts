import { createContext, useContext } from 'react';
import type { UseBoundStore, StoreApi } from 'zustand';
import type { PersistOptions } from 'zustand/middleware';
import type { ApiStoreState } from './useApiStore';
import type { ProductPolicy } from '../productPolicy';

export type ApiStore = UseBoundStore<StoreApi<ApiStoreState>> & {
  /** Present on stores created by createApiStore; legacy injected stores may omit it. */
  readonly productPolicy?: ProductPolicy;
  persist: {
    setOptions: (options: Partial<PersistOptions<ApiStoreState, unknown>>) => void;
    clearStorage: () => void;
    rehydrate: () => Promise<void> | void;
    hasHydrated: () => boolean;
    onHydrate: (fn: (state: ApiStoreState) => void) => () => void;
    onFinishHydration: (fn: (state: ApiStoreState) => void) => () => void;
    getOptions: () => Partial<PersistOptions<ApiStoreState, unknown>>;
  };
  dispose?: () => void;
};

export const StoreContext = createContext<ApiStore | null>(null);

export function useStoreContext(): ApiStore | null {
  return useContext(StoreContext);
}
