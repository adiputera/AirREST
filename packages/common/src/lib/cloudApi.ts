
import { CloudTransport } from '../types/platform';

let injectedCloudTransport: CloudTransport | null = null;

export function setCloudTransport(transport: CloudTransport | null) {
  injectedCloudTransport = transport;
}

export function getCloudTransport(): CloudTransport | null {
  return injectedCloudTransport;
}

async function cloudFetch(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  if (injectedCloudTransport) {
    response = await injectedCloudTransport.fetch(url, {
      method: init.method || 'GET',
      headers: (init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : (init.headers || {})) as Record<string, string>,
      body: init.body,
      signal: (init.signal as AbortSignal) || new AbortController().signal,
    });
  } else {
    response = await fetch(url, {
      ...init,
      redirect: 'manual',
    });
  }

  // Reject redirects to prevent leaking sensitive Authorization / session credentials
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    try {
      if (response.body && !response.bodyUsed) {
        await response.body.cancel();
      }
    } catch {
      // ignore stream cancellation errors
    }
    throw new Error(
      `Cloud server returned an unexpected redirect (HTTP ${response.status || 'opaque'}). ` +
      `Redirects are prohibited for cloud synchronization to prevent credential leakage. Please check your Server URL configuration.`
    );
  }

  return response;
}
import {
  CloudUser,
  CloudWorkspace,
  CloudTeam,
  CloudProject,
  ActiveScope,
  Collection,
  Environment,
} from '../types/api';

export interface TokenRefreshCallback {
  (tokens: { token: string; refreshToken: string; expiresAt?: string; previousRefreshToken?: string }): void;
}

export interface AuthEvictedCallback {
  (reason: string, failedToken?: string): void;
}

const tokenRefreshListeners = new Set<TokenRefreshCallback>();
const authEvictedListeners = new Set<AuthEvictedCallback>();

export function registerTokenRefreshCallback(cb: TokenRefreshCallback | null): () => void {
  if (!cb) return () => {};
  tokenRefreshListeners.add(cb);
  return () => {
    tokenRefreshListeners.delete(cb);
  };
}

export function registerAuthEvictedCallback(cb: AuthEvictedCallback | null): () => void {
  if (!cb) return () => {};
  authEvictedListeners.add(cb);
  return () => {
    authEvictedListeners.delete(cb);
  };
}

function notifyTokenRefreshed(tokens: {
  token: string;
  refreshToken: string;
  expiresAt?: string;
  previousRefreshToken?: string;
}) {
  for (const listener of tokenRefreshListeners) {
    try {
      listener(tokens);
    } catch {
      // Ignore listener error to protect notification cycle
    }
  }
}

function notifyAuthEvicted(reason: string, failedToken?: string) {
  for (const listener of authEvictedListeners) {
    try {
      listener(reason, failedToken);
    } catch {
      // Ignore listener error to protect notification cycle
    }
  }
}

/**
 * Normalizes a cloud API URL.
 * Preserves explicitly provided http:// or https:// schemes.
 * For scheme-less inputs, loopback hosts default to http:// while remote hosts default to https://.
 */
