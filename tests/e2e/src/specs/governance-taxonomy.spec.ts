import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertDocument } from "@rag/db";
import type { Db } from "@rag/db";
import { createCustomSource, openTestDb, truncateAll } from "../helpers/db.js";

/**
 * Phase 2 (docs/PLAN-KB-GOVERNANCE-AND-USAGE-ANALYTICS.md): librarian-facing
 * content-type/governance taxonomy on `documents`.
 *
 * Verified against a real, migrated Postgres (globalSetup runs
 * `packages/db/src/migrate.ts` before this file executes) rather than a unit
 * test, because `packages/db/src` tests in this repo are deliberately
 * DB-free stubs (see `queries.access-control.test.ts`'s own comment: SQL
 * enforcement itself needs Postgres and "is verified by reading +
 * typecheck"). The most important thing this phase depends on — that
 * `upsertDocument`'s ON CONFLICT DO UPDATE SET clause leaves the new
 * governance columns untouched on re-sync — is only genuinely provable
 * against a live ON CONFLICT execution, which is exactly what this spec
 * exercises (mirrors `idempotency.spec.ts`'s "re-ingest unchanged content"
 * shape).
 */
describe("E2E: document governance taxonomy (Phase 2)", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    close = handle.close;
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  it("documents has content_type, owner_id, lifecycle_status with the expected types/defaults", async () => {
    const res = await db.execute<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'documents'
        AND column_name IN ('content_type', 'owner_id', 'lifecycle_status')
    `);

    const byName = new Map(res.rows.map((r) => [r.column_name, r]));

    const contentType = byName.get("content_type");
    expect(contentType?.data_type).toBe("USER-DEFINED"); // enum
    expect(contentType?.is_nullable).toBe("YES");
    expect(contentType?.column_default).toBeNull();

    const ownerId = byName.get("owner_id");
    expect(ownerId?.data_type).toBe("text");
    expect(ownerId?.is_nullable).toBe("YES");
    expect(ownerId?.column_default).toBeNull();

    const lifecycleStatus = byName.get("lifecycle_status");
    expect(lifecycleStatus?.data_type).toBe("text");
    expect(lifecycleStatus?.is_nullable).toBe("NO");
    expect(lifecycleStatus?.column_default).toBe("'active'::text");
  });

  it("content_type enum accepts exactly the five taxonomy values", async () => {
    const res = await db.execute<{ enumlabel: string }>(sql`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'content_type'
      ORDER BY e.enumsortorder
    `);
    expect(res.rows.map((r) => r.enumlabel)).toEqual([
      "sop",
      "template",
      "research_note",
      "example",
      "general",
    ]);
  });

  it("a freshly-inserted document defaults to lifecycleStatus='active' and null contentType/ownerId", async () => {
    const sourceId = await createCustomSource(db, "governance-defaults");
    const { id: documentId } = await upsertDocument(db, {
      sourceId,
      externalId: "doc-1",
      title: "Doc 1",
      mimeType: "text/plain",
      contentHash: "hash-v1",
      metadata: {},
      markdown: "# Doc 1\n\nOriginal content.",
    });

    const [row] = await db
      .execute<{
        content_type: string | null;
        owner_id: string | null;
        lifecycle_status: string;
      }>(
        sql`
      SELECT content_type, owner_id, lifecycle_status
      FROM documents WHERE id = ${documentId}
    `,
      )
      .then((r) => r.rows);

    expect(row?.content_type).toBeNull();
    expect(row?.owner_id).toBeNull();
    expect(row?.lifecycle_status).toBe("active");
  });

  it("re-syncing a document with UNCHANGED content never clobbers a human-set governance tag (the core anti-clobbering guarantee)", async () => {
    const sourceId = await createCustomSource(db, "governance-resync");

    // Step 1: first ingest (upsertDocument insert path).
    const first = await upsertDocument(db, {
      sourceId,
      externalId: "doc-resync",
      title: "Resync Doc",
      mimeType: "text/plain",
      contentHash: "stable-hash",
      metadata: {},
      markdown: "# Resync Doc\n\nUnchanged body.",
    });
    expect(first.contentChanged).toBe(true);

    // Step 2: a librarian manually classifies the document — direct SQL,
    // simulating the only write path this phase ships (no PATCH route yet).
    await db.execute(sql`
      UPDATE documents
      SET content_type = 'sop', owner_id = 'librarian-alice', lifecycle_status = 'draft'
      WHERE id = ${first.id}
    `);

    // Step 3: re-sync with IDENTICAL content (same contentHash) — the
    // unchanged-file path a real source re-sync takes.
    const second = await upsertDocument(db, {
      sourceId,
      externalId: "doc-resync",
      title: "Resync Doc",
      mimeType: "text/plain",
      contentHash: "stable-hash",
      metadata: {},
      markdown: "# Resync Doc\n\nUnchanged body.",
    });
    expect(second.id).toBe(first.id);
    expect(second.contentChanged).toBe(false);

    // Step 4: the governance columns MUST be exactly as the librarian left
    // them — proving upsertDocument's INSERT/SET column list still omits
    // content_type/owner_id/lifecycle_status.
    const [after] = await db
      .execute<{
        content_type: string | null;
        owner_id: string | null;
        lifecycle_status: string;
      }>(
        sql`
        SELECT content_type, owner_id, lifecycle_status
        FROM documents WHERE id = ${first.id}
      `,
      )
      .then((r) => r.rows);

    expect(after?.content_type).toBe("sop");
    expect(after?.owner_id).toBe("librarian-alice");
    expect(after?.lifecycle_status).toBe("draft");
  });

  it("re-syncing a document with CHANGED content still preserves the governance tag", async () => {
    // Governance tags describe the document's role/ownership/lifecycle, not
    // its content revision — a content update must not reset them either.
    const sourceId = await createCustomSource(db, "governance-resync-changed");

    const first = await upsertDocument(db, {
      sourceId,
      externalId: "doc-evolving",
      title: "Evolving Doc",
      mimeType: "text/plain",
      contentHash: "hash-v1",
      metadata: {},
      markdown: "# Evolving Doc\n\nVersion one.",
    });

    await db.execute(sql`
      UPDATE documents
      SET content_type = 'template', owner_id = 'librarian-bob', lifecycle_status = 'archived'
      WHERE id = ${first.id}
    `);

    const second = await upsertDocument(db, {
      sourceId,
      externalId: "doc-evolving",
      title: "Evolving Doc",
      mimeType: "text/plain",
      contentHash: "hash-v2",
      metadata: {},
      markdown: "# Evolving Doc\n\nVersion two — content actually changed.",
    });
    expect(second.contentChanged).toBe(true);

    const [after] = await db
      .execute<{
        content_type: string | null;
        owner_id: string | null;
        lifecycle_status: string;
      }>(
        sql`
        SELECT content_type, owner_id, lifecycle_status
        FROM documents WHERE id = ${first.id}
      `,
      )
      .then((r) => r.rows);

    expect(after?.content_type).toBe("template");
    expect(after?.owner_id).toBe("librarian-bob");
    expect(after?.lifecycle_status).toBe("archived");
  });
});
