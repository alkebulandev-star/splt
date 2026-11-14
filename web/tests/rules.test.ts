import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { looksLikeSha256, manifestHash, sha256Hex } from '../src/core/hash.ts';
import { describeFingerprintFile, formatLength } from '../src/core/library.ts';
import { ROLES } from '../src/core/roles.ts';
import { projectFilesInZip, readZip } from '../src/core/zip.ts';
import { makeArtistId, normaliseArtistId } from '../src/core/artistId.ts';
import { fullyApproved, personStatus, sendProblem, splitProblem, type Person } from '../src/core/splits.ts';

const p = (o: Partial<Person>): Person => ({ artistName: 'A', legalName: 'A Legal', role: 'Artist', writerShare: 0, masterShare: 0, email: '', status: 'draft', ...o });

test('a split sheet needs 100% on both sides and legal names', () => {
  const ok = [p({ writerShare: 60, masterShare: 100 }), p({ artistName: 'B', legalName: 'B Legal', writerShare: 40 })];
  assert.equal(splitProblem(ok), '');
  assert.equal(splitProblem([p({ writerShare: 60, masterShare: 100 })]), 'Writer shares must total 100%');
  assert.equal(splitProblem([p({ writerShare: 100, masterShare: 90 })]), 'Master shares must total 100%');
  assert.equal(splitProblem([p({ writerShare: 100, masterShare: 100, legalName: ' ' })]), 'Legal name missing for A');
  // Credited with no share: no legal name needed.
  assert.equal(splitProblem([...ok, p({ artistName: 'Eng', legalName: '', role: 'Mixing Engineer' })]), '');
  // Thirds add up despite rounding.
  const third = [1, 2, 3].map((i) => p({ artistName: `T${i}`, writerShare: 33.33, masterShare: 33.33 }));
  third[0].writerShare = third[0].masterShare = 33.34;
  assert.equal(splitProblem(third), '');
});

test('the role list is the plugin\'s 25 roles', () => {
  assert.equal(ROLES.length, 25);
  assert.ok(ROLES.includes('A&R'));
});

test('plugin file names are read as master or stem', () => {
  assert.deepEqual(describeFingerprintFile('Night Signal - bounce 2 - 2026-11-13 13-40-12.fingerprint'), { kind: 'Master', name: 'Night Signal, bounce 2' });
  assert.deepEqual(describeFingerprintFile('Night Signal - bounce 2 - 2026-11-13 13-40-12 - stem - Lead Vox.fingerprint'), { kind: 'Stem', name: 'Lead Vox (Night Signal, bounce 2)' });
  assert.equal(describeFingerprintFile('something.fingerprint').name, 'something');
  assert.equal(formatLength(192.4), '3:12');
});

test('SHA-256 and the folder signature match an independent calculation', async () => {
  const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), sha('abc'));
  const files = [
    { path: 'Resources/b.wav', sha: sha('2') },
    { path: 'Alternatives/000/ProjectData', sha: sha('1') },
    { path: '.DS_Store', sha: sha('x') },
    { path: 'Resources/.DS_Store', sha: sha('y') },
  ];
  const expected = sha(`Alternatives/000/ProjectData = ${sha('1')}\nResources/b.wav = ${sha('2')}`);
  assert.equal(await manifestHash(files), expected);
  assert.ok(looksLikeSha256(expected));
  assert.ok(!looksLikeSha256('abc123'));
});

test('sending needs an email for everyone with a share, once each', () => {
  const a = p({ writerShare: 100, masterShare: 100, email: 'a@example.com' });
  assert.equal(sendProblem([a]), '');
  assert.equal(sendProblem([{ ...a, email: '' }]), 'Email missing for A');
  assert.equal(sendProblem([{ ...a, writerShare: 50 }, p({ artistName: 'B', legalName: 'B L', writerShare: 50, email: 'A@example.com' })]), 'a@example.com is on the sheet twice');
  assert.equal(sendProblem([a, p({ artistName: 'Eng', legalName: '', email: '' })]), '', 'credit-only people need no email');
});

