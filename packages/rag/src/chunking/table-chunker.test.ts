import { describe, expect, it } from "vitest";
import type { ParsedTable } from "@rag/core";
import { TableChunker } from "./table-chunker.js";

function makeTable(
  partial: Partial<ParsedTable> & Pick<ParsedTable, "markdown">,
): ParsedTable {
  return {
    markdown: partial.markdown,
    sheetName: partial.sheetName,
    sheetType: partial.sheetType,
    headers: partial.headers ?? [],
    rows: partial.rows ?? [],
    rowCount: partial.rows?.length ?? 0,
    columnCount: partial.headers?.length ?? 0,
    caption: partial.caption,
  };
}

const HEADERS = ["Date", "Customer", "Amount", "Status"];

function syntheticRows(n: number): string[][] {
  return Array.from({ length: n }, (_, i) => [
    `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    `Customer ${i}`,
    String(1000 + i),
    i % 2 === 0 ? "paid" : "pending",
  ]);
}

describe("TableChunker", () => {
  it("repeats the header in every chunk so each is self-contained", () => {
    const chunker = new TableChunker({ chunkSize: 80, rowOverlap: 0 });
    const table = makeTable({
      markdown: "",
      sheetName: "Sales",
      sheetType: "tabular",
      headers: HEADERS,
      rows: syntheticRows(40),
    });
    const chunks = chunker.chunk({ table, startOrdinal: 0 });
    expect(chunks).not.toBeNull();
    expect(chunks!.length).toBeGreaterThan(1);
    for (const c of chunks!) {
      expect(c.text).toContain("| Date | Customer | Amount | Status |");
      expect(c.text).toContain("| --- | --- | --- | --- |");
      expect(c.text.startsWith("# Sales")).toBe(true);
      expect(c.headingPath).toEqual(["Sales"]);
    }
  });

  it("never splits in the middle of a row", () => {
    const chunker = new TableChunker({ chunkSize: 60, rowOverlap: 0 });
    const table = makeTable({
      markdown: "",
      sheetType: "tabular",
      headers: HEADERS,
      rows: syntheticRows(25),
    });
    const chunks = chunker.chunk({ table, startOrdinal: 0 })!;
    // Every body line in every chunk must be a complete row (starts with "|" and ends with "|").
    for (const c of chunks) {
      const lines = c.text.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        expect(line.startsWith("|")).toBe(true);
        expect(line.endsWith("|")).toBe(true);
      }
    }
  });

  it("emits an oversized row alone rather than dropping data", () => {
    const chunker = new TableChunker({ chunkSize: 40, rowOverlap: 0 });
    const longCell = "x ".repeat(200).trim();
    const table = makeTable({
      markdown: "",
      sheetType: "tabular",
      headers: HEADERS,
      rows: [
        ["2026-01-01", "Customer", "100", "paid"],
        ["2026-01-02", longCell, "200", "paid"],
        ["2026-01-03", "Customer", "300", "paid"],
      ],
    });
    const chunks = chunker.chunk({ table, startOrdinal: 0 })!;
    const oversized = chunks.find((c) => c.text.includes(longCell));
    expect(oversized).toBeDefined();
    // The oversized chunk contains exactly one body row (the oversized one).
    const bodyLines = oversized!.text
      .split("\n")
      .filter((l) => l.startsWith("|") && !l.includes("---"));
    // header + 1 data row = 2 pipe-lines
    expect(bodyLines.length).toBe(2);
  });

  it("keeps a financial_model sheet whole when it fits", () => {
    const chunker = new TableChunker({ chunkSize: 1000, rowOverlap: 0 });
    const table = makeTable({
      markdown: "",
      sheetName: "P&L",
      sheetType: "financial_model",
      headers: ["Line", "Q1", "Q2"],
      rows: [
        ["Revenue", "100", "120"],
        ["COGS", "40", "50"],
        ["Gross", "60", "70"],
      ],
    });
    const chunks = chunker.chunk({ table, startOrdinal: 0 })!;
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toContain("Revenue");
    expect(chunks[0]!.text).toContain("Gross");
  });

  it("falls back to row-grouping for a financial_model sheet too big to fit", () => {
    const chunker = new TableChunker({ chunkSize: 60, rowOverlap: 0 });
    const table = makeTable({
      markdown: "",
      sheetName: "BigModel",
      sheetType: "financial_model",
      headers: HEADERS,
      rows: syntheticRows(30),
    });
    const chunks = chunker.chunk({ table, startOrdinal: 0 })!;
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("returns null for narrative sheets (caller falls back to MarkdownChunker)", () => {
    const chunker = new TableChunker({ chunkSize: 800, rowOverlap: 0 });
    const table = makeTable({
      markdown: "narrative md",
      sheetType: "narrative",
      headers: HEADERS,
      rows: syntheticRows(5),
    });
    expect(chunker.chunk({ table, startOrdinal: 0 })).toBeNull();
  });

  it("returns null for freeform sheets", () => {
    const chunker = new TableChunker({ chunkSize: 800, rowOverlap: 0 });
    const table = makeTable({
      markdown: "freeform md",
      sheetType: "freeform",
      headers: HEADERS,
      rows: syntheticRows(5),
    });
    expect(chunker.chunk({ table, startOrdinal: 0 })).toBeNull();
  });

  it("returns null for tables with no structured rows (markdown-only extraction)", () => {
    const chunker = new TableChunker({ chunkSize: 800, rowOverlap: 0 });
    expect(
      chunker.chunk({
        table: makeTable({ markdown: "| a | b |\n| --- | --- |\n| 1 | 2 |" }),
        startOrdinal: 0,
      }),
    ).toBeNull();
  });

  it("assigns ordinals starting from startOrdinal", () => {
    const chunker = new TableChunker({ chunkSize: 80, rowOverlap: 0 });
    const table = makeTable({
      markdown: "",
      sheetType: "tabular",
      headers: HEADERS,
      rows: syntheticRows(20),
    });
    const chunks = chunker.chunk({ table, startOrdinal: 7 })!;
    expect(chunks[0]!.ordinal).toBe(7);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.ordinal).toBe(chunks[i - 1]!.ordinal + 1);
    }
  });

  it("produces deterministic hashes for identical input", () => {
    const chunker = new TableChunker({ chunkSize: 80, rowOverlap: 0 });
    const table = makeTable({
      markdown: "",
      sheetName: "X",
      sheetType: "tabular",
      headers: HEADERS,
      rows: syntheticRows(10),
    });
    const a = chunker.chunk({ table, startOrdinal: 0 })!;
    const b = chunker.chunk({ table, startOrdinal: 0 })!;
    expect(a.map((c) => c.hash)).toEqual(b.map((c) => c.hash));
  });

  it("applies row overlap by repeating the trailing N rows in the next chunk", () => {
    const chunker = new TableChunker({ chunkSize: 80, rowOverlap: 2 });
    const table = makeTable({
      markdown: "",
      sheetType: "tabular",
      headers: HEADERS,
      rows: syntheticRows(30),
    });
    const chunks = chunker.chunk({ table, startOrdinal: 0 })!;
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const prevRows = chunks[i - 1]!.text.split("\n").filter(
        (l) => l.startsWith("|") && !l.includes("---"),
      );
      const lastTwo = prevRows.slice(-2);
      for (const row of lastTwo) {
        // The overlap rows from the previous chunk must appear in the next chunk.
        expect(chunks[i]!.text).toContain(row);
      }
    }
  });

  it("escapes pipes inside cell values so table structure stays parseable", () => {
    const chunker = new TableChunker({ chunkSize: 200, rowOverlap: 0 });
    const table = makeTable({
      markdown: "",
      sheetType: "tabular",
      headers: ["A", "B"],
      rows: [
        ["foo|bar", "baz"],
        ["a", "b"],
      ],
    });
    const chunks = chunker.chunk({ table, startOrdinal: 0 })!;
    expect(chunks[0]!.text).toContain("foo\\|bar");
  });
});
