import React from 'react';
import { Users, FolderGit2, ShieldAlert, ChevronRight } from 'lucide-react';
import { useHubStore, HubTab } from '../store/useHubStore';

export const Sidebar: React.FC = () => {
  const activeTab = useHubStore((state) => state.activeTab);
  const setActiveTab = useHubStore((state) => state.setActiveTab);
  const user = useHubStore((state) => state.user);

  const navItems: { id: HubTab; label: string; icon: React.FC<{ className?: string }>; badge?: string }[] = [
    { id: 'teams', label: 'Teams & Organizations', icon: Users },
    { id: 'projects', label: 'Projects & RBAC', icon: FolderGit2 },
    ...(user?.role === 'superadmin'
      ? [{ id: 'superadmin' as HubTab, label: 'Superadmin Console', icon: ShieldAlert, badge: 'System' }]
      : []),
  ];

  return (
    <aside className="w-64 shrink-0 border-r border-zinc-800 bg-zinc-950 flex flex-col justify-between p-4">
      <div className="space-y-6">
        <div>
          <div className="px-3 text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-2">
            Workspace Hub
          </div>
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center justify-between rounded-xl px-3 py-2.5 text-xs font-semibold transition ${
                    isActive
                      ? 'bg-gradient-to-r from-sky-600/20 to-indigo-600/20 text-white border border-sky-500/30 shadow-sm'
                      : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className={`h-4 w-4 ${isActive ? 'text-sky-400' : 'text-zinc-400'}`} />
                    <span>{item.label}</span>
                  </div>

                  {item.badge ? (
                    <span className="rounded bg-amber-500/10 px-1.5 py-0.2 text-[9px] font-bold text-amber-400 border border-amber-500/20">
                      {item.badge}
                    </span>
                  ) : isActive ? (
                    <ChevronRight className="h-3.5 w-3.5 text-sky-400" />
                  ) : null}
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      {/* Footer Info */}
      <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3 text-center">
        <div className="text-[11px] font-semibold text-zinc-300">AirREST Hub Cloud</div>
        <div className="text-[10px] text-zinc-400 mt-0.5">Stateless Go &amp; PostgreSQL</div>
      </div>
    </aside>
  );
};
