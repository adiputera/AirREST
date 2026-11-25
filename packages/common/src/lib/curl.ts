import { ApiRequest, HttpMethod, KeyValuePair, AuthConfig, FormDataItem, BinaryFileData, RawType } from '../types/api';
import { resolveBodyContentTypeHeader, resolveEffectiveAuthHeader, resolveManualHeaders } from './authHeaders';
import { interpolateVariables } from './fetcher';
import { compileEffectiveJsonPayload } from './formatters';
import {
  decodeQueryComponentPreservingTemplates,
  encodeQueryComponentPreservingTemplates,
  parsePathVariablesFromUrl,
  parseQueryParamsFromUrl,
  substitutePathVariables,
} from './urlParams';

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

  return rawTokens;
}

const ATTACHED_SHORT_VALUE_FLAGS = new Set([
  '-X',
  '-H',
  '-d',
  '-u',
  '-F',
  '-b',
  '-A',
  '-e',
  '-o',
  '-x',
  '-m',
  '-w',
  '-D',
  '-c',
  '-K',
  '-T',
]);

function splitOptionToken(rawToken: string): { flag: string; attachedValue?: string } {
  if (rawToken.startsWith('--')) {
    const eqIdx = rawToken.indexOf('=');
    if (eqIdx > 2) {
      const flagName = rawToken.slice(0, eqIdx);
      if (LONG_FLAGS_WITH_EQUALS.has(flagName)) {
        return { flag: flagName, attachedValue: rawToken.slice(eqIdx + 1) };
      }
    }
    return { flag: rawToken };
  }

  if (rawToken.length > 2 && rawToken[0] === '-' && rawToken[1] !== '-') {
    const shortFlag = rawToken.slice(0, 2);
    if (ATTACHED_SHORT_VALUE_FLAGS.has(shortFlag)) {
      return { flag: shortFlag, attachedValue: rawToken.slice(2) };
    }
  }

  return { flag: rawToken };
}

interface ParsedCurlDataArg {
  raw: string;
  urlencode: boolean;
}

function encodeCurlUrlencodeArg(raw: string): string {
  const eqIdx = raw.indexOf('=');
  if (eqIdx > 0) {
    const key = raw.slice(0, eqIdx);
    const val = raw.slice(eqIdx + 1);
    return `${encodeQueryComponentPreservingTemplates(key)}=${encodeQueryComponentPreservingTemplates(val)}`;
  }
  if (eqIdx === 0) {
    return encodeQueryComponentPreservingTemplates(raw.slice(1));
  }
  return encodeQueryComponentPreservingTemplates(raw);
}

