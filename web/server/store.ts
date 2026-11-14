/**
 * The storage interface: everything the server (app.ts) needs from a database, said in terms of
 * accounts, songs, split sheets, history and projects. No SQL and no database library's types
 * cross this file, so a different database (Firestore is the one planned) can sit behind it.
 *
 * Rules an implementation, and the code that calls it, keep to:
 *
 * - Every method returns a Promise.
 * - `transaction` runs a group of operations so that all of them happen or none do, and nothing
 *   else is seen half-way. Inside it, use ONLY the `tx` handed to the function, never the store.
 * - Inside a transaction the caller does its reads first and its writes after. Firestore refuses a
 *   read that follows a write in the same transaction.
 * - A few write methods are deliberately coarse ("read-modify-write"): `appendEvent` (reads the
 *   song's last history hash), `writePeople` (replaces the sheet and raises split_version),
 *   `setPeopleSeconds`, `updateProfile`, `deleteAccount`, `recordLoginFailure`. What each depends on
 *   is the song itself and its split sheet, which the caller has always read (`workById`,
 *   `workVisibleTo`, `workBySongCode`, `peopleOf`) before its first write, or which the same
 *   transaction created. An implementation that cannot read after a write keeps what the transaction
 *   has read and written in memory (for instance the song's history head and split_version on the
 *   song's own document) and works from that.
 * - Large payloads are not part of the records: a fingerprint's bytes and a project's evidence and
 *   log are fetched and stored through their own methods, so the small records stay small
 *   (a Firestore document is limited to 1 MiB; a long plugin log can exceed that on its own and
 *   would have to be split or kept in file storage).
 *
 * Ids. Song ids are 16 hex characters and are made by the caller. Account ids, message ids and
 * plugin-key ids are numbers and appear in the HTTP API (User.id, Message.id, PluginKey.id and the
 * DELETE /api/keys/<number> address); the SQLite store takes them from auto-increment columns. A
 * Firestore store has no auto-increment and must make them itself, for instance from a counter
 * document read and raised in the same transaction. Split-sheet row ids (PersonRecord.id) never
 * leave the server, so a Firestore store may use any numbers that are unique within a song, such
 * as the row's position.
 */
import { createHash } from 'node:crypto';
import type { Evidence, LogLine, Profile } from '../src/core/api.ts';
import type { Decision, WorkStatus } from '../src/core/splits.ts';

// ---------- records ----------

export interface UserRecord {
  id: number; email: string;
  /** scrypt hash and salt, hex. */
  passHash: string; passSalt: string;
  artistId: string; artistName: string; legalName: string; role: string; pro: string; ipi: string;
  publisher: string; publisherIpi: string; isni: string; phone: string;
}
export interface NewUser { email: string; passHash: string; passSalt: string; artistName: string; legalName: string; artistId: string; createdAt: number }

/** The two facts about a person that decide which songs they may see. */
export interface Viewer { id: number; email: string }

export interface WorkRecord {
  id: string; ownerId: number; createdBy: number;
  /** True once someone has said who owns the song. */
  ownerStated: boolean;
  songCode: string; title: string; album: string; status: WorkStatus;
  /** True once the sheet has been sent; until then only the owner's side sees it. */
  shared: boolean;
  isrc: string; iswc: string;
  /** Goes up on every change to the split sheet. */
  splitVersion: number;
  createdAt: number; updatedAt: number;
}
export interface NewWork { id: string; ownerId: number; createdBy: number; ownerStated: boolean; songCode: string; title: string; album: string; createdAt: number }

/** One row of a split sheet as it is written. */
export interface PersonInput {
  artistName: string; legalName: string; role: string; writerShare: number; masterShare: number;
  /** Empty when the row has no address, or when an earlier row already uses it. */
  email: string; artistId: string;
  pro: string; ipi: string; publisher: string; publisherIpi: string; terms: string; seconds: number;
}
export interface PersonRecord extends PersonInput { id: number; workId: string; position: number; decision: Decision; decidedAt: number | null }

export interface MessageRecord { id: number; userId: number; authorName: string; body: string; createdAt: number }
export interface EventRecord { time: number; type: string; text: string; hash: string }
export interface ActivityRecord { workTitle: string; time: number; text: string }

export interface PluginKeyRecord { id: number; userId: number; name: string; token: string; createdAt: number; lastUsedAt: number | null }

