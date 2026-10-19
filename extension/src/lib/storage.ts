import { StateStorage } from 'zustand/middleware';

const DB_NAME = 'airrest-db';
const STORE_NAME = 'keyval';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

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

      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(request.error || new Error(`Failed to write key "${key}" to IndexedDB.`));
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
 * Removes a key from IndexedDB.
 */
export async function idbDel(key: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(key);

      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(request.error || new Error(`Failed to delete key "${key}" from IndexedDB.`));
      };
      tx.onabort = () => {
        reject(tx.error || new Error('IndexedDB transaction aborted.'));
      };
    } catch (err) {
      reject(err);
    }
  });
}

const LEGACY_STORAGE_KEYS = ['api-tester-storage-v2', 'api-tester-storage'];

/**
 * StateStorage adapter for Zustand Persist backed by IndexedDB.
 * Seamlessly migrates existing legacy data from localStorage and legacy keys to the new storage key.
 */
export const appStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    // 1. Try reading the active key from IndexedDB
    try {
      const val = await idbGet(name);
      if (val !== null) {
        return val;
      }
    } catch (err) {
      console.warn('[AirREST Storage] IndexedDB read failed, checking legacy fallbacks:', err);
    }

    // 2. Check IndexedDB for legacy keys (e.g. 'api-tester-storage-v2')
    const keysToCheck = [name, ...LEGACY_STORAGE_KEYS.filter((k) => k !== name)];

    for (const key of keysToCheck) {
      if (key === name) continue;
      try {
        const legacyVal = await idbGet(key);
        if (legacyVal !== null) {
          try {
            await idbSet(name, legacyVal);
            await idbDel(key);
            console.info(`[AirREST Storage] Migrated IndexedDB key "${key}" to "${name}".`);
          } catch (migrateErr) {
            console.warn(`[AirREST Storage] Failed to migrate IndexedDB key "${key}":`, migrateErr);
          }
          return legacyVal;
        }
      } catch {
        // continue checking
      }
    }

    // 3. Check localStorage for active or legacy keys to automatically migrate
    try {
      if (typeof localStorage !== 'undefined') {
        for (const key of keysToCheck) {
          const localVal = localStorage.getItem(key);
          if (localVal !== null) {
            try {
              await idbSet(name, localVal);
              localStorage.removeItem(key);
              console.info(`[AirREST Storage] Migrated localStorage "${key}" to IndexedDB "${name}".`);
            } catch (migrateErr) {
              console.warn(`[AirREST Storage] Failed to migrate localStorage "${key}":`, migrateErr);
            }
            return localVal;
          }
        }
      }
    } catch (err) {
      console.warn('[AirREST Storage] localStorage read failed:', err);
    }

    return null;
  },

  setItem: async (name: string, value: string): Promise<void> => {
    try {
      await idbSet(name, value);

      // Clean up legacy keys from localStorage and IndexedDB if still present
      const keysToClean = [name, ...LEGACY_STORAGE_KEYS.filter((k) => k !== name)];
      for (const key of keysToClean) {
        if (key !== name) {
          try {
            await idbDel(key);
          } catch {
            // Ignore
          }
        }
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(key);
          }
        } catch {
          // Ignore
        }
      }
      return;
    } catch (err) {
      console.error('[AirREST Storage] IndexedDB write failed, falling back to localStorage:', err);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(name, value);
      }
    }
  },

  removeItem: async (name: string): Promise<void> => {
    const keysToClean = [name, ...LEGACY_STORAGE_KEYS.filter((k) => k !== name)];
    for (const key of keysToClean) {
      try {
        await idbDel(key);
      } catch (err) {
        console.warn(`[AirREST Storage] IndexedDB delete failed for "${key}":`, err);
      }
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(key);
        }
      } catch {
        // Ignore
      }
    }
  },
};
