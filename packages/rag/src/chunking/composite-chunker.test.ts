import { describe, expect, it } from "vitest";
import type { ParsedDocument, ParsedTable } from "@rag/core";
import { CompositeChunker } from "./composite-chunker.js";

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

const opts = {
  markdown: { chunkSize: 200, chunkOverlap: 0 },
  table: { chunkSize: 200, rowOverlap: 0 },
};

describe("CompositeChunker", () => {
  it("routes a spreadsheet doc entirely through TableChunker", async () => {
    const chunker = new CompositeChunker(opts);
    const table = makeTable({
      markdown: "rendered table md",
      sheetName: "Sales",
      sheetType: "tabular",
      headers: ["Date", "Amount"],
      rows: Array.from({ length: 20 }, (_, i) => [
        `2026-01-${i + 1}`,
        String(100 + i),
      ]),
    });
    const doc: ParsedDocument = {
      title: "report.xlsx",
      markdown: "rendered table md",
      tables: [table],
      metadata: {},
    };
    const chunks = await chunker.chunk(doc);
    expect(chunks.length).toBeGreaterThan(0);
    // Every chunk must carry the sheet name in its heading path — proof we
    // went through TableChunker and not MarkdownChunker.
    for (const c of chunks) {
      expect(c.headingPath).toEqual(["Sales"]);
    }
  });

  it("routes a non-spreadsheet doc through MarkdownChunker", async () => {
    const chunker = new CompositeChunker(opts);
    const doc: ParsedDocument = {
      title: "report.pdf",
      markdown:
        "# Introduction\n\nSome prose.\n\n## Background\n\nMore text here.",
      tables: [],
      metadata: {},
    };
    const chunks = await chunker.chunk(doc);
    expect(chunks.length).toBeGreaterThan(0);
    // MarkdownChunker assigns ["Introduction"] / ["Introduction","Background"]
    // — distinct from the TableChunker shape.
    const paths = chunks.map((c) => c.headingPath.join("/"));
    expect(paths.some((p) => p.includes("Introduction"))).toBe(true);
  });

  it("falls back to MarkdownChunker for narrative sheets within a spreadsheet doc", async () => {
    const chunker = new CompositeChunker(opts);
    const tabular = makeTable({
      markdown: "tab md",
      sheetName: "Data",
      sheetType: "tabular",
      headers: ["A", "B"],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
    });
    const narrative = makeTable({
      markdown: "# Notes\n\nThis sheet has prose.\n\n## Details\n\nMore words.",
      sheetName: "Notes",
      sheetType: "narrative",
      headers: ["A"],
      rows: [["irrelevant"]],
    });
    const doc: ParsedDocument = {
      title: "workbook.xlsx",
      markdown: "merged",
      tables: [tabular, narrative],
      metadata: {},
    };
    const chunks = await chunker.chunk(doc);
    // First chunks come from the tabular sheet — heading path is ["Data"].
    // Later chunks come from the narrative sheet's markdown — heading paths
    // include "Notes" or "Details".
    const headingPaths = chunks.map((c) => c.headingPath.join("/"));
    expect(headingPaths.some((p) => p === "Data")).toBe(true);
    expect(
      headingPaths.some((p) => p.includes("Notes") || p.includes("Details")),
    ).toBe(true);
  });

  it("assigns globally unique sequential ordinals across multiple tables", async () => {
    const chunker = new CompositeChunker({
      markdown: { chunkSize: 80, chunkOverlap: 0 },
      table: { chunkSize: 80, rowOverlap: 0 },
    });
    const tables: ParsedTable[] = [
      makeTable({
        markdown: "",
        sheetName: "A",
        sheetType: "tabular",
        headers: ["x", "y"],
        rows: Array.from({ length: 15 }, (_, i) => [String(i), String(i * 2)]),
      }),
      makeTable({
        markdown: "",
        sheetName: "B",
        sheetType: "tabular",
        headers: ["x", "y"],
        rows: Array.from({ length: 15 }, (_, i) => [String(i), String(i * 2)]),
      }),
    ];
    const doc: ParsedDocument = {
      title: "workbook.xlsx",
      markdown: "",
      tables,
      metadata: {},
    };
    const chunks = await chunker.chunk(doc);
    const ordinals = chunks.map((c) => c.ordinal);
    // Ordinals must be 0, 1, 2, ... contiguously across both sheets.
    expect(ordinals).toEqual(
      Array.from({ length: ordinals.length }, (_, i) => i),
    );
  });

  it("never produces a chunk with mid-row content for a spreadsheet doc", async () => {
    const chunker = new CompositeChunker({
      markdown: { chunkSize: 50, chunkOverlap: 0 },
      table: { chunkSize: 50, rowOverlap: 0 },
    });
    const table = makeTable({
      markdown: "",
      sheetName: "Sales",
      sheetType: "tabular",
      headers: ["Date", "Customer", "Amount"],
      rows: Array.from({ length: 50 }, (_, i) => [
        `2026-01-${(i % 28) + 1}`,
        `Customer ${i}`,
        String(1000 + i),
      ]),
    });
    const doc: ParsedDocument = {
      title: "s.xlsx",
      markdown: "",
      tables: [table],
      metadata: {},
    };
    const chunks = await chunker.chunk(doc);
    for (const c of chunks) {
      const bodyLines = c.text
        .split("\n")
        .filter((l) => l.trim().length > 0 && !l.startsWith("#"));
      for (const line of bodyLines) {
        expect(line.startsWith("|")).toBe(true);
        expect(line.trimEnd().endsWith("|")).toBe(true);
      }
    }
  });
});
