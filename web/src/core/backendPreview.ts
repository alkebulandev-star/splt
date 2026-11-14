/**
 * Stand-in for the server when the page is opened on its own (for example as a shared
 * preview). It follows the same rules but keeps everything in memory with example
 * people, so nothing is saved and nothing is sent to anyone.
 */
import type { Activity, Backend, Evidence, PersonInput, User, WorkDetail, WorkEvent } from './api.ts';
import { fullyApproved, hasShare, personStatus, sendProblem, type Decision, type WorkStatus } from './splits.ts';

interface Row extends PersonInput { decision: Decision }
interface Work { id: string; title: string; album: string; status: WorkStatus; owner: string; rows: Row[]; messages: { author: string; email: string; body: string; time: number }[]; events: WorkEvent[]; updatedAt: number }

const HOUR = 3_600_000;
const t0 = Date.now();
let user: User = { id: 1, email: 'nova@example.com', artistId: 'ST-7K2Q-9FX8', artistName: 'Nova Kane', legalName: 'Naomi K. Ellison', role: 'Artist', pro: 'ASCAP', ipi: '00512 34 67 89', publisher: 'Kane Songs', publisherIpi: '00698 11 20 45', isni: '', phone: '+1 555 0142' };
let signedIn = false;

const row = (artistName: string, legalName: string, role: string, writerShare: number, masterShare: number, email: string, decision: Decision): Row =>
  ({ artistName, legalName, role, writerShare, masterShare, email, decision });
const ev = (hoursAgo: number, type: string, text: string): WorkEvent => ({ time: t0 - hoursAgo * HOUR, type, text, hash: 'example' });

const works: Work[] = [
  { id: 'night-signal', title: 'Night Signal', album: 'Afterglow', status: 'sent', owner: user.email, updatedAt: t0 - HOUR,
    rows: [row('Nova Kane', 'Naomi K. Ellison', 'Artist', 40, 50, 'nova@example.com', 'approved'), row('Lil Vanta', 'Devon A. Marsh', 'Featured Artist', 25, 20, 'vanta@example.com', 'approved'),
      row('DJ Halcyon', 'Halvard Lindqvist', 'Producer', 20, 30, 'halcyon@example.com', 'approved'), row('Riko Santos', 'Ricardo Santos', 'Songwriter', 15, 0, 'riko@example.com', 'none')],
    messages: [{ author: 'Nova Kane', email: 'nova@example.com', body: 'Splits for Night Signal are ready. Please check your share and legal name, then approve.', time: t0 - 20 * HOUR },
      { author: 'Riko Santos', email: 'riko@example.com', body: 'Got it. The log shows four guitar takes on my side. Can we talk about 15% before I sign?', time: t0 - 2 * HOUR }],
    events: [ev(30, 'CREATE', 'Nova Kane created "Night Signal" on "Afterglow"'), ev(21, 'SEND', 'Nova Kane sent the split sheet for approval'), ev(5, 'APPROVE', 'DJ Halcyon (Halvard Lindqvist) approved the split: writer 20%, master 30%')] },
  { id: 'low-orbit', title: 'Low Orbit', album: 'Afterglow', status: 'signed', owner: user.email, updatedAt: t0 - 50 * HOUR,
    rows: [row('Nova Kane', 'Naomi K. Ellison', 'Artist', 50, 60, 'nova@example.com', 'approved'), row('DJ Halcyon', 'Halvard Lindqvist', 'Producer', 50, 40, 'halcyon@example.com', 'approved')],
    messages: [], events: [ev(90, 'CREATE', 'Nova Kane created "Low Orbit" on "Afterglow"'), ev(50, 'SIGNED', 'Everyone with a share approved. The split sheet is signed.')] },
  { id: 'glass-hours', title: 'Glass Hours', album: '', status: 'sent', owner: 'mara@example.com', updatedAt: t0 - 8 * HOUR,
    rows: [row('Mara Voss', 'Mara E. Voss', 'Artist', 60, 70, 'mara@example.com', 'approved'), row('Nova Kane', 'Naomi K. Ellison', 'Featured Artist', 40, 30, 'nova@example.com', 'none')],
    messages: [{ author: 'Mara Voss', email: 'mara@example.com', body: 'Sent you the Glass Hours split. Shout if anything looks off.', time: t0 - 8 * HOUR }],
    events: [ev(9, 'CREATE', 'Mara Voss created "Glass Hours"'), ev(8, 'SEND', 'Mara Voss sent the split sheet for approval')] },
  { id: 'paper-planes', title: 'Paper Planes II', album: '', status: 'draft', owner: user.email, updatedAt: t0 - 100 * HOUR,
    rows: [row('Nova Kane', 'Naomi K. Ellison', 'Artist', 100, 100, 'nova@example.com', 'none')], messages: [], events: [ev(100, 'CREATE', 'Nova Kane created "Paper Planes II"')] },
];