export function normalizeCloudApiUrl(rawUrl?: string): string {
  const trimmed = (rawUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) return 'http://localhost:8080';

  const hasExplicitScheme = /^https?:\/\//i.test(trimmed);
  const candidate = hasExplicitScheme ? trimmed : `http://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.toLowerCase();
    const isLoopback =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1';

    if (!hasExplicitScheme) {
      parsed.protocol = isLoopback ? 'http:' : 'https:';
    }

    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return trimmed;
  }
}

export interface ApiFetchOptions extends RequestInit {
  apiUrl: string;
  token?: string;
  refreshToken?: string;
}

const IDENTITY_REQUEST_LIMIT = 4 * 1024 * 1024;
const GZIP_REQUEST_LIMIT = 3_000_000;
const GZIP_DECODED_REQUEST_LIMIT = 16 * 1024 * 1024;
const GZIP_DECODED_RESPONSE_LIMIT = 16 * 1024 * 1024;
const GZIP_THRESHOLD = 64 * 1024;

function supportsGzipRequest(endpoint: string): boolean {
  const path = endpoint.split('?', 1)[0];
  return path === '/api/v1/sync/push' || path === '/api/v1/sync/import-batch';
}

async function gzipRequestBody(body: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
  if (signal?.aborted) {
    throw new Error('The request was aborted before compression completed.');
  }
  const source = new Blob([body]).stream();
  const reader = source.pipeThrough(new CompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelCompression = () => {
    void reader.cancel();
  };
  signal?.addEventListener('abort', cancelCompression, { once: true });

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error('The request was aborted before compression completed.');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > GZIP_REQUEST_LIMIT) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    signal?.removeEventListener('abort', cancelCompression);
    reader.releaseLock();
  }

  const compressed = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(compressed).arrayBuffer();
}

async function prepareRequestBody(endpoint: string, body: BodyInit | null | undefined, signal?: AbortSignal): Promise<{ body: BodyInit | null | undefined; gzip: boolean }> {
  if (typeof body !== 'string') return { body, gzip: false };
  const decodedSize = new TextEncoder().encode(body).byteLength;
  if (decodedSize > GZIP_DECODED_REQUEST_LIMIT) {
    throw new Error('This request exceeds the 16 MiB decoded transfer limit.');
  }
  if (decodedSize < GZIP_THRESHOLD || !supportsGzipRequest(endpoint)) {
    if (decodedSize > IDENTITY_REQUEST_LIMIT) {
      throw new Error('This request exceeds the 4 MiB limit. Reduce its size or import fewer collections.');
    }
    return { body, gzip: false };
  }
  if (typeof CompressionStream === 'undefined') {
    if (decodedSize <= IDENTITY_REQUEST_LIMIT) return { body, gzip: false };
    throw new Error('This request is too large for this client because gzip compression is unavailable.');
  }
  const compressed = await gzipRequestBody(body, signal);
  if (compressed === null) {
    if (decodedSize <= IDENTITY_REQUEST_LIMIT) return { body, gzip: false };
    throw new Error('This request exceeds the 3 MB gzip transfer limit.');
  }
  if (compressed.byteLength >= decodedSize && decodedSize <= IDENTITY_REQUEST_LIMIT) {
    return { body, gzip: false };
  }
  return { body: compressed, gzip: true };
}

function unwrapData<T>(json: any): T {
  if (json && typeof json === 'object' && 'data' in json && json.data !== undefined) {
    return json.data as T;
  }
  return json as T;
}

function extractError(json: any, fallback: string, status?: number): string {
  if (typeof json?.error === 'string') return json.error;
  if (json?.error?.message) return json.error.message;
  if (json?.message) return json.message;
  if (status) return `${fallback} (HTTP ${status})`;
  return fallback;
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

class CloudResponseTooLargeError extends Error {
  constructor() {
    super('The cloud response exceeds the 16 MiB decoded transfer limit.');
    this.name = 'CloudResponseTooLargeError';
  }
}

async function readSuccessfulJson(res: Response): Promise<unknown> {
  if (!res.body) {
    throw new Error('Cloud response contains invalid JSON.');
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > GZIP_DECODED_RESPONSE_LIMIT) {
        await reader.cancel();
        throw new CloudResponseTooLargeError();
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Cloud response contains invalid JSON.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Robust fetch wrapper that automatically handles Bearer authorization and
 * silent token refresh upon encountering 401 Unauthorized / TOKEN_EXPIRED.
 */
export async function fetchWithAuth(
  endpoint: string,
  options: ApiFetchOptions
): Promise<Response> {
  const { apiUrl, token, refreshToken, ...fetchInit } = options;
  const requestBody = await prepareRequestBody(endpoint, fetchInit.body, fetchInit.signal as AbortSignal | undefined);
  const base = normalizeCloudApiUrl(apiUrl);
  const url = `${base}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;

  const headers = new Headers(fetchInit.headers || {});
  headers.set('Content-Type', 'application/json');
  headers.delete('Content-Encoding');
  if (requestBody.gzip) headers.set('Content-Encoding', 'gzip');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const requestInit = { ...fetchInit, body: requestBody.body, headers };
  let response = await cloudFetch(url, requestInit);

  // If 401 Unauthorized, attempt background refresh if refreshToken is available
  if (response.status === 401 && refreshToken) {
    try {
      const result = await handleSilentRefresh(base, refreshToken);
      if (result.token) {
        headers.set('Authorization', `Bearer ${result.token}`);
        // Retry the original request
        response = await cloudFetch(url, requestInit);
        if (response.status === 401) notifyAuthEvicted('Your session has expired or been revoked. Please sign in again.', result.token);
      } else if (result.evicted) {
        notifyAuthEvicted('Your session has expired or been revoked. Please sign in again.', token);
      }
    } catch {
      // Network or transient error during refresh attempt - do not evict session
    }
  } else if (response.status === 401 && !refreshToken) {
    notifyAuthEvicted('Your session has expired or been revoked. Please sign in again.', token);
  }

  return response;
}

