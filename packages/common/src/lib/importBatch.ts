import { Collection, CollectionItem, Environment } from '../types/api';
import { OpenedFileResult } from '../types/platform';
import {
  detectPostmanJsonType,
  importPostmanCollection,
  importPostmanEnvironment,
} from './postman';

export const MAX_IMPORT_FILE_BYTES = 16 * 1024 * 1024; // 16 MiB

export type ImportBatchItemType = 'collection' | 'environment' | 'invalid';

export interface ImportBatchItem {
  id: string;
  filename: string;
  name: string;
  type: ImportBatchItemType;
  checked: boolean;
  disabled: boolean;
  hasConflict: boolean;
  itemCountLabel?: string;
  error?: string;
  parsedCollection?: Collection;
  parsedEnvironment?: Environment;
}

export interface ParseImportBatchContext {
  existingCollections: Collection[];
  existingEnvironments: Environment[];
  canWriteCollection: boolean;
  canWriteEnvironment: boolean;
  existingBatchItems?: ImportBatchItem[];
}

export interface ImportBatchStats {
  collectionsImported: number;
  environmentsImported: number;
  skipped: number;
  failed: Array<{ name: string; error: string }>;
}

export interface ImportBatchSelectionSummary {
  total: number;
  selectable: number;
  selected: number;
  invalid: number;
  conflicts: number;
  selectedConflicts: number;
}

function generateBatchItemId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeImportName(name: string): string {
  return String(name || '').trim().toLowerCase();
}

function countCollectionRequests(items: CollectionItem[]): number {
  let count = 0;
  for (const item of items) {
    if (item.type === 'folder') {
      count += countCollectionRequests(item.items || []);
    } else if (item.type === 'request') {
      count += 1;
    }
  }
  return count;
}

function countEnvironmentVariables(env: Environment): number {
  return (env.variables || []).filter((v) => String(v?.key ?? '').trim() !== '').length;
}

function createInvalidBatchItem(filename: string, error: string): ImportBatchItem {
  return {
    id: generateBatchItemId(),
    filename,
    name: filename,
    type: 'invalid',
    checked: false,
    disabled: true,
    hasConflict: false,
    error,
  };
}

/**
 * Parses one or more opened JSON files into checklist items for preview and selective import.
 */
export function parseImportBatchFiles(
  files: OpenedFileResult[],
  context: ParseImportBatchContext
): ImportBatchItem[] {
  const seenCollectionNames = new Set<string>(
    (context.existingCollections || [])
      .filter((c) => c._syncStatus !== 'pending')
      .map((c) => normalizeImportName(c.name))
      .filter(Boolean)
  );
  const seenEnvironmentNames = new Set<string>(
    (context.existingEnvironments || [])
      .map((e) => normalizeImportName(e.name))
      .filter(Boolean)
  );

  for (const existingItem of context.existingBatchItems || []) {
    if (existingItem.type === 'collection' && existingItem.parsedCollection) {
      const normalized = normalizeImportName(existingItem.parsedCollection.name);
      if (normalized) seenCollectionNames.add(normalized);
    } else if (existingItem.type === 'environment' && existingItem.parsedEnvironment) {
      const normalized = normalizeImportName(existingItem.parsedEnvironment.name);
      if (normalized) seenEnvironmentNames.add(normalized);
    }
  }

  return files.map((file) => {
    const filename = (file.filename || '').trim() || 'import.json';

    if (file.error) {
      return createInvalidBatchItem(filename, file.error);
    }
    if (!file.content || !file.content.trim()) {
      return createInvalidBatchItem(filename, 'File is empty.');
    }
    if (file.content.length > MAX_IMPORT_FILE_BYTES) {
      return createInvalidBatchItem(filename, 'Selected file exceeds maximum allowed limit of 16 MB.');
    }

    try {
      const detected = detectPostmanJsonType(file.content);
      if (detected === 'unknown') {
        return createInvalidBatchItem(
          filename,
          'Unrecognized JSON format. Expected a Postman Collection or Environment.'
        );
      }

      if (detected === 'environment') {
        const parsedEnv = importPostmanEnvironment(file.content);
        const normalized = normalizeImportName(parsedEnv.name);
        const hasConflict = normalized !== '' && seenEnvironmentNames.has(normalized);
        if (normalized) seenEnvironmentNames.add(normalized);

        const varCount = countEnvironmentVariables(parsedEnv);
        const canWrite = context.canWriteEnvironment;

        return {
          id: generateBatchItemId(),
          filename,
          name: parsedEnv.name,
          type: 'environment',
          checked: canWrite,
          disabled: !canWrite,
          hasConflict,
          itemCountLabel: `${varCount} ${varCount === 1 ? 'variable' : 'variables'}`,
          error: canWrite
            ? undefined
            : 'Insufficient permission to import environments into this scope (requires env:write).',
          parsedEnvironment: parsedEnv,
        };
      }

      const parsedCol = importPostmanCollection(file.content);
      const normalized = normalizeImportName(parsedCol.name);
      const hasConflict = normalized !== '' && seenCollectionNames.has(normalized);
      if (normalized) seenCollectionNames.add(normalized);

      const reqCount = countCollectionRequests(parsedCol.items || []);
      const canWrite = context.canWriteCollection;

      return {
        id: generateBatchItemId(),
        filename,
        name: parsedCol.name,
        type: 'collection',
        checked: canWrite,
        disabled: !canWrite,
        hasConflict,
        itemCountLabel: `${reqCount} ${reqCount === 1 ? 'request' : 'requests'}`,
        error: canWrite
          ? undefined
          : 'Insufficient permission to import collections into this scope (requires collection:write).',
        parsedCollection: parsedCol,
      };
    } catch (err: unknown) {
      return createInvalidBatchItem(
        filename,
        err instanceof Error ? err.message : 'Failed to parse Postman file.'
      );
    }
  });
}

