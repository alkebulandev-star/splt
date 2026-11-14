import type { LibraryItem } from '../core/library.ts';

/**
 * Keeps the library in this browser (IndexedDB). If storage is unavailable, as in a
 * private window, the library simply lives in memory until the page closes.
 */
const DB = 'split-tracker', STORE = 'library';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadLibrary(): Promise<LibraryItem[]> {
  try { return await run<LibraryItem[]>('readonly', (s) => s.getAll()); } catch { return []; }
}
export async function saveItem(item: LibraryItem): Promise<void> {
  try { await run('readwrite', (s) => s.put(item)); } catch { /* memory only */ }
}
export async function removeItem(id: string): Promise<void> {
  try { await run('readwrite', (s) => s.delete(id)); } catch { /* memory only */ }
}
export async function clearLibrary(): Promise<void> {
  try { await run('readwrite', (s) => s.clear()); } catch { /* memory only */ }
}
