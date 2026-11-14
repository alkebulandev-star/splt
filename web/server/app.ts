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
import type { PersonInput, PersonRecord, SourceRecord, Store, StoreTx, UserRecord, WorkRecord } from './store.ts';
import { eventGenesis, eventHash } from './store.ts';

/** A JSON object as it arrives in a request. */
type Json = Record<string, any>;

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

// ---------- records to JSON ----------

const userJson = (u: UserRecord): User => ({
  id: u.id, email: u.email, artistId: u.artistId, artistName: u.artistName, legalName: u.legalName, role: u.role, pro: u.pro,
  ipi: u.ipi, publisher: u.publisher, publisherIpi: u.publisherIpi, isni: u.isni, phone: u.phone,
});

export interface AppOptions {
  /** Built page to serve at "/". */
  pagePath?: string;
  /** Set when served over HTTPS so the session cookie is marked Secure. */
  secureCookies?: boolean;
  /** Set when a trusted proxy (Vercel) sits in front and passes the caller's address in X-Forwarded-For.
      Never set it on a server reached directly: the header could then be made up to dodge the sign-in limit. */
  trustProxy?: boolean;
}

/**
 * Builds the request handler on a store (server/store.ts).
 *
 * The helpers below take the store, or a transaction of it, as their first argument `s`, so the
 * same code reads through whichever is in hand. Routes that change something do their checks and
 * their writes inside one `store.transaction`, reads first and writes after, and build their reply
 * from a fresh read once it has finished.
 */
