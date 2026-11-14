/**
 * The storage interface (store.ts) on Google Firestore, through firebase-admin (only its Firestore).
 * It behaves as storeSqlite.ts does; that file is the specification.
 *
 * Where things live. Everything is under one document, envs/{namespace}, so that environments never
 * mix (SPLIT_TRACKER_NAMESPACE, default "prod"). Beneath it:
 *
 *   users/{id}                       an account. id is a number from counters/users.
 *   sessions/{tokenHash}             a sign-in: userId, expiresAt (and expireAt, for a TTL policy).
 *   pluginKeys/{id}                  a plugin key. id is a number from counters/pluginKeys.
 *   counters/{users|messages|pluginKeys}   { next }: the next numeric id, raised inside a transaction.
 *   loginFailures/{sha256(key)}      failed sign-ins: count, resetAt (and expireAt, for a TTL policy).
 *   works/{songId}                   a song, WITH its split sheet (people[]), its history head
 *                                    (ev: count, last hash, current page), its message head (msg),
 *                                    the last few history lines (recent[]) and the fields that
 *                                    decide who may see it (viewers[], sheetEmails[], sourceKeys[]).
 *   works/{songId}/eventPages/{n}    the hash-chained history, many entries to a document.
 *   works/{songId}/messagePages/{n}  the messages, many to a document.
 *   works/{songId}/fingerprints/{fpId}             what is known about one fingerprint file.
 *   works/{songId}/fingerprints/{fpId}/chunks/{gen}-{i}   its bytes, 800 KB to a document.
 *   sources/{userId}_{projectId}     one DAW project feeding a song, with its uploader's artist name.
 *   sources/{key}/chunks/{gen}-e{i} and {gen}-l{i}   its evidence and its log (JSON), 800 KB to a document.
 *   syncHistory/{time-ordered id}    a short note of each upload.
 *
 * Reads are by document id wherever one is known. The queries are all on one field (equality,
 * array-contains, array-contains-any, in), which Firestore indexes by itself: no composite index is
 * needed. Sorting and any second condition are done in memory.
 *
 * Transactions. Firestore wants every read of a transaction before its first write, while app.ts
 * calls coarse operations that read after earlier writes. So a transaction here keeps an overlay
 * (class Session): every document it has read, and every write it has been asked for. Reads are
 * answered from the overlay first; nothing is written to Firestore until the callback has finished,
 * and then all of it is written at once, inside the same Firestore transaction. See `transaction`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cert, deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore, type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { Evidence, LogLine, Profile } from '../src/core/api.ts';
import type { Decision, WorkStatus } from '../src/core/splits.ts';
import { eventGenesis, eventHash } from './store.ts';
import type {
  ActivityRecord, EventRecord, FingerprintInfo, MessageRecord, NewSource, NewUser, NewWork, PersonInput, PersonRecord, PluginKeyRecord,
  SourcePayload, SourceRecord, Store, StoreTx, SyncHistoryRecord, UserRecord, Viewer, WorkRecord,
} from './store.ts';

// ---------- credentials ----------

interface ServiceAccount { project_id: string; client_email: string; private_key: string }

const DEFAULT_KEY_FILE = join(homedir(), '.config', 'split-tracker', 'firebase-key.json');

/** Finds the service-account key: FIREBASE_SERVICE_ACCOUNT (the JSON itself), else FIREBASE_KEY_FILE
    (a path), else ~/.config/split-tracker/firebase-key.json. The key is never printed. */
export function loadServiceAccount(env: NodeJS.ProcessEnv = process.env): ServiceAccount {
  const parse = (text: string, from: string): ServiceAccount => {
    let key: Partial<ServiceAccount> | null = null;
    try { key = JSON.parse(text) as Partial<ServiceAccount>; } catch { /* reported below, without the contents */ }
    if (!key || typeof key.project_id !== 'string' || typeof key.client_email !== 'string' || typeof key.private_key !== 'string')
      throw new Error(`${from} is not a Firebase service-account key (JSON with project_id, client_email and private_key).`);
    return { project_id: key.project_id, client_email: key.client_email, private_key: key.private_key };
  };
  if (env.FIREBASE_SERVICE_ACCOUNT) return parse(env.FIREBASE_SERVICE_ACCOUNT, 'FIREBASE_SERVICE_ACCOUNT');
  if (env.FIREBASE_KEY_FILE) {
    if (!existsSync(env.FIREBASE_KEY_FILE)) throw new Error(`FIREBASE_KEY_FILE points at ${env.FIREBASE_KEY_FILE}, which does not exist.`);
    return parse(readFileSync(env.FIREBASE_KEY_FILE, 'utf8'), `The file ${env.FIREBASE_KEY_FILE}`);
  }
  if (existsSync(DEFAULT_KEY_FILE)) return parse(readFileSync(DEFAULT_KEY_FILE, 'utf8'), `The file ${DEFAULT_KEY_FILE}`);
  throw new Error('No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT to the service-account JSON, or FIREBASE_KEY_FILE to the path of the key file, '
    + `or put the key file at ${DEFAULT_KEY_FILE}.`);
}

/** One connection per service account in this process. */
const connections = new Map<string, { app: App; db: Firestore }>();
function connect(account: ServiceAccount): Firestore {
  const id = `${account.project_id}|${account.client_email}`;
  let c = connections.get(id);
  if (!c) {
    const app = initializeApp({ credential: cert({ projectId: account.project_id, clientEmail: account.client_email, privateKey: account.private_key }), projectId: account.project_id },
      `split-tracker-${connections.size + 1}`);
    const db = getFirestore(app);
    db.settings({ ignoreUndefinedProperties: true });
    connections.set(id, c = { app, db });
  }
  return c.db;
}

// ---------- documents ----------

type Doc = Record<string, any>;
type Op = '==' | 'in' | 'array-contains' | 'array-contains-any';
interface Found { path: string; id: string; data: Doc }

