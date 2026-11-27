import type { ScriptTestResult } from './platform';

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
  testResults?: ScriptTestResult[];
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
  sourceScope?: ActiveScope;
  sourceOfflineWorkspaceId?: string;
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

export type LoadProfileType = 'fixed' | 'ramp_up' | 'spike' | 'peak' | 'staircase';

export type PerformanceExecutionMode = 'sequential' | 'pre_run_setup';

export type PerformanceDurationUnit = 'seconds' | 'minutes';

export type PerformanceEngineMode = 'rust_native' | 'hybrid_pool' | 'js_bounded';

export type PerformanceLatencyMetric = 'avg' | 'p90' | 'p95' | 'p99' | 'min' | 'max';

export interface StaircaseStep {
  /** Normalized end position in (0, 1]; final step ends at 1. */
  endNorm: number;
  /** Target virtual users for this step plateau. */
  virtualUsers: number;
}

export interface LoadProfileConfig {
  profile: LoadProfileType;
  virtualUsers: number;
  baseLoad: number;
  durationValue: number;
  durationUnit: PerformanceDurationUnit;
  /** Normalized handle positions in (0, 1) keyed by profile type. */
  handles: Record<LoadProfileType, number[]>;
  /** Editable 2D steps for the staircase profile (duration boundaries + per-step VU). */
  staircaseSteps?: StaircaseStep[];
  thinkTimeMs: number;
}

export type RunnerMode = 'functional' | 'performance';

export type FunctionalStopOnErrorMode = 'never' | 'request_or_script_error' | 'failed_test';

export interface PerformanceNetworkOptions {
  requestTimeoutMs: number;
  /** When true (default), auto-syncs timeout to min(60_000 ms, testDurationMs). */
  requestTimeoutAuto?: boolean;
  followRedirects: boolean;
  ignoreSslErrors: boolean;
}

export interface FunctionalRunnerConfig {
  iterations: number;
  delayMs: number;
  persistResponses: boolean;
  keepVariableValues: boolean;
  /** Treat HTTP 4xx/5xx responses as failed steps even without pm.test() failures (default false, Postman behavior). */
  failOnHttpError?: boolean;
  stopOnError: FunctionalStopOnErrorMode;
  requestTimeoutMs: number;
  followRedirects: boolean;
  ignoreSslErrors: boolean;
}

export type FunctionalStepStatus = 'passed' | 'warning' | 'failed' | 'error' | 'skipped';

export interface FunctionalCapturedExchange {
  requestMethod: HttpMethod;
  requestUrl: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  requestBodyTruncated?: boolean;
  responseHeaders: Record<string, string>;
  responseBody: string;
  responseBodyTruncated?: boolean;
  dataRow?: Record<string, string>;
}

export interface FunctionalStepResult {
  id: string;
  iteration: number;
  stepIndex: number;
  itemId: string;
  name: string;
  method: HttpMethod;
  url: string;
  status: FunctionalStepStatus;
  httpStatus: number;
  statusText: string;
  timeMs: number;
  sizeBytes: number;
  testResults: ScriptTestResult[];
  testsPassed: number;
  testsFailed: number;
  errorMessage?: string;
  warningMessage?: string;
  scriptError?: string;
  scriptErrorStage?: ScriptErrorStage;
  nextRequestTarget?: string | null;
  dataRowIndex?: number;
  hasCapturedExchange?: boolean;
  captureSkippedReason?: 'disabled' | 'step_limit' | 'memory_budget';
  timestamp: number;
}

export type FunctionalRunStatus = 'running' | 'completed' | 'stopped' | 'failed';

export interface FunctionalRunReport {
  id: string;
  tabId: string;
  title: string;
  sourceType: 'collection' | 'folder' | 'request';
  sourceId: string;
  sourceCollectionId?: string;
  sourceCollectionName?: string;
  sourceName?: string;
  imported?: boolean;
  importedAt?: number;
  importedFilename?: string;
  status: FunctionalRunStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs: number;
  config: FunctionalRunnerConfig;
  dataFile?: Omit<PerformanceDataFileMeta, 'previewRows'>;
  plannedIterations: number;
  completedIterations: number;
  totalRequestsExecuted: number;
  requestsPassed: number;
  requestsWarned?: number;
  requestsFailed: number;
  requestsErrored: number;
  requestsSkipped: number;
  totalTests: number;
  testsPassed: number;
  testsFailed: number;
  avgResponseTimeMs: number;
  steps: FunctionalStepResult[];
  failedItemIds: string[];
  failedIterations?: number[];
  stepsTruncated?: boolean;
  totalStepsRecorded?: number;
  updatedEnvVars?: string[];
  stopReason?: string;
  captureBudgetExhausted?: boolean;
}

export type PerformanceDataFileFormat = 'csv' | 'json';

export type PerformanceDataFileReadMode = 'sequential' | 'random' | 'per_vu';

export interface PerformanceDataFileMeta {
  filename: string;
  format: PerformanceDataFileFormat;
  fileBytes: number;
  rowCount: number;
  columns: string[];
  previewRows: Array<Record<string, string>>;
  readMode: PerformanceDataFileReadMode;
}

export type PerformanceThresholdMetric =
  | 'avgMs'
  | 'p90Ms'
  | 'p95Ms'
  | 'p99Ms'
  | 'errorRatePct'
  | 'requestsPerSec'
  | 'maxRequestsPerSec';

export type PerformanceThresholdOperator = 'lt' | 'lte' | 'gt' | 'gte';

export interface PerformanceThresholdRule {
  id: string;
  enabled: boolean;
  /** 'overall' or a loop requestId */
  targetRequestId: string;
  metric: PerformanceThresholdMetric;
  operator: PerformanceThresholdOperator;
  value: number;
  abortOnFail?: boolean;
}

