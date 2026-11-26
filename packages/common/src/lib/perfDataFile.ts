import type {
  PerformanceDataFileFormat,
  PerformanceDataFileMeta,
  PerformanceDataFileReadMode,
} from '../types/api';
import { registerPerfDataRowsCleanup } from './examples';

export interface PerformanceDataFileLimits {
  maxRows: number;
  maxBytes: number;
}

const PREVIEW_ROW_COUNT = 5;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * In-memory per-tab data rows store so uploaded datasets never bloat localStorage or cloud sync.
 */
const tabDataRowsStore = new Map<string, Array<Record<string, string>>>();

export function setPerformanceTabDataRows(tabId: string, rows: Array<Record<string, string>>): void {
  if (!tabId) return;
  tabDataRowsStore.set(tabId, rows);
}

export function getPerformanceTabDataRows(tabId: string): Array<Record<string, string>> | undefined {
  return tabDataRowsStore.get(tabId);
}

export function clearPerformanceTabDataRows(tabId: string): void {
  if (!tabId) return;
  tabDataRowsStore.delete(tabId);
}

export function clearAllPerformanceDataRows(): void {
  tabDataRowsStore.clear();
}

registerPerfDataRowsCleanup((tabId) => {
  if (tabId) {
    tabDataRowsStore.delete(tabId);
  } else {
    tabDataRowsStore.clear();
  }
});

export function getDataFileLimits(platformId: 'desktop' | 'extension' | 'android' | 'web'): PerformanceDataFileLimits {
  if (platformId === 'desktop') {
    return { maxRows: 50_000, maxBytes: 10 * 1024 * 1024 };
  }
  return { maxRows: 10_000, maxBytes: 2 * 1024 * 1024 };
}

function getUtf8Bytes(str: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).byteLength;
  }
  return str.length;
}

function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function normalizeCellValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

/**
 * Parses RFC 4180 CSV content (handling BOM, CRLF/LF, quoted commas/newlines, and doubled quotes).
 */
export function parseCsvDataFile(
  rawContent: string,
  maxRows: number
): { columns: string[]; rows: Array<Record<string, string>> } {
  const text = stripBom(rawContent);
  if (!text.trim()) {
    throw new Error('CSV data file is empty.');
  }

  const parsedRows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          currentCell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      currentRow.push(currentCell);
      currentCell = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      currentRow.push(currentCell);
      currentCell = '';
      if (currentRow.some((cell) => cell.trim() !== '')) {
        parsedRows.push(currentRow);
      }
      currentRow = [];
    } else if (ch === '\n') {
      currentRow.push(currentCell);
      currentCell = '';
      if (currentRow.some((cell) => cell.trim() !== '')) {
        parsedRows.push(currentRow);
      }
      currentRow = [];
    } else {
      currentCell += ch;
    }

    if (parsedRows.length > maxRows + 1) {
      throw new Error(`CSV data file exceeds the maximum limit of ${maxRows.toLocaleString()} rows.`);
    }
  }

  if (inQuotes) {
    throw new Error('CSV data file contains an unclosed quoted field.');
  }

  currentRow.push(currentCell);
  if (currentRow.some((cell) => cell.trim() !== '')) {
    parsedRows.push(currentRow);
  }

  if (parsedRows.length < 2) {
    throw new Error('CSV data file must contain a header row and at least one data row.');
  }

  const rawHeaders = parsedRows[0].map((h, idx) => {
    const trimmed = h.trim();
    return trimmed || `column_${idx + 1}`;
  });

  const seenCols = new Set<string>();
  const columns: string[] = [];
  for (const h of rawHeaders) {
    if (FORBIDDEN_KEYS.has(h)) {
      throw new Error(`CSV header "${h}" is not allowed as a variable name.`);
    }
    if (!seenCols.has(h)) {
      seenCols.add(h);
      columns.push(h);
    }
  }

  const dataRows = parsedRows.slice(1);
  if (dataRows.length > maxRows) {
    throw new Error(
      `CSV data file has ${dataRows.length.toLocaleString()} rows, exceeding the ${maxRows.toLocaleString()} row limit.`
    );
  }

  const rows: Array<Record<string, string>> = dataRows.map((cells) => {
    const obj: Record<string, string> = {};
    for (let c = 0; c < rawHeaders.length; c++) {
      const col = rawHeaders[c];
      if (!FORBIDDEN_KEYS.has(col)) {
        obj[col] = cells[c] !== undefined ? cells[c] : '';
      }
    }
    return obj;
  });

  return { columns, rows };
}

