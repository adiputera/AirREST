import { User, Team, TeamMember, Project, ProjectMember, Collection, Environment, ProjectRole } from '../types';

export interface TokenRefreshCallback {
  (tokens: { token: string; refreshToken: string; expiresAt: string }): void;
}

let onTokenRefreshed: TokenRefreshCallback | null = null;
let isRefreshing = false;
let refreshPromise: Promise<string | null> | null = null;

export function registerHubTokenRefresh(cb: TokenRefreshCallback | null) {
  onTokenRefreshed = cb;
}

export interface ApiFetchOptions extends RequestInit {
  apiUrl: string;
  token?: string | null;
  refreshToken?: string | null;
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

export const DEFAULT_API_URL: string =
  (import.meta.env.VITE_API_URL ? String(import.meta.env.VITE_API_URL) : 'http://localhost:8080').replace(/\/+$/, '');

export async function fetchWithAuth(endpoint: string, options: ApiFetchOptions): Promise<Response> {
  const { apiUrl, token, refreshToken, ...fetchInit } = options;
  const baseUrl = apiUrl ? apiUrl.replace(/\/+$/, '') : DEFAULT_API_URL;
  const url = `${baseUrl}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;

  const headers = new Headers(fetchInit.headers || {});
  headers.set('Content-Type', 'application/json');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response = await fetch(url, { ...fetchInit, headers });

  if (response.status === 401 && refreshToken) {
    try {
      const newToken = await handleSilentRefresh(baseUrl, refreshToken);
      if (newToken) {
        headers.set('Authorization', `Bearer ${newToken}`);
        response = await fetch(url, { ...fetchInit, headers });
      }
    } catch {
      // Return original response
    }
  }

  return response;
}

async function handleSilentRefresh(apiUrl: string, refreshTokenStr: string): Promise<string | null> {
  if (isRefreshing && refreshPromise) return refreshPromise;

  isRefreshing = true;
  refreshPromise = (async () => {
    try {
      const res = await fetch(`${apiUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshTokenStr }),
      });

      if (!res.ok) return null;

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

// ----------------- Auth -----------------

export async function apiLogin(apiUrl: string, email: string, password: string) {
  const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Login failed'));
  return unwrapData<{ user: User; token: string; refresh_token: string; expires_at: string }>(json);
}

export async function apiRegister(apiUrl: string, email: string, password: string, name: string) {
  const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Registration failed'));
  return unwrapData<{ user: User; token: string; refresh_token: string; expires_at: string }>(json);
}

export async function apiGetMe(apiUrl: string, token: string, refreshToken?: string) {
  const res = await fetchWithAuth('/api/v1/auth/me', { apiUrl, token, refreshToken });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Failed to fetch current user'));
  return unwrapData<User>(json);
}

// ----------------- Teams -----------------

export async function apiListTeams(apiUrl: string, token: string, refreshToken?: string) {
  const res = await fetchWithAuth('/api/v1/teams', { apiUrl, token, refreshToken });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Failed to list teams'));
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as Team[];
}

