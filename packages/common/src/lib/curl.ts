import { ApiRequest, HttpMethod, KeyValuePair, AuthConfig, FormDataItem, BinaryFileData, RawType } from '../types/api';
import { resolveBodyContentTypeHeader, resolveEffectiveAuthHeader, resolveManualHeaders } from './authHeaders';
import { interpolateVariables } from './fetcher';
import { compileEffectiveJsonPayload } from './formatters';
import { parsePathVariablesFromUrl, parseQueryParamsFromUrl, substitutePathVariables } from './urlParams';

function generateId(): string {
  return Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
}

const NON_URL_VALUE_FLAGS = new Set([
  '-o',
  '--output',
  '-x',
  '--proxy',
  '--cacert',
  '--cert',
  '--key',
  '-m',
  '--max-time',
  '--connect-timeout',
  '-w',
  '--write-out',
  '-D',
  '--dump-header',
  '-c',
  '--cookie-jar',
  '--resolve',
  '--interface',
  '--proto',
  '--retry',
  '--retry-delay',
  '--retry-max-time',
  '--limit-rate',
  '--max-redirs',
  '-K',
  '--config',
  '-T',
  '--upload-file',
]);

const LONG_FLAGS_WITH_EQUALS = new Set([
  '--request',
  '--url',
  '--header',
  '--user',
  '--user-agent',
  '--cookie',
  '--referer',
  '--json',
  '--form',
  '--form-string',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-urlencode',
  '--data-ascii',
  '--oauth2-bearer',
  ...Array.from(NON_URL_VALUE_FLAGS).filter((f) => f.startsWith('--')),
]);

/**
 * Strips leading blank/comment lines, optional shell prompt (`$ ` or `> `),
 * and the leading `curl` / `curl.exe` command token.
 * Returns the remaining argument string if the input starts with a cURL invocation, or null otherwise.
 */
function stripCurlCommandPrefix(rawText: string): string | null {
  if (typeof rawText !== 'string') return null;
  let text = rawText.trim();
  if (!text) return null;

  // Strip leading full-line shell comments (# ...)
  while (text.startsWith('#')) {
    const newlineIdx = text.indexOf('\n');
    if (newlineIdx === -1) return null;
    text = text.slice(newlineIdx + 1).trim();
  }

  const match = /^(?:[$>]\s+)?curl(?:\.exe)?(?=[\s\\]|$)/i.exec(text);
  if (!match) return null;

  const rest = text.slice(match[0].length).trim();
  return rest.length > 0 ? rest : null;
}

/**
 * Checks whether a raw string looks like a cURL command invocation.
 */
export function isCurlCommand(rawText: string): boolean {
  return stripCurlCommandPrefix(rawText) !== null;
}

/**
 * Unescapes an ANSI-C quoted string ($'...') payload.
 */
function decodeAnsiCSegment(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\' || i + 1 >= raw.length) {
      out += ch;
      continue;
    }
    const next = raw[++i];
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'v':
        out += '\v';
        break;
      case 'a':
        out += '\x07';
        break;
      case 'e':
      case 'E':
        out += '\x1b';
        break;
      case '\\':
        out += '\\';
        break;
      case "'":
        out += "'";
        break;
      case '"':
        out += '"';
        break;
      case 'x': {
        const hex = raw.slice(i + 1, i + 3);
        const match = /^[0-9a-fA-F]{1,2}/.exec(hex);
        if (match) {
          out += String.fromCharCode(parseInt(match[0], 16));
          i += match[0].length;
        } else {
          out += '\\x';
        }
        break;
      }
      case 'u': {
        const hex = raw.slice(i + 1, i + 5);
        const match = /^[0-9a-fA-F]{1,4}/.exec(hex);
        if (match) {
          out += String.fromCharCode(parseInt(match[0], 16));
          i += match[0].length;
        } else {
          out += '\\u';
        }
        break;
      }
      case 'U': {
        const hex = raw.slice(i + 1, i + 9);
        const match = /^[0-9a-fA-F]{1,8}/.exec(hex);
        if (match) {
          const cp = parseInt(match[0], 16);
          out += cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
          i += match[0].length;
        } else {
          out += '\\U';
        }
        break;
      }
      default: {
        if (next >= '0' && next <= '7') {
          const oct = raw.slice(i, i + 3);
          const match = /^[0-7]{1,3}/.exec(oct);
          if (match) {
            out += String.fromCharCode(parseInt(match[0], 8));
            i += match[0].length - 1;
            break;
          }
        }
        out += next;
        break;
      }
    }
  }
  return out;
}

/**
 * Tokenizes a cURL argument string respecting single quotes ('...'), double quotes ("..."),
 * ANSI-C quotes ($'...'), escaped characters (\', \", \\), adjacent quote concatenation ('O'\''Reilly'),
 * and shell line continuations (\ or ^ before newline, or standalone \ between spaces).
 */
