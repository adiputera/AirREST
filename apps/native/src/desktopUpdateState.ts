export const PENDING_UPDATE_KEY = 'airrest_desktop_pending_update';
const INSTALLED_UPDATE_KEY = 'airrest_desktop_installed_update';
const DISMISSED_UPDATE_VERSION_KEY = 'airrest_desktop_dismissed_update_version';

export interface UpdateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DesktopUpdateRelease {
  readonly version: string;
  readonly releaseUrl: string;
}

function normalizeVersion(value: string): string | null {
  const version = value.trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
    ? version
    : null;
}

function isGitHubName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
}

function parseReleaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password ||
        url.port || url.search || url.hash || parts.length !== 5 || parts[2] !== 'releases' ||
        parts[3] !== 'tag' || !isGitHubName(parts[0]) || !isGitHubName(parts[1]) || !parts[4]) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function releaseUrlFromDownloadUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password ||
        url.port || url.search || url.hash || parts.length !== 6 || parts[2] !== 'releases' ||
        parts[3] !== 'download' || !isGitHubName(parts[0]) || !isGitHubName(parts[1])) {
      return null;
    }
    const tag = decodeURIComponent(parts[4]);
    if (!tag || tag.length > 200) return null;
    return parseReleaseUrl(`https://github.com/${parts[0]}/${parts[1]}/releases/tag/${encodeURIComponent(tag)}`);
  } catch {
    return null;
  }
}

export function readReleaseUrl(rawJson: Record<string, unknown>): string | null {
  const explicit = parseReleaseUrl(rawJson.release_url);
  if (explicit) return explicit;
  const platforms = rawJson.platforms;
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) return null;
  for (const platform of Object.values(platforms)) {
    if (!platform || typeof platform !== 'object' || Array.isArray(platform)) continue;
    const releaseUrl = releaseUrlFromDownloadUrl((platform as Record<string, unknown>).url);
    if (releaseUrl) return releaseUrl;
  }
  return null;
}

function parseRelease(value: string | null): DesktopUpdateRelease | null {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const version = typeof record.version === 'string' ? normalizeVersion(record.version) : null;
    const releaseUrl = parseReleaseUrl(record.releaseUrl);
    return version && releaseUrl ? { version, releaseUrl } : null;
  } catch {
    return null;
  }
}

function readValue(storage: UpdateStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeValue(storage: UpdateStorage, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeValue(storage: UpdateStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage can be unavailable in private or restricted desktop webviews.
  }
}

export function rememberPendingUpdate(release: DesktopUpdateRelease, storage: UpdateStorage): boolean {
  const version = normalizeVersion(release.version);
  const releaseUrl = parseReleaseUrl(release.releaseUrl);
  return version && releaseUrl
    ? writeValue(storage, PENDING_UPDATE_KEY, JSON.stringify({ version, releaseUrl }))
    : false;
}

export function reconcileInstalledUpdate(runningVersion: string, storage: UpdateStorage): DesktopUpdateRelease | null {
  const running = normalizeVersion(runningVersion);
  const pending = parseRelease(readValue(storage, PENDING_UPDATE_KEY));
  if (!running || !pending || pending.version !== running) return null;
  if (!writeValue(storage, INSTALLED_UPDATE_KEY, JSON.stringify(pending))) return null;
  removeValue(storage, PENDING_UPDATE_KEY);
  return pending;
}

export function readInstalledUpdate(runningVersion: string, storage: UpdateStorage): DesktopUpdateRelease | null {
  const running = normalizeVersion(runningVersion);
  const installed = parseRelease(readValue(storage, INSTALLED_UPDATE_KEY));
  if (!running || !installed || installed.version !== running) return null;
  return readValue(storage, DISMISSED_UPDATE_VERSION_KEY) === installed.version ? null : installed;
}

export function dismissInstalledUpdate(runningVersion: string, storage: UpdateStorage): void {
  const running = normalizeVersion(runningVersion);
  if (running) writeValue(storage, DISMISSED_UPDATE_VERSION_KEY, running);
}
