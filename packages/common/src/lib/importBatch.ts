import {
  Collection,
  CollectionItem,
  Environment,
  FunctionalRunReport,
  PerformanceRunReport,
} from '../types/api';
import { OpenedFileResult } from '../types/platform';
import {
  detectPostmanJsonType,
  importPostmanCollectionWithSummary,
  importPostmanEnvironment,
} from './postman';
import { AirRESTReportSourceMeta, parseShareableReportJson } from './reportShare';

export const MAX_IMPORT_FILE_BYTES = 16 * 1024 * 1024; // 16 MiB
export const MAX_IMPORT_BATCH_FILES = 50;
export const MAX_IMPORT_BATCH_TOTAL_BYTES = 64 * 1024 * 1024; // 64 MiB

export type ImportBatchItemType =
  | 'collection'
  | 'environment'
  | 'performance_report'
  | 'functional_report'
  | 'invalid';
export type ImportBatchItemOutcome = 'imported' | 'skipped' | 'failed';

export interface ImportTargetBinding {
  workspaceMode: 'offline' | 'cloud';
  offlineWorkspaceId: string;
  scopeType?: 'workspace' | 'project' | 'offline_workspace';
  scopeId?: string;
  sessionGeneration: number;
  cloudUserId?: string;
  cloudApiUrl?: string;
}

export interface ImportTargetStateLike {
  workspaceMode: 'offline' | 'cloud';
  activeOfflineWorkspaceId?: string;
  isSwitchingWorkspace?: boolean;
  getCloudSessionGeneration?: () => number;
  cloudConfig?: {
    apiUrl?: string;
    token?: string;
    user?: { id?: string } | null;
    activeScope?: { id?: string; type?: 'workspace' | 'project' | 'offline_workspace' } | null;
  };
}

export interface ImportBatchItem {
  id: string;
  filename: string;
  name: string;
  type: ImportBatchItemType;
  checked: boolean;
  disabled: boolean;
  hasConflict: boolean;
  itemCountLabel?: string;
  skippedExamplesCount?: number;
  skippedExamplesReasons?: string[];
  error?: string;
  outcome?: ImportBatchItemOutcome;
  retryCollectionId?: string;
  retryEnvironmentId?: string;
  retryTargetKey?: string;
  parsedCollection?: Collection;
  parsedEnvironment?: Environment;
  parsedPerfReport?: PerformanceRunReport;
  parsedFuncReport?: FunctionalRunReport;
  reportSourceMeta?: AirRESTReportSourceMeta;
}

export interface ParseImportBatchContext {
  existingCollections: Collection[];
  existingEnvironments: Environment[];
  canWriteCollection: boolean;
  canWriteEnvironment: boolean;
  existingBatchItems?: ImportBatchItem[];
  targetKey?: string;
}

