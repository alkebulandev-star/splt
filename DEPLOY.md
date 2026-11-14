# Putting the website on GitHub and Vercel

## What goes live with this setup

Vercel builds `web/` and serves the one page it produces (`web/dist/index.html`): the landing page and the
web app. Without a server behind it the app runs in **preview mode**: sign-in and sign-up are a mock-up with
sample data, and nothing is saved. The page says so in a banner.

Real accounts, plugin sync, fingerprint uploads and offline receipts need the server (`web/server/`), and the
server cannot run on Vercel yet: it keeps its data in a SQLite file, and Vercel functions have no permanent
disk. Moving the data to a hosted database is the next step and is not part of this zip.

## GitHub

    git init
    git add .
    git commit -m "Split Tracker: plugin, website and server"
    git branch -M main
    git remote add origin https://github.com/<you>/<repository>.git
    git push -u origin main

`.gitignore` keeps out the build folders, `node_modules`, JUCE, and `web/data/` (the database and its backups,
which hold accounts and must never be committed).

## Vercel

Import the GitHub repository in Vercel and leave every setting as it is. `vercel.json` at the top of the
repository already says:

- install: `cd web && npm ci --ignore-scripts`
- build: `cd web && npm run build`
- output: `web/dist`

Every push to `main` redeploys.

## Running the full thing on your own computer

    cd web
    npm install
    npm start          # http://localhost:4173, real accounts, data in web/data/

## Building the plugin

See BUILDING.md. JUCE is not in the repository; BUILDING.md has the one command that fetches it.
