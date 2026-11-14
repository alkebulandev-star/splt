// Two-way sync, end to end, with the real plugin code on one side and the real server on the other.
// Runs the plugin's processor (through build/UiShot --sync) as two people working in two separate
// projects on one song, with edits made on the website in between.      npm run test:sync
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.ts';
import { makeStore } from '../helpers/store.ts';

const tool = join(import.meta.dirname, '../../../build/UiShot');
if (!existsSync(tool)) { console.log('UiShot is not built; skipping.'); process.exit(0); }

// SQLite in memory by default; STORE=firestore runs the same stages on a throwaway Firestore namespace,
// which is deleted at the end whether or not they passed.
const backing = await makeStore();
const server = createServer(createApp(backing.store));
try {
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
const dir = mkdtempSync(join(tmpdir(), 'stsync-'));

async function person(artistName: string, legalName: string, email: string) {
  let cookie = '';
  const web = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) } });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return (await r.json()) as any;
  };
  const me = await web('POST', '/api/register', { email, password: 'integration-test-pass', artistName, legalName });
  const key: string = (await web('POST', '/api/keys', { name: 'Test' })).key;
  const state = join(dir, `${artistName.replace(/\W/g, '')}.state`);
  // Each call is the plugin opening that person's project, doing the actions, and closing again.
  // (Run without blocking: the server it talks to lives in this same process.)
  const plugin = (...actions: string[]) => new Promise<any>((resolve, reject) => {
    const child = spawn(tool, ['--sync', state, ...actions], { env: { ...process.env, SPLIT_TRACKER_SERVER: base, SPLIT_TRACKER_KEY: key, SPLIT_TRACKER_OWN_PROCESS_ONLY: '1', SPLIT_TRACKER_ACCOUNT_FILE: join(dir, 'none.json'), SPLIT_TRACKER_LIVE_DIR: join(dir, 'live') } });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.on('exit', () => { try { resolve(JSON.parse(out.trim().split('\n').pop()!)); } catch { reject(new Error('plugin printed: ' + out)); } });
  });
  return { web, plugin, key, artistId: me.artistId as string };
}
const step = (text: string) => console.log('  ✓ ' + text);
const shares = (p: any) => p.people.map((x: any) => [x[0], x[1]]);

const nova = await person('Nova Kane', 'Naomi K. Ellison', 'nova@example.com');
const riko = await person('Riko Santos', 'Ricardo Santos', 'riko@example.com');

// 1. Nova starts the song in her project. Every field goes up, and the song's code comes back.
let p = await nova.plugin('title=Night Signal', 'isrc=US-ABC-26-00001', `owner=${nova.artistId}`,
  `add=Nova Kane|Naomi K. Ellison|60|100|${nova.artistId}|3 points`, `add=Riko Santos|Ricardo Santos|40|0|${riko.artistId}|flat fee`, 'sync');
