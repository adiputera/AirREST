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

/**
 * StateStorage adapter for Zustand Persist backed by IndexedDB with localStorage fallback.
 */
export const appStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const val = await idbGet(name);
      if (val !== null) {
        return val;
      }
    } catch (err) {
      console.warn('[AirREST Storage] IndexedDB read failed:', err);
    }

    try {
      if (typeof localStorage !== 'undefined') {
        return localStorage.getItem(name);
      }
    } catch (err) {
      console.warn('[AirREST Storage] localStorage read failed:', err);
    }

    return null;
  },

  setItem: async (name: string, value: string): Promise<void> => {
    try {
      await idbSet(name, value);
      return;
    } catch (err) {
      console.error('[AirREST Storage] IndexedDB write failed, falling back to localStorage:', err);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(name, value);
      }
    }
  },

  removeItem: async (name: string): Promise<void> => {
    try {
      await idbDel(name);
    } catch (err) {
      console.warn(`[AirREST Storage] IndexedDB delete failed for "${name}":`, err);
    }
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(name);
      }
    } catch {
      // Ignore
    }
  },
};

