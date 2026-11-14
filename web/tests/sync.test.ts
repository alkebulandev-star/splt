// Separate projects feeding one song, a stated owner, two-way split sync, and housekeeping.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.ts';
import { backupDatabase, checkDatabase, openDb, tidyDatabase } from '../server/db.ts';
import { SqliteStore } from '../server/storeSqlite.ts';
import { normaliseSongCode } from '../src/core/artistId.ts';
import { makeStore } from './helpers/store.ts';

let server: Server, base = '';
// SQLite in memory by default; STORE=firestore runs the same tests on a throwaway Firestore namespace.
const backing = await makeStore();
before(async () => { server = createServer(createApp(backing.store)); await new Promise<void>((r) => server.listen(0, r)); base = `http://localhost:${(server.address() as AddressInfo).port}`; });
after(async () => { server.close(); await backing.close(); });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const PASS = 'correct horse battery';

/** A person: a browser session plus a plugin key, as one object. */
async function person(artistName: string, legalName: string, email: string) {
  let cookie = '';
  const web = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) } });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, data: (await r.json()) as any };
  };
  const me = (await web('POST', '/api/register', { email, password: PASS, artistName, legalName })).data;
  const key: string = (await web('POST', '/api/keys', { name: 'Test Mac' })).data.key;
  const sync = async (payload: Record<string, unknown>) => {
    const r = await fetch(base + '/api/plugin/sync', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: r.status, data: (await r.json()) as any };
  };
  return { web, sync, artistId: me.artistId as string, email };
}

/** What a plugin sends for one project, with a properly chained log. */
function project(projectId: string, extra: Record<string, unknown> = {}, lines: [string, string][] = [['SESSION', 'Session opened']]) {
  let prev = sha(`GENESIS|${projectId}`);
  const entries = lines.map(([type, text], i) => { const time = 1_794_000_000_000 + i * 1000; prev = sha(`${prev}|${time}|${type}|${text}`); return { time, type, text, hash: prev }; });
  return { schema: 2, projectId, title: 'Night Signal', log: { entries }, ...extra };
}
const who = (artistName: string, legalName: string, writerShare: number, masterShare: number, more: Record<string, unknown> = {}) =>
  ({ artistName, legalName, role: 'Artist', writerShare, masterShare, ...more });

let nova: Awaited<ReturnType<typeof person>>, riko: Awaited<ReturnType<typeof person>>, mara: Awaited<ReturnType<typeof person>>;
let songId = '', songCode = '';

test('every field the plugin holds reaches the website', async () => {
  nova = await person('Nova Kane', 'Naomi K. Ellison', 'nova@example.com');
  riko = await person('Riko Santos', 'Ricardo Santos', 'riko@example.com');
  mara = await person('Mara Voss', 'Mara E. Voss', 'mara@example.com');

  const r = await nova.sync(project('nova-project-0001', {
    isrc: 'US-ABC-26-00001', iswc: 'T-123.456.789-0', sessionSeconds: 3600, playSeconds: 1200, recordSeconds: 300, splitsConfirmed: false,
    contributors: [who('Nova Kane', 'Naomi K. Ellison', 60, 100, { artistId: nova.artistId, pro: 'ASCAP', ipi: '00512346789', publisher: 'Kane Songs', publisherIpi: '00698112045', terms: '3 points', seconds: 2400 }),
      who('Riko Santos', 'Ricardo Santos', 40, 0, { artistId: riko.artistId, pro: 'BMI', terms: 'flat fee', seconds: 900 })],
    machines: [{ name: 'Studio Mac', os: 'macOS 15', firstSeen: 1, lastSeen: 2, opens: 3 }],
    bounces: [{ num: 1, time: 5, durationSecs: 180, fpId: sha('m'), fileSha: sha('file'), fileName: 'Night Signal master.wav', stems: [] }],
  }));
  assert.equal(r.status, 200);
  songId = r.data.workId; songCode = r.data.site.songCode;
  assert.equal(normaliseSongCode(songCode), songCode);

  const d = (await nova.web('GET', `/api/works/${songId}`)).data;
  assert.deepEqual([d.isrc, d.iswc], ['US-ABC-26-00001', 'T-123.456.789-0']);
  assert.deepEqual(d.rows.map((x: any) => [x.artistName, x.pro, x.ipi, x.publisher, x.publisherIpi, x.terms, x.seconds, x.email, x.artistId]), [
    ['Nova Kane', 'ASCAP', '00512346789', 'Kane Songs', '00698112045', '3 points', 2400, 'nova@example.com', nova.artistId],
    ['Riko Santos', 'BMI', '', '', '', 'flat fee', 900, 'riko@example.com', riko.artistId]]);
  assert.equal(d.evidence.playSeconds, 1200);
  assert.equal(d.evidence.computers[0].name, 'Studio Mac');
  assert.equal(d.evidence.bounces[0].fileName, 'Night Signal master.wav');
});

