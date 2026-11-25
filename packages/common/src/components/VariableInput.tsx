'use client';

import React, { useState, useRef, useLayoutEffect, useMemo, useEffect, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, AlertCircle, CheckCircle2, Sparkles } from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import {
  AutocompleteInputMode,
  AutocompleteContext,
  AutocompleteSuggestionItem,
  detectInputAutocompleteContext,
  getHeaderSuggestions,
  getVariableSuggestions,
  applyAutocompleteSuggestion,
} from '../lib/autocomplete';
import { AutocompletePortal, AutocompleteAnchorRect } from './AutocompletePortal';

export interface VariableToken {
  text: string;
  isVariable: boolean;
  varName?: string;
  isResolved?: boolean;
  resolvedValue?: string;
}

export interface VariableInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  wrapperClassName?: string;
  type?: 'text' | 'password';
  disabled?: boolean;
  readOnly?: boolean;
  ariaDescribedBy?: string;
  maskResetKey?: string | number;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLInputElement>) => void;
  showPreview?: boolean;
  size?: 'sm' | 'md' | 'lg';
  id?: string;
  autocompleteMode?: AutocompleteInputMode;
}

interface HoveredVariableInfo {
  varName: string;
  isResolved: boolean;
  resolvedValue?: string;
  scope: string;
  x: number;
  y: number;
  placement: 'top' | 'bottom';
}

export function tokenizeVariables(
  text: string,
  varMap: Record<string, string>
): VariableToken[] {
  if (!text) return [];

  const tokens: VariableToken[] = [];
  const regex = /\{\{([^{}]+)\}\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({
        text: text.slice(lastIndex, match.index),
        isVariable: false,
      });
    }

    const varName = match[1].trim();
    let isResolved = false;
    let resolvedValue: string | undefined = undefined;

    // Built-in dynamic variables
    if (varName === '$guid') {
      isResolved = true;
      resolvedValue = 'Random UUID v4 (generated dynamically at request dispatch)';
    } else if (varName === '$timestamp') {
      isResolved = true;
      resolvedValue = `Current Unix timestamp (e.g. ${Math.floor(Date.now() / 1000)})`;
    } else if (varName === '$isoTimestamp') {
      isResolved = true;
      resolvedValue = `Current UTC ISO string (e.g. ${new Date().toISOString()})`;
    } else if (varName === '$randomInt') {
      isResolved = true;
      resolvedValue = 'Random integer between 1 and 1000';
    } else if (varMap[varName] !== undefined) {
      isResolved = true;
      resolvedValue = varMap[varName];
    }

    tokens.push({
      text: match[0],
      isVariable: true,
      varName,
      isResolved,
      resolvedValue,
    });

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push({
      text: text.slice(lastIndex),
      isVariable: false,
    });
  }

  return tokens;
}

