import type { EnvironmentVariable } from '../types';

// Older servers may return JSON as a string. Never parse it inside JSX.
export function normalizeEnvironmentVariables(input: unknown): EnvironmentVariable[] {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!value || typeof value !== 'object') return [];

  if (!Array.isArray(value)) {
    return Object.entries(value).map(([k, rawVal]) => ({
      key: k,
      value: typeof rawVal === 'string' || typeof rawVal === 'number' || typeof rawVal === 'boolean' ? String(rawVal) : '',
      enabled: true,
    }));
  }

  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('key' in entry) || typeof entry.key !== 'string') return [];
    const rawValue = 'value' in entry ? entry.value : '';
    return [{
      id: 'id' in entry && typeof entry.id === 'string' ? entry.id : undefined,
      key: entry.key,
      value: typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean' ? String(rawValue) : '',
      enabled: !('enabled' in entry) || entry.enabled !== false,
    }];
  });
}
