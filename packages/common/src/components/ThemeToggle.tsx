import React from 'react';
import { Sun, Moon, Laptop } from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { ThemeMode } from '../types/api';
import { getNextThemeMode } from '../lib/theme';

export const DesktopThemeToggle: React.FC = () => {
  const theme = useApiStore((state) => state.theme || 'system');
  const setTheme = useApiStore((state) => state.setTheme);

  const nextTheme = getNextThemeMode(theme);

  const getThemeInfo = (mode: ThemeMode) => {
    switch (mode) {
      case 'light':
        return {
          icon: <Sun className="h-4 w-4 text-amber-500" />,
          label: 'Light',
          nextLabel: 'Dark',
        };
      case 'dark':
        return {
          icon: <Moon className="h-4 w-4 text-sky-400" />,
          label: 'Dark',
          nextLabel: 'Auto',
        };
      case 'system':
      default:
        return {
          icon: <Laptop className="h-4 w-4 text-zinc-500 dark:text-zinc-400" />,
          label: 'Auto (System)',
          nextLabel: 'Light',
        };
    }
  };

  const currentInfo = getThemeInfo(theme);

  return (
    <button
      type="button"
      onClick={() => setTheme(nextTheme)}
      aria-label={`Current theme: ${currentInfo.label}. Click to switch to ${currentInfo.nextLabel}.`}
      title={`Theme: ${currentInfo.label} (Click for ${currentInfo.nextLabel})`}
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-card/90 text-tx-secondary hover:text-tx-primary hover:bg-hover transition shadow-xs shrink-0 focus:outline-none focus:ring-1 focus:ring-sky-500"
    >
      {currentInfo.icon}
    </button>
  );
};

export const MobileThemeSegmentedControl: React.FC = () => {
  const theme = useApiStore((state) => state.theme || 'system');
  const setTheme = useApiStore((state) => state.setTheme);

  const options: { id: ThemeMode; label: string; icon: React.ReactNode }[] = [
    { id: 'light', label: 'Light', icon: <Sun className="h-3.5 w-3.5" /> },
    { id: 'system', label: 'Auto', icon: <Laptop className="h-3.5 w-3.5" /> },
    { id: 'dark', label: 'Dark', icon: <Moon className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="md:hidden border-b border-line px-2 py-1.5 bg-element/50">
      <div className="grid grid-cols-3 rounded-lg border border-line bg-card/90 p-0.5 text-[11px] font-medium shadow-xs">
        {options.map((opt) => {
          const isActive = theme === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => setTheme(opt.id)}
              className={`flex items-center justify-center gap-1.5 rounded-md py-1 transition-all ${
                isActive
                  ? 'bg-active text-sky-600 dark:text-sky-400 font-semibold shadow-xs'
                  : 'text-tx-muted hover:text-tx-primary'
              }`}
            >
              {opt.icon}
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
