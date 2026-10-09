import { ApiRequest, HttpMethod, KeyValuePair, AuthConfig } from '@/types/api';
import { interpolateVariables } from './fetcher';

function generateId(): string {
  return Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
}

/**
 * Parses a raw cURL command string into an ApiRequest definition.
 */
export function parseCurlCommand(rawCurl: string): Partial<ApiRequest> {
  let cleaned = rawCurl.trim();
  if (cleaned.startsWith('curl ')) {
    cleaned = cleaned.substring(5).trim();
  }

  let method: HttpMethod = 'GET';
  let url = '';
  const headers: KeyValuePair[] = [];
  let bodyContent = '';
  let bodyType: ApiRequest['bodyType'] = 'none';

  // Tokenize preserving quoted strings
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  const tokens: string[] = [];
  let match;
  while ((match = regex.exec(cleaned)) !== null) {
    if (match[1] !== undefined) {
      tokens.push(match[1]);
    } else if (match[2] !== undefined) {
      tokens.push(match[2]);
    } else {
      tokens.push(match[0]);
    }
  }

  let auth: AuthConfig = { type: 'none' };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === '-X' || token === '--request') {
      const next = tokens[++i];
      if (next) {
        method = next.toUpperCase() as HttpMethod;
      }
    } else if (token === '-u' || token === '--user') {
      const userPass = tokens[++i] || '';
      const colonIndex = userPass.indexOf(':');
      if (colonIndex >= 0) {
        auth = {
          type: 'basic',
          basicUsername: userPass.substring(0, colonIndex),
          basicPassword: userPass.substring(colonIndex + 1),
        };
      } else {
        auth = {
          type: 'basic',
          basicUsername: userPass,
          basicPassword: '',
        };
      }
    } else if (token === '-H' || token === '--header') {
      const headerLine = tokens[++i];
      if (headerLine) {
        const colonIndex = headerLine.indexOf(':');
        if (colonIndex > 0) {
          const key = headerLine.substring(0, colonIndex).trim();
          const value = headerLine.substring(colonIndex + 1).trim();
          headers.push({
            id: generateId(),
            key,
            value,
            enabled: true,
          });
        }
      }
    } else if (
      token === '-d' ||
      token === '--data' ||
      token === '--data-raw' ||
      token === '--data-binary'
    ) {
      const data = tokens[++i];
      if (data !== undefined) {
        bodyContent = data;
        if (method === 'GET') {
          method = 'POST'; // curl defaults to POST when -d is passed
        }
        bodyType =
          data.trim().startsWith('{') || data.trim().startsWith('[') ? 'json' : 'raw';
      }
    } else if (token === '--url') {
      url = tokens[++i] || '';
    } else if (
      (token.startsWith('http://') || token.startsWith('https://')) &&
      !url
    ) {
      url = token;
    } else if (!token.startsWith('-') && !url && token.includes('/')) {
      url = token;
    }
  }

  // Extract auth from Authorization header if not already specified with -u
  if (auth.type === 'none') {
    const authHeader = headers.find((h) => h.key.trim().toLowerCase() === 'authorization');
    if (authHeader && authHeader.value) {
      const val = authHeader.value.trim();
      if (/^bearer\s+/i.test(val)) {
        auth = {
          type: 'bearer',
          bearerToken: val.replace(/^bearer\s+/i, '').trim(),
        };
      } else if (/^basic\s+/i.test(val)) {
        const b64 = val.replace(/^basic\s+/i, '').trim();
        try {
          const decoded = atob(b64);
          const colonIdx = decoded.indexOf(':');
          if (colonIdx >= 0) {
            auth = {
              type: 'basic',
              basicUsername: decoded.substring(0, colonIdx),
              basicPassword: decoded.substring(colonIdx + 1),
            };
          }
        } catch {
          // ignore if not standard base64
        }
      }
    }
  }

  // If auth was extracted, clean up redundant Authorization header
  const cleanHeaders = auth.type !== 'none'
    ? headers.filter((h) => h.key.trim().toLowerCase() !== 'authorization')
    : headers;

  return {
    method,
    url,
    headers: cleanHeaders,
    auth,
    bodyType,
    bodyContent,
    name: url ? `${method} ${url.substring(0, 30)}` : 'Imported cURL Request',
  };
}

/**
 * Converts an ApiRequest into a shell-ready cURL command string.
 */
export function generateCurlCommand(
  request: ApiRequest,
  variables: Record<string, string> = {}
): string {
  let url = interpolateVariables(request.url, variables);

  // If API Key is configured in query parameters, attach it
  if (request.auth.type === 'apikey' && request.auth.apiKeyIn === 'query' && request.auth.apiKeyKey && request.auth.apiKeyValue) {
    const k = interpolateVariables(request.auth.apiKeyKey.trim(), variables);
    const v = interpolateVariables(request.auth.apiKeyValue.trim(), variables);
    try {
      const parsedUrl = new URL(url);
      parsedUrl.searchParams.set(k, v);
      url = parsedUrl.toString();
    } catch {
      url += (url.includes('?') ? '&' : '?') + `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    }
  }

  const parts: string[] = [`curl -X ${request.method} "${url}"`];

  // Headers
  for (const h of request.headers) {
    if (h.enabled && h.key.trim()) {
      const key = interpolateVariables(h.key.trim(), variables);
      const val = interpolateVariables(h.value, variables);
      parts.push(`-H "${key}: ${val}"`);
    }
  }

  // Auth
  if (request.auth.type === 'bearer' && request.auth.bearerToken) {
    const token = interpolateVariables(request.auth.bearerToken.trim(), variables);
    parts.push(`-H "Authorization: Bearer ${token}"`);
  } else if (request.auth.type === 'basic') {
    const u = interpolateVariables(request.auth.basicUsername || '', variables);
    const p = interpolateVariables(request.auth.basicPassword || '', variables);
    parts.push(`-u "${u}:${p}"`);
  } else if (request.auth.type === 'apikey' && request.auth.apiKeyKey && request.auth.apiKeyValue) {
    const k = interpolateVariables(request.auth.apiKeyKey.trim(), variables);
    const v = interpolateVariables(request.auth.apiKeyValue.trim(), variables);
    if (request.auth.apiKeyIn !== 'query') {
      parts.push(`-H "${k}: ${v}"`);
    }
  }

  // Body
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.bodyType === 'json' || request.bodyType === 'raw' || request.bodyType === 'x-www-form-urlencoded') {
      const body = interpolateVariables(request.bodyContent || '', variables);
      if (body) {
        parts.push(`-d '${body.replace(/'/g, `'\\''`)}'`);
      }
    } else if (request.bodyType === 'form-data') {
      for (const item of request.bodyFormData || []) {
        if (item.enabled && item.key.trim()) {
          const k = interpolateVariables(item.key.trim(), variables);
          if (item.type === 'file' && item.file) {
            parts.push(`-F "${k}=@${item.file.name}"`);
          } else {
            const v = interpolateVariables(item.value || '', variables);
            parts.push(`-F "${k}=${v}"`);
          }
        }
      }
    }
  }

  return parts.join(' \\\n  ');
}
