import { createHash } from "node:crypto";
import { encode } from "gpt-tokenizer";
import type { Chunk, Chunker, ParsedDocument } from "@rag/core";
import { clampToTokenLimit, MAX_EMBEDDING_TOKENS } from "./token-clamp.js";

/**
 * Markdown-aware recursive chunker.
 *
 * Strategy (in order):
 *   1. Split the document by `#`/`##`/`###` headings into sections.
 *      Each section carries the full heading path (["Intro", "Setup"]) so
 *      retrieved chunks can be cited with context.
 *   2. If a section is small enough (≤ chunkSize tokens), it becomes one chunk.
 *   3. If too big, split by blank lines (paragraphs), then by sentences, then
 *      by hard character count. Code blocks (```…```) are kept intact when
 *      they fit; oversized code blocks are split by line.
 *   4. Apply overlap between adjacent chunks for context preservation.
 *
 * Token counts use the `o200k_base` (GPT-4o family) tokenizer as a stable,
 * provider-independent estimate. Real provider tokenizers may differ ±10%.
 */
export interface MarkdownChunkerOptions {
  chunkSize: number; // target tokens per chunk
  chunkOverlap: number; // overlap tokens between adjacent chunks
}

/**
 * Rough chars-per-token ratio used whenever we need to convert a token
 * budget into a character slice length without re-encoding on every byte
 * (e.g. hard character chunking, oversized-row truncation). Not exact, but
 * consistent across this file's fallback splitters.
 */
const CHARS_PER_TOKEN = 4;

export class MarkdownChunker implements Chunker {
  constructor(private readonly opts: MarkdownChunkerOptions) {}

  async chunk(document: ParsedDocument): Promise<Chunk[]> {
    const sections = splitByHeadings(document.markdown);
    const chunks: Chunk[] = [];
    let ordinal = 0;

    for (const section of sections) {
      const sectionChunks = this.chunkSection(section);
      for (const rawText of sectionChunks) {
        // Last-resort safety net: never let a chunk past the hard embedding
        // token cap (see token-clamp.ts). Truncation is token-aware.
        const text = clampToTokenLimit(rawText);
        const tokenCount = countTokens(text);
        chunks.push({
          hash: sha256(`${section.headingPath.join("/")}::${text}`),
          text,
          tokenCount,
          ordinal: ordinal++,
          headingPath: section.headingPath,
        });
      }
    }

    return chunks;
  }

