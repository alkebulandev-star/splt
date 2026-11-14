export type PersonStatus = 'approved' | 'pending' | 'declined' | 'draft' | 'credit';
export type WorkStatus = 'draft' | 'sent' | 'signed';
export type Decision = 'none' | 'approved' | 'declined';

export interface Person {
  artistName: string;
  legalName: string;
  role: string;
  writerShare: number;
  masterShare: number;
  /** Who approves this row. Needed for anyone with a share before the sheet can be sent. */
  email: string;
  status: PersonStatus;
  /** True when that email belongs to someone who has signed up. Set by the server. */
  hasAccount?: boolean;
  /** Their account's public ID, when the row is tied to an account. */
  artistId?: string;
  /** Registration details, from the plugin or from their profile. */
  pro?: string;
  ipi?: string;
  publisher?: string;
  publisherIpi?: string;
  /** Deal or notes, e.g. "3 points" or "flat fee". */
  terms?: string;
  /** Session time the plugin recorded for this person, in seconds. */
  seconds?: number;
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
export const total = (people: Person[], key: 'writerShare' | 'masterShare'): number =>
  Math.round(people.reduce((t, p) => t + (Number(p[key]) || 0), 0) * 100) / 100;
export const hasShare = (p: Pick<Person, 'writerShare' | 'masterShare'>): boolean => p.writerShare > 0 || p.masterShare > 0;

/** Why a split sheet cannot be locked yet, or '' when it is ready. Mirrors the plugin's lock rule. */
export function splitProblem(people: Person[]): string {
  if (people.length === 0) return 'Add at least one person';
  for (const p of people) {
    if (!p.artistName.trim()) return 'Someone has no artist name';
    if (p.writerShare < 0 || p.masterShare < 0) return `Shares cannot be negative (${p.artistName})`;
  }
  if (!near(total(people, 'writerShare'), 100)) return 'Writer shares must total 100%';
  if (!near(total(people, 'masterShare'), 100)) return 'Master shares must total 100%';
  const missing = people.find((p) => hasShare(p) && !p.legalName.trim());
  if (missing) return `Legal name missing for ${missing.artistName}`;
  return '';
}

/** Why a sheet cannot be sent for approval: the lock rule, plus an email for everyone who must approve. */
export function sendProblem(people: Person[]): string {
  const problem = splitProblem(people);
  if (problem) return problem;
  const noEmail = people.find((p) => hasShare(p) && !p.email.trim());
  if (noEmail) return `Email missing for ${noEmail.artistName}`;
  const seen = new Set<string>();
  for (const p of people) {
    const e = p.email.trim().toLowerCase();
    if (!e) continue;
    if (seen.has(e)) return `${e} is on the sheet twice`;
    seen.add(e);
  }
  return '';
}

/** What to show next to a person, from the sheet's state and that person's decision. */
export function personStatus(work: WorkStatus, decision: Decision, share: boolean): PersonStatus {
  if (work === 'draft') return 'draft';
  if (!share) return 'credit';
  return decision === 'approved' ? 'approved' : decision === 'declined' ? 'declined' : 'pending';
}

/** A sheet is signed once everyone with a share has approved. */
export const fullyApproved = (rows: { share: boolean; decision: Decision }[]): boolean =>
  rows.every((r) => !r.share || r.decision === 'approved');
