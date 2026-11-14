import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { fingerprint, parseFingerprintFile, serialiseFingerprint } from '../src/core/fingerprint.ts';
import { mix } from './synth.ts';
import { openDb } from '../server/db.ts';

let server: Server, base = '';
const db = openDb(':memory:');
before(async () => {
  server = createServer(createApp(db));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** One browser: remembers its session cookie. */
let lastCookies = new Map<object, string>();
function client() {
  let cookie = '';
  const self = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers },
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    lastCookies.set(self, cookie);
    return { status: r.status, data: (await r.json()) as any, setCookie: set ?? '' };
  };
  return self;
}
const novaCookie = () => lastCookies.get(nova) ?? '';

const nova = client(), riko = client(), stranger = client();
const PASS = 'correct horse battery';
let workId = '';

test('accounts: register, wrong password, sign in, sign out', async () => {
  assert.equal((await nova('GET', '/api/me')).status, 401);
  assert.equal((await nova('POST', '/api/register', { email: 'nova@example.com', password: 'short', artistName: 'Nova Kane', legalName: 'Naomi K. Ellison' })).status, 400);
  const reg = await nova('POST', '/api/register', { email: 'Nova@Example.com', password: PASS, artistName: 'Nova Kane', legalName: 'Naomi K. Ellison' });
  assert.equal(reg.status, 200);
  assert.equal(reg.data.email, 'nova@example.com');
  assert.match(reg.setCookie, /HttpOnly; SameSite=Lax/);
  assert.equal(reg.data.pass_hash, undefined);
  assert.match(reg.data.artistId, /^ST-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal((await client()('POST', '/api/register', { email: 'nova@example.com', password: PASS, artistName: 'X', legalName: 'Y' })).status, 409);

  assert.equal((await nova('POST', '/api/logout', {})).status, 200);
  assert.equal((await nova('GET', '/api/me')).status, 401);
  const bad = await nova('POST', '/api/login', { email: 'nova@example.com', password: 'wrong password here' });
  assert.equal(bad.status, 401);
  const unknown = await nova('POST', '/api/login', { email: 'nobody@example.com', password: 'wrong password here' });
  assert.equal(unknown.data.error, bad.data.error, 'same reply whether or not the account exists');
  assert.equal((await nova('POST', '/api/login', { email: 'nova@example.com', password: PASS })).status, 200);
  assert.equal((await nova('GET', '/api/me')).data.artistName, 'Nova Kane');

  // Passwords and session tokens are never stored as they are.
  const u = db.prepare('SELECT * FROM users').get() as any;
  assert.ok(!JSON.stringify(u).includes(PASS));
  const s = db.prepare('SELECT token_hash FROM sessions').all() as any[];
  assert.ok(s.length > 0 && s.every((x) => /^[0-9a-f]{64}$/.test(x.token_hash)));
});

test('requests from another site or without JSON are refused', async () => {
  assert.equal((await nova('POST', '/api/works', { title: 'X' }, { origin: 'https://evil.example' })).status, 403);
  const r = await fetch(base + '/api/login', { method: 'POST', body: 'email=a', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 415);
});

test('profile saves', async () => {
  const r = await nova('PUT', '/api/profile', { artistName: 'Nova Kane', legalName: 'Naomi K. Ellison', role: 'Artist', pro: 'ASCAP', ipi: '00512346789', publisher: 'Kane Songs', publisherIpi: '', isni: '', phone: '' });
  assert.equal(r.data.pro, 'ASCAP');
  assert.equal((await nova('PUT', '/api/profile', { artistName: '', legalName: 'x' })).status, 400);
});

test('a split sheet goes from draft to sent to signed', async () => {
  const made = await nova('POST', '/api/works', { title: 'Night Signal' });
  assert.equal(made.status, 200);
  workId = made.data.id;
  assert.equal(made.data.rows[0].writerShare, 100);
  assert.equal(made.data.status, 'draft');

  const people = [
    { artistName: 'Nova Kane', legalName: 'Naomi K. Ellison', role: 'Artist', writerShare: 60, masterShare: 100, email: 'nova@example.com' },
    { artistName: 'Riko Santos', legalName: '', role: 'Songwriter', writerShare: 40, masterShare: 0, email: 'riko@example.com' },
    { artistName: 'Mix Eng', legalName: '', role: 'Mixing Engineer', writerShare: 0, masterShare: 0, email: '' },
  ];
  assert.equal((await nova('PUT', `/api/works/${workId}/people`, { people })).status, 200);
  const blocked = await nova('POST', `/api/works/${workId}/send`, {});
  assert.equal(blocked.status, 400);
  assert.equal(blocked.data.error, 'Legal name missing for Riko Santos');

  people[1].legalName = 'Ricardo Santos';
  await nova('PUT', `/api/works/${workId}/people`, { people });
  // A draft is private to its owner, even from people already named on it.
  const early = client();
  await early('POST', '/api/register', { email: 'riko@example.com', password: PASS, artistName: 'Riko Santos', legalName: 'Ricardo Santos' });
  assert.deepEqual((await early('GET', '/api/works')).data, []);
  assert.equal((await early('GET', `/api/works/${workId}`)).status, 404);
  const sent = await nova('POST', `/api/works/${workId}/send`, {});
  assert.equal(sent.data.status, 'sent');
  assert.deepEqual(sent.data.rows.map((r: any) => r.status), ['approved', 'pending', 'credit']);
  assert.equal(sent.data.awaiting, 1);

  // Once sent, Riko finds the song waiting.
  await riko('POST', '/api/login', { email: 'riko@example.com', password: PASS });
  const list = await riko('GET', '/api/works');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].needsYou, true);
  assert.equal(list.data[0].isOwner, false);
  assert.equal((await riko('PUT', `/api/works/${workId}/people`, { people })).status, 403);
  assert.equal((await riko('POST', `/api/works/${workId}/send`, {})).status, 403);

  const signed = await riko('POST', `/api/works/${workId}/decision`, { decision: 'approved' });
  assert.equal(signed.data.status, 'signed');
  assert.equal(signed.data.chainIntact, true);
  assert.deepEqual(signed.data.events.map((e: any) => e.type), ['CREATE', 'SPLIT', 'SPLIT', 'SEND', 'APPROVE', 'SIGNED']);
  assert.equal((await nova('PUT', `/api/works/${workId}/people`, { people })).status, 409);
});

