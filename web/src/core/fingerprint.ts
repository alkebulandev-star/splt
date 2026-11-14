/**
 * Acoustic fingerprint, a line-for-line port of the plugin's Source/Fingerprint.h
 * (after Haitsma & Kalker, 2002), so a fingerprint made here can be compared with a
 * `.fingerprint` file the plugin saved next to a bounce receipt.
 *
 * Audio is low-passed, resampled to 11025 Hz and analysed in 2048-point frames every
 * 64 samples. Each frame yields 32 bits: whether the energy difference between
 * neighbouring bands (33 log-spaced bands, 300 Hz to 2 kHz) rose or fell since the
 * previous frame.
 */
import { FFT } from './fft.ts';

export const FFT_SIZE = 2048;
export const HOP = 64;
export const NUM_BANDS = 33;
export const TARGET_RATE = 11025;
export const LOW_HZ = 300;
export const HIGH_HZ = 2000;
export const SECONDS_PER_FRAME = HOP / TARGET_RATE;

export interface Fingerprint {
  frames: Uint32Array;
  secondsPerFrame: number;
}

export interface Match {
  /** 1 minus the bit error rate of the blocks that matched (0..1). */
  similarity: number;
  /** Fraction of the query's blocks that matched. */
  coverage: number;
  /** Where the query sits inside the reference. */
  offsetSeconds: number;
}

/** Shares material with the reference: a copy, or another song using the same beat or sample. */
export const isMatch = (m: Match): boolean => m.coverage >= 0.5 && m.similarity >= 0.7;
/** The same recording. */
export const isStrong = (m: Match): boolean => m.coverage >= 0.8 && m.similarity >= 0.85;

/** Mixes to mono, low-passes and resamples to 11025 Hz, exactly as the plugin does. */
export function toTargetRate(channels: Float32Array[], sampleRate: number): Float32Array {
  const numCh = channels.length;
  if (numCh === 0) return new Float32Array(0);
  const n = channels[0].length;
  const step = sampleRate / TARGET_RATE;

  // Two cascaded RBJ biquad low-passes (anti-alias before decimation).
  const cutoff = Math.min(TARGET_RATE * 0.4, sampleRate * 0.45);
  const w0 = (2 * Math.PI * cutoff) / sampleRate;
  const alpha = Math.sin(w0) / (2 * 0.7071);
  const cosw = Math.cos(w0), a0 = 1 + alpha;
  const b0 = (1 - cosw) / 2 / a0, b1 = (1 - cosw) / a0, b2 = b0;
  const a1 = (-2 * cosw) / a0, a2 = (1 - alpha) / a0;
  const z = [0, 0, 0, 0];

  const out = new Float32Array(Math.ceil(n / step) + 2);
  let o = 0, phase = 0, prev = 0;
  const scale = 1 / numCh;

  for (let i = 0; i < n; i++) {
    let mono = 0;
    for (let ch = 0; ch < numCh; ch++) mono += channels[ch][i];
    let x = Math.fround(mono * scale);
    for (let s = 0; s < 2; s++) {
      const y = b0 * x + z[s * 2];
      z[s * 2] = b1 * x - a1 * y + z[s * 2 + 1];
      z[s * 2 + 1] = b2 * x - a2 * y;
      x = y;
    }
    while (phase < 1) {
      out[o++] = prev + (x - prev) * phase;
      phase += step;
    }
    phase -= 1;
    prev = x;
  }
  return out.subarray(0, o);
}

