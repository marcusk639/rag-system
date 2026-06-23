import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "@rag/db";
import { FakeConnector, FakeGenerator, plainTextDoc } from "@rag/test-fixtures";
import { createCustomSource, openTestDb, truncateAll } from "../helpers/db.js";
import { buildTestApi, type TestInject } from "../helpers/api.js";
import { runOneIngestion } from "../helpers/ingestion.js";

/**
 * In-process HTTP API smoke tests via Fastify's inject(). Covers:
 *   - Bearer-token enforcement on protected routes
 *   - /health (public)
 *   - GET /sources → list view sanitises the config blob
 *   - POST /sources → create
 *   - POST /search → returns RRF-ranked results with citation context
 *   - POST /ask    → 503 when generator missing, 200 with fake generator wired
 */
describe("E2E: HTTP API", () => {
  let db: Db;
  let closeDb: () => Promise<void>;
  let inject: TestInject;
  let app: FastifyInstance;
  let closeApi: () => Promise<void>;
  let generator: FakeGenerator;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    closeDb = handle.close;
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    await truncateAll(db);
    generator = new FakeGenerator();
    const harness = await buildTestApi({ db, generator });
    app = harness.app;
    inject = harness.inject;
    closeApi = harness.close;
  });

  afterEach(async () => {
    await closeApi();
  });

  // --- public ---------------------------------------------------------------

  it("GET /health is open and returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("rejects requests with no bearer token", async () => {
    const res = await app.inject({ method: "POST", url: "/search" });
    expect(res.statusCode).toBe(401);
    const body = res.json<{ error?: { code: string } }>();
    expect(body.error?.code).toBe("UNAUTHORIZED");
  });

  it("rejects requests with a bogus bearer token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/search",
      headers: { authorization: "Bearer not-the-token" },
      payload: { query: "anything" },
    });
    expect(res.statusCode).toBe(401);
  });

  // --- sources --------------------------------------------------------------

  it("POST /sources creates a source; GET /sources lists it without exposing config", async () => {
    const created = await inject({
      method: "POST",
      url: "/sources",
      payload: {
        kind: "custom",
        name: "api-spec",
        config: { secretField: "should-not-leak" },
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json<{ id: string; kind: string }>();
    expect(createdBody.kind).toBe("custom");

    const listed = await inject({ method: "GET", url: "/sources" });
    expect(listed.statusCode).toBe(200);
    const listedBody = listed.json<{
      sources: Array<Record<string, unknown>>;
    }>();
    const ours = listedBody.sources.find(
      (s) => (s as { id?: string }).id === createdBody.id,
    );
    expect(ours).toBeDefined();
    // The sanitisation guard is real — keep it tight.
    expect(ours).not.toHaveProperty("config");
  });

  // --- search ---------------------------------------------------------------

  it("POST /search returns ranked results after ingestion", async () => {
    const sourceId = await createCustomSource(db, "api-search");
    await runOneIngestion(
      db,
      sourceId,
      new FakeConnector([
        plainTextDoc({
          externalId: "physics",
          title: "Physics Primer",
          text: "Quantum entanglement describes correlations between particles regardless of distance.",
        }),
        plainTextDoc({
          externalId: "cooking",
          title: "Cooking Notes",
          text: "Maillard browning happens above 140C when sugars and amino acids react.",
        }),
      ]),
    );

    const res = await inject({
      method: "POST",
      url: "/search",
      payload: { query: "quantum entanglement particles", topK: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      results: Array<{ document: { title: string }; score: number }>;
    }>();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0]!.document.title).toBe("Physics Primer");
  });

  it("POST /search validates topK upper bound", async () => {
    const res = await inject({
      method: "POST",
      url: "/search",
      payload: { query: "anything", topK: 9999 },
    });
    expect(res.statusCode).toBe(400);
  });

  // --- ask ------------------------------------------------------------------

  it("POST /ask returns 503 when generator is not configured", async () => {
    // Rebuild API without generator
    await closeApi();
    const harness = await buildTestApi({ db, generator: null });
    closeApi = harness.close;
    const noGenInject = harness.inject;

    const res = await noGenInject({
      method: "POST",
      url: "/ask",
      payload: { question: "what is anything?" },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ error?: { code: string } }>();
    expect(body.error?.code).toBe("GENERATION_NOT_CONFIGURED");
  });

  it("POST /ask calls the generator with retrieved context", async () => {
    const sourceId = await createCustomSource(db, "api-ask");
    await runOneIngestion(
      db,
      sourceId,
      new FakeConnector([
        plainTextDoc({
          externalId: "cosmology",
          title: "Cosmology Notes",
          text: "Dark matter makes up about 27 percent of the universe's mass-energy content.",
        }),
      ]),
    );

    const res = await inject({
      method: "POST",
      url: "/ask",
      payload: { question: "What is dark matter?" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      answer: string;
      citations: Array<{ documentId: string }>;
    }>();
    expect(body.answer).toContain("What is dark matter?");
    expect(body.citations.length).toBeGreaterThan(0);
    // The generator was actually invoked, with non-empty context.
    expect(generator.calls.length).toBe(1);
    expect(generator.calls[0]!.contextSize).toBeGreaterThan(0);
  });

  it("POST /ask short-circuits to a 'no info' response when retrieval is empty", async () => {
    // No ingestion ⇒ zero chunks in the DB ⇒ retrieval returns [].
    const res = await inject({
      method: "POST",
      url: "/ask",
      payload: { question: "what is this empty corpus?" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ answer: string; citations: unknown[] }>();
    expect(body.answer).toMatch(/do not contain enough information/i);
    expect(body.citations).toEqual([]);
    // Generator must NOT be called when nothing was retrieved — that's the
    // hallucination guard in apps/api/src/routes/ask.ts.
    expect(generator.calls.length).toBe(0);
  });
});
