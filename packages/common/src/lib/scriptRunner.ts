import { ApiResponse } from '../types/api';
import { ScriptExecutor, ScriptInput, ScriptRequest, ScriptMutatedRequest } from '../types/platform';
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

export function resetSandboxIframe(): void {
  const waiters = pendingIframeWaiters.splice(0, pendingIframeWaiters.length);
  for (const w of waiters) {
    w.reject(new Error('Sandbox iframe was reset or destroyed'));
  }
  if (sandboxIframe) {
    try {
      sandboxIframe.remove();
    } catch {
      // ignore DOM removal errors
    }
    sandboxIframe = null;
    isIframeReady = false;
  }
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
}

/**
 * Executes a pre-request script inside an isolated sandbox (QuickJS worker in desktop or iframe in extension).
 */
export async function executePreRequestScript(
  script: string,
  environment: Record<string, string> = {},
  variables: Record<string, string> = {},
  options?: { signal?: AbortSignal; timeoutMs?: number; scriptExecutor?: ScriptExecutor; request?: ScriptRequest }
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
      { script, request: options?.request, environment, variables },
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
  options?: { signal?: AbortSignal; timeoutMs?: number; scriptExecutor?: ScriptExecutor; request?: ScriptRequest }
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
  options?: { signal?: AbortSignal; timeoutMs?: number; request?: ScriptRequest }
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

  try {
    const iframe = await getSandboxIframe();
    if (options?.signal?.aborted) {
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

    return new Promise((resolve) => {
      let isSettled = false;

      const cleanup = () => {
        clearTimeout(timer);
        if (typeof window !== 'undefined') {
          window.removeEventListener('message', handleMessage);
        }
        if (options?.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
      };

      const timer = setTimeout(() => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        resetSandboxIframe();
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
        resetSandboxIframe();
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

      const handleMessage = (event: MessageEvent) => {
        // Enforce source check: message must come strictly from the target iframe content window
        if (event.source !== iframe.contentWindow) return;
        // Verify matching execution ID and object envelope
        if (!event.data || typeof event.data !== 'object' || event.data.id !== id) return;

        if (isSettled) return;
        isSettled = true;
        cleanup();

        const validated = validateScriptOutput(event.data, scriptInput);
        resolve(validated);
      };

      if (typeof window !== 'undefined') {
        window.addEventListener('message', handleMessage);
      }

      iframe.contentWindow?.postMessage(
        {
          id,
          script,
          request: scriptInput.request,
          response: scriptInput.response,
          environment,
          variables,
        },
        '*'
      );
    });
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      environment,
      variables,
    };
  }
}