test('the owner is stated, not assumed, and nobody joins before it is', async () => {
  let d = (await nova.web('GET', `/api/works/${songId}`)).data;
  assert.deepEqual([d.ownerName, d.ownerStated, d.youOwn], ['Nova Kane', false, true]);

  // Riko, working in his own separate project, tries to join with the song code.
  const early = await riko.sync(project('riko-project-0001', { songCode, ownerArtistId: nova.artistId }));
  assert.equal(early.status, 409);
  assert.match(early.data.error, /owner of this song has not been set/);

  // Nova states the owner in her plugin's song details.
  await nova.sync(project('nova-project-0001', { ownerArtistId: nova.artistId }));
  d = (await nova.web('GET', `/api/works/${songId}`)).data;
  assert.equal(d.ownerStated, true);
  assert.ok(d.events.some((e: any) => e.type === 'OWNER'));

  assert.equal((await riko.sync(project('riko-project-0001', { songCode }))).status, 409, 'must give the owner');
  assert.equal((await riko.sync(project('riko-project-0001', { songCode, ownerArtistId: mara.artistId }))).status, 409, 'must give the right owner');
  const stranger = await mara.sync(project('mara-project-0001', { songCode, ownerArtistId: nova.artistId }));
  assert.equal(stranger.status, 403);
  assert.match(stranger.data.error, /not on this song's split sheet/);
  assert.equal((await riko.sync(project('riko-project-0001', { songCode: 'SG-0000-0000', ownerArtistId: nova.artistId }))).status, 404);
  assert.equal((await mara.web('GET', `/api/works/${songId}`)).status, 404);
});

test('separate projects feed one song without touching each other', async () => {
  const novaTracks = { tracks: [{ trackName: 'Lead Vox', person: 'Nova Kane', signalSeconds: 300, recordSeconds: 48, takes: 2 }], takes: [{ track: 'Lead Vox', person: 'Nova Kane', num: 1, time: 1, durationSecs: 48, songPos: 32 }] };
  await nova.sync(project('nova-project-0001', novaTracks, [['SESSION', 'Session opened'], ['TAKE', 'Take 1 on "Lead Vox" (Nova Kane)']]));

  const joined = await riko.sync(project('riko-project-0001', {
    songCode, ownerArtistId: nova.artistId, title: 'my local name for it',
    contributors: [who('Riko Santos', 'Ricardo Santos', 100, 100)],          // his own idea of the split: must not win
    tracks: [{ trackName: 'Guitar', person: 'Riko Santos', signalSeconds: 200, recordSeconds: 90, takes: 4 }],
    takes: [{ track: 'Guitar', person: 'Riko Santos', num: 1, time: 2, durationSecs: 22, songPos: 8 }],
  }, [['SESSION', 'Session opened'], ['TAKE', 'Take 1 on "Guitar" (Riko Santos)']]));
  assert.equal(joined.status, 200);
  assert.equal(joined.data.workId, songId, 'his project is filed under the same song');
  assert.deepEqual([joined.data.site.youManage, joined.data.site.projects, joined.data.site.ownerName], [false, 2, 'Nova Kane']);
  assert.deepEqual(joined.data.site.rows.map((x: any) => [x.artistName, x.writerShare]), [['Nova Kane', 60], ['Riko Santos', 40]], 'he is handed the real split');

  const d = (await nova.web('GET', `/api/works/${songId}`)).data;
  assert.equal(d.title, 'Night Signal', 'a collaborator cannot rename the song');
  assert.deepEqual(d.rows.map((x: any) => x.writerShare), [60, 40], 'nor change the split');
  assert.deepEqual(d.sources.map((x: any) => [x.artistName, x.isOwner, x.tracks, x.takes]), [['Nova Kane', true, 1, 1], ['Riko Santos', false, 1, 1]]);
  assert.deepEqual(d.evidence.tracks.map((t: any) => [t.trackName, t.source]), [['Lead Vox', 'Nova Kane'], ['Guitar', 'Riko Santos']]);
  assert.equal(d.evidence.logEntries, 4);

  // Riko syncing again, or Nova syncing again, replaces only their own record.
  await riko.sync(project('riko-project-0001', { tracks: [{ trackName: 'Guitar', person: 'Riko Santos', signalSeconds: 260, recordSeconds: 120, takes: 5 }] }, [['SESSION', 'Session opened'], ['TAKE', 'Take 1 on "Guitar" (Riko Santos)'], ['TAKE', 'Take 5 on "Guitar" (Riko Santos)']]));
  const again = (await riko.web('GET', `/api/works/${songId}`)).data;       // he can see the song now, though it is still a draft
  assert.deepEqual(again.evidence.tracks.map((t: any) => [t.trackName, t.takes]), [['Lead Vox', 2], ['Guitar', 5]]);
  assert.equal(again.isOwner, false);
  assert.equal((await riko.web('PUT', `/api/works/${songId}/people`, { people: again.rows })).status, 403);

  // A second project of Nova's own (a vocal session elsewhere) joins without any owner check.
  const second = await nova.sync(project('nova-project-0002', { songCode, tracks: [{ trackName: 'Ad libs', person: 'Nova Kane', signalSeconds: 10, recordSeconds: 5, takes: 1 }] }));
  assert.equal(second.data.workId, songId);
  assert.equal((await nova.web('GET', `/api/works/${songId}`)).data.sources.length, 3);
  assert.equal((await nova.web('GET', '/api/works')).data.length, 1, 'still one song, not three');
});

test('the split flows both ways and neither side silently overwrites the other', async () => {
  const v0 = (await nova.web('GET', `/api/works/${songId}`)).data;
  const fromPlugin = (writer: [number, number], split: Record<string, unknown>) => nova.sync(project('nova-project-0001', {
    contributors: [who('Nova Kane', 'Naomi K. Ellison', writer[0], 100, { artistId: nova.artistId, pro: 'ASCAP', ipi: '00512346789', publisher: 'Kane Songs', publisherIpi: '00698112045', terms: '3 points' }),
      who('Riko Santos', 'Ricardo Santos', writer[1], 0, { artistId: riko.artistId, pro: 'BMI', terms: 'flat fee' })], split }));

  // The plugin has not edited the split: syncing must not change the sheet.
  let r = await fromPlugin([10, 90], { dirty: false, baseVersion: v0.splitVersion });
  assert.deepEqual(r.data.site.rows.map((x: any) => x.writerShare), [60, 40]);
  assert.equal(r.data.site.splitVersion, v0.splitVersion);

  // Edited in the plugin, website unchanged since: accepted.
  r = await fromPlugin([70, 30], { dirty: true, baseVersion: v0.splitVersion });
  assert.deepEqual([r.data.site.conflict, r.data.site.rows.map((x: any) => x.writerShare)], [false, [70, 30]]);
  const v1 = r.data.site.splitVersion;
  assert.ok(v1 > v0.splitVersion);

  // Changed on the website, then the plugin (which has not edited) hears about it.
  const rows = (await nova.web('GET', `/api/works/${songId}`)).data.rows;
  rows[0].writerShare = 55; rows[1].writerShare = 45;
  await nova.web('PUT', `/api/works/${songId}/people`, { people: rows });
  r = await fromPlugin([70, 30], { dirty: false, baseVersion: v1 });
  assert.deepEqual(r.data.site.rows.map((x: any) => x.writerShare), [55, 45], 'the plugin is handed the website version');
  assert.deepEqual(r.data.site.rows.map((x: any) => x.terms), ['3 points', 'flat fee'], 'deal notes survived a website edit');
  const v2 = r.data.site.splitVersion;

  // Both sides changed: nothing is overwritten; the plugin is told and chooses.
  r = await fromPlugin([80, 20], { dirty: true, baseVersion: v1 });
  assert.deepEqual([r.data.site.conflict, r.data.site.rows.map((x: any) => x.writerShare)], [true, [55, 45]]);
  r = await fromPlugin([80, 20], { dirty: true, baseVersion: v1, force: true });
  assert.deepEqual([r.data.site.conflict, r.data.site.rows.map((x: any) => x.writerShare)], [false, [80, 20]]);
  assert.ok(r.data.site.splitVersion > v2);

  // A profile corrected on the website reaches a draft sheet, and through it the plugin.
  await riko.web('PUT', '/api/profile', { artistName: 'Riko Santos', legalName: 'Ricardo M. Santos', role: 'Songwriter', pro: 'BMI', ipi: '00777000111', publisher: 'Santos Music', publisherIpi: '', isni: '', phone: '' });
  r = await fromPlugin([80, 20], { dirty: false, baseVersion: r.data.site.splitVersion });
  assert.deepEqual([r.data.site.rows[1].legalName, r.data.site.rows[1].ipi, r.data.site.rows[1].publisher], ['Ricardo M. Santos', '00777000111', 'Santos Music']);

  // Sent and signed on the website: the plugin sees it and can no longer change it.
  await nova.web('POST', `/api/works/${songId}/send`, {});
  await riko.web('POST', `/api/works/${songId}/decision`, { decision: 'approved' });
  r = await fromPlugin([99, 1], { dirty: true, baseVersion: r.data.site.splitVersion, force: true });
  assert.deepEqual([r.data.site.status, r.data.site.rows.map((x: any) => [x.writerShare, x.status])], ['signed', [[80, 'approved'], [20, 'approved']]]);
  await riko.web('PUT', '/api/profile', { artistName: 'Riko Santos', legalName: 'Someone Else', role: 'Songwriter', pro: '', ipi: '', publisher: '', publisherIpi: '', isni: '', phone: '' });
  assert.equal((await nova.web('GET', `/api/works/${songId}`)).data.rows[1].legalName, 'Ricardo M. Santos', 'a signed sheet stays as it was approved');
});

test('the owner can be handed on, on the website, by the owner only', async () => {
  const w = (await nova.web('POST', '/api/works', { title: 'Hand Over', album: '' })).data;
  assert.equal(w.ownerStated, false);
  assert.equal((await nova.web('POST', `/api/works/${w.id}/owner`, { artistId: 'ST-0000-0000' })).status, 404);
  const handed = await nova.web('POST', `/api/works/${w.id}/owner`, { artistId: mara.artistId });
  assert.deepEqual([handed.data.ownerName, handed.data.ownerStated, handed.data.youOwn, handed.data.isOwner], ['Mara Voss', true, false, true]);
  assert.equal((await nova.web('POST', `/api/works/${w.id}/owner`, { artistId: nova.artistId })).status, 403, 'the starter cannot take it back');
  assert.equal((await mara.web('GET', `/api/works/${w.id}`)).data.youOwn, true);
  assert.equal((await mara.web('POST', `/api/works/${w.id}/owner`, { artistId: nova.artistId })).status, 200, 'the owner can hand it on');
});

test('songs and accounts can be deleted, and your data exported', async () => {
  const w = (await mara.web('POST', '/api/works', { title: 'Scratch Idea', album: '' })).data;
  assert.equal((await mara.web('DELETE', `/api/works/${w.id}`, { confirmTitle: 'scratch' })).status, 400);
  assert.equal((await nova.web('DELETE', `/api/works/${w.id}`, { confirmTitle: 'Scratch Idea' })).status, 404);
  assert.equal((await mara.web('DELETE', `/api/works/${w.id}`, { confirmTitle: 'Scratch Idea' })).status, 200);
  assert.equal((await mara.web('GET', `/api/works/${w.id}`)).status, 404);
  assert.equal((await nova.web('DELETE', `/api/works/${songId}`, { confirmTitle: 'Night Signal' })).status, 409, 'a signed sheet cannot be deleted');

  const mine = (await riko.web('GET', '/api/me/export')).data;
  assert.equal(mine.profile.email, 'riko@example.com');
  assert.ok(mine.songs.some((x: any) => x.title === 'Night Signal'));
  assert.ok(!JSON.stringify(mine).includes('pass_hash') && !JSON.stringify(mine).includes('stk_'));

  assert.equal((await nova.web('DELETE', '/api/me', { password: 'wrong password!' })).status, 401);
  const blocked = await nova.web('DELETE', '/api/me', { password: PASS });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /Night Signal/);
  assert.equal((await mara.web('DELETE', '/api/me', { password: PASS })).status, 200);
  assert.equal((await mara.web('GET', '/api/me')).status, 401);
  assert.equal(await backing.peek.accountsWithEmail('mara@example.com'), 0);
  assert.equal(await backing.peek.sound(), true, 'nothing left pointing at the deleted account');
});