/** Example of what the plugin uploads, shown on Night Signal only. */
const exampleEvidence: Evidence = {
  syncedAt: t0 - HOUR, logIntact: true, logEntries: 64, chainHead: 'c6e07b9a41b803d5d13f52c477aae8100be49c268a401f3b2c9db06e9f2ca71e',
  splitsLocked: true, sessionSeconds: 14_760, recordSeconds: 2_004,
  tracks: [
    { trackName: 'Lead Vox', person: 'Nova Kane', signalSeconds: 3120, recordSeconds: 860, takes: 3 },
    { trackName: 'Feature', person: 'Lil Vanta', signalSeconds: 1410, recordSeconds: 365, takes: 2 },
    { trackName: '808 Drums', person: 'DJ Halcyon', signalSeconds: 5200, recordSeconds: 192, takes: 1 },
    { trackName: 'Guitar', person: 'Riko Santos', signalSeconds: 2230, recordSeconds: 587, takes: 4 },
  ],
  projects: [], takes: [], project: { fileName: 'Night Signal.logicx', sha: '0be49c26d13f52c477aae810c6e07b9a41b803d58a401f3b2c9db06e9f2ca71e', daw: 'Logic Pro', time: t0 - 2 * HOUR },
  bounces: [{ num: 1, time: t0 - 3 * HOUR, durationSecs: 192, fpId: 'c6e07b9a'.padEnd(64, '0'), fileSha: '', stems: [
    { trackName: 'Lead Vox', person: 'Nova Kane', fpId: 'd13f52c4'.padEnd(64, '0') }, { trackName: 'Feature', person: 'Lil Vanta', fpId: '8a401f3b'.padEnd(64, '0') },
    { trackName: '808 Drums', person: 'DJ Halcyon', fpId: '77aae810'.padEnd(64, '0') }, { trackName: 'Guitar', person: 'Riko Santos', fpId: '2c9db06e'.padEnd(64, '0') }] }],
};

function find(id: string): Work {
  const w = works.find((x) => x.id === id);
  if (!w) throw new Error('Song not found');
  return w;
}
function log(w: Work, type: string, text: string): void {
  w.events.push({ time: Date.now(), type, text, hash: 'example' });
  w.updatedAt = Date.now();
}
function detail(w: Work): WorkDetail {
  const mine = w.rows.find((r) => r.email === user.email);
  const sent = w.status === 'sent';
  return {
    id: w.id, title: w.title, album: w.album, status: w.status, isOwner: w.owner === user.email,
    songCode: 'SG-4MPT-2K7M', ownerName: w.owner === user.email ? user.artistName : 'Mara Voss', ownerArtistId: w.owner === user.email ? user.artistId : 'ST-MARA-V0S5',
    ownerStated: true, youOwn: w.owner === user.email, isrc: '', iswc: '', splitVersion: 1,
    sources: w.id === 'night-signal' ? [{ artistName: 'Nova Kane', isOwner: true, syncedAt: t0 - HOUR, logIntact: true, logEntries: 64, tracks: 4, takes: 10, bounces: 1 }] : [],
    people: w.rows.map((r) => r.artistName), yourWriterShare: mine ? mine.writerShare : null,
    awaiting: sent ? w.rows.filter((r) => hasShare(r) && r.decision !== 'approved').length : 0,
    needsYou: sent && !!mine && mine.decision === 'none' && hasShare(mine), updatedAt: w.updatedAt,
    rows: w.rows.map(({ decision, ...r }) => ({ ...r, status: personStatus(w.status, decision, hasShare(r)), hasAccount: true })),
    yourDecision: mine ? mine.decision : null,
    messages: w.messages.map((m, i) => ({ id: i, author: m.author, mine: m.email === user.email, body: m.body, time: m.time })),
    events: w.events, chainIntact: true, evidence: w.id === 'night-signal' ? exampleEvidence : null,
  };
}
function signIfComplete(w: Work): void {
  if (fullyApproved(w.rows.map((r) => ({ share: hasShare(r), decision: r.decision })))) {
    w.status = 'signed';
    log(w, 'SIGNED', 'Everyone with a share approved. The split sheet is signed.');
  }
}

