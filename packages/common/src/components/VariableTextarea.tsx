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
    (nextText: string, cursorPos: number | null) => {
      if (!enableVariableAutocomplete || readOnly || disabled) {
        setAcContext(null);
        return;
      }
      const pos = cursorPos ?? nextText.length;
      const detected = detectInputAutocompleteContext(nextText, pos, 'variable-only');
      if (!detected) {
        setAcContext(null);
        return;
      }
      setAcContext((prev) => {
        if (!prev || prev.query !== detected.query) {
          setAcActiveIndex(0);
        }
        return detected;
      });
      setAcAnchorRect(measureAnchorRect());
    },
    [enableVariableAutocomplete, readOnly, disabled, measureAnchorRect]
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
      const target = e.target as HTMLElement | null;
      if (target && target.closest?.(`#${CSS.escape(listboxId)}`)) {
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
  }, [isAutocompleteOpen, listboxId, measureAnchorRect]);

  return (
    <>
      <textarea
        ref={textareaRef}
        value={safeValue}
        readOnly={readOnly}
        disabled={disabled}
        aria-expanded={isAutocompleteOpen || undefined}
        aria-controls={isAutocompleteOpen ? listboxId : undefined}
        aria-activedescendant={
          isAutocompleteOpen ? `${listboxId}-item-${acActiveIndex}` : undefined
        }
        onChange={(e) => {
          onChange?.(e);
          if (!e.defaultPrevented && !readOnly) {
            onValueChange(e.target.value);
            updateAutocomplete(e.target.value, e.target.selectionStart);
          }
        }}
        onKeyUp={(e) => {
          onKeyUp?.(e);
          if (
            e.key === 'ArrowLeft' ||
            e.key === 'ArrowRight' ||
            e.key === 'Home' ||
            e.key === 'End'
          ) {
            updateAutocomplete(e.currentTarget.value, e.currentTarget.selectionStart);
          }
        }}
        onKeyDown={(e) => {
          if (isAutocompleteOpen) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              e.stopPropagation();
              setAcActiveIndex((prev) => (prev + 1) % acSuggestions.length);
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              e.stopPropagation();
              setAcActiveIndex((prev) => (prev - 1 + acSuggestions.length) % acSuggestions.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              e.stopPropagation();
              handleSelectSuggestion(acActiveIndex);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setAcContext(null);
              return;
            }
          }
          onKeyDown?.(e);
        }}
        onClick={(e) => {
          onClick?.(e);
          updateAutocomplete(e.currentTarget.value, e.currentTarget.selectionStart);
        }}
        onBlur={(e) => {
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
        anchorRect={acAnchorRect}
        query={acContext?.query || ''}
        kind="variable"
        listboxId={listboxId}
      />
    </>
  );
};
