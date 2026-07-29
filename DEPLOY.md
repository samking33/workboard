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
- `pkg/`, `magefile.go` — the original Go API this server replaces.

The repo tells the platform what to run in four places, so detection has no
room to guess:

| File | Purpose |
|---|---|
| `package.json` (root) | `build` and `start` scripts, npm only |
| `Procfile` | `web: node server/src/index.js` |
| `nixpacks.toml` | explicit install/build/start for nixpacks-based builders |
| `.slugignore` | keeps `desktop/`, `pkg/` and `frontend/src/` out of detection |

If your platform lets you set an **app root** or **base directory**, set it to
the repository root — not `frontend/` and not `desktop/`.

### If you see a pnpm version error

It means the build is running in `frontend/` rather than the root. `frontend/`
is a pnpm workspace of client sources with no start command; its built output is
already committed. Point the platform at the repository root.

## Diagnosing a 503

A 503 comes from the platform's proxy, and means one of two things. The startup
log tells you which:

**Nothing is listening.** No `[fsoc] listening on …` line. The platform is
running the wrong start command — check that it is `node server/src/index.js`
and that the app root is the repository root.

**The app is up but the database is not.** The log shows
`[fsoc] CANNOT REACH THE DATABASE`, and `/` returns 200 while
`/api/v1/health` returns 503 with the reason. On a managed host this is almost
always the database refusing the app server's IP — add it to the remote-access
allowlist. `/api/v1/health` is the endpoint to point a monitor at.

## A new or empty database

The Go server built its schema through 129 migrations. This server has no
migration runner, so a fresh database is created from `server/schema.sql`:

```bash
npm run db:init                                    # creates the 38 tables
npm run create-admin -- alice alice@example.com 'a good password'
```

`db:init` runs automatically as part of `npm run build`, so a deploy against an
empty database sets itself up. It is idempotent — every statement is
`IF NOT EXISTS` or `INSERT IGNORE` — so it is safe on an existing database and
reports "schema was already current".

**Registration is off by default**, so without `create-admin` a new instance has
no way to log in. The first account it makes is an administrator with an Inbox
project. The password is an argument, so it lands in shell history: prefix the
command with a space, or `unset HISTFILE` first.

### Moving existing data to a new database

`db:init` creates structure, not content. To carry data across:

```bash
mysqldump -h OLD_HOST -u USER -p --no-create-info --skip-extended-insert DB > data.sql
mysql -h NEW_HOST -u USER -p NEW_DB < data.sql
```

Existing bcrypt password hashes move with the rows, so nobody has to reset
anything.

Do **not** carry these tables across — they are machine-local, and moving them
means old credentials keep working somewhere they should not:

| Table | Why not |
|---|---|
| `sessions` | login sessions from the old host |
| `api_tokens` | live credentials scoped to the old instance |
| `totp` | 2FA secrets; a mismatched one locks the account out |
| `user_tokens` | password-reset and CalDAV tokens |
| `migration` | already written by `schema.sql` |
| `migration_status`, `license_status` | local bookkeeping |

### Uploaded files

Attachments, storage items and avatars are rows in `files` pointing at blobs on
disk under `VIKUNJA_FILES_BASEPATH`. The database rows travel with the dump; the
blobs do not. Copy that directory to the new server and point
`VIKUNJA_FILES_BASEPATH` at it, or the app will list files it cannot serve.

```bash
tar -czf files.tar.gz -C /path/above files
scp files.tar.gz user@server:/tmp/
ssh user@server 'tar -xzf /tmp/files.tar.gz -C /var/lib/fsoc/'
```

The blob filename is the `files.id`, so the directory is only meaningful
alongside the database it came from.

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
