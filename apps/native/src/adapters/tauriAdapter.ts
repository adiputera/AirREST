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
  OpenedFileResult,
  NativePerformanceRunner,
  NativePerformanceRunInput,
  NativePerformanceCallbacks,
  NativePerformanceTickPayload,
  NativePerformanceCompletePayload,
  NativePerformanceRunHandle,
} from '@airrest/common/platform';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save as tauriSave, open as tauriOpen } from '@tauri-apps/plugin-dialog';
import {
  writeFile as tauriWriteFile,
  writeTextFile as tauriWriteTextFile,
  readTextFile as tauriReadTextFile,
  stat as tauriStat,
} from '@tauri-apps/plugin-fs';
import type {
  ScriptWorkerRequest,
  ScriptWorkerResponse,
} from '@airrest/common/protocol';
import { SCRIPT_LIMITS, validateScriptInput } from '@airrest/common/protocol';
import { runQuickJsGuest } from '../scripts/quickjsRunner';
import {
  parseNativeCredential,
  serializeNativeCredential,
} from '@airrest/common/native-credentials';
import type { NativeCredentialStorage } from '@airrest/common/platform';

export const MAX_IMPORT_FILE_BYTES = 16 * 1024 * 1024; // 16 MiB
export const MAX_IMPORT_BATCH_FILES = 50;
export const MAX_IMPORT_BATCH_TOTAL_BYTES = 64 * 1024 * 1024; // 64 MiB

export function extractFilename(filePath: string): string {
  if (filePath.startsWith('content:')) {
    try {
      const decoded = decodeURIComponent(filePath).replace(/^content:\/\/[^/]*\/?/i, '');
      const segments = decoded.split(/[/?&#]/).filter(Boolean);
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i].split(/[:/\\]/).pop();
        if (seg && /\.[a-z0-9]+$/i.test(seg) && !seg.includes('%')) {
          return seg;
        }
      }
    } catch {
      // fallback
    }
    return 'import.json';
  }
  return filePath.split(/[/\\]/).pop() || 'file';
}

