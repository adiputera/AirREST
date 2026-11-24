import { Environment } from '../types/api';

export type AutocompleteInputMode = 'variable-only' | 'header-name' | 'none';

export type HeaderCategory =
  | 'Auth & Security'
  | 'Content & Negotiation'
  | 'Caching & Conditionals'
  | 'Client, Proxy & Tracing'
  | 'Connection & CORS';

export interface HeaderCatalogEntry {
  name: string;
  category: HeaderCategory;
  description: string;
  /** Lower number = higher priority when match tiers are equal (1 = top priority). */
  priority?: number;
}

export interface HeaderSuggestionItem {
  kind: 'header';
  key: string;
  label: string;
  insertValue: string;
  category: HeaderCategory;
  description: string;
  matchTier: 1 | 2 | 3 | 4;
}

export interface VariableSuggestionItem {
  kind: 'variable';
  key: string;
  varName: string;
  label: string;
  insertValue: string;
  resolvedValue: string;
  scope: string;
  isBuiltin: boolean;
  isActiveEnv: boolean;
  matchTier: 1 | 2 | 3;
}

export type AutocompleteSuggestionItem = HeaderSuggestionItem | VariableSuggestionItem;

export interface AutocompleteContext {
  kind: 'header' | 'variable';
  query: string;
  replaceFrom: number;
  replaceTo: number;
  openBracesIndex?: number;
}

