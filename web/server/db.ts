/**
 * The database: one SQLite file, opened with better-sqlite3 (a long-established library; the
 * engine built into Node is still marked experimental, so it is not used).
 *
 * The schema is built by numbered migrations. The file records which number it has reached
 * (PRAGMA user_version), so opening an older database brings it up to date and never repeats a step.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Db = Database.Database;
export type Row = Record<string, any>;

const hasColumn = (db: Db, table: string, column: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((c) => c.name === column);
const addColumn = (db: Db, table: string, column: string, type: string): void => {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
};

const migrations: ((db: Db) => void)[] = [
  // 1: accounts, songs, split sheets, messages, history, plugin keys, fingerprints.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE,
        pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL,
        artist_name TEXT NOT NULL, legal_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'Artist', pro TEXT NOT NULL DEFAULT '', ipi TEXT NOT NULL DEFAULT '',
        publisher TEXT NOT NULL DEFAULT '', publisher_ipi TEXT NOT NULL DEFAULT '',
        isni TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
      );
      -- Only a hash of each session token is stored, so a copy of the database cannot be used to sign in.
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS works (
        id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id),
        title TEXT NOT NULL, album TEXT NOT NULL DEFAULT '', project_id TEXT, status TEXT NOT NULL DEFAULT 'draft',
        shared INTEGER NOT NULL DEFAULT 0, /* 1 once the sheet has been sent; until then only the owner sees it */
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS people (
        id INTEGER PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE, position INTEGER NOT NULL,
        artist_name TEXT NOT NULL, legal_name TEXT NOT NULL, role TEXT NOT NULL,
        writer_share REAL NOT NULL, master_share REAL NOT NULL, email TEXT NOT NULL DEFAULT '',
        decision TEXT NOT NULL DEFAULT 'none', decided_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS people_work ON people(work_id);
      CREATE INDEX IF NOT EXISTS people_email ON people(email);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      -- History is hash-chained the same way as the plugin's log: each entry seals the one before it.
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        time INTEGER NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_work ON events(work_id);
      -- A plugin key lets one computer's plugin upload for one account. The key is kept readable so its
      -- owner can copy it again from their Profile; it can only upload records, not sign in or read anything.
      CREATE TABLE IF NOT EXISTS plugin_keys (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, token TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER
      );
      -- Acoustic fingerprints of bounces and stems. These are codes worked out from the audio, never the audio.
      CREATE TABLE IF NOT EXISTS fingerprints (
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE, fp_id TEXT NOT NULL,
        kind TEXT NOT NULL, name TEXT NOT NULL, bounce INTEGER NOT NULL, seconds REAL NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY (work_id, fp_id)
      );
    `);
    addColumn(db, 'users', 'artist_id', 'TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_artist_id ON users(artist_id)');
  },

  // 2: several separate projects can feed one song; the owner is stated, not assumed; the
  //    fields the plugin holds (ISRC, PRO, IPI, publisher, deal notes ...) are stored too.
  (db) => {
    addColumn(db, 'works', 'song_code', 'TEXT');                        // public code a collaborator types into their plugin to join
    addColumn(db, 'works', 'created_by', 'INTEGER');                    // the account that started the song
    addColumn(db, 'works', 'owner_stated', 'INTEGER NOT NULL DEFAULT 0'); // 1 once someone has said who owns it
    addColumn(db, 'works', 'isrc', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'works', 'iswc', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'works', 'split_version', 'INTEGER NOT NULL DEFAULT 1'); // goes up on every change to the sheet
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS works_song_code ON works(song_code)');
    db.exec('UPDATE works SET created_by = owner_id WHERE created_by IS NULL');
    for (const [column, type] of [['artist_id', "TEXT NOT NULL DEFAULT ''"], ['pro', "TEXT NOT NULL DEFAULT ''"], ['ipi', "TEXT NOT NULL DEFAULT ''"],
      ['publisher', "TEXT NOT NULL DEFAULT ''"], ['publisher_ipi', "TEXT NOT NULL DEFAULT ''"], ['terms', "TEXT NOT NULL DEFAULT ''"], ['seconds', 'INTEGER NOT NULL DEFAULT 0']])
      addColumn(db, 'people', column, type);

    db.exec(`
      -- One row per DAW project that feeds a song. Each collaborator's project is its own source, and
      -- each source keeps its own record, so one never overwrites another.
      CREATE TABLE IF NOT EXISTS sources (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, project_id TEXT NOT NULL,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}', log TEXT NOT NULL DEFAULT '[]',
        chain_ok INTEGER NOT NULL DEFAULT 1, chain_head TEXT NOT NULL DEFAULT '', linked_at INTEGER NOT NULL, synced_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, project_id)
      );
      CREATE INDEX IF NOT EXISTS sources_work ON sources(work_id);
      -- A short record of each upload, so earlier states are not lost when a newer one arrives.
      CREATE TABLE IF NOT EXISTS sync_history (
        id INTEGER PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL, project_id TEXT NOT NULL, synced_at INTEGER NOT NULL,
        chain_head TEXT NOT NULL, chain_ok INTEGER NOT NULL, summary TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sync_history_work ON sync_history(work_id);
    `);

    // Songs synced before this step had one project each, recorded on the song itself.
    const old = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'evidence'").get();
    if (old) {
      if (!hasColumn(db, 'evidence', 'log')) db.exec("ALTER TABLE evidence ADD COLUMN log TEXT NOT NULL DEFAULT '[]'");
      db.exec(`INSERT OR IGNORE INTO sources (user_id, project_id, work_id, data, log, chain_ok, chain_head, linked_at, synced_at)
               SELECT w.owner_id, w.project_id, w.id, e.data, e.log, e.chain_ok, e.chain_head, e.synced_at, e.synced_at
               FROM evidence e JOIN works w ON w.id = e.work_id WHERE w.project_id IS NOT NULL`);
      db.exec('DROP TABLE evidence');
    }
    db.exec('DROP INDEX IF EXISTS works_project');
  },

  // 3: a project's record can arrive as an offline receipt file uploaded on the website.
  //    `via` is empty for a plugin's own sync; otherwise it says who the receipt came from.
  (db) => addColumn(db, 'sources', 'via', "TEXT NOT NULL DEFAULT ''"),
];

/** Opens (and if needed creates or upgrades) the database. Pass ':memory:' for tests. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  let version = db.pragma('user_version', { simple: true }) as number;
  while (version < migrations.length) {
    const step = migrations[version];
    db.transaction(() => { step(db); db.pragma(`user_version = ${version + 1}`); })();
    version++;
  }
  return db;
}

/** Runs `fn` inside a transaction and rolls back if it throws. Safe to nest. */
export function transaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn)();
}

// ---------- housekeeping ----------

export interface Health { ok: boolean; problems: string[] }

/** Checks the file is sound and no row points at something that no longer exists. */
export function checkDatabase(db: Db): Health {
  const problems: string[] = [];
  for (const r of db.pragma('integrity_check') as Row[]) if (r.integrity_check !== 'ok') problems.push(String(r.integrity_check));
  for (const r of db.pragma('foreign_key_check') as Row[]) problems.push(`${r.table} row ${r.rowid} points at a missing ${r.parent}`);
  return { ok: problems.length === 0, problems };
}

/** Removes sign-ins that have expired and trims each project's upload history to its latest 50. */
export function tidyDatabase(db: Db): { sessions: number; history: number } {
  const sessions = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()).changes;
  const history = db.prepare(`DELETE FROM sync_history WHERE id NOT IN (
    SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id, project_id ORDER BY id DESC) AS n FROM sync_history) WHERE n <= 50)`).run().changes;
  return { sessions, history };
}

/**
 * Writes a complete, consistent copy of the database into `folder` and keeps the newest `keep`
 * copies. Safe while the server is running. Returns the new file's path.
 */
export function backupDatabase(db: Db, folder: string, keep = 14): string {
  mkdirSync(folder, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let file = join(folder, `split-tracker-${stamp}.db`);
  for (let n = 2; existsSync(file); n++) file = join(folder, `split-tracker-${stamp}-${n}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  const copies = readdirSync(folder).filter((f) => /^split-tracker-.*\.db$/.test(f))
    .map((f) => ({ f, t: statSync(join(folder, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const old of copies.slice(keep)) unlinkSync(join(folder, old.f));
  return file;
}