export function classifyTauriNetworkError(error: unknown): {
  category: NetworkErrorCategory;
  code?: string;
  detail: string;
} {
  let detail = '';
  if (error instanceof Error) {
    detail = error.message;
    if (error.cause) {
      detail += ` (${String(error.cause)})`;
    }
  } else if (typeof error === 'object' && error !== null) {
    const errObj = error as Record<string, unknown>;
    detail = String(errObj.message || errObj.error || errObj.detail || JSON.stringify(error));
  } else {
    detail = String(error);
  }

  const upper = detail.toUpperCase();

  let category: NetworkErrorCategory = 'other';
  if (
    upper.includes('CERT') ||
    upper.includes('AUTHORITY') ||
    upper.includes('SSL') ||
    upper.includes('TLS') ||
    upper.includes('INVALID_CERT') ||
    upper.includes('HANDSHAKE') ||
    upper.includes('TRUST ANCHOR') ||
    upper.includes('PKIX') ||
    upper.includes('ISSUER') ||
    upper.includes('X509')
  ) {
    category = 'ssl';
  } else if (
    upper.includes('CONNECTION REFUSED') ||
    upper.includes('REFUSED') ||
    upper.includes('ECONNREFUSED') ||
    upper.includes('CONNECT')
  ) {
    category = 'connection_refused';
  } else if (
    upper.includes('RESOLVE') ||
    upper.includes('DNS') ||
    upper.includes('NAME_NOT_RESOLVED') ||
    upper.includes('NO SUCH HOST') ||
    upper.includes('FAILED TO LOOKUP ADDRESS')
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

function nativeRequestHeaders(input: TransportInit['headers']): Headers {
  const headers = new Headers(input);
  // With unsafe-headers enabled, Tauri removes an empty Origin before sending.
  // Otherwise it injects the WebView origin, which can trigger server CORS checks.
  if (!headers.has('Origin')) headers.set('Origin', '');
  return headers;
}

export const tauriTestTransport: TestTransport = {
  fetch: async (url: string, init: TransportInit, options?: TestRequestOptions) => {
    return tauriFetch(url, {
      method: init.method,
      headers: nativeRequestHeaders(init.headers),
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

function combineSignals(signal?: AbortSignal | null, timeoutMs = 300000): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (!signal) return timeoutSignal;
    if ('any' in AbortSignal && typeof (AbortSignal as any).any === 'function') {
      return (AbortSignal as any).any([signal, timeoutSignal]);
    }
  }
  if (signal) return signal;
  if (typeof AbortController !== 'undefined') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    return controller.signal;
  }
  return undefined;
}

export const tauriCloudTransport: CloudTransport = {
  fetch: async (url: string, init: TransportInit) => {
    // Cloud sync strictly enforces standard TLS with zero bypasses.
    // maxRedirections: 0 prevents reqwest / Tauri HTTP from automatically following redirects,
    // avoiding credential leaks or unintended host transitions.
    // connectTimeout: 15000 guards against hanging TCP handshakes.
    const signal = combineSignals(init.signal as AbortSignal, 300000);
    return tauriFetch(url, {
      method: init.method,
      headers: nativeRequestHeaders(init.headers),
      body: init.body,
      signal,
      connectTimeout: 15000,
      maxRedirections: 0,
    });
  },
};

interface AndroidCredentialReadResult {
  value: string | null;
}

function credentialScopeKey(scope: { apiUrl: string; userId: string }): string {
  return JSON.stringify([scope.apiUrl, scope.userId]);
}

const tauriCredentialStorage: NativeCredentialStorage = {
  read: async (scope) => {
    const key = credentialScopeKey(scope);
    const raw = (await invoke<AndroidCredentialReadResult>('plugin:native-credential|read', { scope: key })).value;
    return raw === null ? null : parseNativeCredential(raw);
  },
  write: async (scope, record) => {
    const payload = { scope: credentialScopeKey(scope), value: serializeNativeCredential(record) };
    await invoke('plugin:native-credential|write', payload);
  },
  remove: async (scope) => {
    const payload = { scope: credentialScopeKey(scope) };
    await invoke('plugin:native-credential|remove', payload);
  },
};

interface ActiveWorkerRecord {
  terminate: () => void;
  abort: () => void;
}

const activeWorkerRecords = new Set<ActiveWorkerRecord>();

const ANDROID_EXTENSION_TO_MIME: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroenabled.12',
  '.xlsb': 'application/vnd.ms-excel.sheet.binary.macroenabled.12',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.md': 'text/markdown',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.bin': 'application/octet-stream',
};

export function resolveAndroidSaveMimeType(filename: string, mimeType?: string): string | undefined {
  const declared = (mimeType || '').split(';')[0].trim().toLowerCase();
  const extMatch = /(\.[a-z0-9]+)$/i.exec(filename.trim());
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  const expected = ext ? ANDROID_EXTENSION_TO_MIME[ext] : undefined;

  if (expected) {
    if (!declared || declared === 'application/octet-stream' || declared !== expected) {
      return expected;
    }
    return declared;
  }

  return declared || 'application/octet-stream';
}

export function dialogFilters(options?: FileOptions & { mimeType?: string }): FileOptions['filters'] {
  if (!__AIRREST_ANDROID__) return options?.filters;
  // Android's document picker filters by MIME type rather than extension.
  if (options?.filters && options.filters.length > 0) {
    return options.filters.map((filter) => ({
      ...filter,
      extensions: filter.extensions.map((extension) => {
        const lower = extension.toLowerCase();
        if (lower === 'json') return 'application/json';
        if (lower === 'csv') return 'text/csv';
        return extension;
      }),
    }));
  }
  if (options?.mimeType) {
    return [{ name: 'File', extensions: [options.mimeType] }];
  }
  return options?.filters;
}

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

async function readValidatedTauriTextFileWithSize(
  filePath: string,
  remainingBatchBytes?: number
): Promise<{ filename: string; content: string; utf8ByteLength: number }> {
  const fileInfo = typeof tauriStat === 'function' ? await tauriStat(filePath).catch(() => null) : null;
  if (fileInfo && typeof fileInfo.size === 'number') {
    if (fileInfo.size > MAX_IMPORT_FILE_BYTES) {
      throw new Error('Selected file exceeds maximum allowed limit of 16 MB.');
    }
    if (remainingBatchBytes !== undefined && fileInfo.size > remainingBatchBytes) {
      throw new Error('Import batch exceeds maximum total size limit of 64 MB.');
    }
  }
  const content = await tauriReadTextFile(filePath);
  let utf8ByteLength = 0;
  if (typeof TextEncoder !== 'undefined') {
    utf8ByteLength = new TextEncoder().encode(content).byteLength;
  } else {
    for (let i = 0; i < content.length; i++) {
      const code = content.charCodeAt(i);
      if (code < 0x80) utf8ByteLength += 1;
      else if (code < 0x800) utf8ByteLength += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < content.length) {
        utf8ByteLength += 4;
        i += 1;
      } else utf8ByteLength += 3;
    }
  }
  if (utf8ByteLength > MAX_IMPORT_FILE_BYTES) {
    throw new Error('Selected file exceeds maximum allowed limit of 16 MB.');
  }
  if (remainingBatchBytes !== undefined && utf8ByteLength > remainingBatchBytes) {
    throw new Error('Import batch exceeds maximum total size limit of 64 MB.');
  }
  const filename = extractFilename(filePath);
  return { filename, content, utf8ByteLength };
}

async function readValidatedTauriTextFile(filePath: string): Promise<{ filename: string; content: string }> {
  const { filename, content } = await readValidatedTauriTextFileWithSize(filePath);
  return { filename, content };
}

export function createReusableQuickJsPool(maxWorkers = 4): ScriptExecutor {
  const idleWorkers: Worker[] = [];
  const activeWorkers = new Set<Worker>();
  const waitQueue: Array<(worker: Worker) => void> = [];
  let disposed = false;

  const acquireWorker = (): Promise<Worker> => {
    if (idleWorkers.length > 0) {
      const w = idleWorkers.pop()!;
      activeWorkers.add(w);
      return Promise.resolve(w);
    }
    if (activeWorkers.size + idleWorkers.length < maxWorkers) {
      const w = new Worker(new URL('../scripts/quickjs.worker.ts', import.meta.url), {
        type: 'module',
      });
      activeWorkers.add(w);
      return Promise.resolve(w);
    }
    return new Promise<Worker>((resolve) => {
      waitQueue.push(resolve);
    });
  };

  const releaseWorker = (w: Worker, healthy: boolean) => {
    activeWorkers.delete(w);
    if (!healthy || disposed) {
      try {
        w.terminate();
      } catch {
        // ignore
      }
      if (!disposed && waitQueue.length > 0) {
        const nextWaiter = waitQueue.shift()!;
        const fresh = new Worker(new URL('../scripts/quickjs.worker.ts', import.meta.url), {
          type: 'module',
        });
        activeWorkers.add(fresh);
        nextWaiter(fresh);
      }
      return;
    }

    if (waitQueue.length > 0) {
      const nextWaiter = waitQueue.shift()!;
      activeWorkers.add(w);
      nextWaiter(w);
    } else {
      idleWorkers.push(w);
    }
  };

  return {
    execute: async (input: ScriptInput, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ScriptResult> => {
      if (disposed || options?.signal?.aborted) {
        return {
          success: false,
          error: 'Script execution was aborted before evaluation.',
          environment: { ...(input.environment || {}) },
          variables: { ...(input.variables || {}) },
        };
      }
      const val = validateScriptInput(input);
      if (!val.valid) {
        return {
          success: false,
          error: val.error || 'Invalid script input.',
          environment: { ...(input.environment || {}) },
          variables: { ...(input.variables || {}) },
        };
      }
      if (typeof Worker === 'undefined') {
        return runQuickJsGuest(input, options);
      }

      const worker = await acquireWorker();
      if (disposed || options?.signal?.aborted) {
        releaseWorker(worker, true);
        return {
          success: false,
          error: 'Script execution aborted.',
          environment: { ...(input.environment || {}) },
          variables: { ...(input.variables || {}) },
        };
      }

      return new Promise<ScriptResult>((resolve) => {
        let settled = false;
        let evalWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
        const reqId = `pool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timeoutMs = options?.timeoutMs ?? SCRIPT_LIMITS.DEFAULT_TIMEOUT_MS;

        const startupTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup(false);
          resolve({
            success: false,
            error: 'Pooled worker failed to start within 5000ms.',
            environment: { ...(input.environment || {}) },
            variables: { ...(input.variables || {}) },
          });
        }, 5000);

        const cleanup = (healthy: boolean) => {
          clearTimeout(startupTimer);
          if (evalWatchdogTimer) {
            clearTimeout(evalWatchdogTimer);
            evalWatchdogTimer = null;
          }
          worker.onmessage = null;
          worker.onerror = null;
          if (options?.signal) {
            options.signal.removeEventListener('abort', onAbort);
          }
          releaseWorker(worker, healthy);
        };

        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup(false);
          resolve({
            success: false,
            error: 'Script execution aborted.',
            environment: { ...(input.environment || {}) },
            variables: { ...(input.variables || {}) },
          });
        };

        if (options?.signal) {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }

        worker.onmessage = (e: MessageEvent<ScriptWorkerResponse>) => {
          if (settled || !e.data || e.data.id !== reqId) return;
          if (e.data.type === 'EVAL_START') {
            clearTimeout(startupTimer);
            if (!evalWatchdogTimer) {
              evalWatchdogTimer = setTimeout(() => {
                if (settled) return;
                settled = true;
                cleanup(false);
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
            settled = true;
            cleanup(true);
            resolve(e.data.result);
          }
        };

        worker.onerror = (err: ErrorEvent) => {
          if (settled) return;
          settled = true;
          cleanup(false);
          resolve({
            success: false,
            error: err.message || 'Pooled worker execution error.',
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
      });
    },
    dispose: () => {
      disposed = true;
      for (const w of idleWorkers.splice(0, idleWorkers.length)) {
        try {
          w.terminate();
        } catch {
          // ignore
        }
      }
      for (const w of activeWorkers) {
        try {
          w.terminate();
        } catch {
          // ignore
        }
      }
      activeWorkers.clear();
      waitQueue.length = 0;
    },
  };
}

export const tauriPerfScriptExecutor: ScriptExecutor = createReusableQuickJsPool(4);

export const tauriPerformanceRunner: NativePerformanceRunner = {
  maxVirtualUsers: 10000,
  startRun: async (
    input: NativePerformanceRunInput,
    callbacks: NativePerformanceCallbacks
  ): Promise<NativePerformanceRunHandle> => {
    let unlistenTick: (() => void) | null = null;
    let unlistenComplete: (() => void) | null = null;
    const cleanup = () => {
      if (unlistenTick) {
        unlistenTick();
        unlistenTick = null;
      }
      if (unlistenComplete) {
        unlistenComplete();
        unlistenComplete = null;
      }
    };

    try {
      unlistenTick = await listen<NativePerformanceTickPayload>('airrest:perf-tick', (event) => {
        if (event.payload?.runId === input.runId) {
          callbacks.onTick(event.payload);
        }
      });
      unlistenComplete = await listen<NativePerformanceCompletePayload>('airrest:perf-complete', (event) => {
        if (event.payload?.runId === input.runId) {
          cleanup();
          callbacks.onComplete(event.payload);
        }
      });

      const handle = await invoke<NativePerformanceRunHandle>('start_performance_run', { input });
      return handle;
    } catch (err) {
      cleanup();
      throw err;
    }
  },
  stopRun: async (runId: string) => {
    await invoke('stop_performance_run', { runId });
  },
  updateVariables: async (runId: string, variables: Record<string, string>) => {
    await invoke('update_performance_variables', { runId, variables });
  },
  checkCapacity: async () => {
    return invoke<{ softFdLimit?: number; hardFdLimit?: number }>('check_performance_capacity');
  },
};

export const tauriAdapter: PlatformAdapter = {
  platformId: typeof __AIRREST_ANDROID__ !== 'undefined' && __AIRREST_ANDROID__ ? 'android' : 'desktop',
  capabilities: {
    supportsCustomForbiddenHeaders: true,
    supportsIgnoreSslErrors: true,
    supportsNativeFileSystem: true,
    supportsManualRedirectResponse: true,
  },
  transport: tauriTestTransport,
  cloudTransport: tauriCloudTransport,
  credentialStorage: tauriCredentialStorage,
  scriptExecutor: tauriScriptExecutor,
  perfScriptExecutor: tauriPerfScriptExecutor,
  performanceRunner: typeof __AIRREST_ANDROID__ !== 'undefined' && __AIRREST_ANDROID__ ? undefined : tauriPerformanceRunner,
  saveFile: async (filename: string, content: string | Uint8Array, options?: FileOptions & { mimeType?: string }) => {
    const isAndroid = typeof __AIRREST_ANDROID__ !== 'undefined' && __AIRREST_ANDROID__;
    const filterOptions = isAndroid
      ? { ...options, mimeType: resolveAndroidSaveMimeType(filename, options?.mimeType) }
      : options;
    const selectedPath = await tauriSave({
      defaultPath: filename,
      filters: dialogFilters(filterOptions),
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
      filters: dialogFilters(options),
    });
    if (!selected) return null;

    try {
      const filePath = Array.isArray(selected) ? selected[0] : selected;
      return await readValidatedTauriTextFile(filePath);
    } catch (err) {
      console.error('Failed to read file via native dialog:', err);
      throw err;
    }
  },
  openFiles: async (options?: FileOptions): Promise<OpenedFileResult[]> => {
    const selected = await tauriOpen({
      multiple: true,
      directory: false,
      filters: dialogFilters(options),
    });
    if (!selected) return [];

    const paths = (Array.isArray(selected) ? selected : [selected]).filter(Boolean);
    if (paths.length === 0) return [];
    if (paths.length > MAX_IMPORT_BATCH_FILES) {
      return [
        {
          filename: `Batch (${paths.length} files)`,
          content: '',
          error: `Selected batch exceeds maximum allowed limit of ${MAX_IMPORT_BATCH_FILES} files.`,
        },
      ];
    }

    let totalBytes = 0;
    const results: OpenedFileResult[] = [];
    for (const filePath of paths) {
      const filename = extractFilename(filePath);
      try {
        const result = await readValidatedTauriTextFileWithSize(
          filePath,
          MAX_IMPORT_BATCH_TOTAL_BYTES - totalBytes
        );
        totalBytes += result.utf8ByteLength;
        results.push({ filename: result.filename, content: result.content });
      } catch (err) {
        console.error('Failed to read file via native dialog:', err);
        results.push({
          filename,
          content: '',
          error: err instanceof Error ? err.message : 'Failed to read selected file.',
        });
      }
    }
    return results;
  },
  hasHostPermission: async () => true,
  requestHostPermission: async () => true,
  dispose: () => {
    tauriScriptExecutor.dispose();
    tauriPerfScriptExecutor.dispose();
  },
};
