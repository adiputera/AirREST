import type { ApiResponse, NetworkErrorCategory } from './api';

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
  // Construct approved transport options explicitly; no test-request options.
  fetch(url: string, init: TransportInit): Promise<Response>;
}

export interface PlatformCapabilities {
  supportsCustomForbiddenHeaders: boolean;
  supportsIgnoreSslErrors: boolean;
  supportsNativeFileSystem: boolean;
  supportsManualRedirectResponse: boolean;
}

export type ScriptResponse = Pick<ApiResponse,
  'status' | 'statusText' | 'headers' | 'data' | 'timeMs'>;

export interface ScriptInput {
  script: string;
  response?: ScriptResponse;
  environment: Record<string, string>;
  variables: Record<string, string>;
}

export interface ScriptResult {
  success: boolean;
  environment: Record<string, string>;
  variables: Record<string, string>;
  error?: string;
}

export interface ScriptExecutor {
  execute(input: ScriptInput, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ScriptResult>;
  dispose(): void;
}

export interface FileOptions {
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface PlatformAdapter {
  platformId: 'extension' | 'desktop' | 'android' | 'web';
  capabilities: PlatformCapabilities;
  transport: TestTransport;
  cloudTransport: CloudTransport;
  scriptExecutor: ScriptExecutor;
  saveFile(
    filename: string,
    content: string | Uint8Array,
    options?: FileOptions & { mimeType?: string }
  ): Promise<boolean>;
  openFile(options?: FileOptions): Promise<{ filename: string; content: string } | null>;
  hasHostPermission(url: string): Promise<boolean | null>;
  requestHostPermission(url: string): Promise<boolean>;
  dispose(): void;
}
