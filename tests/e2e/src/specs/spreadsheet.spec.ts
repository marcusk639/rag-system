import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeConnector } from "../fakes/fake-connector.js";
import { csvDoc } from "../fakes/factories.js";
import {
  createCustomSource,
  getChunksForExternalId,
  openTestDb,
  truncateAll,
} from "../helpers/db.js";
import { runOneIngestion } from "../helpers/ingestion.js";
import type { Db } from "@rag/db";

/**
 * Validates the v0 table-aware chunker (shipped earlier this session) all the
 * way through the live parser-py service. CSV is the cheapest spreadsheet
 * format — the parser routes it through the same classifier + structured-rows
 * path as XLSX, so the CompositeChunker sees the same `ParsedTable` shape with
 * `sheetType` set.
 *
 * Contract we're verifying:
 *   1. Tabular CSV produces ≥1 chunk via TableChunker (not MarkdownChunker).
 *   2. Every chunk repeats the GFM header row at the top → self-describing.
 *   3. No chunk contains a partial row (the bug v0 was built to fix).
 */
describe("E2E: spreadsheet routing through TableChunker", () => {
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

  it("chunks a CSV with repeated header context and no mid-row splits", async () => {
    const sourceId = await createCustomSource(db, "csv");
    const headers = ["Date", "Customer", "Amount", "Status"];
    const rows = Array.from({ length: 40 }, (_, i) => [
      `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      `Customer ${i}`,
      String(1000 + i),
      i % 2 === 0 ? "paid" : "pending",
    ]);

    const connector = new FakeConnector([
      csvDoc({
        externalId: "sales-csv",
        title: "sales.csv",
        headers,
        rows,
      }),
    ]);

    // Use a small chunk budget so multiple chunks must be emitted — that's
    // the configuration that originally caused mid-row splitting.
    await runOneIngestion(db, sourceId, connector, { chunkSize: 120 });

    const chunks = await getChunksForExternalId(db, sourceId, "sales-csv");
    expect(chunks.length).toBeGreaterThan(1);

    for (const c of chunks) {
      // Header row appears in every chunk (after CompositeChunker repeated it).
      expect(c.text).toContain("| Date | Customer | Amount | Status |");

      // Every non-empty content line is either a heading prefix or a
      // complete pipe-delimited row — no partial rows ever.
      const bodyLines = c.text
        .split("\n")
        .filter((l) => l.trim().length > 0 && !l.startsWith("#"));
      for (const line of bodyLines) {
        expect(line.startsWith("|")).toBe(true);
        expect(line.trimEnd().endsWith("|")).toBe(true);
      }
    }
  });

  it("preserves sheetName as the chunk heading path", async () => {
    const sourceId = await createCustomSource(db, "csv-heading");
    const connector = new FakeConnector([
      csvDoc({
        externalId: "books-csv",
        title: "books.csv",
        headers: ["Title", "Author", "Year"],
        rows: [
          ["Dune", "Herbert", "1965"],
          ["Foundation", "Asimov", "1951"],
          ["Hyperion", "Simmons", "1989"],
          ["Snow Crash", "Stephenson", "1992"],
          ["Neuromancer", "Gibson", "1984"],
        ],
      }),
    ]);

    await runOneIngestion(db, sourceId, connector);
    const chunks = await getChunksForExternalId(db, sourceId, "books-csv");
    expect(chunks.length).toBeGreaterThan(0);
    // The parser sets sheetName to the file stem ("books") for CSV inputs.
    expect(chunks[0]!.headingPath).toEqual(["books"]);
  });
});
