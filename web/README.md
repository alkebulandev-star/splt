# Split Tracker Web

The website and workspace that go with the Split Tracker and Split Tag plugins.

    npm install
    npm run check      # typecheck, 39 tests, build
    npm run test:plugin   # real plugins against a live server (needs the C++ build)
    npm run test:sync     # two-way sync: two people, two projects, one song
    npm start          # build, then serve at http://localhost:4173

Needs Node 23.6 or newer (it runs the TypeScript directly). The database is SQLite through
`better-sqlite3`, the one runtime dependency.
`PORT`, `SPLIT_TRACKER_DB` (database file, default `data/split-tracker.db`) and `HTTPS=1`
(marks the session cookie Secure) are optional.

`npm run build` writes one self-contained page to `dist/index.html`. Served by the server it
uses real accounts; opened on its own it falls back to an in-page preview with example people.

## What works today

Everything here runs in the browser. No audio is uploaded or stored.

- **Identify** (`src/ui/identify.ts`): keep a library of masters and stems, then drop any audio
  to see which one it is. The library takes the `.fingerprint` files the plugin saves next to
  each bounce receipt, or audio files.
  - *Same recording / shares material*: `src/core/fingerprint.ts`, a port of the plugin's
    `Source/Fingerprint.h`. A test runs the plugin's C++ fingerprinter on the same audio and
    requires at least 97% agreement.
  - *Same melody* / *possibly the same melody*: `src/core/melody.ts`. Recognises a song that was
    pitched or sped up or down. Measured on 24 real songs: 95% found with no false matches at
    the strong level. Numbers, method and limits are in `docs/melody-accuracy.md`; rerun with
    `node tools/melody-eval.ts <folder of songs>`. Needs an audio reference; the plugin does not
    save melody profiles yet.
- **Verify** (`src/ui/verify.ts`): SHA-256 of a file, or the plugin's folder signature for
  projects that are folders, compared with the code printed on a receipt.
- **Split sheet rules** (`src/core/splits.ts`): writer and master shares must each total 100%
  and anyone with a share needs a legal name.

## The server (`server/`)

Plain `node:http`, no framework. `server/db.ts` holds the schema as numbered migrations.

- **Accounts**: email and password. Passwords are stored as scrypt hashes with a per-user
  salt; session tokens live in an HttpOnly, SameSite=Lax cookie and only their hash is stored.
  Ten wrong passwords locks that email for 15 minutes. Requests must be JSON from this site.
- **Songs and albums**: each song has its own split sheet and is filed under an album or as a
  single. A new song can start from the split of another of your songs.
- **Approvals**: a sheet can be sent only when writer and master shares each total 100% and
  everyone with a share has a legal name and an email. Sending counts as the owner's approval.
  Each other share holder approves or declines after signing in with that email. When all have
  approved the sheet is signed and locked. Changing a sent sheet withdraws its approvals.
- **Privacy**: a draft is visible only to its owner. Once sent, a song is visible to the
  people on its sheet and to nobody else (others get "not found").
- **Messages**: one thread per song, seen by the people on that song.
- **History**: every change is an entry sealed with a SHA-256 hash of the entry before it,
  the same scheme as the plugin's log. An edited database row shows as "History has been altered".

## Plugin link

- Profile > Plugin link creates a key per computer (`stk_...`). Keys stay readable on the
  Profile page, so they are stored as they are; a key can only upload records for its account,
  not sign in or read anything, and can be removed at any time.
- `POST /api/plugin/sync` takes a project's records, creates the song on first sync (matched
  by the plugin's project ID afterwards), re-checks the plugin's log chain and replies with
  the fingerprint files it still needs. `PUT /api/plugin/works/:id/fingerprints/:fpId` takes
  each one and refuses a file whose SHA-256 is not that ID.
- The split sheet shows a "From the plugin" card (tracks, artists, takes, stems, bounces, log
  status) and Identify loads the uploaded masters and stems by itself.
- Verify cross-checks a chosen project or export against every signature the plugin uploaded
  (`GET /api/signatures`), so nothing has to be pasted.
- `npm run test:plugin` runs the real plugins against a live server (needs the C++ build).

## Database housekeeping

- **Migrations.** The schema is built by numbered steps and the file records which it has
  reached, so an older database is brought up to date when the server starts.
- **Backups.** A complete copy is written to `data/backups/` when the server starts and every
  24 hours, keeping the newest 14. `npm run db:backup` writes one now.
- **Restore.** Stop the server, then `npm run db:restore -- data/backups/<file>`. The current
  database is backed up first, and a damaged backup is refused.
- **Checks.** `npm run db:check` verifies the file and that no row points at something missing,
  and prints the counts. The same check runs at every start.
- **Tidying.** Expired sign-ins are removed and each project's upload history is kept to its
  latest 50.
- **Deleting.** An owner can delete a song that is not signed (typing its title to confirm). A
  signed sheet cannot be deleted. An account can be deleted with its password once it owns no
  song that other people are on.
- **Your data.** Profile > Your data shows everything held about the signed-in person.

## Not built yet



- Email. Nobody is notified: an invited person sees the song when they sign in with the email
  on the sheet. There is no email verification and no password reset.
- Deployment. It has only been run on this computer. Before it faces the internet it needs
  HTTPS and the backups folder copied somewhere off the machine.
- Rate limiting beyond sign-in, and exporting a signed sheet as a PDF.

## Layout

    server/     app.ts (routes and rules), db.ts (schema), main.ts (entry point)
    src/core/   pure logic shared by browser and server, covered by tests/
    src/ui/     one module per screen
    src/index.html, src/styles.css
    tests/      node --test; synth.ts makes the test audio
    build.mjs   esbuild bundle inlined into one page

## Offline receipt

When the studio computer has no internet, or is not linked to an account, the plugin can save the same
records a sync would send as one file: Evidence tab, "Save offline receipt..." (`<song> - offline receipt.splitreceipt`).
The file holds the split, session records, the hash-chained log and the fingerprints. It never holds audio.

The file is sent to the song's owner by any means. On the website (Overview, "Upload an offline receipt")
they see what is in it and choose: register it as a new song (optionally stating themselves as owner), or
add it to a song they manage as a separate project (optionally taking its split while the sheet is a draft).
The server (`POST /api/receipts`) checks the file's checksum, re-checks the log chain, refuses a receipt older
than what it already holds for that project, and labels the source as an offline receipt. When that project's
own plugin later syncs, the live record replaces the receipt. Covered by `npm run test:sync` (stages 8 to 10).