/** One DAW project that feeds a song. Its evidence and log are fetched separately. */
export interface SourceRecord {
  userId: number; projectId: string; workId: string;
  /** Empty for a plugin's own sync; otherwise who the offline receipt came from. */
  via: string;
  chainOk: boolean; chainHead: string; linkedAt: number; syncedAt: number;
  /** Artist name of the account the project belongs to (the uploader, for a receipt). */
  uploaderName: string;
}
export interface NewSource { userId: number; projectId: string; workId: string; via: string; at: number }
/** What one upload of a project stores: the large parts, and the facts about its log chain. */
export interface SourcePayload { evidence: Evidence; log: LogLine[]; chainOk: boolean; chainHead: string; syncedAt: number }
export interface SyncHistoryRecord { workId: string; userId: number; projectId: string; syncedAt: number; chainHead: string; chainOk: boolean; summary: string }

export interface FingerprintInfo { fpId: string; kind: string; name: string; bounce: number; seconds: number }

// ---------- the history chain ----------
// Each song's history is hash-chained: every entry seals the one before it. The rule lives here so
// that every store writes it the same way and the server can check it.

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const eventGenesis = (workId: string): string => sha256(`GENESIS|${workId}`);
export const eventHash = (prev: string, time: number, type: string, text: string): string => sha256(`${prev}|${time}|${type}|${text}`);

// ---------- operations ----------

/** Everything that can be done both on its own and inside a transaction. */
export interface StoreTx {
  // accounts
  /** The account with this id. */
  userById(id: number): Promise<UserRecord | null>;
  /** The account signed up with this (lower-case) email. */
  userByEmail(email: string): Promise<UserRecord | null>;
  /** The account holding this Artist ID. */
  userByArtistId(artistId: string): Promise<UserRecord | null>;
  /** Which of these emails belong to an account. */
  emailsWithAccount(emails: string[]): Promise<string[]>;
  /** Adds an account and returns it with its new id. */
  createUser(user: NewUser): Promise<UserRecord>;
  /** Saves a profile. Draft sheets naming this account follow it, and their split_version goes up; sent and signed sheets stay. */
  updateProfile(userId: number, profile: Profile): Promise<UserRecord>;
  /** Removes the account: the listed songs it owns, its messages, sign-ins, keys and projects; songs it started for others pass to their owners. */
  deleteAccount(userId: number, ownedWorkIds: string[]): Promise<void>;

  // sign-ins
  /** Records a sign-in. Only the hash of the token is kept. */
  createSession(tokenHash: string, userId: number, expiresAt: number): Promise<void>;
  /** The account a sign-in belongs to, if it has not expired. */
  userBySession(tokenHash: string, now: number): Promise<UserRecord | null>;
  /** Ends a sign-in. */
  deleteSession(tokenHash: string): Promise<void>;

  // plugin keys
  /** An account's plugin keys, oldest first. */
  pluginKeysOf(userId: number): Promise<PluginKeyRecord[]>;
  /** Adds a plugin key. */
  createPluginKey(userId: number, name: string, token: string, tokenHash: string, createdAt: number): Promise<void>;
  /** Removes a plugin key, if it belongs to that account. */
  deletePluginKey(userId: number, keyId: number): Promise<void>;
  /** The account a plugin key uploads for, and the key's id. */
  userByPluginKey(tokenHash: string): Promise<{ user: UserRecord; keyId: number } | null>;
  /** Notes that a plugin key was just used. */
  touchPluginKey(keyId: number, at: number): Promise<void>;

  // songs
  /** The song with this id, whoever asks. */
  workById(id: string): Promise<WorkRecord | null>;
  /** The song with this public song code. */
  workBySongCode(songCode: string): Promise<WorkRecord | null>;
  /** The song, if this person may see it: owner, starter, anyone whose project feeds it, and, once sent, anyone on its sheet. */
  workVisibleTo(viewer: Viewer, id: string): Promise<WorkRecord | null>;
  /** Every song this person may see, most recently changed first. */
  worksVisibleTo(viewer: Viewer): Promise<WorkRecord[]>;
  /** Every song this account owns. */
  worksOwnedBy(userId: number): Promise<WorkRecord[]>;
  /** Adds a draft song with its first split sheet, at split_version 1. */
  createWork(work: NewWork, people: PersonInput[]): Promise<void>;
  /** Changes the given filing details and leaves the rest. */
  updateWorkDetails(id: string, details: { title?: string; album?: string; isrc?: string; iswc?: string }): Promise<void>;
  /** Sets the owner and marks the owner as stated. */
  setWorkOwner(id: string, ownerId: number): Promise<void>;
  /** Marks the sheet as sent for approval; from now the people on it can see the song. */
  markSent(id: string): Promise<void>;
  /** Marks the sheet as signed. */
  markSigned(id: string): Promise<void>;
  /** Removes a song and everything that belongs to it. */
  deleteWork(id: string): Promise<void>;

