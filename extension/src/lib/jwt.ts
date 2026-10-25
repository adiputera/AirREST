export interface JwtClaims {
  user_id?: string;
  email?: string;
  role?: string;
  token_type?: string;
  exp?: number;
  iat?: number;
  [key: string]: any;
}

/**
 * Decodes the payload of a JWT without external dependencies.
 *
 * @param token The raw JWT string.
 * @return The parsed claims object, or null if invalid.
 */
export function parseJwt(token?: string | null): JwtClaims | null {
  if (!token || typeof token !== 'string') return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
    const jsonPayload = decodeURIComponent(
      atob(padded)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch {
    return null;
  }
}

/**
 * Extracts the user role directly from a JWT token.
 *
 * @param token The raw JWT string.
 * @return The role string or null.
 */
export function getRoleFromJwt(token?: string | null): string | null {
  const claims = parseJwt(token);
  return claims?.role || null;
}

export const ROLE_RANK: Record<string, number> = {
  admin: 4,
  owner: 4,
  maintainer: 3,
  contributor: 2,
  reader: 1,
};

export const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ['*'],
  owner: ['*'],
  maintainer: [
    'collection:read',
    'collection:write',
    'collection:delete',
    'collection:move',
    'env:read',
    'env:write',
    'env:delete',
  ],
  contributor: [
    'collection:read',
    'collection:write',
    'env:read',
    'env:write',
  ],
  reader: [
    'collection:read',
    'env:read',
  ],
};

/**
 * Checks whether the current user in the active scope has the required granular permission.
 * Supports wildcard '*', array checks, and fallbacks to role mappings.
 *
 * @param scope The active scope object (may have role and/or permissions array)
 * @param permission The required permission capability string (e.g. 'collection:write')
 * @param workspaceMode 'offline' or 'cloud'
 * @param userRole System user role from auth token (e.g. 'superadmin')
 */
export function hasScopePermission(
  scope?: { type?: string; role?: string; permissions?: string[] } | null,
  permission?: string,
  workspaceMode?: string,
  userRole?: string
): boolean {
  if (workspaceMode === 'offline') return true;
  if (!scope || scope.type === 'offline_workspace' || scope.type === 'workspace') return true;
  const normalizedUserRole = userRole?.toLowerCase();
  if (normalizedUserRole === 'superadmin' || normalizedUserRole === 'admin') return true;
  if (!permission) return true;

  // 1. Direct capability permissions array check
  if (Array.isArray(scope.permissions) && scope.permissions.length > 0) {
    return scope.permissions.includes('*') || scope.permissions.includes(permission);
  }

  // 2. Fallback to role-based capabilities mapping
  const role = (scope.role || 'reader').toLowerCase();
  const rolePerms = DEFAULT_ROLE_PERMISSIONS[role] || DEFAULT_ROLE_PERMISSIONS.reader;
  return rolePerms.includes('*') || rolePerms.includes(permission);
}

export function getUserScopeRank(
  workspaceMode: string,
  activeScope?: { type?: string; role?: string } | null,
  token?: string | null,
  user?: { role?: string } | null
): number {
  if (workspaceMode === 'offline') return 4;
  const jwtRole = getRoleFromJwt(token)?.toLowerCase();
  const userRoleStr = user?.role?.toLowerCase();
  if (
    jwtRole === 'superadmin' ||
    jwtRole === 'admin' ||
    userRoleStr === 'superadmin' ||
    userRoleStr === 'admin'
  ) {
    return 4;
  }
  if (!activeScope || activeScope.type === 'workspace' || activeScope.type === 'offline_workspace') {
    return 4;
  }
  const role = (activeScope.role || 'reader').toLowerCase();
  return ROLE_RANK[role] || 1;
}

/**
 * Determines if the current user has capability permissions to modify a collection.
 * Purely permission-driven: evaluates 'collection:write' and granular minRole requirements.
 * Supports modern (minRole, scope, workspaceMode, userRole) and legacy (userRank, minRole, ...) signatures.
 */
export function canModifyCollection(
  firstArg?: number | string | null,
  secondArg?: string | { type?: string; role?: string; permissions?: string[] } | null,
  thirdArg?: { type?: string; role?: string; permissions?: string[] } | string | null,
  fourthArg?: string,
  fifthArg?: string
): boolean {
  let minRole: string | undefined;
  let scope: { type?: string; role?: string; permissions?: string[] } | null | undefined;
  let workspaceMode: string | undefined;
  let userRole: string | undefined;

  if (typeof firstArg === 'number') {
    minRole = typeof secondArg === 'string' ? secondArg : undefined;
    scope = thirdArg as any;
    workspaceMode = fourthArg;
    userRole = fifthArg;
  } else {
    minRole = typeof firstArg === 'string' ? firstArg : undefined;
    scope = secondArg as any;
    workspaceMode = thirdArg as string;
    userRole = fourthArg;
  }

  if (workspaceMode === 'offline') return true;
  if (!scope || scope.type === 'offline_workspace' || scope.type === 'workspace') return true;

  // 1. Base permission: Must have collection:write capability
  if (!hasScopePermission(scope, 'collection:write', workspaceMode, userRole)) {
    return false;
  }

  // 2. Resource-level access requirement mapping
  const normalized = (minRole || 'reader').toLowerCase();
  if (normalized === 'admin') {
    return hasScopePermission(scope, '*', workspaceMode, userRole);
  }
  if (normalized === 'maintainer') {
    return hasScopePermission(scope, 'collection:delete', workspaceMode, userRole);
  }
  return true;
}

/**
 * Determines if the current user has capability permissions to modify an environment.
 * Purely permission-driven: evaluates 'env:write' and granular minRole requirements.
 */
export function canModifyEnvironment(
  envMinRole?: string,
  scope?: { type?: string; role?: string; permissions?: string[] } | null,
  workspaceMode?: string,
  userRole?: string
): boolean {
  if (workspaceMode === 'offline') return true;
  if (!scope || scope.type === 'offline_workspace' || scope.type === 'workspace') return true;

  // 1. Base permission: Must have env:write capability
  if (!hasScopePermission(scope, 'env:write', workspaceMode, userRole)) {
    return false;
  }

  // 2. Resource-level access requirement mapping
  const normalized = (envMinRole || 'reader').toLowerCase();
  if (normalized === 'admin') {
    return hasScopePermission(scope, '*', workspaceMode, userRole);
  }
  if (normalized === 'maintainer') {
    return hasScopePermission(scope, 'env:delete', workspaceMode, userRole);
  }
  return true;
}
