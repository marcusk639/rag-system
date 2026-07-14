import { describe, expect, it } from "vitest";
import { MarkdownChunker } from "./markdown-chunker.js";

describe("MarkdownChunker — oversized inline table", () => {
  it("splits an oversized markdown table on row boundaries, never mid-row", async () => {
    const header = "| Client | Fee | Due Date |\n| --- | --- | --- |\n";
    const rows = Array.from(
      { length: 60 },
      (_, i) => `| Client ${i} | $${1000 + i} | 2026-0${(i % 9) + 1}-15 |\n`,
    ).join("");
    const chunker = new MarkdownChunker({ chunkSize: 200, chunkOverlap: 0 });

    const chunks = await chunker.chunk({
      title: "Fee Schedule",
      markdown: `# Fee Schedule\n\n${header}${rows}`,
      tables: [],
      metadata: {},
    });

    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk must contain only WHOLE table rows — never a row split
    // mid-way through a "| ... |" line (the character-offset bug this fixes).
    for (const c of chunks) {
      const lines = c.text.split("\n").filter((l) => l.trim().startsWith("|"));
      for (const line of lines) {
        expect(line.trim().endsWith("|")).toBe(true);
      }
    }
    // No client row's fee/date got separated from its client name across a
    // chunk boundary in a way that drops it entirely.
    const allText = chunks.map((c) => c.text).join("\n");
    expect(allText).toContain("Client 0");
    expect(allText).toContain("Client 59");
  });
});

describe("MarkdownChunker — table false-positive detection", () => {
  it("does not treat pipe-prefixed prose without a GFM separator row as a table", async () => {
    // Every line starts with "|" (mimicking a table row prefix) but line 2
    // is ordinary prose, NOT a `| --- | --- |`-style GFM separator row. This
    // must fall through to normal sentence splitting, not hardSplitTable.
    const lines = Array.from(
      { length: 40 },
      (_, i) =>
        `| This is line ${i} of pipe-prefixed prose text that is moderately long so it accumulates tokens for the test scenario.`,
    );
    const body = lines.join("\n");
    const chunker = new MarkdownChunker({ chunkSize: 60, chunkOverlap: 0 });

    const chunks = await chunker.chunk({
      title: "Not A Table",
      markdown: `# Not A Table\n\n${body}`,
      tables: [],
      metadata: {},
    });

    // If this were misclassified as a table, hardSplitTable would repeat
    // "line 0" and "line 1" (treated as bogus header + separator) at the top
    // of every single chunk. With correct sentence-splitting fallback, each
    // line's text appears exactly once across the whole output.
    const allText = chunks.map((c) => c.text).join("\n");
    const line1Occurrences =
      allText.split("line 1 of pipe-prefixed").length - 1;
    expect(line1Occurrences).toBe(1);
  });
});

describe("MarkdownChunker — oversized single table row", () => {
  it("keeps a closing pipe on a row whose own token count exceeds maxTokens", async () => {
    const header = "| Client | Notes |\n| --- | --- |\n";
    // A single row whose "Notes" cell alone is large enough that the row's
    // own token count exceeds chunkSize, even as its own solo chunk — AND
    // is large enough to exceed the downstream MAX_EMBEDDING_TOKENS hard cap
    // (token-clamp.ts), which is where the raw, table-unaware truncation
    // previously cut the row mid-string and dropped the closing "|".
    const hugeNote = "word ".repeat(3000).trim();
    const row = `| Client 0 | ${hugeNote} |\n`;
    const chunker = new MarkdownChunker({ chunkSize: 50, chunkOverlap: 0 });

    const chunks = await chunker.chunk({
      title: "Oversized Row",
      markdown: `# Oversized Row\n\n${header}${row}`,
      tables: [],
      metadata: {},
    });

    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      const lines = c.text.split("\n").filter((l) => l.trim().startsWith("|"));
      for (const line of lines) {
        // Row-boundary integrity must hold even for the pathological
        // oversized-row case: the line must still end with a closing "|",
        // never get cut mid-string by the downstream generic token clamp.
        expect(line.trim().endsWith("|")).toBe(true);
      }
    }
  });
});
