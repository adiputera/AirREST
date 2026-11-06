/** Platform adapter contracts and the helpers adapters are allowed to depend on. */
export type {
  ApiResponse,
  CloudTransport,
  FileOptions,
  NetworkErrorCategory,
  PlatformAdapter,
  ScriptExecutor,
  ScriptInput,
  ScriptResult,
  TestRequestOptions,
  TestTransport,
  TransportInit,
} from '../types';
export { categorizeNetworkError, getChromiumNetworkError } from '../lib/fetcher';
export { hasHostPermission, requestHostPermission } from '../lib/hostPermissions';
export { resetSandboxIframe, runScriptInSandbox } from '../lib/scriptRunner';
