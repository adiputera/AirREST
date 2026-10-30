export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface KeyValuePair {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
}

export interface FormDataItem {
  id: string;
  key: string;
  type: 'text' | 'file';
  value: string; // text value or file name display
  file?: File;
  /** Persistence-only attachment metadata. A file handle is never restored after reload. */
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  needsReselection?: boolean;
  enabled: boolean;
}

export interface BinaryFileData {
  name: string;
  size: number;
  type: string;
  file?: File;
  /** True when this entry was restored without its original File handle. */
  needsReselection?: boolean;
}

export type RawType = 'text' | 'json' | 'xml' | 'html';

export type BodyType = 'none' | 'json' | 'xml' | 'raw' | 'x-www-form-urlencoded' | 'form-data' | 'binary' | 'graphql';

export interface AuthConfig {
  type: 'none' | 'bearer' | 'basic' | 'apikey';
  bearerToken?: string;
  basicUsername?: string;
  basicPassword?: string;
  apiKeyKey?: string;
  apiKeyValue?: string;
  apiKeyIn?: 'header' | 'query';
}

export interface ApiRequest {
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
  params: KeyValuePair[];
  pathVariables?: KeyValuePair[];
  headers: KeyValuePair[];
  auth: AuthConfig;
  bodyType: BodyType;
  rawType?: RawType;
  bodyContent: string;
  graphqlQuery?: string;
  graphqlVariables?: string;
  bodyFormData?: FormDataItem[];
  bodyBinaryFile?: BinaryFileData;
  bodyUrlEncoded?: KeyValuePair[];
  preRequestScript?: string;
  postResponseScript?: string;
  createdAt: number;
  updatedAt: number;
}

export type NetworkErrorCategory = 'ssl' | 'connection_refused' | 'dns' | 'timeout' | 'other';
export type ScriptErrorStage = 'pre-request' | 'post-response';
export type RequestFailureKind = 'cancelled' | 'timeout' | 'response_too_large' | 'host_permission' | 'transport';

export interface ApiResponse {
  status: number;
  statusText: string;
  timeMs: number;
  sizeBytes: number;
  headers: Record<string, string>;
  data: string;
  isError?: boolean;
  errorDetail?: string;
  scriptError?: string;
  scriptErrorStage?: ScriptErrorStage;
  updatedEnvVars?: string[];
  timestamp: number;
  contentType?: string;
  isBinary?: boolean;
  isImage?: boolean;
  blobUrl?: string;
  requestUrl?: string;
  netErrorCode?: string;
  netErrorCategory?: NetworkErrorCategory;
  failureKind?: RequestFailureKind;
}

export interface CollectionItem {
  id: string;
  name: string;
  type: 'folder' | 'request';
  request?: ApiRequest;
  items?: CollectionItem[];
}

export type ProjectRole = 'admin' | 'maintainer' | 'contributor' | 'reader';

export interface Collection {
  id: string;
  name: string;
  description?: string;
  items: CollectionItem[];
  version?: number;
  minRole?: ProjectRole;
  /** Local cache state; never included in cloud or Postman payloads. */
  isPartial?: boolean;
  createdAt: number;
  updatedAt: number;
  _origin?: 'offline' | 'cloud';
}

export interface HistoryItem {
  id: string;
  request: ApiRequest;
  response?: ApiResponse;
  timestamp: number;
}

export interface EnvironmentVariable {
  id: string;
  key: string;
  value?: string;
  initialValue: string;
  currentValue: string;
  enabled: boolean;
}

export interface Environment {
  id: string;
  name: string;
  variables: EnvironmentVariable[];
  minRole?: 'admin' | 'maintainer' | 'contributor' | 'reader';
  version?: number;
  createdAt: number;
  updatedAt: number;
}

export type WorkspaceMode = 'offline' | 'cloud';

export interface OfflineWorkspace {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CloudUser {
  id: string;
  email: string;
  name: string;
  role: string;
  avatar_url?: string;
}

export interface CloudWorkspace {
  id: string;
  name: string;
  description?: string;
  is_default?: boolean;
}

export interface CloudTeam {
  id: string;
  name: string;
  description?: string;
  role?: string; // 'admin' | 'member'
}

export type ScopePermission =
  | 'collection:read'
  | 'collection:write'
  | 'collection:delete'
  | 'collection:move'
  | 'env:read'
  | 'env:write'
  | 'env:delete'
  | '*';

export interface CloudProject {
  id: string;
  team_id: string;
  team_name?: string;
  name: string;
  description?: string;
  user_role?: 'admin' | 'maintainer' | 'contributor' | 'reader';
  permissions?: string[];
}

export interface ActiveScope {
  type: 'workspace' | 'project' | 'offline_workspace';
  id: string;
  name: string;
  teamId?: string;
  teamName?: string;
  role?: 'admin' | 'maintainer' | 'contributor' | 'reader' | 'owner';
  permissions?: string[];
}

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'offline';

export interface FeatureFlags {
  'collection.move': boolean;
  'collection.delete': boolean;
  'collection.export': boolean;
}

export interface FeaturePolicy {
  flags: FeatureFlags;
  revision: number;
  updated_by?: string;
  updated_at: string;
}

export type FeaturePolicyStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error';

export interface CloudConfig {
  apiUrl: string;
  hubUrl?: string;
  token?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  user?: CloudUser;
  activeScope?: ActiveScope;
}

export interface ScopesCacheData {
  workspaces: CloudWorkspace[];
  teams?: CloudTeam[];
  teamProjects?: Record<string, CloudProject[]>;
  teamsWithProjects: { team: CloudTeam; projects: CloudProject[] }[];
  lastFetchedAt: number;
}
