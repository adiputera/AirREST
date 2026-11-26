import type { FunctionalRunReport, PerformanceRunReport } from '../types/api';
import { registerCloudPerfCleanup } from './examples';

const PERF_DB_NAME = 'airrest-perf-runs';
const PERF_STORE_NAME = 'reports';
const FUNCTIONAL_STORE_NAME = 'functional_reports';
const PERF_DB_VERSION = 2;
export const MAX_PERF_REPORTS_PER_SCOPE = 25;

export interface PerfScopeKeyInput {
  workspaceMode: 'offline' | 'cloud';
  activeOfflineWorkspaceId?: string | null;
  cloudUserId?: string | null;
  activeScopeType?: string | null;
  activeScopeId?: string | null;
}

export function buildPerfScopeKey(input: PerfScopeKeyInput): string {
  if (input.workspaceMode === 'cloud' && input.cloudUserId && input.activeScopeId) {
    return `cloud:${input.cloudUserId}:${input.activeScopeType || 'workspace'}:${input.activeScopeId}`;
  }
  return `offline:${input.activeOfflineWorkspaceId || 'default'}`;
}

interface StoredReportRecord<T extends { id: string; startedAt: number }> {
  id: string;
  scopeKey: string;
  startedAt: number;
  report: T;
}

// In-memory fallback for environments without IndexedDB (e.g. Node unit tests)
const memoryFallback = new Map<string, StoredReportRecord<PerformanceRunReport>>();
const functionalMemoryFallback = new Map<string, StoredReportRecord<FunctionalRunReport>>();

let perfDbPromise: Promise<IDBDatabase> | null = null;

function openPerfDb(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === 'undefined') return null;
  if (!perfDbPromise) {
    perfDbPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(PERF_DB_NAME, PERF_DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(PERF_STORE_NAME)) {
            const store = db.createObjectStore(PERF_STORE_NAME, { keyPath: 'id' });
            store.createIndex('scopeKey', 'scopeKey', { unique: false });
          }
          if (!db.objectStoreNames.contains(FUNCTIONAL_STORE_NAME)) {
            const funcStore = db.createObjectStore(FUNCTIONAL_STORE_NAME, { keyPath: 'id' });
            funcStore.createIndex('scopeKey', 'scopeKey', { unique: false });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onclose = () => {
            perfDbPromise = null;
          };
          db.onversionchange = () => {
            db.close();
            perfDbPromise = null;
          };
          resolve(db);
        };
        req.onerror = () => {
          perfDbPromise = null;
          reject(req.error || new Error('Failed to open performance reports database.'));
        };
      } catch (err) {
        perfDbPromise = null;
        reject(err);
      }
    });
  }
  return perfDbPromise;
}

function txPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

export function prunePerfRecordsForScope<T extends { id: string; startedAt: number }>(
  records: StoredReportRecord<T>[],
  maxPerScope = MAX_PERF_REPORTS_PER_SCOPE
): { keep: StoredReportRecord<T>[]; pruneIds: string[] } {
  const sorted = [...records].sort((a, b) => b.startedAt - a.startedAt);
  const keep = sorted.slice(0, maxPerScope);
  const pruneIds = sorted.slice(maxPerScope).map((r) => r.id);
  return { keep, pruneIds };
}

async function saveScopedReport<T extends { id: string; startedAt: number }>(
  storeName: string,
  fallbackMap: Map<string, StoredReportRecord<T>>,
  scopeKey: string,
  report: T
): Promise<void> {
  const dbPromise = openPerfDb();
  const record: StoredReportRecord<T> = {
    id: report.id,
    scopeKey,
    startedAt: report.startedAt,
    report,
  };

  if (!dbPromise) {
    fallbackMap.set(record.id, record);
    const scoped = Array.from(fallbackMap.values()).filter((r) => r.scopeKey === scopeKey);
    const { pruneIds } = prunePerfRecordsForScope(scoped);
    for (const id of pruneIds) fallbackMap.delete(id);
    return;
  }

  const db = await dbPromise;
  if (!db.objectStoreNames.contains(storeName)) return;
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  await txPromise(store.put(record));

  if (typeof store.index === 'function') {
    const idx = store.index('scopeKey');
    if (typeof idx.getAll === 'function') {
      const existing = (await txPromise(idx.getAll(scopeKey))) as StoredReportRecord<T>[];
      const { pruneIds } = prunePerfRecordsForScope(existing);
      for (const oldId of pruneIds) {
        await txPromise(store.delete(oldId));
      }
    }
  }
}

