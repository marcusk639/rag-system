import { z } from "zod";
import type { filterSchema } from "./validation.js";
import type { components } from "./parser-types.generated.js";

// ============================================================================
// Source — an external system the ingestion pipeline can pull from
// ============================================================================

export const SourceKind = z.enum([
  "sharepoint",
  "gdrive",
  "gmail",
  "outlook",
  "custom",
  "git-markdown",
  "ecfr-part4",
]);
export type SourceKind = z.infer<typeof SourceKind>;

// ============================================================================
// Document classification — controls index access and egress enforcement
// ============================================================================

/**
 * A/B/C/D data classification for documents ingested into the RAG system.
 *
 * Phase 1 scope: A and B only. C and D are declared here so the type is
 * complete, but the ingestion pipeline blocks them with ClassBlockedError.
 *
 * A — Firm-internal, non-sensitive  (SOPs, templates, research notes)
 * B — Firm-internal, de-ID required  (research memos with client mentions)
 * C — Per-client business data        (Blocked: requires §314.4(f) addendum)
 * D — Client tax return data          (Blocked: requires §7216 consent workflow)
 */
export const DocumentClass = z.enum(["A", "B", "C", "D"]);
export type DocumentClass = z.infer<typeof DocumentClass>;

export const SourceConfig = z.object({
  id: z.string().uuid(),
  kind: SourceKind,
  name: z.string().min(1).max(120),
  // Per-connector configuration. Each connector defines its own shape and
  // validates it on construction. We store as JSON to keep the schema generic.
  config: z.record(z.unknown()),
  // Last successful delta cursor (opaque to the core, interpreted by the connector).
  cursor: z.string().nullable(),
  // Data classification — every source must declare its class. Controls which
  // index the source's documents may enter; deny-by-default at ingestion.
  docClass: DocumentClass,
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type SourceConfig = z.infer<typeof SourceConfig>;

// ============================================================================
// Document — a single retrievable unit from a source (file, email, etc.)
// ============================================================================

export const DocumentMetadata = z
  .object({
    title: z.string().optional(),
    author: z.string().optional(),
    url: z.string().url().optional(),
    mimeType: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    createdAt: z.string().datetime().optional(),
    modifiedAt: z.string().datetime().optional(),
    // Path-like address inside the source (e.g. "Marketing/2024/plan.docx").
    path: z.string().optional(),
    // Email-only fields
    subject: z.string().optional(),
    from: z.string().optional(),
    to: z.array(z.string()).optional(),
    // Data classification tag — set at ingest from source config.
    // A/B only in Phase 1; C/D blocked by ingestion pipeline.
    docClass: DocumentClass.optional(),
    // Free-form for connector-specific extras (drive id, sharepoint site id, etc.)
    extra: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type DocumentMetadata = z.infer<typeof DocumentMetadata>;

export interface SourceDocument {
  /** Stable id within the source (file id, message id, etc.) */
  externalId: string;
  /** Human-readable title used in citations */
  title: string;
  /** ISO timestamp the source reports as "last modified" */
  modifiedAt: string;
  /** MIME type as the source reports it */
  mimeType: string;
  /** Raw bytes of the document */
  content: Buffer;
  /** Anything else worth storing for retrieval/filtering */
  metadata: DocumentMetadata;
}

// ============================================================================
// Parsed document — output of the parser sidecar
// ============================================================================

/**
 * Output of the parser sidecar. Single-sourced from the parser's Pydantic
 * models via the generated OpenAPI types — DO NOT hand-edit. Regenerate with
 * `pnpm gen:parser-types` (requires the parser container to be up).
 */
export type ParsedDocument = components["schemas"]["ParsedDocument"];

/**
 * Routing label assigned by the parser per spreadsheet sheet. Drives downstream
 * choices about chunking (row-grouping vs. semantic), text-to-SQL eligibility,
 * and citation formatting. For non-spreadsheet sources `sheetType` is undefined.
 *
 *  - `tabular`         — database-like sheet, consistent headers, no narrative.
 *                        Best treated row-by-row; SQL-routable when needed.
 *  - `narrative`       — report-style sheet: headings, prose, mixed tables.
 *                        Best treated as markdown chunks with surrounding context.
 *  - `financial_model` — small, dense, formula-heavy. Embed COMPUTED values
 *                        and treat the whole sheet as one logical section.
 *  - `freeform`        — todo lists, plans, irregular layouts. Best-effort.
 *
 * Derived from the generated `ParsedTable.sheetType` to stay single-sourced.
 */
export type SheetType = NonNullable<ParsedTable["sheetType"]>;

/**
 * A structured table extracted from a document. Single-sourced from the
 * parser's Pydantic models via the generated OpenAPI types — DO NOT hand-edit.
 */
export type ParsedTable = components["schemas"]["ParsedTable"];

/**
 * Runtime validator for the parser sidecar's `/parse` response.
 *
 * The TYPES above are the single source of truth (generated from the parser's
 * Pydantic models). This Zod schema is a deliberately SEPARATE runtime guard:
 * `HttpParserClient.parse()` validates the sidecar JSON through it instead of an
 * unchecked `as ParsedDocument` cast, so a malformed response (parser/version
 * skew, proxy mangling, a parser bug) fails loudly at the boundary instead of
 * silently corrupting downstream chunks. The parser runs as a separate,
 * independently-deployed container, so this boundary is a real trust boundary.
 *
 * The shape mirrors the parser's Pydantic defaults exactly: `_CamelModel`
 * serializes camelCase, and list/int fields carry defaults (so they are present
 * rather than missing). The `_assertParsedDocAssignable` check below fails the
 * build if this validator ever drifts from the generated contract.
 */
const ParsedTableSchema = z.object({
  markdown: z.string(),
  caption: z.string().nullish(),
  sheetName: z.string().nullish(),
  sheetType: z
    .enum(["tabular", "narrative", "financial_model", "freeform"])
    .nullish(),
  headers: z.array(z.string()).default([]),
  rows: z.array(z.array(z.string())).default([]),
  rowCount: z.number().int().nonnegative().default(0),
  columnCount: z.number().int().nonnegative().default(0),
});

export const ParsedDocumentSchema = z.object({
  title: z.string(),
  markdown: z.string(),
  tables: z.array(ParsedTableSchema).default([]),
  metadata: z.record(z.unknown()).default({}),
});

/**
 * Compile-time drift guard: the runtime validator's OUTPUT must stay assignable
 * to the generated contract. If the parser's Pydantic models change and the
 * generated types are regenerated, this line stops compiling until the schema
 * above is updated to match — keeping the single source of truth honest.
 */
type _ParsedDocAssignable =
  z.infer<typeof ParsedDocumentSchema> extends ParsedDocument ? true : never;
const _assertParsedDocAssignable: _ParsedDocAssignable = true;
void _assertParsedDocAssignable;

// ============================================================================
// Chunk — a slice of a document ready to embed
// ============================================================================

export interface Chunk {
  /** SHA-256 of the chunk text. Used for dedupe and idempotency. */
  hash: string;
  /** The chunk text */
  text: string;
  /** Token count estimate (used for retrieval budget calculations) */
  tokenCount: number;
  /** Position within the document (0-indexed) */
  ordinal: number;
  /** Heading path at this chunk's location, e.g. ["Introduction", "Setup"] */
  headingPath: string[];
  /** Page number when known (PDFs, Word docs) */
  page?: number;
}

// ============================================================================
// Embedding
// ============================================================================

export interface Embedding {
  /** Raw float vector */
  vector: number[];
  /** Provider name, e.g. "gemini" */
  provider: string;
  /** Model identifier, e.g. "text-embedding-004" */
  model: string;
  /** Dimensions (matches vector.length, included for fast validation) */
  dimensions: number;
}

// ============================================================================
// Retrieval
// ============================================================================

export interface RetrievalQuery {
  query: string;
  topK: number;
  /**
   * Optional metadata filter: AND across keys, OR across array values per key.
   * Derived from the bounded `filterSchema` so the DoS caps are the only
   * representable shape past the HTTP/MCP boundary — not an unbounded record.
   */
  filter?: z.infer<typeof filterSchema>;
  /** Restrict to specific source IDs */
  sourceIds?: string[];
  /** Override hybrid weights for this query */
  weights?: { dense: number; sparse: number };
}

export interface RetrievalResult {
  /** Chunk text */
  text: string;
  /** Combined score (0-1, higher is better) */
  score: number;
  /** Dense (cosine) score component */
  denseScore: number;
  /** Sparse (BM25) score component */
  sparseScore: number;
  /** Document this chunk came from */
  document: {
    id: string;
    title: string;
    sourceId: string;
    sourceKind: SourceKind;
    url?: string;
    /** True when the original file bytes are stored and can be downloaded. */
    hasOriginal?: boolean;
    metadata: DocumentMetadata;
  };
  /** Position within the document */
  chunk: {
    id: string;
    ordinal: number;
    headingPath: string[];
    page?: number;
  };
}
