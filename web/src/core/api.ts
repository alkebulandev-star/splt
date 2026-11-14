import type { Decision, Person, WorkStatus } from './splits.ts';

export interface Profile {
  artistName: string;
  legalName: string;
  role: string;
  pro: string;
  ipi: string;
  publisher: string;
  publisherIpi: string;
  isni: string;
  phone: string;
}
export interface User extends Profile { id: number; email: string; /** Public code others use to add this person to a split sheet. */ artistId: string }
/** What someone's Artist ID reveals: enough to put them on a split sheet. */
export interface ArtistCard { artistId: string; artistName: string; legalName: string; role: string; pro: string; ipi: string; publisher: string; publisherIpi: string; email: string }

export interface WorkSummary {
  id: string;
  title: string;
  /** Album or project the song is filed under; '' means a single. */
  album: string;
  status: WorkStatus;
  /** True when you may change this song: you own it or you started it. */
  isOwner: boolean;
  /** Public code a collaborator types into their own project's plugin to join this song. */
  songCode: string;
  ownerName: string;
  ownerArtistId: string;
  /** False until someone has said who owns the song. Nobody else can join before that. */
  ownerStated: boolean;
  /** True when you are the owner (not merely the person who started it). */
  youOwn: boolean;
  people: string[];
  yourWriterShare: number | null;
  /** People with a share who have not approved yet (only while sent). */
  awaiting: number;
  needsYou: boolean;
  updatedAt: number;
}
export interface Message { id: number; author: string; mine: boolean; body: string; time: number }
export interface WorkEvent { time: number; type: string; text: string; hash: string }
/** One DAW project feeding a song. Each collaborator's project is its own source. */
export interface SourceInfo { artistName: string; /** Set when this project's record came from an offline receipt file: who uploaded it. `artistName` is then who the receipt says made it. */ receiptUploadedBy?: string; isOwner: boolean; syncedAt: number; logIntact: boolean; logEntries: number; tracks: number; takes: number; bounces: number }

export interface WorkDetail extends WorkSummary {
  isrc: string;
  iswc: string;
  /** Goes up on every change to the split sheet, from the website or a plugin. */
  splitVersion: number;
  sources: SourceInfo[];
  rows: Person[];
  yourDecision: Decision | null;
  messages: Message[];
  events: WorkEvent[];
  /** False if the stored history no longer matches its own hash chain. */
  chainIntact: boolean;
  /** Null until the plugin has synced this song. */
  evidence: Evidence | null;
}
export interface Activity { work: string; time: number; text: string }

/** What the plugin recorded for a song, as last uploaded. */
export interface Evidence {
  syncedAt: number;
  /** False if the plugin's log no longer matches its own hash chain. */
  logIntact: boolean;
  logEntries: number;
  chainHead: string;
  splitsLocked: boolean;
  sessionSeconds: number;
  recordSeconds: number;
  /** `source` says whose project each item came from, when several projects feed the song. */
  tracks: { trackName: string; person: string; signalSeconds: number; recordSeconds: number; takes: number; source?: string }[];
  takes: { track: string; person: string; num: number; time: number; durationSecs: number; songPos: number; source?: string }[];
  bounces: { num: number; time: number; durationSecs: number; fpId: string; fileSha: string; fileName?: string; source?: string; stems: { trackName: string; person: string; fpId: string }[] }[];
  playSeconds?: number;
  /** Computers that have opened the project, as the plugin lists them. */
  computers?: { name: string; os: string; firstSeen: number; lastSeen: number; opens: number }[];
  project: { fileName: string; sha: string; daw: string; time: number } | null;
  /** Every project-file signature in the plugin's log, oldest first. */
  projects: { fileName: string; daw: string; sha: string; time: number }[];
}
/** The file the plugin saves when it cannot reach the website: what a sync would have sent, plus the fingerprints. */
export interface ReceiptFile {
  format: 'split-tracker-receipt';
  version: 1;
  madeAt: number;
  /** The linked account, if the plugin knew one; otherwise ''. Stated by the plugin, not checked. */
  madeBy: string;
  computer: string;
  /** SHA-256 of `payload`, so a damaged or edited file is noticed. */
  payloadSha256: string;
  /** The sync payload as JSON text. */
  payload: string;
  /** Fingerprint id -> the fingerprint file in base64. Codes worked out from the audio, never audio. */
  fingerprints: Record<string, string>;
}
export interface ReceiptOptions { mode: 'new' | 'add'; workId?: string; iAmOwner?: boolean; useSplit?: boolean }
export interface ReceiptResult { workId: string; title: string; created: boolean; logIntact: boolean; fingerprints: number; fingerprintsMissing: number }
export interface PluginKey { id: number; name: string; key: string; createdAt: number; lastUsedAt: number | null }
export interface StoredFingerprint { workId: string; fpId: string; title: string; kind: 'Master' | 'Stem'; name: string; /** Track name for a stem, '' for the master. */ track: string; bounce: number; seconds: number }
export interface LogLine { time: number; type: string; text: string }
/** Everything known about one master or stem, with only the log lines that concern it. */
export interface FingerprintDetails {
  kind: 'Master' | 'Stem';
  title: string;
  album: string;
  fpId: string;
  seconds: number;
  bounce: { num: number; time: number; durationSecs: number; fileSha: string };
  /** For a stem: the track it came from. */
  track: { trackName: string; person: string; signalSeconds: number; recordSeconds: number; takes: number } | null;
  takes: { num: number; time: number; durationSecs: number; songPos: number; person: string }[];
  /** For a master: the stems sealed with it. */
  stems: { trackName: string; person: string }[];
  log: LogLine[];
}