function appendDataArgsToUrl(baseUrl: string, args: ParsedCurlDataArg[]): string {
  const hashIdx = baseUrl.indexOf('#');
  const hash = hashIdx >= 0 ? baseUrl.slice(hashIdx) : '';
  const withoutHash = hashIdx >= 0 ? baseUrl.slice(0, hashIdx) : baseUrl;

  const encodedParts = args
    .map((arg) => (arg.urlencode ? encodeCurlUrlencodeArg(arg.raw) : arg.raw))
    .filter((part) => part.length > 0);

  if (encodedParts.length === 0) {
    return baseUrl;
  }

  const joined = encodedParts.join('&');
  const sep = withoutHash.includes('?') ? (withoutHash.endsWith('?') || withoutHash.endsWith('&') ? '' : '&') : '?';
  return `${withoutHash}${sep}${joined}${hash}`;
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
  const dataArgs: ParsedCurlDataArg[] = [];
  let bodyBinaryFile: BinaryFileData | undefined = undefined;
  let bodyContent = '';
  let bodyType: ApiRequest['bodyType'] = 'none';
  let rawType: RawType = 'text';
  let graphqlQuery = '';
  let graphqlVariables = '';

  const tokens = tokenizeCurlCommand(cleaned);
  let auth: AuthConfig = { type: 'none' };
  let afterDoubleDash = false;
  let hasJsonFlag = false;
  const cookieCrumbs: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const rawToken = tokens[i];
    if (!afterDoubleDash && rawToken === '--') {
      afterDoubleDash = true;
      continue;
    }

    const { flag, attachedValue } = afterDoubleDash
      ? { flag: rawToken, attachedValue: undefined }
      : splitOptionToken(rawToken);

    const consumeValue = (): string | undefined => {
      if (attachedValue !== undefined) return attachedValue;
      return tokens[++i];
    };

    if (!afterDoubleDash && (flag === '-X' || flag === '--request')) {
      const next = consumeValue();
      if (next) {
        explicitMethod = next.toUpperCase() as HttpMethod;
        method = explicitMethod;
      }
    } else if (!afterDoubleDash && (flag === '-I' || flag === '--head')) {
      isHeadFlag = true;
      if (!explicitMethod) {
        method = 'HEAD';
      }
    } else if (!afterDoubleDash && (flag === '-G' || flag === '--get')) {
      isGetFlag = true;
    } else if (!afterDoubleDash && (flag === '-u' || flag === '--user')) {
      const userPass = consumeValue() || '';
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
    } else if (!afterDoubleDash && flag === '--oauth2-bearer') {
      const bearer = consumeValue() || '';
      if (bearer) {
        auth = {
          type: 'bearer',
          bearerToken: bearer,
        };
      }
    } else if (!afterDoubleDash && (flag === '-H' || flag === '--header')) {
      const headerLine = consumeValue();
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
    } else if (!afterDoubleDash && (flag === '-A' || flag === '--user-agent')) {
      const ua = consumeValue();
      if (ua) {
        headers.push({
          id: generateId(),
          key: 'User-Agent',
          value: ua,
          enabled: true,
        });
      }
    } else if (!afterDoubleDash && (flag === '-b' || flag === '--cookie')) {
      const cookie = consumeValue();
      if (cookie) {
        cookieCrumbs.push(cookie);
      }
    } else if (!afterDoubleDash && (flag === '-e' || flag === '--referer')) {
      const referer = consumeValue();
      if (referer) {
        headers.push({
          id: generateId(),
          key: 'Referer',
          value: referer,
          enabled: true,
        });
      }
    } else if (!afterDoubleDash && flag === '--json') {
      const data = consumeValue();
      if (data !== undefined) {
        hasJsonFlag = true;
        dataArgs.push({ raw: data, urlencode: false });
        bodyContent = data;
        bodyType = 'json';
        rawType = 'json';
        if (!explicitMethod && !isGetFlag && !isHeadFlag && method === 'GET') {
          method = 'POST';
        }
      }
    } else if (!afterDoubleDash && (flag === '-F' || flag === '--form' || flag === '--form-string')) {
      const formEntry = consumeValue();
      if (formEntry) {
        const eqIdx = formEntry.indexOf('=');
        if (eqIdx > 0) {
          const k = formEntry.substring(0, eqIdx).trim();
          let v = formEntry.substring(eqIdx + 1).trim();
          const isFile = flag !== '--form-string' && v.startsWith('@');
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
    } else if (!afterDoubleDash && flag === '--data-urlencode') {
      const data = consumeValue();
      if (data !== undefined) {
        dataArgs.push({ raw: data, urlencode: true });
        bodyType = 'x-www-form-urlencoded';
        if (!explicitMethod && !isGetFlag && !isHeadFlag && method === 'GET') {
          method = 'POST';
        }
      }
    } else if (
      !afterDoubleDash &&
      (flag === '-d' ||
        flag === '--data' ||
        flag === '--data-raw' ||
        flag === '--data-binary' ||
        flag === '--data-ascii')
    ) {
      const data = consumeValue();
      if (data !== undefined) {
        if (flag === '--data-binary' && data.startsWith('@')) {
          const fileName = data.substring(1).trim();
          bodyType = 'binary';
          bodyBinaryFile = {
            name: fileName,
            size: 0,
            type: 'application/octet-stream',
          };
        } else {
          dataArgs.push({ raw: data, urlencode: false });
        }
        if (!explicitMethod && !isGetFlag && !isHeadFlag && method === 'GET') {
          method = 'POST'; // curl defaults to POST when -d is passed without -G/-I
        }
      }
    } else if (!afterDoubleDash && flag === '--url') {
      url = consumeValue() || '';
    } else if (!afterDoubleDash && NON_URL_VALUE_FLAGS.has(flag)) {
      consumeValue();
    } else if (!url && (afterDoubleDash || isLikelyUrlToken(rawToken))) {
      url = rawToken;
    }
  }

  // Handle -G / --get: move data payloads into query string and keep GET/HEAD unless -X overrode it
  if (isGetFlag) {
    if (!explicitMethod) {
      method = isHeadFlag ? 'HEAD' : 'GET';
    }
    if (dataArgs.length > 0 && url) {
      url = appendDataArgsToUrl(url, dataArgs);
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
  if (cookieCrumbs.length > 0) {
    const mergedCookie = cookieCrumbs.join('; ');
    const existingCookieHeader = headers.find(
      (h) => String(h?.key ?? '').trim().toLowerCase() === 'cookie'
    );
    if (existingCookieHeader) {
      existingCookieHeader.value = existingCookieHeader.value
        ? `${existingCookieHeader.value}; ${mergedCookie}`
        : mergedCookie;
    } else {
      headers.push({
        id: generateId(),
        key: 'Cookie',
        value: mergedCookie,
        enabled: true,
      });
    }
  }

  if (hasJsonFlag) {
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

  const cleanHeaders = auth.type !== 'none'
    ? headers.filter((h) => String(h?.key ?? '').trim().toLowerCase() !== 'authorization')
    : headers;

  // Resolve bodyType, bodyContent, and form-urlencoded items for non-GET requests with data args
  const contentTypeHeader = cleanHeaders.find((h) => String(h?.key ?? '').trim().toLowerCase() === 'content-type');
  const ctVal = contentTypeHeader ? String(contentTypeHeader.value ?? '').toLowerCase() : '';
  const hasUrlEncodedData = dataArgs.some((arg) => arg.urlencode);

  if (!isGetFlag && dataArgs.length > 0 && bodyType !== 'form-data' && bodyType !== 'binary') {
    const combinedRaw = dataArgs.length === 1 ? dataArgs[0].raw : dataArgs.map((arg) => arg.raw).join('&');
    const trimmedCombined = combinedRaw.trim();
    const looksLikeDefaultCurlForm =
      !ctVal &&
      bodyType !== 'json' &&
      trimmedCombined.length > 0 &&
      !trimmedCombined.startsWith('-') &&
      !trimmedCombined.startsWith('{') &&
      !trimmedCombined.startsWith('[') &&
      !(trimmedCombined.startsWith('<') && trimmedCombined.endsWith('>')) &&
      !/[\r\n]/.test(trimmedCombined) &&
      trimmedCombined
        .split('&')
        .filter(Boolean)
        .every((pair) => /^[^=\s]+=/.test(pair));

    if (hasUrlEncodedData || ctVal.includes('application/x-www-form-urlencoded') || looksLikeDefaultCurlForm) {
      bodyType = 'x-www-form-urlencoded';
      bodyContent = dataArgs
        .map((arg) => (arg.urlencode ? encodeCurlUrlencodeArg(arg.raw) : arg.raw))
        .filter((part) => part.length > 0)
        .join('&');

      for (const arg of dataArgs) {
        if (arg.urlencode) {
          const eqIdx = arg.raw.indexOf('=');
          if (eqIdx > 0) {
            bodyUrlEncoded.push({
              id: generateId(),
              key: arg.raw.slice(0, eqIdx),
              value: arg.raw.slice(eqIdx + 1),
              enabled: true,
            });
          } else if (eqIdx === 0) {
            bodyUrlEncoded.push({
              id: generateId(),
              key: '',
              value: arg.raw.slice(1),
              enabled: true,
            });
          } else if (arg.raw.length > 0) {
            bodyUrlEncoded.push({
              id: generateId(),
              key: arg.raw,
              value: '',
              enabled: true,
            });
          }
        } else if (arg.raw.length > 0) {
          for (const pair of arg.raw.split('&')) {
            if (!pair) continue;
            const eqIdx = pair.indexOf('=');
            const rawKey = eqIdx >= 0 ? pair.slice(0, eqIdx) : pair;
            const rawVal = eqIdx >= 0 ? pair.slice(eqIdx + 1) : '';
            bodyUrlEncoded.push({
              id: generateId(),
              key: decodeQueryComponentPreservingTemplates(rawKey),
              value: decodeQueryComponentPreservingTemplates(rawVal),
              enabled: true,
            });
          }
        }
      }
    } else {
      bodyContent = dataArgs.length === 1 ? dataArgs[0].raw : dataArgs.map((arg) => arg.raw).join('&');
      const trimmed = bodyContent.trim();
      const effectiveJson = compileEffectiveJsonPayload(trimmed).trim();

      if (bodyType !== 'json') {
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

      if (ctVal) {
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
 * Formats an argument safely for POSIX shells.
 * Keeps readable double quotes when the value contains no shell-interpreted characters
 * (`"`, `$`, `` ` ``, `\`, `!`, or newlines), and otherwise wraps in single quotes
 * with `'` escaped as `'\''`.
 */
function quoteCurlShellArg(value: string): string {
  const str = String(value ?? '');
  if (!/["$`\\!\r\n]/.test(str)) {
    return `"${str}"`;
  }
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

function appendOrReplaceQueryParamsInUrl(
  rawUrl: string,
  params: KeyValuePair[],
  variables: Record<string, string>
): string {
  const activeOrCleared = (params || []).filter(
    (p) => p && interpolateVariables(String(p.key || '').trim(), variables) !== ''
  );
  if (activeOrCleared.length === 0) {
    return rawUrl;
  }

  const hashIdx = rawUrl.indexOf('#');
  const hash = hashIdx >= 0 ? rawUrl.slice(hashIdx) : '';
  const withoutHash = hashIdx >= 0 ? rawUrl.slice(0, hashIdx) : rawUrl;

  const qIdx = withoutHash.indexOf('?');
  const baseUrl = qIdx >= 0 ? withoutHash.slice(0, qIdx) : withoutHash;
  const existingQuery = qIdx >= 0 ? withoutHash.slice(qIdx + 1) : '';

  const managedKeys = new Set<string>();
  const appendedPairs: string[] = [];
  for (const p of activeOrCleared) {
    const k = interpolateVariables(String(p.key || '').trim(), variables);
    if (!k) continue;
    managedKeys.add(k);
    if (p.enabled) {
      const v = interpolateVariables(String(p.value ?? ''), variables);
      appendedPairs.push(
        `${encodeQueryComponentPreservingTemplates(k)}=${encodeQueryComponentPreservingTemplates(v)}`
      );
    }
  }

  const preservedPairs: string[] = [];
  if (existingQuery) {
    for (const pair of existingQuery.split('&')) {
      if (!pair) continue;
      const eqIdx = pair.indexOf('=');
      const rawKey = eqIdx >= 0 ? pair.slice(0, eqIdx) : pair;
      const decodedKey = decodeQueryComponentPreservingTemplates(rawKey);
      if (!managedKeys.has(decodedKey) && !managedKeys.has(rawKey)) {
        preservedPairs.push(pair);
      }
    }
  }

  const allPairs = [...preservedPairs, ...appendedPairs];
  if (allPairs.length === 0) {
    return `${baseUrl}${hash}`;
  }
  return `${baseUrl}?${allPairs.join('&')}${hash}`;
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

  // Append query parameters (preserve duplicate keys, drop disabled keys, preserve fragment and schemeless/template hosts)
  if (request.params && request.params.length > 0) {
    url = appendOrReplaceQueryParamsInUrl(url, request.params, variables);
  }

  // If API Key is configured in query parameters, attach it before any #fragment
  if (
    request.auth?.type === 'apikey' &&
    request.auth?.apiKeyIn === 'query' &&
    request.auth?.apiKeyKey?.trim() &&
    request.auth?.apiKeyValue?.trim()
  ) {
    const k = interpolateVariables(request.auth.apiKeyKey.trim(), variables).trim();
    const v = interpolateVariables(request.auth.apiKeyValue.trim(), variables);
    if (k) {
      url = appendOrReplaceQueryParamsInUrl(
        url,
        [{ id: 'auth-api-key', key: k, value: v, enabled: true }],
        {}
      );
    }
  }

  const safeMethod = /^[A-Z]+$/i.test(String(request.method || '').trim())
    ? String(request.method).trim().toUpperCase()
    : quoteCurlShellArg(String(request.method || 'GET'));
  const parts: string[] = [`curl -X ${safeMethod} ${quoteCurlShellArg(url)}`];

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
    parts.push(`-H ${quoteCurlShellArg(`${h.key}: ${h.value}`)}`);
  }

  if (bodyContentType && !bodyContentType.isManagedByRuntime && !hasContentType) {
    parts.push(`-H ${quoteCurlShellArg(`Content-Type: ${bodyContentType.value}`)}`);
  }

  // Auth
  if (effectiveAuth) {
    if (effectiveAuth.authType === 'basic' && effectiveAuth.basicCredentials) {
      parts.push(
        `-u ${quoteCurlShellArg(`${effectiveAuth.basicCredentials.username}:${effectiveAuth.basicCredentials.password}`)}`
      );
    } else {
      parts.push(`-H ${quoteCurlShellArg(`${effectiveAuth.key}: ${effectiveAuth.value}`)}`);
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
        parts.push(`--data-raw ${quoteCurlShellArg(body)}`);
      }
    } else if (request.bodyType === 'x-www-form-urlencoded') {
      const activeItems = (request.bodyUrlEncoded || []).filter((item) => item.enabled && item.key.trim());
      if (activeItems.length > 0) {
        for (const item of activeItems) {
          const k = interpolateVariables(item.key.trim(), variables);
          const v = interpolateVariables(item.value || '', variables);
          parts.push(`--data-urlencode ${quoteCurlShellArg(`${k}=${v}`)}`);
        }
      } else if (request.bodyContent) {
        const body = interpolateVariables(request.bodyContent, variables);
        parts.push(`-d '${body.replace(/'/g, `'\\''`)}'`);
      }
    } else if (request.bodyType === 'form-data') {
      for (const item of request.bodyFormData || []) {
        if (item.enabled && item.key.trim()) {
          const k = interpolateVariables(item.key.trim(), variables);
          if (item.type === 'file') {
            const fileName =
              item.file?.name ||
              item.fileName ||
              interpolateVariables(item.value || '', variables) ||
              'file.bin';
            parts.push(`-F ${quoteCurlShellArg(`${k}=@${fileName}`)}`);
          } else {
            const v = interpolateVariables(item.value || '', variables);
            const flag = v.startsWith('@') || v.startsWith('<') || v.includes(';') ? '--form-string' : '-F';
            parts.push(`${flag} ${quoteCurlShellArg(`${k}=${v}`)}`);
          }
        }
      }
    } else if (request.bodyType === 'binary' && request.bodyBinaryFile) {
      const fileName = request.bodyBinaryFile.name || 'file.bin';
      parts.push(`--data-binary ${quoteCurlShellArg(`@${fileName}`)}`);
    }
  }

  return parts.join(' \\\n  ');
}