export function tokenizeCurlCommand(input: string): string[] {
  const rawTokens: string[] = [];
  let current = '';
  let hasToken = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Line continuation outside quotes: `\` or `^` followed by optional spaces/tabs and newline
    if (ch === '\\' || ch === '^') {
      let lookahead = i + 1;
      while (lookahead < input.length && (input[lookahead] === ' ' || input[lookahead] === '\t')) {
        lookahead++;
      }
      if (lookahead < input.length && input[lookahead] === '\r') {
        lookahead++;
      }
      if (lookahead < input.length && input[lookahead] === '\n') {
        i = lookahead + 1;
        continue;
      }

      // Flattened single-line continuation: standalone `\` or `^` when not inside a token and followed by whitespace/end
      if (
        !hasToken &&
        (i + 1 >= input.length || input[i + 1] === ' ' || input[i + 1] === '\t')
      ) {
        i++;
        continue;
      }
    }

    // Unquoted whitespace separates tokens
    if (/\s/.test(ch)) {
      if (hasToken) {
        rawTokens.push(current);
        current = '';
        hasToken = false;
      }
      i++;
      continue;
    }

    // ANSI-C quoting: $'...'
    if (ch === '$' && input[i + 1] === "'") {
      hasToken = true;
      i += 2;
      let ansiRaw = '';
      while (i < input.length) {
        if (input[i] === '\\' && i + 1 < input.length) {
          ansiRaw += input[i] + input[i + 1];
          i += 2;
        } else if (input[i] === "'") {
          i++;
          break;
        } else {
          ansiRaw += input[i];
          i++;
        }
      }
      current += decodeAnsiCSegment(ansiRaw);
      continue;
    }

    // Single quotes: '...'
    if (ch === "'") {
      hasToken = true;
      i++;
      while (i < input.length && input[i] !== "'") {
        current += input[i];
        i++;
      }
      if (i < input.length && input[i] === "'") {
        i++;
      }
      continue;
    }

    // Double quotes: "..."
    if (ch === '"') {
      hasToken = true;
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const next = input[i + 1];
          if (next === '\n') {
            i += 2;
            continue;
          }
          if (next === '\r' && input[i + 2] === '\n') {
            i += 3;
            continue;
          }
          if (next === '"' || next === '\\' || next === '$' || next === '`') {
            current += next;
            i += 2;
            continue;
          }
        }
        current += input[i];
        i++;
      }
      if (i < input.length && input[i] === '"') {
        i++;
      }
      continue;
    }

    // Unquoted backslash escape (e.g. \' in 'O'\''Reilly' or escaped space)
    if (ch === '\\' && i + 1 < input.length) {
      hasToken = true;
      current += input[i + 1];
      i += 2;
      continue;
    }

    hasToken = true;
    current += ch;
    i++;
  }

  if (hasToken) {
    rawTokens.push(current);
  }

  // Normalize attached short flags (-XPOST, -H"...") and --flag=value tokens
  const tokens: string[] = [];
  for (const tok of rawTokens) {
    if (tok.startsWith('--')) {
      const eqIdx = tok.indexOf('=');
      if (eqIdx > 2) {
        const flagName = tok.slice(0, eqIdx);
        if (LONG_FLAGS_WITH_EQUALS.has(flagName)) {
          tokens.push(flagName, tok.slice(eqIdx + 1));
          continue;
        }
      }
      tokens.push(tok);
      continue;
    }

    if (tok.length > 2 && tok[0] === '-' && tok[1] !== '-') {
      const shortFlag = tok.slice(0, 2);
      if (/^-(X|H|d|u|F|b|A|e|o|x|m|w|D|c)$/.test(shortFlag)) {
        tokens.push(shortFlag, tok.slice(2));
        continue;
      }
    }

    tokens.push(tok);
  }

  return tokens;
}

