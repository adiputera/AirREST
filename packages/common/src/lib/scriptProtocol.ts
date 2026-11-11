import { ScriptInput, ScriptResult, ScriptRequest, ScriptMutatedRequest } from '../types/platform';
export type { ScriptInput, ScriptResult, ScriptRequest, ScriptMutatedRequest };

export const SCRIPT_LIMITS = {
  MAX_SCRIPT_BYTES: 256 * 1024, // 256 KiB
  MAX_SERIALIZED_ENV_BYTES: 1024 * 1024, // 1 MiB
  MAX_SERIALIZED_VARS_BYTES: 1024 * 1024, // 1 MiB
  MAX_RESPONSE_BYTES: 2 * 1024 * 1024, // 2 MiB
  MAX_HEAP_BYTES: 64 * 1024 * 1024, // 64 MiB
  MAX_STACK_BYTES: 512 * 1024, // 512 KiB
  DEFAULT_TIMEOUT_MS: 2000,
  STARTUP_TIMEOUT_MS: 5000,
} as const;

export interface ScriptWorkerRequest {
  id: string;
  type: 'EXECUTE';
  input: ScriptInput;
  timeoutMs?: number;
}

export type ScriptWorkerResponse =
  | { id: string; type: 'EVAL_START' }
  | { id: string; type: 'RESULT'; result: ScriptResult };

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function getUtf8ByteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

export function truncateUtf8Bytes(str: string, maxBytes: number): string {
  if (getUtf8ByteLength(str) <= maxBytes) return str;
  const suffix = '... (truncated)';
  const suffixBytes = getUtf8ByteLength(suffix);
  const targetBytes = Math.max(0, maxBytes - suffixBytes);
  let currentBytes = 0;
  let cutIndex = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    let charBytes = 1;
    let isPair = false;
    if (code > 0x7f) {
      if (code <= 0x7ff) {
        charBytes = 2;
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
        const nextCode = str.charCodeAt(i + 1);
        if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
          charBytes = 4;
          isPair = true;
        } else {
          charBytes = 3;
        }
      } else {
        charBytes = 3;
      }
    }
    if (currentBytes + charBytes > targetBytes) break;
    currentBytes += charBytes;
    cutIndex = isPair ? i + 2 : i + 1;
    if (isPair) i++;
  }
  return str.slice(0, cutIndex) + suffix;
}

export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

/**
 * Validates script input bounds and sanity before sending to sandbox.
 */
export function validateScriptInput(input: ScriptInput): { valid: boolean; error?: string } {
  if (input.script) {
    const scriptBytes = getUtf8ByteLength(input.script);
    if (scriptBytes > SCRIPT_LIMITS.MAX_SCRIPT_BYTES) {
      return {
        valid: false,
        error: `Script source size (${(scriptBytes / 1024).toFixed(1)} KiB) exceeded the limit of ${SCRIPT_LIMITS.MAX_SCRIPT_BYTES / 1024} KiB.`,
      };
    }
  }

  if (input.environment !== undefined) {
    if (!input.environment || typeof input.environment !== 'object' || Array.isArray(input.environment)) {
      return { valid: false, error: 'Input environment must be an object map.' };
    }
    for (const [k, v] of Object.entries(input.environment)) {
      if (isForbiddenKey(k)) {
        return { valid: false, error: `Input environment contains forbidden key "${k}".` };
      }
      if (typeof v !== 'string') {
        return { valid: false, error: `Environment key "${k}" must have a string value.` };
      }
    }
  }

  if (input.variables !== undefined) {
    if (!input.variables || typeof input.variables !== 'object' || Array.isArray(input.variables)) {
      return { valid: false, error: 'Input variables must be an object map.' };
    }
    for (const [k, v] of Object.entries(input.variables)) {
      if (isForbiddenKey(k)) {
        return { valid: false, error: `Input variables contains forbidden key "${k}".` };
      }
      if (typeof v !== 'string') {
        return { valid: false, error: `Variable key "${k}" must have a string value.` };
      }
    }
  }

  const envStr = JSON.stringify(input.environment || {});
  const envBytes = getUtf8ByteLength(envStr);
  if (envBytes > SCRIPT_LIMITS.MAX_SERIALIZED_ENV_BYTES) {
    return {
      valid: false,
      error: `Serialized environment size exceeded the 1 MiB limit.`,
    };
  }

  const varsStr = JSON.stringify(input.variables || {});
  const varsBytes = getUtf8ByteLength(varsStr);
  if (varsBytes > SCRIPT_LIMITS.MAX_SERIALIZED_VARS_BYTES) {
    return {
      valid: false,
      error: `Serialized variables size exceeded the 1 MiB limit.`,
    };
  }

  if (input.response?.data && typeof input.response.data === 'string') {
    if (getUtf8ByteLength(input.response.data) > SCRIPT_LIMITS.MAX_RESPONSE_BYTES) {
      input.response.data = truncateUtf8Bytes(input.response.data, SCRIPT_LIMITS.MAX_RESPONSE_BYTES);
    }
  }

  if (input.request !== undefined) {
    if (!input.request || typeof input.request !== 'object' || Array.isArray(input.request)) {
      return { valid: false, error: 'Input request must be an object map.' };
    }
    if (typeof input.request.url !== 'string') {
      return { valid: false, error: 'Input request.url must be a string.' };
    }
    if (getUtf8ByteLength(input.request.url) > 65536) {
      return { valid: false, error: 'Input request.url exceeded maximum allowed length.' };
    }
  }

  return { valid: true };
}

