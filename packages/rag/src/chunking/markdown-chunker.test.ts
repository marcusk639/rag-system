import { encode } from "gpt-tokenizer";
import { describe, expect, it } from "vitest";
import { MarkdownChunker } from "./markdown-chunker.js";
import { MAX_EMBEDDING_TOKENS } from "./token-clamp.js";

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

describe("MarkdownChunker — oversized single table row with dense (CJK) content", () => {
  it("truncates a token-dense row to a REAL token count under MAX_EMBEDDING_TOKENS, keeping the closing pipe", async () => {
    const header = "| Client | Notes |\n| --- | --- |\n";
    // Dense CJK filler: unlike "word ".repeat(...) (English, ~4 chars/token,
    // matching CHARS_PER_TOKEN), common CJK characters tokenize far closer to
    // 1 token/char with the o200k_base tokenizer. A char-budget-only
    // truncation (the old approach) sized off CHARS_PER_TOKEN=4 therefore
    // keeps ~4x too many real tokens for this kind of content.
    const denseUnit =
      "测试内容用于验证令牌截断的正确性并确保它不会被下游裁剪逻辑二次截断";
    const hugeNote = denseUnit.repeat(400); // ~28,000 CJK characters
    const row = `| Client 0 | ${hugeNote} |\n`;
    const chunkSize = 800; // default-ish chunkSize per the reviewer's repro
    const chunker = new MarkdownChunker({ chunkSize, chunkOverlap: 0 });

    // Sanity-check the premise: the OLD char-budget-only approach
    // (CHARS_PER_TOKEN=4, no real-tokenizer verification) would slice
    // chunkSize * 4 characters off this row and call it done. Confirm that
    // naive slice's REAL token count exceeds MAX_EMBEDDING_TOKENS — i.e.
    // this specific input reproduces the reviewer's failure mode
    // mathematically, independent of any particular chunker's behavior.
    const CHARS_PER_TOKEN = 4;
    const oldApproachSlice = row.slice(0, chunkSize * CHARS_PER_TOKEN);
    const oldApproachTokens = encode(oldApproachSlice).length;
    expect(oldApproachTokens).toBeGreaterThan(MAX_EMBEDDING_TOKENS);

    const chunks = await chunker.chunk({
      title: "Oversized Dense Row",
      markdown: `# Oversized Dense Row\n\n${header}${row}`,
      tables: [],
      metadata: {},
    });

    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      const lines = c.text.split("\n").filter((l) => l.trim().startsWith("|"));
      for (const line of lines) {
        // (a) The row-boundary guarantee must hold even for dense content:
        // still ends with a closing "|", never cut mid-string by the
        // downstream generic clampToTokenLimit() re-cutting a "safe-looking"
        // but actually-oversized row.
        expect(line.trim().endsWith("|")).toBe(true);
      }
      // (b) The REAL token count (not char length) of every chunk must be
      // safely under MAX_EMBEDDING_TOKENS — this is what the char-budget
      // approximation could not guarantee for dense content.
      expect(encode(c.text).length).toBeLessThan(MAX_EMBEDDING_TOKENS);
    }
  });
});

