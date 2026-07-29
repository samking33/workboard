# FSOC — Node.js server

A Node.js replacement for the Go API.

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
| Task positions, drag reordering, done ↔ done-bucket sync | done |
| Filter DSL: fields, operators, `&&`/`\|\|`, parentheses, sorting | done |
| Webhooks: HMAC-SHA256 signed, behind an SSRF guard | done |
| Email, in-app notifications, @mentions | done |
| Background jobs: reminders, overdue digest, repeating tasks, deletions | done |
| Realtime WebSocket (`/api/v1/ws`) | done |
| Data export (gzip) and scheduled account deletion | done |
| Imports: CSV, FSOC/Vikunja export, Trello, TickTick, WeKan | done |
| CalDAV (VTODO) with scoped tokens | done |
| Link shares: public auth, password-protected, scoped to one project | done |
| Admin panel: overview, users, projects, roles, status, owner transfer | done |
| Teams: create, rename, delete, add/remove/promote members | done |
| Saved filters, project view CRUD, task duplicate, bulk assignees/labels | done |
| Time tracking: entries, running timer, per-task and per-project views | done |
| Sessions list/revoke, email change, avatar upload, password reset by email | done |
| Bot accounts (API-token identities that cannot sign in) | done |
| Project background upload | done |
| Avatars | generated initials |
| Imports: Todoist, Microsoft Todo | not ported — they need OAuth apps registered with those services |
| Unsplash project backgrounds | not ported — needs an Unsplash API key |
| Plugin system (yaegi) | cannot port — it is a Go source interpreter |

Every endpoint the web client calls is served. The three unported rows each
depend on a third-party credential or a Go-specific runtime, not on missing
work here.

### Pro features

Upstream Vikunja gates the admin panel and time tracking behind a licence. This
server has no licence system and implements both, so `/info` advertises them in
`enabled_pro_features` — that is what makes the client show them. If you ever
run the upstream Go server against this database instead, those screens go back
to being licence-gated.

## Testing

Verified against the real Vue client in a browser, not only through the API —
several bugs were only visible that way: the kanban view has to answer with
buckets rather than tasks, the client gates its write controls on
`max_permission` from the project list, and its filter grammar uses parentheses
and `due_date` spelling that a simpler parser rejected.

Security behaviour proven rather than assumed: HTML uploaded as `image/png` and
scripted SVG are refused (415); a share link cannot reach anything but its one
project; a CalDAV token cannot authenticate a different user; webhook targets
resolving to private or loopback addresses are refused; and a link-share token
cannot be mistaken for the user whose id matches its share id.

## Differences from the Go server, on purpose

- **Uploads are typed by content, not by the client.** The multipart
  `Content-Type` is attacker-controlled, so `lib/sniff.js` derives the mime from
  magic bytes and anything unidentified becomes `application/octet-stream`,
  which is not previewable. A consequence is that SVG is download-only here,
  where the Go server previewed it through `<img>`.
- **Refresh tokens are an HttpOnly cookie**, rotated on every use, and an access
  token is rejected if presented as one.
- **Reminders are deduped against the notifications table**, not a one-minute
  window. The Go server looks for reminders falling inside the current tick, so
  a missed tick drops that reminder silently; here a late tick still sends.
- **Webhook secrets are generated, never accepted from the client**, and are
  returned exactly once — listing webhooks never discloses them.
- **Deleting a project cascades.** Nothing in the schema has foreign keys, so
  removing only the project row would leave its tasks, board, shares and files
  behind as unreachable rows and orphaned blobs.

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

Serves the API on `/api/v1`, storage on `/api/v2`, CalDAV on `/dav`, the
realtime socket on `/api/v1/ws`, and the built frontend from `../frontend/dist`.

### Optional configuration

| Variable | Default | Effect |
|---|---|---|
| `VIKUNJA_MAILER_ENABLED` | `false` | Turns on outgoing email. Everything still works without it — notifications just stay in-app. |
| `VIKUNJA_MAILER_HOST` / `_PORT` / `_USERNAME` / `_PASSWORD` | — | SMTP relay. Port 465 implies TLS; anything else negotiates STARTTLS. |
| `VIKUNJA_MAILER_FROMEMAIL` | `noreply@localhost` | From address. |
| `VIKUNJA_MAILER_SKIPTLSVERIFY` | `false` | Only for an internal relay with a self-signed certificate — it disables checking the relay is who it claims. |
| `VIKUNJA_WEBHOOKS_TIMEOUTSECONDS` | `30` | How long a webhook target may take to respond. |
| `VIKUNJA_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS` | `false` | Lets webhooks reach private addresses. **With it on, a user-supplied webhook URL can reach anything the server can, including cloud metadata endpoints.** Only enable when receivers are on the same trusted network. |
| `VIKUNJA_SERVICE_ENABLEREGISTRATION` | `false` | Public sign-up. |
