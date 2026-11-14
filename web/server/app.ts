/**
 * The Split Tracker web server: accounts, profiles, split sheets with approvals,
 * messages and a hash-chained history per song. Plain node:http, no framework.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import type { Activity, ArtistCard, Evidence, SourceInfo, FingerprintDetails, LogLine, Signature, Message, PluginKey, Profile, StoredFingerprint, User, WorkDetail, WorkEvent, WorkSummary } from '../src/core/api.ts';
import { makeArtistId, makeSongCode, normaliseArtistId, normaliseSongCode } from '../src/core/artistId.ts';
import { fullyApproved, hasShare, personStatus, sendProblem, type Decision, type Person, type WorkStatus } from '../src/core/splits.ts';
import { transaction, type Db, type Row } from './db.ts';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const SESSION_COOKIE = 'st_session';
const SESSION_DAYS = 30;
const MAX_BODY = 100_000;
const MAX_SYNC_BODY = 4_000_000, MAX_FINGERPRINT = 8_000_000, MAX_RECEIPT = 64_000_000;
const MIN_PASSWORD = 10;
const LOGIN_TRIES = 10, LOGIN_WINDOW_MS = 15 * 60_000;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

// ---------- input checks ----------

function text(v: unknown, field: string, max: number, required = false): string {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text`);
  const t = v.trim();
  if (required && !t) throw new HttpError(400, `${field} is required`);
  if (t.length > max) throw new HttpError(400, `${field} is too long`);
  return t;
}
function email(v: unknown, required: boolean): string {
  const e = text(v, 'Email', 254, required).toLowerCase();
  if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'Enter a valid email address');
  return e;
}
function percent(v: unknown, field: string): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new HttpError(400, `${field} must be between 0 and 100`);
  return Math.round(n * 100) / 100;
}

// ---------- rows to JSON ----------

const userJson = (u: Row): User => ({
  id: u.id, email: u.email, artistId: u.artist_id, artistName: u.artist_name, legalName: u.legal_name, role: u.role, pro: u.pro,
  ipi: u.ipi, publisher: u.publisher, publisherIpi: u.publisher_ipi, isni: u.isni, phone: u.phone,
});

export interface AppOptions {
  /** Built page to serve at "/". */
  pagePath?: string;
  /** Set when served over HTTPS so the session cookie is marked Secure. */
  secureCookies?: boolean;
}

