/**
 * Chooses the database the server runs on.
 *
 *   STORE=firestore   Google Firestore (storeFirestore.ts). Credentials: FIREBASE_SERVICE_ACCOUNT (the
 *                     service-account JSON), else FIREBASE_KEY_FILE (a path), else
 *                     ~/.config/split-tracker/firebase-key.json. SPLIT_TRACKER_NAMESPACE (default
 *                     "prod") names the environment; everything is kept under envs/<namespace>.
 *   anything else     SQLite (storeSqlite.ts), the file at SPLIT_TRACKER_DB, as before.
 *
 * Each database's library is loaded only when that database is chosen.
 */
import { dirname, join } from 'node:path';
import type { Db } from './db.ts';
import type { Store } from './store.ts';

export type OpenedStore =
  | { kind: 'sqlite'; store: Store; describe: string; db: Db; dbPath: string; backups: string }
  | { kind: 'firestore'; store: Store; describe: string };

export async function openStore(env: NodeJS.ProcessEnv = process.env): Promise<OpenedStore> {
  if ((env.STORE ?? '').trim().toLowerCase() === 'firestore') {
    const { FirestoreStore } = await import('./storeFirestore.ts');
    const store = FirestoreStore.open(env);
    return { kind: 'firestore', store, describe: `Firestore, ${store.root.path}` };
  }
  const { openDb } = await import('./db.ts');
  const { SqliteStore } = await import('./storeSqlite.ts');
  const dbPath = env.SPLIT_TRACKER_DB ?? join(import.meta.dirname, '..', 'data', 'split-tracker.db');
  const db = openDb(dbPath);
  return { kind: 'sqlite', store: new SqliteStore(db), describe: dbPath, db, dbPath, backups: env.SPLIT_TRACKER_BACKUPS ?? join(dirname(dbPath), 'backups') };
}
