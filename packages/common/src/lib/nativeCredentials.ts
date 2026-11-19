import type { CloudConfig } from '../types/api';
import type { NativeCredentialRecord, NativeCredentialScope } from '../types/credentials';

const CREDENTIAL_VERSION = 1;

interface PersistedCredentialRecord extends NativeCredentialRecord {
  version: number;
}

export function getNativeCredentialScope(config: Pick<CloudConfig, 'apiUrl' | 'user'>): NativeCredentialScope | null {
  const apiUrl = config.apiUrl?.trim();
  const userId = config.user?.id?.trim();
  if (!apiUrl || !userId) return null;
  return { apiUrl, userId };
}

export function sameNativeCredentialScope(
  left: NativeCredentialScope | null | undefined,
  right: NativeCredentialScope | null | undefined,
): boolean {
  return Boolean(left && right && left.apiUrl === right.apiUrl && left.userId === right.userId);
}

export function serializeNativeCredential(record: NativeCredentialRecord): string {
  if (!record.accessToken.trim()) throw new Error('Cannot store an empty access token.');
  if (record.refreshToken !== undefined && !record.refreshToken.trim()) {
    throw new Error('Cannot store an empty refresh token.');
  }
  return JSON.stringify({ version: CREDENTIAL_VERSION, ...record } satisfies PersistedCredentialRecord);
}

export function parseNativeCredential(value: string): NativeCredentialRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('The protected credential record is malformed.');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('The protected credential record is malformed.');
  const record = parsed as Partial<PersistedCredentialRecord>;
  if (record.version !== CREDENTIAL_VERSION || typeof record.accessToken !== 'string' || !record.accessToken.trim()) {
    throw new Error('The protected credential record has an unsupported format.');
  }
  if (record.refreshToken !== undefined && typeof record.refreshToken !== 'string') {
    throw new Error('The protected credential record has an invalid refresh token.');
  }
  if (record.expiresAt !== undefined && typeof record.expiresAt !== 'string') {
    throw new Error('The protected credential record has an invalid expiry time.');
  }
  return {
    accessToken: record.accessToken,
    ...(record.refreshToken !== undefined ? { refreshToken: record.refreshToken } : {}),
    ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
  };
}
