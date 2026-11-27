import {
  PlatformAdapter,
  TestTransport,
  CloudTransport,
  ScriptExecutor,
  ApiResponse,
  FileOptions,
  runScriptInSandbox,
  resetSandboxIframe,
  hasHostPermission,
  requestHostPermission,
  categorizeNetworkError,
  getChromiumNetworkError,
  readBrowserFiles,
} from '@airrest/common/platform';

function pickBrowserFiles(options?: FileOptions, multiple = false): Promise<File[]> {
  if (typeof document === 'undefined') return Promise.resolve([]);
  return new Promise<File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
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
      const files = Array.from(input.files || []);
      cleanup();
      resolve(files);
    };

    input.oncancel = () => {
      cleanup();
      resolve([]);
    };

    input.click();
  });
}

export const chromeTransport: TestTransport = {
  fetch: async (url, init, options) => {
    return fetch(url, {
      ...init,
      redirect: options?.followRedirects === false ? 'manual' : 'follow',
      cache: 'no-store',
    });
  },
  classifyError: async (error, url) => {
    const errorMsg = error instanceof Error ? error.message : String(error);
    let netErrorCode: string | null = null;
    if (url) {
      netErrorCode = await getChromiumNetworkError(url);
    }
    const category = categorizeNetworkError(netErrorCode || errorMsg);
    return {
      category,
      code: netErrorCode || undefined,
      detail: errorMsg,
    };
  },
};

export const chromeCloudTransport: CloudTransport = {
  supportsCredentials: true,
  fetch: async (url, init) => {
    return fetch(url, {
      ...init,
      redirect: 'manual',
      cache: 'no-store',
    });
  },
};

export const chromeScriptExecutor: ScriptExecutor = {
  execute: async (input, options) => {
    return runScriptInSandbox(
      input.script,
      input.response as ApiResponse | undefined,
      input.environment,
      input.variables,
      {
        ...options,
        request: input.request,
        iterationData: input.iterationData,
      }
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
      ? new Blob([content as unknown as BlobPart], { type: 'application/octet-stream' })
      : new Blob([content], { type: options?.mimeType || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    if (a.style) a.style.display = 'none';
    document.body?.appendChild?.(a);
    a.click();
    a.remove?.();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  },
  openFile: async (options) => {
    const [file] = await pickBrowserFiles(options, false);
    if (!file) return null;
    const [result] = await readBrowserFiles([file]);
    if (!result) return null;
    if (result.error) {
      throw new Error(result.error);
    }
    return {
      filename: result.filename,
      content: result.content,
    };
  },
  openFiles: async (options) => {
    const files = await pickBrowserFiles(options, true);
    if (files.length === 0) return [];
    const requireJson = Boolean(
      options?.filters?.length &&
      options.filters.every((filter) =>
        filter.extensions.every((ext) => ext.replace(/^\./, '').toLowerCase() === 'json')
      )
    );
    return readBrowserFiles(files, requireJson ? { requireJsonExtension: true } : undefined);
  },
  hasHostPermission,
  requestHostPermission,
  dispose: () => {
    resetSandboxIframe();
  },
};