export const COMMON_HTTP_HEADERS: readonly HeaderCatalogEntry[] = [
  // Auth & Security
  {
    name: 'Authorization',
    category: 'Auth & Security',
    description: 'Credentials for authenticating the client (e.g. Bearer, Basic)',
    priority: 1,
  },
  {
    name: 'X-API-Key',
    category: 'Auth & Security',
    description: 'API key token for custom service authentication',
    priority: 4,
  },
  {
    name: 'Proxy-Authorization',
    category: 'Auth & Security',
    description: 'Credentials for authenticating with an HTTP proxy',
    priority: 25,
  },
  {
    name: 'X-Auth-Token',
    category: 'Auth & Security',
    description: 'Legacy or custom authentication session token',
    priority: 16,
  },
  {
    name: 'X-CSRF-Token',
    category: 'Auth & Security',
    description: 'Cross-Site Request Forgery protection token',
    priority: 17,
  },
  {
    name: 'X-XSRF-Token',
    category: 'Auth & Security',
    description: 'Cookie-to-header CSRF protection token',
    priority: 18,
  },
  {
    name: 'Cookie',
    category: 'Auth & Security',
    description: 'Stored HTTP cookies sent to the server',
    priority: 9,
  },
  {
    name: 'Origin',
    category: 'Auth & Security',
    description: 'Origin (scheme, host, port) initiating the request',
    priority: 12,
  },
  {
    name: 'Referer',
    category: 'Auth & Security',
    description: 'Address of the previous web page linking to the resource',
    priority: 19,
  },
  {
    name: 'Sec-Fetch-Dest',
    category: 'Auth & Security',
    description: 'Request destination metadata (e.g. empty, document)',
    priority: 40,
  },
  {
    name: 'Sec-Fetch-Mode',
    category: 'Auth & Security',
    description: 'Request mode metadata (e.g. cors, navigate, no-cors)',
    priority: 41,
  },
  {
    name: 'Sec-Fetch-Site',
    category: 'Auth & Security',
    description: 'Relationship between origin and target (e.g. same-origin, cross-site)',
    priority: 42,
  },

  // Content & Negotiation
  {
    name: 'Content-Type',
    category: 'Content & Negotiation',
    description: 'Media type of the request body (e.g. application/json)',
    priority: 2,
  },
  {
    name: 'Accept',
    category: 'Content & Negotiation',
    description: 'Media types acceptable for the response (e.g. application/json)',
    priority: 3,
  },
  {
    name: 'Accept-Language',
    category: 'Content & Negotiation',
    description: 'Preferred natural language and locale (e.g. en-US, id-ID)',
    priority: 10,
  },
  {
    name: 'Accept-Encoding',
    category: 'Content & Negotiation',
    description: 'Acceptable content compression algorithms (e.g. gzip, deflate, br)',
    priority: 11,
  },
  {
    name: 'Accept-Charset',
    category: 'Content & Negotiation',
    description: 'Character encodings understood by the client',
    priority: 30,
  },
  {
    name: 'Content-Length',
    category: 'Content & Negotiation',
    description: 'Size of the request body in bytes',
    priority: 14,
  },
  {
    name: 'Content-Encoding',
    category: 'Content & Negotiation',
    description: 'Compression encoding applied to the request payload',
    priority: 22,
  },
  {
    name: 'Content-Disposition',
    category: 'Content & Negotiation',
    description: 'Presentation style or filename for multipart/file payloads',
    priority: 23,
  },
  {
    name: 'Content-Language',
    category: 'Content & Negotiation',
    description: 'Natural language(s) of the intended audience for the body',
    priority: 31,
  },
  {
    name: 'Content-MD5',
    category: 'Content & Negotiation',
    description: 'Base64-encoded 128-bit MD5 digest of the message body',
    priority: 35,
  },

  // Caching & Conditionals
  {
    name: 'Cache-Control',
    category: 'Caching & Conditionals',
    description: 'Directives for caching mechanisms (e.g. no-cache, no-store)',
    priority: 5,
  },
  {
    name: 'If-Match',
    category: 'Caching & Conditionals',
    description: 'Conditional request matching resource ETag (optimistic concurrency)',
    priority: 8,
  },
  {
    name: 'If-None-Match',
    category: 'Caching & Conditionals',
    description: 'Conditional request proceeding only if ETag differs',
    priority: 13,
  },
  {
    name: 'If-Modified-Since',
    category: 'Caching & Conditionals',
    description: 'Conditional request returning 304 if unchanged since date',
    priority: 20,
  },
  {
    name: 'If-Unmodified-Since',
    category: 'Caching & Conditionals',
    description: 'Conditional request proceeding only if unmodified since date',
    priority: 32,
  },
  {
    name: 'If-Range',
    category: 'Caching & Conditionals',
    description: 'Conditional partial range request if ETag or date matches',
    priority: 36,
  },
  {
    name: 'Pragma',
    category: 'Caching & Conditionals',
    description: 'HTTP/1.0 backward-compatible cache directive (e.g. no-cache)',
    priority: 28,
  },

  // Client, Proxy & Tracing
  {
    name: 'User-Agent',
    category: 'Client, Proxy & Tracing',
    description: 'Client application, OS, and version identification string',
    priority: 6,
  },
  {
    name: 'X-Request-ID',
    category: 'Client, Proxy & Tracing',
    description: 'Unique identifier for tracing an individual HTTP request',
    priority: 7,
  },
  {
    name: 'Idempotency-Key',
    category: 'Client, Proxy & Tracing',
    description: 'Unique key ensuring safe retries of mutating POST/PATCH requests',
    priority: 8,
  },
  {
    name: 'X-Correlation-ID',
    category: 'Client, Proxy & Tracing',
    description: 'Distributed tracing identifier across microservices',
    priority: 15,
  },
  {
    name: 'Traceparent',
    category: 'Client, Proxy & Tracing',
    description: 'W3C Trace Context parent identifier for distributed tracing',
    priority: 24,
  },
  {
    name: 'Tracestate',
    category: 'Client, Proxy & Tracing',
    description: 'W3C Trace Context vendor-specific tracing key-value pairs',
    priority: 37,
  },
  {
    name: 'Host',
    category: 'Client, Proxy & Tracing',
    description: 'Target domain name and optional listening port',
    priority: 21,
  },
  {
    name: 'Forwarded',
    category: 'Client, Proxy & Tracing',
    description: 'Standardized proxy forwarding client/protocol information',
    priority: 29,
  },
  {
    name: 'X-Forwarded-For',
    category: 'Client, Proxy & Tracing',
    description: 'Originating client IP address passed through reverse proxies',
    priority: 26,
  },
  {
    name: 'X-Forwarded-Host',
    category: 'Client, Proxy & Tracing',
    description: 'Original Host header requested by the client before proxy',
    priority: 33,
  },
  {
    name: 'X-Forwarded-Proto',
    category: 'Client, Proxy & Tracing',
    description: 'Originating protocol (http or https) used by the client',
    priority: 34,
  },
  {
    name: 'X-Real-IP',
    category: 'Client, Proxy & Tracing',
    description: 'Client IP header commonly set by NGINX reverse proxies',
    priority: 38,
  },

  // Connection & CORS
  {
    name: 'Access-Control-Request-Method',
    category: 'Connection & CORS',
    description: 'CORS preflight indication of HTTP method to be used',
    priority: 27,
  },
  {
    name: 'Access-Control-Request-Headers',
    category: 'Connection & CORS',
    description: 'CORS preflight indication of custom HTTP headers to be sent',
    priority: 27,
  },
  {
    name: 'Connection',
    category: 'Connection & CORS',
    description: 'Control options for the current network connection (e.g. keep-alive)',
    priority: 30,
  },
  {
    name: 'Keep-Alive',
    category: 'Connection & CORS',
    description: 'Parameters for persistent connection timeout and max requests',
    priority: 39,
  },
  {
    name: 'Range',
    category: 'Connection & CORS',
    description: 'Byte range of a resource requested for partial download (e.g. bytes=0-1023)',
    priority: 26,
  },
  {
    name: 'Transfer-Encoding',
    category: 'Connection & CORS',
    description: 'Payload transfer encoding format (e.g. chunked)',
    priority: 39,
  },
  {
    name: 'Upgrade',
    category: 'Connection & CORS',
    description: 'Protocol upgrade request (e.g. websocket, h2c)',
    priority: 35,
  },
  {
    name: 'Date',
    category: 'Connection & CORS',
    description: 'Date and time at which the message was originated',
    priority: 39,
  },
  {
    name: 'Expect',
    category: 'Connection & CORS',
    description: 'Server behaviors required by the client (e.g. 100-continue)',
    priority: 43,
  },
];

