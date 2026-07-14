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
