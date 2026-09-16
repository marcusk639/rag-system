import { createHash } from "node:crypto";
import { encode } from "gpt-tokenizer";
import type { Chunk, Chunker, ParsedDocument } from "@rag/core";
import { clampToTokenLimit } from "./token-clamp.js";

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
    // The heading line goes on AFTER overlap is applied, so every chunk opens
    // with its heading. Applying overlap to header-prefixed strings put the
    // previous chunk's tail text above the heading of every continuation
    // chunk, burying the structural context the header exists to provide.
    const header = section.headingPath.length
      ? `# ${section.headingPath.join(" › ")}\n\n`
      : "";

    if (countTokens(section.body) <= this.opts.chunkSize) {
      // Whole section fits; prepend the heading line so the chunk is self-contained.
      return [header + section.body];
    }

    // Split by blank lines (paragraphs / code blocks treated as one unit).
    const units = splitParagraphs(section.body);
    const bodies: string[] = [];
    let buffer: string[] = [];
    let bufferTokens = 0;

    const flush = () => {
      if (buffer.length === 0) return;
      bodies.push(buffer.join("\n\n"));
      buffer = [];
      bufferTokens = 0;
    };

    for (const unit of units) {
      const unitTokens = countTokens(unit);
      if (unitTokens > this.opts.chunkSize) {
        // Single paragraph too big — flush what we have, then hard-split.
        flush();
        bodies.push(...hardSplit(unit, this.opts.chunkSize));
        continue;
      }

      if (bufferTokens + unitTokens > this.opts.chunkSize) {
        flush();
      }
      buffer.push(unit);
      bufferTokens += unitTokens;
    }
    flush();

    return applyOverlap(bodies, this.opts.chunkOverlap).map(
      (body) => header + body,
    );
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
 * chunkSize. Splits by sentence first, then by character if a sentence is itself huge.
 */
function hardSplit(text: string, maxTokens: number): string[] {
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
      const charPerToken = 4;
      const charBudget = maxTokens * charPerToken;
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
