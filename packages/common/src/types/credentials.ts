/** A credential record is only for native secure storage, never app persistence. */
export interface NativeCredentialRecord {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

/** Identifies one cloud account without including credential material. */
export interface NativeCredentialScope {
  apiUrl: string;
  userId: string;
}

/** Public native-session metadata persisted without credential material. */
export interface NativeCredentialState {
  version: 1;
  scope: NativeCredentialScope;
  /** Keeps legacy credentials only until both old persistence copies are redacted. */
  phase: 'ready' | 'legacy-pending' | 'cleanup-pending';
}

/** Platform-provided protected credential storage. */
export interface NativeCredentialStorage {
  read(scope: NativeCredentialScope): Promise<NativeCredentialRecord | null>;
  write(scope: NativeCredentialScope, record: NativeCredentialRecord): Promise<void>;
  remove(scope: NativeCredentialScope): Promise<void>;
}