describe("MarkdownChunker — oversized row under a long, deep heading path", () => {
  it("keeps the row's closing pipe and stays under MAX_EMBEDDING_TOKENS once the heading prefix is assembled", async () => {
    // The reviewer's specific repro. A 3-level heading path whose joined
    // prefix (`# H1 › H2 › H3\n\n`) is worth several HUNDRED tokens, plus a
    // dense-CJK oversized row, at a chunkSize LARGER than MAX_EMBEDDING_TOKENS
    // (so the effective ceiling is bound by MAX_EMBEDDING_TOKENS, not
    // chunkSize). The bug: `hardSplitTable` sized the row against just the
    // table header/separator and never saw the outer heading prefix, so the
    // final assembled chunk (heading prefix + header + separator + row)
    // overflowed MAX_EMBEDDING_TOKENS and the generic, table-unaware
    // clampToTokenLimit() re-cut the row mid-string, dropping its closing "|".
    const wordyHeading = (label: string): string =>
      `${label} ${"comprehensive detailed longwinded verbose explanatory ".repeat(32)}`.trim();
    const h1 = wordyHeading("Alpha Section");
    const h2 = wordyHeading("Beta Subsection");
    const h3 = wordyHeading("Gamma Deep Heading");

    // Confirm the heading prefix really is a large, materially-relevant share
    // of the budget (the whole point of this repro) — many hundreds of tokens,
    // far more than any small fixed "safety margin" could have absorbed.
    const headingPrefix = `# ${[h1, h2, h3].join(" › ")}\n\n`;
    expect(encode(headingPrefix).length).toBeGreaterThan(500);

    const header = "| Client | Notes |\n| --- | --- |\n";
    const denseUnit =
      "测试内容用于验证令牌截断的正确性并确保它不会被下游裁剪逻辑二次截断";
    const hugeNote = denseUnit.repeat(400); // ~28,000 dense CJK characters
    const row = `| Client 0 | ${hugeNote} |\n`;

    // chunkSize deliberately > MAX_EMBEDDING_TOKENS so the ceiling is bound by
    // the hard embedding cap, exactly as in the reviewer's demonstration.
    const chunker = new MarkdownChunker({ chunkSize: 5000, chunkOverlap: 0 });

    const chunks = await chunker.chunk({
      title: "Deep Heading Oversized Row",
      markdown: `# ${h1}\n\n## ${h2}\n\n### ${h3}\n\n${header}${row}`,
      tables: [],
      metadata: {},
    });

    expect(chunks.length).toBeGreaterThan(0);
    // The table row lives under the full 3-level path — confirm the structure
    // that induces the large heading prefix is actually exercised end-to-end.
    const tableChunks = chunks.filter((c) => c.text.includes("| Client 0 |"));
    expect(tableChunks.length).toBeGreaterThan(0);
    for (const c of tableChunks) {
      expect(c.headingPath.length).toBe(3);
    }

    for (const c of chunks) {
      const lines = c.text.split("\n").filter((l) => l.trim().startsWith("|"));
      for (const line of lines) {
        // Row-boundary integrity holds even with a long heading prefix eating
        // into the budget: still ends with "|", never cut mid-string.
        expect(line.trim().endsWith("|")).toBe(true);
      }
      // The REAL token count of the FULLY ASSEMBLED chunk (heading prefix +
      // table) is under the hard cap — verified against the same tokenizer
      // used by the final clampToTokenLimit() pass, so that clamp is a no-op.
      expect(encode(c.text).length).toBeLessThan(MAX_EMBEDDING_TOKENS);
    }
  });
});

describe("MarkdownChunker — degenerate heading path leaving no room for row content", () => {
  it("fails safely (no crash, output still produced) when the heading prefix alone exceeds the embedding cap", async () => {
    // Pathological extreme: a heading so long that its prefix ALONE exceeds
    // MAX_EMBEDDING_TOKENS, leaving literally no token budget for any table
    // row content. This does not arise from real documents (it needs a ~1700+
    // token heading), but the chunker must degrade gracefully rather than
    // crash or loop forever. Documented behavior: the row is shrunk to its
    // minimal structurally-valid form and the assembled chunk, being
    // unrepresentable under the cap, is left to the generic clamp — no
    // exception, deterministic output.
    const monsterHeading =
      `Overlong ${"exceedingly verbose ".repeat(1000)}`.trim();
    expect(encode(`# ${monsterHeading}\n\n`).length).toBeGreaterThan(
      MAX_EMBEDDING_TOKENS,
    );

    const header = "| Client | Notes |\n| --- | --- |\n";
    const row = `| Client 0 | ${"payload ".repeat(2000).trim()} |\n`;
    const chunker = new MarkdownChunker({ chunkSize: 5000, chunkOverlap: 0 });

    // The contract for this degenerate input is simply: it returns without
    // throwing and still produces at least one chunk.
    const chunks = await chunker.chunk({
      title: "Degenerate Heading",
      markdown: `# ${monsterHeading}\n\n${header}${row}`,
      tables: [],
      metadata: {},
    });

    expect(chunks.length).toBeGreaterThan(0);
    // Every chunk is still hard-capped by the final safety net — no chunk can
    // reach the embedder over the limit, even in this unrepresentable case.
    for (const c of chunks) {
      expect(encode(c.text).length).toBeLessThanOrEqual(MAX_EMBEDDING_TOKENS);
    }
  });
});
