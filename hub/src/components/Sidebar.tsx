import React from 'react';
import { Users, FolderGit2, UserCog, ChevronRight, Cloud, X } from 'lucide-react';
import { useHubStore, HubTab } from '../store/useHubStore';

export interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen, onClose }) => {
  const activeTab = useHubStore((state) => state.activeTab);
  const setActiveTab = useHubStore((state) => state.setActiveTab);
  const user = useHubStore((state) => state.user);

  const navItems: { id: HubTab; label: string; icon: React.FC<{ className?: string }>; badge?: string }[] = [
    { id: 'teams', label: 'Teams & Organizations', icon: Users },
    { id: 'projects', label: 'Projects', icon: FolderGit2 },
    ...(user?.role === 'superadmin'
      ? [{ id: 'superadmin' as HubTab, label: 'Users', icon: UserCog, badge: 'System' }]
      : []),
  ];

  const handleSelectTab = (tab: HubTab) => {
    setActiveTab(tab);
    onClose?.();
  };

  return (
    <>
      {/* Mobile/Tablet Backdrop overlay */}
      {isOpen && (
        <button
          type="button"
          aria-label="Close navigation overlay"
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm lg:hidden cursor-default"
        />
      )}

      {/* Sidebar container */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col justify-between border-r border-zinc-800 bg-zinc-950 p-4 shadow-2xl transition-transform duration-200 ease-in-out lg:static lg:z-auto lg:w-64 lg:shrink-0 lg:translate-x-0 lg:shadow-none ${
          isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="space-y-6">
          {/* Mobile drawer header with close button */}
          <div className="flex items-center justify-between pb-3 border-b border-zinc-800 lg:hidden">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-tr from-sky-600 to-indigo-600 text-white shadow-md shadow-sky-500/20">
                <Cloud className="h-4 w-4" />
              </div>
              <span className="text-sm font-bold text-zinc-100">AirREST Hub</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close navigation"
              className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

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
                    onClick={() => handleSelectTab(item.id)}
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
    </>
  );
};
