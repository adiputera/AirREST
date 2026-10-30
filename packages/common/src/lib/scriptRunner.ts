import { ApiResponse } from '../types/api';
import { ScriptExecutor, ScriptInput } from '../types/platform';
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

export function resetSandboxIframe(): void {
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

    if (!sandboxIframe) {
      sandboxIframe = document.createElement('iframe');
      sandboxIframe.style.display = 'none';
      sandboxIframe.src = 'sandbox.html';
      sandboxIframe.onload = () => {
        isIframeReady = true;
        resolve(sandboxIframe!);
      };
      sandboxIframe.onerror = (err) => {
        reject(new Error('Failed to load sandbox iframe: ' + String(err)));
      };
      document.body.appendChild(sandboxIframe);
    } else {
      let attempts = 0;
      const checkInterval = setInterval(() => {
        attempts++;
        if (isIframeReady && sandboxIframe) {
          clearInterval(checkInterval);
          resolve(sandboxIframe);
        } else if (attempts > 60) {
          clearInterval(checkInterval);
          reject(new Error('Timed out waiting for sandbox iframe readiness'));
        }
      }, 50);
    }
  });
}

export interface ScriptExecutionResult {
  success: boolean;
  environment: Record<string, string>;
  variables: Record<string, string>;
  error?: string;
}

/**
 * Executes a pre-request script inside an isolated sandbox (QuickJS worker in desktop or iframe in extension).
 */
export async function executePreRequestScript(
  script: string,
  environment: Record<string, string> = {},
  variables: Record<string, string> = {},
  options?: { signal?: AbortSignal; scriptExecutor?: ScriptExecutor }
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
      { script, environment, variables },
      { signal: options?.signal }
    );
  }

  return runScriptInSandbox(script, undefined, environment, variables);
}

/**
 * Executes a post-response script (tests, token extraction) with pm.response object.
 */
export async function executePostResponseScript(
  script: string,
  response: ApiResponse,
  environment: Record<string, string> = {},
  variables: Record<string, string> = {},
  options?: { signal?: AbortSignal; scriptExecutor?: ScriptExecutor }
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
      { signal: options?.signal }
    );
  }

  return runScriptInSandbox(script, response, environment, variables);
}

export async function runScriptInSandbox(
  script: string,
  response: ApiResponse | undefined,
  environment: Record<string, string>,
  variables: Record<string, string>
): Promise<ScriptExecutionResult> {
  const scriptInput: ScriptInput = {
    script,
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
    const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

    return new Promise((resolve) => {
      let isSettled = false;

      const timer = setTimeout(() => {
        if (isSettled) return;
        isSettled = true;
        window.removeEventListener('message', handleMessage);
        resetSandboxIframe();
        resolve({
          success: false,
          error: 'Script timed out after 2000ms.',
          environment,
          variables,
        });
      }, 2000);

      const handleMessage = (event: MessageEvent) => {
        // Enforce source check: message must come strictly from the target iframe content window
        if (event.source !== iframe.contentWindow) return;
        // Verify matching execution ID and object envelope
        if (!event.data || typeof event.data !== 'object' || event.data.id !== id) return;

        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        window.removeEventListener('message', handleMessage);

        const validated = validateScriptOutput(event.data, scriptInput);
        resolve(validated);
      };

      window.addEventListener('message', handleMessage);

      iframe.contentWindow?.postMessage(
        {
          id,
          script,
          response,
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
