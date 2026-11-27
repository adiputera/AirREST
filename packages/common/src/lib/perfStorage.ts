import type { FunctionalRunReport, PerformanceRunReport } from '../types/api';
import { registerCloudPerfCleanup } from './examples';

const PERF_DB_NAME = 'airrest-perf-runs';
const LEGACY_PERF_STORE_NAME = 'reports';
const LEGACY_FUNCTIONAL_STORE_NAME = 'functional_reports';
const PERF_STORE_NAME = 'reports_scoped';
const FUNCTIONAL_STORE_NAME = 'functional_reports_scoped';
const PERF_DB_VERSION = 3;
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

export function makeScopedStorageKey(scopeKey: string, reportId: string): string {
  return `${scopeKey}::${reportId}`;
}

interface StoredReportRecord<T extends { id: string; startedAt: number }> {
  storageKey: string;
  id: string;
  scopeKey: string;
  startedAt: number;
  report: T;
}

interface LegacyStoredReportRecord<T extends { id: string; startedAt: number }> {
  id: string;
  scopeKey: string;
  startedAt: number;
  report: T;
}

// In-memory fallback for environments without IndexedDB (e.g. Node unit tests), keyed by storageKey
const memoryFallback = new Map<string, StoredReportRecord<PerformanceRunReport>>();
const functionalMemoryFallback = new Map<string, StoredReportRecord<FunctionalRunReport>>();

let perfDbPromise: Promise<IDBDatabase> | null = null;

function ensureScopedStore(db: IDBDatabase, storeName: string): IDBObjectStore {
  if (db.objectStoreNames.contains(storeName)) {
    throw new Error(`Store ${storeName} already exists`);
  }
  const store = db.createObjectStore(storeName, { keyPath: 'storageKey' });
  store.createIndex('scopeKey', 'scopeKey', { unique: false });
  store.createIndex('id', 'id', { unique: false });
  return store;
}

function migrateLegacyStore(
  db: IDBDatabase,
  tx: IDBTransaction | null,
  legacyName: string,
  targetStore: IDBObjectStore
): void {
  if (!tx || !db.objectStoreNames.contains(legacyName)) return;
  try {
    const legacyStore = tx.objectStore(legacyName);
    const getAllReq = legacyStore.getAll();
    getAllReq.onsuccess = () => {
      const rows = (getAllReq.result || []) as LegacyStoredReportRecord<{ id: string; startedAt: number }>[];
      for (const row of rows) {
        if (!row?.id || !row?.scopeKey) continue;
        targetStore.put({
          storageKey: makeScopedStorageKey(row.scopeKey, row.id),
          id: row.id,
          scopeKey: row.scopeKey,
          startedAt: row.startedAt,
          report: row.report,
        });
      }
      try {
        db.deleteObjectStore(legacyName);
      } catch {
        // Ignore if deletion is deferred
      }
    };
  } catch {
    // Ignore migration errors in mocked/restricted IndexedDB environments
  }
}