interface SilentRefreshResult {
  token: string | null;
  evicted: boolean;
}

const refreshRequests = new Map<string, Promise<SilentRefreshResult>>();

async function handleSilentRefresh(apiUrl: string, refreshTokenStr: string): Promise<SilentRefreshResult> {
  const base = normalizeCloudApiUrl(apiUrl);
  const key = `${base}:::${refreshTokenStr}`;
  const pending = refreshRequests.get(key);
  if (pending) return pending;

  const refreshPromise = (async (): Promise<SilentRefreshResult> => {
    try {
      const res = await cloudFetch(`${base}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshTokenStr }),
      });

      if (res.status === 401 || res.status === 403) {
        return { token: null, evicted: true };
      }

      if (!res.ok) {
        return { token: null, evicted: false };
      }

      const json = await safeJson(res);
      const data = unwrapData<any>(json);
      if (data && data.token && data.refresh_token) {
        notifyTokenRefreshed({
          token: data.token,
          refreshToken: data.refresh_token,
          expiresAt: data.expires_at,
          previousRefreshToken: refreshTokenStr,
        });
        return { token: data.token as string, evicted: false };
      }
      return { token: null, evicted: false };
    } catch {
      return { token: null, evicted: false };
    } finally {
      refreshRequests.delete(key);
    }
  })();

  refreshRequests.set(key, refreshPromise);
  return refreshPromise;
}

// ----------------- Auth Endpoints -----------------

export async function loginUser(apiUrl: string, email: string, password: string) {
  const base = normalizeCloudApiUrl(apiUrl);
  const res = await cloudFetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Login failed', res.status));
  }
  return unwrapData<{
    user: CloudUser;
    token: string;
    refresh_token: string;
    expires_at: string;
  }>(json);
}

export async function registerUser(apiUrl: string, email: string, password: string, name: string) {
  const base = normalizeCloudApiUrl(apiUrl);
  const res = await cloudFetch(`${base}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });

  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Registration failed', res.status));
  }
  return unwrapData<{
    user: CloudUser;
    token: string;
    refresh_token: string;
    expires_at: string;
  }>(json);
}

export async function getCurrentUser(apiUrl: string, token: string, refreshToken?: string) {
  const res = await fetchWithAuth('/api/v1/auth/me', { apiUrl, token, refreshToken });
  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to fetch current user', res.status));
  }
  return unwrapData<CloudUser>(json);
}

export async function changeUserPassword(
  apiUrl: string,
  currentPassword: string,
  newPassword: string,
  token?: string,
  refreshToken?: string
): Promise<{
  user: CloudUser;
  token: string;
  refresh_token: string;
  expires_at: string;
}> {
  const res = await fetchWithAuth('/api/v1/auth/password', {
    method: 'PUT',
    apiUrl,
    token,
    refreshToken,
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
    }),
  });

  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to update password', res.status));
  }
  return unwrapData<{
    user: CloudUser;
    token: string;
    refresh_token: string;
    expires_at: string;
  }>(json);
}

// ----------------- Workspaces & Teams -----------------

export async function fetchUserWorkspaces(apiUrl: string, token: string, refreshToken?: string, signal?: AbortSignal) {
  const res = await fetchWithAuth('/api/v1/workspaces', { apiUrl, token, refreshToken, signal });
  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to fetch workspaces', res.status));
  }
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as CloudWorkspace[];
}

export async function fetchUserTeams(apiUrl: string, token: string, refreshToken?: string, signal?: AbortSignal) {
  const res = await fetchWithAuth('/api/v1/teams', { apiUrl, token, refreshToken, signal });
  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to fetch teams', res.status));
  }
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as CloudTeam[];
}

export async function fetchTeamProjects(apiUrl: string, teamId: string, token: string, refreshToken?: string, signal?: AbortSignal) {
  const res = await fetchWithAuth(`/api/v1/teams/${teamId}/projects`, { apiUrl, token, refreshToken, signal });
  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to fetch team projects', res.status));
  }
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as CloudProject[];
}

// ----------------- Batch Import -----------------

