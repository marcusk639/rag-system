import { describe, expect, it } from "vitest";
import { encode } from "gpt-tokenizer";
import { MarkdownChunker } from "./markdown-chunker.js";

const doc = (markdown: string) => ({
  title: "t",
  markdown,
  tables: [],
  metadata: {},
});

describe("MarkdownChunker — tables inside prose documents", () => {
  const header = "| Code | Meaning | Billable |";
  const separator = "| --- | --- | --- |";
  const rows = Array.from(
    { length: 60 },
    (_, i) => `| CODE-${i} | Work type number ${i} for the time catalog | yes |`,
  );
  const table = [header, separator, ...rows].join("\n");

  it("splits an oversized table by whole rows and repeats the header in every chunk", async () => {
    const chunker = new MarkdownChunker({ chunkSize: 120, chunkOverlap: 0 });
    const chunks = await chunker.chunk(doc(`# Time codes\n\n${table}`));

    expect(chunks.length).toBeGreaterThan(2);
    const seenRows = new Set<string>();
    for (const c of chunks) {
      const lines = c.text.split("\n");
      expect(lines).toContain(header);
      expect(lines).toContain(separator);
      for (const line of lines.filter((l) => l.startsWith("| CODE-"))) {
        // Whole rows only: every row line is exactly one of the source rows.
        expect(rows).toContain(line);
        seenRows.add(line);
      }
      expect(encode(c.text).length).toBeLessThanOrEqual(120 + 40);
    }
    expect(seenRows.size).toBe(rows.length);
  });

  it("does not prepend character-sliced overlap to a table continuation chunk", async () => {
    const chunker = new MarkdownChunker({ chunkSize: 120, chunkOverlap: 30 });
    const chunks = await chunker.chunk(doc(`# Time codes\n\n${table}`));
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      const body = c.text.slice(c.text.indexOf("\n\n") + 2);
      // The body of every table chunk starts at the header row, whole.
      expect(body.startsWith(header)).toBe(true);
    }
  });

  it("leaves a small table intact as one unit", async () => {
    const chunker = new MarkdownChunker({ chunkSize: 800, chunkOverlap: 0 });
    const small = [header, separator, ...rows.slice(0, 3)].join("\n");
    const chunks = await chunker.chunk(doc(`# Codes\n\n${small}`));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain(small);
  });
});

describe("MarkdownChunker — degenerate chunks", () => {
  it("drops sections with no real text (rules, stray pipes, punctuation)", async () => {
    const chunker = new MarkdownChunker({ chunkSize: 800, chunkOverlap: 0 });
    const chunks = await chunker.chunk(
      doc("# Intro\n\nReal content here.\n\n# Divider\n\n---\n\n# Empty-ish\n\n| |\n"),
    );
    expect(chunks.map((c) => c.headingPath.join("/"))).toEqual(["Intro"]);
  });

  it("keeps a short but meaningful section", async () => {
    const chunker = new MarkdownChunker({ chunkSize: 800, chunkOverlap: 0 });
    const chunks = await chunker.chunk(doc("# Owner\n\nClient services lead."));
    expect(chunks).toHaveLength(1);
  });

  it("renumbers ordinals contiguously after dropping", async () => {
    const chunker = new MarkdownChunker({ chunkSize: 800, chunkOverlap: 0 });
    const chunks = await chunker.chunk(doc("# A\n\nOne.\n\n# B\n\n***\n\n# C\n\nTwo."));
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1]);
  });
});
