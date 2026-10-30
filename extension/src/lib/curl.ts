import { ApiRequest, HttpMethod, KeyValuePair, AuthConfig, FormDataItem, BinaryFileData, RawType } from '@/types/api';
import { interpolateVariables } from './fetcher';
import { substitutePathVariables } from './urlParams';

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
  const bodyFormData: FormDataItem[] = [];
  const bodyUrlEncoded: KeyValuePair[] = [];
  let bodyBinaryFile: BinaryFileData | undefined = undefined;
  let bodyContent = '';
  let bodyType: ApiRequest['bodyType'] = 'none';
  let rawType: RawType = 'text';
  let graphqlQuery = '';
  let graphqlVariables = '';

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
    } else if (token === '-A' || token === '--user-agent') {
      const ua = tokens[++i];
      if (ua) {
        headers.push({
          id: generateId(),
          key: 'User-Agent',
          value: ua,
          enabled: true,
        });
      }
    } else if (token === '-b' || token === '--cookie') {
      const cookie = tokens[++i];
      if (cookie) {
        headers.push({
          id: generateId(),
          key: 'Cookie',
          value: cookie,
          enabled: true,
        });
      }
    } else if (token === '--json') {
      const data = tokens[++i];
      if (data !== undefined) {
        bodyContent = data;
        bodyType = 'json';
        rawType = 'json';
        if (method === 'GET') {
          method = 'POST';
        }
        if (!headers.some((h) => h.key.toLowerCase() === 'content-type')) {
          headers.push({
            id: generateId(),
            key: 'Content-Type',
            value: 'application/json',
            enabled: true,
          });
        }
        if (!headers.some((h) => h.key.toLowerCase() === 'accept')) {
          headers.push({
            id: generateId(),
            key: 'Accept',
            value: 'application/json',
            enabled: true,
          });
        }
      }
    } else if (token === '-F' || token === '--form') {
      const formEntry = tokens[++i];
      if (formEntry) {
        const eqIdx = formEntry.indexOf('=');
        if (eqIdx > 0) {
          const k = formEntry.substring(0, eqIdx).trim();
          let v = formEntry.substring(eqIdx + 1).trim();
          const isFile = v.startsWith('@');
          if (isFile) {
            v = v.substring(1).trim();
          }
          bodyFormData.push({
            id: generateId(),
            key: k,
            type: isFile ? 'file' : 'text',
            value: v,
            enabled: true,
          });
          bodyType = 'form-data';
          if (method === 'GET') {
            method = 'POST';
          }
        }
      }
    } else if (token === '--data-urlencode') {
      const data = tokens[++i];
      if (data !== undefined) {
        bodyType = 'x-www-form-urlencoded';
        const eqIdx = data.indexOf('=');
        if (eqIdx > 0) {
          bodyUrlEncoded.push({
            id: generateId(),
            key: data.substring(0, eqIdx).trim(),
            value: data.substring(eqIdx + 1).trim(),
            enabled: true,
          });
        } else {
          bodyUrlEncoded.push({
            id: generateId(),
            key: data.trim(),
            value: '',
            enabled: true,
          });
        }
        if (method === 'GET') {
          method = 'POST';
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
        if (token === '--data-binary' && data.startsWith('@')) {
          const fileName = data.substring(1).trim();
          bodyType = 'binary';
          bodyBinaryFile = {
            name: fileName,
            size: 0,
            type: 'application/octet-stream',
          };
        } else {
          bodyContent = data;
          const trimmed = data.trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
              const parsed = JSON.parse(data);
              if (parsed && typeof parsed === 'object' && typeof parsed.query === 'string') {
                bodyType = 'graphql';
                graphqlQuery = parsed.query;
                graphqlVariables = parsed.variables ? JSON.stringify(parsed.variables, null, 2) : '';
              } else {
                bodyType = 'json';
                rawType = 'json';
              }
            } catch {
              bodyType = 'json';
              rawType = 'json';
            }
          } else if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
            bodyType = 'xml';
            rawType = 'xml';
          } else {
            bodyType = 'raw';
            rawType = 'text';
          }
        }
        if (method === 'GET') {
          method = 'POST'; // curl defaults to POST when -d is passed
        }
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
    const authHeader = headers.find((h) => String(h?.key ?? '').trim().toLowerCase() === 'authorization');
    if (authHeader && authHeader.value) {
      const val = String(authHeader.value).trim();
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
    ? headers.filter((h) => String(h?.key ?? '').trim().toLowerCase() !== 'authorization')
    : headers;

  // Check Content-Type header if present to refine bodyType and rawType
  const contentTypeHeader = cleanHeaders.find((h) => String(h?.key ?? '').trim().toLowerCase() === 'content-type');
  if (contentTypeHeader && bodyType !== 'none' && bodyType !== 'form-data' && bodyType !== 'binary') {
    const ctVal = String(contentTypeHeader.value ?? '').toLowerCase();
    if (ctVal.includes('application/xml') || ctVal.includes('text/xml')) {
      bodyType = 'xml';
      rawType = 'xml';
    } else if (ctVal.includes('application/json')) {
      bodyType = 'json';
      rawType = 'json';
    } else if (ctVal.includes('text/html')) {
      bodyType = 'raw';
      rawType = 'html';
    } else if (ctVal.includes('text/plain')) {
      bodyType = 'raw';
      rawType = 'text';
    } else if (ctVal.includes('application/x-www-form-urlencoded')) {
      bodyType = 'x-www-form-urlencoded';
      if (bodyContent && bodyUrlEncoded.length === 0) {
        try {
          const parsed = new URLSearchParams(bodyContent);
          parsed.forEach((val, key) => {
            bodyUrlEncoded.push({
              id: generateId(),
              key,
              value: val,
              enabled: true,
            });
          });
        } catch {
          // ignore
        }
      }
    }
  }

  // Extract query parameters from URL into params list
  const params: KeyValuePair[] = [];
  let finalUrl = url;

  if (url && url.includes('?')) {
    try {
      const dummyBase = !/^https?:\/\//i.test(url) ? 'http://placeholder' : undefined;
      const parsedUrl = new URL(url, dummyBase);
      parsedUrl.searchParams.forEach((value, key) => {
        params.push({
          id: generateId(),
          key,
          value,
          enabled: true,
        });
      });
      // Keep full URL with query parameters in sync with params
      finalUrl = url;
    } catch {
      // Retain url as is
    }
  }

  if (params.length === 0) {
    params.push({ id: generateId(), key: '', value: '', enabled: true });
  }

  return {
    method,
    url: finalUrl,
    params,
    headers: cleanHeaders,
    auth,
    bodyType,
    rawType,
    bodyContent,
    graphqlQuery,
    graphqlVariables,
    bodyFormData,
    bodyBinaryFile,
    bodyUrlEncoded: bodyUrlEncoded.length > 0 ? bodyUrlEncoded : [{ id: generateId(), key: '', value: '', enabled: true }],
    name: url ? `${method} ${finalUrl.substring(0, 30)}` : 'Imported cURL Request',
  };
}