function isLikelyUrlToken(token: string): boolean {
  if (!token || token.startsWith('-')) return false;
  if (/^https?:\/\//i.test(token)) return true;
  if (token.startsWith('{{')) return true;
  if (/^localhost(?::\d+)?(?:[/?#]|$)/i.test(token)) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#]|$)/.test(token)) return true;
  if (token.includes('/')) return true;
  if (/^[a-zA-Z0-9][-a-zA-Z0-9.]*\.[a-zA-Z]{2,}(?::\d+)?(?:[/?#]|$)/.test(token)) return true;
  return false;
}

/**
 * Parses a raw cURL command string into an ApiRequest definition.
 */
export function parseCurlCommand(rawCurl: string): Partial<ApiRequest> {
  const stripped = stripCurlCommandPrefix(rawCurl);
  const cleaned = stripped !== null ? stripped : (typeof rawCurl === 'string' ? rawCurl.trim() : '');

  let method: HttpMethod = 'GET';
  let explicitMethod: HttpMethod | null = null;
  let isGetFlag = false;
  let isHeadFlag = false;
  let url = '';
  const headers: KeyValuePair[] = [];
  const bodyFormData: FormDataItem[] = [];
  const bodyUrlEncoded: KeyValuePair[] = [];
  const dataPayloads: string[] = [];
  let bodyBinaryFile: BinaryFileData | undefined = undefined;
  let bodyContent = '';
  let bodyType: ApiRequest['bodyType'] = 'none';
  let rawType: RawType = 'text';
  let graphqlQuery = '';
  let graphqlVariables = '';

  const tokens = tokenizeCurlCommand(cleaned);
  let auth: AuthConfig = { type: 'none' };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === '-X' || token === '--request') {
      const next = tokens[++i];
      if (next) {
        explicitMethod = next.toUpperCase() as HttpMethod;
        method = explicitMethod;
      }
    } else if (token === '-I' || token === '--head') {
      isHeadFlag = true;
      if (!explicitMethod) {
        method = 'HEAD';
      }
    } else if (token === '-G' || token === '--get') {
      isGetFlag = true;
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
    } else if (token === '--oauth2-bearer') {
      const bearer = tokens[++i] || '';
      if (bearer) {
        auth = {
          type: 'bearer',
          bearerToken: bearer,
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
    } else if (token === '-e' || token === '--referer') {
      const referer = tokens[++i];
      if (referer) {
        headers.push({
          id: generateId(),
          key: 'Referer',
          value: referer,
          enabled: true,
        });
      }
    } else if (token === '--json') {
      const data = tokens[++i];
      if (data !== undefined) {
        dataPayloads.push(data);
        bodyContent = data;
        bodyType = 'json';
        rawType = 'json';
        if (!explicitMethod && !isGetFlag && !isHeadFlag && method === 'GET') {
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
    } else if (token === '-F' || token === '--form' || token === '--form-string') {
      const formEntry = tokens[++i];
      if (formEntry) {
        const eqIdx = formEntry.indexOf('=');
        if (eqIdx > 0) {
          const k = formEntry.substring(0, eqIdx).trim();
          let v = formEntry.substring(eqIdx + 1).trim();
          const isFile = token !== '--form-string' && v.startsWith('@');
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
          if (!explicitMethod && !isGetFlag && !isHeadFlag && method === 'GET') {
            method = 'POST';
          }
        }
      }
    } else if (token === '--data-urlencode') {
      const data = tokens[++i];
      if (data !== undefined) {
        dataPayloads.push(data);
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
        if (!explicitMethod && !isGetFlag && !isHeadFlag && method === 'GET') {
          method = 'POST';
        }
      }
    } else if (
      token === '-d' ||
      token === '--data' ||
      token === '--data-raw' ||
      token === '--data-binary' ||
      token === '--data-ascii'
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
          dataPayloads.push(data);
          bodyContent = dataPayloads.length === 1 ? data : dataPayloads.join('&');
          const trimmed = bodyContent.trim();
          const effectiveJson = compileEffectiveJsonPayload(trimmed).trim();
          if (effectiveJson.startsWith('{') || effectiveJson.startsWith('[')) {
            try {
              const parsed = JSON.parse(effectiveJson);
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
        if (!explicitMethod && !isGetFlag && !isHeadFlag && method === 'GET') {
          method = 'POST'; // curl defaults to POST when -d is passed without -G/-I
        }
      }
    } else if (token === '--url') {
      url = tokens[++i] || '';
    } else if (NON_URL_VALUE_FLAGS.has(token)) {
      i++;
    } else if (!url && isLikelyUrlToken(token)) {
      url = token;
    }
  }

  // Handle -G / --get: move data payloads into query string and keep GET/HEAD unless -X overrode it
  if (isGetFlag) {
    if (!explicitMethod) {
      method = isHeadFlag ? 'HEAD' : 'GET';
    }
    if (dataPayloads.length > 0 && url) {
      const joinedQuery = dataPayloads.filter(Boolean).join('&');
      if (joinedQuery) {
        url += (url.includes('?') ? '&' : '?') + joinedQuery;
      }
      bodyContent = '';
      bodyType = 'none';
      rawType = 'text';
      graphqlQuery = '';
      graphqlVariables = '';
      bodyUrlEncoded.length = 0;
    }
  }

  // Extract auth from Authorization header if not already specified with -u / --oauth2-bearer
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
    } else if (ctVal.includes('application/json') || ctVal.includes('+json')) {
      if (bodyType !== 'graphql') {
        bodyType = 'json';
        rawType = 'json';
      }
    } else if (ctVal.includes('text/html')) {
      bodyType = 'raw';
      rawType = 'html';
    } else if (ctVal.includes('text/plain')) {
      bodyType = 'raw';
      rawType = 'text';
    } else if (ctVal.includes('application/x-www-form-urlencoded')) {
      bodyType = 'x-www-form-urlencoded';
      if (bodyContent && bodyUrlEncoded.length === 0) {
        const parsedParams = parseQueryParamsFromUrl(`?${bodyContent}`);
        for (const p of parsedParams) {
          if (p.key || p.value) {
            bodyUrlEncoded.push(p);
          }
        }
      }
    }
  }

  const finalUrl = url.trim();
  const params = parseQueryParamsFromUrl(finalUrl);
  const pathVariables = parsePathVariablesFromUrl(finalUrl);
  const finalHeaders =
    cleanHeaders.length > 0
      ? cleanHeaders
      : [{ id: generateId(), key: '', value: '', enabled: true }];

  return {
    method,
    url: finalUrl,
    params,
    pathVariables,
    headers: finalHeaders,
    auth,
    bodyType,
    rawType,
    bodyContent,
    graphqlQuery,
    graphqlVariables,
    bodyFormData,
    bodyBinaryFile,
    bodyUrlEncoded: bodyUrlEncoded.length > 0 ? bodyUrlEncoded : [{ id: generateId(), key: '', value: '', enabled: true }],
    name: finalUrl ? `${method} ${finalUrl.substring(0, 30)}` : 'Imported cURL Request',
  };
}

/**
 * Checks whether a clipboard/input string is a cURL command and parses it into an ApiRequest.
 * Returns null if the text is not a valid cURL command with a detectable target URL.
 */
export function tryParseCurlCommand(rawText: string): Partial<ApiRequest> | null {
  if (!isCurlCommand(rawText)) return null;
  try {
    const parsed = parseCurlCommand(rawText);
    if (!parsed.url || !parsed.url.trim()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
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
  if (
    request.auth?.type === 'apikey' &&
    request.auth?.apiKeyIn === 'query' &&
    request.auth?.apiKeyKey?.trim() &&
    request.auth?.apiKeyValue?.trim()
  ) {
    const k = interpolateVariables(request.auth.apiKeyKey.trim(), variables).trim();
    const v = interpolateVariables(request.auth.apiKeyValue.trim(), variables);
    if (k) {
      try {
        const parsedUrl = new URL(url);
        parsedUrl.searchParams.set(k, v);
        url = parsedUrl.toString();
      } catch {
        url += (url.includes('?') ? '&' : '?') + `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
      }
    }
  }

  const parts: string[] = [`curl -X ${request.method} "${url}"`];

  // Headers (excluding manual headers overridden by active Auth or runtime-managed form-data Content-Type)
  const resolveVar = (input: string) => interpolateVariables(input, variables);
  const effectiveAuth = resolveEffectiveAuthHeader(request.auth, resolveVar);
  const bodyContentType = resolveBodyContentTypeHeader(request);
  const resolvedManualHeaders = resolveManualHeaders(
    request.headers || [],
    [
      effectiveAuth?.normalizedKey ?? null,
      bodyContentType?.isManagedByRuntime ? 'content-type' : null,
    ],
    resolveVar
  );

  let hasContentType = effectiveAuth?.normalizedKey === 'content-type';
  for (const h of resolvedManualHeaders) {
    if (h.key.toLowerCase() === 'content-type') hasContentType = true;
    parts.push(`-H "${h.key}: ${h.value}"`);
  }

  if (bodyContentType && !bodyContentType.isManagedByRuntime && !hasContentType) {
    parts.push(`-H "Content-Type: ${bodyContentType.value}"`);
  }

  // Auth
  if (effectiveAuth) {
    if (effectiveAuth.authType === 'basic' && effectiveAuth.basicCredentials) {
      parts.push(`-u "${effectiveAuth.basicCredentials.username}:${effectiveAuth.basicCredentials.password}"`);
    } else {
      parts.push(`-H "${effectiveAuth.key}: ${effectiveAuth.value}"`);
    }
  }

  // Body
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.bodyType === 'graphql') {
      const q = interpolateVariables(request.graphqlQuery || request.bodyContent || '', variables);
      const vStr = compileEffectiveJsonPayload(interpolateVariables(request.graphqlVariables || '', variables)).trim();
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
      (request.bodyType === 'raw' && request.rawType === 'json')
    ) {
      const body = compileEffectiveJsonPayload(interpolateVariables(request.bodyContent || '', variables));
      if (body) {
        parts.push(`-d '${body.replace(/'/g, `'\\''`)}'`);
      }
    } else if (
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
