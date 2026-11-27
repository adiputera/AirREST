import { ApiResponse } from '../types/api';
import { ScriptExecutor, ScriptInput, ScriptRequest, ScriptMutatedRequest, ScriptTestResult } from '../types/platform';
import { validateScriptInput, validateScriptOutput } from './scriptProtocol';

let sandboxIframe: HTMLIFrameElement | null = null;
let isIframeReady = false;
let injectedScriptExecutor: ScriptExecutor | null = null;

export function setScriptExecutor(executor: ScriptExecutor | null) {
  injectedScriptExecutor = executor;
}

export function getScriptExecutor(): ScriptExecutor | null {
  return injectedScriptExecutor;
}

interface IframeWaiter {
  resolve: (iframe: HTMLIFrameElement) => void;
  reject: (err: Error) => void;
}

const pendingIframeWaiters: IframeWaiter[] = [];
const activeDisposableIframes = new Set<{
  iframe: HTMLIFrameElement;
  dispose: (reason?: string) => void;
}>();

function removeIframeElement(iframe: HTMLIFrameElement | null): void {
  if (!iframe) return;
  try {
    iframe.onload = null;
    iframe.onerror = null;
    iframe.remove();
  } catch {
    // ignore DOM removal errors
  }
}

export function resetSandboxIframe(): void {
  const waiters = pendingIframeWaiters.splice(0, pendingIframeWaiters.length);
  for (const w of waiters) {
    w.reject(new Error('Sandbox iframe was reset or destroyed'));
  }
  if (sandboxIframe) {
    removeIframeElement(sandboxIframe);
    sandboxIframe = null;
    isIframeReady = false;
  }
  for (const entry of Array.from(activeDisposableIframes)) {
    entry.dispose('Sandbox iframe was reset or destroyed');
  }
  activeDisposableIframes.clear();
}

function createMountedSandboxIframe(): {
  promise: Promise<HTMLIFrameElement>;
  dispose: (reason?: string) => void;
} {
  let disposed = false;
  let iframe: HTMLIFrameElement | null = null;
  let rejectPending: ((err: Error) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const entry = {
    get iframe() {
      return iframe as HTMLIFrameElement;
    },
    dispose: (reason?: string) => {
      if (disposed) return;
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      activeDisposableIframes.delete(entry);
      removeIframeElement(iframe);
      iframe = null;
      if (rejectPending) {
        const rejectFn = rejectPending;
        rejectPending = null;
        rejectFn(new Error(reason || 'Sandbox iframe was reset or destroyed'));
      }
    },
  };

  const promise = new Promise<HTMLIFrameElement>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('Document is not available in current execution environment'));
      return;
    }

    rejectPending = reject;
    iframe = document.createElement('iframe');
    if (typeof iframe.setAttribute === 'function') {
      iframe.setAttribute('sandbox', 'allow-scripts');
    }
    iframe.style.display = 'none';
    iframe.src = 'sandbox.html';
    activeDisposableIframes.add(entry);

    timer = setTimeout(() => {
      if (disposed) return;
      entry.dispose('Timed out waiting for sandbox iframe readiness');
    }, 3000);

    iframe.onload = () => {
      if (disposed || !iframe) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      rejectPending = null;
      resolve(iframe);
    };
    iframe.onerror = (err) => {
      if (disposed) return;
      entry.dispose('Failed to load sandbox iframe: ' + String(err));
    };

    document.body.appendChild(iframe);
  });

  return { promise, dispose: entry.dispose };
}

export function getSandboxIframe(): Promise<HTMLIFrameElement> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('Document is not available in current execution environment'));
      return;
    }

    if (sandboxIframe && isIframeReady) {
      resolve(sandboxIframe);
      return;
    }

    const timer = setTimeout(() => {
      const idx = pendingIframeWaiters.findIndex((w) => w.resolve === safeResolve);
      if (idx !== -1) {
        pendingIframeWaiters.splice(idx, 1);
        reject(new Error('Timed out waiting for sandbox iframe readiness'));
      }
    }, 3000);

    const safeResolve = (el: HTMLIFrameElement) => {
      clearTimeout(timer);
      resolve(el);
    };
    const safeReject = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };

    pendingIframeWaiters.push({ resolve: safeResolve, reject: safeReject });

    if (!sandboxIframe) {
      sandboxIframe = document.createElement('iframe');
      if (typeof sandboxIframe.setAttribute === 'function') {
        sandboxIframe.setAttribute('sandbox', 'allow-scripts');
      }
      sandboxIframe.style.display = 'none';
      sandboxIframe.src = 'sandbox.html';
      sandboxIframe.onload = () => {
        isIframeReady = true;
        const waiters = pendingIframeWaiters.splice(0, pendingIframeWaiters.length);
        for (const w of waiters) {
          w.resolve(sandboxIframe!);
        }
      };
      sandboxIframe.onerror = (err) => {
        const waiters = pendingIframeWaiters.splice(0, pendingIframeWaiters.length);
        for (const w of waiters) {
          w.reject(new Error('Failed to load sandbox iframe: ' + String(err)));
        }
      };
      document.body.appendChild(sandboxIframe);
    }
  });
}

export interface ScriptExecutionResult {
  success: boolean;
  environment: Record<string, string>;
  variables: Record<string, string>;
  error?: string;
  mutatedRequest?: ScriptMutatedRequest;
  testResults?: ScriptTestResult[];
  nextRequest?: string | null;
}

/**
 * Executes a pre-request script inside an isolated sandbox (QuickJS worker in desktop or iframe in extension).
 */
