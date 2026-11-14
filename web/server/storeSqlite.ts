/**
 * The storage interface (store.ts) on SQLite, through db.ts: the same file, schema, migrations,
 * housekeeping and backups as before. All SQL the server uses lives here.
 */
import { randomBytes } from 'node:crypto';
import type { Evidence, LogLine, Profile } from '../src/core/api.ts';
import { makeArtistId, makeSongCode } from '../src/core/artistId.ts';
import type { Decision, WorkStatus } from '../src/core/splits.ts';
import type { Db, Row } from './db.ts';
import { eventGenesis, eventHash } from './store.ts';
import type {
  ActivityRecord, EventRecord, FingerprintInfo, MessageRecord, NewSource, NewUser, NewWork, PersonInput, PersonRecord, PluginKeyRecord,
  SourcePayload, SourceRecord, Store, StoreTx, SyncHistoryRecord, UserRecord, Viewer, WorkRecord,
} from './store.ts';

// ---------- rows to records ----------

const userRecord = (u: Row): UserRecord => ({
  id: u.id, email: u.email, passHash: u.pass_hash, passSalt: u.pass_salt, artistId: u.artist_id, artistName: u.artist_name, legalName: u.legal_name,
  role: u.role, pro: u.pro, ipi: u.ipi, publisher: u.publisher, publisherIpi: u.publisher_ipi, isni: u.isni, phone: u.phone,
});
const workRecord = (w: Row): WorkRecord => ({
  id: w.id, ownerId: w.owner_id, createdBy: w.created_by, ownerStated: !!w.owner_stated, songCode: w.song_code, title: w.title, album: w.album,
  status: w.status as WorkStatus, shared: !!w.shared, isrc: w.isrc, iswc: w.iswc, splitVersion: w.split_version, createdAt: w.created_at, updatedAt: w.updated_at,
});
const personRecord = (p: Row): PersonRecord => ({
  id: p.id, workId: p.work_id, position: p.position, artistName: p.artist_name, legalName: p.legal_name, role: p.role,
  writerShare: p.writer_share, masterShare: p.master_share, email: p.email, artistId: p.artist_id, pro: p.pro, ipi: p.ipi,
  publisher: p.publisher, publisherIpi: p.publisher_ipi, terms: p.terms, seconds: p.seconds, decision: p.decision as Decision, decidedAt: p.decided_at ?? null,
});
const sourceRecord = (s: Row): SourceRecord => ({
  userId: s.user_id, projectId: s.project_id, workId: s.work_id, via: s.via, chainOk: !!s.chain_ok, chainHead: s.chain_head,
  linkedAt: s.linked_at, syncedAt: s.synced_at, uploaderName: s.artist_name,
});

/** Who may see a song: its owner, whoever started it, anyone whose own project feeds it, and,
    once it has been sent, anyone on its split sheet. For everyone else it does not exist. */
const VISIBLE = `(w.owner_id = @uid OR w.created_by = @uid
    OR EXISTS (SELECT 1 FROM sources s WHERE s.work_id = w.id AND s.user_id = @uid)
    OR (w.shared = 1 AND EXISTS (SELECT 1 FROM people p WHERE p.work_id = w.id AND p.email = @email)))`;

const SOURCE = 'SELECT s.*, u.artist_name FROM sources s JOIN users u ON u.id = s.user_id';

/**
 * Every operation, run straight on the database. better-sqlite3 is synchronous, so each method
 * does its work at once and returns an already-settled Promise.
 */
class SqliteOps implements StoreTx {
  db: Db;
  constructor(db: Db) { this.db = db; }

  // ---------- accounts ----------

  private user(where: string, value: unknown): UserRecord | null {
    const u = this.db.prepare(`SELECT * FROM users WHERE ${where} = ?`).get(value) as Row | undefined;
    return u ? userRecord(u) : null;
  }
  async userById(id: number) { return this.user('id', id); }
  async userByEmail(email: string) { return this.user('email', email); }
  async userByArtistId(artistId: string) { return this.user('artist_id', artistId); }

  async emailsWithAccount(emails: string[]): Promise<string[]> {
    const has = this.db.prepare('SELECT 1 FROM users WHERE email = ?');
    return [...new Set(emails)].filter((e) => !!e && !!has.get(e));
  }