/** Fingerprints audio that is already mono at 11025 Hz. */
export function fingerprintResampled(x: Float32Array): Fingerprint {
  const fft = new FFT(FFT_SIZE);
  const window = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));

  const edge = new Int32Array(NUM_BANDS + 1);
  for (let b = 0; b <= NUM_BANDS; b++) {
    const f = LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, b / NUM_BANDS);
    edge[b] = Math.min(FFT_SIZE / 2 - 1, Math.max(1, Math.round((f / TARGET_RATE) * FFT_SIZE)));
  }

  const total = x.length >= FFT_SIZE ? Math.floor((x.length - FFT_SIZE) / HOP) + 1 : 0;
  const frames = new Uint32Array(Math.max(0, total - 1));
  const re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE);
  let prev = new Float64Array(NUM_BANDS), e = new Float64Array(NUM_BANDS);

  for (let j = 0; j < total; j++) {
    const start = j * HOP;
    for (let i = 0; i < FFT_SIZE; i++) { re[i] = Math.fround(x[start + i] * window[i]); im[i] = 0; }
    fft.transform(re, im);

    for (let b = 0; b < NUM_BANDS; b++) {
      let sum = 0;
      const end = Math.max(edge[b] + 1, edge[b + 1]);
      for (let k = edge[b]; k < end; k++) sum += re[k] * re[k] + im[k] * im[k];
      e[b] = sum;
    }

    if (j > 0) {
      let bits = 0;
      for (let m = 0; m < 32; m++) {
        const d = e[m] - e[m + 1] - (prev[m] - prev[m + 1]);
        if (d > 0) bits |= 1 << m;
      }
      frames[j - 1] = bits >>> 0;
    }
    const t = prev; prev = e; e = t;
  }
  return { frames, secondsPerFrame: SECONDS_PER_FRAME };
}

export function fingerprint(channels: Float32Array[], sampleRate: number): Fingerprint {
  return fingerprintResampled(toTargetRate(channels, sampleRate));
}

function popcount(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Compares a query against a reference. The query is cut into blocks of 256 frames
 * (about 1.5 s); each sampled block is slid along the reference to find its best
 * alignment and counts as matched when its bit error rate is below 0.35.
 */
export function compare(reference: Uint32Array, query: Uint32Array, secondsPerFrame = SECONDS_PER_FRAME): Match {
  const m: Match = { similarity: 0, coverage: 0, offsetSeconds: 0 };
  const block = 256;
  if (reference.length < block || query.length < block) return m;

  const numBlocks = Math.floor(query.length / block);
  const step = Math.max(1, Math.floor(numBlocks / 24));
  let tested = 0, matched = 0, berSum = 0, offsetSum = 0;

  for (let b = 0; b < numBlocks; b += step) {
    const q0 = b * block;
    let bestErrors = block * 32 + 1, bestOffset = 0;
    for (let off = 0; off + block <= reference.length; off++) {
      let errors = 0;
      for (let k = 0; k < block && errors < bestErrors; k++) errors += popcount(reference[off + k] ^ query[q0 + k]);
      if (errors < bestErrors) { bestErrors = errors; bestOffset = off; }
    }
    tested++;
    const ber = bestErrors / (block * 32);
    if (ber < 0.35) {
      matched++;
      berSum += ber;
      offsetSum += (bestOffset - q0) * secondsPerFrame;
    }
  }

  m.coverage = tested > 0 ? matched / tested : 0;
  if (matched > 0) {
    m.similarity = 1 - berSum / matched;
    m.offsetSeconds = offsetSum / matched;
  }
  return m;
}

const MAGIC = 'TBAFP1';

/** Reads a `.fingerprint` file written by the plugin. Returns null if it is not one. */
export function parseFingerprintFile(data: ArrayBuffer): Fingerprint | null {
  if (data.byteLength < 18) return null;
  const v = new DataView(data);
  for (let i = 0; i < 6; i++) if (v.getUint8(i) !== MAGIC.charCodeAt(i)) return null;
  const secondsPerFrame = v.getFloat64(6, true);
  const n = v.getInt32(14, true);
  if (n < 0 || n > 10_000_000 || 18 + n * 4 > data.byteLength) return null;
  const frames = new Uint32Array(n);
  for (let i = 0; i < n; i++) frames[i] = v.getUint32(18 + i * 4, true);
  return { frames, secondsPerFrame };
}

/** Writes the same format the plugin reads. */
export function serialiseFingerprint(fp: Fingerprint): ArrayBuffer {
  const buf = new ArrayBuffer(18 + fp.frames.length * 4);
  const v = new DataView(buf);
  for (let i = 0; i < 6; i++) v.setUint8(i, MAGIC.charCodeAt(i));
  v.setFloat64(6, fp.secondsPerFrame, true);
  v.setInt32(14, fp.frames.length, true);
  for (let i = 0; i < fp.frames.length; i++) v.setUint32(18 + i * 4, fp.frames[i], true);
  return buf;
}