// About the SQLite file itself (its backups, its checks, its migrations), so it runs on SQLite only.
test('housekeeping: backups, checks, tidying and upgrading an older database', { skip: backing.kind !== 'sqlite' && 'SQLite only' }, async () => {
  const db = backing.db!;
  const dir = mkdtempSync(join(tmpdir(), 'stdb-'));
  const copy = backupDatabase(db, join(dir, 'backups'), 2);
  const restored = openDb(copy);
  assert.equal(checkDatabase(restored).ok, true);
  assert.equal((restored.prepare('SELECT title FROM works WHERE id = ?').get(songId) as any).title, 'Night Signal');
  backupDatabase(db, join(dir, 'backups'), 2); backupDatabase(db, join(dir, 'backups'), 2);
  assert.equal(readdirSync(join(dir, 'backups')).filter((f) => f.endsWith('.db')).length, 2, 'only the newest copies are kept');

  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) SELECT ?, id, 1 FROM users LIMIT 1').run('expired');
  assert.ok(tidyDatabase(db).sessions >= 1);

  // A database from before this version (one project per song, record stored on the song) is brought up to date.
  const oldPath = join(dir, 'old.db'), old = new Database(oldPath);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, artist_name TEXT NOT NULL, legal_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'Artist', pro TEXT NOT NULL DEFAULT '', ipi TEXT NOT NULL DEFAULT '', publisher TEXT NOT NULL DEFAULT '', publisher_ipi TEXT NOT NULL DEFAULT '', isni TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE TABLE works (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, title TEXT NOT NULL, album TEXT NOT NULL DEFAULT '', project_id TEXT, status TEXT NOT NULL DEFAULT 'draft', shared INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE people (id INTEGER PRIMARY KEY, work_id TEXT NOT NULL, position INTEGER NOT NULL, artist_name TEXT NOT NULL, legal_name TEXT NOT NULL, role TEXT NOT NULL, writer_share REAL NOT NULL, master_share REAL NOT NULL, email TEXT NOT NULL DEFAULT '', decision TEXT NOT NULL DEFAULT 'none', decided_at INTEGER);
    CREATE TABLE evidence (work_id TEXT PRIMARY KEY, data TEXT NOT NULL, chain_ok INTEGER NOT NULL, chain_head TEXT NOT NULL, synced_at INTEGER NOT NULL);
    INSERT INTO users (id, email, pass_hash, pass_salt, artist_name, legal_name, created_at) VALUES (1, 'old@example.com', 'x', 'y', 'Old Timer', 'O. Timer', 1);
    INSERT INTO works VALUES ('aaaaaaaaaaaaaaaa', 1, 'Old Song', '', 'old-project-0001', 'draft', 0, 1, 1);
    INSERT INTO people (work_id, position, artist_name, legal_name, role, writer_share, master_share, email) VALUES ('aaaaaaaaaaaaaaaa', 0, 'Old Timer', 'O. Timer', 'Artist', 100, 100, 'old@example.com');
    INSERT INTO evidence VALUES ('aaaaaaaaaaaaaaaa', '{"syncedAt":5,"logIntact":true,"logEntries":3,"chainHead":"h","splitsLocked":false,"sessionSeconds":9,"recordSeconds":0,"tracks":[],"takes":[],"bounces":[],"project":null,"projects":[]}', 1, 'h', 5);`);
  old.close();
  const upgraded = openDb(oldPath);
  assert.equal(upgraded.pragma('user_version', { simple: true }), 3);
  assert.deepEqual(upgraded.prepare('SELECT user_id, project_id, work_id, chain_head FROM sources').all(), [{ user_id: 1, project_id: 'old-project-0001', work_id: 'aaaaaaaaaaaaaaaa', chain_head: 'h' }]);
  assert.equal(checkDatabase(upgraded).ok, true);
  // Starting the app on it fills in the codes that did not exist before, and the old song still opens.
  const s2 = createServer(createApp(new SqliteStore(upgraded))); await new Promise<void>((r) => s2.listen(0, r));
  const got = upgraded.prepare('SELECT artist_id FROM users').get() as any, song = upgraded.prepare('SELECT song_code, created_by FROM works').get() as any;
  assert.match(got.artist_id, /^ST-/); assert.match(song.song_code, /^SG-/); assert.equal(song.created_by, 1);
  s2.close();
  assert.ok(existsSync(oldPath));
});
