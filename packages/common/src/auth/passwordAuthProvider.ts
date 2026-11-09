import { loginUser } from '../lib/cloudApi';
import type { AuthProvider, AuthSignInRequest } from './types';

export function createPasswordAuthProvider(login: typeof loginUser = loginUser): AuthProvider {
  return Object.freeze({
    id: 'password',
    capabilities: Object.freeze({
      passwordCredentials: true,
      editableProfile: true,
      passwordChange: true,
    }),
    async signIn({ apiUrl, email, password, signal }: AuthSignInRequest) {
      const normalizedEmail = email?.trim();
      if (!normalizedEmail || !password) {
        throw new Error('Email and password are required.');
      }

      const session = await login(apiUrl, normalizedEmail, password, signal);
      return {
        user: session.user,
        accessToken: session.token,
        refreshToken: session.refresh_token,
        expiresAt: session.expires_at,
      };
    },
  });
}

export const passwordAuthProvider = createPasswordAuthProvider();
