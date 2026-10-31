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
  openFile: async (options) => {
    if (typeof document === 'undefined') return null;
    return new Promise<{ filename: string; content: string } | null>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (options?.filters?.length) {
        const exts = options.filters.flatMap((f) =>
          f.extensions.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
        );
        input.accept = exts.join(',');
      }
      input.style.display = 'none';
      document.body.appendChild(input);

      let settled = false;
      const cleanup = () => {
        if (!settled) {
          settled = true;
          input.remove();
        }
      };

      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) {
          cleanup();
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
          cleanup();
          resolve({
            filename: file.name,
            content: (e.target?.result as string) || '',
          });
        };
        reader.onerror = () => {
          cleanup();
          resolve(null);
        };
        reader.readAsText(file);
      };

      input.oncancel = () => {
        cleanup();
        resolve(null);
      };

      input.click();
    });
  },
  hasHostPermission,
  requestHostPermission,
  dispose: () => {
    resetSandboxIframe();
  },
};
