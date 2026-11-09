import type { CloudConfig } from '../types/api';

export interface CloudSessionUpdate {
  updates: Partial<CloudConfig>;
  startsNewSession: boolean;
}

/** Provider sessions are in-memory only and require a validated identity. */
export function isCloudSessionActive(config: CloudConfig): boolean {
  return Boolean(config.token || (config.sessionKind === 'provider' &&
    typeof config.user?.id === 'string' && config.user.id.trim()));
}

/** Normalizes a cloud configuration update and identifies session boundaries. */
export function prepareCloudSessionUpdate(
  current: CloudConfig,
  requested: Partial<CloudConfig>,
  normalizeApiUrl: (url?: string) => string,
): CloudSessionUpdate {
  const updates = { ...requested };
  if (updates.apiUrl !== undefined) {
    updates.apiUrl = normalizeApiUrl(updates.apiUrl);
    if (updates.apiUrl !== current.apiUrl) {
      // Identity and credentials are tied to the original deployment. Only
      // carry fields explicitly supplied by the caller for the new server.
      for (const key of ['user', 'token', 'refreshToken', 'tokenExpiresAt', 'sessionKind', 'activeScope'] as const) {
        if (!Object.prototype.hasOwnProperty.call(updates, key)) {
          Object.assign(updates, { [key]: undefined });
        }
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'user') && updates.user?.id !== current.user?.id) {
    // Never associate another user's cache with credentials from this session.
    for (const key of ['token', 'refreshToken', 'tokenExpiresAt', 'sessionKind', 'activeScope'] as const) {
      if (!Object.prototype.hasOwnProperty.call(updates, key)) {
        Object.assign(updates, { [key]: undefined });
      }
    }
  }

  const startsNewSession =
    (updates.apiUrl !== undefined && updates.apiUrl !== current.apiUrl) ||
    (updates.user?.id !== undefined && updates.user.id !== current.user?.id) ||
    (Object.prototype.hasOwnProperty.call(updates, 'sessionKind') &&
      (updates.sessionKind === 'provider' || updates.sessionKind !== current.sessionKind)) ||
    (updates.token !== undefined && !current.token);

  return { updates, startsNewSession };
}
