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

export type ThemeMode = 'system' | 'light' | 'dark';

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

/** Local editor state; deletion metadata is never saved into collections. */
export interface RequestTab extends ApiRequest {
  deletedFromCollection?: string;
}
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
  /** Raw Content-Type response header including charset/parameters or comma-joined values. */
  rawContentType?: string;
  /** True when strict charset decoding of the raw response bytes failed. */
  hasDecodingError?: boolean;
  /** Snapshot of the request definition captured when this response was executed (pre-script). */
  capturedRequest?: ApiRequest;
  isBinary?: boolean;
  isImage?: boolean;
  blobUrl?: string;
  /** Opaque in-memory handle for retained raw response bytes (never persisted across reloads). */
  rawBodyId?: string;
  requestUrl?: string;
  netErrorCode?: string;
  netErrorCategory?: NetworkErrorCategory;
  failureKind?: RequestFailureKind;
}

export interface SavedExampleHeader {
  key: string;
  value: string;
  disabled?: boolean;
  description?: string;
}

export interface SavedExample {
  id: string;
  revision: number;
  name: string;
  originalRequest?: Record<string, unknown>;
  status: string;
  code: number;
  header: SavedExampleHeader[];
  cookie?: Array<Record<string, unknown>>;
  body: string;
  _postman_previewlanguage?: string | null;
  [key: string]: unknown;
}

export interface SavedExampleSummary {
  id: string;
  revision: number;
  name: string;
  code: number;
  status: string;
  _postman_previewlanguage?: string | null;
  body_size_bytes: number;
}

export interface OpenExampleTab {
  id: string;
  collectionId: string;
  itemId: string;
  exampleId: string;
}

export interface CollectionItem {
  id: string;
  name: string;
  type: 'folder' | 'request';
  request?: ApiRequest;
  items?: CollectionItem[];
  version?: number;
  examples?: SavedExample[];
  exampleSummaries?: SavedExampleSummary[];
  exampleCount?: number;
  exampleSummariesTruncated?: boolean;
  /** True when full example bodies are loaded; false when only summaries or truncated metadata are cached. */
  examplesLoaded?: boolean;
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
  /** Persisted until server details resolve an interrupted cloud move; never upload this snapshot. */
  _needsMoveReconciliation?: boolean;
  _syncStatus?: 'synced' | 'pending' | 'error';
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
  _syncStatus?: 'synced' | 'pending' | 'error';
  /** True only while a locally created cloud environment has never succeeded createScopeEnvironment. */
  _pendingCreate?: boolean;
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
  capabilities?: {
    saved_examples?: boolean;
  };
}

export type FeaturePolicyStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error';

export interface CloudConfig {
  apiUrl: string;
  hubUrl?: string;
  /** In-memory provider session; never restored as authenticated from storage. */
  sessionKind?: 'provider';
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

export interface PendingDuplicateIntent {
  operationId: string;
  ownerKey: string | null;
  kind: 'collection' | 'import_duplicate' | 'item';
  sourceCollectionId: string;
  sourceItemId?: string;
  sourceName?: string;
  sourceItemType?: 'folder' | 'request';
  targetScope?: ActiveScope;
  targetCollectionId?: string;
  targetCollectionName?: string;
  targetParentId?: string | null;
  sanitizedPayload?: { name: string; description?: string; items: any[] };
  createdAt: number;
  status: 'pending' | 'reconcile_required';
  lastError?: string;
}

export interface PendingExampleIntent {
  operationId: string;
  ownerKey: string | null;
  op: 'add' | 'rename' | 'delete';
  collectionId: string;
  itemId: string;
  exampleId: string;
  baseVersion?: number;
  baseExampleRevision?: number;
  example?: SavedExample;
  name?: string;
  targetScope?: ActiveScope;
  createdAt: number;
  status: 'pending' | 'reconcile_required';
  lastError?: string;
}

export interface DuplicateActionResult {
  success: boolean;
  error?: string;
  operationId?: string;
  createdCollectionId?: string;
  createdItemId?: string;
  targetCollectionId?: string;
  targetParentId?: string | null;
  targetScope?: ActiveScope;
  name?: string;
  minRole?: ProjectRole;
  reconcilePending?: boolean;
  deletedOnServer?: boolean;
  detailsUnavailable?: boolean;
  detailsError?: string;
  revealPathIds?: string[];
}
