/**
 * The store a test runs on, so the same tests cover both databases.
 *
 *   default            SqliteStore on ':memory:'
 *   STORE=firestore    FirestoreStore on a namespace of its own, envs/test-<random>, in the real
 *                      project. `close()` deletes that namespace; call it when the file has finished,
 *                      whether it passed or not (an `after` hook, or try/finally).
 *
 * `peek` looks at, or edits, what is stored underneath the API, for the few assertions that need to.
 */
import { randomBytes } from 'node:crypto';
import { checkDatabase, openDb, type Db } from '../../server/db.ts';
import type { Store } from '../../server/store.ts';
import { SqliteStore } from '../../server/storeSqlite.ts';

export interface TestStore {
  store: Store;
  kind: 'sqlite' | 'firestore';
  /** The SQLite database underneath; null on Firestore. */
  db: Db | null;
  peek: {
    /** Every stored account, exactly as stored. */
    users(): Promise<unknown[]>;
    /** The stored form of every sign-in token. */
    sessionTokens(): Promise<string[]>;
    /** How many accounts have this email. */
    accountsWithEmail(email: string): Promise<number>;
    /** Rewrites the text of a song's stored history entries of one type, behind the server's back. */
    rewriteHistory(workId: string, type: string, text: string): Promise<void>;
    /** Whether everything stored points at something that exists. */
    sound(): Promise<boolean>;
  };
  /** Releases the store. On Firestore, deletes the test namespace first. */
  close(): Promise<void>;
}

export const onFirestore = (process.env.STORE ?? '').trim().toLowerCase() === 'firestore';

export async function makeStore(): Promise<TestStore> {
  return onFirestore ? firestoreStore() : sqliteStore();
}

function sqliteStore(): TestStore {
  const db = openDb(':memory:');
  return {
    store: new SqliteStore(db), kind: 'sqlite', db,
    peek: {
      users: async () => db.prepare('SELECT * FROM users').all(),
      sessionTokens: async () => (db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[]).map((x) => x.token_hash),
      accountsWithEmail: async (email) => (db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get(email) as { n: number }).n,
      rewriteHistory: async (workId, type, text) => { db.prepare('UPDATE events SET text = ? WHERE work_id = ? AND type = ?').run(text, workId, type); },
      sound: async () => checkDatabase(db).ok,
    },
    close: async () => { db.close(); },
  };
}

async function firestoreStore(): Promise<TestStore> {
  const { FirestoreStore, closeFirestore } = await import('../../server/storeFirestore.ts');
  const store = FirestoreStore.open(process.env, `test-${randomBytes(6).toString('hex')}`);
  const col = async (name: string) => (await store.root.collection(name).get()).docs;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const used = { ...store.stats };
    const deleted = await store.deleteNamespace();
    console.log(`[firestore ${store.root.path}] about ${used.reads} reads, ${used.writes} writes, ${used.deletes} deletes; clean-up read and deleted ${deleted} documents`);
    await closeFirestore();
  };
  // An interrupted run must not leave its namespace behind either.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().finally(() => process.exit(1)); });

  return {
    store, kind: 'firestore', db: null,
    peek: {
      users: async () => (await col('users')).map((d) => d.data()),
      sessionTokens: async () => (await col('sessions')).map((d) => d.id),
      accountsWithEmail: async (email) => (await store.root.collection('users').where('email', '==', email).get()).size,
      rewriteHistory: async (workId, type, text) => {
        for (const page of (await store.root.collection(`works/${workId}/eventPages`).get()).docs)
          await page.ref.update({ events: (page.data().events as { type: string }[]).map((e) => (e.type === type ? { ...e, text } : e)) });
      },
      // The same question SQLite's foreign-key check answers: does anything point at an account or a song that is gone?
      sound: async () => {
        const users = new Set((await col('users')).map((d) => Number(d.id)));
        const works = await col('works'), songs = new Set(works.map((d) => d.id));
        const sources = await col('sources');
        return works.every((w) => users.has(w.data().ownerId) && (w.data().msgUserIds as number[]).every((u) => users.has(u))
            && (w.data().sourceKeys as string[]).every((k) => sources.some((s) => s.id === k)))
          && sources.every((s) => users.has(s.data().userId) && songs.has(s.data().workId))
          && (await col('sessions')).every((s) => users.has(s.data().userId))
          && (await col('pluginKeys')).every((k) => users.has(k.data().userId))
          && (await col('syncHistory')).every((h) => songs.has(h.data().workId));
      },
    },
    close,
  };
}
