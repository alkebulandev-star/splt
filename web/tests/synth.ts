// Deterministic test signals: no audio files needed.
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

export interface Note { midi: number; beats: number }
export type Timbre = 'sine' | 'saw' | 'organ';

/** Renders a monophonic line. `shift` is in semitones, `tempo` multiplies the speed. */
export function render(notes: Note[], rate: number, opts: { timbre?: Timbre; shift?: number; tempo?: number; bpm?: number } = {}): Float32Array {
  const { timbre = 'sine', shift = 0, tempo = 1, bpm = 100 } = opts;
  const beat = 60 / (bpm * tempo);
  const total = notes.reduce((t, n) => t + n.beats, 0) * beat;
  const out = new Float32Array(Math.ceil(total * rate));
  const harmonics = timbre === 'sine' ? [1] : timbre === 'saw' ? [1, 0.5, 0.33, 0.25, 0.2, 0.16] : [1, 0.1, 0.6, 0.05, 0.3];
  let t0 = 0;
  for (const n of notes) {
    const len = n.beats * beat, i0 = Math.floor(t0 * rate), i1 = Math.min(out.length, Math.floor((t0 + len) * rate));
    if (n.midi > 0) {
      const f = 440 * Math.pow(2, (n.midi + shift - 69) / 12);
      for (let i = i0; i < i1; i++) {
        const t = (i - i0) / rate;
        const env = Math.min(1, t / 0.01) * Math.min(1, (len - t) / 0.03);
        let v = 0;
        for (let h = 0; h < harmonics.length; h++) v += harmonics[h] * Math.sin(2 * Math.PI * f * (h + 1) * t);
        out[i] = 0.3 * env * v;
      }
    }
    t0 += len;
  }
  return out;
}

/** A random but repeatable tune in C major. */
export function tune(seed: number, length = 48): Note[] {
  const r = rng(seed), scale = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76];
  const notes: Note[] = [];
  let idx = 4;
  for (let i = 0; i < length; i++) {
    idx = Math.max(0, Math.min(scale.length - 1, idx + Math.floor(r() * 7) - 3));
    notes.push({ midi: scale[idx], beats: [0.5, 0.5, 1, 1, 1.5][Math.floor(r() * 5)] });
  }
  return notes;
}

/** A dense, music-like mix: three pitched lines plus drum-like noise bursts, so every band carries signal. */
export function mix(seed: number, seconds: number, rate: number): Float32Array {
  const out = new Float32Array(Math.floor(seconds * rate));
  const voices = [0, 1, 2].map((v) => render(tune(seed * 10 + v, 400), rate, { timbre: (['saw', 'organ', 'sine'] as Timbre[])[v], shift: [-12, 0, 7][v], bpm: 90 + v * 17 }));
  const r = rng(seed + 99);
  const hit = Math.floor(rate * (0.31 + 0.05 * (seed % 3)));
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const env = Math.exp(-(i % hit) / (rate * 0.06));
    const white = r() - 0.5;
    lp += 0.25 * (white - lp);
    out[i] = 0.3 * ((voices[0][i] ?? 0) + (voices[1][i] ?? 0) + (voices[2][i] ?? 0) + 0.5 * env * lp + white * 0.03); // peaks stay under full scale
  }
  return out;
}

export function wav16(x: Float32Array, rate: number): Buffer {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  return b;
}

/** The same audio at another sample rate (linear interpolation), as a converter would produce. */
export function resampleTo(x: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array(Math.floor((x.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const p = (i * from) / to, k = Math.floor(p), f = p - k;
    out[i] = x[k] + ((x[k + 1] ?? x[k]) - x[k]) * f;
  }
  return out;
}
