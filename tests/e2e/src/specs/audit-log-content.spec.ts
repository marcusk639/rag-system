import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, getAuditLogRowsSince, logAskEvent } from "@rag/db";
import { eq } from "drizzle-orm";
import { resolveAuditContent } from "@rag/core";
import { openTestDb, truncateAll } from "../helpers/db.js";
import type { Db } from "@rag/db";

/**
 * AUDIT_LOG_CONTENT governs what `audit_log` RETAINS. It must never govern
 * what leaves the database.
 *
 * `handleShipAuditLog` POSTs whatever `getAuditLogRowsSince` returns to
 * `AUDIT_SINK_WEBHOOK_URL` — a third party, and the runbook suggests a
 * free-tier log aggregator. Retaining a staff question internally and
 * disclosing it to an outside collector are separate decisions, and only the
 * second is the one §7216 governs. A `select()` over the row would have
 * conflated them silently the moment the content columns existed, with no
 * failing test and no visible symptom.
 */
describe("E2E: audit_log content never reaches the off-host shipper", () => {
  let db: Db;
  let close: () => Promise<void>;

  const QUESTION = "Does acme-dental qualify for the Schedule F election?";
  const ANSWER = "Per the intake SOP [1], acme-dental's filing status means...";

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    close = handle.close;
  });

  afterAll(async () => {
    await close();
  });

  // Scoped by a unique answerId rather than by truncation: truncateAll does
  // not clear audit_log, and rows from other specs share this database.
  let answerId: string;

  beforeEach(async () => {
    await truncateAll(db);
    answerId = `audit-content-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  });

  const ourRow = async () =>
    (
      await db.select().from(auditLog).where(eq(auditLog.answerId, answerId))
    )[0];

  const writeRow = async (policy: "none" | "full") =>
    logAskEvent(db, {
      principalKind: "scoped",
      principalSources: ["s1"],
      principalSubject: "oid-123",
      questionHash: "deadbeef",
      channel: "api",
      model: "gemini-2.5-flash",
      embeddingProvider: "gemini",
      embeddingModel: "gemini-embedding-001",
      sourceIds: ["s1"],
      chunkIds: ["c1"],
      docIds: ["d1"],
      retrievedCount: 1,
      endpoint: "ask",
      topScore: 0.9,
      answerId,
      ...resolveAuditContent(policy, QUESTION, ANSWER),
    });

  it("retains nothing under the default policy", async () => {
    await writeRow("none");
    const row = await ourRow();
    expect(row?.questionText).toBeNull();
    expect(row?.answerText).toBeNull();
    // The hash is still written — that a question was asked stays on record.
    expect(row?.questionHash).toBe("deadbeef");
  });

  it("retains both when the firm has opted in", async () => {
    await writeRow("full");
    const row = await ourRow();
    expect(row?.questionText).toBe(QUESTION);
    expect(row?.answerText).toBe(ANSWER);
  });

  it("excludes retained content from what the shipper sends", async () => {
    const since = new Date();
    await new Promise((r) => setTimeout(r, 5));
    await writeRow("full");
    const shipped = (await getAuditLogRowsSince(db, since)).filter(
      (r) => r.answerId === answerId,
    );
    expect(shipped).toHaveLength(1);

    // Serialized, because that is what actually crosses the wire.
    const wire = JSON.stringify(shipped);
    expect(wire).not.toContain(QUESTION);
    expect(wire).not.toContain(ANSWER);
    expect(wire).not.toContain("acme-dental");
    expect(Object.keys(shipped[0]!)).not.toContain("questionText");
    expect(Object.keys(shipped[0]!)).not.toContain("answerText");

    // ...while still shipping the fields the audit trail exists for, so this
    // cannot pass by shipping nothing at all.
    expect(shipped[0]!.questionHash).toBe("deadbeef");
    expect(shipped[0]!.principalSubject).toBe("oid-123");
    expect(shipped[0]!.chunkIds).toEqual(["c1"]);
  });
});
