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

export interface Project {
  id: string;
  team_id: string;
  name: string;
  description?: string;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
  user_role?: 'admin' | 'contributor' | 'reader';
}

export interface ProjectMember {
  id?: string;
  user_id: string;
  email?: string;
  name?: string;
  role: 'admin' | 'contributor' | 'reader';
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
