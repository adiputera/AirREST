import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { User } from '../types';
import { DEFAULT_API_URL, registerHubTokenRefresh, registerHubAuthEvicted, invalidateHubSession } from '../lib/api';

export type HubTab = 'teams' | 'projects' | 'superadmin';

const signedOutState = {
  user: null,
  token: null,
  refreshToken: null,
  tokenExpiresAt: null,
  activeTab: 'teams' as HubTab,
  selectedTeamId: null,
  selectedProjectId: null,
};

interface HubStoreState {
  apiUrl: string;
  token: string | null;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  user: User | null;

  activeTab: HubTab;
  selectedTeamId: string | null;
  selectedProjectId: string | null;

  setApiUrl: (url: string) => void;
  setAuth: (user: User, token: string, refreshToken: string, expiresAt: string) => void;
  updateUser: (user: User) => void;
  updateTokens: (token: string, refreshToken: string, expiresAt: string) => void;
  logout: () => void;
  setActiveTab: (tab: HubTab) => void;
  setSelectedTeamId: (teamId: string | null) => void;
  setSelectedProjectId: (projectId: string | null) => void;
}

export const useHubStore = create<HubStoreState>()(
  persist(
    (set) => ({
      apiUrl: DEFAULT_API_URL,
      token: null,
      refreshToken: null,
      tokenExpiresAt: null,
      user: null,

      activeTab: 'teams',
      selectedTeamId: null,
      selectedProjectId: null,

      setApiUrl: (url) => set((state) => {
        const apiUrl = url.trim().replace(/\/+$/, '') || DEFAULT_API_URL;
        if (apiUrl === state.apiUrl) return state;
        invalidateHubSession();
        return { ...signedOutState, apiUrl };
      }),
      setAuth: (user, token, refreshToken, tokenExpiresAt) => {
        invalidateHubSession();
        set({ ...signedOutState, user, token, refreshToken, tokenExpiresAt });
      },
      updateUser: (user) => set((state) => ({
        user,
        activeTab: state.activeTab === 'superadmin' && user.role !== 'superadmin' ? 'teams' : state.activeTab,
      })),
      updateTokens: (token, refreshToken, tokenExpiresAt) =>
        set({ token, refreshToken, tokenExpiresAt }),
      logout: () => {
        invalidateHubSession();
        set(signedOutState);
      },
      setActiveTab: (activeTab) => set((state) => ({
        activeTab: activeTab === 'superadmin' && state.user?.role !== 'superadmin' ? 'teams' : activeTab,
      })),
      setSelectedTeamId: (selectedTeamId) => set({ selectedTeamId, selectedProjectId: null }),
      setSelectedProjectId: (selectedProjectId) => set({ selectedProjectId }),
    }),
    {
      name: 'airrest-hub-storage-v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        apiUrl: state.apiUrl,
        token: state.token,
        refreshToken: state.refreshToken,
        tokenExpiresAt: state.tokenExpiresAt,
        user: state.user,
        selectedTeamId: state.selectedTeamId,
        selectedProjectId: state.selectedProjectId,
      }),
      merge: (persistedState: any, currentState) => {
        const merged = { ...currentState, ...(persistedState as object) };
        // If VITE_API_URL is configured and different from persisted apiUrl, or persisted apiUrl points to vercel while in local dev
        const isPersistedVercel = typeof persistedState?.apiUrl === 'string' && persistedState.apiUrl.includes('vercel.app');
        if (
          (import.meta.env.VITE_API_URL && persistedState?.apiUrl === 'http://localhost:8080' && DEFAULT_API_URL !== persistedState.apiUrl) ||
          (DEFAULT_API_URL === 'http://localhost:8080' && isPersistedVercel)
        ) {
          invalidateHubSession();
          return { ...merged, ...signedOutState, apiUrl: DEFAULT_API_URL };
        }
        return merged;
      },
    }
  )
);

// Register silent token refresh callback to persist renewed tokens
registerHubTokenRefresh((newTokens) => {
  if (useHubStore.getState().refreshToken !== newTokens.previousRefreshToken) return;
  useHubStore.getState().updateTokens(newTokens.token, newTokens.refreshToken, newTokens.expiresAt);
});

// Register auth eviction callback to automatically log out if account is deleted/deactivated
registerHubAuthEvicted((evictedSession) => {
  const current = useHubStore.getState();
  if (evictedSession) {
    if (evictedSession.refreshToken && current.refreshToken && evictedSession.refreshToken !== current.refreshToken) {
      return;
    }
    if (evictedSession.token && current.token && evictedSession.token !== current.token) {
      return;
    }
  }
  useHubStore.getState().logout();
});
