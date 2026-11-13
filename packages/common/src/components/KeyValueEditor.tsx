'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, Lock, AlertTriangle } from 'lucide-react';
import { KeyValuePair } from '../types/api';
import { VariableInput } from './VariableInput';

export interface ReadonlyKeyValueRow {
  id: string;
  key: string;
  value: string;
  valueType?: 'text' | 'password';
  badgeText?: string;
  actionLabel?: string;
  actionTitle?: string;
  onActionClick?: () => void;
  isOverridden?: boolean;
  overriddenTitle?: string;
}

export interface KeyValueEditorProps {
  items: KeyValuePair[];
  onUpdate: (id: string, updates: Partial<KeyValuePair>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  readonlyRows?: ReadonlyKeyValueRow[];
  rowWarnings?: Record<string, string>;
}

interface ActiveWarningTooltip {
  id: string;
  message: string;
  x: number;
  y: number;
  placement: 'top' | 'bottom';
}

export const KeyValueEditor: React.FC<KeyValueEditorProps> = ({
  items,
  onUpdate,
  onAdd,
  onRemove,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  readonlyRows = [],
  rowWarnings,
}) => {
  const [activeWarning, setActiveWarning] = useState<ActiveWarningTooltip | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stickyOpenIdRef = useRef<string | null>(null);
  const pointerGestureRef = useRef<{ id: string; wasOpen: boolean } | null>(null);
  const activeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const openWarningTooltip = useCallback(
    (id: string, message: string, anchorEl: HTMLButtonElement, options?: { sticky?: boolean }) => {
      cancelScheduledClose();
      activeTriggerRef.current = anchorEl;
      if (options?.sticky) {
        stickyOpenIdRef.current = id;
      }
      const rect = anchorEl.getBoundingClientRect();
      const placement: 'top' | 'bottom' = rect.top < 110 ? 'bottom' : 'top';
      const y = placement === 'top' ? rect.top - 8 : rect.bottom + 8;
      const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 800;
      const x = Math.max(12, Math.min(rect.left, viewportWidth - 312));
      setActiveWarning({ id, message, x, y, placement });
    },
    [cancelScheduledClose]
  );

  const scheduleCloseWarningTooltip = useCallback(
    (id: string) => {
      cancelScheduledClose();
      closeTimerRef.current = setTimeout(() => {
        if (stickyOpenIdRef.current === id) return;
        setActiveWarning((prev) => (prev?.id === id ? null : prev));
      }, 120);
    },
    [cancelScheduledClose]
  );

  const closeWarningTooltip = useCallback(
    (id?: string) => {
      cancelScheduledClose();
      if (!id || stickyOpenIdRef.current === id) {
        stickyOpenIdRef.current = null;
      }
      setActiveWarning((prev) => {
        if (!prev) return null;
        if (id && prev.id !== id) return prev;
        return null;
      });
    },
    [cancelScheduledClose]
  );

  useEffect(() => {
    return () => cancelScheduledClose();
  }, [cancelScheduledClose]);

  useEffect(() => {
    if (!activeWarning) return;
    const currentMessage = rowWarnings?.[activeWarning.id];
    if (!currentMessage) {
      if (stickyOpenIdRef.current === activeWarning.id) {
        stickyOpenIdRef.current = null;
      }
      setActiveWarning(null);
    } else if (currentMessage !== activeWarning.message) {
      setActiveWarning((prev) => (prev ? { ...prev, message: currentMessage } : null));
    }
  }, [activeWarning, rowWarnings]);

  useEffect(() => {
    if (!activeWarning) return;
    const handleDismiss = () => {
      stickyOpenIdRef.current = null;
      setActiveWarning(null);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleDismiss();
      }
    };
    const handleOutsidePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (activeTriggerRef.current?.contains(target) || tooltipRef.current?.contains(target)) {
        return;
      }
      handleDismiss();
    };
    window.addEventListener('scroll', handleDismiss, true);
    window.addEventListener('resize', handleDismiss);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('pointerdown', handleOutsidePointerDown, true);
    return () => {
      window.removeEventListener('scroll', handleDismiss, true);
      window.removeEventListener('resize', handleDismiss);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('pointerdown', handleOutsidePointerDown, true);
    };
  }, [activeWarning]);

  const safeReadonlyRows = Array.isArray(readonlyRows) ? readonlyRows.filter(Boolean) : [];
  const safeItems = (Array.isArray(items) ? items : []).filter(Boolean);

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-xl border border-line bg-card">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-line bg-element text-tx-muted">
            <tr>
              <th className="w-10 px-3 py-2 text-center">Use</th>
              <th className="px-3 py-2 font-medium">Key</th>
              <th className="px-3 py-2 font-medium">Value</th>
              <th className="w-10 px-3 py-2 text-center"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {safeReadonlyRows.map((row) => {
              const isOverridden = Boolean(row.isOverridden);
              return (
                <tr
                  key={row.id}
                  data-readonly-row="true"
                  data-overridden={isOverridden ? 'true' : undefined}
                  title={isOverridden ? row.overriddenTitle : undefined}
                  className={isOverridden ? 'bg-element/20 opacity-60' : 'bg-element/35'}
                >
                  <td className="px-3 py-1.5 text-center">
                    <span
                      className={
                        isOverridden
                          ? 'inline-flex items-center justify-center text-tx-muted'
                          : 'inline-flex items-center justify-center text-sky-500 dark:text-sky-400'
                      }
                      title={row.overriddenTitle || row.badgeText || 'Read-only'}
                      aria-label={
                        isOverridden
                          ? `${row.badgeText || 'Read-only'} overridden`
                          : row.badgeText
                            ? `${row.badgeText} active`
                            : 'Read-only active'
                      }
                    >
                      <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className={isOverridden ? 'line-through decoration-tx-muted/70' : undefined}>
                      <VariableInput
                        value={row.key}
                        onChange={() => {}}
                        readOnly
                        size="sm"
                      />
                    </div>
                  </td>
                  <td colSpan={2} className="px-2 py-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <div
                        className={`min-w-0 flex-1 ${isOverridden ? 'line-through decoration-tx-muted/70' : ''}`}
                      >
                        <VariableInput
                          key={`${row.id}-${row.valueType || 'text'}`}
                          value={row.value}
                          onChange={() => {}}
                          type={row.valueType || 'text'}
                          maskResetKey={`${row.id}-${row.valueType || 'text'}`}
                          readOnly
                          size="sm"
                        />
                      </div>
                      {row.badgeText && (
                        <span
                          className={
                            isOverridden
                              ? 'inline-flex items-center rounded-md border border-line bg-element px-1.5 py-0.5 text-[10px] font-medium text-tx-muted shrink-0 whitespace-nowrap'
                              : 'inline-flex items-center rounded-md border border-sky-500/25 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400 shrink-0 whitespace-nowrap'
                          }
                        >
                          {row.badgeText}
                        </span>
                      )}
                      {row.actionLabel && row.onActionClick && (
                        <button
                          type="button"
                          onClick={row.onActionClick}
                          title={row.actionTitle || row.actionLabel}
                          className="inline-flex items-center rounded-md border border-line bg-element px-1.5 py-0.5 text-[10px] font-medium text-tx-secondary hover:bg-hover hover:text-sky-600 dark:hover:text-sky-400 transition shrink-0 whitespace-nowrap cursor-pointer"
                        >
                          {row.actionLabel}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}

            {safeItems.map((item, index) => {
              const warningMessage = rowWarnings?.[item.id];
              const isTooltipOpen = activeWarning?.id === item.id;
              const tooltipId = `kv-warning-tooltip-${item.id}`;
              const srDescId = `kv-warning-desc-${item.id}`;

              return (
                <tr key={item.id || index} className="group hover:bg-hover transition">
                  <td className="px-3 py-1.5 text-center">
                    <input
                      type="checkbox"
                      checked={item.enabled ?? true}
                      onChange={(e) => onUpdate(item.id, { enabled: e.target.checked })}
                      className="h-3.5 w-3.5 rounded border-line-strong bg-element text-sky-500 focus:ring-0 focus:ring-offset-0 cursor-pointer accent-sky-500"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1 min-w-0">
                      <div className="min-w-0 flex-1">
                        <VariableInput
                          value={item.key || ''}
                          onChange={(key) => onUpdate(item.id, { key })}
                          placeholder={keyPlaceholder}
                          size="sm"
                          ariaDescribedBy={warningMessage ? (isTooltipOpen ? tooltipId : srDescId) : undefined}
                        />
                      </div>
                      {warningMessage && (
                        <>
                          <span id={srDescId} className="sr-only">
                            {warningMessage}
                          </span>
                          <button
                            type="button"
                            data-duplicate-warning-trigger="true"
                            aria-label="Duplicate header warning"
                            aria-expanded={isTooltipOpen}
                            aria-describedby={isTooltipOpen ? tooltipId : srDescId}
                            onPointerDown={() => {
                              pointerGestureRef.current = { id: item.id, wasOpen: isTooltipOpen };
                            }}
                            onMouseEnter={(e) => {
                              if (pointerGestureRef.current?.id === item.id) return;
                              openWarningTooltip(item.id, warningMessage, e.currentTarget);
                            }}
                            onMouseLeave={() => {
                              if (pointerGestureRef.current?.id === item.id) return;
                              scheduleCloseWarningTooltip(item.id);
                            }}
                            onFocus={(e) => openWarningTooltip(item.id, warningMessage, e.currentTarget, { sticky: true })}
                            onBlur={() => closeWarningTooltip(item.id)}
                            onClick={(e) => {
                              const gesture = pointerGestureRef.current;
                              pointerGestureRef.current = null;
                              if (gesture && gesture.id === item.id) {
                                if (gesture.wasOpen) {
                                  closeWarningTooltip(item.id);
                                } else {
                                  openWarningTooltip(item.id, warningMessage, e.currentTarget, { sticky: true });
                                }
                                return;
                              }
                              if (isTooltipOpen) {
                                closeWarningTooltip(item.id);
                              } else {
                                openWarningTooltip(item.id, warningMessage, e.currentTarget, { sticky: true });
                              }
                            }}
                            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-amber-500 hover:bg-amber-500/15 hover:text-amber-400 focus-visible:outline-2 focus-visible:outline-amber-500 transition cursor-help"
                          >
                            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <VariableInput
                      value={item.value || ''}
                      onChange={(value) => onUpdate(item.id, { value })}
                      placeholder={valuePlaceholder}
                      size="sm"
                    />
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <button
                      type="button"
                      onClick={() => onRemove(item.id)}
                      className="rounded p-1 text-tx-faint opacity-60 hover:bg-hover hover:text-rose-500 group-hover:opacity-100 transition"
                      title="Delete row"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {activeWarning &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={tooltipRef}
            id={`kv-warning-tooltip-${activeWarning.id}`}
            role="tooltip"
            onMouseEnter={cancelScheduledClose}
            onMouseLeave={() => scheduleCloseWarningTooltip(activeWarning.id)}
            style={{
              position: 'fixed',
              left: `${activeWarning.x}px`,
              top: `${activeWarning.y}px`,
              transform: activeWarning.placement === 'top' ? 'translateY(-100%)' : 'none',
              zIndex: 9999,
            }}
            className="pointer-events-auto max-w-xs rounded-xl border border-amber-500/40 bg-card/95 px-3 py-2 shadow-2xl backdrop-blur-md text-xs text-tx-primary"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" aria-hidden="true" />
              <span className="leading-relaxed text-amber-700 dark:text-amber-300 font-medium">
                {activeWarning.message}
              </span>
            </div>
          </div>,
          document.body
        )}

      <button
        type="button"
        onClick={onAdd}
        className="flex items-center gap-1.5 rounded-lg border border-line bg-element px-3 py-1.5 text-xs font-medium text-tx-muted hover:bg-hover hover:text-tx-primary transition"
      >
        <Plus className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
        <span>Add Row</span>
      </button>
    </div>
  );
};
