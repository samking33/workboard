# Deploying to Hostinger

FSOC is a fork of [Vikunja](https://vikunja.io) v2.4.0 that adds a **Storage**
view to every project — a tab holding that project's documents, links, images
and videos, with in-browser previews.

It keeps Vikunja's AGPL-3.0 licence. The upstream copyright notices are intact
and the source remains available, as that licence requires.

Everything ships as one static binary with the frontend embedded. There is no
Node or Go runtime needed on the server.

## 1. Build (on your machine)

```bash
TARGET=linux/amd64 ./deploy/build-release.sh
```

A Hostinger VPS is almost always `linux/amd64`. Building natively on a Mac
produces a darwin/arm64 binary that will not execute on the server — set
`TARGET` or you will get `cannot execute binary file`.

Output is in `deploy/dist/`.

## 2. Database

Create a MySQL database and user in hPanel (Databases → MySQL). Both names get
an account-id prefix — use the full prefixed values.

```sql
CREATE DATABASE u123_vikunja CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

`utf8mb4` matters: the default `utf8` is three-byte and will reject emoji in
task titles with an "Incorrect string value" error on insert.

## 3. Upload and configure

```bash
ssh user@server
sudo useradd --system --home /var/www/vikunja --shell /usr/sbin/nologin vikunja
sudo mkdir -p /var/www/vikunja/files /etc/vikunja
```

Copy `deploy/dist/*` to `/var/www/vikunja/`, then:

```bash
sudo cp /var/www/vikunja/vikunja.env.example /etc/vikunja/vikunja.env
sudo nano /etc/vikunja/vikunja.env          # fill in every blank
sudo chown root:vikunja /etc/vikunja/vikunja.env
sudo chmod 640 /etc/vikunja/vikunja.env     # contains the db password
sudo chown -R vikunja:vikunja /var/www/vikunja
sudo chmod +x /var/www/vikunja/vikunja
```

The `VIKUNJA_*` variable names keep the upstream prefix — that is the config
namespace the binary reads, not branding. Nothing in the UI shows it.

Generate the session secret once and paste it into `VIKUNJA_SERVICE_SECRET`:

```bash
openssl rand -hex 32
```

If that value is empty, FSOC generates a random one at every start, which
logs the whole team out on every restart and every deploy.

## 4. Bring the data across (only if you have local data)

Point the binary at the empty MySQL database once so it creates the schema, stop
it, then copy the rows in:

```bash
pip install pymysql
python3 sqlite-to-mysql.py --sqlite ./vikunja.db \
  --host 127.0.0.1 --port 3306 \
  --user u123_vikunja --password '...' --database u123_vikunja
```

Run it with `--dry-run` first — it prints what it would copy without writing.
It empties each target table before inserting, so it is safe to re-run.

Uploaded files are **not** in the database. Copy `files/` across as well, or
attachments and storage items will resolve to missing blobs.

## 5. Run

```bash
sudo cp /var/www/vikunja/vikunja.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vikunja
sudo journalctl -u vikunja -f
```

Then put nginx in front using `nginx.conf.example` and issue a certificate with
certbot. `client_max_body_size` in that file must be at least `files.maxsize`
from the config, otherwise uploads fail at nginx with a 413 before FSOC sees
them.

## 6. Create the accounts

Registration is disabled in `config.prod.yml`, so make accounts yourself:

```bash
sudo -u vikunja /var/www/vikunja/vikunja user create -u lucky -e lucky@yourdomain.com
sudo -u vikunja /var/www/vikunja/vikunja user create -u sam   -e sam@yourdomain.com
```

Leave `enableregistration: false` unless you genuinely want strangers signing up
on your domain.

## 7. Oversight panel (optional)

`admin-panel.py` reads the database directly to show every user, project and
assignment — including private projects the API hides from you.

Do **not** expose it publicly; it can read everything. Reach it over SSH:

```bash
ssh -L 3457:127.0.0.1:3457 user@server
# on the server:
ADMIN_PANEL_PASSWORD='...' python3 admin-panel.py
```

Then open <http://localhost:3457>.

## Who sees which project

Access is per project, not per team. A member sees a project only if it is
shared with them, so the sidebar shows each person their own work and nothing
else. The owner (the account that created the project) always has access.

To change it: open the project → **⋯ → Share** → add or remove a user and pick
their level.

| Level | Can |
|---|---|
| Read only | see the project, its tasks and its storage; download files |
| Read & write | the above, plus add/edit tasks, upload and delete storage items |
| Admin | the above, plus rename, share and delete the project itself |

**Read & write** is the right level for most collaborators. Admin lets someone
delete the whole project, so keep it to people who should be able to do that.

Sharing with a *team* is still available on the same screen and grants everyone
in it the same level at once — useful for a project the whole company should
see. Avoid sharing every project with one all-hands team: that is what makes
everybody see everything.

## Backups

Two things, and they must be taken together or a restore is inconsistent:

```bash
mysqldump -u USER -p DBNAME | gzip > vikunja-$(date +%F).sql.gz
tar czf vikunja-files-$(date +%F).tar.gz -C /var/www/vikunja files
```

## Upgrading

FSOC is a fork of Vikunja, so you cannot swap in an upstream Vikunja release
binary. To take a new
upstream version: rebase this branch onto the new tag, resolve conflicts (they
are confined to the files listed below), rebuild, and redeploy.

Files this fork touches:

| File | Change |
|---|---|
| `pkg/models/project_view.go` | `ProjectViewKindStorage` + default view |
| `pkg/models/storage_item*.go` | new model, permissions, tests |
| `pkg/models/error.go` | storage error types |
| `pkg/models/models.go` | registers `StorageItem` table |
| `pkg/models/project.go` | deletes storage items with the project |
| `pkg/migration/20260729090000.go` | creates `storage_items` |
| `pkg/routes/api/v2/storage_items.go` | the API |
| `pkg/web/files/file.go` | inline preview writer |
| `frontend/src/components/project/views/ProjectStorage.vue` | the view |
| `frontend/src/components/project/views/StoragePreviewModal.vue` | previews |
| `frontend/src/services/storageItem.ts` | client |
| `frontend/src/modelTypes/IStorageItem.ts` | types |
| `frontend/src/helpers/formatFileSize.ts` | helper |
| `frontend/src/views/project/ProjectView.vue` | dispatch |
| `frontend/src/components/input/editor/TipTap.vue` | collapsible formatting toolbar |
| `frontend/src/modelTypes/IProjectView.ts` | view-kind enum |
| `frontend/src/i18n/lang/en.json` | strings |
| branding | logos, titles, manifest, CLI text, mail subjects (see below) |

### Branding

FSOC's name and marks replace Vikunja's throughout the UI, CLI, emails and API
docs. What is deliberately **not** renamed:

- `LICENSE` and the `Copyright 2018-present Vikunja` headers in every source
  file — the AGPL requires these to stay.
- The Go module path `code.vikunja.io/api` and the `VIKUNJA_*` env prefix, both
  internal and invisible to users.
- The "Built on Vikunja" link in the sidebar — upstream credit.
- `pkg/license/` — the licence-check system is untouched.

## Notes on the storage feature

- Uploads sort into Documents / Images / Videos from the server-detected type,
  falling back to the file extension when content sniffing is inconclusive.
- Previews are served from a separate endpoint that only returns images, video,
  audio, PDF and plain text inline. Anything else — notably HTML — returns 415
  and stays download-only, because serving it inline from your own origin would
  let it run as the application.
- Files over 100 MB are download-only: previews are pulled into memory whole so
  the auth header can be applied.