  async createUser(user: NewUser): Promise<UserRecord> {
    const info = this.db.prepare(
      'INSERT INTO users (email, pass_hash, pass_salt, artist_name, legal_name, created_at, artist_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(user.email, user.passHash, user.passSalt, user.artistName, user.legalName, user.createdAt, user.artistId);
    return this.user('id', info.lastInsertRowid)!;
  }

  async updateProfile(userId: number, p: Profile): Promise<UserRecord> {
    const db = this.db;
    return db.transaction(() => {
      const before = this.user('id', userId)!;
      db.prepare(
        'UPDATE users SET artist_name=?, legal_name=?, role=?, pro=?, ipi=?, publisher=?, publisher_ipi=?, isni=?, phone=? WHERE id=?',
      ).run(p.artistName, p.legalName, p.role, p.pro, p.ipi, p.publisher, p.publisherIpi, p.isni, p.phone, userId);
      // Draft sheets that name this account follow the profile. Sent and signed sheets stay as approved.
      const drafts = db.prepare("SELECT DISTINCT p.work_id FROM people p JOIN works w ON w.id = p.work_id WHERE p.email = ? AND w.status = 'draft'").all(before.email) as Row[];
      db.prepare(`UPDATE people SET artist_name = ?, legal_name = ?, pro = ?, ipi = ?, publisher = ?, publisher_ipi = ?
                  WHERE email = ? AND work_id IN (SELECT id FROM works WHERE status = 'draft')`).run(p.artistName, p.legalName, p.pro, p.ipi, p.publisher, p.publisherIpi, before.email);
      for (const d of drafts) db.prepare('UPDATE works SET split_version = split_version + 1 WHERE id = ?').run(d.work_id);
      return this.user('id', userId)!;
    })();
  }

  async deleteAccount(userId: number, ownedWorkIds: string[]): Promise<void> {
    const db = this.db;
    db.transaction(() => {
      for (const id of ownedWorkIds) db.prepare('DELETE FROM works WHERE id = ?').run(id);
      db.prepare('UPDATE works SET created_by = owner_id WHERE created_by = ?').run(userId);
      db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);   // sign-ins, plugin keys and projects go with the account
    })();
  }

  // ---------- sign-ins ----------

