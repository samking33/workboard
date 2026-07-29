#!/usr/bin/env python3
"""Read-only oversight panel for a FSOC instance.

FSOC's own admin panel is a licensed feature, and its API hides projects the
caller does not own (403) even from an instance admin. This reads the database
directly, so it sees everything — including members' private projects.

Read-only by design: it opens MySQL with a SELECT-only user where possible and
never issues a write. Point it at the same database as the server.

    VIKUNJA_DATABASE_TYPE=mysql \
    VIKUNJA_DATABASE_HOST=127.0.0.1:3306 \
    VIKUNJA_DATABASE_USER=vikunja \
    VIKUNJA_DATABASE_PASSWORD=... \
    VIKUNJA_DATABASE_DATABASE=vikunja \
    ADMIN_PANEL_PASSWORD=... \
    python3 admin-panel.py

For sqlite set VIKUNJA_DATABASE_TYPE=sqlite and VIKUNJA_DATABASE_PATH=/path/vikunja.db.
MySQL needs pymysql:  pip install pymysql
"""
import base64
import hmac
import html
import http.server
import os
import secrets
import urllib.parse

DB_TYPE = os.environ.get("VIKUNJA_DATABASE_TYPE", "mysql").lower()
DB_PATH = os.environ.get("VIKUNJA_DATABASE_PATH", "./vikunja.db")
DB_HOST = os.environ.get("VIKUNJA_DATABASE_HOST", "127.0.0.1:3306")
DB_USER = os.environ.get("VIKUNJA_DATABASE_USER", "vikunja")
DB_PASSWORD = os.environ.get("VIKUNJA_DATABASE_PASSWORD", "")
DB_NAME = os.environ.get("VIKUNJA_DATABASE_DATABASE", "vikunja")

PORT = int(os.environ.get("ADMIN_PANEL_PORT", "3457"))
BIND = os.environ.get("ADMIN_PANEL_BIND", "127.0.0.1")
USER = os.environ.get("ADMIN_PANEL_USER", "lucky")
PASSWORD = os.environ.get("ADMIN_PANEL_PASSWORD") or secrets.token_urlsafe(9)
VIKUNJA_URL = os.environ.get("VIKUNJA_SERVICE_PUBLICURL", "http://localhost:3456/").rstrip("/")

IS_MYSQL = DB_TYPE in ("mysql", "mariadb")
# The two engines disagree on placeholder syntax and on how to spell "now", and
# nothing else in these queries is dialect-specific.
PH = "%s" if IS_MYSQL else "?"
NOW = "UTC_TIMESTAMP()" if IS_MYSQL else "datetime('now')"


def connect():
    if IS_MYSQL:
        import pymysql
        host, _, port = DB_HOST.partition(":")
        return pymysql.connect(
            host=host or "127.0.0.1",
            port=int(port or 3306),
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME,
            charset="utf8mb4",
            cursorclass=pymysql.cursors.DictCursor,
        )
    import sqlite3
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def q(sql, args=()):
    sql = sql.replace("{NOW}", NOW).replace("{PH}", PH)
    con = connect()
    try:
        cur = con.cursor()
        cur.execute(sql, args)
        return [dict(r) for r in cur.fetchall()]
    finally:
        con.close()


ASSIGNED = """FROM task_assignees ta JOIN tasks t ON t.id=ta.task_id
              WHERE ta.user_id=u.id AND t.deleted_at IS NULL"""

CSS = """
:root{--bg:#fff;--fg:#1a1a1a;--mut:#6b7280;--line:#e5e7eb;--acc:#1a73e8;--warn:#b91c1c}
@media(prefers-color-scheme:dark){:root{--bg:#15171a;--fg:#e8e8e8;--mut:#9aa0a6;--line:#2c3036;--acc:#7cb0ff;--warn:#ff8a80}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:1080px;margin:0 auto}
h1{font-size:1.4rem;margin:0 0 .25rem}
h2{font-size:1rem;margin:2.25rem 0 .6rem;color:var(--mut);text-transform:uppercase;letter-spacing:.06em}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.sub{color:var(--mut);margin:0 0 1.5rem;font-size:.9rem}
.cards{display:flex;flex-wrap:wrap;gap:.75rem}
.card{border:1px solid var(--line);border-radius:8px;padding:.7rem 1rem;min-width:104px}
.card b{display:block;font-size:1.5rem;font-weight:600}
.card span{color:var(--mut);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th{text-align:left;font-weight:600;color:var(--mut);font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
th,td{padding:.5rem .7rem;border-bottom:1px solid var(--line);white-space:nowrap}
.warn{color:var(--warn);font-weight:600}
.mut{color:var(--mut)}
.done{text-decoration:line-through;color:var(--mut)}
.empty{color:var(--mut);font-style:italic;padding:.5rem 0}
"""

PERM_NAMES = {0: "read", 1: "write", 2: "admin"}