assert.match(p.message, /^Synced "Night Signal"/, p.message);
assert.match(p.songCode, /^SG-/);
assert.match(p.account, /^Nova Kane \(ST-/);
assert.deepEqual([p.status, p.dirty, p.conflict, p.version], ['draft', false, false, 1]);
const songs = await nova.web('GET', '/api/works');
assert.equal(songs.length, 1);
const id = songs[0].id;
let d = await nova.web('GET', `/api/works/${id}`);
assert.deepEqual([d.isrc, d.ownerStated, d.ownerName], ['US-ABC-26-00001', true, 'Nova Kane']);
assert.deepEqual(d.rows.map((r: any) => [r.artistName, r.writerShare, r.terms, r.email]), [['Nova Kane', 60, '3 points', 'nova@example.com'], ['Riko Santos', 40, 'flat fee', 'riko@example.com']]);
step('new song created from the plugin with every field, owner stated, song code returned');

// 2. A change in the plugin uploads by itself a moment later: no bounce, no button.
p = await nova.plugin('writer=0:65', 'writer=1:35', 'wait=6');
d = await nova.web('GET', `/api/works/${id}`);
assert.deepEqual(d.rows.map((r: any) => r.writerShare), [65, 35], 'the edit reached the website without pressing Sync');
assert.equal(p.dirty, false);
step('a split change in the plugin syncs by itself');

// 3. Changed on the website: the plugin loads it on its next sync.
d.rows[0].writerShare = 55; d.rows[1].writerShare = 45;
await nova.web('PUT', `/api/works/${id}/people`, { people: d.rows });
p = await nova.plugin('sync');
assert.deepEqual(shares(p), [['Nova Kane', 55], ['Riko Santos', 45]]);
assert.deepEqual(p.people.map((x: any) => x[4]), ['3 points', 'flat fee'], 'deal notes kept through a website edit');
step('a split change on the website is loaded into the plugin');

// 4. Changed in both places: nothing is overwritten until the user chooses.
d = await nova.web('GET', `/api/works/${id}`);
d.rows[0].writerShare = 50; d.rows[1].writerShare = 50;
await nova.web('PUT', `/api/works/${id}/people`, { people: d.rows });
p = await nova.plugin('writer=0:70', 'writer=1:30', 'sync');
assert.equal(p.conflict, true);
assert.deepEqual(shares(p), [['Nova Kane', 70], ['Riko Santos', 30]], 'the plugin keeps its version while the choice is open');
assert.deepEqual((await nova.web('GET', `/api/works/${id}`)).rows.map((r: any) => r.writerShare), [50, 50], 'and the website keeps its own');
// "Send mine" in the same session (a conflict is not remembered across a reopen; the next sync finds it again).
p = await nova.plugin('sync', 'send-mine');
assert.equal(p.conflict, false);
assert.deepEqual((await nova.web('GET', `/api/works/${id}`)).rows.map((r: any) => r.writerShare), [70, 30]);
// And the other choice, with a fresh conflict.
d = await nova.web('GET', `/api/works/${id}`);
d.rows[0].writerShare = 60; d.rows[1].writerShare = 40;
await nova.web('PUT', `/api/works/${id}/people`, { people: d.rows });
p = await nova.plugin('writer=0:90', 'writer=1:10', 'sync', 'use-website');
assert.deepEqual([p.conflict, shares(p)], [false, [['Nova Kane', 60], ['Riko Santos', 40]]]);
step('a conflict is reported, and both "Send mine" and "Use website\'s" resolve it');

// 5. Riko works in his own separate project and joins with the song code and the owner's ID.
let q = await riko.plugin('title=rikos guitar session', `code=${p.songCode}`, 'sync');
assert.match(q.message, /enter its owner's Artist ID/i, q.message);
q = await riko.plugin(`owner=${nova.artistId}`, `add=Riko Santos|Ricardo Santos|100|100|${riko.artistId}|`, 'sync');
assert.match(q.message, /^Synced "Night Signal"/, q.message);
assert.equal(q.title, 'Night Signal', 'his project takes the song\'s name');
assert.equal(q.managedElsewhere, true);
assert.deepEqual(shares(q), [['Nova Kane', 60], ['Riko Santos', 40]], 'his plugin shows the real split, not the one he typed');
assert.match(q.summary, /managed by Nova Kane/);
d = await nova.web('GET', `/api/works/${id}`);
assert.deepEqual([d.sources.length, d.rows.map((r: any) => r.writerShare)], [2, [60, 40]], 'two projects, one song, split untouched');
assert.equal((await riko.web('GET', '/api/works')).length, 1);
step('a second person\'s separate project joins the same song and cannot disturb the split');

// 6. Riko corrects his legal name on the website: it reaches both plugins.
await riko.web('PUT', '/api/profile', { artistName: 'Riko Santos', legalName: 'Ricardo M. Santos', role: 'Songwriter', pro: 'BMI', ipi: '00777000111', publisher: '', publisherIpi: '', isni: '', phone: '' });
p = await nova.plugin('sync'); q = await riko.plugin('sync');
assert.deepEqual([p.people[1][2], p.people[1][5], q.people[1][2]], ['Ricardo M. Santos', '00777000111', 'Ricardo M. Santos']);
step('a profile corrected on the website reaches both plugins');

// 7. Locking in the plugin uploads by itself; signing on the website locks both plugins.
p = await nova.plugin('lock', 'wait=6');
assert.equal((await nova.web('GET', `/api/works/${id}`)).evidence.splitsLocked, true, 'the lock reached the website without pressing Sync');
await nova.web('POST', `/api/works/${id}/send`, {});
await riko.web('POST', `/api/works/${id}/decision`, { decision: 'approved' });
p = await nova.plugin('writer=0:99', 'writer=1:1', 'sync');       // an edit after signing must not stick
q = await riko.plugin('sync');
assert.deepEqual([p.status, p.locked, shares(p)], ['signed', true, [['Nova Kane', 60], ['Riko Santos', 40]]]);
assert.deepEqual([q.status, q.locked], ['signed', true]);
assert.deepEqual((await nova.web('GET', `/api/works/${id}`)).rows.map((r: any) => [r.writerShare, r.status]), [[60, 'approved'], [40, 'approved']]);
step('signing on the website locks the split in both plugins, and later edits do not stick');

// 8. No internet in the studio: the plugin saves a receipt file, and the owner uploads it on the website.
const run = (state: string, key: string, ...actions: string[]) => new Promise<any>((resolve, reject) => {
  // With no key the plugin is not linked to any account, which is what an offline studio computer looks like.
  const child = spawn(tool, ['--sync', join(dir, state), ...actions], { env: { ...process.env, SPLIT_TRACKER_SERVER: key ? base : 'http://localhost:9', SPLIT_TRACKER_KEY: key, SPLIT_TRACKER_OWN_PROCESS_ONLY: '1', SPLIT_TRACKER_ACCOUNT_FILE: join(dir, 'none.json'), SPLIT_TRACKER_LIVE_DIR: join(dir, 'live') } });
  let out = '';
  child.stdout.on('data', (b) => (out += b));
  child.on('exit', () => { try { resolve(JSON.parse(out.trim().split('\n').pop()!)); } catch { reject(new Error('plugin printed: ' + out)); } });
});
const mara = await person('Mara Voss', 'Mara E. Voss', 'mara@example.com');
const file = join(dir, 'low-tide.splitreceipt');
await run('lowtide.state', '', 'title=Low Tide', `add=Mara Voss|Mara E. Voss|70|100|${mara.artistId}|`, `add=Riko Santos|Ricardo M. Santos|30|0|${riko.artistId}|flat fee`, 'lock', `receipt=${file}`);
const receipt = JSON.parse(readFileSync(file, 'utf8'));
assert.deepEqual([receipt.format, receipt.version, receipt.madeBy], ['split-tracker-receipt', 1, '']);

const edited = { ...receipt, payload: receipt.payload.replace('"writerShare": 70', '"writerShare": 99') };
assert.notEqual(edited.payload, receipt.payload);
assert.match((await mara.web('POST', '/api/receipts', { receipt: edited, mode: 'new' })).error, /changed after the plugin saved it/);
assert.equal((await mara.web('GET', '/api/works')).length, 0, 'an edited receipt registers nothing');

let up = await mara.web('POST', '/api/receipts', { receipt, mode: 'new', iAmOwner: true });
assert.deepEqual([up.title, up.created, up.logIntact], ['Low Tide', true, true]);
let lt = await mara.web('GET', `/api/works/${up.workId}`);
assert.deepEqual([lt.ownerStated, lt.ownerName, lt.evidence.splitsLocked, lt.rows.map((r: any) => [r.artistName, r.writerShare, r.email])],
  [true, 'Mara Voss', true, [['Mara Voss', 70, 'mara@example.com'], ['Riko Santos', 30, 'riko@example.com']]]);
assert.equal(lt.sources[0].receiptUploadedBy, 'Mara Voss');
assert.match(lt.events.map((e: any) => e.text).join('\n'), /An offline receipt from .+, uploaded by Mara Voss, created "Low Tide", owned by Mara Voss/);
up = await mara.web('POST', '/api/receipts', { receipt, mode: 'new' });
assert.deepEqual([up.created, (await mara.web('GET', '/api/works')).length], [false, 1], 'uploading the same receipt twice does not make a second song');
step('an offline receipt registers the song on the website; an edited one is refused');

// The studio computer comes online: the plugin's own sync takes over that same song.
let m = await run('lowtide.state', mara.key, 'sync');
assert.match(m.message, /^Synced "Low Tide"/, m.message);
lt = await mara.web('GET', `/api/works/${up.workId}`);
assert.deepEqual([lt.sources.length, lt.sources[0].receiptUploadedBy, (await mara.web('GET', '/api/works')).length], [1, undefined, 1]);
m = await run('lowtide.state', '', 'receipt=' + join(dir, 'old.splitreceipt'));
step('when the plugin is online again it carries on with the same song');

// A collaborator's offline project: the owner adds its receipt to her song, and may take its split.
const file2 = join(dir, 'riko-bass.splitreceipt');
await run('rikobass.state', '', 'title=bass ideas', `add=Mara Voss|Mara E. Voss|50|100|${mara.artistId}|`, `add=Riko Santos|Ricardo M. Santos|50|0|${riko.artistId}|`, `receipt=${file2}`);
const receipt2 = JSON.parse(readFileSync(file2, 'utf8'));
assert.equal((await riko.web('POST', '/api/receipts', { receipt: receipt2, mode: 'add', workId: up.workId })).error, 'Choose one of the songs you manage');
up = await mara.web('POST', '/api/receipts', { receipt: receipt2, mode: 'add', workId: up.workId });
lt = await mara.web('GET', `/api/works/${up.workId}`);
assert.deepEqual([up.created, lt.title, lt.sources.length, lt.rows.map((r: any) => r.writerShare)], [false, 'Low Tide', 2, [70, 30]], 'added beside hers; her split is untouched');
up = await mara.web('POST', '/api/receipts', { receipt: receipt2, mode: 'add', workId: up.workId, useSplit: true });
lt = await mara.web('GET', `/api/works/${up.workId}`);
assert.deepEqual(lt.rows.map((r: any) => r.writerShare), [50, 50], 'the owner chose to take the split from the receipt');
// Riko's computer comes online and joins with the song code: his live record replaces the receipt.
q = await run('rikobass.state', riko.key, `code=${lt.songCode}`, `owner=${mara.artistId}`, 'sync');
assert.match(q.message, /^Synced "Low Tide"/, q.message);
lt = await mara.web('GET', `/api/works/${up.workId}`);
assert.deepEqual([lt.sources.length, lt.sources.filter((x: any) => x.receiptUploadedBy).length], [2, 0]);
assert.match(lt.events.map((e: any) => e.text).join('\n'), /earlier offline receipt was replaced by the live record/);
step("a collaborator's receipt is added to the owner's song, and is replaced once their plugin syncs");

} finally {
  server.close();
  await backing.close();
}
console.log('Plugin and website stay in sync in both directions.');
