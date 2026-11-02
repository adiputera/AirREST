import { ThemeMode } from '../types/api';

export function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark';
  }
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}

export function resolveTheme(theme: ThemeMode): 'light' | 'dark' {
  if (theme === 'system') {
    return getSystemTheme();
  }
  return theme === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const resolved = resolveTheme(theme);
  const isDark = resolved === 'dark';
  const root = document.documentElement;

  if (isDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }

  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;
}

export function getNextThemeMode(current: ThemeMode): ThemeMode {
  switch (current) {
    case 'system':
      return 'light';
    case 'light':
      return 'dark';
    case 'dark':
    default:
      return 'system';
  }
}

export function subscribeToSystemTheme(callback: (resolved: 'light' | 'dark') => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }

  try {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent | MediaQueryList) => {
      const isDark = 'matches' in event ? event.matches : mediaQuery.matches;
      callback(isDark ? 'dark' : 'light');
    };

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', listener);
      return () => mediaQuery.removeEventListener('change', listener);
    } else if (typeof (mediaQuery as any).addListener === 'function') {
      (mediaQuery as any).addListener(listener);
      return () => (mediaQuery as any).removeListener(listener);
    }
  } catch (err) {
    console.warn('[AirREST] Failed to bind system theme listener:', err);
  }

  return () => {};
}
