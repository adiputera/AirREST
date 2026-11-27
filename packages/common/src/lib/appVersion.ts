import commonPkg from '../../package.json' with { type: 'json' };

export interface AppVersionSources {
  buildVersion?: string | null;
  manifestVersion?: string | null;
  fallbackVersion?: string | null;
}

function normalizeVersionValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readChromeManifestVersion(): string | null {
  try {
    const runtime = (globalThis as {
      chrome?: {
        runtime?: {
          getManifest?: () => { version?: string; version_name?: string };
        };
      };
    }).chrome?.runtime;
    if (typeof runtime?.getManifest !== 'function') return null;
    const manifest = runtime.getManifest();
    return normalizeVersionValue(manifest?.version_name) ?? normalizeVersionValue(manifest?.version);
  } catch {
    return null;
  }
}

export function resolveAppVersion(sources?: AppVersionSources): string {
  return (
    normalizeVersionValue(sources?.buildVersion) ??
    normalizeVersionValue(sources?.manifestVersion) ??
    normalizeVersionValue(sources?.fallbackVersion) ??
    ''
  );
}

export function formatAppVersionBadge(version: string): string {
  const normalized = normalizeVersionValue(version);
  if (!normalized) return '';
  return /^v/i.test(normalized) ? `v${normalized.slice(1)}` : `v${normalized}`;
}

export function getAppVersion(): string {
  const buildVersion =
    typeof __AIRREST_VERSION__ !== 'undefined' ? __AIRREST_VERSION__ : undefined;

  return resolveAppVersion({
    buildVersion,
    manifestVersion: readChromeManifestVersion(),
    fallbackVersion: commonPkg.version,
  });
}
