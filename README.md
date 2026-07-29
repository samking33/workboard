# FSOC

Projects, tasks and **project storage** for the team. Every project keeps its
documents, links, images and videos alongside its work, with previews in the
browser.

FSOC is a fork of [Vikunja](https://vikunja.io) v2.4.0 and is licensed under the
same **AGPL-3.0-or-later**. Upstream copyright notices are intact and the source
stays available, as that licence requires.

## What this fork adds

| | |
|---|---|
| **Storage view** | A tab on every project — Documents / Links / Images / Videos — with drag-and-drop upload, in-browser previews (PDF, image, video, audio, text), rename and delete. It is the first tab, ahead of List. |
| **Access tab** | Per-project membership beside the view tabs, visible only to project admins. |
| **Collapsible editor toolbar** | The rich-text toolbar is hidden behind a small toggle instead of always on. |
| **Dismissible task fields** | Sections opened by mistake in the task sidebar can be closed with a × instead of needing a reload. |
| **FSOC branding** | Marks, titles, emails, CLI and API docs. |

## Layout

```
pkg/                 Go API (models, migrations, /api/v2 routes)
frontend/            Vue 3 client, embedded into the binary at build time
deploy/              Everything needed to run it in production
```

## Build

Requires Go 1.26+, Node 24+ and pnpm 11.x.

`package.json` pins pnpm `11.13.1`. Any 11.x works — `frontend/.npmrc` sets
`pm-on-fail=warn` so a different patch release warns instead of aborting with
*"This project is configured to use 11.13.1 of pnpm"*. If you hit that error
outside the build script, either run the script (it handles this) or use
`pnpm install --frozen-lockfile --pm-on-fail=warn`.

```bash
TARGET=linux/amd64 ./deploy/build-release.sh
```

Produces a single static binary in `deploy/dist/` with the frontend embedded —
no Node or Go runtime needed on the server. Build for `linux/amd64` when
deploying to a Linux host, even from a Mac.

Build the frontend first. `frontend/dist/` is generated, so it is not in the
repo, and a bare `go build` on a fresh clone fails with
`pattern all:dist: no matching files found` — the Go binary embeds that
directory. `build-release.sh` does both steps in the right order.

## Deploy

See **[deploy/README.md](deploy/README.md)** for the full walkthrough: MySQL
setup, environment variables, systemd unit, nginx with TLS, migrating data, and
backups.

The short version:

```bash
TARGET=linux/amd64 ./deploy/build-release.sh   # build
# copy deploy/dist/* to the server
# fill /etc/vikunja/vikunja.env  (db creds + session secret)
sudo systemctl enable --now vikunja
```

## Local development

```bash
cd frontend && pnpm install && pnpm build
cd .. && go build -tags osusergo -o fsoc .
./fsoc                      # needs a config.yml or VIKUNJA_* env vars
```

Config is read from `config.yml` next to the binary, or from `VIKUNJA_*`
environment variables which override it. Secrets belong in the environment,
never in a committed file — `config.yml`, `*.db` and `files/` are gitignored.

## Tests

```bash
mage test:feature                        # Go suite
go test -run TestHumaStorageItem ./pkg/webtests/
cd frontend && pnpm lint && pnpm typecheck
```

## Licence

AGPL-3.0-or-later, inherited from Vikunja. See [LICENSE](LICENSE). If you run a
modified copy as a network service, that licence requires you to offer its
source to users.