export interface BuiltinVariableDescriptor {
  varName: string;
  description: string;
  getSampleValue: () => string;
}

export const BUILTIN_DYNAMIC_VARIABLES: readonly BuiltinVariableDescriptor[] = [
  {
    varName: '$guid',
    description: 'Random UUID v4 (generated at request dispatch)',
    getSampleValue: () => 'Random UUID v4 (e.g. 7f8c3d12-...)',
  },
  {
    varName: '$timestamp',
    description: 'Current Unix timestamp in seconds',
    getSampleValue: () => `Current Unix timestamp (e.g. ${Math.floor(Date.now() / 1000)})`,
  },
  {
    varName: '$isoTimestamp',
    description: 'Current UTC ISO-8601 timestamp string',
    getSampleValue: () => `Current UTC ISO string (e.g. ${new Date().toISOString()})`,
  },
  {
    varName: '$randomInt',
    description: 'Random integer between 1 and 1000',
    getSampleValue: () => 'Random integer (1..1000)',
  },
];

/**
 * Filters and ranks common HTTP request headers against a user query.
 *
 * Ranking tiers:
 * - Tier 1: Exact case-insensitive prefix match on the full header name (e.g. "Au" -> "Authorization").
 * - Tier 2: Case-insensitive prefix match on a hyphen-separated segment (e.g. "Key" -> "X-API-Key").
 * - Tier 3: Case-insensitive substring match anywhere else in the header name.
 * - Tier 4: Empty query (returns top common headers ordered by priority).
 */
export function getHeaderSuggestions(
  query: string,
  options?: { limit?: number }
): HeaderSuggestionItem[] {
  const limit = options?.limit ?? 15;
  const trimmed = String(query ?? '').trim();
  const normalizedQuery = trimmed.toLowerCase();

  if (!normalizedQuery) {
    return [...COMMON_HTTP_HEADERS]
      .sort((a, b) => {
        const pa = a.priority ?? 100;
        const pb = b.priority ?? 100;
        if (pa !== pb) return pa - pb;
        return a.name.localeCompare(b.name);
      })
      .slice(0, limit)
      .map((entry) => ({
        kind: 'header',
        key: entry.name.toLowerCase(),
        label: entry.name,
        insertValue: entry.name,
        category: entry.category,
        description: entry.description,
        matchTier: 4,
      }));
  }

  const matched: { entry: HeaderCatalogEntry; tier: 1 | 2 | 3 }[] = [];

  for (const entry of COMMON_HTTP_HEADERS) {
    const lowerName = entry.name.toLowerCase();

    if (lowerName.startsWith(normalizedQuery)) {
      matched.push({ entry, tier: 1 });
      continue;
    }

    const segments = lowerName.split('-');
    const matchesSegmentPrefix = segments.slice(1).some((seg) => seg.startsWith(normalizedQuery));
    if (matchesSegmentPrefix) {
      matched.push({ entry, tier: 2 });
      continue;
    }

    if (lowerName.includes(normalizedQuery)) {
      matched.push({ entry, tier: 3 });
    }
  }

  matched.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const pa = a.entry.priority ?? 100;
    const pb = b.entry.priority ?? 100;
    if (pa !== pb) return pa - pb;
    return a.entry.name.localeCompare(b.entry.name);
  });

  return matched.slice(0, limit).map(({ entry, tier }) => ({
    kind: 'header',
    key: entry.name.toLowerCase(),
    label: entry.name,
    insertValue: entry.name,
    category: entry.category,
    description: entry.description,
    matchTier: tier,
  }));
}

