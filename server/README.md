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
| Auth: login, HttpOnly refresh cookie, register, logout, `/user` | done |
| Two-factor (TOTP): enroll, enable, disable | done |
| Permissions: owner / user share / team share | done |
| Projects: CRUD, views, archive, duplicate, favourite | done |
| Tasks: per project, per view, cross-project, CRUD, bulk edit | done |
| Assignees, labels, reminders, repeating, relations (both directions) | done |
| Comments: create, edit, delete, author-only rules | done |
| Attachments: upload, list, download, delete | done |
| Reactions, subscriptions, favourites | done |
| Kanban buckets, creating buckets, moving cards | done |
| Storage: list, link, upload, download, preview, rename, delete | done |
| Sharing: project users, teams, link shares, user search | done |
| API tokens (hashed, shown once), notifications, saved filters | done |
| Avatars | generated initials |
| Task positions / drag reordering | not ported |
| Filter DSL beyond `done` | not ported |
| CalDAV, webhooks, imports (Todoist/Trello/CSV), Unsplash backgrounds | not ported |
| Data export/deletion, email sending, cron reminders | not ported |
| Plugin system (yaegi) | cannot port — it is a Go interpreter |

Everything the web client uses day to day works. The unported rows are either
separate protocols, background jobs, or integrations; the app runs without them.

## Differences from the Go server, on purpose

- **Uploads are typed by content, not by the client.** The multipart
  `Content-Type` is attacker-controlled, so `lib/sniff.js` derives the mime from
  magic bytes and anything unidentified becomes `application/octet-stream`,
  which is not previewable. A consequence is that SVG is download-only here,
  where the Go server previewed it through `<img>`.
- **Refresh tokens are an HttpOnly cookie**, rotated on every use, and an access
  token is rejected if presented as one.

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