export interface ImportBatchStats {
  collectionsImported: number;
  environmentsImported: number;
  reportsImported?: number;
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
 * Captures an immutable snapshot of the active workspace/scope and session identity.
 */
export function captureImportTarget(state: ImportTargetStateLike): ImportTargetBinding {
  const sessionGeneration =
    typeof state.getCloudSessionGeneration === 'function' ? state.getCloudSessionGeneration() : 0;
  return {
    workspaceMode: state.workspaceMode === 'cloud' ? 'cloud' : 'offline',
    offlineWorkspaceId: state.activeOfflineWorkspaceId || 'ws-default-local',
    scopeType: state.cloudConfig?.activeScope?.type,
    scopeId: state.cloudConfig?.activeScope?.id,
    sessionGeneration,
    cloudUserId: state.cloudConfig?.user?.id,
    cloudApiUrl: state.cloudConfig?.apiUrl,
  };
}

/**
 * Returns true if the live store state still points to the exact same workspace/scope and session.
 */
export function isImportTargetMatching(
  state: ImportTargetStateLike,
  target: ImportTargetBinding | null | undefined,
  explicitSessionGeneration?: number
): boolean {
  if (!target || state.isSwitchingWorkspace) return false;
  const liveMode = state.workspaceMode === 'cloud' ? 'cloud' : 'offline';
  if (liveMode !== target.workspaceMode) return false;

  const liveSessionGen =
    explicitSessionGeneration !== undefined
      ? explicitSessionGeneration
      : typeof state.getCloudSessionGeneration === 'function'
        ? state.getCloudSessionGeneration()
        : target.sessionGeneration;
  if (liveSessionGen !== target.sessionGeneration) return false;

  if (target.workspaceMode === 'offline') {
    return (state.activeOfflineWorkspaceId || 'ws-default-local') === target.offlineWorkspaceId;
  }

  if (!state.cloudConfig?.token) return false;

  return (
    state.cloudConfig?.activeScope?.type === target.scopeType &&
    state.cloudConfig?.activeScope?.id === target.scopeId &&
    state.cloudConfig?.user?.id === target.cloudUserId &&
    state.cloudConfig?.apiUrl === target.cloudApiUrl
  );
}

/**
 * Returns a deterministic key identifying a captured import target.
 */
export function getImportTargetKey(target: ImportTargetBinding): string {
  if (target.workspaceMode === 'offline') {
    return `offline:${target.offlineWorkspaceId}`;
  }
  return `cloud:${target.sessionGeneration}:${target.cloudApiUrl || ''}:${target.cloudUserId || ''}:${target.scopeType || ''}:${target.scopeId || ''}`;
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
    if (getImportUtf8ByteLength(file.content) > MAX_IMPORT_FILE_BYTES) {
      return createInvalidBatchItem(filename, 'Selected file exceeds maximum allowed limit of 16 MB.');
    }

    try {
      const detected = detectPostmanJsonType(file.content);
      if (detected === 'unknown') {
        const parsedReport = parseShareableReportJson(file.content);
        if (!parsedReport.error && parsedReport.perfReport) {
          const perfReport = parsedReport.perfReport;
          return {
            id: generateBatchItemId(),
            filename,
            name: perfReport.title || 'Performance Report',
            type: 'performance_report',
            checked: true,
            disabled: false,
            hasConflict: false,
            itemCountLabel: `${perfReport.summary.totalRequests} reqs • Performance`,
            parsedPerfReport: perfReport,
            reportSourceMeta: parsedReport.sourceMeta,
          };
        }
        if (!parsedReport.error && parsedReport.funcReport) {
          const funcReport = parsedReport.funcReport;
          return {
            id: generateBatchItemId(),
            filename,
            name: funcReport.title || 'Functional Report',
            type: 'functional_report',
            checked: true,
            disabled: false,
            hasConflict: false,
            itemCountLabel: `${funcReport.totalTests} tests • Functional`,
            parsedFuncReport: funcReport,
            reportSourceMeta: parsedReport.sourceMeta,
          };
        }
        return createInvalidBatchItem(
          filename,
          'Unrecognized JSON format. Expected a Postman Collection, Environment, or AirREST Report.'
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

      const { collection: parsedCol, exampleImportSummary } = importPostmanCollectionWithSummary(file.content);
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
        ...(exampleImportSummary.skipped > 0
          ? {
              skippedExamplesCount: exampleImportSummary.skipped,
              skippedExamplesReasons: exampleImportSummary.skippedReasons,
            }
          : {}),
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
  existingEnvironments: Environment[],
  targetKey?: string,
  permissions?: { canWriteCollection: boolean; canWriteEnvironment: boolean }
): ImportBatchItem[] {
  const seenBatchCollectionNames = new Set<string>();
  const seenBatchEnvironmentNames = new Set<string>();

  return items.map((item) => {
    let updatedItem = item;
    if (
      permissions &&
      (item.type === 'collection' || item.type === 'environment') &&
      item.outcome !== 'imported' &&
      item.outcome !== 'skipped'
    ) {
      const canWrite =
        item.type === 'collection' ? permissions.canWriteCollection : permissions.canWriteEnvironment;
      const disabled = !canWrite;
      const permissionError = disabled
        ? item.type === 'collection'
          ? 'Insufficient permission to import collections into this scope (requires collection:write).'
          : 'Insufficient permission to import environments into this scope (requires env:write).'
        : item.outcome === 'failed'
          ? item.error
          : undefined;
      if (item.disabled !== disabled || item.error !== permissionError) {
        updatedItem = {
          ...item,
          disabled,
          checked: disabled ? false : item.outcome === 'failed' ? true : item.checked,
          error: permissionError,
        };
      }
    }

    if (updatedItem.outcome === 'imported' || updatedItem.outcome === 'skipped') {
      return updatedItem.hasConflict ? { ...updatedItem, hasConflict: false } : updatedItem;
    }

    if (updatedItem.type === 'collection' && updatedItem.parsedCollection) {
      const normalized = normalizeImportName(updatedItem.parsedCollection.name);
      const isExplicitItemRetry = Boolean(
        updatedItem.retryCollectionId &&
          targetKey &&
          updatedItem.retryTargetKey === targetKey &&
          (existingCollections || []).some(
            (c) => c.id === updatedItem.retryCollectionId && c._syncStatus === 'pending'
          )
      );
      const hasWorkspaceConflict =
        normalized !== '' &&
        (existingCollections || []).some(
          (c) =>
            normalizeImportName(c.name) === normalized &&
            !(isExplicitItemRetry && c.id === updatedItem.retryCollectionId)
        );
      const hasConflict =
        normalized !== '' && (hasWorkspaceConflict || seenBatchCollectionNames.has(normalized));
      if (normalized && updatedItem.checked && !updatedItem.disabled) {
        seenBatchCollectionNames.add(normalized);
      }
      return updatedItem.hasConflict === hasConflict ? updatedItem : { ...updatedItem, hasConflict };
    }
    if (updatedItem.type === 'environment' && updatedItem.parsedEnvironment) {
      const normalized = normalizeImportName(updatedItem.parsedEnvironment.name);
      const isExplicitEnvRetry = Boolean(
        updatedItem.retryEnvironmentId &&
          targetKey &&
          updatedItem.retryTargetKey === targetKey &&
          (existingEnvironments || []).some(
            (e) => e.id === updatedItem.retryEnvironmentId && e._syncStatus === 'pending'
          )
      );
      const hasWorkspaceConflict =
        normalized !== '' &&
        (existingEnvironments || []).some(
          (e) =>
            normalizeImportName(e.name) === normalized &&
            !(isExplicitEnvRetry && e.id === updatedItem.retryEnvironmentId)
        );
      const hasConflict =
        normalized !== '' && (hasWorkspaceConflict || seenBatchEnvironmentNames.has(normalized));
      if (normalized && updatedItem.checked && !updatedItem.disabled) {
        seenBatchEnvironmentNames.add(normalized);
      }
      return updatedItem.hasConflict === hasConflict ? updatedItem : { ...updatedItem, hasConflict };
    }
    return updatedItem;
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
  if ((stats.reportsImported ?? 0) > 0) {
    importedParts.push(
      `${stats.reportsImported} ${stats.reportsImported === 1 ? 'report' : 'reports'}`
    );
  }

  if (importedParts.length === 0 && stats.skipped > 0 && stats.failed.length === 0) {
    return `No items imported (${stats.skipped} skipped).`;
  }

  const joinedParts =
    importedParts.length <= 2
      ? importedParts.join(' and ')
      : `${importedParts.slice(0, -1).join(', ')}, and ${importedParts[importedParts.length - 1]}`;
  let message = importedParts.length > 0 ? `Imported ${joinedParts}` : 'Import completed';
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
      parsed.values.length > 0 &&
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
 * Evaluates a window-level OS file drop, always preventing browser/WebView navigation
 * when files are present and returning whether global multi-file import should open.
 */
export function evaluateWindowFileDrop(
  event: {
    defaultPrevented: boolean;
    dataTransfer?: { files?: ArrayLike<File> | FileList | null } | null;
    preventDefault: () => void;
    stopPropagation: () => void;
  },
  context: {
    hasHydrated: boolean;
    isSwitchingWorkspace: boolean;
    hasBlockingModal: boolean;
  }
): { shouldProcess: boolean; files: File[] } {
  const wasAlreadyHandled = event.defaultPrevented;
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length > 0 && !wasAlreadyHandled) {
    // Always prevent browser/WebView navigation when OS files are dropped outside file-accepting inputs
    event.preventDefault();
  }
  if (
    wasAlreadyHandled ||
    !context.hasHydrated ||
    context.isSwitchingWorkspace ||
    context.hasBlockingModal ||
    files.length === 0
  ) {
    return { shouldProcess: false, files: [] };
  }

  const hasJsonFile = files.some(isJsonCandidateFile);
  if (!hasJsonFile) {
    return { shouldProcess: false, files: [] };
  }

  event.stopPropagation();
  return { shouldProcess: true, files };
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
 * Computes UTF-8 byte length reliably across browsers and minimal VM runtimes.
 */
export function getImportUtf8ByteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).byteLength;
  }
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
        continue;
      }
      bytes += 3;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Reads browser File objects into OpenedFileResult[] while enforcing per-file (16 MiB)
 * and aggregate batch (50 files / 64 MiB) limits.
 */
export async function readBrowserFiles(
  files: File[],
  options?: { requireJsonExtension?: boolean }
): Promise<OpenedFileResult[]> {
  if (files.length > MAX_IMPORT_BATCH_FILES) {
    return [
      {
        filename: `Batch (${files.length} files)`,
        content: '',
        error: `Selected batch exceeds maximum allowed limit of ${MAX_IMPORT_BATCH_FILES} files.`,
      },
    ];
  }

  let totalBytes = 0;
  const results: OpenedFileResult[] = [];
  for (const file of files) {
    const filename = file.name || 'import.json';
    if (options?.requireJsonExtension && !isJsonCandidateFile(file)) {
      results.push({
        filename,
        content: '',
        error: 'Unsupported file type. Expected a .json file.',
      });
      continue;
    }
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      results.push({
        filename,
        content: '',
        error: 'Selected file exceeds maximum allowed limit of 16 MB.',
      });
      continue;
    }
    if (totalBytes + file.size > MAX_IMPORT_BATCH_TOTAL_BYTES) {
      results.push({
        filename,
        content: '',
        error: 'Import batch exceeds maximum total size limit of 64 MB.',
      });
      continue;
    }
    const result = await new Promise<OpenedFileResult>((resolve) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = typeof event.target?.result === 'string' ? event.target.result : '';
        const utf8Bytes = getImportUtf8ByteLength(content);
        if (utf8Bytes > MAX_IMPORT_FILE_BYTES) {
          resolve({
            filename,
            content: '',
            error: 'Selected file exceeds maximum allowed limit of 16 MB.',
          });
          return;
        }
        if (totalBytes + utf8Bytes > MAX_IMPORT_BATCH_TOTAL_BYTES) {
          resolve({
            filename,
            content: '',
            error: 'Import batch exceeds maximum total size limit of 64 MB.',
          });
          return;
        }
        totalBytes += utf8Bytes;
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
    results.push(result);
  }
  return results;
}