export const VariableInput: React.FC<VariableInputProps> = ({
  value,
  onChange,
  placeholder = '',
  className = '',
  inputClassName = '',
  wrapperClassName = '',
  type = 'text',
  disabled = false,
  readOnly = false,
  ariaDescribedBy,
  maskResetKey,
  onKeyDown,
  onPaste,
  showPreview = false,
  size = 'md',
  id,
  autocompleteMode = 'variable-only',
}) => {
  const environments = useApiStore((state) => state.environments);
  const activeEnvironmentId = useApiStore((state) => state.activeEnvironmentId);
  const generatedId = useId();
  const listboxId = `var-input-ac-${generatedId}`;

  const [showPassword, setShowPassword] = useState(false);
  const [hoveredVar, setHoveredVar] = useState<HoveredVariableInfo | null>(null);

  // Autocomplete states
  const [acContext, setAcContext] = useState<AutocompleteContext | null>(null);
  const [acActiveIndex, setAcActiveIndex] = useState(0);
  const [acAnchorRect, setAcAnchorRect] = useState<AutocompleteAnchorRect | null>(null);

  useEffect(() => {
    setShowPassword(false);
    setHoveredVar(null);
    setAcContext(null);
  }, [type, maskResetKey]);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  // Active environment variable map
  const activeEnv = useMemo(
    () => environments.find((e) => e.id === activeEnvironmentId),
    [environments, activeEnvironmentId]
  );

  const envVarsMap = useMemo(() => {
    const map: Record<string, string> = {};
    if (activeEnv) {
      for (const v of (activeEnv.variables || [])) {
        if (v && v.enabled && String(v.key ?? '').trim()) {
          const effVal = v.currentValue !== undefined && v.currentValue !== null && v.currentValue !== ''
            ? String(v.currentValue)
            : String(v.initialValue ?? v.value ?? '');
          map[String(v.key).trim()] = effVal;
        }
      }
    }
    return map;
  }, [activeEnv]);

  const safeValue = typeof value === 'string' ? value : '';
  const lastInternalValueRef = useRef(safeValue);
  const acHasNavigatedRef = useRef(false);

  useEffect(() => {
    if (safeValue !== lastInternalValueRef.current) {
      lastInternalValueRef.current = safeValue;
      setAcContext(null);
      setHoveredVar(null);
    }
  }, [safeValue]);

  useEffect(() => {
    if (readOnly || disabled || autocompleteMode === 'none') {
      setAcContext(null);
    }
  }, [readOnly, disabled, autocompleteMode]);

  const tokens = useMemo(() => tokenizeVariables(safeValue, envVarsMap), [safeValue, envVarsMap]);

  const isAnchorRectVisible = useCallback((rect: { left: number; right: number; top: number; bottom: number }) => {
    if (typeof window === 'undefined' || typeof window.innerHeight !== 'number' || typeof window.innerWidth !== 'number') {
      return true;
    }
    return !(rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth);
  }, []);

  const measureAnchorRect = useCallback((): AutocompleteAnchorRect | null => {
    const targetEl = wrapperRef.current || inputRef.current;
    if (!targetEl) return null;
    const rect = targetEl.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
    };
  }, []);

  const updateAutocompleteFromInput = useCallback(
    (
      nextText: string,
      cursorPos: number | null,
      options?: { forceOpenHeader?: boolean; selectionEnd?: number | null }
    ) => {
      if (readOnly || disabled || autocompleteMode === 'none') {
        setAcContext(null);
        return;
      }
      if (
        options?.selectionEnd !== undefined &&
        options?.selectionEnd !== null &&
        cursorPos !== null &&
        options.selectionEnd !== cursorPos
      ) {
        setAcContext(null);
        return;
      }
      const pos = cursorPos ?? nextText.length;
      const detected = detectInputAutocompleteContext(nextText, pos, autocompleteMode, options);
      if (!detected) {
        setAcContext(null);
        return;
      }

      // If header mode and user already selected the exact header name (case-sensitive) and no forceOpen,
      // check whether there are other prefix matches or if it's already completed
      if (detected.kind === 'header' && !options?.forceOpenHeader) {
        const matches = getHeaderSuggestions(detected.query);
        if (
          matches.length === 0 ||
          (matches.length === 1 && matches[0].label === nextText.trim())
        ) {
          setAcContext(null);
          return;
        }
      }

      const targetEl = wrapperRef.current || inputRef.current;
      if (targetEl) {
        const domRect = targetEl.getBoundingClientRect();
        if (!isAnchorRectVisible(domRect)) {
          setAcContext(null);
          return;
        }
      }

      setAcContext((prev) => {
        if (!prev || prev.kind !== detected.kind || prev.query !== detected.query) {
          setAcActiveIndex(0);
          acHasNavigatedRef.current = Boolean(options?.forceOpenHeader);
        }
        return detected;
      });
      setAcAnchorRect(measureAnchorRect());
      setHoveredVar(null);
    },
    [readOnly, disabled, autocompleteMode, measureAnchorRect, isAnchorRectVisible]
  );

  const isPasswordMasked = type === 'password' && !showPassword;

  const acSuggestions: AutocompleteSuggestionItem[] = useMemo(() => {
    if (!acContext) return [];
    if (acContext.kind === 'header') {
      return getHeaderSuggestions(acContext.query);
    }
    const suggestions = getVariableSuggestions(acContext.query, environments, activeEnvironmentId);
    if (!isPasswordMasked) {
      return suggestions;
    }
    return suggestions.map((item) => (item.isBuiltin ? item : { ...item, resolvedValue: '' }));
  }, [acContext, environments, activeEnvironmentId, isPasswordMasked]);

  const isAutocompleteOpen = Boolean(
    autocompleteMode !== 'none' && acContext && acSuggestions.length > 0 && !readOnly && !disabled
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
      onChange(nextText);

      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(() => {
          const inputEl = inputRef.current;
          if (inputEl) {
            inputEl.focus();
            try {
              inputEl.setSelectionRange(nextCursorPos, nextCursorPos);
            } catch {
              // ignore selection range error on non-text types
            }
          }
        });
      }
    },
    [acContext, acSuggestions, safeValue, onChange]
  );

  // Keep mirror scroll position synchronized with input scroll
  const syncScroll = () => {
    if (mirrorRef.current && inputRef.current) {
      mirrorRef.current.scrollLeft = inputRef.current.scrollLeft;
    }
  };

  useLayoutEffect(() => {
    syncScroll();
  }, [safeValue]);

  // Clear tooltip & reposition/dismiss autocomplete when window scrolls or resizes
  useEffect(() => {
    const handleScrollOrResize = (e: Event) => {
      setHoveredVar(null);
      if (isAutocompleteOpen) {
        const target = e.target as Node | null;
        const listboxEl = typeof document !== 'undefined' ? document.getElementById(listboxId) : null;
        if (target && listboxEl?.contains(target)) {
          return;
        }
        const targetEl = wrapperRef.current || inputRef.current;
        if (targetEl && !isAnchorRectVisible(targetEl.getBoundingClientRect())) {
          setAcContext(null);
          return;
        }
        setAcAnchorRect(measureAnchorRect());
      }
    };
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    return () => {
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [isAutocompleteOpen, listboxId, measureAnchorRect, isAnchorRectVisible]);

  // Sizing definitions
  const sizeClasses = {
    sm: 'h-6.5 text-xs px-2',
    md: 'h-8 text-xs px-2.5',
    lg: 'h-8 text-xs px-3',
  }[size];

  const paddingClass = {
    sm: 'px-2',
    md: 'px-2.5',
    lg: 'px-3',
  }[size];

  // Distinct variables extracted for the preview chip list
  const uniqueVars = useMemo(() => {
    const seen = new Set<string>();
    const list: VariableToken[] = [];
    for (const t of tokens) {
      if (t.isVariable && t.varName && !seen.has(t.varName)) {
        seen.add(t.varName);
        list.push(t);
      }
    }
    return list;
  }, [tokens]);

  // Detect mouse hover over variable tokens in the mirror layer
  const handleMouseMove = (e: React.MouseEvent<HTMLInputElement>) => {
    if (!mirrorRef.current || isPasswordMasked || isAutocompleteOpen) {
      if (hoveredVar) setHoveredVar(null);
      return;
    }

    const varSpans = mirrorRef.current.querySelectorAll<HTMLSpanElement>('[data-var-name]');
    let foundMatch = false;

    for (const span of varSpans) {
      const rect = span.getBoundingClientRect();
      // Generous vertical hit target for smooth mouse movements
      if (
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top - 4 &&
        e.clientY <= rect.bottom + 4
      ) {
        const varName = span.getAttribute('data-var-name') || '';
        const isResolved = span.getAttribute('data-resolved') === 'true';
        const resolvedValue = span.getAttribute('data-resolved-val') || '';
        const isBuiltin = varName.startsWith('$');

        let scope = 'Unresolved Variable';
        if (isBuiltin) {
          scope = 'Postman Dynamic Variable';
        } else if (isResolved) {
          scope = activeEnv ? `${activeEnv.name} Environment` : 'Active Environment';
        } else {
          scope = activeEnv ? `Not defined in "${activeEnv.name}"` : 'No Active Environment';
        }

        // Determine placement: prefer top unless near the top viewport edge
        const placement = rect.top < 140 ? 'bottom' : 'top';
        const y = placement === 'top' ? rect.top - 8 : rect.bottom + 8;
        const x = Math.max(12, Math.min(rect.left, window.innerWidth - 320));

        setHoveredVar({
          varName,
          isResolved,
          resolvedValue,
          scope,
          x,
          y,
          placement,
        });
        foundMatch = true;
        break;
      }
    }

    if (!foundMatch && hoveredVar) {
      setHoveredVar(null);
    }
  };

  const handleMouseLeave = () => {
    setHoveredVar(null);
  };

  return (
    <div className={`relative w-full ${className}`}>
      <div
        ref={wrapperRef}
        className={`relative flex w-full items-center overflow-hidden rounded-md border border-line transition focus-within:border-sky-500 focus-within:ring-1 focus-within:ring-sky-500 ${
          readOnly ? 'bg-element/60' : 'bg-card/90'
        } ${disabled ? 'opacity-60 cursor-not-allowed' : ''} ${wrapperClassName}`}
      >
        {/* Syntax Highlighting Mirror Layer */}
        {!isPasswordMasked && safeValue.length > 0 && (
          <div
            ref={mirrorRef}
            aria-hidden="true"
            className={`pointer-events-none absolute inset-0 flex items-center overflow-x-hidden whitespace-pre font-mono text-xs leading-5 select-none ${paddingClass}`}
          >
            {tokens.map((token, idx) => {
              if (token.isVariable) {
                return (
                  <span
                    key={idx}
                    data-var-name={token.varName}
                    data-resolved={token.isResolved ? 'true' : 'false'}
                    data-resolved-val={token.resolvedValue || ''}
                    className={`font-semibold cursor-help transition-colors ${token.isResolved
                        ? 'text-amber-700 dark:text-amber-400 bg-amber-500/15'
                        : 'text-rose-600 dark:text-rose-400 bg-rose-500/15'
                      }`}
                  >
                    {token.text}
                  </span>
                );
              }
              return (
                <span key={idx} className="text-tx-primary">
                  {token.text}
                </span>
              );
            })}
          </div>
        )}

        {/* Real Interactive Input */}
        <input
          ref={inputRef}
          id={id}
          type={isPasswordMasked ? 'password' : 'text'}
          value={safeValue}
          disabled={disabled}
          readOnly={readOnly}
          role={!readOnly && autocompleteMode !== 'none' ? 'combobox' : undefined}
          aria-expanded={!readOnly && autocompleteMode !== 'none' ? isAutocompleteOpen : undefined}
          aria-autocomplete={!readOnly && autocompleteMode !== 'none' ? 'list' : undefined}
          aria-controls={isAutocompleteOpen ? listboxId : undefined}
          aria-activedescendant={
            isAutocompleteOpen ? `${listboxId}-item-${acActiveIndex}` : undefined
          }
          aria-readonly={readOnly || undefined}
          aria-describedby={ariaDescribedBy}
          onChange={(e) => {
            if (readOnly) return;
            const nextVal = e.target.value;
            const cursorPos = e.target.selectionStart;
            lastInternalValueRef.current = nextVal;
            onChange(nextVal);
            updateAutocompleteFromInput(nextVal, cursorPos, { selectionEnd: e.target.selectionEnd });
          }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onScroll={() => {
            syncScroll();
            if (hoveredVar) setHoveredVar(null);
          }}
          onKeyUp={(e) => {
            syncScroll();
            if (
              e.key === 'ArrowLeft' ||
              e.key === 'ArrowRight' ||
              e.key === 'Home' ||
              e.key === 'End'
            ) {
              updateAutocompleteFromInput(e.currentTarget.value, e.currentTarget.selectionStart, {
                selectionEnd: e.currentTarget.selectionEnd,
              });
            }
          }}
          onKeyDown={(e) => {
            if (hoveredVar) setHoveredVar(null);
            syncScroll();

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
              if (e.key === 'Enter') {
                if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) {
                  setAcContext(null);
                } else {
                  e.preventDefault();
                  e.stopPropagation();
                  handleSelectSuggestion(acActiveIndex);
                  return;
                }
              }
              if (e.key === 'Tab') {
                const isModifiedTab = e.shiftKey || e.ctrlKey || e.metaKey || e.altKey;
                const shouldLetTabMoveFocus =
                  isModifiedTab || (acContext?.kind === 'header' && !acHasNavigatedRef.current);
                if (shouldLetTabMoveFocus) {
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
            } else if (!readOnly && !disabled && autocompleteMode !== 'none') {
              // Allow Ctrl+Space or ArrowDown on a header-name field to manually open suggestions
              if (
                (e.ctrlKey && e.key === ' ') ||
                (autocompleteMode === 'header-name' && e.key === 'ArrowDown')
              ) {
                e.preventDefault();
                updateAutocompleteFromInput(
                  e.currentTarget.value,
                  e.currentTarget.selectionStart,
                  {
                    forceOpenHeader: autocompleteMode === 'header-name',
                    selectionEnd: e.currentTarget.selectionEnd,
                  }
                );
                return;
              }
            }

            onKeyDown?.(e);
          }}
          onClick={(e) => {
            syncScroll();
            updateAutocompleteFromInput(e.currentTarget.value, e.currentTarget.selectionStart, {
              selectionEnd: e.currentTarget.selectionEnd,
            });
          }}
          onPaste={(e) => {
            onPaste?.(e);
            if (e.defaultPrevented) {
              setAcContext(null);
              setHoveredVar(null);
            }
          }}
          onBlur={(e) => {
            const listboxEl = typeof document !== 'undefined' ? document.getElementById(listboxId) : null;
            const related = e.relatedTarget as Node | null;
            if (related && listboxEl?.contains(related)) {
              return;
            }
            setAcContext(null);
          }}
          onSelect={(e) => {
            syncScroll();
            const start = e.currentTarget.selectionStart;
            const end = e.currentTarget.selectionEnd;
            if (start !== null && end !== null && start !== end) {
              setAcContext(null);
            }
          }}
          placeholder={placeholder}
          className={`w-full bg-transparent font-mono text-xs leading-5 focus:outline-none placeholder-tx-muted ${
            readOnly ? 'caret-transparent cursor-text' : 'caret-sky-400'
          } ${sizeClasses} ${!isPasswordMasked && safeValue.length > 0
              ? 'text-transparent selection:bg-sky-500/30 selection:text-transparent'
              : 'text-tx-primary'
            } ${inputClassName}`}
        />

        {/* Password Visibility Toggle */}
        {type === 'password' && (
          <button
            type="button"
            data-autocomplete-keep-open="true"
            onMouseDown={(e) => {
              // Keep input focus so an open variable autocomplete dropdown updates masking live
              e.preventDefault();
            }}
            onClick={() => {
              setShowPassword(!showPassword);
              setHoveredVar(null);
            }}
            className="mr-2.5 text-tx-muted hover:text-tx-primary transition shrink-0"
            aria-label={showPassword ? 'Hide value' : 'Show value'}
            title={showPassword ? 'Hide password' : 'Show password & highlight variables'}
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </div>

      {/* Autocomplete Dropdown Portal */}
      <AutocompletePortal
        isOpen={isAutocompleteOpen}
        items={acSuggestions}
        activeIndex={acActiveIndex}
        onSelectIndex={handleSelectSuggestion}
        onHighlightIndex={setAcActiveIndex}
        onDismiss={() => setAcContext(null)}
        anchorRect={acAnchorRect}
        query={acContext?.query || ''}
        kind={acContext?.kind || 'variable'}
        listboxId={listboxId}
        maskValues={isPasswordMasked}
      />

      {/* Hover Popup Tooltip */}
      {!isPasswordMasked && !isAutocompleteOpen && hoveredVar &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              left: `${hoveredVar.x}px`,
              top: `${hoveredVar.y}px`,
              transform: hoveredVar.placement === 'top' ? 'translateY(-100%)' : 'none',
              zIndex: 9999,
            }}
            className="pointer-events-none max-w-sm rounded-xl border border-line bg-card/95 p-3 shadow-2xl backdrop-blur-md text-xs select-none transition-all duration-75 text-tx-secondary"
          >
            <div className="flex items-center gap-2 border-b border-line pb-2 mb-2">
              <div
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${hoveredVar.isResolved
                    ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                    : 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/20'
                  }`}
              >
                {hoveredVar.varName.startsWith('$') ? (
                  <Sparkles className="h-3 w-3" />
                ) : hoveredVar.isResolved ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <AlertCircle className="h-3 w-3" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-mono font-bold text-tx-primary">
                    {`{{${hoveredVar.varName}}}`}
                  </span>
                  <span className="text-[10px] text-tx-muted">
                    ({hoveredVar.scope})
                  </span>
                </div>
              </div>
            </div>

            <div className="space-y-1 font-mono text-[11px]">
              {(() => {
                const matchedVar = activeEnv?.variables
                  ?.filter((v) => v && v.enabled && String(v.key ?? '').trim() === hoveredVar.varName)
                  .at(-1);
                const rawInitial = matchedVar?.initialValue ?? matchedVar?.value;
                if (rawInitial !== undefined && rawInitial !== null) {
                  const initialStr = String(rawInitial);
                  return (
                    <div className="flex items-start gap-1.5">
                      <span className="text-tx-muted shrink-0">Initial Value:</span>
                      <span className="break-all font-medium text-tx-primary">
                        {initialStr || '(empty string)'}
                      </span>
                    </div>
                  );
                }
                return null;
              })()}
              <div className="flex items-start gap-1.5">
                <span className="text-tx-muted shrink-0">Current Value:</span>
                <span
                  className={`break-all font-medium ${hoveredVar.isResolved ? 'text-amber-700 dark:text-amber-300' : 'text-rose-600 dark:text-rose-400 italic'
                    }`}
                >
                  {hoveredVar.isResolved
                    ? hoveredVar.resolvedValue || '(empty string)'
                    : 'Unresolved variable'}
                </span>
              </div>
            </div>

            {!hoveredVar.isResolved && (
              <div className="mt-2 text-[10px] text-tx-muted border-t border-line pt-1.5 font-sans leading-relaxed">
                Add this variable in the <span className="text-sky-600 dark:text-sky-400 font-semibold">Environments</span> modal or extract it in tests with <code className="text-emerald-600 dark:text-emerald-400 font-mono">pm.environment.set(&apos;{hoveredVar.varName}&apos;, ...)</code>.
              </div>
            )}
          </div>,
          document.body
        )}

      {/* Resolved Variables Chip Preview */}
      {showPreview && !isPasswordMasked && uniqueVars.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 px-0.5">
          <span className="text-[10px] font-medium text-tx-muted">Variables:</span>
          {uniqueVars.map((v, i) => (
            <span
              key={i}
              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium border ${v.isResolved
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                  : 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400'
                }`}
            >
              {v.isResolved ? (
                <CheckCircle2 className="h-3 w-3 text-amber-600 dark:text-amber-400 shrink-0" />
              ) : (
                <AlertCircle className="h-3 w-3 text-rose-500 dark:text-rose-400 shrink-0" />
              )}
              <span>{`{{${v.varName}}}`}</span>
              <span className="text-tx-muted">→</span>
              <span className="max-w-[150px] truncate text-tx-primary" title={v.resolvedValue}>
                {v.isResolved ? v.resolvedValue || '""' : 'unresolved'}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};
