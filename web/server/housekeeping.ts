// Database housekeeping from the command line.
//   npm run db:check     is the file sound, and does every row point at something that exists?
//   npm run db:backup    write a copy now (keeps the newest 14)
//   npm run db:restore -- <backup file>    replace the database with a backup (stop the server first)
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backupDatabase, checkDatabase, openDb, tidyDatabase } from './db.ts';

const root = join(import.meta.dirname, '..');
const dbPath = process.env.SPLIT_TRACKER_DB ?? join(root, 'data', 'split-tracker.db');
const backups = process.env.SPLIT_TRACKER_BACKUPS ?? join(dirname(dbPath), 'backups');
const [command, arg] = process.argv.slice(2);

if (command === 'restore') {
  if (!arg || !existsSync(arg)) { console.error('Give the path of a backup file.'); process.exit(2); }
  const sound = checkDatabase(openDb(arg));
  if (!sound.ok) { console.error('That backup is damaged:\n  ' + sound.problems.join('\n  ')); process.exit(1); }
  if (existsSync(dbPath)) console.log('Kept the current database as ' + backupDatabase(openDb(dbPath), backups));
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  copyFileSync(arg, dbPath);
  console.log(`Restored ${arg} to ${dbPath}`);
} else {
  const db = openDb(dbPath);
  if (command === 'backup') console.log('Backup written to ' + backupDatabase(db, backups));
  else {
    const health = checkDatabase(db), tidied = tidyDatabase(db);
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    console.log(health.ok ? 'Database is sound.' : 'PROBLEMS:\n  ' + health.problems.join('\n  '));
    console.log(`Accounts ${count('users')}, songs ${count('works')}, projects feeding songs ${count('sources')}, fingerprints ${count('fingerprints')}. Removed ${tidied.sessions} expired sign-ins.`);
    process.exit(health.ok ? 0 : 1);
  }
}
