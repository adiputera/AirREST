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

/**
 * Safely strips single-line (//) and multi-line (/* *\/) comments from a JSON-like string
 * without corrupting URLs or comment-like sequences inside quotes.
 */
export function stripJsonComments(input: string): string {
  let output = '';
  let inString = false;
  let quoteChar = '';
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];
    const prev = i > 0 ? input[i - 1] : '';

    if (inLineComment) {
      if (char === '\n' || char === '\r') {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (char === quoteChar && prev !== '\\') {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quoteChar = char;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    output += char;
  }

  return output;
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
  clean = clean.replace(/([\[,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'(?=\s*[,\]])/g, (_m, prefix, inner) => {
    return `${prefix}"${inner.replace(/(?<!\\)"/g, '\\"')}"`;
  });

  // 4. Python booleans and None (in key-values and arrays)
  clean = clean.replace(/:\s*True\b/g, ': true').replace(/:\s*False\b/g, ': false').replace(/:\s*None\b/g, ': null');
  clean = clean.replace(/([\[,]\s*)True\b/g, '$1true').replace(/([\[,]\s*)False\b/g, '$1false').replace(/([\[,]\s*)None\b/g, '$1null');

  // 5. Wrap unquoted AirREST template variables {{var}}
  clean = clean.replace(/:\s*(\{\{[^{}]+\}\})/g, ': "__AIRREST_TMPL_$1__"');
  clean = clean.replace(/([[,]\s*)(\{\{[^{}]+\}\})/g, '$1"__AIRREST_TMPL_$2__"');

  // 6. Remove trailing commas before } or ]
  while (/,(\s*[}\]])/.test(clean)) {
    clean = clean.replace(/,(\s*[}\]])/g, '$1');
  }

  // 7. Insert missing comma between lines ending with value and next property
  clean = clean.replace(/(["\d\w}\]])(\s*\n\s*"[^"]+"\s*:)/g, '$1,$2');

  return clean;
}

/**
 * Beautifies and indents JSON strings with 2-space indentation.
 * Automatically recovers from common relaxed syntax issues (single quotes,
 * unquoted keys, trailing commas, comments, Python booleans).
 */
export function beautifyJson(jsonStr?: string | null): { formatted: string; error?: string } {
  const trimmed = typeof jsonStr === 'string' ? jsonStr.trim() : '';
  if (!trimmed) return { formatted: '' };

  try {
    const parsed = JSON.parse(trimmed);
    return { formatted: JSON.stringify(parsed, null, 2) };
  } catch (err: unknown) {
    try {
      const sanitized = sanitizeRelaxedJson(trimmed);
      const parsed = JSON.parse(sanitized);
      return { formatted: JSON.stringify(parsed, null, 2) };
    } catch {
      return {
        formatted: trimmed,
        error: err instanceof Error ? err.message : 'Invalid JSON format',
      };
    }
  }
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
