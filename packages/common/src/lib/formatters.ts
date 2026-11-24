/**
 * Beautifies and indents XML strings with 2-space indentation.
 * Validates syntax using DOMParser if in browser environment.
 */
export function beautifyXml(xml?: string | null): { formatted: string; error?: string } {
  const trimmed = typeof xml === 'string' ? xml.trim() : '';
  if (!trimmed) return { formatted: '' };

  // Validate syntax first if DOMParser exists
  if (typeof DOMParser !== 'undefined') {
    const parser = new DOMParser();
    const doc = parser.parseFromString(trimmed, 'application/xml');
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      const errText = parseError.textContent?.split('\n')[0] || 'Invalid XML syntax';
      return { formatted: trimmed, error: errText };
    }
  }

  const PADDING = '  ';
  let formatted = '';
  let pad = 0;

  // Normalize whitespace between tags
  const cleanXml = trimmed.replace(/>\s*</g, '><').replace(/</g, '~::~<').split('~::~');

  for (let i = 0; i < cleanXml.length; i++) {
    const token = cleanXml[i].trim();
    if (!token) continue;

    // Comments, CDATA, DOCTYPE, and XML processing instructions
    if (
      token.startsWith('<!--') ||
      token.startsWith('<![CDATA[') ||
      token.startsWith('<?xml') ||
      token.startsWith('<!DOCTYPE')
    ) {
      formatted += PADDING.repeat(pad) + token + '\n';
      continue;
    }

    // Closing tag </tag>
    if (token.startsWith('</')) {
      pad = Math.max(0, pad - 1);
      formatted += PADDING.repeat(pad) + token + '\n';
      continue;
    }

    // Self-closing tag <tag /> or inline <tag>value</tag>
    const isSelfClosing = token.endsWith('/>');
    const isInlineTag = /^<([a-zA-Z0-9_\-:]+)(?:\s+[^>]*)?>([^<]+)<\/\1>$/.test(token);

    if (isSelfClosing || isInlineTag) {
      formatted += PADDING.repeat(pad) + token + '\n';
      continue;
    }

    // Opening tag <tag>
    if (token.startsWith('<')) {
      formatted += PADDING.repeat(pad) + token + '\n';
      pad++;
      continue;
    }

    // Raw text content
    formatted += PADDING.repeat(pad) + token + '\n';
  }

  return { formatted: formatted.trim() };
}

export interface TextRange {
  from: number;
  to: number;
}

/**
 * Finds character ranges `[from, to)` of single-line (`//`) and block (`/* *\/`) comments
 * in JSON/JSONC text while ignoring comment-like sequences inside string literals.
 */
export function findJsonCommentRanges(input: string): TextRange[] {
  if (!input || (!input.includes('//') && !input.includes('/*'))) {
    return [];
  }

  const ranges: TextRange[] = [];
  let inString = false;
  let quoteChar = '';
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quoteChar) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quoteChar = char;
      escaped = false;
      continue;
    }

    if (char === '/' && next === '/') {
      const from = i;
      i += 2;
      while (i < input.length && input[i] !== '\n' && input[i] !== '\r') {
        i++;
      }
      ranges.push({ from, to: i });
      // Rewind one step if loop stopped at newline so outer loop checks next char cleanly
      i--;
      continue;
    }

    if (char === '/' && next === '*') {
      const from = i;
      const closeIdx = input.indexOf('*/', i + 2);
      const to = closeIdx === -1 ? input.length : closeIdx + 2;
      ranges.push({ from, to });
      i = to - 1;
    }
  }

  return ranges;
}

/**
 * Safely strips single-line (//) and multi-line (/* *\/) comments from a JSON-like string
 * without corrupting URLs or comment-like sequences inside quotes.
 */
export function stripJsonComments(input: string): string {
  const ranges = findJsonCommentRanges(input);
  if (ranges.length === 0) return input;

  let output = '';
  let cursor = 0;
  for (const { from, to } of ranges) {
    output += input.slice(cursor, from);
    cursor = to;
  }
  return output + input.slice(cursor);
}

/**
 * Strips JSON comments while removing lines that contained only whitespace and comments,
 * keeping intentional non-comment blank lines and string contents intact.
 */