test('changing a sent sheet withdraws approvals; declining does not sign', async () => {
  const w = (await nova('POST', '/api/works', { title: 'Glass Hours' })).data;
  const people = [
    { artistName: 'Nova Kane', legalName: 'Naomi K. Ellison', role: 'Artist', writerShare: 50, masterShare: 50, email: 'nova@example.com' },
    { artistName: 'Riko Santos', legalName: 'Ricardo Santos', role: 'Songwriter', writerShare: 50, masterShare: 50, email: 'riko@example.com' },
  ];
  await nova('PUT', `/api/works/${w.id}/people`, { people });
  await nova('POST', `/api/works/${w.id}/send`, {});
  const declined = await riko('POST', `/api/works/${w.id}/decision`, { decision: 'declined' });
  assert.equal(declined.data.status, 'sent');
  assert.equal(declined.data.rows[1].status, 'declined');

  people[0].writerShare = 40; people[1].writerShare = 60;
  const edited = await nova('PUT', `/api/works/${w.id}/people`, { people });
  assert.equal(edited.data.status, 'draft');
  assert.deepEqual(edited.data.rows.map((r: any) => r.status), ['draft', 'draft']);
  assert.equal((await riko('POST', `/api/works/${w.id}/decision`, { decision: 'approved' })).status, 409);
});