export function recomputeBatchConflicts(
  items: ImportBatchItem[],
  existingCollections: Collection[],
  existingEnvironments: Environment[]
): ImportBatchItem[] {
  const seenCollectionNames = new Set<string>(
    (existingCollections || [])
      .filter((c) => c._syncStatus !== 'pending')
      .map((c) => normalizeImportName(c.name))
      .filter(Boolean)
  );
  const seenEnvironmentNames = new Set<string>(
    (existingEnvironments || [])
      .map((e) => normalizeImportName(e.name))
      .filter(Boolean)
  );

  return items.map((item) => {
    if (item.type === 'collection' && item.parsedCollection) {
      const normalized = normalizeImportName(item.parsedCollection.name);
      const hasConflict = normalized !== '' && seenCollectionNames.has(normalized);
      if (normalized && item.checked && !item.disabled) {
        seenCollectionNames.add(normalized);
      }
      return item.hasConflict === hasConflict ? item : { ...item, hasConflict };
    }
    if (item.type === 'environment' && item.parsedEnvironment) {
      const normalized = normalizeImportName(item.parsedEnvironment.name);
      const hasConflict = normalized !== '' && seenEnvironmentNames.has(normalized);
      if (normalized && item.checked && !item.disabled) {
        seenEnvironmentNames.add(normalized);
      }
      return item.hasConflict === hasConflict ? item : { ...item, hasConflict };
    }
    return item;
  });
}

export function toggleImportBatchItem(items: ImportBatchItem[], id: string): ImportBatchItem[] {
  return items.map((item) => {
    if (item.id !== id || item.disabled) return item;
    return { ...item, checked: !item.checked };
  });
}

export function toggleAllImportBatchItems(items: ImportBatchItem[], checked: boolean): ImportBatchItem[] {
  return items.map((item) => {
    if (item.disabled) return item;
    return { ...item, checked };
  });
}

export function getImportBatchSelectionSummary(items: ImportBatchItem[]): ImportBatchSelectionSummary {
  let selectable = 0;
  let selected = 0;
  let invalid = 0;
  let conflicts = 0;
  let selectedConflicts = 0;

  for (const item of items) {
    if (item.type === 'invalid') {
      invalid += 1;
    }
    if (!item.disabled) {
      selectable += 1;
      if (item.hasConflict) conflicts += 1;
      if (item.checked) {
        selected += 1;
        if (item.hasConflict) selectedConflicts += 1;
      }
    }
  }

  return {
    total: items.length,
    selectable,
    selected,
    invalid,
    conflicts,
    selectedConflicts,
  };
}

