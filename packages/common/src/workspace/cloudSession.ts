import type { CloudConfig } from '../types/api';

export interface CloudSessionUpdate {
  updates: Partial<CloudConfig>;
  startsNewSession: boolean;
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
  }

  const startsNewSession =
    (updates.apiUrl !== undefined && updates.apiUrl !== current.apiUrl) ||
    (updates.user?.id !== undefined && updates.user.id !== current.user?.id) ||
    (updates.token !== undefined && !current.token);

  return { updates, startsNewSession };
}