test('songs are filed under albums and can share a split', async () => {
  const first = (await nova('POST', '/api/works', { title: 'Low Orbit', album: 'Afterglow' })).data;
  const people = [
    { artistName: 'Nova Kane', legalName: 'Naomi K. Ellison', role: 'Artist', writerShare: 70, masterShare: 80, email: 'nova@example.com' },
    { artistName: 'Riko Santos', legalName: 'Ricardo Santos', role: 'Songwriter', writerShare: 30, masterShare: 20, email: 'riko@example.com' },
  ];
  await nova('PUT', `/api/works/${first.id}/people`, { people });
  const second = (await nova('POST', '/api/works', { title: 'Afterglow (Reprise)', album: 'Afterglow', copyFrom: first.id })).data;
  assert.equal(second.album, 'Afterglow');
  assert.deepEqual(second.rows.map((r: any) => [r.artistName, r.writerShare, r.masterShare]), [['Nova Kane', 70, 80], ['Riko Santos', 30, 20]]);
  assert.equal(second.status, 'draft');

  const moved = await nova('PUT', `/api/works/${second.id}`, { title: 'Afterglow (Reprise)', album: 'B-sides' });
  assert.equal(moved.data.album, 'B-sides');
  // Riko is named on both drafts but cannot see, move or copy them until they are sent.
  assert.equal((await riko('PUT', `/api/works/${second.id}`, { title: 'Mine now', album: '' })).status, 404);
  assert.equal((await riko('POST', '/api/works', { title: 'Copy', album: '', copyFrom: first.id })).status, 404);
  // Even for a song Riko can see, only its owner can copy its split.
  assert.equal((await riko('POST', '/api/works', { title: 'Copy', album: '', copyFrom: workId })).status, 403);
  const albums = new Set((await nova('GET', '/api/works')).data.map((w: any) => w.album));
  assert.ok(albums.has('Afterglow') && albums.has('B-sides') && albums.has(''));
});

test('messages reach the people on the song and nobody else', async () => {
  assert.equal((await riko('POST', `/api/works/${workId}/messages`, { body: 'Signed. Thanks.' })).status, 200);
  const seen = await nova('GET', `/api/works/${workId}`);
  assert.equal(seen.data.messages[0].body, 'Signed. Thanks.');
  assert.equal(seen.data.messages[0].mine, false);
  assert.equal(seen.data.messages[0].author, 'Riko Santos');

  await stranger('POST', '/api/register', { email: 'stranger@example.com', password: PASS, artistName: 'Stranger', legalName: 'S. Tranger' });
  assert.equal((await stranger('GET', `/api/works/${workId}`)).status, 404);
  assert.equal((await stranger('POST', `/api/works/${workId}/messages`, { body: 'hi' })).status, 404);
  assert.equal((await stranger('POST', `/api/works/${workId}/decision`, { decision: 'approved' })).status, 404);
  assert.deepEqual((await stranger('GET', '/api/works')).data, []);
  assert.deepEqual((await stranger('GET', '/api/activity')).data, []);
  assert.equal((await client()('GET', `/api/works/${workId}`)).status, 401);
});

