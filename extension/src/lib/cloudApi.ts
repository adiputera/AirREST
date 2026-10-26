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
  (tokens: { token: string; refreshToken: string; expiresAt: string; previousRefreshToken: string }): void;
}

export interface AuthEvictedCallback {
  (reason: string): void;
}

let onTokenRefreshed: TokenRefreshCallback | null = null;
let onAuthEvicted: AuthEvictedCallback | null = null;
let isRefreshing = false;

export function registerTokenRefreshCallback(cb: TokenRefreshCallback | null) {
  onTokenRefreshed = cb;
}

export function registerAuthEvictedCallback(cb: AuthEvictedCallback | null) {
  onAuthEvicted = cb;
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
  const url = `${apiUrl.replace(/\/+$/, '')}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;

  const headers = new Headers(fetchInit.headers || {});
  headers.set('Content-Type', 'application/json');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response = await fetch(url, { ...fetchInit, headers });

  // If 401 Unauthorized, attempt background refresh if refreshToken is available
  if (response.status === 401 && refreshToken) {
    try {
      const result = await handleSilentRefresh(apiUrl, refreshToken);
      if (result.token) {
        headers.set('Authorization', `Bearer ${result.token}`);
        // Retry the original request
        response = await fetch(url, { ...fetchInit, headers });
        if (response.status === 401) onAuthEvicted?.('Your session has expired or been revoked. Please sign in again.');
      } else if (result.evicted) {
        if (onAuthEvicted) {
          onAuthEvicted('Your session has expired or been revoked. Please sign in again.');
        }
      }
    } catch {
      // Network or transient error during refresh attempt - do not evict session
    }
  } else if (response.status === 401 && !refreshToken) {
    if (onAuthEvicted) {
      onAuthEvicted('Your session has expired or been revoked. Please sign in again.');
    }
  }

  return response;
}

interface SilentRefreshResult {
  token: string | null;
  evicted: boolean;
}

let refreshPromise: Promise<SilentRefreshResult> | null = null;

async function handleSilentRefresh(apiUrl: string, refreshTokenStr: string): Promise<SilentRefreshResult> {
  if (isRefreshing && refreshPromise) {
    return refreshPromise;
  }

  isRefreshing = true;
  refreshPromise = (async (): Promise<SilentRefreshResult> => {
    try {
      const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/v1/auth/refresh`, {
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
        if (onTokenRefreshed) {
          onTokenRefreshed({
            token: data.token,
            refreshToken: data.refresh_token,
            expiresAt: data.expires_at,
            previousRefreshToken: refreshTokenStr,
          });
        }
        return { token: data.token as string, evicted: false };
      }
      return { token: null, evicted: false };
    } catch {
      return { token: null, evicted: false };
    } finally {
      isRefreshing = false;
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// ----------------- Auth Endpoints -----------------

export async function loginUser(apiUrl: string, email: string, password: string) {
  const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/v1/auth/login`, {
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
  const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/v1/auth/register`, {
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

export async function fetchUserWorkspaces(apiUrl: string, token: string, refreshToken?: string) {
  const res = await fetchWithAuth('/api/v1/workspaces', { apiUrl, token, refreshToken });
  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to fetch workspaces', res.status));
  }
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as CloudWorkspace[];
}

export async function fetchUserTeams(apiUrl: string, token: string, refreshToken?: string) {
  const res = await fetchWithAuth('/api/v1/teams', { apiUrl, token, refreshToken });
  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to fetch teams', res.status));
  }
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as CloudTeam[];
}

export async function fetchTeamProjects(apiUrl: string, teamId: string, token: string, refreshToken?: string) {
  const res = await fetchWithAuth(`/api/v1/teams/${teamId}/projects`, { apiUrl, token, refreshToken });
  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to fetch team projects', res.status));
  }
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as CloudProject[];
}

// ----------------- Stateless Delta Sync & Import -----------------

export async function pullScopeDelta(
  apiUrl: string,
  token: string,
  scope: ActiveScope,
  sinceTimestamp: string | null = null,
  refreshToken?: string
) {
  const query = new URLSearchParams();
  if (scope.type === 'workspace') {
    query.set('workspace_id', scope.id);
  } else if (scope.type === 'project') {
    query.set('project_id', scope.id);
  }

  if (sinceTimestamp) {
    query.set('since', sinceTimestamp);
  }

  const res = await fetchWithAuth(`/api/v1/sync/pull?${query.toString()}`, {
    apiUrl,
    token,
    refreshToken,
  });

  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to pull cloud sync delta', res.status));
  }

  return unwrapData<{
    collections: any[];
    items: any[];
    environments: any[];
    server_time: string;
  }>(json);
}

export async function batchImportToScope(
  apiUrl: string,
  token: string,
  scope: ActiveScope | { id: string; type: 'workspace' | 'project' } | string,
  collections: Collection[],
  refreshToken?: string
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
    body: JSON.stringify(payload),
  });

  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Batch import failed', res.status));
  }
  return unwrapData<any>(json);
}

export async function batchImportToWorkspace(
  apiUrl: string,
  token: string,
  workspaceId: string,
  collections: Collection[],
  refreshToken?: string
) {
  return batchImportToScope(apiUrl, token, workspaceId, collections, refreshToken);
}

export async function moveScopeCollection(
  apiUrl: string,
  token: string,
  collectionId: string,
  targetScope: ActiveScope,
  refreshToken?: string
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
  refreshToken?: string
) {
  const res = await fetchWithAuth(`/api/v1/collections/${collectionId}/reorder`, {
    method: 'PUT',
    apiUrl,
    token,
    refreshToken,
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
  refreshToken?: string
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
  refreshToken?: string
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
  refreshToken?: string
) {
  const res = await fetchWithAuth(`/api/v1/environments/${envId}`, {
    method: 'DELETE',
    apiUrl,
    token,
    refreshToken,
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
  refreshToken?: string
) {
  const res = await fetchWithAuth(`/api/v1/collections/${collectionId}`, {
    method: 'DELETE',
    apiUrl,
    token,
    refreshToken,
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
  refreshToken?: string
) {
  const res = await fetchWithAuth(`/api/v1/items/${itemId}`, {
    method: 'DELETE',
    apiUrl,
    token,
    refreshToken,
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
  refreshToken?: string
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
  refreshToken?: string
): Promise<any> {
  const res = await fetchWithAuth(`/api/v1/collections/${collectionId}`, {
    apiUrl,
    token,
    refreshToken,
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
  refreshToken?: string
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
  });

  const json = await safeJson(res);
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to fetch environments', res.status));
  }
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as any[];
}
