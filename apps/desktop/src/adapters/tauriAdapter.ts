import {
  PlatformAdapter,
  TestTransport,
  CloudTransport,
  ScriptExecutor,
  ScriptInput,
  ScriptResult,
  NetworkErrorCategory,
  TestRequestOptions,
  TransportInit,
  FileOptions,
} from '@airrest/common';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { save as tauriSave, open as tauriOpen } from '@tauri-apps/plugin-dialog';
import {
  writeFile as tauriWriteFile,
  writeTextFile as tauriWriteTextFile,
  readTextFile as tauriReadTextFile,
} from '@tauri-apps/plugin-fs';
import type {
  ScriptWorkerRequest,
  ScriptWorkerResponse,
} from '@airrest/common/protocol';
import { SCRIPT_LIMITS, validateScriptInput } from '@airrest/common/protocol';
import { runQuickJsGuest } from '../scripts/quickjsRunner';

export function classifyTauriNetworkError(error: unknown): {
  category: NetworkErrorCategory;
  code?: string;
  detail: string;
} {
  const detail = error instanceof Error ? error.message : String(error);
  const upper = detail.toUpperCase();

  let category: NetworkErrorCategory = 'other';
  if (
    upper.includes('CERT') ||
    upper.includes('AUTHORITY') ||
    upper.includes('SSL') ||
    upper.includes('TLS') ||
    upper.includes('INVALID_CERT')
  ) {
    category = 'ssl';
  } else if (
    upper.includes('CONNECTION REFUSED') ||
    upper.includes('REFUSED') ||
    upper.includes('CONNECT')
  ) {
    category = 'connection_refused';
  } else if (
    upper.includes('RESOLVE') ||
    upper.includes('DNS') ||
    upper.includes('NAME_NOT_RESOLVED') ||
    upper.includes('NO SUCH HOST')
  ) {
    category = 'dns';
  } else if (
    upper.includes('TIMED OUT') ||
    upper.includes('TIMEOUT') ||
    upper.includes('DEADLINE')
  ) {
    category = 'timeout';
  }

  return { category, detail };
}

export const tauriTestTransport: TestTransport = {
  fetch: async (url: string, init: TransportInit, options?: TestRequestOptions) => {
    return tauriFetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
      maxRedirections: options?.followRedirects === false ? 0 : undefined,
      danger: options?.ignoreSslErrors
        ? { acceptInvalidCerts: true, acceptInvalidHostnames: true }
        : undefined,
    });
  },
  classifyError: async (error: unknown) => {
    return classifyTauriNetworkError(error);
  },
};

export const tauriCloudTransport: CloudTransport = {
  fetch: async (url: string, init: TransportInit) => {
    // Cloud sync strictly enforces standard TLS with zero bypasses.
    // maxRedirections: 0 prevents reqwest / Tauri HTTP from automatically following redirects,
    // avoiding credential leaks or unintended host transitions.
    return tauriFetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
      maxRedirections: 0,
    });
  },
};

interface ActiveWorkerRecord {
  terminate: () => void;
  abort: () => void;
}

const activeWorkerRecords = new Set<ActiveWorkerRecord>();

