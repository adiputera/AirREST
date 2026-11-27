/** Platform adapter contracts and the helpers adapters are allowed to depend on. */
export type {
  ApiResponse,
  CloudTransport,
  FileOptions,
  LoadProfileConfig,
  NetworkErrorCategory,
  OpenedFileResult,
  PerformanceEndpointBreakdown,
  PerformanceErrorGroup,
  PerformanceErrorSample,
  PerformanceMetricSnapshot,
  PerformanceNetworkOptions,
  PerformanceTimeBucket,
  PlatformAdapter,
  ScriptExecutor,
  ScriptInput,
  ScriptResult,
  TestRequestOptions,
  TestTransport,
  TransportInit,
} from '../types';
export type {
  NativePerformanceAttachmentPayload,
  NativePerformanceCallbacks,
  NativePerformanceCompletePayload,
  NativePerformanceRequestItem,
  NativePerformanceRunHandle,
  NativePerformanceRunInput,
  NativePerformanceRunner,
  NativePerformanceTickPayload,
} from '../types/platform';
export type { NativeCredentialRecord, NativeCredentialScope, NativeCredentialStorage } from '../types/credentials';
export { categorizeNetworkError, getChromiumNetworkError } from '../lib/fetcher';
export { hasHostPermission, requestHostPermission } from '../lib/hostPermissions';
export {
  MAX_IMPORT_BATCH_FILES,
  MAX_IMPORT_BATCH_TOTAL_BYTES,
  readBrowserFiles,
} from '../lib/importBatch';
export { resetSandboxIframe, runScriptInSandbox } from '../lib/scriptRunner';
