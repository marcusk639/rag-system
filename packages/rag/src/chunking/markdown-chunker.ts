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
    // The heading-path prefix `chunk()` will ultimately prepend to EVERY piece
    // produced from this section. Computed once here and threaded into the
    // hard-splitters so the row-truncation ceiling is measured against the
    // REAL prefix cost — not a guessed constant. `chunk()` re-derives the exact
    // same string when assembling the final chunk (`headingPrefix + piece`), so
    // what we measure here is exactly what gets embedded.
    const headingPrefix = section.headingPath.length
      ? `# ${section.headingPath.join(" › ")}\n\n`
      : "";

    const tokens = countTokens(section.body);
    if (tokens <= this.opts.chunkSize) {
      // Whole section fits; prepend the heading line so the chunk is self-contained.
      return [headingPrefix + section.body];
    }

    // Split by blank lines (paragraphs / code blocks treated as one unit).
    const units = splitParagraphs(section.body);
    const chunks: string[] = [];
    let buffer: string[] = [];
    let bufferTokens = 0;

    const flush = () => {
      if (buffer.length === 0) return;
      const text = buffer.join("\n\n");
      chunks.push(headingPrefix + text);
      buffer = [];
      bufferTokens = 0;
    };

    for (const unit of units) {
      const unitTokens = countTokens(unit);
      if (unitTokens > this.opts.chunkSize) {
        // Single paragraph too big — flush what we have, then hard-split.
        flush();
        for (const piece of hardSplit(
          unit,
          this.opts.chunkSize,
          headingPrefix,
        )) {
          chunks.push(headingPrefix + piece);
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
function hardSplit(
  text: string,
  maxTokens: number,
  headingPrefix: string,
): string[] {
  if (looksLikeMarkdownTable(text)) {
    return hardSplitTable(text, maxTokens, headingPrefix);
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
 *
 * `headingPrefix` is the outer section-heading prefix (`# Heading › Sub\n\n`)
 * that `chunk()` prepends to every emitted piece. `hardSplitTable` itself never
 * emits that prefix, but it MUST budget for it: the effective per-piece ceiling
 * is measured against `headingPrefix + header + separator + rows`, so no
 * assembled chunk can overflow `MAX_EMBEDDING_TOKENS` and get re-cut mid-row by
 * the generic `clampToTokenLimit()` net in `chunk()`.
 */
function hardSplitTable(
  text: string,
  maxTokens: number,
  headingPrefix: string,
): string[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const headerLine = lines[0]!;
  const separatorLine = lines[1]!;
  const dataRows = lines.slice(2);

  // The real, tokenizer-measured overhead every emitted piece carries once
  // `chunk()` re-assembles it as `headingPrefix + piece`. No guessed constant.
  const structurePrefix = `${headingPrefix}${headerLine}\n${separatorLine}\n`;
  const baseOverheadTokens = countTokens(structurePrefix);
  // A single piece must fit under the smaller of the requested chunk size and
  // the hard embedding cap — the cap is what `clampToTokenLimit()` enforces and
  // what breaks table rows when exceeded, so it always binds here.
  const effectiveMax = Math.max(1, Math.min(maxTokens, MAX_EMBEDDING_TOKENS));

  const out: string[] = [];
  let buffer: string[] = [];
  // `bufferTokens` is an additive UPPER BOUND on the assembled piece's real
  // token count (concatenation only ever merges tokens at boundaries, never
  // adds), so keeping it ≤ effectiveMax keeps the real assembled count ≤
  // effectiveMax ≤ MAX_EMBEDDING_TOKENS at the point this function returns.
  //
  // KNOWN LIMITATION: `chunk()` still applies `applyOverlap()` AFTER this
  // function returns, prepending up to `chunkOverlap` chars of the previous
  // chunk's tail to every chunk but the first. On dense (e.g. CJK-heavy)
  // content that prepend can push a chunk sized right up against
  // effectiveMax back over MAX_EMBEDDING_TOKENS, where the generic
  // clampToTokenLimit() safety net (table-unaware) can cut a table row
  // mid-string again. This only bites when `chunkSize` is configured high
  // enough (~1600+) that effectiveMax is bound by MAX_EMBEDDING_TOKENS
  // rather than chunkSize itself, combined with chunkOverlap > 0 — the
  // shipped default (chunkSize 800, chunkOverlap 120) has enough headroom
  // that this does not trigger. See docs/superpowers/plans/
  // 2026-07-14-table-truncation-final-stage-fix.md for the proper fix
  // (verify post-overlap, not another upstream prediction) if chunkSize is
  // ever raised.
  let bufferTokens = baseOverheadTokens;

  const flush = () => {
    if (buffer.length === 0) return;
    out.push(`${headerLine}\n${separatorLine}\n${buffer.join("\n")}`);
    buffer = [];
    bufferTokens = baseOverheadTokens;
  };

  for (const row of dataRows) {
    const rowTokens = countTokens(row);

    // A row that can't fit even as the SOLE row of its own chunk — i.e. the
    // heading prefix + table header/separator + this one row already exceeds
    // the effective ceiling. Left alone it would flow untouched into the
    // generic clampToTokenLimit() safety net (token-clamp.ts, applied by the
    // caller in chunk()), whose raw token-boundary decode has zero table
    // awareness and cuts the row mid-string, dropping its closing "|". We
    // truncate the row's TEXT here instead, verifying the FULLY ASSEMBLED
    // chunk (heading prefix + header + separator + row) against the real
    // tokenizer at the point this returns. See the KNOWN LIMITATION note on
    // `bufferTokens` above — `applyOverlap()` runs after this and can still
    // reopen the gap at high `chunkSize`.
    if (baseOverheadTokens + rowTokens > effectiveMax) {
      flush();
      const safeRow = truncateTableRow(
        row,
        effectiveMax,
        headerLine,
        separatorLine,
        headingPrefix,
      );
      out.push(`${headerLine}\n${separatorLine}\n${safeRow}`);
      continue;
    }

    if (bufferTokens + rowTokens > effectiveMax && buffer.length > 0) {
      flush();
    }
    buffer.push(row);
    bufferTokens += rowTokens;
  }
  flush();

  return out.length > 0 ? out : [text];
}

/**
 * Truncate a single oversized table row's text so that the FULLY ASSEMBLED
 * chunk it will end up in — exactly `headingPrefix + header + separator + row`,
 * the same string `chunk()` builds and then measures — is genuinely,
 * tokenizer-verified under `effectiveMax`. This replaces the old approach of
 * subtracting a pile of separately-estimated overhead pieces (char-ratio,
 * header/separator tokens, a guessed heading-prefix margin) from a ceiling
 * computed in isolation: instead of enumerating every overhead source and
 * hoping none is missed, we build the real output and check it, so nothing can
 * be left unaccounted-for by construction.
 *
 * Why it matters: on dense content (CJK text, heavy digit/punctuation runs) the
 * real token/char ratio is far worse than `CHARS_PER_TOKEN`, and the outer
 * heading prefix `hardSplitTable` never emits still counts toward the final
 * chunk. A ceiling that mis-estimates either produces a row that LOOKS safe but
 * whose assembled token count still exceeds `MAX_EMBEDDING_TOKENS`; the generic
 * `clampToTokenLimit()` net in `chunk()` then re-cuts it table-unaware and drops
 * the closing "|" — the exact defect this function exists to prevent.
 *
 * Strategy: a fast char-budget first pass (cheap, correct for low-density text),
 * then VERIFY the assembled string's real token count via `countTokens` and
 * shrink the character window in a loop until it is under `effectiveMax`. The
 * loop only iterates on dense content; ordinary text passes on the first try.
 *
 * Degenerate case: if the heading prefix + table header/separator ALONE already
 * meet or exceed `effectiveMax`, there is no token budget left for any row
 * content. The loop shrinks the row to its minimal structurally-valid form
 * (still ending in "|") and returns it rather than crashing or looping forever;
 * the assembled chunk may then still exceed the cap and be clamped by the
 * generic net. This requires a heading path on the order of ~1700 tokens, which
 * does not arise from real documents — see the degenerate test.
 */
function truncateTableRow(
  row: string,
  effectiveMax: number,
  headerLine: string,
  separatorLine: string,
  headingPrefix: string,
): string {
  // Assemble the row into EXACTLY the chunk text chunk() will embed, so the
  // token check below measures the real output, not a proxy.
  const assemble = (candidateRow: string): string =>
    `${headingPrefix}${headerLine}\n${separatorLine}\n${candidateRow}`;

  // Size the first char window off the token budget left after the measured
  // fixed overhead (heading + header + separator). This is only a starting
  // estimate — the verify+shrink loop makes it exact.
  const fixedOverheadTokens = countTokens(assemble(""));
  const rowBudgetTokens = Math.max(1, effectiveMax - fixedOverheadTokens);
  let charBudget = Math.max(1, rowBudgetTokens * CHARS_PER_TOKEN);
  let candidate = finalizeTableRow(row.slice(0, charBudget));

  while (countTokens(assemble(candidate)) > effectiveMax && charBudget > 1) {
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
