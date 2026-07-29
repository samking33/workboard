#!/usr/bin/env python3
"""Copy a FSOC SQLite database into an already-migrated MySQL/MariaDB one.

FSOC has no built-in cross-engine move: point the server at the empty MySQL
database first so it creates the schema, stop it, then run this.

    python3 sqlite-to-mysql.py --sqlite ./vikunja.db \
        --host 127.0.0.1 --port 3306 --user vikunja --password ... --database vikunja

Safe to re-run: every table it copies is emptied first, inside one transaction.
"""
import argparse
import sqlite3
import sys

try:
    import pymysql
except ImportError:
    sys.exit("pymysql is required: pip install pymysql")

# Owned by the migration runner on the target side — copying these would make
# the target think it still has to run migrations it already ran.
SKIP_TABLES = {"migration", "migration_status"}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sqlite", required=True)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=3306)
    p.add_argument("--user", required=True)
    p.add_argument("--password", required=True)
    p.add_argument("--database", required=True)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    lite = sqlite3.connect(f"file:{args.sqlite}?mode=ro", uri=True)
    lite.row_factory = sqlite3.Row

    my = pymysql.connect(host=args.host, port=args.port, user=args.user,
                         password=args.password, database=args.database,
                         charset="utf8mb4", autocommit=False)
    cur = my.cursor()

    cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema=%s",
                (args.database,))
    target_tables = {r[0].lower() for r in cur.fetchall()}

    source_tables = [r[0] for r in lite.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]

    copied, skipped, total_rows = [], [], 0
    # FK order is unknown and irrelevant once checks are off; re-enabled below.
    cur.execute("SET FOREIGN_KEY_CHECKS=0")

    for table in sorted(source_tables):
        if table.lower() in SKIP_TABLES:
            skipped.append(f"{table} (owned by target)")
            continue
        if table.lower() not in target_tables:
            skipped.append(f"{table} (absent in target)")
            continue

        rows = [dict(r) for r in lite.execute(f'SELECT * FROM "{table}"')]
        if not rows:
            continue

        cur.execute("SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema=%s AND table_name=%s", (args.database, table))
        target_cols = {r[0].lower() for r in cur.fetchall()}
        cols = [c for c in rows[0] if c.lower() in target_cols]
        dropped = [c for c in rows[0] if c.lower() not in target_cols]
        if dropped:
            skipped.append(f"{table}.{{{','.join(dropped)}}} (column absent in target)")

        if args.dry_run:
            copied.append(f"{table}: would copy {len(rows)}")
            total_rows += len(rows)
            continue

        cur.execute(f"DELETE FROM `{table}`")
        placeholders = ",".join(["%s"] * len(cols))
        collist = ",".join(f"`{c}`" for c in cols)
        cur.executemany(
            f"INSERT INTO `{table}` ({collist}) VALUES ({placeholders})",
            [tuple(r[c] for c in cols) for r in rows],
        )
        copied.append(f"{table}: {len(rows)}")
        total_rows += len(rows)

    cur.execute("SET FOREIGN_KEY_CHECKS=1")
    if args.dry_run:
        my.rollback()
    else:
        my.commit()

    print("copied:")
    for line in copied:
        print("  " + line)
    if skipped:
        print("skipped:")
        for line in skipped:
            print("  " + line)
    print(f"{'would copy' if args.dry_run else 'copied'} {total_rows} rows "
          f"across {len(copied)} tables")

    lite.close()
    my.close()


if __name__ == "__main__":
    main()