/**
 * Parses a JSON array of objects into normalized string rows for template & pm.iterationData substitution.
 */
export function parseJsonDataFile(
  rawContent: string,
  maxRows: number
): { columns: string[]; rows: Array<Record<string, string>> } {
  const text = stripBom(rawContent).trim();
  if (!text) {
    throw new Error('JSON data file is empty.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON data file: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('JSON data file must be a top-level array of objects.');
  }
  if (parsed.length === 0) {
    throw new Error('JSON data file must contain at least one row object.');
  }
  if (parsed.length > maxRows) {
    throw new Error(
      `JSON data file has ${parsed.length.toLocaleString()} rows, exceeding the ${maxRows.toLocaleString()} row limit.`
    );
  }

  const colSet = new Set<string>();
  const rows: Array<Record<string, string>> = [];

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Row ${i + 1} in JSON data file must be an object.`);
    }
    const rowObj: Record<string, string> = {};
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      const trimmed = k.trim();
      if (!trimmed || FORBIDDEN_KEYS.has(trimmed)) continue;
      colSet.add(trimmed);
      rowObj[trimmed] = normalizeCellValue(v);
    }
    rows.push(rowObj);
  }

  const columns = Array.from(colSet);
  for (const row of rows) {
    for (const col of columns) {
      if (!(col in row)) row[col] = '';
    }
  }

  return { columns, rows };
}

export function detectDataFileFormat(filename: string, rawContent: string): PerformanceDataFileFormat {
  const lower = filename.trim().toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.csv')) return 'csv';
  const trimmed = stripBom(rawContent).trimStart();
  if (trimmed.startsWith('[')) return 'json';
  return 'csv';
}

export function parsePerformanceDataFile(
  filename: string,
  content: string,
  platformId: 'desktop' | 'extension' | 'android' | 'web',
  readMode: PerformanceDataFileReadMode = 'sequential'
): { meta: PerformanceDataFileMeta; rows: Array<Record<string, string>> } {
  const limits = getDataFileLimits(platformId);
  const fileBytes = getUtf8Bytes(content);
  if (fileBytes > limits.maxBytes) {
    const maxMb = Math.round(limits.maxBytes / (1024 * 1024));
    throw new Error(
      `Data file "${filename}" is ${(fileBytes / (1024 * 1024)).toFixed(2)} MB, exceeding the ${maxMb} MB limit for ${platformId}.`
    );
  }

  const format = detectDataFileFormat(filename, content);
  const parsed =
    format === 'json'
      ? parseJsonDataFile(content, limits.maxRows)
      : parseCsvDataFile(content, limits.maxRows);

  return {
    meta: {
      filename,
      format,
      fileBytes,
      rowCount: parsed.rows.length,
      columns: parsed.columns,
      previewRows: parsed.rows.slice(0, PREVIEW_ROW_COUNT),
      readMode,
    },
    rows: parsed.rows,
  };
}

/**
 * Deterministic iteration row selection matching the Rust Native Engine 1:1.
 * For `per_vu`:
 * - When `rowCount >= peakVus`, VU `vuIndex` gets the disjoint slice
 *   `[floor(vuIndex * N / P), floor((vuIndex + 1) * N / P))` and wraps within it.
 * - When `rowCount < peakVus`, VU `vuIndex` maps deterministically to `vuIndex % rowCount`.
 */
export function selectDataRowIndex(
  readMode: PerformanceDataFileReadMode,
  rowCount: number,
  vuIndex: number,
  peakVus: number,
  vuIteration: number,
  sequentialCounter: number,
  randomFn: () => number = Math.random
): number {
  if (rowCount <= 0) return 0;

  if (readMode === 'random') {
    const idx = Math.floor(randomFn() * rowCount);
    return Math.max(0, Math.min(rowCount - 1, idx));
  }

  if (readMode === 'per_vu') {
    const safePeak = Math.max(1, Math.floor(peakVus));
    const safeVu = ((Math.floor(vuIndex) % safePeak) + safePeak) % safePeak;
    if (rowCount >= safePeak) {
      const start = Math.floor((safeVu * rowCount) / safePeak);
      const end = Math.floor(((safeVu + 1) * rowCount) / safePeak);
      const span = Math.max(1, end - start);
      const offset = ((Math.floor(vuIteration) % span) + span) % span;
      return start + offset;
    }
    return safeVu % rowCount;
  }

  // sequential (round-robin)
  return ((Math.floor(sequentialCounter) % rowCount) + rowCount) % rowCount;
}
