import { createHash } from "node:crypto";
import { encode } from "gpt-tokenizer";
import type { Chunk, Chunker, ParsedDocument, ParsedTable } from "@rag/core";
import {
  MarkdownChunker,
  type MarkdownChunkerOptions,
} from "./markdown-chunker.js";
import { TableChunker, type TableChunkerOptions } from "./table-chunker.js";
import { clampToTokenLimit } from "./token-clamp.js";

/**
 * Composite chunker that routes per-document:
 *
 *   - Spreadsheet docs (any table has a sheetType) → TableChunker per table.
 *     The document's `markdown` blob is, by construction of the parser, just
 *     the rendered tables — running MarkdownChunker on it would slice rows
 *     mid-record. We skip it entirely for these.
 *
 *   - Non-spreadsheet docs → MarkdownChunker on `markdown` as before. Tables
 *     embedded in PDFs/DOCX stay inline because the surrounding context
 *     matters; surfacing them separately is a v1 concern.
 *
 *   - narrative / freeform sheets → TableChunker returns null and we re-route
 *     that table's markdown through MarkdownChunker. The classifier said the
 *     sheet is prose-shaped, so heading-aware chunking is the right tool.
 *
 * Ordinals are assigned globally across the whole document so retrieval can
 * still order chunks by position.
 */
export interface CompositeChunkerOptions {
  markdown: MarkdownChunkerOptions;
  table: TableChunkerOptions;
}

export class CompositeChunker implements Chunker {
  private readonly markdownChunker: MarkdownChunker;
  private readonly tableChunker: TableChunker;

  constructor(opts: CompositeChunkerOptions) {
    this.markdownChunker = new MarkdownChunker(opts.markdown);
    this.tableChunker = new TableChunker(opts.table);
  }

  async chunk(document: ParsedDocument): Promise<Chunk[]> {
    const isSpreadsheet = (document.tables ?? []).some(
      (t) => t.sheetType != null,
    );
    const chunks = isSpreadsheet
      ? await this.chunkSpreadsheet(document)
      : await this.markdownChunker.chunk(document);
    return chunks.map((c) => withDocumentTitle(c, document.title));
  }

  private async chunkSpreadsheet(document: ParsedDocument): Promise<Chunk[]> {
    const out: Chunk[] = [];
    let ordinal = 0;

    for (const table of document.tables ?? []) {
      const tableChunks = this.tableChunker.chunk({
        table,
        startOrdinal: ordinal,
      });

      if (tableChunks && tableChunks.length > 0) {
        out.push(...tableChunks);
        ordinal += tableChunks.length;
        continue;
      }

      // TableChunker bowed out (narrative/freeform, or empty structured rows).
      // Re-route this single table's markdown through the heading-aware chunker
      // so we still get sensible prose chunks instead of mid-row slices.
      const fallbackChunks = await this.chunkTableAsMarkdown(table, ordinal);
      out.push(...fallbackChunks);
      ordinal += fallbackChunks.length;
    }

    return out;
  }

  /**
   * Treat one table's `markdown` as a tiny standalone document and feed it to
   * MarkdownChunker, then rewrite ordinals into the global sequence.
   */
  private async chunkTableAsMarkdown(
    table: ParsedTable,
    startOrdinal: number,
  ): Promise<Chunk[]> {
    if (!table.markdown.trim()) return [];

    const synthetic: ParsedDocument = {
      title: table.sheetName ?? "",
      markdown: table.markdown,
      tables: [],
      metadata: {},
    };
    const subChunks = await this.markdownChunker.chunk(synthetic);
    return subChunks.map((c, i) => ({
      ...c,
      ordinal: startOrdinal + i,
    }));
  }
}

/**
 * Put the document title at the front of a chunk's text.
 *
 * The chunk text is what gets embedded and keyword-indexed. A fragment like
 * "3. Apply the template and route for signature" matches every SOP equally;
 * without the title neither the vector nor the tsvector knows which procedure
 * it belongs to. Word/PDF output often has no markdown headings at all, so the
 * heading-path header the chunkers add is frequently empty.
 *
 * `headingPath` is left untouched — it describes the document's own structure
 * and is what citations display as the section.
 */
function withDocumentTitle(chunk: Chunk, rawTitle: string): Chunk {
  const title = rawTitle.replace(/\s+/g, " ").trim();
  if (!title) return chunk;

  const newline = chunk.text.indexOf("\n");
  const firstLine = newline === -1 ? chunk.text : chunk.text.slice(0, newline);
  let text: string;
  if (firstLine.startsWith("# ")) {
    const heading = firstLine.slice(2);
    const firstSegment = heading.split(" › ")[0]?.trim().toLowerCase();
    if (firstSegment === title.toLowerCase()) return chunk;
    text = `# ${title} › ${heading}${chunk.text.slice(firstLine.length)}`;
  } else {
    text = `# ${title}\n\n${chunk.text}`;
  }
  text = clampToTokenLimit(text);
  return {
    ...chunk,
    text,
    tokenCount: encode(text).length,
    hash: createHash("sha256")
      .update(`${chunk.headingPath.join("/")}::${text}`)
      .digest("hex"),
  };
}