/** Where a paged list (history, messages) has got to. */
interface Head { count: number; page: number; pageCount: number; pageBytes: number }
interface PersonDoc extends PersonInput { id: number; decision: Decision; decidedAt: number | null }
interface WorkDoc {
  id: string; ownerId: number; createdBy: number; ownerStated: boolean; songCode: string; title: string; album: string; status: WorkStatus;
  shared: boolean; isrc: string; iswc: string; splitVersion: number; createdAt: number; updatedAt: number;
  /** The split sheet, in order. */
  people: PersonDoc[];
  /** Every email on the sheet (for "which draft sheets name this account"). */
  sheetEmails: string[];
  /** Who may see the song: "u<account id>" for owner, starter and anyone whose project feeds it; "e<email>" for people on the sheet once it is sent. */
  viewers: string[];
  /** The projects feeding the song, as source document ids, and the next linking order number. */
  sourceKeys: string[]; sourceSeq: number;
  /** History head: how many entries, the last hash, and the page being filled. */
  ev: Head & { hash: string };
  /** The newest history lines, so the activity list needs no further reads. */
  recent: { seq: number; time: number; text: string }[];
  msg: Head;
  /** Accounts that have written a message here (for removing an account's messages). */
  msgUserIds: number[];
}
interface Blob { gen: string; ev: number; log: number }
interface SourceDoc {
  userId: number; projectId: string; workId: string; via: string; chainOk: boolean; chainHead: string; linkedAt: number; syncedAt: number;
  seq: number; uploaderName: string; blob: Blob | null;
}

/** Raw bytes per chunk document. A Firestore document may hold 1 MiB; this leaves ample room. */
const CHUNK_BYTES = 800_000;
/** Chunks are uploaded a few at a time: one commit may carry 10 MiB. */
const UPLOAD_BYTES = 3_500_000;
/** A page of history or messages is closed at this many entries or bytes, whichever comes first. */
const PAGE_ITEMS = 100, PAGE_BYTES = 200_000;
/** History lines kept on the song for the activity list (app.ts asks for 12). */
const RECENT = 12;

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const pad = (n: number): string => String(n).padStart(6, '0');
const sourceKey = (userId: number, projectId: string): string => `${userId}_${projectId}`;
const userOfKey = (key: string): number => Number(key.slice(0, key.indexOf('_')));
const unique = <T>(items: T[]): T[] => [...new Set(items)];
const newHead = (): Head => ({ count: 0, page: 0, pageCount: 0, pageBytes: 0 });

const matches = (d: Doc, field: string, op: Op, value: unknown): boolean => {
  const v = d[field];
  if (op === '==') return v === value;
  if (op === 'in') return (value as unknown[]).includes(v);
  if (op === 'array-contains') return Array.isArray(v) && v.includes(value);
  return Array.isArray(v) && v.some((x) => (value as unknown[]).includes(x));
};

/** Fills in the fields a song is found by. Called on every write that could change them. */
function indexed(w: WorkDoc): WorkDoc {
  const sheetEmails = unique(w.people.map((p) => p.email).filter(Boolean));
  const viewers = unique([`u${w.ownerId}`, `u${w.createdBy}`, ...w.sourceKeys.map((k) => `u${userOfKey(k)}`), ...(w.shared ? sheetEmails.map((e) => `e${e}`) : [])]);
  return { ...w, sheetEmails, viewers };
}

/** storeSqlite.ts's VISIBLE rule: owner, starter, anyone whose own project feeds the song, and, once it is sent, anyone on its sheet. */
const visibleTo = (w: WorkDoc, viewer: Viewer): boolean => w.ownerId === viewer.id || w.createdBy === viewer.id
  || w.sourceKeys.some((k) => userOfKey(k) === viewer.id) || (w.shared && w.people.some((p) => p.email === viewer.email));

/** Where the next entry of a paged list goes, and the head after it. */
function advance(head: Head, item: unknown): { page: number; head: Head } {
  const bytes = Buffer.byteLength(JSON.stringify(item));
  const roll = head.pageCount >= PAGE_ITEMS || (head.pageCount > 0 && head.pageBytes + bytes > PAGE_BYTES);
  const page = roll ? head.page + 1 : head.page;
  return { page, head: { count: head.count + 1, page, pageCount: roll ? 1 : head.pageCount + 1, pageBytes: roll ? bytes : head.pageBytes + bytes } };
}

const userRecord = (u: Doc): UserRecord => ({
  id: u.id, email: u.email, passHash: u.passHash, passSalt: u.passSalt, artistId: u.artistId, artistName: u.artistName, legalName: u.legalName,
  role: u.role, pro: u.pro, ipi: u.ipi, publisher: u.publisher, publisherIpi: u.publisherIpi, isni: u.isni, phone: u.phone,
});
const workRecord = (w: WorkDoc): WorkRecord => ({
  id: w.id, ownerId: w.ownerId, createdBy: w.createdBy, ownerStated: w.ownerStated, songCode: w.songCode, title: w.title, album: w.album,
  status: w.status, shared: w.shared, isrc: w.isrc, iswc: w.iswc, splitVersion: w.splitVersion, createdAt: w.createdAt, updatedAt: w.updatedAt,
});
const personDoc = (r: PersonInput, position: number): PersonDoc => ({
  id: position + 1, artistName: r.artistName, legalName: r.legalName, role: r.role, writerShare: r.writerShare, masterShare: r.masterShare,
  email: r.email, artistId: r.artistId, pro: r.pro, ipi: r.ipi, publisher: r.publisher, publisherIpi: r.publisherIpi, terms: r.terms, seconds: r.seconds,
  decision: 'none', decidedAt: null,
});
const sourceRecord = (s: SourceDoc): SourceRecord => ({
  userId: s.userId, projectId: s.projectId, workId: s.workId, via: s.via, chainOk: s.chainOk, chainHead: s.chainHead,
  linkedAt: s.linkedAt, syncedAt: s.syncedAt, uploaderName: s.uploaderName,
});

/** A stored payload was replaced between reading where it is and reading it. The read is tried again. */
class MissingChunk extends Error {}

/** Thrown out of a transaction that turned out to have nothing to write, carrying what it returned. */
class NothingToWrite {
  result: unknown;
  constructor(result: unknown) { this.result = result; }
}

// ---------- the overlay ----------

/**
 * What one transaction (or one plain read) has seen and has been asked to write.
 *
 * - `docs` holds every document read so far, and every pending write as the document's new state
 *   (null for a delete). A later read of the same document is answered from here, so it sees the
 *   transaction's own writes, and Firestore is never asked to read after a write.
 * - `appends` holds entries to add to the end of a page nobody has read (history, messages): they
 *   are written with arrayUnion, so appending costs no read.
 * - `staged` holds chunk documents of large payloads, always under a fresh name. Small ones are
 *   written with the rest. Large ones are uploaded just before the transaction's writes, outside it
 *   (one commit may carry 10 MiB, a long log more); the transaction then only switches the small
 *   record to point at them. `cleanup` lists the chunks that record pointed at before: they are
 *   deleted in the same commit.
 * - Nothing reaches Firestore until `commit`. Without a transaction (`t` null) only reads are allowed.
 */
