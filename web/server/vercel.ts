// The server as one Vercel function. vercel.json sends every /api/... request here; the pages
// themselves are served by Vercel as static files. Storage is Firestore (a function has no disk).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from './app.ts';
import { FirestoreStore } from './storeFirestore.ts';

interface Key { project_id: string; client_email: string; private_key: string }

/** A key's parts, however the text holding them was mangled on the way in. Null if they are not all there. */
function readKey(text: string): Key | null {
  let t = text.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  if (!t.startsWith('{') && /^[A-Za-z0-9+/=\s]+$/.test(t)) {
    try { t = Buffer.from(t, 'base64').toString('utf8').trim(); } catch { /* not base64 */ }
  }
  const tidy = (k: Partial<Key>): Key | null =>
    typeof k.project_id === 'string' && typeof k.client_email === 'string' && typeof k.private_key === 'string' && k.private_key.includes('PRIVATE KEY')
      ? { project_id: k.project_id.trim(), client_email: k.client_email.trim(), private_key: k.private_key.replace(/\\n/g, '\n') } : null;
  try { const k = tidy(JSON.parse(t) as Partial<Key>); if (k) return k; } catch { /* fall through to picking the parts out */ }
  // Pasted through something that turned the \n marks into real line breaks, or dropped a brace.
  const field = (name: string): string | undefined => new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(t)?.[1];
  const pem = /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/.exec(t)?.[0];
  return tidy({ project_id: field('project_id'), client_email: field('client_email'), private_key: pem ? pem.replace(/\\n/g, '\n').replace(/\r/g, '') + '\n' : undefined });
}

/**
 * Finds the Firebase key in the environment. The intended form is one variable, FIREBASE_SERVICE_ACCOUNT,
 * holding the whole key file. Also accepted, because they are easy mistakes: the whole key under another
 * name, or its three parts as separate variables (project_id, client_email, private_key, with or
 * without a FIREBASE_ prefix, in any letter case).
 */
function findKey(env: NodeJS.ProcessEnv): { key: Key | null; why: string } {
  const named = env.FIREBASE_SERVICE_ACCOUNT;
  if (named) {
    const key = readKey(named);
    if (key) return { key, why: '' };
  }
  for (const [name, value] of Object.entries(env))
    if (value && name !== 'FIREBASE_SERVICE_ACCOUNT' && value.includes('PRIVATE KEY') && value.includes('client_email')) {
      const key = readKey(value);
      if (key) return { key, why: '' };
    }
  const part = (suffix: string): string | undefined =>
    Object.entries(env).find(([name, value]) => value && new RegExp(`(^|_)${suffix}$`, 'i').test(name))?.[1];
  const key = readKey(JSON.stringify({ project_id: part('project_id'), client_email: part('client_email'), private_key: part('private_key') }));
  if (key) return { key, why: '' };
  return { key: null, why: named
    ? `FIREBASE_SERVICE_ACCOUNT is set (${named.length} characters) but is not a whole Firebase key: it must be the complete key file, starting with { and ending with }.`
    : 'FIREBASE_SERVICE_ACCOUNT is not set in this deployment.' };
}

let app: ReturnType<typeof createApp> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!app) {
    let why = '';
    try {
      const found = findKey(process.env);
      why = found.why;
      // Opened once and reused while this function instance stays warm.
      if (found.key) app = createApp(FirestoreStore.open({ ...process.env, FIREBASE_SERVICE_ACCOUNT: JSON.stringify(found.key) }), { secureCookies: true, trustProxy: true });
    } catch (err) {
      why = `The key was found but Firebase refused it: ${(err as Error).message}`;
    }
    if (!app && !process.env.FIREBASE_SERVICE_ACCOUNT) {
      // Not on Vercel: a key file on this computer (FIREBASE_KEY_FILE, or the usual place) will do.
      try { app = createApp(FirestoreStore.open(process.env), { secureCookies: true, trustProxy: true }); } catch { /* `why` already says what is missing */ }
    }
    if (!app) {
      // Names only, never values, so the cause can be seen without opening Vercel's logs.
      const names = Object.keys(process.env).filter((n) => /FIREBASE|GOOGLE|STORE|SPLIT|PROJECT_ID|CLIENT_EMAIL|PRIVATE_KEY|^API|KEY$/i.test(n) && !/^(VERCEL|AWS|NODE|NX|TURBO)_/.test(n)).sort();
      console.error('Split Tracker could not start:', why);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        error: 'The server is not set up yet. In Vercel, add the environment variable FIREBASE_SERVICE_ACCOUNT (the whole Firebase key file) and redeploy.',
        reason: why,
        variablesSeen: names,
      }));
      return;
    }
  }
  await app(req, res);
}