export async function batchImportToScope(
  apiUrl: string,
  token: string,
  scope: ActiveScope | { id: string; type: 'workspace' | 'project' } | string,
  collections: Collection[],
  refreshToken?: string,
  signal?: AbortSignal
) {
  if (collections.length > 100) throw new Error('Select at most 100 collections per import.');
  let itemCount = 0;
  const checkItems = (items: Collection['items'] | undefined, depth: number): void => {
    if (!items?.length) return;
    itemCount += items.length;
    if (depth > 32 || itemCount > 5000) throw new Error('Imports support up to 5,000 items and 32 folder levels. Split or flatten this import.');
    for (const item of items) checkItems(item.items, depth + 1);
  };
  for (const collection of collections) checkItems(collection.items, 1);
  const formattedCollections = collections.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description || '',
    items: (c.items || []).map(formatImportItem),
  }));

  const payload: any = {
    collections: formattedCollections,
  };

  if (typeof scope === 'string') {
    payload.workspace_id = scope;
  } else if (scope.type === 'workspace') {
    payload.workspace_id = scope.id;
  } else {
    payload.project_id = scope.id;
  }

  const res = await fetchWithAuth('/api/v1/sync/import-batch', {
    method: 'POST',
    apiUrl,
    token,
    refreshToken,
    signal,
    body: JSON.stringify(payload),
  });

  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Batch import failed', res.status));
  }
  return unwrapData<any>(json);
}

export async function moveScopeCollection(
  apiUrl: string,
  token: string,
  collectionId: string,
  targetScope: ActiveScope,
  refreshToken?: string,
  signal?: AbortSignal
) {
  const payload: any = {};
  if (targetScope.type === 'workspace') {
    payload.target_workspace_id = targetScope.id;
  } else {
    payload.target_project_id = targetScope.id;
  }

  const res = await fetchWithAuth(`/api/v1/collections/${collectionId}/move`, {
    method: 'POST',
    apiUrl,
    token,
    refreshToken,
    signal,
    body: JSON.stringify(payload),
  });

  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to move collection', res.status));
  }
  return unwrapData<any>(json);
}

export interface ReorderItemPayload {
  id: string;
  parent_id: string | null;
  sort_order: number;
}

export async function reorderCollectionItems(
  apiUrl: string,
  token: string,
  collectionId: string,
  items: ReorderItemPayload[],
  refreshToken?: string,
  signal?: AbortSignal
) {
  const res = await fetchWithAuth(`/api/v1/collections/${collectionId}/reorder`, {
    method: 'PUT',
    apiUrl,
    token,
    refreshToken,
    signal,
    body: JSON.stringify({ items }),
  });

  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to reorder collection items', res.status));
  }
  return unwrapData<any>(json);
}

function formatImportItem(item: any): any {
  return {
    id: item.id,
    type: item.type || 'request',
    name: item.name,
    method: item.request?.method || 'GET',
    url: item.request?.url || '',
    params: item.request?.params || [],
    headers: item.request?.headers || [],
    auth: item.request?.auth || { type: 'none' },
    body_type: item.request?.bodyType || 'none',
    raw_type: item.request?.rawType || 'text',
    body_content: item.request?.bodyContent || '',
    graphql_query: item.request?.graphqlQuery || '',
    graphql_variables: item.request?.graphqlVariables || '',
    body_form_data: item.request?.bodyType === 'x-www-form-urlencoded'
      ? item.request?.bodyUrlEncoded || []
      : item.request?.bodyFormData || [],
    pre_request_script: item.request?.preRequestScript || '',
    post_response_script: item.request?.postResponseScript || '',
    items: (item.items || []).map(formatImportItem),
  };
}

// ----------------- Environment Endpoints -----------------

export async function createScopeEnvironment(
  apiUrl: string,
  token: string,
  scope: ActiveScope,
  env: { name: string; variables: any[]; min_role?: string },
  refreshToken?: string,
  signal?: AbortSignal
) {
  const payload: any = {
    name: env.name,
    variables: env.variables,
    min_role: env.min_role || 'reader',
  };

  if (scope.type === 'workspace') {
    payload.workspace_id = scope.id;
  } else {
    payload.project_id = scope.id;
  }

  const res = await fetchWithAuth('/api/v1/environments', {
    method: 'POST',
    apiUrl,
    token,
    refreshToken,
    signal,
    body: JSON.stringify(payload),
  });

  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to create environment', res.status));
  }
  return unwrapData<any>(json);
}

