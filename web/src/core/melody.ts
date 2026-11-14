/**
 * Melody profile and matching. This is new on the web side and has no counterpart in the
 * plugin yet. What it really compares is which notes sound over time (melody and harmony
 * together), so it recognises a song that was pitched up or down, sped up or slowed down.
 *
 * The acoustic fingerprint only recognises the same recording. A melody that has been
 * re-sung, replayed on another instrument, moved to another key or played a little
 * faster is a different recording, so it needs a different measure.
 *
 * Each frame (about 0.19 s) is reduced to a 12-number chroma vector: how much energy
 * falls on each note name (C, C#, D ...) regardless of octave. Two profiles are then
 * aligned with dynamic time warping, which tolerates tempo changes between half and
 * double speed, and the alignment is tried at all 12 transpositions.
 */
import { FFT } from './fft.ts';
import { TARGET_RATE } from './fingerprint.ts';

export const MEL_FFT = 4096;
export const MEL_HOP = 2048;
export const MEL_SECONDS_PER_FRAME = MEL_HOP / TARGET_RATE;
const LOW_HZ = 130, HIGH_HZ = 2000;

export interface MelodyProfile {
  /** frames x 12, each frame L2-normalised; an all-zero frame is silence. */
  chroma: Float32Array;
  frames: number;
}

export interface MelodyMatch {
  /** 1 minus the average chroma distance along the best alignment (0..1). */
  similarity: number;
  /** How far the best transposition stands above the typical wrong one. */
  margin: number;
  /** Semitones the query sits above the reference (0..11). */
  shift: number;
  /** Length of the shorter of the two pieces: how much music the comparison had to go on. */
  seconds: number;
}

/**
 * Two levels of confidence, set from measurements on real songs (see docs/melody-accuracy.md):
 *
 *   strong   - "same melody". On 24 real songs changed in pitch and speed this found 95% of them
 *              and never matched a different song (0 of 3,228 comparisons).
 *   possible - "possibly the same melody, listen to check". Found 98%, with 0.2% false matches
 *              on 25-second clips and about 3% on 13-second clips.
 *
 * Short clips carry too little to be sure, so a strong result needs at least 20 seconds.
 *
 * STILL UNTESTED, and to be said wherever these numbers are quoted: a melody re-sung by another
 * voice or replayed on another instrument (a cover). No such pairs were available to measure.
 */
export const MELODY_UNTESTED = 'Not tested yet: a melody re-sung by another voice or replayed on another instrument.';
export const MELODY_STRONG = { similarity: 0.85, margin: 0.2, seconds: 20 };
export const MELODY_POSSIBLE = { similarity: 0.8, margin: 0.15 };
export const isMelodyStrong = (m: MelodyMatch): boolean =>
  m.similarity >= MELODY_STRONG.similarity && m.margin >= MELODY_STRONG.margin && m.seconds >= MELODY_STRONG.seconds;
export const isMelodyMatch = (m: MelodyMatch): boolean =>
  m.similarity >= MELODY_POSSIBLE.similarity && m.margin >= MELODY_POSSIBLE.margin;

/** Builds a profile from audio that is already mono at 11025 Hz. */
export function melodyProfile(x: Float32Array): MelodyProfile {
  const fft = new FFT(MEL_FFT);
  const window = new Float64Array(MEL_FFT);
  for (let i = 0; i < MEL_FFT; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (MEL_FFT - 1));

  const kLo = Math.ceil((LOW_HZ / TARGET_RATE) * MEL_FFT), kHi = Math.floor((HIGH_HZ / TARGET_RATE) * MEL_FFT);
  const pitchClass = new Int8Array(kHi + 1);
  for (let k = kLo; k <= kHi; k++) {
    const midi = 69 + 12 * Math.log2(((k * TARGET_RATE) / MEL_FFT) / 440);
    pitchClass[k] = ((Math.round(midi) % 12) + 12) % 12;
  }

  const frames = x.length >= MEL_FFT ? Math.floor((x.length - MEL_FFT) / MEL_HOP) + 1 : 0;
  const chroma = new Float32Array(frames * 12);
  const energy = new Float64Array(frames);
  const re = new Float64Array(MEL_FFT), im = new Float64Array(MEL_FFT);
  const mag = new Float64Array(kHi + 2);
  let maxEnergy = 0;

  for (let j = 0; j < frames; j++) {
    const start = j * MEL_HOP;
    for (let i = 0; i < MEL_FFT; i++) { re[i] = x[start + i] * window[i]; im[i] = 0; }
    fft.transform(re, im);
    for (let k = kLo - 1; k <= kHi + 1; k++) mag[k] = re[k] * re[k] + im[k] * im[k];

    // Only spectral peaks count, so the notes being played outweigh broadband noise.
    let total = 0;
    for (let k = kLo; k <= kHi; k++) {
      if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) {
        chroma[j * 12 + pitchClass[k]] += mag[k];
        total += mag[k];
      }
    }
    energy[j] = total;
    if (total > maxEnergy) maxEnergy = total;
  }

  const gate = maxEnergy * 1e-4;
  for (let j = 0; j < frames; j++) {
    let norm = 0;
    for (let c = 0; c < 12; c++) norm += chroma[j * 12 + c] * chroma[j * 12 + c];
    norm = Math.sqrt(norm);
    const silent = energy[j] <= gate || norm === 0;
    for (let c = 0; c < 12; c++) chroma[j * 12 + c] = silent ? 0 : chroma[j * 12 + c] / norm;
  }
  return { chroma, frames };
}

