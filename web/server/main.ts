// Starts the server: node server/main.ts  (PORT, SPLIT_TRACKER_DB and HTTPS=1 are optional)
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { createApp } from './app.ts';
import { backupDatabase, checkDatabase, openDb, tidyDatabase } from './db.ts';

const root = join(import.meta.dirname, '..');
const dbPath = process.env.SPLIT_TRACKER_DB ?? join(root, 'data', 'split-tracker.db');
const backups = process.env.SPLIT_TRACKER_BACKUPS ?? join(dirname(dbPath), 'backups');
const db = openDb(dbPath);

// Housekeeping: check the file is sound, clear out what has expired, and keep a daily copy.
function housekeeping(): void {
  const health = checkDatabase(db);
  if (!health.ok) console.error('DATABASE PROBLEMS:\n  ' + health.problems.join('\n  '));
  const tidied = tidyDatabase(db);
  const copy = backupDatabase(db, backups);
  console.log(`Housekeeping: database ${health.ok ? 'sound' : 'HAS PROBLEMS'}, ${tidied.sessions} expired sign-ins removed, backup written to ${copy}`);
}
housekeeping();
setInterval(housekeeping, 24 * 60 * 60 * 1000).unref();

const port = Number(process.env.PORT ?? 4173);
const app = createApp(db, { pagePath: join(root, 'dist', 'index.html'), secureCookies: process.env.HTTPS === '1' });
createServer(app).listen(port, () => console.log(`Split Tracker at http://localhost:${port}  (database: ${dbPath})`));
