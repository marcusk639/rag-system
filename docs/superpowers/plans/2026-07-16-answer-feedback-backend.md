# Answer Identity + Feedback Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every answer a stable `answerId` (surfaced on the HTTP JSON, SSE, and MCP transports) and add a Helpful/Not-Helpful feedback write path (`answer_feedback` table + service + `POST /feedback`), so staff feedback can attach to a specific answer.

**Architecture:** `answerId` (a uuid) is minted inside the transport-agnostic ask service and returned on `AskResult` and the SSE `done` event; the API/MCP transports pass it through, and the route's audit call records it on `audit_log`. Feedback follows the repo's service→route pattern: a new `answer_feedback` table (plain `answer_id` column, **no FK** to the best-effort audit row), a `submitAnswerFeedback` upsert, and a thin `POST /feedback` Fastify route. This is Phase 1 of `docs/superpowers/plans/2026-07-16-e2e-autopilot-and-feedback.md`.

**Tech Stack:** TypeScript, Drizzle/Postgres (pg16, `uuid-ossp`), Fastify + `fastify-type-provider-zod`, vitest, `@modelcontextprotocol` (MCP).

## Global Constraints

- All DB access via `@rag/db` typed queries; never import `pg`/`drizzle-orm` in routes/services.
- **Hand-author the migration** — do NOT run `drizzle-kit generate` (it emits `DROP INDEX` for the HNSW/tsvector indexes owned by `0000_init.sql`; schema.ts:228-247 warning).
- Migration numbering: current highest is `0017`; next is `0018` with journal `idx: 17`, `when` strictly greater than every existing entry, `uuid_generate_v4()` for PK defaults (NOT `gen_random_uuid()`).
- `answer_feedback.answer_id` is a **plain text column, NOT a foreign key** to `audit_log` (audit writes are fire-and-forget and may be absent).
- **`principal_subject` on feedback is derived server-side from the authenticated principal, never from the client body.**
- `answerId` additions are **purely additive** (consumers ignore unknown fields) — do not remove/rename existing `AskResult`/`done`/`structuredContent` fields.
- Commit format `<type>: <description>`, no attribution footers. Pre-commit hook (prettier + secret scan + 800-line guard) runs on every commit — never `--no-verify`. PostToolUse prettier may reformat — expected. Use `npx -y pnpm@9.12.0 <args>` if bare `pnpm` is missing.
- Comment field: cap 1000 chars; firm-internal ops signal only — never sent to any external model.

---

### Task 1: Mint `answerId` in the ask service (both `AskResult` and the SSE `done` event)

**Files:**

- Modify: `packages/services/src/ask.ts` (`AskResult` :60; `ask()` returns :130-137 and :140-147; `AskStreamEvent` done variant :157-163; `askStream()` done yields :205-214 and :228-235)
- Test: `packages/services/src/ask.test.ts` (extend; read it first for the `buildTestDeps`/fake-generator harness)

**Interfaces:**

- Produces: `AskResult.answerId: string` and the `AskStreamEvent` `{type:"done", answerId: string, ...}` — a fresh uuid per answered call (including the empty-retrieval short-circuit). Consumed by Tasks 4 (transports/audit) and downstream UI.