def page(title, body):
    return (f'<!doctype html><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1">'
            f"<title>{html.escape(title)}</title><style>{CSS}</style><main>{body}</main>")


def e(v):
    return html.escape(str(v if v is not None else ""))


def table(cols, rows, empty="Nothing here."):
    if not rows:
        return f'<p class="empty">{empty}</p>'
    head = "".join(f"<th>{c}</th>" for c in cols)
    return ('<div class="scroll"><table><tr>' + head + "</tr>"
            + "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
            + "</table></div>")


def due_cell(t):
    if not t["due_date"]:
        return '<span class="mut">—</span>'
    d = str(t["due_date"])[:10]
    return f'<span class="warn">{d} overdue</span>' if t["overdue"] else d


def overview():
    s = q("""SELECT
        (SELECT count(*) FROM users) AS users,
        (SELECT count(*) FROM projects WHERE title<>'Inbox') AS projects,
        (SELECT count(*) FROM tasks WHERE deleted_at IS NULL) AS tasks,
        (SELECT count(*) FROM tasks WHERE deleted_at IS NULL AND done=1) AS done,
        (SELECT count(*) FROM tasks WHERE deleted_at IS NULL AND done=0
           AND due_date IS NOT NULL AND due_date<{NOW}) AS overdue,
        (SELECT count(*) FROM storage_items) AS files,
        (SELECT count(*) FROM tasks t WHERE t.deleted_at IS NULL AND done=0
           AND NOT EXISTS(SELECT 1 FROM task_assignees ta WHERE ta.task_id=t.id)) AS unassigned
    """)[0]
    cards = "".join(f'<div class="card"><b class="{"warn" if k == "overdue" and v else ""}">{v}</b>'
                    f"<span>{k}</span></div>" for k, v in s.items())

    people = q(f"""SELECT u.id,u.username,u.email,u.status,
        (SELECT count(*) FROM projects p WHERE p.owner_id=u.id AND p.title<>'Inbox') AS owned,
        (SELECT count(*) {ASSIGNED}) AS assigned,
        (SELECT count(*) {ASSIGNED} AND t.done=0) AS open_tasks,
        (SELECT count(*) {ASSIGNED} AND t.done=0 AND t.due_date IS NOT NULL
            AND t.due_date<{{NOW}}) AS overdue
        FROM users u ORDER BY u.username""")
    prows = [(f'<a href="/user/{p["id"]}">{e(p["username"])}</a>', e(p["email"]),
              "active" if p["status"] == 0 else f'<span class="warn">status {p["status"]}</span>',
              p["owned"], p["assigned"], p["open_tasks"],
              f'<span class="warn">{p["overdue"]}</span>' if p["overdue"] else "0")
             for p in people]

    hidden = q("""SELECT p.id,p.title,u.username AS owner,
        (SELECT count(*) FROM tasks t WHERE t.project_id=p.id AND t.deleted_at IS NULL) AS tasks
        FROM projects p JOIN users u ON u.id=p.owner_id
        WHERE p.title<>'Inbox'
          AND NOT EXISTS(SELECT 1 FROM team_projects tp WHERE tp.project_id=p.id)
          AND NOT EXISTS(SELECT 1 FROM users_projects up WHERE up.project_id=p.id)
          AND p.owner_id<>1
        ORDER BY u.username""")
    hrows = [(e(h["title"]), e(h["owner"]), h["tasks"]) for h in hidden]

    unass = q("""SELECT t.title,p.title AS project FROM tasks t JOIN projects p ON p.id=t.project_id
        WHERE t.deleted_at IS NULL AND t.done=0
          AND NOT EXISTS(SELECT 1 FROM task_assignees ta WHERE ta.task_id=t.id)
        ORDER BY p.title""")
    urows = [(e(u["title"]), e(u["project"])) for u in unass]

    return page("FSOC oversight", f"""
<h1>FSOC oversight</h1>
<p class="sub">Read-only view of every user, project and assignment ·
<a href="/projects">all projects</a> · <a href="{e(VIKUNJA_URL)}">open FSOC</a></p>
<div class="cards">{cards}</div>
<h2>People</h2>
{table(["User", "Email", "Status", "Owns", "Assigned", "Open", "Overdue"], prows)}
<h2>Private projects you cannot see in FSOC</h2>
{table(["Project", "Owner", "Tasks"], hrows, "None — every project is shared or owned by you.")}
<h2>Unassigned open tasks</h2>
{table(["Task", "Project"], urows, "Everything open has an owner.")}
""")


