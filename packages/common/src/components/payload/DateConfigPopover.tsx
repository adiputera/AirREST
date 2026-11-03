import React, { useState, useRef, useEffect } from 'react';
import { Calendar, Clock, Check, Sparkles, X } from 'lucide-react';
import { DateConfig, DateFormatOption } from '../../types/payloadBuilder';
import { formatDateValue } from '../../lib/payloadCompiler';

interface DateConfigPopoverProps {
  config?: DateConfig;
  currentValue?: string;
  onChange: (newConfig: DateConfig, newValue: string) => void;
}

const FORMAT_OPTIONS: { id: DateFormatOption; label: string; example: string }[] = [
  { id: 'iso-8601', label: 'ISO-8601 (UTC)', example: '2026-11-02T05:12:00.000Z' },
  { id: 'date-only', label: 'Date Only (YYYY-MM-DD)', example: '2026-11-02' },
  { id: 'datetime', label: 'Date & Time', example: '2026-11-02 05:12:00' },
  { id: 'unix-timestamp', label: 'Unix Timestamp (seconds)', example: '1793574720' },
  { id: 'unix-ms', label: 'Unix Timestamp (ms)', example: '1793574720000' },
];

export const DateConfigPopover: React.FC<DateConfigPopoverProps> = ({ config, currentValue, onChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeMode = config?.mode || 'static';
  const activeFormat = config?.format || 'iso-8601';

  // Compute live preview
  const livePreview = formatDateValue(
    { mode: activeMode, format: activeFormat, value: currentValue },
    currentValue
  );

  // Close popover on outside click
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

  const handleSelectFormat = (format: DateFormatOption) => {
    const updatedConfig: DateConfig = {
      mode: activeMode,
      format,
      value: currentValue,
    };
    const formatted = formatDateValue(updatedConfig, currentValue);
    onChange(updatedConfig, formatted);
  };

  const handleToggleMode = (mode: 'static' | 'dynamic_now') => {
    const updatedConfig: DateConfig = {
      mode,
      format: activeFormat,
      value: currentValue,
    };
    const formatted = formatDateValue(updatedConfig, currentValue);
    onChange(updatedConfig, formatted);
  };

  return (
    <div className="relative inline-block" ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex items-center gap-1.5 rounded-lg border border-purple-500/30 bg-purple-500/10 px-2 py-1 text-xs font-medium text-purple-600 dark:text-purple-400 hover:bg-purple-500/20 transition cursor-pointer"
        title="Configure date format and mode"
      >
        <Calendar className="h-3.5 w-3.5" />
        <span className="font-mono text-[11px] truncate max-w-[130px]">
          {activeMode === 'dynamic_now' ? 'Now (Dynamic)' : activeFormat}
        </span>
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1.5 z-50 w-72 rounded-xl border border-line bg-card/95 p-3.5 shadow-2xl backdrop-blur-md animate-in fade-in duration-100 text-xs">
          <div className="flex items-center justify-between pb-2 border-b border-line mb-3">
            <span className="font-semibold text-tx-primary flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-purple-500" />
              <span>Date Configuration</span>
            </span>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="text-tx-muted hover:text-tx-primary p-0.5 rounded"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Mode Selector */}
          <div className="space-y-1 mb-3">
            <label className="text-[11px] text-tx-secondary font-medium">Evaluation Mode:</label>
            <div className="grid grid-cols-2 gap-1.5 p-0.5 rounded-lg border border-line bg-element">
              <button
                type="button"
                onClick={() => handleToggleMode('static')}
                className={`py-1 rounded text-center text-xs font-medium transition ${
                  activeMode === 'static'
                    ? 'bg-card text-purple-600 dark:text-purple-400 shadow-sm font-semibold'
                    : 'text-tx-muted hover:text-tx-primary'
                }`}
              >
                Static Value
              </button>
              <button
                type="button"
                onClick={() => handleToggleMode('dynamic_now')}
                className={`py-1 rounded text-center text-xs font-medium transition flex items-center justify-center gap-1 ${
                  activeMode === 'dynamic_now'
                    ? 'bg-card text-purple-600 dark:text-purple-400 shadow-sm font-semibold'
                    : 'text-tx-muted hover:text-tx-primary'
                }`}
              >
                <Sparkles className="h-3 w-3" />
                <span>Now (Dynamic)</span>
              </button>
            </div>
          </div>

          {/* Format Options */}
          <div className="space-y-1 mb-3">
            <label className="text-[11px] text-tx-secondary font-medium">Output Format:</label>
            <div className="space-y-1 max-h-44 overflow-y-auto pr-0.5">
              {FORMAT_OPTIONS.map((opt) => {
                const isSelected = activeFormat === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleSelectFormat(opt.id)}
                    className={`w-full flex items-center justify-between p-2 rounded-lg border text-left transition ${
                      isSelected
                        ? 'border-purple-500/40 bg-purple-500/10 text-purple-600 dark:text-purple-300 font-medium'
                        : 'border-line/60 hover:bg-hover text-tx-secondary'
                    }`}
                  >
                    <div>
                      <div className="text-xs">{opt.label}</div>
                      <div className="font-mono text-[10px] text-tx-muted truncate max-w-[200px]">
                        {opt.example}
                      </div>
                    </div>
                    {isSelected && <Check className="h-3.5 w-3.5 text-purple-500 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Live Preview */}
          <div className="rounded-lg bg-element p-2 border border-line">
            <div className="text-[10px] text-tx-muted font-medium mb-0.5">Compiled Result:</div>
            <div className="font-mono text-[11px] text-tx-primary truncate select-all">
              {livePreview}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
