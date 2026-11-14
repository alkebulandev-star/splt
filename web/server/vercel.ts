// The server as one Vercel function. vercel.json sends every /api/... request here; the pages
// themselves are served by Vercel as static files. Storage is Firestore (a function has no disk).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from './app.ts';
import { FirestoreStore } from './storeFirestore.ts';

let app: ReturnType<typeof createApp> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // Opened once and reused while this function instance stays warm.
    app ??= createApp(FirestoreStore.open(process.env), { secureCookies: true });
  } catch (err) {
    console.error('Split Tracker could not start:', (err as Error).message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'The server is not set up yet. In Vercel, add the environment variable FIREBASE_SERVICE_ACCOUNT (the whole Firebase key file) and redeploy.' }));
    return;
  }
  await app(req, res);
}