/** A signature the plugin recorded: a project file as saved at some moment, or a sealed export. */
export interface Signature { workId: string; title: string; kind: 'Project file' | 'Sealed export'; label: string; sha: string; time: number; latest: boolean }

export type PersonInput = Omit<Person, 'status'>;

/** Everything the screens need. Implemented by the real server and by the in-page preview. */
export interface Backend {
  readonly mode: 'server' | 'preview';
  me(): Promise<User | null>;
  register(input: { email: string; password: string; artistName: string; legalName: string }): Promise<User>;
  login(email: string, password: string): Promise<User>;
  logout(): Promise<void>;
  saveProfile(profile: Profile): Promise<User>;
  works(): Promise<WorkSummary[]>;
  activity(): Promise<Activity[]>;
  /** `copyFrom` starts the new song with the split of one of your other songs, e.g. the rest of the album. */
  createWork(input: { title: string; album: string; copyFrom?: string }): Promise<WorkDetail>;
  updateWork(id: string, input: { title: string; album: string; isrc?: string; iswc?: string }): Promise<WorkDetail>;
  /** States who owns the song, by their Artist ID. Needed before anyone else can join it. */
  setOwner(id: string, artistId: string): Promise<WorkDetail>;
  /** Deletes a song you own that has not been signed. `confirmTitle` must be its exact title. */
  deleteWork(id: string, confirmTitle: string): Promise<void>;
  /** Everything held about you, as one object. */
  exportMyData(): Promise<unknown>;
  deleteAccount(password: string): Promise<void>;
  work(id: string): Promise<WorkDetail>;
  savePeople(id: string, people: PersonInput[]): Promise<WorkDetail>;
  send(id: string): Promise<WorkDetail>;
  decide(id: string, decision: 'approved' | 'declined'): Promise<WorkDetail>;
  postMessage(id: string, body: string): Promise<WorkDetail>;
  pluginKeys(): Promise<PluginKey[]>;
  createPluginKey(name: string): Promise<{ key: string; keys: PluginKey[] }>;
  revokePluginKey(id: number): Promise<PluginKey[]>;
  /** Fingerprints the plugin uploaded for the songs you can see. */
  fingerprints(): Promise<StoredFingerprint[]>;
  fingerprintData(fp: StoredFingerprint): Promise<ArrayBuffer>;
  fingerprintDetails(fp: Pick<StoredFingerprint, 'workId' | 'fpId' | 'track'>): Promise<FingerprintDetails>;
  /** Project-file and export signatures for the songs you can see, to cross-check a file against. */
  signatures(): Promise<Signature[]>;
  /** Registers an offline receipt file from the plugin, as a new song or into one you manage. */
  uploadReceipt(receipt: ReceiptFile, options: ReceiptOptions): Promise<ReceiptResult>;
  /** Looks up an account by its Artist ID. Rejects if nobody has signed up with it. */
  artist(artistId: string): Promise<ArtistCard>;
}

export const PROFILE_FIELDS: (keyof Profile)[] = ['artistName', 'legalName', 'role', 'pro', 'ipi', 'publisher', 'publisherIpi', 'isni', 'phone'];
