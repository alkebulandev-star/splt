// Starts the server: node server/main.ts  (PORT, SPLIT_TRACKER_DB and HTTPS=1 are optional;
// STORE=firestore runs it on Firestore instead of SQLite, see openStore.ts)
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { openStore } from './openStore.ts';

const root = join(import.meta.dirname, '..');
const opened = await openStore();

if (opened.kind === 'sqlite') {
  // Housekeeping for the SQLite file: check it is sound, clear out what has expired, and keep a daily copy.
  // (Firestore keeps its own copies and has no file to check, so none of this applies there.)
  const { backupDatabase, checkDatabase, tidyDatabase } = await import('./db.ts');
  const { db, backups } = opened;
  const housekeeping = (): void => {
    const health = checkDatabase(db);
    if (!health.ok) console.error('DATABASE PROBLEMS:\n  ' + health.problems.join('\n  '));
    const tidied = tidyDatabase(db);
    const copy = backupDatabase(db, backups);
    console.log(`Housekeeping: database ${health.ok ? 'sound' : 'HAS PROBLEMS'}, ${tidied.sessions} expired sign-ins removed, backup written to ${copy}`);
  };
  housekeeping();
  setInterval(housekeeping, 24 * 60 * 60 * 1000).unref();
}

const port = Number(process.env.PORT ?? 4173);
const app = createApp(opened.store, { pagePath: join(root, 'dist', 'index.html'), secureCookies: process.env.HTTPS === '1' });
createServer(app).listen(port, () => console.log(`Split Tracker at http://localhost:${port}  (database: ${opened.describe})`));