export async function apiCreateTeam(apiUrl: string, token: string, name: string, description: string, refreshToken?: string) {
  const res = await fetchWithAuth('/api/v1/teams', {
    method: 'POST',
    apiUrl,
    token,
    refreshToken,
    body: JSON.stringify({ name, description }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Failed to create team'));
  return unwrapData<Team>(json);
}

export async function apiUpdateTeam(
  apiUrl: string,
  token: string,
  teamId: string,
  name: string,
  description: string,
  refreshToken?: string
) {
  const res = await fetchWithAuth(`/api/v1/teams/${teamId}`, {
    method: 'PUT',
    apiUrl,
    token,
    refreshToken,
    body: JSON.stringify({ name, description }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Failed to update team'));
  return unwrapData<Team>(json);
}

export async function apiDeleteTeam(apiUrl: string, token: string, teamId: string, refreshToken?: string) {
  const res = await fetchWithAuth(`/api/v1/teams/${teamId}`, {
    method: 'DELETE',
    apiUrl,
    token,
    refreshToken,
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(extractError(json, 'Failed to delete team'));
  }
}

export async function apiListTeamMembers(apiUrl: string, token: string, teamId: string, refreshToken?: string) {
  const res = await fetchWithAuth(`/api/v1/teams/${teamId}/members`, { apiUrl, token, refreshToken });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Failed to list team members'));
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as TeamMember[];
}

export async function apiAddTeamMember(
  apiUrl: string,
  token: string,
  teamId: string,
  userId: string,
  role: 'admin' | 'member',
  refreshToken?: string
) {
  const res = await fetchWithAuth(`/api/v1/teams/${teamId}/members`, {
    method: 'POST',
    apiUrl,
    token,
    refreshToken,
    body: JSON.stringify({ user_id: userId, role }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Failed to add team member'));
  return unwrapData<any>(json);
}

export async function apiRemoveTeamMember(apiUrl: string, token: string, teamId: string, userId: string, refreshToken?: string) {
  const res = await fetchWithAuth(`/api/v1/teams/${teamId}/members/${userId}`, {
    method: 'DELETE',
    apiUrl,
    token,
    refreshToken,
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(extractError(json, 'Failed to remove team member'));
  }
}

// ----------------- Projects -----------------

export async function apiListTeamProjects(apiUrl: string, token: string, teamId: string, refreshToken?: string) {
  const res = await fetchWithAuth(`/api/v1/teams/${teamId}/projects`, { apiUrl, token, refreshToken });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Failed to list projects'));
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as Project[];
}

export async function apiCreateProject(
  apiUrl: string,
  token: string,
  teamId: string,
  name: string,
  description: string,
  refreshToken?: string
) {
  const res = await fetchWithAuth(`/api/v1/teams/${teamId}/projects`, {
    method: 'POST',
    apiUrl,
    token,
    refreshToken,
    body: JSON.stringify({ name, description }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Failed to create project'));
  return unwrapData<Project>(json);
}

export async function apiUpdateProject(
  apiUrl: string,
  token: string,
  projectId: string,
  name: string,
  description: string,
  refreshToken?: string
) {
  const res = await fetchWithAuth(`/api/v1/projects/${projectId}`, {
    method: 'PUT',
    apiUrl,
    token,
    refreshToken,
    body: JSON.stringify({ name, description }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Failed to update project'));
  return unwrapData<Project>(json);
}

export async function apiDeleteProject(apiUrl: string, token: string, projectId: string, refreshToken?: string) {
  const res = await fetchWithAuth(`/api/v1/projects/${projectId}`, {
    method: 'DELETE',
    apiUrl,
    token,
    refreshToken,
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(extractError(json, 'Failed to delete project'));
  }
}

export async function apiListProjectMembers(apiUrl: string, token: string, projectId: string, refreshToken?: string) {
  const res = await fetchWithAuth(`/api/v1/projects/${projectId}/members`, { apiUrl, token, refreshToken });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Failed to list project members'));
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as ProjectMember[];
}

export async function apiAddProjectMember(
  apiUrl: string,
  token: string,
  projectId: string,
  userId: string,
  role: 'admin' | 'maintainer' | 'contributor' | 'reader',
  refreshToken?: string
) {
  const res = await fetchWithAuth(`/api/v1/projects/${projectId}/members`, {
    method: 'POST',
    apiUrl,
    token,
    refreshToken,
    body: JSON.stringify({ user_id: userId, role }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Failed to assign project member'));
  return unwrapData<any>(json);
}

export async function apiRemoveProjectMember(apiUrl: string, token: string, projectId: string, userId: string, refreshToken?: string) {
  const res = await fetchWithAuth(`/api/v1/projects/${projectId}/members/${userId}`, {
    method: 'DELETE',
    apiUrl,
    token,
    refreshToken,
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(extractError(json, 'Failed to remove project member'));
  }
}

// ----------------- User Search & Superadmin -----------------

export async function apiSearchUsers(apiUrl: string, token: string, query: string, refreshToken?: string) {
  const res = await fetchWithAuth(`/api/v1/users/search?email=${encodeURIComponent(query)}`, {
    apiUrl,
    token,
    refreshToken,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Search failed'));
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as User[];
}

export async function apiListAllUsers(apiUrl: string, token: string, refreshToken?: string) {
  const res = await fetchWithAuth('/api/v1/admin/users', { apiUrl, token, refreshToken });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Failed to list users'));
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as User[];
}

export async function apiProvisionUser(
  apiUrl: string,
  token: string,
  email: string,
  password: string,
  name: string,
  role: string,
  refreshToken?: string
) {
  const res = await fetchWithAuth('/api/v1/admin/users', {
    method: 'POST',
    apiUrl,
    token,
    refreshToken,
    body: JSON.stringify({ email, password, name, role }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Failed to provision user'));
  return unwrapData<User>(json);
}

export async function apiResetUserPassword(
  apiUrl: string,
  token: string,
  userId: string,
  newPassword: string,
  refreshToken?: string
) {
  const res = await fetchWithAuth(`/api/v1/admin/users/${userId}/password`, {
    method: 'PUT',
    apiUrl,
    token,
    refreshToken,
    body: JSON.stringify({ password: newPassword }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(extractError(json, 'Failed to reset user password'));
  return unwrapData<any>(json);
}

// ----------------- Project Collections & Environments Endpoints -----------------

export async function apiListProjectCollections(
  apiUrl: string,
  token: string,
  projectId: string,
  refreshToken?: string
): Promise<Collection[]> {
  const res = await fetchWithAuth(`/api/v1/collections?project_id=${encodeURIComponent(projectId)}`, {
    apiUrl,
    token,
    refreshToken,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Failed to list collections'));
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as Collection[];
}

export async function apiUpdateCollectionPermission(
  apiUrl: string,
  token: string,
  collectionId: string,
  minRole: ProjectRole,
  baseVersion: number,
  refreshToken?: string
): Promise<Collection> {
  const res = await fetchWithAuth(`/api/v1/collections/${collectionId}`, {
    method: 'PUT',
    apiUrl,
    token,
    refreshToken,
    body: JSON.stringify({ min_role: minRole, base_version: baseVersion }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Failed to update collection permission'));
  return unwrapData<Collection>(json);
}

export async function apiMoveCollection(
  apiUrl: string,
  token: string,
  collectionId: string,
  targetProjectId?: string,
  targetWorkspaceId?: string,
  refreshToken?: string
): Promise<void> {
  const payload: any = {};
  if (targetProjectId) payload.target_project_id = targetProjectId;
  if (targetWorkspaceId) payload.target_workspace_id = targetWorkspaceId;

  const res = await fetchWithAuth(`/api/v1/collections/${collectionId}/move`, {
    method: 'POST',
    apiUrl,
    token,
    refreshToken,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(extractError(json, 'Failed to move collection'));
  }
}

export async function apiListProjectEnvironments(
  apiUrl: string,
  token: string,
  projectId: string,
  refreshToken?: string
): Promise<Environment[]> {
  const res = await fetchWithAuth(`/api/v1/environments?project_id=${encodeURIComponent(projectId)}`, {
    apiUrl,
    token,
    refreshToken,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Failed to list environments'));
  const data = unwrapData<any>(json);
  return (Array.isArray(data) ? data : []) as Environment[];
}

export async function apiUpdateEnvironmentPermission(
  apiUrl: string,
  token: string,
  envId: string,
  minRole: ProjectRole,
  baseVersion: number,
  refreshToken?: string
): Promise<Environment> {
  const res = await fetchWithAuth(`/api/v1/environments/${envId}`, {
    method: 'PUT',
    apiUrl,
    token,
    refreshToken,
    body: JSON.stringify({ min_role: minRole, base_version: baseVersion }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(extractError(json, 'Failed to update environment permission'));
  return unwrapData<Environment>(json);
}

export async function apiDeleteCollection(
  apiUrl: string,
  token: string,
  collectionId: string,
  refreshToken?: string
): Promise<{ message: string }> {
  const res = await fetchWithAuth(`/api/v1/collections/${collectionId}`, {
    method: 'DELETE',
    apiUrl,
    token,
    refreshToken,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(extractError(json, 'Failed to delete collection'));
  return unwrapData<{ message: string }>(json);
}

export async function apiDeleteEnvironment(
  apiUrl: string,
  token: string,
  envId: string,
  refreshToken?: string
): Promise<{ message: string }> {
  const res = await fetchWithAuth(`/api/v1/environments/${envId}`, {
    method: 'DELETE',
    apiUrl,
    token,
    refreshToken,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(extractError(json, 'Failed to delete environment'));
  return unwrapData<{ message: string }>(json);
}

