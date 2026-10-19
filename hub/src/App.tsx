import React from 'react';
import { useHubStore } from './store/useHubStore';
import { Navbar } from './components/Navbar';
import { Sidebar } from './components/Sidebar';
import { LoginView } from './pages/LoginView';
import { TeamsView } from './pages/TeamsView';
import { ProjectsView } from './pages/ProjectsView';
import { SuperadminView } from './pages/SuperadminView';

export const App: React.FC = () => {
  const token = useHubStore((state) => state.token);
  const activeTab = useHubStore((state) => state.activeTab);

  if (!token) {
    return <LoginView />;
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100 select-none">
      <Navbar />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar />

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
