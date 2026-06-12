import { createHash } from "node:crypto";
import { encode } from "gpt-tokenizer";
import type { Chunk, ParsedTable } from "@rag/core";
import { clampToTokenLimit } from "./token-clamp.js";

/**
 * Row-grouped chunker for structured tables emitted by the spreadsheet path
 * (parser-py XLSX/CSV route). Groups whole rows under a repeated header so
 * each chunk is self-describing and no row is ever split mid-cell.
 *
 * Inspired by Chonkie's TableChunker (Python). Same idea: pack rows up to a
 * token budget, prepend the header to every chunk, fall back to one-row-per-
 * chunk when a single row exceeds the budget.
 *
 *   sheetType policy (set by the parser classifier):
 *     - tabular         → row-grouping with header repetition + row overlap
 *     - financial_model → keep the whole sheet in one chunk if possible; row-group otherwise
 *     - narrative       → return null so the caller falls back to MarkdownChunker
 *     - freeform        → return null so the caller falls back to MarkdownChunker
 *     - undefined       → treat as tabular (markdown-extracted tables have no classification)
 */
export interface TableChunkerOptions {
  /** Target tokens per chunk (matches MarkdownChunker for output uniformity) */
  chunkSize: number;
  /** Number of trailing rows from the previous chunk to repeat at the top of the next. */
  rowOverlap: number;
}

export interface TableChunkInput {
  table: ParsedTable;
  /** Starting ordinal — caller manages global ordinal sequence across multiple tables. */
  startOrdinal: number;
}

export class TableChunker {
  constructor(private readonly opts: TableChunkerOptions) {}

  /**
   * Chunk a single table. Returns `null` when the caller should fall back to
   * markdown-style chunking (narrative/freeform sheets, or tables with no
   * structured rows — e.g. markdown-extracted tables that the parser left as
   * just a `markdown` blob).
   */
  chunk(input: TableChunkInput): Chunk[] | null {
    const { table, startOrdinal } = input;

    // No structured rows means we have nothing to row-group on (e.g. a table
    // pulled out of a PDF where only the markdown rendering survived).
    if (!table.headers?.length || !table.rows?.length) return null;

    // Narrative/freeform sheets are prose-like; row-grouping fragments them.
    if (table.sheetType === "narrative" || table.sheetType === "freeform") {
      return null;
    }

    const headerLine = renderHeaderLine(table.headers);
    const separator = renderSeparator(table.headers.length);
    const headerBlock = `${headerLine}\n${separator}`;
    const sheetTitle = table.sheetName ? `# ${table.sheetName}\n\n` : "";
    const fixedPrefix = `${sheetTitle}${headerBlock}\n`;
    const fixedPrefixTokens = countTokens(fixedPrefix);

    // Financial-model fast path: try to fit the whole sheet whole-cloth. The
    // classifier already told us this is small + dense + formula-derived;
    // keeping the values together preserves cross-cell context.
    if (table.sheetType === "financial_model") {
      const allRows = table.rows.map((r) => renderRow(r));
      const wholeChunk = fixedPrefix + allRows.join("\n");
      if (countTokens(wholeChunk) <= this.opts.chunkSize) {
        return [
          makeChunk({
            text: wholeChunk,
            ordinal: startOrdinal,
            sheetName: table.sheetName,
          }),
        ];
      }
      // Too big — fall through to row-grouping below.
    }

    const renderedRows = table.rows.map((r) => renderRow(r));
    const rowTokenCounts = renderedRows.map((r) => countTokens(r));

    const chunks: Chunk[] = [];
    let buffer: string[] = [];
    let bufferTokens = 0;
    let bufferStartIdx = 0; // index of first row in `buffer` (for overlap accounting)
    let ordinal = startOrdinal;

    const flush = (endIdx: number) => {
      if (buffer.length === 0) return;
      const text = fixedPrefix + buffer.join("\n");
      chunks.push(
        makeChunk({ text, ordinal: ordinal++, sheetName: table.sheetName }),
      );

      if (this.opts.rowOverlap <= 0) {
        buffer = [];
        bufferTokens = 0;
        bufferStartIdx = endIdx;
        return;
      }

      // Carry the last N rows forward as overlap into the next chunk.
      const overlapCount = Math.min(this.opts.rowOverlap, buffer.length);
      const carry = buffer.slice(-overlapCount);
      const carryTokens = carry.reduce((sum, _, i) => {
        const idx = endIdx - overlapCount + i;
        return sum + (rowTokenCounts[idx] ?? 0);
      }, 0);
      buffer = carry;
      bufferTokens = carryTokens;
      bufferStartIdx = endIdx - overlapCount;
    };

    for (let i = 0; i < renderedRows.length; i++) {
      const row = renderedRows[i]!;
      const rowTokens = rowTokenCounts[i]!;
      const wouldExceed =
        fixedPrefixTokens + bufferTokens + rowTokens > this.opts.chunkSize;

      // Row is too big on its own (very wide row, huge cells). Flush the
      // buffer, then emit the oversized row alone — losing data here is worse
      // than producing one larger-than-target chunk.
      if (fixedPrefixTokens + rowTokens > this.opts.chunkSize) {
        flush(i);
        chunks.push(
          makeChunk({
            text: fixedPrefix + row,
            ordinal: ordinal++,
            sheetName: table.sheetName,
          }),
        );
        buffer = [];
        bufferTokens = 0;
        bufferStartIdx = i + 1;
        continue;
      }

      if (wouldExceed && buffer.length > 0) {
        flush(i);
      }
      buffer.push(row);
      bufferTokens += rowTokens;
    }
    flush(renderedRows.length);

    return chunks;
  }
}

// ----------------------------------------------------------------------------
// Rendering helpers — match _rows_to_markdown in services/parser-py/app/main.py
// so chunks look identical to the inline markdown the parser already emits.
// ----------------------------------------------------------------------------
function renderHeaderLine(headers: string[]): string {
  return "| " + headers.map(escapeCell).join(" | ") + " |";
}

function renderSeparator(ncols: number): string {
  return "| " + Array.from({ length: ncols }, () => "---").join(" | ") + " |";
}

function renderRow(cells: string[]): string {
  return "| " + cells.map(escapeCell).join(" | ") + " |";
}

function escapeCell(cell: string): string {
  return cell.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function makeChunk(args: {
  text: string;
  ordinal: number;
  sheetName: string | null | undefined;
}): Chunk {
  // Last-resort safety net: an oversized row is emitted alone (see chunk()),
  // which can exceed the hard embedding token cap. Clamp it token-aware before
  // it can reach embedBatch (see token-clamp.ts).
  const text = clampToTokenLimit(args.text);
  return {
    hash: sha256(`${args.sheetName ?? ""}::${text}`),
    text,
    tokenCount: countTokens(text),
    ordinal: args.ordinal,
    headingPath: args.sheetName ? [args.sheetName] : [],
  };
}

function countTokens(text: string): number {
  return encode(text).length;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
