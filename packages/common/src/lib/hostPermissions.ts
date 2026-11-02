function getChromePermissions(): any {
  if (typeof globalThis !== 'undefined' && (globalThis as any).chrome?.permissions) {
    return (globalThis as any).chrome.permissions;
  }
  return undefined;
}

export function getHostPermissionPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

export async function hasHostPermission(url: string): Promise<boolean | null> {
  const origin = getHostPermissionPattern(url);
  if (!origin) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
      }
    } catch {
      return false;
    }
    return null;
  }
  const permissions = getChromePermissions();
  if (!permissions?.contains) return null;
  try {
    return await permissions.contains({ origins: [origin] });
  } catch {
    return null;
  }
}

export async function requestHostPermission(url: string): Promise<boolean> {
  const origin = getHostPermissionPattern(url);
  const permissions = getChromePermissions();
  if (!origin || !permissions?.request) return false;
  try {
    return await permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}
