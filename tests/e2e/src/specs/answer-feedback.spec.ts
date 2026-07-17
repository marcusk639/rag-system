import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getFeedbackStats, submitAnswerFeedback } from "@rag/db";
import type { Db } from "@rag/db";
import { openTestDb } from "../helpers/db.js";

/**
 * SDD answer-feedback backend, Task 3: `submitAnswerFeedback` (upsert on
 * `(answer_id, principal_subject)`) and `getFeedbackStats`. Real Postgres —
 * same rationale as `access-grants.spec.ts` / `audit-log-parity.spec.ts`:
 * the property under test is the UNIQUE-index upsert semantics itself (a
 * second vote from the same asker on the same answer overwrites the
 * existing row instead of accumulating a second one) — a DB-free stub can't
 * meaningfully exercise real constraint/`ON CONFLICT` behavior (see
 * `packages/db/src/queries.access-control.test.ts`'s header comment for why
 * `packages/db` unit tests stay DB-free).
 *
 * `answer_feedback` has no FK to `sources`/`documents`, so it falls outside
 * `../helpers/db.js`'s `truncateAll`. This spec truncates it directly in
 * `beforeEach` rather than scoping assertions with `getFeedbackStats`'s
 * `since` option (the brief's illustrative pattern): an earlier version of
 * this file captured `since = new Date()` on the *test-runner's* clock and
 * compared it against `created_at` values written by `now()` on the
 * *Postgres container's* clock. Two `submitAnswerFeedback` calls in quick
 * succession sometimes landed sub-millisecond apart from that `since` mark,
 * and small (sub-millisecond) drift between the two independent clocks was
 * enough to invert the apparent write order and silently drop a row from
 * the stats — reproduced directly: a raw `SELECT` showed both rows present
 * with correct `created_at` values, yet `getFeedbackStats({ since })`
 * excluded one because its timestamp compared earlier than `since` even
 * though it was written after. `answer_feedback` has no other spec-file
 * consumer and the suite runs fully sequentially (`fileParallelism: false`,
 * `singleFork: true`), so truncating per-test is safe and gives exact,
 * clock-independent counts instead.
 */
describe("E2E: submitAnswerFeedback / getFeedbackStats", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    close = handle.close;
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE answer_feedback`);
  });

  afterAll(async () => {
    await close();
  });

  it("inserts a helpful vote and getFeedbackStats counts it", async () => {
    await submitAnswerFeedback(db, {
      answerId: "a1",
      principalSubject: "oid-A",
      rating: "helpful",
      comment: null,
      channel: "web",
    });

    const stats = await getFeedbackStats(db);
    expect(stats.helpful).toBe(1);
    expect(stats.notHelpful).toBe(0);
  });

  it("upserts last-write-wins per (answerId, principalSubject) — one row, not two", async () => {
    await submitAnswerFeedback(db, {
      answerId: "a1",
      principalSubject: "oid-A",
      rating: "helpful",
      comment: null,
      channel: "web",
    });
    await submitAnswerFeedback(db, {
      answerId: "a1",
      principalSubject: "oid-A",
      rating: "not_helpful",
      comment: "wrong",
      channel: "web",
    });

    // Prove exactly one row exists at the SQL level — not just that the
    // aggregate counts happen to net out to the same numbers a two-row
    // scenario could also produce.
    const rowCountRes = await db.execute<{ n: string }>(
      sql`SELECT COUNT(*)::text AS n FROM answer_feedback`,
    );
    expect(Number(rowCountRes.rows[0]?.n ?? "0")).toBe(1);

    const stats = await getFeedbackStats(db);
    expect(stats.helpful).toBe(0);
    expect(stats.notHelpful).toBe(1); // one row, updated — not two
    expect(stats.recentNotHelpful[0]).toMatchObject({
      answerId: "a1",
      comment: "wrong",
    });
  });

  it("upsert is scoped per principalSubject — a different subject on the same answer gets its own row", async () => {
    await submitAnswerFeedback(db, {
      answerId: "a1",
      principalSubject: "oid-A",
      rating: "helpful",
      comment: null,
      channel: "web",
    });
    await submitAnswerFeedback(db, {
      answerId: "a1",
      principalSubject: "oid-B",
      rating: "not_helpful",
      comment: "different user, different vote",
      channel: "web",
    });

    const stats = await getFeedbackStats(db);
    expect(stats.helpful).toBe(1);
    expect(stats.notHelpful).toBe(1);
  });

  it("upsert also collapses repeated null-principalSubject votes on the same answer (NULLS NOT DISTINCT)", async () => {
    await submitAnswerFeedback(db, {
      answerId: "a1",
      principalSubject: null,
      rating: "helpful",
      comment: null,
      channel: "web",
    });
    await submitAnswerFeedback(db, {
      answerId: "a1",
      principalSubject: null,
      rating: "not_helpful",
      comment: "admin changed their mind",
      channel: "web",
    });

    const rowCountRes = await db.execute<{ n: string }>(
      sql`SELECT COUNT(*)::text AS n FROM answer_feedback`,
    );
    expect(Number(rowCountRes.rows[0]?.n ?? "0")).toBe(1);

    const stats = await getFeedbackStats(db);
    expect(stats.helpful).toBe(0);
    expect(stats.notHelpful).toBe(1);
  });

  it("getFeedbackStats `since` excludes votes cast before the given time", async () => {
    await submitAnswerFeedback(db, {
      answerId: "a1",
      principalSubject: "oid-A",
      rating: "helpful",
      comment: null,
      channel: "web",
    });

    // Comfortably in the future relative to the write above — avoids
    // comparing test-runner-clock and Postgres-clock timestamps at
    // sub-millisecond precision (see this file's header comment).
    const future = new Date(Date.now() + 60_000);
    const stats = await getFeedbackStats(db, { since: future });
    expect(stats.helpful).toBe(0);
    expect(stats.notHelpful).toBe(0);
  });
});
