import React from 'react';
import { Send, Plus, FolderOpen, History, Layers } from 'lucide-react';
import { useApiStore } from '../store/useApiStore';

interface EmptyStudioViewProps {
  onCreateTab: () => void;
}

export const EmptyStudioView: React.FC<EmptyStudioViewProps> = ({ onCreateTab }) => {
  const setSidebarTab = useApiStore((state) => state.setSidebarTab);
  const collections = useApiStore((state) => state.collections);
  const history = useApiStore((state) => state.history);

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 bg-app text-tx-primary select-none">
      <div className="flex max-w-md flex-col items-center text-center">
        {/* Glow badge icon */}
        <div className="relative mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-sky-500/25 bg-gradient-to-b from-sky-500/15 to-transparent shadow-xl shadow-sky-500/5">
          <Send className="h-7 w-7 text-sky-500 dark:text-sky-400" />
          <div className="absolute -inset-1 rounded-2xl bg-sky-500/10 blur-sm -z-10" />
        </div>

        {/* Heading & Subtitle */}
        <h2 className="text-lg font-semibold tracking-tight text-tx-primary">
          No Requests Open
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-tx-muted">
          Select an existing request from the sidebar collections or history, or create a new request tab to start testing your APIs.
        </p>

        {/* Action Buttons */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={onCreateTab}
            className="flex items-center gap-2 rounded-xl bg-sky-500 px-4 py-2 text-xs font-semibold text-white dark:text-zinc-950 shadow-md shadow-sky-500/20 hover:bg-sky-400 active:scale-[0.98] transition-all cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            <span>New Request</span>
          </button>

          {collections.length > 0 && (
            <button
              type="button"
              onClick={() => setSidebarTab('collections')}
              className="flex items-center gap-2 rounded-xl border border-line bg-card/80 px-3.5 py-2 text-xs font-medium text-tx-secondary hover:bg-hover hover:border-line-strong hover:text-tx-primary transition-all cursor-pointer"
            >
              <FolderOpen className="h-3.5 w-3.5 text-tx-muted" />
              <span>Browse Collections ({collections.length})</span>
            </button>
          )}

          {history.length > 0 && (
            <button
              type="button"
              onClick={() => setSidebarTab('history')}
              className="flex items-center gap-2 rounded-xl border border-line bg-card/80 px-3.5 py-2 text-xs font-medium text-tx-secondary hover:bg-hover hover:border-line-strong hover:text-tx-primary transition-all cursor-pointer"
            >
              <History className="h-3.5 w-3.5 text-tx-muted" />
              <span>View History ({history.length})</span>
            </button>
          )}
        </div>

        {/* Quick Tips */}
        <div className="mt-8 flex items-center gap-2 text-[11px] text-tx-faint font-mono">
          <Layers className="h-3 w-3" />
          <span>Tip: Click any endpoint in the sidebar tree to open it in a tab</span>
        </div>
      </div>
    </div>
  );
};

