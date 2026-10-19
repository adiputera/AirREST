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
    const jsonPayload = decodeURIComponent(
      atob(base64)
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