export const tauriScriptExecutor: ScriptExecutor = {
  execute: async (input: ScriptInput, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ScriptResult> => {
    if (options?.signal?.aborted) {
      return {
        success: false,
        error: 'Script execution was aborted before evaluation.',
        environment: { ...(input.environment || {}) },
        variables: { ...(input.variables || {}) },
      };
    }

    // Pre-validate input before starting worker / structured cloning
    const val = validateScriptInput(input);
    if (!val.valid) {
      return {
        success: false,
        error: val.error || 'Invalid script input.',
        environment: { ...(input.environment || {}) },
        variables: { ...(input.variables || {}) },
      };
    }

    // In browser/Tauri Webview environment with Web Worker support, execute in dedicated worker
    // to avoid freezing the UI event loop and to allow immediate worker termination on cancel.
    if (typeof Worker !== 'undefined') {
      return new Promise<ScriptResult>((resolve) => {
        let worker: Worker | null = null;
        let isSettled = false;
        let startupTimer: ReturnType<typeof setTimeout> | null = null;
        let evalWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
          if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimer = null;
          }
          if (evalWatchdogTimer) {
            clearTimeout(evalWatchdogTimer);
            evalWatchdogTimer = null;
          }
          if (worker) {
            try {
              worker.terminate();
            } catch {
              // ignore worker termination error
            }
            worker = null;
          }
          if (workerRecord) {
            activeWorkerRecords.delete(workerRecord);
          }
          if (options?.signal && onAbort) {
            options.signal.removeEventListener('abort', onAbort);
          }
        };

        const onAbort = () => {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          resolve({
            success: false,
            error: 'Script execution aborted.',
            environment: { ...(input.environment || {}) },
            variables: { ...(input.variables || {}) },
          });
        };

        const workerRecord: ActiveWorkerRecord = {
          terminate: () => {
            if (worker) {
              try {
                worker.terminate();
              } catch {
                // ignore termination error
              }
              worker = null;
            }
          },
          abort: onAbort,
        };
        activeWorkerRecords.add(workerRecord);

        try {
          worker = new Worker(new URL('../scripts/quickjs.worker.ts', import.meta.url), {
            type: 'module',
          });

          if (options?.signal) {
            options.signal.addEventListener('abort', onAbort, { once: true });
          }

          const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const timeoutMs = options?.timeoutMs ?? SCRIPT_LIMITS.DEFAULT_TIMEOUT_MS;

          // Host startup timeout: if worker fails to initialize within 5000ms
          startupTimer = setTimeout(() => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            resolve({
              success: false,
              error: 'Worker failed to initialize within 5000ms startup timeout.',
              environment: { ...(input.environment || {}) },
              variables: { ...(input.variables || {}) },
            });
          }, 5000);

          worker.onmessage = (e: MessageEvent<ScriptWorkerResponse>) => {
            if (isSettled) return;
            if (!e.data || e.data.id !== reqId) return;

            if (e.data.type === 'EVAL_START') {
              // Startup succeeded: clear startup timer and start evaluation watchdog
              if (startupTimer) {
                clearTimeout(startupTimer);
                startupTimer = null;
              }
              if (!evalWatchdogTimer) {
                evalWatchdogTimer = setTimeout(() => {
                  if (isSettled) return;
                  isSettled = true;
                  cleanup();
                  resolve({
                    success: false,
                    error: 'Script execution timed out (host watchdog).',
                    environment: { ...(input.environment || {}) },
                    variables: { ...(input.variables || {}) },
                  });
                }, timeoutMs + 200);
              }
              return;
            }

            if (e.data.type === 'RESULT') {
              isSettled = true;
              cleanup();
              resolve(e.data.result);
            }
          };

          worker.onerror = (err: ErrorEvent) => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            resolve({
              success: false,
              error: err.message || 'Worker execution error.',
              environment: { ...(input.environment || {}) },
              variables: { ...(input.variables || {}) },
            });
          };

          const req: ScriptWorkerRequest = {
            id: reqId,
            type: 'EXECUTE',
            input,
            timeoutMs,
          };
          worker.postMessage(req);
        } catch (err: unknown) {
          cleanup();
          // Never fall back to UI thread execution on desktop to prevent freezing the interface
          resolve({
            success: false,
            error: `Failed to initialize worker sandbox: ${err instanceof Error ? err.message : String(err)}`,
            environment: { ...(input.environment || {}) },
            variables: { ...(input.variables || {}) },
          });
        }
      });
    }

    // Direct isolated runner (for headless test runners without DOM Worker)
    return runQuickJsGuest(input, options);
  },
  dispose: () => {
    for (const record of activeWorkerRecords) {
      try {
        record.abort();
        record.terminate();
      } catch {
        // ignore
      }
    }
    activeWorkerRecords.clear();
  },
};

export const tauriAdapter: PlatformAdapter = {
  platformId: 'desktop',
  capabilities: {
    supportsCustomForbiddenHeaders: true,
    supportsIgnoreSslErrors: true,
    supportsNativeFileSystem: true,
    supportsManualRedirectResponse: true,
  },
  transport: tauriTestTransport,
  cloudTransport: tauriCloudTransport,
  scriptExecutor: tauriScriptExecutor,
  saveFile: async (filename: string, content: string | Uint8Array, options?: FileOptions) => {
    const selectedPath = await tauriSave({
      defaultPath: filename,
      filters: options?.filters,
    });
    if (!selectedPath) return false;

    try {
      if (content instanceof Uint8Array) {
        await tauriWriteFile(selectedPath, content);
      } else {
        await tauriWriteTextFile(selectedPath, content);
      }
      return true;
    } catch (err) {
      console.error('Failed to write file via native dialog:', err);
      throw err;
    }
  },
  openFile: async (options?: FileOptions) => {
    const selected = await tauriOpen({
      multiple: false,
      directory: false,
      filters: options?.filters,
    });
    if (!selected) return null;

    try {
      const filePath = Array.isArray(selected) ? selected[0] : selected;
      const content = await tauriReadTextFile(filePath);
      const filename = filePath.split(/[/\\]/).pop() || 'file';
      return { filename, content };
    } catch (err) {
      console.error('Failed to read file via native dialog:', err);
      throw err;
    }
  },
  hasHostPermission: async () => true,
  requestHostPermission: async () => true,
  dispose: () => {
    tauriScriptExecutor.dispose();
  },
};

