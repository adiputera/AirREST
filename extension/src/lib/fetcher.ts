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

  // If no scheme provided, default to http:// for localhost/private network IPs or https:// for others
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
    if (request.bodyType === 'json' || (request.bodyType === 'raw' && request.rawType === 'json')) {
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
      bodyPayload = interpolateVariables(request.bodyContent || '', variables);
    } else if (request.bodyType === 'graphql') {
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
      const rawQuery = interpolateVariables(request.graphqlQuery || request.bodyContent || '', variables);
      const rawVars = interpolateVariables(request.graphqlVariables || '', variables).trim();
      let parsedVars: unknown = undefined;
      if (rawVars) {
        try {
          parsedVars = JSON.parse(rawVars);
        } catch {
          // If not standard JSON, retain rawVars or empty
        }
      }
      const gqlBody: { query: string; variables?: unknown } = {
        query: rawQuery,
      };
      if (parsedVars !== undefined) {
        gqlBody.variables = parsedVars;
      }
      bodyPayload = JSON.stringify(gqlBody);
    } else if (request.bodyType === 'xml' || (request.bodyType === 'raw' && request.rawType === 'xml')) {
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/xml';
      }
      bodyPayload = interpolateVariables(request.bodyContent || '', variables);
    } else if (request.bodyType === 'raw' && request.rawType === 'html') {
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'text/html';
      }
      bodyPayload = interpolateVariables(request.bodyContent || '', variables);
    } else if (request.bodyType === 'raw') {
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'text/plain';
      }
      bodyPayload = interpolateVariables(request.bodyContent || '', variables);
    } else if (request.bodyType === 'x-www-form-urlencoded') {
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      const activeItems = (request.bodyUrlEncoded || []).filter(
        (item) => item.enabled && item.key.trim() !== ''
      );
      if (activeItems.length > 0) {
        const formParams = new URLSearchParams();
        for (const item of activeItems) {
          const k = interpolateVariables(item.key.trim(), variables);
          const v = interpolateVariables(item.value || '', variables);
          formParams.append(k, v);
        }
        bodyPayload = formParams.toString();
      } else {
        bodyPayload = interpolateVariables(request.bodyContent || '', variables);
      }
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
    } else if (request.bodyType === 'binary') {
      // Direct raw binary stream upload
      if (request.bodyBinaryFile?.file) {
        bodyPayload = request.bodyBinaryFile.file;
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = request.bodyBinaryFile.type || 'application/octet-stream';
        }
      }
    }
  }

  return {
    finalUrl: rawUrl,
    finalHeaders: headers,
    finalBody: bodyPayload,
  };
}

/**
 * Detects whether the response byte buffer and Content-Type represent
 * an image, non-image binary, or text.
 */
export function detectMediaType(
  buffer: Uint8Array,
  declaredContentType: string
): { isBinary: boolean; isImage: boolean; mimeType: string } {
  const declared = (declaredContentType || '').split(';')[0].trim().toLowerCase();

  // 1. If declared explicitly as image
  if (declared.startsWith('image/')) {
    return { isBinary: true, isImage: true, mimeType: declared };
  }

  // 2. Check magic numbers for common image formats
  if (buffer.length >= 4) {
    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return { isBinary: true, isImage: true, mimeType: 'image/png' };
    }
    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { isBinary: true, isImage: true, mimeType: 'image/jpeg' };
    }
    // GIF: 47 49 46 38 ('GIF8')
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
      return { isBinary: true, isImage: true, mimeType: 'image/gif' };
    }
    // WebP: 'RIFF' ... 'WEBP'
    if (
      buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
    ) {
      return { isBinary: true, isImage: true, mimeType: 'image/webp' };
    }
    // BMP: 42 4D ('BM')
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
      return { isBinary: true, isImage: true, mimeType: 'image/bmp' };
    }
  }

  // 3. Known text or code formats
  const isKnownText =
    declared.startsWith('text/') ||
    declared.includes('json') ||
    declared.includes('xml') ||
    declared.includes('javascript') ||
    declared.includes('ecmascript') ||
    declared.includes('x-www-form-urlencoded') ||
    declared.includes('graphql');

  if (isKnownText) {
    return { isBinary: false, isImage: false, mimeType: declared || 'text/plain' };
  }

  // 4. Known non-image binary formats
  if (
    declared === 'application/octet-stream' ||
    declared === 'application/pdf' ||
    declared.includes('zip') ||
    declared.includes('tar') ||
    declared.includes('gzip') ||
    declared.startsWith('audio/') ||
    declared.startsWith('video/')
  ) {
    return { isBinary: true, isImage: false, mimeType: declared || 'application/octet-stream' };
  }

  // 5. Fallback heuristic: check initial bytes for binary null bytes
  const sampleLength = Math.min(buffer.length, 1024);
  let hasNullByte = false;
  for (let i = 0; i < sampleLength; i++) {
    if (buffer[i] === 0) {
      hasNullByte = true;
      break;
    }
  }

  if (hasNullByte) {
    return { isBinary: true, isImage: false, mimeType: declared || 'application/octet-stream' };
  }

  return { isBinary: false, isImage: false, mimeType: declared || 'text/plain' };
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

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((val, key) => {
      responseHeaders[key] = val;
    });

    const rawContentType = response.headers.get('content-type') || '';
    const arrayBuffer = await response.arrayBuffer();
    const sizeBytes = arrayBuffer.byteLength;
    const uint8 = new Uint8Array(arrayBuffer);

    const { isBinary, isImage, mimeType } = detectMediaType(uint8, rawContentType);

    let textData = '';
    let blobUrl: string | undefined = undefined;

    if (isBinary) {
      const blob = new Blob([arrayBuffer], { type: mimeType });
      blobUrl = URL.createObjectURL(blob);
      if (mimeType === 'image/svg+xml') {
        const decoder = new TextDecoder('utf-8', { fatal: false });
        textData = decoder.decode(uint8);
      } else {
        textData = isImage ? `[Binary Image: ${mimeType}]` : `[Binary File: ${mimeType}]`;
      }
    } else {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      textData = decoder.decode(uint8);
    }

    return {
      status: response.status,
      statusText: response.statusText || (response.ok ? 'OK' : 'Error'),
      timeMs,
      sizeBytes,
      headers: responseHeaders,
      data: textData,
      isError: !response.ok,
      timestamp: Date.now(),
      contentType: mimeType,
      isBinary,
      isImage,
      blobUrl,
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