export const previewBackend: Backend = {
  mode: 'preview',
  me: async () => (signedIn ? user : null),
  register: async () => { signedIn = true; return user; },
  login: async () => { signedIn = true; return user; },
  logout: async () => { signedIn = false; },
  saveProfile: async (profile) => (user = { ...user, ...profile }),
  works: async () => [...works].sort((a, b) => b.updatedAt - a.updatedAt).map(detail),
  activity: async (): Promise<Activity[]> =>
    works.flatMap((w) => w.events.map((e) => ({ work: w.title, time: e.time, text: e.text }))).sort((a, b) => b.time - a.time).slice(0, 12),
  createWork: async ({ title, album, copyFrom }) => {
    if (!title.trim()) throw new Error('Title is required');
    const source = copyFrom ? find(copyFrom) : null;
    const w: Work = { id: `w${Date.now()}`, title: title.trim(), album: album.trim(), status: 'draft', owner: user.email, messages: [], events: [], updatedAt: Date.now(),
      rows: source ? source.rows.map((r) => ({ ...r, decision: 'none' as Decision })) : [row(user.artistName, user.legalName, user.role, 100, 100, user.email, 'none')] };
    log(w, 'CREATE', `${user.artistName} created "${w.title}"${w.album ? ` on "${w.album}"` : ''}`);
    works.push(w);
    return detail(w);
  },
  updateWork: async (id, { title, album }) => {
    const w = find(id);
    if (!title.trim()) throw new Error('Title is required');
    w.title = title.trim(); w.album = album.trim();
    log(w, 'FILE', `${user.artistName} filed this as "${w.title}"${w.album ? ` on "${w.album}"` : ' (single)'}`);
    return detail(w);
  },
  work: async (id) => detail(find(id)),
  setOwner: async (id) => detail(find(id)),
  deleteWork: async (id) => { const i = works.findIndex((x) => x.id === id); if (i >= 0) works.splice(i, 1); },
  exportMyData: async () => ({ profile: user, songs: works.map(detail) }),
  deleteAccount: async () => { throw new Error('Deleting an account needs the server. This is the preview.'); },
  savePeople: async (id, people) => {
    const w = find(id);
    if (w.status === 'signed') throw new Error('This split sheet is signed and can no longer be changed');
    w.rows = people.map((p) => ({ ...p, email: p.email.trim().toLowerCase(), decision: 'none' as Decision }));
    w.status = 'draft';
    log(w, 'SPLIT', `${user.artistName} set the split (writer/master): ${people.map((p) => `${p.artistName} ${p.writerShare}/${p.masterShare}`).join(', ')}`);
    return detail(w);
  },
  send: async (id) => {
    const w = find(id);
    const problem = sendProblem(detail(w).rows);
    if (problem) throw new Error(problem);
    w.status = 'sent';
    for (const r of w.rows) if (r.email === user.email) r.decision = 'approved';
    log(w, 'SEND', `${user.artistName} sent the split sheet for approval`);
    signIfComplete(w);
    return detail(w);
  },
  decide: async (id, decision) => {
    const w = find(id), mine = w.rows.find((r) => r.email === user.email);
    if (!mine || w.status !== 'sent') throw new Error('This split sheet is not waiting for you');
    mine.decision = decision;
    log(w, decision === 'approved' ? 'APPROVE' : 'DECLINE', `${user.artistName} (${user.legalName}) ${decision} the split: writer ${mine.writerShare}%, master ${mine.masterShare}%`);
    signIfComplete(w);
    return detail(w);
  },
  pluginKeys: async () => [],
  createPluginKey: async () => { throw new Error('Plugin keys need the server. This is the preview.'); },
  revokePluginKey: async () => [],
  fingerprints: async () => [],
  signatures: async () => [],
  uploadReceipt: async () => { throw new Error('Uploading a receipt needs the server. This is the preview.'); },
  artist: async () => { throw new Error('Looking up an Artist ID needs the server. This is the preview.'); },
  fingerprintDetails: async () => { throw new Error('Details need the server. This is the preview.'); },
  fingerprintData: async () => new ArrayBuffer(0),
  postMessage: async (id, body) => {
    const w = find(id);
    w.messages.push({ author: user.artistName, email: user.email, body, time: Date.now() });
    w.updatedAt = Date.now();
    return detail(w);
  },
};
