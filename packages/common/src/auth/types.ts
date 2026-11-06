import type { CloudUser } from '../types/api';

export interface AuthSession {
  user: CloudUser;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface AuthSignInRequest {
  apiUrl: string;
  email?: string;
  password?: string;
  signal?: AbortSignal;
}

export interface AuthProviderCapabilities {
  readonly passwordCredentials: boolean;
  readonly editableProfile: boolean;
  readonly passwordChange: boolean;
}

/**
 * Product-facing authentication boundary. Implementations may use password
 * credentials, a browser redirect, a native broker, or a cookie-backed BFF.
 */
export interface AuthProvider {
  readonly id: string;
  readonly capabilities: AuthProviderCapabilities;
  signIn(request: AuthSignInRequest): Promise<AuthSession>;
}
