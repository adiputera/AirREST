'use client';

import React, { useState, useRef, useLayoutEffect, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, AlertCircle, CheckCircle2, Sparkles } from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';

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
  type?: 'text' | 'password';
  disabled?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  showPreview?: boolean;
  size?: 'sm' | 'md' | 'lg';
  id?: string;
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
  type = 'text',
  disabled = false,
  onKeyDown,
  showPreview = false,
  size = 'md',
  id,
}) => {
  const environments = useApiStore((state) => state.environments);
  const activeEnvironmentId = useApiStore((state) => state.activeEnvironmentId);

  const [showPassword, setShowPassword] = useState(false);
  const [hoveredVar, setHoveredVar] = useState<HoveredVariableInfo | null>(null);

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
        if (v && v.enabled && String(v.key || '').trim()) {
          const effVal = v.currentValue !== undefined && v.currentValue !== ''
            ? v.currentValue
            : String(v.initialValue ?? v.value ?? '');
          map[String(v.key).trim()] = effVal;
        }
      }
    }
    return map;
  }, [activeEnv]);

  const safeValue = typeof value === 'string' ? value : '';

  const tokens = useMemo(() => tokenizeVariables(safeValue, envVarsMap), [safeValue, envVarsMap]);

  // Keep mirror scroll position synchronized with input scroll
  const syncScroll = () => {
    if (mirrorRef.current && inputRef.current) {
      mirrorRef.current.scrollLeft = inputRef.current.scrollLeft;
    }
  };

  useLayoutEffect(() => {
    syncScroll();
  }, [safeValue]);

  // Clear tooltip when window scrolls or resizes
  useEffect(() => {
    const handleDismiss = () => setHoveredVar(null);
    window.addEventListener('scroll', handleDismiss, true);
    window.addEventListener('resize', handleDismiss);
    return () => {
      window.removeEventListener('scroll', handleDismiss, true);
      window.removeEventListener('resize', handleDismiss);
    };
  }, []);

  const isPasswordMasked = type === 'password' && !showPassword;

  // Sizing definitions
  const sizeClasses = {
    sm: 'h-7 text-xs px-2',
    md: 'h-10 text-xs px-3',
    lg: 'h-11 text-xs px-4',
  }[size];

  const paddingClass = {
    sm: 'px-2',
    md: 'px-3',
    lg: 'px-4',
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
    if (!mirrorRef.current || isPasswordMasked) {
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
        className={`relative flex w-full items-center overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/90 transition focus-within:border-sky-500 focus-within:ring-1 focus-within:ring-sky-500 ${
          disabled ? 'opacity-60 cursor-not-allowed' : ''
        }`}
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
                    className={`font-semibold cursor-help transition-colors ${
                      token.isResolved
                        ? 'text-amber-400 bg-amber-400/15'
                        : 'text-rose-400 bg-rose-400/15'
                    }`}
                  >
                    {token.text}
                  </span>
                );
              }
              return (
                <span key={idx} className="text-zinc-100">
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
          onChange={(e) => onChange(e.target.value)}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onScroll={() => {
            syncScroll();
            if (hoveredVar) setHoveredVar(null);
          }}
          onKeyUp={syncScroll}
          onKeyDown={(e) => {
            if (hoveredVar) setHoveredVar(null);
            syncScroll();
            onKeyDown?.(e);
          }}
          onClick={syncScroll}
          onSelect={syncScroll}
          placeholder={placeholder}
          className={`w-full bg-transparent font-mono text-xs leading-5 focus:outline-none placeholder-zinc-500 caret-sky-400 ${sizeClasses} ${
            !isPasswordMasked && value.length > 0
              ? 'text-transparent selection:bg-sky-500/30 selection:text-transparent'
              : 'text-zinc-100'
          } ${inputClassName}`}
        />

        {/* Password Visibility Toggle */}
        {type === 'password' && (
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="mr-2.5 text-zinc-500 hover:text-zinc-300 transition shrink-0"
            title={showPassword ? 'Hide password' : 'Show password & highlight variables'}
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </div>

      {/* Hover Popup Tooltip */}
      {hoveredVar &&
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
            className="pointer-events-none max-w-sm rounded-xl border border-zinc-800 bg-zinc-950/95 p-3 shadow-2xl backdrop-blur-md text-xs select-none transition-all duration-75"
          >
            <div className="flex items-center gap-2 border-b border-zinc-800 pb-2 mb-2">
              <div
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${
                  hoveredVar.isResolved
                    ? 'bg-amber-500/15 text-amber-400 border border-amber-500/20'
                    : 'bg-rose-500/15 text-rose-400 border border-rose-500/20'
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
                  <span className="font-mono font-bold text-zinc-100">
                    {`{{${hoveredVar.varName}}}`}
                  </span>
                  <span className="text-[10px] text-zinc-400">
                    ({hoveredVar.scope})
                  </span>
                </div>
              </div>
            </div>

            <div className="space-y-1 font-mono text-[11px]">
              {(() => {
                const matchedVar = activeEnv?.variables?.find((v) => v.key.trim() === hoveredVar.varName);
                const initialVal = matchedVar?.initialValue ?? matchedVar?.value;
                if (initialVal !== undefined) {
                  return (
                    <div className="flex items-start gap-1.5">
                      <span className="text-zinc-500 shrink-0">Initial Value:</span>
                      <span className="break-all font-medium text-zinc-300">
                        {initialVal || '(empty string)'}
                      </span>
                    </div>
                  );
                }
                return null;
              })()}
              <div className="flex items-start gap-1.5">
                <span className="text-zinc-500 shrink-0">Current Value:</span>
                <span
                  className={`break-all font-medium ${
                    hoveredVar.isResolved ? 'text-amber-300' : 'text-rose-400 italic'
                  }`}
                >
                  {hoveredVar.isResolved
                    ? hoveredVar.resolvedValue || '(empty string)'
                    : 'Unresolved variable'}
                </span>
              </div>
            </div>

            {!hoveredVar.isResolved && (
              <div className="mt-2 text-[10px] text-zinc-500 border-t border-zinc-850 pt-1.5 font-sans leading-relaxed">
                Add this variable in the <span className="text-sky-400 font-semibold">Environments</span> modal or extract it in tests with <code className="text-emerald-400 font-mono">pm.environment.set(&apos;{hoveredVar.varName}&apos;, ...)</code>.
              </div>
            )}
          </div>,
          document.body
        )}

      {/* Resolved Variables Chip Preview */}
      {showPreview && uniqueVars.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 px-0.5">
          <span className="text-[10px] font-medium text-zinc-500">Variables:</span>
          {uniqueVars.map((v, i) => (
            <span
              key={i}
              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium border ${
                v.isResolved
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                  : 'border-rose-500/30 bg-rose-500/10 text-rose-400'
              }`}
            >
              {v.isResolved ? (
                <CheckCircle2 className="h-3 w-3 text-amber-400 shrink-0" />
              ) : (
                <AlertCircle className="h-3 w-3 text-rose-400 shrink-0" />
              )}
              <span>{`{{${v.varName}}}`}</span>
              <span className="text-zinc-500">→</span>
              <span className="max-w-[150px] truncate text-zinc-200" title={v.resolvedValue}>
                {v.isResolved ? v.resolvedValue || '""' : 'unresolved'}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};
