'use client';

import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, CheckCircle2, Globe, Hash } from 'lucide-react';
import { AutocompleteSuggestionItem } from '../lib/autocomplete';

export interface AutocompleteAnchorRect {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

export interface AutocompletePortalProps {
  isOpen: boolean;
  items: AutocompleteSuggestionItem[];
  activeIndex: number;
  onSelectIndex: (index: number) => void;
  onHighlightIndex: (index: number) => void;
  anchorRect: AutocompleteAnchorRect | null;
  query: string;
  kind: 'header' | 'variable';
  listboxId?: string;
}

function renderHighlightedMatch(text: string, query: string): React.ReactNode {
  const trimmed = query.trim();
  if (!trimmed) return text;

  const lowerText = text.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();
  const matchIdx = lowerText.indexOf(lowerQuery);
  if (matchIdx === -1) return text;

  const before = text.slice(0, matchIdx);
  const match = text.slice(matchIdx, matchIdx + trimmed.length);
  const after = text.slice(matchIdx + trimmed.length);

  return (
    <>
      {before}
      <span className="text-sky-600 dark:text-sky-400 underline decoration-sky-500/50 underline-offset-2 font-bold">
        {match}
      </span>
      {after}
    </>
  );
}

export const AutocompletePortal: React.FC<AutocompletePortalProps> = ({
  isOpen,
  items,
  activeIndex,
  onSelectIndex,
  onHighlightIndex,
  anchorRect,
  query,
  kind,
  listboxId = 'airrest-autocomplete-listbox',
}) => {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const activeEl = listRef.current.querySelector<HTMLElement>(`[data-autocomplete-idx="${activeIndex}"]`);
    if (activeEl && typeof activeEl.scrollIntoView === 'function') {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [isOpen, activeIndex]);

  if (!isOpen || !anchorRect || items.length === 0 || typeof document === 'undefined') {
    return null;
  }

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768;

  const menuMaxWidth = Math.min(420, viewportWidth - 16);
  const menuMinWidth = Math.min(Math.max(anchorRect.width, 280), menuMaxWidth);

  const spaceBelow = viewportHeight - anchorRect.bottom - 12;
  const spaceAbove = anchorRect.top - 12;
  const placement: 'bottom' | 'top' = spaceBelow < 200 && spaceAbove > spaceBelow ? 'top' : 'bottom';

  const maxListHeight = Math.max(120, Math.min(248, (placement === 'bottom' ? spaceBelow : spaceAbove) - 36));
  const left = Math.max(8, Math.min(anchorRect.left, viewportWidth - menuMinWidth - 8));
  const top = placement === 'bottom' ? anchorRect.bottom + 4 : anchorRect.top - 4;

  return createPortal(
    <div
      id={listboxId}
      role="listbox"
      aria-label={kind === 'header' ? 'HTTP Header Suggestions' : 'Environment Variable Suggestions'}
      onMouseDown={(e) => {
        // Prevent focus loss on the underlying input/editor when clicking inside the dropdown
        e.preventDefault();
      }}
      style={{
        position: 'fixed',
        left: `${left}px`,
        top: `${top}px`,
        minWidth: `${menuMinWidth}px`,
        maxWidth: `${menuMaxWidth}px`,
        transform: placement === 'top' ? 'translateY(-100%)' : 'none',
        zIndex: 10000,
      }}
      className="overflow-hidden rounded-xl border border-line-strong bg-card/98 shadow-2xl backdrop-blur-md text-xs select-none animate-in fade-in duration-75"
    >
      {/* Header Bar */}
      <div className="flex items-center justify-between gap-2 border-b border-line bg-element/70 px-2.5 py-1.5 text-[10px] font-medium text-tx-muted">
        <div className="flex items-center gap-1.5">
          {kind === 'header' ? (
            <>
              <Hash className="h-3 w-3 text-sky-500 dark:text-sky-400 shrink-0" />
              <span>Common HTTP Headers</span>
            </>
          ) : (
            <>
              <Globe className="h-3 w-3 text-amber-500 dark:text-amber-400 shrink-0" />
              <span>Variables ({items.length})</span>
            </>
          )}
        </div>
        <div className="hidden sm:flex items-center gap-1 font-mono text-[9.5px] text-tx-faint">
          <kbd className="rounded border border-line bg-card px-1 py-0.2 text-tx-secondary">↑↓</kbd>
          <span>navigate</span>
          <kbd className="rounded border border-line bg-card px-1 py-0.2 text-tx-secondary ml-1">Enter</kbd>
          <span>select</span>
          <kbd className="rounded border border-line bg-card px-1 py-0.2 text-tx-secondary ml-1">Esc</kbd>
        </div>
      </div>

      {/* Scrollable Items */}
      <div
        ref={listRef}
        style={{ maxHeight: `${maxListHeight}px` }}
        className="overflow-y-auto divide-y divide-line/40 p-1"
      >
        {items.map((item, idx) => {
          const isSelected = idx === activeIndex;

          if (item.kind === 'header') {
            return (
              <div
                key={item.key}
                id={`${listboxId}-item-${idx}`}
                role="option"
                aria-selected={isSelected}
                data-autocomplete-idx={idx}
                onMouseEnter={() => onHighlightIndex(idx)}
                onClick={() => onSelectIndex(idx)}
                className={`flex flex-col gap-0.5 rounded-lg px-2.5 py-1.5 cursor-pointer transition ${
                  isSelected
                    ? 'bg-sky-500/15 text-tx-primary ring-1 ring-sky-500/30'
                    : 'hover:bg-hover text-tx-secondary'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-tx-primary truncate">
                    {renderHighlightedMatch(item.label, query)}
                  </span>
                  <span className="rounded border border-line bg-element px-1.5 py-0.2 text-[9.5px] font-medium text-tx-muted shrink-0">
                    {item.category}
                  </span>
                </div>
                <span className="text-[10.5px] text-tx-muted truncate">
                  {item.description}
                </span>
              </div>
            );
          }

          // Variable Suggestion Item
          return (
            <div
              key={item.key}
              id={`${listboxId}-item-${idx}`}
              role="option"
              aria-selected={isSelected}
              data-autocomplete-idx={idx}
              onMouseEnter={() => onHighlightIndex(idx)}
              onClick={() => onSelectIndex(idx)}
              className={`flex items-center justify-between gap-2.5 rounded-lg px-2.5 py-1.5 cursor-pointer transition ${
                isSelected
                  ? 'bg-amber-500/15 text-tx-primary ring-1 ring-amber-500/30'
                  : 'hover:bg-hover text-tx-secondary'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <div
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                    item.isBuiltin
                      ? 'bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/25'
                      : item.isActiveEnv
                        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/25'
                        : 'bg-element text-tx-muted border-line'
                  }`}
                >
                  {item.isBuiltin ? (
                    <Sparkles className="h-3 w-3" />
                  ) : (
                    <CheckCircle2 className="h-3 w-3" />
                  )}
                </div>

                <div className="flex flex-col min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs font-semibold text-tx-primary truncate">
                      {'{{'}
                      {renderHighlightedMatch(item.varName, query)}
                      {'}}'}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.2 text-[9.5px] font-medium shrink-0 border ${
                        item.isBuiltin
                          ? 'bg-violet-500/10 text-violet-600 dark:text-violet-300 border-violet-500/20'
                          : item.isActiveEnv
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                            : 'bg-element text-tx-muted border-line'
                      }`}
                    >
                      {item.scope}
                    </span>
                  </div>
                  <span className="font-mono text-[10.5px] text-tx-muted truncate">
                    {item.resolvedValue || '(empty string)'}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>,
    document.body
  );
};
