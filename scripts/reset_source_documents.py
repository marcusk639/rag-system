#!/usr/bin/env python3
"""
Reset stale `documents` rows for a source so a re-sync re-embeds them.

Background (Phase 3): early sync runs upserted `documents` rows (recording
`content_hash`) BEFORE embedding failed on a 429. ingestOne short-circuits when
the incoming hash matches the stored one, so those docs are now silently skipped
and never embedded -> chunksCreated=0. Nulling `content_hash` forces a hash
mismatch on the next sync, so every doc re-embeds.

Run with the postgres service env injected, e.g.:
    railway run --service rag-postgres -- .reset-venv/bin/python \
        scripts/reset_source_documents.py --source <uuid>            # dry-run
    railway run --service rag-postgres -- .reset-venv/bin/python \
        scripts/reset_source_documents.py --source <uuid> --apply    # writes

Prints only counts — never the connection string or secrets.
"""

from __future__ import annotations

import argparse
import os
import sys

import psycopg2


def _connect():
    # Prefer a ready-made URL when present.
    for var in ("DATABASE_PUBLIC_URL", "DATABASE_URL"):
        val = os.environ.get(var)
        if val:
            return psycopg2.connect(val)

    # Otherwise build from discrete vars. For off-platform reach we MUST use the
    # public TCP proxy (RAILWAY_TCP_PROXY_*), since PGHOST is the internal name.
    host = os.environ.get("RAILWAY_TCP_PROXY_DOMAIN") or os.environ.get("PGHOST")
    port = os.environ.get("RAILWAY_TCP_PROXY_PORT") or os.environ.get("PGPORT") or "5432"
    user = os.environ.get("PGUSER") or os.environ.get("POSTGRES_USER")
    password = os.environ.get("PGPASSWORD") or os.environ.get("POSTGRES_PASSWORD")
    dbname = os.environ.get("PGDATABASE") or os.environ.get("POSTGRES_DB") or "railway"

    if not (host and user and password):
        present = sorted(
            k for k in os.environ
            if any(t in k for t in ("PG", "POSTGRES", "DATABASE", "RAILWAY_TCP", "RAILWAY_PRIVATE"))
        )
        print(f"ERROR: cannot assemble connection. DB-ish var NAMES present: {present}", file=sys.stderr)
        sys.exit(2)

    return psycopg2.connect(host=host, port=port, user=user, password=password, dbname=dbname)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="source_id (uuid)")
    ap.add_argument("--apply", action="store_true", help="perform the UPDATE (default: dry-run)")
    args = ap.parse_args()

    conn = _connect()
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*), count(content_hash) FROM documents WHERE source_id = %s",
                (args.source,),
            )
            total, with_hash = cur.fetchone()
            cur.execute(
                "SELECT count(*) FROM chunks c "
                "JOIN documents d ON d.id = c.document_id WHERE d.source_id = %s",
                (args.source,),
            )
            (chunk_count,) = cur.fetchone()
            print(
                f"BEFORE: documents={total} with_content_hash={with_hash} chunks={chunk_count}"
            )

            if not args.apply:
                print("dry-run: no changes written (pass --apply to null content_hash)")
                return

            cur.execute(
                "UPDATE documents SET content_hash = NULL WHERE source_id = %s",
                (args.source,),
            )
            updated = cur.rowcount
        conn.commit()
        print(f"APPLIED: content_hash nulled on {updated} document rows")
    except Exception as e:  # noqa: BLE001
        conn.rollback()
        print(f"ERROR (rolled back): {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
