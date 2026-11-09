import type { CloudUser } from '../types/api';
import type { CloudRequestAuthorizer } from '../lib/cloudApi';

export interface AuthSession {
  user: CloudUser;
  /** Omitted by providers that authorize through a cookie or platform session. */
  accessToken?: string;
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

export interface AuthSignOutRequest {
  apiUrl: string;
  user?: CloudUser;
  accessToken?: string;
  refreshToken?: string;
}

/**
 * Product-facing authentication boundary. Implementations may use password
 * credentials, a browser redirect, a native broker, or a cookie-backed BFF.
 */
export interface AuthProvider {
  readonly id: string;
  readonly capabilities: AuthProviderCapabilities;
  signIn(request: AuthSignInRequest): Promise<AuthSession>;
  signOut?(request: AuthSignOutRequest): Promise<void>;
  /** Overrides password refresh for providers with their own request protocol. */
  authorizeRequest?: CloudRequestAuthorizer;
}
