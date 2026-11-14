import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toTargetRate } from '../src/core/fingerprint.ts';
import { compareMelody, isMelodyMatch, isMelodyStrong, melodyProfile } from '../src/core/melody.ts';
import { render, rng, tune, type Note } from './synth.ts';

const RATE = 44100;
const profile = (x: Float32Array) => melodyProfile(toTargetRate([x], RATE));
const A = tune(11), B = tune(22), C = tune(33);
const ref = profile(render(A, RATE, { timbre: 'sine' }));

function report(name: string, m: ReturnType<typeof compareMelody>) {
  console.log(`  ${name.padEnd(46)} sim ${(m.similarity * 100).toFixed(0)}%  margin ${(m.margin * 100).toFixed(0)}  shift ${m.shift}`);
}

test('same tune on another instrument matches', () => {
  const m = compareMelody(ref, profile(render(A, RATE, { timbre: 'saw' })));
  report('same tune, saw instead of sine', m);
  assert.ok(isMelodyMatch(m)); assert.equal(m.shift, 0);
});

test('same tune in another key and 15% faster matches', () => {
  const m = compareMelody(ref, profile(render(A, RATE, { timbre: 'organ', shift: 3, tempo: 1.15 })));
  report('same tune, organ, +3 semitones, 15% faster', m);
  assert.ok(isMelodyMatch(m)); assert.equal(m.shift, 3);
});

test('same tune 20% slower and down a fourth matches', () => {
  const m = compareMelody(ref, profile(render(A, RATE, { timbre: 'saw', shift: -5, tempo: 0.8 })));
  report('same tune, saw, -5 semitones, 20% slower', m);
  assert.ok(isMelodyMatch(m)); assert.equal(m.shift, 7);
});

test('a phrase from the middle is found', () => {
  const m = compareMelody(ref, profile(render(A.slice(16, 36), RATE, { timbre: 'organ', shift: 2 })));
  report('20-note phrase from the middle, +2', m);
  assert.ok(isMelodyMatch(m));
});

test('different tunes in the same key do not match', () => {
  for (const [name, t] of [['tune B', B], ['tune C', C]] as [string, Note[]][]) {
    const m = compareMelody(ref, profile(render(t, RATE, { timbre: 'saw' })));
    report(`different ${name}, same key and scale`, m);
    assert.ok(!isMelodyMatch(m));
  }
});

test('noise does not match', () => {
  const r = rng(3), x = new Float32Array(RATE * 20).map(() => (r() - 0.5) * 0.5);
  const m = compareMelody(ref, profile(x));
  report('white noise', m);
  assert.ok(!isMelodyMatch(m));
});

test('a clip under 20 seconds can only ever be a possible match', () => {
  const short = compareMelody(ref, profile(render(A.slice(0, 16), RATE, { timbre: 'saw' })));
  report('first 16 notes only (about 9 s)', short);
  assert.ok(short.seconds < 20);
  assert.ok(isMelodyMatch(short) && !isMelodyStrong(short));
  const long = compareMelody(ref, profile(render(A, RATE, { timbre: 'saw', shift: 4 })));
  assert.ok(long.seconds >= 20 && isMelodyStrong(long));
});