- [ ] **Step 1: Write the failing tests**

  In `packages/services/src/ask.test.ts` (match the file's existing deps/fakes; read it first):

  ```typescript
  it("askQuestion returns a non-empty answerId (uuid) on a normal answer", async () => {
    const result = await askQuestion(deps, { question: "q" }, 5, ADMIN_SCOPE);
    expect(result.answerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("askQuestion returns an answerId even on the empty-retrieval short-circuit", async () => {
    // deps whose retriever returns [] (use the file's empty-retriever fixture)
    const result = await askQuestion(
      emptyDeps,
      { question: "q" },
      5,
      ADMIN_SCOPE,
    );
    expect(result.answer).toContain("do not contain enough information");
    expect(result.answerId).toBeTruthy();
  });

  it("askQuestionStream's done event carries an answerId", async () => {
    const events = [];
    for await (const e of askQuestionStream(
      deps,
      { question: "q" },
      5,
      ADMIN_SCOPE,
    ))
      events.push(e);
    const done = events.find((e) => e.type === "done");
    expect(done?.answerId).toBeTruthy();
  });
  ```

  Use the existing test's names for `deps`, `emptyDeps`/empty-retriever, and `ADMIN_SCOPE` (read the file — do not invent).

- [ ] **Step 2: Run to confirm RED**

  ```bash
  pnpm --filter @rag/services test -- ask
  ```

  Expected: FAIL — `answerId` does not exist on `AskResult`/the done event (type error or undefined).

- [ ] **Step 3: Add `answerId` to the types + generate it**

  In `packages/services/src/ask.ts`:
  - Add the import at the top: `import { randomUUID } from "node:crypto";`
  - Add to `AskResult` (after `disclaimer`): `answerId: string;` with a doc line `/** Stable id for this answer; feedback references it. */`
  - Add the same field to the `AskStreamEvent` `{ type: "done"; ... }` variant.
  - In `ask()` (the private function), at the top: `const answerId = randomUUID();`, and add `answerId` to BOTH returned objects (the empty-retrieval one and the generated one).
  - In `askStream()`, at the top: `const answerId = randomUUID();`, and add `answerId` to BOTH `yield { type: "done", ... }` payloads.

- [ ] **Step 4: Run to confirm GREEN**

  ```bash
  pnpm --filter @rag/services test -- ask
  pnpm --filter @rag/services typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add packages/services/src/ask.ts packages/services/src/ask.test.ts
  git commit -m "feat(services): mint a stable answerId on AskResult and the ask stream done event"
  ```

---

### Task 2: Migration 0018 — `audit_log.answer_id` column + `answer_feedback` table

**Files:**

- Create: `packages/db/drizzle/0018_answer_feedback.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/src/schema.ts` (add `answerId` to `auditLog` ~:344; add the new `answerFeedback` table + its `$inferSelect`/`$inferInsert` types after it)
- Modify: `packages/db/src/index.ts` (export the new table/types if the barrel re-exports schema symbols — confirm)
- Test: `packages/db/src/migration-guard.test.ts` already asserts journal monotonicity; a fresh-DB apply is the real check (Step 5)

**Interfaces:**

- Produces: `audit_log.answer_id text` (nullable); `answer_feedback` table `{ id, answer_id, principal_subject, rating, comment, channel, created_at }` with a unique index on `(answer_id, principal_subject)` `NULLS NOT DISTINCT`; Drizzle `answerFeedback`, `AnswerFeedback`, `NewAnswerFeedback` types. Consumed by Task 3.

- [ ] **Step 1: Confirm the current highest migration + journal tip**

  ```bash
  ls packages/db/drizzle/*.sql | sort -V | tail -2
  tail -12 packages/db/drizzle/meta/_journal.json
  ```

  Expected: highest is `0017_add_audit_log_provider_disclosure.sql`; last journal entry `idx: 16`. If higher, adjust the new numbers accordingly (0019/idx:18, etc.) before proceeding.

- [ ] **Step 2: Hand-author the migration SQL**

  Create `packages/db/drizzle/0018_answer_feedback.sql` (pg16; `NULLS NOT DISTINCT` makes anonymous re-votes dedupe too):

  ```sql
  ALTER TABLE "audit_log" ADD COLUMN "answer_id" text;
  --> statement-breakpoint
  CREATE TABLE "answer_feedback" (
      "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
      "answer_id" text NOT NULL,
      "principal_subject" text,
      "rating" text NOT NULL,
      "comment" text,
      "channel" text NOT NULL,
      "created_at" timestamptz DEFAULT now() NOT NULL
  );
  --> statement-breakpoint
  CREATE UNIQUE INDEX "afb_answer_subject_unique"
      ON "answer_feedback" ("answer_id", "principal_subject") NULLS NOT DISTINCT;
  --> statement-breakpoint
  CREATE INDEX "afb_answer_idx" ON "answer_feedback" ("answer_id");
  ```

- [ ] **Step 3: Add the journal entry**

  Append to the `entries` array in `packages/db/drizzle/meta/_journal.json` (use a `when` strictly greater than the current max — follow the file's existing spacing, e.g. `1795000000000`):

  ```json
  {
    "idx": 17,
    "version": "7",
    "when": 1795000000000,
    "tag": "0018_answer_feedback",
    "breakpoints": true
  }
  ```

- [ ] **Step 4: Add the Drizzle schema**

  In `packages/db/src/schema.ts`:
  - Inside `auditLog`'s column object, add: `answerId: text("answer_id"),` with a doc line `/** The answer this row is for; links feedback to answer context. Nullable — pre-0018 rows have none. */`
  - After the `auditLog` table + its exported types, add:

    ```typescript
    // --------------------------------------------------------------------------
    // answer_feedback — one Helpful/Not-Helpful vote per (answer, user). Plain
    // answer_id column (NOT a FK to audit_log — that write is best-effort and may
    // be absent). Upsert on (answer_id, principal_subject) = last vote wins.
    // --------------------------------------------------------------------------
    export const answerFeedback = pgTable(
      "answer_feedback",
      {
        id: uuid("id")
          .primaryKey()
          .default(sql`uuid_generate_v4()`),
        answerId: text("answer_id").notNull(),
        /** Asker's AAD oid, derived server-side from the principal; null for admin. */
        principalSubject: text("principal_subject"),
        /** "helpful" | "not_helpful" */
        rating: text("rating").notNull(),
        /** Optional firm-internal note; never sent to any external model. */
        comment: text("comment"),
        /** "web" | "teams" */
        channel: text("channel").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true })
          .notNull()
          .defaultNow(),
      },
      (table) => ({
        answerSubjectUnique: uniqueIndex("afb_answer_subject_unique").on(
          table.answerId,
          table.principalSubject,
        ),
        answerIdx: index("afb_answer_idx").on(table.answerId),
      }),
    );

    export type AnswerFeedback = typeof answerFeedback.$inferSelect;
    export type NewAnswerFeedback = typeof answerFeedback.$inferInsert;
    ```

  Confirm `uniqueIndex`, `index`, `text`, `timestamp`, `uuid`, `sql` are already imported at the top of `schema.ts` (they are used by existing tables — add any that isn't). Note: Drizzle's `uniqueIndex` does not emit `NULLS NOT DISTINCT`; the hand-authored SQL (Step 2) is the source of truth for that clause, and this schema declaration exists for typing + `assertRequiredIndexes` parity, not to regenerate the migration.

- [ ] **Step 5: Apply from a fresh DB and confirm the full 0000→0018 chain**

  ```bash
  pnpm docker:down && pnpm docker:up
  pnpm --filter @rag/db migrate
  pnpm --filter @rag/db test -- migration-guard
  ```

  Expected: migrate exits 0 (all 18 migrations apply clean); migration-guard passes (monotonic journal). Then confirm the table exists:

  ```bash
  docker exec rag-postgres psql -U rag -d rag -c "\d answer_feedback"
  ```

  Expected: the table + the two indexes are listed, `afb_answer_subject_unique` UNIQUE.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/db/drizzle/0018_answer_feedback.sql packages/db/drizzle/meta/_journal.json packages/db/src/schema.ts packages/db/src/index.ts
  git commit -m "feat(db): add audit_log.answer_id and the answer_feedback table (migration 0018)"
  ```

---

### Task 3: DB queries — `logAskEvent` answerId, `submitAnswerFeedback` (upsert), `getFeedbackStats`

**Files:**

- Modify: `packages/db/src/queries.ts` (`AskEventRow` :756; `logAskEvent` :791; add the two new functions after it)
- Modify: `packages/db/src/index.ts` (export the new functions if the barrel lists query exports — confirm)
- Test: `packages/db/src/queries.test.ts` OR a new `packages/db/src/answer-feedback.test.ts` (check the existing test style — most `@rag/db` query tests run against real Postgres via the e2e/test-db harness; follow whichever the repo uses for `logAskEvent`/grant tests)

**Interfaces:**

- Consumes: `answerFeedback`/`NewAnswerFeedback`, `auditLog`/`NewAuditLog` (Task 2), `Db`, `sql` (existing).
- Produces:
  - `AskEventRow.answerId: string` + `logAskEvent` writes it.
  - `submitAnswerFeedback(db: Db, row: { answerId: string; principalSubject: string | null; rating: "helpful" | "not_helpful"; comment: string | null; channel: "web" | "teams" }): Promise<void>` — upsert on `(answer_id, principal_subject)`.
  - `getFeedbackStats(db: Db, opts?: { since?: Date }): Promise<{ helpful: number; notHelpful: number; recentNotHelpful: Array<{ answerId: string; comment: string | null; createdAt: Date }> }>`.

- [ ] **Step 1: Write the failing tests**

  Following the repo's existing `@rag/db` query-test pattern (real-Postgres via the test DB harness — read a neighbor like the grant/`logAskEvent` tests first):

  ```typescript
  it("submitAnswerFeedback inserts a helpful vote", async () => {
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

  it("upserts last-write-wins per (answerId, principalSubject)", async () => {
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
    const stats = await getFeedbackStats(db);
    expect(stats.helpful).toBe(0);
    expect(stats.notHelpful).toBe(1); // one row, updated — not two
    expect(stats.recentNotHelpful[0]).toMatchObject({
      answerId: "a1",
      comment: "wrong",
    });
  });

  it("logAskEvent persists the answerId", async () => {
    await logAskEvent(db, { ...BASE_ASK_EVENT, answerId: "a-log-1" });
    // read the row back via a direct select or an existing audit query helper
    // assert answer_id === "a-log-1"
  });
  ```

  Use the file's existing `db` handle + a `BASE_ASK_EVENT` fixture (copy the shape from an existing `logAskEvent` test).

- [ ] **Step 2: Run to confirm RED**

  ```bash
  pnpm docker:up && pnpm --filter @rag/db test -- answer-feedback
  ```

  Expected: FAIL — functions/field not defined.

- [ ] **Step 3: Implement**

  In `packages/db/src/queries.ts`:
  - Add `answerId: string;` to `AskEventRow` (with a doc line), and in `logAskEvent`'s `values` object add `answerId: row.answerId,`.
  - Add the two functions (copy the `logAskEvent` insert idiom):

    ```typescript
    export async function submitAnswerFeedback(
      db: Db,
      row: {
        answerId: string;
        principalSubject: string | null;
        rating: "helpful" | "not_helpful";
        comment: string | null;
        channel: "web" | "teams";
      },
    ): Promise<void> {
      const values: NewAnswerFeedback = {
        answerId: row.answerId,
        principalSubject: row.principalSubject,
        rating: row.rating,
        comment: row.comment,
        channel: row.channel,
      };
      await db
        .insert(answerFeedback)
        .values(values)
        .onConflictDoUpdate({
          target: [answerFeedback.answerId, answerFeedback.principalSubject],
          set: {
            rating: row.rating,
            comment: row.comment,
            createdAt: sql`now()`,
          },
        });
    }

    export interface FeedbackStats {
      helpful: number;
      notHelpful: number;
      recentNotHelpful: Array<{
        answerId: string;
        comment: string | null;
        createdAt: Date;
      }>;
    }

    export async function getFeedbackStats(
      db: Db,
      opts: { since?: Date } = {},
    ): Promise<FeedbackStats> {
      const rows = await db
        .select()
        .from(answerFeedback)
        .where(
          opts.since ? gte(answerFeedback.createdAt, opts.since) : undefined,
        );
      return {
        helpful: rows.filter((r) => r.rating === "helpful").length,
        notHelpful: rows.filter((r) => r.rating === "not_helpful").length,
        recentNotHelpful: rows
          .filter((r) => r.rating === "not_helpful")
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, 20)
          .map((r) => ({
            answerId: r.answerId,
            comment: r.comment,
            createdAt: r.createdAt,
          })),
      };
    }
    ```

  Confirm `onConflictDoUpdate`, `gte`, `sql` are imported from `drizzle-orm` at the top of `queries.ts` (add `gte` if absent — it's a standard drizzle operator). The `onConflictDoUpdate` target must match the unique index columns `(answerId, principalSubject)`.

- [ ] **Step 4: Run to confirm GREEN**

  ```bash
  pnpm --filter @rag/db test -- answer-feedback
  pnpm --filter @rag/db typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add packages/db/src/queries.ts packages/db/src/index.ts packages/db/src/answer-feedback.test.ts
  git commit -m "feat(db): logAskEvent answerId + submitAnswerFeedback (upsert) + getFeedbackStats"
  ```

---

### Task 4: Thread `answerId` through the API + MCP transports + the audit write

**Files:**

- Modify: `apps/api/src/routes/ask.ts` (`auditAsk` :29-53 — add answerId param + pass to `logAskEvent`; the `/ask` handler :77-93 already returns `result` with answerId; the `/ask/stream` done write :144-151 — add `answerId` to the JSON)
- Modify: `apps/mcp/src/tools/ask.ts` (:154 `structuredContent` — add `answerId`)
- Modify: `apps/web/src/lib/stream-chat.ts` (:18-19 — add `answerId` to the parsed `done` type so the UI can read it)
- Test: `apps/api/src/routes/ask.test.ts` / `apps/api/src/routes/audit-log.test.ts` (whichever holds the `/ask` audit assertions), `apps/mcp/src/tools/ask.test.ts`

**Interfaces:**

- Consumes: `AskResult.answerId` + the done event's `answerId` (Task 1); `AskEventRow.answerId` (Task 3).
- Produces: `/ask` JSON, `/ask/stream` `done` event, and MCP `structuredContent` all carry `answerId`; `audit_log.answer_id` is populated for both endpoints.

- [ ] **Step 1: Write the failing tests**

  - In the `/ask` route test: assert the `POST /ask` JSON body includes a non-empty `answerId`, and that `logAskEvent` was called with a matching `answerId` (extend the existing `logAskEvent` mock capture used for the `channel` assertions).
  - In the `/ask/stream` test (if present): assert the `done` SSE event JSON includes `answerId`.
  - In `apps/mcp/src/tools/ask.test.ts`: assert the tool's `structuredContent` includes `answerId`.

- [ ] **Step 2: Confirm RED**

  ```bash
  pnpm --filter @rag/api test -- ask
  pnpm --filter @rag/mcp test -- ask
  ```

- [ ] **Step 3: Implement the wiring**

  - `apps/api/src/routes/ask.ts` `auditAsk`: add a parameter `answerId: string`, and add `answerId,` to the object passed to `logAskEvent`. Update BOTH call sites: the `/ask` handler passes `result.answerId`; the `/ask/stream` `done` branch passes `event.answerId`.
  - In the `/ask/stream` `done` write (`raw.write(\`event: done\ndata: ${JSON.stringify({...})}\n\n\`)`), add `answerId: event.answerId` to the JSON object.
  - `apps/mcp/src/tools/ask.ts`: add `answerId: result.answerId` to the `structuredContent` object at :154.
  - `apps/web/src/lib/stream-chat.ts`: add `answerId: string` to the `done`-event parsed type (:18-19) so Phase 2's UI can read it (no behavior change here — just the type + passing it through the parser).

- [ ] **Step 4: Confirm GREEN + typecheck the touched apps**

  ```bash
  pnpm --filter @rag/api test -- ask
  pnpm --filter @rag/mcp test -- ask
  pnpm --filter @rag/api typecheck && pnpm --filter @rag/mcp typecheck && pnpm --filter @rag/web typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add apps/api/src/routes/ask.ts apps/mcp/src/tools/ask.ts apps/web/src/lib/stream-chat.ts apps/api/src/routes/*.test.ts apps/mcp/src/tools/ask.test.ts
  git commit -m "feat: surface answerId on the api/mcp transports and record it in the ask audit"
  ```

---

### Task 5: Feedback service + `POST /feedback` route

**Files:**

- Create: `packages/services/src/feedback.ts`, `packages/services/src/feedback.test.ts`
- Modify: `packages/services/src/index.ts` (export `submitAnswerFeedback`)
- Create: `apps/api/src/routes/feedback.ts`, `apps/api/src/routes/feedback.test.ts`
- Modify: the API route registration (where `registerAskRoute` etc. are registered — find it in `apps/api/src/` and add `registerFeedbackRoute`)

**Interfaces:**

- Consumes: `submitAnswerFeedback` DB query (Task 3), `ServiceDeps`, `scopeFromRequest` + `request.principal` (existing in `apps/api/src/routes/authz.ts`).
- Produces: service `submitAnswerFeedback(deps: ServiceDeps, input: { answerId: string; rating: "helpful" | "not_helpful"; comment?: string; principalSubject: string | null; channel: "web" | "teams" }): Promise<void>`; `POST /feedback` returning `204`.

- [ ] **Step 1: Write the failing service test**

  ```typescript
  // packages/services/src/feedback.test.ts
  it("records feedback with the server-provided principalSubject (not from the client)", async () => {
    const dbMock = { submit: vi.fn() }; // wire to a captured submitAnswerFeedback
    await submitAnswerFeedback(deps, {
      answerId: "a1",
      rating: "not_helpful",
      comment: "off-topic",
      principalSubject: "oid-A",
      channel: "web",
    });
    expect(dbSubmitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        answerId: "a1",
        rating: "not_helpful",
        comment: "off-topic",
        principalSubject: "oid-A",
        channel: "web",
      }),
    );
  });
  ```

  Match the file's `deps` construction (copy `packages/services/src/sources.test.ts`); mock the `@rag/db` `submitAnswerFeedback` (vi.mock) and capture the call.

- [ ] **Step 2: Confirm RED**, then implement `packages/services/src/feedback.ts` (copy `triggerSync`'s shape):

  ```typescript
  import type { ServiceDeps } from "./deps.js";
  import { submitAnswerFeedback as dbSubmitAnswerFeedback } from "@rag/db";

  export interface SubmitFeedbackInput {
    answerId: string;
    rating: "helpful" | "not_helpful";
    comment?: string;
    /** Derived server-side from the authenticated principal — NOT the client body. */
    principalSubject: string | null;
    channel: "web" | "teams";
  }

  export async function submitAnswerFeedback(
    deps: ServiceDeps,
    input: SubmitFeedbackInput,
  ): Promise<void> {
    await dbSubmitAnswerFeedback(deps.db, {
      answerId: input.answerId,
      rating: input.rating,
      comment: input.comment ?? null,
      principalSubject: input.principalSubject,
      channel: input.channel,
    });
  }
  ```

  Export it from `packages/services/src/index.ts`. Confirm GREEN: `pnpm --filter @rag/services test -- feedback`.

- [ ] **Step 3: Write the failing route test**

  In `apps/api/src/routes/feedback.test.ts` (copy the `ask`/`documents` route-test harness): assert `POST /feedback` with `{ answerId, rating: "helpful" }` returns `204` and calls the service with `principalSubject` taken from `request.principal.subject` (mock the service, inject a scoped principal). Assert a bad `rating` → 400 (Zod), and a `comment` > 1000 chars → 400.

- [ ] **Step 4: Confirm RED**, then implement `apps/api/src/routes/feedback.ts` (copy `documents.ts`'s thin-adapter shape):

  ```typescript
  import type { FastifyInstance } from "fastify";
  import type { ZodTypeProvider } from "fastify-type-provider-zod";
  import { z } from "zod";
  import { submitAnswerFeedback } from "@rag/services";
  import type { Deps } from "../deps.js";

  const FeedbackBody = z.object({
    answerId: z.string().min(1),
    rating: z.enum(["helpful", "not_helpful"]),
    comment: z.string().max(1000).optional(),
  });

  export async function registerFeedbackRoute(
    app: FastifyInstance,
    deps: Deps,
  ): Promise<void> {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.post(
      "/feedback",
      { schema: { body: FeedbackBody } },
      async (request, reply) => {
        const principal = request.principal;
        await submitAnswerFeedback(deps, {
          answerId: request.body.answerId,
          rating: request.body.rating,
          comment: request.body.comment,
          // server-derived identity — never the client's word
          principalSubject:
            principal?.kind === "scoped" ? (principal.subject ?? null) : null,
          channel: "web",
        });
        return reply.code(204).send();
      },
    );
  }
  ```

  Register it alongside the other routes (find the registration site — copy how `registerAskRoute` is wired). Match `Deps`/`request.principal` types to the actual `apps/api` definitions (read `routes/ask.ts` + `routes/authz.ts`).

- [ ] **Step 5: Confirm GREEN + typecheck**

  ```bash
  pnpm --filter @rag/services test -- feedback
  pnpm --filter @rag/api test -- feedback
  pnpm --filter @rag/api typecheck
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add packages/services/src/feedback.ts packages/services/src/feedback.test.ts packages/services/src/index.ts apps/api/src/routes/feedback.ts apps/api/src/routes/feedback.test.ts apps/api/src/<route-registration-file>
  git commit -m "feat: add submitAnswerFeedback service and POST /feedback route"
  ```

---

### Task 6 (optional): MCP `submit_feedback` tool

**Files:**

- Create: `apps/mcp/src/tools/submit-feedback.ts`, `apps/mcp/src/tools/submit-feedback.test.ts`
- Modify: the MCP tool registration (where `registerAsk`/`registerTriggerSync` are wired — copy that)

**Interfaces:**

- Consumes: `submitAnswerFeedback` service (Task 5); the MCP `fakeServer()` test harness (as in `apps/mcp/src/tools/trigger-sync.test.ts`).
- Produces: an MCP `submit_feedback` tool recording feedback with `channel: "teams"` (MCP is the agent/Teams surface) and `principalSubject` from the tool's scope/principal.

- [ ] **Step 1: Write the failing test** (copy `trigger-sync.test.ts`'s `fakeServer` capture): invoking `submit_feedback` with `{answerId, rating}` calls the service with the right args + the principal's subject.
- [ ] **Step 2: Confirm RED**, then implement `submit-feedback.ts` (copy `trigger-sync.ts`): `server.registerTool("submit_feedback", { title, description, inputSchema: { answerId, rating, comment? } }, handler)`; the handler does its own scope/principal read, calls `submitAnswerFeedback(deps, { ...args, principalSubject, channel: "teams" })`, returns a short confirmation `content`.
- [ ] **Step 3: Confirm GREEN** (`pnpm --filter @rag/mcp test -- submit-feedback`), register the tool, re-run the MCP suite + typecheck.
- [ ] **Step 4: Commit** `feat(mcp): add submit_feedback tool`.

---

## Out of scope (later phases of the parent plan)

- Feedback UI (web 👍/👎 + Teams card buttons) + `data-testid`s — Phase 2.
- Playwright E2E, the autopilot agent, the answer-quality judge, real SharePoint corpus — Phases 0.5, 3–6.
- Surfacing `getFeedbackStats` in an admin view — a later small task once there's data.

## Verification (after all tasks)

1. `pnpm docker:up && pnpm --filter @rag/db migrate` — 0000→0018 apply clean from a fresh volume.
2. `pnpm -r build && pnpm typecheck && pnpm lint && pnpm --filter @rag/services test && pnpm --filter @rag/db test && pnpm --filter @rag/api test && pnpm --filter @rag/mcp test` all green.
3. Manual: `POST /ask` returns an `answerId`; `POST /feedback {answerId, rating:"not_helpful", comment:"x"}` → 204 → an `answer_feedback` row with the asker's `principal_subject`; a re-vote updates the same row (upsert).
4. No FK from `answer_feedback` to `audit_log` (`\d answer_feedback` shows none).
