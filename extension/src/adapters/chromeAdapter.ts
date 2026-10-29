import {
  PlatformAdapter,
  TestTransport,
  CloudTransport,
  ScriptExecutor,
  runScriptInSandbox,
  resetSandboxIframe,
  hasHostPermission,
  requestHostPermission,
  categorizeNetworkError,
} from '@airrest/common';

export const chromeTransport: TestTransport = {
  fetch: async (url, init, options) => {
    return fetch(url, {
      ...init,
      redirect: options?.followRedirects === false ? 'manual' : 'follow',
      cache: 'no-store',
    });
  },
  classifyError: async (error) => {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      category: categorizeNetworkError(errorMsg),
      detail: errorMsg,
    };
  },
};

export const chromeCloudTransport: CloudTransport = {
  fetch: async (url, init) => {
    return fetch(url, {
      ...init,
      redirect: 'manual',
      cache: 'no-store',
    });
  },
};

export const chromeScriptExecutor: ScriptExecutor = {
  execute: async (input) => {
    return runScriptInSandbox(
      input.script,
      input.response as any,
      input.environment,
      input.variables
    );
  },
  dispose: () => {
    resetSandboxIframe();
  },
};

export const chromeAdapter: PlatformAdapter = {
  platformId: 'extension',
  capabilities: {
    supportsCustomForbiddenHeaders: false,
    supportsIgnoreSslErrors: false,
    supportsNativeFileSystem: false,
    supportsManualRedirectResponse: false,
  },
  transport: chromeTransport,
  cloudTransport: chromeCloudTransport,
  scriptExecutor: chromeScriptExecutor,
  saveFile: async (filename, content, options) => {
    const blob = content instanceof Uint8Array
      ? new Blob([content as any], { type: options?.mimeType || 'application/octet-stream' })
      : new Blob([content], { type: options?.mimeType || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return true;
  },
  openFile: async () => {
    return null;
  },
  hasHostPermission,
  requestHostPermission,
  dispose: () => {
    resetSandboxIframe();
  },
};