test('the plugin syncs a project: song, split, evidence and fingerprints', async () => {
  const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
  // Sign in fresh: the lockout test below and earlier tests share accounts.
  assert.equal((await nova('POST', '/api/keys', { name: 'Studio Mac' }, { origin: 'https://evil.example' })).status, 403);
  const made = await nova('POST', '/api/keys', { name: 'Studio Mac' });
  const key: string = made.data.key;
  assert.match(key, /^stk_/);
  assert.equal(made.data.keys[0].name, 'Studio Mac');
  assert.equal((await nova('GET', '/api/keys')).data[0].key, key, 'the owner can read the key again later');
  assert.equal((await riko('GET', '/api/keys')).data.length, 0, 'nobody else can see it');

  const plugin = (method: string, path: string, body: unknown, k = key) => fetch(base + path, {
    method, headers: { authorization: `Bearer ${k}`, 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' },
    body: Buffer.isBuffer(body) ? body : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: (await r.json()) as any }));

  // A project as the plugin describes it, with a log chained the way the plugin chains it.
  const projectId = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
  let prev = sha(`GENESIS|${projectId}`);
  const entries = [['SESSION', 'Session opened'], ['TAKE', 'Take 1 on "Lead Vox" (Nova Kane): 0:48'], ['LOCK', 'Splits locked'],
    ['PROJECT', `Signed project file Halo Drift.logicx (Logic Pro): SHA-256 ${sha('older save')}, 12 files, 3 MB`],
    ['PROJECT', `Signed automatically, as last saved: Halo Drift.logicx (Logic Pro): SHA-256 ${sha('project')}, 12 files, 3 MB`]].map(([type, text], i) => {
    const time = 1_794_000_000_000 + i * 1000;
    prev = sha(`${prev}|${time}|${type}|${text}`);
    return { time, type, text, hash: prev };
  });
  const master = Buffer.from(serialiseFingerprint(fingerprint([mix(1, 12, 44100)], 44100)));
  const stem = Buffer.from(serialiseFingerprint(fingerprint([mix(2, 12, 44100)], 44100)));
  const payload = {
    schema: 1, projectId, title: 'Halo Drift', splitsConfirmed: true, sessionSeconds: 3600, recordSeconds: 48,
    contributors: [
      { artistName: 'Nova Kane', legalName: 'Naomi K. Ellison', role: 'Artist', writerShare: 50, masterShare: 100 },
      { artistName: 'DJ Halcyon', legalName: 'Halvard Lindqvist', role: 'Producer', writerShare: 50, masterShare: 0 },
    ],
    tracks: [{ trackName: 'Lead Vox', person: 'Nova Kane', signalSeconds: 300, recordSeconds: 48, takes: 1 }],
    takes: [{ track: 'Lead Vox', person: 'Nova Kane', num: 1, time: 1_794_000_001_000, durationSecs: 48, songPos: 32.5 }],
    bounces: [{ num: 1, time: 1_794_000_100_000, durationSecs: 12, fpId: sha(master), fileSha: '', stems: [{ trackName: 'Lead Vox', person: 'Nova Kane', fpId: sha(stem) }] }],
    project: { fileName: 'Halo Drift.logicx', sha: sha('project'), daw: 'Logic Pro', time: 1_794_000_200_000 },
    log: { entries },
  };

  assert.equal((await plugin('POST', '/api/plugin/sync', payload, 'stk_notarealkeynotarealkeynotarealkey')).status, 401);
  const first = await plugin('POST', '/api/plugin/sync', payload);
  assert.equal(first.status, 200);
  assert.equal(first.data.logIntact, true);
  assert.deepEqual(new Set(first.data.missingFingerprints), new Set([sha(master), sha(stem)]));
  const id: string = first.data.workId;

  // The song now exists for Nova with the plugin's split; her own row got her email.
  const seen = (await nova('GET', `/api/works/${id}`)).data;
  assert.equal(seen.title, 'Halo Drift');
  assert.deepEqual(seen.rows.map((r: any) => [r.artistName, r.writerShare, r.email]), [['Nova Kane', 50, 'nova@example.com'], ['DJ Halcyon', 50, '']]);
  assert.equal(seen.evidence.tracks[0].takes, 1);
  assert.equal(seen.evidence.logIntact, true);
  assert.equal(seen.evidence.bounces[0].stems[0].person, 'Nova Kane');

  // Every signed version of the project can be cross-checked, and only by people on the song.
  const sigs = (await nova('GET', '/api/signatures')).data;
  assert.deepEqual(sigs.map((x: any) => [x.kind, x.label, x.sha, x.latest]), [
    ['Project file', 'Halo Drift.logicx (Logic Pro)', sha('older save'), false],
    ['Project file', 'Halo Drift.logicx (Logic Pro)', sha('project'), true]]);
  assert.deepEqual((await stranger('GET', '/api/signatures')).data, []);

  // Fingerprints: wrong bytes and unknown ids are refused; the right file is stored and can be read back.
  assert.equal((await plugin('PUT', `/api/plugin/works/${id}/fingerprints/${sha(master)}`, stem)).status, 400);
  assert.equal((await plugin('PUT', `/api/plugin/works/${id}/fingerprints/${sha('x')}`, Buffer.from('x'))).status, 400);
  assert.equal((await plugin('PUT', `/api/plugin/works/${id}/fingerprints/${sha(master)}`, master)).status, 200);
  assert.equal((await plugin('PUT', `/api/plugin/works/${id}/fingerprints/${sha(stem)}`, stem)).status, 200);
  const listed = (await nova('GET', '/api/fingerprints')).data;
  assert.deepEqual(listed.map((f: any) => [f.title, f.kind, f.name]).sort(), [['Halo Drift', 'Master', 'Master'], ['Halo Drift', 'Stem', 'Lead Vox (Nova Kane)']]);
  const back = await fetch(`${base}/api/works/${id}/fingerprints/${sha(master)}`, { headers: { cookie: (await nova('GET', '/api/me'), novaCookie()) } });
  assert.equal(parseFingerprintFile(await back.arrayBuffer())!.frames.length, parseFingerprintFile(master.buffer.slice(master.byteOffset, master.byteOffset + master.length))!.frames.length);
  assert.equal((await stranger('GET', `/api/works/${id}/fingerprints/${sha(master)}`)).status, 404);
  assert.deepEqual((await stranger('GET', '/api/fingerprints')).data, []);

  // Clicking a stem shows only its own track's log; the master shows the song-wide lines.
  const stemInfo = (await nova('GET', `/api/works/${id}/fingerprints/${sha(stem)}/details?track=${encodeURIComponent('Lead Vox')}`)).data;
  assert.equal(stemInfo.kind, 'Stem');
  assert.equal(stemInfo.track.person, 'Nova Kane');
  assert.equal(stemInfo.takes.length, 1);
  assert.deepEqual(stemInfo.log.map((l: any) => l.type), ['TAKE']);
  const masterInfo = (await nova('GET', `/api/works/${id}/fingerprints/${sha(master)}/details`)).data;
  assert.equal(masterInfo.kind, 'Master');
  assert.deepEqual(masterInfo.stems, [{ trackName: 'Lead Vox', person: 'Nova Kane' }]);
  assert.deepEqual(masterInfo.log.map((l: any) => l.type), ['SESSION', 'LOCK', 'PROJECT', 'PROJECT']);
  assert.equal((await stranger('GET', `/api/works/${id}/fingerprints/${sha(master)}/details`)).status, 404);
  assert.equal((await nova('GET', `/api/works/${id}/fingerprints/${sha('nope')}/details`)).status, 404);

  // Syncing again: nothing missing, same song, email entered on the web is kept when the split changes.
  const people = seen.rows.map((r: any) => ({ ...r, email: r.artistName === 'DJ Halcyon' ? 'halcyon@example.com' : r.email }));
  await nova('PUT', `/api/works/${id}/people`, { people });
  payload.contributors[0].writerShare = 60; payload.contributors[1].writerShare = 40;
  const second = await plugin('POST', '/api/plugin/sync', payload);
  assert.equal(second.data.workId, id);
  assert.deepEqual(second.data.missingFingerprints, []);
  const after = (await nova('GET', `/api/works/${id}`)).data;
  assert.deepEqual(after.rows.map((r: any) => [r.writerShare, r.email]), [[60, 'nova@example.com'], [40, 'halcyon@example.com']]);

  // Sending waits until everyone with a share has an account.
  const tooEarly = await nova('POST', `/api/works/${id}/send`, {});
  assert.equal(tooEarly.status, 400);
  assert.match(tooEarly.data.error, /DJ Halcyon has not signed up yet/);
  const halcyon = client();
  const hReg = await halcyon('POST', '/api/register', { email: 'halcyon@example.com', password: PASS, artistName: 'DJ Halcyon', legalName: 'Halvard Lindqvist' });

  // The plugin can ask who it is linked to, and look someone up by Artist ID.
  const get = (path: string) => fetch(base + path, { headers: { authorization: `Bearer ${key}` } }).then(async (r) => ({ status: r.status, data: (await r.json()) as any }));
  const me = await get('/api/plugin/whoami');
  assert.deepEqual([me.data.artistName, me.data.email], ['Nova Kane', 'nova@example.com']);
  const card = await get(`/api/plugin/artists/${encodeURIComponent(hReg.data.artistId.toLowerCase().replace(/-/g, ' '))}`);
  assert.deepEqual([card.data.artistName, card.data.legalName, card.data.artistId], ['DJ Halcyon', 'Halvard Lindqvist', hReg.data.artistId]);
  assert.equal((await get('/api/plugin/artists/ST-0000-0000')).status, 404, 'a well-formed ID nobody owns');
  assert.equal((await get('/api/plugin/artists/not-an-id')).status, 400);
  assert.equal((await fetch(`${base}/api/plugin/artists/${hReg.data.artistId}`)).status, 401, 'no key, no lookup');
  assert.equal((await nova('GET', `/api/artists/${hReg.data.artistId}`)).data.email, 'halcyon@example.com');

  // A contributor sent with an Artist ID is tied to that account, whatever name was typed.
  const third = (await plugin('POST', '/api/plugin/sync', { ...payload, projectId: 'id-linked-project-0001', title: 'ID Linked',
    contributors: [{ artistName: 'Nova Kane', legalName: 'Naomi K. Ellison', role: 'Artist', writerShare: 50, masterShare: 100, artistId: me.data.artistId },
      { artistName: 'Halcyon (typed differently)', legalName: 'H. Lindqvist', role: 'Producer', writerShare: 50, masterShare: 0, artistId: hReg.data.artistId }] })).data;
  const linked = (await nova('GET', `/api/works/${third.workId}`)).data;
  assert.deepEqual(linked.rows.map((r: any) => [r.email, r.hasAccount]), [['nova@example.com', true], ['halcyon@example.com', true]]);
  assert.equal(third.account.artistName, 'Nova Kane');

  // Once sent, the plugin can no longer change the split.
  await nova('POST', `/api/works/${id}/send`, {});
  payload.contributors[0].writerShare = 90; payload.contributors[1].writerShare = 10;
  await plugin('POST', '/api/plugin/sync', payload);
  assert.deepEqual((await nova('GET', `/api/works/${id}`)).data.rows.map((r: any) => r.writerShare), [60, 40]);

  // A log edited after the fact is reported.
  payload.log.entries[1].text = 'Take 1 on "Lead Vox" (Someone Else): 0:48';
  const tampered = await plugin('POST', '/api/plugin/sync', payload);
  assert.equal(tampered.data.logIntact, false);
  assert.equal((await nova('GET', `/api/works/${id}`)).data.evidence.logIntact, false);

  // A revoked key stops working.
  await nova('DELETE', `/api/keys/${made.data.keys[0].id}`, {});
  assert.equal((await plugin('POST', '/api/plugin/sync', payload)).status, 401);
});

test('editing the stored history is detected', async () => {
  db.prepare("UPDATE events SET text = 'Nova Kane set the split (writer/master): Nova Kane 100/100' WHERE work_id = ? AND type = 'SPLIT'").run(workId);
  assert.equal((await nova('GET', `/api/works/${workId}`)).data.chainIntact, false);
});

test('too many wrong passwords locks sign-in for a while', async () => {
  const c = client();
  for (let i = 0; i < 10; i++) assert.equal((await c('POST', '/api/login', { email: 'riko@example.com', password: 'nope nope nope' })).status, 401);
  assert.equal((await c('POST', '/api/login', { email: 'riko@example.com', password: PASS })).status, 429);
});