export async function executePreRequestScript(
  script: string,
  environment: Record<string, string> = {},
  variables: Record<string, string> = {},
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    scriptExecutor?: ScriptExecutor;
    request?: ScriptRequest;
    iterationData?: Record<string, string>;
  }
): Promise<ScriptExecutionResult> {
  if (!script || !script.trim()) {
    return {
      success: true,
      environment,
      variables,
    };
  }

  const executor = options?.scriptExecutor || injectedScriptExecutor;
  if (executor) {
    return executor.execute(
      { script, request: options?.request, environment, variables, iterationData: options?.iterationData },
      { signal: options?.signal, timeoutMs: options?.timeoutMs }
    );
  }

  return runScriptInSandbox(script, undefined, environment, variables, options);
}

/**
 * Executes a post-response script (tests, token extraction) with pm.response object.
 */
export async function executePostResponseScript(
  script: string,
  response: ApiResponse,
  environment: Record<string, string> = {},
  variables: Record<string, string> = {},
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    scriptExecutor?: ScriptExecutor;
    request?: ScriptRequest;
    iterationData?: Record<string, string>;
  }
): Promise<ScriptExecutionResult> {
  if (!script || !script.trim()) {
    return {
      success: true,
      environment,
      variables,
    };
  }

  const executor = options?.scriptExecutor || injectedScriptExecutor;
  if (executor) {
    return executor.execute(
      {
        script,
        request: options?.request,
        environment,
        variables,
        iterationData: options?.iterationData,
        response: {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          data: response.data,
          timeMs: response.timeMs,
        },
      },
      { signal: options?.signal, timeoutMs: options?.timeoutMs }
    );
  }

  return runScriptInSandbox(script, response, environment, variables, options);
}

export async function runScriptInSandbox(
  script: string,
  response: ApiResponse | undefined,
  environment: Record<string, string>,
  variables: Record<string, string>,
  options?: { signal?: AbortSignal; timeoutMs?: number; request?: ScriptRequest; iterationData?: Record<string, string> }
): Promise<ScriptExecutionResult> {
  if (options?.signal?.aborted) {
    return {
      success: false,
      error: 'Script execution aborted.',
      environment,
      variables,
    };
  }

  const scriptInput: ScriptInput = {
    script,
    request: options?.request,
    response: response ? {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data: response.data,
      timeMs: response.timeMs,
    } : undefined,
    environment,
    variables,
    iterationData: options?.iterationData,
  };

  const validation = validateScriptInput(scriptInput);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error || 'Invalid script input.',
      environment,
      variables,
    };
  }

  let disposableHandle: ReturnType<typeof createMountedSandboxIframe> | null = null;
  try {
    // Isolate each script run inside a fresh disposable sandbox iframe so globals, prototypes,
    // or CryptoJS state from one script cannot poison subsequent script runs.
    disposableHandle = createMountedSandboxIframe();
    const iframe = await disposableHandle.promise;
    if (options?.signal?.aborted) {
      disposableHandle.dispose();
      return {
        success: false,
        error: 'Script execution aborted.',
        environment,
        variables,
      };
    }

    const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

    const timeoutMs = options?.timeoutMs ?? 2000;
    const isOpaqueSandboxOrigin =
      typeof iframe.getAttribute !== 'function' ||
      !(iframe.getAttribute('sandbox') || '').includes('allow-same-origin');

    return new Promise((resolve) => {
      let isSettled = false;
      const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;

      const cleanup = () => {
        clearTimeout(timer);
        if (channel) {
          channel.port1.onmessage = null;
          try {
            channel.port1.close();
          } catch {
            // ignore close error
          }
          try {
            channel.port2.close();
          } catch {
            // ignore close error
          }
        }
        if (typeof window !== 'undefined') {
          window.removeEventListener('message', handleMessage);
        }
        if (options?.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
        disposableHandle?.dispose();
      };

      const acceptResult = (payload: unknown) => {
        if (!payload || typeof payload !== 'object' || (payload as { id?: unknown }).id !== id) return;
        if (isSettled) return;
        isSettled = true;
        cleanup();

        const validated = validateScriptOutput(payload, scriptInput);
        resolve(validated);
      };

      const timer = setTimeout(() => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        resolve({
          success: false,
          error: `Script timed out after ${timeoutMs}ms.`,
          environment,
          variables,
        });
      }, timeoutMs);

      const onAbort = () => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        resolve({
          success: false,
          error: 'Script execution aborted.',
          environment,
          variables,
        });
      };

      if (options?.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      if (channel) {
        channel.port1.onmessage = (portEvent: MessageEvent) => {
          acceptResult(portEvent.data);
        };
      }

      const handleMessage = (event: MessageEvent) => {
        // Enforce source check: message must come strictly from the target iframe content window
        if (event.source !== iframe.contentWindow) return;
        if (isOpaqueSandboxOrigin && typeof event.origin === 'string' && event.origin !== 'null') return;
        acceptResult(event.data);
      };

      if (typeof window !== 'undefined') {
        window.addEventListener('message', handleMessage);
      }

      const messagePayload = {
        id,
        script,
        request: scriptInput.request,
        response: scriptInput.response,
        environment,
        variables,
        iterationData: scriptInput.iterationData,
      };
      if (channel) {
        iframe.contentWindow?.postMessage(messagePayload, '*', [channel.port2]);
      } else {
        iframe.contentWindow?.postMessage(messagePayload, '*');
      }
    });
  } catch (err: unknown) {
    disposableHandle?.dispose();
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      environment,
      variables,
    };
  }
}