/**
 * Enforces strict boundary verification on the guest's return payload.
 * Guarantees that only valid, string-valued own properties are accepted,
 * and rolls back to initialInput if tampered or invalid.
 */
export function validateScriptOutput(rawResult: unknown, initialInput?: ScriptInput): ScriptResult {
  const fallbackEnv = initialInput?.environment ? { ...initialInput.environment } : {};
  const fallbackVars = initialInput?.variables ? { ...initialInput.variables } : {};

  if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
    return {
      success: false,
      error: 'Invalid result envelope received from script guest.',
      environment: fallbackEnv,
      variables: fallbackVars,
    };
  }

  const record = rawResult as Record<string, unknown>;

  if (typeof record.success !== 'boolean') {
    return {
      success: false,
      error: 'Script result missing boolean success indicator.',
      environment: fallbackEnv,
      variables: fallbackVars,
    };
  }

  if (!record.success) {
    let rawError = typeof record.error === 'string' ? record.error : 'Script execution failed.';
    if (getUtf8ByteLength(rawError) > 32768) {
      rawError = truncateUtf8Bytes(rawError, 32768);
    }
    return {
      success: false,
      error: rawError,
      environment: fallbackEnv,
      variables: fallbackVars,
    };
  }

  // Reject malformed or array environment/variables maps
  if (!record.environment || typeof record.environment !== 'object' || Array.isArray(record.environment)) {
    return {
      success: false,
      error: 'Script result contains invalid environment format (must be a key-value object).',
      environment: fallbackEnv,
      variables: fallbackVars,
    };
  }

  if (!record.variables || typeof record.variables !== 'object' || Array.isArray(record.variables)) {
    return {
      success: false,
      error: 'Script result contains invalid variables format (must be a key-value object).',
      environment: fallbackEnv,
      variables: fallbackVars,
    };
  }

  const sanitizedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(record.environment as Record<string, unknown>)) {
    if (isForbiddenKey(k)) {
      return {
        success: false,
        error: `Script result returned forbidden key "${k}" in environment.`,
        environment: fallbackEnv,
        variables: fallbackVars,
      };
    }
    if (typeof v !== 'string') {
      return {
        success: false,
        error: `Environment key "${k}" has non-string value. Only string values are allowed.`,
        environment: fallbackEnv,
        variables: fallbackVars,
      };
    }
    sanitizedEnv[k] = v;
  }

  const sanitizedVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(record.variables as Record<string, unknown>)) {
    if (isForbiddenKey(k)) {
      return {
        success: false,
        error: `Script result returned forbidden key "${k}" in variables.`,
        environment: fallbackEnv,
        variables: fallbackVars,
      };
    }
    if (typeof v !== 'string') {
      return {
        success: false,
        error: `Variable key "${k}" has non-string value. Only string values are allowed.`,
        environment: fallbackEnv,
        variables: fallbackVars,
      };
    }
    sanitizedVars[k] = v;
  }

  const envBytes = getUtf8ByteLength(JSON.stringify(sanitizedEnv));
  if (envBytes > SCRIPT_LIMITS.MAX_SERIALIZED_ENV_BYTES) {
    return {
      success: false,
      error: `Output environment size (${(envBytes / (1024 * 1024)).toFixed(2)} MiB) exceeded the 1 MiB limit.`,
      environment: fallbackEnv,
      variables: fallbackVars,
    };
  }

  const varsBytes = getUtf8ByteLength(JSON.stringify(sanitizedVars));
  if (varsBytes > SCRIPT_LIMITS.MAX_SERIALIZED_VARS_BYTES) {
    return {
      success: false,
      error: `Output variables size (${(varsBytes / (1024 * 1024)).toFixed(2)} MiB) exceeded the 1 MiB limit.`,
      environment: fallbackEnv,
      variables: fallbackVars,
    };
  }

  let sanitizedMutatedRequest: ScriptMutatedRequest | undefined;
  if (record.mutatedRequest && typeof record.mutatedRequest === 'object' && !Array.isArray(record.mutatedRequest)) {
    const mut = record.mutatedRequest as Record<string, unknown>;
    const queryParams: Array<{ key: string; value: string }> = [];
    if (Array.isArray(mut.queryParams)) {
      for (const q of mut.queryParams) {
        if (q && typeof q === 'object' && typeof q.key === 'string' && typeof q.value === 'string' && !isForbiddenKey(q.key)) {
          queryParams.push({ key: q.key, value: q.value });
        }
      }
    }
    const headers: Array<{ key: string; value: string }> = [];
    if (Array.isArray(mut.headers)) {
      for (const h of mut.headers) {
        if (h && typeof h === 'object' && typeof h.key === 'string' && typeof h.value === 'string' && !isForbiddenKey(h.key)) {
          headers.push({ key: h.key, value: h.value });
        }
      }
    }
    sanitizedMutatedRequest = {
      url: typeof mut.url === 'string' ? mut.url : undefined,
      queryParams,
      headers,
    };
  }

  return {
    success: true,
    environment: sanitizedEnv,
    variables: sanitizedVars,
    ...(sanitizedMutatedRequest ? { mutatedRequest: sanitizedMutatedRequest } : {}),
  };
}
