import type { CloudCacheArchive, CloudCacheArchiveState } from './cloudCacheArchive';

export const CLOUD_CACHE_RECOVERY_FORMAT = 'AirREST cloud cache recovery';
export const MAX_CLOUD_CACHE_RECOVERY_BYTES = 16 * 1024 * 1024;

export interface CloudCacheRecoveryBackup {
  format: typeof CLOUD_CACHE_RECOVERY_FORMAT;
  version: 1;
  archives: CloudCacheArchive[];
  unsupportedArchives?: unknown[];
}

export type CloudCacheRecoveryImportResult =
  | { success: true; archiveCount: number; unsupportedArchiveCount: number; archives: CloudCacheArchiveState }
  | { success: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 100) return false;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every((entry) => isSafeJsonValue(entry, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, entry]) =>
    key !== '__proto__' && key !== 'constructor' && key !== 'prototype' && isSafeJsonValue(entry, depth + 1),
  );
}

function isCloudCacheArchive(value: unknown): value is CloudCacheArchive {
  if (!isRecord(value) || !isRecord(value.scopeCache)) return false;
  if (value.scopesCache !== undefined && !isRecord(value.scopesCache)) return false;
  return value.unscoped === undefined || (Array.isArray(value.unscoped) && value.unscoped.every(isRecord));
}

/** Parses a user-selected recovery file without associating it with an account. */
export function parseCloudCacheRecoveryBackup(serialized: string):
  | { success: true; backup: CloudCacheRecoveryBackup }
  | { success: false; error: string } {
  if (serialized.length > MAX_CLOUD_CACHE_RECOVERY_BYTES) {
    return { success: false, error: 'Recovery file exceeds the 16 MB import limit.' };
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error) {
    return { success: false, error: error instanceof Error ? `Recovery file is not valid JSON: ${error.message}` : 'Recovery file is not valid JSON.' };
  }

  if (!isSafeJsonValue(value) || !isRecord(value)) {
    return { success: false, error: 'Recovery file contains an unsafe or unsupported data structure.' };
  }
  if (value.format !== CLOUD_CACHE_RECOVERY_FORMAT || value.version !== 1 || !Array.isArray(value.archives)) {
    return { success: false, error: 'Recovery file does not use a supported AirREST cloud-cache format.' };
  }
  if (!value.archives.every(isCloudCacheArchive)) {
    return { success: false, error: 'Recovery file contains an invalid workspace archive.' };
  }
  if (value.unsupportedArchives !== undefined && !Array.isArray(value.unsupportedArchives)) {
    return { success: false, error: 'Recovery file contains invalid unsupported-archive data.' };
  }

  return {
    success: true,
    backup: {
      format: CLOUD_CACHE_RECOVERY_FORMAT,
      version: 1,
      archives: value.archives,
      ...(value.unsupportedArchives ? { unsupportedArchives: value.unsupportedArchives } : {}),
    },
  };
}

/** Adds imported snapshots as unclaimed data, so they never open under any account automatically. */
export function importCloudCacheRecoveryBackup(
  current: CloudCacheArchiveState,
  serialized: string,
): CloudCacheRecoveryImportResult {
  const parsed = parseCloudCacheRecoveryBackup(serialized);
  if (!parsed.success) return parsed;

  const unsupportedArchives = [
    ...(current.unsupportedVersions || []),
    ...(parsed.backup.unsupportedArchives || []),
  ];
  return {
    success: true,
    archiveCount: parsed.backup.archives.length,
    unsupportedArchiveCount: parsed.backup.unsupportedArchives?.length || 0,
    archives: {
      version: 1,
      owners: { ...current.owners },
      unclaimed: [...current.unclaimed, ...parsed.backup.archives],
      ...(unsupportedArchives.length ? { unsupportedVersions: unsupportedArchives } : {}),
    },
  };
}