function stripJsonCommentsCleanly(input: string): string {
  let output = '';
  let lineBuffer = '';
  let lineHadNonWhitespaceCode = false;
  let lineHadComment = false;
  let inString = false;
  let quoteChar = '';
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  const flushLine = (lineBreak: string) => {
    if (lineHadComment && !lineHadNonWhitespaceCode) {
      // Drop lines whose entire non-whitespace content was commented out
    } else if (lineHadComment) {
      output += lineBuffer.replace(/[ \t]+$/, '') + lineBreak;
    } else {
      output += lineBuffer + lineBreak;
    }
    lineBuffer = '';
    lineHadNonWhitespaceCode = false;
    lineHadComment = false;
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (char === '\r' && next === '\n') {
        inLineComment = false;
        flushLine('\r\n');
        i++;
      } else if (char === '\n' || char === '\r') {
        inLineComment = false;
        flushLine(char);
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i++;
      } else if (char === '\r' && next === '\n') {
        flushLine('\r\n');
        i++;
      } else if (char === '\n' || char === '\r') {
        flushLine(char);
      }
      continue;
    }

    if (inString) {
      lineBuffer += char;
      lineHadNonWhitespaceCode = true;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quoteChar) {
        inString = false;
      }
      continue;
    }

    if (char === '\r' && next === '\n') {
      flushLine('\r\n');
      i++;
      continue;
    }

    if (char === '\n' || char === '\r') {
      flushLine(char);
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quoteChar = char;
      escaped = false;
      lineBuffer += char;
      lineHadNonWhitespaceCode = true;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      lineHadComment = true;
      i++;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      lineHadComment = true;
      i++;
      continue;
    }

    lineBuffer += char;
    if (char !== ' ' && char !== '\t') {
      lineHadNonWhitespaceCode = true;
    }
  }

  if (lineBuffer.length > 0 || (lineHadComment && lineHadNonWhitespaceCode)) {
    output += lineHadComment && !lineHadNonWhitespaceCode ? '' : (lineHadComment ? lineBuffer.replace(/[ \t]+$/, '') : lineBuffer);
  }

  return output;
}

/**
 * Removes trailing commas immediately preceding `}` or `]` outside of string literals.
 */
export function removeJsonTrailingCommas(input: string): string {
  let output = '';
  let inString = false;
  let quoteChar = '';
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quoteChar) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quoteChar = char;
      escaped = false;
      output += char;
      continue;
    }

    if (char === ',') {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) {
        j++;
      }
      if (j < input.length && (input[j] === '}' || input[j] === ']')) {
        continue;
      }
    }

    output += char;
  }

  return output;
}

/**
 * Compiles a JSON or JSONC (JSON with comments and trailing commas) payload into a clean
 * outbound JSON string ready for HTTP transport and cURL generation without altering
 * string contents, key ordering, or large number formatting.
 */
export function compileEffectiveJsonPayload(rawJson?: string | null): string {
  if (!rawJson || typeof rawJson !== 'string') return '';
  if (!rawJson.trim()) return rawJson;

  // Fast path: if already valid strict RFC 8259 JSON, keep as-is
  try {
    JSON.parse(rawJson);
    return rawJson;
  } catch {
    // Proceed with comment & trailing-comma stripping
  }

  const stripped = stripJsonCommentsCleanly(rawJson);
  const withoutTrailingCommas = removeJsonTrailingCommas(stripped);

  if (!withoutTrailingCommas.trim()) {
    return '';
  }

  return withoutTrailingCommas;
}

/**
 * Sanitizes relaxed JSON-like strings (such as JavaScript object literals,
 * Python dictionaries, single quotes, unquoted keys, trailing commas, comments)
 * into standard RFC 8259 JSON format.
 */