export async function updateScopeEnvironment(
  apiUrl: string,
  token: string,
  envId: string,
  updates: { name?: string; variables?: any[]; min_role?: string; base_version?: number },
  refreshToken?: string,
  signal?: AbortSignal
) {
  const payload: any = {
    name: updates.name,
    variables: updates.variables,
    min_role: updates.min_role,
  };
  if (typeof updates.base_version === 'number' && updates.base_version > 0) {
    payload.base_version = updates.base_version;
  }

  const res = await fetchWithAuth(`/api/v1/environments/${envId}`, {
    method: 'PUT',
    apiUrl,
    token,
    refreshToken,
    signal,
    body: JSON.stringify(payload),
  });

  const json = await safeJson(res);
  if (!res.ok) {
    const errorMsg = extractError(json, 'Failed to update environment', res.status);
    const err: any = new Error(errorMsg);
    err.status = res.status;
    err.data = json?.data;
    throw err;
  }
  return unwrapData<any>(json);
}

export async function deleteScopeEnvironment(
  apiUrl: string,
  token: string,
  envId: string,
  refreshToken?: string,
  signal?: AbortSignal
) {
  const res = await fetchWithAuth(`/api/v1/environments/${envId}`, {
    method: 'DELETE',
    apiUrl,
    token,
    refreshToken,
    signal,
  });

  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to delete environment', res.status));
  }
  return unwrapData<any>(json);
}

export async function deleteScopeCollection(
  apiUrl: string,
  token: string,
  collectionId: string,
  refreshToken?: string,
  signal?: AbortSignal
) {
  const res = await fetchWithAuth(`/api/v1/collections/${collectionId}`, {
    method: 'DELETE',
    apiUrl,
    token,
    refreshToken,
    signal,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to delete collection'));
  }
  return unwrapData<any>(json);
}

export async function deleteScopeItem(
  apiUrl: string,
  token: string,
  itemId: string,
  refreshToken?: string,
  signal?: AbortSignal
) {
  const res = await fetchWithAuth(`/api/v1/items/${itemId}`, {
    method: 'DELETE',
    apiUrl,
    token,
    refreshToken,
    signal,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to delete item'));
  }
  return unwrapData<any>(json);
}

/**
 * Fetches lightweight collection list (id, name, description, min_role, version, etc.)
 * without heavy items payload to prevent Vercel FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE.
 */
export async function fetchScopeCollections(
  apiUrl: string,
  token: string,
  scope: ActiveScope,
  refreshToken?: string,
  signal?: AbortSignal
): Promise<any[]> {
  const query = new URLSearchParams();
  if (scope.type === 'workspace') {
    query.set('workspace_id', scope.id);
  } else {
    query.set('project_id', scope.id);
  }

  const res = await fetchWithAuth(`/api/v1/collections?${query.toString()}`, {
    apiUrl,
    token,
    refreshToken,
    signal,
  });

  const json = res.ok ? await readSuccessfulJson(res) : await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to fetch collections', res.status));
  }
  const data = unwrapData<any>(json);
  if (!Array.isArray(data)) {
    throw new Error('Cloud response contains an invalid collection list.');
  }
  return data as any[];
}

/**
 * Fetches a single collection by ID including all its items.
 * Allows pulling large project collections 1-by-1 without overflowing serverless limits.
 */
export async function fetchCollectionById(
  apiUrl: string,
  token: string,
  collectionId: string,
  refreshToken?: string,
  signal?: AbortSignal
): Promise<any> {
  const res = await fetchWithAuth(`/api/v1/collections/${collectionId}`, {
    apiUrl,
    token,
    refreshToken,
    signal,
  });

  const json = res.ok ? await readSuccessfulJson(res) : await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to fetch collection', res.status));
  }
  const data = unwrapData<unknown>(json);
  if (!isRecord(data) || typeof data.id !== 'string') {
    throw new Error('Cloud response contains an invalid collection detail.');
  }
  return data;
}

/**
 * Fetches environments belonging to a specific workspace or project scope.
 */
export async function fetchScopeEnvironments(
  apiUrl: string,
  token: string,
  scope: ActiveScope,
  refreshToken?: string,
  signal?: AbortSignal
): Promise<any[]> {
  const query = new URLSearchParams();
  if (scope.type === 'workspace') {
    query.set('workspace_id', scope.id);
  } else {
    query.set('project_id', scope.id);
  }

  const res = await fetchWithAuth(`/api/v1/environments?${query.toString()}`, {
    apiUrl,
    token,
    refreshToken,
    signal,
  });

  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to fetch environments', res.status));
  }
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as any[];
}
