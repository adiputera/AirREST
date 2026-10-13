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
  (tokens: { token: string; refreshToken: string; expiresAt: string }): void;
}

let onTokenRefreshed: TokenRefreshCallback | null = null;
let isRefreshing = false;
let refreshPromise: Promise<string | null> | null = null;

export function registerTokenRefreshCallback(cb: TokenRefreshCallback | null) {
  onTokenRefreshed = cb;
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

function extractError(json: any, fallback: string): string {
  if (typeof json?.error === 'string') return json.error;
  if (json?.error?.message) return json.error.message;
  if (json?.message) return json.message;
  return fallback;
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
      const newToken = await handleSilentRefresh(apiUrl, refreshToken);
      if (newToken) {
        headers.set('Authorization', `Bearer ${newToken}`);
        // Retry the original request
        response = await fetch(url, { ...fetchInit, headers });
      }
    } catch {
      // If refresh fails, return original 401 response
    }
  }

  return response;
}

async function handleSilentRefresh(apiUrl: string, refreshTokenStr: string): Promise<string | null> {
  if (isRefreshing && refreshPromise) {
    return refreshPromise;
  }

  isRefreshing = true;
  refreshPromise = (async () => {
    try {
      const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshTokenStr }),
      });

      if (!res.ok) {
        return null;
      }

      const json = await res.json();
      const data = unwrapData<any>(json);
      if (data && data.token && data.refresh_token) {
        if (onTokenRefreshed) {
          onTokenRefreshed({
            token: data.token,
            refreshToken: data.refresh_token,
            expiresAt: data.expires_at,
          });
        }
        return data.token as string;
      }
      return null;
    } catch {
      return null;
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

  const json = await res.json();
  if (!res.ok) {
    throw new Error(extractError(json, 'Login failed'));
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

  const json = await res.json();
  if (!res.ok) {
    throw new Error(extractError(json, 'Registration failed'));
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
  const json = await res.json();
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to fetch current user'));
  }
  return unwrapData<CloudUser>(json);
}

// ----------------- Workspaces & Teams -----------------

export async function fetchUserWorkspaces(apiUrl: string, token: string, refreshToken?: string) {
  const res = await fetchWithAuth('/api/v1/workspaces', { apiUrl, token, refreshToken });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to fetch workspaces'));
  }
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as CloudWorkspace[];
}

export async function fetchUserTeams(apiUrl: string, token: string, refreshToken?: string) {
  const res = await fetchWithAuth('/api/v1/teams', { apiUrl, token, refreshToken });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to fetch teams'));
  }
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as CloudTeam[];
}

export async function fetchTeamProjects(apiUrl: string, teamId: string, token: string, refreshToken?: string) {
  const res = await fetchWithAuth(`/api/v1/teams/${teamId}/projects`, { apiUrl, token, refreshToken });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to fetch team projects'));
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

  const json = await res.json();
  if (!res.ok) {
    throw new Error(extractError(json, 'Failed to pull cloud sync delta'));
  }

  return unwrapData<{
    collections: any[];
    items: any[];
    environments: any[];
    server_time: string;
  }>(json);
}

export async function batchImportToWorkspace(
  apiUrl: string,
  token: string,
  workspaceId: string,
  collections: Collection[],
  refreshToken?: string
) {
  const formattedCollections = collections.map((c) => ({
    name: c.name,
    description: c.description || '',
    items: c.items.map(formatImportItem),
  }));

  const res = await fetchWithAuth('/api/v1/sync/import-batch', {
    method: 'POST',
    apiUrl,
    token,
    refreshToken,
    body: JSON.stringify({
      workspace_id: workspaceId,
      collections: formattedCollections,
    }),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(extractError(json, 'Batch import failed'));
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
    body_form_data: item.request?.bodyFormData || [],
    pre_request_script: item.request?.preRequestScript || '',
    post_response_script: item.request?.postResponseScript || '',
    items: (item.items || []).map(formatImportItem),
  };
}
