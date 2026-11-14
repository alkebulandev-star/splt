// End-to-end check of the plugin link: starts the server, creates an account and a plugin key,
// runs the plugin's C++ host test (which loads the real plugins, tags tracks, records a take and
// bounces) pointed at that server, then checks what arrived.   npm run test:plugin
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createApp } from '../../server/app.ts';
import { openDb } from '../../server/db.ts';
import { compare, isStrong, parseFingerprintFile } from '../../src/core/fingerprint.ts';
import { mix, wav16 } from '../synth.ts';

const hostTest = join(import.meta.dirname, '../../../build/HostTest_artefacts/Release/HostTest');
if (!existsSync(hostTest)) { console.log('HostTest is not built; skipping.'); process.exit(0); }

const app = createApp(openDb(':memory:'));
const seen: string[] = [];
const server = createServer((req, res) => { res.on('finish', () => seen.push(`${req.method} ${req.url?.slice(0, 60)} -> ${res.statusCode}`)); void app(req, res); });
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

let cookie = '';
async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return r;
}
await api('POST', '/api/register', { email: 'tester@example.com', password: 'integration-test-pass', artistName: 'Test Artist', legalName: 'Test A. Artist' });
const { key } = (await (await api('POST', '/api/keys', { name: 'Host test' })).json()) as { key: string };

const song = join(mkdtempSync(join(tmpdir(), 'stlink-')), 'song.wav');
writeFileSync(song, wav16(mix(1, 40, 44100), 44100));

console.log('Running the plugin host test against', base, '...');
const code = await new Promise<number>((resolve) => {
  const child = spawn(hostTest, [song], { env: { ...process.env, SPLIT_TRACKER_SERVER: base, SPLIT_TRACKER_KEY: key }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.on('exit', (c) => { console.log(out.trim().split('\n').filter((l) => /FAIL|passed|project/i.test(l)).join('\n')); resolve(c ?? 1); });
});
assert.equal(code, 0, 'the plugin host test itself must pass');

const works = (await (await api('GET', '/api/works')).json()) as any[];
assert.ok(works.length >= 1, 'the plugin created a song on the server');
let checked = 0;
for (const w of works) {
  const d = (await (await api('GET', `/api/works/${w.id}`)).json()) as any;
  const ev = d.evidence;
  assert.ok(ev, `${d.title}: evidence arrived`);
  assert.equal(ev.logIntact, true, `${d.title}: the server re-checked the plugin's log chain and it holds`);
  if (ev.bounces.length === 0) continue;
  const stems = ev.bounces.flatMap((b: any) => b.stems);
  console.log(`  "${d.title}": ${ev.logEntries} log entries, ${ev.tracks.length} tracks, ${ev.takes.length} takes, ${ev.bounces.length} bounce(s), ${stems.length} stems, split rows: ${d.rows.length}`);
  assert.ok(d.rows.length >= 1, 'the song has a split sheet to work on');
  assert.ok(stems.length >= 2, 'both tagged tracks sent a stem');
  assert.ok(ev.takes.length >= 1, 'the recorded take arrived');
  checked++;
}
assert.ok(checked >= 1, 'at least one song has a bounce');

if (process.env.SHOW_REQUESTS) console.log(seen.filter((l) => l.includes('/plugin/')).join('\n'));
const fps = (await (await api('GET', '/api/fingerprints')).json()) as any[];
assert.ok(fps.filter((f) => f.kind === 'Master').length >= 1 && fps.filter((f) => f.kind === 'Stem').length >= 2, 'master and stem fingerprint files were uploaded');
const load = async (f: any) => parseFingerprintFile(await (await api('GET', `/api/works/${f.workId}/fingerprints/${f.fpId}`)).arrayBuffer())!;
const master = await load(fps.find((f) => f.kind === 'Master'));
assert.ok(master.frames.length > 256, 'the uploaded master fingerprint is readable');
assert.ok(isStrong(compare(master.frames, master.frames)), 'and matches itself');
console.log(`  fingerprints on the server: ${fps.map((f) => `${f.kind} ${f.name}`).join(', ')}`);

// The plugin's own C++ client: which account the key belongs to, and looking someone up by Artist ID.
const tool = join(import.meta.dirname, '../../../build/FindProject_artefacts/Release/FindProject');
if (existsSync(tool)) {
  const run = (...a: string[]) => new Promise<string>((resolve) => { const c = spawn(tool, a); let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('exit', () => resolve(o.trim())); });
  const me = await run('--whoami', base, key);
  assert.match(me, /^ST-[0-9A-Z]{4}-[0-9A-Z]{4}\|Test Artist\|Test A\. Artist/, 'the plugin can tell which account it is linked to');
  const other = await fetch(base + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'second@example.com', password: 'integration-test-pass', artistName: 'Second Artist', legalName: 'Sec O. Artist' }) }).then((r) => r.json()) as any;
  const found = await run('--artist', base, key, other.artistId.toLowerCase().replace(/-/g, ' '));
  assert.equal(found.split('|').slice(0, 3).join('|'), `${other.artistId}|Second Artist|Sec O. Artist`, 'looking up an Artist ID fills in their name and legal name');
  assert.match(await run('--artist', base, key, 'ST-0000-0000'), /^ERROR No account has that Artist ID/);
  assert.match(await run('--whoami', base, 'stk_wrongwrongwrongwrongwrongwrong'), /^ERROR This plugin key is not valid/);
  console.log(`  linked account: ${me.split('|').slice(0, 2).join(' ')}; Artist ID lookup found: ${found.split('|')[1]}`);
}

const sigs = (await (await api('GET', '/api/signatures')).json()) as any[];
console.log(`  signatures on the server: ${sigs.map((x) => `${x.kind} ${x.label} ${x.sha.slice(0, 12)}`).join(', ') || 'none'}`);
assert.ok(sigs.some((x) => x.kind === 'Project file' && x.label.includes('.flp')), 'the project file the host had open was signed automatically and its signature uploaded');

server.close();
console.log('Plugin link works end to end.');