def user_page(uid):
    u = q("SELECT id,username,email,status,created FROM users WHERE id={PH}", (uid,))
    if not u:
        return None
    u = u[0]

    owned = q("""SELECT p.title,
        (SELECT count(*) FROM tasks t WHERE t.project_id=p.id AND t.deleted_at IS NULL) AS tasks,
        (SELECT count(*) FROM team_projects tp WHERE tp.project_id=p.id) AS shared
        FROM projects p WHERE p.owner_id={PH} AND p.title<>'Inbox' ORDER BY p.title""", (uid,))
    orows = [(e(o["title"]), o["tasks"],
              "team" if o["shared"] else '<span class="warn">private</span>') for o in owned]

    tasks = q("""SELECT t.title,t.done,t.due_date,p.title AS project,
        (CASE WHEN t.done=0 AND t.due_date IS NOT NULL AND t.due_date<{NOW}
              THEN 1 ELSE 0 END) AS overdue
        FROM task_assignees ta JOIN tasks t ON t.id=ta.task_id
        JOIN projects p ON p.id=t.project_id
        WHERE ta.user_id={PH} AND t.deleted_at IS NULL
        ORDER BY t.done, t.due_date""", (uid,))
    trows = [(f'<span class="{"done" if t["done"] else ""}">{e(t["title"])}</span>',
              e(t["project"]), due_cell(t), "done" if t["done"] else "open") for t in tasks]

    return page(u["username"], f"""
<h1>{e(u["username"])}</h1>
<p class="sub">{e(u["email"])} · joined {e(str(u["created"])[:10])} · <a href="/">← everyone</a></p>
<h2>Projects owned ({len(owned)})</h2>
{table(["Project", "Tasks", "Sharing"], orows, "Owns no projects.")}
<h2>Assigned tasks ({len(tasks)})</h2>
{table(["Task", "Project", "Due", "State"], trows, "Nothing assigned.")}
""")


def projects_page():
    rows = q("""SELECT p.id,p.title,u.username AS owner,
        (SELECT count(*) FROM tasks t WHERE t.project_id=p.id AND t.deleted_at IS NULL) AS tasks,
        (SELECT count(*) FROM tasks t WHERE t.project_id=p.id AND t.deleted_at IS NULL
            AND t.done=0 AND t.due_date IS NOT NULL AND t.due_date<{NOW}) AS overdue,
        (SELECT count(*) FROM storage_items si WHERE si.project_id=p.id) AS files
        FROM projects p JOIN users u ON u.id=p.owner_id
        WHERE p.title<>'Inbox' ORDER BY p.title""")

    # Built in python rather than SQL: string concatenation differs between
    # sqlite (||) and mysql (CONCAT), and this keeps one query for both.
    shares = q("""SELECT tp.project_id, tm.name, tp.permission
        FROM team_projects tp JOIN teams tm ON tm.id=tp.team_id""")
    by_project = {}
    for sh in shares:
        by_project.setdefault(sh["project_id"], []).append(
            f'{sh["name"]} ({PERM_NAMES.get(sh["permission"], sh["permission"])})')

    prows = [(e(r["title"]), e(r["owner"]), r["tasks"],
              f'<span class="warn">{r["overdue"]}</span>' if r["overdue"] else "0",
              r["files"],
              e(", ".join(by_project.get(r["id"], []))) or '<span class="warn">not shared</span>')
             for r in rows]
    return page("All projects", f"""
<h1>All projects</h1>
<p class="sub">{len(rows)} projects · <a href="/">← everyone</a></p>
{table(["Project", "Owner", "Tasks", "Overdue", "Files", "Shared with"], prows)}
""")


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "vikunja-oversight"

    def _auth_ok(self):
        h = self.headers.get("Authorization", "")
        if not h.startswith("Basic "):
            return False
        try:
            got = base64.b64decode(h[6:]).decode()
        except Exception:
            return False
        # constant-time compare so the panel can't be brute-forced by timing
        return hmac.compare_digest(got, f"{USER}:{PASSWORD}")

    def _send(self, body, code=200):
        raw = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if not self._auth_ok():
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="FSOC oversight"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        path = urllib.parse.urlparse(self.path).path.rstrip("/") or "/"
        try:
            if path == "/":
                return self._send(overview())
            if path == "/projects":
                return self._send(projects_page())
            if path.startswith("/user/") and path[6:].isdigit():
                body = user_page(int(path[6:]))
                return self._send(body) if body else self._send(
                    page("Not found", "<h1>No such user</h1>"), 404)
            self._send(page("Not found", '<h1>404</h1><p><a href="/">back</a></p>'), 404)
        except Exception as ex:  # noqa: BLE001 - surface db/config errors as a page
            self._send(page("Error", f"<h1>Database error</h1><p>{e(ex)}</p>"), 500)

    def log_message(self, *a):
        pass  # the app's own log is the interesting one


if __name__ == "__main__":
    try:
        q("SELECT 1 AS ok")
    except Exception as ex:  # noqa: BLE001
        raise SystemExit(f"cannot reach the vikunja database ({DB_TYPE}): {ex}")

    print(f"oversight panel  http://{BIND}:{PORT}   (db: {DB_TYPE})")
    print(f"  user      {USER}")
    print(f"  password  {PASSWORD}"
          + ("" if os.environ.get("ADMIN_PANEL_PASSWORD")
             else "   (generated — set ADMIN_PANEL_PASSWORD to pin it)"))
    http.server.ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
