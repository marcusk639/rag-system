import { describe, expect, it } from "vitest";
import { encode } from "gpt-tokenizer";
import type { ParsedDocument, ParsedTable } from "@rag/core";
import { CompositeChunker, withDocumentTitle } from "./composite-chunker.js";
import { MAX_EMBEDDING_TOKENS } from "./token-clamp.js";

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

  it("clamps a giant code block below the hard embedding token cap", async () => {
    // A huge fenced code block can't be split by paragraph/sentence and only
    // gets char-sliced by hardSplit using a 4-chars/token estimate that can
    // under-count. Without the clamp such a chunk can exceed Gemini's 2048
    // embedding input limit. The clamp is the last line of defense.
    const chunker = new CompositeChunker(opts);
    const giantCode = "const x = 1; // padding token here\n".repeat(4000);
    const doc: ParsedDocument = {
      title: "huge.md",
      markdown: `# Code\n\n\`\`\`ts\n${giantCode}\`\`\`\n`,
      tables: [],
      metadata: {},
    };
    const chunks = await chunker.chunk(doc);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(encode(c.text).length).toBeLessThanOrEqual(MAX_EMBEDDING_TOKENS);
      expect(c.tokenCount).toBeLessThanOrEqual(MAX_EMBEDDING_TOKENS);
      expect(c.tokenCount).toBe(encode(c.text).length);
    }
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

  describe("document title context", () => {
    it("prefixes the title to a chunk from a document with no headings", async () => {
      const chunker = new CompositeChunker(opts);
      const chunks = await chunker.chunk({
        title: "New Client Onboarding SOP",
        markdown: "Apply the template and route the letter for signature.",
        tables: [],
        metadata: {},
      });
      expect(chunks[0]?.text.startsWith("# New Client Onboarding SOP\n\n")).toBe(
        true,
      );
      // headingPath stays the document's own structure — citations use it.
      expect(chunks[0]?.headingPath).toEqual([]);
    });

    it("joins the title onto an existing heading path", async () => {
      const chunker = new CompositeChunker(opts);
      const chunks = await chunker.chunk({
        title: "Karbon Guide",
        markdown: "# Setup\n\nCreate the client record.",
        tables: [],
        metadata: {},
      });
      expect(chunks[0]?.text.startsWith("# Karbon Guide › Setup\n\n")).toBe(true);
      expect(chunks[0]?.headingPath).toEqual(["Setup"]);
    });

    it("does not repeat a title that is already the first heading", async () => {
      const chunker = new CompositeChunker(opts);
      const chunks = await chunker.chunk({
        title: "Karbon Guide",
        markdown: "# Karbon Guide\n\n## Setup\n\nCreate the client record.",
        tables: [],
        metadata: {},
      });
      expect(chunks[0]?.text.startsWith("# Karbon Guide › Setup\n\n")).toBe(true);
    });

    it("prefixes the title to spreadsheet row chunks", async () => {
      const chunker = new CompositeChunker(opts);
      const chunks = await chunker.chunk({
        title: "Time Codes",
        markdown: "",
        tables: [
          makeTable({
            markdown: "md",
            sheetName: "Codes",
            sheetType: "tabular",
            headers: ["Code", "Meaning"],
            rows: [["BK-CATCHUP", "Bookkeeping catch-up"]],
          }),
        ],
        metadata: {},
      });
      expect(chunks[0]?.text.startsWith("# Time Codes › Codes\n\n")).toBe(true);
    });

    it("recomputes the chunk hash so re-titled chunks are not treated as unchanged", async () => {
      const chunker = new CompositeChunker(opts);
      const base = { markdown: "Same body.", tables: [], metadata: {} };
      const [a] = await chunker.chunk({ ...base, title: "Doc A" });
      const [b] = await chunker.chunk({ ...base, title: "Doc B" });
      expect(a?.hash).not.toBe(b?.hash);
    });
  });

  describe("heading and title survive chunk overlap (production chunkOverlap)", () => {
    const overlapping = {
      markdown: { chunkSize: 60, chunkOverlap: 20 },
      table: { chunkSize: 200, rowOverlap: 0 },
    };
    const paragraphs = Array.from(
      { length: 8 },
      (_, i) =>
        `Step ${i + 1}: open the client record, confirm the engagement letter, and apply the work template before assigning.`,
    ).join("\n\n");

    it("starts EVERY chunk of a multi-chunk section with the title and heading, before any overlap text", async () => {
      const chunker = new CompositeChunker(overlapping);
      const chunks = await chunker.chunk({
        title: "Onboarding SOP",
        markdown: `# Setup\n\n${paragraphs}`,
        tables: [],
        metadata: {},
      });
      expect(chunks.length).toBeGreaterThan(2);
      for (const c of chunks) {
        expect(c.text.startsWith("# Onboarding SOP › Setup\n\n")).toBe(true);
        // The heading appears once, at the top — not again after overlap text.
        expect(c.text.indexOf("# Setup")).toBe(-1);
      }
      // Overlap is still carried: chunk 2 repeats the tail of chunk 1's body.
      const firstBodyTail = chunks[0]!.text.slice(-30);
      expect(chunks[1]!.text).toContain(firstBodyTail.trim().slice(-15));
    });
  });

  describe("withDocumentTitle", () => {
    it("only merges into a header line the chunker itself wrote", () => {
      const chunk = {
        hash: "h",
        text: "# comment line from a split code block\nmore",
        tokenCount: 5,
        ordinal: 0,
        headingPath: [],
      };
      const out = withDocumentTitle(chunk, "Runbook");
      expect(out.text.startsWith("# Runbook\n\n# comment line")).toBe(true);
    });
  });
});
