import { describe, expect, it } from "vitest";
import { hybridSearch } from "./queries.js";
import type { Db } from "./client.js";

/**
 * Regression guard for the sparse arm's OR semantics.
 *
 * The bug: `plainto_tsquery`/`websearch_to_tsquery` AND every lexeme together,
 * so one chunk had to contain EVERY content word of the question. Measured on a
 * representative SOP corpus, 5 of 15 realistic staff questions matched ZERO
 * chunks — hybrid search silently degraded to dense-only for exactly the
 * queries whose exact tokens (form numbers, work codes) the sparse arm exists
 * to catch. The fix rewrites the lexemes joined by `|`.
 *
 * The fix shipped without a test — it landed inside an unrelated
 * `feat(extraction)` commit, and the commit that advertised it changed only
 * comments. This file is that missing test.
 *
 * There is no live Postgres in this package (see `queries.access-control.test.ts`
 * for the same constraint), so the assertion is on the SQL this builds rather
 * than on rows returned. That is enough to catch the regression that matters:
 * a revert to `plainto_tsquery`, or dropping the `|` join. It deliberately does
 * NOT claim to verify Postgres' runtime behaviour — a DB-backed test asserting a
 * multi-word question returns a non-empty sparse arm is still worth adding.
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

function capturingDb(captured: string[]): Db {
  const tx = {
    execute: async (q: unknown) => {
      captured.push(sqlText(q));
      return { rows: [] };
    },
  };
  return {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as Db;
}

/** Strip `--` comments: the SQL explains the fix in prose that names the very
 * builders the negative assertions below look for. */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
}

/** The retrieval statement, as opposed to the `SET LOCAL` that precedes it. */
function retrievalSql(captured: string[]): string {
  const found = captured.find((s) => s.includes("WITH params"));
  if (!found) throw new Error("no retrieval query was issued");
  return found;
}

const baseOpts = {
  query: "how do I set up a new bookkeeping client",
  queryEmbedding: [0.1, 0.2, 0.3],
  topK: 8,
  embeddingProvider: "test-provider",
  embeddingModel: "test-model",
  enforcedSourceIds: null,
};

describe("hybridSearch — sparse arm uses OR semantics", () => {
  it("joins lexemes with | rather than ANDing them", async () => {
    const captured: string[] = [];
    await hybridSearch(capturingDb(captured), baseOpts);

    // The transaction issues `SET LOCAL hnsw.ef_search` first; the retrieval
    // CTE is the one that carries the tsquery.
    const sql = retrievalSql(captured);

    // The OR join is the fix.
    expect(sql).toContain("' | '");
    // The AND-semantics builders are what the fix replaced. Checked against the
    // comment-stripped SQL, since the comment explains what it replaced.
    const code = stripComments(sql);
    expect(code).not.toContain("plainto_tsquery");
    expect(code).not.toContain("websearch_to_tsquery");
  });

  it("builds the tsquery from to_tsvector so the dictionary matches the index", async () => {
    // Splitting the raw string instead would stem and stop-word differently
    // from the indexed `chunks.tsv` column, so some lexemes could never match.
    const captured: string[] = [];
    await hybridSearch(capturingDb(captured), baseOpts);

    expect(retrievalSql(captured)).toContain("tsvector_to_array");
    expect(retrievalSql(captured)).toContain("to_tsvector");
  });

  it("quotes each lexeme so operator characters cannot be parsed as tsquery syntax", async () => {
    // `to_tsquery` parses its argument as tsquery SYNTAX. The question text is
    // untrusted end-user input from a Teams message, so an unquoted lexeme
    // carrying & | ! ( ) : would either be read as an operator or raise a
    // syntax error on input as ordinary as a pasted URL.
    const captured: string[] = [];
    await hybridSearch(capturingDb(captured), {
      ...baseOpts,
      query: "see https://example.com/a?b=1&c=2 for the AR & AP process",
    });

    expect(retrievalSql(captured)).toContain("quote_literal");
  });

  it("degrades to a deliberate no-match tsquery for an all-stop-word question", async () => {
    // `to_tsquery('')` raises a syntax error, which would fail the whole search
    // rather than letting dense retrieval answer it.
    const captured: string[] = [];
    await hybridSearch(capturingDb(captured), {
      ...baseOpts,
      query: "how do I do it",
    });

    expect(retrievalSql(captured)).toContain("NULLIF");
    expect(retrievalSql(captured)).toContain("zzzznomatchzzzz");
  });
});
