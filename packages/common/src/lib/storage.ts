import { StateStorage } from 'zustand/middleware';

const DB_NAME = 'airrest-db';
const STORE_NAME = 'keyval';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;
const STORAGE_ENVELOPE_VERSION = 1;
const writerId = typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID()
  : `writer-${Math.random().toString(36).slice(2)}`;

interface StorageEnvelope {
  version: number;
  timestamp: number;
  revision: number;
  writerId: string;
  deleted?: boolean;
  data?: string;
}

function parseEnvelope(raw: string | null): StorageEnvelope | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StorageEnvelope>;
    if (
      parsed.version === STORAGE_ENVELOPE_VERSION &&
      typeof parsed.revision === 'number' &&
      (typeof parsed.data === 'string' || parsed.deleted === true)
    ) {
      return {
        version: STORAGE_ENVELOPE_VERSION,
        timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : 0,
        revision: parsed.revision,
        writerId: typeof parsed.writerId === 'string' ? parsed.writerId : 'unknown',
        deleted: parsed.deleted === true,
        data: parsed.data,
      };
    }
  } catch {
    // Existing Zustand values are valid legacy data below.
  }
  return { version: 0, timestamp: 0, revision: 0, writerId: 'legacy', data: raw };
}

function latestEnvelope(values: Array<string | null>): StorageEnvelope | null {
  return values.map(parseEnvelope).filter((value): value is StorageEnvelope => value !== null)
    .sort((a, b) => b.revision - a.revision || b.timestamp - a.timestamp)[0] || null;
}

export function selectStoredValue(values: Array<string | null>): string | null {
  const selected = latestEnvelope(values);
  return selected && !selected.deleted ? selected.data || null : null;
}

function getLocalItem(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setLocalItem(key: string, value: string): void {
  if (typeof localStorage === 'undefined') throw new Error('localStorage is not available.');
  localStorage.setItem(key, value);
}

const storageChannel = typeof BroadcastChannel === 'undefined'
  ? null
  : new BroadcastChannel('airrest_storage_sync');

export interface StorageCommitNotice {
  key: string;
  revision: number;
  writerId: string;
  deleted: boolean;
}

export function onStorageCommit(listener: (notice: StorageCommitNotice) => void): () => void {
  if (!storageChannel) return () => {};
  const handler = (event: MessageEvent<StorageCommitNotice>) => {
    if (event.data?.writerId !== writerId && event.data?.key) listener(event.data);
  };
  storageChannel.addEventListener('message', handler);
  return () => storageChannel.removeEventListener('message', handler);
}

async function withStorageLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & {
    locks?: { request: <R>(name: string, callback: () => Promise<R>) => Promise<R> };
  }).locks;
  return locks ? locks.request(`airrest-storage:${key}`, task) : task();
}

function notifyStorageCommit(key: string, envelope: StorageEnvelope) {
  storageChannel?.postMessage({ key, revision: envelope.revision, writerId: envelope.writerId, deleted: envelope.deleted === true });
}

/**
 * Opens or retrieves the cached IndexedDB database connection.
 */
function getDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this environment.'));
  }

  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME);
          }
        };

        request.onsuccess = () => {
          const db = request.result;
          db.onclose = () => {
            dbPromise = null;
          };
          db.onversionchange = () => {
            db.close();
            dbPromise = null;
          };
          resolve(db);
        };

        request.onerror = () => {
          dbPromise = null;
          reject(request.error || new Error('Failed to open IndexedDB.'));
        };
      } catch (err) {
        dbPromise = null;
        reject(err);
      }
    });
  }

  return dbPromise;
}

/**
 * Reads a value by key from IndexedDB.
 */
export async function idbGet(key: string): Promise<string | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => {
        resolve(request.result !== undefined ? (request.result as string) : null);
      };
      request.onerror = () => {
        reject(request.error || new Error(`Failed to read key "${key}" from IndexedDB.`));
      };
      tx.onabort = () => {
        reject(tx.error || new Error('IndexedDB transaction aborted.'));
      };
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Writes a key-value pair to IndexedDB.
 */
export async function idbSet(key: string, value: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(value, key);

      request.onerror = () => {
        reject(request.error || new Error(`Failed to write key "${key}" to IndexedDB.`));
      };
      tx.onabort = () => {
        reject(tx.error || new Error('IndexedDB transaction aborted.'));
      };
      tx.onerror = () => {
        reject(tx.error || new Error('IndexedDB transaction failed.'));
      };
      tx.oncomplete = () => {
        resolve();
      };
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Removes a key from IndexedDB.
 */
export async function idbDel(key: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(key);

      request.onerror = () => {
        reject(request.error || new Error(`Failed to delete key "${key}" from IndexedDB.`));
      };
      tx.onabort = () => {
        reject(tx.error || new Error('IndexedDB transaction aborted.'));
      };
      tx.onerror = () => {
        reject(tx.error || new Error('IndexedDB transaction failed.'));
      };
      tx.oncomplete = () => {
        resolve();
      };
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * StateStorage adapter for Zustand Persist backed by IndexedDB with localStorage fallback.
 */
export const appStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    let indexedValue: string | null = null;
    try {
      indexedValue = await idbGet(name);
    } catch (err) {
      console.warn('[AirREST Storage] IndexedDB read failed:', err);
    }
    return selectStoredValue([indexedValue, getLocalItem(name)]);
  },

  setItem: async (name: string, value: string): Promise<void> => {
    await withStorageLock(name, async () => {
    let existingIdb: string | null = null;
    try {
      existingIdb = await idbGet(name);
    } catch {
      // A fallback-only commit can still advance the revision from localStorage.
    }
    const previous = latestEnvelope([existingIdb, getLocalItem(name)]);
    const envelope: StorageEnvelope = {
      version: STORAGE_ENVELOPE_VERSION,
      timestamp: Date.now(),
      revision: (previous?.revision || 0) + 1,
      writerId,
      data: value,
    };
    const serialized = JSON.stringify(envelope);
    let committed = false;
    try {
      await idbSet(name, serialized);
      committed = true;
    } catch (err) {
      console.warn('[AirREST Storage] IndexedDB write failed:', err);
    }
    try {
      setLocalItem(name, serialized);
      committed = true;
    } catch (err) {
      console.warn('[AirREST Storage] localStorage write failed:', err);
    }
    if (!committed) {
      throw new Error('No persistent storage backend accepted this update.');
    }
    notifyStorageCommit(name, envelope);
    });
  },

  removeItem: async (name: string): Promise<void> => {
    await withStorageLock(name, async () => {
    const previous = latestEnvelope([await idbGet(name).catch(() => null), getLocalItem(name)]);
    const envelope: StorageEnvelope = {
      version: STORAGE_ENVELOPE_VERSION,
      timestamp: Date.now(),
      revision: (previous?.revision || 0) + 1,
      writerId,
      deleted: true,
    };
    const serialized = JSON.stringify(envelope);
    let committed = false;
    try {
      await idbSet(name, serialized);
      committed = true;
    } catch (err) {
      console.warn(`[AirREST Storage] IndexedDB tombstone failed for "${name}":`, err);
    }
    try {
      setLocalItem(name, serialized);
      committed = true;
    } catch (err) {
      console.warn(`[AirREST Storage] localStorage tombstone failed for "${name}":`, err);
    }
    if (!committed) {
      throw new Error('No persistent storage backend accepted the deletion.');
    }
    notifyStorageCommit(name, envelope);
    });
  },
};
