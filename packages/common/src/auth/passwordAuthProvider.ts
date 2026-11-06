import { loginUser } from '../lib/cloudApi';
import type { AuthProvider, AuthSignInRequest } from './types';

export const passwordAuthProvider: AuthProvider = Object.freeze({
  id: 'password',
  capabilities: Object.freeze({
    passwordCredentials: true,
    editableProfile: true,
    passwordChange: true,
  }),
  async signIn({ apiUrl, email, password }: AuthSignInRequest) {
    const normalizedEmail = email?.trim();
    if (!normalizedEmail || !password) {
      throw new Error('Email and password are required.');
    }

    const session = await loginUser(apiUrl, normalizedEmail, password);
    return {
      user: session.user,
      accessToken: session.token,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at,
    };
  },
});
