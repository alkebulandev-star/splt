import type { Backend, User } from '../core/api.ts';
import { previewBackend } from '../core/backendPreview.ts';

/** What every screen shares: which backend is in use, who is signed in, which song is open. */
export const ctx: { backend: Backend; user: User | null; workId: string | null } = {
  backend: previewBackend, user: null, workId: null,
};

export const when = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export const initials = (name: string): string =>
  name.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';

export const COLOURS = ['--p1', '--p2', '--p3', '--p4', '--p5'];

export const STATUS_TAG = {
  draft: ['idle', 'Draft'], sent: ['wait', 'Awaiting approval'], signed: ['ok', 'Signed'],
} as const;
