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
| Auth: login, HttpOnly refresh cookie, `/user`, register, logout | done |
| Permissions: owner / user share / team share | done |
| Projects: list, read, create, update, delete, views | done |
| Tasks: per project, per view, cross-project, CRUD | done |
| Assignees, labels on tasks | done |
| Kanban buckets, moving cards | done |
| Storage: list, link, upload, download, preview, rename, delete | done |
| Sharing: project users + teams, user search | done |
| Notifications, saved filters (read), avatars | done |
| Attachments on tasks, comments, relations, reminders | not ported |
| Task positions/reordering, filters beyond `done` | not ported |
| CalDAV, webhooks, subscriptions, imports, 2FA | not planned |

The app loads and works end to end: sign in, browse projects, see tasks with
assignees and due dates, and use the storage view. The unported areas above are
features of the task detail screen and will be missing or inert until done.

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
