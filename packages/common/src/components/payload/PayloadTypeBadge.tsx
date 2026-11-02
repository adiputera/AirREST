import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { PayloadValueType } from '../../types/payloadBuilder';

interface PayloadTypeBadgeProps {
  type: PayloadValueType;
  onChange: (newType: PayloadValueType) => void;
  disabled?: boolean;
}

const TYPE_CONFIGS: Record<
  PayloadValueType,
  { label: string; short: string; color: string; badgeBg: string; border: string }
> = {
  string: {
    label: 'String',
    short: 'str',
    color: 'text-sky-600 dark:text-sky-400',
    badgeBg: 'bg-sky-500/10 hover:bg-sky-500/20',
    border: 'border-sky-500/30',
  },
  number: {
    label: 'Number',
    short: 'num',
    color: 'text-amber-600 dark:text-amber-400',
    badgeBg: 'bg-amber-500/10 hover:bg-amber-500/20',
    border: 'border-amber-500/30',
  },
  boolean: {
    label: 'Boolean',
    short: 'bool',
    color: 'text-emerald-600 dark:text-emerald-400',
    badgeBg: 'bg-emerald-500/10 hover:bg-emerald-500/20',
    border: 'border-emerald-500/30',
  },
  date: {
    label: 'Date',
    short: 'date',
    color: 'text-purple-600 dark:text-purple-400',
    badgeBg: 'bg-purple-500/10 hover:bg-purple-500/20',
    border: 'border-purple-500/30',
  },
  list: {
    label: 'List',
    short: 'list',
    color: 'text-indigo-600 dark:text-indigo-400',
    badgeBg: 'bg-indigo-500/10 hover:bg-indigo-500/20',
    border: 'border-indigo-500/30',
  },
  object: {
    label: 'Object',
    short: 'obj',
    color: 'text-teal-600 dark:text-teal-400',
    badgeBg: 'bg-teal-500/10 hover:bg-teal-500/20',
    border: 'border-teal-500/30',
  },
  null: {
    label: 'Null',
    short: 'null',
    color: 'text-slate-600 dark:text-slate-400',
    badgeBg: 'bg-slate-500/10 hover:bg-slate-500/20',
    border: 'border-slate-500/30',
  },
};

const ALL_TYPES: PayloadValueType[] = ['string', 'number', 'boolean', 'date', 'list', 'object', 'null'];

export const PayloadTypeBadge: React.FC<PayloadTypeBadgeProps> = ({ type, onChange, disabled }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeConfig = TYPE_CONFIGS[type] || TYPE_CONFIGS.string;

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div className="relative inline-block" ref={containerRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((prev) => !prev)}
        className={`flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold transition ${activeConfig.badgeBg} ${activeConfig.color} ${activeConfig.border} ${
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
        }`}
        title={`Change type (current: ${activeConfig.label})`}
      >
        <span>{activeConfig.short}</span>
        <ChevronDown className="h-3 w-3 opacity-70" />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full mt-1 z-40 min-w-[120px] rounded-lg border border-line bg-card/95 py-1 text-xs shadow-xl backdrop-blur-md animate-in fade-in duration-100">
          {ALL_TYPES.map((t) => {
            const config = TYPE_CONFIGS[t];
            const isSelected = t === type;
            return (
              <button
                key={t}
                type="button"
                onClick={() => {
                  onChange(t);
                  setIsOpen(false);
                }}
                className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs transition hover:bg-hover ${
                  isSelected ? 'font-bold ' + config.color : 'text-tx-secondary'
                }`}
              >
                <span>{config.label}</span>
                <span className={`font-mono text-[10px] rounded px-1 py-0.2 border ${config.badgeBg} ${config.color} ${config.border}`}>
                  {config.short}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