class Session {
  store: FirestoreStore;
  t: Transaction | null;
  docs = new Map<string, { data: Doc | null; dirty: boolean }>();
  appends = new Map<string, { field: string; items: unknown[] }>();
  staged: { path: string; data: Buffer }[] = [];
  /** Payloads staged in this transaction, by owner and kind, so it can read back what it wrote. */
  pending = new Map<string, Buffer>();
  /** Chunk documents uploaded ahead of the commit by this attempt (to remove if it does not go through). */
  uploaded: string[] = [];
  /** Chunk documents nothing will point at once this transaction has gone through. */
  cleanup: string[] = [];
  /** Reads under way, so two operations asking for one document at the same moment share one read. */
  private loading = new Map<string, Promise<void>>();
  /** Which documents each query returned, so asking the same thing twice costs one read. */
  private asked = new Map<string, string[]>();

  constructor(store: FirestoreStore, t: Transaction | null) { this.store = store; this.t = t; }

  private ref(path: string): DocumentReference { return this.store.db.doc(`${this.store.root.path}/${path}`); }

  /** Reads documents straight from Firestore (through the transaction, if there is one). */
  async raw(paths: string[]): Promise<(Doc | null)[]> {
    if (paths.length === 0) return [];
    const refs = paths.map((p) => this.ref(p));
    const snaps = this.t ? await this.t.getAll(...refs) : await this.store.db.getAll(...refs);
    this.store.stats.reads += paths.length;
    return snaps.map((d) => (d.exists ? d.data() as Doc : null));
  }

  /** Takes a document as read from Firestore into the overlay, with any entries waiting to be appended to it. */
  private admit(path: string, data: Doc | null): Doc | null {
    const more = this.appends.get(path);
    if (more) {
      this.appends.delete(path);
      data = { ...(data ?? {}), [more.field]: [...((data?.[more.field] as unknown[] | undefined) ?? []), ...more.items] };
    }
    this.docs.set(path, { data, dirty: !!more });
    return data;
  }

  async getMany(paths: string[]): Promise<(Doc | null)[]> {
    const missing = unique(paths.filter((p) => !this.docs.has(p) && !this.loading.has(p)));
    if (missing.length > 0) {
      const load = this.raw(missing).then((fetched) => missing.forEach((p, i) => { if (!this.docs.has(p)) this.admit(p, fetched[i]); }))
        .finally(() => missing.forEach((p) => this.loading.delete(p)));
      for (const p of missing) this.loading.set(p, load);
    }
    await Promise.all(unique(paths.map((p) => this.loading.get(p)).filter((x) => !!x)));
    return paths.map((p) => this.docs.get(p)!.data);
  }
  /** Whether this document has already been read (or written) here. */
  has(path: string): boolean { return this.docs.has(path); }
  async get(path: string): Promise<Doc | null> { return (await this.getMany([path]))[0]; }

