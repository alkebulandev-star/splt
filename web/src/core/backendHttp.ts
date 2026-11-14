import type { Activity, ArtistCard, Backend, FingerprintDetails, Signature, PersonInput, PluginKey, Profile, StoredFingerprint, User, WorkDetail, WorkSummary } from './api.ts';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? 'Something went wrong. Try again.');
  return data as T;
}

/** Talks to server/app.ts. The session lives in an HttpOnly cookie, so no token is held in the page. */
export const httpBackend: Backend = {
  mode: 'server',
  me: () => call<User>('GET', '/me').catch(() => null),
  register: (input) => call<User>('POST', '/register', input),
  login: (email, password) => call<User>('POST', '/login', { email, password }),
  logout: () => call<void>('POST', '/logout'),
  saveProfile: (profile: Profile) => call<User>('PUT', '/profile', profile),
  works: () => call<WorkSummary[]>('GET', '/works'),
  activity: () => call<Activity[]>('GET', '/activity'),
  createWork: (input) => call<WorkDetail>('POST', '/works', input),
  updateWork: (id, input) => call<WorkDetail>('PUT', `/works/${id}`, input),
  work: (id) => call<WorkDetail>('GET', `/works/${id}`),
  setOwner: (id, artistId) => call<WorkDetail>('POST', `/works/${id}/owner`, { artistId }),
  deleteWork: (id, confirmTitle) => call<void>('DELETE', `/works/${id}`, { confirmTitle }),
  exportMyData: () => call<unknown>('GET', '/me/export'),
  deleteAccount: (password) => call<void>('DELETE', '/me', { password }),
  savePeople: (id, people: PersonInput[]) => call<WorkDetail>('PUT', `/works/${id}/people`, { people }),
  send: (id) => call<WorkDetail>('POST', `/works/${id}/send`),
  decide: (id, decision) => call<WorkDetail>('POST', `/works/${id}/decision`, { decision }),
  postMessage: (id, body) => call<WorkDetail>('POST', `/works/${id}/messages`, { body }),
  pluginKeys: () => call<PluginKey[]>('GET', '/keys'),
  createPluginKey: (name) => call<{ key: string; keys: PluginKey[] }>('POST', '/keys', { name }),
  revokePluginKey: (id) => call<PluginKey[]>('DELETE', `/keys/${id}`),
  fingerprints: () => call<StoredFingerprint[]>('GET', '/fingerprints'),
  fingerprintDetails: (fp) => call<FingerprintDetails>('GET', `/works/${fp.workId}/fingerprints/${fp.fpId}/details${fp.track ? `?track=${encodeURIComponent(fp.track)}` : ''}`),
  artist: (artistId) => call<ArtistCard>('GET', `/artists/${encodeURIComponent(artistId)}`),
  uploadReceipt: (receipt, options) => call('POST', '/receipts', { receipt, ...options }),
  signatures: () => call<Signature[]>('GET', '/signatures'),
  fingerprintData: async (fp) => {
    const r = await fetch(`/api/works/${fp.workId}/fingerprints/${fp.fpId}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('Could not load that fingerprint');
    return r.arrayBuffer();
  },
};

/** True when this page is being served by the Split Tracker server. */
export async function serverAvailable(): Promise<boolean> {
  try {
    const r = await fetch('/api/health', { credentials: 'same-origin' });
    return r.ok && ((await r.json()) as { ok?: boolean }).ok === true;
  } catch { return false; }
}