export function sanitizeRelaxedJson(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return '';
  let clean = stripJsonComments(raw);

  // 1. Normalize single-quoted property keys: 'key': -> "key":
  clean = clean.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'\s*:/g, (_m, inner) => {
    return `"${inner.replace(/(?<!\\)"/g, '\\"')}":`;
  });

  // 2. Normalize unquoted property names: key: -> "key":
  clean = clean.replace(/([{,]\s*)([a-zA-Z0-9_$-]+)\s*:/g, '$1"$2":');

  // 3. Normalize single-quoted string values in object fields or arrays
  clean = clean.replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, inner) => {
    return `: "${inner.replace(/(?<!\\)"/g, '\\"')}"`;
  });
  clean = clean.replace(/((?:\[|,)\s*)'([^'\\]*(?:\\.[^'\\]*)*)'(?=\s*(?:,|\]))/g, (_m, prefix, inner) => {
    return `${prefix}"${inner.replace(/(?<!\\)"/g, '\\"')}"`;
  });

  // 4. Python booleans and None (in key-values and arrays)
  clean = clean.replace(/:\s*True\b/g, ': true').replace(/:\s*False\b/g, ': false').replace(/:\s*None\b/g, ': null');
  clean = clean.replace(/((?:\[|,)\s*)True\b/g, '$1true').replace(/((?:\[|,)\s*)False\b/g, '$1false').replace(/((?:\[|,)\s*)None\b/g, '$1null');

  // 5. Wrap unquoted AirREST template variables {{var}}
  clean = clean.replace(/:\s*(\{\{[^{}]+\}\})/g, ': "__AIRREST_TMPL_$1__"');
  clean = clean.replace(/((?:\[|,)\s*)(\{\{[^{}]+\}\})/g, '$1"__AIRREST_TMPL_$2__"');

  // 6. Remove trailing commas before } or ]
  clean = removeJsonTrailingCommas(clean);

  // 7. Insert missing comma between lines ending with value and next property
  clean = clean.replace(/(["\d\w}\]])(\s*\n\s*"[^"]+"\s*:)/g, '$1,$2');

  return clean;
}

export type JsonLikeTokenKind = 'open-object' | 'close-object' | 'open-array' | 'close-array' | 'colon' | 'comma' | 'atom' | 'line-comment' | 'block-comment';

export interface JsonLikeToken {
  kind: JsonLikeTokenKind;
  text: string;
  /** Whether a line break separated this token from the previous token in the source. */
  newlineBefore?: boolean;
}

export function tokenizeJsonLike(input: string): { tokens: JsonLikeToken[]; error?: string } {
  const tokens: JsonLikeToken[] = [];
  let sawNewline = false;
  const push = (kind: JsonLikeTokenKind, text: string) => {
    tokens.push({ kind, text, newlineBefore: sawNewline });
    sawNewline = false;
  };

  for (let index = 0; index < input.length;) {
    const char = input[index];
    const next = input[index + 1];

    if (/\s/.test(char)) {
      if (char === '\n' || char === '\r') sawNewline = true;
      index++;
      continue;
    }

    if (char === '/' && next === '/') {
      const start = index;
      index += 2;
      while (index < input.length && input[index] !== '\n' && input[index] !== '\r') index++;
      push('line-comment', input.slice(start, index));
      continue;
    }

    if (char === '/' && next === '*') {
      const start = index;
      const end = input.indexOf('*/', index + 2);
      if (end === -1) return { tokens, error: 'Unterminated block comment' };
      index = end + 2;
      push('block-comment', input.slice(start, index));
      continue;
    }

    if (char === '"' || char === "'") {
      const start = index;
      const quote = char;
      index++;
      let escaped = false;
      let closed = false;
      while (index < input.length) {
        const current = input[index++];
        if (escaped) {
          escaped = false;
        } else if (current === '\\') {
          escaped = true;
        } else if (current === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) return { tokens, error: 'Unterminated string literal' };
      push('atom', input.slice(start, index));
      continue;
    }

    if (char === '{' && next === '{') {
      const start = index;
      const end = input.indexOf('}}', index + 2);
      if (end === -1) return { tokens, error: 'Unterminated template variable' };
      index = end + 2;
      push('atom', input.slice(start, index));
      continue;
    }

    const punctuation: Record<string, JsonLikeTokenKind> = {
      '{': 'open-object',
      '}': 'close-object',
      '[': 'open-array',
      ']': 'close-array',
      ':': 'colon',
      ',': 'comma',
    };
    const kind = punctuation[char];
    if (kind) {
      push(kind, char);
      index++;
      continue;
    }

    const start = index;
    while (
      index < input.length &&
      !/\s/.test(input[index]) &&
      !'{}[],:'.includes(input[index]) &&
      !(input[index] === '/' && (input[index + 1] === '/' || input[index + 1] === '*'))
    ) {
      index++;
    }
    if (start === index) return { tokens, error: `Unexpected character "${char}"` };
    push('atom', input.slice(start, index));
  }

  return { tokens };
}

function validateJsonLikeTokens(tokens: JsonLikeToken[]): string | undefined {
  let index = 0;
  const skipComments = () => {
    while (tokens[index]?.kind === 'line-comment' || tokens[index]?.kind === 'block-comment') index++;
  };
  const parseValue = (): string | undefined => {
    skipComments();
    const token = tokens[index];
    if (!token) return 'Expected a value';
    if (token.kind === 'atom') {
      index++;
      return undefined;
    }
    if (token.kind === 'open-object') return parseObject();
    if (token.kind === 'open-array') return parseArray();
    return `Expected a value, found "${token.text}"`;
  };
  const parseObject = (): string | undefined => {
    index++;
    skipComments();
    if (tokens[index]?.kind === 'close-object') {
      index++;
      return undefined;
    }
    while (true) {
      skipComments();
      const key = tokens[index];
      if (!key || key.kind !== 'atom') return 'Expected an object property name';
      index++;
      skipComments();
      if (tokens[index]?.kind !== 'colon') return 'Expected ":" after an object property name';
      index++;
      const valueError = parseValue();
      if (valueError) return valueError;
      skipComments();
      const separator = tokens[index];
      if (separator?.kind === 'close-object') {
        index++;
        return undefined;
      }
      if (separator?.kind !== 'comma') return 'Expected "," or "}" after an object property';
      index++;
      skipComments();
      if (tokens[index]?.kind === 'close-object') {
        index++;
        return undefined;
      }
    }
  };
  const parseArray = (): string | undefined => {
    index++;
    skipComments();
    if (tokens[index]?.kind === 'close-array') {
      index++;
      return undefined;
    }
    while (true) {
      const valueError = parseValue();
      if (valueError) return valueError;
      skipComments();
      const separator = tokens[index];
      if (separator?.kind === 'close-array') {
        index++;
        return undefined;
      }
      if (separator?.kind !== 'comma') return 'Expected "," or "]" after an array value';
      index++;
      skipComments();
      if (tokens[index]?.kind === 'close-array') {
        index++;
        return undefined;
      }
    }
  };

  const error = parseValue();
  if (error) return error;
  skipComments();
  return tokens[index] ? `Unexpected token "${tokens[index].text}"` : undefined;
}

function formatJsonLikeTokens(tokens: JsonLikeToken[]): string {
  let output = '';
  let indentation = 0;
  let atLineStart = true;

  const write = (text: string) => {
    if (atLineStart) {
      output += '  '.repeat(indentation);
      atLineStart = false;
    }
    output += text;
  };
  const newline = () => {
    output = output.replace(/[ \t]+$/, '');
    if (!output.endsWith('\n')) output += '\n';
    atLineStart = true;
  };
  const nextToken = (start: number) => tokens.slice(start + 1).find((token) => token.kind !== 'line-comment' && token.kind !== 'block-comment');
  const isSameLineComment = (token?: JsonLikeToken) =>
    !!token && (token.kind === 'line-comment' || token.kind === 'block-comment') && !token.newlineBefore;

  tokens.forEach((token, index) => {
    if (token.kind === 'open-object' || token.kind === 'open-array') {
      write(token.text);
      // A container is empty only when its closing token follows immediately; comments inside
      // count as content so indentation stays balanced with the matching close token.
      const following = tokens[index + 1];
      if (following && following.kind !== (token.kind === 'open-object' ? 'close-object' : 'close-array')) {
        indentation++;
        // Keep a comment written on the same source line as the opening bracket on that line.
        if (!isSameLineComment(following)) newline();
      }
      return;
    }

    if (token.kind === 'close-object' || token.kind === 'close-array') {
      const previous = tokens[index - 1];
      const wasEmpty = previous?.kind === (token.kind === 'close-object' ? 'open-object' : 'open-array');
      if (!wasEmpty) {
        if (!atLineStart) newline();
        indentation = Math.max(0, indentation - 1);
      }
      write(token.text);
      return;
    }

    if (token.kind === 'comma') {
      write(token.text);
      // Keep trailing comments (`"a": 1, // note`) attached to the property they describe.
      if (!isSameLineComment(tokens[index + 1])) newline();
      return;
    }

    if (token.kind === 'colon') {
      write(': ');
      return;
    }

    if (token.kind === 'line-comment') {
      if (token.newlineBefore && !atLineStart) newline();
      if (!atLineStart && !output.endsWith(' ')) write(' ');
      write(token.text);
      newline();
      return;
    }

    if (token.kind === 'block-comment') {
      if (token.newlineBefore && !atLineStart) newline();
      if (!atLineStart && !output.endsWith(' ')) write(' ');
      write(token.text);
      const next = nextToken(index);
      if (next?.kind === 'atom' || next?.kind === 'open-object' || next?.kind === 'open-array') newline();
      return;
    }

    write(token.text);
  });

  return output.trim();
}

/**
 * Beautifies JSON and supported relaxed JSON without reserializing values.
 * Comments, templates, number spelling, strings, and property ordering remain intact.
 */
export function beautifyJson(jsonStr?: string | null): { formatted: string; error?: string } {
  const original = typeof jsonStr === 'string' ? jsonStr : '';
  const trimmed = original.trim();
  if (!trimmed) return { formatted: '' };

  const tokenized = tokenizeJsonLike(trimmed);
  if (tokenized.error) return { formatted: original, error: tokenized.error };

  const validationError = validateJsonLikeTokens(tokenized.tokens);
  if (validationError) return { formatted: original, error: validationError };

  return { formatted: formatJsonLikeTokens(tokenized.tokens) };
}

/**
 * Beautifies and indents GraphQL queries and mutations with 2-space indentation.
 * Validates syntax for balanced braces, brackets, and parentheses.
 */
export function beautifyGraphQL(query?: string | null): { formatted: string; error?: string } {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (!trimmed) return { formatted: '' };

  // 1. Syntax check for balanced braces, parens, brackets
  let braceCount = 0;
  let parenCount = 0;
  let bracketCount = 0;
  let inString = false;
  let inComment = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    const prev = i > 0 ? trimmed[i - 1] : '';

    if (inComment) {
      if (char === '\n') inComment = false;
      continue;
    }
    if (inString) {
      if (char === '"' && prev !== '\\') inString = false;
      continue;
    }

    if (char === '#') {
      inComment = true;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      braceCount++;
    } else if (char === '}') {
      braceCount--;
      if (braceCount < 0) return { formatted: trimmed, error: 'Unexpected closing brace "}"' };
    } else if (char === '(') {
      parenCount++;
    } else if (char === ')') {
      parenCount--;
      if (parenCount < 0) return { formatted: trimmed, error: 'Unexpected closing parenthesis ")"' };
    } else if (char === '[') {
      bracketCount++;
    } else if (char === ']') {
      bracketCount--;
      if (bracketCount < 0) return { formatted: trimmed, error: 'Unexpected closing bracket "]"' };
    }
  }

  if (braceCount !== 0) return { formatted: trimmed, error: 'Unbalanced braces "{" and "}" in GraphQL query' };
  if (parenCount !== 0) return { formatted: trimmed, error: 'Unbalanced parentheses "(" and ")" in GraphQL query' };
  if (bracketCount !== 0) return { formatted: trimmed, error: 'Unbalanced brackets "[" and "]" in GraphQL query' };

  // 2. Format with clean 2-space indentation
  const INDENT = '  ';
  let formatted = '';
  let pad = 0;

  let prepared = '';
  inString = false;
  inComment = false;
  let inParens = 0;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    const prev = i > 0 ? trimmed[i - 1] : '';

    if (inComment) {
      prepared += char;
      if (char === '\n') inComment = false;
      continue;
    }
    if (inString) {
      prepared += char;
      if (char === '"' && prev !== '\\') inString = false;
      continue;
    }

    if (char === '#') {
      inComment = true;
      prepared += char;
    } else if (char === '"') {
      inString = true;
      prepared += char;
    } else if (char === '(') {
      inParens++;
      prepared += char;
    } else if (char === ')') {
      inParens = Math.max(0, inParens - 1);
      prepared += char;
    } else if (char === '{') {
      prepared += ' {\n';
    } else if (char === '}') {
      prepared += '\n}\n';
    } else if (char === '\n') {
      prepared += '\n';
    } else {
      prepared += char;
    }
  }

  // Process line by line
  const lines = prepared.split('\n');
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    // Comments
    if (line.startsWith('#')) {
      formatted += INDENT.repeat(pad) + line + '\n';
      continue;
    }

    // Handle closing braces: decrease pad first
    if (line.startsWith('}')) {
      pad = Math.max(0, pad - 1);
      formatted += INDENT.repeat(pad) + line + '\n';
      continue;
    }

    // Lines ending with {: increase pad after
    if (line.endsWith('{')) {
      formatted += INDENT.repeat(pad) + line + '\n';
      pad++;
      continue;
    }

    // If multiple simple fields are on a single line (e.g. "id name email")
    if (
      !line.includes('{') &&
      !line.includes('}') &&
      !line.includes('(') &&
      !line.includes(':') &&
      !line.includes('@') &&
      line.includes(' ')
    ) {
      const words = line.split(/\s+/).filter(Boolean);
      for (const w of words) {
        formatted += INDENT.repeat(pad) + w + '\n';
      }
      continue;
    }

    // Regular field line
    formatted += INDENT.repeat(pad) + line + '\n';
  }

  return { formatted: formatted.trim() };
}
