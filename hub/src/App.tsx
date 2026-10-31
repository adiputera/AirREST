import React, { useEffect, useState } from 'react';
import { useHubStore } from './store/useHubStore';
import { apiGetMe } from './lib/api';
import { Navbar } from './components/Navbar';
import { Sidebar } from './components/Sidebar';
import { LoginView } from './pages/LoginView';
import { TeamsView } from './pages/TeamsView';
import { ProjectsView } from './pages/ProjectsView';
import { SuperadminView } from './pages/SuperadminView';

export const App: React.FC = () => {
  const token = useHubStore((state) => state.token);
  const refreshToken = useHubStore((state) => state.refreshToken);
  const apiUrl = useHubStore((state) => state.apiUrl);
  const updateUser = useHubStore((state) => state.updateUser);
  const selectedTab = useHubStore((state) => state.activeTab);
  const role = useHubStore((state) => state.user?.role);
  const activeTab = selectedTab === 'superadmin' && role !== 'superadmin' ? 'teams' : selectedTab;

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  useEffect(() => {
    if (!isSidebarOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSidebarOpen]);

  useEffect(() => {
    setIsSidebarOpen(false);
  }, [activeTab]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    apiGetMe(apiUrl, token, refreshToken || undefined)
      .then((freshUser) => {
        if (!cancelled && freshUser) {
          updateUser(freshUser);
        }
      })
      .catch(() => {
        // Handled silently or evicted by fetchWithAuth if 401
      });
    return () => {
      cancelled = true;
    };
  }, [token, apiUrl]);

  if (!token) {
    return <LoginView />;
  }

  return (
    <div className="flex h-[100dvh] w-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100 select-none">
      <Navbar onOpenSidebar={() => setIsSidebarOpen((prev) => !prev)} />

      <div className="relative flex flex-1 overflow-hidden">
        <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />

        <main className="flex flex-1 flex-col overflow-hidden bg-zinc-950">
          {activeTab === 'teams' && <TeamsView />}
          {activeTab === 'projects' && <ProjectsView />}
          {activeTab === 'superadmin' && <SuperadminView />}
        </main>
      </div>
    </div>
  );
};

export default App;