  /** The documents of a collection (all of them, or those matching one condition), as this transaction sees them. */
  async query(collection: string, field?: string, op?: Op, value?: unknown): Promise<Found[]> {
    const ok = (d: Doc): boolean => !field || matches(d, field, op!, value);
    const out = new Map<string, Doc>();
    const question = `${collection}|${field ?? ''}|${op ?? ''}|${JSON.stringify(value ?? null)}`;
    let returned = this.asked.get(question);
    if (!returned) {
      const col = this.store.db.collection(`${this.store.root.path}/${collection}`);
      const q = field ? col.where(field, op!, value) : col;
      const snap = this.t ? await this.t.get(q) : await q.get();
      this.store.stats.reads += Math.max(1, snap.size);
      returned = snap.docs.map((d) => `${collection}/${d.id}`);
      snap.docs.forEach((d, i) => { if (!this.docs.has(returned![i])) this.admit(returned![i], d.data() as Doc); });
      this.asked.set(question, returned);
    }
    for (const path of returned) {
      const data = this.docs.get(path)!.data;
      if (data && ok(data)) out.set(path, data);
    }
    // What this transaction has written, or is waiting to append, that Firestore does not know yet.
    const parent = (path: string): string => path.slice(0, path.lastIndexOf('/'));
    // (A page waiting for appends that a whole-collection read did not return does not exist yet.)
    if (!field) for (const path of [...this.appends.keys()]) if (parent(path) === collection) this.admit(path, null);
    for (const [path, e] of this.docs) if (e.dirty && e.data && parent(path) === collection && ok(e.data)) out.set(path, e.data);
    return [...out].map(([path, data]) => ({ path, id: path.slice(path.lastIndexOf('/') + 1), data })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private writing(): void { if (!this.t) throw new Error('A write needs a transaction'); }

  /** Writes a whole document. `data` must be a new object, not one handed out by a read and then changed. */
  set(path: string, data: Doc): void { this.writing(); this.appends.delete(path); this.docs.set(path, { data, dirty: true }); }
  del(path: string): void { this.writing(); this.appends.delete(path); this.docs.set(path, { data: null, dirty: true }); }

  /** Adds an entry to the end of a list held in a document, creating the document if need be. No read. */
  append(path: string, field: string, item: unknown): void {
    this.writing();
    const seen = this.docs.get(path);
    if (seen) { this.docs.set(path, { data: { ...(seen.data ?? {}), [field]: [...((seen.data?.[field] as unknown[] | undefined) ?? []), item] }, dirty: true }); return; }
    const more = this.appends.get(path);
    if (more) more.items.push(item); else this.appends.set(path, { field, items: [item] });
  }

  /** Splits a payload into chunk documents `${owner}/chunks/${prefix}${i}` and returns how many. */
  stage(owner: string, prefix: string, bytes: Buffer): number {
    this.writing();
    let n = 0;
    for (let at = 0; at < bytes.length; at += CHUNK_BYTES) this.staged.push({ path: `${owner}/chunks/${prefix}${n++}`, data: bytes.subarray(at, at + CHUNK_BYTES) });
    return n;
  }
  /** Reads a payload back from its chunk documents. */
  async blob(owner: string, prefix: string, chunks: number): Promise<Buffer> {
    const parts = await this.raw(Array.from({ length: chunks }, (_, i) => `${owner}/chunks/${prefix}${i}`));
    if (parts.some((p) => !p)) throw new MissingChunk(`A stored payload of ${owner} is incomplete`);
    return Buffer.concat(parts.map((p) => p!.d as Buffer));
  }
  static chunkPaths(owner: string, prefix: string, chunks: number): string[] {
    return Array.from({ length: chunks }, (_, i) => `${owner}/chunks/${prefix}${i}`);
  }

  /** Whether this transaction has anything to write. */
  hasWrites(): boolean {
    return this.appends.size > 0 || this.staged.length > 0 || this.cleanup.length > 0 || [...this.docs.values()].some((e) => e.dirty);
  }

  /** Hands every pending write to the Firestore transaction (uploading large payloads first). */
  async commit(): Promise<void> {
    const t = this.t!;
    this.store.stats.writes += this.staged.length;
    if (this.staged.reduce((n, c) => n + c.data.length, 0) <= UPLOAD_BYTES) {
      for (const c of this.staged) t.set(this.ref(c.path), { d: c.data });
    } else {
      let batch = this.store.db.batch(), size = 0, held: string[] = [];
      const flush = async (): Promise<void> => {
        if (held.length === 0) return;
        await batch.commit();
        this.uploaded.push(...held);
        batch = this.store.db.batch(); size = 0; held = [];
      };
      for (const c of this.staged) {
        if (size + c.data.length > UPLOAD_BYTES) await flush();
        batch.set(this.ref(c.path), { d: c.data });
        size += c.data.length; held.push(c.path);
      }
      await flush();
    }
    for (const path of this.cleanup) { t.delete(this.ref(path)); this.store.stats.deletes++; }

    for (const [path, e] of this.docs) {
      if (!e.dirty) continue;
      if (e.data) { t.set(this.ref(path), e.data); this.store.stats.writes++; } else { t.delete(this.ref(path)); this.store.stats.deletes++; }
    }
    for (const [path, a] of this.appends) { t.set(this.ref(path), { [a.field]: FieldValue.arrayUnion(...a.items) }, { merge: true }); this.store.stats.writes++; }
  }
}

// ---------- the operations ----------

/** Every operation of StoreTx, written once against a Session: a transaction's, or a plain read's. */
class FsOps implements StoreTx {
  s: Session;
  constructor(s: Session) { this.s = s; }

  private async work(id: string): Promise<WorkDoc | null> { return await this.s.get(`works/${id}`) as WorkDoc | null; }
  private async source(key: string): Promise<SourceDoc | null> { return await this.s.get(`sources/${key}`) as SourceDoc | null; }

  /** The next number of a counter document, raised in this transaction. */
  private async nextId(counter: string): Promise<number> {
    const c = await this.s.get(`counters/${counter}`);
    const id = (c?.next as number | undefined) ?? 1;
    this.s.set(`counters/${counter}`, { next: id + 1 });
    return id;
  }

  // ---------- accounts ----------

  private async userWhere(field: string, value: string): Promise<UserRecord | null> {
    const found = await this.s.query('users', field, '==', value);
    return found.length > 0 ? userRecord(found[0].data) : null;
  }
  async userById(id: number): Promise<UserRecord | null> {
    const u = await this.s.get(`users/${id}`);
    return u ? userRecord(u) : null;
  }
  async userByEmail(email: string): Promise<UserRecord | null> { return this.userWhere('email', email); }
  async userByArtistId(artistId: string): Promise<UserRecord | null> { return this.userWhere('artistId', artistId); }

  async emailsWithAccount(emails: string[]): Promise<string[]> {
    const asked = unique(emails).filter(Boolean);
    const have = new Set<string>();
    for (let i = 0; i < asked.length; i += 30)
      for (const u of await this.s.query('users', 'email', 'in', asked.slice(i, i + 30))) have.add(u.data.email as string);
    return asked.filter((e) => have.has(e));
  }

  async createUser(user: NewUser): Promise<UserRecord> {
    // The two things SQLite's unique indexes refuse.
    if (await this.userByEmail(user.email)) throw new Error('That email already has an account');
    if (await this.userByArtistId(user.artistId)) throw new Error('That Artist ID is already taken');
    const id = await this.nextId('users');
    const doc = { id, email: user.email, passHash: user.passHash, passSalt: user.passSalt, artistId: user.artistId, artistName: user.artistName, legalName: user.legalName,
      role: 'Artist', pro: '', ipi: '', publisher: '', publisherIpi: '', isni: '', phone: '', createdAt: user.createdAt };
    this.s.set(`users/${id}`, doc);
    return userRecord(doc);
  }

  async updateProfile(userId: number, p: Profile): Promise<UserRecord> {
    const before = await this.s.get(`users/${userId}`);
    if (!before) throw new Error(`There is no account ${userId}`);
    const after = { ...before, artistName: p.artistName, legalName: p.legalName, role: p.role, pro: p.pro, ipi: p.ipi, publisher: p.publisher, publisherIpi: p.publisherIpi, isni: p.isni, phone: p.phone };
    this.s.set(`users/${userId}`, after);
    // Draft sheets that name this account follow the profile. Sent and signed sheets stay as approved.
    for (const found of await this.s.query('works', 'sheetEmails', 'array-contains', before.email)) {
      const w = found.data as WorkDoc;
      if (w.status !== 'draft') continue;
      this.s.set(found.path, { ...w, splitVersion: w.splitVersion + 1, people: w.people.map((r) => (r.email === before.email
        ? { ...r, artistName: p.artistName, legalName: p.legalName, pro: p.pro, ipi: p.ipi, publisher: p.publisher, publisherIpi: p.publisherIpi } : r)) });
    }
    // Each project carries its uploader's artist name, so reading a song's projects needs no account lookups.
    if (before.artistName !== p.artistName)
      for (const found of await this.s.query('sources', 'userId', '==', userId)) this.s.set(found.path, { ...found.data, uploaderName: p.artistName });
    return userRecord(after);
  }

  async deleteAccount(userId: number, ownedWorkIds: string[]): Promise<void> {
    for (const id of ownedWorkIds) await this.deleteWork(id);
    // As in SQLite, an account that still owns a song cannot go.
    if ((await this.s.query('works', 'ownerId', '==', userId)).length > 0) throw new Error('This account still owns songs');
    for (const found of await this.s.query('works', 'createdBy', '==', userId)) {
      const w = found.data as WorkDoc;
      this.s.set(found.path, indexed({ ...w, createdBy: w.ownerId }));
    }
    for (const found of await this.s.query('works', 'msgUserIds', 'array-contains', userId)) {
      for (const page of await this.s.query(`${found.path}/messagePages`)) {
        const all = (page.data.messages ?? []) as Doc[];
        if (all.some((m) => m.userId === userId)) this.s.set(page.path, { ...page.data, messages: all.filter((m) => m.userId !== userId) });
      }
      const w = (await this.work(found.id))!;
      this.s.set(found.path, { ...w, msgUserIds: w.msgUserIds.filter((u) => u !== userId) });
    }
    for (const found of await this.s.query('sessions', 'userId', '==', userId)) this.s.del(found.path);
    for (const found of await this.s.query('pluginKeys', 'userId', '==', userId)) this.s.del(found.path);
    for (const found of await this.s.query('sources', 'userId', '==', userId)) await this.removeSource(userId, found.data.projectId as string);
    this.s.del(`users/${userId}`);
  }

  // ---------- sign-ins ----------

  async createSession(tokenHash: string, userId: number, expiresAt: number): Promise<void> {
    if (await this.s.get(`sessions/${tokenHash}`)) throw new Error('That sign-in already exists');
    this.s.set(`sessions/${tokenHash}`, { userId, expiresAt, expireAt: Timestamp.fromMillis(expiresAt) });
  }
  async userBySession(tokenHash: string, now: number): Promise<UserRecord | null> {
    const session = await this.s.get(`sessions/${tokenHash}`);
    return session && session.expiresAt > now ? this.userById(session.userId as number) : null;
  }
  async deleteSession(tokenHash: string): Promise<void> { this.s.del(`sessions/${tokenHash}`); }

  // ---------- plugin keys ----------

  async pluginKeysOf(userId: number): Promise<PluginKeyRecord[]> {
    return (await this.s.query('pluginKeys', 'userId', '==', userId)).map((f) => f.data)
      .map((k) => ({ id: k.id as number, userId: k.userId as number, name: k.name as string, token: k.token as string, createdAt: k.createdAt as number, lastUsedAt: (k.lastUsedAt as number | null) ?? null }))
      .sort((a, b) => a.id - b.id);
  }
  async createPluginKey(userId: number, name: string, token: string, tokenHash: string, createdAt: number): Promise<void> {
    const id = await this.nextId('pluginKeys');
    this.s.set(`pluginKeys/${id}`, { id, userId, name, token, tokenHash, createdAt, lastUsedAt: null });
  }
  async deletePluginKey(userId: number, keyId: number): Promise<void> {
    const k = await this.s.get(`pluginKeys/${keyId}`);
    if (k && k.userId === userId) this.s.del(`pluginKeys/${keyId}`);
  }
  async userByPluginKey(tokenHash: string): Promise<{ user: UserRecord; keyId: number } | null> {
    const found = await this.s.query('pluginKeys', 'tokenHash', '==', tokenHash);
    const user = found.length > 0 ? await this.userById(found[0].data.userId as number) : null;
    return user ? { user, keyId: found[0].data.id as number } : null;
  }
  async touchPluginKey(keyId: number, at: number): Promise<void> {
    const k = await this.s.get(`pluginKeys/${keyId}`);
    if (k) this.s.set(`pluginKeys/${keyId}`, { ...k, lastUsedAt: at });
  }

  // ---------- songs ----------

  async workById(id: string): Promise<WorkRecord | null> {
    const w = await this.work(id);
    return w ? workRecord(w) : null;
  }
  async workBySongCode(songCode: string): Promise<WorkRecord | null> {
    const found = await this.s.query('works', 'songCode', '==', songCode);
    return found.length > 0 ? workRecord(found[0].data as WorkDoc) : null;
  }
  async workVisibleTo(viewer: Viewer, id: string): Promise<WorkRecord | null> {
    const w = await this.work(id);
    return w && visibleTo(w, viewer) ? workRecord(w) : null;
  }
  private async visibleDocs(viewer: Viewer): Promise<WorkDoc[]> {
    return (await this.s.query('works', 'viewers', 'array-contains-any', [`u${viewer.id}`, `e${viewer.email}`])).map((f) => f.data as WorkDoc);
  }
  async worksVisibleTo(viewer: Viewer): Promise<WorkRecord[]> {
    return (await this.visibleDocs(viewer)).sort((a, b) => b.updatedAt - a.updatedAt).map(workRecord);
  }
  async worksOwnedBy(userId: number): Promise<WorkRecord[]> {
    return (await this.s.query('works', 'ownerId', '==', userId)).map((f) => workRecord(f.data as WorkDoc));
  }

  async createWork(work: NewWork, people: PersonInput[]): Promise<void> {
    this.s.set(`works/${work.id}`, indexed({
      id: work.id, ownerId: work.ownerId, createdBy: work.createdBy, ownerStated: work.ownerStated, songCode: work.songCode, title: work.title, album: work.album,
      status: 'draft', shared: false, isrc: '', iswc: '', splitVersion: 1, createdAt: work.createdAt, updatedAt: work.createdAt,
      people: people.map(personDoc), sheetEmails: [], viewers: [], sourceKeys: [], sourceSeq: 0,
      ev: { ...newHead(), hash: '' }, recent: [], msg: newHead(), msgUserIds: [],
    }));
  }

  /** Changes a song, if it exists (as an SQL UPDATE would), and keeps its lookup fields right. */
  private async change(id: string, fn: (w: WorkDoc) => WorkDoc): Promise<void> {
    const w = await this.work(id);
    if (w) this.s.set(`works/${id}`, indexed(fn(w)));
  }

  async updateWorkDetails(id: string, details: { title?: string; album?: string; isrc?: string; iswc?: string }): Promise<void> {
    const columns = (['title', 'album', 'isrc', 'iswc'] as const).filter((c) => details[c] !== undefined);
    if (columns.length === 0) return;
    await this.change(id, (w) => { const next = { ...w }; for (const c of columns) next[c] = details[c]!; return next; });
  }
  async setWorkOwner(id: string, ownerId: number): Promise<void> { await this.change(id, (w) => ({ ...w, ownerId, ownerStated: true })); }
  async markSent(id: string): Promise<void> { await this.change(id, (w) => ({ ...w, status: 'sent', shared: true })); }
  async markSigned(id: string): Promise<void> { await this.change(id, (w) => ({ ...w, status: 'signed' })); }

  async deleteWork(id: string): Promise<void> {
    const w = await this.work(id);
    if (!w) return;
    this.s.del(`works/${id}`);
    if (w.ev.count > 0) for (let p = 0; p <= w.ev.page; p++) this.s.del(`works/${id}/eventPages/${pad(p)}`);
    if (w.msg.count > 0) for (let p = 0; p <= w.msg.page; p++) this.s.del(`works/${id}/messagePages/${pad(p)}`);
    for (const key of w.sourceKeys) await this.dropSource(key);
    for (const f of await this.s.query(`works/${id}/fingerprints`)) {
      this.s.del(f.path);
      this.s.cleanup.push(...Session.chunkPaths(f.path, `${f.data.gen}-`, f.data.chunks as number));
    }
    for (const h of await this.s.query('syncHistory', 'workId', '==', id)) this.s.del(h.path);
  }

  // ---------- split sheets ----------

  async peopleOf(workId: string): Promise<PersonRecord[]> {
    const w = await this.work(workId);
    return (w?.people ?? []).map((p, position) => ({ ...p, workId, position }));
  }
  async personOnSheet(workId: string, email: string, artistId: string): Promise<boolean> {
    const w = await this.work(workId);
    return !!w && w.people.some((p) => p.email === email || p.artistId === artistId);
  }
  async writePeople(workId: string, rows: PersonInput[]): Promise<void> {
    // Any change withdraws earlier approvals: people approve the sheet as it stands, not an older one.
    await this.change(workId, (w) => ({ ...w, people: rows.map(personDoc), status: 'draft', splitVersion: w.splitVersion + 1 }));
  }
  async setDecisions(workId: string, personIds: number[], decision: Decision, at: number): Promise<void> {
    await this.change(workId, (w) => ({ ...w, people: w.people.map((p) => (personIds.includes(p.id) ? { ...p, decision, decidedAt: at } : p)) }));
  }
  async setPeopleSeconds(workId: string, entries: { artistName: string; seconds: number }[]): Promise<void> {
    await this.change(workId, (w) => {
      let people = w.people;
      for (const e of entries) people = people.map((p) => (p.artistName === e.artistName ? { ...p, seconds: e.seconds } : p));
      return { ...w, people };
    });
  }

  // ---------- messages and history ----------

  async messagesOf(workId: string): Promise<MessageRecord[]> {
    const all = (await this.s.query(`works/${workId}/messagePages`)).flatMap((p) => (p.data.messages ?? []) as Doc[]).sort((a, b) => a.id - b.id);
    const ids = unique(all.map((m) => m.userId as number));
    const authors = new Map((await this.s.getMany(ids.map((id) => `users/${id}`))).map((u, i) => [ids[i], u]));
    return all.filter((m) => authors.get(m.userId)).map((m) => ({ id: m.id, userId: m.userId, authorName: authors.get(m.userId)!.artistName, body: m.body, createdAt: m.createdAt }));
  }
  async addMessage(workId: string, userId: number, body: string, at: number): Promise<void> {
    const w = await this.work(workId);
    if (!w) throw new Error(`There is no song ${workId} to add a message to`);
    const item = { id: await this.nextId('messages'), userId, body, createdAt: at };
    const { page, head } = advance(w.msg, item);
    this.s.append(`works/${workId}/messagePages/${pad(page)}`, 'messages', item);
    this.s.set(`works/${workId}`, { ...w, updatedAt: at, msg: head, msgUserIds: unique([...w.msgUserIds, userId]) });
  }
  async eventsOf(workId: string): Promise<EventRecord[]> {
    return (await this.s.query(`works/${workId}/eventPages`)).flatMap((p) => (p.data.events ?? []) as Doc[])
      .map((e) => ({ time: e.time, type: e.type, text: e.text, hash: e.hash }));
  }
  async appendEvent(workId: string, type: string, text: string): Promise<void> {
    // The head of the chain is on the song, which this transaction has read (or made): no query.
    const w = await this.work(workId);
    if (!w) throw new Error(`There is no song ${workId} to add history to`);
    const time = Date.now();
    const hash = eventHash(w.ev.hash || eventGenesis(workId), time, type, text);
    const item = { time, type, text, hash };
    const { page, head } = advance(w.ev, item);
    this.s.append(`works/${workId}/eventPages/${pad(page)}`, 'events', item);
    this.s.set(`works/${workId}`, { ...w, updatedAt: time, ev: { ...head, hash }, recent: [...w.recent, { seq: w.ev.count, time, text }].slice(-RECENT) });
  }
  async activityVisibleTo(viewer: Viewer, limit: number): Promise<ActivityRecord[]> {
    const all: { workTitle: string; time: number; text: string; seq: number; workId: string }[] = [];
    for (const w of await this.visibleDocs(viewer)) {
      let lines = w.recent;
      // More was asked for than a song keeps to hand: read its whole history.
      if (limit > lines.length && w.ev.count > lines.length) lines = (await this.eventsOf(w.id)).map((e, seq) => ({ seq, time: e.time, text: e.text }));
      for (const e of lines) all.push({ workTitle: w.title, time: e.time, text: e.text, seq: e.seq, workId: w.id });
    }
    all.sort((a, b) => b.time - a.time || (a.workId === b.workId ? b.seq - a.seq : a.workId < b.workId ? -1 : 1));
    return all.slice(0, Math.max(0, limit)).map((e) => ({ workTitle: e.workTitle, time: e.time, text: e.text }));
  }

  // ---------- projects feeding songs ----------

  async findSource(userId: number, projectId: string): Promise<SourceRecord | null> {
    const s = await this.source(sourceKey(userId, projectId));
    return s ? sourceRecord(s) : null;
  }
  async sourcesOfWork(workId: string): Promise<SourceRecord[]> {
    // A song that has been read here already lists its projects, which are then fetched by id (often already read too).
    const all = this.s.has(`works/${workId}`)
      ? (await this.s.getMany(((await this.work(workId))?.sourceKeys ?? []).map((k) => `sources/${k}`))).filter((d) => !!d) as SourceDoc[]
      : (await this.s.query('sources', 'workId', '==', workId)).map((f) => f.data as SourceDoc);
    return all.sort((a, b) => a.linkedAt - b.linkedAt || a.seq - b.seq).map(sourceRecord);
  }
  async addSource(n: NewSource): Promise<void> {
    const key = sourceKey(n.userId, n.projectId);
    if (await this.source(key)) throw new Error('That project is already linked for this account');
    const w = await this.work(n.workId), u = await this.s.get(`users/${n.userId}`);
    if (!w || !u) throw new Error('A project can only be linked to a song and an account that exist');
    this.s.set(`sources/${key}`, { userId: n.userId, projectId: n.projectId, workId: n.workId, via: n.via, chainOk: true, chainHead: '', linkedAt: n.at, syncedAt: n.at,
      seq: w.sourceSeq, uploaderName: u.artistName, blob: null });
    this.s.set(`works/${n.workId}`, indexed({ ...w, sourceKeys: [...w.sourceKeys, key], sourceSeq: w.sourceSeq + 1 }));
  }
  async setSourceVia(userId: number, projectId: string, via: string): Promise<void> {
    const key = sourceKey(userId, projectId), s = await this.source(key);
    if (s) this.s.set(`sources/${key}`, { ...s, via });
  }
  /** Deletes a project's record and its stored payloads. */
  private async dropSource(key: string): Promise<SourceDoc | null> {
    const s = await this.source(key);
    if (!s) return null;
    this.s.del(`sources/${key}`);
    if (s.blob) this.forget(key, s.blob);
    return s;
  }
  private forget(key: string, b: Blob): void {
    this.s.cleanup.push(...Session.chunkPaths(`sources/${key}`, `${b.gen}-e`, b.ev), ...Session.chunkPaths(`sources/${key}`, `${b.gen}-l`, b.log));
  }
  async removeSource(userId: number, projectId: string): Promise<void> {
    const key = sourceKey(userId, projectId), s = await this.dropSource(key);
    if (s) await this.change(s.workId, (w) => ({ ...w, sourceKeys: w.sourceKeys.filter((k) => k !== key) }));
  }
  async putSourceRecord(userId: number, projectId: string, p: SourcePayload): Promise<void> {
    const key = sourceKey(userId, projectId), s = await this.source(key);
    if (!s) return;
    // The new payload goes under a fresh name; the record is switched to it in the transaction,
    // and the one it replaces is removed afterwards. A reader sees one upload or the other, whole.
    const gen = randomBytes(6).toString('hex');
    const evidence = Buffer.from(JSON.stringify(p.evidence)), log = Buffer.from(JSON.stringify(p.log));
    const blob: Blob = { gen, ev: this.s.stage(`sources/${key}`, `${gen}-e`, evidence), log: p.log.length > 0 ? this.s.stage(`sources/${key}`, `${gen}-l`, log) : 0 };
    this.s.pending.set(`${key}|e`, evidence); this.s.pending.set(`${key}|l`, log);
    if (s.blob) this.forget(key, s.blob);
    this.s.set(`sources/${key}`, { ...s, chainOk: p.chainOk, chainHead: p.chainHead, syncedAt: p.syncedAt, blob });
  }
  async getSourceEvidence(userId: number, projectId: string): Promise<Evidence | null> {
    const key = sourceKey(userId, projectId), s = await this.source(key);
    if (!s) return null;
    if (!s.blob) return {} as Evidence;
    return JSON.parse((this.s.pending.get(`${key}|e`) ?? await this.s.blob(`sources/${key}`, `${s.blob.gen}-e`, s.blob.ev)).toString('utf8')) as Evidence;
  }
  async getSourceLog(userId: number, projectId: string): Promise<LogLine[]> {
    const key = sourceKey(userId, projectId), s = await this.source(key);
    if (!s?.blob || s.blob.log === 0) return [];
    return JSON.parse((this.s.pending.get(`${key}|l`) ?? await this.s.blob(`sources/${key}`, `${s.blob.gen}-l`, s.blob.log)).toString('utf8')) as LogLine[];
  }
  async addSyncHistory(h: SyncHistoryRecord): Promise<void> {
    // Ids sort in the order they were made (to the millisecond, then by this process's count).
    const id = `${String(Date.now()).padStart(14, '0')}-${pad(historyCount++ % 1_000_000)}-${randomBytes(3).toString('hex')}`;
    this.s.set(`syncHistory/${id}`, { workId: h.workId, userId: h.userId, projectId: h.projectId, syncedAt: h.syncedAt, chainHead: h.chainHead, chainOk: h.chainOk, summary: h.summary });
  }
  async syncHistoryOf(userId: number): Promise<SyncHistoryRecord[]> {
    return (await this.s.query('syncHistory', 'userId', '==', userId)).map((f) => f.data)
      .map((h) => ({ workId: h.workId, userId, projectId: h.projectId, syncedAt: h.syncedAt, chainHead: h.chainHead, chainOk: h.chainOk, summary: h.summary }));
  }

  // ---------- fingerprints ----------

  async putFingerprint(workId: string, info: FingerprintInfo, data: Uint8Array): Promise<void> {
    if (!await this.work(workId)) throw new Error(`There is no song ${workId} to keep a fingerprint for`);
    const path = `works/${workId}/fingerprints/${info.fpId}`;
    const old = await this.s.get(path);
    if (old) this.s.cleanup.push(...Session.chunkPaths(path, `${old.gen}-`, old.chunks as number));
    const gen = randomBytes(6).toString('hex');
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    this.s.set(path, { fpId: info.fpId, kind: info.kind, name: info.name, bounce: info.bounce, seconds: info.seconds, gen, chunks: this.s.stage(path, `${gen}-`, bytes), bytes: bytes.length });
  }
  async getFingerprint(workId: string, fpId: string): Promise<Uint8Array | null> {
    const path = `works/${workId}/fingerprints/${fpId}`;
    const meta = await this.s.get(path);
    return meta ? this.s.blob(path, `${meta.gen}-`, meta.chunks as number) : null;
  }
  async fingerprintsOf(workId: string): Promise<FingerprintInfo[]> {
    return (await this.s.query(`works/${workId}/fingerprints`)).map((f) => f.data)
      .map((f) => ({ fpId: f.fpId, kind: f.kind, name: f.name, bounce: f.bounce, seconds: f.seconds }));
  }
}

let historyCount = 0;

/** Operations that only read: on the store they run as plain reads, without a transaction. */
const READS: (keyof StoreTx)[] = ['userById', 'userByEmail', 'userByArtistId', 'emailsWithAccount', 'userBySession', 'pluginKeysOf', 'userByPluginKey',
  'workById', 'workBySongCode', 'workVisibleTo', 'worksVisibleTo', 'worksOwnedBy', 'peopleOf', 'personOnSheet', 'messagesOf', 'eventsOf', 'activityVisibleTo',
  'findSource', 'sourcesOfWork', 'getSourceEvidence', 'getSourceLog', 'syncHistoryOf', 'getFingerprint', 'fingerprintsOf'];
/** Operations that write: on the store each runs as a transaction of its own. */
const WRITES: (keyof StoreTx)[] = ['createUser', 'updateProfile', 'deleteAccount', 'createSession', 'deleteSession', 'createPluginKey', 'deletePluginKey', 'touchPluginKey',
  'createWork', 'updateWorkDetails', 'setWorkOwner', 'markSent', 'markSigned', 'deleteWork', 'writePeople', 'setDecisions', 'setPeopleSeconds', 'addMessage', 'appendEvent',
  'addSource', 'setSourceVia', 'removeSource', 'putSourceRecord', 'addSyncHistory', 'putFingerprint'];

const NOT_FOUND = 5, ALREADY_EXISTS = 6;

/**
 * The store the server is given. It offers every operation of StoreTx (declared just below, filled
 * in by the constructor) plus `transaction` and the sign-in rate limit.
 *
 * Called on the store, a reading operation is a plain read and a writing operation is a
 * transaction of its own. Inside `transaction`, operations go through the `tx` object.
 */
export interface FirestoreStore extends StoreTx {}
export class FirestoreStore implements Store {
  db: Firestore;
  namespace: string;
  /** The document everything of this environment lives under: envs/{namespace}. */
  root: DocumentReference;
  /** A rough count of what this store has asked of Firestore (documents read, written, deleted). */
  stats = { reads: 0, writes: 0, deletes: 0 };

  constructor(db: Firestore, namespace: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(namespace)) throw new Error('SPLIT_TRACKER_NAMESPACE must be letters, digits, "-" and "_" (at most 100, starting with a letter or digit).');
    this.db = db;
    this.namespace = namespace;
    this.root = db.collection('envs').doc(namespace);

    const self = this as unknown as Record<string, unknown>;
    const call = (ops: FsOps, name: string, args: unknown[]) => (ops as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name](...args);
    for (const name of READS) self[name] = (...args: unknown[]) => this.read((ops) => call(ops, name, args));
    for (const name of WRITES) self[name] = (...args: unknown[]) => this.transaction((tx) => call(tx as FsOps, name, args));

    // Three writes every request can make, done as one plain write each: no read, no transaction.
    this.createSession = async (tokenHash, userId, expiresAt) => {
      try { await this.root.collection('sessions').doc(tokenHash).create({ userId, expiresAt, expireAt: Timestamp.fromMillis(expiresAt) }); this.stats.writes++; } catch (e) {
        if ((e as { code?: number }).code === ALREADY_EXISTS) throw new Error('That sign-in already exists');
        throw e;
      }
    };
    this.deleteSession = async (tokenHash) => { await this.root.collection('sessions').doc(tokenHash).delete(); this.stats.deletes++; };
    this.touchPluginKey = async (keyId, at) => {
      try { await this.root.collection('pluginKeys').doc(String(keyId)).update({ lastUsedAt: at }); this.stats.writes++; } catch (e) {
        if ((e as { code?: number }).code !== NOT_FOUND) throw e;   // a key removed a moment ago: nothing to note
      }
    };
  }

  /** Opens the store the environment describes: credentials as `loadServiceAccount` finds them, namespace from SPLIT_TRACKER_NAMESPACE (default "prod"). */
  static open(env: NodeJS.ProcessEnv = process.env, namespace: string = env.SPLIT_TRACKER_NAMESPACE || 'prod'): FirestoreStore {
    return new FirestoreStore(connect(loadServiceAccount(env)), namespace);
  }

  private async read<T>(fn: (ops: FsOps) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await fn(new FsOps(new Session(this, null))); } catch (e) {
        // A payload replaced while it was being read: read again, from the record that now points at the new one.
        if (!(e instanceof MissingChunk) || attempt >= 4) throw e;
      }
    }
  }

  /**
   * Runs `fn` as one Firestore transaction.
   *
   * `fn` works on an overlay (Session): its reads go to Firestore through the transaction and are
   * remembered; its writes are only noted. When `fn` returns, the noted writes are handed to
   * Firestore together and committed. Firestore commits only if nothing `fn` read has changed since
   * it was read; otherwise it runs `fn` again from the start, on a fresh overlay, with fresh reads.
   * So the history chain (the last hash is on the song document, which every appendEvent reads) and
   * split_version cannot be built on a stale value, whatever else is happening at the same moment.
   *
   * `fn` may therefore run more than once. app.ts's callbacks are safe to run again: each makes its
   * decisions from what it reads through `tx`, and changes nothing outside itself until it returns.
   * An error `fn` throws (an HttpError, say) is not retried: the transaction is dropped and nothing is written.
   */
  async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const attempts: Session[] = [];
    try {
      const out = await this.db.runTransaction(async (t) => {
        const s = new Session(this, t);
        attempts.push(s);
        const result = await fn(new FsOps(s));
        // Nothing to write: leave the transaction (which releases what it read) rather than commit nothing.
        if (!s.hasWrites()) throw new NothingToWrite(result);
        await s.commit();
        return result;
      }, { maxAttempts: 8 });
      attempts.pop();
      await this.sweep(attempts.flatMap((a) => a.uploaded));
      return out;
    } catch (e) {
      if (e instanceof NothingToWrite) return e.result as T;
      await this.sweep(attempts.flatMap((a) => a.uploaded));
      throw e;
    }
  }

  /** Deletes chunks uploaded by an attempt that did not go through. A failure here loses nothing: it leaves unused chunks behind. */
  private async sweep(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    try {
      for (let i = 0; i < paths.length; i += 400) {
        const batch = this.db.batch();
        for (const p of paths.slice(i, i + 400)) batch.delete(this.db.doc(`${this.root.path}/${p}`));
        await batch.commit();
        this.stats.deletes += Math.min(400, paths.length - i);
      }
    } catch (e) {
      console.error('Could not remove unused payload chunks:', (e as Error).message);
    }
  }

  // ---------- sign-in rate limit: in Firestore, so it holds across serverless invocations ----------

  private failures(key: string): DocumentReference { return this.root.collection('loginFailures').doc(sha(key)); }

  async loginFailures(key: string, now: number): Promise<number> {
    const f = (await this.failures(key).get()).data();
    this.stats.reads++;
    return f && f.resetAt > now ? f.count as number : 0;
  }
  async recordLoginFailure(key: string, now: number, windowMs: number): Promise<void> {
    const ref = this.failures(key);
    await this.db.runTransaction(async (t) => {
      const f = (await t.get(ref)).data();
      const cur = f && f.resetAt > now ? { count: f.count as number, resetAt: f.resetAt as number } : { count: 0, resetAt: now + windowMs };
      t.set(ref, { count: cur.count + 1, resetAt: cur.resetAt, expireAt: Timestamp.fromMillis(cur.resetAt) });
    });
    this.stats.reads++; this.stats.writes++;
  }
  async clearLoginFailures(key: string): Promise<void> {
    await this.failures(key).delete();
    this.stats.deletes++;
  }

  // ---------- for tests ----------

  /** Deletes everything under this namespace. Only for test namespaces ("test-…"); returns how many documents went. */
  async deleteNamespace(): Promise<number> {
    if (!this.namespace.startsWith('test-')) throw new Error(`Refusing to delete the namespace "${this.namespace}": only test namespaces (test-…) are deleted this way.`);
    const writer = this.db.bulkWriter();
    let deleted = 0;
    writer.onWriteResult(() => { deleted++; });
    await this.db.recursiveDelete(this.root, writer);
    await writer.close();
    this.stats.reads += deleted; this.stats.deletes += deleted;
    return deleted;
  }
}

/** Closes every Firestore connection this process opened, so it can exit. */
export async function closeFirestore(): Promise<void> {
  const open = [...connections.values()];
  connections.clear();
  for (const c of open) await deleteApp(c.app);
}