/**
 * Collects, filters, and ranks available variables from the active environment,
 * fallback inactive workspace environments (if any variables aren't in the active one),
 * and built-in dynamic Postman-compatible variables.
 */
export function getVariableSuggestions(
  query: string,
  environments: readonly Environment[] = [],
  activeEnvironmentId: string | null = null,
  options?: { limit?: number }
): VariableSuggestionItem[] {
  const limit = options?.limit ?? 30;
  const trimmedQuery = String(query ?? '').trim().toLowerCase();

  const activeEnv = (environments || []).find((e) => e && e.id === activeEnvironmentId) || null;
  const seenVarNames = new Set<string>();
  const rawItems: Omit<VariableSuggestionItem, 'matchTier'>[] = [];

  // 1. Active environment enabled variables (highest precedence)
  if (activeEnv && Array.isArray(activeEnv.variables)) {
    for (const v of activeEnv.variables) {
      if (!v || !v.enabled) continue;
      const varName = String(v.key ?? '').trim();
      if (!varName || seenVarNames.has(varName)) continue;
      seenVarNames.add(varName);

      const effVal =
        v.currentValue !== undefined && v.currentValue !== ''
          ? String(v.currentValue)
          : String(v.initialValue ?? v.value ?? '');

      rawItems.push({
        kind: 'variable',
        key: `active:${varName}`,
        varName,
        label: `{{${varName}}}`,
        insertValue: `{{${varName}}}`,
        resolvedValue: effVal,
        scope: `${activeEnv.name}`,
        isBuiltin: false,
        isActiveEnv: true,
      });
    }
  }

  // 2. Fallback variables from other environments in current workspace (helpful when no env is active yet)
  for (const env of environments || []) {
    if (!env || env.id === activeEnvironmentId || !Array.isArray(env.variables)) continue;
    for (const v of env.variables) {
      if (!v || !v.enabled) continue;
      const varName = String(v.key ?? '').trim();
      if (!varName || seenVarNames.has(varName)) continue;
      seenVarNames.add(varName);

      const effVal =
        v.currentValue !== undefined && v.currentValue !== ''
          ? String(v.currentValue)
          : String(v.initialValue ?? v.value ?? '');

      rawItems.push({
        kind: 'variable',
        key: `inactive:${env.id}:${varName}`,
        varName,
        label: `{{${varName}}}`,
        insertValue: `{{${varName}}}`,
        resolvedValue: effVal,
        scope: activeEnv ? `${env.name} (inactive)` : `${env.name} (not active)`,
        isBuiltin: false,
        isActiveEnv: false,
      });
    }
  }

  // 3. Built-in dynamic variables
  for (const builtin of BUILTIN_DYNAMIC_VARIABLES) {
    if (seenVarNames.has(builtin.varName)) continue;
    seenVarNames.add(builtin.varName);
    rawItems.push({
      kind: 'variable',
      key: `builtin:${builtin.varName}`,
      varName: builtin.varName,
      label: `{{${builtin.varName}}}`,
      insertValue: `{{${builtin.varName}}}`,
      resolvedValue: builtin.description,
      scope: 'Dynamic Variable',
      isBuiltin: true,
      isActiveEnv: false,
    });
  }

  const matched: VariableSuggestionItem[] = [];

  for (const item of rawItems) {
    if (!trimmedQuery) {
      matched.push({ ...item, matchTier: 1 });
      continue;
    }

    const lowerVar = item.varName.toLowerCase();
    // Strip leading '$' so typing "{{gu" matches "{{$guid}}" at prefix tier
    const lowerVarWithoutDollar = lowerVar.startsWith('$') ? lowerVar.slice(1) : lowerVar;

    if (lowerVar.startsWith(trimmedQuery) || lowerVarWithoutDollar.startsWith(trimmedQuery)) {
      matched.push({ ...item, matchTier: 1 });
    } else if (lowerVar.includes(trimmedQuery)) {
      matched.push({ ...item, matchTier: 2 });
    } else if (item.scope.toLowerCase().includes(trimmedQuery)) {
      matched.push({ ...item, matchTier: 3 });
    }
  }

  matched.sort((a, b) => {
    // When user typed a query, rank by matchTier first, then activeEnv -> inactiveEnv -> builtin
    if (a.matchTier !== b.matchTier) return a.matchTier - b.matchTier;
    if (a.isActiveEnv !== b.isActiveEnv) return a.isActiveEnv ? -1 : 1;
    if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? 1 : -1;
    return a.varName.localeCompare(b.varName);
  });

  return matched.slice(0, limit);
}