export function formatBatchImportSummary(stats: ImportBatchStats): string {
  const importedParts: string[] = [];
  if (stats.collectionsImported > 0) {
    importedParts.push(
      `${stats.collectionsImported} ${stats.collectionsImported === 1 ? 'collection' : 'collections'}`
    );
  }
  if (stats.environmentsImported > 0) {
    importedParts.push(
      `${stats.environmentsImported} ${stats.environmentsImported === 1 ? 'environment' : 'environments'}`
    );
  }

  if (importedParts.length === 0 && stats.skipped > 0 && stats.failed.length === 0) {
    return `No items imported (${stats.skipped} skipped).`;
  }

  let message = importedParts.length > 0 ? `Imported ${importedParts.join(' and ')}` : 'Import completed';
  const notes: string[] = [];
  if (stats.skipped > 0) notes.push(`${stats.skipped} skipped`);
  if (stats.failed.length > 0) notes.push(`${stats.failed.length} failed`);
  if (notes.length > 0) {
    message += ` (${notes.join(', ')})`;
  }
  return `${message}.`;
}

/**
 * Strictly checks whether raw clipboard text represents a Postman Collection or Environment JSON,
 * avoiding false positives on generic API JSON payloads during global Ctrl+V / Cmd+V paste.
 */
export function isStrictPostmanImportJson(rawText: string): boolean {
  if (typeof rawText !== 'string') return false;
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false;
    }

    // Strict Postman Environment match
    if (parsed._postman_variable_scope === 'environment') {
      return true;
    }
    const nestedEnv = parsed.environment;
    if (
      nestedEnv &&
      typeof nestedEnv === 'object' &&
      !Array.isArray(nestedEnv) &&
      Array.isArray((nestedEnv as Record<string, unknown>).values)
    ) {
      return true;
    }
    if (
      Array.isArray(parsed.values) &&
      (typeof parsed.name === 'string' || typeof parsed._postman_exported_at === 'string') &&
      parsed.values.every(
        (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v) && 'key' in v)
      )
    ) {
      return true;
    }

    // Strict Postman Collection v2.0 / v2.1 match
    const info = parsed.info;
    if (info && typeof info === 'object' && !Array.isArray(info)) {
      const infoObj = info as Record<string, unknown>;
      if (
        (typeof infoObj.schema === 'string' && infoObj.schema.toLowerCase().includes('collection')) ||
        typeof infoObj._postman_id === 'string' ||
        (typeof infoObj.name === 'string' && Array.isArray(parsed.item))
      ) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Checks whether an event target belongs to an editable input or code editor.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
  };
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  if (el.isContentEditable) {
    return true;
  }
  if (typeof el.closest === 'function') {
    return Boolean(
      el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .cm-editor, .monaco-editor')
    );
  }
  return false;
}

/**
 * Checks whether a File-like object appears to be a JSON file.
 */
export function isJsonCandidateFile(
  file: { name?: string; type?: string } | null | undefined
): boolean {
  if (!file) return false;
  const name = String(file.name || '').trim().toLowerCase();
  const mime = String(file.type || '').trim().toLowerCase().split(';')[0];
  return name.endsWith('.json') || mime === 'application/json' || mime === 'text/json';
}

/**
 * Reads browser File objects into OpenedFileResult[] while enforcing the 16 MiB file limit.
 */
export function readBrowserFiles(
  files: File[],
  options?: { requireJsonExtension?: boolean }
): Promise<OpenedFileResult[]> {
  return Promise.all(
    files.map((file) => {
      const filename = file.name || 'import.json';
      if (options?.requireJsonExtension && !isJsonCandidateFile(file)) {
        return Promise.resolve({
          filename,
          content: '',
          error: 'Unsupported file type. Expected a .json file.',
        });
      }
      if (file.size > MAX_IMPORT_FILE_BYTES) {
        return Promise.resolve({
          filename,
          content: '',
          error: 'Selected file exceeds maximum allowed limit of 16 MB.',
        });
      }
      return new Promise<OpenedFileResult>((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => {
          const content = typeof event.target?.result === 'string' ? event.target.result : '';
          if (content.length > MAX_IMPORT_FILE_BYTES) {
            resolve({
              filename,
              content: '',
              error: 'Selected file exceeds maximum allowed limit of 16 MB.',
            });
            return;
          }
          resolve({ filename, content });
        };
        reader.onerror = () => {
          resolve({
            filename,
            content: '',
            error: 'Failed to read selected file.',
          });
        };
        reader.readAsText(file);
      });
    })
  );
}
