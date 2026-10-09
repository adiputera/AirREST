import { ApiResponse } from '@/types/api';

let sandboxIframe: HTMLIFrameElement | null = null;
let isIframeReady = false;

function getSandboxIframe(): Promise<HTMLIFrameElement> {
  return new Promise((resolve) => {
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
      document.body.appendChild(sandboxIframe);
    } else {
      const checkInterval = setInterval(() => {
        if (isIframeReady) {
          clearInterval(checkInterval);
          resolve(sandboxIframe!);
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
 * Executes a pre-request script inside an isolated sandboxed iframe.
 */
export async function executePreRequestScript(
  script: string,
  environment: Record<string, string> = {},
  variables: Record<string, string> = {}
): Promise<ScriptExecutionResult> {
  if (!script || !script.trim()) {
    return {
      success: true,
      environment,
      variables,
    };
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
  variables: Record<string, string> = {}
): Promise<ScriptExecutionResult> {
  if (!script || !script.trim()) {
    return {
      success: true,
      environment,
      variables,
    };
  }

  return runScriptInSandbox(script, response, environment, variables);
}

async function runScriptInSandbox(
  script: string,
  response: ApiResponse | undefined,
  environment: Record<string, string>,
  variables: Record<string, string>
): Promise<ScriptExecutionResult> {
  try {
    const iframe = await getSandboxIframe();
    const id = Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', handleMessage);
        resolve({
          success: false,
          error: 'Script timed out after 2000ms.',
          environment,
          variables,
        });
      }, 2000);

      const handleMessage = (event: MessageEvent) => {
        if (event.data && event.data.id === id) {
          clearTimeout(timer);
          window.removeEventListener('message', handleMessage);
          resolve({
            success: Boolean(event.data.success),
            environment: event.data.environment || environment,
            variables: event.data.variables || variables,
            error: event.data.error,
          });
        }
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
