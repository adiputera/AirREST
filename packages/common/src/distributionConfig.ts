import {
  createProductPolicy,
  isProductEdition,
  validateProductPolicy,
  type ProductPolicy,
} from './productPolicy';

export interface ApplicationDistributionConfig {
  readonly backend: Readonly<{
    apiUrl?: string;
    allowCustomUrl: boolean;
  }>;
  readonly auth: Readonly<{
    providerId: string;
  }>;
  readonly workspace: Readonly<{
    policy: ProductPolicy;
  }>;
  readonly updates: Readonly<{
    androidReleaseRepository?: string;
    desktopUpdaterEndpoint?: string;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalRecord(value: Record<string, unknown>, key: string, label: string): Record<string, unknown> | undefined {
  const nested = value[key];
  if (nested === undefined) return undefined;
  if (!isRecord(nested)) throw new Error(`${label} must be an object.`);
  return nested;
}

function readOptionalString(value: Record<string, unknown>, key: string, label: string): string | undefined {
  const nested = value[key];
  if (nested === undefined) return undefined;
  if (typeof nested !== 'string' || nested.trim().length === 0) throw new Error(`${label} must be a non-empty string.`);
  return nested.trim();
}

function readOptionalBoolean(value: Record<string, unknown>, key: string, label: string): boolean | undefined {
  const nested = value[key];
  if (nested === undefined) return undefined;
  if (typeof nested !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return nested;
}

function normalizeUrl(raw: string, label: string, allowLoopbackHttp: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL.`);
  }
  const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(allowLoopbackHttp && parsed.protocol === 'http:' && isLoopback)) {
    throw new Error(`${label} must use HTTPS${allowLoopbackHttp ? ' outside loopback development' : ''}.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} cannot contain credentials, query data, or a fragment.`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function normalizeRepository(raw: string): string {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(raw)) {
    throw new Error('Android release repository must use the owner/repository format.');
  }
  return raw;
}

/**
 * Validates build/startup configuration without reading environment variables.
 * Application entry points own environment access and inject this canonical value.
 */
export function createApplicationDistributionConfig(input: unknown): ApplicationDistributionConfig {
  if (!isRecord(input)) throw new Error('Application distribution configuration must be an object.');

  const workspaceInput = readOptionalRecord(input, 'workspace', 'Workspace configuration');
  const configuredEdition = workspaceInput === undefined
    ? undefined
    : readOptionalString(workspaceInput, 'edition', 'Workspace edition');
  if (configuredEdition !== undefined && !isProductEdition(configuredEdition)) {
    throw new Error(`Unsupported product edition: ${configuredEdition}`);
  }
  const suppliedPolicy = workspaceInput?.policy;
  const policy = suppliedPolicy === undefined
    ? createProductPolicy(configuredEdition ?? 'full')
    : validateProductPolicy(suppliedPolicy);
  if (configuredEdition !== undefined && policy.edition !== configuredEdition) {
    throw new Error('Workspace edition and policy must match.');
  }

  const backendInput = readOptionalRecord(input, 'backend', 'Backend configuration');
  const rawApiUrl = backendInput === undefined
    ? undefined
    : readOptionalString(backendInput, 'apiUrl', 'Backend API URL');
  const apiUrl = rawApiUrl === undefined ? undefined : normalizeUrl(rawApiUrl, 'Backend API URL', true);
  if (!policy.workspace.cloud && apiUrl !== undefined) {
    throw new Error('An offline-only workspace cannot configure a backend API URL.');
  }
  const allowCustomUrl = backendInput === undefined
    ? true
    : readOptionalBoolean(backendInput, 'allowCustomUrl', 'Backend allowCustomUrl') ?? true;

  const authInput = readOptionalRecord(input, 'auth', 'Auth configuration');
  const providerId = authInput === undefined
    ? 'password'
    : readOptionalString(authInput, 'providerId', 'Auth provider ID') ?? 'password';
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(providerId)) {
    throw new Error('Auth provider ID must contain lowercase letters, digits, or hyphens.');
  }

  const updatesInput = readOptionalRecord(input, 'updates', 'Update configuration');
  const rawRepository = updatesInput === undefined
    ? undefined
    : readOptionalString(updatesInput, 'androidReleaseRepository', 'Android release repository');
  const rawEndpoint = updatesInput === undefined
    ? undefined
    : readOptionalString(updatesInput, 'desktopUpdaterEndpoint', 'Desktop updater endpoint');
  const androidReleaseRepository = rawRepository === undefined ? undefined : normalizeRepository(rawRepository);
  const desktopUpdaterEndpoint = rawEndpoint === undefined
    ? undefined
    : normalizeUrl(rawEndpoint, 'Desktop updater endpoint', false);

  return Object.freeze({
    backend: Object.freeze(apiUrl === undefined ? { allowCustomUrl } : { apiUrl, allowCustomUrl }),
    auth: Object.freeze({ providerId }),
    workspace: Object.freeze({ policy }),
    updates: Object.freeze({
      ...(androidReleaseRepository === undefined ? {} : { androidReleaseRepository }),
      ...(desktopUpdaterEndpoint === undefined ? {} : { desktopUpdaterEndpoint }),
    }),
  });
}

/** Revalidates configuration supplied across an application/package boundary. */
export function validateApplicationDistributionConfig(value: unknown): ApplicationDistributionConfig {
  return createApplicationDistributionConfig(value);
}