/**
 * Converts an ApiRequest into a shell-ready cURL command string.
 */
export function generateCurlCommand(
  request: ApiRequest,
  variables: Record<string, string> = {}
): string {
  let url = interpolateVariables(request?.url || '', variables);

  // Substitute path variables
  if (request.pathVariables && request.pathVariables.length > 0) {
    const interpolatedPathVars = request.pathVariables.map((pv) => ({
      ...pv,
      value: interpolateVariables(String(pv.value ?? ''), variables),
    }));
    url = substitutePathVariables(url, interpolatedPathVars);
  }

  // Append query parameters
  if (request.params && request.params.length > 0) {
    const activeParams = request.params.filter((p) => p && p.enabled && String(p?.key ?? '').trim());
    if (activeParams.length > 0) {
      try {
        const dummyBase = !/^https?:\/\//i.test(url) ? 'http://placeholder' : undefined;
        const parsedUrl = new URL(url, dummyBase);
        for (const p of activeParams) {
          const k = interpolateVariables(String(p.key).trim(), variables);
          const v = interpolateVariables(String(p.value ?? ''), variables);
          parsedUrl.searchParams.set(k, v);
        }
        url = dummyBase ? parsedUrl.pathname + parsedUrl.search : parsedUrl.toString();
      } catch {
        if (!url.includes('?')) {
          const queryString = activeParams
            .map((p) => `${encodeURIComponent(interpolateVariables(String(p.key).trim(), variables))}=${encodeURIComponent(interpolateVariables(String(p.value ?? ''), variables))}`)
            .join('&');
          url += '?' + queryString;
        }
      }
    }
  }

  // If API Key is configured in query parameters, attach it
  if (request.auth?.type === 'apikey' && request.auth?.apiKeyIn === 'query' && request.auth?.apiKeyKey && request.auth?.apiKeyValue) {
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
  let hasContentType = false;
  for (const h of (request.headers || [])) {
    if (h && h.enabled && h.key?.trim()) {
      const key = interpolateVariables(h.key.trim(), variables);
      const val = interpolateVariables(h.value || '', variables);
      if (key.toLowerCase() === 'content-type') hasContentType = true;
      parts.push(`-H "${key}: ${val}"`);
    }
  }

  if (!hasContentType && request.bodyType === 'graphql') {
    parts.push(`-H "Content-Type: application/json"`);
  }

  // Auth
  if (request.auth?.type === 'bearer' && request.auth?.bearerToken) {
    const token = interpolateVariables(request.auth.bearerToken.trim(), variables);
    parts.push(`-H "Authorization: Bearer ${token}"`);
  } else if (request.auth?.type === 'basic') {
    const u = interpolateVariables(request.auth?.basicUsername || '', variables);
    const p = interpolateVariables(request.auth?.basicPassword || '', variables);
    parts.push(`-u "${u}:${p}"`);
  } else if (request.auth?.type === 'apikey' && request.auth?.apiKeyKey && request.auth?.apiKeyValue) {
    const k = interpolateVariables(request.auth.apiKeyKey.trim(), variables);
    const v = interpolateVariables(request.auth.apiKeyValue.trim(), variables);
    if (request.auth?.apiKeyIn !== 'query') {
      parts.push(`-H "${k}: ${v}"`);
    }
  }

  // Body
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.bodyType === 'graphql') {
      const q = interpolateVariables(request.graphqlQuery || request.bodyContent || '', variables);
      const vStr = interpolateVariables(request.graphqlVariables || '', variables).trim();
      let vParsed: unknown = undefined;
      if (vStr) {
        try {
          vParsed = JSON.parse(vStr);
        } catch {
          // ignore
        }
      }
      const gqlObj: { query: string; variables?: unknown } = { query: q };
      if (vParsed !== undefined) gqlObj.variables = vParsed;
      const body = JSON.stringify(gqlObj);
      parts.push(`-d '${body.replace(/'/g, `'\\''`)}'`);
    } else if (
      request.bodyType === 'json' ||
      request.bodyType === 'xml' ||
      request.bodyType === 'raw'
    ) {
      const body = interpolateVariables(request.bodyContent || '', variables);
      if (body) {
        parts.push(`-d '${body.replace(/'/g, `'\\''`)}'`);
      }
    } else if (request.bodyType === 'x-www-form-urlencoded') {
      const activeItems = (request.bodyUrlEncoded || []).filter((item) => item.enabled && item.key.trim());
      if (activeItems.length > 0) {
        for (const item of activeItems) {
          const k = interpolateVariables(item.key.trim(), variables);
          const v = interpolateVariables(item.value || '', variables);
          parts.push(`--data-urlencode "${k}=${v}"`);
        }
      } else if (request.bodyContent) {
        const body = interpolateVariables(request.bodyContent, variables);
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
    } else if (request.bodyType === 'binary' && request.bodyBinaryFile) {
      const fileName = request.bodyBinaryFile.name || 'file.bin';
      parts.push(`--data-binary "@${fileName}"`);
    }
  }

  return parts.join(' \\\n  ');
}
