import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { User } from '../types';
import { DEFAULT_API_URL, registerHubTokenRefresh } from '../lib/api';

export type HubTab = 'teams' | 'projects' | 'superadmin';

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

      setApiUrl: (apiUrl) => set({ apiUrl }),
      setAuth: (user, token, refreshToken, tokenExpiresAt) =>
        set({ user, token, refreshToken, tokenExpiresAt }),
      updateTokens: (token, refreshToken, tokenExpiresAt) =>
        set({ token, refreshToken, tokenExpiresAt }),
      logout: () =>
        set({
          user: null,
          token: null,
          refreshToken: null,
          tokenExpiresAt: null,
          selectedTeamId: null,
          selectedProjectId: null,
        }),
      setActiveTab: (activeTab) => set({ activeTab }),
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
        // If VITE_API_URL is configured and user's persisted storage is still pointing to default localhost, update to VITE_API_URL
        if (import.meta.env.VITE_API_URL && persistedState?.apiUrl === 'http://localhost:8080') {
          merged.apiUrl = DEFAULT_API_URL;
        }
        return merged;
      },
    }
  )
);

// Register silent token refresh callback to persist renewed tokens
registerHubTokenRefresh((newTokens) => {
  useHubStore.getState().updateTokens(newTokens.token, newTokens.refreshToken, newTokens.expiresAt);
});