  private chunkSection(section: Section): string[] {
    const tokens = countTokens(section.body);
    if (tokens <= this.opts.chunkSize) {
      // Whole section fits; prepend the heading line so the chunk is self-contained.
      const header = section.headingPath.length
        ? `# ${section.headingPath.join(" › ")}\n\n`
        : "";
      return [header + section.body];
    }

    // Split by blank lines (paragraphs / code blocks treated as one unit).
    const units = splitParagraphs(section.body);
    const chunks: string[] = [];
    let buffer: string[] = [];
    let bufferTokens = 0;

    const flush = () => {
      if (buffer.length === 0) return;
      const text = buffer.join("\n\n");
      const header = section.headingPath.length
        ? `# ${section.headingPath.join(" › ")}\n\n`
        : "";
      chunks.push(header + text);
      buffer = [];
      bufferTokens = 0;
    };

    for (const unit of units) {
      const unitTokens = countTokens(unit);
      if (unitTokens > this.opts.chunkSize) {
        // Single paragraph too big — flush what we have, then hard-split.
        flush();
        for (const piece of hardSplit(unit, this.opts.chunkSize)) {
          const header = section.headingPath.length
            ? `# ${section.headingPath.join(" › ")}\n\n`
            : "";
          chunks.push(header + piece);
        }
        continue;
      }

      if (bufferTokens + unitTokens > this.opts.chunkSize) {
        flush();
      }
      buffer.push(unit);
      bufferTokens += unitTokens;
    }
    flush();

    return applyOverlap(chunks, this.opts.chunkOverlap);
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
interface Section {
  headingPath: string[];
  body: string;
}

function splitByHeadings(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  let currentPath: string[] = [];
  let currentBody: string[] = [];
  let inCodeBlock = false;

  const push = () => {
    const body = currentBody.join("\n").trim();
    if (body) sections.push({ headingPath: [...currentPath], body });
    currentBody = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) inCodeBlock = !inCodeBlock;

    const headingMatch = !inCodeBlock
      ? /^(#{1,6})\s+(.+?)\s*$/.exec(line)
      : null;
    if (headingMatch) {
      push();
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!;
      // Pop to the appropriate level, then push.
      currentPath = currentPath.slice(0, level - 1);
      currentPath[level - 1] = text;
      currentPath = currentPath.filter((s) => s !== undefined);
    } else {
      currentBody.push(line);
    }
  }
  push();

  return sections.length
    ? sections
    : [{ headingPath: [], body: markdown.trim() }];
}

function splitParagraphs(text: string): string[] {
  const units: string[] = [];
  const lines = text.split("\n");
  let buf: string[] = [];
  let inCode = false;

  const flush = () => {
    const joined = buf.join("\n").trim();
    if (joined) units.push(joined);
    buf = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      // Toggle code block; do NOT split inside one.
      inCode = !inCode;
      buf.push(line);
      continue;
    }
    if (!inCode && line.trim() === "") {
      flush();
    } else {
      buf.push(line);
    }
  }
  flush();
  return units;
}

/**
 * Last-resort splitter for a single unit (paragraph or code block) larger than
 * chunkSize. If the unit looks like a GFM pipe table (every non-blank line
 * starts with `|`), split on row boundaries so no chunk ever cuts a table row
 * mid-way — the header + separator row is repeated at the top of every piece
 * so each chunk stays self-contained. Otherwise splits by sentence first, then
 * by character if a sentence is itself huge.
 */
function hardSplit(text: string, maxTokens: number): string[] {
  if (looksLikeMarkdownTable(text)) {
    return hardSplitTable(text, maxTokens);
  }

  const sentences = text.match(/[^.!?]+[.!?]?\s*/g) ?? [text];
  const out: string[] = [];
  let buffer = "";
  let bufferTokens = 0;

  for (const s of sentences) {
    const t = countTokens(s);
    if (t > maxTokens) {
      // Even a single sentence is too big — fall back to character chunking.
      if (buffer) {
        out.push(buffer);
        buffer = "";
        bufferTokens = 0;
      }
      const charBudget = maxTokens * CHARS_PER_TOKEN;
      for (let i = 0; i < s.length; i += charBudget) {
        out.push(s.slice(i, i + charBudget));
      }
      continue;
    }
    if (bufferTokens + t > maxTokens) {
      out.push(buffer);
      buffer = "";
      bufferTokens = 0;
    }
    buffer += s;
    bufferTokens += t;
  }
  if (buffer) out.push(buffer);
  return out;
}

/**
 * True when every non-blank line of `text` is a GFM pipe-table row (`| ... |`)
 * AND the second line is an actual GFM separator row (`| --- | --- |`).
 * Checking only the leading `|` is not enough — ordinary prose that happens
 * to start every line with `|` would otherwise be misclassified as a table
 * and routed through `hardSplitTable`, which repeats the (bogus) "header"
 * and "separator" lines at the top of every resulting chunk.
 */
function looksLikeMarkdownTable(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return (
    lines.length >= 2 &&
    lines.every((l) => l.trim().startsWith("|")) &&
    looksLikeTableSeparatorRow(lines[1]!)
  );
}

/**
 * True when `line` is a GFM table separator row, e.g. `| --- | --- |` or
 * `|:---:|---|`. After stripping the leading/trailing `|` and whitespace,
 * every `|`-delimited cell must consist solely of `-` and `:` characters,
 * with at least one `-`.
 */
function looksLikeTableSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const stripped = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = stripped.split("|").map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/**
 * Split a markdown table into row-boundary-respecting pieces. The header row
 * and its `| --- | --- |` separator are repeated at the top of every piece
 * past the first so each chunk stays a valid, self-contained table.
 */
function hardSplitTable(text: string, maxTokens: number): string[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const headerLine = lines[0]!;
  const separatorLine = lines[1]!;
  const dataRows = lines.slice(2);

  const out: string[] = [];
  let buffer: string[] = [];
  let bufferTokens = countTokens(`${headerLine}\n${separatorLine}\n`);

  const flush = () => {
    if (buffer.length === 0) return;
    out.push(`${headerLine}\n${separatorLine}\n${buffer.join("\n")}`);
    buffer = [];
    bufferTokens = countTokens(`${headerLine}\n${separatorLine}\n`);
  };

  for (const row of dataRows) {
    const rowTokens = countTokens(row);

    if (rowTokens > maxTokens) {
      // This single row is oversized even as its own solo chunk. Left
      // alone, it would flow untouched out of this function and into the
      // generic clampToTokenLimit() safety net (token-clamp.ts, applied by
      // the caller in chunk()). That clamp does a raw token-boundary
      // decode with zero table awareness, so it can (and, per review, did)
      // cut this row mid-string and drop its closing "|" — silently
      // breaking the "no chunk ever cuts a table row mid-way" guarantee
      // this function's docstring makes. We truncate the row's TEXT here,
      // inside the table-aware splitter, so the row-boundary guarantee
      // holds even in this pathological case, rather than widening the
      // shared clamp's behavior for every non-table caller.
      flush();
      // `bufferTokens` was just reset by the flush() above to exactly the
      // header + separator token count (flush() is a no-op when buffer is
      // already empty, and bufferTokens is only ever mutated by flush()'s
      // reset or in lockstep with buffer.push(), so this invariant holds
      // whenever buffer.length === 0). Pass it through so the row's
      // truncation ceiling is sized against the real overhead it will be
      // bundled with, not a guess.
      const safeRow = truncateTableRow(row, maxTokens, bufferTokens);
      buffer.push(safeRow);
      bufferTokens += countTokens(safeRow);
      flush();
      continue;
    }

    if (bufferTokens + rowTokens > maxTokens && buffer.length > 0) {
      flush();
    }
    buffer.push(row);
    bufferTokens += rowTokens;
  }
  flush();

  return out.length > 0 ? out : [text];
}

/**
 * Fixed token buffer subtracted (on top of the caller's measured
 * header+separator overhead) when computing a table row's truncation
 * ceiling. Covers the outer section-heading prefix (`# Heading › Sub\n\n`)
 * `chunkSection` prepends to every hard-split piece — which `hardSplitTable`
 * never sees — plus the trailing `|` `finalizeTableRow` may append.
 */
const ROW_TRUNCATION_SAFETY_MARGIN_TOKENS = 40;

/**
 * Truncate a single table row's text so the result is genuinely,
 * tokenizer-verified under the ceiling this row (plus its table's header and
 * separator) must fit in — not just a `CHARS_PER_TOKEN` char-ratio guess.
 *
 * Why this matters: on dense content (CJK text, heavy digit/punctuation
 * runs) the real token/char ratio can be far worse than `CHARS_PER_TOKEN`.
 * A char-budget-only truncation can produce a row that LOOKS safe (short
 * enough in characters) but whose real token count still exceeds
 * `MAX_EMBEDDING_TOKENS`. When that happens, the generic
 * `clampToTokenLimit()` safety net in `chunk()` fires a second time on this
 * "safe-looking" row and re-cuts it with a table-unaware raw token-boundary
 * decode — reproducing the exact "cuts mid-row, drops the closing `|`"
 * defect this function exists to prevent.
 *
 * `headerOverheadTokens` is the caller's already-computed token count of the
 * table's header + separator rows (the text this row is bundled with in the
 * final chunk) — passed in so the ceiling reflects the real overhead the
 * row will share a chunk with, rather than guessing.
 *
 * Strategy: do a fast char-budget first pass (cheap, and correct for the
 * common case of low-density text), then VERIFY the real token count via
 * `countTokens` — the same tokenizer used everywhere else in this file —
 * and shrink the character window further in a loop until the real count is
 * safely under the ceiling. The verify+shrink loop only needs to iterate on
 * dense content; ordinary text satisfies the ceiling on the first pass.
 */
function truncateTableRow(
  row: string,
  maxTokens: number,
  headerOverheadTokens: number,
): string {
  const ceiling =
    Math.min(maxTokens, MAX_EMBEDDING_TOKENS) -
    headerOverheadTokens -
    ROW_TRUNCATION_SAFETY_MARGIN_TOKENS;
  const targetTokens = Math.max(1, ceiling);

  let charBudget = Math.max(1, targetTokens * CHARS_PER_TOKEN);
  let candidate = finalizeTableRow(row.slice(0, charBudget));

  while (countTokens(candidate) > targetTokens && charBudget > 1) {
    charBudget = Math.max(1, Math.floor(charBudget * 0.75));
    candidate = finalizeTableRow(row.slice(0, charBudget));
  }

  return candidate;
}

/**
 * Ensure truncated row text still ends with a closing `|` — i.e. it still
 * looks like a syntactically valid table row, even though the truncated
 * cell's content is now incomplete.
 */
function finalizeTableRow(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.endsWith("|") ? trimmed : `${trimmed} |`;
}

function applyOverlap(chunks: string[], overlapTokens: number): string[] {
  if (overlapTokens <= 0 || chunks.length <= 1) return chunks;
  const out: string[] = [chunks[0]!];
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1]!;
    const prevTokens = encode(prev);
    // Take the tail tokens of the previous chunk as the prefix of this one.
    const tail = prevTokens.slice(-overlapTokens);
    // Decoding back to string isn't exact for arbitrary tokens, so we
    // approximate by slicing the previous chunk's string. For most languages
    // the ratio is ~4 chars/token; this overshoots slightly, which is fine.
    const approxChars = tail.length * 4;
    const overlapText = prev.slice(-approxChars);
    out.push(`${overlapText}\n\n${chunks[i]}`);
  }
  return out;
}

function countTokens(text: string): number {
  return encode(text).length;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
