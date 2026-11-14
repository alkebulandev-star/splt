// Measures melody matching on real music.   node tools/melody-eval.ts <folder of songs> [how many]
//
// Needs ffmpeg. Nothing leaves this computer: clips are cut into a temp folder and deleted at the end.
// For each song it makes a 25-second clip changed five ways (pitch up 2 semitones, down 3, sped up
// 12%, slowed 11%, tempo up 8% in the same key) plus an MP3 copy, then compares every clip with a
// 50-second reference of every song. It reports how often the right song is found and how often a
// different song is wrongly matched, for both confidence levels.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { compare, fingerprintResampled, isMatch, isStrong, toTargetRate } from '../src/core/fingerprint.ts';
import { compareMelody, isMelodyMatch, isMelodyStrong, MELODY_UNTESTED, melodyProfile } from '../src/core/melody.ts';

const [folder, limit = '24'] = process.argv.slice(2);
if (!folder) { console.error('usage: node tools/melody-eval.ts <folder of songs> [how many]'); process.exit(2); }
const ff = (...args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
// A file ffprobe cannot read simply counts as too short and is skipped.
const seconds = (f: string) => { try { return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) || 0; } catch { return 0; } };
function wav(p: string): Float32Array {
  const b = readFileSync(p);
  let o = 12;
  while (b.toString('latin1', o, o + 4) !== 'data') o += 8 + b.readUInt32LE(o + 4);
  o += 8;
  const x = new Float32Array((b.length - o) >> 1);
  for (let i = 0; i < x.length; i++) x[i] = b.readInt16LE(o + i * 2) / 32768;
  return toTargetRate([x], 44100);
}

const songs: string[] = [];
const walk = (d: string) => { for (const n of readdirSync(d)) { if (n.startsWith('.') || n === 'venv' || n === 'node_modules') continue; const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(wav|aif|aiff|mp3|m4a|flac)$/i.test(extname(p))) songs.push(p); } };
walk(folder);
const picked: string[] = [];
for (const f of songs) { if (picked.length >= Number(limit)) break; if (seconds(f) >= 100) picked.push(f); }
if (picked.length < 3) { console.error('Need at least 3 songs of 100 seconds or more.'); process.exit(1); }

const tmp = mkdtempSync(join(tmpdir(), 'melody-eval-'));
const UP2 = 2 ** (2 / 12), DOWN3 = 2 ** (-3 / 12);
const variants: Record<string, string[]> = {
  'MP3 copy': [], 'pitch +2 semitones': ['-af', `asetrate=44100*${UP2},aresample=44100,atempo=${1 / UP2}`],
  'pitch -3 semitones': ['-af', `asetrate=44100*${DOWN3},aresample=44100,atempo=${1 / DOWN3}`],
  'sped up 12%': ['-af', `asetrate=44100*${UP2},aresample=44100`], 'slowed 11%': ['-af', 'asetrate=44100*0.89,aresample=44100'],
  'tempo +8%, same key': ['-af', 'atempo=1.08'],
};
console.log(`Preparing ${picked.length} songs...`);
const refs = picked.map((f, i) => {
  const ref = join(tmp, `r${i}.wav`);
  ff('-ss', '40', '-t', '50', '-i', f, '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', ref);
  const x = wav(ref);
  return { i, ref, fp: fingerprintResampled(x).frames, mel: melodyProfile(x) };
});

// Files that are copies or versions of one recording are not "different songs": find them with the
// plain fingerprint first and leave those pairs out of the false-match count.
const sameRecording = new Set<string>();
for (const a of refs) for (const b of refs) if (a.i < b.i && isMatch(compare(a.fp, b.fp))) { sameRecording.add(`${a.i}-${b.i}`); sameRecording.add(`${b.i}-${a.i}`); }
if (sameRecording.size) {
  console.log(`\n${sameRecording.size / 2} pair(s) of files are the same recording and are not counted as different songs:`);
  for (const key of sameRecording) { const [a, b] = key.split('-').map(Number); if (a < b) console.log(`  ${picked[a].split('/').pop()}  =  ${picked[b].split('/').pop()}`); }
}

let falseStrong = 0, falsePossible = 0, others = 0;
console.log('\nchange                | same melody | possibly | plain fingerprint');
for (const [name, filter] of Object.entries(variants)) {
  let strong = 0, possible = 0, fp = 0;
  for (const r of refs) {
    const q = join(tmp, 'q.wav');
    if (name === 'MP3 copy') { ff('-ss', '12', '-t', '25', '-i', r.ref, '-c:a', 'libmp3lame', '-b:a', '96k', join(tmp, 'q.mp3')); ff('-i', join(tmp, 'q.mp3'), '-ac', '1', '-ar', '44100', q); }
    else ff('-ss', '12', '-t', '25', '-i', r.ref, ...filter, '-ac', '1', '-ar', '44100', q);
    const x = wav(q), qf = fingerprintResampled(x).frames, qm = melodyProfile(x);
    for (const other of refs) {
      const m = compareMelody(other.mel, qm);
      if (other.i === r.i) { if (isMelodyStrong(m)) strong++; if (isMelodyMatch(m)) possible++; if (isStrong(compare(other.fp, qf))) fp++; }
      else if (!sameRecording.has(`${r.i}-${other.i}`)) { others++; if (isMelodyStrong(m)) falseStrong++; if (isMelodyMatch(m)) falsePossible++; }
    }
  }
  console.log(`${name.padEnd(21)} | ${String(strong).padStart(3)}/${refs.length}      | ${String(possible).padStart(3)}/${refs.length}   | ${String(fp).padStart(3)}/${refs.length}`);
}
console.log(`\nDifferent songs wrongly matched: ${falseStrong} as "same melody", ${falsePossible} as "possibly", out of ${others} comparisons.`);
console.log('Note: two different recordings of one song (a remake, a new mix) still count as "different" here, so check any false match by ear.');
console.log(MELODY_UNTESTED + ' This run does not measure it.');
rmSync(tmp, { recursive: true, force: true });
