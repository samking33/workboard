# Deploying FSOC Workboard

This app is a Node.js server that also serves the prebuilt web client. It needs
a persistent process and a port — see "Hostinger" below.

## What the host has to do

```bash
npm --prefix server install --omit=dev   # or: npm run build
npm start                                # node server/src/index.js
```

That is the whole build. **pnpm is never needed.** The web client under
`frontend/dist` is committed already built, precisely so no build step runs on
the server.

If your platform reports a pnpm version error, it has auto-detected one of the
directories that are *not* part of this deployment:

- `frontend/` — source for the client. Only needed to rebuild the UI; the built
  output is already committed.
- `desktop/` — the Electron wrapper. Irrelevant to a web deployment.
- `pkg/`, `magefile.go` — the original Go API this server replaces.

Point the build at the repo root (which has a `package.json` describing exactly
the two commands above) rather than at `frontend/`.

## Configuration

Set these as environment variables. Never commit them.

```
VIKUNJA_SERVICE_SECRET=<long random string>
VIKUNJA_SERVICE_PUBLICURL=https://your-domain/
VIKUNJA_DATABASE_HOST=<host>:3306
VIKUNJA_DATABASE_USER=<user>
VIKUNJA_DATABASE_PASSWORD=<password>
VIKUNJA_DATABASE_DATABASE=<database>
VIKUNJA_FILES_BASEPATH=/absolute/path/to/writable/files
PORT=3456
```

`VIKUNJA_SERVICE_SECRET` signs every session token: changing it logs everyone
out, and a guessable value lets anyone forge one. Generate it with
`openssl rand -hex 32`.

Optional settings (email, webhooks) are listed in `server/README.md`.

## Hostinger

**Shared hosting cannot run this app**, in any language. It needs a process that
stays alive and listens on a port; shared plans only run PHP per request. This
is not a limitation of the Node rewrite — the Go version could not run there
either.

What does work:

- **VPS** — install Node 20+, clone, set the variables above, run under
  systemd or pm2, and put nginx in front for TLS.
- Any Node host (Railway, Render, Fly, a container platform).

Whichever you choose, restrict **Remote MySQL** to that server's IP. Leaving it
open to any address exposes the database to the whole internet.
