import type {
  ApiRequest,
  ApiResponse,
  LoadProfileConfig,
  NetworkErrorCategory,
  PerformanceDataFileReadMode,
  PerformanceEndpointBreakdown,
  PerformanceErrorGroup,
  PerformanceErrorSample,
  PerformanceMetricSnapshot,
  PerformanceNetworkOptions,
  PerformanceTimeBucket,
} from './api';
import type { NativeCredentialStorage } from './credentials';

export type TransportInit = Pick<RequestInit, 'method' | 'headers' | 'body'> & {
  signal: AbortSignal;
};

export interface TestRequestOptions {
  ignoreSslErrors?: boolean; // Default false
  followRedirects?: boolean; // Default true
}

export interface TestTransport {
  // Resolve at headers; do not consume or clone the response body.
  fetch(url: string, init: TransportInit, options?: TestRequestOptions): Promise<Response>;
  classifyError(error: unknown, url: string): Promise<{
    category: NetworkErrorCategory;
    code?: string;
    detail: string;
  }>;
}

export interface CloudTransport {
  /** Explicit opt-in: the adapter forwards Fetch credentials to its own cookie jar. */
  readonly supportsCredentials?: boolean;
  // Construct approved transport options explicitly; no test-request options.
  fetch(url: string, init: TransportInit & Pick<RequestInit, 'credentials'>): Promise<Response>;
}

export interface PlatformCapabilities {
  supportsCustomForbiddenHeaders: boolean;
  supportsIgnoreSslErrors: boolean;
  supportsNativeFileSystem: boolean;
  supportsManualRedirectResponse: boolean;
}

export type ScriptResponse = Pick<ApiResponse,
  'status' | 'statusText' | 'headers' | 'data' | 'timeMs'>;

export interface ScriptRequest {
  url: string;
  method?: string;
  headers?: Record<string, string> | Array<{ key: string; value: string; enabled?: boolean }>;
  params?: Array<{ key: string; value: string; enabled?: boolean }>;
  body?: {
    mode?: string;
    raw?: string;
    urlencoded?: Array<{ key: string; value: string; enabled?: boolean }>;
    formdata?: Array<{ key: string; value: string; enabled?: boolean }>;
  };
}

export interface ScriptMutatedRequest {
  url?: string;
  queryParams?: Array<{ key: string; value: string }>;
  headers?: Array<{ key: string; value: string }>;
}

export interface ScriptTestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs?: number;
}

export interface ScriptInput {
  script: string;
  request?: ScriptRequest;
  response?: ScriptResponse;
  environment: Record<string, string>;
  variables: Record<string, string>;
  iterationData?: Record<string, string>;
}

export interface ScriptResult {
  success: boolean;
  environment: Record<string, string>;
  variables: Record<string, string>;
  error?: string;
  mutatedRequest?: ScriptMutatedRequest;
  testResults?: ScriptTestResult[];
  /** undefined = normal sequential flow; null = stop iteration; string = target request name or ID. */
  nextRequest?: string | null;
}

export interface ScriptExecutor {
  execute(input: ScriptInput, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ScriptResult>;
  dispose(): void;
}

export interface FileOptions {
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface OpenedFileResult {
  filename: string;
  content: string;
  error?: string;
}

export interface NativePerformanceAttachmentPayload {
  fieldKey?: string;
  fileName: string;
  mimeType: string;
  bytesBase64: string;
}

export interface NativePerformanceRequestItem {
  id: string;
  name: string;
  path: string;
  request: ApiRequest;
  binaryBase64?: string;
  formAttachments?: Record<string, NativePerformanceAttachmentPayload>;
}

export interface NativePerformanceDataFileInput {
  readMode: PerformanceDataFileReadMode;
  rows: Array<Record<string, string>>;
}

export interface NativePerformanceRunInput {
  runId: string;
  items: NativePerformanceRequestItem[];
  initialVariables: Record<string, string>;
  loadProfile: LoadProfileConfig;
  network: PerformanceNetworkOptions;
  dataFile?: NativePerformanceDataFileInput;
}

export interface NativePerformanceTickPayload {
  runId: string;
  elapsedMs: number;
  activeVus: number;
  unauthorizedCount?: number;
  summary: PerformanceMetricSnapshot;
  bucket?: PerformanceTimeBucket;
  endpoints: PerformanceEndpointBreakdown[];
  errorGroups: PerformanceErrorGroup[];
  errorSamples: PerformanceErrorSample[];
}

export interface NativePerformanceCompletePayload {
  runId: string;
  status: 'completed' | 'stopped' | 'failed';
  durationMs: number;
  failureReason?: string;
  summary: PerformanceMetricSnapshot;
  timeSeries: PerformanceTimeBucket[];
  endpoints: PerformanceEndpointBreakdown[];
  errorGroups: PerformanceErrorGroup[];
  errorSamples: PerformanceErrorSample[];
  warnings?: string[];
}

export interface NativePerformanceCallbacks {
  onTick: (tick: NativePerformanceTickPayload) => void;
  onComplete: (result: NativePerformanceCompletePayload) => void;
}

export interface NativePerformanceRunHandle {
  runId: string;
  softFdLimit?: number;
  effectiveMaxVus?: number;
  warnings?: string[];
}

export interface NativePerformanceRunner {
  maxVirtualUsers: number;
  startRun(
    input: NativePerformanceRunInput,
    callbacks: NativePerformanceCallbacks
  ): Promise<NativePerformanceRunHandle>;
  stopRun(runId: string): Promise<void>;
  updateVariables?(runId: string, variables: Record<string, string>): Promise<void>;
  checkCapacity?(): Promise<{ softFdLimit?: number; hardFdLimit?: number }>;
}

export interface PlatformAdapter {
  platformId: 'extension' | 'desktop' | 'android' | 'web';
  capabilities: PlatformCapabilities;
  transport: TestTransport;
  cloudTransport: CloudTransport;
  /** Undefined on platforms that deliberately retain browser-managed credential storage. */
  credentialStorage?: NativeCredentialStorage;
  scriptExecutor: ScriptExecutor;
  perfScriptExecutor?: ScriptExecutor;
  performanceRunner?: NativePerformanceRunner;
  saveFile(
    filename: string,
    content: string | Uint8Array,
    options?: FileOptions & { mimeType?: string }
  ): Promise<boolean>;
  openFile(options?: FileOptions): Promise<{ filename: string; content: string } | null>;
  openFiles?(options?: FileOptions): Promise<OpenedFileResult[]>;
  hasHostPermission(url: string): Promise<boolean | null>;
  requestHostPermission(url: string): Promise<boolean>;
  dispose(): void;
}