function openPerfDb(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === 'undefined') return null;
  if (!perfDbPromise) {
    perfDbPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(PERF_DB_NAME, PERF_DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          const upgradeTx = req.transaction;
          if (!db.objectStoreNames.contains(PERF_STORE_NAME)) {
            const perfStore = ensureScopedStore(db, PERF_STORE_NAME);
            migrateLegacyStore(db, upgradeTx, LEGACY_PERF_STORE_NAME, perfStore);
          }
          if (!db.objectStoreNames.contains(FUNCTIONAL_STORE_NAME)) {
            const funcStore = ensureScopedStore(db, FUNCTIONAL_STORE_NAME);
            migrateLegacyStore(db, upgradeTx, LEGACY_FUNCTIONAL_STORE_NAME, funcStore);
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
): { keep: StoredReportRecord<T>[]; pruneIds: string[]; pruneStorageKeys: string[] } {
  const sorted = [...records].sort((a, b) => b.startedAt - a.startedAt);
  const keep = sorted.slice(0, maxPerScope);
  const pruned = sorted.slice(maxPerScope);
  const pruneIds = pruned.map((r) => r.id);
  const pruneStorageKeys = pruned.map((r) => r.storageKey || makeScopedStorageKey(r.scopeKey, r.id));
  return { keep, pruneIds, pruneStorageKeys };
}

async function saveScopedReport<T extends { id: string; startedAt: number }>(
  storeName: string,
  fallbackMap: Map<string, StoredReportRecord<T>>,
  scopeKey: string,
  report: T
): Promise<void> {
  const dbPromise = openPerfDb();
  const storageKey = makeScopedStorageKey(scopeKey, report.id);
  const record: StoredReportRecord<T> = {
    storageKey,
    id: report.id,
    scopeKey,
    startedAt: report.startedAt,
    report,
  };

  if (!dbPromise) {
    fallbackMap.set(storageKey, record);
    const scoped = Array.from(fallbackMap.values()).filter((r) => r.scopeKey === scopeKey);
    const { pruneStorageKeys } = prunePerfRecordsForScope(scoped);
    for (const key of pruneStorageKeys) fallbackMap.delete(key);
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
      const { pruneStorageKeys } = prunePerfRecordsForScope(existing);
      for (const oldKey of pruneStorageKeys) {
        await txPromise(store.delete(oldKey));
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
  reportId: string,
  scopeKey?: string
): Promise<T | null> {
  const dbPromise = openPerfDb();
  if (!dbPromise) {
    if (scopeKey) {
      return fallbackMap.get(makeScopedStorageKey(scopeKey, reportId))?.report || null;
    }
    for (const rec of fallbackMap.values()) {
      if (rec.id === reportId) return rec.report;
    }
    return null;
  }

  const db = await dbPromise;
  if (!db.objectStoreNames.contains(storeName)) return null;
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  if (scopeKey) {
    const rec = (await txPromise(store.get(makeScopedStorageKey(scopeKey, reportId)))) as
      | StoredReportRecord<T>
      | undefined;
    return rec?.report || null;
  }
  if (typeof store.index === 'function') {
    const idx = store.index('id');
    const rec = (await txPromise(idx.get(reportId))) as StoredReportRecord<T> | undefined;
    return rec?.report || null;
  }
  return null;
}

async function deleteScopedReport<T extends { id: string; startedAt: number }>(
  storeName: string,
  fallbackMap: Map<string, StoredReportRecord<T>>,
  reportId: string,
  scopeKey?: string
): Promise<void> {
  const dbPromise = openPerfDb();
  if (!dbPromise) {
    if (scopeKey) {
      fallbackMap.delete(makeScopedStorageKey(scopeKey, reportId));
      return;
    }
    for (const [key, rec] of fallbackMap.entries()) {
      if (rec.id === reportId) fallbackMap.delete(key);
    }
    return;
  }

  const db = await dbPromise;
  if (!db.objectStoreNames.contains(storeName)) return;
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  if (scopeKey) {
    await txPromise(store.delete(makeScopedStorageKey(scopeKey, reportId)));
    return;
  }
  if (typeof store.index === 'function') {
    const idx = store.index('id');
    if (typeof idx.getAll === 'function') {
      const matches = (await txPromise(idx.getAll(reportId))) as StoredReportRecord<T>[];
      for (const m of matches) {
        await txPromise(store.delete(m.storageKey));
      }
    }
  }
}

async function clearCloudRecordsInStore<T extends { id: string; startedAt: number }>(
  storeName: string,
  fallbackMap: Map<string, StoredReportRecord<T>>,
  prefix: string
): Promise<void> {
  const dbPromise = openPerfDb();
  if (!dbPromise) {
    for (const [key, rec] of fallbackMap.entries()) {
      if (rec.scopeKey.startsWith(prefix)) {
        fallbackMap.delete(key);
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
        await txPromise(store.delete(rec.storageKey));
      }
    }
  } catch {
    // Ignore storage cleanup failures in restricted/mocked IndexedDB environments
  }
}

async function hasReportInScopedStore<T extends { id: string; startedAt: number }>(
  storeName: string,
  fallbackMap: Map<string, StoredReportRecord<T>>,
  scopeKey: string,
  reportId: string
): Promise<boolean> {
  const storageKey = makeScopedStorageKey(scopeKey, reportId);
  const dbPromise = openPerfDb();
  if (!dbPromise) {
    return fallbackMap.has(storageKey);
  }

  const db = await dbPromise;
  if (!db.objectStoreNames.contains(storeName)) return false;
  const tx = db.transaction(storeName, 'readonly');
  const rec = (await txPromise(tx.objectStore(storeName).get(storageKey))) as
    | StoredReportRecord<T>
    | undefined;
  return Boolean(rec);
}

export async function savePerfReport(scopeKey: string, report: PerformanceRunReport): Promise<void> {
  return saveScopedReport(PERF_STORE_NAME, memoryFallback, scopeKey, report);
}

export async function listPerfReports(scopeKey: string): Promise<PerformanceRunReport[]> {
  return listScopedReports(PERF_STORE_NAME, memoryFallback, scopeKey);
}

export async function getPerfReportById(
  reportId: string,
  scopeKey?: string
): Promise<PerformanceRunReport | null> {
  return getScopedReportById(PERF_STORE_NAME, memoryFallback, reportId, scopeKey);
}

export async function hasPerfReportInScope(scopeKey: string, reportId: string): Promise<boolean> {
  return hasReportInScopedStore(PERF_STORE_NAME, memoryFallback, scopeKey, reportId);
}

export async function deletePerfReport(reportId: string, scopeKey?: string): Promise<void> {
  return deleteScopedReport(PERF_STORE_NAME, memoryFallback, reportId, scopeKey);
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

export async function getFunctionalReportById(
  reportId: string,
  scopeKey?: string
): Promise<FunctionalRunReport | null> {
  return getScopedReportById(FUNCTIONAL_STORE_NAME, functionalMemoryFallback, reportId, scopeKey);
}

export async function hasFunctionalReportInScope(scopeKey: string, reportId: string): Promise<boolean> {
  return hasReportInScopedStore(FUNCTIONAL_STORE_NAME, functionalMemoryFallback, scopeKey, reportId);
}

export async function deleteFunctionalReport(reportId: string, scopeKey?: string): Promise<void> {
  return deleteScopedReport(FUNCTIONAL_STORE_NAME, functionalMemoryFallback, reportId, scopeKey);
}

export async function clearCloudPerfReports(userId?: string | null): Promise<void> {
  const prefix = userId ? `cloud:${userId}:` : 'cloud:';
  await Promise.all([
    clearCloudRecordsInStore(PERF_STORE_NAME, memoryFallback, prefix),
    clearCloudRecordsInStore(FUNCTIONAL_STORE_NAME, functionalMemoryFallback, prefix),
  ]);
}

registerCloudPerfCleanup(clearCloudPerfReports);
