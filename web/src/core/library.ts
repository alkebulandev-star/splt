import type { MelodyProfile } from './melody.ts';

export type Kind = 'Master' | 'Stem' | 'Audio';

export interface LibraryItem {
  id: string;
  name: string;
  kind: Kind;
  seconds: number;
  frames: Uint32Array;
  secondsPerFrame: number;
  /** Set for fingerprints the plugin uploaded for one of your songs; these are not kept in the browser. */
  fromSong?: string;
  /** Where to look up its details on the server. */
  ref?: { workId: string; fpId: string; track: string };
  /** Only present when the item was added from audio. */
  melody?: MelodyProfile;
}

/**
 * The plugin names its files "<song> - bounce <n> - <date>.fingerprint" for the master and
 * "<song> - bounce <n> - <date> - stem - <track>.fingerprint" for each tagged track.
 */
export function describeFingerprintFile(fileName: string): { kind: Kind; name: string } {
  const base = fileName.replace(/\.fingerprint$/i, '');
  const stem = /^(.*?) - bounce (\d+) - .*? - stem - (.+)$/.exec(base);
  if (stem) return { kind: 'Stem', name: `${stem[3]} (${stem[1]}, bounce ${stem[2]})` };
  const master = /^(.*?) - bounce (\d+) - /.exec(base);
  if (master) return { kind: 'Master', name: `${master[1]}, bounce ${master[2]}` };
  return { kind: 'Master', name: base };
}

export function formatLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
