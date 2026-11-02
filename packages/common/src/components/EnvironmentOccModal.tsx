import React, { useState } from 'react';
import { AlertTriangle, CloudDownload, CloudUpload } from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { useBackHandler } from '../lib/backNavigation';

export const EnvironmentOccModal: React.FC = () => {
  const conflict = useApiStore((state) => state.environmentOccConflict);
  const discard = useApiStore((state) => state.discardEnvironmentOccConflict);
  const overwrite = useApiStore((state) => state.overwriteEnvironmentOccConflict);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // An OCC conflict requires an explicit choice; Back must not discard it.
  useBackHandler(Boolean(conflict), () => {}, 40);

  if (!conflict) return null;
  const run = async (action: () => void | Promise<void>) => {
    setIsSubmitting(true);
    await action();
    setIsSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby="occ-title" className="w-full max-w-4xl rounded-2xl border border-amber-500/30 bg-surface shadow-2xl">
        <div className="border-b border-line p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500 dark:text-amber-400" />
            <div>
              <h2 id="occ-title" className="text-sm font-semibold text-tx-primary">Environment changed on the server</h2>
              <p className="mt-1 text-xs leading-relaxed text-tx-muted">Review both versions before choosing which one to keep. A newer server edit can still reject an overwrite.</p>
            </div>
          </div>
        </div>
        <div className="grid gap-4 p-5 md:grid-cols-2">
          {[
            ['Server version', conflict.remote],
            ['Local draft', conflict.local],
          ].map(([label, environment]) => {
            const env = environment as typeof conflict.remote;
            return <section key={label as string} className="rounded-xl border border-line bg-card/50 p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-tx-primary">{label as string}</h3>
                <span className="font-mono text-[10px] text-tx-muted">v{env.version || 1}</span>
              </div>
              <p className="mt-2 text-sm text-tx-primary">{env.name}</p>
              <pre className="mt-3 max-h-56 overflow-auto rounded-lg border border-line bg-surface p-3 text-[11px] leading-relaxed text-tx-secondary">{JSON.stringify(env.variables.map((item) => ({ key: item.key, value: item.initialValue, enabled: item.enabled })), null, 2)}</pre>
            </section>;
          })}
        </div>
        <div className="flex flex-col gap-2 border-t border-line p-5 sm:flex-row sm:justify-end">
          <button disabled={isSubmitting} onClick={() => run(discard)} className="inline-flex items-center justify-center gap-2 rounded-lg border border-line px-3 py-2 text-xs font-medium text-tx-secondary hover:bg-hover disabled:opacity-50">
            <CloudDownload className="h-3.5 w-3.5" /> Discard Local Changes &amp; Pull Server
          </button>
          <button disabled={isSubmitting} onClick={() => run(overwrite)} className="inline-flex items-center justify-center gap-2 rounded-lg bg-amber-500 px-3 py-2 text-xs font-semibold text-zinc-950 dark:text-zinc-950 hover:bg-amber-400 disabled:opacity-50">
            <CloudUpload className="h-3.5 w-3.5" /> Overwrite Server with Local Draft
          </button>
        </div>
      </div>
    </div>
  );
};
