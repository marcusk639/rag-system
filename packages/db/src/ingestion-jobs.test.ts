import { describe, expect, it } from "vitest";
import {
  incrementIngestionJobCounters,
  listGateFailureQuarantines,
} from "./ingestion-jobs.js";
import type { Db } from "./client.js";

/**
 * There is no live Postgres in this package (same constraint as
 * `queries.access-control.test.ts`), so these assert the SQL this builds and
 * the mapping of what Postgres hands back, not Postgres' runtime behaviour.
 *
 * That is exactly the gap that mattered: `@rag/db` is mocked wholesale in
 * `apps/worker`'s handler test, so before this file both the SQL delta and the
 * `RETURNING` mapping could be gutted with the whole suite green — and the
 * worker's safety guard reads nothing else.
 */

/** Recursively collect every literal string in a drizzle SQL object. */
function sqlText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(sqlText).join(" ");
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (Array.isArray(o.value) && o.value.every((v) => typeof v === "string")) {
      return (o.value as string[]).join(" ");
    }
    if (Array.isArray(o.queryChunks)) return sqlText(o.queryChunks);
    return "";
  }
  return "";
}

/** Strip `--` comments so prose in the SQL cannot satisfy an assertion. */
function stripComments(text: string): string {
  return text.replace(/--[^\n]*/g, " ");
}

function capturingDb(captured: string[], rows: unknown[] = []): Db {
  return {
    execute: async (q: unknown) => {
      captured.push(stripComments(sqlText(q)));
      return { rows };
    },
  } as unknown as Db;
}

const DELTA = {
  documentsProcessed: 10,
  documentsFailed: 1,
  chunksCreated: 20,
  documentsQuarantined: 3,
  documentsQuarantinedGateFailure: 2,
};

const ROW = {
  documents_processed: 100,
  documents_failed: 4,
  chunks_created: 250,
  documents_quarantined: 11,
  documents_quarantined_gate_failure: 2,
};

describe("incrementIngestionJobCounters — accumulated counters", () => {
  it("accumulates both quarantine counters in the UPDATE", async () => {
    const captured: string[] = [];
    await incrementIngestionJobCounters(
      capturingDb(captured, [ROW]),
      "ing-1",
      DELTA,
    );

    const sql = captured[0] ?? "";
    expect(sql).toContain("documents_quarantined = documents_quarantined +");
    expect(sql).toContain(
      "documents_quarantined_gate_failure = documents_quarantined_gate_failure +",
    );
  });

  it("RETURNs both quarantine counters", async () => {
    // The caller's guard reads the ACCUMULATED row, so a column missing from
    // RETURNING reaches it as 0 and silences the guard rather than erroring.
    const captured: string[] = [];
    await incrementIngestionJobCounters(
      capturingDb(captured, [ROW]),
      "ing-1",
      DELTA,
    );

    const returning = (captured[0] ?? "").split("RETURNING")[1] ?? "";
    expect(returning).toContain("documents_quarantined");
    expect(returning).toContain("documents_quarantined_gate_failure");
  });

  it("maps the returned row onto the accumulated totals", async () => {
    const totals = await incrementIngestionJobCounters(
      capturingDb([], [ROW]),
      "ing-1",
      DELTA,
    );

    expect(totals).toEqual({
      documentsProcessed: 100,
      documentsFailed: 4,
      chunksCreated: 250,
      documentsQuarantined: 11,
      documentsQuarantinedGateFailure: 2,
    });
  });

  it("throws when the UPDATE matched no row", async () => {
    // Previously this returned all-zero totals, which is indistinguishable
    // from a healthy run and makes the worker's safety guard inert: a bad
    // ingestion id would report "nothing quarantined" forever. This repo's
    // posture is to fail loud.
    await expect(
      incrementIngestionJobCounters(capturingDb([], []), "missing", DELTA),
    ).rejects.toThrow(/missing/);
  });

  it("treats an omitted gate-failure delta as zero, not as absent", async () => {
    const captured: string[] = [];
    const totals = await incrementIngestionJobCounters(
      capturingDb(captured, [ROW]),
      "ing-1",
      {
        documentsProcessed: 1,
        documentsFailed: 0,
        chunksCreated: 1,
      },
    );

    expect(totals.documentsQuarantinedGateFailure).toBe(2);
  });
});

describe("listGateFailureQuarantines — problematic documents", () => {
  it("selects only blocked rows carrying the gate-failure prefix", async () => {
    // A document that reliably breaks the gate must be identifiable from
    // `ingest_log` alone. Policy refusals share `action = 'blocked'`, so the
    // reason prefix is what separates "the gate broke on this file" from
    // "this file was correctly refused".
    const captured: string[] = [];
    await listGateFailureQuarantines(capturingDb(captured, []), "src-1", {
      limit: 20,
    });

    const sql = captured[0] ?? "";
    expect(sql).toContain("ingest_log");
    expect(sql).toContain("action = 'blocked'");
    expect(sql).toContain("rejection_reason LIKE");
    expect(sql).toContain("source_id =");
  });

  it("returns the external id, reason and last-seen time per document", async () => {
    const rows = [
      {
        external_id: "Working Papers/ledger.xlsx",
        rejection_reason: "gate-failure: semantic scan failed: too-large",
        attempts: 4,
        last_seen_at: "2026-10-06T00:00:00.000Z",
      },
    ];

    const out = await listGateFailureQuarantines(
      capturingDb([], rows),
      "src-1",
      { limit: 20 },
    );

    expect(out).toEqual([
      {
        externalId: "Working Papers/ledger.xlsx",
        rejectionReason: "gate-failure: semantic scan failed: too-large",
        attempts: 4,
        lastSeenAt: "2026-10-06T00:00:00.000Z",
      },
    ]);
  });
});