export interface PerformanceThresholdConfig {
  rules: PerformanceThresholdRule[];
  abortGracePeriodSec: number;
  abortConsecutiveBreaches: number;
}

export interface PerformanceThresholdEvaluation {
  ruleId: string;
  targetRequestId: string;
  targetLabel: string;
  metric: PerformanceThresholdMetric;
  operator: PerformanceThresholdOperator;
  expected: number;
  actual: number;
  passed: boolean;
  notEvaluated?: boolean;
  notEvaluatedReason?: string;
  abortOnFail: boolean;
  triggeredAbort?: boolean;
}

export interface PerformanceSlaSummary {
  status: 'passed' | 'failed';
  passedCount: number;
  failedCount: number;
  inconclusiveCount?: number;
  totalCount: number;
  autoAborted: boolean;
  autoAbortedReason?: string;
  results: PerformanceThresholdEvaluation[];
}

export interface PerformanceSetupRefreshConfig {
  enabled: boolean;
  intervalValue: number;
  intervalUnit: PerformanceDurationUnit;
  refreshOn401: boolean;
  cooldownSec: number;
}

export interface PerformanceSetupRefreshStats {
  attempts: number;
  successes: number;
  failures: number;
  lastRefreshedAt?: number;
  lastError?: string;
}

export interface PerformanceRequestDescriptor {
  id: string;
  itemId: string;
  name: string;
  method: HttpMethod;
  path: string;
  request: ApiRequest;
  selected: boolean;
}

export interface OpenPerformanceTab {
  id: string;
  title: string;
  runnerMode: RunnerMode;
  sourceType: 'collection' | 'folder' | 'request' | 'imported';
  sourceId: string;
  collectionId?: string;
  items: PerformanceRequestDescriptor[];
  executionMode: PerformanceExecutionMode;
  setupItemIds: string[];
  setupRefresh?: PerformanceSetupRefreshConfig;
  runInLoopScripts: boolean;
  loadProfile: LoadProfileConfig;
  network: PerformanceNetworkOptions;
  functionalConfig: FunctionalRunnerConfig;
  dataFile?: PerformanceDataFileMeta;
  thresholds?: PerformanceThresholdConfig;
  viewMode: 'setup' | 'running' | 'report';
  activeRunId?: string | null;
  viewingReportId?: string | null;
  activeFunctionalRunId?: string | null;
  viewingFunctionalReportId?: string | null;
  isSessionOnlyImported?: boolean;
  sessionOnlyReason?: string;
  createdAt: number;
}

export interface PerformanceMetricSnapshot {
  totalRequests: number;
  errorCount: number;
  warningCount?: number;
  errorRatePct: number;
  requestsPerSec: number;
  maxRequestsPerSec?: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  bytesReceived: number;
}

export interface PerformanceRequestBucketMetrics {
  totalRequests: number;
  errorCount: number;
  errorRatePct: number;
  requestsPerSec: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface PerformanceTimeBucket {
  second: number;
  timestampMs: number;
  virtualUsers: number;
  totalRequests: number;
  errorCount: number;
  errorRatePct: number;
  requestsPerSec: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  byRequest?: Record<string, PerformanceRequestBucketMetrics>;
}

export interface PerformanceEndpointBreakdown {
  requestId: string;
  name: string;
  method: HttpMethod;
  path: string;
  totalRequests: number;
  errorCount: number;
  warningCount?: number;
  errorRatePct: number;
  requestsPerSec: number;
  maxRequestsPerSec?: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  bytesReceived: number;
}

export interface PerformanceErrorGroup {
  key: string;
  status: number;
  category: string;
  label: string;
  count: number;
  requestIds: string[];
}

export interface PerformanceErrorSample {
  id: string;
  timestampMs: number;
  requestId: string;
  requestName: string;
  method: HttpMethod;
  url: string;
  status: number;
  statusText: string;
  category: string;
  message: string;
  responseSnippet?: string;
  timeMs: number;
}

export interface PerformanceSetupStepResult {
  requestId: string;
  name: string;
  method: HttpMethod;
  url: string;
  status: number;
  timeMs: number;
  success: boolean;
  error?: string;
  updatedVariables: string[];
}

export interface PerformanceRunReport {
  id: string;
  tabId: string;
  title: string;
  sourceType: 'collection' | 'folder' | 'request';
  sourceId: string;
  sourceCollectionId?: string;
  sourceCollectionName?: string;
  sourceName?: string;
  imported?: boolean;
  importedAt?: number;
  importedFilename?: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  status: 'running' | 'completed' | 'stopped' | 'failed';
  engineMode: PerformanceEngineMode;
  platformId: 'desktop' | 'extension' | 'android' | 'web';
  executionMode: PerformanceExecutionMode;
  setupResults?: PerformanceSetupStepResult[];
  setupRefreshStats?: PerformanceSetupRefreshStats;
  failureReason?: string;
  autoAborted?: boolean;
  slaResult?: PerformanceSlaSummary;
  configSnapshot: {
    loadProfile: LoadProfileConfig;
    network: PerformanceNetworkOptions;
    requestCount: number;
    setupRequestCount: number;
    runInLoopScripts: boolean;
    dataFile?: Omit<PerformanceDataFileMeta, 'previewRows'>;
    thresholds?: PerformanceThresholdConfig;
    setupRefresh?: PerformanceSetupRefreshConfig;
  };
  summary: PerformanceMetricSnapshot;
  timeSeries: PerformanceTimeBucket[];
  endpoints: PerformanceEndpointBreakdown[];
  errorGroups: PerformanceErrorGroup[];
  errorSamples: PerformanceErrorSample[];
  warnings: string[];
}