  async createSession(tokenHash: string, userId: number, expiresAt: number): Promise<void> {
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, userId, expiresAt);
  }
  async userBySession(tokenHash: string, now: number): Promise<UserRecord | null> {
    const u = this.db.prepare(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
    ).get(tokenHash, now) as Row | undefined;
    return u ? userRecord(u) : null;
  }
  async deleteSession(tokenHash: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  // ---------- plugin keys ----------

  async pluginKeysOf(userId: number): Promise<PluginKeyRecord[]> {
    return (this.db.prepare('SELECT * FROM plugin_keys WHERE user_id = ? ORDER BY id').all(userId) as Row[])
      .map((k) => ({ id: k.id, userId: k.user_id, name: k.name, token: k.token, createdAt: k.created_at, lastUsedAt: k.last_used_at ?? null }));
  }
  async createPluginKey(userId: number, name: string, token: string, tokenHash: string, createdAt: number): Promise<void> {
    this.db.prepare('INSERT INTO plugin_keys (user_id, name, token, token_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, name, token, tokenHash, createdAt);
  }
  async deletePluginKey(userId: number, keyId: number): Promise<void> {
    this.db.prepare('DELETE FROM plugin_keys WHERE id = ? AND user_id = ?').run(keyId, userId);
  }
  async userByPluginKey(tokenHash: string): Promise<{ user: UserRecord; keyId: number } | null> {
    const row = this.db.prepare(
      'SELECT u.*, k.id AS key_id FROM plugin_keys k JOIN users u ON u.id = k.user_id WHERE k.token_hash = ?',
    ).get(tokenHash) as Row | undefined;
    return row ? { user: userRecord(row), keyId: row.key_id } : null;
  }
  async touchPluginKey(keyId: number, at: number): Promise<void> {
    this.db.prepare('UPDATE plugin_keys SET last_used_at = ? WHERE id = ?').run(at, keyId);
  }

  // ---------- songs ----------

  async workById(id: string): Promise<WorkRecord | null> {
    const w = this.db.prepare('SELECT * FROM works WHERE id = ?').get(id) as Row | undefined;
    return w ? workRecord(w) : null;
  }
  async workBySongCode(songCode: string): Promise<WorkRecord | null> {
    const w = this.db.prepare('SELECT * FROM works WHERE song_code = ?').get(songCode) as Row | undefined;
    return w ? workRecord(w) : null;
  }
  async workVisibleTo(viewer: Viewer, id: string): Promise<WorkRecord | null> {
    const w = this.db.prepare(`SELECT * FROM works w WHERE w.id = @id AND ${VISIBLE}`).get({ id, uid: viewer.id, email: viewer.email }) as Row | undefined;
    return w ? workRecord(w) : null;
  }
  async worksVisibleTo(viewer: Viewer): Promise<WorkRecord[]> {
    return (this.db.prepare(`SELECT * FROM works w WHERE ${VISIBLE} ORDER BY w.updated_at DESC`).all({ uid: viewer.id, email: viewer.email }) as Row[]).map(workRecord);
  }
  async worksOwnedBy(userId: number): Promise<WorkRecord[]> {
    return (this.db.prepare('SELECT * FROM works WHERE owner_id = ?').all(userId) as Row[]).map(workRecord);
  }

  private insertPeople(workId: string, rows: PersonInput[]): void {
    const insert = this.db.prepare(`INSERT INTO people (work_id, position, artist_name, legal_name, role, writer_share, master_share, email, artist_id, pro, ipi, publisher, publisher_ipi, terms, seconds)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    rows.forEach((r, i) => insert.run(workId, i, r.artistName, r.legalName, r.role, r.writerShare, r.masterShare, r.email, r.artistId, r.pro, r.ipi, r.publisher, r.publisherIpi, r.terms, r.seconds));
  }

  async createWork(work: NewWork, people: PersonInput[]): Promise<void> {
    const db = this.db;
    db.transaction(() => {
      db.prepare('INSERT INTO works (id, owner_id, created_by, owner_stated, song_code, title, album, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(work.id, work.ownerId, work.createdBy, work.ownerStated ? 1 : 0, work.songCode, work.title, work.album, work.createdAt, work.createdAt);
      this.insertPeople(work.id, people);
    })();
  }

  async updateWorkDetails(id: string, details: { title?: string; album?: string; isrc?: string; iswc?: string }): Promise<void> {
    const columns = (['title', 'album', 'isrc', 'iswc'] as const).filter((c) => details[c] !== undefined);
    if (columns.length === 0) return;
    this.db.prepare(`UPDATE works SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...columns.map((c) => details[c]), id);
  }
  async setWorkOwner(id: string, ownerId: number): Promise<void> {
    this.db.prepare('UPDATE works SET owner_id = ?, owner_stated = 1 WHERE id = ?').run(ownerId, id);
  }
  async markSent(id: string): Promise<void> {
    this.db.prepare("UPDATE works SET status = 'sent', shared = 1 WHERE id = ?").run(id);
  }
  async markSigned(id: string): Promise<void> {
    this.db.prepare("UPDATE works SET status = 'signed' WHERE id = ?").run(id);
  }
  async deleteWork(id: string): Promise<void> {
    this.db.prepare('DELETE FROM works WHERE id = ?').run(id);
  }

  // ---------- split sheets ----------

  async peopleOf(workId: string): Promise<PersonRecord[]> {
    return (this.db.prepare('SELECT * FROM people WHERE work_id = ? ORDER BY position').all(workId) as Row[]).map(personRecord);
  }
  async personOnSheet(workId: string, email: string, artistId: string): Promise<boolean> {
    return !!this.db.prepare('SELECT 1 FROM people WHERE work_id = ? AND (email = ? OR artist_id = ?)').get(workId, email, artistId);
  }
  async writePeople(workId: string, rows: PersonInput[]): Promise<void> {
    const db = this.db;
    db.transaction(() => {
      db.prepare('DELETE FROM people WHERE work_id = ?').run(workId);
      this.insertPeople(workId, rows);
      // Any change withdraws earlier approvals: people approve the sheet as it stands, not an older one.
      db.prepare("UPDATE works SET status = 'draft', split_version = split_version + 1 WHERE id = ?").run(workId);
    })();
  }
  async setDecisions(workId: string, personIds: number[], decision: Decision, at: number): Promise<void> {
    const update = this.db.prepare('UPDATE people SET decision = ?, decided_at = ? WHERE id = ? AND work_id = ?');
    for (const id of personIds) update.run(decision, at, id, workId);
  }
  async setPeopleSeconds(workId: string, entries: { artistName: string; seconds: number }[]): Promise<void> {
    const update = this.db.prepare('UPDATE people SET seconds = ? WHERE work_id = ? AND artist_name = ?');
    for (const e of entries) update.run(e.seconds, workId, e.artistName);
  }

  // ---------- messages and history ----------

  async messagesOf(workId: string): Promise<MessageRecord[]> {
    return (this.db.prepare(
      'SELECT m.id, m.body, m.created_at, m.user_id, u.artist_name FROM messages m JOIN users u ON u.id = m.user_id WHERE m.work_id = ? ORDER BY m.id',
    ).all(workId) as Row[]).map((m) => ({ id: m.id, userId: m.user_id, authorName: m.artist_name, body: m.body, createdAt: m.created_at }));
  }
  async addMessage(workId: string, userId: number, body: string, at: number): Promise<void> {
    this.db.prepare('INSERT INTO messages (work_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(workId, userId, body, at);
    this.db.prepare('UPDATE works SET updated_at = ? WHERE id = ?').run(at, workId);
  }
  async eventsOf(workId: string): Promise<EventRecord[]> {
    return (this.db.prepare('SELECT time, type, text, hash FROM events WHERE work_id = ? ORDER BY id').all(workId) as Row[])
      .map((e) => ({ time: e.time, type: e.type, text: e.text, hash: e.hash }));
  }
  async appendEvent(workId: string, type: string, text: string): Promise<void> {
    const db = this.db;
    db.transaction(() => {
      const last = db.prepare('SELECT hash FROM events WHERE work_id = ? ORDER BY id DESC LIMIT 1').get(workId) as Row | undefined;
      const time = Date.now();
      db.prepare('INSERT INTO events (work_id, time, type, text, hash) VALUES (?, ?, ?, ?, ?)')
        .run(workId, time, type, text, eventHash(last?.hash ?? eventGenesis(workId), time, type, text));
      db.prepare('UPDATE works SET updated_at = ? WHERE id = ?').run(time, workId);
    })();
  }
  async activityVisibleTo(viewer: Viewer, limit: number): Promise<ActivityRecord[]> {
    return (this.db.prepare(
      `SELECT e.time, e.text, w.title FROM events e JOIN works w ON w.id = e.work_id WHERE ${VISIBLE} ORDER BY e.id DESC LIMIT @limit`,
    ).all({ uid: viewer.id, email: viewer.email, limit }) as Row[]).map((e) => ({ workTitle: e.title, time: e.time, text: e.text }));
  }

  // ---------- projects feeding songs ----------

  async findSource(userId: number, projectId: string): Promise<SourceRecord | null> {
    const s = this.db.prepare(`${SOURCE} WHERE s.user_id = ? AND s.project_id = ?`).get(userId, projectId) as Row | undefined;
    return s ? sourceRecord(s) : null;
  }
  async sourcesOfWork(workId: string): Promise<SourceRecord[]> {
    return (this.db.prepare(`${SOURCE} WHERE s.work_id = ? ORDER BY s.linked_at`).all(workId) as Row[]).map(sourceRecord);
  }
  async addSource(s: NewSource): Promise<void> {
    this.db.prepare('INSERT INTO sources (user_id, project_id, work_id, linked_at, synced_at, via) VALUES (?, ?, ?, ?, ?, ?)').run(s.userId, s.projectId, s.workId, s.at, s.at, s.via);
  }
  async setSourceVia(userId: number, projectId: string, via: string): Promise<void> {
    this.db.prepare('UPDATE sources SET via = ? WHERE user_id = ? AND project_id = ?').run(via, userId, projectId);
  }
  async removeSource(userId: number, projectId: string): Promise<void> {
    this.db.prepare('DELETE FROM sources WHERE user_id = ? AND project_id = ?').run(userId, projectId);
  }
  async putSourceRecord(userId: number, projectId: string, p: SourcePayload): Promise<void> {
    this.db.prepare('UPDATE sources SET data = ?, log = ?, chain_ok = ?, chain_head = ?, synced_at = ? WHERE user_id = ? AND project_id = ?')
      .run(JSON.stringify(p.evidence), JSON.stringify(p.log), p.chainOk ? 1 : 0, p.chainHead, p.syncedAt, userId, projectId);
  }
  async getSourceEvidence(userId: number, projectId: string): Promise<Evidence | null> {
    const s = this.db.prepare('SELECT data FROM sources WHERE user_id = ? AND project_id = ?').get(userId, projectId) as Row | undefined;
    return s ? JSON.parse(s.data) as Evidence : null;
  }
  async getSourceLog(userId: number, projectId: string): Promise<LogLine[]> {
    const s = this.db.prepare('SELECT log FROM sources WHERE user_id = ? AND project_id = ?').get(userId, projectId) as Row | undefined;
    return JSON.parse((s?.log as string) ?? '[]') as LogLine[];
  }
  async addSyncHistory(h: SyncHistoryRecord): Promise<void> {
    this.db.prepare('INSERT INTO sync_history (work_id, user_id, project_id, synced_at, chain_head, chain_ok, summary) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(h.workId, h.userId, h.projectId, h.syncedAt, h.chainHead, h.chainOk ? 1 : 0, h.summary);
  }
  async syncHistoryOf(userId: number): Promise<SyncHistoryRecord[]> {
    return (this.db.prepare('SELECT work_id, project_id, synced_at, chain_head, chain_ok, summary FROM sync_history WHERE user_id = ? ORDER BY id').all(userId) as Row[])
      .map((h) => ({ workId: h.work_id, userId, projectId: h.project_id, syncedAt: h.synced_at, chainHead: h.chain_head, chainOk: !!h.chain_ok, summary: h.summary }));
  }

  // ---------- fingerprints ----------

  async putFingerprint(workId: string, info: FingerprintInfo, data: Uint8Array): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO fingerprints (work_id, fp_id, kind, name, bounce, seconds, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(workId, info.fpId, info.kind, info.name, info.bounce, info.seconds, data);
  }
  async getFingerprint(workId: string, fpId: string): Promise<Uint8Array | null> {
    const row = this.db.prepare('SELECT data FROM fingerprints WHERE work_id = ? AND fp_id = ?').get(workId, fpId) as Row | undefined;
    return row ? row.data as Uint8Array : null;
  }
  async fingerprintsOf(workId: string): Promise<FingerprintInfo[]> {
    return (this.db.prepare('SELECT fp_id, kind, name, bounce, seconds FROM fingerprints WHERE work_id = ?').all(workId) as Row[])
      .map((f) => ({ fpId: f.fp_id, kind: f.kind, name: f.name, bounce: f.bounce, seconds: f.seconds }));
  }
}

/** The names of every operation, so the store below can offer each one. */
const OPERATIONS = Object.getOwnPropertyNames(SqliteOps.prototype)
  .filter((n) => n !== 'constructor' && n !== 'user' && n !== 'insertPeople') as (keyof StoreTx)[];

/**
 * The store the server is given. It offers every operation of StoreTx (declared just below, filled
 * in by the constructor) plus `transaction` and the sign-in rate limit.
 *
 * One connection does everything, so work is kept in a single line: an operation called on the
 * store waits for a transaction that is under way to finish, and so never lands inside it. Inside
 * a transaction, operations go through the `tx` object and run at once.
 */
export interface SqliteStore extends StoreTx {}
export class SqliteStore implements Store {
  /** The database underneath, for housekeeping and backups (db.ts). */
  db: Db;
  private ops: SqliteOps;
  private tail: Promise<unknown> = Promise.resolve();
  /** Failed sign-ins. Memory is enough here: this store runs in one long-lived process. */
  private failures = new Map<string, { count: number; resetAt: number }>();

  constructor(db: Db) {
    this.db = db;
    const ops = this.ops = new SqliteOps(db);
    const self = this as unknown as Record<string, unknown>, target = ops as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const name of OPERATIONS) self[name] = (...args: unknown[]) => this.inTurn(() => target[name](...args));

    // Accounts and songs made before Artist IDs and song codes existed get one now.
    for (const u of db.prepare('SELECT id FROM users WHERE artist_id IS NULL').all() as Row[]) {
      let id = makeArtistId(randomBytes(7));
      while (db.prepare('SELECT 1 FROM users WHERE artist_id = ?').get(id)) id = makeArtistId(randomBytes(7));
      db.prepare('UPDATE users SET artist_id = ? WHERE id = ?').run(id, u.id);
    }
    for (const w of db.prepare('SELECT id FROM works WHERE song_code IS NULL').all() as Row[]) {
      let code = makeSongCode(randomBytes(7));
      while (db.prepare('SELECT 1 FROM works WHERE song_code = ?').get(code)) code = makeSongCode(randomBytes(7));
      db.prepare('UPDATE works SET song_code = ? WHERE id = ?').run(code, w.id);
    }
  }

  /** Runs `fn` after everything asked for before it has finished. */
  private inTurn<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }

  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    return this.inTurn(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const out = await fn(this.ops);
        this.db.exec('COMMIT');
        return out;
      } catch (e) {
        if (this.db.inTransaction) this.db.exec('ROLLBACK');
        throw e;
      }
    });
  }

  // ---------- sign-in rate limit ----------

  async loginFailures(key: string, now: number): Promise<number> {
    const f = this.failures.get(key);
    return f && f.resetAt > now ? f.count : 0;
  }
  async recordLoginFailure(key: string, now: number, windowMs: number): Promise<void> {
    const f = this.failures.get(key);
    const cur = f && f.resetAt > now ? f : { count: 0, resetAt: now + windowMs };
    cur.count++;
    this.failures.set(key, cur);
  }
  async clearLoginFailures(key: string): Promise<void> {
    this.failures.delete(key);
  }
}