test('a sheet is signed only when every share holder approved', () => {
  assert.equal(fullyApproved([{ share: true, decision: 'approved' }, { share: false, decision: 'none' }]), true);
  assert.equal(fullyApproved([{ share: true, decision: 'approved' }, { share: true, decision: 'none' }]), false);
  assert.equal(fullyApproved([{ share: true, decision: 'declined' }]), false);
  assert.equal(personStatus('draft', 'approved', true), 'draft');
  assert.equal(personStatus('sent', 'none', true), 'pending');
  assert.equal(personStatus('sent', 'none', false), 'credit');
});

// The plugin signs a project folder; the website must arrive at the same signature for it.
const signTool = join(import.meta.dirname, '../../build/FindProject_artefacts/Release/FindProject');
test('a project folder gets the same signature from the plugin and the website', { skip: !existsSync(signTool) && 'C++ tool not built' }, async () => {
  const root = join(mkdtempSync(join(tmpdir(), 'stsig-')), 'Tricky Sông.logicx');
  const put = (path: string, body: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), body); };
  put('Alternatives/000/ProjectData', 'project data');
  put('Alternatives/000/Undo Data.nosync/1', 'undo');
  put('Media/Audio Files/Vocal take #1 (ünïcode) 🎤.wav', 'audio one');
  put('Media/Audio Files/vocal take #1.wav', 'audio two');       // differs only by case and length
  put('Media/Audio Files/Zebra.wav', 'audio three');             // capital Z sorts before lower-case a
  put('Media/Audio Files/apple.wav', '');                        // an empty file still counts
  put('Resources/.hidden-settings', 'hidden');
  put('.DS_Store', 'finder');                                    // ignored
  put('Media/.DS_Store', 'finder');                              // ignored at any depth

  const files: { path: string; sha: string }[] = [];
  const walk = (dir: string) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else files.push({ path: relative(root, p), sha: createHash('sha256').update(readFileSync(p)).digest('hex') }); } };
  walk(root);
  const [pluginSha, pluginFiles] = execFileSync(signTool, [root], { encoding: 'utf8' }).trim().split(' ');
  assert.equal(await manifestHash(files), pluginSha);
  assert.equal(Number(pluginFiles), 7);
  await assert.rejects(manifestHash([{ path: '.DS_Store', sha: 'x' }]), /no files/);

  // The same project, zipped three ways, must give the same signature again:
  // the way Finder's Compress does it, plain `zip` from outside, and `zip` from inside the folder.
  const zipDir = join(root, '..');
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', root, join(zipDir, 'finder.zip')]);
  execFileSync('zip', ['-r', '-q', join(zipDir, 'outside.zip'), 'Tricky Sông.logicx'], { cwd: zipDir });
  execFileSync('zip', ['-r', '-q', '-0', join(zipDir, 'inside.zip'), '.'], { cwd: root });
  for (const name of ['finder.zip', 'outside.zip', 'inside.zip']) {
    const b = readFileSync(join(zipDir, name));
    const entries = projectFilesInZip(await readZip(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)));
    const hashes = [];
    for (const e of entries) hashes.push({ path: e.path.replace(/^\.\//, ''), sha: await sha256Hex(await e.data()) });
    assert.equal(await manifestHash(hashes), pluginSha, name);
  }
  await assert.rejects(readZip(new ArrayBuffer(64)), /not a zip/);

  // A single-file project is just the file's own hash on both sides.
  const single = join(root, '..', 'beat.flp');
  writeFileSync(single, 'pretend FL project');
  assert.equal(execFileSync(signTool, [single], { encoding: 'utf8' }).split(' ')[0], await sha256Hex(readFileSync(single)));
});

test('Artist IDs carry a check character and forgive common typing slips', () => {
  const id = makeArtistId(new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
  assert.match(id, /^ST-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(id, 'ST-1234-567C');                              // fixed vector, shared with the plugin
  assert.equal(normaliseArtistId(id), id);
  assert.equal(normaliseArtistId(' st 1234 567c '), id);
  assert.equal(normaliseArtistId('1234567c'), id);
  assert.equal(normaliseArtistId('ST-I234-567C'), id);           // I typed for 1
  assert.equal(normaliseArtistId('ST-1234-567D'), null);         // one character wrong
  assert.equal(normaliseArtistId('ST-2134-567C'), null);         // two characters swapped
  assert.equal(normaliseArtistId('nova@example.com'), null);
  assert.equal(normaliseArtistId(''), null);
});
