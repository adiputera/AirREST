'use client';

import React, { useState, useRef, useMemo, useEffect, useCallback, useId } from 'react';
import { useApiStore } from '../store/useApiStore';
import {
  AutocompleteContext,
  AutocompleteSuggestionItem,
  detectInputAutocompleteContext,
  getVariableSuggestions,
  applyAutocompleteSuggestion,
} from '../lib/autocomplete';
import { AutocompletePortal, AutocompleteAnchorRect } from './AutocompletePortal';

export interface VariableTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  value: string;
  onValueChange: (value: string) => void;
  enableVariableAutocomplete?: boolean;
}

export const VariableTextarea: React.FC<VariableTextareaProps> = ({
  value,
  onValueChange,
  enableVariableAutocomplete = true,
  onChange,
  onKeyDown,
  onKeyUp,
  onClick,
  onBlur,
  onSelect,
  readOnly,
  disabled,
  ...rest
}) => {
  const environments = useApiStore((state) => state.environments);
  const activeEnvironmentId = useApiStore((state) => state.activeEnvironmentId);
  const generatedId = useId();
  const listboxId = `var-textarea-ac-${generatedId}`;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [acContext, setAcContext] = useState<AutocompleteContext | null>(null);
  const [acActiveIndex, setAcActiveIndex] = useState(0);
  const [acAnchorRect, setAcAnchorRect] = useState<AutocompleteAnchorRect | null>(null);

  const safeValue = typeof value === 'string' ? value : '';
  const lastInternalValueRef = useRef(safeValue);
  const acHasNavigatedRef = useRef(false);

  useEffect(() => {
    if (safeValue !== lastInternalValueRef.current) {
      lastInternalValueRef.current = safeValue;
      setAcContext(null);
    }
  }, [safeValue]);

  useEffect(() => {
    if (!enableVariableAutocomplete || readOnly || disabled) {
      setAcContext(null);
    }
  }, [enableVariableAutocomplete, readOnly, disabled]);

  const isAnchorRectVisible = useCallback((rect: { left: number; right: number; top: number; bottom: number }) => {
    if (typeof window === 'undefined' || typeof window.innerHeight !== 'number' || typeof window.innerWidth !== 'number') {
      return true;
    }
    return !(rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth);
  }, []);

  const measureAnchorRect = useCallback((): AutocompleteAnchorRect | null => {
    const el = textareaRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    // Estimate current line vertical offset inside textarea
    const cursor = el.selectionStart ?? 0;
    const textBefore = el.value.slice(0, cursor);
    const linesBefore = textBefore.split('\n');
    const lineIdx = Math.max(0, linesBefore.length - 1);
    const colIdx = linesBefore[linesBefore.length - 1]?.length ?? 0;

    const lineHeight = 19; // approximate text-xs leading-relaxed line height
    const paddingTop = 12;
    const paddingLeft = 12;
    const charWidth = 7.2;

    const rawTop = rect.top + paddingTop + lineIdx * lineHeight - el.scrollTop;
    const clampedTop = Math.max(rect.top + 4, Math.min(rawTop, rect.bottom - 20));
    const rawLeft = rect.left + paddingLeft + Math.min(colIdx * charWidth, rect.width - 120) - el.scrollLeft;
    const clampedLeft = Math.max(rect.left + 8, Math.min(rawLeft, rect.right - 80));

    return {
      left: clampedLeft,
      top: clampedTop,
      bottom: clampedTop + lineHeight + 2,
      width: Math.min(320, Math.max(240, rect.width * 0.6)),
    };
  }, []);

  const updateAutocomplete = useCallback(
    (nextText: string, cursorPos: number | null, selectionEnd?: number | null) => {
      if (!enableVariableAutocomplete || readOnly || disabled) {
        setAcContext(null);
        return;
      }
      if (selectionEnd !== undefined && selectionEnd !== null && cursorPos !== null && selectionEnd !== cursorPos) {
        setAcContext(null);
        return;
      }
      const pos = cursorPos ?? nextText.length;
      const detected = detectInputAutocompleteContext(nextText, pos, 'variable-only');
      if (!detected) {
        setAcContext(null);
        return;
      }
      const el = textareaRef.current;
      if (el && !isAnchorRectVisible(el.getBoundingClientRect())) {
        setAcContext(null);
        return;
      }
      setAcContext((prev) => {
        if (!prev || prev.query !== detected.query) {
          setAcActiveIndex(0);
          acHasNavigatedRef.current = false;
        }
        return detected;
      });
      setAcAnchorRect(measureAnchorRect());
    },
    [enableVariableAutocomplete, readOnly, disabled, measureAnchorRect, isAnchorRectVisible]
  );

  const acSuggestions: AutocompleteSuggestionItem[] = useMemo(() => {
    if (!acContext) return [];
    return getVariableSuggestions(acContext.query, environments, activeEnvironmentId);
  }, [acContext, environments, activeEnvironmentId]);

  const isAutocompleteOpen = Boolean(
    enableVariableAutocomplete && acContext && acSuggestions.length > 0 && !readOnly && !disabled
  );

  useEffect(() => {
    if (acActiveIndex >= acSuggestions.length && acSuggestions.length > 0) {
      setAcActiveIndex(0);
    }
  }, [acActiveIndex, acSuggestions.length]);

  const handleSelectSuggestion = useCallback(
    (index: number) => {
      if (!acContext || index < 0 || index >= acSuggestions.length) return;
      const chosen = acSuggestions[index];
      const { nextText, nextCursorPos } = applyAutocompleteSuggestion(safeValue, acContext, chosen);
      lastInternalValueRef.current = nextText;
      setAcContext(null);
      onValueChange(nextText);

      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) {
            el.focus();
            try {
              el.setSelectionRange(nextCursorPos, nextCursorPos);
            } catch {
              // ignore
            }
          }
        });
      }
    },
    [acContext, acSuggestions, safeValue, onValueChange]
  );

  useEffect(() => {
    if (!isAutocompleteOpen) return;
    const handleScrollOrResize = (e: Event) => {
      const target = e.target as Node | null;
      const listboxEl = typeof document !== 'undefined' ? document.getElementById(listboxId) : null;
      if (target && listboxEl?.contains(target)) {
        return;
      }
      const el = textareaRef.current;
      if (el && !isAnchorRectVisible(el.getBoundingClientRect())) {
        setAcContext(null);
        return;
      }
      setAcAnchorRect(measureAnchorRect());
    };
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    return () => {
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [isAutocompleteOpen, listboxId, measureAnchorRect, isAnchorRectVisible]);

  return (
    <>
      <textarea
        ref={textareaRef}
        value={safeValue}
        readOnly={readOnly}
        disabled={disabled}
        role={!readOnly && enableVariableAutocomplete ? 'combobox' : undefined}
        aria-autocomplete={!readOnly && enableVariableAutocomplete ? 'list' : undefined}
        aria-expanded={!readOnly && enableVariableAutocomplete ? isAutocompleteOpen : undefined}
        aria-controls={isAutocompleteOpen ? listboxId : undefined}
        aria-activedescendant={
          isAutocompleteOpen ? `${listboxId}-item-${acActiveIndex}` : undefined
        }
        onChange={(e) => {
          onChange?.(e);
          if (!e.defaultPrevented && !readOnly) {
            lastInternalValueRef.current = e.target.value;
            onValueChange(e.target.value);
            updateAutocomplete(e.target.value, e.target.selectionStart, e.target.selectionEnd);
          }
        }}
        onKeyUp={(e) => {
          onKeyUp?.(e);
          if (
            e.key === 'ArrowLeft' ||
            e.key === 'ArrowRight' ||
            e.key === 'ArrowUp' ||
            e.key === 'ArrowDown' ||
            e.key === 'PageUp' ||
            e.key === 'PageDown' ||
            e.key === 'Home' ||
            e.key === 'End'
          ) {
            if (!isAutocompleteOpen || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) {
              updateAutocomplete(e.currentTarget.value, e.currentTarget.selectionStart, e.currentTarget.selectionEnd);
            }
          }
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent?.isComposing || e.keyCode === 229) {
            onKeyDown?.(e);
            return;
          }
          if (isAutocompleteOpen) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              e.stopPropagation();
              acHasNavigatedRef.current = true;
              setAcActiveIndex((prev) => (prev + 1) % acSuggestions.length);
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              e.stopPropagation();
              acHasNavigatedRef.current = true;
              setAcActiveIndex((prev) => (prev - 1 + acSuggestions.length) % acSuggestions.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) {
                setAcContext(null);
              } else {
                e.preventDefault();
                e.stopPropagation();
                handleSelectSuggestion(acActiveIndex);
                return;
              }
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setAcContext(null);
              return;
            }
          } else if (enableVariableAutocomplete && !readOnly && !disabled) {
            if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === ' ') {
              e.preventDefault();
              updateAutocomplete(e.currentTarget.value, e.currentTarget.selectionStart, e.currentTarget.selectionEnd);
              return;
            }
          }
          onKeyDown?.(e);
        }}
        onClick={(e) => {
          onClick?.(e);
          updateAutocomplete(e.currentTarget.value, e.currentTarget.selectionStart, e.currentTarget.selectionEnd);
        }}
        onSelect={(e) => {
          onSelect?.(e);
          const start = e.currentTarget.selectionStart;
          const end = e.currentTarget.selectionEnd;
          if (start !== null && end !== null && start !== end) {
            setAcContext(null);
          }
        }}
        onBlur={(e) => {
          const listboxEl = typeof document !== 'undefined' ? document.getElementById(listboxId) : null;
          const related = e.relatedTarget as Node | null;
          if (related && listboxEl?.contains(related)) {
            return;
          }
          setAcContext(null);
          onBlur?.(e);
        }}
        {...rest}
      />
      <AutocompletePortal
        isOpen={isAutocompleteOpen}
        items={acSuggestions}
        activeIndex={acActiveIndex}
        onSelectIndex={handleSelectSuggestion}
        onHighlightIndex={setAcActiveIndex}
        onDismiss={() => setAcContext(null)}
        anchorRect={acAnchorRect}
        query={acContext?.query || ''}
        kind="variable"
        listboxId={listboxId}
      />
    </>
  );
};