export function createApp(store: Store, options: AppOptions = {}) {

  // ---------- Artist IDs ----------

  async function newArtistId(s: StoreTx): Promise<string> {
    for (;;) {
      const id = makeArtistId(randomBytes(7));
      if (!await s.userByArtistId(id)) return id;
    }
  }

  async function artistCard(raw: unknown): Promise<ArtistCard> {
    const id = normaliseArtistId(typeof raw === 'string' ? raw : '');
    if (!id) throw new HttpError(400, 'That is not an Artist ID. It looks like ST-7K2Q-9FXM.');
    const u = await store.userByArtistId(id);
    if (!u) throw new HttpError(404, 'No account has that Artist ID. They need to sign up first.');
    return { artistId: u.artistId, artistName: u.artistName, legalName: u.legalName, role: u.role, pro: u.pro, ipi: u.ipi, publisher: u.publisher, publisherIpi: u.publisherIpi, email: u.email };
  }

  // ---------- history ----------

  function chainIntact(workId: string, events: WorkEvent[]): boolean {
    let prev = eventGenesis(workId);
    for (const e of events) {
      if (e.hash !== eventHash(prev, e.time, e.type, e.text)) return false;
      prev = e.hash;
    }
    return true;
  }

  // ---------- sessions ----------

  async function startSession(res: ServerResponse, userId: number): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const maxAge = SESSION_DAYS * 86_400;
    await store.createSession(sha256(token), userId, Date.now() + maxAge * 1000);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${options.secureCookies ? '; Secure' : ''}`);
  }

  function sessionToken(req: IncomingMessage): string | null {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const [k, v] = part.trim().split('=');
      if (k === SESSION_COOKIE && v) return v;
    }
    return null;
  }

  async function currentUser(req: IncomingMessage): Promise<UserRecord | null> {
    const token = sessionToken(req);
    if (!token) return null;
    return store.userBySession(sha256(token), Date.now());
  }

  async function requireUser(req: IncomingMessage): Promise<UserRecord> {
    const u = await currentUser(req);
    if (!u) throw new HttpError(401, 'Sign in to continue');
    return u;
  }

  // ---------- works ----------

  /** The song, for someone who may see it (the store decides who may). For everyone else it does not exist. */
  async function visibleWork(s: StoreTx, user: UserRecord, id: string): Promise<WorkRecord> {
    const w = await s.workVisibleTo(user, id);
    if (!w) throw new HttpError(404, 'Song not found');
    return w;
  }

  /** The owner, and the person who started the song, may change it. */
  const manages = (user: UserRecord, w: WorkRecord): boolean => w.ownerId === user.id || w.createdBy === user.id;

  async function newSongCode(s: StoreTx): Promise<string> {
    for (;;) {
      const code = makeSongCode(randomBytes(7));
      if (!await s.workBySongCode(code)) return code;
    }
  }

  const shareOf = (p: { writerShare: number; masterShare: number }) => hasShare({ writerShare: p.writerShare, masterShare: p.masterShare });

  async function summary(s: StoreTx, user: UserRecord, w: WorkRecord, given?: PersonRecord[]): Promise<WorkSummary> {
    const people = given ?? await s.peopleOf(w.id);
    const mine = people.find((p) => p.email === user.email);
    const sent = w.status === 'sent';
    const owner = (await s.userById(w.ownerId))!;
    return {
      id: w.id, title: w.title, album: w.album, status: w.status, isOwner: manages(user, w),
      songCode: w.songCode, ownerName: owner.artistName, ownerArtistId: owner.artistId, ownerStated: w.ownerStated, youOwn: w.ownerId === user.id,
      people: people.map((p) => p.artistName),
      yourWriterShare: mine ? mine.writerShare : null,
      awaiting: sent ? people.filter((p) => shareOf(p) && p.decision !== 'approved').length : 0,
      needsYou: sent && !!mine && mine.decision === 'none' && shareOf(mine),
      updatedAt: w.updatedAt,
    };
  }

  /** A split sheet as the page shows it, with whether each person has an account. */
  async function sheetRows(s: StoreTx, status: WorkStatus, people: PersonRecord[]): Promise<Person[]> {
    const accounts = new Set(await s.emailsWithAccount(people.map((p) => p.email).filter(Boolean)));
    return people.map((p) => ({
      artistName: p.artistName, legalName: p.legalName, role: p.role, writerShare: p.writerShare, masterShare: p.masterShare,
      email: p.email, status: personStatus(status, p.decision, shareOf(p)),
      hasAccount: !!p.email && accounts.has(p.email),
      artistId: p.artistId, pro: p.pro, ipi: p.ipi, publisher: p.publisher, publisherIpi: p.publisherIpi, terms: p.terms, seconds: p.seconds,
    }));
  }

  async function detail(s: StoreTx, user: UserRecord, w: WorkRecord): Promise<WorkDetail> {
    // Independent reads, asked for together: a store that answers over a network need not be waited on one at a time.
    const [people, stored, events, sources] = await Promise.all([s.peopleOf(w.id), s.messagesOf(w.id), s.eventsOf(w.id) as Promise<WorkEvent[]>, loadSources(s, w.id)]);
    const messages: Message[] = stored.map((m) => ({ id: m.id, author: m.authorName, mine: m.userId === user.id, body: m.body, time: m.createdAt }));
    const mine = people.find((p) => p.email === user.email);
    const [top, rows] = await Promise.all([summary(s, user, w, people), sheetRows(s, w.status, people)]);
    return {
      ...top, rows, messages, events,
      isrc: w.isrc, iswc: w.iswc, splitVersion: w.splitVersion, sources: sourceList(w, sources),
      yourDecision: mine ? mine.decision : null,
      chainIntact: chainIntact(w.id, events),
      evidence: evidenceOf(w.ownerId, sources),
    };
  }

  /** One row of a split sheet as it comes in. Rows may name an account by Artist ID; that fixes the row's email. */
  type RowIn = PersonInput;

  /** Ties each row to its account (by Artist ID, else by email) and makes sure no address is on the sheet twice. Reads only. */
  async function resolveRows(s: StoreTx, rows: RowIn[]): Promise<PersonInput[]> {
    const used = new Set<string>();
    const out: PersonInput[] = [];
    const accounts = await Promise.all(rows.map((r) => (r.artistId ? s.userByArtistId(r.artistId) : r.email ? s.userByEmail(r.email) : null)));
    for (const [i, r] of rows.entries()) {
      const account = accounts[i];
      let address = account?.email ?? r.email;
      if (used.has(address)) address = '';   // nobody approves twice
      if (address) used.add(address);
      out.push({ ...r, email: address, artistId: account?.artistId ?? r.artistId });
    }
    return out;
  }

  const rowIn = (p: Json): RowIn => ({
    artistName: text(p?.artistName, 'Artist name', 80, true), legalName: text(p?.legalName, 'Legal name', 120),
    role: text(p?.role, 'Role', 60) || 'Other', writerShare: percent(p?.writerShare ?? 0, 'Writer share'), masterShare: percent(p?.masterShare ?? 0, 'Master share'),
    email: email(p?.email, false), artistId: normaliseArtistId(text(p?.artistId, 'Artist ID', 20)) ?? '',
    pro: text(p?.pro, 'PRO', 60), ipi: text(p?.ipi, 'IPI number', 40), publisher: text(p?.publisher, 'Publisher', 120),
    publisherIpi: text(p?.publisherIpi, 'Publisher IPI', 40), terms: text(p?.terms, 'Deal notes', 300),
    seconds: Math.max(0, Math.round(Number(p?.seconds) || 0)),
  });

  const fresh = async (user: UserRecord, id: string): Promise<WorkDetail> => detail(store, user, await visibleWork(store, user, id));

  /** Whether everyone with a share has approved, given the sheet as read and the decisions about to be written. */
  const completes = (people: PersonRecord[], changed: number[], decision: Decision): boolean =>
    fullyApproved(people.map((p) => ({ share: shareOf(p), decision: changed.includes(p.id) ? decision : p.decision })));

  async function sign(tx: StoreTx, workId: string): Promise<void> {
    await tx.markSigned(workId);
    await tx.appendEvent(workId, 'SIGNED', 'Everyone with a share approved. The split sheet is signed.');
  }

  const describeSplit = (rows: { artistName: string; writerShare: number; masterShare: number }[]): string =>
    rows.map((r) => `${r.artistName} ${r.writerShare}/${r.masterShare}`).join(', ');

  // ---------- routes ----------

  type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; body: Json; raw: Buffer; params: string[] }) => unknown | Promise<unknown>;
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
    if (await store.userByEmail(address)) throw new HttpError(409, 'That email already has an account. Sign in instead.');

    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt, 64);
    const created = await store.createUser({ email: address, passHash: hash.toString('hex'), passSalt: salt.toString('hex'), artistName, legalName,
      createdAt: Date.now(), artistId: await newArtistId(store) });
    await startSession(res, created.id);
    return userJson(created);
  });

  route('POST', /^\/api\/login$/, async ({ req, res, body }) => {
    const address = email(body.email, true);
    const password = typeof body.password === 'string' ? body.password : '';
    // Behind a proxy the connection is the proxy's (and on Vercel there may be no socket at all).
    const forwarded = options.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    const key = `${address}|${forwarded || req.socket?.remoteAddress || 'unknown'}`;
    if (await store.loginFailures(key, Date.now()) >= LOGIN_TRIES) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');

    const u = await store.userByEmail(address);
    // Hash even when the account does not exist, so the reply takes the same time either way.
    const salt = u ? Buffer.from(u.passSalt, 'hex') : Buffer.alloc(16);
    const hash = await scryptAsync(password.slice(0, 200), salt, 64);
    if (!u || !timingSafeEqual(hash, Buffer.from(u.passHash, 'hex'))) {
      await store.recordLoginFailure(key, Date.now(), LOGIN_WINDOW_MS);
      throw new HttpError(401, 'Email or password is incorrect');
    }
    await store.clearLoginFailures(key);
    await startSession(res, u.id);
    return userJson(u);
  });

  route('POST', /^\/api\/logout$/, async ({ req, res }) => {
    const token = sessionToken(req);
    if (token) await store.deleteSession(sha256(token));
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return { ok: true };
  });

  route('GET', /^\/api\/me$/, async ({ req }) => userJson(await requireUser(req)));

  route('PUT', /^\/api\/profile$/, async ({ req, body }) => {
    const u = await requireUser(req);
    const p: Profile = {
      artistName: text(body.artistName, 'Artist name', 80, true), legalName: text(body.legalName, 'Legal name', 120, true),
      role: text(body.role, 'Role', 60) || 'Artist', pro: text(body.pro, 'PRO', 60), ipi: text(body.ipi, 'IPI number', 40),
      publisher: text(body.publisher, 'Publisher', 120), publisherIpi: text(body.publisherIpi, 'Publisher IPI', 40),
      isni: text(body.isni, 'ISNI', 40), phone: text(body.phone, 'Phone', 40),
    };
    // Draft sheets that name this account follow the profile. Sent and signed sheets stay as approved.
    return userJson(await store.updateProfile(u.id, p));
  });

  route('GET', /^\/api\/works$/, async ({ req }) => {
    const u = await requireUser(req);
    return Promise.all((await store.worksVisibleTo(u)).map((w): Promise<WorkSummary> => summary(store, u, w)));
  });

  route('GET', /^\/api\/activity$/, async ({ req }): Promise<Activity[]> => {
    const u = await requireUser(req);
    return (await store.activityVisibleTo(u, 12)).map((e) => ({ work: e.workTitle, time: e.time, text: e.text }));
  });

  route('POST', /^\/api\/works$/, async ({ req, body }) => {
    const u = await requireUser(req);
    const title = text(body.title, 'Title', 120, true);
    const album = text(body.album, 'Album', 120);
    const id = randomBytes(8).toString('hex');
    await store.transaction(async (tx) => {
      // Optionally start from the split of another of your songs, so an album can share one split.
      let template: PersonRecord[] | null = null;
      if (body.copyFrom !== undefined && body.copyFrom !== '') {
        const source = await visibleWork(tx, u, text(body.copyFrom, 'Song to copy', 16));
        if (!manages(u, source)) throw new HttpError(403, 'You can only copy the split of a song you created');
        template = await tx.peopleOf(source.id);
      }
      const rows = await resolveRows(tx, template ? template.map((p) => ({ artistName: p.artistName, legalName: p.legalName, role: p.role, writerShare: p.writerShare, masterShare: p.masterShare,
        email: p.email, artistId: p.artistId, pro: p.pro, ipi: p.ipi, publisher: p.publisher, publisherIpi: p.publisherIpi, terms: p.terms, seconds: 0 })) : [ownRow(u)]);
      const songCode = await newSongCode(tx);

      await tx.createWork({ id, ownerId: u.id, createdBy: u.id, ownerStated: false, songCode, title, album, createdAt: Date.now() }, rows);
      await tx.appendEvent(id, 'CREATE', `${u.artistName} created "${title}"${album ? ` on "${album}"` : ''}${template ? ', starting from the split of another song' : ''}`);
    });
    return fresh(u, id);
  });

  route('PUT', /^\/api\/works\/([0-9a-f]{16})$/, async ({ req, body, params }) => {
    const u = await requireUser(req);
    await store.transaction(async (tx) => {
      const w = await visibleWork(tx, u, params[0]);
      if (!manages(u, w)) throw new HttpError(403, 'Only the owner, or the person who started this song, can change its details');
      const title = text(body.title, 'Title', 120, true), album = text(body.album, 'Album', 120);
      const isrc = body.isrc === undefined ? w.isrc : text(body.isrc, 'ISRC', 20), iswc = body.iswc === undefined ? w.iswc : text(body.iswc, 'ISWC', 20);
      if (title !== w.title || album !== w.album || isrc !== w.isrc || iswc !== w.iswc) {
        await tx.updateWorkDetails(w.id, { title, album, isrc, iswc });
        await tx.appendEvent(w.id, 'FILE', `${u.artistName} filed this as "${title}"${album ? ` on "${album}"` : ' (single)'}${isrc ? `, ISRC ${isrc}` : ''}${iswc ? `, ISWC ${iswc}` : ''}`);
      }
    });
    return fresh(u, params[0]);
  });

  /** Says who owns the song. Until this is done nobody else's project can join it. */
  route('POST', /^\/api\/works\/([0-9a-f]{16})\/owner$/, async ({ req, body, params }) => {
    const u = await requireUser(req);
    await store.transaction(async (tx) => {
      const w = await visibleWork(tx, u, params[0]);
      const owner = await ownerToSet(tx, u, w, text(body.artistId, 'Artist ID', 20, true));
      if (owner) await writeOwner(tx, u, w, owner);
    });
    // Someone who hands a song on, and is not otherwise part of it, can no longer open it.
    try { return await fresh(u, params[0]); } catch { return { handedOver: true }; }
  });

  route('DELETE', /^\/api\/works\/([0-9a-f]{16})$/, async ({ req, body, params }) => {
    const u = await requireUser(req);
    await store.transaction(async (tx) => {
      const w = await visibleWork(tx, u, params[0]);
      if (w.ownerId !== u.id) throw new HttpError(403, 'Only the owner can delete a song');
      if (w.status === 'signed') throw new HttpError(409, 'A signed split sheet is a record other people rely on, so it cannot be deleted');
      if (text(body.confirmTitle, 'Title', 120) !== w.title) throw new HttpError(400, 'Type the song title exactly to confirm');
      await tx.deleteWork(w.id);
    });
    return { ok: true };
  });

  route('GET', /^\/api\/works\/([0-9a-f]{16})$/, async ({ req, params }) => fresh(await requireUser(req), params[0]));

  route('PUT', /^\/api\/works\/([0-9a-f]{16})\/people$/, async ({ req, body, params }) => {
    const u = await requireUser(req);
    await store.transaction(async (tx) => {
      const w = await visibleWork(tx, u, params[0]);
      if (!manages(u, w)) throw new HttpError(403, 'Only the owner, or the person who started this song, can change the split');
      if (w.status === 'signed') throw new HttpError(409, 'This split sheet is signed and can no longer be changed');
      if (!Array.isArray(body.people) || body.people.length === 0 || body.people.length > 50) throw new HttpError(400, 'A split sheet needs between 1 and 50 people');
      const rows = (body.people as Json[]).map(rowIn);
      const resolved = await resolveRows(tx, rows);

      await tx.writePeople(w.id, resolved);
      await tx.appendEvent(w.id, 'SPLIT', `${u.artistName} set the split (writer/master): ${describeSplit(rows)}`);
    });
    return fresh(u, params[0]);
  });

  route('POST', /^\/api\/works\/([0-9a-f]{16})\/send$/, async ({ req, params }) => {
    const u = await requireUser(req);
    await store.transaction(async (tx) => {
      const w = await visibleWork(tx, u, params[0]);
      if (!manages(u, w)) throw new HttpError(403, 'Only the owner, or the person who started this song, can send it for approval');
      if (w.status !== 'draft') throw new HttpError(409, w.status === 'signed' ? 'This split sheet is already signed' : 'This split sheet has already been sent');
      const people = await tx.peopleOf(w.id);
      const rowsNow = await sheetRows(tx, w.status, people);
      const problem = sendProblem(rowsNow);
      if (problem) throw new HttpError(400, problem);
      // Everyone who has to approve must have an account, so the sheet has somewhere to go.
      const stranger = rowsNow.find((r) => hasShare(r) && !r.hasAccount);
      if (stranger) throw new HttpError(400, `${stranger.artistName} has not signed up yet. They need an account before this can be sent.`);
      // Sending is the owner's own approval.
      const own = people.filter((p) => p.email === u.email).map((p) => p.id);

      await tx.markSent(w.id);
      await tx.setDecisions(w.id, own, 'approved', Date.now());
      await tx.appendEvent(w.id, 'SEND', `${u.artistName} sent the split sheet for approval`);
      if (completes(people, own, 'approved')) await sign(tx, w.id);
    });
    return fresh(u, params[0]);
  });

  route('POST', /^\/api\/works\/([0-9a-f]{16})\/decision$/, async ({ req, body, params }) => {
    const u = await requireUser(req);
    await store.transaction(async (tx) => {
      const w = await visibleWork(tx, u, params[0]);
      const decision = body.decision;
      if (decision !== 'approved' && decision !== 'declined') throw new HttpError(400, 'Choose approve or decline');
      if (w.status !== 'sent') throw new HttpError(409, w.status === 'signed' ? 'This split sheet is already signed' : 'This split sheet has not been sent for approval yet');
      const people = await tx.peopleOf(w.id);
      const mine = people.find((p) => p.email === u.email);
      if (!mine) throw new HttpError(403, 'You are not on this split sheet');

      await tx.setDecisions(w.id, [mine.id], decision, Date.now());
      await tx.appendEvent(w.id, decision === 'approved' ? 'APPROVE' : 'DECLINE',
        `${u.artistName} (${u.legalName}) ${decision} the split: writer ${mine.writerShare}%, master ${mine.masterShare}%`);
      if (completes(people, [mine.id], decision)) await sign(tx, w.id);
    });
    return fresh(u, params[0]);
  });

  route('POST', /^\/api\/works\/([0-9a-f]{16})\/messages$/, async ({ req, body, params }) => {
    const u = await requireUser(req);
    await store.transaction(async (tx) => {
      const w = await visibleWork(tx, u, params[0]);
      const message = text(body.body, 'Message', 2000, true);
      await tx.addMessage(w.id, u.id, message, Date.now());
    });
    return fresh(u, params[0]);
  });


  // ---------- plugin link ----------

  const keysOf = async (s: StoreTx, userId: number): Promise<PluginKey[]> =>
    (await s.pluginKeysOf(userId)).map((k) => ({ id: k.id, name: k.name, key: k.token, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt }));

  route('GET', /^\/api\/keys$/, async ({ req }) => keysOf(store, (await requireUser(req)).id));

  route('POST', /^\/api\/keys$/, async ({ req, body }) => {
    const u = await requireUser(req);
    const name = text(body.name, 'Name', 60) || 'My computer';
    const key = `stk_${randomBytes(32).toString('base64url')}`;
    await store.transaction(async (tx) => {
      if ((await tx.pluginKeysOf(u.id)).length >= 20) throw new HttpError(400, 'Remove an old key before adding another');
      await tx.createPluginKey(u.id, name, key, sha256(key), Date.now());
    });
    return { key, keys: await keysOf(store, u.id) };
  });

  route('DELETE', /^\/api\/keys\/(\d+)$/, async ({ req, params }) => {
    const u = await requireUser(req);
    await store.deletePluginKey(u.id, Number(params[0]));
    return keysOf(store, u.id);
  });

  async function requireKeyUser(req: IncomingMessage): Promise<UserRecord> {
    const m = /^Bearer (stk_[A-Za-z0-9_-]{20,})$/.exec(req.headers.authorization ?? '');
    const found = m ? await store.userByPluginKey(sha256(m[1])) : null;
    if (!found) throw new HttpError(401, 'This plugin key is not valid. Create a new one on your Profile page.');
    await store.touchPluginKey(found.keyId, Date.now());
    return found.user;
  }

  /** Which account this computer's plugin is linked to, so the plugin can show it. */
  route('GET', /^\/api\/plugin\/whoami$/, async ({ req }) => {
    const u = await requireKeyUser(req);
    return { artistName: u.artistName, legalName: u.legalName, email: u.email, artistId: u.artistId };
  }, { auth: 'key' });

  /** The plugin looks up the person being added to a split sheet by their Artist ID. */
  route('GET', /^\/api\/plugin\/artists\/([^/]{1,40})$/, async ({ req, params }) => {
    await requireKeyUser(req);
    return artistCard(decodeURIComponent(params[0]));
  }, { auth: 'key' });

  route('GET', /^\/api\/artists\/([^/]{1,40})$/, async ({ req, params }) => {
    await requireUser(req);
    return artistCard(decodeURIComponent(params[0]));
  });

  const num = (v: unknown, max = 1e15): number => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0; };
  const hex64 = (v: unknown): string => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : '');
  const list = (v: unknown, max: number): Json[] => (Array.isArray(v) ? v.slice(0, max).filter((x) => x && typeof x === 'object') : []);
  const short = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  /** Recomputes the plugin's log chain exactly as the plugin does. */
  function pluginLogIntact(projectId: string, log: Json): { ok: boolean; head: string; entries: number } {
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

  /** A project feeding a song, with its evidence. */
  interface Loaded { r: SourceRecord; ev: Evidence }

  /** Every project feeding a song, each with the evidence it uploaded. */
  async function loadSources(s: StoreTx, workId: string): Promise<Loaded[]> {
    return Promise.all((await s.sourcesOfWork(workId)).map(async (r): Promise<Loaded> => ({ r, ev: (await s.getSourceEvidence(r.userId, r.projectId) ?? {}) as Evidence })));
  }

  function sourceList(w: WorkRecord, all: Loaded[]): SourceInfo[] {
    return all.map(({ r, ev }) => ({
      artistName: r.via ? r.via : r.uploaderName, isOwner: !r.via && r.userId === w.ownerId, receiptUploadedBy: r.via ? r.uploaderName : undefined, syncedAt: r.syncedAt, logIntact: r.chainOk,
      logEntries: ev.logEntries ?? 0, tracks: ev.tracks?.length ?? 0, takes: ev.takes?.length ?? 0, bounces: ev.bounces?.length ?? 0,
    }));
  }

  /** Every project's record for a song, side by side. Nothing from one project replaces another's:
      each track, take and bounce is labelled with whose project it came from. */
  function evidenceOf(ownerId: number, all: Loaded[]): Evidence | null {
    if (all.length === 0) return null;
    const lead = all.find((x) => x.r.userId === ownerId) ?? all[0];
    const label = (x: Loaded) => (x.r.via ? `${x.r.via}'s offline receipt` : all.length > 1 ? x.r.uploaderName : undefined);
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

  /** A song's combined evidence, read from the store. */
  const evidenceOfWork = async (s: StoreTx, w: WorkRecord): Promise<Evidence | null> => evidenceOf(w.ownerId, await loadSources(s, w.id));

  const ownRow = (u: UserRecord): RowIn => ({ artistName: u.artistName, legalName: u.legalName, role: u.role, writerShare: 100, masterShare: 100, email: u.email,
    artistId: u.artistId, pro: u.pro, ipi: u.ipi, publisher: u.publisher, publisherIpi: u.publisherIpi, terms: '', seconds: 0 });

  /** Checks a statement of who owns the song. The current owner may hand the song on; the person who
      started it may name the owner while nobody has yet. The owner must have an account. Reads only:
      returns the account to set as owner, or null when it already is. */
  async function ownerToSet(s: StoreTx, u: UserRecord, w: WorkRecord, rawId: string): Promise<UserRecord | null> {
    const id = normaliseArtistId(rawId);
    if (!id) throw new HttpError(400, "That is not an Artist ID. The owner's ID looks like ST-7K2Q-9FXM.");
    const owner = await s.userByArtistId(id);
    if (!owner) throw new HttpError(404, 'No account has that Artist ID. The owner needs to sign up first.');
    const allowed = w.ownerId === u.id || (w.createdBy === u.id && !w.ownerStated);
    if (!allowed) throw new HttpError(403, w.ownerStated ? 'Only the current owner can hand this song to someone else' : 'Only the person who started this song can name its owner');
    if (w.status === 'signed' && owner.id !== w.ownerId) throw new HttpError(409, 'A signed song cannot change owner');
    if (owner.id === w.ownerId && w.ownerStated) return null;
    return owner;
  }

  /** Writes the owner that `ownerToSet` returned. */
  async function writeOwner(tx: StoreTx, u: UserRecord, w: WorkRecord, owner: UserRecord): Promise<void> {
    await tx.setWorkOwner(w.id, owner.id);
    await tx.appendEvent(w.id, 'OWNER', `${u.artistName} stated that ${owner.artistName} (${owner.legalName}) owns this song`);
  }

  /** The plugin holds no emails. Rows keep the email already entered here for the same person, and the
      person syncing is recognised by name; a row with an Artist ID is tied to that account instead. */
  function withEmails(contributors: RowIn[], before: PersonRecord[], u: UserRecord): RowIn[] {
    const emails = new Map(before.filter((p) => p.email).map((p) => [p.artistName.toLowerCase(), p.email]));
    const mine = [u.artistName, u.legalName].map((n) => n.toLowerCase());
    return contributors.map((c) => ({ ...c, email: c.artistId ? '' : emails.get(c.artistName.toLowerCase())
      ?? (mine.includes(c.artistName.toLowerCase()) || (c.legalName && mine.includes(c.legalName.toLowerCase())) ? u.email : '') }));
  }

  /** What the plugin gets back, so it can show and load the website's side of the song. */
  async function siteState(s: StoreTx, u: UserRecord, w: WorkRecord, conflict: boolean) {
    const [found, sources, people] = await Promise.all([s.userById(w.ownerId), s.sourcesOfWork(w.id), s.peopleOf(w.id)]);
    const owner = found!;
    return {
      songCode: w.songCode, title: w.title, album: w.album, isrc: w.isrc, iswc: w.iswc, status: w.status,
      ownerName: owner.artistName, ownerArtistId: owner.artistId, ownerStated: w.ownerStated,
      youManage: manages(u, w), splitVersion: w.splitVersion, conflict,
      projects: sources.length,
      rows: people.map((p) => ({ artistId: p.artistId, artistName: p.artistName, legalName: p.legalName, role: p.role, writerShare: p.writerShare,
        masterShare: p.masterShare, pro: p.pro, ipi: p.ipi, publisher: p.publisher, publisherIpi: p.publisherIpi, terms: p.terms,
        status: personStatus(w.status, p.decision, shareOf(p)) })),
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
  async function syncProject(u: UserRecord, body: Json, opts: SyncOptions = {}) {
    const via = opts.receipt?.madeBy ?? '';
    const actor = opts.receipt ? `An offline receipt from ${via}, uploaded by ${u.artistName},` : `${u.artistName}'s plugin`;
    const projectId = short(body.projectId, 80);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(projectId)) throw new HttpError(400, 'This project has no valid project id');
    const title = short(body.title, 120);
    const ownerId = short(body.ownerArtistId, 20), songCode = short(body.songCode, 20);

    const chain = pluginLogIntact(projectId, body.log as Json);
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
      project: body.project && typeof body.project === 'object' && hex64((body.project as Json).sha)
        ? { fileName: short((body.project as Json).fileName, 200), sha: hex64((body.project as Json).sha), daw: short((body.project as Json).daw, 40), time: num((body.project as Json).time) } : null,
      projects: [],
      computers: list(body.machines, 50).map((m) => ({ name: short(m.name, 80), os: short(m.os, 60), firstSeen: num(m.firstSeen), lastSeen: num(m.lastSeen), opens: num(m.opens, 1e6) })),
    };
    // Every signature the log holds, so an older saved version of the project can still be recognised.
    for (const e of list((body.log as Json)?.entries, 6000)) {
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
    const lines: LogLine[] = list((body.log as Json)?.entries, 6000).map((e) => ({ time: num(e.time), type: short(e.type, 40), text: short(e.text, 2000) }));

    const done = await store.transaction(async (tx) => {
      const now = Date.now();

      // ----- Reads and checks. Nothing is written until every one of them has passed. -----

      const source = await tx.findSource(u.id, projectId);
      let w: WorkRecord;
      let joined = false, created = false;
      let newOwner: UserRecord | null = null;     // for a new song: the owner its details name
      let newPeople: PersonInput[] = [];           // for a new song: its first split sheet

      if (source) {
        w = (await tx.workById(source.workId))!;
        // A receipt saved before the latest sync would put older records over newer ones.
        if (opts.receipt && chain.entries < ((await tx.getSourceEvidence(u.id, projectId))?.logEntries ?? 0))
          throw new HttpError(409, `The website already has a newer record of this project (in "${w.title}"). This receipt is older, so nothing was changed.`);
      } else if (songCode) {
        // A separate project joining an existing song.
        const code = normaliseSongCode(songCode);
        if (!code) throw new HttpError(400, 'That is not a song code. It looks like SG-4MPT-2K7H and is on the song\'s page on the website.');
        const found = await tx.workBySongCode(code);
        if (!found) throw new HttpError(404, 'No song has that code');
        w = found;
        if (!manages(u, w)) {
          const owner = (await tx.userById(w.ownerId))!;
          if (!w.ownerStated) throw new HttpError(409, 'The owner of this song has not been set yet. The person who started it sets the owner in Song details, or on the website, before anyone else can join.');
          if (normaliseArtistId(ownerId) !== owner.artistId) throw new HttpError(409, "To join this song, enter its owner's Artist ID in Song details. It must match the owner set for the song.");
          if (!await tx.personOnSheet(w.id, u.email, u.artistId)) throw new HttpError(403, `You are not on this song's split sheet yet. Ask ${owner.artistName} to add you with your Artist ID ${u.artistId}.`);
        }
        joined = true;
      } else {
        // A new song. The owner is whoever the song details name; if they name nobody, it is not yet stated.
        let owner = u, stated = false;
        if (ownerId) {
          const id = normaliseArtistId(ownerId);
          if (!id) throw new HttpError(400, "The owner's Artist ID in Song details is not valid. It looks like ST-7K2Q-9FXM.");
          const named = await tx.userByArtistId(id);
          if (!named) throw new HttpError(404, "No account has the owner's Artist ID. The owner needs to sign up first.");
          owner = named; stated = true;
        }
        newOwner = owner;
        newPeople = await resolveRows(tx, contributors.length > 0 ? withEmails(contributors, [], u) : [ownRow(owner)]);
        w = { id: randomBytes(8).toString('hex'), ownerId: owner.id, createdBy: u.id, ownerStated: stated, songCode: await newSongCode(tx), title: title || 'Untitled', album: '',
          status: 'draft', shared: false, isrc: '', iswc: '', splitVersion: 1, createdAt: now, updatedAt: now };
        created = true;
      }
      const fresh = joined || created;

      // Receipts of this same project that someone else uploaded to the song; its own plugin's sync replaces them.
      const receipts = !opts.receipt && !created
        ? (await tx.sourcesOfWork(w.id)).filter((s) => s.projectId === projectId && s.userId !== u.id && s.via !== '') : [];

      const manager = manages(u, w);
      // The owner named in the plugin's song details, from someone entitled to say.
      let ownerChange: UserRecord | null = null;
      if (manager && ownerId && source) {
        const allowed = w.ownerId === u.id || !w.ownerStated;
        if (allowed) ownerChange = await ownerToSet(tx, u, w, ownerId);
      }

      let details: { title: string; isrc: string; iswc: string } | null = null;
      if (manager && !opts.keepDetails && !(fresh && !created)) {
        const isrc = short(body.isrc, 20), iswc = short(body.iswc, 20);
        const nextTitle = title && title !== 'Untitled' ? title : w.title;
        if (nextTitle !== w.title || (isrc && isrc !== w.isrc) || (iswc && iswc !== w.iswc))
          details = { title: nextTitle, isrc: isrc || w.isrc, iswc: iswc || w.iswc };
      }

      // The split. A plugin that has not edited it since it last saw the website's version changes nothing.
      let conflict = false;
      let split: PersonInput[] | null = null;
      const sp = (body.split && typeof body.split === 'object' ? body.split : null) as Json | null;
      const dirty = sp ? sp.dirty === true : true;               // older plugins always send their split
      const base = sp ? num(sp.baseVersion) : w.splitVersion;
      if (manager && (!fresh || (opts.receipt && !created)) && w.status === 'draft' && contributors.length > 0 && dirty) {
        const before = await tx.peopleOf(w.id);
        const key = (r: { artistName: string; legalName: string; role: string; writerShare: number; masterShare: number; artistId: string; pro: string; ipi: string; publisher: string; publisherIpi: string; terms: string }) =>
          [r.artistName, r.legalName, r.role, r.writerShare, r.masterShare, r.artistId, r.pro, r.ipi, r.publisher, r.publisherIpi, r.terms].join('|');
        const same = before.length === contributors.length && before.every((p, i) => {
          const c = contributors[i];
          // A row the plugin holds without an Artist ID still equals the stored row for that person.
          return key({ ...c, artistId: c.artistId || p.artistId }) === key(p);
        });
        if (!same) {
          if (base === w.splitVersion || sp?.force === true) split = await resolveRows(tx, withEmails(contributors, before, u));
          else conflict = true;   // changed on the website as well; the plugin decides which to keep
        }
      }

      const chainChanged = (source?.chainHead ?? '') !== chain.head || (source?.chainOk ?? true) !== chain.ok;

      // ----- Writes. -----

      if (created) {
        await tx.createWork({ id: w.id, ownerId: w.ownerId, createdBy: u.id, ownerStated: w.ownerStated, songCode: w.songCode, title: w.title, album: '', createdAt: now }, newPeople);
        await tx.appendEvent(w.id, 'CREATE', `${actor} created "${title || 'Untitled'}"${w.ownerStated ? `, owned by ${newOwner!.artistName}` : ''}`);
        if (contributors.length > 0) await tx.appendEvent(w.id, 'SPLIT', `Plugin set the split (writer/master): ${describeSplit(contributors)}`);
      }
      if (joined) await tx.appendEvent(w.id, 'JOIN', opts.receipt ? `${actor} added a separate project to this song` : `${u.artistName}'s project joined this song as a separate source`);

      if (!source) await tx.addSource({ userId: u.id, projectId, workId: w.id, via, at: now });
      if (!opts.receipt) {
        // The project's own plugin is syncing now, so a receipt of the same project is no longer needed.
        if (source?.via) await tx.setSourceVia(u.id, projectId, '');
        for (const r of receipts) await tx.removeSource(r.userId, r.projectId);
        if (receipts.length > 0) await tx.appendEvent(w.id, 'RECEIPT', `${u.artistName}'s plugin now syncs this project itself, so its earlier offline receipt was replaced by the live record`);
      }

      if (ownerChange) await writeOwner(tx, u, w, ownerChange);
      if (details) await tx.updateWorkDetails(w.id, details);

      if (split) {
        await tx.writePeople(w.id, split);
        await tx.appendEvent(w.id, 'SPLIT', `${actor} set the split (writer/master): ${describeSplit(contributors)}`);
      }
      // Session time per person is a fact about the session, not a change to the agreement.
      if (manager && contributors.length > 0) await tx.setPeopleSeconds(w.id, contributors.map((c) => ({ artistName: c.artistName, seconds: c.seconds })));

      await tx.putSourceRecord(u.id, projectId, { evidence, log: lines, chainOk: chain.ok, chainHead: chain.head, syncedAt: evidence.syncedAt });
      if (chainChanged) {
        const stems = evidence.bounces.reduce((t, b) => t + b.stems.length, 0);
        const summaryText = `${evidence.takes.length} takes, ${evidence.bounces.length} bounces, ${stems} stems`;
        await tx.addSyncHistory({ workId: w.id, userId: u.id, projectId, syncedAt: evidence.syncedAt, chainHead: chain.head, chainOk: chain.ok, summary: summaryText });
        await tx.appendEvent(w.id, 'PLUGIN', `${actor} ${opts.receipt ? 'brought' : 'synced'}: ${summaryText}. Plugin log ${chain.ok ? 'intact' : 'ALTERED'}, head ${chain.head.slice(0, 16)}`);
      }
      return { workId: w.id, conflict, created };
    });

    // The reply is read after the transaction, so it shows the song as it now stands.
    const w = (await store.workById(done.workId))!;
    const wanted = new Set(evidence.bounces.flatMap((b) => [b.fpId, ...b.stems.map((st) => st.fpId)]).filter(Boolean));
    const [stored, site] = await Promise.all([store.fingerprintsOf(w.id), siteState(store, u, w, done.conflict)]);
    for (const f of stored) wanted.delete(f.fpId);
    return { workId: w.id, title: w.title, created: done.created, logIntact: chain.ok, missingFingerprints: [...wanted],
      account: { artistName: u.artistName, artistId: u.artistId }, site };
  }

  route('POST', /^\/api\/plugin\/sync$/, async ({ req, body }) => syncProject(await requireKeyUser(req), body), { auth: 'key', maxBody: MAX_SYNC_BODY });

  /** Stores one fingerprint file. Its SHA-256 must be its id, and the id must be on a bounce of the song. */
  async function storeFingerprint(workId: string, fpId: string, raw: Buffer): Promise<void> {
    if (sha256(raw) !== fpId) throw new HttpError(400, 'The file does not match its fingerprint id');
    if (raw.length < 18 || raw.subarray(0, 6).toString('latin1') !== 'TBAFP1') throw new HttpError(400, 'Not a Split Tracker fingerprint file');
    const w = await store.workById(workId);
    const ev = w ? await evidenceOfWork(store, w) : null;
    let found: { kind: string; name: string; bounce: number } | null = null;
    for (const b of ev?.bounces ?? []) {
      if (b.fpId === fpId) found = { kind: 'Master', name: 'Master', bounce: b.num };
      for (const s of b.stems) if (s.fpId === fpId) found = { kind: 'Stem', name: s.person ? `${s.trackName} (${s.person})` : s.trackName, bounce: b.num };
    }
    if (!found) throw new HttpError(400, 'This fingerprint is not on any bounce of the song');
    const seconds = raw.readDoubleLE(6) * raw.readInt32LE(14);
    await store.putFingerprint(workId, { fpId, kind: found.kind, name: found.name, bounce: found.bounce, seconds: Number.isFinite(seconds) ? seconds : 0 }, raw);
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
  route('POST', /^\/api\/receipts$/, async ({ req, body }) => {
    const u = await requireUser(req);
    const r = (body.receipt && typeof body.receipt === 'object' ? body.receipt : {}) as Json;
    if (r.format !== 'split-tracker-receipt' || typeof r.payload !== 'string') throw new HttpError(400, 'That is not a Split Tracker offline receipt. In the plugin: Evidence tab, "Save offline receipt".');
    if (r.version !== 1) throw new HttpError(400, 'This receipt was saved by a newer plugin than this website understands');
    if (sha256(r.payload) !== r.payloadSha256) throw new HttpError(400, 'This receipt file is damaged, or was changed after the plugin saved it. Ask for it to be saved and sent again.');
    let payload: Json;
    try { payload = JSON.parse(r.payload) as Json; } catch { throw new HttpError(400, 'This receipt file cannot be read'); }
    if (!payload || typeof payload !== 'object') throw new HttpError(400, 'This receipt file cannot be read');

    const projectId = short(payload.projectId, 80);
    const mine = await store.findSource(u.id, projectId);
    if (body.mode === 'add') {
      const w = await store.workById(short(body.workId, 16));
      if (!w || !manages(u, w)) throw new HttpError(404, 'Choose one of the songs you manage');
      if (mine && mine.workId !== w.id) {
        const other = (await store.workById(mine.workId))!;
        throw new HttpError(409, `This project is already part of "${other.title}". Upload it there, or register it as a new song.`);
      }
      payload.songCode = w.songCode;
    }
    else if (short(payload.songCode, 20)) {
      // A code for a song that is no longer on the website: register the project afresh.
      const code = normaliseSongCode(short(payload.songCode, 20));
      if (!code || !await store.workBySongCode(code)) payload.songCode = '';
    }
    if (body.iAmOwner === true && !short(payload.ownerArtistId, 20)) payload.ownerArtistId = u.artistId;
    payload.split = { dirty: body.useSplit === true, baseVersion: 0, force: true };

    const madeBy = short(r.madeBy, 80) || short(r.computer, 80) || 'an unnamed computer';
    const out = await syncProject(u, payload, { receipt: { madeBy }, keepDetails: body.mode === 'add' });

    let stored = 0;
    const wanted = new Set(out.missingFingerprints);
    const files = (r.fingerprints && typeof r.fingerprints === 'object' ? r.fingerprints : {}) as Record<string, unknown>;
    for (const id of wanted) {
      const b64 = files[id];
      if (typeof b64 !== 'string') continue;
      try { await storeFingerprint(out.workId, id, Buffer.from(b64, 'base64')); stored++; } catch { /* a file that does not verify is left out */ }
    }
    return { workId: out.workId, title: out.title, created: out.created, logIntact: out.logIntact, fingerprints: stored, fingerprintsMissing: wanted.size - stored };
  }, { maxBody: MAX_RECEIPT });

  /** The plugin uploads one fingerprint file the sync reply asked for. Its SHA-256 must be the id on the receipt. */
  route('PUT', /^\/api\/plugin\/works\/([0-9a-f]{16})\/fingerprints\/([0-9a-f]{64})$/, async ({ req, raw, params }) => {
    const u = await requireKeyUser(req);
    const [workId, fpId] = params;
    // Anyone whose project feeds the song may upload that project's fingerprints.
    if (!(await store.sourcesOfWork(workId)).some((s) => s.userId === u.id)) throw new HttpError(404, 'Song not found');
    await storeFingerprint(workId, fpId, raw);
    return { ok: true };
  }, { auth: 'key', raw: true, maxBody: MAX_FINGERPRINT });

  route('GET', /^\/api\/signatures$/, async ({ req }): Promise<Signature[]> => {
    const u = await requireUser(req);
    const out: Signature[] = [];
    for (const w of await store.worksVisibleTo(u)) {
      const ev = await evidenceOfWork(store, w);
      if (!ev) continue;
      const projects = ev.projects ?? [];
      projects.forEach((p, i) => out.push({ workId: w.id, title: w.title, kind: 'Project file', label: p.daw ? `${p.fileName} (${p.daw})` : p.fileName, sha: p.sha, time: p.time, latest: i === projects.length - 1 }));
      for (const b of ev.bounces) if (b.fileSha) out.push({ workId: w.id, title: w.title, kind: 'Sealed export', label: `Bounce ${b.num}`, sha: b.fileSha, time: b.time, latest: true });
    }
    return out;
  });

  route('GET', /^\/api\/fingerprints$/, async ({ req }): Promise<StoredFingerprint[]> => {
    const u = await requireUser(req);
    const out: StoredFingerprint[] = [];
    for (const w of await store.worksVisibleTo(u)) {
      const ev = await evidenceOfWork(store, w);
      if (!ev) continue;
      const stored = new Map((await store.fingerprintsOf(w.id)).map((f) => [f.fpId, f.seconds]));
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
  route('GET', /^\/api\/works\/([0-9a-f]{16})\/fingerprints\/([0-9a-f]{64})\/details$/, async ({ req, params }): Promise<FingerprintDetails> => {
    const w = await visibleWork(store, await requireUser(req), params[0]);
    const fpId = params[1];
    const trackName = new URL(req.url ?? '/', 'http://localhost').searchParams.get('track') ?? '';
    const sources = await loadSources(store, w.id);
    const ev = evidenceOf(w.ownerId, sources);
    const stored = (await store.fingerprintsOf(w.id)).find((f) => f.fpId === fpId);
    const bounce = ev?.bounces.find((b) => (trackName ? b.stems.some((st) => st.fpId === fpId && st.trackName === trackName) : b.fpId === fpId));
    if (!ev || !bounce) throw new HttpError(404, 'Nothing recorded for that fingerprint');
    // The log lines come from the project that made this fingerprint, not from the other collaborators' projects.
    const holder = sources.find((x) => x.ev.bounces?.some((b) => b.fpId === fpId || b.stems.some((st) => st.fpId === fpId)));
    const all = holder ? await store.getSourceLog(holder.r.userId, holder.r.projectId) : [];
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

  route('GET', /^\/api\/works\/([0-9a-f]{16})\/fingerprints\/([0-9a-f]{64})$/, async ({ req, params }) => {
    const w = await visibleWork(store, await requireUser(req), params[0]);
    const data = await store.getFingerprint(w.id, params[1]);
    if (!data) throw new HttpError(404, 'Fingerprint not found');
    return Buffer.from(data);
  });

  // ---------- your data ----------

  /** Everything held about the signed-in person, in one object (the right of access). */
  route('GET', /^\/api\/me\/export$/, async ({ req }) => {
    const u = await requireUser(req);
    const songs: WorkDetail[] = [];
    for (const w of await store.worksVisibleTo(u)) songs.push(await detail(store, u, w));
    return {
      exportedAt: new Date().toISOString(),
      profile: userJson(u),
      pluginKeys: (await keysOf(store, u.id)).map((k) => ({ name: k.name, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })),
      songs,
      syncHistory: (await store.syncHistoryOf(u.id)).map((h) => ({ work_id: h.workId, project_id: h.projectId, synced_at: h.syncedAt, chain_head: h.chainHead, chain_ok: h.chainOk ? 1 : 0, summary: h.summary })),
    };
  });

  /** Deletes the account. Songs that other people are on are theirs too, so those have to be dealt with first. */
  route('DELETE', /^\/api\/me$/, async ({ req, res, body }) => {
    const u = await requireUser(req);
    const hash = await scryptAsync(typeof body.password === 'string' ? body.password.slice(0, 200) : '', Buffer.from(u.passSalt, 'hex'), 64);
    if (!timingSafeEqual(hash, Buffer.from(u.passHash, 'hex'))) throw new HttpError(401, 'That password is not correct');
    await store.transaction(async (tx) => {
      const owned = await tx.worksOwnedBy(u.id);
      const shared: WorkRecord[] = [];
      for (const w of owned) if (w.status === 'signed' || (await tx.peopleOf(w.id)).some((p) => p.email && p.email !== u.email)) shared.push(w);
      if (shared.length > 0) throw new HttpError(409, `Other people are on these songs, so hand them to another owner or delete them first: ${shared.map((w) => w.title).join(', ')}`);
      await tx.deleteAccount(u.id, owned.map((w) => w.id));
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

  async function readBody(req: IncomingMessage, opts: RouteOptions): Promise<{ body: Json; raw: Buffer }> {
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
      return { body: parsed as Json, raw };
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