/** Halves the frame rate until the profile is short enough to align quickly. */
function shorten(p: MelodyProfile, maxFrames: number): MelodyProfile {
  let cur = p;
  while (cur.frames > maxFrames) {
    const n = Math.floor(cur.frames / 2);
    const out = new Float32Array(n * 12);
    for (let j = 0; j < n; j++) {
      let norm = 0;
      for (let c = 0; c < 12; c++) {
        const v = cur.chroma[j * 24 + c] + cur.chroma[j * 24 + 12 + c];
        out[j * 12 + c] = v; norm += v * v;
      }
      norm = Math.sqrt(norm);
      if (norm > 0) for (let c = 0; c < 12; c++) out[j * 12 + c] /= norm;
    }
    cur = { chroma: out, frames: n };
  }
  return cur;
}

/** Best average distance of `q` aligned anywhere inside `r`, with `q` transposed down by `shift`. */
function alignCost(r: MelodyProfile, q: MelodyProfile, shift: number): number {
  const N = q.frames, M = r.frames;
  const INF = 1e30;
  // Rolling rows: cost so far and number of steps taken, for rows i, i-1, i-2.
  let c0 = new Float64Array(M), c1 = new Float64Array(M), c2 = new Float64Array(M);
  let s0 = new Uint16Array(M), s1 = new Uint16Array(M), s2 = new Uint16Array(M);
  const qv = new Float32Array(12);

  for (let i = 0; i < N; i++) {
    let qSilent = true;
    for (let c = 0; c < 12; c++) {
      qv[c] = q.chroma[i * 12 + ((c + shift) % 12)];
      if (qv[c] !== 0) qSilent = false;
    }
    for (let j = 0; j < M; j++) {
      let dot = 0, rSilent = true;
      for (let c = 0; c < 12; c++) {
        const rv = r.chroma[j * 12 + c];
        if (rv !== 0) rSilent = false;
        dot += rv * qv[c];
      }
      const local = qSilent && rSilent ? 0.5 : qSilent || rSilent ? 1 : 1 - dot;

      if (i === 0) { c0[j] = local; s0[j] = 1; continue; }
      let best = INF, steps = 0;
      if (j >= 1 && c1[j - 1] < best) { best = c1[j - 1]; steps = s1[j - 1]; }          // same speed
      if (j >= 2 && c1[j - 2] < best) { best = c1[j - 2]; steps = s1[j - 2]; }          // reference twice as fast
      if (i >= 2 && j >= 1 && c2[j - 1] < best) { best = c2[j - 1]; steps = s2[j - 1]; } // query twice as fast
      if (best >= INF) { c0[j] = INF; s0[j] = 0; } else { c0[j] = best + local; s0[j] = steps + 1; }
    }
    if (i < N - 1) {
      const tc = c2; c2 = c1; c1 = c0; c0 = tc;
      const ts = s2; s2 = s1; s1 = s0; s0 = ts;
    }
  }

  let best = 1;
  for (let j = 0; j < M; j++) if (c0[j] < INF && s0[j] > 0) best = Math.min(best, c0[j] / s0[j]);
  return best;
}

/** Compares two melody profiles. The shorter one is searched for inside the longer one. */
export function compareMelody(a: MelodyProfile, b: MelodyProfile): MelodyMatch {
  const seconds = Math.min(a.frames, b.frames) * MEL_SECONDS_PER_FRAME;
  const none: MelodyMatch = { similarity: 0, margin: 0, shift: 0, seconds };
  let r = shorten(a, 1200), q = shorten(b, 1200);
  const swapped = q.frames > r.frames;
  if (swapped) { const t = r; r = q; q = t; }
  if (q.frames < 16) return none; // under about 3 s there is too little to go on

  const sims: number[] = [];
  for (let shift = 0; shift < 12; shift++) sims.push(1 - alignCost(r, q, shift));

  let bestShift = 0;
  for (let s = 1; s < 12; s++) if (sims[s] > sims[bestShift]) bestShift = s;
  const others = sims.filter((_, s) => s !== bestShift).sort((x, y) => x - y);
  const median = others[Math.floor(others.length / 2)];

  return {
    similarity: sims[bestShift],
    margin: sims[bestShift] - median,
    shift: swapped ? (12 - bestShift) % 12 : bestShift,
    seconds,
  };
}