  // split sheets
  /** A song's split sheet, in order. */
  peopleOf(workId: string): Promise<PersonRecord[]>;
  /** Whether the sheet has a row with this email or this Artist ID. */
  personOnSheet(workId: string, email: string, artistId: string): Promise<boolean>;
  /** Replaces the whole sheet, returns it to draft (withdrawing approvals) and raises split_version by one. */
  writePeople(workId: string, rows: PersonInput[]): Promise<void>;
  /** Records the same decision for the given rows of a sheet. */
  setDecisions(workId: string, personIds: number[], decision: Decision, at: number): Promise<void>;
  /** Session time per person: for each entry in turn, every row with that artist name gets its seconds. Not a change to the agreement, so split_version stays. */
  setPeopleSeconds(workId: string, entries: { artistName: string; seconds: number }[]): Promise<void>;

  // messages and history
  /** A song's messages with their authors' names, oldest first. */
  messagesOf(workId: string): Promise<MessageRecord[]>;
  /** Adds a message and marks the song as changed. */
  addMessage(workId: string, userId: number, body: string, at: number): Promise<void>;
  /** A song's history, oldest first. */
  eventsOf(workId: string): Promise<EventRecord[]>;
  /** Appends to a song's hash-chained history (reads the last hash, seals the new entry with it) and marks the song as changed. */
  appendEvent(workId: string, type: string, text: string): Promise<void>;
  /** The latest history lines across every song this person may see, newest first. */
  activityVisibleTo(viewer: Viewer, limit: number): Promise<ActivityRecord[]>;

  // projects feeding songs
  /** The project this account has linked under this project id, if any. */
  findSource(userId: number, projectId: string): Promise<SourceRecord | null>;
  /** Every project feeding a song, in the order they were linked, each with its uploader's artist name. */
  sourcesOfWork(workId: string): Promise<SourceRecord[]>;
  /** Links a project to a song. Its record starts empty. */
  addSource(source: NewSource): Promise<void>;
  /** Changes who a project's record is said to come from ('' once its own plugin syncs). */
  setSourceVia(userId: number, projectId: string, via: string): Promise<void>;
  /** Unlinks a project from its song. */
  removeSource(userId: number, projectId: string): Promise<void>;
  /** Stores a project's latest evidence and log, replacing the earlier upload. */
  putSourceRecord(userId: number, projectId: string, payload: SourcePayload): Promise<void>;
  /** A project's stored evidence (an empty object before its first upload). */
  getSourceEvidence(userId: number, projectId: string): Promise<Evidence | null>;
  /** A project's stored log lines. */
  getSourceLog(userId: number, projectId: string): Promise<LogLine[]>;
  /** Keeps a short note of an upload, so earlier states are not lost. */
  addSyncHistory(entry: SyncHistoryRecord): Promise<void>;
  /** Every upload note for one account's projects, oldest first. */
  syncHistoryOf(userId: number): Promise<SyncHistoryRecord[]>;

  // fingerprints
  /** Stores (or replaces) one fingerprint file of a song. */
  putFingerprint(workId: string, info: FingerprintInfo, data: Uint8Array): Promise<void>;
  /** One fingerprint file's bytes. */
  getFingerprint(workId: string, fpId: string): Promise<Uint8Array | null>;
  /** What is known about a song's stored fingerprints, without their bytes. */
  fingerprintsOf(workId: string): Promise<FingerprintInfo[]>;
}

export interface Store extends StoreTx {
  /** Runs `fn` so that everything it does through `tx` happens together or not at all. Reads first, then writes. */
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;

  // sign-in rate limit: kept in the store because a serverless host does not keep memory between requests
  /** How many failed sign-ins are counted against this key in its current window (0 once the window has passed). */
  loginFailures(key: string, now: number): Promise<number>;
  /** Counts one more failed sign-in; a new window of `windowMs` starts if none is running. */
  recordLoginFailure(key: string, now: number, windowMs: number): Promise<void>;
  /** Forgets the failed sign-ins for this key. */
  clearLoginFailures(key: string): Promise<void>;
}
