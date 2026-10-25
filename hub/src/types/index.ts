export type SystemRole = 'superadmin' | 'user';

export interface User {
  id: string;
  email: string;
  name: string;
  role: SystemRole;
  avatar_url?: string;
  created_at?: string;
  updated_at?: string;
}

export interface Team {
  id: string;
  name: string;
  description?: string;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
  user_role?: 'admin' | 'member';
}

export interface TeamMember {
  id?: string;
  user_id: string;
  email?: string;
  name?: string;
  role: 'admin' | 'member';
  joined_at?: string;
  user?: {
    id: string;
    email: string;
    name: string;
  };
}

export type ProjectRole = 'admin' | 'maintainer' | 'contributor' | 'reader';

export interface Project {
  id: string;
  team_id: string;
  name: string;
  description?: string;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
  user_role?: ProjectRole;
  permissions?: string[];
}

export interface ProjectMember {
  id?: string;
  user_id: string;
  email?: string;
  name?: string;
  role: ProjectRole;
  permissions?: string[];
  assigned_at?: string;
  user?: {
    id: string;
    email: string;
    name: string;
  };
}

export interface Workspace {
  id: string;
  owner_id: string;
  name: string;
  description?: string;
  is_default: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface CollectionItem {
  id: string;
  collection_id: string;
  parent_id?: string | null;
  type: 'folder' | 'request';
  name: string;
  sort_order: number;
  method?: string | null;
  url?: string | null;
  version?: number;
  created_at?: string;
  updated_at?: string;
  items?: CollectionItem[];
}

export interface Collection {
  id: string;
  workspace_id?: string | null;
  project_id?: string | null;
  name: string;
  description?: string | null;
  min_role?: ProjectRole;
  version: number;
  created_by?: string;
  last_modified_by?: string | null;
  created_at?: string;
  updated_at?: string;
  items?: CollectionItem[];
}

export interface EnvironmentVariable {
  id?: string;
  key: string;
  value: string;
  enabled: boolean;
}

export interface Environment {
  id: string;
  workspace_id?: string | null;
  project_id?: string | null;
  name: string;
  variables: EnvironmentVariable[];
  min_role?: ProjectRole;
  version: number;
  last_modified_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

