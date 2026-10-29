import {
  CloudUser,
  CloudWorkspace,
  CloudTeam,
  CloudProject,
  ActiveScope,
  Collection,
  Environment,
} from '@/types/api';

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

async function cloudFetch(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    redirect: 'manual',
  });

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

/**
 * Robust fetch wrapper that automatically handles Bearer authorization and
 * silent token refresh upon encountering 401 Unauthorized / TOKEN_EXPIRED.
 */
export async function fetchWithAuth(
  endpoint: string,
  options: ApiFetchOptions
): Promise<Response> {
  const { apiUrl, token, refreshToken, ...fetchInit } = options;
  if (typeof fetchInit.body === 'string' && new TextEncoder().encode(fetchInit.body).byteLength > 4 * 1024 * 1024) {
    throw new Error('This request exceeds the 4 MiB limit. Reduce its size or import fewer collections.');
  }
  const base = normalizeCloudApiUrl(apiUrl);
  const url = `${base}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;

  const headers = new Headers(fetchInit.headers || {});
  headers.set('Content-Type', 'application/json');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response = await cloudFetch(url, { ...fetchInit, headers });

  // If 401 Unauthorized, attempt background refresh if refreshToken is available
  if (response.status === 401 && refreshToken) {
    try {
      const result = await handleSilentRefresh(base, refreshToken);
      if (result.token) {
        headers.set('Authorization', `Bearer ${result.token}`);
        // Retry the original request
        response = await cloudFetch(url, { ...fetchInit, headers });
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

  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to fetch collections', res.status));
  }
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as any[];
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

  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to fetch collection', res.status));
  }
  return unwrapData<any>(json);
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