async function listScopedReports<T extends { id: string; startedAt: number }>(
  storeName: string,
  fallbackMap: Map<string, StoredReportRecord<T>>,
  scopeKey: string
): Promise<T[]> {
  const dbPromise = openPerfDb();
  if (!dbPromise) {
    return Array.from(fallbackMap.values())
      .filter((r) => r.scopeKey === scopeKey)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => r.report);
  }

  const db = await dbPromise;
  if (!db.objectStoreNames.contains(storeName)) return [];
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  if (typeof store.index !== 'function') return [];
  const idx = store.index('scopeKey');
  if (typeof idx.getAll !== 'function') return [];
  const rows = (await txPromise(idx.getAll(scopeKey))) as StoredReportRecord<T>[];
  return rows.sort((a, b) => b.startedAt - a.startedAt).map((r) => r.report);
}

async function getScopedReportById<T extends { id: string; startedAt: number }>(
  storeName: string,
  fallbackMap: Map<string, StoredReportRecord<T>>,
  reportId: string
): Promise<T | null> {
  const dbPromise = openPerfDb();
  if (!dbPromise) {
    return fallbackMap.get(reportId)?.report || null;
  }

  const db = await dbPromise;
  if (!db.objectStoreNames.contains(storeName)) return null;
  const tx = db.transaction(storeName, 'readonly');
  const rec = (await txPromise(tx.objectStore(storeName).get(reportId))) as StoredReportRecord<T> | undefined;
  return rec?.report || null;
}

async function deleteScopedReport<T extends { id: string; startedAt: number }>(
  storeName: string,
  fallbackMap: Map<string, StoredReportRecord<T>>,
  reportId: string
): Promise<void> {
  const dbPromise = openPerfDb();
  if (!dbPromise) {
    fallbackMap.delete(reportId);
    return;
  }

  const db = await dbPromise;
  if (!db.objectStoreNames.contains(storeName)) return;
  const tx = db.transaction(storeName, 'readwrite');
  await txPromise(tx.objectStore(storeName).delete(reportId));
}

async function clearCloudRecordsInStore<T extends { id: string; startedAt: number }>(
  storeName: string,
  fallbackMap: Map<string, StoredReportRecord<T>>,
  prefix: string
): Promise<void> {
  const dbPromise = openPerfDb();
  if (!dbPromise) {
    for (const [id, rec] of fallbackMap.entries()) {
      if (rec.scopeKey.startsWith(prefix)) {
        fallbackMap.delete(id);
      }
    }
    return;
  }

  try {
    const db = await dbPromise;
    if (!db.objectStoreNames.contains(storeName)) return;
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    if (typeof store.getAll !== 'function') return;
    const all = (await txPromise(store.getAll())) as StoredReportRecord<T>[];
    for (const rec of all) {
      if (rec.scopeKey.startsWith(prefix)) {
        await txPromise(store.delete(rec.id));
      }
    }
  } catch {
    // Ignore storage cleanup failures in restricted/mocked IndexedDB environments
  }
}

export async function savePerfReport(scopeKey: string, report: PerformanceRunReport): Promise<void> {
  return saveScopedReport(PERF_STORE_NAME, memoryFallback, scopeKey, report);
}

export async function listPerfReports(scopeKey: string): Promise<PerformanceRunReport[]> {
  return listScopedReports(PERF_STORE_NAME, memoryFallback, scopeKey);
}

export async function getPerfReportById(reportId: string): Promise<PerformanceRunReport | null> {
  return getScopedReportById(PERF_STORE_NAME, memoryFallback, reportId);
}

export async function deletePerfReport(reportId: string): Promise<void> {
  return deleteScopedReport(PERF_STORE_NAME, memoryFallback, reportId);
}

export async function saveFunctionalReport(scopeKey: string, report: FunctionalRunReport): Promise<void> {
  const lightweight: FunctionalRunReport = {
    ...report,
    steps: report.steps.map((s) => ({
      ...s,
      hasCapturedExchange: false,
    })),
  };
  return saveScopedReport(FUNCTIONAL_STORE_NAME, functionalMemoryFallback, scopeKey, lightweight);
}

export async function listFunctionalReports(scopeKey: string): Promise<FunctionalRunReport[]> {
  return listScopedReports(FUNCTIONAL_STORE_NAME, functionalMemoryFallback, scopeKey);
}

export async function deleteFunctionalReport(reportId: string): Promise<void> {
  return deleteScopedReport(FUNCTIONAL_STORE_NAME, functionalMemoryFallback, reportId);
}

export async function clearCloudPerfReports(userId?: string | null): Promise<void> {
  const prefix = userId ? `cloud:${userId}:` : 'cloud:';
  await Promise.all([
    clearCloudRecordsInStore(PERF_STORE_NAME, memoryFallback, prefix),
    clearCloudRecordsInStore(FUNCTIONAL_STORE_NAME, functionalMemoryFallback, prefix),
  ]);
}

registerCloudPerfCleanup(clearCloudPerfReports);
