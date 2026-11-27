import React, { useState } from 'react';
import { AlertTriangle, Check, Link2 } from 'lucide-react';
import type { Collection } from '../../types/api';

interface SessionOnlyReportBannerProps {
  reason?: string;
  availableCollections: Collection[];
  onAttachToCollection?: (collection: Collection) => void;
}

export const SessionOnlyReportBanner: React.FC<SessionOnlyReportBannerProps> = ({
  reason,
  availableCollections,
  onAttachToCollection,
}) => {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>(
    () => availableCollections[0]?.id || ''
  );

  const handleConfirmAttach = () => {
    if (!onAttachToCollection) return;
    const chosen =
      availableCollections.find((c) => c.id === selectedCollectionId) || availableCollections[0];
    if (!chosen) return;
    setPickerOpen(false);
    onAttachToCollection(chosen);
  };

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-200 shrink-0">
      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <div className="flex items-start gap-2.5 min-w-0 flex-1">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400" />
          <div className="min-w-0">
            <div className="font-semibold">
              Temporary Session-Only Report — Read-Only
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-amber-800/90 dark:text-amber-200/90">
              {reason ? `${reason} ` : ''}
              This imported report is not saved to workspace history and will disappear when you close
              this tab, switch workspaces, or sign out.
            </p>
          </div>
        </div>

        {onAttachToCollection && availableCollections.length > 0 && (
          <div className="shrink-0">
            {!pickerOpen ? (
              <button
                type="button"
                onClick={() => {
                  setSelectedCollectionId(availableCollections[0]?.id || '');
                  setPickerOpen(true);
                }}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-amber-500/45 bg-surface px-2.5 text-[11px] font-semibold text-amber-700 dark:text-amber-200 hover:bg-amber-500/15 transition"
              >
                <Link2 className="h-3.5 w-3.5" />
                <span>Attach to Collection...</span>
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                <select
                  value={selectedCollectionId || availableCollections[0]?.id || ''}
                  onChange={(e) => setSelectedCollectionId(e.target.value)}
                  className="h-7 max-w-[200px] rounded-lg border border-amber-500/45 bg-surface px-2 text-[11px] text-tx-primary focus:outline-none focus:ring-1 focus:ring-amber-500"
                  aria-label="Choose target collection"
                >
                  {availableCollections.map((col) => (
                    <option key={col.id} value={col.id}>
                      {col.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleConfirmAttach}
                  className="inline-flex h-7 items-center gap-1 rounded-lg bg-amber-600 px-2.5 text-[11px] font-semibold text-white hover:bg-amber-500 transition"
                >
                  <Check className="h-3 w-3" />
                  <span>Attach &amp; Save</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPickerOpen(false)}
                  className="h-7 rounded-lg px-2 text-[11px] font-medium text-tx-muted hover:bg-hover hover:text-tx-primary transition"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
