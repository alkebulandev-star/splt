import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compare, fingerprint, isMatch, isStrong, parseFingerprintFile, serialiseFingerprint } from '../src/core/fingerprint.ts';
import { mix, resampleTo, rng, wav16 } from './synth.ts';

const song = (rate: number) => mix(1, 30, rate);

test('file format round-trips', () => {
  const fp = fingerprint([song(44100)], 44100);
  const back = parseFingerprintFile(serialiseFingerprint(fp));
  assert.ok(back);
  assert.deepEqual(Array.from(back.frames.subarray(0, 500)), Array.from(fp.frames.subarray(0, 500)));
  assert.equal(back.frames.length, fp.frames.length);
  assert.equal(parseFingerprintFile(new ArrayBuffer(40)), null);
});

test('about 172 frames per second', () => {
  const fp = fingerprint([song(44100)], 44100);
  assert.ok(Math.abs(fp.frames.length / 30 - 172) < 3, `${fp.frames.length / 30}`);
});

test('same song at another sample rate is a strong match', () => {
  const a = fingerprint([song(44100)], 44100), b = fingerprint([resampleTo(song(44100), 44100, 48000)], 48000);
  const m = compare(a.frames, b.frames);
  assert.ok(isStrong(m), JSON.stringify(m));
});

test('quieter copy with added noise is a strong match', () => {
  const x = song(44100), r = rng(5);
  const y = x.map((v) => v * 0.25 + (r() - 0.5) * 0.004);
  const m = compare(fingerprint([x], 44100).frames, fingerprint([y], 44100).frames);
  assert.ok(isStrong(m), JSON.stringify(m));
});

test('an excerpt is found at the right position', () => {
  const x = song(44100);
  const m = compare(fingerprint([x], 44100).frames, fingerprint([x.subarray(10 * 44100, 22 * 44100)], 44100).frames);
  assert.ok(isStrong(m), JSON.stringify(m));
  assert.ok(Math.abs(m.offsetSeconds - 10) < 0.1, `offset ${m.offsetSeconds}`);
});

test('a different song does not match', () => {
  const m = compare(fingerprint([song(44100)], 44100).frames, fingerprint([mix(2, 30, 44100)], 44100).frames);
  assert.ok(!isMatch(m), JSON.stringify(m));
});

// The real proof: a fingerprint made here must match what the plugin's own C++ code hears.
const cpp = join(import.meta.dirname, '../../build/FingerprintTest_artefacts/Release/FingerprintTest');
test('agrees with the plugin\'s C++ fingerprinter', { skip: !existsSync(cpp) && 'C++ test tool not built' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'stweb-'));
  const x = song(44100);
  writeFileSync(join(dir, 'song.wav'), wav16(x, 44100));
  writeFileSync(join(dir, 'web.fingerprint'), Buffer.from(serialiseFingerprint(fingerprint([x], 44100))));
  const out = execFileSync(cpp, [join(dir, 'web.fingerprint'), '--', join(dir, 'song.wav')], { encoding: 'utf8' });
  const sim = /sim\s*(\d+)%/.exec(out);
  assert.ok(sim, out);
  assert.ok(parseFloat(sim[1]) >= 97, out);
});
