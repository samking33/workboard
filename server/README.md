# FSOC — Node.js server

A Node.js replacement for the Go API, in progress.

## Why this shape

The rewrite is scoped so it can ship incrementally rather than as one big-bang
replacement:

- **The database is unchanged.** This server reads the schema the Go migrations
  already created. No data migration, and existing bcrypt passwords keep
  working, so nobody has to reset anything.
- **The frontend is unchanged.** `frontend/` is already a Vue SPA — it was never
  Go. This server serves the same built output and speaks the same HTTP
  contract, so the UI needs no changes.
- **Config is unchanged.** The same `VIKUNJA_*` environment variables are read,
  so a deployment's env file works as-is.

What is being replaced is only the API layer.

## Status

| Area | State |
|---|---|
| Auth (login, refresh, `/user`, register) | done |
| Permissions (owner / user share / team share) | done |
| Projects (list, read, create, update, delete) | done |
| Project views | read only |
| Tasks | not started |
| Labels, buckets, assignees | not started |
| Storage items + upload/preview/download | not started |
| Teams, sharing endpoints | not started |
| CalDAV, webhooks, subscriptions, migrations | not planned |

Until the remaining areas land, this server cannot replace the Go one — the
frontend will fail on any endpoint that is missing.

## Run

```bash
cd server && npm install
env VIKUNJA_SERVICE_SECRET=... \
    VIKUNJA_DATABASE_HOST=127.0.0.1:3306 \
    VIKUNJA_DATABASE_USER=... \
    VIKUNJA_DATABASE_PASSWORD=... \
    VIKUNJA_DATABASE_DATABASE=... \
    PORT=3457 npm start
```

Serves the API on `/api/v1` and the built frontend from `../frontend/dist`.