export function createApp(db: Db, options: AppOptions = {}) {
  const failures = new Map<string, { count: number; resetAt: number }>();

  // ---------- Artist IDs ----------

  function newArtistId(): string {
    for (;;) {
      const id = makeArtistId(randomBytes(7));
      if (!db.prepare('SELECT 1 FROM users WHERE artist_id = ?').get(id)) return id;
    }
  }
  // Accounts made before Artist IDs existed get one now.
  for (const u of db.prepare('SELECT id FROM users WHERE artist_id IS NULL').all() as Row[])
    db.prepare('UPDATE users SET artist_id = ? WHERE id = ?').run(newArtistId(), u.id);

  function artistCard(raw: unknown): ArtistCard {
    const id = normaliseArtistId(typeof raw === 'string' ? raw : '');
    if (!id) throw new HttpError(400, 'That is not an Artist ID. It looks like ST-7K2Q-9FXM.');
    const u = db.prepare('SELECT * FROM users WHERE artist_id = ?').get(id) as Row | undefined;
    if (!u) throw new HttpError(404, 'No account has that Artist ID. They need to sign up first.');
    return { artistId: u.artist_id, artistName: u.artist_name, legalName: u.legal_name, role: u.role, pro: u.pro, ipi: u.ipi, publisher: u.publisher, publisherIpi: u.publisher_ipi, email: u.email };
  }

  // ---------- history ----------

  const genesis = (workId: string) => sha256(`GENESIS|${workId}`);
  const entryHash = (prev: string, time: number, type: string, body: string) => sha256(`${prev}|${time}|${type}|${body}`);

  function addEvent(workId: string, type: string, body: string): void {
    const last = db.prepare('SELECT hash FROM events WHERE work_id = ? ORDER BY id DESC LIMIT 1').get(workId) as Row | undefined;
    const time = Date.now();
    db.prepare('INSERT INTO events (work_id, time, type, text, hash) VALUES (?, ?, ?, ?, ?)')
      .run(workId, time, type, body, entryHash(last?.hash ?? genesis(workId), time, type, body));
    db.prepare('UPDATE works SET updated_at = ? WHERE id = ?').run(time, workId);
  }

  function chainIntact(workId: string, events: WorkEvent[]): boolean {
    let prev = genesis(workId);
    for (const e of events) {
      if (e.hash !== entryHash(prev, e.time, e.type, e.text)) return false;
      prev = e.hash;
    }
    return true;
  }

  // ---------- sessions ----------

  function startSession(res: ServerResponse, userId: number): void {
    const token = randomBytes(32).toString('base64url');
    const maxAge = SESSION_DAYS * 86_400;
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, Date.now() + maxAge * 1000);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${options.secureCookies ? '; Secure' : ''}`);
  }

  function sessionToken(req: IncomingMessage): string | null {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const [k, v] = part.trim().split('=');
      if (k === SESSION_COOKIE && v) return v;
    }
    return null;
  }

  function currentUser(req: IncomingMessage): Row | null {
    const token = sessionToken(req);
    if (!token) return null;
    const row = db.prepare(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
    ).get(sha256(token), Date.now()) as Row | undefined;
    return row ?? null;
  }

  function requireUser(req: IncomingMessage): Row {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'Sign in to continue');
    return u;
  }

  // ---------- works ----------

  /** Who may see a song: its owner, whoever started it, anyone whose own project feeds it, and,
      once it has been sent, anyone on its split sheet. For everyone else it does not exist. */
  const VISIBLE = `(w.owner_id = @uid OR w.created_by = @uid
      OR EXISTS (SELECT 1 FROM sources s WHERE s.work_id = w.id AND s.user_id = @uid)
      OR (w.shared = 1 AND EXISTS (SELECT 1 FROM people p WHERE p.work_id = w.id AND p.email = @email)))`;

  function visibleWork(user: Row, id: string): Row {
    const w = db.prepare(`SELECT * FROM works w WHERE w.id = @id AND ${VISIBLE}`).get({ id, uid: user.id, email: user.email }) as Row | undefined;
    if (!w) throw new HttpError(404, 'Song not found');
    return w;
  }

  /** The owner, and the person who started the song, may change it. */
  const manages = (user: Row, w: Row): boolean => w.owner_id === user.id || w.created_by === user.id;

  function newSongCode(): string {
    for (;;) {
      const code = makeSongCode(randomBytes(7));
      if (!db.prepare('SELECT 1 FROM works WHERE song_code = ?').get(code)) return code;
    }
  }
  // Songs made before song codes existed get one now.
  for (const w of db.prepare('SELECT id FROM works WHERE song_code IS NULL').all() as Row[])
    db.prepare('UPDATE works SET song_code = ? WHERE id = ?').run(newSongCode(), w.id);

  const peopleOf = (workId: string): Row[] =>
    db.prepare('SELECT * FROM people WHERE work_id = ? ORDER BY position').all(workId) as Row[];

  const shareOf = (p: Row) => hasShare({ writerShare: p.writer_share, masterShare: p.master_share });

  function summary(user: Row, w: Row, people = peopleOf(w.id)): WorkSummary {
    const mine = people.find((p) => p.email === user.email);
    const sent = w.status === 'sent';
    const owner = db.prepare('SELECT artist_name, artist_id FROM users WHERE id = ?').get(w.owner_id) as Row;
    return {
      id: w.id, title: w.title, album: w.album, status: w.status as WorkStatus, isOwner: manages(user, w),
      songCode: w.song_code, ownerName: owner.artist_name, ownerArtistId: owner.artist_id, ownerStated: !!w.owner_stated, youOwn: w.owner_id === user.id,
      people: people.map((p) => p.artist_name),
      yourWriterShare: mine ? mine.writer_share : null,
      awaiting: sent ? people.filter((p) => shareOf(p) && p.decision !== 'approved').length : 0,
      needsYou: sent && !!mine && mine.decision === 'none' && shareOf(mine),
      updatedAt: w.updated_at,
    };
  }

  const personJson = (w: Row, p: Row): Person => ({
    artistName: p.artist_name, legalName: p.legal_name, role: p.role, writerShare: p.writer_share, masterShare: p.master_share,
    email: p.email, status: personStatus(w.status, p.decision as Decision, shareOf(p)),
    hasAccount: !!p.email && !!db.prepare('SELECT 1 FROM users WHERE email = ?').get(p.email),
    artistId: p.artist_id, pro: p.pro, ipi: p.ipi, publisher: p.publisher, publisherIpi: p.publisher_ipi, terms: p.terms, seconds: p.seconds,
  });

  function detail(user: Row, w: Row): WorkDetail {
    const people = peopleOf(w.id);
    const messages: Message[] = (db.prepare(
      'SELECT m.id, m.body, m.created_at, m.user_id, u.artist_name FROM messages m JOIN users u ON u.id = m.user_id WHERE m.work_id = ? ORDER BY m.id',
    ).all(w.id) as Row[]).map((m) => ({ id: m.id, author: m.artist_name, mine: m.user_id === user.id, body: m.body, time: m.created_at }));
    const events = db.prepare('SELECT time, type, text, hash FROM events WHERE work_id = ? ORDER BY id').all(w.id) as unknown as WorkEvent[];
    const mine = people.find((p) => p.email === user.email);
    return {
      ...summary(user, w, people), rows: people.map((p) => personJson(w, p)), messages, events,
      isrc: w.isrc, iswc: w.iswc, splitVersion: w.split_version, sources: sourceList(w),
      yourDecision: mine ? (mine.decision as Decision) : null,
      chainIntact: chainIntact(w.id, events),
      evidence: evidenceOf(w.id),
    };
  }

  /** Writes a whole split sheet. Rows may name an account by Artist ID; that fixes the row's email. */
  interface RowIn { artistName: string; legalName: string; role: string; writerShare: number; masterShare: number; email: string; artistId: string; pro: string; ipi: string; publisher: string; publisherIpi: string; terms: string; seconds: number }
  function writePeople(workId: string, rows: RowIn[]): void {
    db.prepare('DELETE FROM people WHERE work_id = ?').run(workId);
    const insert = db.prepare(`INSERT INTO people (work_id, position, artist_name, legal_name, role, writer_share, master_share, email, artist_id, pro, ipi, publisher, publisher_ipi, terms, seconds)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const used = new Set<string>();
    rows.forEach((r, i) => {
      const account = r.artistId ? db.prepare('SELECT email, artist_id FROM users WHERE artist_id = ?').get(r.artistId) as Row | undefined
        : r.email ? db.prepare('SELECT email, artist_id FROM users WHERE email = ?').get(r.email) as Row | undefined : undefined;
      let address = account?.email ?? r.email;
      if (used.has(address)) address = '';   // nobody approves twice
      if (address) used.add(address);
      insert.run(workId, i, r.artistName, r.legalName, r.role, r.writerShare, r.masterShare, address, account?.artist_id ?? r.artistId, r.pro, r.ipi, r.publisher, r.publisherIpi, r.terms, r.seconds);
    });
    // Any change withdraws earlier approvals: people approve the sheet as it stands, not an older one.
    db.prepare("UPDATE works SET status = 'draft', split_version = split_version + 1 WHERE id = ?").run(workId);
  }

  const rowIn = (p: Row): RowIn => ({
    artistName: text(p?.artistName, 'Artist name', 80, true), legalName: text(p?.legalName, 'Legal name', 120),
    role: text(p?.role, 'Role', 60) || 'Other', writerShare: percent(p?.writerShare ?? 0, 'Writer share'), masterShare: percent(p?.masterShare ?? 0, 'Master share'),
    email: email(p?.email, false), artistId: normaliseArtistId(text(p?.artistId, 'Artist ID', 20)) ?? '',
    pro: text(p?.pro, 'PRO', 60), ipi: text(p?.ipi, 'IPI number', 40), publisher: text(p?.publisher, 'Publisher', 120),
    publisherIpi: text(p?.publisherIpi, 'Publisher IPI', 40), terms: text(p?.terms, 'Deal notes', 300),
    seconds: Math.max(0, Math.round(Number(p?.seconds) || 0)),
  });

  const fresh = (user: Row, id: string): WorkDetail => detail(user, visibleWork(user, id));

  function signIfComplete(workId: string): void {
    const people = peopleOf(workId);
    const done = fullyApproved(people.map((p) => ({ share: hasShare({ writerShare: p.writer_share, masterShare: p.master_share }), decision: p.decision as Decision })));
    if (!done) return;
    db.prepare("UPDATE works SET status = 'signed' WHERE id = ?").run(workId);
    addEvent(workId, 'SIGNED', 'Everyone with a share approved. The split sheet is signed.');
  }

  const describeSplit = (rows: { artistName: string; writerShare: number; masterShare: number }[]): string =>
    rows.map((r) => `${r.artistName} ${r.writerShare}/${r.masterShare}`).join(', ');

  // ---------- routes ----------

  type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; body: Row; raw: Buffer; params: string[] }) => unknown | Promise<unknown>;
  interface RouteOptions {
    /** 'key' routes are called by the plugin with a plugin key instead of a browser session. */
    auth?: 'session' | 'key';
    /** Take the body as bytes instead of JSON. */
    raw?: boolean;
    maxBody?: number;
  }
  const routes: { method: string; pattern: RegExp; handler: Handler; opts: RouteOptions }[] = [];
  const route = (method: string, pattern: RegExp, handler: Handler, opts: RouteOptions = {}) => routes.push({ method, pattern, handler, opts });

  route('GET', /^\/api\/health$/, () => ({ ok: true }));

  route('POST', /^\/api\/register$/, async ({ res, body }) => {
    const address = email(body.email, true);
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `Use a password of at least ${MIN_PASSWORD} characters`);
    if (password.length > 200) throw new HttpError(400, 'Password is too long');
    const artistName = text(body.artistName, 'Artist name', 80, true);
    const legalName = text(body.legalName, 'Legal name', 120, true);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(address)) throw new HttpError(409, 'That email already has an account. Sign in instead.');

    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt, 64);
    const info = db.prepare(
      'INSERT INTO users (email, pass_hash, pass_salt, artist_name, legal_name, created_at, artist_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(address, hash.toString('hex'), salt.toString('hex'), artistName, legalName, Date.now(), newArtistId());
    startSession(res, Number(info.lastInsertRowid));
    return userJson(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) as Row);
  });

  route('POST', /^\/api\/login$/, async ({ req, res, body }) => {
    const address = email(body.email, true);
    const password = typeof body.password === 'string' ? body.password : '';
    const key = `${address}|${req.socket.remoteAddress}`;
    const f = failures.get(key);
    if (f && f.resetAt > Date.now() && f.count >= LOGIN_TRIES) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');

    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(address) as Row | undefined;
    // Hash even when the account does not exist, so the reply takes the same time either way.
    const salt = u ? Buffer.from(u.pass_salt, 'hex') : Buffer.alloc(16);
    const hash = await scryptAsync(password.slice(0, 200), salt, 64);
    if (!u || !timingSafeEqual(hash, Buffer.from(u.pass_hash, 'hex'))) {
      const cur = f && f.resetAt > Date.now() ? f : { count: 0, resetAt: Date.now() + LOGIN_WINDOW_MS };
      cur.count++;
      failures.set(key, cur);
      throw new HttpError(401, 'Email or password is incorrect');
    }
    failures.delete(key);
    startSession(res, u.id);
    return userJson(u);
  });

  route('POST', /^\/api\/logout$/, ({ req, res }) => {
    const token = sessionToken(req);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return { ok: true };
  });

  route('GET', /^\/api\/me$/, ({ req }) => userJson(requireUser(req)));

  route('PUT', /^\/api\/profile$/, ({ req, body }) => {
    const u = requireUser(req);
    const p: Profile = {
      artistName: text(body.artistName, 'Artist name', 80, true), legalName: text(body.legalName, 'Legal name', 120, true),
      role: text(body.role, 'Role', 60) || 'Artist', pro: text(body.pro, 'PRO', 60), ipi: text(body.ipi, 'IPI number', 40),
      publisher: text(body.publisher, 'Publisher', 120), publisherIpi: text(body.publisherIpi, 'Publisher IPI', 40),
      isni: text(body.isni, 'ISNI', 40), phone: text(body.phone, 'Phone', 40),
    };
    db.prepare(
      'UPDATE users SET artist_name=?, legal_name=?, role=?, pro=?, ipi=?, publisher=?, publisher_ipi=?, isni=?, phone=? WHERE id=?',
    ).run(p.artistName, p.legalName, p.role, p.pro, p.ipi, p.publisher, p.publisherIpi, p.isni, p.phone, u.id);
    // Draft sheets that name this account follow the profile. Sent and signed sheets stay as approved.
    const drafts = db.prepare("SELECT DISTINCT p.work_id FROM people p JOIN works w ON w.id = p.work_id WHERE p.email = ? AND w.status = 'draft'").all(u.email) as Row[];
    db.prepare(`UPDATE people SET artist_name = ?, legal_name = ?, pro = ?, ipi = ?, publisher = ?, publisher_ipi = ?
                WHERE email = ? AND work_id IN (SELECT id FROM works WHERE status = 'draft')`).run(p.artistName, p.legalName, p.pro, p.ipi, p.publisher, p.publisherIpi, u.email);
    for (const d of drafts) db.prepare('UPDATE works SET split_version = split_version + 1 WHERE id = ?').run(d.work_id);
    return userJson(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id) as Row);
  });

  const visibleWorks = (u: Row): Row[] =>
    db.prepare(`SELECT * FROM works w WHERE ${VISIBLE} ORDER BY w.updated_at DESC`).all({ uid: u.id, email: u.email }) as Row[];

  route('GET', /^\/api\/works$/, ({ req }) => {
    const u = requireUser(req);
    return visibleWorks(u).map((w) => summary(u, w));
  });

  route('GET', /^\/api\/activity$/, ({ req }): Activity[] => {
    const u = requireUser(req);
    return (db.prepare(
      `SELECT e.time, e.text, w.title FROM events e JOIN works w ON w.id = e.work_id WHERE ${VISIBLE} ORDER BY e.id DESC LIMIT 12`,
    ).all({ uid: u.id, email: u.email }) as Row[]).map((e) => ({ work: e.title, time: e.time, text: e.text }));
  });

  route('POST', /^\/api\/works$/, ({ req, body }) => {
    const u = requireUser(req);
    const title = text(body.title, 'Title', 120, true);
    const album = text(body.album, 'Album', 120);
    // Optionally start from the split of another of your songs, so an album can share one split.
    let template: Row[] | null = null;
    if (body.copyFrom !== undefined && body.copyFrom !== '') {
      const source = visibleWork(u, text(body.copyFrom, 'Song to copy', 16));
      if (!manages(u, source)) throw new HttpError(403, 'You can only copy the split of a song you created');
      template = peopleOf(source.id);
    }
    const id = randomBytes(8).toString('hex');
    transaction(db, () => {
      const now = Date.now();
      db.prepare('INSERT INTO works (id, owner_id, created_by, song_code, title, album, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, u.id, u.id, newSongCode(), title, album, now, now);
      writePeople(id, template ? template.map((p) => ({ ...personJson({ status: 'draft' }, p), artistId: p.artist_id, seconds: 0 } as unknown as RowIn))
        : [ownRow(u)]);
      db.prepare('UPDATE works SET split_version = 1 WHERE id = ?').run(id);
      addEvent(id, 'CREATE', `${u.artist_name} created "${title}"${album ? ` on "${album}"` : ''}${template ? ', starting from the split of another song' : ''}`);
    });
    return fresh(u, id);
  });

  route('PUT', /^\/api\/works\/([0-9a-f]{16})$/, ({ req, body, params }) => {
    const u = requireUser(req);
    const w = visibleWork(u, params[0]);
    if (!manages(u, w)) throw new HttpError(403, 'Only the owner, or the person who started this song, can change its details');
    const title = text(body.title, 'Title', 120, true), album = text(body.album, 'Album', 120);
    const isrc = body.isrc === undefined ? w.isrc : text(body.isrc, 'ISRC', 20), iswc = body.iswc === undefined ? w.iswc : text(body.iswc, 'ISWC', 20);
    if (title !== w.title || album !== w.album || isrc !== w.isrc || iswc !== w.iswc) {
      db.prepare('UPDATE works SET title = ?, album = ?, isrc = ?, iswc = ? WHERE id = ?').run(title, album, isrc, iswc, w.id);
      addEvent(w.id, 'FILE', `${u.artist_name} filed this as "${title}"${album ? ` on "${album}"` : ' (single)'}${isrc ? `, ISRC ${isrc}` : ''}${iswc ? `, ISWC ${iswc}` : ''}`);
    }
    return fresh(u, w.id);
  });

  /** Says who owns the song. Until this is done nobody else's project can join it. */
  route('POST', /^\/api\/works\/([0-9a-f]{16})\/owner$/, ({ req, body, params }) => {
    const u = requireUser(req);
    const w = visibleWork(u, params[0]);
    setOwner(u, w, text(body.artistId, 'Artist ID', 20, true));
    // Someone who hands a song on, and is not otherwise part of it, can no longer open it.
    try { return fresh(u, w.id); } catch { return { handedOver: true }; }
  });

  route('DELETE', /^\/api\/works\/([0-9a-f]{16})$/, ({ req, body, params }) => {
    const u = requireUser(req);
    const w = visibleWork(u, params[0]);
    if (w.owner_id !== u.id) throw new HttpError(403, 'Only the owner can delete a song');
    if (w.status === 'signed') throw new HttpError(409, 'A signed split sheet is a record other people rely on, so it cannot be deleted');
    if (text(body.confirmTitle, 'Title', 120) !== w.title) throw new HttpError(400, 'Type the song title exactly to confirm');
    db.prepare('DELETE FROM works WHERE id = ?').run(w.id);
    return { ok: true };
  });

  route('GET', /^\/api\/works\/([0-9a-f]{16})$/, ({ req, params }) => fresh(requireUser(req), params[0]));

  route('PUT', /^\/api\/works\/([0-9a-f]{16})\/people$/, ({ req, body, params }) => {
    const u = requireUser(req);
    const w = visibleWork(u, params[0]);
    if (!manages(u, w)) throw new HttpError(403, 'Only the owner, or the person who started this song, can change the split');
    if (w.status === 'signed') throw new HttpError(409, 'This split sheet is signed and can no longer be changed');
    if (!Array.isArray(body.people) || body.people.length === 0 || body.people.length > 50) throw new HttpError(400, 'A split sheet needs between 1 and 50 people');
    const rows = (body.people as Row[]).map(rowIn);
    transaction(db, () => {
      writePeople(w.id, rows);
      addEvent(w.id, 'SPLIT', `${u.artist_name} set the split (writer/master): ${describeSplit(rows)}`);
    });
    return fresh(u, w.id);
  });

  route('POST', /^\/api\/works\/([0-9a-f]{16})\/send$/, ({ req, params }) => {
    const u = requireUser(req);
    const w = visibleWork(u, params[0]);
    if (!manages(u, w)) throw new HttpError(403, 'Only the owner, or the person who started this song, can send it for approval');
    if (w.status !== 'draft') throw new HttpError(409, w.status === 'signed' ? 'This split sheet is already signed' : 'This split sheet has already been sent');
    const rowsNow = detail(u, w).rows;
    const problem = sendProblem(rowsNow);
    if (problem) throw new HttpError(400, problem);
    // Everyone who has to approve must have an account, so the sheet has somewhere to go.
    const stranger = rowsNow.find((r) => hasShare(r) && !r.hasAccount);
    if (stranger) throw new HttpError(400, `${stranger.artistName} has not signed up yet. They need an account before this can be sent.`);

    transaction(db, () => {
      db.prepare("UPDATE works SET status = 'sent', shared = 1 WHERE id = ?").run(w.id);
      // Sending is the owner's own approval.
      db.prepare("UPDATE people SET decision = 'approved', decided_at = ? WHERE work_id = ? AND email = ?").run(Date.now(), w.id, u.email);
      addEvent(w.id, 'SEND', `${u.artist_name} sent the split sheet for approval`);
      signIfComplete(w.id);
    });
    return fresh(u, w.id);
  });

  route('POST', /^\/api\/works\/([0-9a-f]{16})\/decision$/, ({ req, body, params }) => {
    const u = requireUser(req);
    const w = visibleWork(u, params[0]);
    const decision = body.decision;
    if (decision !== 'approved' && decision !== 'declined') throw new HttpError(400, 'Choose approve or decline');
    if (w.status !== 'sent') throw new HttpError(409, w.status === 'signed' ? 'This split sheet is already signed' : 'This split sheet has not been sent for approval yet');
    const mine = db.prepare('SELECT * FROM people WHERE work_id = ? AND email = ?').get(w.id, u.email) as Row | undefined;
    if (!mine) throw new HttpError(403, 'You are not on this split sheet');

    transaction(db, () => {
      db.prepare('UPDATE people SET decision = ?, decided_at = ? WHERE id = ?').run(decision, Date.now(), mine.id);
      addEvent(w.id, decision === 'approved' ? 'APPROVE' : 'DECLINE',
        `${u.artist_name} (${u.legal_name}) ${decision} the split: writer ${mine.writer_share}%, master ${mine.master_share}%`);
      signIfComplete(w.id);
    });
    return fresh(u, w.id);
  });

  route('POST', /^\/api\/works\/([0-9a-f]{16})\/messages$/, ({ req, body, params }) => {
    const u = requireUser(req);
    const w = visibleWork(u, params[0]);
    const message = text(body.body, 'Message', 2000, true);
    db.prepare('INSERT INTO messages (work_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(w.id, u.id, message, Date.now());
    db.prepare('UPDATE works SET updated_at = ? WHERE id = ?').run(Date.now(), w.id);
    return fresh(u, w.id);
  });


  // ---------- plugin link ----------

  const keyJson = (k: Row): PluginKey => ({ id: k.id, name: k.name, key: k.token, createdAt: k.created_at, lastUsedAt: k.last_used_at ?? null });
  const keysOf = (userId: number): PluginKey[] =>
    (db.prepare('SELECT * FROM plugin_keys WHERE user_id = ? ORDER BY id').all(userId) as Row[]).map(keyJson);

  route('GET', /^\/api\/keys$/, ({ req }) => keysOf(requireUser(req).id));

  route('POST', /^\/api\/keys$/, ({ req, body }) => {
    const u = requireUser(req);
    const name = text(body.name, 'Name', 60) || 'My computer';
    if (keysOf(u.id).length >= 20) throw new HttpError(400, 'Remove an old key before adding another');
    const key = `stk_${randomBytes(32).toString('base64url')}`;
    db.prepare('INSERT INTO plugin_keys (user_id, name, token, token_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(u.id, name, key, sha256(key), Date.now());
    return { key, keys: keysOf(u.id) };
  });

  route('DELETE', /^\/api\/keys\/(\d+)$/, ({ req, params }) => {
    const u = requireUser(req);
    db.prepare('DELETE FROM plugin_keys WHERE id = ? AND user_id = ?').run(Number(params[0]), u.id);
    return keysOf(u.id);
  });

  function requireKeyUser(req: IncomingMessage): Row {
    const m = /^Bearer (stk_[A-Za-z0-9_-]{20,})$/.exec(req.headers.authorization ?? '');
    const row = m ? db.prepare(
      'SELECT u.*, k.id AS key_id FROM plugin_keys k JOIN users u ON u.id = k.user_id WHERE k.token_hash = ?',
    ).get(sha256(m[1])) as Row | undefined : undefined;
    if (!row) throw new HttpError(401, 'This plugin key is not valid. Create a new one on your Profile page.');
    db.prepare('UPDATE plugin_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), row.key_id);
    return row;
  }

  /** Which account this computer's plugin is linked to, so the plugin can show it. */
  route('GET', /^\/api\/plugin\/whoami$/, ({ req }) => {
    const u = requireKeyUser(req);
    return { artistName: u.artist_name, legalName: u.legal_name, email: u.email, artistId: u.artist_id };
  }, { auth: 'key' });

  /** The plugin looks up the person being added to a split sheet by their Artist ID. */
  route('GET', /^\/api\/plugin\/artists\/([^/]{1,40})$/, ({ req, params }) => {
    requireKeyUser(req);
    return artistCard(decodeURIComponent(params[0]));
  }, { auth: 'key' });

  route('GET', /^\/api\/artists\/([^/]{1,40})$/, ({ req, params }) => {
    requireUser(req);
    return artistCard(decodeURIComponent(params[0]));
  });

  const num = (v: unknown, max = 1e15): number => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0; };
  const hex64 = (v: unknown): string => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : '');
  const list = (v: unknown, max: number): Row[] => (Array.isArray(v) ? v.slice(0, max).filter((x) => x && typeof x === 'object') : []);
  const short = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  /** Recomputes the plugin's log chain exactly as the plugin does. */
  function pluginLogIntact(projectId: string, log: Row): { ok: boolean; head: string; entries: number } {
    const entries = list(log?.entries, 6000);
    let prev = hex64(log?.baseHash) || sha256(`GENESIS|${projectId}`);
    let ok = true;
    for (const e of entries) {
      const expected = sha256(`${prev}|${short(String(e.time ?? ''), 20)}|${short(e.type, 40)}|${typeof e.text === 'string' ? e.text : ''}`);
      if (e.hash !== expected) ok = false;
      prev = hex64(e.hash) || expected;
    }
    return { ok, head: prev, entries: entries.length };
  }

  // ---------- sources: the separate projects that feed one song ----------

  const sourceRows = (workId: string): Row[] => db.prepare(
    `SELECT s.*, u.artist_name FROM sources s JOIN users u ON u.id = s.user_id WHERE s.work_id = ? ORDER BY s.linked_at`,
  ).all(workId) as Row[];

  function sourceList(w: Row): SourceInfo[] {
    return sourceRows(w.id).map((r) => {
      const ev = JSON.parse(r.data) as Evidence;
      return { artistName: r.via ? r.via : r.artist_name, isOwner: !r.via && r.user_id === w.owner_id, receiptUploadedBy: r.via ? r.artist_name : undefined, syncedAt: r.synced_at, logIntact: !!r.chain_ok,
        logEntries: ev.logEntries ?? 0, tracks: ev.tracks?.length ?? 0, takes: ev.takes?.length ?? 0, bounces: ev.bounces?.length ?? 0 };
    });
  }

  /** Every project's record for a song, side by side. Nothing from one project replaces another's:
      each track, take and bounce is labelled with whose project it came from. */
  function evidenceOf(workId: string): Evidence | null {
    const rows = sourceRows(workId);
    if (rows.length === 0) return null;
    const w = db.prepare('SELECT owner_id FROM works WHERE id = ?').get(workId) as Row;
    const all = rows.map((r) => ({ r, ev: JSON.parse(r.data) as Evidence }));
    const lead = all.find((x) => x.r.user_id === w.owner_id) ?? all[0];
    const label = (x: { r: Row }) => (x.r.via ? `${x.r.via}'s offline receipt` : rows.length > 1 ? x.r.artist_name as string : undefined);
    return {
      syncedAt: Math.max(...all.map((x) => x.ev.syncedAt)),
      logIntact: all.every((x) => x.ev.logIntact),
      logEntries: all.reduce((t, x) => t + x.ev.logEntries, 0),
      chainHead: lead.ev.chainHead, splitsLocked: lead.ev.splitsLocked,
      sessionSeconds: all.reduce((t, x) => t + x.ev.sessionSeconds, 0),
      recordSeconds: all.reduce((t, x) => t + x.ev.recordSeconds, 0),
      playSeconds: all.reduce((t, x) => t + (x.ev.playSeconds ?? 0), 0),
      tracks: all.flatMap((x) => x.ev.tracks.map((t) => ({ ...t, source: label(x) }))),
      takes: all.flatMap((x) => x.ev.takes.map((t) => ({ ...t, source: label(x) }))),
      bounces: all.flatMap((x) => x.ev.bounces.map((b) => ({ ...b, source: label(x) }))),
      project: lead.ev.project ?? all.find((x) => x.ev.project)?.ev.project ?? null,
      projects: all.flatMap((x) => x.ev.projects ?? []),
      computers: all.flatMap((x) => x.ev.computers ?? []),
    };
  }

  const ownRow = (u: Row): RowIn => ({ artistName: u.artist_name, legalName: u.legal_name, role: u.role, writerShare: 100, masterShare: 100, email: u.email,
    artistId: u.artist_id, pro: u.pro, ipi: u.ipi, publisher: u.publisher, publisherIpi: u.publisher_ipi, terms: '', seconds: 0 });

  /** States the owner. The current owner may hand the song on; the person who started it may name the
      owner while nobody has yet. The owner must have an account. */
  function setOwner(u: Row, w: Row, rawId: string): void {
    const id = normaliseArtistId(rawId);
    if (!id) throw new HttpError(400, "That is not an Artist ID. The owner's ID looks like ST-7K2Q-9FXM.");
    const owner = db.prepare('SELECT * FROM users WHERE artist_id = ?').get(id) as Row | undefined;
    if (!owner) throw new HttpError(404, 'No account has that Artist ID. The owner needs to sign up first.');
    const allowed = w.owner_id === u.id || (w.created_by === u.id && !w.owner_stated);
    if (!allowed) throw new HttpError(403, w.owner_stated ? 'Only the current owner can hand this song to someone else' : 'Only the person who started this song can name its owner');
    if (w.status === 'signed' && owner.id !== w.owner_id) throw new HttpError(409, 'A signed song cannot change owner');
    if (owner.id === w.owner_id && w.owner_stated) return;
    db.prepare('UPDATE works SET owner_id = ?, owner_stated = 1 WHERE id = ?').run(owner.id, w.id);
    addEvent(w.id, 'OWNER', `${u.artist_name} stated that ${owner.artist_name} (${owner.legal_name}) owns this song`);
    w.owner_id = owner.id; w.owner_stated = 1;
  }

  /** The plugin holds no emails. Rows keep the email already entered here for the same person, and the
      person syncing is recognised by name; a row with an Artist ID is tied to that account instead. */
  function withEmails(contributors: RowIn[], before: Row[], u: Row): RowIn[] {
    const emails = new Map(before.filter((p) => p.email).map((p) => [String(p.artist_name).toLowerCase(), p.email as string]));
    const mine = [u.artist_name, u.legal_name].map((n: string) => n.toLowerCase());
    return contributors.map((c) => ({ ...c, email: c.artistId ? '' : emails.get(c.artistName.toLowerCase())
      ?? (mine.includes(c.artistName.toLowerCase()) || (c.legalName && mine.includes(c.legalName.toLowerCase())) ? u.email : '') }));
  }

  /** What the plugin gets back, so it can show and load the website's side of the song. */
  function siteState(u: Row, w: Row, conflict: boolean) {
    const owner = db.prepare('SELECT artist_name, artist_id FROM users WHERE id = ?').get(w.owner_id) as Row;
    return {
      songCode: w.song_code, title: w.title, album: w.album, isrc: w.isrc, iswc: w.iswc, status: w.status,
      ownerName: owner.artist_name, ownerArtistId: owner.artist_id, ownerStated: !!w.owner_stated,
      youManage: manages(u, w), splitVersion: w.split_version, conflict,
      projects: sourceRows(w.id).length,
      rows: peopleOf(w.id).map((p) => ({ artistId: p.artist_id, artistName: p.artist_name, legalName: p.legal_name, role: p.role, writerShare: p.writer_share,
        masterShare: p.master_share, pro: p.pro, ipi: p.ipi, publisher: p.publisher, publisherIpi: p.publisher_ipi, terms: p.terms,
        status: personStatus(w.status, p.decision as Decision, shareOf(p)) })),
    };
  }

  /**
   * The plugin sends what one DAW project recorded.
   *
   * - A project nobody has synced before starts a new song, or, when it carries a song code, joins
   *   that song as a further source. Each source keeps its own record.
   * - The split is taken from the plugin only from someone who manages the song, only while the
   *   sheet is a draft, and only if the plugin edited it since it last saw the website's version.
   * - The reply carries the website's state, so the plugin can show it and load it.
   */
  interface SyncOptions {
    /** Set when the record arrives as an offline receipt file uploaded on the website, not from a plugin. */
    receipt?: { madeBy: string };
    /** The project is being added to an existing song, so it must not rename it. */
    keepDetails?: boolean;
  }
  function syncProject(u: Row, body: Row, opts: SyncOptions = {}) {
    const via = opts.receipt?.madeBy ?? '';
    const actor = opts.receipt ? `An offline receipt from ${via}, uploaded by ${u.artist_name},` : `${u.artist_name}'s plugin`;
    const projectId = short(body.projectId, 80);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(projectId)) throw new HttpError(400, 'This project has no valid project id');
    const title = short(body.title, 120);
    const ownerId = short(body.ownerArtistId, 20), songCode = short(body.songCode, 20);

    const chain = pluginLogIntact(projectId, body.log as Row);
    const evidence: Evidence = {
      syncedAt: Date.now(), logIntact: chain.ok, logEntries: chain.entries, chainHead: chain.head,
      splitsLocked: body.splitsConfirmed === true,
      sessionSeconds: num(body.sessionSeconds), recordSeconds: num(body.recordSeconds), playSeconds: num(body.playSeconds),
      tracks: list(body.tracks, 500).map((t) => ({ trackName: short(t.trackName, 120), person: short(t.person, 80), signalSeconds: num(t.signalSeconds), recordSeconds: num(t.recordSeconds), takes: num(t.takes, 1e6) })),
      takes: list(body.takes, 5000).map((t) => ({ track: short(t.track, 120), person: short(t.person, 80), num: num(t.num, 1e6), time: num(t.time), durationSecs: num(t.durationSecs), songPos: num(t.songPos) })),
      bounces: list(body.bounces, 500).map((b) => ({
        num: num(b.num, 1e6), time: num(b.time), durationSecs: num(b.durationSecs), fpId: hex64(b.fpId), fileSha: hex64(b.fileSha), fileName: short(b.fileName, 200),
        stems: list(b.stems, 200).map((st) => ({ trackName: short(st.trackName, 120), person: short(st.person, 80), fpId: hex64(st.fpId) })),
      })),
      project: body.project && typeof body.project === 'object' && hex64((body.project as Row).sha)
        ? { fileName: short((body.project as Row).fileName, 200), sha: hex64((body.project as Row).sha), daw: short((body.project as Row).daw, 40), time: num((body.project as Row).time) } : null,
      projects: [],
      computers: list(body.machines, 50).map((m) => ({ name: short(m.name, 80), os: short(m.os, 60), firstSeen: num(m.firstSeen), lastSeen: num(m.lastSeen), opens: num(m.opens, 1e6) })),
    };
    // Every signature the log holds, so an older saved version of the project can still be recognised.
    for (const e of list((body.log as Row)?.entries, 6000)) {
      if (e.type !== 'PROJECT' || typeof e.text !== 'string') continue;
      const m = /(?:Signed project file |as last saved: )(.+?)(?: \(([^()]+)\))?: SHA-256 ([0-9a-f]{64})/.exec(e.text);
      if (m) evidence.projects.push({ fileName: m[1].slice(0, 200), daw: m[2] ?? '', sha: m[3], time: num(e.time) });
    }
    const contributors: RowIn[] = list(body.contributors, 50).filter((c) => short(c.artistName, 80)).map((c) => ({
      artistName: short(c.artistName, 80), legalName: short(c.legalName, 120), role: short(c.role, 60) || 'Other',
      writerShare: Math.min(100, Math.round(num(c.writerShare) * 100) / 100), masterShare: Math.min(100, Math.round(num(c.masterShare) * 100) / 100),
      email: '', artistId: normaliseArtistId(short(c.artistId, 20)) ?? '',
      pro: short(c.pro, 60), ipi: short(c.ipi, 40), publisher: short(c.publisher, 120), publisherIpi: short(c.publisherIpi, 40),
      terms: short(c.terms, 300), seconds: Math.round(num(c.seconds)),
    }));

    let conflict = false, created = false;
    let w!: Row;
    transaction(db, () => {
      const now = Date.now();
      const source = db.prepare('SELECT * FROM sources WHERE user_id = ? AND project_id = ?').get(u.id, projectId) as Row | undefined;
      let fresh = false;

      if (source) {
        w = db.prepare('SELECT * FROM works WHERE id = ?').get(source.work_id) as Row;
        // A receipt saved before the latest sync would put older records over newer ones.
        if (opts.receipt && chain.entries < ((JSON.parse(source.data) as Evidence).logEntries ?? 0))
          throw new HttpError(409, `The website already has a newer record of this project (in "${w.title}"). This receipt is older, so nothing was changed.`);
      } else if (songCode) {
        // A separate project joining an existing song.
        const code = normaliseSongCode(songCode);
        if (!code) throw new HttpError(400, 'That is not a song code. It looks like SG-4MPT-2K7H and is on the song\'s page on the website.');
        w = db.prepare('SELECT * FROM works WHERE song_code = ?').get(code) as Row;
        if (!w) throw new HttpError(404, 'No song has that code');
        if (!manages(u, w)) {
          const owner = db.prepare('SELECT artist_name, artist_id FROM users WHERE id = ?').get(w.owner_id) as Row;
          if (!w.owner_stated) throw new HttpError(409, 'The owner of this song has not been set yet. The person who started it sets the owner in Song details, or on the website, before anyone else can join.');
          if (normaliseArtistId(ownerId) !== owner.artist_id) throw new HttpError(409, "To join this song, enter its owner's Artist ID in Song details. It must match the owner set for the song.");
          const onSheet = db.prepare('SELECT 1 FROM people WHERE work_id = ? AND (email = ? OR artist_id = ?)').get(w.id, u.email, u.artist_id);
          if (!onSheet) throw new HttpError(403, `You are not on this song's split sheet yet. Ask ${owner.artist_name} to add you with your Artist ID ${u.artist_id}.`);
        }
        fresh = true;
        addEvent(w.id, 'JOIN', opts.receipt ? `${actor} added a separate project to this song` : `${u.artist_name}'s project joined this song as a separate source`);
      } else {
        // A new song. The owner is whoever the song details name; if they name nobody, it is not yet stated.
        let owner = u, stated = 0;
        if (ownerId) {
          const id = normaliseArtistId(ownerId);
          if (!id) throw new HttpError(400, "The owner's Artist ID in Song details is not valid. It looks like ST-7K2Q-9FXM.");
          const named = db.prepare('SELECT * FROM users WHERE artist_id = ?').get(id) as Row | undefined;
          if (!named) throw new HttpError(404, "No account has the owner's Artist ID. The owner needs to sign up first.");
          owner = named; stated = 1;
        }
        const id = randomBytes(8).toString('hex');
        db.prepare('INSERT INTO works (id, owner_id, created_by, owner_stated, song_code, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, owner.id, u.id, stated, newSongCode(), title || 'Untitled', now, now);
        addEvent(id, 'CREATE', `${actor} created "${title || 'Untitled'}"${stated ? `, owned by ${owner.artist_name}` : ''}`);
        writePeople(id, contributors.length > 0 ? withEmails(contributors, [], u) : [ownRow(owner)]);
        db.prepare('UPDATE works SET split_version = 1 WHERE id = ?').run(id);
        if (contributors.length > 0) addEvent(id, 'SPLIT', `Plugin set the split (writer/master): ${describeSplit(contributors)}`);
        w = db.prepare('SELECT * FROM works WHERE id = ?').get(id) as Row;
        fresh = true; created = true;
      }

      if (!source)
        db.prepare('INSERT INTO sources (user_id, project_id, work_id, linked_at, synced_at, via) VALUES (?, ?, ?, ?, ?, ?)').run(u.id, projectId, w.id, now, now, via);
      if (!opts.receipt) {
        // The project's own plugin is syncing now, so a receipt of the same project is no longer needed.
        if (source?.via) db.prepare("UPDATE sources SET via = '' WHERE user_id = ? AND project_id = ?").run(u.id, projectId);
        const replaced = db.prepare("DELETE FROM sources WHERE work_id = ? AND project_id = ? AND user_id != ? AND via != ''").run(w.id, projectId, u.id).changes;
        if (replaced > 0) addEvent(w.id, 'RECEIPT', `${u.artist_name}'s plugin now syncs this project itself, so its earlier offline receipt was replaced by the live record`);
      }

      const manager = manages(u, w);
      // The owner named in the plugin's song details, from someone entitled to say.
      if (manager && ownerId && source) {
        const allowed = w.owner_id === u.id || !w.owner_stated;
        if (allowed) setOwner(u, w, ownerId);
      }
      if (manager && !opts.keepDetails && !(fresh && !created)) {
        const isrc = short(body.isrc, 20), iswc = short(body.iswc, 20);
        const nextTitle = title && title !== 'Untitled' ? title : w.title;
        if (nextTitle !== w.title || (isrc && isrc !== w.isrc) || (iswc && iswc !== w.iswc))
          db.prepare('UPDATE works SET title = ?, isrc = ?, iswc = ? WHERE id = ?').run(nextTitle, isrc || w.isrc, iswc || w.iswc, w.id);
      }

      // The split. A plugin that has not edited it since it last saw the website's version changes nothing.
      const sp = (body.split && typeof body.split === 'object' ? body.split : null) as Row | null;
      const dirty = sp ? sp.dirty === true : true;               // older plugins always send their split
      const base = sp ? num(sp.baseVersion) : w.split_version;
      if (manager && (!fresh || (opts.receipt && !created)) && w.status === 'draft' && contributors.length > 0 && dirty) {
        const before = peopleOf(w.id);
        const key = (r: { artistName: string; legalName: string; role: string; writerShare: number; masterShare: number; artistId: string; pro: string; ipi: string; publisher: string; publisherIpi: string; terms: string }) =>
          [r.artistName, r.legalName, r.role, r.writerShare, r.masterShare, r.artistId, r.pro, r.ipi, r.publisher, r.publisherIpi, r.terms].join('|');
        const same = before.length === contributors.length && before.every((p, i) => {
          const c = contributors[i];
          // A row the plugin holds without an Artist ID still equals the stored row for that person.
          return key({ ...c, artistId: c.artistId || p.artist_id }) === key({ artistName: p.artist_name, legalName: p.legal_name, role: p.role, writerShare: p.writer_share,
            masterShare: p.master_share, artistId: p.artist_id, pro: p.pro, ipi: p.ipi, publisher: p.publisher, publisherIpi: p.publisher_ipi, terms: p.terms });
        });
        if (!same) {
          if (base === w.split_version || sp?.force === true) {
            writePeople(w.id, withEmails(contributors, before, u));
            addEvent(w.id, 'SPLIT', `${actor} set the split (writer/master): ${describeSplit(contributors)}`);
          } else {
            conflict = true;   // changed on the website as well; the plugin decides which to keep
          }
        }
      }
      // Session time per person is a fact about the session, not a change to the agreement.
      if (manager && contributors.length > 0)
        for (const c of contributors) db.prepare('UPDATE people SET seconds = ? WHERE work_id = ? AND artist_name = ?').run(c.seconds, w.id, c.artistName);

      const previous = db.prepare('SELECT chain_head, chain_ok FROM sources WHERE user_id = ? AND project_id = ?').get(u.id, projectId) as Row;
      const lines: LogLine[] = list((body.log as Row)?.entries, 6000).map((e) => ({ time: num(e.time), type: short(e.type, 40), text: short(e.text, 2000) }));
      db.prepare('UPDATE sources SET data = ?, log = ?, chain_ok = ?, chain_head = ?, synced_at = ? WHERE user_id = ? AND project_id = ?')
        .run(JSON.stringify(evidence), JSON.stringify(lines), chain.ok ? 1 : 0, chain.head, evidence.syncedAt, u.id, projectId);
      if (previous.chain_head !== chain.head || !!previous.chain_ok !== chain.ok) {
        const stems = evidence.bounces.reduce((t, b) => t + b.stems.length, 0);
        const summaryText = `${evidence.takes.length} takes, ${evidence.bounces.length} bounces, ${stems} stems`;
        db.prepare('INSERT INTO sync_history (work_id, user_id, project_id, synced_at, chain_head, chain_ok, summary) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(w.id, u.id, projectId, evidence.syncedAt, chain.head, chain.ok ? 1 : 0, summaryText);
        addEvent(w.id, 'PLUGIN', `${actor} ${opts.receipt ? 'brought' : 'synced'}: ${summaryText}. Plugin log ${chain.ok ? 'intact' : 'ALTERED'}, head ${chain.head.slice(0, 16)}`);
      }
      w = db.prepare('SELECT * FROM works WHERE id = ?').get(w.id) as Row;
    });

    const wanted = new Set(evidence.bounces.flatMap((b) => [b.fpId, ...b.stems.map((st) => st.fpId)]).filter(Boolean));
    for (const row of db.prepare('SELECT fp_id FROM fingerprints WHERE work_id = ?').all(w.id) as Row[]) wanted.delete(row.fp_id);
    return { workId: w.id, title: w.title, created, logIntact: chain.ok, missingFingerprints: [...wanted],
      account: { artistName: u.artist_name, artistId: u.artist_id }, site: siteState(u, w, conflict) };
  }

  route('POST', /^\/api\/plugin\/sync$/, ({ req, body }) => syncProject(requireKeyUser(req), body), { auth: 'key', maxBody: MAX_SYNC_BODY });

  /** Stores one fingerprint file. Its SHA-256 must be its id, and the id must be on a bounce of the song. */
  function storeFingerprint(workId: string, fpId: string, raw: Buffer): void {
    if (sha256(raw) !== fpId) throw new HttpError(400, 'The file does not match its fingerprint id');
    if (raw.length < 18 || raw.subarray(0, 6).toString('latin1') !== 'TBAFP1') throw new HttpError(400, 'Not a Split Tracker fingerprint file');
    const ev = evidenceOf(workId);
    let found: { kind: string; name: string; bounce: number } | null = null;
    for (const b of ev?.bounces ?? []) {
      if (b.fpId === fpId) found = { kind: 'Master', name: 'Master', bounce: b.num };
      for (const s of b.stems) if (s.fpId === fpId) found = { kind: 'Stem', name: s.person ? `${s.trackName} (${s.person})` : s.trackName, bounce: b.num };
    }
    if (!found) throw new HttpError(400, 'This fingerprint is not on any bounce of the song');
    const seconds = raw.readDoubleLE(6) * raw.readInt32LE(14);
    db.prepare('INSERT OR REPLACE INTO fingerprints (work_id, fp_id, kind, name, bounce, seconds, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(workId, fpId, found.kind, found.name, found.bounce, Number.isFinite(seconds) ? seconds : 0, raw);
  }

  /**
   * An offline receipt: the file the plugin saves when it cannot reach the website. It holds exactly
   * what a sync would have sent, plus the fingerprints. Whoever is signed in uploads it and chooses:
   *
   * - mode 'new': register it as a new song (or, if the receipt names a song that exists, add it there);
   * - mode 'add': add it to one of the songs they manage, as a separate project;
   * - iAmOwner: state themselves as the owner when the receipt names nobody;
   * - useSplit: replace a draft sheet's split with the one in the receipt.
   */
  route('POST', /^\/api\/receipts$/, ({ req, body }) => {
    const u = requireUser(req);
    const r = (body.receipt && typeof body.receipt === 'object' ? body.receipt : {}) as Row;
    if (r.format !== 'split-tracker-receipt' || typeof r.payload !== 'string') throw new HttpError(400, 'That is not a Split Tracker offline receipt. In the plugin: Evidence tab, "Save offline receipt".');
    if (r.version !== 1) throw new HttpError(400, 'This receipt was saved by a newer plugin than this website understands');
    if (sha256(r.payload) !== r.payloadSha256) throw new HttpError(400, 'This receipt file is damaged, or was changed after the plugin saved it. Ask for it to be saved and sent again.');
    let payload: Row;
    try { payload = JSON.parse(r.payload) as Row; } catch { throw new HttpError(400, 'This receipt file cannot be read'); }
    if (!payload || typeof payload !== 'object') throw new HttpError(400, 'This receipt file cannot be read');

    const projectId = short(payload.projectId, 80);
    const mine = db.prepare('SELECT work_id FROM sources WHERE user_id = ? AND project_id = ?').get(u.id, projectId) as Row | undefined;
    if (body.mode === 'add') {
      const w = db.prepare('SELECT * FROM works WHERE id = ?').get(short(body.workId, 16)) as Row | undefined;
      if (!w || !manages(u, w)) throw new HttpError(404, 'Choose one of the songs you manage');
      if (mine && mine.work_id !== w.id) {
        const other = db.prepare('SELECT title FROM works WHERE id = ?').get(mine.work_id) as Row;
        throw new HttpError(409, `This project is already part of "${other.title}". Upload it there, or register it as a new song.`);
      }
      payload.songCode = w.song_code;
    }
    else if (short(payload.songCode, 20)) {
      // A code for a song that is no longer on the website: register the project afresh.
      const code = normaliseSongCode(short(payload.songCode, 20));
      if (!code || !db.prepare('SELECT 1 FROM works WHERE song_code = ?').get(code)) payload.songCode = '';
    }
    if (body.iAmOwner === true && !short(payload.ownerArtistId, 20)) payload.ownerArtistId = u.artist_id;
    payload.split = { dirty: body.useSplit === true, baseVersion: 0, force: true };

    const madeBy = short(r.madeBy, 80) || short(r.computer, 80) || 'an unnamed computer';
    const out = syncProject(u, payload, { receipt: { madeBy }, keepDetails: body.mode === 'add' });

    let stored = 0;
    const wanted = new Set(out.missingFingerprints);
    const files = (r.fingerprints && typeof r.fingerprints === 'object' ? r.fingerprints : {}) as Record<string, unknown>;
    for (const id of wanted) {
      const b64 = files[id];
      if (typeof b64 !== 'string') continue;
      try { storeFingerprint(out.workId, id, Buffer.from(b64, 'base64')); stored++; } catch { /* a file that does not verify is left out */ }
    }
    return { workId: out.workId, title: out.title, created: out.created, logIntact: out.logIntact, fingerprints: stored, fingerprintsMissing: wanted.size - stored };
  }, { maxBody: MAX_RECEIPT });

  /** The plugin uploads one fingerprint file the sync reply asked for. Its SHA-256 must be the id on the receipt. */
  route('PUT', /^\/api\/plugin\/works\/([0-9a-f]{16})\/fingerprints\/([0-9a-f]{64})$/, ({ req, raw, params }) => {
    const u = requireKeyUser(req);
    const [workId, fpId] = params;
    // Anyone whose project feeds the song may upload that project's fingerprints.
    if (!db.prepare('SELECT 1 FROM sources WHERE work_id = ? AND user_id = ?').get(workId, u.id)) throw new HttpError(404, 'Song not found');
    storeFingerprint(workId, fpId, raw);
    return { ok: true };
  }, { auth: 'key', raw: true, maxBody: MAX_FINGERPRINT });

  route('GET', /^\/api\/signatures$/, ({ req }): Signature[] => {
    const u = requireUser(req);
    const out: Signature[] = [];
    for (const w of visibleWorks(u)) {
      const ev = evidenceOf(w.id);
      if (!ev) continue;
      const projects = ev.projects ?? [];
      projects.forEach((p, i) => out.push({ workId: w.id, title: w.title, kind: 'Project file', label: p.daw ? `${p.fileName} (${p.daw})` : p.fileName, sha: p.sha, time: p.time, latest: i === projects.length - 1 }));
      for (const b of ev.bounces) if (b.fileSha) out.push({ workId: w.id, title: w.title, kind: 'Sealed export', label: `Bounce ${b.num}`, sha: b.fileSha, time: b.time, latest: true });
    }
    return out;
  });

  route('GET', /^\/api\/fingerprints$/, ({ req }): StoredFingerprint[] => {
    const u = requireUser(req);
    const out: StoredFingerprint[] = [];
    for (const w of visibleWorks(u)) {
      const ev = evidenceOf(w.id);
      if (!ev) continue;
      const stored = new Map((db.prepare('SELECT fp_id, seconds FROM fingerprints WHERE work_id = ?').all(w.id) as Row[]).map((f) => [f.fp_id as string, f.seconds as number]));
      // Listed from the plugin's record, so two tracks with identical audio still appear as two stems.
      for (const b of [...ev.bounces].reverse()) {
        if (stored.has(b.fpId)) out.push({ workId: w.id, fpId: b.fpId, title: w.title, kind: 'Master', name: 'Master', track: '', bounce: b.num, seconds: stored.get(b.fpId)! });
        for (const st of b.stems)
          if (stored.has(st.fpId)) out.push({ workId: w.id, fpId: st.fpId, title: w.title, kind: 'Stem', name: st.person ? `${st.trackName} (${st.person})` : st.trackName, track: st.trackName, bounce: b.num, seconds: stored.get(st.fpId)! });
      }
    }
    return out;
  });

  /** One master or stem in full: where it came from, its takes, and only the log lines about it. */
  route('GET', /^\/api\/works\/([0-9a-f]{16})\/fingerprints\/([0-9a-f]{64})\/details$/, ({ req, params }): FingerprintDetails => {
    const w = visibleWork(requireUser(req), params[0]);
    const fpId = params[1];
    const trackName = new URL(req.url ?? '/', 'http://localhost').searchParams.get('track') ?? '';
    const ev = evidenceOf(w.id);
    const stored = db.prepare('SELECT seconds FROM fingerprints WHERE work_id = ? AND fp_id = ?').get(w.id, fpId) as Row | undefined;
    const bounce = ev?.bounces.find((b) => (trackName ? b.stems.some((st) => st.fpId === fpId && st.trackName === trackName) : b.fpId === fpId));
    if (!ev || !bounce) throw new HttpError(404, 'Nothing recorded for that fingerprint');
    // The log lines come from the project that made this fingerprint, not from the other collaborators' projects.
    const holder = sourceRows(w.id).find((r) => (JSON.parse(r.data) as Evidence).bounces?.some((b) => b.fpId === fpId || b.stems.some((st) => st.fpId === fpId)));
    const all = JSON.parse((holder?.log as string) ?? '[]') as LogLine[];
    const perTrack = new Set(['TRACK', 'REC', 'TAKE', 'STEM']);
    // The plugin writes track names in quotes, so a stem's lines are the ones naming its track;
    // the master gets everything about the song as a whole.
    const log = trackName ? all.filter((l) => l.text.includes(`"${trackName}"`)) : all.filter((l) => !perTrack.has(l.type));
    const track = trackName ? ev.tracks.find((t) => t.trackName === trackName) ?? null : null;
    const stem = bounce.stems.find((st) => st.fpId === fpId && st.trackName === trackName);
    return {
      kind: trackName ? 'Stem' : 'Master', title: w.title, album: w.album, fpId, seconds: stored?.seconds ?? bounce.durationSecs,
      bounce: { num: bounce.num, time: bounce.time, durationSecs: bounce.durationSecs, fileSha: bounce.fileSha },
      track: trackName ? track ?? { trackName, person: stem?.person ?? '', signalSeconds: 0, recordSeconds: 0, takes: 0 } : null,
      takes: trackName ? ev.takes.filter((t) => t.track === trackName).map(({ track: _t, ...rest }) => rest) : [],
      stems: trackName ? [] : bounce.stems.map((st) => ({ trackName: st.trackName, person: st.person })),
      log,
    };
  });

  route('GET', /^\/api\/works\/([0-9a-f]{16})\/fingerprints\/([0-9a-f]{64})$/, ({ req, params }) => {
    const w = visibleWork(requireUser(req), params[0]);
    const row = db.prepare('SELECT data FROM fingerprints WHERE work_id = ? AND fp_id = ?').get(w.id, params[1]) as Row | undefined;
    if (!row) throw new HttpError(404, 'Fingerprint not found');
    return Buffer.from(row.data as Uint8Array);
  });

  // ---------- your data ----------

  /** Everything held about the signed-in person, in one object (the right of access). */
  route('GET', /^\/api\/me\/export$/, ({ req }) => {
    const u = requireUser(req);
    return {
      exportedAt: new Date().toISOString(),
      profile: userJson(u),
      pluginKeys: keysOf(u.id).map((k) => ({ name: k.name, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })),
      songs: visibleWorks(u).map((w) => detail(u, w)),
      syncHistory: db.prepare('SELECT work_id, project_id, synced_at, chain_head, chain_ok, summary FROM sync_history WHERE user_id = ? ORDER BY id').all(u.id),
    };
  });

  /** Deletes the account. Songs that other people are on are theirs too, so those have to be dealt with first. */
  route('DELETE', /^\/api\/me$/, async ({ req, res, body }) => {
    const u = requireUser(req);
    const hash = await scryptAsync(typeof body.password === 'string' ? body.password.slice(0, 200) : '', Buffer.from(u.pass_salt, 'hex'), 64);
    if (!timingSafeEqual(hash, Buffer.from(u.pass_hash, 'hex'))) throw new HttpError(401, 'That password is not correct');
    const owned = db.prepare('SELECT * FROM works WHERE owner_id = ?').all(u.id) as Row[];
    const shared = owned.filter((w) => w.status === 'signed' || peopleOf(w.id).some((p) => p.email && p.email !== u.email));
    if (shared.length > 0) throw new HttpError(409, `Other people are on these songs, so hand them to another owner or delete them first: ${shared.map((w) => w.title).join(', ')}`);
    transaction(db, () => {
      for (const w of owned) db.prepare('DELETE FROM works WHERE id = ?').run(w.id);
      db.prepare('UPDATE works SET created_by = owner_id WHERE created_by = ?').run(u.id);
      db.prepare('DELETE FROM messages WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    });
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return { ok: true };
  });

  // ---------- request handling ----------

  async function readBytes(req: IncomingMessage, max: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > max) throw new HttpError(413, 'Request is too large');
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async function readBody(req: IncomingMessage, opts: RouteOptions): Promise<{ body: Row; raw: Buffer }> {
    const none = { body: {}, raw: Buffer.alloc(0) };
    if (req.method === 'GET') return none;
    if (opts.auth !== 'key') {
      // A browser always sends Origin on these requests; it must be this site, which blocks cross-site form posts.
      // Plugin routes carry a key instead of a cookie, so another site cannot make the browser call them.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Request came from another site');
    }
    if (opts.raw) return { body: {}, raw: await readBytes(req, opts.maxBody ?? MAX_BODY) };
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Send JSON');
    const raw = await readBytes(req, opts.maxBody ?? MAX_BODY);
    if (raw.length === 0) return none;
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return { body: parsed as Row, raw };
    } catch { throw new HttpError(400, 'Request is not valid JSON'); }
  }

  function send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    try {
      if (path.startsWith('/api/')) {
        const match = routes.map((r) => ({ r, m: r.pattern.exec(path) })).find((x) => x.m);
        if (!match) throw new HttpError(404, 'Not found');
        const sameMethod = routes.find((r) => r.method === req.method && r.pattern.test(path));
        if (!sameMethod) throw new HttpError(405, 'Method not allowed');
        const { body, raw } = await readBody(req, sameMethod.opts);
        const out = await sameMethod.handler({ req, res, body, raw, params: sameMethod.pattern.exec(path)!.slice(1) });
        if (Buffer.isBuffer(out)) {
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=3600' });
          res.end(out);
          return;
        }
        return send(res, 200, out);
      }
      if (req.method === 'GET' && (path === '/' || path === '/index.html') && options.pagePath) {
        const page = await readFile(options.pagePath, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${page}`);
        return;
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'Something went wrong on the server' });
    }
  };
}