/**
 * Inspects the text and current cursor offset (`selectionStart`) to determine whether
 * a `{{` variable trigger or a header name autocomplete trigger is active.
 */
export function detectInputAutocompleteContext(
  text: string,
  selectionStart: number,
  mode: AutocompleteInputMode = 'variable-only',
  options?: { forceOpenHeader?: boolean }
): AutocompleteContext | null {
  if (mode === 'none') return null;
  const safeText = typeof text === 'string' ? text : '';
  const cursor = Math.max(0, Math.min(selectionStart ?? safeText.length, safeText.length));

  // 1. Check if cursor is inside an unclosed `{{...` token on the current line
  const beforeCursor = safeText.slice(0, cursor);
  const lastNewlineIdx = beforeCursor.lastIndexOf('\n');
  const lineStartIdx = lastNewlineIdx === -1 ? 0 : lastNewlineIdx + 1;
  const lineBeforeCursor = safeText.slice(lineStartIdx, cursor);

  const lastOpenBracesInLine = lineBeforeCursor.lastIndexOf('{{');
  if (lastOpenBracesInLine !== -1) {
    const absOpenIndex = lineStartIdx + lastOpenBracesInLine;
    const betweenOpenAndCursor = safeText.slice(absOpenIndex + 2, cursor);

    // Valid unclosed variable trigger if there are no `{` or `}` or newlines between `{{` and cursor
    if (!/[{}\r\n]/.test(betweenOpenAndCursor)) {
      // Determine how far the replacement should extend to the right of the cursor
      const afterCursor = safeText.slice(cursor);
      let replaceTo = cursor;

      // Consume any trailing identifier characters and closing `}` or `}}` on the same line
      // if the user is editing an existing token or has auto-paired braces
      const trailingClosureMatch = afterCursor.match(/^([^{}\r\n]*?\}\}|\})/);
      if (trailingClosureMatch && trailingClosureMatch[0].startsWith('}')) {
        // Immediate `}` or `}}` right after cursor
        replaceTo = cursor + (afterCursor.startsWith('}}') ? 2 : 1);
      }

      return {
        kind: 'variable',
        query: betweenOpenAndCursor,
        replaceFrom: absOpenIndex,
        replaceTo,
        openBracesIndex: absOpenIndex,
      };
    }
  }

  // 2. If in `header-name` mode, check for header key prefix/query trigger
  if (mode === 'header-name') {
    const trimmed = safeText.trim();
    // Avoid triggering header suggestions if the field already contains a variable `{{...}}`
    if (safeText.includes('{{')) {
      return null;
    }
    if (trimmed.length > 0 || options?.forceOpenHeader) {
      return {
        kind: 'header',
        query: trimmed,
        replaceFrom: 0,
        replaceTo: safeText.length,
      };
    }
  }

  return null;
}

/**
 * Applies a selected autocomplete item to the input string and computes the new cursor position.
 * Prevents duplicate closing `}}` braces when inserting a variable.
 */
export function applyAutocompleteSuggestion(
  text: string,
  context: AutocompleteContext,
  suggestion: AutocompleteSuggestionItem | string
): { nextText: string; nextCursorPos: number } {
  const safeText = typeof text === 'string' ? text : '';
  const rawValue = typeof suggestion === 'string' ? suggestion : suggestion.insertValue;

  if (context.kind === 'header') {
    const headerName = rawValue;
    return {
      nextText: headerName,
      nextCursorPos: headerName.length,
    };
  }

  // Variable insertion: ensure value is wrapped in `{{...}}`
  const cleanVarName = rawValue.replace(/^\{\{|\}\}$/g, '').trim();
  const formattedToken = `{{${cleanVarName}}}`;

  const prefix = safeText.slice(0, context.replaceFrom);
  let suffix = safeText.slice(context.replaceTo);

  // Guard against leftover closing braces immediately following replaceTo
  if (suffix.startsWith('}}')) {
    suffix = suffix.slice(2);
  } else if (suffix.startsWith('}')) {
    suffix = suffix.slice(1);
  }

  const nextText = `${prefix}${formattedToken}${suffix}`;
  const nextCursorPos = prefix.length + formattedToken.length;

  return {
    nextText,
    nextCursorPos,
  };
}
