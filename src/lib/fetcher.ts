import { ApiRequest, ApiResponse } from '@/types/api';

/**
 * Replaces {{variable}} placeholders with values from variables map
 * and dynamic Postman-style variables: {{$guid}}, {{$timestamp}}, {{$isoTimestamp}}, {{$randomInt}}
 */
export function interpolateVariables(input: string, variables: Record<string, string> = {}): string {
  if (!input) return input;

  return input.replace(/\{\{([^{}]+)\}\}/g, (match, varName) => {
    const trimmed = varName.trim();

    // Built-in dynamic variables
    if (trimmed === '$guid') {
      return typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }
    if (trimmed === '$timestamp') {
      return Math.floor(Date.now() / 1000).toString();
    }
    if (trimmed === '$isoTimestamp') {
      return new Date().toISOString();
    }
    if (trimmed === '$randomInt') {
      return (Math.floor(Math.random() * 1000) + 1).toString();
    }

    // Custom environment or script variables
    if (variables[trimmed] !== undefined) {
      return variables[trimmed];
    }

    return match; // Keep unchanged if not found
  });
}

/**
 * Builds query parameters, attaches auth headers, interpolates variables,
 * and constructs the final request payload.
 */
export function prepareRequest(
  request: ApiRequest,
  variables: Record<string, string> = {}
): {
  finalUrl: string;
  finalHeaders: Record<string, string>;
  finalBody?: BodyInit;
} {
  let rawUrl = interpolateVariables(request.url.trim(), variables);

  // If no scheme provided, default to http:// for localhost/intranet IPs or https:// for others
  if (!/^https?:\/\//i.test(rawUrl)) {
    const isLocalOrIp = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i.test(rawUrl);
    rawUrl = isLocalOrIp ? `http://${rawUrl}` : `https://${rawUrl}`;
  }

  // Append query params
  try {
    const parsedUrl = new URL(rawUrl);
    const activeParams = request.params.filter((p) => p.enabled && p.key.trim() !== '');
    for (const p of activeParams) {
      const paramKey = interpolateVariables(p.key.trim(), variables);
      const paramVal = interpolateVariables(p.value, variables);
      parsedUrl.searchParams.set(paramKey, paramVal);
    }
    rawUrl = parsedUrl.toString();
  } catch {
    // Retain URL as is if parsing fails
  }

  // Construct headers
  const headers: Record<string, string> = {};
  for (const h of request.headers) {
    if (h.enabled && h.key.trim() !== '') {
      const headerKey = interpolateVariables(h.key.trim(), variables);
      const headerVal = interpolateVariables(h.value, variables);
      headers[headerKey] = headerVal;
    }
  }

  // Add Auth headers or query params if configured
  if (request.auth.type === 'bearer' && request.auth.bearerToken) {
    const token = interpolateVariables(request.auth.bearerToken.trim(), variables);
    headers['Authorization'] = `Bearer ${token}`;
  } else if (request.auth.type === 'basic' && (request.auth.basicUsername || request.auth.basicPassword)) {
    const user = interpolateVariables(request.auth.basicUsername || '', variables);
    const pass = interpolateVariables(request.auth.basicPassword || '', variables);
    const credentials = btoa(`${user}:${pass}`);
    headers['Authorization'] = `Basic ${credentials}`;
  } else if (request.auth.type === 'apikey' && request.auth.apiKeyKey && request.auth.apiKeyValue) {
    const key = interpolateVariables(request.auth.apiKeyKey.trim(), variables);
    const val = interpolateVariables(request.auth.apiKeyValue.trim(), variables);
    if (request.auth.apiKeyIn === 'query') {
      try {
        const parsedUrl = new URL(rawUrl);
        parsedUrl.searchParams.set(key, val);
        rawUrl = parsedUrl.toString();
      } catch {
        // ignore URL parse errors
      }
    } else {
      headers[key] = val;
    }
  }

  let bodyPayload: BodyInit | undefined = undefined;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.bodyType === 'json') {
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
      bodyPayload = interpolateVariables(request.bodyContent || '', variables);
    } else if (request.bodyType === 'raw' || request.bodyType === 'x-www-form-urlencoded') {
      bodyPayload = interpolateVariables(request.bodyContent || '', variables);
    } else if (request.bodyType === 'form-data') {
      // Multipart Form Data with File support
      const formData = new FormData();
      const activeFormItems = (request.bodyFormData || []).filter((item) => item.enabled && item.key.trim() !== '');

      for (const item of activeFormItems) {
        const itemKey = interpolateVariables(item.key.trim(), variables);
        if (item.type === 'file' && item.file) {
          formData.append(itemKey, item.file, item.file.name);
        } else {
          formData.append(itemKey, interpolateVariables(item.value || '', variables));
        }
      }

      bodyPayload = formData;
      // Note: Delete explicit Content-Type so the browser automatically sets boundary
      delete headers['Content-Type'];
      delete headers['content-type'];
    }
  }

  return {
    finalUrl: rawUrl,
    finalHeaders: headers,
    finalBody: bodyPayload,
  };
}

/**
 * Dispatches an API request with full variable interpolation,
 * file upload support, and zero CORS limitations.
 */
export async function executeApiRequest(
  request: ApiRequest,
  variables: Record<string, string> = {}
): Promise<ApiResponse> {
  const { finalUrl, finalHeaders, finalBody } = prepareRequest(request, variables);
  const startTime = performance.now();

  try {
    const fetchOptions: RequestInit = {
      method: request.method,
      headers: finalHeaders,
      redirect: 'follow',
      cache: 'no-store',
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      fetchOptions.body = finalBody;
    }

    const response = await fetch(finalUrl, fetchOptions);

    const timeMs = Math.round(performance.now() - startTime);
    const textData = await response.text();
    const sizeBytes = new Blob([textData]).size;

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((val, key) => {
      responseHeaders[key] = val;
    });

    return {
      status: response.status,
      statusText: response.statusText || (response.ok ? 'OK' : 'Error'),
      timeMs,
      sizeBytes,
      headers: responseHeaders,
      data: textData,
      isError: !response.ok,
      timestamp: Date.now(),
    };
  } catch (err: unknown) {
    const timeMs = Math.round(performance.now() - startTime);
    const errorMsg = err instanceof Error ? err.message : String(err);

    return {
      status: 0,
      statusText: 'Network / Connection Error',
      timeMs,
      sizeBytes: 0,
      headers: {},
      data: `Failed to connect to ${finalUrl}.\n\nPossible causes:\n1. Server is offline or unreachable on your current network/VPN.\n2. URL is invalid or DNS resolution failed.\n3. Exact error: ${errorMsg}`,
      isError: true,
      errorDetail: errorMsg,
      timestamp: Date.now(),
    };
  }
}
